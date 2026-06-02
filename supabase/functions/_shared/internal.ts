// Internal invocation helper.
//
// Constructs a synthetic Request that mimics an in-process call to another
// Edge Function handler, forwarding the caller's JWT and an optional JSON
// body. The handler is called directly (no HTTP hop) and the response body
// is parsed as JSON.
//
// Usage:
//   const { status, body } = await invokeHandler(handleContext, {
//     method: "GET",
//     path: "/context",
//     jwt: callerJwt,
//   });
//
//   const { status, body } = await invokeHandler(handleTenants, {
//     method: "POST",
//     path: "/tenants",
//     jwt: callerJwt,
//     body: { property_id, name, cpf, whatsapp },
//   });

export interface InvokeOptions {
  method: string;
  path: string;
  jwt: string;
  body?: unknown;
}

export interface InvokeResult {
  status: number;
  body: unknown;
}

/**
 * Call an exported Edge Function handler with a synthetic Request.
 *
 * - URL is constructed as `https://internal/<path>` (the host is irrelevant
 *   because handlers only inspect `req.url` for routing purposes).
 * - Authorization header carries the caller's JWT.
 * - JSON body is serialised when provided.
 *
 * @param handler  Exported async function that accepts a Request and returns
 *                 a Response (the standard Edge Function signature).
 * @param opts     method, path, jwt, and optional body.
 * @returns        { status, body } where body is the parsed JSON response.
 */
export async function invokeHandler(
  handler: (req: Request) => Promise<Response>,
  opts: InvokeOptions,
): Promise<InvokeResult> {
  const { method, path, jwt, body } = opts;

  const url = `https://internal${path}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${jwt}`,
  };

  let bodyInit: string | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyInit = JSON.stringify(body);
  }

  const req = new Request(url, {
    method,
    headers,
    body: bodyInit,
  });

  const res = await handler(req);
  const responseBody = await res.json();

  return { status: res.status, body: responseBody };
}
