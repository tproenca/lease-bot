// unit: _shared/autentique.ts — input-bounds validation (no network calls) and
// new signing operations (submitDocument, getDocumentStatus, updateReminderFrequency).
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  getDocumentStatus,
  submitDocument,
  updateReminderFrequency,
  validateAutentiqueApiKey,
} from "./autentique.ts";

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

// ═══════════════════════════════════════════════════════════════════════════
// unit: submitDocument
// ═══════════════════════════════════════════════════════════════════════════

const VALID_API_KEY = "a".repeat(32);
const MOCK_PDF_BASE64 = btoa("mock-pdf-bytes");
const MOCK_SIGNERS = [
  {
    name: "João Silva",
    whatsapp: "+5511999999999",
    role: "LOCATARIO",
    x: 60,
    y: 120,
    page: 1,
  },
];

Deno.test("unit: submitDocument — throws on invalid API key (too short)", async () => {
  let threw = false;
  try {
    await submitDocument("short", {
      pdfBase64: MOCK_PDF_BASE64,
      signers: MOCK_SIGNERS,
      reminderFrequency: "WEEKLY",
    });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("unit: submitDocument — throws on empty pdfBase64", async () => {
  let threw = false;
  try {
    await submitDocument(VALID_API_KEY, {
      pdfBase64: "",
      signers: MOCK_SIGNERS,
      reminderFrequency: "WEEKLY",
    });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("unit: submitDocument — throws on empty signers array", async () => {
  let threw = false;
  try {
    await submitDocument(VALID_API_KEY, {
      pdfBase64: MOCK_PDF_BASE64,
      signers: [],
      reminderFrequency: "WEEKLY",
    });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("unit: submitDocument — returns documentId on success (network mocked)", async () => {
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ data: { createDocument: { id: "doc-xyz-123" } } }),
        { status: 200 },
      ),
    );
  try {
    const result = await submitDocument(VALID_API_KEY, {
      pdfBase64: MOCK_PDF_BASE64,
      signers: MOCK_SIGNERS,
      reminderFrequency: "WEEKLY",
    });
    assertEquals(result.documentId, "doc-xyz-123");
  } finally {
    globalThis.fetch = _originalFetch;
  }
});

Deno.test("unit: submitDocument — throws on GraphQL errors in response", async () => {
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ errors: [{ message: "unauthorized" }] }),
        { status: 200 },
      ),
    );
  let threw = false;
  try {
    await submitDocument(VALID_API_KEY, {
      pdfBase64: MOCK_PDF_BASE64,
      signers: MOCK_SIGNERS,
      reminderFrequency: "DAILY",
    });
  } catch {
    threw = true;
  } finally {
    globalThis.fetch = _originalFetch;
  }
  assertEquals(threw, true);
});

Deno.test("unit: submitDocument — throws on HTTP error status", async () => {
  globalThis.fetch = () =>
    Promise.resolve(new Response("Internal Server Error", { status: 500 }));
  let threw = false;
  try {
    await submitDocument(VALID_API_KEY, {
      pdfBase64: MOCK_PDF_BASE64,
      signers: MOCK_SIGNERS,
      reminderFrequency: "WEEKLY",
    });
  } catch {
    threw = true;
  } finally {
    globalThis.fetch = _originalFetch;
  }
  assertEquals(threw, true);
});

Deno.test("unit: submitDocument — sends Authorization Bearer header (network mocked)", async () => {
  let capturedHeader: string | undefined;
  globalThis.fetch = (_input: string | URL | Request, init?: RequestInit) => {
    // For multipart FormData, headers are on the request init.
    const headers = init?.headers;
    if (headers instanceof Headers) {
      capturedHeader = headers.get("Authorization") ?? undefined;
    } else if (typeof headers === "object" && headers !== null) {
      capturedHeader = (headers as Record<string, string>)["Authorization"];
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({ data: { createDocument: { id: "doc-abc" } } }),
        { status: 200 },
      ),
    );
  };
  try {
    await submitDocument(VALID_API_KEY, {
      pdfBase64: MOCK_PDF_BASE64,
      signers: MOCK_SIGNERS,
      reminderFrequency: "WEEKLY",
    });
    assertEquals(capturedHeader, `Bearer ${VALID_API_KEY}`);
  } finally {
    globalThis.fetch = _originalFetch;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: getDocumentStatus
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: getDocumentStatus — throws on invalid API key", async () => {
  let threw = false;
  try {
    await getDocumentStatus("short", "doc-id");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("unit: getDocumentStatus — throws on empty documentId", async () => {
  let threw = false;
  try {
    await getDocumentStatus(VALID_API_KEY, "");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("unit: getDocumentStatus — returns pending when some signers unsigned", async () => {
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: {
            document: {
              name: "Contrato",
              signatures: [
                {
                  name: "João",
                  signed: { created_at: "2026-01-15T10:00:00Z" },
                },
                { name: "Maria", signed: null },
              ],
            },
          },
        }),
        { status: 200 },
      ),
    );
  try {
    const result = await getDocumentStatus(VALID_API_KEY, "doc-uuid");
    assertEquals(result.status, "pending");
    assertEquals(result.signers.length, 2);
    assertEquals(result.signers[0].signed_at, "2026-01-15T10:00:00Z");
    assertEquals(result.signers[1].signed_at, null);
  } finally {
    globalThis.fetch = _originalFetch;
  }
});

Deno.test("unit: getDocumentStatus — returns completed when all signers signed", async () => {
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: {
            document: {
              name: "Contrato",
              signatures: [
                {
                  name: "João",
                  signed: { created_at: "2026-01-15T10:00:00Z" },
                },
                {
                  name: "Maria",
                  signed: { created_at: "2026-01-16T11:00:00Z" },
                },
              ],
            },
          },
        }),
        { status: 200 },
      ),
    );
  try {
    const result = await getDocumentStatus(VALID_API_KEY, "doc-uuid");
    assertEquals(result.status, "completed");
    assertEquals(result.signers.every((s) => s.signed_at !== null), true);
  } finally {
    globalThis.fetch = _originalFetch;
  }
});

