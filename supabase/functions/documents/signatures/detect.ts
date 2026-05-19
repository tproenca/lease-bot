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
//     4. Match the underscore marker pattern and the role label on the next line.
//
//   Autentique coordinate system: origin at bottom-left of page, unit = points
//   (1/72 inch). x increases right, y increases up.
//
//   pdf-lib writes text as hex-encoded strings: <hex> Tj. The tokeniser handles
//   both parenthesis-delimited literals and angle-bracket hex strings.
//
// See ADR-0011 for the full rationale behind this approach.
//
// Success shape:  { ok: true; signers: DetectedSigner[] }
// Failure shape:  { ok: false; error: string }
//
// No console.log statements. No I/O. No network calls. No Deno.serve().

import { PDFDocument } from "pdf-lib";

// ─── Public types ─────────────────────────────────────────────────────────

export type SignerRole = "tenant" | "landlord" | "witness";

export interface DetectedSigner {
  /** Display name for this signer position (role label or witness name). */
  name: string;
  /** Signer role as expected by the Autentique API. */
  role: SignerRole;
  /**
   * X coordinate in PDF points, origin at bottom-left of page.
   * Corresponds to the horizontal start of the signature underline.
   */
  x: number;
  /**
   * Y coordinate in PDF points, origin at bottom-left of page.
   * Corresponds to the baseline of the signature underline text element.
   */
  y: number;
  /** 1-indexed page number of the signature block within the merged PDF. */
  page: number;
}

export interface DetectSuccess {
  ok: true;
  signers: DetectedSigner[];
}

export interface DetectFailure {
  ok: false;
  /**
   * User-friendly message that can be surfaced to the landlord. Instructs
   * them to position signers manually on the Autentique interface.
   */
  error: string;
}

export type DetectResult = DetectSuccess | DetectFailure;

// ─── Constants ────────────────────────────────────────────────────────────

/**
 * The signature underline marker written by our lease templates.
 * Must be at least 20 underscores to reduce false positive matches.
 */
const UNDERLINE_PATTERN = /_{20,}/;

/**
 * Brazilian lease role labels as they appear in the PDF text stream.
 * Matching is case-insensitive to tolerate minor template variations.
 */
const TENANT_LABEL = /^inquilino$/i;
const LANDLORD_LABEL = /^locador$/i;

/**
 * Maximum vertical distance (in points) between an underline baseline and the
 * label baseline for the label to be considered "immediately below" the line.
 * PDF text lines in our templates are ~14–24 pt apart at 12 pt font size.
 */
const LABEL_SEARCH_WINDOW_PT = 40;

/**
 * User-facing fallback message returned when no markers are detected.
 */
const FALLBACK_MESSAGE =
  "Não foi possível detectar automaticamente as posições de assinatura no PDF. " +
  "Acesse o documento no Autentique e posicione os campos de assinatura manualmente " +
  "antes de enviar para os signatários.";

// ─── Zlib decompression ───────────────────────────────────────────────────

/**
 * Decompress zlib-encoded bytes (FlateDecode, which is what pdf-lib uses to
 * compress content streams) using Deno's built-in DecompressionStream.
 *
 * The "deflate" format in the WHATWG Compression Streams spec handles both
 * raw deflate and zlib-wrapped deflate (magic bytes 0x78 0x9C).
 *
 * Returns the decompressed bytes, or the original bytes unchanged if
 * decompression fails (e.g. the stream was never compressed).
 */
async function zlibDecompress(data: Uint8Array): Promise<Uint8Array> {
  // Detect zlib magic bytes (CMF + FLG where CMF & 0x0F === 8).
  if (data.length < 2 || (data[0] & 0x0f) !== 8) {
    return data; // Not zlib-compressed — return as-is.
  }
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
    return data; // Decompression failed — return original.
  }
}

// ─── Content-stream tokeniser ─────────────────────────────────────────────

/**
 * A located text element extracted from a PDF content stream.
 */
interface TextElement {
  text: string;
  /** X position in page points (bottom-left origin). */
  x: number;
  /** Y position in page points (bottom-left origin). */
  y: number;
}

/**
 * Decode a hex string literal <AABB…> into its plain-text content.
 * Each pair of hex digits maps to one character code.
 */
function decodeHexString(hex: string): string {
  // Pad to even length.
  const padded = hex.length % 2 === 0 ? hex : hex + "0";
  let s = "";
  for (let i = 0; i < padded.length; i += 2) {
    s += String.fromCharCode(parseInt(padded.slice(i, i + 2), 16));
  }
  return s;
}

/**
 * Decode a PDF parenthesis-delimited string literal "(…)" into its plain-text
 * content. Handles common escape sequences: \n, \r, \t, \\, \(, \).
 */
