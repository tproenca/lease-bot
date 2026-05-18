// unit: _shared/cookies.ts
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  clearCookie,
  parseCookies,
  serializeCookie,
} from "./cookies.ts";

// ─── parseCookies ─────────────────────────────────────────────────────────

Deno.test("unit: parseCookies — returns empty object for null header", () => {
  assertEquals(parseCookies(null), {});
});

Deno.test("unit: parseCookies — parses single cookie", () => {
  assertEquals(parseCookies("foo=bar"), { foo: "bar" });
});

Deno.test("unit: parseCookies — parses multiple cookies", () => {
  assertEquals(parseCookies("a=1; b=2; c=3"), { a: "1", b: "2", c: "3" });
});

Deno.test("unit: parseCookies — handles value with = sign", () => {
  const result = parseCookies("token=abc=def");
  assertEquals(result["token"], "abc=def");
});

Deno.test("unit: parseCookies — trims whitespace around names and values", () => {
  assertEquals(parseCookies("  foo  = bar "), { foo: "bar" });
});

Deno.test("unit: parseCookies — skips empty segments", () => {
  const result = parseCookies(";foo=bar;;");
  assertEquals(result["foo"], "bar");
});

Deno.test("unit: parseCookies — handles empty value", () => {
  assertEquals(parseCookies("foo="), { foo: "" });
});

// ─── serializeCookie ─────────────────────────────────────────────────────

Deno.test("unit: serializeCookie — minimal (defaults)", () => {
  const s = serializeCookie("foo", "bar");
  assertStringIncludes(s, "foo=bar");
  assertStringIncludes(s, "Path=/");
  assertStringIncludes(s, "HttpOnly");
  assertStringIncludes(s, "SameSite=Lax");
});

Deno.test("unit: serializeCookie — includes Max-Age when set", () => {
  const s = serializeCookie("foo", "bar", { maxAge: 600 });
  assertStringIncludes(s, "Max-Age=600");
});

Deno.test("unit: serializeCookie — includes Secure when set", () => {
  const s = serializeCookie("foo", "bar", { secure: true });
  assertStringIncludes(s, "Secure");
});

Deno.test("unit: serializeCookie — omits Secure when not set", () => {
  const s = serializeCookie("foo", "bar", { secure: false });
  assertEquals(s.includes("Secure"), false);
});

Deno.test("unit: serializeCookie — respects SameSite override", () => {
  const s = serializeCookie("foo", "bar", { sameSite: "Strict" });
  assertStringIncludes(s, "SameSite=Strict");
});

Deno.test("unit: serializeCookie — can disable HttpOnly", () => {
  const s = serializeCookie("foo", "bar", { httpOnly: false });
  assertEquals(s.includes("HttpOnly"), false);
});

Deno.test("unit: serializeCookie — respects custom Path", () => {
  const s = serializeCookie("foo", "bar", { path: "/setup" });
  assertStringIncludes(s, "Path=/setup");
});

// ─── clearCookie ─────────────────────────────────────────────────────────

Deno.test("unit: clearCookie — sets Max-Age=0 and empty value", () => {
  const s = clearCookie("foo");
  assertStringIncludes(s, "foo=");
  assertStringIncludes(s, "Max-Age=0");
});
