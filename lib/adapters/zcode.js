'use strict';
const path = require('path');
const { homedir } = require('os');
const fs = require('fs');
const { run, resolveZcodeCli, zcodeConfigPath } = require('../util');
const { protectPath } = require('../secure-fs');

const DB_PATH = () => path.join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite');

function openDb() {
  if (!fs.existsSync(DB_PATH())) return null;
  // node:sqlite ships with Node >= 22.5
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(DB_PATH(), { readOnly: true });
}

function available() {
  return fs.existsSync(DB_PATH());
}

function list(limit = 0) {
  const db = openDb();
  if (!db) return [];
  try {
    const rows = db.prepare(`
      SELECT id, title, directory, time_created, time_updated
      FROM session
      WHERE parent_id IS NULL
        AND slug NOT LIKE 'sess\\_subagent%' ESCAPE '\\'
        AND time_archived IS NULL
      ORDER BY COALESCE(time_updated, time_created) DESC
      ${limit && limit > 0 ? 'LIMIT ' + Number.parseInt(limit, 10) : ''}
    `).all();
    return rows.map((r) => ({
      agent: 'zcode',
      id: r.id,
      title: r.title || '(untitled)',
      workspace: r.directory || '',
      mtime: r.time_updated || r.time_created || 0,
    }));
  } finally { db.close(); }
}

function get(id) {
  const db = openDb();
  if (!db) return null;
  try {
    return db.prepare('SELECT id, title, directory, path FROM session WHERE id = ?').get(id) || null;
  } finally { db.close(); }
}

// Conversation turns: message rows carry the role, part rows carry text.
function messages(id, limit = 10) {
  const db = openDb();
  if (!db) return null;
  try {
    const rows = db.prepare(`
      SELECT m.data AS md, p.data AS pd
      FROM message m
      JOIN part p ON p.message_id = m.id
      WHERE m.session_id = ?
      ORDER BY m.time_created ASC, COALESCE(p.time_created, m.time_created) ASC, p.sequence ASC
    `).all(id);
    const turns = [];
    for (const r of rows) {
      let md, pd;
      try { md = JSON.parse(r.md); pd = JSON.parse(r.pd); } catch { continue; }
      if (pd.type !== 'text' || !pd.text) continue;
      turns.push({ role: md.role || '?', text: pd.text });
    }
    return turns.slice(-limit);
  } finally { db.close(); }
}

// A detached turn writes its complete output here, so on a shared machine this
// directory is a disclosure surface: the mode is the request made at creation
// time, and protectPath is what actually holds on the existing tree (icacls on
// Windows, a verified chmod on POSIX). Memoised per directory - an icacls spawn
// on every send would make each headless turn pay for a process it does not need.
let _logsProtectedDir = null;
let _logsAcl = null;
function logDir({ fsImpl = fs, home = homedir, protect = protectPath } = {}) {
  const d = path.join(home(), '.openacom', 'logs');
  fsImpl.mkdirSync(d, { recursive: true, mode: 0o700 });
  if (_logsProtectedDir !== d) {
    _logsProtectedDir = d;
    _logsAcl = protect(d, { directory: true });
  }
  return d;
}
// 'inherited' means the log tree is readable by someone else on this machine.
function logsAcl() { return _logsAcl; }

// Start a headless zcode turn that outlives this process; output lands in a log file.
// The same fs/home/protect seams reach the directory, so a test can run the whole
// creation path against a temporary tree.
function spawnDetached(cliArgs, cwd, { spawn = require('child_process').spawn, fsImpl = fs, home, protect } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const log = path.join(logDir({ fsImpl, home, protect }), `zcode-${stamp}.log`);
  // The mode applies only when the file is created, which is why this opens with
  // 'a' and an explicit 0600 rather than relying on a later chmod.
  const out = fsImpl.openSync(log, 'a', 0o600);
  const child = spawn(process.execPath, cliArgs, { cwd, detached: true, stdio: ['ignore', out, out] });
  child.unref();
  try { fsImpl.closeSync(out); } catch { /* child owns its dup */ }
  return log;
}

