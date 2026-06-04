// contract: ERROR_MAP coverage — every error code emitted by any endpoint
// handler must exist as a key in ERROR_MAP.
//
// The test is data-driven: it scans all non-test TypeScript source files under
// supabase/functions/ for errorResponse( calls and extracts the second argument
// (the code string). It then asserts each collected code is present in
// ERROR_MAP. This catches regressions where a new code is added to an endpoint
// but the map is not updated.
//
// Additionally, the test verifies the three-tier resolveErrorMessage helper
// behaves correctly for each tier.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ERROR_MAP,
  GENERIC_ERROR_MESSAGE,
  resolveErrorMessage,
} from "./error-map.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Walk a directory tree and yield .ts file paths (excluding .test.ts files). */
async function* walkTsFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      yield* walkTsFiles(path);
    } else if (
      entry.isFile &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts")
    ) {
      yield path;
    }
  }
}

/**
 * Extract all string literals used as the second argument to errorResponse()
 * calls in the given source text.
 *
 * Matches patterns like:
 *   errorResponse(405, "METHOD_NOT_ALLOWED", ...)
 *   errorResponse(
 *     400,
 *     "INVALID_JSON",
 *     ...
 *   )
 *
 * The regex captures the code on the same line as errorResponse( or on the
 * immediately following lines, handling both compact and multi-line styles.
 */
function extractErrorCodes(source: string): string[] {
  const codes: string[] = [];
  // Match errorResponse( followed by optional whitespace/newlines, a status
  // number, optional whitespace/newlines + comma, then the code string.
  const pattern =
    /errorResponse\s*\(\s*\d+\s*,\s*(?:\/\/[^\n]*)?\s*"([A-Z][A-Z0-9_]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    codes.push(match[1]);
  }
  return codes;
}

// ─── Contract test ────────────────────────────────────────────────────────────

Deno.test("contract: every errorResponse() code in endpoint handlers exists in ERROR_MAP", async () => {
  // Resolve the functions root relative to this file's location.
  const functionsRoot = new URL("../", import.meta.url).pathname;

  const missing: Array<{ file: string; code: string }> = [];

  for await (const filePath of walkTsFiles(functionsRoot)) {
    const source = await Deno.readTextFile(filePath);
    const codes = extractErrorCodes(source);
    for (const code of codes) {
      if (!(code in ERROR_MAP)) {
        missing.push({ file: filePath.replace(functionsRoot, ""), code });
      }
    }
  }

  if (missing.length > 0) {
    const report = missing
      .map(({ file, code }) => `  ${code}  (in ${file})`)
      .join("\n");
    throw new Error(
      `The following error codes are used in endpoint handlers but are missing from ERROR_MAP:\n${report}\n\nAdd them to supabase/functions/_shared/error-map.ts.`,
    );
  }

  // Sanity: ERROR_MAP must not be empty.
  assertEquals(Object.keys(ERROR_MAP).length > 0, true);
});

// ─── resolveErrorMessage — unit tests ─────────────────────────────────────────

Deno.test("unit: resolveErrorMessage — tier 1: returns ERROR_MAP entry for known code", () => {
  const result = resolveErrorMessage("GOOGLE_REAUTH_REQUIRED");
  assertEquals(result, ERROR_MAP["GOOGLE_REAUTH_REQUIRED"]);
});

Deno.test("unit: resolveErrorMessage — tier 1: ERROR_MAP wins over backendMessage", () => {
  const result = resolveErrorMessage(
    "GOOGLE_REAUTH_REQUIRED",
    "some backend message",
  );
  assertEquals(result, ERROR_MAP["GOOGLE_REAUTH_REQUIRED"]);
});

Deno.test("unit: resolveErrorMessage — tier 2: returns backendMessage for unknown code when present", () => {
  const result = resolveErrorMessage(
    "SOME_UNKNOWN_CODE_XYZ",
    "Mensagem do backend.",
  );
  assertEquals(result, "Mensagem do backend.");
});

Deno.test("unit: resolveErrorMessage — tier 3: returns generic fallback for unknown code with no backendMessage", () => {
  const result = resolveErrorMessage("SOME_UNKNOWN_CODE_XYZ");
  assertEquals(result, GENERIC_ERROR_MESSAGE);
});

Deno.test("unit: resolveErrorMessage — tier 3: returns generic fallback for empty code with no backendMessage", () => {
  const result = resolveErrorMessage("");
  assertEquals(result, GENERIC_ERROR_MESSAGE);
});

Deno.test("unit: resolveErrorMessage — tier 3: empty backendMessage falls through to generic", () => {
  const result = resolveErrorMessage("SOME_UNKNOWN_CODE_XYZ", "");
  assertEquals(result, GENERIC_ERROR_MESSAGE);
});
