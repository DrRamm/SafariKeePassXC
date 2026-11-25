#!/usr/bin/env bash
#
# Checks that the app version is consistent across the Xcode project (app and
# extension targets) and the Safari extension manifest.
#
# Usage:
#   scripts/check-versions.sh            # compare the three versions
#   scripts/check-versions.sh v1.2.5     # also require this version (release tag)
#
set -euo pipefail

cd "$(dirname "$0")/.."

read_marketing_version() {
    xcodebuild -project SafariKeePassXC.xcodeproj \
        -target "$1" -configuration Release -showBuildSettings 2>/dev/null \
        | awk -F' = ' '/^ *MARKETING_VERSION = /{print $2; exit}'
}

app_version="$(read_marketing_version "SafariKeePassXC")"
extension_version="$(read_marketing_version "SafariKeePassXC Extension")"
manifest_version="$(
    python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' \
        "SafariKeePassXC Extension/Resources/manifest.json"
)"

echo "App MARKETING_VERSION:       $app_version"
echo "Extension MARKETING_VERSION: $extension_version"
echo "Manifest version:            $manifest_version"

for value in "$app_version" "$extension_version" "$manifest_version"; do
    if [[ -z "$value" ]]; then
        echo "error: could not read one of the versions" >&2
        exit 1
    fi
done

if [[ "$app_version" != "$extension_version" || "$app_version" != "$manifest_version" ]]; then
    echo "error: app, extension and manifest versions must match" >&2
    exit 1
fi

if [[ $# -ge 1 ]]; then
    expected="${1#v}"
    echo "Expected version:            $expected"
    if [[ "$expected" != "$app_version" ]]; then
        echo "error: expected version $expected does not match $app_version" >&2
        exit 1
    fi
fi
