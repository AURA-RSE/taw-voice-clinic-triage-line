// Runs the generated n8n Code nodes outside n8n against the sample payloads.
// Usage: node scripts/simulate-n8n.js   (run from the repo root)
const wf = require(require('path').join(__dirname, '..', 'workflow', 'clinic-triage-line.json'));
const fs = require('fs');
const code = (n) => wf.nodes.find((x) => x.name === n).parameters.jsCode;
const run = (src, ctx) => new Function('$input', '$', `return (async () => { ${src} })()`)(ctx.$input, ctx.$);
(async () => {
  for (const f of ['vapi-tool-call-route.json', 'vapi-tool-call-emergency.json', 'vapi-tool-call-callback.json', 'vapi-end-of-call-report.json']) {
    const body = JSON.parse(fs.readFileSync('sample-data/' + f));
    const out = await run(code('Handle Vapi Message'), { $input: { first: () => ({ json: { headers: {}, body } }) } });
    console.log('\n==', f, '->', out[0].json.kind);
    console.log(JSON.stringify(out[0].json.response).slice(0, 500));
    if (out[0].json.callbacks && out[0].json.callbacks.length) {
      const handled = out[0].json;
      const split = await run(code('Split Callbacks'), { $input: { first: () => ({ json: handled }) } });
      for (const scenario of [[[{ json: {} }], [{ json: {} }]], [[{ json: {} }], [{ json: { error: 'calendar 403' } }]], [[{ json: { error: 'sheets 500' } }], [{ json: {} }]]]) {
        const nodesOut = { 'Handle Vapi Message': [{ json: handled }], 'Log Callback Request': scenario[0], 'Create Callback Event': scenario[1] };
        const $ = (n) => ({ first: () => nodesOut[n][0], all: () => nodesOut[n] });
        const r = await run(code('Build Callback Response'), { $input: null, $ });
        console.log('  split:', split.length, '| logged:', r[0].json.logged, 'scheduled:', r[0].json.scheduled, '->', JSON.stringify(r[0].json.response.results[0]));
      }
    }
    if (out[0].json.callLog) console.log('callLog', JSON.stringify(out[0].json.callLog));
  }
  const sec = code('Handle Vapi Message').replace("const VAPI_SHARED_SECRET = '';", "const VAPI_SHARED_SECRET = 's3cret';");
  const bad = await run(sec, { $input: { first: () => ({ json: { headers: {}, body: {} } }) } });
  const good = await run(sec, { $input: { first: () => ({ json: { headers: { authorization: 'Bearer s3cret' }, body: { message: { type: 'status-update' } } } }) } });
  console.log('\nsecret: no header ->', bad[0].json.kind, '| bearer ->', good[0].json.kind);
})();
