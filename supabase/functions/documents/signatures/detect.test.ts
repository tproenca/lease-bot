// unit: documents/signatures/detect
//
// Unit tests for detectSignaturePositions.
// All PDFs are constructed synthetically in-memory using pdf-lib — no disk I/O.
//
// Test naming follows the ci.sh filter: "unit|integration".
//
// Strategy:
//   pdf-lib's text-drawing API produces a real PDF content stream that our
//   parser reads back.  We construct minimal PDFs with known signature blocks,
//   run detection, and assert the returned signer shapes.
//
//   For fallback (no markers) tests we use plain PDFs without any text, or
//   PDFs whose text does not match the underscore pattern.

import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  DetectedSigner,
  DetectResult,
  detectSignaturePositions,
} from "./detect.ts";

// ─── Fixture helpers ──────────────────────────────────────────────────────

const UNDERLINE = "_____________________________"; // 29 underscores (≥ 20)

/**
 * Build a minimal 1-page PDF with a Helvetica font, drawing `lines` as text
 * elements at fixed positions.  Each entry in `lines` is placed on the page
 * using a simple y-offset layout, top-to-bottom.
 *
 * The drawing positions ensure that labels fall below their underlines in the
 * same way as a Google-Docs-exported lease PDF.
 */
async function buildPdfWithText(
  pageLines: Array<{ text: string; x: number; y: number }>,
  pageCount = 1,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (let p = 0; p < pageCount; p++) {
    const page = doc.addPage([595, 842]); // A4 in points
    // Only draw text on the LAST page (simulate signature on last page only).
    if (p === pageCount - 1) {
      for (const { text, x, y } of pageLines) {
        page.drawText(text, { x, y, size: 12, font });
      }
    }
  }

  return doc.save();
}

/** Convenience: build a single-page PDF with the standard 3-signer layout. */
async function buildStandard3SignerPdf(): Promise<Uint8Array> {
  // Layout (y increases upward in PDF coordinates, 842pt page height):
  //   Landlord block at y≈200, Tenant at y≈150, Witness at y≈100.
  //   Label is 20pt below the underline.
  return buildPdfWithText([
    { text: UNDERLINE, x: 50, y: 200 },
    { text: "Locador", x: 50, y: 180 },
    { text: UNDERLINE, x: 200, y: 200 },
    { text: "Inquilino", x: 200, y: 180 },
    { text: UNDERLINE, x: 350, y: 200 },
    { text: "João da Silva", x: 350, y: 180 },
  ]);
}

/** Run detection on raw bytes and return the result. */
async function detect(pdfBytes: Uint8Array): Promise<DetectResult> {
  return detectSignaturePositions(pdfBytes);
}

// ═══════════════════════════════════════════════════════════════════════════
// unit: standard 3-signer layout
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — standard layout returns ok:true", async () => {
  const pdf = await buildStandard3SignerPdf();
  const result = await detect(pdf);
  assertEquals(result.ok, true);
});

Deno.test("unit: detect — standard layout returns 3 signers", async () => {
  const pdf = await buildStandard3SignerPdf();
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.signers.length, 3);
  }
});

Deno.test("unit: detect — standard layout detects landlord role", async () => {
  const pdf = await buildStandard3SignerPdf();
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const landlord = result.signers.find((s: DetectedSigner) =>
      s.role === "landlord"
    );
    assertEquals(landlord !== undefined, true);
    assertEquals(landlord?.name, "Locador");
  }
});

Deno.test("unit: detect — standard layout detects tenant role", async () => {
  const pdf = await buildStandard3SignerPdf();
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const tenant = result.signers.find((s: DetectedSigner) =>
      s.role === "tenant"
    );
    assertEquals(tenant !== undefined, true);
    assertEquals(tenant?.name, "Inquilino");
  }
});

Deno.test("unit: detect — standard layout detects witness role", async () => {
  const pdf = await buildStandard3SignerPdf();
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const witness = result.signers.find((s: DetectedSigner) =>
      s.role === "witness"
    );
    assertEquals(witness !== undefined, true);
  }
});

Deno.test("unit: detect — standard layout witness name is the custom label text", async () => {
  const pdf = await buildStandard3SignerPdf();
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const witness = result.signers.find((s: DetectedSigner) =>
      s.role === "witness"
    );
    assertEquals(witness?.name, "João da Silva");
  }
});

Deno.test("unit: detect — each signer has numeric x and y coordinates", async () => {
  const pdf = await buildStandard3SignerPdf();
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    for (const signer of result.signers) {
      assertEquals(typeof signer.x, "number");
      assertEquals(typeof signer.y, "number");
      assertEquals(isNaN(signer.x), false);
      assertEquals(isNaN(signer.y), false);
    }
  }
});

