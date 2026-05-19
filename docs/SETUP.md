# External Services Setup — Lease Assistant

Step-by-step setup for the four external services required to run the system locally.
Complete them in order — each step depends on information from the previous one.

---

## 1. ngrok

ngrok exposes your local Supabase instance over HTTPS so the Custom GPT can reach it
and Google OAuth can redirect back to it.

### Install
```sh
brew install ngrok/ngrok/ngrok   # macOS
# or download from https://ngrok.com/download
```

### Create an account and claim a permanent domain
1. Sign up at [ngrok.com](https://ngrok.com) (free tier is sufficient)
2. Copy your authtoken from the dashboard → **Your Authtoken**
3. Run: `ngrok config add-authtoken <your-token>`
4. Go to **Cloud Edge → Domains → New Domain** → claim a free permanent subdomain
   (e.g. `your-name.ngrok-free.dev`). Note it down — you'll use it everywhere below.

### Start ngrok
```sh
ngrok http 54321 --domain <your-domain>.ngrok-free.dev
```

Keep this running whenever you test locally.

---

## 2. Google Cloud Console

### Create a project
1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (or reuse one) — name it anything, e.g. `Lease Assistant`

### Enable APIs
In the project, go to **APIs & Services → Library** and enable:
- **Google Drive API**
- **Google Picker API**

### OAuth consent screen
1. Go to **APIs & Services → OAuth consent screen**
2. User type: **External** (allows you to log in without a Google Workspace org)
3. Fill in App name, user support email, and developer contact — any values work for local testing
4. Add scopes:
   - `openid`
   - `email`
   - `profile`
   - `https://www.googleapis.com/auth/drive`
5. Under **Test users**, add your own Google account email
6. Save

### Create OAuth credentials
1. Go to **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
2. Application type: **Web application**
3. Add **Authorized redirect URIs**:
   - Local (ngrok): `https://<your-domain>.ngrok-free.dev/functions/v1/auth/callback`
   - Production: `https://<project-ref>.supabase.co/functions/v1/auth/callback`
4. Click **Create** → copy the **Client ID** and **Client Secret**

### Optional: API key for Google Drive Picker
The `/setup` onboarding page uses the Google Drive Picker to let landlords select their
root folder. Without an API key the Picker won't load — landlords can still paste a
folder ID manually, but the Picker is the better UX.

1. Go to **APIs & Services → Credentials → Create Credentials → API Key**
2. Restrict it to **Google Picker API** and your ngrok/production domains
3. Copy the key

### Add to `.env`
```sh
GOOGLE_CLIENT_ID=<client-id>
GOOGLE_CLIENT_SECRET=<client-secret>
PUBLIC_GOOGLE_API_KEY=<api-key>   # optional — omit to skip the Drive Picker
```

---

## 3. Autentique

Autentique handles e-signature submission and notifies signers via WhatsApp.
Each landlord has their own Autentique account — their API key is collected during
onboarding and stored per-landlord in the database.

### Create an account
1. Go to [autentique.com.br](https://autentique.com.br) and sign up with your Google account
2. Free tier is sufficient for local testing

### Get your API key
1. In the Autentique dashboard, go to **Configurações → Tokens de API**
2. Create a new token and copy it — you'll paste it into the GPT during onboarding (Flow 1)
   It is **not** an environment variable; it's collected conversationally and stored in the DB

### Register the webhook (required for Flow 8 — signing)
The webhook notifies your local backend when a document is fully signed, triggering the
signed PDF to be saved back to Google Drive.

1. In Autentique, go to **Configurações → Webhooks → Novo Webhook**
2. URL: `https://<your-domain>.ngrok-free.dev/functions/v1/webhooks/autentique`
3. Event: select **Documento finalizado** (fully signed by all parties)
   — do NOT also select "Documento assinado"; that fires per-signer and would trigger duplicate processing
4. Secret: generate a random string (e.g. `openssl rand -hex 32`) — Autentique will sign
   webhook payloads with it; your backend verifies the signature
5. Copy the secret and add to `.env`:
   ```sh
   AUTENTIQUE_WEBHOOK_SECRET=<your-secret>
   ```

---

## 4. Meta WhatsApp Business

Required only for **Flow 9** (ad-hoc payment reminders). You can skip this and still
run Flows 1–8.

### Create a Meta Business account and app
1. Go to [developers.facebook.com](https://developers.facebook.com) and log in
2. Go to **My Apps → Create App**
3. Use case: **Other** → type: **Business**
4. Give it a name (e.g. `Lease Assistant`) and click **Create**

### Add WhatsApp to the app
1. In the app dashboard, find **WhatsApp** under **Add Products** and click **Set up**
2. You'll land on the **WhatsApp API Setup** screen

### Get the test token and phone number ID
Meta provides a free test sender number — no real phone number or verified business needed
for local testing.

1. On the **API Setup** screen, under **Send and receive messages**:
   - Copy the **Temporary access token** (valid 24h — regenerate it from this same screen when it expires)
   - Copy the **Phone number ID** of the test sender
2. Add to `.env`:
   ```sh
   META_WHATSAPP_TOKEN=<temporary-access-token>
   META_WHATSAPP_PHONE_ID=<phone-number-id>
   ```

### Add a recipient test number
Meta sandbox only sends messages to pre-verified recipient numbers.
1. Under **To**, click **Manage phone number list**
2. Add your own WhatsApp number and verify it via the code Meta sends you

### Message templates
Payment reminder messages sent by this system use a plain-text body constructed at
runtime — no pre-approved Meta template is required as long as you are testing with
sandbox recipient numbers. A production deployment sending to unverified numbers
requires a Meta-approved message template.

---

## 5. Put it all together

Once all services are set up, populate `supabase/.env.local` (see `.env.example` for the
full list) and start the local stack:

```sh
supabase start
ngrok http 54321 --domain <your-domain>.ngrok-free.dev
```

Then follow `docs/MANUAL-TEST.md` to run the flows end-to-end.
