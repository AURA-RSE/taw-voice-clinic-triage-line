// Clinic Triage Line: routing logic.
// The same code runs in the tests (node) and inside the n8n Code node
// "Handle Vapi Message" (scripts/build-workflow.js copies it in).
// No medical advice is ever produced here: the logic only decides WHERE a caller goes.

const DEFAULT_CONFIG = {
  clinicName: 'Harbourview Family Clinic',
  timezone: 'Africa/Lagos',
  emergencyNumber: '112',
  crisisLine: 'your local crisis line',
  defaultCountryCode: '234',
  callbackLeadMinutes: 30,
  callbackDurationMinutes: 15,
};

// Hours are [open, close] in 24h "HH:MM", keyed by weekday (0 = Sunday).
const WEEKDAYS_8_6 = { 1: ['08:00', '18:00'], 2: ['08:00', '18:00'], 3: ['08:00', '18:00'], 4: ['08:00', '18:00'], 5: ['08:00', '18:00'], 6: ['09:00', '13:00'] };

const DEPARTMENTS = {
  appointments: {
    label: 'Appointments and Front Desk',
    keywords: ['appointment', 'book', 'booking', 'reschedule', 'cancel', 'new patient', 'register', 'registration', 'opening hours', 'open today', 'directions', 'address', 'location', 'see a doctor', 'see the doctor', 'check in'],
    hours: WEEKDAYS_8_6,
  },
  billing: {
    label: 'Billing and Insurance',
    keywords: ['bill', 'billing', 'invoice', 'payment', 'pay', 'paid', 'charge', 'charged', 'insurance', 'hmo', 'refund', 'receipt', 'balance', 'cost', 'price', 'fee'],
    hours: { 1: ['09:00', '17:00'], 2: ['09:00', '17:00'], 3: ['09:00', '17:00'], 4: ['09:00', '17:00'], 5: ['09:00', '17:00'] },
  },
  pharmacy: {
    label: 'Pharmacy and Prescription Refills',
    keywords: ['refill', 'prescription', 'medication', 'medicine', 'pharmacy', 'drugs', 'pills', 'repeat prescription', 'pick up my'],
    hours: { 1: ['08:00', '20:00'], 2: ['08:00', '20:00'], 3: ['08:00', '20:00'], 4: ['08:00', '20:00'], 5: ['08:00', '20:00'], 6: ['08:00', '20:00'] },
  },
  lab: {
    label: 'Laboratory and Test Results',
    keywords: ['lab', 'laboratory', 'result', 'results', 'blood test', 'blood work', 'x-ray', 'xray', 'scan', 'ultrasound', 'sample', 'urine test'],
    hours: { 1: ['07:30', '16:00'], 2: ['07:30', '16:00'], 3: ['07:30', '16:00'], 4: ['07:30', '16:00'], 5: ['07:30', '16:00'] },
  },
  records: {
    label: 'Medical Records',
    keywords: ['records', 'medical record', 'copy of my', 'sick note', 'doctor\'s letter', 'doctors letter', 'referral letter', 'medical report', 'transfer my file', 'fitness certificate'],
    hours: { 1: ['09:00', '16:00'], 2: ['09:00', '16:00'], 3: ['09:00', '16:00'], 4: ['09:00', '16:00'], 5: ['09:00', '16:00'] },
  },
  nurse: {
    label: 'Nurse Line',
    keywords: ['symptom', 'symptoms', 'fever', 'temperature', 'pain', 'hurts', 'feel sick', 'feeling sick', 'unwell', 'rash', 'cough', 'vomit', 'vomiting', 'diarrh', 'headache', 'side effect', 'should i take', 'is it normal', 'advice', 'nurse', 'dizzy', 'swollen'],
    hours: { 0: ['08:00', '20:00'], 1: ['08:00', '20:00'], 2: ['08:00', '20:00'], 3: ['08:00', '20:00'], 4: ['08:00', '20:00'], 5: ['08:00', '20:00'], 6: ['08:00', '20:00'] },
  },
};

