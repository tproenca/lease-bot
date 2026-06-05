#!/usr/bin/env -S deno run --allow-read --allow-write
//
// generate-shared.ts — Generates TypeScript constants from docs/*.md sources.
//
// Run before starting Supabase locally or as a CI step before deploy:
//   deno run --allow-read --allow-write scripts/generate-shared.ts
//
// Outputs (committed to git — diffs show what changed):
//   supabase/functions/_shared/placeholder-guide-content.ts
//   supabase/functions/_shared/placeholder-list-content.ts
//   supabase/functions/_shared/sample-contract-content.ts

const HEADER = (src: string) =>
  `// GENERATED — do not edit directly.\n// Source: ${src}\n// Run: deno run --allow-read --allow-write scripts/generate-shared.ts\n\n`;

function emitContent(src: string, exportName: string, md: string): string {
  const escaped = md.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(
    /\$\{/g,
    "\\${",
  );
  return `${HEADER(src)}export const ${exportName} = \`${escaped}\`;\n`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const placeholderGuideMd = await Deno.readTextFile("docs/placeholder-guide.md");
const placeholderListMd = await Deno.readTextFile("docs/placeholder-list.md");
const sampleContractMd = await Deno.readTextFile("docs/sample-contract.md");

await Deno.writeTextFile(
  "supabase/functions/_shared/placeholder-guide-content.ts",
  emitContent(
    "docs/placeholder-guide.md",
    "PLACEHOLDER_GUIDE_CONTENT",
    placeholderGuideMd,
  ),
);
console.log("✓ _shared/placeholder-guide-content.ts");

await Deno.writeTextFile(
  "supabase/functions/_shared/placeholder-list-content.ts",
  emitContent(
    "docs/placeholder-list.md",
    "PLACEHOLDER_LIST_TEMPLATE",
    placeholderListMd,
  ),
);
console.log("✓ _shared/placeholder-list-content.ts");

await Deno.writeTextFile(
  "supabase/functions/_shared/sample-contract-content.ts",
  emitContent(
    "docs/sample-contract.md",
    "SAMPLE_CONTRACT_CONTENT",
    sampleContractMd,
  ),
);
console.log("✓ _shared/sample-contract-content.ts");
