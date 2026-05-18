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

const GPT_URL = Deno.env.get("GPT_URL") ?? "https://chat.openai.com/";

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
    return htmlResponse(renderPostSetupHtml());
  }
  return htmlResponse(renderPostAuthHtml({ email: user.email }));
}

// ─── HTML rendering ────────────────────────────────────────────────────────

function renderPreAuthPage(req: Request): Response {
  const baseUrl = publicFunctionsBaseUrl();
  const redirectUri = googleRedirectUri(baseUrl);
  const state = crypto.randomUUID();
  const authUrl = buildGoogleAuthUrl({ redirectUri, state });

  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
  headers.append(
    "Set-Cookie",
    serializeCookie(COOKIE_OAUTH_STATE, state, {
      maxAge: OAUTH_STATE_TTL_SECONDS,
      httpOnly: true,
      secure: isHttpsRequest(req),
      sameSite: "Lax",
    }),
  );
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
  .btn { display: inline-block; padding: 10px 18px; border-radius: 6px;
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

function renderPostAuthHtml(params: { email: string }): string {
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
  <p>Olá, ${escapeHtml(params.email)}. Falta pouco para terminar a configuração.</p>

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

    <p class="error" id="formError" role="alert"></p>

    <p style="margin-top: 24px;">
      <button type="submit" class="btn" id="submitBtn">Concluir configuração</button>
    </p>
  </form>

  <script>
    (function() {
      var form = document.getElementById('setupForm');
      var errorEl = document.getElementById('formError');
      var submitBtn = document.getElementById('submitBtn');
      var pickerBtn = document.getElementById('pickerBtn');
      var rootInput = document.getElementById('rootFolderId');
      var apiKey = rootInput.getAttribute('data-api-key');
      var clientId = rootInput.getAttribute('data-client-id');
      var pickerInited = false;
      var oauthToken = null;

      function showError(msg) { errorEl.textContent = msg || ''; }

      function loadPicker() {
        if (pickerInited) return;
        pickerInited = true;
        var s1 = document.createElement('script');
        s1.src = 'https://accounts.google.com/gsi/client';
        document.head.appendChild(s1);
        var s2 = document.createElement('script');
        s2.src = 'https://apis.google.com/js/api.js';
        s2.onload = function() { gapi.load('picker', function() {}); };
        document.head.appendChild(s2);
      }

      pickerBtn.addEventListener('click', function() {
        if (!apiKey || !clientId) {
          showError('Picker não configurado — informe o ID da pasta manualmente.');
          return;
        }
        loadPicker();
        var tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: 'https://www.googleapis.com/auth/drive.readonly',
          callback: function(resp) {
            if (resp.error) { showError('Falha ao autorizar o Picker.'); return; }
            oauthToken = resp.access_token;
            openPicker();
          }
        });
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

      form.addEventListener('submit', async function(ev) {
        ev.preventDefault();
        showError('');
        submitBtn.disabled = true;
        try {
          var payload = {
            root_folder_id: rootInput.value.trim(),
            templates_folder_name: document.getElementById('templatesFolderName').value.trim(),
            whatsapp: document.getElementById('whatsapp').value.trim(),
            autentique_api_key: document.getElementById('autentiqueApiKey').value
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
            submitBtn.disabled = false;
            return;
          }
          window.location.reload();
        } catch (e) {
          showError('Erro de rede. Tente novamente.');
          submitBtn.disabled = false;
        }
      });
    })();
  </script>
</body>
</html>`;
}

function renderPostSetupHtml(): string {
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
    <a class="btn" href="${escapeHtml(GPT_URL)}" target="_blank" rel="noopener">
      Abrir o assistente no ChatGPT
    </a>
  </p>
  <hr />
  <p>Antes de gerar seu primeiro contrato, leia o
     <strong>Guia de Placeholders</strong> — ele explica como nomear as variáveis
     dentro dos seus modelos no Google Docs (ex.: <code>{{nome do inquilino}}</code>).
     Você pode pedir ao assistente: <em>"me mostre o guia de placeholders"</em>.</p>
</body>
</html>`;
}
