#!/usr/bin/env node
// AgentRelay desktop-mode sender via CDP (renderer-level, no OS focus steal).
// Selects the session in the sidebar by title prefix, focuses the composer,
// inserts the message as trusted input, presses Enter. Requires ZCode started
// with --remote-debugging-port (tools/start-zcode-cdp.ps1).
// Usage: node cdp-send.js <titlePrefix> <message> [port]

const port = process.argv[4] || '9222';
const t0 = Date.now();
const stage = (m) => console.error(`[cdp +${Date.now() - t0}ms] ${m}`);
const watchdog = setTimeout(() => { console.error(`[cdp +${Date.now() - t0}ms] WATCHDOG: stuck`); process.exit(3); }, 25000);
const titlePrefix = process.argv[2];
const message = process.argv[3];

if (!titlePrefix || !message) { console.log('usage: node cdp-send.js <titlePrefix> <message> [port]'); process.exit(1); }

(async () => {
  stage('fetching /json');
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => null);
  if (!targets) { console.log('ERR: CDP port ' + port + ' not reachable - start ZCode via tools/start-zcode-cdp.ps1'); process.exit(2); }
  // skip overlay windows (tray indicator etc.): main window serves the app from file://
  stage(`targets: ${targets.length}`);
  const page = targets.find((t) => t.type === 'page' && /^file:|^http:/.test(t.url || ''));
  if (!page) { console.log('ERR: no page target'); process.exit(2); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0; const pending = new Map();
  const rpc = (method, params) => new Promise((res, rej) => {
    const id = ++seq; pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  };
  const opened = new Promise((r) => (ws.onopen = r));
  ws.onerror = () => { console.log('ERR: websocket failed'); process.exit(2); };
  await opened;

  const evaluate = async (expression) => {
    const r = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
    if (r.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception?.description || '').slice(0, 200));
    return r.result?.value;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 1) click the sidebar row whose text starts with the title prefix
  const clicked = await evaluate(`(function(){
    const prefix = ${JSON.stringify(titlePrefix)};
    const els = [...document.querySelectorAll('div,span,button')];
    const hits = els.filter(e => {
      const t = (e.textContent || '').trim();
      const r = e.getBoundingClientRect();
      return t.startsWith(prefix) && t.length <= prefix.length + 8 && r.left >= 0 && r.left < 460 && r.width > 40;
    });
    if (!hits.length) return null;
    const el = hits[hits.length - 1];
    el.click();
    return el.textContent.trim().slice(0, 50);
  })()`);
  if (!clicked) { console.log('ERR: session row not found in sidebar for: ' + titlePrefix); process.exit(4); }
  console.log('clicked row:', clicked);
  await sleep(900);

  // 2) find the composer (textarea/contenteditable) of the opened conversation
  const composerInfo = await evaluate(`(function(){
    const cands = [...document.querySelectorAll('textarea, [contenteditable="true"]')].filter(e => e.offsetParent !== null);
    const re = /${'\\u5411 ZCode \\u63D0\\u95EE|\\u7EE7\\u7EED\\u8F93\\u5165|\\u63D0\\u51FA\\u540E\\u7EED\\u4FEE\\u6539|\\u8BF4\\u70B9\\u4EC0\\u4E48'}/;
    const hit = cands.find(e => re.test(e.getAttribute('placeholder') || e.getAttribute('data-placeholder') || e.getAttribute('aria-label') || ''));
    if (hit) { hit.focus(); return hit.tagName + '|' + (hit.getAttribute('placeholder') || hit.getAttribute('data-placeholder') || '').slice(0, 20); }
    if (cands.length) { cands[cands.length - 1].focus(); return cands[cands.length - 1].tagName + '|fallback'; }
    return null;
  })()`);
  if (!composerInfo) { console.log('ERR: composer not found'); process.exit(5); }
  console.log('composer:', composerInfo);

  // 3) insert message as trusted input, then Enter to send
  await rpc('Input.insertText', { text: message });
  await sleep(350);
  const key = (type) => rpc('Input.dispatchKeyEvent', {
    type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: type === 'keyChar' ? '\r' : undefined,
  });
  await key('rawKeyDown');
  await key('char');
  await key('keyUp');
  await sleep(300);
  clearTimeout(watchdog);
  console.log('OK sent via desktop UI (CDP)');
  ws.close(); process.exit(0);
})().catch((e) => { console.log('ERR: ' + e.message); process.exit(1); });
