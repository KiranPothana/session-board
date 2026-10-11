#!/bin/sh
# Builds Session Board.app, the floating window that lists every Claude Code session.
# The mod runs it the first time it's needed, and again when an update changes main.swift or
# this file:
#   sh build.sh "$HOME/Applications/Session Board.app"
# With no argument it builds next to this script, for trying a change.
#
# Building on your own Mac is what lets it run without Apple's notarization: macOS checks
# downloaded apps, and this one isn't downloaded.
set -e
SRC=$(cd "$(dirname "$0")" && pwd)
APP=${1:-"$SRC/Session Board.app"}
BUNDLE_ID=io.github.kiranpothana.session-board
DATA="$HOME/Library/Application Support/session-board"
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$SRC/../.claude-plugin/plugin.json" | head -1)

if ! xcode-select -p >/dev/null 2>&1; then
  echo "Session Board needs Apple's command-line tools to build its window: run xcode-select --install" >&2
  exit 2
fi

# One build at a time: two sessions can start one together. A lock left by a build that was
# killed is taken over after 10 minutes.
LOCK="$APP.lock"
mkdir -p "$(dirname "$APP")"
if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then rmdir "$LOCK" 2>/dev/null || true; fi
if ! mkdir "$LOCK" 2>/dev/null; then
  i=0
  while [ -d "$LOCK" ] && [ $i -lt 600 ]; do sleep 1; i=$((i + 1)); done
  if [ -d "$APP" ]; then echo "built $APP (by the build already running)"; exit 0; fi
  mkdir "$LOCK"
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

TMP="$APP.tmp"
rm -rf "$TMP"
mkdir -p "$TMP/Contents/MacOS"
swiftc -O -swift-version 5 -o "$TMP/Contents/MacOS/SessionBoard" "$SRC/main.swift"
# The icon, which the app draws itself; without it the app gets the generic one
ICON=
rm -rf "$TMP.iconset"
if "$TMP/Contents/MacOS/SessionBoard" --iconset "$TMP.iconset" >/dev/null 2>&1 \
  && mkdir -p "$TMP/Contents/Resources" \
  && iconutil -c icns -o "$TMP/Contents/Resources/AppIcon.icns" "$TMP.iconset" 2>/dev/null; then
  ICON='<key>CFBundleIconFile</key><string>AppIcon</string>'
fi
rm -rf "$TMP.iconset"
# The three sounds (needs you, your turn, done); Settings plays them by name
mkdir -p "$TMP/Contents/Resources"
cp "$SRC"/sounds/*.wav "$TMP/Contents/Resources/"
cat > "$TMP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleName</key><string>Session Board</string>
  <key>CFBundleExecutable</key><string>SessionBoard</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION:-0.0.0}</string>
  $ICON
  <key>LSMinimumSystemVersion</key><string>15.0</string>
  <!-- Starts with no Dock icon; the Regular window setting adds one -->
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppleEventsUsageDescription</key><string>To highlight the session in the Terminal or iTerm tab you're looking at.</string>
</dict>
</plist>
PLIST
# Signed with your Apple Development certificate when you have one, so macOS keeps the
# Accessibility permission across rebuilds; otherwise ad hoc, and a rebuild asks for it again
IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null | grep -o '"Apple Development[^"]*"' | head -1 | tr -d '"')
if [ -n "$IDENTITY" ] && codesign --force --sign "$IDENTITY" "$TMP" >/dev/null 2>&1; then
  echo "signed with $IDENTITY"
else
  codesign --force --sign - "$TMP" >/dev/null 2>&1 || true
  echo "signed ad hoc"
fi

# A running window is the old build: quit it, and the mod opens the new one
pkill -x SessionBoard 2>/dev/null || true
mkdir -p "$(dirname "$APP")"
rm -rf "$APP"
mv "$TMP" "$APP"
# What the installed app was built from: the mod builds again only when this changes
if [ -n "$1" ]; then
  mkdir -p "$DATA"
  shasum -a 256 "$SRC/main.swift" "$SRC/build.sh" | awk '{print $1}' | paste -sd: - > "$DATA/built.sha"
fi
echo "built $APP"
