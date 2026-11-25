#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="$PROJECT_ROOT/dist"
MAS_DIR="$PROJECT_ROOT/mas"

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR" "$MAS_DIR"

echo "[1/6] Generating macOS AppIcon.icns..."
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

draw.rounded_rectangle([64, 64, 960, 960], radius=210, fill=(37, 99, 235, 255))
draw.rounded_rectangle([96, 96, 928, 928], radius=185, outline=(147, 197, 253, 95), width=10)
draw.ellipse([210, 210, 814, 814], outline=(255, 255, 255, 70), width=14)
draw.ellipse([310, 310, 714, 714], outline=(255, 255, 255, 120), width=16)
draw.polygon([(512, 270), (350, 580), (674, 580)], fill=(255, 255, 255, 255))
draw.ellipse([382, 310, 642, 570], fill=(255, 255, 255, 255))
draw.rounded_rectangle([320, 560, 704, 632], radius=36, fill=(255, 255, 255, 255))
draw.ellipse([456, 636, 568, 740], fill=(255, 255, 255, 255))
draw.ellipse([620, 240, 780, 400], fill=(239, 68, 68, 255), outline=(255, 255, 255, 255), width=18)

img.save(out_path, "PNG")
PY

for sz in 16 32 128 256 512; do
  /usr/bin/sips -z "$sz" "$sz" "$ICON_TMP/base.png" --out "$ICONSET_DIR/icon_${sz}x${sz}.png" >/dev/null
  sz2=$((sz * 2))
  /usr/bin/sips -z "$sz2" "$sz2" "$ICON_TMP/base.png" --out "$ICONSET_DIR/icon_${sz}x${sz}@2x.png" >/dev/null
done
ICNS_FILE="$ICON_TMP/AppIcon.icns"
/usr/bin/iconutil -c icns "$ICONSET_DIR" -o "$ICNS_FILE"

echo "[2/6] Compiling Universal macOS Binaries (Direct + Mac App Store StoreKit2)..."
BIN_TMP="$(mktemp -d)"

# Direct Universal Binary
/usr/bin/swiftc -O -target arm64-apple-macos12.0 \
  -framework Cocoa -framework WebKit -framework CryptoKit -framework UserNotifications \
  "$PROJECT_ROOT/native-mac/TabPulseApp.swift" -o "$BIN_TMP/direct-arm64"
/usr/bin/swiftc -O -target x86_64-apple-macos12.0 \
  -framework Cocoa -framework WebKit -framework CryptoKit -framework UserNotifications \
  "$PROJECT_ROOT/native-mac/TabPulseApp.swift" -o "$BIN_TMP/direct-x86_64"
UNIVERSAL_DIRECT="$BIN_TMP/DirectExec"
/usr/bin/lipo -create "$BIN_TMP/direct-arm64" "$BIN_TMP/direct-x86_64" -output "$UNIVERSAL_DIRECT"

# Universal Desktop Bridge Helper (Dock Badges + Notification Sniffer + Pure-Text Accessibility/Vision Sync)
/usr/bin/swiftc -O -target arm64-apple-macos12.0 \
  -framework Cocoa -framework CoreGraphics -framework ApplicationServices -framework Vision \
  "$PROJECT_ROOT/native-mac/DesktopBridgeHelper.swift" -o "$BIN_TMP/helper-arm64"
/usr/bin/swiftc -O -target x86_64-apple-macos12.0 \
  -framework Cocoa -framework CoreGraphics -framework ApplicationServices -framework Vision \
  "$PROJECT_ROOT/native-mac/DesktopBridgeHelper.swift" -o "$BIN_TMP/helper-x86_64"
UNIVERSAL_HELPER="$BIN_TMP/mac-desktop-helper"
/usr/bin/lipo -create "$BIN_TMP/helper-arm64" "$BIN_TMP/helper-x86_64" -output "$UNIVERSAL_HELPER"
cp "$UNIVERSAL_HELPER" "$PROJECT_ROOT/bin/mac-desktop-helper"
chmod +x "$PROJECT_ROOT/bin/mac-desktop-helper"

# MAS StoreKit2 Universal Binary
/usr/bin/swiftc -O -DMAS_BUILD -target arm64-apple-macos12.0 \
  -framework Cocoa -framework WebKit -framework CryptoKit -framework UserNotifications -framework StoreKit \
  "$PROJECT_ROOT/native-mac/TabPulseApp.swift" -o "$BIN_TMP/mas-arm64"
/usr/bin/swiftc -O -DMAS_BUILD -target x86_64-apple-macos12.0 \
  -framework Cocoa -framework WebKit -framework CryptoKit -framework UserNotifications -framework StoreKit \
  "$PROJECT_ROOT/native-mac/TabPulseApp.swift" -o "$BIN_TMP/mas-x86_64"
