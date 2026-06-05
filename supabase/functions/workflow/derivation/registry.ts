// Closed formula registry.
//
// Each entry in FORMULA_REGISTRY declares:
//   - arity: expected number of arguments
//   - fn: the deterministic implementation
//
// Supported formulas: amount_in_words, full_date_text, end_date.
//
// CPF formatting is handled via the placeholder `format: "cpf"` field applied at
// render time, not through a registry formula. Use `derived_formula: "tenant.cpf"`
// (a bare context path) combined with `format: "cpf"` on the placeholder instead.
//
// `identity` is not registered because a bare token (`tenant.name`) already covers
// the passthrough case — the function call form adds no value.
//
// Adding a new formula requires a code change and a new ADR (ADR-0016, ADR-0017).

// ─── Types ────────────────────────────────────────────────────────────────────

export type FormulaSpec = {
  /** Expected number of arguments. */
  arity: number;
  /**
   * Deterministic formula implementation.
   * All args are pre-resolved string values.
   * Returns the output string.
   */
  fn: (...args: string[]) => string;
};

// ─── Helper: Portuguese month names ──────────────────────────────────────────

const PT_MONTHS = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

// ─── Helper: Portuguese extenso (amount_in_words) ────────────────────────────
//
// Deterministic conversion of a numeric amount (R$) to Portuguese extenso.
// Handles: 0, integers, decimals (centavos), up to hundreds of billions.
// Gender: "real" (singular), "reais" (plural).
// Centavos: "centavo" (singular), "centavos" (plural).

const UNITS = [
  "",
  "um",
  "dois",
  "três",
  "quatro",
  "cinco",
  "seis",
  "sete",
  "oito",
  "nove",
  "dez",
  "onze",
  "doze",
  "treze",
  "quatorze",
  "quinze",
  "dezesseis",
  "dezessete",
  "dezoito",
  "dezenove",
];

const TENS = [
  "",
  "",
  "vinte",
  "trinta",
  "quarenta",
  "cinquenta",
  "sessenta",
  "setenta",
  "oitenta",
  "noventa",
];

const HUNDREDS = [
  "",
  "cento",
  "duzentos",
  "trezentos",
  "quatrocentos",
  "quinhentos",
  "seiscentos",
  "setecentos",
  "oitocentos",
  "novecentos",
];

// "cem" when exactly 100; "cento" for 101–199 (handled by hundreds array for non-100).
function threeDigitGroup(n: number): string {
  if (n === 0) return "";
  if (n === 100) return "cem";
  const h = Math.floor(n / 100);
  const remainder = n % 100;
  const parts: string[] = [];
  if (h > 0) parts.push(HUNDREDS[h]);
  if (remainder > 0) {
    if (remainder < 20) {
      parts.push(UNITS[remainder]);
    } else {
      const t = Math.floor(remainder / 10);
      const u = remainder % 10;
      if (u === 0) {
        parts.push(TENS[t]);
      } else {
        parts.push(`${TENS[t]} e ${UNITS[u]}`);
      }
    }
  }
  return parts.join(" e ");
}

type ScaleEntry = { value: number; singular: string; plural: string };

const SCALES: ScaleEntry[] = [
  { value: 1_000_000_000, singular: "bilhão", plural: "bilhões" },
  { value: 1_000_000, singular: "milhão", plural: "milhões" },
  { value: 1_000, singular: "mil", plural: "mil" },
];

/**
 * Convert a non-negative integer to Portuguese extenso (no currency suffix).
 */
function integerToExtensoParts(n: number): string {
  if (n === 0) return "zero";
  const parts: string[] = [];
  let remaining = n;
  for (const scale of SCALES) {
    const count = Math.floor(remaining / scale.value);
    if (count > 0) {
      const groupText = threeDigitGroup(count);
      const scaleName = count === 1 ? scale.singular : scale.plural;
      if (count === 1 && scale.value === 1_000) {
        // "mil" stands alone without "um"
        parts.push(scale.singular);
      } else {
        parts.push(`${groupText} ${scaleName}`);
      }
      remaining -= count * scale.value;
    }
  }
  if (remaining > 0) {
    parts.push(threeDigitGroup(remaining));
  }
  return parts.join(" e ");
}

