// unit: documents/signatures/detect
//
// Unit tests for detectSignaturePositions (content-stream parsing approach).
// All PDFs are constructed synthetically in-memory using pdf-lib — no disk I/O.
//
// Strategy:
//   pdf-lib's drawText() produces real, compressed content streams that our
//   parser reads back via getPageContentStream → zlibDecompress → extractTextElements.
//   We construct PDFs with known underline and label positions, run detection,
//   and assert that the returned coordinates match the drawText() positions —
//   verifying that actual coordinates are used, not hardcoded defaults.

import {
  assertEquals,
  assertAlmostEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { PDFDocument, StandardFonts } from "https://esm.sh/pdf-lib@1.17.1";
import {
  DetectResult,
  detectSignaturePositions,
  SignerPosition,
} from "./detect.ts";

// ─── Fixture helpers ──────────────────────────────────────────────────────

const UNDERLINE = "_____________________________"; // 29 underscores (≥ 20)

interface TextEntry {
  text: string;
  x: number;
  y: number;
}

/**
 * Build a PDF where the last page contains the given text entries drawn with
 * Helvetica at size 12. Earlier pages (if pageCount > 1) are blank.
 *
 * Using pdf-lib's drawText() produces real compressed content streams that
 * our parser reads back, validating the full parsing pipeline end-to-end.
 */
async function buildPdf(
  entries: TextEntry[],
  pageCount = 1,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < pageCount; p++) {
    const page = doc.addPage([595, 842]); // A4
    if (p === pageCount - 1) {
      for (const { text, x, y } of entries) {
        page.drawText(text, { x, y, size: 12, font });
      }
    }
  }
  return doc.save();
}

async function detect(bytes: Uint8Array): Promise<DetectResult> {
  return detectSignaturePositions(bytes);
}

// ─── Coordinate tolerance ─────────────────────────────────────────────────
// pdf-lib text matrices may carry sub-point floating-point noise; allow ±1pt.
const COORD_TOLERANCE = 1;

// ═══════════════════════════════════════════════════════════════════════════
// unit: 2-signer layout (Locador + Locatário)
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — Locador + Locatário returns ok:true", async () => {
  const pdf = await buildPdf([
    { text: UNDERLINE, x: 50, y: 200 },
    { text: "Locador", x: 50, y: 182 },
    { text: UNDERLINE, x: 200, y: 200 },
    { text: "Locatário", x: 200, y: 182 },
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
});

