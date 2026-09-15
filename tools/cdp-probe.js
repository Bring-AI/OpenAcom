#!/usr/bin/env node
// Probe the ZCode desktop renderer over CDP: list targets, dump window bridges.
// Zero-dependency (Node >= 22 has global WebSocket).
// Usage: node cdp-probe.js [port]
const port = process.argv[2] || '9222';

const httpGet = (path) => fetch(`http://127.0.0.1:${port}${path}`).then((r) => r.json());

(async () => {
  let targets;
  try { targets = await httpGet('/json'); } catch { console.log('ERR: CDP port not reachable — start ZCode with --remote-debugging-port'); process.exit(2); }
  const page = targets.find((t) => t.type === 'page');
  if (!page) { console.log('ERR: no page target'); process.exit(2); }
  console.log('page:', page.title);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const rpc = (method, params) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  await new Promise((r) => (ws.onopen = r));

  const evaluate = async (expr) => {
    const r = await rpc('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.result?.result?.value ?? r.result?.result?.description ?? JSON.stringify(r.result).slice(0, 300);
  };

  console.log('window keys:', await evaluate('Object.keys(window).filter(k => /api|zcode|bridge|ipc|electron/i.test(k)).join(", ") || "(no obvious bridge)"'));
  console.log('preload probe:', await evaluate('typeof window.electronAPI !== "undefined" ? "electronAPI" : (typeof window.zcode !== "undefined" ? "zcode" : "none")'));
  ws.close();
  process.exit(0);
})();
