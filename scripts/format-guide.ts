#!/usr/bin/env -S deno run --allow-net --allow-read --allow-env --allow-run=open
//
// format-guide.ts — Applies rich styling to a Google Doc from docs/placeholder-guide.md.
//
// Usage:
//   deno run --allow-net --allow-read --allow-env --allow-run=open scripts/format-guide.ts [doc-id]
//
// If no <doc-id> given, creates a new doc in the Templates folder.
// One-time setup: add http://localhost:8889/callback to authorized redirect URIs
// of your Google OAuth 2.0 Web application client in Google Cloud Console.
//
// Env vars (auto-loaded from supabase/.env):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET

import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";
import { applyDocStyle } from "../supabase/functions/_shared/docs-style.ts";

const env = await load({ envPath: "supabase/.env", allowEmptyValues: true, examplePath: null });
const CLIENT_ID = env["GOOGLE_CLIENT_ID"] ?? Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const CLIENT_SECRET = env["GOOGLE_CLIENT_SECRET"] ?? Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const DOC_ID_ARG = Deno.args[0] ?? "";
const SCOPES = [
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive.file",
].join(" ");
const REDIRECT_URI = "http://localhost:8889/callback";

// ── Auth (loopback redirect) ──────────────────────────────────────────────────

let resolveCode!: (code: string) => void;
const codePromise = new Promise<string>((resolve) => { resolveCode = resolve; });
const abortController = new AbortController();

Deno.serve(
  { port: 8889, signal: abortController.signal, onListen: () => {} },
  (req: Request) => {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    if (code) { resolveCode(code); return new Response("Autenticado! Pode fechar esta aba.", { status: 200 }); }
    return new Response("Código não encontrado.", { status: 400 });
  },
);

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", CLIENT_ID);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPES);
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");

const urlStr = authUrl.toString();
console.log(`\nAbrindo navegador para autorização...\n${urlStr}\n`);
new Deno.Command("open", { args: [urlStr] }).spawn();

const authCode = await codePromise;
abortController.abort();

const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    code: authCode, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI, grant_type: "authorization_code",
  }),
});
const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string };
if (!tokenJson.access_token) { console.error("Auth error:", tokenJson.error); Deno.exit(1); }
const token = tokenJson.access_token;
console.log("Autorizado ✓");

const driveAuth = { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } };

// ── Find Templates folder ─────────────────────────────────────────────────────

async function findTemplatesFolder(): Promise<string | null> {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("q", `name = 'Templates' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  url.searchParams.set("fields", "files(id)");
  url.searchParams.set("pageSize", "5");
  const r = await fetch(url, driveAuth);
  const json = await r.json() as { files: Array<{ id: string }> };
  return json.files[0]?.id ?? null;
}

// ── Get or create doc ─────────────────────────────────────────────────────────

let docId = DOC_ID_ARG;
if (!docId) {
  const templatesFolderId = await findTemplatesFolder();
  if (!templatesFolderId) console.warn("⚠ Templates folder not found — doc will be in Drive root.");

  const r = await fetch("https://docs.googleapis.com/v1/documents", {
    method: "POST", ...driveAuth, body: JSON.stringify({ title: "Guia de Placeholders" }),
  });
  const d = (await r.json()) as { documentId: string };
  docId = d.documentId;

  if (templatesFolderId) {
    const moveUrl = new URL(`https://www.googleapis.com/drive/v3/files/${docId}`);
    moveUrl.searchParams.set("addParents", templatesFolderId);
    moveUrl.searchParams.set("removeParents", "root");
    moveUrl.searchParams.set("fields", "id");
    await fetch(moveUrl, { method: "PATCH", ...driveAuth });
    console.log(`Created doc in Templates: https://docs.google.com/document/d/${docId}/edit`);
  } else {
    console.log(`Created doc: https://docs.google.com/document/d/${docId}/edit`);
  }
} else {
  console.log(`Updating doc: https://docs.google.com/document/d/${docId}/edit`);
}

// ── Apply style ───────────────────────────────────────────────────────────────

const mdContent = await Deno.readTextFile(
  new URL("../docs/placeholder-guide.md", import.meta.url),
);
await applyDocStyle(docId, token, mdContent);
console.log(`\nDone → https://docs.google.com/document/d/${docId}/edit`);
