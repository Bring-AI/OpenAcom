'use strict';
const path = require('path');
const { homedir } = require('os');
const fs = require('fs');
const { run, resolveZcodeCli, zcodeConfigPath } = require('../util');

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

function logDir() {
  const d = path.join(homedir(), '.agentrelay', 'logs');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Start a headless zcode turn that outlives this process; output lands in a log file.
function spawnDetached(cliArgs, cwd) {
  const { spawn } = require('child_process');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const log = path.join(logDir(), `zcode-${stamp}.log`);
  const out = fs.openSync(log, 'a');
  const child = spawn(process.execPath, cliArgs, { cwd, detached: true, stdio: ['ignore', out, out] });
  child.unref();
  try { fs.closeSync(out); } catch { /* child owns its dup */ }
  return log;
}

function cdpReachable() {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, ['-e',
    'fetch("http://127.0.0.1:9222/json/version").then(()=>process.exit(0)).catch(()=>process.exit(1))'],
    { timeout: 4000, windowsHide: true });
  return r.status === 0;
}

// desktop option (default): deliver through the desktop UI via CDP - live
// refresh, native chain, steer - at the cost of the app switching to that
// conversation. false (--no-desktop) = silent headless, no view switch.
// true = force UI (surface errors); undefined = auto: CDP when reachable,
// headless fallback.
function send(id, message, { timeoutMs = 600e3, noWait = false, desktop, desktopStrict = false, cdpPort, cdpTargetId } = {}) {
  const sess = get(id);
  if (desktopStrict) {
    if (desktop !== true) throw Object.assign(new Error('Strict desktop delivery requires desktop:true'), { code: 'INVALID_MODE', uncertain: false });
    return require('../desktop-delivery').sendDesktopStrict(sess, message, { timeoutMs, cdpPort, cdpTargetId });
  }
  if (!sess) throw new Error(`zcode session not found: ${id}`);
  let fellBack = false;
  if (desktop === undefined && !cdpReachable()) fellBack = true; // port down: silent-fallback case
  if (desktop === true || (desktop === undefined && cdpReachable())) {
    try {
      return sendDesktop(id, message, { timeoutMs: Math.min(timeoutMs, 60e3) });
    } catch (e) {
      if (desktop === true) throw e;
      fellBack = true; // auto: fall through to headless
    }
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
    const tag = fellBack ? ' [delivery: headless fallback - CDP unavailable, model may differ from the session UI]' : '';
    return `OK (no-wait) turn running in background on ${id}; reply lands in the session transcript and ${log}${tag}`;
  }
  // spawn node.exe directly (no shell) so the message can contain any characters
  const r = run(process.execPath, cliArgs, { timeoutMs });
  if (r.error) throw new Error(r.error.code === 'ETIMEDOUT' ? `zcode timed out after ${timeoutMs / 1000}s` : `failed to launch zcode: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`zcode exited ${r.status}: ${String(r.stderr || r.stdout || '').slice(0, 400)}`);
  }
  const reply = String(r.stdout || '').trim();
  if (fellBack) return reply + String.fromCharCode(10) + '[delivery: headless fallback - CDP unavailable, model may differ from the session UI]';;
  return reply;
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
// (lib/desktop-send.ps1, focus-stealing) otherwise. The turn runs inside the
// desktop app, so nothing can go stale. Returns no reply text (async in-app).
function sendDesktop(id, message, { timeoutMs = 60e3 } = {}) {
  if (process.platform !== 'win32') throw new Error('desktop mode is Windows-only (it drives the ZCode desktop UI)');
  const sess = get(id);
  if (!sess) throw new Error(`zcode session not found: ${id}`);
  const { spawnSync } = require('child_process');
  const cdp = path.join(__dirname, '..', '..', 'tools', 'cdp-send.js');
  const title = (sess.title || '').trim().slice(0, 24);
  let lastOut = ''; let lastErr = ''; let status = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = spawnSync(process.execPath, [cdp, title, message], { timeout: timeoutMs, encoding: 'utf8', windowsHide: true });
    lastOut = String(r.stdout || '').trim();
    lastErr = String(r.stderr || '').trim();
    status = r.status ?? 1;
    if (r.error) { lastErr = `launch issue: ${r.error.code || r.error.message}`; }
    if (status === 0 && /OK sent/.test(lastOut)) return lastOut;
    if (/CDP port/.test(lastOut + ' ' + lastErr)) break;
    lastOut = (lastOut + ' ' + lastErr).trim();
  }
  if (/CDP port/.test(lastOut)) {
    const ps = path.join(__dirname, '..', 'desktop-send.ps1');
    const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
    const r2 = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, '-TitleB64', b64(title), '-MessageB64', b64(message)], { timeout: timeoutMs, encoding: 'utf8', windowsHide: true });
    const out2 = String(r2.stdout || '').trim();
    if (r2.status === 0 && !out2.startsWith('ERR')) return out2;
    throw new Error(out2 || `desktop UIA send failed (exit ${r2.status})`);
  }
  throw new Error((lastOut || 'no output') + ` (exit ${status})`);
}

module.exports = { name: 'zcode', available, list, get, messages, send, sendDesktop, sendFresh };
