// unit: derivation engine — formula registry, grammar parser, topological resolver
//
// Covers:
//   - parseFormula: all grammar forms, error cases
//   - siblingDeps: extraction from each formula kind
//   - registry functions: amount_in_words, full_date_text, end_date
//   - amount_in_words: boundary values (zero, decimals, large numbers)
//   - resolvePlaceholders: asked, context, derived, sibling chain, default
//   - topoSort: linear chain, multi-sibling, circular dependency error
//   - error codes: UNKNOWN_FORMULA, UNRESOLVABLE_INPUT, CIRCULAR_DEPENDENCY

import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import { parseFormula, siblingDeps } from "./parser.ts";
import { amountInWords, FORMULA_REGISTRY } from "./registry.ts";
import { DerivationError, resolvePlaceholders, topoSort } from "./resolver.ts";

// ─── parseFormula ─────────────────────────────────────────────────────────────

Deno.test("unit: parseFormula — null returns asked", () => {
  const result = parseFormula(null);
  assertEquals(result.kind, "asked");
});

Deno.test("unit: parseFormula — empty string returns asked", () => {
  const result = parseFormula("");
  assertEquals(result.kind, "asked");
});

Deno.test("unit: parseFormula — string 'null' returns asked", () => {
  const result = parseFormula("null");
  assertEquals(result.kind, "asked");
});

Deno.test("unit: parseFormula — bare context path returns context_path", () => {
  const result = parseFormula("tenant.name");
  assertEquals(result.kind, "context_path");
  if (result.kind === "context_path") {
    assertEquals(result.namespace, "tenant");
    assertEquals(result.field, "name");
  }
});

Deno.test("unit: parseFormula — bare context path with property namespace", () => {
  const result = parseFormula("property.address");
  assertEquals(result.kind, "context_path");
  if (result.kind === "context_path") {
    assertEquals(result.namespace, "property");
    assertEquals(result.field, "address");
  }
});

Deno.test("unit: parseFormula — bare sibling name returns sibling", () => {
  const result = parseFormula("valor_aluguel");
  assertEquals(result.kind, "sibling");
  if (result.kind === "sibling") {
    assertEquals(result.name, "valor_aluguel");
  }
});

Deno.test("unit: parseFormula — fn_call with one context arg", () => {
  const result = parseFormula("full_date_text(tenant.start_date)");
  assertEquals(result.kind, "fn_call");
  if (result.kind === "fn_call") {
    assertEquals(result.fn, "full_date_text");
    assertEquals(result.args.length, 1);
    assertEquals(result.args[0].kind, "context_path");
    if (result.args[0].kind === "context_path") {
      assertEquals(result.args[0].namespace, "tenant");
      assertEquals(result.args[0].field, "start_date");
    }
  }
});

Deno.test("unit: parseFormula — fn_call with sibling arg", () => {
  const result = parseFormula("amount_in_words(valor_aluguel)");
  assertEquals(result.kind, "fn_call");
  if (result.kind === "fn_call") {
    assertEquals(result.fn, "amount_in_words");
    assertEquals(result.args.length, 1);
    assertEquals(result.args[0].kind, "sibling");
    if (result.args[0].kind === "sibling") {
      assertEquals(result.args[0].name, "valor_aluguel");
    }
  }
});

Deno.test("unit: parseFormula — fn_call with two args (sibling + sibling)", () => {
  const result = parseFormula("end_date(data_inicio, duracao_meses)");
  assertEquals(result.kind, "fn_call");
  if (result.kind === "fn_call") {
    assertEquals(result.fn, "end_date");
    assertEquals(result.args.length, 2);
    assertEquals(result.args[0].kind, "sibling");
    assertEquals(result.args[1].kind, "sibling");
    if (result.args[0].kind === "sibling") {
      assertEquals(result.args[0].name, "data_inicio");
    }
    if (result.args[1].kind === "sibling") {
      assertEquals(result.args[1].name, "duracao_meses");
    }
  }
});

Deno.test("unit: parseFormula — fn_call with context path + sibling args", () => {
  const result = parseFormula("end_date(tenant.start_date, duracao_meses)");
  assertEquals(result.kind, "fn_call");
  if (result.kind === "fn_call") {
    assertEquals(result.args[0].kind, "context_path");
    assertEquals(result.args[1].kind, "sibling");
  }
});

