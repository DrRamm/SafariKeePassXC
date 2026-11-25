#!/usr/bin/env bash
# Rebuild every raster icon from the vector masters.
#
# The brand mark is the popup header tile: the thin key on a flat blue rounded
# badge. On a canvas the badge is 80% wide (10% margin on every side), the
# corner radius is 30% of the badge, and the key occupies 50% of the badge,
# centred. toolbar-icon.svg is the master for the toolbar and extension icons;
# app-icon.svg is the master for the macOS app icon (same geometry plus the
# macOS drop shadow).
#
# The 16-19 px slots use the *-small.svg optical variants: at the reference key
# ratio the stroke is sub-pixel there and the glyph turns into a blob.
#
# Requires rsvg-convert (brew install librsvg; the app-icon drop shadow needs
# librsvg 2.50 or newer).
set -euo pipefail

cd "$(dirname "$0")/.."

EXT="SafariKeePassXC Extension/Resources/images"
APP="SafariKeePassXC/Assets.xcassets/AppIcon.appiconset"
TOOLBAR_MASTER="$EXT/toolbar-icon.svg"
TOOLBAR_SMALL_MASTER="$EXT/toolbar-icon-small.svg"
APP_MASTER="scripts/app-icon.svg"
APP_SMALL_MASTER="scripts/app-icon-small.svg"

render() {
    local master=$1 size=$2 out=$3
    rsvg-convert --width "$size" --height "$size" "$master" --output "$out"
}

# Safari toolbar (action.default_icon)
render "$TOOLBAR_SMALL_MASTER" 16 "$EXT/toolbar-icon-16.png"
render "$TOOLBAR_SMALL_MASTER" 19 "$EXT/toolbar-icon-19.png"
render "$TOOLBAR_MASTER" 32 "$EXT/toolbar-icon-32.png"
render "$TOOLBAR_MASTER" 38 "$EXT/toolbar-icon-38.png"

# Extension listing icons
for size in 48 64 96 128 256 512; do
    render "$TOOLBAR_MASTER" "$size" "$EXT/icon-$size.png"
done

# macOS app icon, 1x and @2x
render "$APP_SMALL_MASTER" 16 "$APP/icon_16.png"
for size in 32 128 256 512; do
    render "$APP_MASTER" "$size" "$APP/icon_$size.png"
    render "$APP_MASTER" "$((size * 2))" "$APP/icon_$size@2x.png"
done
render "$APP_MASTER" 32 "$APP/icon_16@2x.png"

echo "Icons rendered from $TOOLBAR_MASTER and $APP_MASTER"
