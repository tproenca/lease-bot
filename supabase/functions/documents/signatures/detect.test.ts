// unit: documents/signatures/detect
//
// Unit tests for detectSignaturePositions (content-stream parser approach).
// All PDFs are constructed synthetically in-memory — no disk I/O.
//
// Strategy:
//   The detect.ts implementation parses PDF content-stream operators
//   (BT/ET, Tm, Tf, Tj, TJ) to extract text elements with their positions.
//   Test PDFs are hand-built with uncompressed content streams using proper
//   BT/Tm/Tf/Tj/ET operators so the parser can find [[ROLE]] markers at
//   known coordinates.
//
//   Page dimensions: A4 (595 × 842 pt), font size: 10 pt.
//   Coordinate conversion (detect.ts):
//     x% = (x_pt / page_width)  * 100
//     y% = ((page_height - y_pt - font_size) / page_height) * 100

import {
  assertAlmostEquals,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { PDFDocument } from "pdf-lib";
import {
  DetectResult,
  detectSignaturePositions,
  SignerPosition,
} from "./detect.ts";

// ─── Page / font constants ─────────────────────────────────────────────────

const PW = 595; // page width  (pt)
const PH = 842; // page height (pt)
const FS = 10; // font size   (pt)

/** Expected Autentique x% for a marker placed at x_pt on an A4 page. */
function xPct(x: number): number {
  return (x / PW) * 100;
}

/** Expected Autentique y% for a marker placed at y_pt on an A4 page with FS=10. */
function yPct(y: number): number {
  return ((PH - y - FS) / PH) * 100;
}

// Canonical marker positions used across most tests (PDF points, origin bottom-left).
const MX = 50; // x for all markers
const Y_LOCADOR = 700;
const Y_LOCATARIO = 640;
const Y_T1 = 580;
const Y_T2 = 520;

// ─── Fixture helpers ───────────────────────────────────────────────────────

interface MarkerSpec {
  text: string;
  x: number;
  y: number;
}

/**
 * Build a minimal valid PDF with markers placed at specific PDF-point
 * coordinates using proper BT/Tm/Tf/Tj/ET content-stream operators.
 * Each entry in `pages` is a list of markers to embed on that page.
 * Page size: A4 (595 × 842 pt).  Font size: 10 pt.
 */
function buildPdfWithMarkers(pages: MarkerSpec[][]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  let offset = 0;
  const objOffsets: number[] = [];

  function emit(s: string): void {
    const b = encoder.encode(s);
    parts.push(b);
    offset += b.length;
  }

  emit("%PDF-1.4\n");

  const pageCount = pages.length;
  // Object layout: 1=catalog, 2=pages, then pairs (page, stream) per page.
  const catalogObj = 1;
  const pagesObj = 2;
  const firstPageObj = 3;
  const totalObjs = 2 + pageCount * 2;
  objOffsets.length = totalObjs + 1;
  objOffsets.fill(0);

  objOffsets[catalogObj] = offset;
  emit(
    `${catalogObj} 0 obj\n<< /Type /Catalog /Pages ${pagesObj} 0 R >>\nendobj\n`,
  );

  objOffsets[pagesObj] = offset;
  const kids = Array.from(
    { length: pageCount },
    (_, i) => `${firstPageObj + 2 * i} 0 R`,
  ).join(" ");
  emit(
    `${pagesObj} 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj\n`,
  );

  for (let i = 0; i < pageCount; i++) {
    const pageObj = firstPageObj + 2 * i;
    const streamObj = firstPageObj + 2 * i + 1;

    const body = (pages[i] ?? [])
      .map(({ text, x, y }) =>
        `BT\n/F1 ${FS} Tf\n1 0 0 1 ${x} ${y} Tm\n(${text}) Tj\nET\n`
      )
      .join("");
    const bodyLen = encoder.encode(body).length;

    objOffsets[pageObj] = offset;
    emit(
      `${pageObj} 0 obj\n<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PW} ${PH}] /Contents ${streamObj} 0 R >>\nendobj\n`,
    );

    objOffsets[streamObj] = offset;
    emit(`${streamObj} 0 obj\n<< /Length ${bodyLen} >>\nstream\n`);
    emit(body);
    emit(`endstream\nendobj\n`);
  }

  const xrefOffset = offset;
  emit(`xref\n0 ${totalObjs + 1}\n`);
  emit("0000000000 65535 f \n");
  for (let n = 1; n <= totalObjs; n++) {
    emit(`${String(objOffsets[n]).padStart(10, "0")} 00000 n \n`);
  }
  emit(
    `trailer\n<< /Size ${
      totalObjs + 1
    } /Root ${catalogObj} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );

  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

/** 1-page PDF with LOCADOR and LOCATARIO at canonical positions. */
function buildMinimalValidPdf(): Uint8Array {
  return buildPdfWithMarkers([[
    { text: "[[LOCADOR]]", x: MX, y: Y_LOCADOR },
    { text: "[[LOCATARIO]]", x: MX, y: Y_LOCATARIO },
  ]]);
}

async function detect(bytes: Uint8Array): Promise<DetectResult> {
  return detectSignaturePositions(bytes);
}

// ═══════════════════════════════════════════════════════════════════════════
// unit: basic valid case
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — valid PDF with required markers returns ok:true", async () => {
  const result = await detect(buildMinimalValidPdf());
  assertEquals(result.ok, true);
});

Deno.test("unit: detect — valid PDF returns positions array", async () => {
  const result = await detect(buildMinimalValidPdf());
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(Array.isArray(result.positions), true);
});

Deno.test("unit: detect — valid PDF returns exactly 2 positions for required roles", async () => {
  const result = await detect(buildMinimalValidPdf());
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.positions.length, 2);
});

Deno.test("unit: detect — LOCADOR role is present", async () => {
  const result = await detect(buildMinimalValidPdf());
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(
      result.positions.some((p: SignerPosition) => p.role === "LOCADOR"),
      true,
    );
  }
});

Deno.test("unit: detect — LOCATARIO role is present", async () => {
  const result = await detect(buildMinimalValidPdf());
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(
      result.positions.some((p: SignerPosition) => p.role === "LOCATARIO"),
      true,
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: coordinate conversion
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — each position has numeric x and y", async () => {
  const result = await detect(buildMinimalValidPdf());
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

Deno.test("unit: detect — x and y are in 0–100 percentage range", async () => {
  const result = await detect(buildMinimalValidPdf());
  assertEquals(result.ok, true);
  if (result.ok) {
    for (const pos of result.positions) {
      assertEquals(pos.x >= 0 && pos.x <= 100, true);
      assertEquals(pos.y >= 0 && pos.y <= 100, true);
    }
  }
});

Deno.test("unit: detect — LOCADOR x% matches PDF x / page_width * 100", async () => {
  const result = await detect(buildMinimalValidPdf());
  assertEquals(result.ok, true);
  if (result.ok) {
    const pos = result.positions.find((p: SignerPosition) =>
      p.role === "LOCADOR"
    )!;
    assertAlmostEquals(pos.x, xPct(MX), 0.01);
  }
});

Deno.test("unit: detect — LOCADOR y% = (page_height - y_pt - font_size) / page_height * 100", async () => {
  const result = await detect(buildMinimalValidPdf());
  assertEquals(result.ok, true);
  if (result.ok) {
    const pos = result.positions.find((p: SignerPosition) =>
      p.role === "LOCADOR"
    )!;
    assertAlmostEquals(pos.y, yPct(Y_LOCADOR), 0.01);
  }
});

Deno.test("unit: detect — LOCATARIO x% matches PDF x / page_width * 100", async () => {
  const result = await detect(buildMinimalValidPdf());
  assertEquals(result.ok, true);
  if (result.ok) {
    const pos = result.positions.find((p: SignerPosition) =>
      p.role === "LOCATARIO"
    )!;
    assertAlmostEquals(pos.x, xPct(MX), 0.01);
  }
});

Deno.test("unit: detect — LOCATARIO y% = (page_height - y_pt - font_size) / page_height * 100", async () => {
  const result = await detect(buildMinimalValidPdf());
  assertEquals(result.ok, true);
  if (result.ok) {
    const pos = result.positions.find((p: SignerPosition) =>
      p.role === "LOCATARIO"
    )!;
    assertAlmostEquals(pos.y, yPct(Y_LOCATARIO), 0.01);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: page number
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — single-page PDF reports page 1 for all positions", async () => {
  const result = await detect(buildMinimalValidPdf());
  assertEquals(result.ok, true);
  if (result.ok) {
    for (const pos of result.positions) assertEquals(pos.page, 1);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: witness markers
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — TESTEMUNHA_1 marker detected when present", async () => {
  const pdf = buildPdfWithMarkers([[
    { text: "[[LOCADOR]]", x: MX, y: Y_LOCADOR },
    { text: "[[LOCATARIO]]", x: MX, y: Y_LOCATARIO },
    { text: "[[TESTEMUNHA_1]]", x: MX, y: Y_T1 },
  ]]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.positions.length, 3);
    assertEquals(
      result.positions.some((p: SignerPosition) => p.role === "TESTEMUNHA_1"),
      true,
    );
  }
});

Deno.test("unit: detect — TESTEMUNHA_2 marker detected when present", async () => {
  const pdf = buildPdfWithMarkers([[
    { text: "[[LOCADOR]]", x: MX, y: Y_LOCADOR },
    { text: "[[LOCATARIO]]", x: MX, y: Y_LOCATARIO },
    { text: "[[TESTEMUNHA_1]]", x: MX, y: Y_T1 },
    { text: "[[TESTEMUNHA_2]]", x: MX, y: Y_T2 },
  ]]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.positions.length, 4);
    assertEquals(
      result.positions.some((p: SignerPosition) => p.role === "TESTEMUNHA_2"),
      true,
    );
  }
});

Deno.test("unit: detect — single witness is TESTEMUNHA_1 not TESTEMUNHA_2", async () => {
  const pdf = buildPdfWithMarkers([[
    { text: "[[LOCADOR]]", x: MX, y: Y_LOCADOR },
    { text: "[[LOCATARIO]]", x: MX, y: Y_LOCATARIO },
    { text: "[[TESTEMUNHA_1]]", x: MX, y: Y_T1 },
  ]]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(
      result.positions.some((p: SignerPosition) => p.role === "TESTEMUNHA_1"),
      true,
    );
    assertEquals(
      result.positions.some((p: SignerPosition) => p.role === "TESTEMUNHA_2"),
      false,
    );
  }
});

Deno.test("unit: detect — single witness returns exactly 3 positions", async () => {
  const pdf = buildPdfWithMarkers([[
    { text: "[[LOCADOR]]", x: MX, y: Y_LOCADOR },
    { text: "[[LOCATARIO]]", x: MX, y: Y_LOCATARIO },
    { text: "[[TESTEMUNHA_1]]", x: MX, y: Y_T1 },
  ]]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.positions.length, 3);
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: ordering (top-to-bottom on page = ascending y%)
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — LOCADOR y% is less than LOCATARIO y% (higher on page)", async () => {
  const result = await detect(buildMinimalValidPdf());
  assertEquals(result.ok, true);
  if (result.ok) {
    const locador = result.positions.find((p: SignerPosition) =>
      p.role === "LOCADOR"
    )!;
    const locatario = result.positions.find((p: SignerPosition) =>
      p.role === "LOCATARIO"
    )!;
    assertEquals(locador.y < locatario.y, true);
  }
});

Deno.test("unit: detect — LOCATARIO y% is less than TESTEMUNHA_1 y%", async () => {
  const pdf = buildPdfWithMarkers([[
    { text: "[[LOCADOR]]", x: MX, y: Y_LOCADOR },
    { text: "[[LOCATARIO]]", x: MX, y: Y_LOCATARIO },
    { text: "[[TESTEMUNHA_1]]", x: MX, y: Y_T1 },
  ]]);
  const result = await detect(pdf);
  assertEquals(result.ok, true);
  if (result.ok) {
    const locatario = result.positions.find((p: SignerPosition) =>
      p.role === "LOCATARIO"
    )!;
    const t1 = result.positions.find((p: SignerPosition) =>
      p.role === "TESTEMUNHA_1"
    )!;
    assertEquals(locatario.y < t1.y, true);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: multi-page
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — multi-page: LOCADOR on page 1, LOCATARIO on page 2", async () => {
  const pdf = buildPdfWithMarkers([
    [{ text: "[[LOCADOR]]", x: MX, y: Y_LOCADOR }],
    [{ text: "[[LOCATARIO]]", x: MX, y: Y_LOCATARIO }],
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
  const pdf = buildPdfWithMarkers([
    [{ text: "[[LOCADOR]]", x: MX, y: Y_LOCADOR }, {
      text: "[[LOCATARIO]]",
      x: MX,
      y: Y_LOCATARIO,
    }],
    [{ text: "[[TESTEMUNHA_1]]", x: MX, y: Y_T1 }],
    [{ text: "[[TESTEMUNHA_2]]", x: MX, y: Y_T2 }],
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

Deno.test("unit: detect — multi-page: witness pages are in order (T1.page <= T2.page)", async () => {
  const pdf = buildPdfWithMarkers([
    [{ text: "[[LOCADOR]]", x: MX, y: Y_LOCADOR }, {
      text: "[[LOCATARIO]]",
      x: MX,
      y: Y_LOCATARIO,
    }],
    [{ text: "[[TESTEMUNHA_1]]", x: MX, y: Y_T1 }],
    [{ text: "[[TESTEMUNHA_2]]", x: MX, y: Y_T2 }],
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
// unit: failure — empty / invalid bytes
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — empty Uint8Array returns ok:false", async () => {
  const result = await detect(new Uint8Array(0));
  assertEquals(result.ok, false);
});

Deno.test("unit: detect — empty bytes error is detect_empty_pdf", async () => {
  const result = await detect(new Uint8Array(0));
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error, "detect_empty_pdf");
});

Deno.test("unit: detect — random bytes return ok:false", async () => {
  const result = await detect(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xFF]));
  assertEquals(result.ok, false);
});

Deno.test("unit: detect — invalid PDF error is detect_invalid_pdf", async () => {
  const result = await detect(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xFF]));
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error, "detect_invalid_pdf");
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: failure — missing required markers
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — blank pdf-lib page returns ok:false", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([PW, PH]);
  const result = await detect(await doc.save());
  assertEquals(result.ok, false);
});

Deno.test("unit: detect — blank pdf-lib page error mentions LOCADOR", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([PW, PH]);
  const result = await detect(await doc.save());
  assertEquals(result.ok, false);
  if (!result.ok) assertStringIncludes(result.error, "LOCADOR");
});

Deno.test("unit: detect — only LOCATARIO present returns error mentioning LOCADOR", async () => {
  const pdf = buildPdfWithMarkers([[{
    text: "[[LOCATARIO]]",
    x: MX,
    y: Y_LOCATARIO,
  }]]);
  const result = await detect(pdf);
  assertEquals(result.ok, false);
  if (!result.ok) assertStringIncludes(result.error, "LOCADOR");
});

Deno.test("unit: detect — only LOCADOR present returns error mentioning LOCATARIO", async () => {
  const pdf = buildPdfWithMarkers([[{
    text: "[[LOCADOR]]",
    x: MX,
    y: Y_LOCADOR,
  }]]);
  const result = await detect(pdf);
  assertEquals(result.ok, false);
  if (!result.ok) assertStringIncludes(result.error, "LOCATARIO");
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: result shape conformance
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: detect — success result shape: ok:true and positions array", async () => {
  const result = await detect(buildMinimalValidPdf());
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(Array.isArray(result.positions), true);
});

Deno.test("unit: detect — failure result shape: ok:false and non-empty error string", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([PW, PH]);
  const result = await detect(await doc.save());
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(typeof result.error, "string");
    assertEquals(result.error.length > 0, true);
  }
});

Deno.test("unit: detect — failure does not throw", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([PW, PH]);
  const result = await detect(await doc.save());
  assertEquals(typeof result.ok, "boolean");
});
