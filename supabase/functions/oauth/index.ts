// OAuth proxy function — entry point that routes /oauth/authorize and /oauth/token.
//
// This Edge Function is mounted at /functions/v1/oauth. It provides thin proxy
// endpoints so that the GPT OAuth action's Authorization URL, Token URL, and
// API server all share the same root domain (required by OpenAI). See issue #53
// and ADR-0014.

import { errorResponse } from "../_shared/errors.ts";
import { handleOAuthAuthorize } from "./authorize/index.ts";
import { handleOAuthToken } from "./token/index.ts";

Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const pathname = url.pathname.replace(/\/+$/, "");

  if (pathname.endsWith("/oauth/authorize")) {
    return await handleOAuthAuthorize(req);
  }
  if (pathname.endsWith("/oauth/token")) {
    return await handleOAuthToken(req);
  }
  return errorResponse(404, "NOT_FOUND", "Rota não encontrada.");
});
