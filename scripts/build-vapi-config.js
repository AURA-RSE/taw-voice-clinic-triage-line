// Builds the Vapi tool and assistant definitions in vapi/ from src/triage.js and vapi/system-prompt.md.
// Values in {{DOUBLE_BRACES}} are filled from .env by scripts/setup-vapi.js; the committed JSON keeps placeholders.
// Usage: node scripts/build-vapi-config.js
const fs = require('fs');
const path = require('path');
const { DEPARTMENTS } = require('../src/triage');

const root = path.join(__dirname, '..');
const deptKeys = Object.keys(DEPARTMENTS);
const server = { url: '{{N8N_VAPI_WEBHOOK_URL}}', timeoutSeconds: 20, headers: { 'X-Vapi-Secret': '{{VAPI_SHARED_SECRET}}' } };

const tools = {
  'route-caller.json': {
    type: 'function',
    function: {
      name: 'route_caller',
      description: 'Decide where to send the caller. Call this as soon as you understand why they are calling. Returns an action: transfer, callback, clarify or emergency, with an instruction to follow.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: "Why the caller is calling, in their own words (one sentence). Include any urgent symptoms they mentioned." },
          department: { type: 'string', enum: deptKeys, description: 'Your best guess of the department, only if you are confident.' },
        },
        required: ['reason'],
      },
    },
    server,
    messages: [{ type: 'request-failed', role: 'system', content: 'The routing service failed. Apologise briefly and offer to take a callback request.' }],
  },
  'request-callback.json': {
    type: 'function',
    function: {
      name: 'request_callback',
      description: 'Book a callback from a department that is closed or busy. Only call after the caller has agreed to be called back and you have repeated their number back to them.',
      parameters: {
        type: 'object',
        properties: {
          caller_name: { type: 'string', description: "Caller's name" },
          phone: { type: 'string', description: 'Best number to call back, digits only, as the caller confirmed it' },
          department: { type: 'string', enum: deptKeys },
          reason: { type: 'string', description: 'Short, non-clinical reason for the callback' },
          consent_to_callback: { type: 'boolean', description: 'True only if the caller clearly agreed to be called back' },
        },
        required: ['caller_name', 'phone', 'department', 'consent_to_callback'],
      },
    },
    server,
    messages: [
      { type: 'request-start', content: 'One moment while I book that.' },
      { type: 'request-failed', role: 'system', content: 'The callback could not be booked. Apologise and ask the caller to ring back during opening hours.' },
    ],
  },
  'transfer-to-department.json': {
    type: 'transferCall',
    destinations: deptKeys.map((k) => ({
      type: 'number',
      number: `{{DEPT_${k.toUpperCase()}_NUMBER}}`,
      message: `Connecting you to ${DEPARTMENTS[k].label} now. Please hold.`,
      description: `${DEPARTMENTS[k].label}: ${DEPARTMENTS[k].keywords.slice(0, 6).join(', ')}. Use only after route_caller returned action "transfer" with department "${k}".`,
      transferPlan: { mode: 'blind-transfer' },
    })),
    messages: [{ type: 'request-failed', role: 'system', content: 'The transfer did not go through. Apologise and offer a callback instead.' }],
  },
  'end-call.json': { type: 'endCall' },
};

const assistant = {
  name: 'Clinic Triage Line',
  firstMessage: 'Thank you for calling {{CLINIC_NAME}}. This is the automated assistant. If this is a medical emergency, please hang up and call {{EMERGENCY_NUMBER}}. How can I help you today?',
  firstMessageMode: 'assistant-speaks-first',
  model: {
    provider: 'openai',
    model: '{{OPENAI_MODEL}}',
    temperature: 0.2,
    messages: [{ role: 'system', content: fs.readFileSync(path.join(root, 'vapi', 'system-prompt.md'), 'utf8') }],
    toolIds: ['{{TOOL_ID_route_caller}}', '{{TOOL_ID_request_callback}}', '{{TOOL_ID_transferCall}}', '{{TOOL_ID_endCall}}'],
  },
  voice: { provider: 'vapi', voiceId: 'Elliot' },
  transcriber: { provider: 'deepgram', model: 'nova-2', language: 'en' },
  maxDurationSeconds: 420,
  silenceTimeoutSeconds: 30,
  server,
  serverMessages: ['end-of-call-report'],
  analysisPlan: {
    summaryPlan: { enabled: true },
    structuredDataPlan: {
      enabled: true,
      schema: {
        type: 'object',
        properties: {
          department: { type: 'string', enum: deptKeys.concat(['none']) },
          outcome: { type: 'string', enum: ['transferred', 'callback_booked', 'emergency_redirected', 'info_only', 'abandoned'] },
          emergency_flagged: { type: 'boolean' },
        },
      },
    },
  },
};

fs.mkdirSync(path.join(root, 'vapi', 'tools'), { recursive: true });
for (const [file, def] of Object.entries(tools)) fs.writeFileSync(path.join(root, 'vapi', 'tools', file), JSON.stringify(def, null, 2) + '\n');
fs.writeFileSync(path.join(root, 'vapi', 'assistant.json'), JSON.stringify(assistant, null, 2) + '\n');
console.log('Wrote vapi/assistant.json and', Object.keys(tools).length, 'tools');
