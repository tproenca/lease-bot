// Google OAuth + Drive helpers used by the onboarding flow.
//
// We deliberately keep the surface area small: just what the three onboarding
// endpoints need. Other endpoints (issues 1.4+) will extend this module.

import { requireEnv } from "./env.ts";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";

export const GOOGLE_OAUTH_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive",
].join(" ");

export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  id_token?: string;
  token_type: string;
  scope: string;
}

export function buildGoogleAuthUrl(params: {
  redirectUri: string;
  state: string;
}): string {
  const search = new URLSearchParams({
    client_id: requireEnv("GOOGLE_CLIENT_ID"),
    redirect_uri: params.redirectUri,
    response_type: "code",
    scope: GOOGLE_OAUTH_SCOPES,
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state: params.state,
  });
  return `${GOOGLE_AUTH_URL}?${search.toString()}`;
}

export async function exchangeCodeForTokens(params: {
  code: string;
  redirectUri: string;
}): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    code: params.code,
    client_id: requireEnv("GOOGLE_CLIENT_ID"),
    client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
    redirect_uri: params.redirectUri,
    grant_type: "authorization_code",
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    // Do NOT include the response body in the thrown message — it may contain
    // the authorization code or other sensitive context.
    throw new Error(`google_token_exchange_failed_${res.status}`);
  }
  return await res.json() as GoogleTokenResponse;
}

export async function refreshGoogleAccessToken(
  refreshToken: string,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: requireEnv("GOOGLE_CLIENT_ID"),
    client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    throw new Error(`google_token_refresh_failed_${res.status}`);
  }
  const json = await res.json() as GoogleTokenResponse;
  return json.access_token;
}

export async function fetchGoogleUserInfo(
  accessToken: string,
): Promise<{ email: string; name: string }> {
  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`google_userinfo_failed_${res.status}`);
  }
  const json = await res.json() as {
    email?: string;
    name?: string;
    given_name?: string;
  };
  if (!json.email) throw new Error("google_userinfo_missing_email");
  return {
    email: json.email,
    name: json.name ?? json.given_name ?? json.email,
  };
}

export async function getDriveFolder(params: {
  accessToken: string;
  folderId: string;
}): Promise<{ id: string; name: string; mimeType: string } | null> {
  const url = new URL(`${DRIVE_FILES_URL}/${encodeURIComponent(params.folderId)}`);
  url.searchParams.set("fields", "id,name,mimeType,trashed");
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${params.accessToken}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`drive_get_folder_failed_${res.status}`);
  }
  const json = await res.json() as {
    id: string;
    name: string;
    mimeType: string;
    trashed?: boolean;
  };
  if (json.trashed) return null;
  if (json.mimeType !== "application/vnd.google-apps.folder") return null;
  return { id: json.id, name: json.name, mimeType: json.mimeType };
}

export async function createDriveFolder(params: {
  accessToken: string;
  name: string;
  parentFolderId: string;
}): Promise<string> {
  // Check first whether a folder with this name already exists under the parent.
  // Drive allows duplicate names but we prefer to be idempotent for the
  // onboarding folder.
  const existing = await findDriveFolderByName({
    accessToken: params.accessToken,
    name: params.name,
    parentFolderId: params.parentFolderId,
  });
  if (existing) return existing;

  const res = await fetch(`${DRIVE_FILES_URL}?fields=id`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: params.name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [params.parentFolderId],
    }),
  });
  if (!res.ok) {
    throw new Error(`drive_create_folder_failed_${res.status}`);
  }
  const json = await res.json() as { id: string };
  return json.id;
}

export async function findDriveFolderByName(params: {
  accessToken: string;
  name: string;
  parentFolderId: string;
}): Promise<string | null> {
  const safeName = params.name.replace(/'/g, "\\'");
  const q = [
    `'${params.parentFolderId}' in parents`,
    `name = '${safeName}'`,
    `mimeType = 'application/vnd.google-apps.folder'`,
    `trashed = false`,
  ].join(" and ");
  const url = new URL(DRIVE_FILES_URL);
  url.searchParams.set("q", q);
  url.searchParams.set("fields", "files(id,name)");
  url.searchParams.set("pageSize", "1");

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${params.accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`drive_search_folder_failed_${res.status}`);
  }
  const json = await res.json() as { files: Array<{ id: string }> };
  return json.files[0]?.id ?? null;
}

