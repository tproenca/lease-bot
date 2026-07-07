// unit: _shared/retry.ts
import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { retryWithBackoff } from "./retry.ts";

// Use baseDelayMs: 0 throughout so tests don't actually sleep.

// ─── result-based retry (shouldRetry) ─────────────────────────────────────

Deno.test("unit: retryWithBackoff — returns first result when shouldRetry is false", async () => {
  let calls = 0;
  const result = await retryWithBackoff(() => {
    calls++;
    return Promise.resolve("ok");
  }, { baseDelayMs: 0, shouldRetry: () => false });
  assertStrictEquals(result, "ok");
  assertStrictEquals(calls, 1);
});

Deno.test("unit: retryWithBackoff — retries while shouldRetry is true, then returns success", async () => {
  let calls = 0;
  const result = await retryWithBackoff(() => {
    calls++;
    return Promise.resolve(calls < 3 ? 500 : 200);
  }, {
    baseDelayMs: 0,
    maxAttempts: 5,
    shouldRetry: (status) => status === 500,
  });
  assertStrictEquals(result, 200);
  assertStrictEquals(calls, 3);
});

Deno.test("unit: retryWithBackoff — exhausts attempts and returns last (still-retryable) result", async () => {
  let calls = 0;
  const result = await retryWithBackoff(() => {
    calls++;
    return Promise.resolve(500);
  }, {
    baseDelayMs: 0,
    maxAttempts: 3,
    shouldRetry: (status) => status === 500,
  });
  assertStrictEquals(result, 500);
  assertStrictEquals(calls, 3);
});

// ─── exception-based retry (retryOnThrow) ─────────────────────────────────

Deno.test("unit: retryWithBackoff — does NOT retry on throw by default", async () => {
  let calls = 0;
  await assertRejects(
    () =>
      retryWithBackoff(() => {
        calls++;
        return Promise.reject(new Error("boom"));
      }, { baseDelayMs: 0, maxAttempts: 3 }),
    Error,
    "boom",
  );
  assertStrictEquals(calls, 1);
});

Deno.test("unit: retryWithBackoff — retries on throw when retryOnThrow is set, then succeeds", async () => {
  let calls = 0;
  const result = await retryWithBackoff(() => {
    calls++;
    if (calls < 3) return Promise.reject(new Error("transient"));
    return Promise.resolve("done");
  }, { baseDelayMs: 0, maxAttempts: 5, retryOnThrow: true });
  assertStrictEquals(result, "done");
  assertStrictEquals(calls, 3);
});

Deno.test("unit: retryWithBackoff — rethrows the last error after exhausting attempts", async () => {
  let calls = 0;
  await assertRejects(
    () =>
      retryWithBackoff(() => {
        calls++;
        return Promise.reject(new Error(`fail-${calls}`));
      }, { baseDelayMs: 0, maxAttempts: 3, retryOnThrow: true }),
    Error,
    "fail-3",
  );
  assertStrictEquals(calls, 3);
});

Deno.test("unit: retryWithBackoff — default maxAttempts is 3", async () => {
  let calls = 0;
  await retryWithBackoff(() => {
    calls++;
    return Promise.resolve(500);
  }, { baseDelayMs: 0, shouldRetry: () => true });
  assertEquals(calls, 3);
});
