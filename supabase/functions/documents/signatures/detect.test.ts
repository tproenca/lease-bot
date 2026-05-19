// unit: documents/signatures/detect
//
// Unit tests for detectSignaturePositions (marker-based, [[ROLE]] approach).
// All PDFs are constructed synthetically in-memory using pdf-lib — no disk I/O.
//
// Test naming follows the ci.sh filter: "unit|integration".
//
// Strategy:
//   We embed [[ROLE]] marker strings into PDF text content streams using
//   pdf-lib's drawText API, which produces real content streams that the
//   raw-text extractor can scan.  We then assert on the returned positions
//   array shape.
//
//   For failure cases we use blank PDFs or PDFs missing required role markers.

import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  DetectResult,
  detectSignaturePositions,
  SignerPosition,
} from "./detect.ts";

// ─── Fixture helpers ──────────────────────────────────────────────────────

/**
 * Build a minimal PDF with the given text lines drawn on the specified page.
 * `pageLines` is a map from page index (0-based) to an array of text strings
 * to draw on that page.  Pages without an entry are left blank.
 */
async function buildPdfWithMarkers(
  pageLines: Map<number, string[]>,
  totalPages = 1,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (let p = 0; p < totalPages; p++) {
    const page = doc.addPage([595, 842]); // A4
    const lines = pageLines.get(p) ?? [];
    let y = 700;
    for (const text of lines) {
      page.drawText(text, { x: 60, y, size: 12, font });
      y -= 20;
    }
  }

  return doc.save();
}

/** Convenience: 1-page PDF with [[LOCADOR]] and [[LOCATARIO]] markers. */
async function buildMinimalValidPdf(): Promise<Uint8Array> {
  return buildPdfWithMarkers(
    new Map([[0, ["[[LOCADOR]]", "[[LOCATARIO]]"]]]),
    1,
  );
}

/** Run detection on raw bytes and return the result. */
async function detect(pdfBytes: Uint8Array): Promise<DetectResult> {
  return detectSignaturePositions(pdfBytes);
}

// ═══════════════════════════════════════════════════════════════════════════
// unit: basic valid case — both required markers present
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — valid PDF with required markers returns ok:true", async () => {
  const pdf = await buildMinimalValidPdf();
  const result = await detect(pdf);
  assertEquals(result.ok, true);
});

Deno.test("unit: detect — valid PDF returns positions array", async () => {
  const pdf = await buildMinimalValidPdf();
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(Array.isArray(result.positions), true);
  }
});

Deno.test("unit: detect — valid PDF returns 2 positions for required roles", async () => {
  const pdf = await buildMinimalValidPdf();
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.positions.length, 2);
  }
});

Deno.test("unit: detect — LOCADOR position has role LOCADOR", async () => {
  const pdf = await buildMinimalValidPdf();
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
  const pdf = await buildMinimalValidPdf();
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
  const pdf = await buildMinimalValidPdf();
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
  const pdf = await buildMinimalValidPdf();
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    for (const pos of result.positions) {
      assertEquals(pos.x > 0, true);
    }
  }
});

Deno.test("unit: detect — each position has y > 0", async () => {
  const pdf = await buildMinimalValidPdf();
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    for (const pos of result.positions) {
      assertEquals(pos.y > 0, true);
    }
  }
});

Deno.test("unit: detect — each position has a 1-based page number", async () => {
  const pdf = await buildMinimalValidPdf();
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
  const pdf = await buildPdfWithMarkers(
    new Map([[
      0,
      ["[[LOCADOR]]", "[[LOCATARIO]]", "[[TESTEMUNHA_1]]"],
    ]]),
    1,
  );
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
  const pdf = await buildPdfWithMarkers(
    new Map([[
      0,
      ["[[LOCADOR]]", "[[LOCATARIO]]", "[[TESTEMUNHA_1]]", "[[TESTEMUNHA_2]]"],
    ]]),
    1,
  );
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
  const pdf = await buildMinimalValidPdf();
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
  const pdf = await buildPdfWithMarkers(
    new Map([[0, ["[[LOCATARIO]]"]]]),
    1,
  );
  const result = await detect(pdf);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error, "LOCADOR");
  }
});

Deno.test("unit: detect — missing LOCATARIO marker returns error string", async () => {
  // Only LOCADOR present.
  const pdf = await buildPdfWithMarkers(
    new Map([[0, ["[[LOCADOR]]"]]]),
    1,
  );
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
  const pdf = await buildMinimalValidPdf();
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
  const pdf = await buildMinimalValidPdf();
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
  const pdf = await buildPdfWithMarkers(
    new Map([[
      0,
      ["[[LOCADOR]]", "[[LOCATARIO]]", "[[TESTEMUNHA_1]]"],
    ]]),
    1,
  );
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const roles = result.positions.map((p: SignerPosition) => p.role);
    const t1Idx = roles.indexOf("TESTEMUNHA_1");
    const locatarioIdx = roles.indexOf("LOCATARIO");
    assertEquals(t1Idx > locatarioIdx, true);
  }
});
