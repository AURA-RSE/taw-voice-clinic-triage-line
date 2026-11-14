// Builds workflow/clinic-triage-line.json from src/triage.js so the n8n Code nodes
// always run exactly the code that the tests cover.
// Usage: node scripts/build-workflow.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const lib = fs
  .readFileSync(path.join(root, 'src', 'triage.js'), 'utf8')
  .replace(/\/\/ --- n8n:strip-start[\s\S]*?\/\/ --- n8n:strip-end\n?/, '')
  .trim();

// Google auth: one Google Service Account credential (works on self-hosted n8n behind a changing tunnel URL).
// Pass your IDs to bake them in: GOOGLE_SHEET_ID=... GOOGLE_CALENDAR_ID=... node scripts/build-workflow.js
// VAPI_SHARED_SECRET=... bakes the webhook secret into the Code node. The committed export keeps placeholders
// and an empty secret; never commit a filled-in export.
const SHEET_ID = process.env.GOOGLE_SHEET_ID || 'YOUR_GOOGLE_SHEET_ID';
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'YOUR_CALENDAR_ID@group.calendar.google.com';
const googleCred = { googleApi: { name: 'Google Service Account account' } };
const retry = { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 };

const handleCode = `// ===== Clinic config: edit these for your clinic =====
const CONFIG = {
  clinicName: 'Harbourview Family Clinic',
  timezone: 'Africa/Lagos',
  emergencyNumber: '112',
  crisisLine: 'your local crisis line',
  defaultCountryCode: '234',
  callbackLeadMinutes: 30,
  callbackDurationMinutes: 15,
};
// Same value as the secret on the Vapi server credential (sent as X-Vapi-Secret or Bearer token).
// Leave empty only while testing locally.
const VAPI_SHARED_SECRET = '${(process.env.VAPI_SHARED_SECRET || '').replace(/'/g, '')}';

// ===== Routing library (generated from src/triage.js, do not edit here) =====
${lib}

// ===== Handler =====
const req = $input.first().json;
const headers = req.headers || {};
const presented = headers['x-vapi-secret'] || String(headers['authorization'] || '').replace(/^Bearer\\s+/i, '');
if (VAPI_SHARED_SECRET && presented !== VAPI_SHARED_SECRET) {
  return [{ json: { kind: 'unauthorized', response: { error: 'unauthorized' } } }];
}
const out = handleVapiMessage(req.body || {}, new Date(), CONFIG);
return [{ json: out }];
`;

const splitCode = `// One item per callback so each gets its own sheet row and calendar event.
return ($input.first().json.callbacks || []).map((c) => ({ json: c }));
`;

const finalizeLib = lib.match(/function finalizeCallbackResponse[\s\S]*?\n}/)[0] + "\n";
const buildResponseCode = `${finalizeLib}
// A failed node (continue on error) outputs an item carrying an "error" field.
const handled = $('Handle Vapi Message').first().json;
const sheetOut = $('Log Callback Request').all();
const calOut = $('Create Callback Event').all();
const logged = sheetOut.length > 0 && sheetOut.every((i) => !i.json.error);
const scheduled = calOut.length > 0 && calOut.every((i) => !i.json.error);
return [{ json: { response: finalizeCallbackResponse(handled.response, handled.callbacks, { logged, scheduled }), logged, scheduled } }];
`;

function schema(cols) {
  return cols.map((c) => ({ id: c, displayName: c, required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true }));
}
function sheetAppend(name, tab, cols, valueFor, position) {
  const value = {};
  for (const c of cols) value[c] = valueFor(c);
  return {
    name,
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: 4.7,
    position,
    parameters: {
      resource: 'sheet',
      operation: 'append',
      authentication: 'serviceAccount',
      documentId: { __rl: true, mode: 'id', value: SHEET_ID },
      sheetName: { __rl: true, mode: 'name', value: tab },
      columns: { mappingMode: 'defineBelow', value, matchingColumns: [], schema: schema(cols) },
      options: { useAppend: true },
    },
    ...retry,
    onError: 'continueRegularOutput',
    credentials: googleCred,
  };
}
function respond(name, body, position, code = 200) {
  return {
    name,
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.1,
    position,
    parameters: { respondWith: 'json', responseBody: body, options: { responseCode: code } },
  };
}
function eq(id, value) {
  return { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id, leftValue: '={{ $json.kind }}', rightValue: value, operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, renameOutput: true, outputKey: value };
}

const CALLBACK_COLS = ['callback_id', 'call_id', 'caller_name', 'phone', 'department', 'department_label', 'reason', 'consent_to_callback', 'callback_due', 'callback_end', 'status', 'created_at'];
const CALL_COLS = ['call_id', 'caller', 'started_at', 'ended_at', 'duration_seconds', 'ended_reason', 'department', 'outcome', 'emergency_flagged', 'summary', 'logged_at'];

