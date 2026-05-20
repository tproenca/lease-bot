// GET /templates/diff
//
// Detects changes to the landlord's Google Drive templates since last sync.
//
// Fast path (< 200 ms target):
//   If all templates' Drive modifiedTime matches the cached drive_last_modified_at
//   in the DB, return 200 with all-empty diff arrays immediately — no Drive file
//   reads are performed.
//
// Slow path (changed templates only):
//   For each template whose modifiedTime changed, export the file as plain text
//   from Drive, extract {{placeholder}} tokens and witness names from signature
//   blocks, compute added/removed diffs against the DB-cached placeholder_names,
//   and update the DB cache.
//
// Special rules:
//   - Templates named exactly "Guia de Placeholders" are always excluded.
//   - Witness names come only from changed templates' signature blocks.
//   - Unchanged templates' placeholders come from the DB cache.
//
// Auth: Bearer JWT → RLS enforces landlord isolation on all DB queries.
// No service-role key is used.

import { corsHeaders } from "../../_shared/cors.ts";
import { errorResponse } from "../../_shared/errors.ts";
import {
  extractBearer,
  getAuthenticatedUser,
  userClient,
} from "../../_shared/supabase.ts";
import {
  exportDriveFileAsText,
  listDriveFilesInFolder,
  refreshGoogleAccessToken,
} from "../../_shared/google.ts";

const GUIA_EXACT_NAME = "Guia de Placeholders";

// ── Placeholder extraction ────────────────────────────────────────────────

/**
 * Extract all unique {{token}} placeholder names from document text.
 * Returns names in sorted order for stable comparison.
 */
export function extractPlaceholders(text: string): string[] {
  const re = /\{\{([^}]+)\}\}/g;
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1].trim();
    if (name.length > 0) names.add(name);
  }
  return [...names].sort();
}

// ── Witness extraction ────────────────────────────────────────────────────

/**
 * Extract witness names from signature blocks in document text.
 *
 * A signature block is a line consisting only of underscores (at least 5).
 * The witness name is the next non-empty line following such a line.
 * Names that look like placeholder tokens (contain {{ or }}) are skipped.
 */
export function extractWitnessNames(text: string): string[] {
  const UNDERSCORE_LINE = /^_+$/;
  const PLACEHOLDER_TOKEN = /\{\{|\}\}/;
  const lines = text.split("\n").map((l) => l.trim());
  const names: string[] = [];

  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].length >= 5 && UNDERSCORE_LINE.test(lines[i])) {
      // Scan forward for the first non-empty line after the underscore line.
      for (let j = i + 1; j < lines.length; j++) {
        const candidate = lines[j];
        if (candidate.length === 0) continue;
        if (!PLACEHOLDER_TOKEN.test(candidate)) {
          names.push(candidate);
        }
        break;
      }
    }
  }

  return names;
}

// ── Handler ───────────────────────────────────────────────────────────────

