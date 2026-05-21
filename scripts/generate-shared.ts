#!/usr/bin/env -S deno run --allow-read --allow-write
//
// generate-shared.ts — Generates TypeScript constants from docs/*.md sources.
//
// Run before starting Supabase locally or as a CI step before deploy:
//   deno run --allow-read --allow-write scripts/generate-shared.ts
//
// Outputs (committed to git — diffs show what changed):
//   supabase/functions/_shared/docs-style-constants.ts
//   supabase/functions/_shared/placeholder-guide-content.ts

const HEADER = (src: string) =>
  `// GENERATED — do not edit directly.\n// Source: ${src}\n// Run: deno run --allow-read --allow-write scripts/generate-shared.ts\n\n`;

// ── Style guide parser ────────────────────────────────────────────────────────

function firstHex(s: string, fallback: string): string {
  return s.match(/`?(#[0-9A-Fa-f]{6})`?/)?.[1] ?? fallback;
}

function firstPt(s: string, fallback: number): number {
  const m = s.match(/(\d+(?:\.\d+)?)\s*pt/i);
  return m ? parseFloat(m[1]) : fallback;
}

function tableSection(md: string, heading: string): Record<string, string>[] {
  const idx = md.indexOf(heading);
  if (idx === -1) return [];
  const lines = md.slice(idx).split("\n");
  const start = lines.findIndex((l) => l.startsWith("|"));
  if (start === -1) return [];
  const rows: string[] = [];
  for (let i = start; i < lines.length && lines[i].startsWith("|"); i++) rows.push(lines[i]);
  const headers = rows[0].split("|").slice(1, -1).map((h) => h.trim());
  return rows.slice(2).map((row) => {
    const cells = row.split("|").slice(1, -1).map((c) => c.trim());
    return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""]));
  });
}

function prop(md: string, heading: string, property: string): string {
  const rows = tableSection(md, heading);
  const row = rows.find((r) => Object.values(r)[0]?.toLowerCase() === property.toLowerCase());
  return row?.[Object.keys(rows[0] ?? {})[1] ?? ""] ?? "";
}

function parseStyleGuide(md: string) {
  const bodyFont = prop(md, "## 2.", "Font") || "Calibri";
  const bodySize = firstPt(prop(md, "## 2.", "Size"), 11);

  const headings = tableSection(md, "## 3.");
  function headingCfg(name: string, sizeDef: number, colorDef: string, spaceDef: number) {
    const row = headings.find((r) => r["Style"]?.toLowerCase() === name.toLowerCase()) ?? {};
    return {
      size: firstPt(row["Size"] ?? "", sizeDef),
      bold: (row["Weight"] ?? "").includes("bold"),
      color: firstHex(row["Color"] ?? "", colorDef),
      spaceAbove: firstPt(row["Space Before"] ?? "", spaceDef),
    };
  }

  const headerRowVal = prop(md, "7b.", "Header row (firstRow)");
  const bandRowVal = prop(md, "7c.", "Alternating rows (band1Horz)");

  // "fill `#4F81BD`" — extract the hex that follows the word "fill"
  const tableHeaderFill = headerRowVal.match(/fill[^#]*(#[0-9A-Fa-f]{6})/i)?.[1] ?? "#4F81BD";
  // white text is always the first hex in the header row value
  const tableHeaderText = firstHex(headerRowVal, "#FFFFFF");

  return {
    bodyFont,
    bodySize,
    title: headingCfg("Title", 26, "#17365D", 0),
    h1: headingCfg("Heading 1", 14, "#365F91", 24),
    h2: headingCfg("Heading 2", 13, "#4F81BD", 10),
    tableHeaderFill,
    tableHeaderText,
    tableBandFill: firstHex(bandRowVal, "#D3DFEE"),
  };
}

function emitStyleConstants(style: ReturnType<typeof parseStyleGuide>): string {
  const s = JSON.stringify;
  return [
    HEADER("docs/docs-style.md"),
    `export const STYLE = {`,
    `  bodyFont: ${s(style.bodyFont)},`,
    `  bodySize: ${style.bodySize},`,
    `  title:    { size: ${style.title.size}, bold: ${style.title.bold}, color: ${s(style.title.color)}, spaceAbove: ${style.title.spaceAbove} },`,
    `  h1:       { size: ${style.h1.size}, bold: ${style.h1.bold}, color: ${s(style.h1.color)}, spaceAbove: ${style.h1.spaceAbove} },`,
    `  h2:       { size: ${style.h2.size}, bold: ${style.h2.bold}, color: ${s(style.h2.color)}, spaceAbove: ${style.h2.spaceAbove} },`,
    `  tableHeaderFill: ${s(style.tableHeaderFill)},`,
    `  tableHeaderText: ${s(style.tableHeaderText)},`,
    `  tableBandFill:   ${s(style.tableBandFill)},`,
    `} as const;`,
    "",
  ].join("\n");
}

function emitContent(src: string, exportName: string, md: string): string {
  const escaped = md.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  return `${HEADER(src)}export const ${exportName} = \`${escaped}\`;\n`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const styleGuideMd = await Deno.readTextFile("docs/docs-style.md");
const placeholderGuideMd = await Deno.readTextFile("docs/placeholder-guide.md");
const placeholderListMd = await Deno.readTextFile("docs/placeholder-list.md");
const sampleContractMd = await Deno.readTextFile("docs/sample-contract.md");

const style = parseStyleGuide(styleGuideMd);

await Deno.writeTextFile(
  "supabase/functions/_shared/docs-style-constants.ts",
  emitStyleConstants(style),
);
console.log("✓ _shared/docs-style-constants.ts");

await Deno.writeTextFile(
  "supabase/functions/_shared/placeholder-guide-content.ts",
  emitContent("docs/placeholder-guide.md", "PLACEHOLDER_GUIDE_CONTENT", placeholderGuideMd),
);
console.log("✓ _shared/placeholder-guide-content.ts");

await Deno.writeTextFile(
  "supabase/functions/_shared/placeholder-list-content.ts",
  emitContent("docs/placeholder-list.md", "PLACEHOLDER_LIST_TEMPLATE", placeholderListMd),
);
console.log("✓ _shared/placeholder-list-content.ts");

await Deno.writeTextFile(
  "supabase/functions/_shared/sample-contract-content.ts",
  emitContent("docs/sample-contract.md", "SAMPLE_CONTRACT_CONTENT", sampleContractMd),
);
console.log("✓ _shared/sample-contract-content.ts");