const nodes = [
  {
    name: 'Vapi Server Webhook',
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    position: [0, 300],
    webhookId: 'clinic-triage-line',
    parameters: { httpMethod: 'POST', path: 'vapi/clinic-triage', responseMode: 'responseNode', options: {} },
  },
  { name: 'Handle Vapi Message', type: 'n8n-nodes-base.code', typeVersion: 2, position: [224, 300], parameters: { mode: 'runOnceForAllItems', jsCode: handleCode } },
  {
    name: 'Route by Message Type',
    type: 'n8n-nodes-base.switch',
    typeVersion: 3.2,
    position: [448, 300],
    parameters: {
      rules: { values: [eq('s1', 'tool-calls'), eq('s2', 'end-of-call-report'), eq('s3', 'unauthorized')] },
      options: { fallbackOutput: 'extra', renameFallbackOutput: 'other' },
    },
  },
  {
    name: 'Callback Requested?',
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: [672, 96],
    parameters: {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, conditions: [{ id: 'c1', leftValue: '={{ ($json.callbacks || []).length }}', rightValue: 0, operator: { type: 'number', operation: 'gt' } }], combinator: 'and' },
      options: {},
    },
  },
  { name: 'Split Callbacks', type: 'n8n-nodes-base.code', typeVersion: 2, position: [896, 0], parameters: { mode: 'runOnceForAllItems', jsCode: splitCode } },
  sheetAppend('Log Callback Request', 'Callbacks', CALLBACK_COLS, (c) => `={{ $json.${c} }}`, [1120, 0]),
  {
    // Google Calendar API called directly so the service account credential can be used.
    name: 'Create Callback Event',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [1344, 0],
    parameters: {
      method: 'POST',
      url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events`,
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'googleApi',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: "={{ JSON.stringify({ summary: 'Callback: ' + $('Split Callbacks').item.json.department_label + ' (' + $('Split Callbacks').item.json.callback_id + ')', description: 'Call back ' + $('Split Callbacks').item.json.caller_name + ' on ' + $('Split Callbacks').item.json.phone + '.\\nReason: ' + $('Split Callbacks').item.json.reason + '\\nCaller consented to a callback. Do not give clinical advice unless you are clinical staff.\\nVapi call: ' + $('Split Callbacks').item.json.call_id, start: { dateTime: $('Split Callbacks').item.json.callback_due }, end: { dateTime: $('Split Callbacks').item.json.callback_end } }) }}",
      options: {},
    },
    ...retry,
    onError: 'continueRegularOutput',
    credentials: googleCred,
  },
  { name: 'Build Callback Response', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1568, 0], parameters: { mode: 'runOnceForAllItems', jsCode: buildResponseCode } },
  respond('Respond: Callback Result', '={{ JSON.stringify($json.response) }}', [1792, 0]),
  respond('Respond: Tool Results', '={{ JSON.stringify($json.response) }}', [896, 192]),
  respond('Respond: Report Received', '={{ JSON.stringify({ ok: true }) }}', [672, 304]),
  sheetAppend('Log Call', 'Call Log', CALL_COLS, (c) => `={{ $('Handle Vapi Message').item.json.callLog.${c} }}`, [896, 304]),
  respond('Respond: Unauthorized', '={{ JSON.stringify({ error: "unauthorized" }) }}', [672, 496], 401),
  respond('Respond: Acknowledge', '={{ JSON.stringify({}) }}', [672, 688]),
];

const link = (to) => [{ node: to, type: 'main', index: 0 }];
const connections = {
  'Vapi Server Webhook': { main: [link('Handle Vapi Message')] },
  'Handle Vapi Message': { main: [link('Route by Message Type')] },
  'Route by Message Type': { main: [link('Callback Requested?'), link('Respond: Report Received'), link('Respond: Unauthorized'), link('Respond: Acknowledge')] },
  'Callback Requested?': { main: [link('Split Callbacks'), link('Respond: Tool Results')] },
  'Split Callbacks': { main: [link('Log Callback Request')] },
  'Log Callback Request': { main: [link('Create Callback Event')] },
  'Create Callback Event': { main: [link('Build Callback Response')] },
  'Build Callback Response': { main: [link('Respond: Callback Result')] },
  'Respond: Report Received': { main: [link('Log Call')] },
};

const workflow = {
  name: 'Clinic Triage Line - Vapi Server',
  nodes,
  connections,
  settings: { executionOrder: 'v1', saveManualExecutions: true },
  active: false,
  tags: [],
};

const out = path.join(root, 'workflow', 'clinic-triage-line.json');
fs.writeFileSync(out, JSON.stringify(workflow, null, 2) + '\n');
console.log('Wrote', path.relative(root, out), `(${nodes.length} nodes)`);