Deno.test("unit: detect — 2-signer layout returns 2 positions", async () => {
  const pdf = await buildPdf([
    { text: UNDERLINE, x: 50, y: 200 },
    { text: "Locador", x: 50, y: 182 },
    { text: UNDERLINE, x: 200, y: 200 },
    { text: "Locatário", x: 200, y: 182 },
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.positions.length, 2);
});

Deno.test("unit: detect — LOCADOR role is present", async () => {
  const pdf = await buildPdf([
    { text: UNDERLINE, x: 50, y: 200 },
    { text: "Locador", x: 50, y: 182 },
    { text: UNDERLINE, x: 200, y: 200 },
    { text: "Locatário", x: 200, y: 182 },
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const pos = result.positions.find((p: SignerPosition) => p.role === "LOCADOR");
    assertEquals(pos !== undefined, true);
  }
});

Deno.test("unit: detect — LOCATARIO role is present", async () => {
  const pdf = await buildPdf([
    { text: UNDERLINE, x: 50, y: 200 },
    { text: "Locador", x: 50, y: 182 },
    { text: UNDERLINE, x: 200, y: 200 },
    { text: "Locatário", x: 200, y: 182 },
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const pos = result.positions.find((p: SignerPosition) => p.role === "LOCATARIO");
    assertEquals(pos !== undefined, true);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: coordinates match the drawText position (not hardcoded defaults)
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — LOCADOR x coordinate matches underline drawText position", async () => {
  const pdf = await buildPdf([
    { text: UNDERLINE, x: 50, y: 200 },
    { text: "Locador", x: 50, y: 182 },
    { text: UNDERLINE, x: 200, y: 150 },
    { text: "Locatário", x: 200, y: 132 },
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const pos = result.positions.find((p: SignerPosition) => p.role === "LOCADOR")!;
    assertAlmostEquals(pos.x, 50, COORD_TOLERANCE);
  }
});

Deno.test("unit: detect — LOCADOR y coordinate matches underline drawText position", async () => {
  const pdf = await buildPdf([
    { text: UNDERLINE, x: 50, y: 200 },
    { text: "Locador", x: 50, y: 182 },
    { text: UNDERLINE, x: 200, y: 150 },
    { text: "Locatário", x: 200, y: 132 },
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const pos = result.positions.find((p: SignerPosition) => p.role === "LOCADOR")!;
    assertAlmostEquals(pos.y, 200, COORD_TOLERANCE);
  }
});

Deno.test("unit: detect — LOCATARIO coordinates match its underline position", async () => {
  const pdf = await buildPdf([
    { text: UNDERLINE, x: 50, y: 200 },
    { text: "Locador", x: 50, y: 182 },
    { text: UNDERLINE, x: 200, y: 150 },
    { text: "Locatário", x: 200, y: 132 },
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const pos = result.positions.find((p: SignerPosition) => p.role === "LOCATARIO")!;
    assertAlmostEquals(pos.x, 200, COORD_TOLERANCE);
    assertAlmostEquals(pos.y, 150, COORD_TOLERANCE);
  }
});

Deno.test("unit: detect — coordinates are distinct when underlines are at different positions", async () => {
  const pdf = await buildPdf([
    { text: UNDERLINE, x: 50, y: 300 },
    { text: "Locador", x: 50, y: 282 },
    { text: UNDERLINE, x: 50, y: 200 },
    { text: "Locatário", x: 50, y: 182 },
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const locador = result.positions.find((p: SignerPosition) => p.role === "LOCADOR")!;
    const locatario = result.positions.find((p: SignerPosition) => p.role === "LOCATARIO")!;
    assertEquals(locador.y !== locatario.y, true);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: 3-signer layout (+ Testemunha)
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — 3-signer layout returns ok:true with 3 positions", async () => {
  const pdf = await buildPdf([
    { text: UNDERLINE, x: 50, y: 300 },
    { text: "Locador", x: 50, y: 282 },
    { text: UNDERLINE, x: 50, y: 230 },
    { text: "Locatário", x: 50, y: 212 },
    { text: UNDERLINE, x: 50, y: 160 },
    { text: "Testemunha", x: 50, y: 142 },
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.positions.length, 3);
});

Deno.test("unit: detect — single witness becomes TESTEMUNHA_1", async () => {
  const pdf = await buildPdf([
    { text: UNDERLINE, x: 50, y: 300 },
    { text: "Locador", x: 50, y: 282 },
    { text: UNDERLINE, x: 50, y: 230 },
    { text: "Locatário", x: 50, y: 212 },
    { text: UNDERLINE, x: 50, y: 160 },
    { text: "Testemunha", x: 50, y: 142 },
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const t1 = result.positions.find((p: SignerPosition) => p.role === "TESTEMUNHA_1");
    assertEquals(t1 !== undefined, true);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: 4-signer layout (2 witnesses)
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — 4-signer layout returns 4 positions", async () => {
  const pdf = await buildPdf([
    { text: UNDERLINE, x: 50, y: 380 },
    { text: "Locador", x: 50, y: 362 },
    { text: UNDERLINE, x: 50, y: 310 },
    { text: "Locatário", x: 50, y: 292 },
    { text: UNDERLINE, x: 50, y: 240 },
    { text: "Testemunha", x: 50, y: 222 },
    { text: UNDERLINE, x: 50, y: 170 },
    { text: "Testemunha", x: 50, y: 152 },
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.positions.length, 4);
});

Deno.test("unit: detect — first witness (higher y) is TESTEMUNHA_1", async () => {
  const pdf = await buildPdf([
    { text: UNDERLINE, x: 50, y: 380 },
    { text: "Locador", x: 50, y: 362 },
    { text: UNDERLINE, x: 50, y: 310 },
    { text: "Locatário", x: 50, y: 292 },
    { text: UNDERLINE, x: 50, y: 240 },
    { text: "Testemunha", x: 50, y: 222 },
    { text: UNDERLINE, x: 50, y: 170 },
    { text: "Testemunha", x: 50, y: 152 },
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const t1 = result.positions.find((p: SignerPosition) => p.role === "TESTEMUNHA_1")!;
    const t2 = result.positions.find((p: SignerPosition) => p.role === "TESTEMUNHA_2")!;
    assertEquals(t1.y > t2.y, true); // TESTEMUNHA_1 is higher on the page
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: realistic label — "Nome — Locador" (full name + role keyword)
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — label 'Nome — Locador' maps to LOCADOR", async () => {
  const pdf = await buildPdf([
    { text: UNDERLINE, x: 50, y: 200 },
    { text: "Elenice Proenca — Locador", x: 50, y: 182 },
    { text: UNDERLINE, x: 50, y: 140 },
    { text: "Hamilton Xavier — Locatario", x: 50, y: 122 },
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const pos = result.positions.find((p: SignerPosition) => p.role === "LOCADOR");
    assertEquals(pos !== undefined, true);
  }
});

Deno.test("unit: detect — label 'Nome — Locatario' maps to LOCATARIO", async () => {
  const pdf = await buildPdf([
    { text: UNDERLINE, x: 50, y: 200 },
    { text: "Elenice Proenca — Locador", x: 50, y: 182 },
    { text: UNDERLINE, x: 50, y: 140 },
    { text: "Hamilton Xavier — Locatario", x: 50, y: 122 },
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const pos = result.positions.find((p: SignerPosition) => p.role === "LOCATARIO");
    assertEquals(pos !== undefined, true);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: case-insensitive role matching
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — uppercase LOCADOR label maps to LOCADOR role", async () => {
  const pdf = await buildPdf([
    { text: UNDERLINE, x: 50, y: 200 },
    { text: "LOCADOR", x: 50, y: 182 },
    { text: UNDERLINE, x: 50, y: 140 },
    { text: "LOCATARIO", x: 50, y: 122 },
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const pos = result.positions.find((p: SignerPosition) => p.role === "LOCADOR");
    assertEquals(pos !== undefined, true);
  }
});

Deno.test("unit: detect — uppercase LOCATARIO label maps to LOCATARIO role", async () => {
  const pdf = await buildPdf([
    { text: UNDERLINE, x: 50, y: 200 },
    { text: "LOCADOR", x: 50, y: 182 },
    { text: UNDERLINE, x: 50, y: 140 },
    { text: "LOCATARIO", x: 50, y: 122 },
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const pos = result.positions.find((p: SignerPosition) => p.role === "LOCATARIO");
    assertEquals(pos !== undefined, true);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: multi-page PDF — signatures on last page
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — multi-page PDF returns correct 1-based page number", async () => {
  const pdf = await buildPdf([
    { text: UNDERLINE, x: 50, y: 200 },
    { text: "Locador", x: 50, y: 182 },
    { text: UNDERLINE, x: 50, y: 140 },
    { text: "Locatário", x: 50, y: 122 },
  ], 3);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    for (const pos of result.positions) {
      assertEquals(pos.page, 3);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: failure — short underscores (< 20) are not detected
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — short underscores (5 chars) not detected → ok:false", async () => {
  const pdf = await buildPdf([
    { text: "_____", x: 50, y: 200 },
    { text: "Locador", x: 50, y: 182 },
    { text: "_____", x: 50, y: 140 },
    { text: "Locatário", x: 50, y: 122 },
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: failure — label outside search window
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — label more than 40pt below underline is not matched → ok:false", async () => {
  const pdf = await buildPdf([
    { text: UNDERLINE, x: 50, y: 200 },
    // 60pt below — outside the 40pt LABEL_SEARCH_WINDOW_PT
    { text: "Locador", x: 50, y: 140 },
    { text: UNDERLINE, x: 50, y: 100 },
    { text: "Locatário", x: 50, y: 40 },
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: failure — missing required roles
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — only LOCADOR present → ok:false (LOCATARIO missing)", async () => {
  const pdf = await buildPdf([
    { text: UNDERLINE, x: 50, y: 200 },
    { text: "Locador", x: 50, y: 182 },
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error, "detect_missing_role_LOCATARIO");
});

Deno.test("unit: detect — only LOCATARIO present → ok:false (LOCADOR missing)", async () => {
  const pdf = await buildPdf([
    { text: UNDERLINE, x: 50, y: 200 },
    { text: "Locatário", x: 50, y: 182 },
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error, "detect_missing_role_LOCADOR");
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: failure — empty or invalid input
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — empty bytes returns ok:false with detect_empty_pdf", async () => {
  const result = await detect(new Uint8Array(0));
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error, "detect_empty_pdf");
});

Deno.test("unit: detect — invalid bytes returns ok:false with detect_invalid_pdf", async () => {
  const result = await detect(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xFF]));
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error, "detect_invalid_pdf");
});

Deno.test("unit: detect — blank PDF (no text) returns ok:false", async () => {
  const doc = await PDFDocument.create();
  doc.addPage();
  const bytes = await doc.save();
  const result = await detect(bytes);
  assertEquals(result.ok, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: result shape conformance
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — success result has ok:true and positions array", async () => {
  const pdf = await buildPdf([
    { text: UNDERLINE, x: 50, y: 200 },
    { text: "Locador", x: 50, y: 182 },
    { text: UNDERLINE, x: 50, y: 140 },
    { text: "Locatário", x: 50, y: 122 },
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(Array.isArray(result.positions), true);
});

Deno.test("unit: detect — each position has numeric x, y, and 1-based page", async () => {
  const pdf = await buildPdf([
    { text: UNDERLINE, x: 50, y: 200 },
    { text: "Locador", x: 50, y: 182 },
    { text: UNDERLINE, x: 50, y: 140 },
    { text: "Locatário", x: 50, y: 122 },
  ]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    for (const pos of result.positions) {
      assertEquals(typeof pos.x, "number");
      assertEquals(typeof pos.y, "number");
      assertEquals(isNaN(pos.x), false);
      assertEquals(isNaN(pos.y), false);
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
