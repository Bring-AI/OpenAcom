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

function list(limit = 30) {
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
      LIMIT ?
    `).all(limit);
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

function send(id, message, { timeoutMs = 600e3 } = {}) {
  const sess = get(id);
  if (!sess) throw new Error(`zcode session not found: ${id}`);
  const cli = resolveZcodeCli();
  if (!cli) {
    throw new Error('zcode CLI (zcode.cjs) not found; set AGENTRELAY_ZCODE_CLI to its full path');
  }
  if (!fs.existsSync(zcodeConfigPath())) {
    throw new Error(`headless zcode needs a model provider config at ${zcodeConfigPath()} (key "provider" + "model"); the desktop app keeps its own copy under ~/.zcode/v2/config.json`);
  }
  // spawn node.exe directly (no shell) so the message can contain any characters
  const r = run(process.execPath, [cli, '--resume', id, '--cwd', sess.directory || sess.path || process.cwd(), '--prompt', message], { timeoutMs });
  if (r.error) throw new Error(r.error.code === 'ETIMEDOUT' ? `zcode timed out after ${timeoutMs / 1000}s` : `failed to launch zcode: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`zcode exited ${r.status}: ${String(r.stderr || r.stdout || '').slice(0, 400)}`);
  }
  return String(r.stdout || '').trim();
}

// Desktop mode: drive the real ZCode desktop UI (Windows). The message is typed
// into the app's own composer, so the turn runs inside the desktop app — its
// window live-updates and the message chain stays native. Trade-offs: needs the
// desktop app running, steals window focus for a moment, matches by title, and
// returns no reply text (the turn runs asynchronously in the app).
function sendDesktop(id, message, { timeoutMs = 120e3 } = {}) {
  if (process.platform !== 'win32') throw new Error('desktop mode is Windows-only (it drives the ZCode desktop UI)');
  const sess = get(id);
  if (!sess) throw new Error(`zcode session not found: ${id}`);
  const script = path.join(__dirname, '..', 'desktop-send.ps1');
  const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-TitleB64', b64(sess.title || ''), '-MessageB64', b64(message)];
  const r = run('powershell', args, { timeoutMs });
  if (r.error) throw new Error(r.error.code === 'ETIMEDOUT' ? `desktop send timed out after ${timeoutMs / 1000}s` : `failed to launch powershell: ${r.error.message}`);
  const out = String(r.stdout || '').trim();
  if (r.status !== 0 || out.startsWith('ERR')) throw new Error(out || `desktop send failed (exit ${r.status})`);
  return out;
}

module.exports = { name: 'zcode', available, list, get, messages, send, sendDesktop };
