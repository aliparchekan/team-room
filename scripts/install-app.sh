#!/bin/bash
# Install Team Room as a Mac app and a terminal command.
#
#   scripts/install-app.sh            installs ~/Applications/Team Room.app and ~/.local/bin/team-room
#   scripts/install-app.sh --remove   removes both (your rooms and data are untouched)
#
# The app runs scripts/team-room.sh from this checkout: it opens T3 Code, starts the
# Team Room server if needed, and opens Team Room in its own window.
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
APP="$HOME/Applications/Team Room.app"
BIN="$HOME/.local/bin/team-room"

if [ "${1:-}" = "--remove" ]; then
  # Only remove what this script created.
  [ -f "$APP/Contents/Resources/.team-room-installer" ] && rm -rf "$APP" && echo "Removed $APP"
  [ -L "$BIN" ] && [ "$(readlink "$BIN")" = "$ROOT/scripts/team-room.sh" ] && rm "$BIN" && echo "Removed $BIN"
  exit 0
fi

if [ -e "$APP" ] && [ ! -f "$APP/Contents/Resources/.team-room-installer" ]; then
  echo "$APP exists and was not made by this installer; not replacing it." >&2
  exit 1
fi

chmod +x "$ROOT/scripts/team-room.sh"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
touch "$APP/Contents/Resources/.team-room-installer"

cat >"$APP/Contents/MacOS/Team Room" <<EOF
#!/bin/bash
exec "$ROOT/scripts/team-room.sh" open
EOF
chmod +x "$APP/Contents/MacOS/Team Room"

cat >"$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Team Room</string>
  <key>CFBundleDisplayName</key><string>Team Room</string>
  <key>CFBundleIdentifier</key><string>local.team-room.launcher</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>0.1</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Team Room</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
EOF

# Icon: draw it, then let macOS build the .icns from the standard sizes.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
python3 "$ROOT/scripts/make-icon.py" "$TMP/icon.png"
ICONSET="$TMP/AppIcon.iconset"
mkdir "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$TMP/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$TMP/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
touch "$APP"

mkdir -p "$(dirname "$BIN")"
ln -sf "$ROOT/scripts/team-room.sh" "$BIN"

echo "Installed:"
echo "  $APP   (Spotlight: \"Team Room\"; drag it to the Dock to keep it there)"
echo "  $BIN   (team-room | team-room stop | team-room status | team-room logs)"
