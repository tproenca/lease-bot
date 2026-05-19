# ADR-0011: pdf-lib for PDF Merge in Edge Functions
Date: 2026-05-19
Status: Accepted

## Context
The documents/export Edge Function must merge multiple Google Docs — each exported as a separate PDF — into a single ordered bundle and return it to the caller. This merge must happen inside a Deno Edge Function, which prohibits native binaries or OS-level tooling. pdf-lib was already identified as the chosen library in specs/ARCHITECTURE.md.

## Decision
Use pdf-lib@1.17.1 (already declared in deno.json) for all PDF merging operations and for page count validation inside the documents/export Edge Function.

## Alternatives Considered
- **pdfcpu**: written in Go; cannot run inside a Deno runtime without a native binary, so it is not a viable option.
- **pdf.js**: read-only renderer; provides no API to merge or write PDF documents.
- **jsPDF**: designed for client-side PDF generation from scratch; cannot merge existing PDF byte streams.

## Consequences
- pdf-lib is a pure-JavaScript/TypeScript library and runs in Deno without any native binary dependencies.
- Bundle size increase is acceptable and stays well within the 256 MB Edge Function limit.
- Page count validation against the merged document is reliable using pdf-lib's built-in page introspection API.
