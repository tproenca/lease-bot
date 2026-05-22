// GET /auth/callback — Google OAuth redirect handler.
//
// Flow:
//   1. Validate `state` query param against the short-lived CSRF cookie.
//   2. Exchange the `code` for Google tokens (access_token, refresh_token,
//      id_token).
//   3. Create a Supabase Auth session by passing Google's id_token to
//      Supabase's signInWithIdToken — this binds auth.uid() to the landlord's
//      Google identity.
//   4. Persist the Google refresh_token into the auth user's metadata so
//      Edge Functions can later mint Drive access tokens. Per
//      specs/SECURITY.md the refresh token is encrypted at rest by Supabase
//      Vault — we never log it.
//   5. Set a session cookie (so the server-rendered /setup page can detect
//      auth state) and redirect to /setup.
//
// This file is kept under `supabase/functions/auth/callback/` per issue 1.2;
// the deployable function is `supabase/functions/auth/` and routes internally.

import { corsHeaders } from "../../_shared/cors.ts";
import { errorResponse } from "../../_shared/errors.ts";
import { publicFunctionsBaseUrl } from "../../_shared/env.ts";
import {
  exchangeCodeForTokens,
  googleRedirectUri,
} from "../../_shared/google.ts";
import {
  clearCookie,
  COOKIE_OAUTH_STATE,
  COOKIE_SESSION,
  isHttpsRequest,
  parseCookies,
  serializeCookie,
  SESSION_COOKIE_TTL_SECONDS,
} from "../../_shared/cookies.ts";
import { anonClient, serviceClient } from "../../_shared/supabase.ts";

export async function handleAuthCallback(req: Request): Promise<Response> {
  if (req.method !== "GET") {
    return errorResponse(405, "METHOD_NOT_ALLOWED", "Método não permitido.");
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    return errorResponse(
      400,
      "OAUTH_DENIED",
      "Autorização do Google negada ou cancelada.",
    );
  }
  if (!code || !state) {
    return errorResponse(
      400,
      "OAUTH_MISSING_PARAMS",
      "Parâmetros de autenticação ausentes.",
    );
  }

  // 1. CSRF: compare state param against cookie.
  const cookies = parseCookies(req.headers.get("cookie"));
  const expectedState = cookies[COOKIE_OAUTH_STATE];
  if (!expectedState || !timingSafeEqual(state, expectedState)) {
    return errorResponse(
      400,
      "OAUTH_STATE_MISMATCH",
      "Falha de validação de segurança. Tente novamente.",
    );
  }

  // 2. Exchange code → tokens.
  const baseUrl = publicFunctionsBaseUrl();
  const redirectUri = googleRedirectUri(baseUrl);
  let tokens: Awaited<ReturnType<typeof exchangeCodeForTokens>>;
  try {
    tokens = await exchangeCodeForTokens({ code, redirectUri });
  } catch {
    return errorResponse(
      502,
      "OAUTH_TOKEN_EXCHANGE_FAILED",
      "Não foi possível concluir o login com o Google. Tente novamente.",
    );
  }
  if (!tokens.id_token) {
    return errorResponse(
      502,
      "OAUTH_MISSING_ID_TOKEN",
      "Resposta do Google incompleta. Tente novamente.",
    );
  }
  if (!tokens.refresh_token) {
    // We requested access_type=offline + prompt=consent so a refresh token
    // should always come back. If it didn't, the landlord can't grant Drive
    // access — fail loudly.
    return errorResponse(
      502,
      "OAUTH_MISSING_REFRESH_TOKEN",
      "Não recebemos a permissão de acesso offline ao Drive. Tente novamente.",
    );
  }

  // 3. Create Supabase Auth session via id_token.
  const { data: signInData, error: signInError } = await anonClient().auth
    .signInWithIdToken({
      provider: "google",
      token: tokens.id_token,
    });
  if (signInError || !signInData.session || !signInData.user) {
    return errorResponse(
      502,
      "SUPABASE_SIGNIN_FAILED",
      "Não foi possível criar a sessão. Tente novamente.",
    );
  }

  // 4. Persist the Google refresh token in app_metadata via the service-role
  //    admin API. app_metadata is admin-only (not user-editable) and is
  //    returned by getUser() so /setup/complete can read it without a separate
  //    DB query. We never log the token.
  const { error: updateError } = await serviceClient().auth.admin
    .updateUserById(
      signInData.user.id,
      {
        // No spread needed: Supabase's admin API performs a shallow merge, so
        // existing app_metadata keys (e.g. `provider`, `providers`) are preserved.
        app_metadata: {
          google_refresh_token: tokens.refresh_token,
        },
      },
    );
  if (updateError) {
    return errorResponse(
      502,
      "REFRESH_TOKEN_PERSIST_FAILED",
      "Não foi possível salvar o token de acesso. Tente novamente.",
    );
  }

  // 5. Set session cookie, clear state cookie, redirect to /setup.
  const setupUrl = `${baseUrl.replace(/\/$/, "")}/setup`;
  const headers = new Headers({
    ...corsHeaders,
    Location: setupUrl,
  });
  headers.append(
    "Set-Cookie",
    serializeCookie(COOKIE_SESSION, signInData.session.access_token, {
      maxAge: SESSION_COOKIE_TTL_SECONDS,
      httpOnly: true,
      secure: isHttpsRequest(req),
      sameSite: "Lax",
    }),
  );
  headers.append("Set-Cookie", clearCookie(COOKIE_OAUTH_STATE));
  return new Response(null, { status: 302, headers });
}

// Constant-time string comparison to defeat timing attacks on the state nonce.
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}
