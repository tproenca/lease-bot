// POST /oauth/token — Proxy to Google's OAuth token endpoint.
//
// OpenAI requires that the Authorization URL, Token URL, and API server all
// share the same root domain. This endpoint forwards the token exchange
// request body to Google's token endpoint and returns Google's response
// verbatim (status, body, content-type). See issue #53 and ADR-0014.
//
// Security:
//   - Only forwards to the exact Google token URL — no open redirect.
//   - No authentication required (this is the OAuth token exchange flow).
//   - No credentials are stored or logged by this proxy.

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export async function handleOAuthToken(req: Request): Promise<Response> {
  if (req.method !== "POST") {
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

  // Read the raw body and forward it as-is to Google. The GPT sends
  // grant_type, code, redirect_uri, client_id, client_secret, etc.
  const body = await req.arrayBuffer();
  const contentType = req.headers.get("content-type") ??
    "application/x-www-form-urlencoded";

  const googleResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
    },
    body,
  });

  // Return Google's response verbatim — status, body, and content-type.
  const responseBody = await googleResponse.arrayBuffer();
  const responseContentType = googleResponse.headers.get("content-type") ??
    "application/json";

  return new Response(responseBody, {
    status: googleResponse.status,
    headers: {
      "Content-Type": responseContentType,
    },
  });
}
