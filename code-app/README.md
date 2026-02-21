# CIJ Captcha Configuration

This is a standalone code app for configuring the Dataverse plugin step used by CIJ CAPTCHA validation.

## What it configures

- Provider (`recaptcha` or `turnstile`) in unsecure config
- Min score (only when provider is `recaptcha`) in unsecure config
- Secret key in secure config

## Run locally

```bash
cd code-app
npm install
npm run dev
```

## Dataverse integration (Code Apps pattern)

This app does not use `Xrm.WebApi`.

To connect it to Dataverse in a Code Apps-compliant way:

1. Install/sign in to PAC CLI and select the target environment.
2. Add Dataverse data sources for the required tables using `pac code add-data-source`.
3. Implement and register `registerPluginConfigImplementation(...)` from
	`src/services/pluginConfigService.ts` using generated services from
	`src/generated/services/*`.

Until that implementation is registered, the app shows a clear setup message and won't save.

## Save behavior

The app writes:

- `sdkmessageprocessingstep.configuration`
- `sdkmessageprocessingstepsecureconfig.secureconfig`