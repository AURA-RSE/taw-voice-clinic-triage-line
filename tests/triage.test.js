// Run: npm test   (or: node --test tests/)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const t = require('../src/triage');

// Africa/Lagos is UTC+1 all year (no daylight saving), so these are easy to read.
const MON_10AM = new Date('2026-11-16T09:00:00Z'); // Monday 10:00 Lagos
const MON_7PM = new Date('2026-11-16T18:00:00Z'); // Monday 19:00 Lagos
const SAT_3PM = new Date('2026-11-14T14:00:00Z'); // Saturday 15:00 Lagos
const SUN_9AM = new Date('2026-11-15T08:00:00Z'); // Sunday 09:00 Lagos
const route = (reason, now, department) => t.routeCaller({ reason, department }, now, {});

test('emergency phrases are caught before any routing', () => {
  for (const s of [
    'my dad has chest pain and is sweating',
    "I can't breathe properly",
    'she collapsed and is unresponsive',
    'he took an overdose',
    'I think my mum is having a stroke, her face is drooping',
    'my throat is swelling after a bee sting',
  ]) {
    const r = route(s, MON_10AM);
    assert.strictEqual(r.action, 'emergency', s);
    assert.match(r.instruction, /112/);
    assert.match(r.instruction, /Do not give medical advice/);
  }
});

test('self-harm language gets the safety message, not a transfer', () => {
  const r = route('I want to kill myself', MON_10AM);
  assert.strictEqual(r.action, 'emergency');
  assert.match(r.instruction, /concerned for their safety/);
});

test('emergency still wins when the model already picked a department', () => {
  assert.strictEqual(route('refill, also I have chest pain right now', MON_10AM, 'pharmacy').action, 'emergency');
});

test('intents map to the right department', () => {
  const cases = [
    ['I need to book an appointment with Dr Bello', 'appointments'],
    ['I want to reschedule my visit on Thursday', 'appointments'],
    ['question about my bill, I was charged twice', 'billing'],
    ['does the clinic take my HMO insurance', 'billing'],
    ['I need a refill on my prescription', 'pharmacy'],
    ['are my blood test results back', 'lab'],
    ['I need a copy of my medical records', 'records'],
    ['my son has a fever and a rash, what should I do', 'nurse'],
  ];
  for (const [text, dept] of cases) assert.strictEqual(t.classifyIntent(text).department, dept, text);
});

test('unclear or tied requests ask a clarifying question', () => {
  const none = route('hello, I have a question', MON_10AM);
  assert.strictEqual(none.action, 'clarify');
  const tie = route('pharmacy or lab', MON_10AM);
  assert.strictEqual(tie.action, 'clarify');
  assert.deepStrictEqual(tie.candidates.sort(), ['lab', 'pharmacy']);
});

test('model-picked department is used when valid, ignored when invented', () => {
  assert.strictEqual(route('something vague', MON_10AM, 'billing').department, 'billing');
  assert.strictEqual(route('something vague', MON_10AM, 'cardiology').action, 'clarify');
});

test('open department -> transfer', () => {
  const r = route('book an appointment', MON_10AM);
  assert.strictEqual(r.action, 'transfer');
  assert.strictEqual(r.open, true);
});

test('closed department -> callback offer with next opening', () => {
  const r = route('question about my invoice', MON_7PM);
  assert.strictEqual(r.action, 'callback');
  assert.strictEqual(r.next_open, '2026-11-17T08:00:00.000Z'); // Tue 09:00 Lagos
  assert.match(r.next_open_spoken, /Tuesday/);
});

test('department hours differ: Saturday afternoon pharmacy open, front desk closed', () => {
  assert.strictEqual(t.isOpen('pharmacy', SAT_3PM, 'Africa/Lagos'), true);
  assert.strictEqual(t.isOpen('appointments', SAT_3PM, 'Africa/Lagos'), false);
  assert.strictEqual(t.isOpen('nurse', SUN_9AM, 'Africa/Lagos'), true);
  assert.strictEqual(t.isOpen('billing', SUN_9AM, 'Africa/Lagos'), false);
});

