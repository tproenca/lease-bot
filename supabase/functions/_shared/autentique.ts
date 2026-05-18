// Thin wrapper around the Autentique GraphQL API. Only the operations needed
// for onboarding live here; signing/webhook flows extend this module.

const AUTENTIQUE_GRAPHQL_URL = "https://api.autentique.com.br/v2/graphql";

export interface AutentiqueValidationResult {
  ok: boolean;
  // Present only when ok === true. We never return it to the client; it's just
  // used internally by callers that want to log a non-PII success signal.
  accountName?: string;
}

export async function validateAutentiqueApiKey(
  apiKey: string,
): Promise<AutentiqueValidationResult> {
  // Sanity check before issuing any network call.
  if (typeof apiKey !== "string" || apiKey.trim().length < 10) {
    return { ok: false };
  }

  let res: Response;
  try {
    res = await fetch(AUTENTIQUE_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
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
