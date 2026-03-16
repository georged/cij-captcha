#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

WEBRESOURCE_SOURCE="config-page/cij-captcha-config.html"
WEBRESOURCE_NAME="gd_cijcaptchaconfig"
SOLUTION_ZIP="artifacts/CIJ_Captcha.zip"
PLUGIN_ID="ba5e7404-c30c-405e-8974-3423a1f12c05"
PLUGIN_DLL="plugin/bin/Release/net462/Georged.Cij.Captcha.dll"

for cmd in dotnet pac zip; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
done

if [[ ! -f "$WEBRESOURCE_SOURCE" ]]; then
  echo "Missing web resource source: $WEBRESOURCE_SOURCE" >&2
  exit 1
fi

if [[ ! -f "$SOLUTION_ZIP" ]]; then
  echo "Missing solution zip: $SOLUTION_ZIP" >&2
  exit 1
fi

echo "[1/6] Build plugin (Release)"
dotnet build plugin/Georged.Cij.Captcha.csproj -c Release

if [[ ! -f "$PLUGIN_DLL" ]]; then
  echo "Plugin DLL not found after build: $PLUGIN_DLL" >&2
  exit 1
fi

echo "[2/5] Refresh config page web resource via pac unpack/pack"
TMP_DIR="$(mktemp -d /tmp/cij_solution_unpack.XXXXXX)"

pac solution unpack \
  --zipfile "$SOLUTION_ZIP" \
  --folder "$TMP_DIR" \
  --packagetype Unmanaged \
  --allowDelete \
  --allowWrite \
  --clobber

cp "$WEBRESOURCE_SOURCE" "$TMP_DIR/WebResources/$WEBRESOURCE_NAME"

pac solution pack \
  --zipfile "$SOLUTION_ZIP" \
  --folder "$TMP_DIR" \
  --packagetype Unmanaged

rm -rf "$TMP_DIR"

echo "[3/5] Import solution (activate plugins + publish changes)"
pac solution import --path "$SOLUTION_ZIP" --activate-plugins --publish-changes

echo "[4/5] Push plugin assembly"
(
  cd plugin
  pac plugin push --pluginId "$PLUGIN_ID" --type Assembly --pluginFile "bin/Release/net462/Georged.Cij.Captcha.dll" --configuration Release
)

echo "[5/5] Deployment complete"
