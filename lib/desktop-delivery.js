'use strict';
const path = require('path');
const { spawnSync } = require('child_process');
const { randomUUID } = require('crypto');
const { readFileSync } = require('fs');
const { homedir } = require('os');
const { selectDesktopSession } = require('./desktop-navigation');

let busy = false;

// A localhost CDP listener authenticates nobody: any process that wins the port
// first gets to answer these requests. These constants do not make the endpoint
// trusted - they only refuse to hand text to whatever happens to be listening,
// so an unrelated or partially-implementing debugger endpoint fails closed.
// Nothing here may fall back to "probe failed, assume it is ZCode".
const CDP_IDENTITY = Object.freeze({
  // Browser/Product must name a Chromium-family engine.
  browser: /(?:\b(?:chrome|chromium|electron|zcode)\b|\/)/i,
  // Electron ships an app token plus "Electron/<version>" in the UA; a plain
  // Chrome headless or a stub server does not.
  userAgent: /\belectron\/[0-9]/i,
  // The main ZCode window serves from file:// (packaged) or the loopback dev
  // server; tray/overlay helpers do not, and neither does anything remote.
  pageUrl: /^(?:file:|chrome-extension:|http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost)(?::\d+)?(?:\/|$))/i,
});
const IDENTITY_FIELDS = Object.freeze(Object.keys(CDP_IDENTITY));

// Operator-level consent gate for a node process that owns its own desktop.
// The value must be exactly "1": an empty or mistyped variable is not consent.
const CONSENT_ENV = ['OPENACOM_DESKTOP_CONSENT', 'AGENTRELAY_DESKTOP_CONSENT'];
// Resident file grant: `<AGENTRELAY_HOME>/desktop-consent` containing exactly
// "1". The env vars only reach processes the operator launched with them, but
// MCP servers are spawned by an already-running desktop app and inherit that
// app's environment - a file is the one resident grant such a server can be
// given without restarting the whole app. Deleting the file revokes it.
function desktopConsentFile() {
  return path.join(process.env.AGENTRELAY_HOME || path.join(homedir(), '.openacom'), 'desktop-consent');
}
function desktopConsentGranted(env = process.env) {
  if (CONSENT_ENV.some((key) => env[key] === '1')) return true;
  try { return readFileSync(desktopConsentFile(), 'utf8').trim() === '1'; } catch { return false; }
}

// One message for both entry points (deliver() and this module) so a caller
// always learns the same two ways out. uncertain stays false: nothing has been
// sent to the desktop at this point.
function consentFailure(consented) {
  if (consented === true || desktopConsentGranted()) return null;
  return Object.assign(new Error('ZCode desktop submit needs an explicit consent signal because it presses Enter in a live desktop window. Deliver mode "draft" instead (the text lands in the composer for the operator to review), or pass consent:true from a caller that has operator approval, or set OPENACOM_DESKTOP_CONSENT=1 in this process environment, or write exactly "1" into the desktop-consent file in the OpenAcom home directory - the last two are resident grants for a desktop you personally control.'), { code: 'CONSENT_REQUIRED', uncertain: false });
}

// An identity field may be a RegExp or a literal substring; null, false or an
// empty string disable that single check. Anything else is a configuration bug
// and must not silently weaken the gate.
function matchesIdentity(pattern, value, label) {
  if (pattern === undefined || pattern === null || pattern === false || pattern === '') return { ok: true, enforced: false };
  const text = typeof value === 'string' ? value : '';
  if (pattern instanceof RegExp) return { ok: pattern.test(text), enforced: true, expected: String(pattern), actual: text.slice(0, 160) };
  if (typeof pattern === 'string') return { ok: text.includes(pattern), enforced: true, expected: `contains ${JSON.stringify(pattern)}`, actual: text.slice(0, 160) };
  throw new TypeError(`invalid ${label} identity pattern`);
}

