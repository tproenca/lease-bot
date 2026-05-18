// Auth function — entry point that routes /auth/callback.
//
// This Edge Function is mounted at /functions/v1/auth. The only sub-route is
// /auth/callback, implemented in ./callback/index.ts.

import { corsHeaders } from "../_shared/cors.ts";
import { errorResponse } from "../_shared/errors.ts";
import { handleAuthCallback } from "./callback/index.ts";

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  const url = new URL(req.url);
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/auth/callback")) {
    return await handleAuthCallback(req);
  }
  return errorResponse(404, "NOT_FOUND", "Rota não encontrada.");
});
