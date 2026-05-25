// documents/signatures/detect — pure internal module (no HTTP endpoint).
//
// Scans the last page of a merged PDF for signature blocks and returns
// Autentique-compatible signer coordinates.
//
// Detection strategy:
//   pdf-lib is a PDF writer/merger and does not expose a text extraction API.
//   To locate signature blocks we:
//     1. Access the page's content stream via pdf-lib internal APIs.
//     2. Decompress the stream with Deno's built-in DecompressionStream (zlib).
//     3. Parse the raw PDF content-stream operators (BT/ET, Tm, Td, Tj, TJ)
//        to extract text elements with their positions.
//     4. Match the underscore pattern (≥20 underscores) and read the label
//        immediately below each underline to determine the signer role.
//
//   Autentique coordinate system: origin at bottom-left of page, unit = points
//   (1/72 inch). x increases right, y increases up.
//
//   Role classification (from the label below each underline):
//     Contains "Locador"    → LOCADOR   (landlord, required)
//     Contains "Locata"     → LOCATARIO (tenant, required; matches "Locatário")
//     Contains "Testemunha" → TESTEMUNHA_1, then TESTEMUNHA_2 (by top-to-bottom order)
//
//   This approach returns the actual x/y of the underline baseline, so
//   Autentique places the signature widget exactly over the visible field —
//   no hardcoded default coordinates.
//
// Success shape:  { ok: true; positions: SignerPosition[] }
// Failure shape:  { ok: false; error: string }
//
// No console.log statements. No I/O. No network calls. No Deno.serve().

import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1";

// ─── Public types ─────────────────────────────────────────────────────────

export interface SignerPosition {
  /** Role token used by send/index.ts and the Autentique API. */
  role: string; // "LOCADOR" | "LOCATARIO" | "TESTEMUNHA_1" | "TESTEMUNHA_2"
  /** 1-based page number where the signature block was found. */
  page: number;
  /** X position as a percentage of page width (0–100), origin top-left. */
  x: number;
  /** Y position as a percentage of page height (0–100), origin top-left, increasing downward. */
  y: number;
}

export interface DetectSuccess {
  ok: true;
  positions: SignerPosition[];
}

export interface DetectFailure {
  ok: false;
  /** Short diagnostic code (never echoes user data). */
  error: string;
}

export type DetectResult = DetectSuccess | DetectFailure;

// ─── Constants ────────────────────────────────────────────────────────────

/** Matches [[ROLE]] markers in extracted text (e.g. [[LOCADOR]]). */
const MARKER_RE = /\[\[([A-Z0-9_]+)\]\]/;

/** All roles the detector recognises. Unknown markers are ignored. */
const RECOGNISED_ROLES = new Set([
  "LOCADOR",
  "LOCATARIO",
  "TESTEMUNHA_1",
  "TESTEMUNHA_2",
]);

/** Roles that must be present for the document to be signable. */
const REQUIRED_ROLES = ["LOCADOR", "LOCATARIO"];

// ─── Zlib decompression ───────────────────────────────────────────────────

async function zlibDecompress(data: Uint8Array): Promise<Uint8Array> {
  if (data.length < 2 || (data[0] & 0x0f) !== 8) return data;
  try {
    const ds = new DecompressionStream("deflate");
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    writer.write(data as unknown as ArrayBuffer);
    writer.close();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
    const out = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  } catch {
    return data;
  }
}

// ─── Content-stream tokeniser ─────────────────────────────────────────────

interface TextElement {
  text: string;
  x: number;
  y: number;
  fontSize: number;
}

function decodeHexString(hex: string): string {
  const padded = hex.length % 2 === 0 ? hex : hex + "0";
  let s = "";
  for (let i = 0; i < padded.length; i += 2) {
    s += String.fromCharCode(parseInt(padded.slice(i, i + 2), 16));
  }
  return s;
}

function decodePdfString(literal: string): string {
  const inner = literal.slice(1, -1);
  return inner.replace(/\\(.)/g, (_: string, ch: string) => {
    switch (ch) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "\\":
        return "\\";
      case "(":
        return "(";
      case ")":
        return ")";
      default:
        return ch;
    }
  });
}

