# Harbourview · Clinic Triage Line (AI Voice Agent)

> 🎥 **Loom demo (60–90s):** _LOOM_LINK_HERE_

An AI phone receptionist for clinics. It answers the call, works out **why** the patient is calling, and sends them to the **right department**: it transfers the call when that department is open and books a **callback** when it is closed. It **never gives medical advice**, and it sends anyone describing an emergency straight to emergency services.

---

## Problem

Clinic front desks are overloaded with calls that only need to be put through to the right place: a refill question for the pharmacy, a bill question for billing, a results question for the lab. Patients wait on hold, calls after hours go unanswered, and staff are pulled away from patients in the building. A generic phone menu ("press 1 for…") frustrates callers and misroutes them.

## Who it's for

- Small and mid-sized clinics, GP practices and outpatient centres with several departments sharing one phone line
- Agencies and freelancers who build voice automations for healthcare clients

## Features

- **Intent routing:** the caller speaks naturally; the assistant calls `route_caller`, which maps the reason to one of six departments (Appointments, Billing, Pharmacy, Lab, Records, Nurse Line). Unclear or mixed requests get one clarifying question.
- **Department transfer:** when the department is open, the call is transferred to its number with Vapi's Transfer Call tool (blind transfer through Twilio).
- **Callback request:** when the department is closed, the assistant says when it opens and offers a callback. It collects the name, reads the number back, records consent, and books it: a row in Google Sheets plus an event in Google Calendar, scheduled inside that department's opening hours. The caller gets a reference such as `CB-20261116-0002`.
- **Per-department opening hours** in the clinic's timezone (for example, the pharmacy is open on Saturday afternoons but the front desk is not).
- **Safety guard, no medical advice:** emergency and self-harm phrases are detected in code *before* any routing, even if the AI picked a department. The caller is told to hang up and call the emergency number. Symptom questions go to the Nurse Line (a human) and the assistant never answers them.
- **Call log:** every call's end-of-call report (summary, department, outcome, ended reason, duration) is logged with the caller's number masked.

## Stack

| Layer | Tool |
|---|---|
| Voice agent | Vapi (assistant + Function tools + Transfer Call + End Call) |
| Telephony | Twilio phone number imported into Vapi (or a free Vapi number) |
| Orchestration | n8n (one webhook workflow is the Vapi "server") |
| Scheduling | Google Calendar (callback events) |
| Log | Google Sheets (`Callbacks` and `Call Log` tabs) |
| LLM / voice | OpenAI `gpt-4o-mini` via Vapi, Deepgram transcriber, Vapi voice |
| Logic + tests | Plain JavaScript (`src/triage.js`), Node's built-in test runner |

The brief allows "Google Calendar/GHL": this build uses **Google Calendar**, because it's free and P2 already covered GHL.

## Architecture

```mermaid
flowchart TD
    C[Caller] -->|dials| T[Twilio number]
    T --> V[Vapi assistant: Clinic Triage Line]
    V -->|tool call: route_caller| W[n8n webhook: /vapi/clinic-triage]
    W --> H[Code: Handle Vapi Message<br/>auth check + src/triage.js]
    H --> S{Message type}
    S -- tool-calls --> R{Callback requested?}
    R -- no --> RT[Respond: tool result<br/>transfer / callback / clarify / emergency]
    RT --> V
    R -- yes --> SP[Split callbacks]
    SP --> GS[Sheets: Callbacks tab<br/>retry 3x, continue on error]
    GS --> GC[Calendar: callback event<br/>retry 3x, continue on error]
    GC --> BR[Build response<br/>booked / calendar pending / failed]
    BR --> V
    S -- end-of-call-report --> AK[Respond 200] --> CL[Sheets: Call Log tab]
    S -- bad secret --> U[Respond 401]
    V -->|action = transfer| X[Transfer Call tool] --> D[Department test number]
    V -->|action = emergency| E[Tell caller to call 112, end call]
```

**Why the logic lives in code, not in the prompt:** the emergency check, department hours and callback validation decide what happens to a patient, so they're deterministic and tested (`tests/triage.test.js`). The LLM handles the conversation; the code makes the routing decision. `scripts/build-workflow.js` copies `src/triage.js` into the n8n Code node, so n8n runs exactly the tested code.

### Departments and hours (Africa/Lagos)

| Key | Department | Hours |
|---|---|---|
| `appointments` | Appointments and Front Desk | Mon–Fri 08:00–18:00, Sat 09:00–13:00 |
| `billing` | Billing and Insurance | Mon–Fri 09:00–17:00 |
| `pharmacy` | Pharmacy and Prescription Refills | Mon–Sat 08:00–20:00 |
| `lab` | Laboratory and Test Results | Mon–Fri 07:30–16:00 |
| `records` | Medical Records | Mon–Fri 09:00–16:00 |
| `nurse` | Nurse Line | Every day 08:00–20:00 |

Edit `DEPARTMENTS` in `src/triage.js`, then run `npm run build:workflow && npm run build:vapi`.

## Setup

**Requirements:** Node 18+, a Vapi account (free trial credit), an n8n instance (Cloud trial or self-hosted), a Google account, and optionally a Twilio trial account.

1. **Clone and test**
   ```bash
   npm test                      # 18 routing tests
   node scripts/simulate-n8n.js  # runs the generated n8n code on the sample payloads
   ```
