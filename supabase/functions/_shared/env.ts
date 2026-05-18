// Strict environment variable accessor. Throws if a required secret is missing
// rather than failing later with a confusing runtime error.

export function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getEnv(name: string): string | undefined {
  return Deno.env.get(name);
}

// Public base URL for building Google OAuth redirect URIs and post-auth
// redirects. Defaults to the local Supabase functions URL.
export function publicFunctionsBaseUrl(): string {
  return (
    getEnv("PUBLIC_FUNCTIONS_BASE_URL") ??
    `${getEnv("SUPABASE_URL") ?? "http://localhost:54321"}/functions/v1`
  );
}
