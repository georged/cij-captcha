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
  "action": "cij_form_submit"
}
```

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
- `RECAPTCHA_EXPECTED_ACTION` optional action check
