// unit: documents/signatures/detect
//
// Unit tests for detectSignaturePositions (marker-based, [[ROLE]] approach).
// All PDFs are constructed synthetically in-memory — no disk I/O.
//
// Test names follow the "unit:" / "integration:" prefix convention.
//
// Strategy:
//   The detect.ts implementation scans raw PDF bytes using TextDecoder("latin1")
//   for [[ROLE]] marker strings.  pdf-lib's drawText() encodes text through
//   font glyph maps, making markers invisible to the raw byte scanner.
//
//   To produce PDFs where the markers are present as literal ASCII in the raw
//   bytes we hand-build minimal PDF structures with uncompressed content
//   streams.  Each "page" section is separated by a /Type /Page dictionary
//   entry so the implementation's page-splitting logic works correctly.
//
//   For failure cases we use blank PDFs created with pdf-lib (no markers).

import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { PDFDocument } from "pdf-lib";
import {
  DetectResult,
  detectSignaturePositions,
  SignerPosition,
} from "./detect.ts";

// ─── Fixture helpers ──────────────────────────────────────────────────────

/**
 * Build a minimal but valid PDF whose raw bytes contain the given marker
 * strings verbatim.  Each entry in `pages` is a list of marker strings to
 * embed on that page (0-based).
 *
 * The PDF is hand-crafted to keep it small while still passing pdf-lib's
 * parser (used by detectSignaturePositions to determine page count and
 * dimensions).  Content streams are stored uncompressed so the raw-text
 * scanner in detect.ts can find [[ROLE]] patterns directly.
 *
 * Page dimensions: A4 (595 × 842 pt).
 */