// Delivery is desktop-CDP only: on failure the error propagates - no silent
// headless fallback (a fallback can run on a different model than the session
// UI, and it drops the message entirely when headless is broken). Pass
// desktop:false (--no-desktop) for the explicit headless escape hatch, which is
// also the route to take when the desktop consent gate refuses to submit.
function send(id, message, { timeoutMs = 600e3, noWait = false, desktop, desktopStrict = false, cdpPort, cdpTargetId, mode, consent = false } = {}) {
  const sess = get(id);
  if (desktopStrict) {
    if (desktop !== true) throw Object.assign(new Error('Strict desktop delivery requires desktop:true'), { code: 'INVALID_MODE', uncertain: false });
    // mode/consent pass straight through; the strict sender still defaults to draft.
    return require('../desktop-delivery').sendDesktopStrict(sess, message, { timeoutMs, cdpPort, cdpTargetId, mode, consent: consent === true });
  }
  if (!sess) throw new Error(`zcode session not found: ${id}`);
  if (desktop !== false) {
    return sendDesktop(id, message, { timeoutMs: Math.min(timeoutMs, 60e3), mode, cdpPort, consent: consent === true });
  }
  const cli = resolveZcodeCli();
  if (!cli) {
    throw new Error('zcode CLI (zcode.cjs) not found; set AGENTRELAY_ZCODE_CLI to its full path');
  }
  if (!fs.existsSync(zcodeConfigPath())) {
    throw new Error(`headless zcode needs a model provider config at ${zcodeConfigPath()} (key "provider" + "model"); the desktop app keeps its own copy under ~/.zcode/v2/config.json`);
  }
  const cliArgs = [cli, '--resume', id, '--cwd', sess.directory || sess.path || process.cwd(), '--prompt', message];
  if (noWait) {
    const log = spawnDetached(cliArgs, sess.directory || sess.path || process.cwd());
    return `OK (no-wait) turn running in background on ${id}; reply lands in the session transcript and ${log}`;
  }
  // spawn node.exe directly (no shell) so the message can contain any characters
  const r = run(process.execPath, cliArgs, { timeoutMs });
  if (r.error) throw new Error(r.error.code === 'ETIMEDOUT' ? `zcode timed out after ${timeoutMs / 1000}s` : `failed to launch zcode: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`zcode exited ${r.status}: ${String(r.stderr || r.stdout || '').slice(0, 400)}`);
  }
  return String(r.stdout || '').trim();
}

// Fresh-session send: run the message in a brand-new session and return its id
// plus the reply. The new session shows up in the desktop app's task list on its
// own (the list tracks the DB even though open conversations do not refresh), and
// opening it loads the full transcript — so agent traffic becomes visible in the
// desktop without injecting into (or staling out) any conversation the user has open.
function sendFresh(message, { cwd = process.cwd(), timeoutMs = 600e3, noWait = false } = {}) {
  const cli = resolveZcodeCli();
  if (!cli) throw new Error('zcode CLI (zcode.cjs) not found; set AGENTRELAY_ZCODE_CLI to its full path');
  if (!fs.existsSync(zcodeConfigPath())) {
    throw new Error(`headless zcode needs a model provider config at ${zcodeConfigPath()}`);
  }
  if (noWait) {
    const log = spawnDetached([cli, '--cwd', cwd, '--prompt', message], cwd);
    // give the child a moment to persist the new session so we can report its id
    const since = Date.now() - 5000;
    for (let i = 0; i < 8; i++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
      try {
        const db = openDb();
        if (db) {
          const row = db.prepare('SELECT id, time_created FROM session ORDER BY time_created DESC LIMIT 1').get();
          db.close();
          if (row && row.time_created >= since) return { id: row.id, reply: `(no-wait) turn running in background; log: ${log}` };
        }
      } catch { /* keep polling */ }
    }
    return { id: null, reply: `(no-wait) turn running in background; log: ${log}` };
  }
  const r = run(process.execPath, [cli, '--cwd', cwd, '--prompt', message], { timeoutMs });
  if (r.error) throw new Error(r.error.code === 'ETIMEDOUT' ? `zcode timed out after ${timeoutMs / 1000}s` : `failed to launch zcode: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`zcode exited ${r.status}: ${String(r.stderr || r.stdout || '').slice(0, 400)}`);
  }
  const reply = String(r.stdout || '').trim();
  // the created session = newest session whose workspace matches cwd (path separators differ between sources)
  const norm = (s) => String(s || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  let id = null;
  try {
    const db = openDb();
    if (db) {
      const rows = db.prepare('SELECT id, directory, path FROM session ORDER BY time_created DESC LIMIT 20').all();
      for (const row of rows) {
        if (norm(row.directory) === norm(cwd) || norm(row.path) === norm(cwd)) { id = row.id; break; }
      }
      db.close();
    }
  } catch { /* id stays null */ }
  return { id, reply };
}

