# Recorded run: 14 Nov 2026

**Setup:** self-hosted n8n (Node 24) on the developer's Mac, exposed with a Cloudflare quick tunnel. The workflow was imported and published with the n8n CLI (`setup-p3.command`), with the Google Service Account credential connected to Google Sheets (`Clinic Triage Line`) and Google Calendar (`Clinic Callbacks`). The Vapi assistant **Clinic Triage Line** and its 4 tools were created through the Vapi API (`scripts/setup-vapi.js`).

**Time of run:** Saturday 14 Nov 2026, 20:27 Africa/Lagos. The pharmacy closes at 20:00 on Saturdays, so the routing test correctly returns `callback` rather than `transfer`.

Each sample payload from `sample-data/` was posted to the live production webhook with the shared secret.

## 1. Route: prescription refill, after pharmacy hours

`vapi-tool-call-route.json` → HTTP 200

```json
{"results":[{"toolCallId":"call_route_demo_01","result":"{\"action\":\"callback\",\"department\":\"pharmacy\",\"department_label\":\"Pharmacy and Prescription Refills\",\"open\":false,\"source\":\"keywords\",\"next_open\":\"2026-11-16T07:00:00.000Z\",\"next_open_spoken\":\"Monday 8:00 am\",\"instruction\":\"Pharmacy and Prescription Refills is closed right now and opens Monday 8:00 am. Offer a callback: collect name, best number and consent, then call request_callback.\"}"}]}
```

✅ Intent routed to Pharmacy. Closed, so it offers a callback with the next opening time (Sunday is closed; Monday 08:00).

## 2. Emergency guard

`vapi-tool-call-emergency.json` ("My father has chest pain and is struggling to breathe") → HTTP 200

```json
{"results":[{"toolCallId":"call_route_demo_02","result":"{\"action\":\"emergency\",\"department\":null,\"open\":null,\"instruction\":\"Tell the caller this sounds like an emergency, that they should hang up and call 112 immediately or go to the nearest emergency department. Do not transfer. Do not give medical advice.\"}"}]}
```

✅ Caught before routing: no department, no transfer, no medical advice.

## 3. Callback booked

`vapi-tool-call-callback.json` (Billing, fictional caller "Ada Test", consent = true) → HTTP 200

```json
{"results":[{"toolCallId":"call_cb_demo_01","result":"Callback booked. Reference CB-20261114-0002. Billing and Insurance will call Ada Test back around Monday 9:00 am."}]}
```

✅ A row was appended to the **Callbacks** tab and an event was created in the **Clinic Callbacks** calendar for Monday 09:00–09:15, inside Billing's opening hours. No "calendar entry pending" suffix appeared, which confirms both the Sheets and Calendar steps succeeded.

## 4. End-of-call report

`vapi-end-of-call-report.json` → HTTP 200 `{"ok":true}`

✅ A row was appended to the **Call Log** tab, with the caller's number masked (`+•••••••0101`).

## 5. Security: wrong shared secret

Same route payload with `X-Vapi-Secret: wrong` → **HTTP 401** `{"error":"unauthorized"}`

✅ Rejected; nothing was processed.

## Vapi assistant creation

```
created tool tool:endCall
created tool tool:request_callback
created tool tool:route_caller
created tool tool:transferCall
created assistant assistant 6785a568-6a4b-42d1-a95e-528b91f9cb63
```

## Automated tests

`npm test`: 18/18 pass. `node scripts/simulate-n8n.js` runs the generated n8n Code nodes on the same payloads, including the three callback outcomes (booked, calendar down, Sheets down).
