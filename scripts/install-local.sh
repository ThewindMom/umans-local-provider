#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$HOME/.local/share/umans-factory-provider"
SYSTEMD_DIR="$HOME/.config/systemd/user"

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun is required: https://bun.sh/docs/installation" >&2
  exit 1
fi

mkdir -p "$APP_DIR" "$APP_DIR/.config" "$SYSTEMD_DIR"

for path in proxy.js dashboard.html package.json src scripts config integrations systemd LICENSE README.md; do
  if [ -e "$path" ]; then
    cp -R "$path" "$APP_DIR/"
  fi
done

if [ ! -f "$APP_DIR/.config/config.json" ]; then
  cp "$APP_DIR/config/config.example.json" "$APP_DIR/.config/config.json"
  echo "Created $APP_DIR/.config/config.json"
  echo "Edit it and set API_KEY or export UMANS_API_KEY before starting services."
fi

cp "$APP_DIR/systemd/user/umans-limiter.service" "$SYSTEMD_DIR/umans-limiter.service"
cp "$APP_DIR/systemd/user/umans-dash.service" "$SYSTEMD_DIR/umans-dash.service"

systemctl --user daemon-reload
systemctl --user enable umans-limiter.service umans-dash.service

echo "Installed to $APP_DIR"
echo "Next: edit $APP_DIR/.config/config.json, then run:"
echo "  systemctl --user restart umans-limiter.service umans-dash.service"
echo "  curl http://127.0.0.1:8084/healthz"
