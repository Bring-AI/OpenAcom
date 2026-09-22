'use strict';
// Tracked sends with read receipts, plus the local async mailbox (post()). Every
// requireRead send lands in a local SQLite inbox
// (`~/.openacom/inbox.sqlite`, override base dir with
// AGENTRELAY_HOME) and carries a receipt footer: the target agent marks it
// read via the ack_message tool (or by replying containing ACK-<id>). An
// unacknowledged message is redelivered, at most 3 attempts total, then
// declared failed - the sender always gets an honest outcome.
const path = require('path');
const { homedir } = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { protectPath, aggregateAcl } = require('./secure-fs');

const DB_PATH = () => path.join(process.env.AGENTRELAY_HOME || path.join(homedir(), '.openacom'), 'inbox.sqlite');

let _db = null;
let _acl = null;

// The store keeps message text, so its directory and every SQLite sidecar are
// protected once per process - on Windows a protection spawns icacls, which
// must never run per row.
function protectStore(file, dir) {
  const results = [protectPath(dir, { directory: true })];
  for (const sidecar of [file, `${file}-wal`, `${file}-shm`]) {
    // wal/shm exist only while a writer holds them. Absent is normal, not a
    // degraded ACL, so ask before protecting rather than letting secure-fs
    // report a missing file as a failure.
    if (fs.existsSync(sidecar)) results.push(protectPath(sidecar));
  }
  return aggregateAcl(results);
}

// Aggregate marker of the last store open, or null before one. Callers that
// surface privacy to a human (web startup) read this.
function acl() { return _acl; }

