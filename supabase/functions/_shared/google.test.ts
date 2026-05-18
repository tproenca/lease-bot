// unit: _shared/google.ts — buildGoogleAuthUrl
//
// Sets the required env vars inline so this test is self-contained and does
// not require a running Supabase instance.
import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildGoogleAuthUrl, GOOGLE_OAUTH_SCOPES } from "./google.ts";

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