Deno.test("unit: parseFormula — fn_call with landlord namespace", () => {
  const result = parseFormula("full_date_text(landlord.start_date)");
  assertEquals(result.kind, "fn_call");
  if (result.kind === "fn_call") {
    assertEquals(result.args[0].kind, "context_path");
    if (result.args[0].kind === "context_path") {
      assertEquals(result.args[0].namespace, "landlord");
    }
  }
});

Deno.test("unit: parseFormula — fn_call with building namespace", () => {
  const result = parseFormula("full_date_text(building.construction_date)");
  assertEquals(result.kind, "fn_call");
  if (result.kind === "fn_call") {
    assertEquals(result.args[0].kind, "context_path");
    if (result.args[0].kind === "context_path") {
      assertEquals(result.args[0].namespace, "building");
    }
  }
});

Deno.test("unit: parseFormula — whitespace around tokens is ignored", () => {
  const result = parseFormula("  end_date( data_inicio , duracao_meses )  ");
  assertEquals(result.kind, "fn_call");
  if (result.kind === "fn_call") {
    assertEquals(result.fn, "end_date");
    assertEquals(result.args.length, 2);
  }
});

Deno.test("unit: parseFormula — bare namespace without field throws SyntaxError", () => {
  assertThrows(
    () => parseFormula("tenant"),
    SyntaxError,
    "missing '.field'",
  );
});

Deno.test("unit: parseFormula — trailing content after sibling throws SyntaxError", () => {
  assertThrows(
    () => parseFormula("foo bar"),
    SyntaxError,
  );
});

Deno.test("unit: parseFormula — trailing content after context path throws SyntaxError", () => {
  assertThrows(
    () => parseFormula("tenant.name extra"),
    SyntaxError,
  );
});

Deno.test("unit: parseFormula — trailing content after fn_call throws SyntaxError", () => {
  assertThrows(
    () => parseFormula("amount_in_words(tenant.name) extra"),
    SyntaxError,
  );
});

Deno.test("unit: parseFormula — unexpected character throws SyntaxError", () => {
  assertThrows(
    () => parseFormula("amount_in_words($foo)"),
    SyntaxError,
    "Unexpected character",
  );
});

// ─── siblingDeps ──────────────────────────────────────────────────────────────

Deno.test("unit: siblingDeps — asked returns empty set", () => {
  const deps = siblingDeps({ kind: "asked" });
  assertEquals(deps.size, 0);
});

Deno.test("unit: siblingDeps — context_path returns empty set", () => {
  const deps = siblingDeps({
    kind: "context_path",
    namespace: "tenant",
    field: "name",
  });
  assertEquals(deps.size, 0);
});

Deno.test("unit: siblingDeps — sibling returns set with that name", () => {
  const deps = siblingDeps({ kind: "sibling", name: "valor_aluguel" });
  assertEquals(deps.has("valor_aluguel"), true);
  assertEquals(deps.size, 1);
});

Deno.test("unit: siblingDeps — fn_call with sibling args returns all sibling names", () => {
  const formula = parseFormula("end_date(data_inicio, duracao_meses)");
  const deps = siblingDeps(formula);
  assertEquals(deps.has("data_inicio"), true);
  assertEquals(deps.has("duracao_meses"), true);
  assertEquals(deps.size, 2);
});

Deno.test("unit: siblingDeps — fn_call with context args returns empty set", () => {
  const formula = parseFormula("full_date_text(tenant.start_date)");
  const deps = siblingDeps(formula);
  assertEquals(deps.size, 0);
});

// ─── Registry: amount_in_words ────────────────────────────────────────────────

Deno.test("unit: amountInWords — zero returns 'zero reais'", () => {
  assertEquals(amountInWords("0"), "zero reais");
});

Deno.test("unit: amountInWords — one returns 'um real'", () => {
  assertEquals(amountInWords("1"), "um real");
});

Deno.test("unit: amountInWords — two returns 'dois reais'", () => {
  assertEquals(amountInWords("2"), "dois reais");
});

Deno.test("unit: amountInWords — 1500 returns 'mil e quinhentos reais'", () => {
  assertEquals(amountInWords("1500"), "mil e quinhentos reais");
});