// Red flags: the caller is told to hang up and call emergency services. Never transferred, never advised.
const EMERGENCY_PATTERNS = [
  /chest (pain|tightness|pressure)/, /heart attack/, /(can'?t|cannot|can not|struggling to|trouble|difficulty) breath/, /not breathing/, /stopped breathing/,
  /unconscious/, /unresponsive/, /passed out/, /collapsed/, /(severe|heavy|heavily|won'?t stop) bleed/, /bleeding (heavily|a lot|badly)/,
  /stroke/, /face (is )?droop/, /slurred speech/, /seizure/, /fitting/, /convuls/, /overdose/, /poison/, /choking/,
  /anaphyla/, /(throat|tongue|lips?) (is |are )?(swelling|swollen|closing)/, /baby (is )?not moving/, /labou?r (pains?|has started)/,
];
const SELF_HARM_PATTERNS = [/suicid/, /kill (myself|himself|herself)/, /end (my|his|her) life/, /hurt (myself|himself|herself)/, /self[- ]harm/];

function normalizeText(text) {
  return String(text || '').toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim();
}

function detectEmergency(text) {
  const t = normalizeText(text);
  if (!t) return { isEmergency: false, selfHarm: false };
  const selfHarm = SELF_HARM_PATTERNS.some((p) => p.test(t));
  const medical = EMERGENCY_PATTERNS.some((p) => p.test(t));
  return { isEmergency: selfHarm || medical, selfHarm };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Keyword scoring. Returns the best department, or null when nothing matches or two departments tie.
function classifyIntent(text) {
  const t = normalizeText(text);
  const scores = [];
  for (const [key, dept] of Object.entries(DEPARTMENTS)) {
    const matched = dept.keywords.filter((k) => new RegExp('(^|[^a-z])' + escapeRegex(k), 'i').test(t));
    if (matched.length) scores.push({ department: key, score: matched.length, matched });
  }
  scores.sort((a, b) => b.score - a.score);
  if (!scores.length) return { department: null, confidence: 'none', matched: [] };
  if (scores.length > 1 && scores[0].score === scores[1].score) {
    return { department: null, confidence: 'ambiguous', matched: scores.flatMap((s) => s.matched), candidates: scores.slice(0, 3).map((s) => s.department) };
  }
  return { department: scores[0].department, confidence: scores[0].score > 1 ? 'high' : 'medium', matched: scores[0].matched };
}

// Local wall-clock parts in the clinic's timezone.
function localParts(date, timezone) {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { weekday: wd, minutes: Number(p.hour) * 60 + Number(p.minute), ymd: `${p.year}-${p.month}-${p.day}` };
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function isOpen(departmentKey, date, timezone) {
  const dept = DEPARTMENTS[departmentKey];
  if (!dept) return false;
  const { weekday, minutes } = localParts(date, timezone);
  const slot = dept.hours[weekday];
  return Boolean(slot) && minutes >= toMinutes(slot[0]) && minutes < toMinutes(slot[1]);
}

// Next moment the department opens (searches up to 8 days ahead in 15-minute steps).
function nextOpening(departmentKey, date, timezone) {
  const step = 15 * 60 * 1000;
  let t = new Date(Math.ceil(date.getTime() / step) * step);
  for (let i = 0; i < 8 * 24 * 4; i++, t = new Date(t.getTime() + step)) {
    if (isOpen(departmentKey, t, timezone)) return t;
  }
  return null;
}

function describeTime(date, timezone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'long', hour: 'numeric', minute: '2-digit', hour12: true }).format(date);
}

// Main routing decision for the route_caller tool.
// args: { reason, department? } where department is the model's own pick (optional).
function routeCaller(args, now, config) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, config || {});
  const reason = String((args && args.reason) || '').trim();
  const emergency = detectEmergency(reason);
  if (emergency.isEmergency) {
    const say = emergency.selfHarm
      ? `Tell the caller you are concerned for their safety, that this line cannot help with this, and that they should hang up and call ${cfg.emergencyNumber} or ${cfg.crisisLine} right now. Do not transfer. Do not give medical advice.`
      : `Tell the caller this sounds like an emergency, that they should hang up and call ${cfg.emergencyNumber} immediately or go to the nearest emergency department. Do not transfer. Do not give medical advice.`;
    return { action: 'emergency', department: null, open: null, instruction: say };
  }

  let department = args && args.department && DEPARTMENTS[String(args.department).toLowerCase()] ? String(args.department).toLowerCase() : null;
  let source = department ? 'model' : 'keywords';
  let classification = null;
  if (!department) {
    classification = classifyIntent(reason);
    department = classification.department;
  }
  if (!department) {
    const options = (classification && classification.candidates) || Object.keys(DEPARTMENTS);
    return {
      action: 'clarify',
      department: null,
      open: null,
      candidates: options,
      instruction: `Ask one short question to find out which of these the caller needs: ${options.map((k) => DEPARTMENTS[k].label).join(', ')}.`,
    };
  }

  const label = DEPARTMENTS[department].label;
  if (isOpen(department, now, cfg.timezone)) {
    return {
      action: 'transfer',
      department,
      department_label: label,
      open: true,
      source,
      instruction: `Tell the caller you are connecting them to ${label}, then call transferCall with the ${label} destination in the same turn.`,
    };
  }
  const opens = nextOpening(department, now, cfg.timezone);
  return {
    action: 'callback',
    department,
    department_label: label,
    open: false,
    source,
    next_open: opens ? opens.toISOString() : null,
    next_open_spoken: opens ? describeTime(opens, cfg.timezone) : null,
    instruction: `${label} is closed right now${opens ? ` and opens ${describeTime(opens, cfg.timezone)}` : ''}. Offer a callback: collect name, best number and consent, then call request_callback.`,
  };
}

