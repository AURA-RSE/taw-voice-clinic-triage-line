#!/usr/bin/env bash
# Sends the sample Vapi server messages to your n8n webhook, so you can test without placing a call.
# Usage: N8N_VAPI_WEBHOOK_URL=https://.../webhook/vapi/clinic-triage VAPI_SHARED_SECRET=... ./scripts/send-test-events.sh [route|emergency|callback|report|all]
set -euo pipefail
: "${N8N_VAPI_WEBHOOK_URL:?Set N8N_VAPI_WEBHOOK_URL}"
cd "$(dirname "$0")/../sample-data"
send() {
  echo "== $1"
  curl -sS -X POST "$N8N_VAPI_WEBHOOK_URL" -H 'Content-Type: application/json' \
    -H "X-Vapi-Secret: ${VAPI_SHARED_SECRET:-}" --data @"$1" -w '\n(HTTP %{http_code})\n'
}
case "${1:-all}" in
  route) send vapi-tool-call-route.json ;;
  emergency) send vapi-tool-call-emergency.json ;;
  callback) send vapi-tool-call-callback.json ;;
  report) send vapi-end-of-call-report.json ;;
  all) for f in vapi-tool-call-route.json vapi-tool-call-emergency.json vapi-tool-call-callback.json vapi-end-of-call-report.json; do send "$f"; done ;;
  *) echo "unknown event: $1"; exit 1 ;;
esac
