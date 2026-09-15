// Probe: all composers (visible or hidden) and whether we can map them to conversations.
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

  const info = await ev(`(function(){
    const composers = [...document.querySelectorAll('textarea, [contenteditable="true"]')];
    return composers.map((c, i) => {
      const r = c.getBoundingClientRect();
      const ph = (c.placeholder || c.getAttribute('data-placeholder') || c.getAttribute('aria-label') || '').slice(0, 24);
      // walk up to find a container with substantial text (conversation identity)
      let anc = c, ctx = '';
      for (let k = 0; k < 12 && anc.parentElement; k++) {
        anc = anc.parentElement;
        const t = (anc.textContent || '').trim();
        if (t.length > 40) { ctx = t.slice(0, 60); break; }
      }
      return i + '|vis=' + (c.offsetParent !== null) + '|ph=' + ph + '|x=' + Math.round(r.left) + ',y=' + Math.round(r.top) + '|ctx=' + ctx;
    }).join('\\n');
  })()`);
  console.log('COMPOSERS:');
  console.log(info);
  console.log('TABS:', await ev(`[...document.querySelectorAll('[role="tab"]')].map(t => (t.textContent||'').trim().slice(0,16) + (t.getAttribute('aria-selected')==='true'?'*':'')).join(' | ')`));
  ws.close(); process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
