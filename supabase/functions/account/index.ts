// Account function — entry point that routes /account/config.
//
// This Edge Function is mounted at /functions/v1/account. The only sub-route
// is /account/config, implemented in ./config/index.ts.

import { corsHeaders } from "../_shared/cors.ts";
import { errorResponse } from "../_shared/errors.ts";
import { handleAccountConfig } from "./config/index.ts";

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  const url = new URL(req.url);
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/account/config")) {
    return await handleAccountConfig(req);
  }
  return errorResponse(404, "NOT_FOUND", "Rota não encontrada.");
});
