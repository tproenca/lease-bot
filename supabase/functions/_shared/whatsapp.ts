// Thin wrapper around the Meta WhatsApp Business Cloud API.
// Sends pre-approved template messages to a recipient's WhatsApp number.
//
// Environment variables required:
//   META_WHATSAPP_TOKEN    — Bearer token for the Meta Graph API
//   META_WHATSAPP_PHONE_ID — Phone number ID for the WhatsApp Business account

import { requireEnv } from "./env.ts";

const META_API_BASE = "https://graph.facebook.com/v19.0";

export interface SendWhatsAppResult {
  ok: boolean;
  error?: string;
}

/**
 * Send a pre-approved WhatsApp template message via the Meta Business Cloud API.
 *
 * - Never throws — always returns `{ ok: boolean, error?: string }`.
 * - Retries once on transient HTTP failures (5xx) or network errors before
 *   returning `{ ok: false, error: "transient_error" }`.
 * - 401/403 responses are not retried and return `{ ok: false, error: "invalid_token" }`.
 * - Other 4xx responses are not retried and return `{ ok: false, error: "client_error" }`.
 */
export async function sendWhatsAppTemplate(params: {
  to: string;
  templateName: string;
  languageCode: string;
  components?: unknown[];
}): Promise<SendWhatsAppResult> {
  const { to, templateName, languageCode, components } = params;

  let token: string;
  let phoneId: string;
  try {
    token = requireEnv("META_WHATSAPP_TOKEN");
    phoneId = requireEnv("META_WHATSAPP_PHONE_ID");
  } catch {
    return { ok: false, error: "transient_error" };
  }

  const url = `${META_API_BASE}/${phoneId}/messages`;
  const body = JSON.stringify({
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      components: components ?? [],
    },
  });

  const attempt = async (): Promise<SendWhatsAppResult> => {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body,
      });
    } catch {
      // Network error — caller will retry once.
      return { ok: false, error: "transient_error" };
    }

    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "invalid_token" };
    }

    if (res.status >= 400 && res.status < 500) {
      return { ok: false, error: "client_error" };
    }

    if (res.status >= 500) {
      return { ok: false, error: "transient_error" };
    }

    return { ok: true };
  };

  const first = await attempt();

  // Retry once on transient errors (5xx or network failures).
  if (!first.ok && first.error === "transient_error") {
    return await attempt();
  }

  return first;
}