2. **Google:** create a Google Sheet named `Clinic Triage Line` with two tabs, using the headers from `sample-data/`:
   - `Callbacks`: `callbacks-sheet-template.csv` headers
   - `Call Log`: `call-log-sheet-template.csv` headers

   Then create a Google Calendar named `Clinic Callbacks`.
3. **n8n:** import `workflow/clinic-triage-line.json` (*Workflows → Import from file*). Connect the Google Sheets and Google Calendar credentials, then select the sheet and calendar in the three Google nodes. In **Handle Vapi Message**, set `VAPI_SHARED_SECRET` and the `CONFIG` block (clinic name, timezone, emergency number). **Activate** the workflow and copy the production webhook URL.
4. **Environment:** `cp .env.example .env` and fill it in. The department numbers must be **test numbers** (your own phone or teammates who agreed); on a Twilio trial they must also be Verified Caller IDs.
5. **Vapi:** create the tools and assistant in one step:
   ```bash
   node scripts/setup-vapi.js --dry-run   # check the payloads
   node scripts/setup-vapi.js             # creates/updates them, saves IDs to .vapi-ids.json
   ```
   Or create them by hand in the dashboard from `vapi/tools/*.json` and `vapi/assistant.json`.
6. **Phone number:** in Vapi, go to *Phone Numbers*, import your Twilio number (Account SID + Auth Token) or buy a free Vapi number, and set its assistant to **Clinic Triage Line**. You can also test without a number by clicking **Talk to Assistant** in the dashboard (web call).

### Test without a phone call

```bash
N8N_VAPI_WEBHOOK_URL=https://<your-n8n>/webhook/vapi/clinic-triage VAPI_SHARED_SECRET=<secret> \
  ./scripts/send-test-events.sh all
```

## Error handling

| Case | Behaviour |
|---|---|
| Caller describes an emergency or self-harm | Detected in code before routing; caller is told to call the emergency number; no transfer; call ends |
| Model picks a department that doesn't exist | Ignored; falls back to keyword routing or a clarifying question |
| Request is unclear or matches two departments equally | `clarify` action: one short question, then route again |
| Department closed | `callback` action with the next opening time, spoken naturally |
| Callback missing name, valid number, department or consent | Tool returns an `error` naming what's missing; the assistant asks for it |
| Google Sheets fails | 3 retries, then the tool returns an `error`; Vapi speaks the failure message and asks the caller to ring back in opening hours |
| Google Calendar fails | 3 retries; the callback is still logged in Sheets and confirmed to the caller as "calendar entry pending" |
| Transfer fails (number busy or unreachable) | Transfer tool's `request-failed` message: apologise and offer a callback |
| Malformed tool arguments or unknown tool | `error` result, HTTP 200 (as Vapi requires); never crashes the call |
| Request without the shared secret | HTTP 401, nothing processed |
| Other Vapi server messages | Acknowledged with `{}` |

## Data, privacy and safety

- **No medical advice.** The assistant only routes. It has no access to records or results, and the system prompt forbids it from interpreting symptoms, medicines or results.
- **Seed data only.** Sample callers are fictional ("Ada Test", +1 555-0100-1xx, a range reserved for fiction).
- **Test numbers only.** Department transfer numbers are the developer's own or opted-in testers; on a Twilio trial they must be verified.
- **Consent.** A callback is booked only after the caller agrees (`consent_to_callback = true`).
- **Minimal data.** Callers' numbers are masked in the call log; the callback row stores only name, number and a short non-clinical reason.
- **No secrets committed.** Keys live in `.env` (git-ignored), n8n credentials and Vapi.
- This is a demo, not a certified medical device. A real deployment needs the clinic's privacy/HIPAA/NDPR review and a BAA/DPA with each vendor.

## Screenshots

_Added after the recorded run:_ `docs/screenshots/` (workflow, Vapi assistant, Callbacks sheet, calendar event, call log).

## Testing

- `npm test`: 18 unit tests (emergency guard, intents, hours, clarify, callbacks, phone normalisation, Vapi payload handling, failure paths)
- `node scripts/simulate-n8n.js`: runs the generated n8n Code nodes against `sample-data/`
- [`docs/TEST_CHECKLIST.md`](docs/TEST_CHECKLIST.md): webhook and live-call checklist
- `docs/recorded-run/`: recorded run (call transcript, sheet rows, n8n executions)

## Repo structure

```
src/triage.js                     routing logic (single source of truth)
tests/triage.test.js              unit tests
workflow/clinic-triage-line.json  n8n workflow export (generated)
vapi/assistant.json               Vapi assistant (placeholders filled by setup script)
vapi/tools/*.json                 route_caller, request_callback, transferCall, endCall
vapi/system-prompt.md             assistant instructions
scripts/build-workflow.js         src -> n8n workflow
scripts/build-vapi-config.js      src + prompt -> Vapi JSON
scripts/setup-vapi.js             create/update tools + assistant via the Vapi API
scripts/simulate-n8n.js           run the n8n code locally
scripts/send-test-events.sh       fire sample Vapi messages at n8n
sample-data/                      fictional payloads + sheet templates
docs/                             test checklist, recorded run, screenshots
.env.example                      every variable used
```