function decodePdfString(literal: string): string {
  // Remove surrounding parentheses.
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

/**
 * Tokenise a PDF content stream string into individual tokens.
 *
 * Handles:
 *   - Parenthesis-delimited string literals  (…)
 *   - Angle-bracket hex string literals       <…>
 *   - Array delimiters                        [ ]
 *   - Bare tokens (operators and numbers)
 *   - Comments (% to end of line — skipped)
 */
function* tokenise(stream: string): Generator<string> {
  let i = 0;
  while (i < stream.length) {
    const ch = stream[i];

    // Skip whitespace.
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }

    // Skip comments.
    if (ch === "%") {
      while (i < stream.length && stream[i] !== "\n" && stream[i] !== "\r") {
        i++;
      }
      continue;
    }

    // Parenthesis-delimited string literal.
    if (ch === "(") {
      let depth = 1;
      let j = i + 1;
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

    // Angle-bracket hex string literal <…>.
    // Double angle brackets <<…>> are dictionary delimiters — yield them as-is.
    if (ch === "<") {
      if (i + 1 < stream.length && stream[i + 1] === "<") {
        yield "<<";
        i += 2;
        continue;
      }
      let j = i + 1;
      while (j < stream.length && stream[j] !== ">") {
        j++;
      }
      // Yield including angle brackets so decoder can recognise the type.
      yield stream.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === ">") {
      if (i + 1 < stream.length && stream[i + 1] === ">") {
        yield ">>";
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    // Array delimiters.
    if (ch === "[" || ch === "]") {
      yield ch;
      i++;
      continue;
    }

    // Bare token (operator, name, or number).
    let j = i;
    while (
      j < stream.length &&
      stream[j] !== " " &&
      stream[j] !== "\t" &&
      stream[j] !== "\n" &&
      stream[j] !== "\r" &&
      stream[j] !== "(" &&
      stream[j] !== ")" &&
      stream[j] !== "<" &&
      stream[j] !== ">" &&
      stream[j] !== "[" &&
      stream[j] !== "]" &&
      stream[j] !== "%" &&
      stream[j] !== "{"
    ) {
      j++;
    }
    if (j > i) yield stream.slice(i, j);
    i = j;
  }
}

/**
 * Decode a token that may be a parenthesis string, a hex string, or a bare
 * token (returned as-is).
 */
function decodeTokenText(token: string): string {
  if (token.startsWith("(")) return decodePdfString(token);
  if (token.startsWith("<") && !token.startsWith("<<")) {
    return decodeHexString(token.slice(1, -1));
  }
  return token;
}

/**
 * Parse a decompressed PDF content stream and extract all text elements with
 * their positions.
 *
 * Only text operators within BT…ET blocks are processed:
 *   Tm a b c d e f  — set text matrix (e=x, f=y)
 *   Td tx ty        — move start of next line (relative)
 *   TD tx ty        — same + update leading
 *   T*              — move to next line (uses leading)
 *   Tf font size    — set font and size (size used for T* leading)
 *   TL leading      — set leading
 *   Tj string       — show string
 *   TJ [array]      — show array of strings with kerning adjustments
 */
function extractTextElements(stream: string): TextElement[] {
  const elements: TextElement[] = [];
  const tokens = [...tokenise(stream)];

  let curX = 0;
  let curY = 0;
  let lineX = 0;
  let lineY = 0;
  let fontSize = 12;
  let leading = 0;
  let inTextBlock = false;

  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];

    // BT — begin text block.
    if (tok === "BT") {
      inTextBlock = true;
      curX = 0;
      curY = 0;
      lineX = 0;
      lineY = 0;
      i++;
      continue;
    }

    // ET — end text block.
    if (tok === "ET") {
      inTextBlock = false;
      i++;
      continue;
    }

    if (!inTextBlock) {
      i++;
      continue;
    }

    // Tm a b c d e f — set text matrix.
    if (tok === "Tm") {
      // 6 operands precede the operator.
      if (i >= 6) {
        const e = parseFloat(tokens[i - 2]);
        const f = parseFloat(tokens[i - 1]);
        if (!isNaN(e) && !isNaN(f)) {
          curX = e;
          curY = f;
          lineX = e;
          lineY = f;
        }
      }
      i++;
      continue;
    }

    // Tf font size — capture font size for T* leading calculation.
    if (tok === "Tf") {
      if (i >= 2) {
        const sz = parseFloat(tokens[i - 1]);
        if (!isNaN(sz) && sz > 0) fontSize = sz;
      }
      i++;
      continue;
    }

    // TL leading — set text leading.
    if (tok === "TL") {
      if (i >= 1) {
        const l = parseFloat(tokens[i - 1]);
        if (!isNaN(l)) leading = l;
      }
      i++;
      continue;
    }

    // Td tx ty — move to start of next line.
    if (tok === "Td") {
      if (i >= 2) {
        const tx = parseFloat(tokens[i - 2]);
        const ty = parseFloat(tokens[i - 1]);
        if (!isNaN(tx) && !isNaN(ty)) {
          lineX += tx;
          lineY += ty;
          curX = lineX;
          curY = lineY;
        }
      }
      i++;
      continue;
    }

    // TD tx ty — move and update leading.
    if (tok === "TD") {
      if (i >= 2) {
        const tx = parseFloat(tokens[i - 2]);
        const ty = parseFloat(tokens[i - 1]);
        if (!isNaN(tx) && !isNaN(ty)) {
          lineX += tx;
          lineY += ty;
          curX = lineX;
          curY = lineY;
          leading = -ty;
        }
      }
      i++;
      continue;
    }

    // T* — move to start of next line using current leading.
    if (tok === "T*") {
      const ld = leading !== 0 ? leading : fontSize;
      lineY -= ld;
      curX = lineX;
      curY = lineY;
      i++;
      continue;
    }

    // Tj string — show single string (operator follows the operand).
    if (tok === "Tj") {
      if (i >= 1) {
        const operand = tokens[i - 1];
        if (
          operand.startsWith("(") ||
          (operand.startsWith("<") && !operand.startsWith("<<"))
        ) {
          const text = decodeTokenText(operand);
          if (text.length > 0) {
            elements.push({ text, x: curX, y: curY });
          }
        }
      }
      i++;
      continue;
    }

    // TJ [array] — show strings with kerning; operator follows "]".
    if (tok === "TJ") {
      // Walk backward from "]" to "[".
      let combined = "";
      let j = i - 1;
      if (j >= 0 && tokens[j] === "]") {
        j--;
        while (j >= 0 && tokens[j] !== "[") {
          const t = tokens[j];
          if (
            t.startsWith("(") ||
            (t.startsWith("<") && !t.startsWith("<<"))
          ) {
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

// ─── Signature block detection ────────────────────────────────────────────

/**
 * Classify a label text string into a signer role and display name.
 */
function classifyLabel(label: string): { role: SignerRole; name: string } {
  const trimmed = label.trim();
  if (TENANT_LABEL.test(trimmed)) {
    return { role: "tenant", name: "Inquilino" };
  }
  if (LANDLORD_LABEL.test(trimmed)) {
    return { role: "landlord", name: "Locador" };
  }
  return { role: "witness", name: trimmed };
}

/**
 * Given all text elements on a page, find signature blocks:
 *   1. Locate elements whose content matches the underline pattern.
 *   2. Find the label element immediately below each underline.
 *   3. Return one DetectedSigner per block.
 */
function findSignatureBlocks(
  elements: TextElement[],
  pageNumber: number,
): DetectedSigner[] {
  const signers: DetectedSigner[] = [];

  for (const el of elements) {
    if (!UNDERLINE_PATTERN.test(el.text)) continue;

    const underlineY = el.y;
    const underlineX = el.x;

    // Find the best label below this underline.
    let bestLabel: TextElement | null = null;
    let bestDist = Infinity;

    for (const candidate of elements) {
      if (candidate === el) continue;
      // In PDF coordinates, y increases upward.
      // The label is BELOW the underline, so candidate.y < underline.y.
      const dy = underlineY - candidate.y;
      if (dy <= 0 || dy > LABEL_SEARCH_WINDOW_PT) continue;
      if (candidate.text.trim().length === 0) continue;
      const dx = Math.abs(candidate.x - underlineX);
      const dist = dy + dx * 0.1;
      if (dist < bestDist) {
        bestDist = dist;
        bestLabel = candidate;
      }
    }

    if (!bestLabel) continue;

    const { role, name } = classifyLabel(bestLabel.text);
    signers.push({
      name,
      role,
      x: el.x,
      y: el.y,
      page: pageNumber,
    });
  }

  return signers;
}

// ─── Content stream extraction ────────────────────────────────────────────

/**
 * Extract and decompress the content stream for a given pdf-lib page.
 *
 * pdf-lib stores page content in compressed (FlateDecode / zlib) streams.
 * We access the internal `node` and `context` properties to read the raw bytes,
 * then decompress them with Deno's DecompressionStream.
 *
 * This relies on pdf-lib internal APIs — see ADR-0011 for the rationale and
 * the versioned dependency constraint that protects against breakage.
 */
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

    // Contents() returns a PDFArray (has .asArray()) or a direct PDFRef.
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
      } catch {
        // Skip unreadable stream segments.
      }
    }
    return combined;
  } catch {
    return "";
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Scan the last page of a merged PDF for signature blocks and return
 * Autentique-compatible signer coordinates.
 *
 * @param pdfBytes  Raw bytes of the merged PDF (output of exportAndMergePdfs).
 *
 * @returns DetectSuccess with an array of signers, or DetectFailure with a
 *   user-friendly error message when no signature blocks are found.
 */
export async function detectSignaturePositions(
  pdfBytes: Uint8Array,
): Promise<DetectResult> {
  const doc = await PDFDocument.load(pdfBytes);
  const pageCount = doc.getPageCount();

  if (pageCount === 0) {
    return { ok: false, error: FALLBACK_MESSAGE };
  }

  const lastPageIndex = pageCount - 1;
  const lastPage = doc.getPage(lastPageIndex);

  // deno-lint-ignore no-explicit-any
  const context = (doc as any).context;
  const stream = await getPageContentStream(lastPage, context);
  const elements = extractTextElements(stream);
  const signers = findSignatureBlocks(elements, pageCount);

  if (signers.length === 0) {
    return { ok: false, error: FALLBACK_MESSAGE };
  }

  return { ok: true, signers };
}
