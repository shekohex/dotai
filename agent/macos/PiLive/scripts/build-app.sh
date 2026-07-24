#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIGURATION="${CONFIGURATION:-debug}"
ARCH="$(uname -m)"
BUILD_DIR="$ROOT/.build/$ARCH-apple-macosx/$CONFIGURATION"
APP_DIR="$ROOT/.build/Pi Live.app"

cd "$ROOT"
swift package resolve >/dev/null

# KeyboardShortcuts uses Bundle.module for recorder localization. SwiftPM's generated executable
# accessor searches beside the command-line binary, but Pi Live is manually wrapped as a macOS app
# and stores resource bundles under Contents/Resources. Route localization through a safe lookup
# before compiling so the finished app remains relocatable and code-signable.
KEYBOARD_SHORTCUTS_UTILITIES="$ROOT/.build/checkouts/KeyboardShortcuts/Sources/KeyboardShortcuts/Utilities.swift"
if [[ -f "$KEYBOARD_SHORTCUTS_UTILITIES" ]]; then
  chmod +w "$KEYBOARD_SHORTCUTS_UTILITIES"
  python3 - "$KEYBOARD_SHORTCUTS_UTILITIES" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text()
if ".piLiveKeyboardShortcutsBundle" not in text:
    text = text.replace(
        "NSLocalizedString(self, bundle: .module, comment: self)",
        "NSLocalizedString(self, bundle: .piLiveKeyboardShortcutsBundle, comment: self)",
    )
    injection = """
private extension Bundle {
    static let piLiveKeyboardShortcutsBundle: Bundle = {
        if let url = Bundle.main.url(
            forResource: "KeyboardShortcuts_KeyboardShortcuts",
            withExtension: "bundle"
        ), let bundle = Bundle(url: url) {
            return bundle
        }

        return Bundle.main
    }()
}
"""
    marker = "}\n\n\nextension Data {"
    if marker not in text:
        raise SystemExit("Unable to patch KeyboardShortcuts localization lookup")
    text = text.replace(marker, "}\n\n" + injection + "\nextension Data {", 1)
    path.write_text(text)
PY
fi

swift build -c "$CONFIGURATION"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Frameworks" "$APP_DIR/Contents/Resources"
cp "$ROOT/Info.plist" "$APP_DIR/Contents/Info.plist"
cp "$BUILD_DIR/PiLive" "$APP_DIR/Contents/MacOS/PiLive"

cp -R "$BUILD_DIR/WebRTC.framework" "$APP_DIR/Contents/Frameworks/"
for resource_bundle in "$BUILD_DIR"/*.bundle; do
  if [[ -d "$resource_bundle" ]]; then
    cp -R "$resource_bundle" "$APP_DIR/Contents/Resources/"
  fi
done

install_name_tool -add_rpath '@executable_path/../Frameworks' "$APP_DIR/Contents/MacOS/PiLive" 2>/dev/null || true
codesign --force --deep --sign - "$APP_DIR"
printf 'Built %s\n' "$APP_DIR"
