// unit: setup/complete/index.ts — sanitizeApiKey
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Set required env vars before importing the module.
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
Deno.env.set("GOOGLE_CLIENT_ID", "test-client-id");
Deno.env.set("GOOGLE_CLIENT_SECRET", "test-client-secret");

import { sanitizeApiKey } from "./index.ts";

Deno.test("unit: sanitizeApiKey — accepts valid 32-char alphanumeric key", () => {
  assertEquals(sanitizeApiKey("a".repeat(32)), "a".repeat(32));
});

Deno.test("unit: sanitizeApiKey — trims surrounding whitespace", () => {
  assertEquals(sanitizeApiKey("  " + "a".repeat(32) + "  "), "a".repeat(32));
});

Deno.test("unit: sanitizeApiKey — rejects non-string", () => {
  assertEquals(sanitizeApiKey(null), null);
  assertEquals(sanitizeApiKey(undefined), null);
  assertEquals(sanitizeApiKey(12345), null);
});

Deno.test("unit: sanitizeApiKey — rejects too-short key (< 10)", () => {
  assertEquals(sanitizeApiKey("short"), null);
});

Deno.test("unit: sanitizeApiKey — accepts exactly 10 chars", () => {
  assertEquals(sanitizeApiKey("a".repeat(10)), "a".repeat(10));
});

Deno.test("unit: sanitizeApiKey — accepts exactly 256 chars", () => {
  assertEquals(sanitizeApiKey("a".repeat(256)), "a".repeat(256));
});

Deno.test("unit: sanitizeApiKey — rejects 257 chars", () => {
  assertEquals(sanitizeApiKey("a".repeat(257)), null);
});

Deno.test("unit: sanitizeApiKey — rejects key with newline", () => {
  assertEquals(sanitizeApiKey("validlongkey12345\nX-Evil: injected"), null);
});

Deno.test("unit: sanitizeApiKey — rejects key with carriage return", () => {
  assertEquals(sanitizeApiKey("validlongkey12345\r"), null);
});

Deno.test("unit: sanitizeApiKey — rejects key with NUL byte", () => {
  assertEquals(sanitizeApiKey("validlongkey12345\x00"), null);
});

Deno.test("unit: sanitizeApiKey — rejects key with tab character", () => {
  assertEquals(sanitizeApiKey("validlong\tkey"), null);
});

Deno.test("unit: sanitizeApiKey — rejects key with internal space", () => {
  assertEquals(sanitizeApiKey("valid long key 12345"), null);
});

Deno.test("unit: sanitizeApiKey — accepts key with hyphens and underscores", () => {
  assertEquals(
    sanitizeApiKey("valid-key_with-dashes"),
    "valid-key_with-dashes",
  );
});
