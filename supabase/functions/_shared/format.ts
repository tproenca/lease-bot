// Document substitution helpers — pure string transforms shared by the
// document-generation engine. No IO; safe to unit-test in isolation.

// ─── Case transformation ──────────────────────────────────────────────────

/**
 * Apply the placeholder's `case` transformation to a string value.
 *
 * Supported values (from specs/DESIGN.md):
 *   maiúsculas — UPPERCASE
 *   minúsculas — lowercase
 *   título     — Title Case (first letter of each word capitalised)
 *   frase      — Sentence case (first letter of the whole string capitalised)
 *
 * If `caseTransform` is null/undefined, the value is returned unchanged.
 */
export function applyCase(
  value: string,
  caseTransform: string | null | undefined,
): string {
  if (!caseTransform) return value;
  switch (caseTransform) {
    case "maiúsculas":
      return value.toUpperCase();
    case "minúsculas":
      return value.toLowerCase();
    case "título":
      // Title Case: capitalise first letter of each whitespace-separated word.
      return value.replace(
        /\S+/g,
        (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
      );
    case "frase":
      // Sentence case: capitalise first letter of the entire string.
      return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
    default:
      return value;
  }
}

// ─── Substitution engine ──────────────────────────────────────────────────

/**
 * Replace all {{name}} tokens in `content` using the provided map of name →
 * transformed value. Tokens that do not appear in the map are left unchanged
 * (the caller has already validated completeness).
 */
export function substituteTokens(
  content: string,
  values: Map<string, string>,
): string {
  // Replace each occurrence of {{name}} (case-sensitive match) with its value.
  return content.replace(/\{\{([^}]+)\}\}/g, (_match, name: string) => {
    const val = values.get(name.trim());
    return val !== undefined ? val : `{{${name}}}`;
  });
}