Deno.test("unit: amountInWords — 100 returns 'cem reais'", () => {
  assertEquals(amountInWords("100"), "cem reais");
});

Deno.test("unit: amountInWords — 101 returns 'cento e um reais'", () => {
  assertEquals(amountInWords("101"), "cento e um reais");
});

Deno.test("unit: amountInWords — 200 returns 'duzentos reais'", () => {
  assertEquals(amountInWords("200"), "duzentos reais");
});

Deno.test("unit: amountInWords — 1000 returns 'mil reais'", () => {
  assertEquals(amountInWords("1000"), "mil reais");
});

Deno.test("unit: amountInWords — 2000 returns 'dois mil reais'", () => {
  assertEquals(amountInWords("2000"), "dois mil reais");
});

Deno.test("unit: amountInWords — 1000000 returns 'um milhão reais'", () => {
  assertEquals(amountInWords("1000000"), "um milhão reais");
});

Deno.test("unit: amountInWords — 2500000 returns 'dois milhões e quinhentos mil reais'", () => {
  assertEquals(
    amountInWords("2500000"),
    "dois milhões e quinhentos mil reais",
  );
});

Deno.test("unit: amountInWords — decimals: 1.50 returns 'um real e cinquenta centavos'", () => {
  assertEquals(amountInWords("1.50"), "um real e cinquenta centavos");
});

Deno.test("unit: amountInWords — decimals: 0.01 returns 'um centavo'", () => {
  assertEquals(amountInWords("0.01"), "um centavo");
});

Deno.test("unit: amountInWords — decimals: 0.99 returns 'noventa e nove centavos'", () => {
  assertEquals(amountInWords("0.99"), "noventa e nove centavos");
});

Deno.test("unit: amountInWords — decimals: 1500.75 returns 'mil e quinhentos reais e setenta e cinco centavos'", () => {
  assertEquals(
    amountInWords("1500.75"),
    "mil e quinhentos reais e setenta e cinco centavos",
  );
});

Deno.test("unit: amountInWords — large: 1000000000 returns 'um bilhão reais'", () => {
  assertEquals(amountInWords("1000000000"), "um bilhão reais");
});

Deno.test("unit: amountInWords — large: 2000000000 returns 'dois bilhões reais'", () => {
  assertEquals(amountInWords("2000000000"), "dois bilhões reais");
});

Deno.test("unit: amountInWords — throws RangeError for negative value", () => {
  assertThrows(() => amountInWords("-1"), RangeError);
});

Deno.test("unit: amountInWords — throws RangeError for non-numeric string", () => {
  assertThrows(() => amountInWords("abc"), RangeError);
});

Deno.test("unit: registry amount_in_words — arity is 1", () => {
  const spec = FORMULA_REGISTRY.get("amount_in_words")!;
  assertEquals(spec.arity, 1);
});

// ─── Registry: full_date_text ─────────────────────────────────────────────────

Deno.test("unit: registry full_date_text — ISO date formats correctly", () => {
  const spec = FORMULA_REGISTRY.get("full_date_text")!;
  assertEquals(spec.arity, 1);
  assertEquals(spec.fn("2025-03-15"), "15 de março de 2025");
});

Deno.test("unit: registry full_date_text — January", () => {
  const spec = FORMULA_REGISTRY.get("full_date_text")!;
  assertEquals(spec.fn("2025-01-01"), "1 de janeiro de 2025");
});

Deno.test("unit: registry full_date_text — December", () => {
  const spec = FORMULA_REGISTRY.get("full_date_text")!;
  assertEquals(spec.fn("2025-12-31"), "31 de dezembro de 2025");
});

Deno.test("unit: registry full_date_text — throws RangeError for invalid date", () => {
  const spec = FORMULA_REGISTRY.get("full_date_text")!;
  assertThrows(() => spec.fn("not-a-date"), RangeError, "invalid date");
});

// ─── Registry: end_date ───────────────────────────────────────────────────────

Deno.test("unit: registry end_date — adds months correctly within same year", () => {
  const spec = FORMULA_REGISTRY.get("end_date")!;
  assertEquals(spec.arity, 2);
  assertEquals(spec.fn("2025-01-01", "6"), "2025-07-01");
});

Deno.test("unit: registry end_date — wraps year correctly", () => {
  const spec = FORMULA_REGISTRY.get("end_date")!;
  assertEquals(spec.fn("2025-06-01", "12"), "2026-06-01");
});

