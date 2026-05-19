// unit: _shared/whatsapp.ts — sendWhatsAppTemplate (all network calls mocked)
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { sendWhatsAppTemplate } from "./whatsapp.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const _originalFetch = globalThis.fetch;

/** Restore fetch and unset env vars set by a test. */
function restoreFetch() {
  globalThis.fetch = _originalFetch;
}

/** Set the required env vars for the duration of a test. */
function setEnv() {
  Deno.env.set("META_WHATSAPP_TOKEN", "test-token-abc123");
  Deno.env.set("META_WHATSAPP_PHONE_ID", "1234567890");
}

/** Clear the required env vars after a test. */
function clearEnv() {
  Deno.env.delete("META_WHATSAPP_TOKEN");
  Deno.env.delete("META_WHATSAPP_PHONE_ID");
}

const defaultParams = {
  to: "+5511999999999",
  templateName: "payment_reminder",
  languageCode: "pt_BR",
};

// ─── Tests ────────────────────────────────────────────────────────────────────

Deno.test("unit: sendWhatsAppTemplate — success returns ok:true", async () => {
  setEnv();
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ messages: [{ id: "wamid.abc" }] }),
        { status: 200 },
      ),
    );

  const result = await sendWhatsAppTemplate(defaultParams);

  restoreFetch();
  clearEnv();

  assertEquals(result.ok, true);
  assertEquals(result.error, undefined);
});

Deno.test("unit: sendWhatsAppTemplate — success includes optional components", async () => {
  setEnv();
  let capturedBody: unknown;
  globalThis.fetch = (_url: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(init?.body as string);
    return Promise.resolve(
      new Response(JSON.stringify({}), { status: 200 }),
    );
  };

  const components = [{
    type: "body",
    parameters: [{ type: "text", text: "R$ 1.500,00" }],
  }];
  const result = await sendWhatsAppTemplate({ ...defaultParams, components });

  restoreFetch();
  clearEnv();

  assertEquals(result.ok, true);
  assertEquals(
    (capturedBody as { template: { components: unknown[] } }).template
      .components,
    components,
  );
});

Deno.test("unit: sendWhatsAppTemplate — omitted components defaults to []", async () => {
  setEnv();
  let capturedBody: unknown;
  globalThis.fetch = (_url: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(init?.body as string);
    return Promise.resolve(
      new Response(JSON.stringify({}), { status: 200 }),
    );
  };

  const result = await sendWhatsAppTemplate(defaultParams);

  restoreFetch();
  clearEnv();

  assertEquals(result.ok, true);
  assertEquals(
    (capturedBody as { template: { components: unknown[] } }).template
      .components,
    [],
  );
});

Deno.test("unit: sendWhatsAppTemplate — 401 returns invalid_token without retry", async () => {
  setEnv();
  let callCount = 0;
  globalThis.fetch = () => {
    callCount++;
    return Promise.resolve(new Response(JSON.stringify({}), { status: 401 }));
  };

  const result = await sendWhatsAppTemplate(defaultParams);

  restoreFetch();
  clearEnv();

  assertEquals(result.ok, false);
  assertEquals(result.error, "invalid_token");
  // Must NOT have retried.
  assertEquals(callCount, 1);
});

Deno.test("unit: sendWhatsAppTemplate — 403 returns invalid_token without retry", async () => {
  setEnv();
  let callCount = 0;
  globalThis.fetch = () => {
    callCount++;
    return Promise.resolve(new Response(JSON.stringify({}), { status: 403 }));
  };

  const result = await sendWhatsAppTemplate(defaultParams);

  restoreFetch();
  clearEnv();

  assertEquals(result.ok, false);
  assertEquals(result.error, "invalid_token");
  assertEquals(callCount, 1);
});

Deno.test("unit: sendWhatsAppTemplate — 400 returns client_error without retry", async () => {
  setEnv();
  let callCount = 0;
  globalThis.fetch = () => {
    callCount++;
    return Promise.resolve(new Response(JSON.stringify({}), { status: 400 }));
  };

  const result = await sendWhatsAppTemplate(defaultParams);

  restoreFetch();
  clearEnv();

  assertEquals(result.ok, false);
  assertEquals(result.error, "client_error");
  assertEquals(callCount, 1);
});

