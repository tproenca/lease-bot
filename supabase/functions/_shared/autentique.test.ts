// unit: _shared/autentique.ts — input-bounds validation (no network calls)
//
// Tests that validateAutentiqueApiKey rejects malformed keys before any
// network call is made, preventing header injection attacks.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { validateAutentiqueApiKey } from "./autentique.ts";

// We intercept fetch globally to ensure no real network calls occur.
const _originalFetch = globalThis.fetch;

function assertNoNetworkCalls() {
  let called = false;
  globalThis.fetch = () => {
    called = true;
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  return () => {
    globalThis.fetch = _originalFetch;
    return called;
  };
}

Deno.test("unit: validateAutentiqueApiKey — rejects non-string", async () => {
  const check = assertNoNetworkCalls();
  const r = await validateAutentiqueApiKey(null as unknown as string);
  check();
  assertEquals(r.ok, false);
});

Deno.test("unit: validateAutentiqueApiKey — rejects key shorter than 10 chars", async () => {
  const check = assertNoNetworkCalls();
  const r = await validateAutentiqueApiKey("short");
  check();
  assertEquals(r.ok, false);
});

Deno.test("unit: validateAutentiqueApiKey — rejects key longer than 256 chars", async () => {
  const check = assertNoNetworkCalls();
  const r = await validateAutentiqueApiKey("a".repeat(257));
  check();
  assertEquals(r.ok, false);
});

Deno.test("unit: validateAutentiqueApiKey — rejects key with newline (header injection)", async () => {
  const check = assertNoNetworkCalls();
  const r = await validateAutentiqueApiKey("validlongkey\nX-Evil: injected");
  check();
  assertEquals(r.ok, false);
});

Deno.test("unit: validateAutentiqueApiKey — rejects key with carriage return", async () => {
  const check = assertNoNetworkCalls();
  const r = await validateAutentiqueApiKey("validlongkey\rX-Evil: injected");
  check();
  assertEquals(r.ok, false);
});

Deno.test("unit: validateAutentiqueApiKey — rejects key with internal whitespace", async () => {
  const check = assertNoNetworkCalls();
  const r = await validateAutentiqueApiKey("valid key with spaces");
  check();
  assertEquals(r.ok, false);
});

Deno.test("unit: validateAutentiqueApiKey — rejects key with NUL character", async () => {
  const check = assertNoNetworkCalls();
  const r = await validateAutentiqueApiKey("validlongkey\x00rest");
  check();
  assertEquals(r.ok, false);
});

Deno.test("unit: validateAutentiqueApiKey — exactly 10 chars passes input bounds (network mocked)", async () => {
  // Replace fetch with a mock that returns a valid Autentique-like response.
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ data: { me: { name: "Test User" } } }),
        { status: 200 },
      ),
    );
  try {
    const r = await validateAutentiqueApiKey("a".repeat(10));
    assertEquals(r.ok, true);
  } finally {
    globalThis.fetch = _originalFetch;
  }
});

Deno.test("unit: validateAutentiqueApiKey — exactly 256 chars passes input bounds (network mocked)", async () => {
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ data: { me: { name: "Test User" } } }),
        { status: 200 },
      ),
    );
  try {
    const r = await validateAutentiqueApiKey("a".repeat(256));
    assertEquals(r.ok, true);
  } finally {
    globalThis.fetch = _originalFetch;
  }
});