/**
 * Convert a currency amount to Portuguese extenso.
 *
 * Examples:
 *   0        → "zero reais"
 *   1        → "um real"
 *   1.5      → "um real e cinquenta centavos"
 *   1500     → "mil e quinhentos reais"
 *   1000001  → "um milhão e um reais"
 */
export function amountInWords(amountStr: string): string {
  const parsed = Number(amountStr.trim().replace(",", "."));
  if (!isFinite(parsed) || parsed < 0) {
    throw new RangeError(
      `amount_in_words: invalid amount '${amountStr}' — must be a non-negative number`,
    );
  }
  // Split into reais and centavos
  const rounded = Math.round(parsed * 100); // work in centavos to avoid float errors
  const reaisInt = Math.floor(rounded / 100);
  const centavosInt = rounded % 100;

  const parts: string[] = [];

  if (reaisInt > 0) {
    const reaisText = integerToExtensoParts(reaisInt);
    const suffix = reaisInt === 1 ? "real" : "reais";
    parts.push(`${reaisText} ${suffix}`);
  }

  if (centavosInt > 0) {
    const centavosText = integerToExtensoParts(centavosInt);
    const suffix = centavosInt === 1 ? "centavo" : "centavos";
    parts.push(`${centavosText} ${suffix}`);
  }

  if (parts.length === 0) return "zero reais";
  return parts.join(" e ");
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export const FORMULA_REGISTRY: Map<string, FormulaSpec> = new Map([
  [
    "amount_in_words",
    {
      arity: 1,
      fn: (amount: string): string => amountInWords(amount),
    },
  ],
  [
    "full_date_text",
    {
      arity: 1,
      fn: (dateStr: string): string => {
        // Accepts ISO date (YYYY-MM-DD) or date string parseable by Date constructor.
        // To avoid timezone shifts, parse the YYYY-MM-DD parts directly if possible.
        const isoMatch = dateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
        let year: number, month: number, day: number;
        if (isoMatch) {
          year = parseInt(isoMatch[1], 10);
          month = parseInt(isoMatch[2], 10); // 1-based
          day = parseInt(isoMatch[3], 10);
        } else {
          const d = new Date(dateStr);
          if (isNaN(d.getTime())) {
            throw new RangeError(
              `full_date_text: invalid date '${dateStr}'`,
            );
          }
          year = d.getFullYear();
          month = d.getMonth() + 1;
          day = d.getDate();
        }
        if (month < 1 || month > 12) {
          throw new RangeError(
            `full_date_text: invalid month ${month} in '${dateStr}'`,
          );
        }
        const monthName = PT_MONTHS[month - 1];
        return `${day} de ${monthName} de ${year}`;
      },
    },
  ],
  [
    "end_date",
    {
      arity: 2,
      fn: (startDateStr: string, durationMonthsStr: string): string => {
        const isoMatch = startDateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
        let year: number, month: number, day: number;
        if (isoMatch) {
          year = parseInt(isoMatch[1], 10);
          month = parseInt(isoMatch[2], 10); // 1-based
          day = parseInt(isoMatch[3], 10);
        } else {
          const d = new Date(startDateStr);
          if (isNaN(d.getTime())) {
            throw new RangeError(
              `end_date: invalid start date '${startDateStr}'`,
            );
          }
          year = d.getFullYear();
          month = d.getMonth() + 1;
          day = d.getDate();
        }
        const durationMonths = parseInt(durationMonthsStr.trim(), 10);
        if (isNaN(durationMonths) || durationMonths < 0) {
          throw new RangeError(
            `end_date: invalid duration '${durationMonthsStr}' — must be a non-negative integer`,
          );
        }
        // Add months, adjusting year overflow
        let endMonth = month + durationMonths;
        let endYear = year;
        while (endMonth > 12) {
          endMonth -= 12;
          endYear++;
        }
        // Clamp day to the end of the target month
        const daysInMonth = new Date(endYear, endMonth, 0).getDate();
        const endDay = Math.min(day, daysInMonth);
        return `${endYear}-${String(endMonth).padStart(2, "0")}-${
          String(endDay).padStart(2, "0")
        }`;
      },
    },
  ],
]);
