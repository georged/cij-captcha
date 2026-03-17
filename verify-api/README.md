# CIJ Captcha Verify API

Standalone endpoint for pre-submit CAPTCHA verification.

## Run locally

```bash
npm install
cp .env.sample .env   # or cp config.json.sample config.json
npm start
```

Default URL: `http://localhost:8787`

## Configuration

Settings can be provided as environment variables (via `.env`) **or** as a `config.json` file. Environment variables always take precedence over `config.json`.

### config.json (recommended)

Copy `config.json.sample` to `config.json` and fill in your values. The format matches the output of the **"Copy for verify-api"** button on the plugin config page:

```json
{
  "recaptchaMode": "standard",
  "actionThresholds": {
    "cij_form_submit": 0.5
  },
  "recaptchaSecretKey": "YOUR_RECAPTCHA_SECRET_KEY",
  "turnstileSecretKey": "YOUR_TURNSTILE_SECRET_KEY",
  "enterpriseProjectId": "",
  "enterpriseApiKey": "",
  "enterpriseSiteKey": "",
  "corsOrigins": ["https://yoursite.com"]
}
```

`recaptchaMode` is `"standard"` (default) or `"enterprise"`. Enterprise requires `enterpriseProjectId`, `enterpriseApiKey`, and `enterpriseSiteKey`.
`recaptchaSecretKey` is the reCAPTCHA v3 secret key. `turnstileSecretKey` is the Cloudflare Turnstile secret key.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8787` | Listening port |
| `CORS_ORIGINS` | *(all)* | Comma-separated origin allowlist. Empty = allow all. |
| `RECAPTCHA_SECRET_KEY` | | reCAPTCHA v3 secret key |
| `TURNSTILE_SECRET_KEY` | | Cloudflare Turnstile secret key |
| `RECAPTCHA_MODE` | `standard` | `standard` or `enterprise` |
| `RECAPTCHA_ACTION_THRESHOLDS` | `cij_form_submit:0.5` | `action:threshold` pairs, comma-separated |
| `RECAPTCHA_ENTERPRISE_API_KEY` | | Enterprise API key |
| `RECAPTCHA_ENTERPRISE_PROJECT_ID` | | Google Cloud project ID |
| `RECAPTCHA_SITE_KEY` | | Enterprise site key (server-side fallback) |

## Endpoint

`POST /api/captcha/verify`

Request body:

```json
{
  "provider": "recaptcha",
  "token": "TOKEN_FROM_CLIENT",
  "action": "cij_form_submit",
  "formId": "FORM_BLOCK_OR_FORM_ID",
  "siteKey": "PUBLIC_SITE_KEY_FOR_ENTERPRISE",
  "recaptchaMode": "enterprise",
  "actionThresholds": {
    "cij_form_submit": 0.5,
    "newsletter_signup": 0.8
  }
}
```

`formId` is optional and forwarded for form-specific policy logic.
`actionThresholds` is optional and overrides server defaults per request.

Response:

- Valid token: `{ "success": true, ... }`
- Invalid token: `{ "success": false, "reason": "..." }`

## Deploy to Azure Functions

The repository includes a deployment script:

- `scripts/deploy-verify-api-azure.sh`

It can provision a **Flex Consumption** Function App (Node.js 20), apply app settings, package `verify-api`, and deploy via zip.

### Prerequisites

- Azure CLI (`az`) installed and logged in
- `zip` and `rsync`

### Deploy (provision + code)

From repo root:

```bash
./scripts/deploy-verify-api-azure.sh \
  --subscription "<subscription-id-or-name>" \
  --resource-group "rg-cij-captcha" \
  --location "eastus2" \
  --app-name "cij-captcha-verify-api-prod" \
  --storage-name "cijcaptchaverifysa001" \
  --cors-origins "https://assets1-usa.mkt.dynamics.com" \
  --recaptcha-secret-key "<recaptcha-secret>" \
  --turnstile-secret-key "<turnstile-secret>"
```

### Deploy code only (existing Function App)

```bash
./scripts/deploy-verify-api-azure.sh \
  --subscription "<subscription-id-or-name>" \
  --resource-group "rg-cij-captcha" \
  --app-name "cij-captcha-verify-api-prod" \
  --skip-provision
```

### Settings

The script accepts CLI arguments and/or environment variables for API settings:

- `CORS_ORIGINS`
- `RECAPTCHA_SECRET_KEY`
- `TURNSTILE_SECRET_KEY`
- `RECAPTCHA_MODE`
- `RECAPTCHA_ACTION_THRESHOLDS`
- `RECAPTCHA_ENTERPRISE_API_KEY`
- `RECAPTCHA_ENTERPRISE_PROJECT_ID`
- `RECAPTCHA_SITE_KEY`

Example:

```bash
export RECAPTCHA_MODE=standard
export RECAPTCHA_ACTION_THRESHOLDS="cij_form_submit:0.5"
export RECAPTCHA_SECRET_KEY="<recaptcha-secret>"
export TURNSTILE_SECRET_KEY="<turnstile-secret>"

./scripts/deploy-verify-api-azure.sh \
  --subscription "<subscription-id-or-name>" \
  --resource-group "rg-cij-captcha" \
  --location "eastus2" \
  --app-name "cij-captcha-verify-api-prod" \
  --storage-name "cijcaptchaverifysa001"
```
