// POST /oauth/token — Exchange auth code or refresh token for a Supabase JWT.
//
// OpenAI requires that the Token URL shares the same root domain as the API.
// This endpoint proxies to Google to get tokens, then exchanges the Google
// id_token for a Supabase session so that the GPT always holds a valid
// Supabase JWT — not a raw Google access token — for API calls.
//
// grant_type=authorization_code:
//   1. Check if `code` exists in the oauth_codes table (integrated setup flow).
//      If yes: return the stored access_token + refresh_token and delete the row
//      (single-use). The row is expired-filtered so stale codes are rejected.
//   2. If no oauth_codes row: fall through to Google token exchange (original
//      direct-/setup-page flow, kept for backward compatibility).
//   3. Forward to Google's token endpoint to get Google id_token.
//   4. Call supabase.auth.signInWithIdToken to create/update the Supabase user.
//   5. Return the Supabase access_token + refresh_token.
//
// grant_type=refresh_token:
//   The stored refresh_token is a Supabase refresh token from a prior exchange.
//   Call supabase.auth.refreshSession to get a new Supabase access_token.

import { anonClient, serviceClient } from "../../_shared/supabase.ts";
import { redeemOAuthCode } from "../../_shared/oauth-codes.ts";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export async function handleOAuthToken(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({
        error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." },
      }),
      { status: 405, headers: { "Content-Type": "application/json" } },
    );
  }

  const body = await req.text();
  const params = new URLSearchParams(body);
  const grantType = params.get("grant_type");

  // ── Refresh token flow ───────────────────────────────────────────────────
  if (grantType === "refresh_token") {
    const supabaseRefreshToken = params.get("refresh_token");
    if (!supabaseRefreshToken) {
      return new Response(
        JSON.stringify({
          error: "invalid_request",
          error_description: "Missing refresh_token",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const supabase = anonClient();
    const { data, error } = await supabase.auth.refreshSession({
      refresh_token: supabaseRefreshToken,
    });

    if (error || !data.session) {
      return new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Token refresh failed",
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        token_type: "Bearer",
        expires_in: data.session.expires_in ?? 3600,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  // ── Authorization code flow ──────────────────────────────────────────────
  if (grantType !== "authorization_code") {
    return new Response(
      JSON.stringify({
        error: "unsupported_grant_type",
        error_description: `Unsupported grant_type: ${grantType}`,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const code = params.get("code");

  // 1. Check the oauth_codes table first (integrated setup flow).
  //    If we issued this code from /setup/complete or /auth/callback, it holds
  //    a Supabase JWT pair — return it directly without calling Google.
  if (code) {
    let redeemed: { accessToken: string; refreshToken: string } | null = null;
    try {
      redeemed = await redeemOAuthCode(code);
    } catch {
      // Unexpected DB error — fall through to the Google exchange path.
      // The code won't be in Google's system, so that will also fail, but we
      // preserve backward compatibility and avoid swallowing real errors silently.
    }

    if (redeemed) {
      return new Response(
        JSON.stringify({
          access_token: redeemed.accessToken,
          refresh_token: redeemed.refreshToken,
          token_type: "Bearer",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  // 2. Fall through: Google token exchange (original flow).
  const googleResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const googleData = await googleResponse.json() as Record<string, unknown>;

  if (!googleResponse.ok || googleData.error) {
    return new Response(JSON.stringify(googleData), {
      status: googleResponse.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const idToken = googleData.id_token as string | undefined;
  if (!idToken) {
    return new Response(
      JSON.stringify({
        error: "server_error",
        error_description: "No id_token in Google response",
      }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  // Exchange Google id_token for a Supabase session.
  const supabase = anonClient();
  const { data, error } = await supabase.auth.signInWithIdToken({
    provider: "google",
    token: idToken,
  });

  if (error || !data.session) {
    return new Response(
      JSON.stringify({
        error: "server_error",
        error_description: "Supabase sign-in failed",
      }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  // Store the Google refresh token in app_metadata so /setup/complete can
  // refresh a Google access token to validate Drive folders. app_metadata is
  // admin-only (not user-editable). Google only returns a refresh_token on
  // first authorization, so we only update when present — subsequent logins
  // leave the stored token intact.
  const googleRefreshToken = googleData.refresh_token as string | undefined;
  if (googleRefreshToken) {
    const svc = serviceClient();
    await svc.auth.admin.updateUserById(data.session.user.id, {
      // No spread needed: Supabase's admin API performs a shallow merge, so
      // existing app_metadata keys (e.g. `provider`, `providers`) are preserved.
      app_metadata: { google_refresh_token: googleRefreshToken },
    });
  }

  return new Response(
    JSON.stringify({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      token_type: "Bearer",
      expires_in: data.session.expires_in ?? 3600,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