function normalizePhone(raw, defaultCountryCode) {
  let p = String(raw || '').replace(/[^+0-9]/g, '');
  if (!p) return '';
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (!p.startsWith('+')) p = p.startsWith('0') ? '+' + defaultCountryCode + p.slice(1) : '+' + p;
  return /^\+[1-9][0-9]{7,14}$/.test(p) ? p : '';
}

function isTruthy(v) {
  return v === true || /^(true|yes|y|1)$/i.test(String(v || '').trim());
}

// Validates the request_callback arguments and builds the record to log + schedule.
function buildCallback(args, now, config, callId) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, config || {});
  const a = args || {};
  const errors = [];
  const name = String(a.caller_name || '').trim();
  const phone = normalizePhone(a.phone, cfg.defaultCountryCode);
  const department = DEPARTMENTS[String(a.department || '').toLowerCase()] ? String(a.department).toLowerCase() : null;
  const reason = String(a.reason || '').trim().slice(0, 300);
  if (!name) errors.push('caller_name is missing');
  if (!phone) errors.push('phone is missing or not a valid number');
  if (!department) errors.push('department is missing or unknown');
  if (!isTruthy(a.consent_to_callback)) errors.push('caller has not agreed to a callback');
  if (detectEmergency(reason).isEmergency) errors.push('reason describes an emergency');
  if (errors.length) return { ok: false, errors };

  const leadMs = cfg.callbackLeadMinutes * 60 * 1000;
  const earliest = new Date(now.getTime() + leadMs);
  let due = isOpen(department, earliest, cfg.timezone) ? earliest : nextOpening(department, earliest, cfg.timezone);
  if (!due) due = earliest;
  const end = new Date(due.getTime() + cfg.callbackDurationMinutes * 60 * 1000);
  const ymd = localParts(now, cfg.timezone).ymd.replace(/-/g, '');
  const suffix = String(callId || now.getTime()).replace(/[^a-zA-Z0-9]/g, '').slice(-4).toUpperCase() || '0000';
  return {
    ok: true,
    record: {
      callback_id: `CB-${ymd}-${suffix}`,
      call_id: String(callId || ''),
      caller_name: name,
      phone,
      department,
      department_label: DEPARTMENTS[department].label,
      reason,
      consent_to_callback: true,
      callback_due: due.toISOString(),
      callback_due_spoken: describeTime(due, cfg.timezone),
      callback_end: end.toISOString(),
      status: 'pending',
      created_at: now.toISOString(),
    },
  };
}

