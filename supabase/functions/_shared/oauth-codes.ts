// One-time OAuth code helpers for the integrated setup flow.
//
// When a new landlord completes /setup from within the ChatGPT OAuth window,
// we issue a short-lived single-use code that encapsulates the Supabase
// access_token + refresh_token. ChatGPT calls /oauth/token with this code and
// receives the JWT pair.
//
// Security:
//   - Codes are crypto.randomUUID() — 122 bits of entropy.
//   - Codes expire after 5 minutes (enforced by the expires_at DB column).
//   - Codes are deleted on first successful exchange (single-use).
//   - Tokens stored here are Supabase JWTs, never Google tokens.
//   - All DB operations use the service-role client (service-role bypasses RLS).
//
// See migration 20260525033453_oauth_codes.sql and issue #89.

import { serviceClient } from "./supabase.ts";

/**
 * Insert a new one-time code row and return the code.
 * Throws if the DB insert fails.
 */
export async function issueOAuthCode(params: {
  accessToken: string;
  refreshToken: string;
}): Promise<string> {
  const code = crypto.randomUUID();
  const svc = serviceClient();
  const { error } = await svc.from("oauth_codes").insert({
    code,
    access_token: params.accessToken,
    refresh_token: params.refreshToken,
  });
  if (error) {
    throw new Error(`oauth_code_insert_failed: ${error.message}`);
  }
  return code;
}

/**
 * Look up a one-time code, delete it, and return the stored tokens.
 * Returns null when the code is not found, already used, or expired.
 * Throws only on unexpected DB errors during the delete step.
 */
export async function redeemOAuthCode(
  code: string,
): Promise<{ accessToken: string; refreshToken: string } | null> {
  const svc = serviceClient();

  // Fetch the row only if it has not expired.
  const { data, error } = await svc
    .from("oauth_codes")
    .select("access_token, refresh_token, expires_at")
    .eq("code", code)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (error || !data) return null;

  // Delete the row immediately (single-use). Best-effort: if this fails we
  // still return the tokens — the row will expire naturally.
  await svc.from("oauth_codes").delete().eq("code", code);

  return {
    accessToken: data.access_token as string,
    refreshToken: data.refresh_token as string,
  };
}
