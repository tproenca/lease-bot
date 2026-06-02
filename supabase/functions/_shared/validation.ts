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
