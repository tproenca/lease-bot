# ADR-0012: PDF Content Stream Parsing for Signature Position Detection
Date: 2026-05-19
Status: Accepted

## Context

Issue #12 requires scanning the last page of a merged PDF for signature blocks
(underscore lines + role labels) and returning Autentique-compatible coordinates
for each signer. The implementation must use `pdf-lib` (the library already in
`deno.json`) and accept raw `Uint8Array` PDF bytes.

`pdf-lib` is a PDF _writer and merger_, not a PDF text extractor. Its public API
provides no method to read back the text content or coordinates of elements on a
page. Three approaches were considered:

1. **Parse the raw PDF bytes directly** — walk the raw binary, find content
   stream objects, decompress and parse PDF content-stream operators.
2. **Use a separate text-extraction library** — add `pdf-parse`, `pdfjs-dist`,
   or similar.
3. **Use a coordinate-estimation heuristic** — infer y-positions from page
   height and a known page layout template, without reading any content.

## Decision

Use approach (1): access `pdf-lib`'s internal APIs to retrieve the page content
stream bytes, decompress them with Deno's built-in `DecompressionStream`, and
parse the subset of PDF content-stream operators needed for text positioning.

**Specific internal APIs used:**
- `(page as any).node.Contents()` — returns the page's `Contents` entry
  (a `PDFArray` of stream refs) from the page dict.
- `(doc as any).context.lookup(ref)` — resolves a `PDFRef` to the actual stream
  object via the document context.
- `stream.getContents()` — returns raw (compressed) stream bytes as a
  `Uint8Array`.

These are minified internal properties of pdf-lib 1.17.1 (the version pinned in
`deno.json`). To guard against breakage the version is pinned to the exact patch
(`pdf-lib@1.17.1`), and the internal access is isolated in one function
(`getPageContentStream`) with a try/catch fallback that returns an empty string,
ensuring the module degrades gracefully to the `ok: false` fallback instead of
throwing.

**Decompression:** `pdf-lib` compresses content streams with zlib (FlateDecode
filter). `DecompressionStream("deflate")` in Deno's built-in Compression Streams
API handles zlib-wrapped deflate (CMF byte `0x78`). A magic-byte check
(`(byte[0] & 0x0F) === 8`) is performed before attempting decompression so
uncompressed streams pass through unchanged.

**Content-stream parsing:** only the operators needed for text position and
content are parsed: `BT`, `ET`, `Tm`, `Td`, `TD`, `T*`, `Tf`, `TL`, `Tj`,
`TJ`. The tokeniser handles both parenthesis-delimited string literals `(…)` and
angle-bracket hex string literals `<hex>` — the latter is what pdf-lib produces
when writing text via its `drawText` API.

## Alternatives Considered

**Adding a text-extraction library (pdf-parse / pdfjs-dist):**
- `pdf-parse` is a Node.js library and not compatible with Deno's ESM import
  model without a shim.
- `pdfjs-dist` is large (~3 MB bundled), adds significant cold-start latency to
  Edge Functions, and pulls in canvas/DOM polyfills that are unnecessary for
  text-coordinate extraction.
- Both would require a new entry in `deno.json` and expand the dependency
  surface of a security-sensitive codebase.

**Coordinate-estimation heuristic:**
- Our lease PDF templates are generated from Google Docs via different landlord-
  authored templates, so the exact page layout and y-position of signature blocks
  varies. A hardcoded estimate would be fragile and would silently return wrong
  coordinates instead of a clear `ok: false` fallback.

**Raw PDF byte walking without pdf-lib:**
- Duplicates pdf-lib's PDF object model and cross-reference parsing. Maintains
  two PDF parsers in the codebase. Rejected.

## Consequences

- The implementation depends on pdf-lib internal APIs that could change if the
  dependency is upgraded beyond `1.17.1`. Mitigation: exact version pin.
- If a future upgrade is needed, `getPageContentStream` is the only function
  that uses internal APIs; isolating the breakage surface to one function means
  the rest of the detection logic is stable.
- No new dependency is added. The module is self-contained and pure (no I/O,
  no network).
- The `ok: false` fallback path is covered by tests and returns a user-friendly
  Portuguese message instructing the landlord to position signers manually in
  Autentique if detection fails for any reason (including internal API breakage).
