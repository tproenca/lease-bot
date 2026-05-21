// unit: _shared/docs-style.ts — parseMarkdown
//
// Pure unit tests for the markdown parser. No network calls, no mocks.
// Each test exercises a specific block kind or inline formatting rule.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseMarkdown } from "./docs-style.ts";

// ─── Block kinds ──────────────────────────────────────────────────────────────

Deno.test("unit: parseMarkdown — # prefix produces title block", () => {
  const blocks = parseMarkdown("# My Title");
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].kind, "title");
  assertEquals((blocks[0] as { kind: string; text: string }).text, "My Title");
});

Deno.test("unit: parseMarkdown — ## prefix produces h1 block", () => {
  const blocks = parseMarkdown("## Section");
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].kind, "h1");
  assertEquals((blocks[0] as { kind: string; text: string }).text, "Section");
});

Deno.test("unit: parseMarkdown — ### prefix produces h2 block", () => {
  const blocks = parseMarkdown("### Subsection");
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].kind, "h2");
  assertEquals(
    (blocks[0] as { kind: string; text: string }).text,
    "Subsection",
  );
});

Deno.test("unit: parseMarkdown — > prefix produces blockquote block", () => {
  const blocks = parseMarkdown("> This is a note.");
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].kind, "blockquote");
  assertEquals(
    (blocks[0] as { kind: string; text: string }).text,
    "This is a note.",
  );
});

Deno.test("unit: parseMarkdown — plain line produces paragraph block", () => {
  const blocks = parseMarkdown("Just a paragraph.");
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].kind, "paragraph");
  assertEquals(
    (blocks[0] as { kind: string; text: string }).text,
    "Just a paragraph.",
  );
});

Deno.test("unit: parseMarkdown — numbered line produces list_item block", () => {
  const blocks = parseMarkdown("1. First item");
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].kind, "list_item");
  const item = blocks[0] as { kind: string; text: string; index: number };
  assertEquals(item.text, "First item");
  assertEquals(item.index, 1);
});

// ─── Spacer threshold ─────────────────────────────────────────────────────────

Deno.test("unit: parseMarkdown — single blank line does not produce spacer", () => {
  const blocks = parseMarkdown("First\n\nSecond");
  assertEquals(blocks.length, 2);
  assertEquals(blocks.every((b) => b.kind !== "spacer"), true);
});

Deno.test("unit: parseMarkdown — two blank lines produce spacer block", () => {
  const blocks = parseMarkdown("First\n\n\nSecond");
  assertEquals(blocks.length, 3);
  assertEquals(blocks[1].kind, "spacer");
});

Deno.test("unit: parseMarkdown — three blank lines also produce one spacer block", () => {
  const blocks = parseMarkdown("First\n\n\n\nSecond");
  assertEquals(blocks.length, 3);
  assertEquals(blocks[1].kind, "spacer");
});

// ─── Table ────────────────────────────────────────────────────────────────────

Deno.test("unit: parseMarkdown — pipe-delimited block produces table block", () => {
  const md = [
    "| Name | Format |",
    "| ---- | ------ |",
    "| nome | text   |",
    "| data | date   |",
  ].join("\n");
  const blocks = parseMarkdown(md);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].kind, "table");
  const tbl = blocks[0] as {
    kind: string;
    headers: string[];
    rows: string[][];
  };
  assertEquals(tbl.headers, ["Name", "Format"]);
  assertEquals(tbl.rows.length, 2);
  assertEquals(tbl.rows[0], ["nome", "text"]);
  assertEquals(tbl.rows[1], ["data", "date"]);
});

Deno.test("unit: parseMarkdown — table separator row is excluded from rows", () => {
  const md = "| A | B |\n| - | - |\n| 1 | 2 |";
  const blocks = parseMarkdown(md);
  const tbl = blocks[0] as { rows: string[][] };
  assertEquals(tbl.rows.length, 1);
});

// ─── Inline formatting ────────────────────────────────────────────────────────

Deno.test("unit: parseMarkdown — **text** produces bold run", () => {
  const blocks = parseMarkdown("Hello **world**.");
  const para = blocks[0] as {
    kind: string;
    text: string;
    runs: Array<{ bold?: boolean; start: number; end: number }>;
  };
  assertEquals(para.kind, "paragraph");
  assertEquals(para.text, "Hello world.");
  const boldRun = para.runs.find((r) => r.bold);
  assertEquals(boldRun !== undefined, true);
  assertEquals(para.text.slice(boldRun!.start, boldRun!.end), "world");
});

Deno.test("unit: parseMarkdown — `code` produces code run", () => {
  const blocks = parseMarkdown("Use `{{nome}}` here.");
  const para = blocks[0] as {
    text: string;
    runs: Array<{ code?: boolean; start: number; end: number }>;
  };
  assertEquals(para.text, "Use {{nome}} here.");
  const codeRun = para.runs.find((r) => r.code);
  assertEquals(codeRun !== undefined, true);
  assertEquals(para.text.slice(codeRun!.start, codeRun!.end), "{{nome}}");
});

Deno.test("unit: parseMarkdown — *text* produces italic run", () => {
  const blocks = parseMarkdown("Some *emphasis* here.");
  const para = blocks[0] as {
    text: string;
    runs: Array<{ italic?: boolean; start: number; end: number }>;
  };
  assertEquals(para.text, "Some emphasis here.");
  const italicRun = para.runs.find((r) => r.italic);
  assertEquals(italicRun !== undefined, true);
  assertEquals(para.text.slice(italicRun!.start, italicRun!.end), "emphasis");
});

Deno.test("unit: parseMarkdown — [text](url) strips URL and keeps text", () => {
  const blocks = parseMarkdown("See [the docs](https://example.com) for more.");
  const para = blocks[0] as { text: string };
  assertEquals(para.text, "See the docs for more.");
});

Deno.test("unit: parseMarkdown — multiple inline runs in one paragraph", () => {
  const blocks = parseMarkdown("**Bold** and `code` together.");
  const para = blocks[0] as {
    text: string;
    runs: Array<{ bold?: boolean; code?: boolean }>;
  };
  assertEquals(para.text, "Bold and code together.");
  assertEquals(para.runs.some((r) => r.bold), true);
  assertEquals(para.runs.some((r) => r.code), true);
});

// ─── Mixed document ───────────────────────────────────────────────────────────

Deno.test("unit: parseMarkdown — mixed document produces correct block sequence", () => {
  const md = [
    "# Title",
    "## Section",
    "> A note",
    "",
    "A paragraph.",
    "",
    "",
    "After spacer.",
  ].join("\n");
  const blocks = parseMarkdown(md);
  const kinds = blocks.map((b) => b.kind);
  assertEquals(kinds, [
    "title",
    "h1",
    "blockquote",
    "paragraph",
    "spacer",
    "paragraph",
  ]);
});
