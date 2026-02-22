# Customer Insights Journeys CAPTCHA Integration

Protect Customer Insights Journeys (CIJ) forms with server-side CAPTCHA validation.

- Client script: `form-script/`
- Server plugin: `plugin/`
- Config app: `code-app/`

## Release 1.1.0

This release supports:

- Managed solution distribution via GitHub Releases
- Hosted client script via jsDelivr (no self-hosting required)
- Script init API: `window.CijCaptcha.init({...})`
- Provider support: Google reCAPTCHA v3 and Cloudflare Turnstile
- Multi-form support

## Quick Start

1. Download latest [CIJ_Captcha_managed.zip](https://github.com/georged/cij-captcha/releases/latest/download/CIJ_Captcha_managed.zip) managed solution and import it into your Dataverse instance.

2. Open the **CIJ Captcha Configuration** app and configure server-side provider + secret.
   <img width="845" height="456" alt="image" src="https://github.com/user-attachments/assets/6270167c-a4e0-4c8e-856d-596a9ee3b09d" />

> [!TIP]
> If using reCaptcha, set threshold to 1.0 to simulate failed tests.

3. Edit HTML source for your form:
   - Insert the hosted script block after the `<body>`tag and initialize with your site (public) key.
   - Add `data-validate-submission="true"` attribute to the `<form>` tag.

    ```html
    ...
    <body>
        <script>
          function initCijCaptcha() {
            if (!window.CijCaptcha?.init) return;
            window.CijCaptcha.init({
              provider: "recaptcha",
              siteKey: "YOUR_RECAPTCHA_KEY"
            });
          }
        </script>
        <script src="https://cdn.jsdelivr.net/gh/georged/cij-captcha@v1.1.0/form-script/cij-captcha.js"
          onload="initCijCaptcha()">
        </script>
        <main>
            <form aria-label="Untitled Form" class="marketingForm" data-validate-submission="true">
              ...
    ```
   
4. Save and publish the form. 

5. Wait for propagation (typically 1–10 minutes), then test on a standalone page.

> [!TIP]
>
> Don't forget to add form hosting domain (e.g. `assets-usa.mkt.dynamics.com`) to the list of approved domains for your captcha keys. 

------------------
## Configuration

### Server-side configuration

Expected plugin configuration values:

- reCAPTCHA unsecure config: `provider=recaptcha;minscore=0.7`
- Turnstile unsecure config: `provider=turnstile`
- Secure config: provider secret key

### Client-side script

Client-side requires cij-captcha.js script and a call to `CijCaptcha.init()` method.

You can copy and paste the entire script but it's more efficient to use version-pinned CDN URL:

```html
<script src="https://cdn.jsdelivr.net/gh/georged/cij-captcha@v1.1.0/form-script/cij-captcha.js"></script>
```

If you want latest from default branch (not pinned), use:

```html
<script src="https://cdn.jsdelivr.net/gh/georged/cij-captcha/form-script/cij-captcha.js"></script>
```

### Minimal Turnstile init

```html
<script>
  window.CijCaptcha.init({
    provider: 'turnstile',
    siteKey: 'YOUR_TURNSTILE_SITE_KEY'
  });
</script>
```

### Minimal reCAPTCHA init

```html
<script>
  window.CijCaptcha.init({
    provider: 'recaptcha',
    siteKey: 'YOUR_RECAPTCHA_SITE_KEY'
  });
</script>
```

### Client script API

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

#### Multiple form support

If your page includes multiple CIJ Forms Each form, each form tag  still requires `data-validate-submission` attribute however  you can use a single instance of the script.

```html
<!-- single instance of the captcha script -->
<script src="https://cdn.jsdelivr.net/gh/georged/cij-captcha@v1.1.0/form-script/cij-captcha.js"></script>
<script>
   window.CijCaptcha.init({
      provider: "recaptcha", 
      siteKey: "YOUR_RECAPTCHA_SITE_KEY"
   });
</script>
<div
   data-form-id='form1-guid'
   data-form-api-url='form1-api-url'
   data-cached-form-url='form1-cached-url' ></div>
<div
   data-form-id='form2-guid'
   data-form-api-url='form2-api-url'
   data-cached-form-url='form2-cached-url' ></div>
<!-- single instance of the form loader (your url may differ) -->
<script src = 'https://cxppusa1formui01cdnsa01-endpoint.azureedge.net/usa/FormLoader/FormLoader.bundle.js' ></script>
```



## Build your own version

### Dataverse Plugin

From repo root:

```bash
cd plugin
```

Generate strong-name key file (one-time for local build):

```bash
sn -k CijCaptcha.snk
```

Build plugin assembly:

```bash
dotnet build -c Release
```

Output DLL:

- `plugin/bin/Release/net462/CijCaptcha.dll`

Register with Plugin Registration Tool:

1. Open Plugin Registration Tool and connect to your Dataverse environment.
2. Register `CijCaptcha.dll` as a new assembly (Sandbox).
3. Register step for message `msdynmkt_validateformsubmission` (Synchronous, Post-operation).
4. Set step configuration:
   - Unsecure: `provider=recaptcha;minscore=0.7` or `provider=turnstile`
   - Secure: CAPTCHA secret key

> [!IMPORTANT]
>
> Keep `CijCaptcha.snk` private and do not commit private keys.

### Configuration app

From repo root:

```bash
cd code-app
npm install
npm run build
pac code push --solutionName "CIJ Captcha"
```

If you deleted/recreated the app and push fails due stale app ID, clear `appId` in `code-app/power.config.json` and push again.

#### Run and debug locally

Use two terminals from `code-app/`:

Terminal 1 (frontend):

```bash
npm run dev -- --host
```

Terminal 2 (Power Code Apps bridge):

```bash
pac code run --port 3000 --appUrl http://localhost:5173
```

Then open the local/play URL shown by `pac code run` and debug in browser DevTools.

## Security notes

- Never commit secret keys.
- Rotate exposed keys immediately if they were ever shared publicly.
- Keep provider secret only in secure plugin configuration.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Copyright

Copyright (c) 2026 George Doubinski

---

**Made with ❤️ for productivity**
