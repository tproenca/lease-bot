# ADR-0013: PDF Marker Detection via Raw Text Scan
Date: 2026-05-19
Status: Accepted

## Context
The `POST /signatures/send` endpoint must determine where to place each signer's signature block on the merged PDF before submitting it to Autentique. The approved approach (specs/DESIGN.md) is to scan the PDF for `[[ROLE]]` marker strings that landlords insert into their Google Docs templates (e.g. `[[LOCADOR]]`, `[[LOCATARIO]]`, `[[TESTEMUNHA_1]]`).

A full PDF text extraction with accurate glyph coordinates requires either a native binary (pdfcpu, poppler) or a complete PDF renderer, neither of which is available inside a Deno Edge Function. pdf-lib (the library already in use for merging, per ADR-0011) provides page dimensions and page count but does not expose a public text-extraction API.

## Decision
Detect signature marker positions using a raw byte scan of the PDF content streams, combined with pdf-lib for page count and page dimension inspection.

Specifically:
1. Decode the raw PDF bytes as latin-1 to produce a string (marker tokens are pure ASCII so they survive this encoding).
2. Split the string on `/Type /Page` dictionary markers to produce approximate per-page text segments.
3. Scan each segment for `[[ROLE]]` patterns using a regular expression.
4. Assign fixed default coordinates (x = 60 pt, y = 120 pt from lower-left, stepping up 60 pt per additional signer on the same page) when a marker is found, rather than extracting exact glyph bounds.

If the page-split heuristic fails (wrong number of `/Type /Page` markers), all text is assigned to page 0 and marker roles are distributed there — a safe fallback since Google Docs exports for this project are always single-page or low page count.

The two required markers (`[[LOCADOR]]`, `[[LOCATARIO]]`) must be present; if either is absent the endpoint returns 422 with a structured error instructing the landlord to verify the template.

## Alternatives Considered

- **Full PDF text extraction with exact glyph coordinates** — requires a native binary or a complex pure-JS PDF renderer. Neither is viable in a Deno Edge Function within the project's constraints (no native binaries, 256 MB memory limit). Rejected.
- **pdf.js** — read-only renderer that supports text extraction, but it targets browser environments and cannot run reliably in Deno Edge Functions without significant polyfilling. Rejected.
- **Hardcoded coordinates per role** — would work if all generated documents from a given template always place signatures on the same page and position. Fragile once templates change. Rejected in favour of marker-based detection.
- **Embed coordinates in the document name or metadata** — would require changes to the document generation flow (issue 10). Out of scope for this issue. Rejected.

## Consequences

- The raw scan approach works reliably for Google Docs exports to PDF because Google's PDF exporter produces uncompressed content streams with ASCII text. It will not work for PDFs with compressed streams, CJK text, or non-standard font encodings — none of which apply to this project's templates.
- Signature placement uses fixed default offsets, not exact marker glyph positions. This means signatures land in a consistent lower-signature-block area but may not align precisely with the visual marker text. Landlords can verify placement in the Autentique signing interface before sending.
- If a future template variation causes the page-split heuristic to fail, all markers are placed on page 1 — a visible but non-breaking degradation the landlord can correct by adjusting the template.
- The detect module (`documents/signatures/detect.ts`) is tested at the unit level; exact coordinate assertions are deferred to integration tests with real Google Docs-exported PDFs.
