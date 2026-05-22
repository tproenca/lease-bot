#!/usr/bin/env -S deno run --allow-net --allow-read --allow-env
//
// Test createStarterDocsForSetup directly — no HTTP/JWT needed.
// Run: deno run --allow-net --allow-read --allow-env scripts/test-setup-docs.ts
//
// Reads the landlord's Google refresh token from the local Supabase auth DB
// via service role, refreshes the access token, then calls createStarterDocsForSetup.

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const USER_ID = "facfe2e4-7a0c-4536-ab8b-331f68b28136";

// ── 1. Get the user's google_refresh_token ────────────────────────────────────
const userRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${USER_ID}`, {
  headers: {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  },
});
const user = await userRes.json() as { user_metadata?: { google_refresh_token?: string } };
const refreshToken = user.user_metadata?.google_refresh_token;
if (!refreshToken) {
  console.error("❌ No google_refresh_token found in user metadata.");
  Deno.exit(1);
}
console.log("✓ Got Google refresh token");

// ── 2. Get the landlord's templates_folder_id from DB ─────────────────────────
const landlordRes = await fetch(
  `${SUPABASE_URL}/rest/v1/landlords?select=templates_folder_id&id=eq.${USER_ID}&limit=1`,
  {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
  },
);
const [landlord] = await landlordRes.json() as Array<{ templates_folder_id: string }>;
if (!landlord?.templates_folder_id) {
  console.error("❌ No landlord row found.");
  Deno.exit(1);
}
const templatesFolderId = landlord.templates_folder_id;
console.log("✓ Templates folder:", templatesFolderId);

// ── 3. Import and call ────────────────────────────────────────────────────────
// Set env vars the shared modules expect
Deno.env.set("GOOGLE_CLIENT_ID", Deno.env.get("GOOGLE_CLIENT_ID") ?? "");
Deno.env.set("GOOGLE_CLIENT_SECRET", Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "");
Deno.env.set("SUPABASE_URL", SUPABASE_URL);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);

const { refreshGoogleAccessToken } = await import(
  "../supabase/functions/_shared/google.ts"
);
const { createStarterDocsForSetup } = await import(
  "../supabase/functions/setup/complete/index.ts"
);

const accessToken = await refreshGoogleAccessToken(refreshToken);
console.log("✓ Google access token refreshed");

console.log("\n🚀 Creating starter docs in Templates folder...\n");
const result = await createStarterDocsForSetup({ accessToken, templatesFolderId });

console.log("\n✅ Done!");
console.log("  guia_doc_id:    ", result.guiaDocId ?? "failed");
console.log("  exemplo_doc_id: ", result.contratoDocId ?? "failed");

if (result.guiaDocId)
  console.log(`\n  → https://docs.google.com/document/d/${result.guiaDocId}/edit`);
if (result.contratoDocId)
  console.log(`  → https://docs.google.com/document/d/${result.contratoDocId}/edit`);
