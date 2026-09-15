#!/usr/bin/env node
// Map the send-related API surface of window.zcode in the ZCode renderer (via CDP).
const port = process.argv[2] || '9222';

(async () => {
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const rpc = (method, params) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  await new Promise((r) => (ws.onopen = r));

  const expr = `(${function walk(o, depth) {
    const out = {};
    let keys = [];
    try { keys = Object.getOwnPropertyNames(o); } catch (e) { return '<locked>'; }
    for (const k of keys) {
      if (/^__|^_/.test(k)) continue;
      let v; try { v = o[k]; } catch (e) { continue; }
      const t = typeof v;
      if (t === 'function') { if (/send|message|input|queue|prompt|session|text|goal|steer/i.test(k)) out[k] = 'fn(' + v.length + ')'; }
      else if (t === 'object' && v !== null) { const sub = walk(v, depth - 1); if (sub && Object.keys(sub).length) out[k] = sub; }
    }
    return out;
  }.toString()})(window.zcode, 3)`;

  const r = await rpc('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log(JSON.stringify(r.result?.result?.value, null, 1));
  ws.close(); process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
