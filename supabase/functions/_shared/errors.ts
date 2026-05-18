// Structured error helpers. Per specs/SECURITY.md, error responses must never
// echo raw user input. Callers should pass safe, static Portuguese messages.

import { corsHeaders } from "./cors.ts";

export interface ApiError {
  code: string;
  message: string;
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  const body: { error: ApiError } = { error: { code, message } };
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
