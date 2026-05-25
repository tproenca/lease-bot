// Setup function — serves the onboarding HTML page and routes /setup/complete.
//
// This Edge Function is mounted at /functions/v1/setup. Two routes:
//   GET  /functions/v1/setup            → HTML (3 states)
//   POST /functions/v1/setup/complete   → JSON, delegated to ./complete/index.ts
//
// The three onboarding states are:
//   1. Pre-auth (no session cookie): "Entrar com Google" button + CSRF state.
//   2. Post-auth (session, no landlord row): Drive Picker + form.
//   3. Post-setup (landlord row exists): success page with GPT link.

import { corsHeaders } from "../_shared/cors.ts";
import { errorResponse } from "../_shared/errors.ts";
import { publicFunctionsBaseUrl } from "../_shared/env.ts";
import { buildGoogleAuthUrl, googleRedirectUri } from "../_shared/google.ts";
import { getAuthenticatedUser, serviceClient } from "../_shared/supabase.ts";
import {
  clearCookie,
  COOKIE_OAUTH_STATE,
  COOKIE_SESSION,
  isHttpsRequest,
  OAUTH_STATE_TTL_SECONDS,
  parseCookies,
  serializeCookie,
} from "../_shared/cookies.ts";
import { handleSetupComplete } from "./complete/index.ts";

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const pathname = url.pathname.replace(/\/+$/, "");
  const isCompleteRoute = pathname.endsWith("/setup/complete");

  if (isCompleteRoute) {
    if (req.method !== "POST") {
      return errorResponse(405, "METHOD_NOT_ALLOWED", "Método não permitido.");
    }
    return await handleSetupComplete(req);
  }

  if (req.method !== "GET") {
    return errorResponse(405, "METHOD_NOT_ALLOWED", "Método não permitido.");
  }
  return await handleSetupPage(req);
});

// ─── GET /setup ────────────────────────────────────────────────────────────

async function handleSetupPage(req: Request): Promise<Response> {
  const cookies = parseCookies(req.headers.get("cookie"));
  const sessionJwt = cookies[COOKIE_SESSION];

  // Pre-auth: render "Entrar com Google" and set a fresh CSRF state nonce.
  if (!sessionJwt) {
    return renderPreAuthPage(req);
  }

  // Validate session JWT. If invalid, drop the cookie and render pre-auth.
  const user = await getAuthenticatedUser(sessionJwt);
  if (!user) {
    const res = await renderPreAuthPage(req);
    res.headers.append("Set-Cookie", clearCookie(COOKIE_SESSION));
    return res;
  }

  // Has session — has landlord row already? If yes, post-setup; else post-auth.
  const svc = serviceClient();
  const { data: landlord, error } = await svc
    .from("landlords")
    .select("id, templates_folder_id")
    .eq("id", user.id)
    .maybeSingle();
  if (error) {
    return errorResponse(500, "DB_ERROR", "Erro ao consultar a conta.");
  }

  if (landlord) {
    const searchParams = new URL(req.url).searchParams;
    const guiaDocId = searchParams.get("guia") ?? undefined;
    return htmlResponse(renderPostSetupHtml(guiaDocId));
  }

  // Detect integrated OAuth flow: ?via=oauth means the page is open inside
  // the ChatGPT OAuth window. The JS form handler will redirect to ChatGPT
  // when /setup/complete returns a redirect_to URL.
  const viaOAuth = new URL(req.url).searchParams.get("via") === "oauth";

  return htmlResponse(
    renderPostAuthHtml({
      email: user.email,
      // Webhook URL that the landlord must paste into their Autentique
      // webhook configuration. Includes the landlord_id path segment so
      // the webhook handler can find their per-landlord Endpoint Secret.
      webhookUrl: `${publicFunctionsBaseUrl()}/webhooks/autentique/${user.id}`,
      viaOAuth,
    }),
  );
}

// ─── HTML rendering ────────────────────────────────────────────────────────

