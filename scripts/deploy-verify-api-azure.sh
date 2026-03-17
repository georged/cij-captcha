#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFY_API_DIR="$ROOT_DIR/verify-api"

if ! command -v az >/dev/null 2>&1; then
  echo "Error: Azure CLI (az) is required." >&2
  exit 1
fi

if ! command -v zip >/dev/null 2>&1; then
  echo "Error: zip is required." >&2
  exit 1
fi

usage() {
  cat <<'EOF'
Deploy verify-api as an Azure Function App.

Required:
  --subscription <id-or-name>      Azure subscription
  --resource-group <name>          Resource group name
  --location <azure-region>        Azure region (for RG + Flex plan)
  --app-name <function-app-name>   Azure Function App name (must be globally unique)
  --storage-name <account-name>    Storage account name (3-24 lowercase letters/numbers)

Optional:
  --cors-origins <csv>             Example: "https://site1.com,https://site2.com"
  --recaptcha-mode <mode>          standard|enterprise (default: standard)
  --action-thresholds <pairs>      Example: "cij_form_submit:0.5,newsletter_signup:0.8"
  --recaptcha-secret-key <value>   reCAPTCHA v3 secret key
  --turnstile-secret-key <value>   Cloudflare Turnstile secret key
  --enterprise-api-key <value>     reCAPTCHA enterprise API key
  --enterprise-project-id <value>  reCAPTCHA enterprise project id
  --enterprise-site-key <value>    reCAPTCHA enterprise site key
  --skip-provision                 Deploy code/settings to existing resources only

Environment variable fallback:
  CORS_ORIGINS
  RECAPTCHA_MODE
  RECAPTCHA_ACTION_THRESHOLDS
  RECAPTCHA_SECRET_KEY
  TURNSTILE_SECRET_KEY
  RECAPTCHA_ENTERPRISE_API_KEY
  RECAPTCHA_ENTERPRISE_PROJECT_ID
  RECAPTCHA_SITE_KEY

Example:
  ./scripts/deploy-verify-api-azure.sh \
    --subscription "My Sub" \
    --resource-group "rg-cij-captcha" \
    --location "eastus2" \
    --app-name "cij-captcha-verify-api-prod" \
    --storage-name "cijcaptchaverifysa001" \
    --cors-origins "https://assets-usa.mkt.dynamics.com,https://assets1-usa.mkt.dynamics.com" \
    --recaptcha-secret-key "YOUR_RECAPTCHA_SECRET" \
    --turnstile-secret-key "YOUR_TURNSTILE_SECRET"
EOF
}

SUBSCRIPTION=""
RESOURCE_GROUP=""
LOCATION=""
APP_NAME=""
STORAGE_NAME=""
SKIP_PROVISION=false

CORS_ORIGINS="${CORS_ORIGINS:-}"
RECAPTCHA_SECRET_KEY="${RECAPTCHA_SECRET_KEY:-}"
TURNSTILE_SECRET_KEY="${TURNSTILE_SECRET_KEY:-}"
RECAPTCHA_MODE="${RECAPTCHA_MODE:-standard}"
RECAPTCHA_ACTION_THRESHOLDS="${RECAPTCHA_ACTION_THRESHOLDS:-cij_form_submit:0.5}"
RECAPTCHA_ENTERPRISE_API_KEY="${RECAPTCHA_ENTERPRISE_API_KEY:-}"
RECAPTCHA_ENTERPRISE_PROJECT_ID="${RECAPTCHA_ENTERPRISE_PROJECT_ID:-}"
RECAPTCHA_SITE_KEY="${RECAPTCHA_SITE_KEY:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --subscription)
      SUBSCRIPTION="$2"
      shift 2
      ;;
    --resource-group)
      RESOURCE_GROUP="$2"
      shift 2
      ;;
    --location)
      LOCATION="$2"
      shift 2
      ;;
    --app-name)
      APP_NAME="$2"
      shift 2
      ;;
    --storage-name)
      STORAGE_NAME="$2"
      shift 2
      ;;
    --cors-origins)
      CORS_ORIGINS="$2"
      shift 2
      ;;
    --recaptcha-mode)
      RECAPTCHA_MODE="$2"
      shift 2
      ;;
    --action-thresholds)
      RECAPTCHA_ACTION_THRESHOLDS="$2"
      shift 2
      ;;
    --recaptcha-secret-key)
      RECAPTCHA_SECRET_KEY="$2"
      shift 2
      ;;
    --turnstile-secret-key)
      TURNSTILE_SECRET_KEY="$2"
      shift 2
      ;;
    --enterprise-api-key)
      RECAPTCHA_ENTERPRISE_API_KEY="$2"
      shift 2
      ;;
    --enterprise-project-id)
      RECAPTCHA_ENTERPRISE_PROJECT_ID="$2"
      shift 2
      ;;
    --enterprise-site-key)
      RECAPTCHA_SITE_KEY="$2"
      shift 2
      ;;
    --skip-provision)
      SKIP_PROVISION=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$SUBSCRIPTION" || -z "$RESOURCE_GROUP" || -z "$APP_NAME" ]]; then
  echo "Error: --subscription, --resource-group, and --app-name are required." >&2
  usage
  exit 1
fi