test('phone normalisation', () => {
  assert.strictEqual(t.normalizePhone('0803 000 0001', '234'), '+2348030000001');
  assert.strictEqual(t.normalizePhone('+1 (555) 010-0199', '234'), '+15550100199');
  assert.strictEqual(t.normalizePhone('0044 20 7946 0000', '234'), '+442079460000');
  assert.strictEqual(t.normalizePhone('12', '234'), '');
});

test('callback needs name, valid number, department and consent', () => {
  const bad = t.buildCallback({ caller_name: '', phone: 'abc', department: 'x', consent_to_callback: false }, MON_7PM, {}, 'call_1');
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.errors.length, 4);
});

test('callback is scheduled inside the department opening hours', () => {
  const cb = t.buildCallback({ caller_name: 'Ada Test', phone: '08030000001', department: 'billing', reason: 'invoice question', consent_to_callback: 'yes' }, MON_7PM, {}, 'call_abc123');
  assert.strictEqual(cb.ok, true);
  assert.strictEqual(cb.record.callback_due, '2026-11-17T08:00:00.000Z');
  assert.strictEqual(cb.record.callback_id, 'CB-20261116-C123');
  assert.strictEqual(cb.record.phone, '+2348030000001');
});

test('callback while open is booked ~30 minutes ahead', () => {
  const cb = t.buildCallback({ caller_name: 'Ada', phone: '+2348030000001', department: 'appointments', consent_to_callback: true }, MON_10AM, {}, 'c1');
  assert.strictEqual(cb.record.callback_due, '2026-11-16T09:30:00.000Z');
});

const sample = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'sample-data', f), 'utf8'));

test('Vapi tool-calls payload: route_caller returns a string result', () => {
  const out = t.handleVapiMessage(sample('vapi-tool-call-route.json'), MON_10AM, {});
  assert.strictEqual(out.kind, 'tool-calls');
  const r = out.response.results[0];
  assert.strictEqual(typeof r.result, 'string');
  assert.strictEqual(JSON.parse(r.result).department, 'pharmacy');
});

test('Vapi tool-calls payload: request_callback, then finalised for success and failure', () => {
  const out = t.handleVapiMessage(sample('vapi-tool-call-callback.json'), MON_7PM, {});
  assert.strictEqual(out.callbacks.length, 1);
  const ok = t.finalizeCallbackResponse(out.response, out.callbacks, { logged: true, scheduled: true });
  assert.match(ok.results[0].result, /Callback booked\. Reference CB-/);
  const partial = t.finalizeCallbackResponse(out.response, out.callbacks, { logged: true, scheduled: false });
  assert.match(partial.results[0].result, /calendar entry pending/);
  const failed = t.finalizeCallbackResponse(out.response, out.callbacks, { logged: false, scheduled: false });
  assert.ok(failed.results[0].error);
  assert.strictEqual(failed.results[0].result, undefined);
});

test('bad arguments and unknown tools return an error field, never a crash', () => {
  const body = { message: { type: 'tool-calls', call: { id: 'c' }, toolCallList: [
    { id: 'a', function: { name: 'route_caller', arguments: '{not json' } },
    { id: 'b', function: { name: 'delete_everything', arguments: {} } },
  ] } };
  const out = t.handleVapiMessage(body, MON_10AM, {});
  assert.ok(out.response.results.every((r) => r.error && !r.result));
});

test('end-of-call report becomes a log row with a masked number', () => {
  const out = t.handleVapiMessage(sample('vapi-end-of-call-report.json'), MON_10AM, {});
  assert.strictEqual(out.kind, 'end-of-call-report');
  assert.strictEqual(out.callLog.caller, '+•••••••0101');
  assert.strictEqual(out.callLog.duration_seconds, 74);
  assert.strictEqual(out.callLog.outcome, 'transferred');
});

test('other server messages are acknowledged with an empty body', () => {
  assert.deepStrictEqual(t.handleVapiMessage({ message: { type: 'status-update' } }, MON_10AM, {}).response, {});
});
