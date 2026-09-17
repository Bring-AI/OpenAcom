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
// Resolve the real opencode executable from the npm cmd shim (avoids cmd.exe
// quoting entirely - we spawn the exe directly with unicode argv).
function resolveExe() {
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

function send(id, message, { timeoutMs = 600e3, noWait = false } = {}) {
  const sess = get(id);
  if (!sess) throw new Error(`opencode session not found: ${id}`);
  const exe = resolveExe();
  const d = path.join(homedir(), '.agentrelay', 'logs');
  fs.mkdirSync(d, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const { spawnSync, spawn } = require('child_process');
  if (noWait) {
    const log = path.join(d, `opencode-${stamp}.log`);
    const out = fs.openSync(log, 'a');
    const child = spawn(exe, ['run', '-s', id, message], { cwd: sess.directory || process.cwd(), detached: true, stdio: ['ignore', out, out] });
    child.unref();
    try { fs.closeSync(out); } catch { /* child owns its dup */ }
    return `OK (no-wait) turn running in background on ${id}; reply lands in the session transcript and ${log}`;
  }
  const r = spawnSync(exe, ['run', '-s', id], { timeout: timeoutMs, encoding: 'utf8', input: message, cwd: sess.directory || process.cwd() });
  if (r.error) throw new Error(r.error.code === 'ETIMEDOUT' ? `opencode timed out after ${timeoutMs / 1000}s` : `failed to launch opencode: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`opencode exited ${r.status}: ${String(r.stderr || r.stdout || '').slice(0, 400)}`);
  }
  return String(r.stdout || '').trim();
}

module.exports = { name: 'opencode', available, list, get, messages, send };
