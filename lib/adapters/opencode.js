'use strict';
const path = require('path');
const { homedir } = require('os');
const fs = require('fs');
const { run } = require('../util');

const DB_PATH = () => path.join(homedir(), '.local', 'share', 'opencode', 'opencode.db');

function openDb() {
  if (!fs.existsSync(DB_PATH())) return null;
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
      SELECT id, title, directory, time_updated
      FROM session
      WHERE parent_id IS NULL
      ORDER BY COALESCE(time_updated, time_created) DESC
      ${limit && limit > 0 ? 'LIMIT ' + Number.parseInt(limit, 10) : ''}
    `).all();
    return rows.map((r) => ({
      agent: 'opencode',
      id: r.id,
      title: r.title || '(untitled)',
      workspace: r.directory || '',
      mtime: r.time_updated || 0,
    }));
  } finally { db.close(); }
}

function get(id) {
  const db = openDb();
  if (!db) return null;
  try {
    return db.prepare('SELECT id, title, directory FROM session WHERE id = ?').get(id) || null;
  } finally { db.close(); }
}

function messages(id, limit = 10) {
  const db = openDb();
  if (!db) return null;
  try {
    const rows = db.prepare(`
      SELECT m.data AS md, p.data AS pd
      FROM message m
      JOIN part p ON p.message_id = m.id
      WHERE m.session_id = ?
      ORDER BY p.time_created ASC
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

// Headless resume: `opencode run -s <id>`; the message goes over stdin (piped
// file redirect) so arbitrary text is safe. Fire-and-forget supported the same
// way (detached, output to a log).
// Resolve the real opencode executable. Prefer the direct exe (spawned without
// a shell, so unicode argv/stdin is safe), then parse the npm cmd/sh shims,
// then fall back to a PATH lookup.
function resolveExe() {
  const exeName = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  const direct = process.platform === 'win32'
    ? [path.join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe')]
    : [path.join(homedir(), '.local', 'bin', exeName)];
  for (const c of direct) {
    try { if (fs.existsSync(c)) return c; } catch { /* try next */ }
  }
  const npmDir = path.join(homedir(), 'AppData', 'Roaming', 'npm');
  for (const shim of [path.join(npmDir, 'opencode.cmd'), path.join(npmDir, 'opencode')]) {
    try {
      const txt = fs.readFileSync(shim, 'utf8');
      const m = txt.match(/"([^"]+opencode[^"]*\.exe)"/i) || txt.match(/(?:^|\s)(\S*opencode\.exe)/i);
      if (m) {
        // expand cmd-shim vars like %dp0% (dirname of the shim)
        const exePath = m[1].replace(/%dp0%/ig, path.dirname(shim));
        if (fs.existsSync(exePath)) return exePath;
      }
    } catch { /* try next */ }
  }
  return 'opencode'; // last resort: PATH lookup (shell required by caller)
}

// ---- shared long-lived server delivery -------------------------------------
// `opencode run` boots its own throwaway instance, so a TUI already open on the
// session never refreshes (both instances only share the SQLite file). opencode's
// own fix for that is a persistent `opencode serve` + TUI `attach`: the server is
// the single event source and pushes every turn over SSE to attached TUIs. We
// deliver through that server when one is up (live TUI), else fall back to run.
// serve is project-scoped (it lists only the cwd project's sessions), so each
// project gets a deterministic port derived from its directory - both this
// adapter and `agentrelay oc-serve` derive it the same way, no registry needed.
function normDir(d) {
  return String(d || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function serverPortFor(dir) {
  let h = 5381;
  for (const ch of normDir(dir)) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return 44000 + (h % 997);
}

async function probeServer(base, sessionId, timeoutMs = 1500) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(base + '/session', { signal: ac.signal });
    if (!r.ok) return null;
    const list = await r.json();
    if (!Array.isArray(list)) return null;
    // the port may belong to a different project (hash collision): only accept
    // a server that actually knows the target session
    if (sessionId && !list.some((s) => s && s.id === sessionId)) return null;
    return base;
  } catch { return null; } finally { clearTimeout(t); }
}

async function findServer(dir, sessionId) {
  const bases = [];
  if (process.env.AGENTRELAY_OPENCODE_URL) bases.push(process.env.AGENTRELAY_OPENCODE_URL.replace(/\/+$/, ''));
  bases.push(`http://127.0.0.1:${serverPortFor(dir)}`);
  for (const b of bases) {
    const ok = await probeServer(b, sessionId);
    if (ok) return ok;
  }
  return null;
}

function replyFromMessage(body) {
  try {
    const j = typeof body === 'string' ? JSON.parse(body) : body;
    if (j && Array.isArray(j.parts)) {
      return j.parts.filter((p) => p && p.type === 'text' && p.text).map((p) => p.text).join('\n').trim();
    }
  } catch { /* fall through */ }
  return '';
}

// Blocking delivery through the shared server: the turn runs server-side, the
// response resolves with the finished assistant message, and every TUI attached
// to the server has been streaming the turn live the whole time. The POST is
// non-streaming, so the final reply is emitted through onData in one chunk
// (the CLI prints opencode replies from onData, not from the return value).
async function serverDeliver(base, id, message, timeoutMs = 600e3, onData) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/session/${encodeURIComponent(id)}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text: message }] }),
      signal: ac.signal,
    });
    if (!r.ok) throw new Error(`opencode server ${base} replied ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const reply = replyFromMessage(await r.text());
    const out = reply || `(delivered via ${base}; empty reply)`;
    if (onData && out) { try { onData('stdout', out + String.fromCharCode(10)); } catch { /* caller-side */ } }
    return out;
  } finally { clearTimeout(t); }
}

// Fire-and-forget through the shared server. The POST must outlive this process
// (an aborted connection could cancel the turn), so a tiny detached node helper
// performs it; the message travels via a temp file (unicode-safe, like run).
function serverSendBackground(id, message, base) {
  const d = path.join(homedir(), '.agentrelay', 'logs');
  fs.mkdirSync(d, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const msgFile = path.join(d, `opencode-msg-${stamp}.txt`);
  fs.writeFileSync(msgFile, message, 'utf8');
  const log = path.join(d, `opencode-server-${stamp}.log`);
  const helper = `
    const fs = require('fs');
    // under node -e, argv = [node, ...userArgs] (the code itself takes no slot)
    const [base, id, msgFile, logFile] = process.argv.slice(1);
    fetch(base + '/session/' + encodeURIComponent(id) + '/message', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text: fs.readFileSync(msgFile, 'utf8') }] }),
    }).then(async (r) => {
      const body = await r.text();
      const reply = r.ok ? (JSON.parse(body).parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('') : '';
      fs.appendFileSync(logFile, 'status=' + r.status + (reply ? ' reply: ' + reply.slice(0, 400) : ' body: ' + body.slice(0, 400)) + '\\n');
    }).catch((e) => fs.appendFileSync(logFile, 'error: ' + e.message + '\\n'));`;
  const { spawn } = require('child_process');
  const out = fs.openSync(log, 'a');
  const child = spawn(process.execPath, ['-e', helper, base, id, msgFile, log], { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  try { fs.closeSync(out); } catch { /* child owns its dup */ }
  return `OK (no-wait) delivered via opencode server ${base}; turn runs there (attached TUIs show it live); log: ${log}`;
}

// Async send with server preference: deliver through the project's shared
// server when one is up (turn is live in every attached TUI; blocking mode
// returns the reply), else fall back to the throwaway-instance `run` paths.
async function send(id, message, { timeoutMs = 600e3, noWait = false, onData } = {}) {
  if (!message || !String(message).trim()) throw new Error('opencode send needs a non-empty message');
  const sess = get(id);
  if (!sess) throw new Error(`opencode session not found: ${id}`);
  const base = await findServer(sess.directory, id);
  if (base) {
    if (noWait) return serverSendBackground(id, message, base);
    return serverDeliver(base, id, message, timeoutMs, onData);
  }
  if (noWait) return sendBackground(id, message);
  return sendStream(id, message, { timeoutMs, onData });
}

function stripAnsi(s) {
  return String(s || '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '');
}

function sessionCwd(sess) {
  return (sess.directory && fs.existsSync(sess.directory)) ? sess.directory : process.cwd();
}

// Blocking direct steer: `opencode run -s <id>` with the message over stdin.
// The message becomes a real user turn in THIS session - even mid-turn, the
// live session is steered, never forked (no --fork, ever: a fork would divert
// the turn into a copy and the live session would never see it).
// Child stdout (assistant text) and stderr (header/tool progress) stream live
// through onData(stream, chunk) while the full reply is captured and resolved.
function sendStream(id, message, { timeoutMs = 600e3, onData } = {}) {
  const sess = get(id);
  if (!sess) throw new Error(`opencode session not found: ${id}`);
  const exe = resolveExe();
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const child = spawn(exe, ['run', '-s', id], { cwd: sessionCwd(sess), windowsHide: true });
    let out = '', err = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch { /* already gone */ }
      reject(new Error(`opencode timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    const fail = (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } };
    child.stdout.on('data', (d) => {
      out += d;
      if (onData) { try { onData('stdout', String(d)); } catch { /* caller-side */ } }
    });
    child.stderr.on('data', (d) => {
      err += d;
      if (onData) { try { onData('stderr', String(d)); } catch { /* caller-side */ } }
    });
    child.stdin.on('error', () => { /* EPIPE when the child exits early; close carries the real error */ });
    child.on('error', (e) => fail(new Error(`failed to launch opencode: ${e.message}`)));
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) {
        fail(new Error(`opencode exited ${code}: ${stripAnsi(err || out).slice(-400).trim()}`));
        return;
      }
      resolve(stripAnsi(out).trim());
    });
    // Message over stdin (piped, never argv/shell): arbitrary quotes,
    // newlines and unicode are safe, and the turn is stored verbatim.
    try {
      child.stdin.write(message);
      child.stdin.end();
    } catch (e) { fail(new Error(`failed to write to opencode stdin: ${e.message}`)); }
  });
}

// Fire-and-forget steer: same direct-to-session delivery, detached. stdin
// comes from a temp message file so no shell (and no argv quoting) is needed.
function sendBackground(id, message) {
  const sess = get(id);
  if (!sess) throw new Error(`opencode session not found: ${id}`);
  const exe = resolveExe();
  const { spawn } = require('child_process');
  const d = path.join(homedir(), '.agentrelay', 'logs');
  fs.mkdirSync(d, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const msgFile = path.join(d, `opencode-msg-${stamp}.txt`);
  fs.writeFileSync(msgFile, message, 'utf8');
  const log = path.join(d, `opencode-${stamp}.log`);
  const out = fs.openSync(log, 'a');
  const infd = fs.openSync(msgFile, 'r');
  const child = spawn(exe, ['run', '-s', id], { cwd: sessionCwd(sess), detached: true, stdio: [infd, out, out] });
  child.unref();
  try { fs.closeSync(out); } catch { /* child owns its dup */ }
  try { fs.closeSync(infd); } catch { /* child owns its dup */ }
  return `OK (no-wait) steering ${id} in background; reply lands in the session transcript and ${log}`;
}

module.exports = { name: 'opencode', available, list, get, messages, send, cliPath: resolveExe, serverPortFor };