async function fetchCdpJson(port, path, failureCode, abort) {
  const fail = (message, actual) => Object.assign(new Error(actual ? `${message} (${actual})` : message), { code: failureCode });
  let response;
  try {
    // connection: close, so no keep-alive socket outlives the probe - the
    // synchronous caller runs this in a child that must be able to just exit.
    response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: abort.signal, headers: { connection: 'close' } });
  } catch (error) {
    throw fail(`CDP endpoint 127.0.0.1:${port}${path} could not be reached: ${error.message}`);
  }
  if (!response.ok) throw fail(`CDP ${path} returned HTTP ${response.status}`);
  const body = await response.text();
  if (Buffer.byteLength(body) > 1024 * 1024) throw fail(`CDP ${path} response is too large`);
  try {
    return JSON.parse(body);
  } catch {
    throw fail(`CDP ${path} did not return JSON`, body.replace(/\s+/g, ' ').trim().slice(0, 120));
  }
}

// The identity probe every desktop path shares: the engine the port declares in
// /json/version, then exactly one identity-shaped page in /json. Returns that
// page. Failing closed is the only alternative - a probe that errors must never
// be read as "probably ZCode". `fail` lets a caller keep its own error contract.
//
// The two refusal families stay separate because callers treat them differently:
// DESKTOP_UNAVAILABLE means "no debugger endpoint here" (nothing answered, or an
// answer that is not CDP at all), while CDP_IDENTITY means "something answered
// and it is not ZCode". Only the first is an acceptable reason to use another
// transport; an endpoint that impersonates the debugger is never retried
// somewhere else.
async function verifyCdpEndpoint(cdpPort, checks, { cdpTargetId, abort = new AbortController(), fail } = {}) {
  const failWith = typeof fail === 'function' ? fail : (code, message, uncertain = false) => Object.assign(new Error(message), { code, uncertain });
  const version = await fetchCdpJson(cdpPort, '/json/version', 'DESKTOP_UNAVAILABLE', abort);
  if (!version || typeof version !== 'object' || Array.isArray(version)) throw failWith('CDP_IDENTITY', `CDP /json/version on port ${cdpPort} did not describe a browser`);
  const product = [version.Browser, version.Product].filter((value) => typeof value === 'string').join(' ');
  const declaredUserAgent = [version['User-Agent'], version.userAgent].find((value) => typeof value === 'string') || '';
  for (const [key, value] of [['browser', product], ['userAgent', declaredUserAgent]]) {
    const outcome = matchesIdentity(checks[key], value, key);
    if (!outcome.enforced) continue;
    if (!outcome.ok) {
      throw failWith('CDP_IDENTITY', `127.0.0.1:${cdpPort} is not verified as the ZCode desktop debugger: ${key} ${JSON.stringify(outcome.actual)} does not match ${outcome.expected}. Refusing to inject text; check the target cdpPort, or pass an explicit identity override for a build this default does not describe.`);
    }
  }
  const targets = await fetchCdpJson(cdpPort, '/json', 'DESKTOP_UNAVAILABLE', abort);
  if (!Array.isArray(targets)) throw failWith('CDP_PROTOCOL', 'Invalid CDP target list');
  const pages = targets.filter((target) => target && target.type === 'page');
  const shaped = pages.filter((page) => matchesIdentity(checks.pageUrl, typeof page.url === 'string' ? page.url : '', 'pageUrl').ok);
  const matches = cdpTargetId === undefined ? shaped : shaped.filter((page) => page.id === cdpTargetId);
  if (matches.length !== 1) {
    throw failWith('DESKTOP_TARGET', `Expected exactly one identity-shaped CDP page on port ${cdpPort}, found ${matches.length} of ${pages.length} page target(s)` +
      (pages.length !== shaped.length ? ` (${pages.length - shaped.length} rejected by the page url identity check)` : '') +
      '; select one using local target cdpTargetId when multiple pages are present');
  }
  const page = matches[0];
  if (typeof page.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(page.id)) throw failWith('CDP_PROTOCOL', 'Invalid CDP page id');
  return page;
}

