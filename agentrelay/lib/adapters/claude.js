'use strict';
const path = require('path');
const { homedir } = require('os');
const fs = require('fs');
const { run } = require('../util');

const ROOT = () => path.join(homedir(), '.claude', 'projects');

function available() {
  return fs.existsSync(ROOT());
}

function readHeadLines(file, maxLines = 250) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(256 * 1024);
  try {
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.slice(0, n).toString('utf8').split(/\r?\n/).slice(0, maxLines);
  } finally { fs.closeSync(fd); }
}

function contentText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
  return '';
}

function isNoise(text) {
  return /^\s*<(command-name|local-command|environment_context|permissions|user_instructions)/.test(text);
}

// Scan a session file's head for id / cwd / a usable title.
function scanMeta(file) {
  const id = path.basename(file, '.jsonl');
  let cwd = '', title = '';
  try {
    for (const line of readHeadLines(file)) {
      if (!line) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      if (!cwd && d.cwd) cwd = d.cwd;
      if (!title && d.type === 'user' && !d.isSidechain) {
        const t = contentText(d.message && d.message.content).trim();
        if (t && !isNoise(t)) title = t;
      }
      if (cwd && title) break;
    }
  } catch { /* unreadable file: keep defaults */ }
  return { id, cwd, title: title || '(no user message)' };
}

function sessionFiles() {
  const out = [];
  let projects = [];
  try { projects = fs.readdirSync(ROOT(), { withFileTypes: true }); } catch { return out; }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    let files = [];
    try { files = fs.readdirSync(path.join(ROOT(), p.name)); } catch { continue; }
    for (const f of files) {
      if (f.endsWith('.jsonl')) out.push(path.join(ROOT(), p.name, f));
    }
  }
  return out;
}

function list(limit = 30) {
  const rows = [];
  for (const f of sessionFiles()) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (st.size === 0) continue;
    const meta = scanMeta(f);
    rows.push({ agent: 'claude', id: meta.id, title: meta.title, workspace: meta.cwd, mtime: st.mtimeMs, file: f });
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows.slice(0, limit);
}

function findFile(id) {
  return sessionFiles().find((f) => path.basename(f, '.jsonl') === id) || null;
}

function messages(id, limit = 10) {
  const file = findFile(id);
  if (!file) return null;
  const turns = [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if ((d.type === 'user' || d.type === 'assistant') && !d.isSidechain && d.message) {
      const t = contentText(d.message.content).trim();
      if (t) turns.push({ role: d.message.role || d.type, text: t });
    }
  }
  return turns.slice(-limit);
}

function send(id, message, { timeoutMs = 600e3 } = {}) {
  const file = findFile(id);
  if (!file) throw new Error(`claude session not found: ${id}`);
  const meta = scanMeta(file);
  const cwd = meta.cwd && fs.existsSync(meta.cwd) ? meta.cwd : process.cwd();
  // Prompt goes over stdin ("cat x | claude -p") so no shell quoting is involved.
  const r = run('claude', ['--resume', id, '-p', '--output-format', 'text'], { cwd, timeoutMs, input: message });
  if (r.error) throw new Error(r.error.code === 'ETIMEDOUT' ? `claude timed out after ${timeoutMs / 1000}s` : `failed to launch claude CLI: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`claude exited ${r.status}: ${String(r.stderr || r.stdout || '').slice(0, 400)}`);
  }
  return String(r.stdout || '').trim();
}

module.exports = { name: 'claude', available, list, messages, send };