Deno.test("unit: getDocumentStatus — throws on GraphQL errors", async () => {
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ errors: [{ message: "not found" }] }),
        { status: 200 },
      ),
    );
  let threw = false;
  try {
    await getDocumentStatus(VALID_API_KEY, "doc-uuid");
  } catch {
    threw = true;
  } finally {
    globalThis.fetch = _originalFetch;
  }
  assertEquals(threw, true);
});

Deno.test("unit: getDocumentStatus — returns pending when no signatures present", async () => {
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: {
            document: {
              name: "Contrato",
              signatures: [],
            },
          },
        }),
        { status: 200 },
      ),
    );
  try {
    const result = await getDocumentStatus(VALID_API_KEY, "doc-uuid");
    assertEquals(result.status, "pending");
    assertEquals(result.signers.length, 0);
  } finally {
    globalThis.fetch = _originalFetch;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: updateReminderFrequency
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: updateReminderFrequency — throws on invalid API key", async () => {
  let threw = false;
  try {
    await updateReminderFrequency("short", "doc-id", "DAILY");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("unit: updateReminderFrequency — throws on invalid frequency", async () => {
  let threw = false;
  try {
    await updateReminderFrequency(
      VALID_API_KEY,
      "doc-id",
      "MONTHLY" as "DAILY" | "WEEKLY",
    );
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("unit: updateReminderFrequency — resolves on success with DAILY", async () => {
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ data: { updateDocument: { id: "doc-uuid" } } }),
        { status: 200 },
      ),
    );
  try {
    await updateReminderFrequency(VALID_API_KEY, "doc-uuid", "DAILY");
    // No throw = success.
    assertEquals(true, true);
  } finally {
    globalThis.fetch = _originalFetch;
  }
});

Deno.test("unit: updateReminderFrequency — resolves on success with WEEKLY", async () => {
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ data: { updateDocument: { id: "doc-uuid" } } }),
        { status: 200 },
      ),
    );
  try {
    await updateReminderFrequency(VALID_API_KEY, "doc-uuid", "WEEKLY");
    assertEquals(true, true);
  } finally {
    globalThis.fetch = _originalFetch;
  }
});

Deno.test("unit: updateReminderFrequency — throws on GraphQL errors", async () => {
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ errors: [{ message: "server error" }] }),
        { status: 200 },
      ),
    );
  let threw = false;
  try {
    await updateReminderFrequency(VALID_API_KEY, "doc-uuid", "DAILY");
  } catch {
    threw = true;
  } finally {
    globalThis.fetch = _originalFetch;
  }
  assertEquals(threw, true);
});

Deno.test("unit: updateReminderFrequency — throws on HTTP error", async () => {
  globalThis.fetch = () =>
    Promise.resolve(new Response("Server Error", { status: 500 }));
  let threw = false;
  try {
    await updateReminderFrequency(VALID_API_KEY, "doc-uuid", "WEEKLY");
  } catch {
    threw = true;
  } finally {
    globalThis.fetch = _originalFetch;
  }
  assertEquals(threw, true);
});
