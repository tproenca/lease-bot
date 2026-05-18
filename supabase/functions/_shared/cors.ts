// Shared CORS headers for browser-served Edge Functions.
// The setup HTML page is served from the same origin as the function, so CORS
// is strictly required only for the JSON `POST /setup/complete` endpoint when
// the page is hosted elsewhere. We expose a permissive default to keep local
// development simple; tighten in production via Supabase project settings.

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
