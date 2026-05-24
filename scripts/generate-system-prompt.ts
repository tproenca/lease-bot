#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run
//
// generate-system-prompt.ts
//
// Substitutes constants from gpt/config.yaml into gpt/SYSTEM_PROMPT.md,
// validates the result against the character limit, writes the ready-to-upload
// version to gpt/SYSTEM_PROMPT.generated.md, and copies it to the clipboard.
//
// Usage:
//   deno run --allow-read --allow-write --allow-run scripts/generate-system-prompt.ts
//
// Placeholders recognised in SYSTEM_PROMPT.md:
//   {SETUP_URL}       → config.onboarding_url
//   {PROMPT_VERSION}  → config.prompt_version

const CONFIG_PATH = "gpt/config.yaml";
const TEMPLATE_PATH = "gpt/SYSTEM_PROMPT.md";
const OUTPUT_PATH = "gpt/SYSTEM_PROMPT.generated.md";

// ─── Config parser ────────────────────────────────────────────────────────
// Handles simple "key: value" YAML (no nesting, no arrays, # comments).

function parseConfig(yaml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of yaml.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    out[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return out;
}

// ─── Load inputs ──────────────────────────────────────────────────────────

let configText: string;
try {
  configText = await Deno.readTextFile(CONFIG_PATH);
} catch {
  console.error(`ERROR: cannot read ${CONFIG_PATH}`);
  Deno.exit(1);
}

let template: string;
try {
  template = await Deno.readTextFile(TEMPLATE_PATH);
} catch {
  console.error(`ERROR: cannot read ${TEMPLATE_PATH}`);
  Deno.exit(1);
}

const config = parseConfig(configText);
const maxChars = parseInt(config.max_chars ?? "8000", 10);
const setupUrl = config.onboarding_url ?? "";
const promptVersion = config.prompt_version ?? "?";

if (!setupUrl) {
  console.error("ERROR: onboarding_url is missing from gpt/config.yaml");
  Deno.exit(1);
}

// ─── Substitute ───────────────────────────────────────────────────────────

const output = template
  .replaceAll("{SETUP_URL}", setupUrl)
  .replaceAll("{PROMPT_VERSION}", promptVersion);

// ─── Validate ─────────────────────────────────────────────────────────────

const charCount = [...output].length; // Unicode-aware (counts codepoints)
const delta = charCount - maxChars;
const pass = delta <= 0;

console.log("");
console.log(`Prompt version : v${promptVersion}`);
console.log(`Setup URL      : ${setupUrl}`);
console.log("");

if (pass) {
  console.log(`✅  ${charCount} / ${maxChars} chars  (${-delta} remaining)`);
} else {
  console.log(`❌  ${charCount} / ${maxChars} chars  (${delta} over limit)`);
  console.log(`    Trim ${delta} chars from gpt/SYSTEM_PROMPT.md before uploading.`);
}

// ─── Write output file ────────────────────────────────────────────────────

await Deno.writeTextFile(OUTPUT_PATH, output);
console.log(`\nOutput : ${OUTPUT_PATH}`);

// ─── Copy to clipboard ────────────────────────────────────────────────────

try {
  const child = new Deno.Command("pbcopy", { stdin: "piped" }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(output));
  await writer.close();
  await child.status;
  console.log("Copied to clipboard ✓");
} catch {
  console.log("(pbcopy not available — copy from the output file manually)");
}

// ─── Exit code ───────────────────────────────────────────────────────────
// Non-zero exit when over limit so CI can catch it.
if (!pass) Deno.exit(1);