Deno.test("unit: registry end_date — multi-year wrap", () => {
  const spec = FORMULA_REGISTRY.get("end_date")!;
  assertEquals(spec.fn("2025-01-01", "24"), "2027-01-01");
});

Deno.test("unit: registry end_date — clamps day to end of shorter month", () => {
  const spec = FORMULA_REGISTRY.get("end_date")!;
  // March 31 + 1 month = April 30 (April has 30 days)
  assertEquals(spec.fn("2025-03-31", "1"), "2025-04-30");
});

Deno.test("unit: registry end_date — zero duration returns same date", () => {
  const spec = FORMULA_REGISTRY.get("end_date")!;
  assertEquals(spec.fn("2025-06-15", "0"), "2025-06-15");
});

Deno.test("unit: registry end_date — throws RangeError for invalid start date", () => {
  const spec = FORMULA_REGISTRY.get("end_date")!;
  assertThrows(
    () => spec.fn("not-a-date", "12"),
    RangeError,
    "invalid start date",
  );
});

Deno.test("unit: registry end_date — throws RangeError for invalid duration", () => {
  const spec = FORMULA_REGISTRY.get("end_date")!;
  assertThrows(
    () => spec.fn("2025-01-01", "abc"),
    RangeError,
    "invalid duration",
  );
});

// ─── topoSort ─────────────────────────────────────────────────────────────────

Deno.test("unit: topoSort — asked placeholder has no dependencies (order preserved)", () => {
  const placeholders = [
    { name: "a", derived_formula: null, default: null },
    { name: "b", derived_formula: null, default: null },
  ];
  const sorted = topoSort(placeholders);
  assertEquals(sorted.map((p) => p.name).sort(), ["a", "b"]);
});

Deno.test("unit: topoSort — linear chain: a → b (b depends on a, a must come first)", () => {
  const placeholders = [
    { name: "b", derived_formula: "amount_in_words(a)", default: null },
    { name: "a", derived_formula: null, default: null },
  ];
  const sorted = topoSort(placeholders);
  const names = sorted.map((p) => p.name);
  const aIdx = names.indexOf("a");
  const bIdx = names.indexOf("b");
  assertEquals(aIdx < bIdx, true, "a must come before b");
});

Deno.test("unit: topoSort — multi-sibling chain: a → b → c", () => {
  const placeholders = [
    { name: "c", derived_formula: "full_date_text(b)", default: null },
    { name: "b", derived_formula: "amount_in_words(a)", default: null },
    { name: "a", derived_formula: null, default: null },
  ];
  const sorted = topoSort(placeholders);
  const names = sorted.map((p) => p.name);
  const aIdx = names.indexOf("a");
  const bIdx = names.indexOf("b");
  const cIdx = names.indexOf("c");
  assertEquals(aIdx < bIdx, true, "a must come before b");
  assertEquals(bIdx < cIdx, true, "b must come before c");
});

Deno.test("unit: topoSort — two independent chains resolved correctly", () => {
  const placeholders = [
    { name: "x2", derived_formula: "amount_in_words(x1)", default: null },
    { name: "y2", derived_formula: "amount_in_words(y1)", default: null },
    { name: "x1", derived_formula: null, default: null },
    { name: "y1", derived_formula: null, default: null },
  ];
  const sorted = topoSort(placeholders);
  const names = sorted.map((p) => p.name);
  assertEquals(names.indexOf("x1") < names.indexOf("x2"), true);
  assertEquals(names.indexOf("y1") < names.indexOf("y2"), true);
});

Deno.test("unit: topoSort — circular dependency throws CIRCULAR_DEPENDENCY error", () => {
  const placeholders = [
    { name: "a", derived_formula: "amount_in_words(b)", default: null },
    { name: "b", derived_formula: "amount_in_words(a)", default: null },
  ];
  assertThrows(
    () => topoSort(placeholders),
    DerivationError,
  );
  try {
    topoSort(placeholders);
  } catch (e) {
    assertEquals((e as DerivationError).code, "CIRCULAR_DEPENDENCY");
  }
});

