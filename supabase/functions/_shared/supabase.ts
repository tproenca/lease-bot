// Supabase client factories.
//
// `serviceClient()` uses the service-role key and BYPASSES Row Level Security.
// Per specs/SECURITY.md it must only be used for narrowly-scoped operations
// where the Edge Function itself enforces landlord_id scoping. The onboarding
// flow is one of those cases: the landlord row does not yet exist, so RLS
// cannot identify it.
//
// `userClient()` carries the caller's JWT and is subject to RLS — use this for
// any request handler that operates on already-authenticated landlord rows.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireEnv } from "./env.ts";

export function serviceClient(): SupabaseClient {
  return createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}

export function anonClient(): SupabaseClient {
  return createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_ANON_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

export function userClient(jwt: string): SupabaseClient {
  return createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_ANON_KEY"),
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    },
  );
}

export function extractBearer(req: Request): string | null {
  const auth = req.headers.get("Authorization") ??
    req.headers.get("authorization");
  if (!auth) return null;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export async function getAuthenticatedUser(
  jwt: string,
): Promise<
  { id: string; email: string; user_metadata: Record<string, unknown> } | null
> {
  const client = createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_ANON_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data, error } = await client.auth.getUser(jwt);
  if (error || !data.user || !data.user.email) return null;
  return {
    id: data.user.id,
    email: data.user.email,
    user_metadata: (data.user.user_metadata ?? {}) as Record<string, unknown>,
  };
}