function buildRawPdf(pages: string[][]): Uint8Array {
  // We build a cross-reference table manually.
  // Object layout:
  //   1 0 obj  — catalog
  //   2 0 obj  — pages dict
  //   3 0 obj  — page 0
  //   4 0 obj  — content stream for page 0
  //   5 0 obj  — page 1 (if present)
  //   6 0 obj  — content stream for page 1 (if present)
  //   … etc.

  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  let offset = 0;
  // offsets tracked in objOffsets below (1-indexed)

  function emit(s: string): void {
    const bytes = encoder.encode(s);
    parts.push(bytes);
    offset += bytes.length;
  }

  // PDF header.
  emit("%PDF-1.4\n");

  const pageCount = pages.length;
  // Object numbers:
  //   1 → catalog
  //   2 → pages
  //   3+2*i → page i
  //   4+2*i → content stream for page i
  const catalogObj = 1;
  const pagesObj = 2;
  const pageObjBase = 3; // page i → pageObjBase + 2*i
  const contentObjBase = 4; // content for page i → contentObjBase + 2*i

  const totalObjs = 2 + pageCount * 2; // catalog + pages + N pages + N streams

  // Placeholder array for offsets (filled in as we emit objects).
  const objOffsets = new Array<number>(totalObjs + 1).fill(0);

  // ── Object 1: Catalog ──────────────────────────────────────────────────
  objOffsets[catalogObj] = offset;
  emit(`${catalogObj} 0 obj\n`);
  emit(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>\n`);
  emit("endobj\n");

  // ── Object 2: Pages ───────────────────────────────────────────────────
  objOffsets[pagesObj] = offset;
  emit(`${pagesObj} 0 obj\n`);
  const kidRefs = Array.from(
    { length: pageCount },
    (_, i) => `${pageObjBase + 2 * i} 0 R`,
  ).join(" ");
  emit(
    `<< /Type /Pages /Kids [${kidRefs}] /Count ${pageCount} >>\n`,
  );
  emit("endobj\n");

  // ── One object pair per page ───────────────────────────────────────────
  for (let i = 0; i < pageCount; i++) {
    const pageObj = pageObjBase + 2 * i;
    const contentObj = contentObjBase + 2 * i;

    // Build content stream — embed each marker on its own line as a PDF
    // comment so the raw-text scanner finds it without font encoding.
    // PDF comments start with %; they are preserved in uncompressed streams
    // and readable by latin1 decode.  We also emit the markers as bare
    // text tokens outside any text block so they survive the raw scan.
    const markers = pages[i] ?? [];
    const streamBody = markers.map((m) => `% ${m}\n${m}\n`).join("");
    const streamLen = encoder.encode(streamBody).length;

    // Page dictionary.
    objOffsets[pageObj] = offset;
    emit(`${pageObj} 0 obj\n`);
    emit(
      `<< /Type /Page /Parent ${pagesObj} 0 R ` +
        `/MediaBox [0 0 595 842] ` +
        `/Contents ${contentObj} 0 R >>\n`,
    );
    emit("endobj\n");

    // Content stream.
    objOffsets[contentObj] = offset;
    emit(`${contentObj} 0 obj\n`);
    emit(`<< /Length ${streamLen} >>\n`);
    emit("stream\n");
    emit(streamBody);
    emit("endstream\n");
    emit("endobj\n");
  }

  // ── Cross-reference table ──────────────────────────────────────────────
  const xrefOffset = offset;
  emit("xref\n");
  emit(`0 ${totalObjs + 1}\n`);
  emit("0000000000 65535 f \n"); // free list head

  for (let n = 1; n <= totalObjs; n++) {
    emit(`${String(objOffsets[n]).padStart(10, "0")} 00000 n \n`);
  }

  // ── Trailer ───────────────────────────────────────────────────────────
  emit("trailer\n");
  emit(`<< /Size ${totalObjs + 1} /Root ${catalogObj} 0 R >>\n`);
  emit("startxref\n");
  emit(`${xrefOffset}\n`);
  emit("%%EOF\n");

  // Concatenate all parts.
  const totalLen = parts.reduce((acc, p) => acc + p.length, 0);
  const result = new Uint8Array(totalLen);
  let pos = 0;
  for (const p of parts) {
    result.set(p, pos);
    pos += p.length;
  }
  return result;
}

/** Convenience: 1-page PDF with [[LOCADOR]] and [[LOCATARIO]] markers. */
function buildMinimalValidPdf(): Uint8Array {
  return buildRawPdf([["[[LOCADOR]]", "[[LOCATARIO]]"]]);
}

/** Run detection on raw bytes and return the result. */
async function detect(pdfBytes: Uint8Array): Promise<DetectResult> {
  return detectSignaturePositions(pdfBytes);
}

// ═══════════════════════════════════════════════════════════════════════════
// unit: basic valid case — both required markers present
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — valid PDF with required markers returns ok:true", async () => {
  const pdf = buildMinimalValidPdf();
  const result = await detect(pdf);
  assertEquals(result.ok, true);
});

Deno.test("unit: detect — valid PDF returns positions array", async () => {
  const pdf = buildMinimalValidPdf();
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(Array.isArray(result.positions), true);
  }
});

Deno.test("unit: detect — valid PDF returns 2 positions for required roles", async () => {
  const pdf = buildMinimalValidPdf();
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.positions.length, 2);
  }
});

Deno.test("unit: detect — LOCADOR position has role LOCADOR", async () => {
  const pdf = buildMinimalValidPdf();
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const pos = result.positions.find((p: SignerPosition) =>
      p.role === "LOCADOR"
    );
    assertEquals(pos !== undefined, true);
  }
});

Deno.test("unit: detect — LOCATARIO position has role LOCATARIO", async () => {
  const pdf = buildMinimalValidPdf();
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const pos = result.positions.find((p: SignerPosition) =>
      p.role === "LOCATARIO"
    );
    assertEquals(pos !== undefined, true);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: coordinate shape
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — each position has numeric x and y", async () => {
  const pdf = buildMinimalValidPdf();
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    for (const pos of result.positions) {
      assertEquals(typeof pos.x, "number");
      assertEquals(typeof pos.y, "number");
      assertEquals(isNaN(pos.x), false);
      assertEquals(isNaN(pos.y), false);
    }
  }
});

Deno.test("unit: detect — each position has x > 0", async () => {
  const pdf = buildMinimalValidPdf();
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    for (const pos of result.positions) {
      assertEquals(pos.x > 0, true);
    }
  }
});

Deno.test("unit: detect — each position has y > 0", async () => {
  const pdf = buildMinimalValidPdf();
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    for (const pos of result.positions) {
      assertEquals(pos.y > 0, true);
    }
  }
});

Deno.test("unit: detect — each position has a 1-based page number", async () => {
  const pdf = buildMinimalValidPdf();
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    for (const pos of result.positions) {
      assertEquals(typeof pos.page, "number");
      assertEquals(pos.page >= 1, true);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: witness markers are detected when present
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — TESTEMUNHA_1 marker detected when present", async () => {
  const pdf = buildRawPdf([
    ["[[LOCADOR]]", "[[LOCATARIO]]", "[[TESTEMUNHA_1]]"],
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.positions.length, 3);
    const t1 = result.positions.find((p: SignerPosition) =>
      p.role === "TESTEMUNHA_1"
    );
    assertEquals(t1 !== undefined, true);
  }
});

Deno.test("unit: detect — TESTEMUNHA_2 marker detected when present", async () => {
  const pdf = buildRawPdf([
    ["[[LOCADOR]]", "[[LOCATARIO]]", "[[TESTEMUNHA_1]]", "[[TESTEMUNHA_2]]"],
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.positions.length, 4);
    const t2 = result.positions.find((p: SignerPosition) =>
      p.role === "TESTEMUNHA_2"
    );
    assertEquals(t2 !== undefined, true);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: page number reporting
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — single-page PDF reports page 1 for all positions", async () => {
  const pdf = buildMinimalValidPdf();
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    for (const pos of result.positions) {
      assertEquals(pos.page, 1);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: failure — empty bytes
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — empty Uint8Array returns ok:false", async () => {
  const result = await detect(new Uint8Array(0));
  assertEquals(result.ok, false);
});

Deno.test("unit: detect — empty bytes error is detect_empty_pdf", async () => {
  const result = await detect(new Uint8Array(0));
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error, "detect_empty_pdf");
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: failure — invalid PDF bytes
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — random bytes return ok:false", async () => {
  const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xFF]);
  const result = await detect(bytes);
  assertEquals(result.ok, false);
});

Deno.test("unit: detect — invalid PDF error is detect_invalid_pdf", async () => {
  const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xFF]);
  const result = await detect(bytes);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error, "detect_invalid_pdf");
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: failure — missing required markers
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — PDF with no markers returns ok:false", async () => {
  const doc = await PDFDocument.create();
  doc.addPage();
  const bytes = await doc.save();
  const result = await detect(bytes);
  assertEquals(result.ok, false);
});

Deno.test("unit: detect — missing LOCADOR marker returns error string", async () => {
  // Only LOCATARIO present.
  const pdf = buildRawPdf([["[[LOCATARIO]]"]]);
  const result = await detect(pdf);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error, "LOCADOR");
  }
});

Deno.test("unit: detect — missing LOCATARIO marker returns error string", async () => {
  // Only LOCADOR present.
  const pdf = buildRawPdf([["[[LOCADOR]]"]]);
  const result = await detect(pdf);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error, "LOCATARIO");
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: result shape conformance
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — success result has ok:true and positions array", async () => {
  const pdf = buildMinimalValidPdf();
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(Array.isArray(result.positions), true);
  }
});

Deno.test("unit: detect — failure result has ok:false and error string", async () => {
  const doc = await PDFDocument.create();
  doc.addPage();
  const bytes = await doc.save();
  const result = await detect(bytes);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(typeof result.error, "string");
    assertEquals(result.error.length > 0, true);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: position ordering follows ROLE_ORDER
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — positions ordered LOCADOR before LOCATARIO", async () => {
  const pdf = buildMinimalValidPdf();
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const roles = result.positions.map((p: SignerPosition) => p.role);
    const locadorIdx = roles.indexOf("LOCADOR");
    const locatarioIdx = roles.indexOf("LOCATARIO");
    assertEquals(locadorIdx < locatarioIdx, true);
  }
});

Deno.test("unit: detect — TESTEMUNHA positions come after required roles", async () => {
  const pdf = buildRawPdf([
    ["[[LOCADOR]]", "[[LOCATARIO]]", "[[TESTEMUNHA_1]]"],
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const roles = result.positions.map((p: SignerPosition) => p.role);
    const t1Idx = roles.indexOf("TESTEMUNHA_1");
    const locatarioIdx = roles.indexOf("LOCATARIO");
    assertEquals(t1Idx > locatarioIdx, true);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: role coordinate values match DEFAULT_X / DEFAULT_Y constants
//
// detect.ts assigns fixed coordinates: x=60 for all positions, y starts at
// 120 and increments by 60 per additional signer on the same page.
// We derive expected values from these documented constants rather than
// hard-coding magic numbers.
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_X = 60;
const DEFAULT_Y_FIRST = 120;
const DEFAULT_Y_STEP = 60;

Deno.test("unit: detect — LOCADOR has x=DEFAULT_X", async () => {
  const pdf = buildMinimalValidPdf();
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const pos = result.positions.find((p: SignerPosition) =>
      p.role === "LOCADOR"
    )!;
    assertEquals(pos.x, DEFAULT_X);
  }
});

Deno.test("unit: detect — LOCADOR is first slot on page — y=DEFAULT_Y_FIRST", async () => {
  const pdf = buildMinimalValidPdf();
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const pos = result.positions.find((p: SignerPosition) =>
      p.role === "LOCADOR"
    )!;
    assertEquals(pos.y, DEFAULT_Y_FIRST);
  }
});

Deno.test("unit: detect — LOCATARIO is second slot on page — y=DEFAULT_Y_FIRST+DEFAULT_Y_STEP", async () => {
  const pdf = buildMinimalValidPdf();
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const pos = result.positions.find((p: SignerPosition) =>
      p.role === "LOCATARIO"
    )!;
    assertEquals(pos.y, DEFAULT_Y_FIRST + DEFAULT_Y_STEP);
  }
});

Deno.test("unit: detect — LOCATARIO has x=DEFAULT_X", async () => {
  const pdf = buildMinimalValidPdf();
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const pos = result.positions.find((p: SignerPosition) =>
      p.role === "LOCATARIO"
    )!;
    assertEquals(pos.x, DEFAULT_X);
  }
});

Deno.test("unit: detect — TESTEMUNHA_1 is third slot on page — y=DEFAULT_Y_FIRST+2*DEFAULT_Y_STEP", async () => {
  const pdf = buildRawPdf([
    ["[[LOCADOR]]", "[[LOCATARIO]]", "[[TESTEMUNHA_1]]"],
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const pos = result.positions.find((p: SignerPosition) =>
      p.role === "TESTEMUNHA_1"
    )!;
    assertEquals(pos.y, DEFAULT_Y_FIRST + 2 * DEFAULT_Y_STEP);
  }
});

Deno.test("unit: detect — TESTEMUNHA_1 has x=DEFAULT_X", async () => {
  const pdf = buildRawPdf([
    ["[[LOCADOR]]", "[[LOCATARIO]]", "[[TESTEMUNHA_1]]"],
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const pos = result.positions.find((p: SignerPosition) =>
      p.role === "TESTEMUNHA_1"
    )!;
    assertEquals(pos.x, DEFAULT_X);
  }
});

Deno.test("unit: detect — TESTEMUNHA_2 is fourth slot on page — y=DEFAULT_Y_FIRST+3*DEFAULT_Y_STEP", async () => {
  const pdf = buildRawPdf([
    ["[[LOCADOR]]", "[[LOCATARIO]]", "[[TESTEMUNHA_1]]", "[[TESTEMUNHA_2]]"],
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const pos = result.positions.find((p: SignerPosition) =>
      p.role === "TESTEMUNHA_2"
    )!;
    assertEquals(pos.y, DEFAULT_Y_FIRST + 3 * DEFAULT_Y_STEP);
  }
});

Deno.test("unit: detect — TESTEMUNHA_2 has x=DEFAULT_X", async () => {
  const pdf = buildRawPdf([
    ["[[LOCADOR]]", "[[LOCATARIO]]", "[[TESTEMUNHA_1]]", "[[TESTEMUNHA_2]]"],
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const pos = result.positions.find((p: SignerPosition) =>
      p.role === "TESTEMUNHA_2"
    )!;
    assertEquals(pos.x, DEFAULT_X);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: regression — only one witness maps to TESTEMUNHA_1 (not TESTEMUNHA_2)
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — single witness role is TESTEMUNHA_1 not TESTEMUNHA_2", async () => {
  const pdf = buildRawPdf([
    ["[[LOCADOR]]", "[[LOCATARIO]]", "[[TESTEMUNHA_1]]"],
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const roles = result.positions.map((p: SignerPosition) => p.role);
    assertEquals(roles.includes("TESTEMUNHA_1"), true);
    assertEquals(roles.includes("TESTEMUNHA_2"), false);
  }
});

Deno.test("unit: detect — single witness returns exactly 3 positions", async () => {
  const pdf = buildRawPdf([
    ["[[LOCADOR]]", "[[LOCATARIO]]", "[[TESTEMUNHA_1]]"],
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.positions.length, 3);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: edge case — multiple pages, witnesses assigned in page order
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — multi-page: LOCADOR on page 1, LOCATARIO on page 2", async () => {
  const pdf = buildRawPdf([
    ["[[LOCADOR]]"],
    ["[[LOCATARIO]]"],
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const locador = result.positions.find((p: SignerPosition) =>
      p.role === "LOCADOR"
    )!;
    const locatario = result.positions.find((p: SignerPosition) =>
      p.role === "LOCATARIO"
    )!;
    assertEquals(locador.page, 1);
    assertEquals(locatario.page, 2);
  }
});

Deno.test("unit: detect — multi-page: TESTEMUNHA_1 on page 2, TESTEMUNHA_2 on page 3", async () => {
  const pdf = buildRawPdf([
    ["[[LOCADOR]]", "[[LOCATARIO]]"],
    ["[[TESTEMUNHA_1]]"],
    ["[[TESTEMUNHA_2]]"],
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const t1 = result.positions.find((p: SignerPosition) =>
      p.role === "TESTEMUNHA_1"
    )!;
    const t2 = result.positions.find((p: SignerPosition) =>
      p.role === "TESTEMUNHA_2"
    )!;
    assertEquals(t1.page, 2);
    assertEquals(t2.page, 3);
  }
});

Deno.test("unit: detect — multi-page: each role on separate page reports page 1 slot y", async () => {
  // When each role is on its own page, each is slot 0 on that page → y=DEFAULT_Y_FIRST.
  const pdf = buildRawPdf([
    ["[[LOCADOR]]"],
    ["[[LOCATARIO]]"],
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    for (const pos of result.positions) {
      assertEquals(pos.y, DEFAULT_Y_FIRST);
    }
  }
});

Deno.test("unit: detect — multi-page: witnesses in page order (T1 page <= T2 page)", async () => {
  const pdf = buildRawPdf([
    ["[[LOCADOR]]", "[[LOCATARIO]]"],
    ["[[TESTEMUNHA_1]]"],
    ["[[TESTEMUNHA_2]]"],
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const t1 = result.positions.find((p: SignerPosition) =>
      p.role === "TESTEMUNHA_1"
    )!;
    const t2 = result.positions.find((p: SignerPosition) =>
      p.role === "TESTEMUNHA_2"
    )!;
    assertEquals(t1.page <= t2.page, true);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: regression — no signature lines returns empty / default without error
//
// A blank pdf-lib document (no [[ROLE]] markers at all) must return ok:false
// with a specific missing-marker error, not throw or return garbled data.
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — blank pdf-lib doc returns ok:false (no markers)", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  const bytes = await doc.save();
  const result = await detect(bytes);
  assertEquals(result.ok, false);
});

Deno.test("unit: detect — blank pdf-lib doc error mentions LOCADOR", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  const bytes = await doc.save();
  const result = await detect(bytes);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error, "LOCADOR");
  }
});

Deno.test("unit: detect — blank pdf-lib doc does not throw", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  const bytes = await doc.save();
  // If this throws it will fail the test — otherwise asserting result type is enough.
  const result = await detect(bytes);
  assertEquals(typeof result.ok, "boolean");
});