function db() {
  if (_db) return _db;
  const file = DB_PATH();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { DatabaseSync } = require('node:sqlite');
  _db = new DatabaseSync(file);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      from_addr TEXT NOT NULL,
      to_addr TEXT NOT NULL,
      agent TEXT NOT NULL,
      session_id TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      read_at INTEGER
    );
  `);
  // A mailbox post is marked apart from a tracked send because it never went
  // through an adapter. Stores created before the column keep working as-is.
  const columns = _db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  if (!columns.includes('delivery')) _db.exec('ALTER TABLE messages ADD COLUMN delivery TEXT');
  for (const column of ['route_key', 'route_result']) {
    if (!columns.includes(column)) _db.exec('ALTER TABLE messages ADD COLUMN ' + column + ' TEXT');
  }
  _acl = protectStore(file, dir);
  return _db;
}

function now() { return Date.now(); }

function create({ id = randomUUID(), fromAddr, toAddr, agent, sessionId, text, maxAttempts = 3 }) {
  const t = now();
  db().prepare(`
    INSERT INTO messages (id, from_addr, to_addr, agent, session_id, text, status, attempts, max_attempts, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
  `).run(id, fromAddr, toAddr, agent, sessionId, text, maxAttempts, t, t);
  const row = get(id);
  require('./hooks').fire('message.created', { message: snapshot(row) });
  return row;
}

// Async mailbox post: a row another local MCP client picks up with the inbox
// tool and settles with the same ack_message receipt. No adapter is involved, so
// this is the reachable direction for agents that have no live injection channel
// (nothing to steer, no CLI stdin, and we never drive an IDE UI). The post is the
// delivery, hence one attempt, recorded and 'sent' at once; a stored id may be
// replayed only with an identical payload, exactly like the hub's ID_CONFLICT.
function post({ id = randomUUID(), fromAddr, toAddr, text, delivery = 'mailbox' }) {
  const existing = get(id);
  if (existing) {
    const same = existing.delivery === delivery && existing.from_addr === fromAddr
      && existing.to_addr === toAddr && existing.text === text;
    if (!same) {
      throw Object.assign(new Error(`ID_CONFLICT: message id ${id} is already associated with a different payload`), { code: 'ID_CONFLICT' });
    }
    return { row: existing, replayed: true };
  }
  const colon = String(toAddr).indexOf(':');
  const t = now();
  db().prepare(`
    INSERT INTO messages (id, from_addr, to_addr, agent, session_id, text, status, attempts, max_attempts, delivery, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'sent', 1, 1, ?, ?, ?)
  `).run(id, fromAddr, toAddr, colon > 0 ? toAddr.slice(0, colon) : toAddr, colon > 0 ? toAddr.slice(colon + 1) : '', text, delivery, t, t);
  const row = get(id);
  const hooks = require('./hooks');
  hooks.fire('message.created', { message: snapshot(row) });
  hooks.fire('message.sent', { message: snapshot(row) });
  return { row, replayed: false };
}

function get(id) {
  return db().prepare('SELECT * FROM messages WHERE id = ?').get(id) || null;
}

function list({ status, fromAddr, toAddr, limit = 30 } = {}) {
  const where = [];
  const vals = [];
  for (const [column, value] of [['status', status], ['from_addr', fromAddr], ['to_addr', toAddr]]) {
    if (value) { where.push(`${column} = ?`); vals.push(value); }
  }
  return db().prepare(`
    SELECT * FROM messages ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY updated_at DESC LIMIT ?
  `).all(...vals, limit);
}

function setFields(id, fields) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); vals.push(v); }
  sets.push('updated_at = ?'); vals.push(now());
  db().prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return get(id);
}

function snapshot(row) {
  return { id: row.id, from: row.from_addr, to: row.to_addr, agent: row.agent, sessionId: row.session_id, status: row.status, attempts: row.attempts, maxAttempts: row.max_attempts, lastError: row.last_error || undefined, textPreview: String(row.text || '').slice(0, 200) };
}

function recordAttempt(id, attempt, error) {
  const row = setFields(id, { attempts: attempt, status: 'sent', last_error: error || null });
  require('./hooks').fire('message.sent', { message: snapshot(row) });
  return row;
}

// Explicit tool ack from the target agent (or ack CLI/web).
function markRead(id, via = 'ack_message') {
  const row = get(id);
  if (!row) throw new Error(`unknown message id: ${id}`);
  if (row.status === 'read') return row;
  const updated = setFields(id, { status: 'read', read_at: now(), last_error: null });
  require('./hooks').fire('message.read', { message: snapshot(updated), via });
  return updated;
}

// Fallback ack: the target replied containing the receipt token in an
// assistant turn (user turns carry the instruction itself, so they never count).
// Adapters expose no turn timestamps, so freshness is established by comparing
// against a baseline taken before the attempt went out: a token that was
// already in the transcript (a recited footer, an earlier attempt's echo) can
// never confirm a read. A negative baseline means the transcript was unreadable
// before the send, so no transcript ack is trusted for that attempt.
const ACK_WINDOW = 8;

function countAckTurns(a, sessionId, id) {
  try {
    const turns = a.messages(sessionId, ACK_WINDOW);
    if (!turns) return 0;
    return turns.filter((t) => t && t.role === 'assistant' && String(t.text || '').includes(`ACK-${id}`)).length;
  } catch { return -1; }
}

function ackLanded(a, sessionId, id, baseline) {
  if (!(baseline >= 0)) return false;
  return countAckTurns(a, sessionId, id) > baseline;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function summary(row, extra = {}) {
  return {
    id: row.id,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    to: row.to_addr,
    readAt: row.read_at || undefined,
    lastError: row.last_error || undefined,
    ...extra,
  };
}

// Send with read-receipt tracking: deliver, wait for ack, redeliver on
// silence (up to maxAttempts total), then declare failed. sendOpts are the
// adapter send options for each attempt (noWait/desktop etc.).
async function trackedSend(a, sessionId, fromAddr, baseMessage, { ackTimeoutMs = 90e3, maxAttempts = 3, pollMs = 5000, sendOpts = {} } = {}) {
  const row = create({ fromAddr, toAddr: `${a.name}:${sessionId}`, agent: a.name, sessionId, text: baseMessage, maxAttempts });
  const id = row.id;
  const problems = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const footer = `${String.fromCharCode(10)}[read-receipt] 收到并处理后请标记已读：调用 openacom 的 ack_message 工具（id="${id}"），或在回复中包含 ACK-${id}（重发 ${attempt}/${maxAttempts}）`;
    const baseline = countAckTurns(a, sessionId, id);
    try {
      await a.send(sessionId, baseMessage + footer, sendOpts);
      recordAttempt(id, attempt);
    } catch (e) {
      problems.push(`attempt ${attempt}: delivery failed: ${e.message}`);
      setFields(id, { attempts: attempt, status: 'sent', last_error: `delivery: ${e.message}` });
      continue; // count as a burnt attempt, try again
    }
    const deadline = Date.now() + ackTimeoutMs;
    while (Date.now() < deadline) {
      if (get(id).status === 'read') return summary(get(id), { attemptsUsed: attempt, note: 'acknowledged via ack_message' });
      if (ackLanded(a, sessionId, id, baseline)) {
        markRead(id, 'transcript');
        return summary(get(id), { attemptsUsed: attempt, note: 'acknowledged via reply token' });
      }
      await sleep(pollMs);
    }
    problems.push(`attempt ${attempt}: not acknowledged within ${Math.round(ackTimeoutMs / 1000)}s`);
    setFields(id, { attempts: attempt, last_error: `no ack (attempt ${attempt})` });
  }
  const final = setFields(id, { status: 'failed', last_error: problems[problems.length - 1] });
  require('./hooks').fire('message.failed', { message: snapshot(final), problems });
  return summary(final, { attemptsUsed: maxAttempts, problems });
}

// Read-only creation cursor for desktop listeners. Page within a fixed upper bound
// so filtered bursts larger than one page do not drop messages or claim delivery.
function watchCursor() { return Number(db().prepare('SELECT COALESCE(MAX(rowid), 0) AS cursor FROM messages').get().cursor); }
function watchPage(cursor, { toAddr, limit = 100 } = {}) {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('invalid inbox cursor or page limit');
  const upper = watchCursor();
  const rows = db().prepare('SELECT rowid AS sequence, substr(id, 1, 200) AS id, substr(from_addr, 1, 2000) AS from_addr, substr(to_addr, 1, 2000) AS to_addr, status, created_at, updated_at FROM messages WHERE rowid > ? AND rowid <= ?' + (toAddr ? ' AND to_addr = ?' : '') + ' ORDER BY rowid LIMIT ?').all(cursor, upper, ...(toAddr ? [toAddr] : []), limit);
  return { rows, cursor: rows.length === limit ? Number(rows[rows.length - 1].sequence) : upper, more: rows.length === limit && rows[rows.length - 1].sequence < upper };
}

function close() { try { _db && _db.close(); _db = null; } catch { /* ignore */ } }

module.exports = { watchCursor, watchPage, DB_PATH, create, post, get, list, markRead, recordAttempt, setFields, trackedSend, summary, close, acl, protectStore, countAckTurns, ackLanded };
