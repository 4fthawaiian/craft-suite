#!/bin/sh
# build-installer.sh — regenerate dist/craft-suite-install.sh from the current
# sources in this directory. Run after changing serve.js / suite-shim.js /
# index.html / update.js.
set -e
cd "$(dirname "$0")"
mkdir -p dist
OUT=dist/craft-suite-install.sh

emit_file() {  # $1 = source file, $2 = dest name, $3 = heredoc tag
  echo "cat > \"\$DIR/$2\" <<'$3'" >> "$OUT"
  cat "$1" >> "$OUT"
  echo "$3" >> "$OUT"
  echo >> "$OUT"
}

cat > "$OUT" <<'HEADER'
#!/bin/sh
# ============================================================================
# Craft Suite — self-hosted ArtCraft web apps with server-side file storage.
#
# Single-file installer. Run:
#     sh craft-suite-install.sh
#   or pipe: curl -fsSL <url>/craft-suite-install.sh | sh
#
# Config via environment:
#     CRAFT_SUITE_DIR   install location   (default: ~/craft-suite)
#     CRAFT_SUITE_PORT  listen port        (default: 8091)
#     CRAFT_SUITE_APPS  comma-separated apps to fetch
#                     (default: gridcraft,wordcraft,deckcraft,pdfcraft,photocraft,figcraft)
#     INSTALL_SERVICE   1 = install systemd user service (default when available)
#
# ArtCraft app code is MIT/Apache-2.0 (github.com/storytold). Names and logos
# are ArtCraft trademarks — personal/homelab redistribution only.
# ============================================================================
set -e

DIR="${CRAFT_SUITE_DIR:-$HOME/craft-suite}"
PORT="${CRAFT_SUITE_PORT:-8091}"
APPS="${CRAFT_SUITE_APPS:-gridcraft,wordcraft,deckcraft,pdfcraft,photocraft,figcraft}"

echo "==> Craft Suite installer"
echo "    dir:  $DIR"
echo "    port: $PORT"
echo "    apps: $APPS"

command -v node  >/dev/null 2>&1 || { echo "error: node.js required (https://nodejs.org)"; exit 1; }
command -v unzip >/dev/null 2>&1 || { echo "error: unzip required"; exit 1; }

mkdir -p "$DIR"
HEADER

emit_file serve.js serve.js EOF_SERVE
emit_file suite-shim.js suite-shim.js EOF_SHIM
emit_file index.html index.html EOF_INDEX
emit_file update.js update.js EOF_UPDATE

echo 'mkdir -p "$DIR/sso"' >> "$OUT"
emit_file sso/README.md sso/README.md EOF_SSOREADME
emit_file sso/oauth2-proxy.cfg sso/oauth2-proxy.cfg EOF_SSOCFG
emit_file sso/Caddyfile sso/Caddyfile EOF_CADDY
emit_file sso/craft-suite-sso.conf sso/craft-suite-sso.conf EOF_SSODROPIN

cat >> "$OUT" <<'FOOTER'
echo "==> fetching app web builds (first run downloads ~60 MB per app)"
cd "$DIR"
node update.js --apps="$APPS"

if [ "${INSTALL_SERVICE:-1}" = "1" ] && command -v systemctl >/dev/null 2>&1 \
   && systemctl --user daemon-reload >/dev/null 2>&1; then
  mkdir -p "$HOME/.config/systemd/user"
  NODE_BIN="$(command -v node)"
  cat > "$HOME/.config/systemd/user/craft-suite.service" <<EOF_UNIT
[Unit]
Description=Craft Suite - ArtCraft web builds static server
After=network.target

[Service]
WorkingDirectory=$DIR
ExecStart=$NODE_BIN serve.js . $PORT
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF_UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now craft-suite
  echo "==> systemd user service installed (systemctl --user status craft-suite)"
  echo "    tip: 'loginctl enable-linger $USER' makes it survive logout/reboot"
else
  echo "==> no systemd service (INSTALL_SERVICE=0 or systemd unavailable)"
  echo "    run manually: cd $DIR && node serve.js . $PORT"
fi

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo ""
echo "==> done. open http://${IP:-localhost}:$PORT/"
echo "    update apps later with: cd $DIR && node update.js"
FOOTER

chmod +x "$OUT"
echo "wrote $OUT ($(wc -c < "$OUT") bytes)"
