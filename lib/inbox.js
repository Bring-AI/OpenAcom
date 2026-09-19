'use strict';
// Tracked sends with read receipts. Every requireRead send lands in a local
// SQLite inbox (`~/.agentrelay/inbox.sqlite`, override base dir with
// AGENTRELAY_HOME) and carries a receipt footer: the target agent marks it
// read via the ack_message tool (or by replying containing ACK-<id>). An
// unacknowledged message is redelivered, at most 3 attempts total, then
// declared failed - the sender always gets an honest outcome.
const path = require('path');
const { homedir } = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');

const DB_PATH = () => path.join(process.env.AGENTRELAY_HOME || path.join(homedir(), '.agentrelay'), 'inbox.sqlite');

let _db = null;
function db() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH()), { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  _db = new DatabaseSync(DB_PATH());
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
  return _db;
}

function now() { return Date.now(); }

function create({ id = randomUUID(), fromAddr, toAddr, agent, sessionId, text, maxAttempts = 3 }) {
  const t = now();
  db().prepare(`
    INSERT INTO messages (id, from_addr, to_addr, agent, session_id, text, status, attempts, max_attempts, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
  `).run(id, fromAddr, toAddr, agent, sessionId, text, maxAttempts, t, t);
  return get(id);
}

function get(id) {
  return db().prepare('SELECT * FROM messages WHERE id = ?').get(id) || null;
}

function list({ status, limit = 30 } = {}) {
  const rows = status
    ? db().prepare('SELECT * FROM messages WHERE status = ? ORDER BY updated_at DESC LIMIT ?').all(status, limit)
    : db().prepare('SELECT * FROM messages ORDER BY updated_at DESC LIMIT ?').all(limit);
  return rows;
}

function setFields(id, fields) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); vals.push(v); }
  sets.push('updated_at = ?'); vals.push(now());
  db().prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return get(id);
}

function recordAttempt(id, attempt, error) {
  return setFields(id, { attempts: attempt, status: 'sent', last_error: error || null });
}

// Explicit tool ack from the target agent (or ack CLI).
function markRead(id, via = 'ack_message') {
  const row = get(id);
  if (!row) throw new Error(`unknown message id: ${id}`);
  if (row.status === 'read') return row;
  return setFields(id, { status: 'read', read_at: now(), last_error: null });
}

// Fallback ack: the target replied containing the receipt token in an
// assistant turn (user turns carry the instruction itself, so they never count).
async function scanAck(a, sessionId, id) {
  try {
    const turns = a.messages(sessionId, 8);
    if (!turns) return false;
    return turns.some((t) => t.role === 'assistant' && String(t.text || '').includes(`ACK-${id}`));
  } catch { return false; }
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
    const footer = `${String.fromCharCode(10)}[read-receipt] 收到并处理后请标记已读：调用 agentrelay 的 ack_message 工具（id="${id}"），或在回复中包含 ACK-${id}（重发 ${attempt}/${maxAttempts}）`;
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
      if (await scanAck(a, sessionId, id)) {
        markRead(id, 'transcript');
        return summary(get(id), { attemptsUsed: attempt, note: 'acknowledged via reply token' });
      }
      await sleep(pollMs);
    }
    problems.push(`attempt ${attempt}: not acknowledged within ${Math.round(ackTimeoutMs / 1000)}s`);
    setFields(id, { attempts: attempt, last_error: `no ack (attempt ${attempt})` });
  }
  const final = setFields(id, { status: 'failed', last_error: problems[problems.length - 1] });
  return summary(final, { attemptsUsed: maxAttempts, problems });
}

function close() { try { _db && _db.close(); _db = null; } catch { /* ignore */ } }

module.exports = { DB_PATH, create, get, list, markRead, recordAttempt, setFields, trackedSend, summary, close };
