#!/bin/bash
# Starts self-hosted n8n on this Mac and gives it a public HTTPS URL with a free Cloudflare quick tunnel,
# so Vapi can reach the webhook. Double-click this file in Finder (or run it in Terminal).
# Downloads Node and cloudflared into ./local-n8n/tools if they are missing (no admin rights needed).
# Stop everything with Ctrl+C or by closing this window.
set -u
cd "$(dirname "$0")/.." || exit 1
BASE="$PWD/local-n8n"
TOOLS="$BASE/tools"
mkdir -p "$TOOLS" "$BASE/data"
ARCH=$(uname -m); [ "$ARCH" = "x86_64" ] && NARCH=x64 || NARCH=arm64; [ "$ARCH" = "x86_64" ] && CARCH=amd64 || CARCH=arm64

echo "== Clinic Triage Line: local n8n =="

# 1. Node (n8n needs Node 20.19+ / 22 / 24)
node_ok() { command -v node >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit((a===20&&b>=19)||a===22||a===24?0:1)'; }
if ! node_ok; then
  if [ -x "$TOOLS/node/bin/node" ]; then export PATH="$TOOLS/node/bin:$PATH"; fi
fi
if ! node_ok; then
  echo "Downloading Node 22 LTS into local-n8n/tools ..."
  FILE=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | awk '{print $2}' | grep "darwin-$NARCH.tar.gz$")
  curl -fSL "https://nodejs.org/dist/latest-v22.x/$FILE" -o "$TOOLS/node.tgz" || { echo "Node download failed"; read -r; exit 1; }
  rm -rf "$TOOLS/node" && mkdir -p "$TOOLS/node" && tar -xzf "$TOOLS/node.tgz" -C "$TOOLS/node" --strip-components 1 && rm "$TOOLS/node.tgz"
  export PATH="$TOOLS/node/bin:$PATH"
fi
echo "Node $(node -v)"

# 2. cloudflared
CF=$(command -v cloudflared || true)
if [ -z "$CF" ]; then
  CF="$TOOLS/cloudflared"
  if [ ! -x "$CF" ]; then
    echo "Downloading cloudflared ..."
    curl -fSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-$CARCH.tgz" -o "$TOOLS/cf.tgz" || { echo "cloudflared download failed"; read -r; exit 1; }
    tar -xzf "$TOOLS/cf.tgz" -C "$TOOLS" && rm "$TOOLS/cf.tgz" && chmod +x "$CF"
  fi
fi

# 3. Tunnel first, so n8n knows its public URL
LOG="$BASE/tunnel.log"; : > "$LOG"
"$CF" tunnel --no-autoupdate --url http://localhost:5678 > "$LOG" 2>&1 &
CF_PID=$!
cleanup() { echo; echo "Stopping..."; kill "$CF_PID" "${N8N_PID:-}" 2>/dev/null; rm -f "$BASE/tunnel-url.txt"; exit 0; }
trap cleanup INT TERM HUP
URL=""
for i in $(seq 1 60); do
  URL=$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1)
  [ -n "$URL" ] && break; sleep 1
done
[ -z "$URL" ] && { echo "Tunnel did not start. See $LOG"; cat "$LOG"; read -r; kill "$CF_PID"; exit 1; }
echo "$URL" > "$BASE/tunnel-url.txt"

# 4. n8n (data kept in local-n8n/data)
export N8N_USER_FOLDER="$BASE/data"
export WEBHOOK_URL="$URL/"
export N8N_EDITOR_BASE_URL="$URL/"
export GENERIC_TIMEZONE="Africa/Lagos"
export N8N_SECURE_COOKIE=false
export N8N_DIAGNOSTICS_ENABLED=false
export N8N_PERSONALIZATION_ENABLED=false
echo "Starting n8n (first run downloads it, this can take a few minutes) ..."
npx --yes n8n@latest start > "$BASE/n8n.log" 2>&1 &
N8N_PID=$!
for i in $(seq 1 300); do
  curl -fsS http://localhost:5678/healthz >/dev/null 2>&1 && break
  kill -0 "$N8N_PID" 2>/dev/null || { echo "n8n stopped. Last lines of local-n8n/n8n.log:"; tail -20 "$BASE/n8n.log"; read -r; cleanup; }
  sleep 2
done

echo
echo "=============================================================="
echo " n8n is running."
echo " Editor:            $URL"
echo " Vapi webhook URL:  ${URL}/webhook/vapi/clinic-triage"
echo " (The URL changes each time you restart this. Re-run"
echo "  'node scripts/setup-vapi.js' after updating .env.)"
echo " Keep this window open. Ctrl+C to stop."
echo "=============================================================="
wait "$N8N_PID"
cleanup
