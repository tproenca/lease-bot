// Thin wrapper around the Autentique GraphQL API. Only the operations needed
// for onboarding live here; signing/webhook flows extend this module.

const AUTENTIQUE_GRAPHQL_URL = "https://api.autentique.com.br/v2/graphql";

export interface AutentiqueValidationResult {
  ok: boolean;
  // Present only when ok === true. We never return it to the client; it's just
  // used internally by callers that want to log a non-PII success signal.
  accountName?: string;
}

/**
 * Validate an Autentique API key by making a real GraphQL test call.
 *
 * Input bounds enforced before any network call (defence-in-depth — callers
 * should also validate before passing the key here):
 *   - Non-empty string, 10–256 characters.
 *   - No ASCII control characters (0x00–0x1F, 0x7F) — prevents HTTP header
 *     injection when the key is used in `Authorization: Bearer <key>`.
 *   - No internal whitespace — Autentique tokens are opaque and must not
 *     contain spaces.
 *
 * Returns `{ ok: true }` only when the API returns a valid `me { name }` response.
 */
export async function validateAutentiqueApiKey(
  apiKey: string,
): Promise<AutentiqueValidationResult> {
  // Input bounds check — must pass before we put this string in an HTTP header.
  if (typeof apiKey !== "string") return { ok: false };
  const trimmed = apiKey.trim();
  if (trimmed.length < 10 || trimmed.length > 256) return { ok: false };
  // deno-lint-ignore no-control-regex
  if (/[\x00-\x1F\x7F]/.test(trimmed)) return { ok: false };
  if (/\s/.test(trimmed)) return { ok: false };

  let res: Response;
  try {
    res = await fetch(AUTENTIQUE_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${trimmed}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query: "{ me { name } }" }),
    });
  } catch {
    return { ok: false };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false };
  }
  if (!res.ok) {
    return { ok: false };
  }
  let json: {
    data?: { me?: { name?: string } | null } | null;
    errors?: unknown;
  };
  try {
    json = await res.json();
  } catch {
    return { ok: false };
  }
  if (json.errors || !json.data?.me?.name) {
    return { ok: false };
  }
  return { ok: true, accountName: json.data.me.name };
}
