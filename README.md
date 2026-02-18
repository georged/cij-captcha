# CIJ CAPTCHA Integration

Adds CAPTCHA protection to **Customer Insights Journeys (CIJ) embedded forms** using the official [Customize form submission validation](https://learn.microsoft.com/en-us/dynamics365/customer-insights/journeys/real-time-marketing-form-customize-submission-validation) extension point.

Supports two providers — switch between them with a single config variable:

| Provider | Setting | Token field | Verification |
|---|---|---|---|
| **Google reCAPTCHA v3** | `provider=recaptcha` | `g-recaptcha-response` | Score 0.0–1.0; configurable threshold |
| **Cloudflare Turnstile** | `provider=turnstile` | `cf-turnstile-response` | Pass / fail; no score |

---

## How it works

```
Browser                              Dataverse
───────                              ─────────
User fills in CIJ form
  │
  ▼
cij-captcha.js intercepts submit
  │  calls grecaptcha.execute()  (reCAPTCHA)
  │       or  turnstile.execute() (Turnstile)
  ▼
Hidden field  g-recaptcha-response  = <token>   (reCAPTCHA)
          or  cf-turnstile-response = <token>   (Turnstile)
  │
  ▼
Form submitted to CIJ endpoint
  │
  ▼                                msdynmkt_validateformsubmission fires
                                       │
                                       ▼
                                   CaptchaValidationPlugin
                                       │  POST /siteverify → Google | Cloudflare
                                       ▼
                               reCAPTCHA: score ≥ threshold?
                               Turnstile:    success = true?
                                       │ yes              │ no
                                       ▼                  ▼
                                   IsValid=true       IsValid=false
                                   (submission saved)  (submission rejected)
```

---

## Repository layout

```
cij-recaptcha-v3/
├── form-script/
│   └── cij-captcha.js          ← client-side script added to each CIJ form
└── plugin/
    ├── CijCaptcha.csproj
    └── CaptchaValidationPlugin.cs  ← Dataverse plug-in
```

---

## Prerequisites

| Requirement | Details |
|---|---|
| CAPTCHA keys | **reCAPTCHA v3:** [Google Admin Console](https://www.google.com/recaptcha/admin) — get site key + secret key. **Turnstile:** [Cloudflare Dashboard](https://dash.cloudflare.com/?to=/:account/turnstile) — get site key + secret key. |
| Visual Studio 2022+ | With **.NET desktop development** workload installed |
| Plugin Registration Tool (PRT) | Part of [Microsoft.CrmSdk.XrmTooling.PluginRegistrationTool](https://www.nuget.org/packages/Microsoft.CrmSdk.XrmTooling.PluginRegistrationTool) |
| Dataverse / CIJ environment | System Customizer or System Administrator role |

---

## Part 1 — Customise the CIJ form (client-side)

### 1.1 Add the CAPTCHA token field to your form

The back-end plugin reads a hidden field whose name depends on the provider:

| Provider | Field name on form |
|---|---|
| Google reCAPTCHA v3 | `g-recaptcha-response` |
| Cloudflare Turnstile | `cf-turnstile-response` |

Steps:

1. Open **Customer Insights – Journeys → Real-time marketing forms**.
2. Open the form you want to protect.
3. In the form editor, add a new **Text field** (single line).
4. Map it to a custom attribute on **Lead** or **Contact** (e.g. `cij_captchatoken`). The label can be anything.
5. In the field's **Advanced** settings, set **Field name on form** to the value from the table above.
6. Mark the field as **Hidden**.
7. Add the `data-validate-submission="true"` attribute to the form's embed `<div>` — see step 1.3.

### 1.2 Configure and add the script

1. Open `form-script/cij-captcha.js`.
2. Set the three variables at the top:

```js
var CAPTCHA_PROVIDER = 'recaptcha';           // 'recaptcha' | 'turnstile'
var CAPTCHA_SITE_KEY = 'YOUR_CAPTCHA_SITE_KEY'; // your public / site key
var CAPTCHA_ACTION   = 'cij_form_submit';     // reCAPTCHA v3 only
```

3. In the CIJ form editor, go to **Custom scripts** and paste the entire contents of `cij-captcha.js`, **or** host the file on your CDN and reference it with a `<script src="…">` tag.

> **Tip:** If you host the script externally, add the `<script>` via **Form → Settings → Custom code** so it loads on every page that renders the form.

### 1.3 Enable custom validation on the embed snippet

When you copy the embed code from CIJ, add `data-validate-submission="true"` to the host `<div>`:

```html
<!-- CIJ form embed – add data-validate-submission="true" -->
<div
  data-form-id="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  data-form-api-url="https://public-eur.mkt.dynamics.com/api/v1.0/orgs/…/landingpageforms"
  data-cached-form-url="…"
  data-validate-submission="true"   <!-- ← ADD THIS -->
></div>
<script src="https://cxppusa1formui01cdnsa01-endpoint.azureedge.net/eur/FormLoader/FormLoader.bundle.js"></script>
```

Without this attribute, the `msdynmkt_validateformsubmission` message is never raised and the plugin will not execute.

---

## Part 2 — Build and deploy the plug-in

### 2.1 Configure the provider and secret key

All configuration is supplied through the Plugin Registration Tool — **no secrets or keys exist anywhere in source code**. The plugin throws an error on startup if the Secure Config is empty, so misconfiguration is caught immediately.

#### Google reCAPTCHA v3

| Field | Value |
|---|---|
| **Unsecure Config** | `provider=recaptcha;minscore=0.5` |
| **Secure Config** | `6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe` *(your reCAPTCHA v3 secret key)* |

The `minscore` parameter is optional and defaults to `0.5`. Accepted range: `0.0`–`1.0`. Google recommends `0.5`; raise it (e.g. `0.7`) for higher confidence, lower it for more permissive traffic.

#### Cloudflare Turnstile

| Field | Value |
|---|---|
| **Unsecure Config** | `provider=turnstile` |
| **Secure Config** | `1x0000000000000000000000000000000AA` *(your Turnstile secret key)* |

Turnstile is pass/fail — there is no score threshold to configure.

> **Security note:** The Secure Config value is stored encrypted by Dataverse and is never returned through the API or visible in the UI after saving. It is the only place the secret key should exist. Never commit it to source control.

### 2.2 Generate a strong-name key

Dataverse requires the assembly to be strong-name signed.

```bash
# Run once from the plugin/ directory
sn -k CijCaptcha.snk
```

The `.csproj` already references `CijCaptcha.snk`. **Do not commit** the `.snk` file to a public repository — it is listed in `.gitignore`.

### 2.3 Build the assembly

```bash
cd plugin
dotnet build -c Release
# Output: plugin/bin/Release/net462/CijCaptcha.dll
```

Or open `plugin/CijCaptcha.csproj` in Visual Studio, set **Configuration = Release**, and press **Build → Build Solution**.

### 2.4 Register the assembly with the Plugin Registration Tool

1. Launch `PluginRegistrationTool.exe`.
2. Click **Create new connection → Office 365** and sign in.
3. Click **Register → Register New Assembly**.
4. Click **…** and browse to `plugin/bin/Release/net462/CijCaptcha.dll`.
5. Leave isolation mode as **Sandbox**.
6. In **Unsecure Configuration**, enter e.g. `provider=recaptcha;minscore=0.5`.
7. In **Secure Configuration**, paste your CAPTCHA secret key.
8. Click **Register Selected Plugin**.

### 2.5 Register the step

1. Expand the registered assembly and select `CijCaptcha.CaptchaValidationPlugin`.
2. Click **Register New Step** and fill in:

| Field | Value |
|---|---|
| Message | `msdynmkt_validateformsubmission` |
| Primary Entity | *(leave blank)* |
| Execution Mode | **Synchronous** |
| Execution Order | `10` |
| Event Pipeline Stage | **Post-operation** |

3. Click **Register New Step**.

> The plugin runs **after** the default Microsoft validation plugin. CIJ sets `IsValid=false` when no built-in CAPTCHA fields are present; your plugin overwrites that result.

---

## Testing

1. Open a page containing the CIJ form embed.
2. Open browser DevTools → **Network**.
3. Submit the form.
4. Verify that the CAPTCHA provider's script was loaded and the hidden field was populated before submission.
5. In **Dynamics 365 → Settings → System Jobs**, confirm `msdynmkt_validateformsubmission` completed without errors.
6. In **Plug-in Trace Log** (Settings → Plug-in Trace Log), review lines written by `CaptchaValidationPlugin`.

To enable the Plug-in Trace Log:
**Settings → Administration → System Settings → Customization tab → Enable logging to plug-in trace log = All**

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Plugin never fires | `data-validate-submission="true"` missing | Add the attribute to the embed `<div>` |
| Token field not in submission | Hidden field not added / wrong name in CIJ editor | Add the hidden field and match the name to the provider's expected field |
| reCAPTCHA: score always 0 or token invalid | Wrong site key or secret key | Verify keys in [Google Admin Console](https://www.google.com/recaptcha/admin) |
| Turnstile: success always false | Wrong site key or secret key | Verify keys in [Cloudflare Dashboard](https://dash.cloudflare.com/?to=/:account/turnstile) |
| `IsValid` stays `false` | Plugin execution order too high | Set execution order to `10` |
| CAPTCHA script blocked in console | CSP or ad-blocker | Add provider domains to your CSP (see below) |

### CSP domains to allow

| Provider | Domains |
|---|---|
| reCAPTCHA v3 | `www.google.com`, `www.gstatic.com` |
| Turnstile | `challenges.cloudflare.com` |

---

## Security notes

- **Never expose the secret key** client-side. It is used only in the server-side plugin.
- reCAPTCHA v3 is **score-based** — tune `minscore` based on your traffic. Consider logging low-score submissions to a custom entity for review rather than silently discarding them.
- Cloudflare Turnstile is **pass/fail** — no score tuning needed. It is GDPR-friendly and does not require a consent banner in most jurisdictions.
