# CIJ CAPTCHA Integration

Protect Customer Insights Journeys (CIJ) forms with server-side CAPTCHA validation.

- Client script: `form-script/cij-captcha.js`
- Server plugin: `plugin/CaptchaValidationPlugin.cs`
- Config app: `code-app/` (**CIJ Captcha Configuration**)

## Release 1.1.0

This release supports:

- Managed solution distribution via GitHub Releases
- Hosted client script via jsDelivr (no self-hosting required)
- Script init API: `window.CijCaptcha.init({...})`
- Provider support: Google reCAPTCHA v3 and Cloudflare Turnstile

## Quick Start

1. Download `CIJ_Captcha_managed.zip` from GitHub Release `v1.1.0`.
2. Import the managed solution into Dataverse.
3. Open the **CIJ Captcha Configuration** app and configure server-side provider + secret.
4. Add `data-validate-submission="true"` directly in your CIJ form HTML.
5. Add the hosted script block (jsDelivr) and initialize with your site key.
6. Wait for propagation (typically 1–10 minutes), then test on a standalone page.

### CIJ form HTML (required attribute)

```html
<div
  data-form-id="YOUR_FORM_ID"
  data-form-api-url="YOUR_FORM_API_URL"
  data-cached-form-url="YOUR_FORM_CACHED_URL"
  data-validate-submission="true"
></div>
<script src="https://cxppusa1formui01cdnsa01-endpoint.azureedge.net/usa/FormLoader/FormLoader.bundle.js"></script>
```

### Hosted script (jsDelivr)

Use version-pinned CDN URL:

```html
<script src="https://cdn.jsdelivr.net/gh/<owner>/<repo>@v1.1.0/form-script/cij-captcha.js"></script>
```

#### Minimal Turnstile init

```html
<script>
  window.CijCaptcha.init({
    provider: 'turnstile',
    siteKey: 'YOUR_TURNSTILE_SITE_KEY'
  });
</script>
```

#### Minimal reCAPTCHA init

```html
<script>
  window.CijCaptcha.init({
    provider: 'recaptcha',
    siteKey: 'YOUR_RECAPTCHA_SITE_KEY'
  });
</script>
```

## Server-side configuration (CIJ Captcha Configuration app)

After importing the managed solution:

1. Launch **CIJ Captcha Configuration**.
2. Select provider:
   - `recaptcha`
   - `turnstile`
3. For reCAPTCHA, set minimum score (for example `0.7`).
4. Enter secret key and save.

Expected plugin configuration values:

- reCAPTCHA unsecure config: `provider=recaptcha;minscore=0.7`
- Turnstile unsecure config: `provider=turnstile`
- Secure config: provider secret key

## Client script API

`window.CijCaptcha.init(settings)`

Supported settings:

- `provider`: `'recaptcha' | 'turnstile'` (default `'recaptcha'`)
- `siteKey`: provider site key (**required**)
- `action`: reCAPTCHA action (default `'cij_form_submit'`)
- `enableDebugLogs`: `boolean` (default `false`)
- `eagerLoad`: `boolean` (default `true`)
- `turnstile`:
  - `size`: `'normal' | 'compact' | 'invisible'` (default `'normal'`)
  - `execution`: `'execute' | 'render'` (default `'execute'`)
  - `appearance`: `'always' | 'execute' | 'interaction-only'` (default `'execute'`)
  - `theme`: `'auto' | 'light' | 'dark'` (default `'auto'`)
  - `tokenReuseTimeout`: number in ms (default `240000`)

## Security notes

- Never commit secret keys.
- Rotate exposed keys immediately if they were ever shared publicly.
- Keep provider secret only in secure plugin configuration.
