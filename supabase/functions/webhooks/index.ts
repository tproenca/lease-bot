import { handleAutentiqueWebhook } from "./autentique/index.ts";

Deno.serve(handleAutentiqueWebhook);
