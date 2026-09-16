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

// Only <uuid>.jsonl files are sessions; agent-*.jsonl are subagent (sidechain)
// transcripts that must not be listed or addressed as sessions.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sessionFiles() {
  const out = [];
  let projects = [];
  try { projects = fs.readdirSync(ROOT(), { withFileTypes: true }); } catch { return out; }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    // ssh-<uuid> project dirs are remote (SSH) workspaces; everything else is local
    const remote = p.name.startsWith('ssh-');
    let files = [];
    try { files = fs.readdirSync(path.join(ROOT(), p.name)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      if (!UUID_RE.test(path.basename(f, '.jsonl'))) continue;
      out.push({ id: path.basename(f, '.jsonl'), file: path.join(ROOT(), p.name, f), project: p.name, remote });
    }
  }
  return out;
}

function list(limit = 0) {
  const rows = [];
  for (const e of sessionFiles()) {
    let st; try { st = fs.statSync(e.file); } catch { continue; }
    if (st.size === 0) continue;
    const meta = scanMeta(e.file);
    rows.push({
      agent: 'claude', id: meta.id, title: meta.title,
      workspace: e.remote ? `ssh:${meta.cwd || e.project}` : meta.cwd,
      remote: e.remote, mtime: st.mtimeMs, file: e.file,
    });
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return limit && limit > 0 ? rows.slice(0, limit) : rows;
}

function findFile(id) {
  return sessionFiles().find((e) => path.basename(e.file, '.jsonl') === id) || null;
}

function messages(id, limit = 10) {
  const entry = findFile(id);
  if (!entry) return null;
  const turns = [];
  const lines = fs.readFileSync(entry.file, 'utf8').split(/\r?\n/);
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

// --- remote (SSH) sessions -----------------------------------------------------
// Remote sessions run as `ccd-cli --resume=<id> --input-format stream-json` on the
// SSH host. The local transcript is a mirror. Sending = locate the live runner via
// its --resume=<id> flag and write one stream-json user turn into its stdin through
// /proc/<pid>/fd/0 (root on the host). The turn runs inside the live process, so the
// reply streams back to the desktop app live and the chain stays native.

const CLAUDE_JSON = () => path.join(homedir(), '.claude.json');

function resolveSshHost(cwd) {
  try {
    const d = JSON.parse(fs.readFileSync(CLAUDE_JSON(), 'utf8'));
    for (const key of Object.keys(d.projects || {})) {
      if (key.startsWith('ssh:') && key.endsWith(':' + cwd)) {
        return key.slice('ssh:'.length, key.length - cwd.length - 1);
      }
    }
  } catch { /* no config */ }
  return null;
}

function sendRemote(entry, message, { timeoutMs = 600e3 } = {}) {
  const meta = scanMeta(entry.file);
  const host = resolveSshHost(meta.cwd);
  if (!host) {
    throw new Error(`no ssh host mapping for cwd "${meta.cwd}" in ~/.claude.json (expected a projects key "ssh:<host>:<cwd>")`);
  }
  const sshOpts = ['-o', 'BatchMode=yes'];
  const find = run('ssh', [...sshOpts, host,
    `ps aux | grep -- "--resume=${entry.id}" | grep -v grep | awk '{print $2}' | head -1`], { timeoutMs: 30e3 });
  const pid = String(find.stdout || '').trim();
  if (!pid) {
    throw new Error(`remote session ${id0(entry.id)} is not currently running on ${host} — start it once from the desktop app, then send again`);
  }
  const payload = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: message }] },
  }) + '\n';
  const w = run('ssh', [...sshOpts, host, 'cat > /proc/' + pid + '/fd/0'], { timeoutMs: 30e3, input: payload });
  if (w.status !== 0) {
    throw new Error(`inject into remote stdin failed: ${String(w.stderr || w.stdout || '').slice(0, 200)}`);
  }
  return `OK injected into live remote session (pid ${pid} @ ${host}); the reply streams to the desktop app - read with: agentrelay read ${entry.id} --agent claude`;
}

function id0(s) { return String(s || '').slice(0, 12); }

function send(id, message, { timeoutMs = 600e3, noWait = false } = {}) {
  const entry = findFile(id);
  if (!entry) throw new Error(`claude session not found: ${id}`);
  if (entry.remote) {
    // injection into the live process is already fire-and-forget
    return sendRemote(entry, message, { timeoutMs });
  }
  const file = entry.file;
  const meta = scanMeta(file);
  const cwd = meta.cwd && fs.existsSync(meta.cwd) ? meta.cwd : process.cwd();
  if (noWait) {
    const { spawn } = require('child_process');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const d = path.join(homedir(), '.agentrelay', 'logs');
    fs.mkdirSync(d, { recursive: true });
    const log = path.join(d, `claude-${stamp}.log`);
    const tmp = path.join(homedir(), '.agentrelay', 'logs', `msg-${stamp}.txt`);
    fs.writeFileSync(tmp, message, 'utf8');
    const out = fs.openSync(log, 'a');
    let child;
    if (process.platform === 'win32') {
      child = spawn('cmd.exe', ['/c', `claude --resume ${id} -p --output-format text < "${tmp}"`],
        { cwd, detached: true, stdio: ['ignore', out, out] });
    } else {
      child = spawn('/bin/sh', ['-c', `claude --resume '${id}' -p --output-format text < '${tmp}'`],
        { cwd, detached: true, stdio: ['ignore', out, out] });
    }
    child.unref();
    try { fs.closeSync(out); } catch { /* child owns its dup */ }
    return `OK (no-wait) turn running in background on ${id}; reply lands in the session transcript and ${log}`;
  }
  // Prompt goes over stdin ("cat x | claude -p") so no shell quoting is involved.
  const r = run('claude', ['--resume', id, '-p', '--output-format', 'text'], { cwd, timeoutMs, input: message });
  if (r.error) throw new Error(r.error.code === 'ETIMEDOUT' ? `claude timed out after ${timeoutMs / 1000}s` : `failed to launch claude CLI: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`claude exited ${r.status}: ${String(r.stderr || r.stdout || '').slice(0, 400)}`);
  }
  return String(r.stdout || '').trim();
}

module.exports = { name: 'claude', available, list, messages, send };