UNIVERSAL_MAS="$BIN_TMP/MasExec"
/usr/bin/lipo -create "$BIN_TMP/mas-arm64" "$BIN_TMP/mas-x86_64" -output "$UNIVERSAL_MAS"

PRESETS_TMP="$BIN_TMP/presets.json"
/usr/local/bin/node -e '
import("./seed/preset-packs.mjs").then((m) => {
  import("node:fs").then((fs) => {
    fs.writeFileSync(process.argv[1], JSON.stringify(m.PRESET_PACKS, null, 2));
  });
});
' "$PRESETS_TMP"

populate_bundle() {
  local app_dir="$1"
  local bundle_name="$2"
  local exec_name="$3"
  local bundle_id="$4"
  local dev_region="$5"
  local src_bin="$6"
  local short_ver="${7:-2.0.0}"
  local build_num="${8:-2}"

  mkdir -p "$app_dir/Contents/MacOS" "$app_dir/Contents/Resources/zh-Hans.lproj" "$app_dir/Contents/Resources/en.lproj"
  cp "$src_bin" "$app_dir/Contents/MacOS/$exec_name"
  chmod +x "$app_dir/Contents/MacOS/$exec_name"
  cp "$ICNS_FILE" "$app_dir/Contents/Resources/AppIcon.icns"
  cp "$PROJECT_ROOT/hub/ui/index.html" "$app_dir/Contents/Resources/index.html"
  cp "$PROJECT_ROOT/extension/probe.js" "$app_dir/Contents/Resources/probe.js"
  cp "$PROJECT_ROOT/extension/passive-observer.js" "$app_dir/Contents/Resources/passive-observer.js"
  cp "$PROJECT_ROOT/docs/cold-reply-playbook.html" "$app_dir/Contents/Resources/cold-reply-playbook.html"
  cp "$PRESETS_TMP" "$app_dir/Contents/Resources/presets.json"

  printf '"CFBundleDisplayName" = "消息总管";\n"CFBundleName" = "消息总管";\n' > "$app_dir/Contents/Resources/zh-Hans.lproj/InfoPlist.strings"
  printf '"CFBundleDisplayName" = "ReplyRadar";\n"CFBundleName" = "ReplyRadar";\n' > "$app_dir/Contents/Resources/en.lproj/InfoPlist.strings"

  cat > "$app_dir/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>${dev_region}</string>
  <key>CFBundleDisplayName</key>
  <string>${bundle_name}</string>
  <key>CFBundleExecutable</key>
  <string>${exec_name}</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>${bundle_id}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${bundle_name}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${short_ver}</string>
  <key>CFBundleVersion</key>
  <string>${build_num}</string>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.productivity</string>
  <key>LSHasLocalizedDisplayName</key>
  <true/>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>ITSAppUsesNonExemptEncryption</key>
  <false/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
</dict>
</plist>
PLIST
}

bundle_embedded_server() {
  local app_dir="$1"
  local srv_root="$app_dir/Contents/Resources/app-server"
  mkdir -p "$srv_root/hub/ui" "$srv_root/mcp-server" "$srv_root/skills/replyradar-notify" "$srv_root/seed" "$srv_root/docs" "$srv_root/bin" "$srv_root/extension"
  cp "$PROJECT_ROOT/hub/"*.mjs "$srv_root/hub/"
  cp "$PROJECT_ROOT/hub/ui/"* "$srv_root/hub/ui/"
  cp "$PROJECT_ROOT/extension/"* "$srv_root/extension/"
  cp "$PROJECT_ROOT/mcp-server/index.mjs" "$srv_root/mcp-server/"
  cp "$PROJECT_ROOT/skills/replyradar-notify/SKILL.md" "$srv_root/skills/replyradar-notify/"
  cp "$PROJECT_ROOT/bin/setup-ai.mjs" "$srv_root/bin/"
  cp "$PROJECT_ROOT/seed/"*.mjs "$srv_root/seed/"
  cp "$PROJECT_ROOT/docs/cold-reply-playbook.html" "$srv_root/docs/"
  cp "$PROJECT_ROOT/llms.txt" "$srv_root/"
  cp "$UNIVERSAL_HELPER" "$srv_root/bin/mac-desktop-helper"
  chmod +x "$srv_root/bin/mac-desktop-helper" "$srv_root/mcp-server/index.mjs" "$srv_root/bin/setup-ai.mjs"
}

SIGN_IDENTITY="-"
if security find-identity -v -p codesigning | grep -q "Apple Development: Yang He (KU364788TC)"; then
  SIGN_IDENTITY="Apple Development: Yang He (KU364788TC)"
fi