Deno.test("unit: sendWhatsAppTemplate — 422 returns client_error without retry", async () => {
  setEnv();
  let callCount = 0;
  globalThis.fetch = () => {
    callCount++;
    return Promise.resolve(new Response(JSON.stringify({}), { status: 422 }));
  };

  const result = await sendWhatsAppTemplate(defaultParams);

  restoreFetch();
  clearEnv();

  assertEquals(result.ok, false);
  assertEquals(result.error, "client_error");
  assertEquals(callCount, 1);
});

Deno.test("unit: sendWhatsAppTemplate — 5xx retries once and succeeds on retry", async () => {
  setEnv();
  let callCount = 0;
  globalThis.fetch = () => {
    callCount++;
    if (callCount === 1) {
      return Promise.resolve(new Response(JSON.stringify({}), { status: 503 }));
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
  };

  const result = await sendWhatsAppTemplate(defaultParams);

  restoreFetch();
  clearEnv();

  assertEquals(result.ok, true);
  assertEquals(callCount, 2);
});

Deno.test("unit: sendWhatsAppTemplate — 5xx retries once and returns transient_error on second failure", async () => {
  setEnv();
  let callCount = 0;
  globalThis.fetch = () => {
    callCount++;
    return Promise.resolve(new Response(JSON.stringify({}), { status: 500 }));
  };

  const result = await sendWhatsAppTemplate(defaultParams);

  restoreFetch();
  clearEnv();

  assertEquals(result.ok, false);
  assertEquals(result.error, "transient_error");
  // Exactly two attempts: the original + one retry.
  assertEquals(callCount, 2);
});

Deno.test("unit: sendWhatsAppTemplate — network error retries once and succeeds on retry", async () => {
  setEnv();
  let callCount = 0;
  globalThis.fetch = () => {
    callCount++;
    if (callCount === 1) {
      return Promise.reject(new TypeError("network failure"));
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
  };

  const result = await sendWhatsAppTemplate(defaultParams);

  restoreFetch();
  clearEnv();

  assertEquals(result.ok, true);
  assertEquals(callCount, 2);
});

Deno.test("unit: sendWhatsAppTemplate — network error retries once and returns transient_error on second failure", async () => {
  setEnv();
  let callCount = 0;
  globalThis.fetch = () => {
    callCount++;
    return Promise.reject(new TypeError("network failure"));
  };

  const result = await sendWhatsAppTemplate(defaultParams);

  restoreFetch();
  clearEnv();

  assertEquals(result.ok, false);
  assertEquals(result.error, "transient_error");
  assertEquals(callCount, 2);
});

Deno.test("unit: sendWhatsAppTemplate — sends correct Authorization header", async () => {
  setEnv();
  let capturedHeaders: Headers | undefined;
  globalThis.fetch = (_url: RequestInfo | URL, init?: RequestInit) => {
    capturedHeaders = new Headers(init?.headers as HeadersInit);
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
  };

  await sendWhatsAppTemplate(defaultParams);

  restoreFetch();
  clearEnv();

  assertEquals(
    capturedHeaders?.get("Authorization"),
    "Bearer test-token-abc123",
  );
});

Deno.test("unit: sendWhatsAppTemplate — sends correct request body shape", async () => {
  setEnv();
  let capturedBody: unknown;
  globalThis.fetch = (_url: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(init?.body as string);
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
  };

  await sendWhatsAppTemplate({
    to: "+5511999999999",
    templateName: "payment_reminder",
    languageCode: "pt_BR",
  });

  restoreFetch();
  clearEnv();

  assertEquals(capturedBody, {
    messaging_product: "whatsapp",
    to: "+5511999999999",
    type: "template",
    template: {
      name: "payment_reminder",
      language: { code: "pt_BR" },
      components: [],
    },
  });
});

Deno.test("unit: sendWhatsAppTemplate — sends to correct Meta API URL", async () => {
  setEnv();
  let capturedUrl: string | undefined;
  globalThis.fetch = (url: RequestInfo | URL) => {
    capturedUrl = String(url);
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
  };

  await sendWhatsAppTemplate(defaultParams);

  restoreFetch();
  clearEnv();

  assertEquals(
    capturedUrl,
    "https://graph.facebook.com/v19.0/1234567890/messages",
  );
});