Deno.test("unit: topoSort — three-way cycle throws CIRCULAR_DEPENDENCY error", () => {
  const placeholders = [
    { name: "a", derived_formula: "amount_in_words(c)", default: null },
    { name: "b", derived_formula: "amount_in_words(a)", default: null },
    { name: "c", derived_formula: "amount_in_words(b)", default: null },
  ];
  assertThrows(
    () => topoSort(placeholders),
    DerivationError,
  );
  try {
    topoSort(placeholders);
  } catch (e) {
    assertEquals((e as DerivationError).code, "CIRCULAR_DEPENDENCY");
  }
});

// ─── resolvePlaceholders ──────────────────────────────────────────────────────

Deno.test("unit: resolvePlaceholders — asked placeholder uses collected value", () => {
  const placeholders = [
    { name: "nome", derived_formula: null, default: null },
  ];
  const result = resolvePlaceholders(placeholders, { nome: "Maria" }, {});
  assertEquals(result.get("nome"), "Maria");
});

Deno.test("unit: resolvePlaceholders — asked placeholder with no collected value uses default", () => {
  const placeholders = [
    { name: "cidade", derived_formula: null, default: "São Paulo" },
  ];
  const result = resolvePlaceholders(placeholders, {}, {});
  assertEquals(result.get("cidade"), "São Paulo");
});

Deno.test("unit: resolvePlaceholders — asked placeholder with no value and no default resolves to empty string", () => {
  const placeholders = [
    { name: "observacoes", derived_formula: null, default: null },
  ];
  const result = resolvePlaceholders(placeholders, {}, {});
  assertEquals(result.get("observacoes"), "");
});

Deno.test("unit: resolvePlaceholders — context path resolves from contextData", () => {
  const placeholders = [
    { name: "nome_inquilino", derived_formula: "tenant.name", default: null },
  ];
  const result = resolvePlaceholders(
    placeholders,
    {},
    { tenant: { name: "João Silva" } },
  );
  assertEquals(result.get("nome_inquilino"), "João Silva");
});

Deno.test("unit: resolvePlaceholders — context path missing namespace throws UNRESOLVABLE_INPUT", () => {
  const placeholders = [
    { name: "nome_inquilino", derived_formula: "tenant.name", default: null },
  ];
  assertThrows(
    () => resolvePlaceholders(placeholders, {}, {}),
    DerivationError,
  );
  try {
    resolvePlaceholders(placeholders, {}, {});
  } catch (e) {
    assertEquals((e as DerivationError).code, "UNRESOLVABLE_INPUT");
  }
});

Deno.test("unit: resolvePlaceholders — context path missing field throws UNRESOLVABLE_INPUT", () => {
  const placeholders = [
    { name: "cpf_inquilino", derived_formula: "tenant.cpf", default: null },
  ];
  assertThrows(
    () => resolvePlaceholders(placeholders, {}, { tenant: { name: "João" } }),
    DerivationError,
  );
  try {
    resolvePlaceholders(placeholders, {}, { tenant: { name: "João" } });
  } catch (e) {
    assertEquals((e as DerivationError).code, "UNRESOLVABLE_INPUT");
  }
});

Deno.test("unit: resolvePlaceholders — registry fn resolves with context arg", () => {
  const placeholders = [
    {
      name: "data_texto",
      derived_formula: "full_date_text(tenant.start_date)",
      default: null,
    },
  ];
  const result = resolvePlaceholders(
    placeholders,
    {},
    { tenant: { start_date: "2025-03-15" } },
  );
  assertEquals(result.get("data_texto"), "15 de março de 2025");
});

Deno.test("unit: resolvePlaceholders — registry fn resolves with sibling arg", () => {
  const placeholders = [
    { name: "valor_aluguel", derived_formula: null, default: null },
    {
      name: "valor_por_extenso",
      derived_formula: "amount_in_words(valor_aluguel)",
      default: null,
    },
  ];
  const result = resolvePlaceholders(
    placeholders,
    { valor_aluguel: "1500" },
    {},
  );
  assertEquals(result.get("valor_por_extenso"), "mil e quinhentos reais");
});