if [[ "$SKIP_PROVISION" == false ]]; then
  if [[ -z "$LOCATION" || -z "$STORAGE_NAME" ]]; then
    echo "Error: --location and --storage-name are required unless --skip-provision is used." >&2
    usage
    exit 1
  fi
fi

if [[ ! -f "$VERIFY_API_DIR/host.json" ]]; then
  echo "Error: verify-api/host.json not found at $VERIFY_API_DIR" >&2
  exit 1
fi

echo "==> Selecting subscription: $SUBSCRIPTION"
az account set --subscription "$SUBSCRIPTION"

if [[ "$SKIP_PROVISION" == false ]]; then
  echo "==> Ensuring resource group exists"
  az group create --name "$RESOURCE_GROUP" --location "$LOCATION" >/dev/null

  echo "==> Ensuring storage account exists"
  az storage account create \
    --name "$STORAGE_NAME" \
    --location "$LOCATION" \
    --resource-group "$RESOURCE_GROUP" \
    --sku Standard_LRS \
    --allow-blob-public-access false >/dev/null

  echo "==> Ensuring Function App exists (Flex Consumption)"
  if ! az functionapp show --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" >/dev/null 2>&1; then
    az functionapp create \
      --resource-group "$RESOURCE_GROUP" \
      --name "$APP_NAME" \
      --storage-account "$STORAGE_NAME" \
      --flexconsumption-location "$LOCATION" \
      --runtime node \
      --runtime-version 20 >/dev/null
  else
    echo "Function App already exists; reusing it."
  fi
fi

echo "==> Applying app settings"
APP_SETTINGS=(
  "RECAPTCHA_MODE=$RECAPTCHA_MODE"
  "RECAPTCHA_ACTION_THRESHOLDS=$RECAPTCHA_ACTION_THRESHOLDS"
)

if [[ -n "$RECAPTCHA_SECRET_KEY" ]]; then
  APP_SETTINGS+=("RECAPTCHA_SECRET_KEY=$RECAPTCHA_SECRET_KEY")
fi
if [[ -n "$TURNSTILE_SECRET_KEY" ]]; then
  APP_SETTINGS+=("TURNSTILE_SECRET_KEY=$TURNSTILE_SECRET_KEY")
fi
if [[ -n "$RECAPTCHA_ENTERPRISE_API_KEY" ]]; then
  APP_SETTINGS+=("RECAPTCHA_ENTERPRISE_API_KEY=$RECAPTCHA_ENTERPRISE_API_KEY")
fi
if [[ -n "$RECAPTCHA_ENTERPRISE_PROJECT_ID" ]]; then
  APP_SETTINGS+=("RECAPTCHA_ENTERPRISE_PROJECT_ID=$RECAPTCHA_ENTERPRISE_PROJECT_ID")
fi
if [[ -n "$RECAPTCHA_SITE_KEY" ]]; then
  APP_SETTINGS+=("RECAPTCHA_SITE_KEY=$RECAPTCHA_SITE_KEY")
fi

az functionapp config appsettings set \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --settings "${APP_SETTINGS[@]}" >/dev/null

if [[ -n "$CORS_ORIGINS" ]]; then
  echo "==> Configuring CORS (API > CORS)"
  # Clear existing allowed origins
  EXISTING_ORIGINS="$(az functionapp cors show -g "$RESOURCE_GROUP" -n "$APP_NAME" --query "allowedOrigins" -o tsv 2>/dev/null || true)"
  if [[ -n "$EXISTING_ORIGINS" ]]; then
    while IFS= read -r origin; do
      [[ -n "$origin" ]] && az functionapp cors remove -g "$RESOURCE_GROUP" -n "$APP_NAME" --allowed-origins "$origin" >/dev/null 2>&1 || true
    done <<< "$EXISTING_ORIGINS"
  fi
  IFS=',' read -ra CORS_ARRAY <<< "$CORS_ORIGINS"
  for origin in "${CORS_ARRAY[@]}"; do
    origin="${origin// /}"
    [[ -n "$origin" ]] && az functionapp cors add -g "$RESOURCE_GROUP" -n "$APP_NAME" --allowed-origins "$origin" >/dev/null
  done
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "==> Preparing deployment package"
rsync -a \
  --exclude 'node_modules' \
  --exclude '.env' \
  --exclude '.env.bak' \
  --exclude 'config.json' \
  --exclude 'test' \
  "$VERIFY_API_DIR/" "$TMP_DIR/"

pushd "$TMP_DIR" >/dev/null
npm ci --omit=dev >/dev/null
zip -qr "$TMP_DIR/verify-api.zip" .
popd >/dev/null

echo "==> Deploying package"
az functionapp deployment source config-zip \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_NAME" \
  --src "$TMP_DIR/verify-api.zip" >/dev/null

HNAME="$(az functionapp show --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" --query "properties.defaultHostName" -o tsv)"
if [[ -z "$HNAME" || "$HNAME" == "null" ]]; then
  HNAME="$(az functionapp show --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" --query "defaultHostName" -o tsv)"
fi
if [[ -z "$HNAME" || "$HNAME" == "null" ]]; then
  HNAME="$(az functionapp show --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" --query "hostNames[0]" -o tsv)"
fi
echo
echo "Deployment complete."
echo "Verify endpoint: https://$HNAME/api/captcha/verify"