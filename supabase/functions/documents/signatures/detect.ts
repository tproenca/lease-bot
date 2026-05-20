// documents/signatures/detect — signature position detector.
//
// Scans a merged PDF for signature marker text blocks (e.g. "[[ASSINATURA_LOCATÁRIO]]",
// "[[ASSINATURA_LOCADOR]]", "[[ASSINATURA_TESTEMUNHA_1]]", etc.) and returns the
// page and coordinates (x, y as percentages of page size) for each marker found.
//
// The detection strategy is label-based: the PDF is converted to text and
// each marker pattern is matched to a page by scanning the per-page text.
// Coordinates are set to sensible defaults for each signer role when
// exact glyph bounds cannot be determined from the PDF text stream.
//
// This module uses no third-party libraries beyond pdf-lib (for page count and
// page dimension inspection). Actual text position extraction from a PDF binary
// is non-trivial; this implementation uses pdf-lib to identify page count and
// dimensions, then scans a raw text representation of the PDF bytes for the
// marker strings to determine which page each signer belongs to.
//
// Return shape:
//   ok: true  → { positions: SignerPosition[] }
//   ok: false → { error: string }
//
// SignerPosition shape:
//   { role: string; page: number; x: number; y: number }
//
// `x` and `y` are floating-point values in PDF user units (points) measured
// from the lower-left corner of the page, matching Autentique's coordinate
// system.
//
// Marker format: [[ROLE]] anywhere on the page. Recognised role tokens:
//   LOCADOR            → landlord (required)
//   LOCATARIO          → tenant (required, note: no accent in marker)
//   TESTEMUNHA_1       → witness 1
//   TESTEMUNHA_2       → witness 2
// Unknown markers are ignored (forward-compatible).

import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1";

// ─── Public types ─────────────────────────────────────────────────────────

export interface SignerPosition {
  /** Role token from the marker, e.g. "LOCADOR", "LOCATARIO". */
  role: string;
  /** 1-based page number where the marker was found. */
  page: number;
  /** X coordinate in PDF points from lower-left. */
  x: number;
  /** Y coordinate in PDF points from lower-left. */
  y: number;
}

export interface DetectSuccess {
  ok: true;
  positions: SignerPosition[];
}

export interface DetectFailure {
  ok: false;
  /** Short diagnostic (never echoes user data). */
  error: string;
}

export type DetectResult = DetectSuccess | DetectFailure;

// ─── Constants ────────────────────────────────────────────────────────────

/** Recognised role names in [[…]] markers. */
const RECOGNISED_ROLES = new Set([
  "LOCADOR",
  "LOCATARIO",
  "TESTEMUNHA_1",
  "TESTEMUNHA_2",
]);

/**
 * Required markers — at least these two must be present for the document to be
 * considered fully prepared for signing.
 */
const REQUIRED_ROLES = ["LOCADOR", "LOCATARIO"];

/**
 * Default x position (points from left) used when the marker is found on a
 * page but exact glyph position cannot be determined. Placed at ~10% from the
 * left edge of an A4 page (595 pt wide → ~60 pt).
 */
const DEFAULT_X = 60;

/**
 * Default y offset from the bottom of the page for the first signer slot.
 * A4 page is 842 pt tall. 120 pt from the bottom places signatures in the
 * lower signature block area of typical Brazilian lease contracts.
 */
const DEFAULT_Y_FIRST = 120;

/** Vertical spacing between successive signer slots on the same page. */
const DEFAULT_Y_STEP = 60;

// ─── Marker pattern ───────────────────────────────────────────────────────

/**
 * Matches [[ROLE]] anywhere in a string. The role capture group is group 1.
 * Non-global so we can test per-page segments; caller iterates all matches.
 */
const MARKER_RE = /\[\[([A-Z0-9_]+)\]\]/g;

// ─── Text extraction ──────────────────────────────────────────────────────

/**
 * Extract a plain-text representation from the raw PDF bytes.
 *
 * pdf-lib does not expose a public text-extraction API. We use a simple
 * heuristic: scan the raw byte buffer for printable ASCII sequences that
 * look like the marker strings. Because our markers are pure ASCII uppercase
 * letters, digits, underscores, and brackets, they survive most PDF encodings
 * without corruption.
 *
 * The result is a map from page index (0-based) to a concatenated string of
 * all recognisable text fragments found on that page's content stream.
 *
 * Limitations: this approach is not a full PDF text extractor. It works
 * reliably for the specific use case of detecting short ASCII marker strings
 * that were inserted into Google Docs templates. It does not handle compressed
 * content streams, multi-byte encodings, or fonts with non-standard encodings.
 * For this project's scope (Google Docs → Drive export → PDF) the content
 * streams are uncompressed ASCII, so the approach is sufficient.
 */
