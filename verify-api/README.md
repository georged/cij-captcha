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
  "secretKey": "YOUR_RECAPTCHA_SECRET_KEY",
  "enterpriseProjectId": "",
  "enterpriseApiKey": "",
  "enterpriseSiteKey": "",
  "corsOrigins": ["https://yoursite.com"]
}
```

`recaptchaMode` is `"standard"` (default) or `"enterprise"`. Enterprise requires `enterpriseProjectId`, `enterpriseApiKey`, and `enterpriseSiteKey`.
`secretKey` is the shared provider secret key format used by the plugin/config page and is used as a fallback by verify-api for both reCAPTCHA and Turnstile.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8787` | Listening port |
| `CORS_ORIGINS` | *(all)* | Comma-separated origin allowlist. Empty = allow all. |
| `RECAPTCHA_MODE` | `standard` | `standard` or `enterprise` |
| `CAPTCHA_SECRET_KEY` | | Shared secret key fallback for both providers |
| `RECAPTCHA_SECRET_KEY` | | reCAPTCHA v3 secret key |
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
