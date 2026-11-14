// Creates (or updates) the Vapi tools and the assistant from vapi/*.json, filling {{PLACEHOLDERS}} from .env.
// Usage: cp .env.example .env  (fill it in)  then  node scripts/setup-vapi.js
// Add --dry-run to print the filled payloads without calling Vapi.
// Created IDs are saved to .vapi-ids.json (git-ignored) so re-running updates instead of duplicating.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env');
if (!fs.existsSync(envPath)) { console.error('Missing .env. Copy .env.example to .env and fill it in.'); process.exit(1); }
const env = Object.fromEntries(
  fs.readFileSync(envPath, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')])
);

const required = ['VAPI_API_KEY', 'N8N_VAPI_WEBHOOK_URL', 'VAPI_SHARED_SECRET', 'CLINIC_NAME', 'EMERGENCY_NUMBER', 'OPENAI_MODEL',
  'DEPT_APPOINTMENTS_NUMBER', 'DEPT_BILLING_NUMBER', 'DEPT_PHARMACY_NUMBER', 'DEPT_LAB_NUMBER', 'DEPT_RECORDS_NUMBER', 'DEPT_NURSE_NUMBER'];
const missing = required.filter((k) => !env[k] || /x{6,}|your_|example\.com/i.test(env[k]));
if (missing.length) { console.error('Fill these in .env first:', missing.join(', ')); process.exit(1); }
const badNumbers = required.filter((k) => k.startsWith('DEPT_') && !/^\+[1-9][0-9]{7,14}$/.test(env[k]));
if (badNumbers.length) { console.error('Department numbers must be E.164 test numbers (e.g. +2348030000001):', badNumbers.join(', ')); process.exit(1); }

const idsPath = path.join(root, '.vapi-ids.json');
const ids = fs.existsSync(idsPath) ? JSON.parse(fs.readFileSync(idsPath, 'utf8')) : {};
const fill = (obj, vars) => JSON.parse(JSON.stringify(obj).replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (m, k) => {
  if (vars[k] === undefined) throw new Error('No value for placeholder ' + m);
  return String(vars[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}));

const DRY = process.argv.includes('--dry-run');
async function api(method, url, body, attempt = 1) {
  if (DRY) { console.log(`[dry-run] ${method} ${url}`, JSON.stringify(body).slice(0, 300) + '...'); return { id: 'dry-' + url.replace(/\W/g, '') }; }
  const res = await fetch('https://api.vapi.ai' + url, {
    method,
    headers: { Authorization: 'Bearer ' + env.VAPI_API_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    await new Promise((r) => setTimeout(r, 1500 * attempt));
    return api(method, url, body, attempt + 1);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function upsert(kind, key, body) {
  const strip = (b) => { const c = Object.assign({}, b); delete c.type; return c; }; // type cannot be changed on update
  if (ids[key]) {
    try { await api('PATCH', `/${kind}/${ids[key]}`, kind === 'tool' ? strip(body) : body); console.log('updated', kind, key, ids[key]); return ids[key]; }
    catch (e) { if (!/404/.test(e.message)) throw e; console.log(key, 'no longer exists, recreating'); }
  }
  const created = await api('POST', `/${kind}`, body);
  ids[key] = created.id;
  if (!DRY) fs.writeFileSync(idsPath, JSON.stringify(ids, null, 2));
  console.log('created', kind, key, created.id);
  return created.id;
}

(async () => {
  const vars = Object.assign({}, env);
  const toolDir = path.join(root, 'vapi', 'tools');
  for (const file of fs.readdirSync(toolDir).filter((f) => f.endsWith('.json')).sort()) {
    const def = fill(JSON.parse(fs.readFileSync(path.join(toolDir, file), 'utf8')), vars);
    const key = def.function && def.function.name ? def.function.name : def.type;
    vars['TOOL_ID_' + key] = await upsert('tool', 'tool:' + key, def);
  }
  const assistant = fill(JSON.parse(fs.readFileSync(path.join(root, 'vapi', 'assistant.json'), 'utf8')), vars);
  const id = await upsert('assistant', 'assistant', assistant);
  console.log('\nDone. Assistant ID:', id);
  console.log('Next: in the Vapi dashboard, attach a phone number to this assistant, or use "Talk to Assistant" for a web test call.');
})().catch((e) => { console.error('Setup failed:', e.message); process.exit(1); });
