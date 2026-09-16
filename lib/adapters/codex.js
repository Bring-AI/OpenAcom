'use strict';
const path = require('path');
const { homedir } = require('os');
const fs = require('fs');
const { run } = require('../util');

const ROOT = () => path.join(homedir(), '.codex', 'sessions');

function available() {
  return fs.existsSync(ROOT());
}

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function isNoise(text) {
  return /^\s*<(environment_context|permissions|user_instructions|ENVIRONMENT|recommended_plugins)/.test(text);
}

function scanMeta(file) {
  // First line is session_meta with id / cwd; scan a bit further for the first real user turn.
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(512 * 1024);
  let lines;
  try {
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    lines = buf.slice(0, n).toString('utf8').split(/\r?\n/).slice(0, 400);
  } finally { fs.closeSync(fd); }
  let id = '', cwd = '', title = '';
  for (const line of lines) {
    if (!line) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const p = d.payload || {};
    if (d.type === 'session_meta') {
      id = p.id || p.session_id || '';
      cwd = p.cwd || '';
    }
    if (!title && d.type === 'response_item' && p.type === 'message' && p.role === 'user') {
      const t = (Array.isArray(p.content) ? p.content.map((c) => c.text || '').join('\n') : String(p.content || '')).trim();
      if (t && !isNoise(t)) title = t;
    }
  }
  return { id: id || '', cwd, title: title || '(no user message)' };
}

function list(limit = 0) {
  const rows = [];
  for (const f of walk(ROOT())) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (st.size === 0) continue;
    const meta = scanMeta(f);
    rows.push({
      agent: 'codex', id: meta.id, title: meta.title, workspace: meta.cwd,
      mtime: st.mtimeMs, file: f,
    });
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return limit && limit > 0 ? rows.slice(0, limit) : rows;
}

function findFile(id) {
  return walk(ROOT()).find((f) => path.basename(f).includes(id)) || null;
}

function messages(id, limit = 10) {
  const file = findFile(id);
  if (!file) return null;
  const turns = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const p = d.payload || {};
    if (d.type === 'response_item' && p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      const t = (Array.isArray(p.content) ? p.content.map((c) => c.text || '').join('\n') : String(p.content || '')).trim();
      if (t) turns.push({ role: p.role, text: t });
    } else if (d.type === 'event_msg' && (p.type === 'user_message' || p.type === 'agent_message') && p.message) {
      turns.push({ role: p.type === 'user_message' ? 'user' : 'assistant', text: String(p.message).trim() });
    }
  }
  return turns.slice(-limit);
}

function send(id, message, { timeoutMs = 600e3 } = {}) {
  const file = findFile(id);
  if (!file) throw new Error(`codex session not found: ${id}`);
  const meta = scanMeta(file);
  const cwd = meta.cwd && fs.existsSync(meta.cwd) ? meta.cwd : process.cwd();
  // "-" makes codex read the instructions from stdin.
  const r = run('codex', ['exec', 'resume', id, '--skip-git-repo-check', '-'], { cwd, timeoutMs, input: message });
  if (r.error) throw new Error(r.error.code === 'ETIMEDOUT' ? `codex timed out after ${timeoutMs / 1000}s` : `failed to launch codex CLI: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`codex exited ${r.status}: ${String(r.stderr || r.stdout || '').slice(0, 400)}`);
  }
  return String(r.stdout || '').trim();
}

module.exports = { name: 'codex', available, list, messages, send };
