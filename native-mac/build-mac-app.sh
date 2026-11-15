#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="$PROJECT_ROOT/dist"
APP_NAME="TabPulse"
APP_BUNDLE="$DIST_DIR/$APP_NAME.app"
DMG_STAGE="$DIST_DIR/dmg-stage"
DMG_PATH="$DIST_DIR/TabPulse-v0.2.0-macOS-universal.dmg"

rm -rf "$APP_BUNDLE" "$DMG_STAGE" "$DMG_PATH"
mkdir -p "$APP_BUNDLE/Contents/MacOS" "$APP_BUNDLE/Contents/Resources"

echo "[1/5] Generating macOS AppIcon.icns..."
ICON_TMP="$(mktemp -d)"
ICONSET_DIR="$ICON_TMP/AppIcon.iconset"
mkdir -p "$ICONSET_DIR"

/usr/bin/python3 - "$ICON_TMP/base.png" <<'PY'
import sys
from PIL import Image, ImageDraw

out_path = sys.argv[1]
size = 1024
img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# Rounded squircle background (#1E40AF -> #4F46E5 feel)
draw.rounded_rectangle([64, 64, 960, 960], radius=210, fill=(37, 99, 235, 255))
draw.rounded_rectangle([96, 96, 928, 928], radius=185, outline=(147, 197, 253, 95), width=10)

# Radar rings
draw.ellipse([210, 210, 814, 814], outline=(255, 255, 255, 70), width=14)
draw.ellipse([310, 310, 714, 714], outline=(255, 255, 255, 120), width=16)

# Crisp white bell / pulse core
draw.polygon([(512, 270), (350, 580), (674, 580)], fill=(255, 255, 255, 255))
draw.ellipse([382, 310, 642, 570], fill=(255, 255, 255, 255))
draw.rounded_rectangle([320, 560, 704, 632], radius=36, fill=(255, 255, 255, 255))
draw.ellipse([456, 636, 568, 740], fill=(255, 255, 255, 255))

# Unread red alert dot
draw.ellipse([620, 240, 780, 400], fill=(239, 68, 68, 255), outline=(255, 255, 255, 255), width=18)

img.save(out_path, "PNG")
PY

for sz in 16 32 128 256 512; do
  /usr/bin/sips -z "$sz" "$sz" "$ICON_TMP/base.png" --out "$ICONSET_DIR/icon_${sz}x${sz}.png" >/dev/null
  sz2=$((sz * 2))
  /usr/bin/sips -z "$sz2" "$sz2" "$ICON_TMP/base.png" --out "$ICONSET_DIR/icon_${sz}x${sz}@2x.png" >/dev/null
done
/usr/bin/iconutil -c icns "$ICONSET_DIR" -o "$APP_BUNDLE/Contents/Resources/AppIcon.icns"
rm -rf "$ICON_TMP"

echo "[2/5] Bundling UI, probe script, presets, and Info.plist..."
cp "$PROJECT_ROOT/hub/ui/index.html" "$APP_BUNDLE/Contents/Resources/index.html"
cp "$PROJECT_ROOT/extension/probe.js" "$APP_BUNDLE/Contents/Resources/probe.js"
cp "$PROJECT_ROOT/docs/cold-reply-playbook.html" "$APP_BUNDLE/Contents/Resources/cold-reply-playbook.html"

/usr/local/bin/node -e '
import("./seed/preset-packs.mjs").then((m) => {
  import("node:fs").then((fs) => {
    fs.writeFileSync(process.argv[1], JSON.stringify(m.PRESET_PACKS, null, 2));
  });
});
' "$APP_BUNDLE/Contents/Resources/presets.json"

cat > "$APP_BUNDLE/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>万站回音 TabPulse</string>
  <key>CFBundleExecutable</key>
  <string>TabPulse</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>com.shuchuang.tabpulse</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>TabPulse</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.2.0</string>
  <key>CFBundleVersion</key>
  <string>2</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
</dict>
</plist>
PLIST

echo "[3/5] Compiling Universal macOS Binary (arm64 + x86_64)..."
BIN_TMP="$(mktemp -d)"
/usr/bin/swiftc -O \
  -target arm64-apple-macos12.0 \
  -framework Cocoa -framework WebKit -framework CryptoKit \
  "$PROJECT_ROOT/native-mac/TabPulseApp.swift" \
  -o "$BIN_TMP/TabPulse-arm64"

/usr/bin/swiftc -O \
  -target x86_64-apple-macos12.0 \
  -framework Cocoa -framework WebKit -framework CryptoKit \
  "$PROJECT_ROOT/native-mac/TabPulseApp.swift" \
  -o "$BIN_TMP/TabPulse-x86_64"

/usr/bin/lipo -create \
  "$BIN_TMP/TabPulse-arm64" \
  "$BIN_TMP/TabPulse-x86_64" \
  -output "$APP_BUNDLE/Contents/MacOS/TabPulse"
rm -rf "$BIN_TMP"

echo "[4/5] Code signing & running Ed25519 self-test..."
/usr/bin/codesign --force --deep --sign - "$APP_BUNDLE"

SAMPLE_KEY="$(/usr/local/bin/node "$PROJECT_ROOT/bin/generate-license.mjs" --plan lifetime --count 1 --prefix TEST | awk -F'\t' '{print $4}')"
"$APP_BUNDLE/Contents/MacOS/TabPulse" --self-test --verify-key "$SAMPLE_KEY"

echo "[5/5] Packaging macOS Universal DMG & installing to /Applications..."
mkdir -p "$DMG_STAGE"
cp -R "$APP_BUNDLE" "$DMG_STAGE/"
ln -s /Applications "$DMG_STAGE/Applications"
/usr/bin/hdiutil create \
  -volname "TabPulse 万站回音 v0.2.0" \
  -srcfolder "$DMG_STAGE" \
  -ov -format UDZO \
  "$DMG_PATH" >/dev/null
rm -rf "$DMG_STAGE"

rm -rf "/Applications/TabPulse.app"
cp -R "$APP_BUNDLE" "/Applications/TabPulse.app"

ls -lh "$DMG_PATH"
echo "BUILD_COMPLETE: $DMG_PATH"
