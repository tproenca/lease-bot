// Shared CORS helpers for browser-served Edge Functions.
//
// Two CORS profiles are exported:
//
//   corsHeaders        — wildcard origin; safe for GET endpoints that return
//                        non-sensitive public HTML (pre-auth setup page) and
//                        for OPTIONS preflight responses.
//
//   strictCorsHeaders  — restricts `Access-Control-Allow-Origin` to the
//                        configured functions base URL (or falls back to the
//                        Supabase project URL). Required for any mutating
//                        endpoint that accepts credentials, to prevent
//                        cross-origin requests from arbitrary sites.
//                        Used by: POST /setup/complete.

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function strictCorsHeaders(): Record<string, string> {
  // Derive the allowed origin from PUBLIC_FUNCTIONS_BASE_URL if set,
  // otherwise fall back to the Supabase project URL. We only need the
  // scheme+host part (no path).
  const base = Deno.env.get("PUBLIC_FUNCTIONS_BASE_URL") ??
    Deno.env.get("SUPABASE_URL") ??
    "";
  let allowedOrigin = "*"; // safe fallback for local dev when nothing is configured
  if (base) {
    try {
      const u = new URL(base);
      allowedOrigin = `${u.protocol}//${u.host}`;
    } catch {
      // malformed URL — fall back to wildcard rather than crashing
    }
  }
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin",
  };
}
