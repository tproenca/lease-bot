// unit: _shared/format.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyCase, substituteTokens } from "./format.ts";

// ═══════════════════════════════════════════════════════════════════════════
// unit: applyCase
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: applyCase — null case returns value unchanged", () => {
  assertEquals(applyCase("hello world", null), "hello world");
});

Deno.test("unit: applyCase — undefined case returns value unchanged", () => {
  assertEquals(applyCase("hello world", undefined), "hello world");
});

Deno.test("unit: applyCase — maiúsculas converts to UPPERCASE", () => {
  assertEquals(applyCase("joão silva", "maiúsculas"), "JOÃO SILVA");
});

Deno.test("unit: applyCase — minúsculas converts to lowercase", () => {
  assertEquals(applyCase("JOÃO SILVA", "minúsculas"), "joão silva");
});

Deno.test("unit: applyCase — título capitalises first letter of each word", () => {
  assertEquals(applyCase("rua das flores", "título"), "Rua Das Flores");
});

Deno.test("unit: applyCase — título handles already-mixed case", () => {
  assertEquals(applyCase("RUA DAS flores", "título"), "Rua Das Flores");
});

Deno.test("unit: applyCase — frase capitalises first letter of string only", () => {
  assertEquals(applyCase("rua das flores", "frase"), "Rua das flores");
});

Deno.test("unit: applyCase — frase lowercases rest of string", () => {
  assertEquals(applyCase("RUA DAS FLORES", "frase"), "Rua das flores");
});

Deno.test("unit: applyCase — unknown case value returns value unchanged", () => {
  assertEquals(applyCase("hello", "unknown-transform"), "hello");
});

Deno.test("unit: applyCase — empty string with maiúsculas returns empty string", () => {
  assertEquals(applyCase("", "maiúsculas"), "");
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: substituteTokens
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: substituteTokens — replaces single token", () => {
  const result = substituteTokens(
    "Olá {{nome}}!",
    new Map([["nome", "João"]]),
  );
  assertEquals(result, "Olá João!");
});

Deno.test("unit: substituteTokens — replaces multiple tokens", () => {
  const result = substituteTokens(
    "{{nome}}, CPF {{cpf}}",
    new Map([["nome", "João"], ["cpf", "123.456.789-00"]]),
  );
  assertEquals(result, "João, CPF 123.456.789-00");
});

Deno.test("unit: substituteTokens — replaces same token multiple times", () => {
  const result = substituteTokens(
    "{{nome}} e {{nome}}",
    new Map([["nome", "João"]]),
  );
  assertEquals(result, "João e João");
});

Deno.test("unit: substituteTokens — leaves unknown tokens unchanged", () => {
  const result = substituteTokens(
    "{{nome}} e {{desconhecido}}",
    new Map([["nome", "João"]]),
  );
  assertEquals(result, "João e {{desconhecido}}");
});

Deno.test("unit: substituteTokens — handles token with spaces in name", () => {
  const result = substituteTokens(
    "Imóvel: {{nome do imóvel}}",
    new Map([["nome do imóvel", "Apt 101"]]),
  );
  assertEquals(result, "Imóvel: Apt 101");
});

Deno.test("unit: substituteTokens — handles empty value replacement", () => {
  const result = substituteTokens(
    "{{nome}} {{sobrenome}}",
    new Map([["nome", "João"], ["sobrenome", ""]]),
  );
  assertEquals(result, "João ");
});

Deno.test("unit: substituteTokens — handles content with no tokens", () => {
  const result = substituteTokens(
    "Nenhum placeholder aqui.",
    new Map([["nome", "João"]]),
  );
  assertEquals(result, "Nenhum placeholder aqui.");
});

Deno.test("unit: substituteTokens — trims whitespace inside token braces", () => {
  const result = substituteTokens(
    "{{ nome }}",
    new Map([["nome", "João"]]),
  );
  assertEquals(result, "João");
});