// Desktop mode: deliver through the real ZCode desktop UI. Preferred transport is
// CDP (renderer-level trusted input; no focus steal, live UI, native chain) when
// the app was started with --remote-debugging-port=9222; falls back to UIA
// (lib/desktop-send.ps1, focus-stealing) only when no debugger endpoint answers
// at all. The turn runs inside the desktop app, so nothing can go stale. Returns
// no reply text (async in-app).
//
// Both transports press Enter in a window somebody may be typing into, so this is
// the legacy route around the strict sender and carries the same two gates: an
// explicit consent signal, and the identity probe that refuses to hand text to
// whatever happens to own the port. An endpoint that answers but is not ZCode is
// a hard refusal - it must never degrade into the UIA fallback.
//
// This transport has no draft mode: every one of its branches submits. Asking it
// for a draft is refused rather than quietly turned into a submit.
function sendDesktop(id, message, {
  timeoutMs = 60e3, consent = false, mode = 'submit', cdpPort = 9222, platform = process.platform, spawn = require('child_process').spawnSync,
} = {}) {
  if (platform !== 'win32') throw new Error('desktop mode is Windows-only (it drives the ZCode desktop UI)');
  const desktop = require('../desktop-delivery');
  if (mode !== 'submit') {
    throw Object.assign(new Error(`The legacy desktop transport can only submit; deliver mode "draft" through the strict sender (desktopStrict:true) which leaves the text in the composer unsent.`), { code: 'INVALID_MODE', uncertain: false });
  }
  const gate = desktop.consentFailure(consent === true);
  if (gate) throw gate;
  const sess = get(id);
  if (!sess) throw new Error(`zcode session not found: ${id}`);
  let uiOnly = false;
  try {
    desktop.verifyCdpEndpointSync(cdpPort, { spawn, timeoutMs: Math.min(8000, timeoutMs) });
  } catch (error) {
    // Nothing is listening as CDP, so the UIA branch cannot be talking to a rogue
    // debugger endpoint - it drives the on-screen window instead. Anything else
    // (an impersonator, a probe that could not run) is a refusal, never a retry.
    if (error.code !== 'DESKTOP_UNAVAILABLE') throw error;
    uiOnly = true;
  }
  if (uiOnly) return sendDesktopUia(sess, message, { timeoutMs, spawn });
  const cdp = path.join(__dirname, '..', '..', 'tools', 'cdp-send.js');
  const title = (sess.title || '').trim().slice(0, 24);
  let lastOut = ''; let lastErr = ''; let status = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = spawn(process.execPath, [cdp, title, message, String(cdpPort)], { timeout: timeoutMs, encoding: 'utf8', windowsHide: true });
    lastOut = String(r.stdout || '').trim();
    lastErr = String(r.stderr || '').trim();
    status = r.status ?? 1;
    if (r.error) { lastErr = `launch issue: ${r.error.code || r.error.message}`; }
    if (status === 0 && /OK sent/.test(lastOut)) return lastOut;
    if (/CDP port/.test(lastOut + ' ' + lastErr)) break;
    lastOut = (lastOut + ' ' + lastErr).trim();
  }
  if (/CDP port/.test(lastOut)) return sendDesktopUia(sess, message, { timeoutMs, spawn });
  throw new Error((lastOut || 'no output') + ` (exit ${status})`);
}

// UIA fallback: focus-stealing text entry into the window whose title matches.
// Reachable only from sendDesktop, which has already required consent. The argv
// lives in lib/desktop-delivery.js so the desktop has one UIA sender, not two.
function sendDesktopUia(sess, message, { timeoutMs = 60e3, spawn = require('child_process').spawnSync } = {}) {
  return require('../desktop-delivery').uiSend(sess, message, { timeoutMs, spawn });
}

module.exports = { name: 'zcode', available, list, get, messages, send, sendDesktop, sendFresh, logDir, logsAcl, spawnDetached };
