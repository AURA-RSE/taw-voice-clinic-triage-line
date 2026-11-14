# Test checklist: Clinic Triage Line

Automated tests cover the routing logic; the live checks below cover the phone flow end to end.
Only call **test numbers** you own or that belong to teammates who agreed to receive test calls.

## A. Automated (run before every PR)

| # | Check | Command | Pass when |
|---|---|---|---|
| A1 | Routing unit tests (18) | `npm test` | all pass |
| A2 | Generated n8n code runs on sample payloads | `node scripts/simulate-n8n.js` | route, emergency, callback (3 outcomes), report and secret check print as expected |
| A3 | Workflow + Vapi configs rebuilt from source | `npm run build:workflow && npm run build:vapi` then `git diff --exit-code` | no diff |
| A4 | Vapi payloads fill correctly | `node scripts/setup-vapi.js --dry-run` (with `.env`) | no missing placeholders |

## B. n8n webhook (no phone call)

| # | Check | How | Expected | Result |
|---|---|---|---|---|
| B1 | Route, department open | `./scripts/send-test-events.sh route` during pharmacy hours | `results[0].result` has `"action":"transfer"` | |
| B2 | Emergency phrase | `./scripts/send-test-events.sh emergency` | `"action":"emergency"`, mentions 112, no department | |
| B3 | Callback booked | `./scripts/send-test-events.sh callback` | "Callback booked. Reference CB-…"; new row in **Callbacks** tab; event in **Clinic Callbacks** calendar | |
| B4 | Callback, Calendar down | Disconnect the Calendar credential, repeat B3 | Row still logged; result says "calendar entry pending" | |
| B5 | Callback, Sheets down | Point the Sheets node at a missing tab, repeat B3 | `error` field returned (Vapi speaks the failure message) and no crash | |
| B6 | End-of-call report | `./scripts/send-test-events.sh report` | HTTP 200 `{"ok":true}`; row in **Call Log** with masked number | |
| B7 | Wrong secret | `VAPI_SHARED_SECRET=wrong ./scripts/send-test-events.sh route` | HTTP 401 | |
| B8 | Retries | Check the Sheets/Calendar node settings | Retry on fail: 3 tries, 2s apart; On error: continue | |

## C. Live calls (Vapi web call or the Twilio number)

| # | Say | Expected | Result |
|---|---|---|---|
| C1 | "I'd like to book an appointment" (front desk open) | Routes to Appointments and transfers to its test number | |
| C2 | "Question about my bill" after 17:00 or at the weekend | Says Billing is closed and when it opens; offers callback; reads back number; gives CB reference | |
| C3 | "My son has a fever, what medicine should I give him?" | Refuses medical advice, routes to the Nurse Line | |
| C4 | "My dad has chest pain and can't breathe" | Tells caller to hang up and call 112; no transfer; call ends | |
| C5 | "Hi, I have a question" | Asks one clarifying question, then routes | |
| C6 | "Are my lab results normal?" | Does not read or interpret results; routes to Lab | |
| C7 | Hang up mid-call | End-of-call report still logged (outcome `abandoned`) | |
| C8 | Ask "are you a real person?" | Says it is the clinic's automated assistant | |

## D. Definition-of-done checks

- [ ] No real patient data anywhere (sample data is fictional: "Ada Test", +1 555-0100-1xx, a range reserved for fiction)
- [ ] `.env` not committed; `.env.example` lists every variable
- [ ] Transfer numbers are test numbers only
- [ ] README has Loom link, architecture diagram, setup, screenshots
- [ ] Repo description and topics set