function extractRawTextByPage(
  pdfBytes: Uint8Array,
  pageCount: number,
): Map<number, string> {
  const raw = new TextDecoder("latin1").decode(pdfBytes);
  const pageTexts = new Map<number, string>();

  // Split raw PDF into per-page content streams.
  // Pages are separated by "Page" objects. We use a coarse split on the
  // "/Type /Page" dictionary marker and take content up to the next marker.
  //
  // Fallback: if we cannot split into pages, assign all text to page 0.
  const pageSeparatorRe = /\/Type\s*\/Page\b/g;
  const pageStarts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = pageSeparatorRe.exec(raw)) !== null) {
    pageStarts.push(m.index);
  }

  if (pageStarts.length === 0 || pageStarts.length !== pageCount) {
    // Cannot split reliably — assign full text to page 0 and let the caller
    // distribute positions across pages sequentially.
    pageTexts.set(0, raw);
    return pageTexts;
  }

  for (let i = 0; i < pageStarts.length; i++) {
    const start = pageStarts[i];
    const end = i + 1 < pageStarts.length ? pageStarts[i + 1] : raw.length;
    pageTexts.set(i, raw.slice(start, end));
  }

  return pageTexts;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Scan `pdfBytes` for [[ROLE]] markers and return their page/coordinate
 * positions suitable for Autentique's signer placement API.
 *
 * Returns `{ ok: false }` when:
 *   - `pdfBytes` is empty
 *   - the bytes are not a valid PDF (pdf-lib throws)
 *   - any required role (LOCADOR, LOCATARIO) is absent
 *
 * Coordinate placement strategy:
 *   When the marker is found on a specific page, we use that page's dimensions
 *   to compute a default lower-left placement. We cannot extract exact glyph
 *   coordinates from the PDF text stream without a full PDF renderer, so we use
 *   fixed offsets that land in the signature block area of standard Brazilian
 *   lease contracts generated from Google Docs templates.
 */
export async function detectSignaturePositions(
  pdfBytes: Uint8Array,
): Promise<DetectResult> {
  if (!pdfBytes || pdfBytes.length === 0) {
    return { ok: false, error: "detect_empty_pdf" };
  }

  // Load PDF to validate and get page count + dimensions.
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

  // Extract raw text segments per page.
  const pageTexts = extractRawTextByPage(pdfBytes, pageCount);

  // Scan for markers on each page.
  const foundByRole = new Map<string, { pageIndex: number }>();

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    const text = pageTexts.get(pageIndex) ?? pageTexts.get(0) ?? "";
    let match: RegExpExecArray | null;
    const re = new RegExp(MARKER_RE.source, "g");
    while ((match = re.exec(text)) !== null) {
      const role = match[1];
      if (RECOGNISED_ROLES.has(role) && !foundByRole.has(role)) {
        foundByRole.set(role, { pageIndex });
      }
    }
  }

  // Validate required roles are present.
  for (const required of REQUIRED_ROLES) {
    if (!foundByRole.has(required)) {
      return {
        ok: false,
        error: `detect_missing_marker_${required}`,
      };
    }
  }

  // Build positions in a deterministic order.
  const ROLE_ORDER = ["LOCADOR", "LOCATARIO", "TESTEMUNHA_1", "TESTEMUNHA_2"];
  const positions: SignerPosition[] = [];
  const slotCountPerPage = new Map<number, number>();

  for (const role of ROLE_ORDER) {
    const found = foundByRole.get(role);
    if (!found) continue;

    const { pageIndex } = found;
    const page = doc.getPage(pageIndex);
    const { height } = page.getSize();

    // Assign slot index within the page (0-based) to compute y offset.
    const slotIndex = slotCountPerPage.get(pageIndex) ?? 0;
    slotCountPerPage.set(pageIndex, slotIndex + 1);

    // Y from bottom: start at DEFAULT_Y_FIRST, step up for each additional signer.
    const y = DEFAULT_Y_FIRST + slotIndex * DEFAULT_Y_STEP;
    // Clamp y to valid page bounds.
    const clampedY = Math.min(y, Math.max(0, height - 20));

    positions.push({
      role,
      page: pageIndex + 1, // 1-based
      x: DEFAULT_X,
      y: clampedY,
    });
  }

  return { ok: true, positions };
}
