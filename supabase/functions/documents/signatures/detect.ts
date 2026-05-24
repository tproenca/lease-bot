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
  /** X coordinate in PDF points from lower-left, at the underline baseline. */
  x: number;
  /** Y coordinate in PDF points from lower-left, at the underline baseline. */
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

/** Minimum underscore run to be recognised as a signature line. */
const UNDERLINE_PATTERN = /_{20,}/;

/**
 * Maximum vertical distance (in points) between the underline baseline and
 * the label baseline for the label to be considered "immediately below".
 * At 12pt font size with standard leading, lines are ~14–24pt apart.
 */
const LABEL_SEARCH_WINDOW_PT = 40;

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
    let j = i;
    while (j < stream.length && !" \t\n\r()/<>[]%{".includes(stream[j])) j++;
    if (j > i) yield stream.slice(i, j);
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
        if (text.length > 0) elements.push({ text, x: curX, y: curY });
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
        elements.push({ text: combined, x: curX, y: curY });
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

// ─── Signature block detection ────────────────────────────────────────────

function classifyLabelToRole(
  labelText: string,
  witnessCount: number,
): string | null {
  // ASCII-safe substring checks survive most PDF font encodings. "Locador" and
  // "Locata" (prefix of "Locatário/Locatario") are pure ASCII. "Testemunha" is
  // also ASCII, making these checks robust against encoding variations.
  if (/locador/i.test(labelText)) return "LOCADOR";
  if (/locata/i.test(labelText)) return "LOCATARIO";
  if (/testemunha/i.test(labelText)) {
    return witnessCount === 0 ? "TESTEMUNHA_1" : "TESTEMUNHA_2";
  }
  return null;
}

function findSignatureBlocks(
  elements: TextElement[],
  pageNumber: number,
): SignerPosition[] {
  const positions: SignerPosition[] = [];
  let witnessCount = 0;

  // Process underlines top-to-bottom (descending y in PDF coordinates) so
  // TESTEMUNHA_1 is always the witness closest to the top of the page.
  const underlines = elements
    .filter((el) => UNDERLINE_PATTERN.test(el.text))
    .sort((a, b) => b.y - a.y);

  for (const ul of underlines) {
    // Collect all text elements within the vertical search window below this
    // underline and concatenate them into a single label string.
    const labelText = elements
      .filter((candidate) => {
        const dy = ul.y - candidate.y; // positive = below (y increases upward)
        return dy > 0 && dy <= LABEL_SEARCH_WINDOW_PT && candidate !== ul;
      })
      .sort((a, b) => b.y - a.y)
      .map((e) => e.text)
      .join(" ");

    if (!labelText.trim()) continue;

    const role = classifyLabelToRole(labelText, witnessCount);
    if (!role) continue;

    if (role.startsWith("TESTEMUNHA")) witnessCount++;
    positions.push({ role, page: pageNumber, x: ul.x, y: ul.y });
  }

  return positions;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Scan the last page of a merged PDF for signature blocks and return
 * Autentique-compatible signer coordinates.
 *
 * Returns the actual x/y position of each underline baseline so that
 * Autentique places signature widgets exactly over the visible fields.
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

  // Signatures are always on the last page of Brazilian lease contracts.
  const lastPage = doc.getPage(pageCount - 1);
  // deno-lint-ignore no-explicit-any
  const context = (doc as any).context;
  const stream = await getPageContentStream(lastPage, context);
  const elements = extractTextElements(stream);
  const positions = findSignatureBlocks(elements, pageCount);

  for (const required of REQUIRED_ROLES) {
    if (!positions.find((p) => p.role === required)) {
      return { ok: false, error: `detect_missing_role_${required}` };
    }
  }

  return { ok: true, positions };
}
