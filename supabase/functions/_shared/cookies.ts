// Cookie helpers for the onboarding flow.
//
// Two cookies are used:
//   - `oauth_state`  — short-lived CSRF nonce for the Google OAuth round-trip.
//   - `sb_session`   — the Supabase JWT issued after a successful callback.
//                      Used by /setup to detect post-auth state.
//
// Both are HttpOnly + Secure (when behind HTTPS) + SameSite=Lax so they ride
// along on the OAuth redirect back from Google.

export interface CookieOptions {
  maxAge?: number;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  path?: string;
}

export function serializeCookie(
  name: string,
  value: string,
  opts: CookieOptions = {},
): string {
  const parts = [`${name}=${value}`];
  parts.push(`Path=${opts.path ?? "/"}`);
  if (typeof opts.maxAge === "number") parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  parts.push(`SameSite=${opts.sameSite ?? "Lax"}`);
  return parts.join("; ");
}

export function clearCookie(name: string): string {
  return serializeCookie(name, "", { maxAge: 0 });
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const [rawName, ...rest] = part.split("=");
    if (!rawName) continue;
    const name = rawName.trim();
    if (!name) continue;
    out[name] = rest.join("=").trim();
  }
  return out;
}

export function isHttpsRequest(req: Request): boolean {
  const url = new URL(req.url);
  if (url.protocol === "https:") return true;
  const proto = req.headers.get("x-forwarded-proto");
  return proto === "https";
}

// Constants kept here so the two endpoints stay in sync.
export const COOKIE_OAUTH_STATE = "oauth_state";
export const COOKIE_SESSION = "sb_session";
export const OAUTH_STATE_TTL_SECONDS = 600; // 10 minutes
export const SESSION_COOKIE_TTL_SECONDS = 60 * 60; // 1 hour: only used to
// render the post-auth setup page; the real session lives in Supabase Auth.
