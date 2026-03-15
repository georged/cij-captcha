# CIJ Captcha Verify API

Standalone endpoint for pre-submit CAPTCHA verification.

## Run locally

```bash
npm install
cp .env.sample .env
npm start
```

Default URL: `http://localhost:8787`

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

`formId` is optional today and is forwarded for form-specific policy logic.
`actionThresholds` is optional and can override server defaults per request.

Response:

- Valid token: `{ "success": true, ... }`
- Invalid token: `{ "success": false, "reason": "..." }`

## Required environment variables

- `RECAPTCHA_SECRET_KEY` for Google reCAPTCHA v3
- `TURNSTILE_SECRET_KEY` for Cloudflare Turnstile

## Optional environment variables

- `PORT` default `8787`
- `CORS_ORIGINS` comma-separated allowlist. Empty means allow all origins.
- `RECAPTCHA_MIN_SCORE` default `0.5`
- `RECAPTCHA_ACTION_THRESHOLDS` action-threshold pairs (for example: `cij_form_submit:0.5,newsletter_signup:0.8`)
- `RECAPTCHA_EXPECTED_ACTION` legacy fallback action (used when `RECAPTCHA_ACTION_THRESHOLDS` is not provided)