function maskPhone(p) {
  const s = String(p || '');
  return s.length > 4 ? s.slice(0, -4).replace(/[0-9]/g, '•') + s.slice(-4) : s;
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw || '{}'); } catch (e) { return null; }
}

// Turns one Vapi server message into: the HTTP response body, plus side effects for n8n to run.
function handleVapiMessage(body, now, config) {
  const msg = (body && body.message) || {};
  const callId = (msg.call && msg.call.id) || '';

  if (msg.type === 'tool-calls') {
    const calls = msg.toolCallList || (msg.toolWithToolCallList || []).map((t) => t.toolCall) || [];
    const results = [];
    const callbacks = [];
    for (const tc of calls) {
      const fn = (tc && tc.function) || {};
      const args = parseArgs(fn.arguments);
      if (!args) { results.push({ toolCallId: tc.id, error: 'Arguments could not be read. Ask the caller to repeat.' }); continue; }
      if (fn.name === 'route_caller') {
        results.push({ toolCallId: tc.id, result: JSON.stringify(routeCaller(args, now, config)) });
      } else if (fn.name === 'request_callback') {
        const cb = buildCallback(args, now, config, callId);
        if (!cb.ok) results.push({ toolCallId: tc.id, error: 'Callback not booked: ' + cb.errors.join('; ') + '. Ask the caller for what is missing.' });
        else { callbacks.push(Object.assign({ tool_call_id: tc.id }, cb.record)); results.push({ toolCallId: tc.id, result: '__PENDING_CALLBACK__' }); }
      } else {
        results.push({ toolCallId: tc.id, error: `Unknown tool ${fn.name}` });
      }
    }
    return { kind: 'tool-calls', response: { results }, callbacks };
  }

  if (msg.type === 'end-of-call-report') {
    const analysis = msg.analysis || {};
    const sd = analysis.structuredData || {};
    const call = msg.call || {};
    const customer = (call.customer && call.customer.number) || (msg.customer && msg.customer.number) || '';
    const started = msg.startedAt || call.startedAt || '';
    const ended = msg.endedAt || call.endedAt || '';
    const duration = started && ended ? Math.round((new Date(ended) - new Date(started)) / 1000) : (msg.durationSeconds || '');
    return {
      kind: 'end-of-call-report',
      response: { ok: true },
      callLog: {
        call_id: callId,
        caller: maskPhone(customer),
        started_at: started,
        ended_at: ended,
        duration_seconds: duration,
        ended_reason: msg.endedReason || '',
        department: sd.department || '',
        outcome: sd.outcome || (msg.endedReason === 'assistant-forwarded-call' ? 'transferred' : ''),
        emergency_flagged: sd.emergency_flagged === true,
        summary: String(analysis.summary || msg.summary || '').slice(0, 1000),
        logged_at: now.toISOString(),
      },
    };
  }

  return { kind: msg.type || 'unknown', response: {} };
}

// Fills in the callback result after n8n has tried to log/schedule it.
function finalizeCallbackResponse(response, callbacks, outcome) {
  const byId = Object.fromEntries((callbacks || []).map((c) => [c.tool_call_id, c]));
  const results = response.results.map((r) => {
    if (r.result !== '__PENDING_CALLBACK__') return r;
    const cb = byId[r.toolCallId];
    if (!outcome.logged) {
      return { toolCallId: r.toolCallId, error: 'The callback could not be saved because of a system problem. Apologise and ask the caller to ring back during opening hours.' };
    }
    const when = cb ? cb.callback_due_spoken : 'soon';
    const note = outcome.scheduled ? '' : ' (calendar entry pending, the team will see it in the callback list)';
    return { toolCallId: r.toolCallId, result: `Callback booked. Reference ${cb.callback_id}. ${cb.department_label} will call ${cb.caller_name} back around ${when}${note}.` };
  });
  return { results };
}

// --- n8n:strip-start
module.exports = { DEFAULT_CONFIG, DEPARTMENTS, detectEmergency, classifyIntent, isOpen, nextOpening, routeCaller, normalizePhone, buildCallback, handleVapiMessage, finalizeCallbackResponse, maskPhone };
// --- n8n:strip-end
