// POST /setup/complete
//
// Routed from `supabase/functions/setup/index.ts` when the request path ends
// in `/setup/complete`. Kept in its own file per the issue 1.2 spec.
//
// Steps:
//   1. Verify JWT (from Authorization header or session cookie).
//   2. Validate request body shape and field formats.
//   3. Validate the Autentique API key against the real Autentique GraphQL API.
//   4. Refresh the landlord's Google access token from their stored refresh
//      token (set during /auth/callback in auth user metadata).
//   5. Verify the selected root folder exists in their Drive.
//   6. Create (or reuse) the templates folder inside the root folder.
//   7. Insert the landlord row via the service-role client (see
//      specs/SECURITY.md — "Approved Service-Role Key Usage").
//
// Returns: { templates_folder_id }
// Errors follow { error: { code, message } } and never echo raw input back.
//
// CORS: uses strictCorsHeaders() — origin restricted to PUBLIC_FUNCTIONS_BASE_URL
// (or SUPABASE_URL as fallback) to prevent cross-origin mutations from
// arbitrary sites while still supporting the credential cookie.

import { strictCorsHeaders } from "../../_shared/cors.ts";
import {
  createDriveFolder,
  createPlaceholderGuide,
  createSampleContract,
  getDriveFolder,
  refreshGoogleAccessToken,
} from "../../_shared/google.ts";
import { validateAutentiqueApiKey } from "../../_shared/autentique.ts";
import {
  extractBearer,
  getAuthenticatedUser,
  serviceClient,
} from "../../_shared/supabase.ts";
import {
  looksLikeDriveId,
  normalizeBrazilianWhatsapp,
  normalizeTemplatesFolderName,
} from "../../_shared/validation.ts";
import {
  COOKIE_CHATGPT_REDIRECT,
  COOKIE_SESSION,
  COOKIE_SESSION_REFRESH,
  parseCookies,
} from "../../_shared/cookies.ts";
import {
  buildChatgptCallbackUrl,
  parseChatgptRedirectCookie,
} from "../../auth/callback/index.ts";
import { issueOAuthCode } from "../../_shared/oauth-codes.ts";

interface SetupCompleteBody {
  root_folder_id?: unknown;
  templates_folder_name?: unknown;
  whatsapp?: unknown;
  autentique_api_key?: unknown;
  autentique_webhook_secret?: unknown;
}

type StarterDocsResult = {
  guiaDocId?: string;
  contratoDocId?: string;
};

type StarterDocsDeps = {
  createPlaceholderGuide: typeof createPlaceholderGuide;
  createSampleContract: typeof createSampleContract;
  warn: typeof console.warn;
};

export async function createStarterDocsForSetup(
  params: {
    accessToken: string;
    templatesFolderId: string;
    logPrefix?: string;
  },
  deps: StarterDocsDeps = {
    createPlaceholderGuide,
    createSampleContract,
    warn: console.warn,
  },
): Promise<StarterDocsResult> {
  const result: StarterDocsResult = {};
  const logPrefix = params.logPrefix ?? "setup/complete";

  try {
    result.guiaDocId = await deps.createPlaceholderGuide({
      accessToken: params.accessToken,
      templatesFolderId: params.templatesFolderId,
    });
  } catch (err) {
    deps.warn(`${logPrefix}: Guia de Placeholders creation failed`, err);
  }

  try {
    result.contratoDocId = await deps.createSampleContract({
      accessToken: params.accessToken,
      templatesFolderId: params.templatesFolderId,
    });
  } catch (err) {
    deps.warn(
      `${logPrefix}: Contrato de Locação Residencial (Exemplo) creation failed`,
      err,
    );
  }

  return result;
}