function* tokenise(stream: string): Generator<string> {
  let i = 0;
  while (i < stream.length) {
    const ch = stream[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    if (ch === "%") {
      while (i < stream.length && stream[i] !== "\n" && stream[i] !== "\r") i++;
      continue;
    }
    if (ch === "(") {
      let depth = 1, j = i + 1;
      let literal = "(";
      while (j < stream.length && depth > 0) {
        if (stream[j] === "\\" && j + 1 < stream.length) {
          literal += stream[j] + stream[j + 1];
          j += 2;
          continue;
        }
        if (stream[j] === "(") depth++;
        if (stream[j] === ")") depth--;
        literal += stream[j];
        j++;
      }
      yield literal;
      i = j;
      continue;
    }
    if (ch === "<") {
      if (i + 1 < stream.length && stream[i + 1] === "<") {
        yield "<<";
        i += 2;
        continue;
      }
      let j = i + 1;
      while (j < stream.length && stream[j] !== ">") j++;
      yield stream.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === ">") {
      if (i + 1 < stream.length && stream[i + 1] === ">") {
        yield ">>";
        i += 2;
      } else i++;
      continue;
    }
    if (ch === "[" || ch === "]") {
      yield ch;
      i++;
      continue;
    }
    if (ch === "/") {
      // PDF name object: consume through the name characters
      let j = i + 1;
      while (j < stream.length && !" \t\n\r()/<>[]%{".includes(stream[j])) j++;
      yield stream.slice(i, j);
      i = j;
      continue;
    }
    let j = i;
    while (j < stream.length && !" \t\n\r()/<>[]%{".includes(stream[j])) j++;
    if (j > i) yield stream.slice(i, j);
    else j++; // skip unrecognised delimiter (e.g. `{`) to prevent infinite loop
    i = j;
  }
}

function decodeTokenText(token: string): string {
  if (token.startsWith("(")) return decodePdfString(token);
  if (token.startsWith("<") && !token.startsWith("<<")) {
    return decodeHexString(token.slice(1, -1));
  }
  return token;
}

function extractTextElements(stream: string): TextElement[] {
  const elements: TextElement[] = [];
  const tokens = [...tokenise(stream)];
  let curX = 0, curY = 0, lineX = 0, lineY = 0;
  let fontSize = 12, leading = 0;
  let inTextBlock = false;
  let i = 0;

  while (i < tokens.length) {
    const tok = tokens[i];

    if (tok === "BT") {
      inTextBlock = true;
      curX =
        curY =
        lineX =
        lineY =
          0;
      i++;
      continue;
    }
    if (tok === "ET") {
      inTextBlock = false;
      i++;
      continue;
    }
    if (!inTextBlock) {
      i++;
      continue;
    }

    if (tok === "Tm" && i >= 6) {
      const e = parseFloat(tokens[i - 2]), f = parseFloat(tokens[i - 1]);
      if (!isNaN(e) && !isNaN(f)) {
        curX = lineX = e;
        curY = lineY = f;
      }
      i++;
      continue;
    }
    if (tok === "Tf" && i >= 2) {
      const sz = parseFloat(tokens[i - 1]);
      if (!isNaN(sz) && sz > 0) fontSize = sz;
      i++;
      continue;
    }
    if (tok === "TL" && i >= 1) {
      const l = parseFloat(tokens[i - 1]);
      if (!isNaN(l)) leading = l;
      i++;
      continue;
    }
    if (tok === "Td" && i >= 2) {
      const tx = parseFloat(tokens[i - 2]), ty = parseFloat(tokens[i - 1]);
      if (!isNaN(tx) && !isNaN(ty)) {
        lineX += tx;
        lineY += ty;
        curX = lineX;
        curY = lineY;
      }
      i++;
      continue;
    }
    if (tok === "TD" && i >= 2) {
      const tx = parseFloat(tokens[i - 2]), ty = parseFloat(tokens[i - 1]);
      if (!isNaN(tx) && !isNaN(ty)) {
        lineX += tx;
        lineY += ty;
        curX = lineX;
        curY = lineY;
        leading = -ty;
      }
      i++;
      continue;
    }
    if (tok === "T*") {
      const ld = leading !== 0 ? leading : fontSize;
      lineY -= ld;
      curX = lineX;
      curY = lineY;
      i++;
      continue;
    }
    if (tok === "Tj" && i >= 1) {
      const op = tokens[i - 1];
      if (op.startsWith("(") || (op.startsWith("<") && !op.startsWith("<<"))) {
        const text = decodeTokenText(op);
        if (text.length > 0) {
          elements.push({ text, x: curX, y: curY, fontSize });
        }
      }
      i++;
      continue;
    }
    if (tok === "TJ") {
      let combined = "", j = i - 1;
      if (j >= 0 && tokens[j] === "]") {
        j--;
        while (j >= 0 && tokens[j] !== "[") {
          const t = tokens[j];
          if (t.startsWith("(") || (t.startsWith("<") && !t.startsWith("<<"))) {
            combined = decodeTokenText(t) + combined;
          }
          j--;
        }
      }
      if (combined.length > 0) {
        elements.push({ text: combined, x: curX, y: curY, fontSize });
      }
      i++;
      continue;
    }
    i++;
  }
  return elements;
}

// ─── Content stream extraction ────────────────────────────────────────────

async function getPageContentStream(
  page: ReturnType<PDFDocument["getPage"]>,
  // deno-lint-ignore no-explicit-any
  context: any,
): Promise<string> {
  try {
    // deno-lint-ignore no-explicit-any
    const node = (page as any).node;
    if (!node?.Contents) return "";
    const contents = node.Contents();
    if (!contents) return "";
    const decoder = new TextDecoder("latin1");
    // deno-lint-ignore no-explicit-any
    const contentsAny = contents as any;
    const refs: unknown[] = contentsAny.asArray?.() ??
      (contentsAny.objectNumber !== undefined ? [contentsAny] : []);

    // When Contents resolved directly to the stream object (no indirect ref),
    // refs will be empty — read the bytes from the object itself.
    if (refs.length === 0) {
      const raw: Uint8Array = contentsAny.getContents?.() ??
        contentsAny.contents;
      if (!(raw instanceof Uint8Array) || raw.length === 0) return "";
      const decompressed = await zlibDecompress(raw);
      return decoder.decode(decompressed);
    }

    let combined = "";
    for (const ref of refs) {
      try {
        const stream = context.lookup(ref);
        if (!stream) continue;
        // deno-lint-ignore no-explicit-any
        const s = stream as any;
        const raw: Uint8Array = s.getContents?.() ?? s.contents;
        if (!raw) continue;
        const decompressed = await zlibDecompress(raw);
        combined += decoder.decode(decompressed) + " ";
      } catch { /* skip unreadable stream segments */ }
    }
    return combined;
  } catch {
    return "";
  }
}

// ─── Marker detection ─────────────────────────────────────────────────────

interface MarkerHit {
  role: string;
  page: number;
  x: number;
  y: number;
  fontSize: number;
}

/**
 * Scan extracted text elements for [[ROLE]] markers and return their x/y.
 * Elements are processed top-to-bottom (descending y) so the first occurrence
 * of each role wins and order is deterministic.
 */
function findMarkerPositions(
  elements: TextElement[],
  pageNumber: number,
): MarkerHit[] {
  const hits: MarkerHit[] = [];
  const seen = new Set<string>();

  const sorted = [...elements].sort((a, b) => b.y - a.y);

  for (const el of sorted) {
    const match = MARKER_RE.exec(el.text);
    if (!match) continue;
    const role = match[1];
    if (!RECOGNISED_ROLES.has(role) || seen.has(role)) continue;
    seen.add(role);
    hits.push({
      role,
      page: pageNumber,
      x: el.x,
      y: el.y,
      fontSize: el.fontSize,
    });
  }

  return hits;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Scan all pages of a PDF for [[ROLE]] markers and return their
 * Autentique-compatible coordinates.
 *
 * Uses the full content-stream parser (with zlib decompression) so it works
 * with both Google Docs exports and pdf-lib-generated PDFs.
 */
export async function detectSignaturePositions(
  pdfBytes: Uint8Array,
): Promise<DetectResult> {
  if (!pdfBytes || pdfBytes.length === 0) {
    return { ok: false, error: "detect_empty_pdf" };
  }

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdfBytes);
  } catch {
    return { ok: false, error: "detect_invalid_pdf" };
  }

  const pageCount = doc.getPageCount();
  if (pageCount === 0) {
    return { ok: false, error: "detect_no_pages" };
  }

  // deno-lint-ignore no-explicit-any
  const context = (doc as any).context;
  const positions: SignerPosition[] = [];

  for (let i = 0; i < pageCount; i++) {
    const page = doc.getPage(i);
    const { width: pw, height: ph } = page.getSize();
    const stream = await getPageContentStream(page, context);
    const elements = extractTextElements(stream);
    const found = findMarkerPositions(elements, i + 1); // 1-based

    // Convert from PDF points (origin bottom-left, y upward) to the
    // Autentique percentage system (origin top-left, y downward, 0–100).
    // We offset y upward by fontSize so the box top aligns with the text top
    // (the PDF y is the text baseline; the visible glyph starts ~fontSize above it).
    for (const hit of found) {
      positions.push({
        role: hit.role,
        page: hit.page,
        x: (hit.x / pw) * 100,
        y: ((ph - (hit.y + hit.fontSize)) / ph) * 100,
      });
    }
  }

  for (const required of REQUIRED_ROLES) {
    if (!positions.find((p) => p.role === required)) {
      return { ok: false, error: `detect_missing_marker_${required}` };
    }
  }

  return { ok: true, positions };
}
