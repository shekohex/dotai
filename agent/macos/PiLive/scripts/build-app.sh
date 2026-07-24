#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIGURATION="${CONFIGURATION:-debug}"
ARCH="$(uname -m)"
BUILD_DIR="$ROOT/.build/$ARCH-apple-macosx/$CONFIGURATION"
APP_DIR="$ROOT/.build/Pi Live.app"

cd "$ROOT"
swift build -c "$CONFIGURATION"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Frameworks"
cp "$ROOT/Info.plist" "$APP_DIR/Contents/Info.plist"
cp "$BUILD_DIR/PiLive" "$APP_DIR/Contents/MacOS/PiLive"

while IFS= read -r framework; do
  cp -R "$framework" "$APP_DIR/Contents/Frameworks/"
done < <(find "$ROOT/.build" -type d -name 'WebRTC.framework' -prune)

install_name_tool -add_rpath '@executable_path/../Frameworks' "$APP_DIR/Contents/MacOS/PiLive" 2>/dev/null || true
codesign --force --deep --sign - "$APP_DIR"
printf 'Built %s\n' "$APP_DIR"
