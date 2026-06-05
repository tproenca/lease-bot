// ── Color / dimension helpers ─────────────────────────────────────────────────

function hexRgb(h: string) {
  const c = h.replace("#", "");
  return {
    red: parseInt(c.slice(0, 2), 16) / 255,
    green: parseInt(c.slice(2, 4), 16) / 255,
    blue: parseInt(c.slice(4, 6), 16) / 255,
  };
}

function rgbColor(c: ReturnType<typeof hexRgb>) {
  return { color: { rgbColor: c } };
}

function pt(n: number) {
  return { magnitude: n, unit: "PT" };
}

const TABLE_HEADER_BG = hexRgb("#595959"); // dark grey header
const TABLE_BAND_BG = hexRgb("#F2F2F2"); // light grey zebra rows
const WHITE = hexRgb("#FFFFFF");
const BLACK = hexRgb("#000000");

// ── Markdown parser ───────────────────────────────────────────────────────────

interface InlineRun {
  start: number;
  end: number;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

type Block =
  | { kind: "title"; text: string; runs: InlineRun[] }
  | { kind: "h1"; text: string; runs: InlineRun[] }
  | { kind: "h2"; text: string; runs: InlineRun[] }
  | { kind: "paragraph"; text: string; runs: InlineRun[] }
  | { kind: "list_item"; text: string; runs: InlineRun[]; index: number }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "spacer" }
  | { kind: "blockquote"; text: string; runs: InlineRun[] };

interface Span {
  start: number;
  end: number;
  kind: Block["kind"];
  runs: InlineRun[];
}

function parseInline(s: string): { text: string; runs: InlineRun[] } {
  s = s.trim(); // trim input so run offsets into `text` stay valid
  const runs: InlineRun[] = [];
  let text = "";
  let i = 0;
  while (i < s.length) {
    if (s.startsWith("**", i)) {
      const close = s.indexOf("**", i + 2);
      if (close !== -1) {
        const start = text.length;
        text += s.slice(i + 2, close);
        runs.push({ start, end: text.length, bold: true });
        i = close + 2;
        continue;
      }
    }
    if (s[i] === "`") {
      const close = s.indexOf("`", i + 1);
      if (close !== -1) {
        const start = text.length;
        text += s.slice(i + 1, close);
        runs.push({ start, end: text.length, code: true });
        i = close + 1;
        continue;
      }
    }
    if (s[i] === "*" && !s.startsWith("**", i)) {
      const close = s.indexOf("*", i + 1);
      if (close !== -1) {
        const start = text.length;
        text += s.slice(i + 1, close);
        runs.push({ start, end: text.length, italic: true });
        i = close + 1;
        continue;
      }
    }
    if (s[i] === "[") {
      const textEnd = s.indexOf("]", i);
      if (textEnd !== -1 && s[textEnd + 1] === "(") {
        const urlEnd = s.indexOf(")", textEnd + 2);
        if (urlEnd !== -1) {
          text += s.slice(i + 1, textEnd);
          i = urlEnd + 1;
          continue;
        }
      }
    }
    text += s[i];
    i++;
  }
  return { text, runs };
}

function stripInline(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")
    .trim();
}

function parseTableRow(row: string): string[] {
  return row.split("|").slice(1, -1).map((c) => stripInline(c.trim()));
}

