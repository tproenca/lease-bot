// unit: /auth/callback helpers — parseChatgptRedirectCookie, buildChatgptCallbackUrl
//
// These pure helpers are exported from the callback handler for testability.
// They are exercised here without needing a running Supabase instance.

import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// Set required env vars before importing the module (requireEnv is called at
// import time via transitively imported modules).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
Deno.env.set("GOOGLE_CLIENT_ID", "test-client-id");
Deno.env.set("GOOGLE_CLIENT_SECRET", "test-client-secret");
Deno.env.set(
  "PUBLIC_FUNCTIONS_BASE_URL",
  "http://localhost:54321/functions/v1",
);

import {
  buildChatgptCallbackUrl,
  parseChatgptRedirectCookie,
} from "./index.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// parseChatgptRedirectCookie
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("unit: parseChatgptRedirectCookie — returns null for undefined input", () => {
  assertEquals(parseChatgptRedirectCookie(undefined), null);
});

Deno.test("unit: parseChatgptRedirectCookie — returns null for empty string", () => {
  assertEquals(parseChatgptRedirectCookie(""), null);
});

Deno.test("unit: parseChatgptRedirectCookie — returns null for malformed JSON", () => {
  const bad = encodeURIComponent("not-json");
  assertEquals(parseChatgptRedirectCookie(bad), null);
});

Deno.test("unit: parseChatgptRedirectCookie — returns null when redirect_uri missing", () => {
  const val = encodeURIComponent(JSON.stringify({ state: "s" }));
  assertEquals(parseChatgptRedirectCookie(val), null);
});

Deno.test("unit: parseChatgptRedirectCookie — returns null when redirect_uri is empty string", () => {
  const val = encodeURIComponent(
    JSON.stringify({ redirect_uri: "", state: "s" }),
  );
  assertEquals(parseChatgptRedirectCookie(val), null);
});

Deno.test("unit: parseChatgptRedirectCookie — parses valid cookie with state", () => {
  const val = encodeURIComponent(
    JSON.stringify({
      redirect_uri: "https://chat.openai.com/aip/callback",
      state: "openai-state-xyz",
    }),
  );
  const result = parseChatgptRedirectCookie(val);
  assertEquals(result?.redirect_uri, "https://chat.openai.com/aip/callback");
  assertEquals(result?.state, "openai-state-xyz");
});

Deno.test("unit: parseChatgptRedirectCookie — defaults state to empty string when absent", () => {
  const val = encodeURIComponent(
    JSON.stringify({ redirect_uri: "https://chat.openai.com/aip/callback" }),
  );
  const result = parseChatgptRedirectCookie(val);
  assertEquals(result?.state, "");
});

Deno.test("unit: parseChatgptRedirectCookie — returns null for non-string redirect_uri", () => {
  const val = encodeURIComponent(
    JSON.stringify({ redirect_uri: 42, state: "s" }),
  );
  assertEquals(parseChatgptRedirectCookie(val), null);
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildChatgptCallbackUrl
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("unit: buildChatgptCallbackUrl — includes code param", () => {
  const url = buildChatgptCallbackUrl(
    "https://chat.openai.com/aip/callback",
    "test-code-123",
    "state-abc",
  );
  assertStringIncludes(url, "code=test-code-123");
});

Deno.test("unit: buildChatgptCallbackUrl — includes state param when non-empty", () => {
  const url = buildChatgptCallbackUrl(
    "https://chat.openai.com/aip/callback",
    "code",
    "openai-state",
  );
  assertStringIncludes(url, "state=openai-state");
});

Deno.test("unit: buildChatgptCallbackUrl — omits state param when empty", () => {
  const url = buildChatgptCallbackUrl(
    "https://chat.openai.com/aip/callback",
    "code",
    "",
  );
  assertEquals(url.includes("state="), false);
});

Deno.test("unit: buildChatgptCallbackUrl — preserves base redirect_uri", () => {
  const base = "https://chat.openai.com/aip/callback";
  const url = buildChatgptCallbackUrl(base, "c", "s");
  assertStringIncludes(url, "chat.openai.com/aip/callback");
});

Deno.test("unit: buildChatgptCallbackUrl — merges params onto existing query string", () => {
  const base = "https://chat.openai.com/aip/callback?existing=1";
  const url = buildChatgptCallbackUrl(base, "mycode", "mystate");
  assertStringIncludes(url, "existing=1");
  assertStringIncludes(url, "code=mycode");
  assertStringIncludes(url, "state=mystate");
});
