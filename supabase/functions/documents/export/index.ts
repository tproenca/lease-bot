// documents/export — internal helper module (not an HTTP endpoint).
//
// Exports one or more Google Docs to PDF via the Drive API and merges them
// into a single PDF bundle using pdf-lib, preserving document order.
//
// Called by the future POST /signatures/send endpoint.
//
// Token acquisition: uses the landlord's stored Google OAuth refresh token
// (same pattern as documents/generate) to obtain a fresh access token once
// per call, then reuses it for all Drive export requests.
//
// Error behaviour:
//   On any individual export failure the function returns immediately with:
//     { ok: false; failedUrl: string; driveUrl: string; error: string }
//   The `driveUrl` is a human-readable Google Docs URL for the failed file so
//   the landlord can inspect or retry.
//
// Success shape:
//   { ok: true; pdf: Uint8Array; pageCount: number }
//
// No console.log statements — errors are returned as structured values.

import { PDFDocument } from "pdf-lib";
import { refreshGoogleAccessToken } from "../../_shared/google.ts";

// ─── Types ────────────────────────────────────────────────────────────────

/** A single document to export, identified by its Drive file ID. */
export interface DocToExport {
  /** Google Drive file ID of the Google Doc to export. */
  fileId: string;
  /** Human-readable label used in error messages (e.g. template name). */
  label: string;
}

/** Returned when all exports and the merge succeed. */
export interface ExportSuccess {
  ok: true;
  /** Merged PDF as raw bytes. */
  pdf: Uint8Array;
  /** Total number of pages across all merged documents. */
  pageCount: number;
}

/** Returned when any single Drive export request fails. */
export interface ExportFailure {
  ok: false;
  /** Drive export URL that failed (for diagnostics). */
  failedUrl: string;
  /** Human-readable Google Docs URL the landlord can open to inspect. */
  driveUrl: string;
  /** Short error description (never echoes raw user data). */
  error: string;
}

export type ExportResult = ExportSuccess | ExportFailure;

// ─── Drive constants ──────────────────────────────────────────────────────

const DRIVE_EXPORT_BASE = "https://www.googleapis.com/drive/v3/files";
const DRIVE_EXPORT_MIME = "application/pdf";
const DRIVE_RETRYABLE_STATUSES = new Set([429, 500]);
const DRIVE_MAX_ATTEMPTS = 3;

// ─── Drive retry helper ───────────────────────────────────────────────────

/**
 * Fetch a URL with up to DRIVE_MAX_ATTEMPTS attempts, retrying on 429 and 500
 * responses with exponential backoff (1 s, 2 s).
 */
async function fetchWithRetry(
  url: string | URL,
  init: RequestInit,
): Promise<Response> {
  let last: Response | undefined;
  for (let attempt = 0; attempt < DRIVE_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 * Math.pow(2, attempt - 1))
      );
    }
    last = await fetch(url, init);
    if (!DRIVE_RETRYABLE_STATUSES.has(last.status)) {
      return last;
    }
  }
  return last!;
}

// ─── URL builders ─────────────────────────────────────────────────────────

/** Build the Drive export URL for a given file ID (exports to PDF). */
function driveExportUrl(fileId: string): string {
  const url = new URL(
    `${DRIVE_EXPORT_BASE}/${encodeURIComponent(fileId)}/export`,
  );
  url.searchParams.set("mimeType", DRIVE_EXPORT_MIME);
  return url.toString();
}

/** Build the human-readable Google Docs URL for a file ID. */
function googleDocsUrl(fileId: string): string {
  return `https://docs.google.com/document/d/${fileId}/edit`;
}

// ─── Core export function ─────────────────────────────────────────────────

/**
 * Export a single Google Doc to PDF bytes via the Drive API.
 *
 * Returns the raw PDF bytes on success, or throws an error that includes the
 * HTTP status so the caller can surface it.
 */
async function exportDocToPdfBytes(params: {
  accessToken: string;
  fileId: string;
}): Promise<Uint8Array> {
  const url = driveExportUrl(params.fileId);
  const res = await fetchWithRetry(url, {
    headers: { Authorization: `Bearer ${params.accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`drive_export_pdf_failed_${res.status}`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Export each Google Doc in `docs` to PDF and merge them into one bundle.
 *
 * Documents are merged in the order provided. On the first export failure the
 * function returns an ExportFailure immediately (no partial result).
 *
 * @param refreshToken  Landlord's stored Google OAuth refresh token.
 * @param docs          Ordered list of Drive file IDs and labels to export.
 */
export async function exportAndMergePdfs(params: {
  refreshToken: string;
  docs: DocToExport[];
}): Promise<ExportResult> {
  const { refreshToken, docs } = params;

  // Obtain a fresh access token once and reuse for all exports.
  const accessToken = await refreshGoogleAccessToken(refreshToken);

  // Export each doc individually, collecting raw PDF bytes in order.
  const pdfBytesPerDoc: Uint8Array[] = [];
  for (const doc of docs) {
    const exportUrl = driveExportUrl(doc.fileId);
    let bytes: Uint8Array;
    try {
      bytes = await exportDocToPdfBytes({ accessToken, fileId: doc.fileId });
    } catch (err) {
      return {
        ok: false,
        failedUrl: exportUrl,
        driveUrl: googleDocsUrl(doc.fileId),
        error: err instanceof Error
          ? err.message
          : `export_failed_${doc.label}`,
      };
    }
    pdfBytesPerDoc.push(bytes);
  }

  // Merge all individual PDFs into one document using pdf-lib.
  const merged = await PDFDocument.create();
  let totalPageCount = 0;

  for (const bytes of pdfBytesPerDoc) {
    const src = await PDFDocument.load(bytes);
    const pageIndices = src.getPageIndices();
    const copiedPages = await merged.copyPages(src, pageIndices);
    for (const page of copiedPages) {
      merged.addPage(page);
    }
    totalPageCount += pageIndices.length;
  }

  const mergedBytes = await merged.save();

  return {
    ok: true,
    pdf: mergedBytes,
    pageCount: totalPageCount,
  };
}
