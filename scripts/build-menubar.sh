#!/bin/bash
# Build the macOS menu bar companion into menubar/build/Worktime.app.
#
# Uses the swiftc that ships with the Xcode command line tools — no Xcode
# project, no SwiftPM manifest, nothing to install, in keeping with the rest of
# the repo having no build step.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/menubar/build/Worktime.app"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found — install the Xcode command line tools:" >&2
  echo "  xcode-select --install" >&2
  exit 1
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Worktime</string>
  <key>CFBundleDisplayName</key><string>Worktime</string>
  <key>CFBundleIdentifier</key><string>dev.worktime.menubar</string>
  <key>CFBundleExecutable</key><string>Worktime</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <!-- Menu bar only: no Dock icon, no app switcher entry. -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

swiftc -O \
  -o "$APP/Contents/MacOS/Worktime" \
  -framework AppKit \
  "$ROOT/menubar/WorktimeMenuBar.swift"

# Ad-hoc signature, otherwise macOS kills the unsigned bundle on launch.
codesign --force --sign - "$APP" 2>/dev/null || true

echo "built $APP"
echo "run:      open '$APP'"
echo "at login: System Settings → General → Login Items → +"
