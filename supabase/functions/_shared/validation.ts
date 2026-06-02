// Input validation helpers used at API boundaries.
//
// WhatsApp Brazilian number rule (per specs/SECURITY.md): E.164 form
// `+55` followed by a 10- or 11-digit national number. We accept the canonical
// form and also tolerate digit-only input that already starts with the 55
// country code (normalized to `+55...`).

// ─── CPF ──────────────────────────────────────────────────────────────────

// CPF format: XXX.XXX.XXX-XX
const CPF_RE = /^\d{3}\.\d{3}\.\d{3}-\d{2}$/;

/**
 * Returns true when `v` is a string that matches the CPF mask XXX.XXX.XXX-XX.
 * Does not perform a mathematical checksum — format validation only.
 */
export function isValidCpf(v: unknown): v is string {
  return typeof v === "string" && CPF_RE.test(v.trim());
}

/**
 * Normalizes a CPF value: trims whitespace. Returns the trimmed string if it
 * passes format validation, otherwise returns null.
 */
export function normalizeCpf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return CPF_RE.test(trimmed) ? trimmed : null;
}

/**
 * Validates CPF check digits using the standard Brazilian algorithm.
 * Input must be exactly 11 digits (no formatting).
 * Returns false for all-same-digit sequences (e.g. "00000000000").
 */
function cpfCheckDigitsValid(digits: string): boolean {
  // All-same-digit CPFs are trivially invalid
  if (/^(\d)\1{10}$/.test(digits)) return false;

  const d = digits.split("").map(Number);

  // First check digit
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += d[i] * (10 - i);
  let rem = (sum * 10) % 11;
  if (rem === 10 || rem === 11) rem = 0;
  if (rem !== d[9]) return false;

  // Second check digit
  sum = 0;
  for (let i = 0; i < 10; i++) sum += d[i] * (11 - i);
  rem = (sum * 10) % 11;
  if (rem === 10 || rem === 11) rem = 0;
  return rem === d[10];
}

/**
 * Accepts a CPF in either formatted (XXX.XXX.XXX-XX) or digit-only form.
 * Strips all non-digit characters, validates length and check digits,
 * and returns the formatted string "XXX.XXX.XXX-XX" on success or null on failure.
 */
export function parseCpfInput(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const digits = v.replace(/\D/g, "");
  if (digits.length !== 11) return null;
  if (!cpfCheckDigitsValid(digits)) return null;
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${
    digits.slice(9)
  }`;
}

// ─── WhatsApp ──────────────────────────────────────────────────────────────

const BR_WHATSAPP_RE = /^\+55\d{10,11}$/;

export function normalizeBrazilianWhatsapp(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const stripped = input.trim().replace(/[\s\-().]/g, "");
  if (!stripped) return null;
  const candidate = stripped.startsWith("+") ? stripped : `+${stripped}`;
  if (!BR_WHATSAPP_RE.test(candidate)) return null;
  return candidate;
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

// Drive folder/file IDs are URL-safe base64-ish strings (letters, digits, -, _).
// We accept anything that looks like a Drive ID; the source of truth is the
// Drive API verification step in /setup/complete.
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,}$/;

export function looksLikeDriveId(v: unknown): v is string {
  return typeof v === "string" && DRIVE_ID_RE.test(v);
}

// Templates folder name: a simple folder name (no slashes other than an
// optional trailing one). We strip the trailing slash before using it.
const TEMPLATES_FOLDER_NAME_RE = /^[^/\\?%*:|"<>]{1,80}\/?$/;

export function normalizeTemplatesFolderName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!TEMPLATES_FOLDER_NAME_RE.test(trimmed)) return null;
  return trimmed.replace(/\/$/, "");
}