export function parseMarkdown(md: string): Block[] {
  const lines = md.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("# ")) {
      const { text, runs } = parseInline(line.slice(2));
      blocks.push({ kind: "title", text, runs });
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      const { text, runs } = parseInline(line.slice(3));
      blocks.push({ kind: "h1", text, runs });
      i++;
      continue;
    }
    if (line.startsWith("### ")) {
      const { text, runs } = parseInline(line.slice(4));
      blocks.push({ kind: "h2", text, runs });
      i++;
      continue;
    }
    if (line.startsWith("> ")) {
      const { text, runs } = parseInline(line.slice(2));
      blocks.push({ kind: "blockquote", text, runs });
      i++;
      continue;
    }
    if (line.startsWith("|")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      const [headerLine, , ...dataLines] = tableLines;
      blocks.push({
        kind: "table",
        headers: parseTableRow(headerLine),
        rows: dataLines.map(parseTableRow),
      });
      continue;
    }
    const olMatch = line.match(/^(\d+)\. (.+)/);
    if (olMatch) {
      const { text, runs } = parseInline(olMatch[2]);
      blocks.push({
        kind: "list_item",
        text,
        runs,
        index: parseInt(olMatch[1]),
      });
      i++;
      continue;
    }
    if (line.trim() === "") {
      let count = 0;
      while (i < lines.length && lines[i].trim() === "") {
        i++;
        count++;
      }
      if (count >= 2) blocks.push({ kind: "spacer" });
      continue;
    }
    const { text, runs } = parseInline(line);
    blocks.push({ kind: "paragraph", text, runs });
    i++;
  }
  return blocks;
}

// ── Docs API helpers ──────────────────────────────────────────────────────────

type AuthHeaders = {
  headers: { Authorization: string; "Content-Type": string };
};

type DocContent = {
  body: {
    content: Array<{
      table?: {
        tableRows: Array<{
          tableCells: Array<{
            content: Array<{
              startIndex: number;
              endIndex: number;
              paragraph: {
                elements: Array<{ startIndex: number; endIndex: number }>;
              };
            }>;
          }>;
        }>;
        startIndex: number;
      };
      paragraph?: {
        elements: Array<
          {
            textRun?: { content: string };
            startIndex: number;
            endIndex: number;
          }
        >;
      };
      startIndex: number;
      endIndex: number;
    }>;
  };
};

async function docsGet(docId: string, auth: AuthHeaders): Promise<DocContent> {
  const r = await fetch(
    `https://docs.googleapis.com/v1/documents/${docId}`,
    auth,
  );
  if (!r.ok) throw new Error(`docs_get_failed_${r.status}: ${await r.text()}`);
  return r.json();
}

