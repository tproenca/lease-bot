// GET /oauth/authorize — Proxy redirect to Google's OAuth authorization endpoint.
//
// OpenAI requires that the Authorization URL, Token URL, and API server all
// share the same root domain. Since Google OAuth lives on accounts.google.com
// and the API lives on supabase.co (or an ngrok domain), a same-domain proxy
// is needed. This endpoint forwards all query params to Google's authorization
// URL and returns a 302 redirect. See issue #53 and ADR-0014.
//
// Security:
//   - Only redirects to the exact Google authorization URL — no open redirect.
//   - No authentication required (this is the start of the OAuth flow).
//   - No credentials are stored or logged.

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export async function handleOAuthAuthorize(req: Request): Promise<Response> {
  if (req.method !== "GET") {
    return new Response(
      JSON.stringify({
        error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." },
      }),
      {
        status: 405,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  const incomingUrl = new URL(req.url);
  const targetUrl = new URL(GOOGLE_AUTH_URL);

  // Forward all query params. Force access_type=offline so Google always
  // issues a refresh token — required by /setup/complete to access Drive.
  incomingUrl.searchParams.forEach((value, key) => {
    targetUrl.searchParams.set(key, value);
  });
  targetUrl.searchParams.set("access_type", "offline");

  return new Response(null, {
    status: 302,
    headers: {
      Location: targetUrl.toString(),
    },
  });
}
