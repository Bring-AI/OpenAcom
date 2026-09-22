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

// Codex's thread-writer lock is an empty file with no PID inside, so mtime can
// only say when something last wrote - never whether the holder is still alive.
// That makes a crash leave a lock that refuses delivery forever. On Windows the
// process list answers the question, so the refusal is preceded by one probe.
// Which process may own the writer lock. Measured on this box 2026-09-20:
//   codex.exe                        CLI / app-server - the writer, counts
//   codex-computer-use-swift.exe     a second child of the running app; not the writer
//   codex-windows-sandbox-service    an installed Windows service (parent is the
//                                    service host, started ~3.5h before the app),
//                                    so treating it as a holder would mean a live
//                                    process forever and an orphan verdict that can
//                                    never fire - the crash case would stay closed.
// Getting this wrong towards "orphan" is the cheap direction: neither verdict
// injects anything, so a mis-read process list changes the wording of a refusal
// rather than writing a turn into a session somebody is typing into.
const HOLDER_IMAGE = /^codex\.exe$/i;
const FAMILY_IMAGE = /^codex/i;
function probeCodexHolder({ platform = process.platform, spawn = require('child_process').spawnSync } = {}) {
  // Lock semantics differ off Windows and nothing here has measured them, so the
  // probe abstains and the caller keeps refusing - the pre-existing behaviour.
  if (platform !== 'win32') return { state: 'unknown', detail: `the holder probe is only implemented for Windows, not ${platform}` };
  // One unfiltered listing in CSV (locale-stable field order, ASCII image names).
  // An IMAGENAME filter would have to name the binary exactly, which is what the
  // lines above are for instead: the names are stated, not assumed.
  const result = (() => {
    try {
      return spawn('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 10e3, shell: false });
    } catch (error) {
      // A probe that could not start has to answer "unknown", never "orphan".
      return { error };
    }
  })();
  if (result && result.error) {
    return { state: 'unknown', detail: `tasklist could not run: ${result.error.code || result.error.message}` };
  }
  if (!result || result.status !== 0) {
    return { state: 'unknown', detail: `tasklist exited ${result ? result.status : 'without a status'}: ${String((result && result.stderr) || '').replace(/\s+/g, ' ').trim().slice(0, 160)}` };
  }
  // Anything that is not a quoted CSV row is tasklist's own prose, which must not
  // read as a process list.
  const rows = String(result.stdout || '').split(/\r?\n/)
    .map((line) => line.trim()).filter((line) => line.startsWith('"'))
    .map((line) => {
      const cells = line.split('","').map((cell) => cell.replace(/^"|"$/g, ''));
      return { name: cells[0] || '', pid: cells[1] || '' };
    }).filter((row) => FAMILY_IMAGE.test(row.name));
  const holders = rows.filter((row) => HOLDER_IMAGE.test(row.name));
  const listed = rows.map((row) => `${row.name} pid ${row.pid || '?'}`).join(', ');
  if (holders.length) {
    return {
      state: 'alive',
      detail: holders.map((row) => `${row.name} pid ${row.pid || '?'}`).join(', ') + (rows.length > holders.length ? ` (also running, not a writer candidate: ${rows.filter((row) => !holders.includes(row)).map((row) => row.name).join(', ')})` : ''),
      processes: holders,
      family: rows,
    };
  }
  return {
    state: 'orphan',
    detail: rows.length ? `no codex.exe running; other Codex processes are not writer candidates: ${listed}` : 'no Codex process of any name is running',
    processes: [],
    family: rows,
  };
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

const LOCKED = /already has an active writer|thread-store conflict/;
const ORPHAN_NOTE = 'lock holder not running';

function resume(id, message, { cwd, timeoutMs, runImpl = run }) {
  // "-" makes codex read the instructions from stdin.
  return runImpl('codex', ['exec', 'resume', id, '--skip-git-repo-check', '-'], { cwd, timeoutMs, input: message });
}

function lockAge(lock) {
  try {
    const mins = Math.round((Date.now() - fs.statSync(lock).mtimeMs) / 60000);
    return ` (lock last touched ${mins}m ago)`;
  } catch { return ''; /* the lock path may differ from this guess */ }
}

function send(id, message, { timeoutMs = 600e3, holderProbe = probeCodexHolder, platform = process.platform, runImpl = run } = {}) {
  const file = findFile(id);
  if (!file) throw new Error(`codex session not found: ${id}`);
  const meta = scanMeta(file);
  const cwd = meta.cwd && fs.existsSync(meta.cwd) ? meta.cwd : process.cwd();
  const r = resume(id, message, { cwd, timeoutMs, runImpl });
  if (r.error) throw new Error(r.error.code === 'ETIMEDOUT' ? `codex timed out after ${timeoutMs / 1000}s` : `failed to launch codex CLI: ${r.error.message}`);
  if (r.status !== 0) {
    const tail = String(r.stderr || r.stdout || '');
    // Codex enforces a single writer per thread: a session open in a live TUI
    // (or a stuck codex.exe) owns the lock and headless resume is refused.
    if (LOCKED.test(tail)) {
      const lock = path.join(homedir(), '.codex', 'thread-writer-locks', `${id}.lock`);
      const age = lockAge(lock);
      const holder = holderProbe({ platform });
      if (holder.state !== 'orphan') {
        // A live holder keeps the old refusal; an abstained or failed probe is
        // treated as one, because guessing "nobody owns this" is how a turn gets
        // injected into a conversation somebody is typing into.
        throw new Error(
          `codex session ${id} is open in another Codex instance - it holds the single-writer lock, so headless injection is refused.${age} ` +
          `Holder probe: ${holder.state === 'alive' ? holder.detail : `could not answer (${holder.detail})`}, so the lock is treated as live. ` +
          `Options: deliver your text in that TUI directly, close that conversation and retry, or kill its codex.exe if it is stuck. ` +
          `read_session still works on a locked session.`
        );
      }
      // Provably no Codex process is running, so this is the crash case: the lock
      // carries no PID and no liveness, and a plain refusal would have no exit.
      // Say that out loud and explain how to confirm and clear it - but do NOT
      // inject anyway. Nobody else has decided that a stale lock may be walked
      // past, and this adapter does not delete another tool's state either.
      throw Object.assign(new Error(
        `codex session ${id} is refused by a single-writer lock that no running Codex process can hold - ${ORPHAN_NOTE.replace('; proceeding', '')}.${age} ` +
        `Confirm it: the lock is an empty file with no PID (${lock}), so nothing in it says who died; check the process list shows no codex.exe and that no Codex window or app-server for this thread is open. ` +
        `Clear it: restart the Codex app and let it close the thread, or delete that lock file yourself once you have confirmed nothing is writing, then re-run this send. ` +
        `OpenAcom will not delete it or inject past it for you. ` +
        `read_session still works on a locked session.`
      ), { orphanLock: true, holder: holder.detail, uncertain: false });
    }
    throw new Error(`codex exited ${r.status}: ${tail.slice(0, 400)}`);
  }
  return String(r.stdout || '').trim();
}

module.exports = { name: 'codex', available, list, messages, send, probeCodexHolder };
