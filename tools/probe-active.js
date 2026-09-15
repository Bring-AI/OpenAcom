// Probe: how does the sidebar mark the currently-open session row?
const port = process.argv[2] || '9222';
(async () => {
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
  const page = targets.find((t) => t.type === 'page' && /^(file|http):/.test(t.url || ''));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0; const pending = new Map();
  const rpc = (m, p) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p })); });
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  await new Promise((r) => (ws.onopen = r));
  const ev = async (e) => (await rpc('Runtime.evaluate', { expression: e, returnByValue: true })).result?.value;

  const expr = `(function(){
    const out = [];
    const walk = (el, depth) => {
      if (depth > 8 || out.length > 400) return;
      for (const c of el.children) {
        const cls = String(c.className || '');
        if (/active|selected|current|opened|running/.test(cls)) {
          const r = c.getBoundingClientRect();
          out.push(JSON.stringify({ tag: c.tagName, cls: cls.slice(0, 80), text: (c.textContent || '').trim().slice(0, 24), x: Math.round(r.left), w: Math.round(r.width) }));
        }
        walk(c, depth + 1);
      }
    };
    walk(document.body, 0);
    return out.slice(0, 25).join('\\n');
  })()`;
  console.log(await ev(expr));
  ws.close(); process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
