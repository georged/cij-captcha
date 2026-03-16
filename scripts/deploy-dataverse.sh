#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SOLUTION_NAME="CIJCaptcha"
WEBRESOURCE_SOURCE="config-page/cij-captcha-config.html"
WEBRESOURCE_NAME="gd_cijcaptchaconfig"
ARTIFACTS_DIR="artifacts"
ARTIFACT_UNMANAGED_ZIP="$ARTIFACTS_DIR/CIJ_Captcha_unmanaged.zip"
ARTIFACT_MANAGED_ZIP="$ARTIFACTS_DIR/CIJ_Captcha_managed.zip"
ARTIFACT_UNPACK_DIR="$ARTIFACTS_DIR/CIJ_Captcha"
PLUGIN_CSPROJ="plugin/Georged.Cij.Captcha.csproj"
PLUGIN_DLL="plugin/bin/Release/net462/Georged.Cij.Captcha.dll"

increment_revision() {
  local version="$1"
  local a b c d
  IFS='.' read -r a b c d <<<"$version"
  if [[ -z "${a:-}" || -z "${b:-}" || -z "${c:-}" || -z "${d:-}" ]]; then
    echo "Invalid version format: $version" >&2
    exit 1
  fi
  echo "${a}.${b}.${c}.$((d + 1))"
}

extract_tag_value() {
  local file="$1"
  local tag="$2"
  sed -n "s:.*<${tag}>\([0-9][0-9]*\(\.[0-9][0-9]*\)\{3\}\)</${tag}>.*:\1:p" "$file" | head -1
}

replace_in_file() {
  local file="$1"
  local pattern="$2"
  local replacement="$3"
  perl -0777 -i.bak -pe "s#${pattern}#${replacement}#g" "$file"
  rm -f "${file}.bak"
}

replace_plugin_version_refs() {
  local file="$1"
  local new_version="$2"
  NEW_PLUGIN_VERSION="$new_version" perl -0777 -i.bak -pe '
    s{(Georged\.Cij\.Captcha(?:\.CaptchaValidationPlugin)?(?:, Georged\.Cij\.Captcha)?, Version=)\d+\.\d+\.\d+\.\d+}{$1$ENV{NEW_PLUGIN_VERSION}}g;
  ' "$file"
  rm -f "${file}.bak"
}

for cmd in dotnet pac perl find; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
done

if [[ ! -f "$WEBRESOURCE_SOURCE" ]]; then
  echo "Missing web resource source: $WEBRESOURCE_SOURCE" >&2
  exit 1
fi

if [[ ! -f "$PLUGIN_CSPROJ" ]]; then
  echo "Missing plugin project file: $PLUGIN_CSPROJ" >&2
  exit 1
fi

mkdir -p "$ARTIFACTS_DIR"

WORK_DIR="$(mktemp -d /tmp/cij_deploy.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

EXPORTED_UNMANAGED_ZIP="$WORK_DIR/CIJ_Captcha_export_unmanaged.zip"
DEPLOY_UNMANAGED_ZIP="$WORK_DIR/CIJ_Captcha_deploy_unmanaged.zip"
UNPACK_DIR="$WORK_DIR/unpack"

echo "[1/7] Export current unmanaged solution from Dataverse"
pac solution export --name "$SOLUTION_NAME" --path "$EXPORTED_UNMANAGED_ZIP" --overwrite

echo "[2/7] Unpack exported solution"
pac solution unpack \
  --zipfile "$EXPORTED_UNMANAGED_ZIP" \
  --folder "$UNPACK_DIR" \
  --packagetype Unmanaged \
  --allowDelete \
  --allowWrite \
  --clobber

echo "[3/7] Increment plugin and solution versions"
CURRENT_PLUGIN_VERSION="$(extract_tag_value "$PLUGIN_CSPROJ" "AssemblyVersion")"
CURRENT_SOLUTION_VERSION="$(extract_tag_value "$UNPACK_DIR/Other/Solution.xml" "Version")"

if [[ -z "$CURRENT_PLUGIN_VERSION" || -z "$CURRENT_SOLUTION_VERSION" ]]; then
  echo "Failed to read current versions from metadata files." >&2
  exit 1
fi

NEW_PLUGIN_VERSION="$(increment_revision "$CURRENT_PLUGIN_VERSION")"
NEW_SOLUTION_VERSION="$(increment_revision "$CURRENT_SOLUTION_VERSION")"

replace_in_file "$PLUGIN_CSPROJ" '<AssemblyVersion>[0-9]+(\.[0-9]+){3}</AssemblyVersion>' "<AssemblyVersion>${NEW_PLUGIN_VERSION}</AssemblyVersion>"
replace_in_file "$PLUGIN_CSPROJ" '<FileVersion>[0-9]+(\.[0-9]+){3}</FileVersion>' "<FileVersion>${NEW_PLUGIN_VERSION}</FileVersion>"

echo "  Plugin version:  ${CURRENT_PLUGIN_VERSION} -> ${NEW_PLUGIN_VERSION}"
echo "  Solution version: ${CURRENT_SOLUTION_VERSION} -> ${NEW_SOLUTION_VERSION}"

echo "[4/7] Build plugin (Release)"
dotnet build plugin/Georged.Cij.Captcha.csproj -c Release

if [[ ! -f "$PLUGIN_DLL" ]]; then
  echo "Plugin DLL not found after build: $PLUGIN_DLL" >&2
  exit 1
fi

echo "[5/7] Copy latest components and apply version metadata"
cp "$WEBRESOURCE_SOURCE" "$UNPACK_DIR/WebResources/$WEBRESOURCE_NAME"

UNPACKED_PLUGIN_DLL="$(find "$UNPACK_DIR/PluginAssemblies" -type f -name '*.dll' | head -1)"
if [[ -z "$UNPACKED_PLUGIN_DLL" ]]; then
  echo "Could not find unpacked plugin assembly under $UNPACK_DIR/PluginAssemblies" >&2
  exit 1
fi
cp "$PLUGIN_DLL" "$UNPACKED_PLUGIN_DLL"

replace_in_file "$UNPACK_DIR/Other/Solution.xml" '<Version>[0-9]+(\.[0-9]+){3}</Version>' "<Version>${NEW_SOLUTION_VERSION}</Version>"

while IFS= read -r xml_file; do
  replace_plugin_version_refs "$xml_file" "$NEW_PLUGIN_VERSION"
done < <(find "$UNPACK_DIR" -type f \( -name '*.xml' -o -name '*.data.xml' \))

echo "[6/7] Pack and deploy updated unmanaged solution"
pac solution pack \
  --zipfile "$DEPLOY_UNMANAGED_ZIP" \
  --folder "$UNPACK_DIR" \
  --packagetype Unmanaged

pac solution import --path "$DEPLOY_UNMANAGED_ZIP" --activate-plugins --publish-changes

echo "[7/7] Export managed and unmanaged solution artifacts"
pac solution export --name "$SOLUTION_NAME" --path "$ARTIFACT_UNMANAGED_ZIP" --overwrite
pac solution export --name "$SOLUTION_NAME" --managed --path "$ARTIFACT_MANAGED_ZIP" --overwrite

pac solution unpack \
  --zipfile "$ARTIFACT_UNMANAGED_ZIP" \
  --folder "$ARTIFACT_UNPACK_DIR" \
  --packagetype Unmanaged \
  --allowDelete \
  --allowWrite \
  --clobber

echo "Deployment complete"
echo "  Unmanaged artifact: $ARTIFACT_UNMANAGED_ZIP"
echo "  Managed artifact:   $ARTIFACT_MANAGED_ZIP"
