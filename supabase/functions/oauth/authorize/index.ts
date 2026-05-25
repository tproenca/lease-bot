// GET /oauth/authorize — Proxy redirect to Google's OAuth authorization endpoint.
//
// OpenAI requires that the Authorization URL, Token URL, and API server all
// share the same root domain. Since Google OAuth lives on accounts.google.com
// and the API lives on supabase.co (or an ngrok domain), a same-domain proxy
// is needed. This endpoint forwards all query params to Google's authorization
// URL and returns a 302 redirect. See issue #53 and ADR-0014.
//
// Integrated setup flow (issue #89):
//   ChatGPT sends redirect_uri=<chatgpt_callback>&state=<openai_state>.
//   We intercept those, store them in a short-lived HttpOnly cookie
//   (COOKIE_CHATGPT_REDIRECT), and replace redirect_uri with our own
//   /auth/callback. After Google auth + optional setup, /auth/callback (or
//   /setup/complete) redirects to the stored ChatGPT redirect_uri.
//
// Security:
//   - Only redirects to the exact Google authorization URL — no open redirect.
//   - No authentication required (this is the start of the OAuth flow).
//   - redirect_uri and state are stored in an HttpOnly cookie; never logged.

import { publicFunctionsBaseUrl } from "../../_shared/env.ts";
import { googleRedirectUri } from "../../_shared/google.ts";
import {
  CHATGPT_REDIRECT_TTL_SECONDS,
  COOKIE_CHATGPT_REDIRECT,
  COOKIE_OAUTH_STATE,
  isHttpsRequest,
  OAUTH_STATE_TTL_SECONDS,
  serializeCookie,
} from "../../_shared/cookies.ts";

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

  // Extract ChatGPT's redirect_uri and state before forwarding, so we can
  // store them in a cookie and replace redirect_uri with our /auth/callback.
  const chatgptRedirectUri = incomingUrl.searchParams.get("redirect_uri");
  const chatgptState = incomingUrl.searchParams.get("state");

  // Forward all query params. Force access_type=offline so Google always
  // issues a refresh token — required by /setup/complete to access Drive.
  incomingUrl.searchParams.forEach((value, key) => {
    targetUrl.searchParams.set(key, value);
  });
  targetUrl.searchParams.set("access_type", "offline");
  targetUrl.searchParams.set("prompt", "consent");

  // Replace redirect_uri with our /auth/callback so Google returns to us
  // instead of ChatGPT directly. ChatGPT's redirect_uri + state are stored
  // in the cookie below and consumed after auth completes.
  const baseUrl = publicFunctionsBaseUrl();
  const ourCallbackUri = googleRedirectUri(baseUrl);
  targetUrl.searchParams.set("redirect_uri", ourCallbackUri);

  const responseHeaders = new Headers({
    Location: targetUrl.toString(),
  });

  // Store the state param in COOKIE_OAUTH_STATE so /auth/callback can verify
  // it as a CSRF nonce. ChatGPT always sends state (OpenAI enforces it).
  if (chatgptState) {
    responseHeaders.append(
      "Set-Cookie",
      serializeCookie(COOKIE_OAUTH_STATE, chatgptState, {
        maxAge: OAUTH_STATE_TTL_SECONDS,
        httpOnly: true,
        secure: isHttpsRequest(req),
        sameSite: "Lax",
      }),
    );
  }

  // Store the ChatGPT redirect_uri and state in an HttpOnly cookie so the
  // callback handler can redirect there after auth + optional setup.
  // Only set when ChatGPT actually sent a redirect_uri (not present in direct
  // /setup page flows where the user clicks "Entrar com Google" themselves).
  if (chatgptRedirectUri) {
    // Encode as a JSON blob so one cookie carries both values.
    // Never log either value — treat them as opaque tokens.
    const cookieValue = JSON.stringify({
      redirect_uri: chatgptRedirectUri,
      state: chatgptState ?? "",
    });
    responseHeaders.append(
      "Set-Cookie",
      serializeCookie(
        COOKIE_CHATGPT_REDIRECT,
        encodeURIComponent(cookieValue),
        {
          maxAge: CHATGPT_REDIRECT_TTL_SECONDS,
          httpOnly: true,
          secure: isHttpsRequest(req),
          sameSite: "Lax",
        },
      ),
    );
  }

  return new Response(null, {
    status: 302,
    headers: responseHeaders,
  });
}
