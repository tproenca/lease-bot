// Structured error helpers. Per specs/SECURITY.md, error responses must never
// echo raw user input. Callers should pass safe, static Portuguese messages.

import { corsHeaders } from "./cors.ts";

export interface ApiError {
  code: string;
  message: string;
}

/**
 * Build a structured JSON error response.
 *
 * @param status  HTTP status code.
 * @param code    Machine-readable error code (e.g. "INVALID_WHATSAPP").
 * @param message Human-readable Portuguese message shown to the user.
 * @param extraHeaders Optional CORS / other headers to merge in. Callers that
 *   require strict CORS (e.g. POST /setup/complete) should pass
 *   `strictCorsHeaders()` here.
 */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  extraHeaders?: Record<string, string>,
): Response {
  const body: { error: ApiError } = { error: { code, message } };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      ...(extraHeaders ?? {}),
      "Content-Type": "application/json",
    },
  });
}
