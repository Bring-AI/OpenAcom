'use strict';
const { randomUUID } = require('crypto');

let busy = false;

// Strict distributed delivery supports the observed ZCode v4 DOM only. Exact
// session-id attributes, not a guessed/fuzzy title, bind the composer to a task.
async function sendDesktopStrict(session, text, { cdpPort = 9222, cdpTargetId, timeoutMs = 15000 } = {}) {
  const fail = (code, message, uncertain = false) => Object.assign(new Error(message), { code, uncertain });
  if (busy) throw fail('INPUT_BUSY', 'Another desktop input delivery is in progress');
  if (!session || typeof session.id !== 'string' || typeof session.title !== 'string' || !session.title.trim()) {
    throw fail('DESKTOP_TARGET', 'ZCode session must exist and have a non-empty full title');
  }
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
  const deadline = Date.now() + Math.min(Math.max(timeoutMs, 1000), 15000);
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
      expression: `(${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(',')})`,
      returnByValue: true,
      awaitPromise: false,
    });
    if (result.exceptionDetails) throw fail('DESKTOP_DOM', 'ZCode DOM evaluation failed', inserted);
    return result.result?.value;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json`, { signal: abort.signal });
    if (!response.ok) throw fail('DESKTOP_UNAVAILABLE', 'ZCode CDP endpoint did not return a target list');
    const body = await response.text();
    if (Buffer.byteLength(body) > 1024 * 1024) throw fail('DESKTOP_PROTOCOL', 'CDP target list is too large');
    const targets = JSON.parse(body);
    if (!Array.isArray(targets)) throw fail('DESKTOP_PROTOCOL', 'Invalid CDP target list');
    const pages = targets.filter((target) => target.type === 'page');
    const matches = cdpTargetId === undefined ? pages : pages.filter((page) => page.id === cdpTargetId);
    if (matches.length !== 1) throw fail('DESKTOP_TARGET', 'Select exactly one CDP page using local target cdpTargetId when multiple pages are present');
    const page = matches[0];
    if (typeof page.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(page.id)) throw fail('DESKTOP_PROTOCOL', 'Invalid CDP page id');
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
    const selection = await evaluate((id, title, lease, expiry) => {
      const visible = (element) => Boolean(element.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden';
      const existing = window.__openacomDesktopLease;
      if (existing && existing.expiry > Date.now()) return 'busy';
      const sidebar = document.querySelector('[data-testid="sidebar"]');
      if (!sidebar) return 'unsupported';
      const rows = [...sidebar.querySelectorAll('[data-testid^="task-item-"]')].filter(visible);
      const matches = rows.filter((row) => row.getAttribute('data-testid') === 'task-item-' + id);
      const titleMatches = rows.filter((row) => row.querySelector('[data-task-title-copy="original"]')?.textContent.trim() === title);
      if (matches.length !== 1 || titleMatches.length !== 1 || matches[0] !== titleMatches[0]) return 'ambiguous';
      // Do not switch away from an unfinished local draft either.
      const existingInputs = [...document.querySelectorAll('[data-testid="v4-composer-input"]')].filter(visible);
      if (existingInputs.some((input) => input.textContent !== '' || input.querySelector('img,video,audio,[data-lexical-decorator]'))) return 'draft';
      window.__openacomDesktopLease = { id: lease, expiry };
      matches[0].click();
      return 'selected';
    }, session.id, session.title.trim(), lockId, deadline + 1000);
    if (selection !== 'selected') throw fail(selection === 'busy' ? 'INPUT_BUSY' : 'DESKTOP_TARGET', `Cannot safely select ZCode session (${selection}); expose its exact unique full-title row and clear pending drafts`);
    locked = true;

    // Observe navigation, without repeating the selection side effect.
    let ready = false;
    const navigationDeadline = Math.min(deadline, Date.now() + 3000);
    while (Date.now() < navigationDeadline) {
      ready = await evaluate((id) => {
        const panes = [...document.querySelectorAll('[data-testid^="v4-session-pane-"][data-session-id]')].filter((pane) => pane.getClientRects().length && pane.getAttribute('data-session-id') === id);
        return panes.length === 1 && panes[0].querySelector('[data-testid="v4-composer-input"]') !== null;
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
      if (!input.isContentEditable || input.textContent !== '' || input.querySelector('img,video,audio,[data-lexical-decorator]') || !send || !send.disabled) return false;
      input.focus();
      return document.activeElement === input;
    }, session.id, session.title.trim(), lockId);
    if (!prepared) throw fail('INPUT_LOCKED', 'Cannot verify an empty, unambiguous ZCode composer and disabled empty-input send control');
    inserted = true;
    await rpc('Input.insertText', { text });
    const confirmed = await evaluate((id, expected, lease) => {
      if (window.__openacomDesktopLease?.id !== lease) return false;
      const panes = [...document.querySelectorAll('[data-testid^="v4-session-pane-"][data-session-id]')].filter((pane) => pane.getClientRects().length && pane.getAttribute('data-session-id') === id);
      if (panes.length !== 1) return false;
      const inputs = [...panes[0].querySelectorAll('[data-testid="v4-composer-input"]')].filter((input) => input.getClientRects().length);
      if (inputs.length !== 1 || document.activeElement !== inputs[0]) return false;
      const send = panes[0].querySelector('[data-testid="v4-composer-send"]');
      return Boolean(send && !send.disabled && (inputs[0].innerText === expected || inputs[0].textContent === expected));
    }, session.id, text, lockId);
    if (!confirmed) throw fail('INPUT_UNCERTAIN', 'Inserted text or session identity could not be confirmed; inspect the desktop, do not retry', true);
    await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' });
    await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
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

module.exports = { sendDesktopStrict };