export async function handleSetupComplete(req: Request): Promise<Response> {
  // Compute once so all responses in this handler share consistent CORS headers.
  const cors = strictCorsHeaders();

  // Helpers scoped to this request so they inherit `cors`.
  function errResp(
    status: number,
    code: string,
    message: string,
  ): Response {
    return new Response(
      JSON.stringify({ error: { code, message } }),
      { status, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }

  function okResp(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // 1. JWT verification — accept either Authorization: Bearer or session cookie.
  const cookies = parseCookies(req.headers.get("cookie"));
  const jwt = extractBearer(req) ?? cookies[COOKIE_SESSION];
  if (!jwt) {
    return errResp(
      401,
      "UNAUTHORIZED",
      "Sessão não encontrada. Faça login novamente.",
    );
  }
  const user = await getAuthenticatedUser(jwt);
  if (!user) {
    return errResp(
      401,
      "UNAUTHORIZED",
      "Sessão inválida. Faça login novamente.",
    );
  }

  // 2. Parse + validate body.
  let body: SetupCompleteBody;
  try {
    body = await req.json() as SetupCompleteBody;
  } catch {
    return errResp(400, "INVALID_JSON", "Corpo da requisição inválido.");
  }

  const rootFolderId = body.root_folder_id;
  const templatesFolderName = normalizeTemplatesFolderName(
    body.templates_folder_name,
  );
  const whatsapp = normalizeBrazilianWhatsapp(body.whatsapp);
  // sanitizeApiKey is defined below — validates bounds + encoding before use.
  const apiKey = sanitizeApiKey(body.autentique_api_key);
  // sanitizeWebhookSecret applies the same bounds + encoding rules as the
  // API key sanitizer: opaque token, must be safe to use as the HMAC key
  // and to store in the DB without smuggling control characters.
  const webhookSecret = sanitizeWebhookSecret(body.autentique_webhook_secret);

  if (!looksLikeDriveId(rootFolderId)) {
    return errResp(
      400,
      "INVALID_ROOT_FOLDER",
      "Selecione a pasta raiz do Google Drive.",
    );
  }
  if (!templatesFolderName) {
    return errResp(
      400,
      "INVALID_TEMPLATES_FOLDER_NAME",
      "Nome da pasta de modelos inválido.",
    );
  }
  if (!whatsapp) {
    return errResp(
      400,
      "INVALID_WHATSAPP",
      "Número de WhatsApp inválido. Use o formato +55 seguido do DDD e número.",
    );
  }
  if (!apiKey) {
    return errResp(
      400,
      "MISSING_AUTENTIQUE_KEY",
      "Informe sua chave de API da Autentique.",
    );
  }
  if (!webhookSecret) {
    return errResp(
      400,
      "MISSING_AUTENTIQUE_WEBHOOK_SECRET",
      "Informe o Endpoint Secret do webhook da Autentique.",
    );
  }

  // 3. Check Google refresh token before making any external API calls.
  //    Stored in app_metadata (admin-only) by /auth/callback and /oauth/token.
  const refreshToken =
    (user.app_metadata.google_refresh_token as string | undefined) ??
      undefined;
  if (!refreshToken) {
    return errResp(
      400,
      "MISSING_GOOGLE_TOKEN",
      "Conexão com o Google não encontrada. Refaça o login com o Google.",
    );
  }

  // 4. Validate Autentique API key.
  const autentique = await validateAutentiqueApiKey(apiKey);
  if (!autentique.ok) {
    return errResp(
      400,
      "INVALID_AUTENTIQUE_KEY",
      "Chave de API da Autentique inválida. Verifique em autentique.com.br → Configurações → Tokens de API.",
    );
  }

  // 5. Refresh Google access token.
  let accessToken: string;
  try {
    accessToken = await refreshGoogleAccessToken(refreshToken);
  } catch {
    return errResp(
      502,
      "GOOGLE_TOKEN_REFRESH_FAILED",
      "Não foi possível renovar o acesso ao Google Drive. Tente novamente.",
    );
  }

  // 5. Verify root folder exists in Drive.
  let rootFolder: { id: string; name: string } | null;
  try {
    rootFolder = await getDriveFolder({
      accessToken,
      folderId: rootFolderId as string,
    });
  } catch {
    return errResp(
      502,
      "DRIVE_LOOKUP_FAILED",
      "Não foi possível consultar o Google Drive. Tente novamente.",
    );
  }
  if (!rootFolder) {
    return errResp(
      400,
      "ROOT_FOLDER_NOT_FOUND",
      "Pasta raiz não encontrada no seu Google Drive.",
    );
  }

  // 6. Create (or reuse) templates folder.
  let templatesFolderId: string;
  try {
    templatesFolderId = await createDriveFolder({
      accessToken,
      name: templatesFolderName,
      parentFolderId: rootFolderId as string,
    });
  } catch {
    return errResp(
      502,
      "DRIVE_CREATE_FAILED",
      "Não foi possível criar a pasta de modelos no Google Drive.",
    );
  }

  // 7. Insert landlord row using the service-role client.
  //    Rationale for service-role bypass: see specs/SECURITY.md §
  //    "Approved Service-Role Key Usage" — the landlord row does not yet exist,
  //    so RLS cannot grant the insert. We bind id = user.id (from the verified
  //    JWT) so the row is owned by the authenticated user from this point on.
  const svc = serviceClient();
  const { error: insertError } = await svc.from("landlords").insert({
    id: user.id,
    email: user.email,
    name: (user.user_metadata.full_name as string | undefined) ??
      (user.user_metadata.name as string | undefined) ??
      user.email,
    whatsapp,
    google_refresh_token: refreshToken,
    autentique_api_key: apiKey,
    autentique_webhook_secret: webhookSecret,
    root_folder_id: rootFolderId,
    templates_folder_id: templatesFolderId,
  });
  if (insertError) {
    // Unique violation on primary key — onboarding already complete.
    // Make the endpoint idempotent: return the existing templates_folder_id.
    if ((insertError as { code?: string }).code === "23505") {
      const { data: existing } = await svc
        .from("landlords")
        .select("templates_folder_id")
        .eq("id", user.id)
        .maybeSingle();
      if (existing) {
        // Also (re-)create starter docs so the response can link what worked.
        const starterDocs = await createStarterDocsForSetup({
          accessToken,
          templatesFolderId: existing.templates_folder_id as string,
          logPrefix: "setup/complete 23505 path",
        });
        return okResp({
          templates_folder_id: existing.templates_folder_id,
          guia_doc_id: starterDocs.guiaDocId,
          contrato_doc_id: starterDocs.contratoDocId,
        });
      }
    }
    return errResp(
      500,
      "LANDLORD_INSERT_FAILED",
      "Não foi possível concluir o cadastro. Tente novamente.",
    );
  }

  // 8. Create starter docs in the Templates folder.
  //    Non-fatal: if Drive calls fail here, the landlord row already exists and
  //    setup is complete — we just won't have a doc ID to link to.
  const starterDocs = await createStarterDocsForSetup({
    accessToken,
    templatesFolderId,
  });

  // 9. Integrated OAuth flow: if a ChatGPT redirect cookie is present, issue a
  //    one-time code and return redirect_to so the JS form handler can close the
  //    OAuth window by navigating to the ChatGPT callback URL.
  //    The Supabase refresh_token was stored in COOKIE_SESSION_REFRESH by
  //    /auth/callback so we don't need to re-create the session here.
  const chatgptInfo = parseChatgptRedirectCookie(
    cookies[COOKIE_CHATGPT_REDIRECT],
  );
  const sessionRefreshToken = cookies[COOKIE_SESSION_REFRESH];
  if (chatgptInfo && sessionRefreshToken) {
    try {
      const oneTimeCode = await issueOAuthCode({
        accessToken: jwt,
        refreshToken: sessionRefreshToken,
      });
      const redirectTo = buildChatgptCallbackUrl(
        chatgptInfo.redirect_uri,
        oneTimeCode,
        chatgptInfo.state,
      );
      return okResp({
        templates_folder_id: templatesFolderId,
        guia_doc_id: starterDocs.guiaDocId,
        contrato_doc_id: starterDocs.contratoDocId,
        redirect_to: redirectTo,
      });
    } catch {
      // Non-fatal: fall through to normal response. The GPT will receive a 404
      // from getContext and instruct the landlord to re-authenticate.
    }
  }

  return okResp({
    templates_folder_id: templatesFolderId,
    guia_doc_id: starterDocs.guiaDocId,
    contrato_doc_id: starterDocs.contratoDocId,
  });
}

// ─── Input sanitization helpers ────────────────────────────────────────────

/**
 * Sanitize an Autentique API key before any use.
 *
 * Rules (per reviewer item 6):
 *   - Must be a non-empty string.
 *   - Minimum 10 characters (as before).
 *   - Maximum 256 characters (upper bound to prevent oversized inputs).
 *   - No ASCII control characters (0x00–0x1F, 0x7F) — these could inject
 *     CRLF sequences into HTTP headers (Bearer <key>).
 *   - No internal whitespace — Autentique API keys are opaque tokens and
 *     should never contain spaces or tabs.
 *
 * Returns the trimmed key on success, or null if any constraint fails.
 */
export function sanitizeApiKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Check control characters on the raw value before trimming — a trailing
  // \r is a sign of header injection, not accidental whitespace.
  // deno-lint-ignore no-control-regex
  if (/[\x00-\x1F\x7F]/.test(raw)) return null;
  const trimmed = raw.trim();
  if (trimmed.length < 10 || trimmed.length > 256) return null;
  // Reject internal whitespace (space, non-breaking space, etc.)
  if (/\s/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Sanitize an Autentique webhook Endpoint Secret before any use.
 *
 * Same rules as `sanitizeApiKey`: the secret is an opaque token generated by
 * Autentique on webhook creation. We never embed it in an HTTP header (it is
 * only used as the HMAC-SHA256 key for signature verification), but we apply
 * the same bounds + encoding rules to keep DB rows free of control characters
 * and to fail fast on obviously malformed inputs.
 *
 * Returns the trimmed secret on success, or null if any constraint fails.
 */
export function sanitizeWebhookSecret(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // deno-lint-ignore no-control-regex
  if (/[\x00-\x1F\x7F]/.test(raw)) return null;
  const trimmed = raw.trim();
  if (trimmed.length < 10 || trimmed.length > 256) return null;
  if (/\s/.test(trimmed)) return null;
  return trimmed;
}