Deno.test("unit: resolvePlaceholders — sibling dependency chain resolved in order", () => {
  const placeholders = [
    { name: "data_inicio", derived_formula: null, default: null },
    { name: "duracao_meses", derived_formula: null, default: null },
    {
      name: "data_fim",
      derived_formula: "end_date(data_inicio, duracao_meses)",
      default: null,
    },
    {
      name: "valor",
      derived_formula: null,
      default: null,
    },
    {
      name: "valor_extenso",
      derived_formula: "amount_in_words(valor)",
      default: null,
    },
  ];
  const result = resolvePlaceholders(
    placeholders,
    { data_inicio: "2025-01-01", duracao_meses: "6", valor: "500" },
    {},
  );
  assertEquals(result.get("data_fim"), "2025-07-01");
  assertEquals(result.get("valor_extenso"), "quinhentos reais");
});

Deno.test("unit: resolvePlaceholders — end_date with two sibling inputs", () => {
  const placeholders = [
    { name: "data_inicio", derived_formula: null, default: null },
    { name: "duracao_meses", derived_formula: null, default: null },
    {
      name: "data_fim",
      derived_formula: "end_date(data_inicio, duracao_meses)",
      default: null,
    },
  ];
  const result = resolvePlaceholders(
    placeholders,
    { data_inicio: "2025-01-01", duracao_meses: "12" },
    {},
  );
  assertEquals(result.get("data_fim"), "2026-01-01");
});

Deno.test("unit: resolvePlaceholders — unknown formula function throws UNKNOWN_FORMULA", () => {
  const placeholders = [
    { name: "x", derived_formula: "unknown_fn(tenant.name)", default: null },
  ];
  assertThrows(
    () => resolvePlaceholders(placeholders, {}, { tenant: { name: "João" } }),
    DerivationError,
  );
  try {
    resolvePlaceholders(
      placeholders,
      {},
      { tenant: { name: "João" } },
    );
  } catch (e) {
    assertEquals((e as DerivationError).code, "UNKNOWN_FORMULA");
  }
});

Deno.test("unit: resolvePlaceholders — sibling ref with no resolved value throws UNRESOLVABLE_INPUT", () => {
  const placeholders = [
    {
      name: "valor_extenso",
      derived_formula: "amount_in_words(valor_inexistente)",
      default: null,
    },
  ];
  assertThrows(
    () => resolvePlaceholders(placeholders, {}, {}),
    DerivationError,
  );
  try {
    resolvePlaceholders(placeholders, {}, {});
  } catch (e) {
    assertEquals((e as DerivationError).code, "UNRESOLVABLE_INPUT");
  }
});

Deno.test("unit: resolvePlaceholders — full_date_text with context arg", () => {
  const placeholders = [
    {
      name: "data_texto",
      derived_formula: "full_date_text(tenant.start_date)",
      default: null,
    },
  ];
  const result = resolvePlaceholders(
    placeholders,
    {},
    { tenant: { start_date: "2025-06-15" } },
  );
  assertEquals(result.get("data_texto"), "15 de junho de 2025");
});

Deno.test("unit: resolvePlaceholders — multiple placeholders resolved in one call", () => {
  const placeholders = [
    { name: "nome", derived_formula: "tenant.name", default: null },
    { name: "cpf", derived_formula: "tenant.cpf", default: null },
    { name: "aluguel", derived_formula: null, default: null },
    {
      name: "aluguel_extenso",
      derived_formula: "amount_in_words(aluguel)",
      default: null,
    },
    {
      name: "data_texto",
      derived_formula: "full_date_text(tenant.start_date)",
      default: null,
    },
  ];
  const result = resolvePlaceholders(
    placeholders,
    { aluguel: "1000" },
    {
      tenant: {
        name: "Maria Silva",
        cpf: "12345678909",
        start_date: "2025-03-15",
      },
    },
  );
  assertEquals(result.get("nome"), "Maria Silva");
  assertEquals(result.get("cpf"), "12345678909");
  assertEquals(result.get("aluguel"), "1000");
  assertEquals(result.get("aluguel_extenso"), "mil reais");
  assertEquals(result.get("data_texto"), "15 de março de 2025");
});

Deno.test("unit: resolvePlaceholders — context path missing field uses default if present", () => {
  const placeholders = [
    {
      name: "endereco",
      derived_formula: "property.address",
      default: "Endereço não informado",
    },
  ];
  const result = resolvePlaceholders(
    placeholders,
    {},
    { property: { type: "apartment" } }, // no 'address' field
  );
  assertEquals(result.get("endereco"), "Endereço não informado");
});