// The legacy desktop transport (tools/cdp-send.js, driven synchronously by
// lib/adapters/zcode.js) inserts text and presses Enter inside a child process,
// so its caller cannot await the probe above. Running the probe itself in a
// short-lived child keeps one implementation instead of a second, weaker
// opinion. Nothing here may proceed on a probe that could not run: every exit
// path other than status 0 is a refusal, and uncertain stays false because no
// text reached the desktop.
const PROBE_CODES = ['CDP_IDENTITY', 'CDP_PROTOCOL', 'DESKTOP_UNAVAILABLE', 'DESKTOP_TARGET'];
const PROBE_VERDICT = 'VERIFIED';
function verifyCdpEndpointSync(cdpPort, { timeoutMs = 8000, spawn = spawnSync, execPath = process.execPath } = {}) {
  // The child writes its verdict instead of only setting an exit code: a process
  // that exits 0 for any other reason (drained loop, half-loaded module) must not
  // read as a pass.
  const script = `const m=require(process.argv[1]);m.verifyCdpEndpoint(Number(process.argv[2]),m.CDP_IDENTITY)`
    + `.then(function(){process.stdout.write("${PROBE_VERDICT}")},`
    + `function(e){process.exitCode=1;process.stderr.write(String((e&&e.code)||"CDP_IDENTITY")+": "+String((e&&e.message)||e))})`;
  const refusal = (message) => Object.assign(new Error(message), { code: 'CDP_IDENTITY', uncertain: false });
  const result = spawn(execPath, ['-e', script, __filename, String(cdpPort)], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  if (result && result.error) throw refusal(`Desktop identity probe for 127.0.0.1:${cdpPort} could not run (${result.error.code || result.error.message}); refusing desktop delivery`);
  // Only a clean exit 0 that also reported the verdict counts as verified. A
  // crash, a timeout, or a probe that said nothing is a refusal, never a pass.
  if (result && result.status === 0 && String(result.stdout || '').trim() === PROBE_VERDICT) return;
  const spoken = String((result && (result.stderr || result.stdout)) || '').replace(/\s+/g, ' ').trim();
  const detail = (spoken || `the probe exited ${result ? result.status : 'without a status'}`).slice(0, 400);
  const separator = detail.indexOf(': ');
  const reported = separator < 0 ? '' : detail.slice(0, separator);
  const code = PROBE_CODES.includes(reported) ? reported : 'CDP_IDENTITY';
  const reason = code === reported ? detail.slice(separator + 2) : detail;
  throw Object.assign(refusal(`Refusing desktop delivery: 127.0.0.1:${cdpPort} - ${reason}`), { code });
}

// Strict distributed delivery supports the observed ZCode v4 DOM only. Exact
// session-id attributes, not a guessed/fuzzy title, bind the composer to a task.
async function desktopOperation(session, text, {
  cdpPort = 9222,
  cdpTargetId,
  timeoutMs = 15000,
  mode = 'draft',
  consent = false,
  identity = {},
} = {}, inspectOnly = false) {
  const fail = (code, message, uncertain = false) => Object.assign(new Error(message), { code, uncertain });
  if (mode !== 'submit' && mode !== 'draft') throw fail('INVALID_MODE', 'Desktop delivery mode must be submit or draft');
  // Submitting presses Enter in a window somebody may be typing into. Draft is
  // the only default; submit needs an explicit, per-call consent signal.
  if (mode !== 'submit' && mode !== 'draft') throw fail('INVALID_MODE', 'Desktop mode must be submit or draft');
  if (mode === 'submit' && !inspectOnly) {
    const gate = consentFailure(consent);
    if (gate) throw gate;
  }
  if (!session || typeof session.id !== 'string' || typeof session.title !== 'string' || !session.title.trim()) {
    throw fail('DESKTOP_TARGET', 'ZCode session must exist and have a non-empty full title');
  }
  const checks = Object.assign({}, CDP_IDENTITY, identity);
  for (const [label, pattern] of Object.entries(checks)) {
    // A mistyped field must not quietly drop the check it was meant to weaken.
    if (!IDENTITY_FIELDS.includes(label)) throw fail('INVALID_IDENTITY', `Unknown desktop identity field ${JSON.stringify(label)}; known fields are ${IDENTITY_FIELDS.join(', ')}`, false);
    try { matchesIdentity(pattern, '', label); }
    catch (error) { throw fail('INVALID_IDENTITY', `Desktop target identity config is invalid: ${error.message}`, false); }
  }
  if (busy) throw fail('INPUT_BUSY', 'Another desktop input delivery is in progress');
  busy = true;
  let inserted = false;
  let ws;
  let seq = 0;
  let closed = false;
  let rejectOpen;
  let locked = false;
  const pending = new Map();
  const lockId = randomUUID();
  const abort = new AbortController();
  const deadline = Date.now() + Math.min(Math.max(timeoutMs, 1000), 300000);
  function stop(error) {
    closed = true;
    rejectOpen?.(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }
  const watchdog = setTimeout(() => {
    abort.abort();
    stop(fail('DESKTOP_TIMEOUT', 'Desktop delivery timed out; never automatically replay it', inserted));
    ws?.close();
  }, deadline - Date.now());
  function rpc(method, params) {
    if (closed || Date.now() >= deadline || ws.readyState !== WebSocket.OPEN) return Promise.reject(fail('DESKTOP_CLOSED', 'CDP connection is not open', inserted));
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      try { ws.send(JSON.stringify({ id, method, params })); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }
  async function evaluate(fn, ...args) {
    const result = await rpc('Runtime.evaluate', {
      expression: `(${fn.toString()})(${args.map((arg) => arg === undefined ? 'undefined' : JSON.stringify(arg)).join(',')})`,
      returnByValue: true,
      awaitPromise: false,
    });
    if (result.exceptionDetails) throw fail('DESKTOP_DOM', 'ZCode DOM evaluation failed', inserted);
    return result.result?.value;
  }
  try {
    const page = await verifyCdpEndpoint(cdpPort, checks, { cdpTargetId, abort, fail });
    // Do not trust a target-list-provided WebSocket URL to redirect off localhost.
    ws = new WebSocket(`ws://127.0.0.1:${cdpPort}/devtools/page/${encodeURIComponent(page.id)}`);
    ws.addEventListener('message', (event) => {
      try {
        if (typeof event.data !== 'string' || event.data.length > 1024 * 1024) throw new Error('Invalid CDP response');
        const result = JSON.parse(event.data);
        const request = pending.get(result.id);
        if (!request) return;
        pending.delete(result.id);
        if (result.error) request.reject(fail('DESKTOP_PROTOCOL', String(result.error.message).slice(0, 500), inserted));
        else request.resolve(result.result);
      } catch (error) { stop(error); ws.close(); }
    });
    ws.addEventListener('error', () => stop(fail('DESKTOP_UNAVAILABLE', 'CDP connection failed', inserted)));
    ws.addEventListener('close', () => stop(fail('DESKTOP_CLOSED', 'CDP connection closed', inserted)));
    await new Promise((resolve, reject) => {
      rejectOpen = reject;
      ws.addEventListener('open', resolve, { once: true });
    });
    rejectOpen = undefined;
    // Cross-check the engine the page itself reports against what /json/version
    // claimed, so a stub that answers the HTTP endpoints but is not the Electron
    // renderer still fails before any DOM side effect.
    const liveUserAgent = await evaluate(() => navigator.userAgent);
    const live = matchesIdentity(checks.userAgent, typeof liveUserAgent === 'string' ? liveUserAgent : '', 'userAgent');
    if (live.enforced && !live.ok) throw fail('CDP_IDENTITY', `Connected CDP page reports ${JSON.stringify(live.actual)} which does not match the ZCode/Electron identity ${live.expected}; refusing to inject`);
    let selection;
    const selectDeadline = Math.min(deadline, Date.now() + 4000);
    do {
      selection = await evaluate(selectDesktopSession, session.id, session.title.trim(), session.directory || session.workspace, lockId, deadline + 1000);
      if (['selected','active','navigated','expanded'].includes(selection)) locked = true;
      if (!['expanded','loading-workspace'].includes(selection)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < selectDeadline);
    if (!['selected','active','navigated'].includes(selection)) {
      const codes = {busy:'INPUT_BUSY',draft:'INPUT_DRAFT', 'not-listed':'DESKTOP_NOT_LISTED', 'workspace-unavailable':'DESKTOP_WORKSPACE', 'title-mismatch':'DESKTOP_TITLE_MISMATCH'};
      throw fail(codes[selection] || 'DESKTOP_TARGET', 'Cannot select exact ZCode session (' + selection + '). Open this session in ZCode or refresh its workspace before trying again.');
    }

    // Observe navigation, without repeating the selection side effect.
    let ready = false;
    const navigationDeadline = deadline - 500;
    while (Date.now() < navigationDeadline) {
      ready = await evaluate((id) => {
        const panes = [...document.querySelectorAll('[data-testid^="v4-session-pane-"][data-session-id]')].filter((pane) => pane.getClientRects().length && pane.getAttribute('data-session-id') === id);
        return panes.length === 1 && panes[0].querySelector('[data-testid="v4-composer-input"]')?.isContentEditable === true;
      }, session.id);
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw fail('DESKTOP_TARGET', 'Cannot verify the selected pane has the exact configured session id');
    const prepared = await evaluate((id, title, lease) => {
      if (window.__openacomDesktopLease?.id !== lease) return false;
      const visible = (element) => Boolean(element.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden';
      const panes = [...document.querySelectorAll('[data-testid^="v4-session-pane-"][data-session-id]')].filter(visible);
      const matches = panes.filter((pane) => pane.getAttribute('data-session-id') === id);
      if (matches.length !== 1) return false;
      const pane = matches[0];
      const titles = [...pane.querySelectorAll('[data-testid="v4-session-title"]')];
      if (titles.length !== 1 || (titles[0].getAttribute('data-title') || titles[0].textContent).trim() !== title) return false;
      const inputs = [...pane.querySelectorAll('[data-testid="v4-composer-input"]')].filter(visible);
      if (inputs.length !== 1) return false;
      const input = inputs[0];
      const send = pane.querySelector('[data-testid="v4-composer-send"]');
      // A running session replaces the send control with a stop control, so the
      // empty-input send button only has to exist on an idle pane; a missing one
      // is acceptable exactly while the stop control is there instead.
      const stop = pane.querySelector('[data-testid="v4-stop"]');
      if (!input.isContentEditable || input.textContent !== '' || input.querySelector('img,video,audio,[data-lexical-decorator]')) return false;
      if (send ? !send.disabled : !stop) return false;
      input.focus();
      return document.activeElement === input;
    }, session.id, session.title.trim(), lockId);
    if (!prepared) throw fail('INPUT_LOCKED', 'Cannot verify an empty, unambiguous ZCode composer with an idle (disabled send) or running (stop) control');
    if (inspectOnly) return {status:'ready',sessionId:session.id,title:session.title,selection};
    inserted = true;
    await rpc('Input.insertText', { text });
    let confirmed = false;
    const confirmDeadline = Math.min(deadline - 250, Date.now() + 3000);
    do {
    confirmed = await evaluate((id, expected, lease) => {
      if (window.__openacomDesktopLease?.id !== lease) return false;
      const panes = [...document.querySelectorAll('[data-testid^="v4-session-pane-"][data-session-id]')].filter((pane) => pane.getClientRects().length && pane.getAttribute('data-session-id') === id);
      if (panes.length !== 1) return false;
      const inputs = [...panes[0].querySelectorAll('[data-testid="v4-composer-input"]')].filter((input) => input.getClientRects().length);
      if (inputs.length !== 1 || document.activeElement !== inputs[0]) return false;
      const send = panes[0].querySelector('[data-testid="v4-composer-send"]');
      return Boolean((!send || !send.disabled) && (inputs[0].innerText === expected || inputs[0].textContent === expected));
    }, session.id, text, lockId);
    if (confirmed) break; await new Promise(resolve=>setTimeout(resolve,50));
    } while (Date.now()<confirmDeadline);
    if (!confirmed) throw fail('INPUT_UNCERTAIN', 'Inserted text or session identity could not be confirmed; inspect the desktop, do not retry', true);
    if (mode === 'draft') {
      // Leave the text in the composer for the operator; the lease is released in
      // the finally block so the local user can edit or submit it.
      return { status: 'drafted', outcome: 'input-drafted' };
    }
    await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' });
    await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    let accepted = false;
    const submitDeadline = Math.min(deadline - 100, Date.now() + 3000);
    do {
      accepted = await evaluate((id,lease)=>{
        if(window.__openacomDesktopLease?.id!==lease)return false;
        const panes=[...document.querySelectorAll('[data-testid^="v4-session-pane-"][data-session-id]')].filter(p=>p.getClientRects().length&&p.getAttribute('data-session-id')===id);
        const inputs=panes.length===1?[...panes[0].querySelectorAll('[data-testid="v4-composer-input"]')].filter(e=>e.getClientRects().length):[];
        return inputs.length===1&&inputs[0].textContent==='';
      },session.id,lockId);
      if(accepted)break;await new Promise(resolve=>setTimeout(resolve,50));
    } while(Date.now()<submitDeadline);
    if(!accepted)throw fail('INPUT_UNCERTAIN','Enter was dispatched, but the composer did not confirm acceptance. Inspect the session before retrying.',true);
    return { status: 'submitted', outcome: 'input-submitted' };
  } catch (error) {
    throw fail(error.code || 'DESKTOP_ERROR', error.message, inserted || error.uncertain === true);
  } finally {
    if (locked && ws?.readyState === WebSocket.OPEN && !closed && Date.now() < deadline) {
      try {
        await evaluate((lease) => {
          if (window.__openacomDesktopLease?.id === lease) delete window.__openacomDesktopLease;
        }, lockId);
      } catch {} // A crashed connection leaves only a bounded, expiring lease.
    }
    clearTimeout(watchdog);
    abort.abort();
    ws?.close();
    busy = false;
  }
}

function sendDesktopStrict(session,text,opts={}) { return desktopOperation(session,text,opts,false); }
// Navigates and verifies the real target without inserting text or pressing Enter.
function inspectDesktopTarget(session,opts={}) { return desktopOperation(session,'',{...opts,mode:'draft'},true); }

// The focus-stealing UIA branch, written once so both desktop senders hand the
// powershell the same argv. Callers must already have passed the consent gate:
// this types into whichever window owns the title and presses Enter.
function uiSend(session, text, {
  timeoutMs = 60e3, spawn = spawnSync, ps1 = path.join(__dirname, 'desktop-send.ps1'), host = 'powershell',
} = {}) {
  const b64 = (value) => Buffer.from(String(value), 'utf8').toString('base64');
  const title = String(session.title || '').trim().slice(0, 24);
  const result = spawn(host, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-TitleB64', b64(title), '-MessageB64', b64(text)], { timeout: timeoutMs, encoding: 'utf8', windowsHide: true });
  const out = String((result && result.stdout) || '').trim();
  if (result && result.error) {
    throw Object.assign(new Error(`desktop UIA sender could not start: ${result.error.code || result.error.message}`), { code: 'DESKTOP_UIA', uncertain: false });
  }
  if (result && result.status === 0 && !out.startsWith('ERR')) return out;
  // powershell ran and may have typed before it failed, which is not something to
  // replay into a live window.
  throw Object.assign(new Error(out || `desktop UIA send failed (exit ${result ? result.status : 'no status'})`), { code: 'DESKTOP_UIA', uncertain: true });
}

// The one desktop INJECTION transport: it types the text into the real ZCode
// window and presses Enter, and that is all it can do.
//
// "Forceful" here means the transport has no retreat - it never falls back to a
// headless run, never parks the text in a mailbox for somebody else to pick up,
// and never retries on a second transport. It does not mean skipping the
// operator's approval: a submit still needs consent:true or the resident
// OPENACOM_DESKTOP_CONSENT=1, because an Enter pressed in a window the user is
// typing into cannot be taken back.
//
// mode is fixed to submit on purpose. A draft is a different promise about the
// target (nothing is sent), and it belongs to sendDesktopStrict; accepting both
// words here would let a caller ask for one and get the other.
async function deliverDesktop(session, text, {
  mode = 'submit',
  consent = false,
  cdpPort = 9222,
  cdpTargetId,
  timeoutMs = 60e3,
  identity,
  platform = process.platform,
  spawn = spawnSync,
  strictSender = sendDesktopStrict,
  ps1 = path.join(__dirname, 'desktop-send.ps1'),
} = {}) {
  const fail = (code, message, uncertain = false) => Object.assign(new Error(message), { code, uncertain });
  if (mode !== 'submit') {
    throw fail('INVALID_MODE', `deliverDesktop only submits, got ${JSON.stringify(mode)}. Leave the text for a human with sendDesktopStrict({mode:"draft"}), or omit mode here.`);
  }
  const gate = consentFailure(consent === true);
  if (gate) throw gate;
  if (!session || typeof session.id !== 'string' || !session.id) throw fail('DESKTOP_TARGET', 'desktop injection needs a ZCode session with an id');
  if (typeof session.title !== 'string' || !session.title.trim()) throw fail('DESKTOP_TARGET', 'desktop injection needs a session with a non-empty full title');
  if (typeof text !== 'string' || !text.length) throw fail('INVALID_TEXT', 'desktop injection needs non-empty text');
  if (platform !== 'win32') throw fail('DESKTOP_PLATFORM', `desktop injection is Windows-only (it drives the ZCode desktop UI), not ${platform}`);
  const base = { status: 'submitted', sessionId: session.id, cdpPort, textLength: text.length, consent: true, uncertain: false };
  try {
    const outcome = await strictSender(session, text, { mode: 'submit', consent: true, cdpPort, cdpTargetId, timeoutMs, ...(identity ? { identity } : {}) });
    return { ...base, outcome: (outcome && outcome.outcome) || 'input-submitted', transport: 'cdp', note: `submitted through the ZCode desktop debugger on 127.0.0.1:${cdpPort}` };
  } catch (error) {
    // Exactly one answer may change transport: nothing is listening as CDP, and
    // provably nothing was typed. Anything that did answer - an impersonator, a
    // half-open socket, a failure after the text went in - ends the call, since
    // a second transport would type the same text twice into a live window.
    const switchable = error && error.code === 'DESKTOP_UNAVAILABLE' && error.uncertain !== true;
    if (!switchable) {
      throw Object.assign(fail(error && error.code || 'DESKTOP_ERROR', `${(error && error.message) || 'desktop injection failed'} (no fallback was attempted)`, error && error.uncertain === true), { transport: 'cdp', attempted: ['cdp'] });
    }
    let note;
    try {
      note = uiSend(session, text, { timeoutMs, spawn, ps1 });
    } catch (uiaError) {
      throw Object.assign(fail('DESKTOP_UIA', `desktop injection failed on both transports: CDP was not answering (${error.message}); the UIA sender then failed: ${uiaError.message}`, uiaError.uncertain === true), { transport: 'uia', attempted: ['cdp', 'uia'] });
    }
    return { ...base, outcome: 'input-submitted-via-uia', transport: 'uia', note: note || 'submitted through the ZCode desktop window (UIA; focus was taken to type it)' };
  }
}

module.exports = {
  sendDesktopStrict, inspectDesktopTarget, deliverDesktop, uiSend, verifyCdpEndpoint, verifyCdpEndpointSync, desktopConsentGranted, desktopConsentFile, consentFailure, CONSENT_ENV, CDP_IDENTITY, matchesIdentity,
};
