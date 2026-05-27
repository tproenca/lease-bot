// unit: _shared/google.ts — buildGoogleAuthUrl + refreshGoogleAccessToken
//
// Sets the required env vars inline so this test is self-contained and does
// not require a running Supabase instance.
import {
  assertInstanceOf,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildGoogleAuthUrl,
  GOOGLE_OAUTH_SCOPES,
  GoogleReauthRequiredError,
  refreshGoogleAccessToken,
} from "./google.ts";

const FAKE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";

Deno.test("unit: buildGoogleAuthUrl — contains Google auth base URL", () => {
  Deno.env.set("GOOGLE_CLIENT_ID", FAKE_CLIENT_ID);
  const url = buildGoogleAuthUrl({
    redirectUri: "http://localhost:54321/functions/v1/auth/callback",
    state: "test-state-nonce",
  });
  assertStringIncludes(url, "https://accounts.google.com/o/oauth2/v2/auth");
});

Deno.test("unit: buildGoogleAuthUrl — includes client_id", () => {
  Deno.env.set("GOOGLE_CLIENT_ID", FAKE_CLIENT_ID);
  const url = buildGoogleAuthUrl({
    redirectUri: "http://localhost:54321/functions/v1/auth/callback",
    state: "test-state-nonce",
  });
  assertStringIncludes(url, encodeURIComponent(FAKE_CLIENT_ID));
});

Deno.test("unit: buildGoogleAuthUrl — includes redirect_uri", () => {
  Deno.env.set("GOOGLE_CLIENT_ID", FAKE_CLIENT_ID);
  const redirectUri = "http://localhost:54321/functions/v1/auth/callback";
  const url = buildGoogleAuthUrl({ redirectUri, state: "abc" });
  assertStringIncludes(url, encodeURIComponent(redirectUri));
});

Deno.test("unit: buildGoogleAuthUrl — includes state param", () => {
  Deno.env.set("GOOGLE_CLIENT_ID", FAKE_CLIENT_ID);
  const url = buildGoogleAuthUrl({
    redirectUri: "http://localhost:54321/functions/v1/auth/callback",
    state: "unique-csrf-nonce",
  });
  assertStringIncludes(url, "unique-csrf-nonce");
});

Deno.test("unit: buildGoogleAuthUrl — requests offline access", () => {
  Deno.env.set("GOOGLE_CLIENT_ID", FAKE_CLIENT_ID);
  const url = buildGoogleAuthUrl({
    redirectUri: "http://localhost:54321/functions/v1/auth/callback",
    state: "nonce",
  });
  assertStringIncludes(url, "access_type=offline");
});

Deno.test("unit: buildGoogleAuthUrl — includes drive scope", () => {
  Deno.env.set("GOOGLE_CLIENT_ID", FAKE_CLIENT_ID);
  const url = buildGoogleAuthUrl({
    redirectUri: "http://localhost:54321/functions/v1/auth/callback",
    state: "nonce",
  });
  assertStringIncludes(
    url,
    encodeURIComponent("https://www.googleapis.com/auth/drive"),
  );
});

Deno.test("unit: buildGoogleAuthUrl — forces consent prompt (ensures refresh token)", () => {
  Deno.env.set("GOOGLE_CLIENT_ID", FAKE_CLIENT_ID);
  const url = buildGoogleAuthUrl({
    redirectUri: "http://localhost:54321/functions/v1/auth/callback",
    state: "nonce",
  });
  assertStringIncludes(url, "prompt=consent");
});

Deno.test("unit: GOOGLE_OAUTH_SCOPES — contains drive scope", () => {
  assertStringIncludes(
    GOOGLE_OAUTH_SCOPES,
    "https://www.googleapis.com/auth/drive",
  );
});

Deno.test("unit: GOOGLE_OAUTH_SCOPES — contains openid", () => {
  assertStringIncludes(GOOGLE_OAUTH_SCOPES, "openid");
});

// ─── refreshGoogleAccessToken ─────────────────────────────────────────────

Deno.test(
  "unit: refreshGoogleAccessToken — throws GoogleReauthRequiredError on invalid_grant (HTTP 400)",
  async () => {
    Deno.env.set("GOOGLE_CLIENT_ID", FAKE_CLIENT_ID);
    Deno.env.set("GOOGLE_CLIENT_SECRET", "test-client-secret");

    const originalFetch = globalThis.fetch;
    globalThis.fetch =
      ((_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
          }),
        )) as typeof fetch;

    try {
      let thrown: unknown;
      try {
        await refreshGoogleAccessToken("stale-refresh-token");
      } catch (err) {
        thrown = err;
      }
      assertInstanceOf(thrown, GoogleReauthRequiredError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test(
  "unit: refreshGoogleAccessToken — throws generic Error on other HTTP errors (not invalid_grant)",
  async () => {
    Deno.env.set("GOOGLE_CLIENT_ID", FAKE_CLIENT_ID);
    Deno.env.set("GOOGLE_CLIENT_SECRET", "test-client-secret");

    const originalFetch = globalThis.fetch;
    globalThis.fetch =
      ((_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "server_error" }), {
            status: 500,
          }),
        )) as typeof fetch;

    try {
      let thrown: unknown;
      try {
        await refreshGoogleAccessToken("stale-refresh-token");
      } catch (err) {
        thrown = err;
      }
      // Must NOT be a GoogleReauthRequiredError — should be a plain Error
      if (thrown instanceof GoogleReauthRequiredError) {
        throw new Error(
          "Expected a plain Error but got GoogleReauthRequiredError",
        );
      }
      assertInstanceOf(thrown, Error);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);