Deno.test("unit: detect — all signers report last page number (1-indexed)", async () => {
  const pdf = await buildStandard3SignerPdf();
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    for (const signer of result.signers) {
      assertEquals(signer.page, 1); // single-page PDF
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: multi-page PDF — signers land on correct page number
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — multi-page PDF reports correct 1-indexed page number", async () => {
  // 3-page PDF: signature block on last page (page 3).
  const pdf = await buildPdfWithText(
    [
      { text: UNDERLINE, x: 50, y: 200 },
      { text: "Inquilino", x: 50, y: 180 },
    ],
    3,
  );
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.signers.length, 1);
    assertEquals(result.signers[0].page, 3);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: missing markers — fallback path
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — empty PDF returns ok:false", async () => {
  const doc = await PDFDocument.create();
  doc.addPage();
  const bytes = await doc.save();
  const result = await detect(bytes);
  assertEquals(result.ok, false);
});

Deno.test("unit: detect — fallback error message is user-friendly Portuguese", async () => {
  const doc = await PDFDocument.create();
  doc.addPage();
  const bytes = await doc.save();
  const result = await detect(bytes);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error, "Autentique");
    assertStringIncludes(result.error, "manualmente");
  }
});

Deno.test("unit: detect — PDF with short underscores (< 20) returns ok:false", async () => {
  // 5 underscores should not trigger detection.
  const pdf = await buildPdfWithText([
    { text: "_____", x: 50, y: 200 },
    { text: "Inquilino", x: 50, y: 180 },
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, false);
});

Deno.test("unit: detect — PDF with underline but no label below returns ok:false", async () => {
  // Underline with no text below it within the search window.
  const pdf = await buildPdfWithText([
    { text: UNDERLINE, x: 50, y: 200 },
    // Label is 60pt below (outside the 40pt search window).
    { text: "Inquilino", x: 50, y: 130 },
  ]);
  const result = await detect(pdf);
  // No valid block found → fallback.
  assertEquals(result.ok, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: witness with custom name
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — witness with multi-word name is preserved", async () => {
  const pdf = await buildPdfWithText([
    { text: UNDERLINE, x: 50, y: 200 },
    { text: "Maria Conceição", x: 50, y: 182 },
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.signers[0].role, "witness");
    assertEquals(result.signers[0].name, "Maria Conceição");
  }
});

Deno.test("unit: detect — unknown label (not Inquilino/Locador) treated as witness", async () => {
  const pdf = await buildPdfWithText([
    { text: UNDERLINE, x: 50, y: 200 },
    { text: "Fiador", x: 50, y: 182 },
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.signers[0].role, "witness");
    assertEquals(result.signers[0].name, "Fiador");
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: single-signer edge case
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — single signer PDF returns ok:true with one signer", async () => {
  const pdf = await buildPdfWithText([
    { text: UNDERLINE, x: 50, y: 200 },
    { text: "Locador", x: 50, y: 182 },
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.signers.length, 1);
    assertEquals(result.signers[0].role, "landlord");
  }
});

Deno.test("unit: detect — single signer has x > 0 and y > 0", async () => {
  const pdf = await buildPdfWithText([
    { text: UNDERLINE, x: 50, y: 200 },
    { text: "Locador", x: 50, y: 182 },
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.signers[0].x > 0, true);
    assertEquals(result.signers[0].y > 0, true);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: role field values
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — role values are restricted to tenant|landlord|witness", async () => {
  const pdf = await buildStandard3SignerPdf();
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const validRoles = new Set(["tenant", "landlord", "witness"]);
    for (const signer of result.signers) {
      assertEquals(validRoles.has(signer.role), true);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: result shape conformance
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — success result has ok:true and signers array", async () => {
  const pdf = await buildPdfWithText([
    { text: UNDERLINE, x: 50, y: 200 },
    { text: "Inquilino", x: 50, y: 182 },
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(Array.isArray(result.signers), true);
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
// unit: label matching is case-insensitive
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — INQUILINO (uppercase) maps to tenant role", async () => {
  const pdf = await buildPdfWithText([
    { text: UNDERLINE, x: 50, y: 200 },
    { text: "INQUILINO", x: 50, y: 182 },
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.signers[0].role, "tenant");
  }
});

Deno.test("unit: detect — LOCADOR (uppercase) maps to landlord role", async () => {
  const pdf = await buildPdfWithText([
    { text: UNDERLINE, x: 50, y: 200 },
    { text: "LOCADOR", x: 50, y: 182 },
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.signers[0].role, "landlord");
  }
});
