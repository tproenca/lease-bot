// unit: _shared/validation.ts
import { assertEquals, assertStrictEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  looksLikeDriveId,
  normalizeBrazilianWhatsapp,
  normalizeTemplatesFolderName,
} from "./validation.ts";

// ─── normalizeBrazilianWhatsapp ───────────────────────────────────────────

Deno.test("unit: normalizeBrazilianWhatsapp — canonical E.164 11-digit", () => {
  assertStrictEquals(normalizeBrazilianWhatsapp("+5511999999999"), "+5511999999999");
});

Deno.test("unit: normalizeBrazilianWhatsapp — canonical E.164 10-digit", () => {
  assertStrictEquals(normalizeBrazilianWhatsapp("+551199999999"), "+551199999999");
});

Deno.test("unit: normalizeBrazilianWhatsapp — adds leading + from 55-prefixed digits", () => {
  assertStrictEquals(normalizeBrazilianWhatsapp("5511999999999"), "+5511999999999");
});

Deno.test("unit: normalizeBrazilianWhatsapp — strips formatting chars", () => {
  assertStrictEquals(
    normalizeBrazilianWhatsapp("+55 (11) 99999-9999"),
    "+5511999999999",
  );
});

Deno.test("unit: normalizeBrazilianWhatsapp — rejects non-Brazilian country code", () => {
  assertStrictEquals(normalizeBrazilianWhatsapp("+14155552671"), null);
});

Deno.test("unit: normalizeBrazilianWhatsapp — rejects too-short number", () => {
  assertStrictEquals(normalizeBrazilianWhatsapp("+55119999999"), null);
});

Deno.test("unit: normalizeBrazilianWhatsapp — rejects too-long number", () => {
  assertStrictEquals(normalizeBrazilianWhatsapp("+551199999999999"), null);
});

Deno.test("unit: normalizeBrazilianWhatsapp — rejects empty string", () => {
  assertStrictEquals(normalizeBrazilianWhatsapp(""), null);
});

Deno.test("unit: normalizeBrazilianWhatsapp — rejects non-string", () => {
  assertStrictEquals(normalizeBrazilianWhatsapp(null), null);
  assertStrictEquals(normalizeBrazilianWhatsapp(undefined), null);
  assertStrictEquals(normalizeBrazilianWhatsapp(5511999999999), null);
});

// ─── looksLikeDriveId ─────────────────────────────────────────────────────

Deno.test("unit: looksLikeDriveId — accepts valid-looking Drive folder ID", () => {
  assertEquals(looksLikeDriveId("1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms"), true);
});

Deno.test("unit: looksLikeDriveId — accepts short but valid ID (10 chars)", () => {
  assertEquals(looksLikeDriveId("ABCDE12345"), true);
});

Deno.test("unit: looksLikeDriveId — accepts IDs with hyphens and underscores", () => {
  assertEquals(looksLikeDriveId("1aBc-De_Fg1234567"), true);
});

Deno.test("unit: looksLikeDriveId — rejects too-short string (< 10 chars)", () => {
  assertEquals(looksLikeDriveId("ABC123"), false);
});

Deno.test("unit: looksLikeDriveId — rejects string with invalid chars", () => {
  assertEquals(looksLikeDriveId("ABC!@#$%^&*123"), false);
});

Deno.test("unit: looksLikeDriveId — rejects empty string", () => {
  assertEquals(looksLikeDriveId(""), false);
});

Deno.test("unit: looksLikeDriveId — rejects non-string", () => {
  assertEquals(looksLikeDriveId(null), false);
  assertEquals(looksLikeDriveId(undefined), false);
  assertEquals(looksLikeDriveId(12345678901), false);
});

// ─── normalizeTemplatesFolderName ────────────────────────────────────────

Deno.test("unit: normalizeTemplatesFolderName — strips trailing slash", () => {
  assertStrictEquals(normalizeTemplatesFolderName("Templates/"), "Templates");
});

Deno.test("unit: normalizeTemplatesFolderName — accepts name without slash", () => {
  assertStrictEquals(normalizeTemplatesFolderName("Modelos"), "Modelos");
});

Deno.test("unit: normalizeTemplatesFolderName — trims surrounding whitespace", () => {
  assertStrictEquals(normalizeTemplatesFolderName("  Templates/  "), "Templates");
});

Deno.test("unit: normalizeTemplatesFolderName — accepts name with spaces", () => {
  assertStrictEquals(normalizeTemplatesFolderName("Meus Modelos"), "Meus Modelos");
});

Deno.test("unit: normalizeTemplatesFolderName — rejects name with path separator", () => {
  assertStrictEquals(normalizeTemplatesFolderName("Pasta/SubPasta"), null);
});

Deno.test("unit: normalizeTemplatesFolderName — rejects name with backslash", () => {
  assertStrictEquals(normalizeTemplatesFolderName("Pasta\\Sub"), null);
});

Deno.test("unit: normalizeTemplatesFolderName — rejects name longer than 80 chars", () => {
  assertStrictEquals(normalizeTemplatesFolderName("A".repeat(81)), null);
});

Deno.test("unit: normalizeTemplatesFolderName — rejects empty string", () => {
  assertStrictEquals(normalizeTemplatesFolderName(""), null);
});

Deno.test("unit: normalizeTemplatesFolderName — rejects non-string", () => {
  assertStrictEquals(normalizeTemplatesFolderName(null), null);
  assertStrictEquals(normalizeTemplatesFolderName(undefined), null);
});