async function docsBatch(
  docId: string,
  auth: AuthHeaders,
  requests: unknown[],
): Promise<void> {
  const r = await fetch(
    `https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`,
    {
      method: "POST",
      ...auth,
      body: JSON.stringify({ requests }),
    },
  );
  if (!r.ok) {
    throw new Error(`docs_batchUpdate_failed_${r.status}: ${await r.text()}`);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Clears a Google Doc and rewrites it from markdown content, applying the
 * style defined in docs/docs-style.md.
 */
export async function applyDocStyle(
  docId: string,
  accessToken: string,
  mdContent: string,
): Promise<void> {
  const auth: AuthHeaders = {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  };

  // 1. Clear existing content
  const before = await docsGet(docId, auth);
  const endIdx = before.body.content[before.body.content.length - 1].endIndex;
  if (endIdx > 2) {
    await docsBatch(docId, auth, [{
      deleteContentRange: { range: { startIndex: 1, endIndex: endIdx - 1 } },
    }]);
  }

  // 2. Insert text + tables interleaved (tables in their natural position)
  const blocks = parseMarkdown(mdContent);
  const spans: Span[] = [];
  let pos = 1;
  let textBatch: unknown[] = [];

  async function flushText(): Promise<void> {
    if (textBatch.length === 0) return;
    await docsBatch(docId, auth, textBatch);
    textBatch = [];
  }

  for (const block of blocks) {
    if (block.kind === "spacer") {
      textBatch.push({ insertText: { location: { index: pos }, text: "\n" } });
      spans.push({ start: pos, end: pos + 1, kind: "spacer", runs: [] });
      pos += 1;
      continue;
    }
    if (block.kind !== "table") {
      const content = block.text + "\n";
      textBatch.push({
        insertText: { location: { index: pos }, text: content },
      });
      spans.push({
        start: pos,
        end: pos + content.length,
        kind: block.kind,
        runs: block.runs,
      });
      pos += content.length;
      continue;
    }

    await flushText();

    await docsBatch(docId, auth, [{
      insertTable: {
        rows: 1 + block.rows.length,
        columns: block.headers.length,
        location: { index: pos },
      },
    }]);

    const snap = await docsGet(docId, auth);
    const tblEntry = snap.body.content.find((b) =>
      b.table && b.startIndex >= pos
    );
    if (tblEntry?.table) {
      const allRows = [block.headers, ...block.rows];
      const cellInserts: unknown[] = [];
      for (let ri = 0; ri < allRows.length; ri++) {
        for (let ci = 0; ci < allRows[ri].length; ci++) {
          const cell = tblEntry.table.tableRows[ri]?.tableCells[ci];
          if (!cell) continue;
          const cellStart = cell.content[0]?.paragraph.elements[0]?.startIndex;
          if (cellStart != null) {
            cellInserts.push({
              insertText: {
                location: { index: cellStart },
                text: allRows[ri][ci],
              },
            });
          }
        }
      }
      cellInserts.sort((a, b) => {
        const idx = (r: unknown) =>
          (r as { insertText: { location: { index: number } } }).insertText
            .location.index;
        return idx(b) - idx(a);
      });
      if (cellInserts.length > 0) await docsBatch(docId, auth, cellInserts);
    }

    // Re-read after cell inserts so pos reflects the true document end including
    // all cell content. This means consecutive tables (no text between them)
    // correctly target the position after the fully-populated first table.
    const snapAfter = await docsGet(docId, auth);
    pos = snapAfter.body.content[snapAfter.body.content.length - 1].endIndex -
      1;
  }

  await flushText();

  // 3. Apply paragraph + table styling
  const docFinal = await docsGet(docId, auth);
  const styleRequests: unknown[] = [];

  // Paragraph styling: named styles, blockquotes, spacers.
  // Spacing around blockquotes is applied to the adjacent paragraphs (not the
  // blockquote itself) so the shading doesn't swallow the gap.
  const paraBlocks = docFinal.body.content.filter((b) => b.paragraph);
  for (let bi = 0; bi < paraBlocks.length; bi++) {
    const block = paraBlocks[bi];
    const s = block.startIndex;
    const e = block.endIndex;
    const span = spans.find((sp) => sp.start === s);
    if (!span) continue;

    const prevSpan = bi > 0
      ? spans.find((sp) => sp.start === paraBlocks[bi - 1].startIndex)
      : null;
    const nextSpan = bi < paraBlocks.length - 1
      ? spans.find((sp) => sp.start === paraBlocks[bi + 1].startIndex)
      : null;

    const namedStyle = span.kind === "title"
      ? "TITLE"
      : span.kind === "h1"
      ? "HEADING_1"
      : span.kind === "h2"
      ? "HEADING_2"
      : null;

    if (namedStyle) {
      styleRequests.push({
        updateParagraphStyle: {
          range: { startIndex: s, endIndex: e },
          paragraphStyle: { namedStyleType: namedStyle },
          fields: "namedStyleType",
        },
      });
    } else if (span.kind === "blockquote") {
      styleRequests.push({
        updateParagraphStyle: {
          range: { startIndex: s, endIndex: e },
          paragraphStyle: {
            borderLeft: {
              color: rgbColor(hexRgb("#595959")),
              width: pt(3),
              padding: pt(8),
              dashStyle: "SOLID",
            },
            shading: { backgroundColor: rgbColor(hexRgb("#F5F5F5")) },
            indentStart: pt(16),
          },
          fields: "borderLeft,shading,indentStart",
        },
      });
    } else if (span.kind === "spacer") {
      styleRequests.push({
        updateParagraphStyle: {
          range: { startIndex: s, endIndex: e },
          paragraphStyle: { spaceAbove: pt(36) },
          fields: "spaceAbove",
        },
      });
    }

    // Push spacing onto neighbours so shading doesn't swallow the gap.
    const extraFields: string[] = [];
    const extra: Record<string, unknown> = {};
    if (nextSpan?.kind === "blockquote") {
      extra.spaceBelow = pt(10);
      extraFields.push("spaceBelow");
    }
    if (prevSpan?.kind === "blockquote") {
      extra.spaceAbove = pt(10);
      extraFields.push("spaceAbove");
    }
    if (extraFields.length > 0) {
      styleRequests.push({
        updateParagraphStyle: {
          range: { startIndex: s, endIndex: e },
          paragraphStyle: extra,
          fields: extraFields.join(","),
        },
      });
    }
  }

  // Tables
  const border = (color: ReturnType<typeof hexRgb>) => ({
    color: rgbColor(color),
    width: pt(1),
    dashStyle: "SOLID",
  });

  for (const tblBlock of docFinal.body.content.filter((b) => b.table)) {
    const tbl = tblBlock.table!;
    const totalRows = tbl.tableRows.length;
    const totalCols = tbl.tableRows[0]?.tableCells.length ?? 0;

    styleRequests.push({
      updateTableCellStyle: {
        tableRange: {
          tableCellLocation: {
            tableStartLocation: { index: tblBlock.startIndex },
            rowIndex: 0,
            columnIndex: 0,
          },
          rowSpan: totalRows,
          columnSpan: totalCols,
        },
        tableCellStyle: {
          borderLeft: border(BLACK),
          borderRight: border(BLACK),
          borderTop: border(BLACK),
          borderBottom: border(BLACK),
        },
        fields: "borderLeft,borderRight,borderTop,borderBottom",
      },
    });

    for (let ri = 0; ri < tbl.tableRows.length; ri++) {
      const isHeader = ri === 0;
      const isBand = ri % 2 === 0 && !isHeader;
      for (let ci = 0; ci < tbl.tableRows[ri].tableCells.length; ci++) {
        const cell = tbl.tableRows[ri].tableCells[ci];
        for (const cellBlock of cell.content) {
          if (isHeader) {
            styleRequests.push({
              updateTextStyle: {
                range: {
                  startIndex: cellBlock.startIndex,
                  endIndex: cellBlock.endIndex,
                },
                textStyle: { bold: true, foregroundColor: rgbColor(WHITE) },
                fields: "bold,foregroundColor",
              },
            });
          }
        }
        if (isHeader || isBand) {
          styleRequests.push({
            updateTableCellStyle: {
              tableRange: {
                tableCellLocation: {
                  tableStartLocation: { index: tblBlock.startIndex },
                  rowIndex: ri,
                  columnIndex: ci,
                },
                rowSpan: 1,
                columnSpan: 1,
              },
              tableCellStyle: {
                backgroundColor: rgbColor(
                  isHeader ? TABLE_HEADER_BG : TABLE_BAND_BG,
                ),
              },
              fields: "backgroundColor",
            },
          });
        }
      }
    }
  }

  if (styleRequests.length > 0) await docsBatch(docId, auth, styleRequests);

  // 4. Inline formatting (bold / italic / code)
  const inlineRequests: unknown[] = [];
  for (const span of spans) {
    for (const run of span.runs) {
      const runStart = span.start + run.start;
      const runEnd = span.start + run.end;
      if (runStart >= runEnd) continue;
      const textStyle: Record<string, unknown> = {};
      const fields: string[] = [];
      if (run.bold) {
        textStyle.bold = true;
        fields.push("bold");
      }
      if (run.italic) {
        textStyle.italic = true;
        fields.push("italic");
      }
      if (run.code) {
        textStyle.weightedFontFamily = { fontFamily: "Courier New" };
        textStyle.fontSize = pt(10);
        fields.push("weightedFontFamily", "fontSize");
      }
      if (fields.length > 0) {
        inlineRequests.push({
          updateTextStyle: {
            range: { startIndex: runStart, endIndex: runEnd },
            textStyle,
            fields: fields.join(","),
          },
        });
      }
    }
  }
  if (inlineRequests.length > 0) await docsBatch(docId, auth, inlineRequests);
}