function renderPreAuthPage(req: Request): Response {
  const baseUrl = publicFunctionsBaseUrl();
  const redirectUri = googleRedirectUri(baseUrl);

  // Reuse the existing state nonce if the cookie is still present (i.e. the
  // Max-Age has not expired on the client side). This prevents a second tab
  // from invalidating the first tab's in-flight OAuth round-trip.
  // We cannot verify the TTL server-side (we don't know when it was set), so
  // we trust that the browser will have discarded an expired cookie already.
  const cookies = parseCookies(req.headers.get("cookie"));
  const existingState = cookies[COOKIE_OAUTH_STATE];
  const state = existingState || crypto.randomUUID();

  const authUrl = buildGoogleAuthUrl({ redirectUri, state });

  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
  // Only emit a Set-Cookie when we generated a fresh nonce; avoid resetting
  // the Max-Age clock on reloads where the old nonce is still valid.
  if (!existingState) {
    headers.append(
      "Set-Cookie",
      serializeCookie(COOKIE_OAUTH_STATE, state, {
        maxAge: OAUTH_STATE_TTL_SECONDS,
        httpOnly: true,
        secure: isHttpsRequest(req),
        sameSite: "Lax",
      }),
    );
  }
  return new Response(renderPreAuthHtml(authUrl), { headers });
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const BASE_STYLES = `
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         max-width: 560px; margin: 48px auto; padding: 0 16px; color: #111;
         line-height: 1.5; }
  h1 { font-size: 24px; margin-bottom: 8px; }
  p { color: #444; }
  label { display: block; margin-top: 16px; font-weight: 600; font-size: 14px; }
  input[type=text], input[type=password], input[type=tel] {
    width: 100%; padding: 10px 12px; font-size: 15px;
    border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box;
    margin-top: 4px;
  }
  .helper { font-size: 13px; color: #666; margin-top: 4px; }
  .btn { display: inline-flex; align-items: center; gap: 8px;
         padding: 10px 18px; border-radius: 6px;
         background: #1a73e8; color: #fff; border: none; font-size: 15px;
         cursor: pointer; text-decoration: none; }
  .btn:disabled { background: #999; cursor: not-allowed; }
  .btn-secondary { background: #fff; color: #1a73e8; border: 1px solid #1a73e8; }
  .error { color: #b00020; margin-top: 12px; min-height: 20px; }
  .picker-row { display: flex; gap: 8px; align-items: center; margin-top: 4px; }
  .picker-row input { flex: 1; }
  hr { border: none; border-top: 1px solid #eee; margin: 24px 0; }
  .success { background: #e6f4ea; border: 1px solid #b7e1cd; padding: 16px;
             border-radius: 6px; }
  @keyframes btn-spin { to { transform: rotate(360deg); } }
  .btn-spinner { display: none; width: 16px; height: 16px; flex-shrink: 0;
                 border: 2px solid rgba(255,255,255,0.4);
                 border-top-color: #fff; border-radius: 50%;
                 animation: btn-spin 0.7s linear infinite; }
  .btn-spinner.visible { display: inline-block; }
`;

function renderPreAuthHtml(authUrl: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<title>Configuração inicial — Lease Assistant</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>${BASE_STYLES}</style>
</head>
<body>
  <h1>Bem-vindo ao Lease Assistant</h1>
  <p>Para começar, entre com sua conta Google. Vamos usá-la para acessar seus modelos
     de contrato no Google Drive e para identificar você no GPT.</p>
  <p><a class="btn" href="${escapeHtml(authUrl)}">Entrar com Google</a></p>
  <hr />
  <p class="helper">Você precisará autorizar o acesso ao seu Google Drive para que o
     assistente possa gerar contratos a partir dos seus modelos.</p>
</body>
</html>`;
}

function renderPostAuthHtml(
  params: { email: string; webhookUrl: string; viaOAuth?: boolean },
): string {
  // The Google Drive Picker needs the developer API key + OAuth client ID.
  // We surface them as data attributes for the inline script to pick up. If
  // PUBLIC_GOOGLE_API_KEY is absent, the page still lets the landlord paste
  // a folder ID manually.
  const apiKey = Deno.env.get("PUBLIC_GOOGLE_API_KEY") ?? "";
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<title>Configuração inicial — Lease Assistant</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>${BASE_STYLES}</style>
</head>
<body>
  <h1>Configurar sua conta</h1>
  <p>Olá, ${
    escapeHtml(params.email)
  }. Falta pouco para terminar a configuração.</p>

  <form id="setupForm" autocomplete="off">
    <label for="rootFolderId">Pasta raiz no Google Drive</label>
    <div class="picker-row">
      <input type="text" id="rootFolderId" name="root_folder_id"
             placeholder="ID da pasta raiz" required
             data-api-key="${escapeHtml(apiKey)}"
             data-client-id="${escapeHtml(clientId)}" />
      <button type="button" class="btn btn-secondary" id="pickerBtn">
        Selecionar pasta
      </button>
    </div>
    <div class="helper">Esta será a pasta onde o assistente criará a estrutura de
       imóveis, inquilinos e contratos. Recomendamos uma pasta dedicada (ex.: "Imóveis/").</div>

    <label for="templatesFolderName">Nome da pasta de modelos</label>
    <input type="text" id="templatesFolderName" name="templates_folder_name"
           value="Templates/" maxlength="80" required />
    <div class="helper">Pasta que será criada dentro da pasta raiz para guardar
       seus modelos de contrato em Google Docs.</div>

    <label for="whatsapp">WhatsApp do proprietário</label>
    <input type="tel" id="whatsapp" name="whatsapp"
           placeholder="+5511999999999" required />
    <div class="helper">Formato E.164: +55 seguido do DDD e número.</div>

    <label for="autentiqueApiKey">Chave de API da Autentique</label>
    <input type="password" id="autentiqueApiKey" name="autentique_api_key"
           placeholder="Cole aqui sua chave de API" required />
    <div class="helper">Crie uma conta em
       <a href="https://www.autentique.com.br" target="_blank" rel="noopener">autentique.com.br</a>
       usando o mesmo Google. Depois vá em <strong>Configurações → Tokens de API</strong>
       e copie a chave. Ela é validada antes de ser salva.</div>

    <label for="autentiqueWebhookSecret">Endpoint Secret do webhook da Autentique</label>
    <input type="password" id="autentiqueWebhookSecret" name="autentique_webhook_secret"
           placeholder="Cole aqui o Endpoint Secret" required />
    <div class="helper">Na Autentique, vá em <strong>Configurações → Webhooks → Adicionar endpoint</strong>.
       Use a URL abaixo, formato <strong>JSON</strong>, evento <strong>document.finished</strong>,
       clique em <strong>Criar</strong> e copie o <strong>Endpoint Secret</strong> mostrado
       (uma única vez).
       <div style="position:relative; margin-top:8px; background:#f5f5f5; border-radius:6px; padding:10px 40px 10px 10px;">
         <code id="webhookUrl" style="font-size:13px; word-break:break-all; display:block;">${
    escapeHtml(params.webhookUrl)
  }</code>
         <button type="button" id="copyWebhookBtn" title="Copiar" style="position:absolute; top:6px; right:6px; background:none; border:1px solid #ccc; border-radius:4px; padding:3px 5px; cursor:pointer; color:#555; line-height:0;"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
       </div>
    </div>

    <p class="error" id="formError" role="alert"></p>

    <p style="margin-top: 24px;">
      <button type="submit" class="btn" id="submitBtn">
        <svg class="btn-spinner" id="submitSpinner" aria-hidden="true"
             viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"></svg>
        <span id="submitLabel">Concluir configuração</span>
      </button>
    </p>
  </form>

  <script>
    (function() {
      var viaOAuth = ${params.viaOAuth ? "true" : "false"};
      var form = document.getElementById('setupForm');
      var errorEl = document.getElementById('formError');
      var submitBtn = document.getElementById('submitBtn');
      var pickerBtn = document.getElementById('pickerBtn');
      var rootInput = document.getElementById('rootFolderId');
      var apiKey = rootInput.getAttribute('data-api-key');
      var clientId = rootInput.getAttribute('data-client-id');
      var oauthToken = null;
      var pickerReady = false;
      var tokenClient = null;

      function showError(msg) { errorEl.textContent = msg || ''; }

      var copyBtn = document.getElementById('copyWebhookBtn');
      if (copyBtn) {
        var copyIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
        var checkIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#1a73e8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        copyBtn.addEventListener('click', function() {
          var url = document.getElementById('webhookUrl').textContent;
          navigator.clipboard.writeText(url).then(function() {
            copyBtn.innerHTML = checkIcon;
            setTimeout(function() { copyBtn.innerHTML = copyIcon; }, 1500);
          });
        });
      }

      if (apiKey && clientId) {
        var s1 = document.createElement('script');
        s1.src = 'https://accounts.google.com/gsi/client';
        s1.onload = function() {
          tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: clientId,
            scope: 'https://www.googleapis.com/auth/drive.readonly',
            callback: function(resp) {
              if (resp.error) { showError('Falha ao autorizar o Picker.'); return; }
              oauthToken = resp.access_token;
              openPicker();
            }
          });
        };
        document.head.appendChild(s1);
        var s2 = document.createElement('script');
        s2.src = 'https://apis.google.com/js/api.js';
        s2.onload = function() { gapi.load('picker', function() { pickerReady = true; }); };
        document.head.appendChild(s2);
      }

      pickerBtn.addEventListener('click', function() {
        if (!apiKey || !clientId) {
          showError('Picker não configurado — informe o ID da pasta manualmente.');
          return;
        }
        if (!tokenClient || !pickerReady) {
          showError('Picker ainda carregando, tente novamente em instantes.');
          return;
        }
        tokenClient.requestAccessToken();
      });

      function openPicker() {
        var view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
          .setSelectFolderEnabled(true)
          .setMimeTypes('application/vnd.google-apps.folder');
        var picker = new google.picker.PickerBuilder()
          .addView(view)
          .setOAuthToken(oauthToken)
          .setDeveloperKey(apiKey)
          .setCallback(function(data) {
            if (data.action === google.picker.Action.PICKED) {
              rootInput.value = data.docs[0].id;
            }
          })
          .build();
        picker.setVisible(true);
      }

      var submitSpinner = document.getElementById('submitSpinner');
      var submitLabel = document.getElementById('submitLabel');

      function setSubmitting(loading) {
        submitBtn.disabled = loading;
        if (loading) {
          submitSpinner.classList.add('visible');
          submitLabel.textContent = 'Aguarde…';
        } else {
          submitSpinner.classList.remove('visible');
          submitLabel.textContent = 'Concluir configuração';
        }
      }

      form.addEventListener('submit', async function(ev) {
        ev.preventDefault();
        showError('');
        setSubmitting(true);
        try {
          var payload = {
            root_folder_id: rootInput.value.trim(),
            templates_folder_name: document.getElementById('templatesFolderName').value.trim(),
            whatsapp: document.getElementById('whatsapp').value.trim(),
            autentique_api_key: document.getElementById('autentiqueApiKey').value,
            autentique_webhook_secret: document.getElementById('autentiqueWebhookSecret').value
          };
          var res = await fetch('./setup/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(payload)
          });
          var json = await res.json().catch(function(){ return {}; });
          if (!res.ok) {
            showError((json.error && json.error.message) || 'Erro ao concluir a configuração.');
            setSubmitting(false);
            return;
          }
          // Keep spinner visible — page will navigate away on success.
          if (viaOAuth && json.redirect_to) {
            // Integrated OAuth flow: close the ChatGPT auth window by
            // navigating to the ChatGPT callback URL with the one-time code.
            window.location.href = json.redirect_to;
          } else {
            var guiaParam = json.guia_doc_id ? '?guia=' + encodeURIComponent(json.guia_doc_id) : '';
            window.location.href = window.location.pathname + guiaParam;
          }
        } catch (e) {
          showError('Erro de rede. Tente novamente.');
          setSubmitting(false);
        }
      });
    })();
  </script>
</body>
</html>`;
}

function renderPostSetupHtml(guiaDocId?: string): string {
  const guiaUrl = guiaDocId
    ? `https://docs.google.com/document/d/${escapeHtml(guiaDocId)}/edit`
    : null;
  const guiaSection = guiaUrl
    ? `<p>Um modelo de contrato e o <strong>Guia de Placeholders</strong> foram criados
       na sua pasta de modelos no Google Drive.<br/>
       <a href="${guiaUrl}" target="_blank" rel="noopener">Abrir Guia de Placeholders</a></p>`
    : `<p>Antes de gerar seu primeiro contrato, leia o
       <strong>Guia de Placeholders</strong> — ele explica como nomear as variáveis
       dentro dos seus modelos no Google Docs (ex.: <code>{{nome do inquilino}}</code>).
       Você pode pedir ao assistente: <em>"me mostre o guia de placeholders"</em>.</p>`;

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<title>Configuração concluída — Lease Assistant</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>${BASE_STYLES}</style>
</head>
<body>
  <h1>Tudo pronto!</h1>
  <div class="success">
    <p><strong>Sua conta está configurada.</strong></p>
    <p>Você já pode usar o assistente diretamente no ChatGPT.</p>
  </div>
  <p style="margin-top: 24px;">
    <button class="btn" onclick="window.close();setTimeout(function(){document.getElementById('close-fb').style.display='block'},400)">
      Abrir o assistente no ChatGPT
    </button>
    <span id="close-fb" style="display:none;margin-top:12px;display:none">
      Feche esta aba e volte ao ChatGPT.
    </span>
  </p>
  <hr />
  ${guiaSection}
</body>
</html>`;
}