// Convenience: figure out the absolute redirect URI for /auth/callback.
export function googleRedirectUri(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/auth/callback`;
}

export interface DriveFileMeta {
  id: string;
  name: string;
  modifiedTime: string; // RFC 3339 datetime string
}

/**
 * List all non-trashed files directly inside a Drive folder.
 * Returns id, name, and modifiedTime for each file (not subfolders).
 * Uses pageToken pagination to retrieve all results.
 */
export async function listDriveFilesInFolder(params: {
  accessToken: string;
  folderId: string;
}): Promise<DriveFileMeta[]> {
  const q = [
    `'${params.folderId}' in parents`,
    `mimeType != 'application/vnd.google-apps.folder'`,
    `trashed = false`,
  ].join(" and ");

  const files: DriveFileMeta[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(DRIVE_FILES_URL);
    url.searchParams.set("q", q);
    url.searchParams.set("fields", "nextPageToken,files(id,name,modifiedTime)");
    url.searchParams.set("pageSize", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${params.accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`drive_list_files_failed_${res.status}`);
    }
    const json = await res.json() as {
      nextPageToken?: string;
      files: Array<{ id: string; name: string; modifiedTime: string }>;
    };

    for (const f of json.files ?? []) {
      files.push({ id: f.id, name: f.name, modifiedTime: f.modifiedTime });
    }
    pageToken = json.nextPageToken;
  } while (pageToken);

  return files;
}

/**
 * Star a Google Drive file or folder (sets `starred = true`).
 * Used to highlight the active tenant folder per property.
 */
export async function starDriveFile(params: {
  accessToken: string;
  fileId: string;
}): Promise<void> {
  const url = new URL(
    `${DRIVE_FILES_URL}/${encodeURIComponent(params.fileId)}`,
  );
  url.searchParams.set("fields", "id");
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ starred: true }),
  });
  if (!res.ok) {
    throw new Error(`drive_star_file_failed_${res.status}`);
  }
}

/**
 * Unstar a Google Drive file or folder (sets `starred = false`).
 * Used to de-highlight the previous tenant folder when a new tenant moves in.
 */
export async function unstarDriveFile(params: {
  accessToken: string;
  fileId: string;
}): Promise<void> {
  const url = new URL(
    `${DRIVE_FILES_URL}/${encodeURIComponent(params.fileId)}`,
  );
  url.searchParams.set("fields", "id");
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ starred: false }),
  });
  if (!res.ok) {
    throw new Error(`drive_unstar_file_failed_${res.status}`);
  }
}

/**
 * Upsert the "Guia de Placeholders" Google Doc in the landlord's Templates
 * Drive folder. Creates it if absent; updates content if present.
 *
 * The document is a plain-text file (uploaded as text/plain; Google converts it
 * to a Google Doc via the mimeType hint in the metadata part). Content is sorted
 * alphabetically by placeholder name.
 */
export async function upsertGuiaDePlaceholders(params: {
  accessToken: string;
  templatesFolderId: string;
  placeholders: Array<{
    name: string;
    required: boolean;
    format: string;
    case?: string | null;
    default?: string | null;
    derived_from?: string | null;
    derived_formula?: string | null;
  }>;
}): Promise<void> {
  const { accessToken, templatesFolderId, placeholders } = params;

  // 1. List files in the Templates folder to find "Guia de Placeholders".
  const driveFiles = await listDriveFilesInFolder({
    accessToken,
    folderId: templatesFolderId,
  });
  const guia = driveFiles.find((f) => f.name === "Guia de Placeholders");

  // 2. Build plain-text content sorted by placeholder name.
  const sorted = [...placeholders].sort((a, b) => a.name.localeCompare(b.name));
  const lines: string[] = ["Guia de Placeholders", ""];
  for (const p of sorted) {
    let line = `{{${p.name}}} — format: ${p.format} | required: ${p.required ? "sim" : "não"}`;
    if (p.case != null) line += ` | case: ${p.case}`;
    if (p.default != null) line += ` | default: ${p.default}`;
    if (p.derived_from != null) line += ` | derived_from: ${p.derived_from}`;
    lines.push(line);
  }
  const content = lines.join("\n");

  if (guia) {
    // 3a. File exists — update content in-place via media upload PATCH.
    const patchUrl =
      `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(guia.id)}?uploadType=media`;
    const res = await fetch(patchUrl, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "text/plain",
      },
      body: content,
    });
    if (!res.ok) {
      throw new Error(`drive_guia_update_failed_${res.status}`);
    }
  } else {
    // 3b. File not found — create via multipart upload.
    const boundary = "guia_boundary_lease_assistant";
    const metadata = JSON.stringify({
      name: "Guia de Placeholders",
      mimeType: "application/vnd.google-apps.document",
      parents: [templatesFolderId],
    });
    const body = [
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      metadata,
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "",
      content,
      `--${boundary}--`,
    ].join("\r\n");

    const createUrl =
      `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;
    const res = await fetch(createUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    });
    if (!res.ok) {
      throw new Error(`drive_guia_create_failed_${res.status}`);
    }
  }
}

/**
 * Export a Google Drive file as plain text.
 * For Google Docs (application/vnd.google-apps.document) this uses the
 * export endpoint. For other MIME types the file content is downloaded
 * directly.
 */
export async function exportDriveFileAsText(params: {
  accessToken: string;
  fileId: string;
}): Promise<string> {
  const exportUrl = new URL(
    `${DRIVE_FILES_URL}/${encodeURIComponent(params.fileId)}/export`,
  );
  exportUrl.searchParams.set("mimeType", "text/plain");

  const res = await fetch(exportUrl, {
    headers: { Authorization: `Bearer ${params.accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`drive_export_file_failed_${res.status}`);
  }
  return await res.text();
}