export async function handleTemplatesDiff(req: Request): Promise<Response> {
  // Handle CORS preflight.
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Only GET is accepted.
  if (req.method !== "GET") {
    return errorResponse(405, "METHOD_NOT_ALLOWED", "Método não permitido.");
  }

  // 1. Verify JWT.
  const jwt = extractBearer(req);
  if (!jwt) {
    return errorResponse(
      401,
      "UNAUTHORIZED",
      "Token de autorização não encontrado.",
    );
  }

  const user = await getAuthenticatedUser(jwt);
  if (!user) {
    return errorResponse(
      401,
      "UNAUTHORIZED",
      "Token de autorização inválido ou expirado.",
    );
  }

  // 2. Load all templates + landlord data using the user-scoped client so RLS
  //    restricts every query to this landlord's rows automatically.
  const db = userClient(jwt);

  const [templatesResult, landlordResult] = await Promise.all([
    db
      .from("templates")
      .select(
        "id, name, drive_file_id, drive_last_modified_at, placeholder_names",
      ),
    db
      .from("landlords")
      .select("google_refresh_token, templates_folder_id")
      .eq("id", user.id)
      .maybeSingle(),
  ]);

  if (templatesResult.error) {
    return errorResponse(500, "DB_ERROR", "Erro ao carregar templates.");
  }
  if (landlordResult.error || !landlordResult.data) {
    return errorResponse(
      404,
      "LANDLORD_NOT_FOUND",
      "Cadastro do proprietário não encontrado. Conclua o processo de configuração.",
    );
  }

  const landlord = landlordResult.data as {
    google_refresh_token: string;
    templates_folder_id: string;
  };

  // 3. Exclude "Guia de Placeholders" by exact name match.
  type TemplateRow = {
    id: string;
    name: string;
    drive_file_id: string;
    drive_last_modified_at: string;
    placeholder_names: string[];
  };
  const allTemplates = (templatesResult.data ?? []) as TemplateRow[];
  const templates = allTemplates.filter((t) => t.name !== GUIA_EXACT_NAME);

  // 4. Obtain a fresh Google access token — needed to list Drive files.
  let accessToken: string;
  try {
    accessToken = await refreshGoogleAccessToken(landlord.google_refresh_token);
  } catch {
    return errorResponse(
      502,
      "GOOGLE_AUTH_FAILED",
      "Falha ao autenticar com o Google Drive. Tente novamente.",
    );
  }

  // 5. Fetch file metadata from Drive to compare modifiedTime values.
  let driveFiles: Array<{ id: string; name: string; modifiedTime: string }>;
  try {
    driveFiles = await listDriveFilesInFolder({
      accessToken,
      folderId: landlord.templates_folder_id,
    });
  } catch {
    return errorResponse(
      502,
      "DRIVE_LIST_FAILED",
      "Falha ao listar templates no Google Drive. Tente novamente.",
    );
  }

  // Build lookups for Drive vs DB comparison.
  const driveModifiedMap = new Map<string, string>(
    driveFiles.map((f) => [f.id, f.modifiedTime]),
  );
  const driveFileIds = new Set(driveFiles.map((f) => f.id));
  const dbFileIds = new Set(templates.map((t) => t.drive_file_id));

  // Compute template-level diff (Drive files not in DB, and DB rows gone from Drive).
  const addedTemplates = driveFiles
    .filter((f) => !dbFileIds.has(f.id) && f.name !== GUIA_EXACT_NAME)
    .map((f) => f.name)
    .sort();
  const removedTemplates = templates
    .filter((t) => !driveFileIds.has(t.drive_file_id))
    .map((t) => t.name)
    .sort();

  // 6. Determine which DB templates have a changed modifiedTime.
  //    Skip templates whose Drive file is gone (they appear in removedTemplates).
  const changedTemplates = templates.filter((t) => {
    const driveTime = driveModifiedMap.get(t.drive_file_id);
    if (!driveTime) return false;
    return driveTime !== t.drive_last_modified_at;
  });

  // Fast path: no template-level changes and no content changes.
  if (
    addedTemplates.length === 0 &&
    removedTemplates.length === 0 &&
    changedTemplates.length === 0
  ) {
    return new Response(
      JSON.stringify({
        templates: { added: [], removed: [] },
        placeholders: { added: [], removed: [] },
        witnesses: { added: [] },
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  // Slow path: process each changed template.
  const allAddedPlaceholders = new Set<string>();
  const allRemovedPlaceholders = new Set<string>();
  const allWitnessNames = new Set<string>();

  for (const tmpl of changedTemplates) {
    // Export file content as plain text.
    let text: string;
    try {
      text = await exportDriveFileAsText({
        accessToken,
        fileId: tmpl.drive_file_id,
      });
    } catch {
      return errorResponse(
        502,
        "DRIVE_EXPORT_FAILED",
        "Falha ao ler conteúdo do template no Google Drive. Tente novamente.",
      );
    }

    // Extract new placeholder list and compute diff.
    const newPlaceholders = extractPlaceholders(text);
    const oldPlaceholders = tmpl.placeholder_names ?? [];

    const oldSet = new Set(oldPlaceholders);
    const newSet = new Set(newPlaceholders);

    for (const p of newPlaceholders) {
      if (!oldSet.has(p)) allAddedPlaceholders.add(p);
    }
    for (const p of oldPlaceholders) {
      if (!newSet.has(p)) allRemovedPlaceholders.add(p);
    }

    // Extract witness names from signature blocks.
    const witnesses = extractWitnessNames(text);
    for (const w of witnesses) allWitnessNames.add(w);

    // Update DB cache: drive_last_modified_at and placeholder_names.
    const newModifiedTime = driveModifiedMap.get(tmpl.drive_file_id)!;
    const { error: updateError } = await db
      .from("templates")
      .update({
        drive_last_modified_at: newModifiedTime,
        placeholder_names: newPlaceholders,
      })
      .eq("id", tmpl.id);

    if (updateError) {
      return errorResponse(
        500,
        "DB_ERROR",
        "Erro ao atualizar cache do template. Tente novamente.",
      );
    }
  }

  return new Response(
    JSON.stringify({
      templates: { added: addedTemplates, removed: removedTemplates },
      placeholders: {
        added: [...allAddedPlaceholders].sort(),
        removed: [...allRemovedPlaceholders].sort(),
      },
      witnesses: { added: [...allWitnessNames].sort() },
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
}

if (import.meta.main) Deno.serve(handleTemplatesDiff);