echo "[3/6] Assembling Direct CN (消息总管.app) & Direct EN (ReplyRadar.app)..."
populate_bundle "$DIST_DIR/消息总管.app" "消息总管" "XiaoXiZongGuan" "com.shuchuang.xiaoxizongguan" "zh_CN" "$UNIVERSAL_DIRECT" "5.3.0" "8"
bundle_embedded_server "$DIST_DIR/消息总管.app"
/usr/bin/codesign --force --deep --sign "$SIGN_IDENTITY" "$DIST_DIR/消息总管.app"

populate_bundle "$DIST_DIR/ReplyRadar.app" "ReplyRadar" "ReplyRadar" "com.shuchuang.replyradar" "en" "$UNIVERSAL_DIRECT" "5.3.0" "8"
bundle_embedded_server "$DIST_DIR/ReplyRadar.app"
/usr/bin/codesign --force --deep --sign "$SIGN_IDENTITY" "$DIST_DIR/ReplyRadar.app"

echo "[4/6] Running self-tests on compiled Universal binaries..."
SAMPLE_KEY="$(/usr/local/bin/node "$PROJECT_ROOT/bin/generate-license.mjs" --plan lifetime --count 1 --prefix TEST | awk -F'\t' '{print $4}')"
"$DIST_DIR/消息总管.app/Contents/MacOS/XiaoXiZongGuan" --self-test --verify-key "$SAMPLE_KEY"
"$DIST_DIR/ReplyRadar.app/Contents/MacOS/ReplyRadar" --self-test --verify-key "$SAMPLE_KEY"

echo "[5/6] Building Official Apple Signed Mac App Store Package (ReplyRadar-MAS-1.0.0.pkg)..."
if [ -f "$MAS_DIR/embedded.provisionprofile" ] && security find-identity -v | grep -q "Apple Distribution: Yang He (KU364788TC)"; then
  MAS_STAGE="$BIN_TMP/mas-stage"
  mkdir -p "$MAS_STAGE"
  MAS_APP="$MAS_STAGE/ReplyRadar.app"
  populate_bundle "$MAS_APP" "ReplyRadar" "ReplyRadar" "com.yanghe.replyradar" "zh_CN" "$UNIVERSAL_MAS" "1.0.0" "2"
  cp "$MAS_DIR/embedded.provisionprofile" "$MAS_APP/Contents/embedded.provisionprofile"

  ENT_FILE="$MAS_DIR/ReplyRadar-MAS.entitlements"
  cat > "$ENT_FILE" <<'ENT'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.app-sandbox</key>
  <true/>
  <key>com.apple.security.network.client</key>
  <true/>
  <key>com.apple.application-identifier</key>
  <string>KU364788TC.com.yanghe.replyradar</string>
  <key>com.apple.developer.team-identifier</key>
  <string>KU364788TC</string>
</dict>
</plist>
ENT

  /usr/bin/codesign --force --deep --options runtime \
    --entitlements "$ENT_FILE" \
    --sign "Apple Distribution: Yang He (KU364788TC)" \
    "$MAS_APP"

  /usr/bin/productbuild \
    --component "$MAS_APP" /Applications \
    --sign "3rd Party Mac Developer Installer: Yang He (KU364788TC)" \
    "$DIST_DIR/ReplyRadar-MAS-1.0.0.pkg"
  echo "MAS_PKG_SIGNED_OK: $DIST_DIR/ReplyRadar-MAS-1.0.0.pkg"
fi

rm -rf "$ICON_TMP" "$BIN_TMP"

echo "[6/6] Packaging CN & EN DMG installers and updating /Applications/消息总管.app..."
STAGE_CN="$(mktemp -d)"
cp -R "$DIST_DIR/消息总管.app" "$STAGE_CN/"
ln -s /Applications "$STAGE_CN/Applications"
/usr/bin/hdiutil create -volname "消息总管" -srcfolder "$STAGE_CN" -ov -format UDZO "$DIST_DIR/消息总管-macOS安装包.dmg" >/dev/null
cp "$DIST_DIR/消息总管-macOS安装包.dmg" "$DIST_DIR/XiaoXiZongGuan-CN-macOS.dmg"
rm -rf "$STAGE_CN"

STAGE_EN="$(mktemp -d)"
cp -R "$DIST_DIR/ReplyRadar.app" "$STAGE_EN/"
ln -s /Applications "$STAGE_EN/Applications"
/usr/bin/hdiutil create -volname "ReplyRadar" -srcfolder "$STAGE_EN" -ov -format UDZO "$DIST_DIR/ReplyRadar-EN-macOS.dmg" >/dev/null
rm -rf "$STAGE_EN"

rm -rf "/Applications/TabPulse.app" "/Applications/消息总管.app"
cp -R "$DIST_DIR/消息总管.app" "/Applications/消息总管.app"

ls -lh "$DIST_DIR"
echo "ALL_MAC_BUILDS_COMPLETE"
