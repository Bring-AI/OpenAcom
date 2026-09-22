'use strict';

// Distributed relay: a hub (loopback HTTP + durable SQLite queue) plus nodes
// that poll and inject into locally allowlisted targets.
//
// Delivery invariant: at-most-once with honest status - never exactly-once.
// A node commits a durable receipt BEFORE any UI call, so a crash can lose a
// message but can never run the same UI side effect twice. The three
// non-final-looking statuses mean different things and are never conflated:
//   deferred  - the node proved the target was untouched, so redelivery is safe;
//   uncertain - input may already have been submitted; never redelivered, and
//               only the owning node's later report retires the uncertainty;
//   delivered - input reached the UI, which never implies a model answered.
// An operator retry (POST /messages/:id/retry) restarts the deferral window and
// the TTL clock for queued, deferred, expired or failed work; it never re-offers
// uncertain work, and it never rewrites consent or the sticky uncertain marker.
//
// Credentials: AGENTRELAY_TOKEN is the hub bootstrap credential. It enqueues,
// registers new node ids and reads status. Every node is additionally issued a
// hub-generated per-node token at registration, and only that token may poll or
// acknowledge that node's own queue - a registered node cannot claim another
// node's messages even though it shares the hub.
//
// Desktop consent: a zcode submit presses Enter in a window somebody may be
// typing into, so `consent` is carried end to end but never defaulted on. The
// hub only stores and forwards what the sender claimed; lib/desktop-delivery.js
// alone decides, which is also what lets the node's own environment authorise a
// desktop its operator personally controls.
//
// Both stores are node:sqlite with synchronous = FULL, so a commit that returns
// success survives a process kill. Their files are tightened through
// lib/secure-fs.js, and the resulting acl is reported rather than assumed.

const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { homedir } = require('os');
const { createHash, randomBytes, randomUUID, timingSafeEqual } = require('crypto');
const secureFs = require('./secure-fs');

const MAX_BODY = 512 * 1024;
const MAX_TEXT = 64 * 1024;
const LEASE_MS = 120000;
const HEARTBEAT_MS = 10000;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;

// Queue growth bounds (M6). Resolved per hub/node start, not at require time.
const HOUR = 3600000;
const QUEUE_TTL_MS = 24 * HOUR;
const NODE_QUEUE_LIMIT = 128;
const HISTORY_RETENTION_MS = 7 * 24 * HOUR;
// A message stays 'uncertain' until the owning node reports a definitive result
// (M4). Only that node can know whether its UI call landed, so hub-side sweeps
// open uncertainty rather than closing it.
const UNCERTAIN_SETTLE_MS = 30 * 60000;
const UNCERTAIN_MIN_POLLS = 2;
const MAINTENANCE_MS = 60000;
const DEFERRAL_BASE_MS = 5000;
const DEFERRAL_MAX_MS = 5 * 60000;
const MAX_DEFERRALS = 6;
const ALERT_DEBOUNCE_MS = 60000;
const SECURITY_ALERT_KINDS = ['ADMIN_HEARTBEAT_FOR_REGISTERED_NODE', 'FOREIGN_CREDENTIAL_HEARTBEAT', 'NODE_TAKEOVER_BLOCKED', 'CREDENTIAL_ROTATED', 'MULTI_SOURCE_HEARTBEAT', 'CREDENTIAL_MISMATCH_ACK'];

function positiveNumber(value, name, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number of milliseconds.`);
  return parsed;
}

function positiveInteger(value, name, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function envList(name) {
  const raw = process.env[name];
  if (!raw) return [];
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => identifier(entry, name));
}

// Delivery codes that prove the node never touched the target, so the hub may
// hand the same message out again without risking a second side effect (M5).
// CONSENT_REQUIRED is deliberately absent: retrying the same submit changes
// nothing until the operator switches to draft or grants consent, so a deferral
// budget would only be burned to prove the same refusal twice.
const DEFERRABLE_CODES = new Set([
  'INPUT_LOCKED', 'PENDING_DRAFT', 'INPUT_BUSY', 'TERMINAL_EXITED', 'PASTE_UNAVAILABLE',
  'IPC_TIMEOUT', 'IPC_ERROR', 'IPC_CLOSED', 'IPC_PROTOCOL', 'CONNECTION_REFUSED',
]);

// Row statuses an operator may push back through the queue with POST /messages/:id/retry.
// 'delivering' has a live claim, 'uncertain' may already have landed (M4) and 'delivered' is settled - all three refuse.
const RETRYABLE_FROM = new Set(['queued', 'deferred', 'expired', 'failed']);

// Classify a node-side delivery failure into the three honest buckets. Uncertain
// takes priority: an adapter that says "I may already have typed it" outranks
// whatever code came with it.
function classifyFailure(error) {
  const code = error && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'DELIVERY_ERROR';
  if (error && error.uncertain === true) return { status: 'uncertain', code };
  if (error && error.uncertain === false && DEFERRABLE_CODES.has(code)) return { status: 'deferred', code };
  return { status: 'failed', code };
}

// M2: targets.json holds per-target IPC secrets, so a group- or world-readable
// copy hands them to any local account. Rejected on POSIX; on Windows the mode
// bits mean nothing and the icacls wiring lives outside this file, so warn.
function targetFilePermissionProblem(mode, platform = process.platform) {
  if (platform === 'win32') return null;
  if (mode & 0o077) return 'readable or writable by group or others';
  return null;
}

function fault(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function tokenValue(token) {
  if (typeof token !== 'string' || !/^[\x21-\x7e]{32,4096}$/.test(token)) {
    throw new Error('AGENTRELAY_TOKEN must contain at least 32 printable non-space ASCII characters (maximum 4096).');
  }
  return token;
}

function identifier(value, field) {
  if (typeof value !== 'string' || !ID.test(value)) {
    throw fault(400, 'INVALID_ID', `${field} must be 1-64 letters, digits, dots, underscores or hyphens, starting with a letter or digit.`);
  }
  return value;
}

function uuid(value, field) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw fault(400, 'INVALID_ID', `${field} must be a UUID.`);
  }
  return value.toLowerCase();
}

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw fault(400, 'INVALID_BODY', 'Expected a JSON object.');
  }
  return value;
}

function onlyKeys(value, keys) {
  object(value);
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw fault(400, 'INVALID_BODY', 'Unexpected JSON field.');
  }
}

function messageInput(body) {
  onlyKeys(body, ['id', 'to', 'target', 'text', 'mode', 'consent']);
  const id = body.id === undefined ? randomUUID() : uuid(body.id, 'id');
  const to = identifier(body.to, 'to');
  const target = identifier(body.target, 'target');
  const mode = body.mode === undefined ? 'submit' : body.mode;
  if (mode !== 'submit' && mode !== 'draft') throw fault(400, 'INVALID_MODE', 'mode must be submit or draft.');
  // F1: only the literal boolean true authorises anything. An absent flag means
  // not authorised, and a truthy non-boolean is a caller bug, not a maybe.
  if (body.consent !== undefined && body.consent !== true && body.consent !== false) {
    throw fault(400, 'INVALID_CONSENT', 'consent must be the boolean true, and only for a desktop submit an operator approved.');
  }
  const consent = body.consent === true;
  if (typeof body.text !== 'string' || !body.text.trim() || Buffer.byteLength(body.text, 'utf8') > MAX_TEXT || CONTROL.test(body.text)) {
    throw fault(400, 'INVALID_TEXT', 'text must be nonempty, at most 65536 UTF-8 bytes, and contain no terminal controls other than newline.');
  }
  // SQLite stores UTF-8; reject lone UTF-16 surrogates rather than changing a caller's text.
  if (body.text !== Buffer.from(body.text, 'utf8').toString('utf8')) {
    throw fault(400, 'INVALID_TEXT', 'text must contain valid Unicode.');
  }
  return { id, to, target, text: body.text, mode, consent };
}

function loopback(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === '::1' || (net.isIP(h) === 4 && h.startsWith('127.'));
}

function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Hub URL must be an absolute http:// or https:// URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Hub URL must be an HTTP(S) origin without credentials, path, query or fragment.');
  }
  if (url.protocol === 'http:' && !loopback(url.hostname) && url.hostname !== 'localhost') {
    throw new Error('Plain HTTP is permitted only on loopback; use an SSH tunnel or HTTPS reverse proxy.');
  }
  return url;
}

function request({ url, token, timeoutMs = 15000 }, method, resource, body) {
  return new Promise((resolve, reject) => {
    let base;
    let payload;
    try {
      base = endpoint(url);
      tokenValue(token);
      if (typeof resource !== 'string' || !resource.startsWith('/') || resource.startsWith('//') || /[\r\n#]/.test(resource)) {
        throw new Error('Request path must be an absolute path on the configured hub.');
      }
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new Error('Invalid request timeout.');
      payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
      if (payload && payload.length > MAX_BODY) throw fault(413, 'BODY_TOO_LARGE', 'Request JSON exceeds 512 KiB.');
    } catch (error) { reject(error); return; }
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    const options = { method, path: resource, headers, agent: false };
    // A localhost DNS override must not silently send the shared token off-machine over HTTP.
    if (base.protocol === 'http:') {
      options.lookup = (host, opts, callback) => {
        dns.lookup(host, opts, (error, address, family) => {
          if (error) { callback(error); return; }
          const addresses = Array.isArray(address) ? address : [{ address, family }];
          if (addresses.some((entry) => !loopback(entry.address))) {
            callback(new Error('Refusing non-loopback HTTP address.'));
          } else callback(null, address, family);
        });
      };
    }
    const client = base.protocol === 'https:' ? https : http;
    let timer;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const req = client.request(base, options, (res) => {
      const chunks = [];
      let length = 0;
      res.on('data', (chunk) => {
        length += chunk.length;
        if (length > MAX_BODY) {
          const error = fault(502, 'RESPONSE_TOO_LARGE', 'Hub response exceeds 512 KiB.');
          finish(error);
          res.destroy(error);
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', (error) => finish(error));
      res.on('aborted', () => finish(new Error('Hub response was interrupted.')));
      res.on('end', () => {
        if (settled) return;
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { finish(fault(res.statusCode || 502, 'INVALID_RESPONSE', 'Hub returned invalid JSON.')); return; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const detail = value && value.error;
          finish(fault(res.statusCode, detail && detail.code || 'HTTP_ERROR', detail && detail.message || `Hub HTTP ${res.statusCode}.`));
        } else finish(null, value);
      });
    });
    req.on('error', (error) => finish(error));
    timer = setTimeout(() => req.destroy(fault(504, 'REQUEST_TIMEOUT', `Hub request timed out after ${timeoutMs} ms.`)), timeoutMs);
    req.end(payload);
  });
}

function issueNodeToken() {
  return randomBytes(32).toString('base64url');
}

// Only the digest of a node credential is stored, so a hub database copy cannot
// be replayed as a credential.
function nodeDigest(credential) {
  return createHash('sha256').update(`Bearer ${credential}`).digest('hex');
}

// SQLite has no IF NOT EXISTS for columns, and both stores may be opened by an
// older release, so additive columns are migrated by inspection.
function ensureColumns(store, table, columns) {
  const existing = new Set(store.db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
  for (const [name, declaration] of Object.entries(columns)) {
    if (!existing.has(name)) store.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
  }
}

function openStore(dataDir, filename) {
  const directory = path.resolve(dataDir || path.join(homedir(), '.openacom', 'distributed'));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(directory, filename);
  // F2: chmod is a no-op against a Windows security descriptor, so both the
  // directory and the store (which holds issued node credentials on the hub side
  // and the node's own credential in plaintext) go through secure-fs. Once per
  // creation, never per request: on Windows that spawns icacls.
  const protections = [secureFs.protectPath(directory, { directory: true })];
  const db = new DatabaseSync(file);
  let owner;
  const statements = new Map();
  const sql = (query) => {
    let statement = statements.get(query);
    if (!statement) { statement = db.prepare(query); statements.set(query, statement); }
    return statement;
  };
  try {
    protections.push(secureFs.protectPath(file));
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    db.exec('CREATE TABLE IF NOT EXISTS runtime (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER NOT NULL, owner TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    db.exec('BEGIN IMMEDIATE');
    try {
      const active = sql('SELECT pid FROM runtime WHERE id = 1').get();
      if (active) {
        let alive = true;
        try { process.kill(active.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
        if (alive) throw new Error(`Distributed store is already in use by PID ${active.pid}: ${file}`);
      }
      owner = randomUUID();
      sql('INSERT OR REPLACE INTO runtime (id, pid, owner) VALUES (1, ?, ?)').run(process.pid, owner);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } catch (error) { db.close(); throw error; }
  return {
    db, sql, file,
    acl: secureFs.aggregateAcl(protections),
    protections: protections.map(({ path: protectedPath, acl, platform, principal, error }) => ({
      path: protectedPath, acl, platform, principal, ...(error ? { error } : {}),
    })),
    close() {
      try { sql('DELETE FROM runtime WHERE id = 1 AND owner = ?').run(owner); }
      finally { db.close(); }
    },
  };
}

function transaction(store, action) {
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    store.db.exec('COMMIT');
    return result;
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}

// This object is what `relay_status` and `openacom relay status` return, so
// every field here is operator-visible delivery truth.
//   attempts   - times a node was handed this message (deferred retries included)
//   deferrals  - attempts that ended before the target was touched
//   retries    - how often an operator pushed this row back into the queue
//   retryEligible - POST /messages/:id/retry would accept this row right now
//   consent    - the sender's own desktop-submit authorisation as recorded at
//                enqueue time; it is never inferred and never defaults to true
//   retryable  - the hub may hand it out again; guaranteed not to have landed yet
//   terminal   - no further status change is possible from this row
//   everUncertain - sticky (M4): once a row has ever been uncertain it stays
//                   true even after the node resolves it, and it survives a hub
//                   restart because it is its own column, never cleared by an ack
function publicMessage(row) {
  const terminal = ['delivered', 'failed', 'expired'].includes(row.status)
    || (row.status === 'uncertain' && row.settlement === 'no-evidence-budget-exhausted')
    || (row.status === 'deferred' && row.deferrals >= MAX_DEFERRALS);
  return {
    id: row.id, to: row.node_id, target: row.target, text: row.text, mode: row.mode,
    status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
    consent: !!row.consent,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    error: row.error_json ? JSON.parse(row.error_json) : null,
    attempts: row.attempts, deferrals: row.deferrals, deferred: row.status === 'deferred',
    retries: row.retries, retryEligible: RETRYABLE_FROM.has(row.status),
    retryable: !terminal && ['queued', 'delivering', 'deferred'].includes(row.status),
    terminal, expiresAt: row.expires_at, everUncertain: !!row.ever_uncertain,
    uncertainAt: row.uncertain_at, uncertainDeadline: row.uncertain_deadline, settlement: row.settlement,
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
      req.resume();
      reject(fault(415, 'CONTENT_TYPE', 'Content-Type must be application/json.'));
      return;
    }
    if (Number(req.headers['content-length']) > MAX_BODY) {
      req.resume();
      reject(fault(413, 'BODY_TOO_LARGE', 'Request JSON exceeds 512 KiB.'));
      return;
    }
    const chunks = [];
    let length = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      length += chunk.length;
      if (length > MAX_BODY) {
        failed = true;
        reject(fault(413, 'BODY_TOO_LARGE', 'Request JSON exceeds 512 KiB.'));
      } else chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('aborted', () => reject(fault(400, 'INTERRUPTED_BODY', 'Request body was interrupted.')));
    req.on('end', () => {
      if (failed) return;
      try { resolve(object(JSON.parse(Buffer.concat(chunks).toString('utf8')))); }
      catch { reject(fault(400, 'INVALID_JSON', 'Expected a valid JSON object.')); }
    });
  });
}

function respond(res, status, value) {
  let body = JSON.stringify(value);
  if (Buffer.byteLength(body) > MAX_BODY) {
    status = 413;
    body = JSON.stringify({ error: { code: 'RESPONSE_TOO_LARGE', message: 'Hub response exceeds the 512 KiB JSON limit.' } });
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...(status >= 400 ? { Connection: 'close' } : {}),
  });
  res.end(body);
}

async function runHub({
  host = '127.0.0.1', port = 9330, dataDir, token,
  queueTtlMs, nodeQueueLimit, historyRetentionMs, uncertainSettleMs, allowedNodes,
} = {}) {
  tokenValue(token);
  if (!loopback(host)) throw new Error('Hub must bind a loopback IP address; expose it using SSH or a TLS reverse proxy.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Hub port must be an integer from 0 to 65535.');
  const ttlMs = positiveNumber(queueTtlMs ?? process.env.AGENTRELAY_QUEUE_TTL_MS, 'queueTtlMs', QUEUE_TTL_MS);
  const depthLimit = positiveInteger(nodeQueueLimit ?? process.env.AGENTRELAY_NODE_QUEUE_LIMIT, 'nodeQueueLimit', NODE_QUEUE_LIMIT);
  const retentionMs = positiveNumber(historyRetentionMs ?? process.env.AGENTRELAY_HISTORY_RETENTION_MS, 'historyRetentionMs', HISTORY_RETENTION_MS);
  const settleMs = positiveNumber(uncertainSettleMs, 'uncertainSettleMs', UNCERTAIN_SETTLE_MS);
  const permittedNodes = new Set((allowedNodes ?? envList('AGENTRELAY_ALLOWED_NODES')).map((nodeId) => identifier(nodeId, 'allowedNodes')));
  const store = openStore(dataDir, 'hub.sqlite');
  const { db, sql } = store;
  let server;
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, session_id TEXT NOT NULL,
        targets_json TEXT NOT NULL, last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, node_id TEXT NOT NULL, target TEXT NOT NULL, text TEXT NOT NULL,
        mode TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        claim_id TEXT, session_id TEXT, result_json TEXT, error_json TEXT
      );
      CREATE TABLE IF NOT EXISTS alerts (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT NOT NULL, kind TEXT NOT NULL,
        detail_json TEXT, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS message_queue ON messages (node_id, status, created_at);
      CREATE INDEX IF NOT EXISTS alert_node ON alerts (node_id, created_at);
    `);
    ensureColumns(store, 'nodes', {
      credential_digest: 'TEXT', issued_at: 'INTEGER', first_seen: 'INTEGER', source: 'TEXT',
    });
    ensureColumns(store, 'messages', {
      attempts: 'INTEGER NOT NULL DEFAULT 0', deferrals: 'INTEGER NOT NULL DEFAULT 0',
      retry_not_before: 'INTEGER', expires_at: 'INTEGER', ever_uncertain: 'INTEGER NOT NULL DEFAULT 0',
      uncertain_at: 'INTEGER', uncertain_deadline: 'INTEGER', uncertain_polls: 'INTEGER NOT NULL DEFAULT 0',
      settlement: 'TEXT', consent: 'INTEGER NOT NULL DEFAULT 0',
      retries: 'INTEGER NOT NULL DEFAULT 0',
    });
    // Created after the migration because an older hub.sqlite has no such column yet.
    db.exec('CREATE INDEX IF NOT EXISTS message_expiry ON messages (status, expires_at);');
    const uncertainError = (message) => JSON.stringify({ code: 'DELIVERY_UNCERTAIN', message });
    const makeUncertain = (reason) => ({ now, id }) => sql(`
      UPDATE messages SET status = 'uncertain', ever_uncertain = 1, uncertain_at = @now,
        uncertain_deadline = @now + @settle, uncertain_polls = 0, settlement = 'awaiting-node-evidence',
        updated_at = @now, error_json = @error
      WHERE id = @id
    `).run({ now, settle: settleMs, error: uncertainError(reason), id });
    // A restart never closes uncertainty by itself: any in-flight claim becomes
    // uncertain and waits for the owning node's durable receipt to speak.
    sql("SELECT id FROM messages WHERE status = 'delivering'").all()
      .forEach((row) => makeUncertain('Hub restarted before delivery was acknowledged; input may have been submitted. It will not be replayed.')(
        { now: Date.now(), id: row.id },
      ));
    const authDigest = createHash('sha256').update(`Bearer ${token}`).digest();
    let lastMaintenance = 0;
    const expire = () => {
      const now = Date.now();
      sql("SELECT id FROM messages WHERE status = 'delivering' AND node_id IN (SELECT id FROM nodes WHERE last_seen < ?)").all(now - LEASE_MS)
        .forEach((row) => makeUncertain('Node heartbeat expired before delivery was acknowledged; input may have been submitted. It will not be replayed.')(
          { now, id: row.id },
        ));
      // M4: 'uncertain' closes only when the owning node is online, has polled
      // at least twice since the uncertainty opened (so its durable receipt had
      // every chance to report), and the evidence window has passed. Even then
      // the status stays 'uncertain' - the hub refuses to guess either way.
      sql(`
        UPDATE messages SET settlement = 'no-evidence-budget-exhausted', updated_at = ?
        WHERE status = 'uncertain' AND settlement = 'awaiting-node-evidence'
          AND uncertain_polls >= ? AND uncertain_deadline <= ?
          AND node_id IN (SELECT id FROM nodes WHERE last_seen >= ?)
      `).run(now, UNCERTAIN_MIN_POLLS, now, now - LEASE_MS);
      // M6: expiry gates claiming, so it runs on every request rather than
      // waiting for the cheaper-to-defer retention pass below.
      ageOut(now);
      if (now - lastMaintenance < MAINTENANCE_MS) return null;
      lastMaintenance = now;
      return maintain(now);
    };
    // M6: TTL and retention are stored per row, so a restart sweeps what an
    // earlier process never got to; nothing here depends on in-memory state.
    const ageOut = (now) => sql("UPDATE messages SET status = 'expired', updated_at = ?, error_json = ? WHERE status IN ('queued','deferred') AND expires_at <= ?").run(
      now, JSON.stringify({ code: 'QUEUE_EXPIRED', message: 'Message aged out of the queue TTL without being delivered; the target was never touched.' }), now,
    ).changes;
    const maintain = (now) => {
      const result = {};
      // In-flight claims are aged out by the lease sweep into 'uncertain', never
      // by TTL, because expiry asserts the target was never touched.
      result.expired = ageOut(now);
      result.deleted = sql("DELETE FROM messages WHERE status IN ('delivered','failed','expired') AND updated_at <= ?").run(now - retentionMs).changes;
      result.alerts = sql('DELETE FROM alerts WHERE created_at <= ?').run(now - retentionMs).changes;
      return result;
    };
    const getMessage = (id) => {
      const row = sql('SELECT * FROM messages WHERE id = ?').get(id);
      if (!row) throw fault(404, 'NOT_FOUND', 'Message not found.');
      return row;
    };
    const alertThrottled = (nodeId, kind, detail) => {
      const now = Date.now();
      const last = sql('SELECT created_at FROM alerts WHERE node_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1').get(nodeId, kind);
      if (last && now - last.created_at < ALERT_DEBOUNCE_MS) return;
      sql('INSERT INTO alerts (node_id, kind, detail_json, created_at) VALUES (?, ?, ?, ?)').run(
        nodeId, kind, JSON.stringify(detail ?? null), now,
      );
    };
    const sourceAddress = (req) => (req.socket && req.socket.remoteAddress) || '';
    const caller = (req) => {
      // Both sides are fixed-length SHA-256 digests, so timingSafeEqual cannot throw here.
      const supplied = createHash('sha256').update(req.headers.authorization || '').digest();
      if (timingSafeEqual(authDigest, supplied)) return { admin: true, nodeId: null };
      const owner = sql('SELECT id FROM nodes WHERE credential_digest = ?').get(supplied.toString('hex'));
      if (!owner) throw fault(401, 'UNAUTHORIZED', 'Bearer authentication required.');
      return { admin: false, nodeId: owner.id };
    };
    const requireAdmin = (actor) => {
      if (!actor.admin) throw fault(403, 'ADMIN_CREDENTIAL_REQUIRED', 'This route requires the hub bootstrap credential, not a node credential.');
    };
    // H1: the node credential bound to a queue is the only one that may take or
    // settle that queue's messages, and the hub reports impersonation instead of
    // treating it as an odd client bug.
    const requireNodeCredential = (actor, nodeId, row) => {
      if (actor.admin) throw fault(403, 'NODE_CREDENTIAL_REQUIRED', 'Polling and acknowledging require the node credential issued to this node at registration.');
      if (actor.nodeId !== nodeId) {
        if (row) alertThrottled(nodeId, 'CREDENTIAL_MISMATCH_ACK', { presented: actor.nodeId, holder: row.node_id });
        throw fault(403, 'NODE_FORBIDDEN', 'Credential does not belong to this node id.');
      }
    };
    server = http.createServer(async (req, res) => {
      try {
        const actor = caller(req);
        if (!req.url || req.url.length > 2048 || !req.url.startsWith('/') || req.url.startsWith('//')) {
          throw fault(400, 'INVALID_PATH', 'Invalid request path.');
        }
        const url = new URL(req.url, 'http://127.0.0.1');
        expire();
        if (req.method === 'POST' && url.pathname === '/messages') {
          requireAdmin(actor);
          const input = messageInput(await readJson(req));
          const existing = sql('SELECT * FROM messages WHERE id = ?').get(input.id);
          if (existing) {
            // A stored id may not be replayed with a different payload, including a
            // louder consent flag: that would launder authorisation through a retry.
            if (existing.node_id !== input.to || existing.target !== input.target || existing.text !== input.text || existing.mode !== input.mode || !!existing.consent !== input.consent) {
              throw fault(409, 'ID_CONFLICT', 'This message id is already associated with a different payload.');
            }
            respond(res, 200, publicMessage(existing));
          } else {
            // H1: only a node that has registered (or that the operator named in
            // AGENTRELAY_ALLOWED_NODES) may receive work, so a credential holder
            // cannot push messages into an arbitrary or spoofed queue.
            const registered = sql('SELECT id FROM nodes WHERE id = ?').get(input.to);
            if (!registered && !permittedNodes.has(input.to)) {
              throw fault(403, 'UNKNOWN_NODE', `Node ${input.to} is not registered with this hub; run the node once, or list it in AGENTRELAY_ALLOWED_NODES.`);
            }
            const depth = sql("SELECT COUNT(*) AS c FROM messages WHERE node_id = ? AND status IN ('queued','delivering','deferred','uncertain')").get(input.to).c;
            if (depth >= depthLimit) {
              throw Object.assign(fault(429, 'QUEUE_FULL', `Node ${input.to} already holds ${depth} undelivered messages (limit ${depthLimit}).`), { retryAfterMs: ttlMs });
            }
            const now = Date.now();
            sql("INSERT INTO messages (id, node_id, target, text, mode, status, created_at, updated_at, expires_at, consent) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)").run(
              input.id, input.to, input.target, input.text, input.mode, now, now, now + ttlMs, input.consent ? 1 : 0,
            );
            respond(res, 202, publicMessage(getMessage(input.id)));
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/nodes') {
          requireAdmin(actor);
          const alerts = new Map(sql('SELECT node_id, kind, COUNT(*) AS count, MAX(created_at) AS last_at FROM alerts GROUP BY node_id, kind')
            .all().map((row) => [`${row.node_id}\u0000${row.kind}`, { count: row.count, lastAt: row.last_at }]));
          const now = Date.now();
          const nodes = sql('SELECT id, targets_json, last_seen, first_seen, issued_at, source, credential_digest FROM nodes ORDER BY id').all().map((node) => ({
            id: node.id, targets: JSON.parse(node.targets_json), lastSeen: node.last_seen, online: node.last_seen >= now - LEASE_MS,
            firstSeen: node.first_seen, registeredAt: node.issued_at, heartbeatSource: node.source,
            credential: node.credential_digest ? { issuedAt: node.issued_at, fingerprint: node.credential_digest.slice(0, 8) } : null,
            security: Object.fromEntries(SECURITY_ALERT_KINDS.map((kind) => {
              const entry = alerts.get(`${node.id}\u0000${kind}`);
              return [kind, { count: entry ? entry.count : 0, lastAt: entry ? entry.lastAt : null }];
            })),
          }));
          respond(res, 200, {
            nodes, queueTtlMs: ttlMs, nodeQueueLimit: depthLimit,
            // F2: the queue store holds credential digests, so its real ACL is
            // fleet state an operator can read, not a log line that scrolls away.
            store: { acl: store.acl, paths: store.protections },
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/security') {
          requireAdmin(actor);
          respond(res, 200, {
            alerts: sql('SELECT node_id, kind, detail_json, created_at FROM alerts ORDER BY seq DESC LIMIT 200').all()
              .map((row) => ({ nodeId: row.node_id, kind: row.kind, detail: row.detail_json ? JSON.parse(row.detail_json) : null, createdAt: row.created_at })),
          });
          return;
        }
        // Operator-only observation, separate from the node poll/claim endpoint.
        if (req.method === 'GET' && url.pathname === '/admin/messages') {
          requireAdmin(actor);
          const rawLimit = url.searchParams.get('limit');
          const limit = rawLimit === null ? 100 : Number(rawLimit);
          if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw fault(400, 'INVALID_LIMIT', 'limit must be 1..200');
          const node = url.searchParams.get('node');
          const status = url.searchParams.get('status');
          const where = [], args = [];
          if (node) { identifier(node, 'node'); where.push('node_id = ?'); args.push(node); }
          if (status) {
            if (!['queued','delivering','delivered','deferred','uncertain','failed','expired'].includes(status)) throw fault(400, 'INVALID_STATUS', 'Unknown message status');
            where.push('status = ?'); args.push(status);
          }
          const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
          const rows = sql('SELECT * FROM messages' + clause + ' ORDER BY updated_at DESC, rowid DESC LIMIT ?').all(...args, limit);
          const counts = sql('SELECT status, COUNT(*) AS count FROM messages' + clause + ' GROUP BY status').all(...args);
          respond(res, 200, {
            messages: rows.map(row => { const item = publicMessage(row); const preview = Buffer.from(item.text.slice(0, 2000), 'utf16le').toString('utf16le'); return { ...item, text: preview, truncated: item.text.length > 2000 }; }),
            counts: Object.fromEntries(counts.map(row => [row.status, row.count])),
            total: counts.reduce((total, row) => total + row.count, 0), limit,
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/queue/prune') {
          requireAdmin(actor);
          req.resume();
          respond(res, 200, { ok: true, ...maintain(Date.now()) });
          return;
        }
        const retryPath = /^\/messages\/([^/]+)\/retry$/.exec(url.pathname);
        if (req.method === 'POST' && retryPath) {
          requireAdmin(actor);
          req.resume();
          const id = uuid(retryPath[1], 'id');
          const row = getMessage(id);
          if (!RETRYABLE_FROM.has(row.status)) {
            const why = row.status === 'delivered' ? 'ALREADY_SETTLED'
              : row.status === 'uncertain' ? 'UNCERTAIN_NOT_RETRYABLE' : 'CLAIM_ACTIVE';
            throw fault(409, why, `A message in status ${row.status} is not retryable: ${
              why === 'ALREADY_SETTLED' ? 'the node reported the input delivered.'
                : why === 'UNCERTAIN_NOT_RETRYABLE' ? 'the input may already have landed, so only the owning node can settle it.'
                  : 'a node holds a live claim.'}`);
          }
          const now = Date.now();
          // A terminal row re-entering the queue counts against the node's depth again, so the cap is checked here too.
          if (!['queued', 'deferred'].includes(row.status)) {
            const depth = sql("SELECT COUNT(*) AS c FROM messages WHERE node_id = ? AND status IN ('queued','delivering','deferred','uncertain')").get(row.node_id).c;
            if (depth >= depthLimit) {
              throw Object.assign(fault(429, 'QUEUE_FULL', `Node ${row.node_id} already holds ${depth} undelivered messages (limit ${depthLimit}); retry would exceed it.`), { retryAfterMs: ttlMs });
            }
          }
          // The deferral window and budget reset and the TTL clock restarts; the attempt
          // history, the sticky uncertain marker, the settlement trail and consent all stay.
          const changed = transaction(store, () => sql(`
            UPDATE messages SET status = 'queued', deferrals = 0, retry_not_before = 0, claim_id = NULL,
              session_id = NULL, result_json = NULL, error_json = NULL, retries = retries + 1,
              updated_at = ?, expires_at = ?
            WHERE id = ? AND status = ?
          `).run(now, now + ttlMs, id, row.status).changes);
          if (!changed) throw fault(409, 'RETRY_RACED', 'The message changed state while the retry was being applied; read it again before deciding.');
          const retried = publicMessage(getMessage(id));
          respond(res, 200, {
            ok: true, id: retried.id, status: retried.status, attempts: retried.attempts,
            deferrals: retried.deferrals, retries: retried.retries, retryable: retried.retryable,
            terminal: retried.terminal, expiresAt: retried.expiresAt, retryEligible: retried.retryEligible,
          });
          return;
        }
        const heartbeat = /^\/nodes\/([^/]+)\/heartbeat$/.exec(url.pathname);
        if (req.method === 'POST' && heartbeat) {
          const nodeId = identifier(heartbeat[1], 'nodeId');
          const body = await readJson(req);
          onlyKeys(body, ['instanceId', 'sessionId', 'targets']);
          const instanceId = uuid(body.instanceId, 'instanceId');
          const sessionId = uuid(body.sessionId, 'sessionId');
          if (!Array.isArray(body.targets) || body.targets.length > 128 || new Set(body.targets).size !== body.targets.length) {
            throw fault(400, 'INVALID_TARGETS', 'targets must be an array of at most 128 unique local target names.');
          }
          body.targets.forEach((target) => identifier(target, 'target'));
          const source = sourceAddress(req);
          // A rejected takeover rolls its transaction back, so the security event
          // is recorded afterwards - otherwise the attempt that matters most is
          // the one that leaves no trace.
          const notes = [];
          let outcome;
          try {
            outcome = transaction(store, () => {
              const note = (kind, detail) => { notes.push([kind, detail]); };
              const now = Date.now();
              const previous = sql('SELECT * FROM nodes WHERE id = ?').get(nodeId);
              const touch = (credential) => sql(`
                INSERT INTO nodes (id, instance_id, session_id, targets_json, last_seen, credential_digest, issued_at, first_seen, source)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET instance_id = excluded.instance_id, session_id = excluded.session_id,
                  targets_json = excluded.targets_json, last_seen = excluded.last_seen, source = excluded.source
                  ${credential ? ', credential_digest = excluded.credential_digest, issued_at = excluded.issued_at' : ''}
              `).run(nodeId, instanceId, sessionId, JSON.stringify(body.targets), now,
                credential || (previous && previous.credential_digest) || null,
                credential ? now : (previous && previous.issued_at) || now,
                (previous && previous.first_seen) || now, source);
              if (!previous) {
                if (!actor.admin) throw fault(401, 'UNAUTHORIZED', 'Bearer authentication required.');
                if (permittedNodes.size && !permittedNodes.has(nodeId)) {
                  throw fault(403, 'NODE_NOT_ALLOWED', `Node ${nodeId} is not listed in AGENTRELAY_ALLOWED_NODES.`);
                }
                const nodeToken = issueNodeToken();
                touch(nodeDigest(nodeToken));
                return { nodeToken };
              }
              if (actor.nodeId !== nodeId) {
                if (!actor.admin) {
                  note('FOREIGN_CREDENTIAL_HEARTBEAT', { presented: actor.nodeId, source });
                  throw fault(403, 'NODE_FORBIDDEN', 'Credential does not belong to this node id.');
                }
                note('ADMIN_HEARTBEAT_FOR_REGISTERED_NODE', { instanceId, sessionId, source });
                // The instance holding the lease stays authoritative: a bootstrap
                // credential cannot rebind a live node out from under itself, and a
                // rebind of an idle node rotates the credential so the previous
                // holder loses access rather than being silently kept alive.
                if (previous.last_seen >= now - LEASE_MS) {
                  if (previous.instance_id !== instanceId || previous.session_id !== sessionId) {
                    note('NODE_TAKEOVER_BLOCKED', { held: previous.instance_id, attempted: instanceId, source });
                    throw fault(403, 'NODE_TAKEOVER', `Node ${nodeId} is live under another instance; its credential was not reissued.`);
                  }
                  touch();
                  return {};
                }
                const nodeToken = issueNodeToken();
                note('CREDENTIAL_ROTATED', { instanceId, previousIssuedAt: previous.issued_at });
                touch(nodeDigest(nodeToken));
                return { nodeToken, rotated: true };
              }
              if (previous.session_id !== sessionId) {
                sql("SELECT id FROM messages WHERE node_id = ? AND status = 'delivering'").all(nodeId).forEach((row) => makeUncertain(
                  'Node session changed before acknowledgment; input may have been submitted. It will not be replayed.',
                )({ now, id: row.id }));
              }
              if (previous.source && previous.source !== source) {
                note('MULTI_SOURCE_HEARTBEAT', { held: previous.source, attempted: source });
              }
              touch();
              return {};
            });
          } finally {
            notes.forEach(([kind, detail]) => alertThrottled(nodeId, kind, detail));
          }
          respond(res, 200, {
            ok: true, heartbeatMs: HEARTBEAT_MS,
            ...(outcome.nodeToken ? { nodeToken: outcome.nodeToken } : {}),
            ...(outcome.rotated ? { credentialRotated: true } : {}),
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/messages') {
          const nodeId = identifier(url.searchParams.get('to'), 'to');
          const sessionId = uuid(url.searchParams.get('sessionId'), 'sessionId');
          requireNodeCredential(actor, nodeId);
          const claimed = transaction(store, () => {
            const node = sql('SELECT * FROM nodes WHERE id = ?').get(nodeId);
            if (!node || node.session_id !== sessionId || node.last_seen < Date.now() - LEASE_MS) {
              throw fault(409, 'NODE_SESSION', 'Register a current node heartbeat before polling.');
            }
            const active = sql("SELECT * FROM messages WHERE node_id = ? AND status = 'delivering' AND session_id = ? ORDER BY created_at, rowid LIMIT 1").get(nodeId, sessionId);
            if (active) return active;
            // M4: this poll is the owning node's chance to report evidence about an
            // uncertain message from its durable receipt. Counting chances is what
            // lets the hub later say "no evidence will arrive" honestly.
            sql("UPDATE messages SET uncertain_polls = uncertain_polls + 1 WHERE node_id = ? AND status = 'uncertain' AND settlement = 'awaiting-node-evidence'").run(nodeId);
            // Deferred work is untouched work, so it is handed out again once its
            // backoff elapses; uncertain work never is.
            const queued = sql("SELECT * FROM messages WHERE node_id = ? AND (status = 'queued' OR (status = 'deferred' AND COALESCE(retry_not_before, 0) <= ?)) ORDER BY created_at, rowid LIMIT 1").get(nodeId, Date.now());
            if (!queued) return null;
            if (!JSON.parse(node.targets_json).includes(queued.target)) {
              sql("UPDATE messages SET status = 'failed', updated_at = ?, error_json = ? WHERE id = ?").run(
                Date.now(), JSON.stringify({ code: 'UNKNOWN_TARGET', message: `Node has no configured target named ${queued.target}.` }), queued.id,
              );
              return null;
            }
            sql("UPDATE messages SET status = 'delivering', claim_id = ?, session_id = ?, updated_at = ?, attempts = attempts + 1 WHERE id = ?").run(randomUUID(), sessionId, Date.now(), queued.id);
            return getMessage(queued.id);
          });
          respond(res, 200, { message: claimed ? { ...publicMessage(claimed), claimId: claimed.claim_id } : null });
          return;
        }
        const statusPath = /^\/messages\/([^/]+)$/.exec(url.pathname);
        if (req.method === 'GET' && statusPath) {
          const row = getMessage(uuid(statusPath[1], 'id'));
          // A node may read its own receipt; enumerating other queues stays admin only.
          if (!actor.admin) requireNodeCredential(actor, row.node_id, row);
          respond(res, 200, publicMessage(row));
          return;
        }
        const ackPath = /^\/messages\/([^/]+)\/ack$/.exec(url.pathname);
        if (req.method === 'POST' && ackPath) {
          const id = uuid(ackPath[1], 'id');
          const body = await readJson(req);
          onlyKeys(body, ['nodeId', 'claimId', 'status', 'result', 'error']);
          const nodeId = identifier(body.nodeId, 'nodeId');
          const claimId = uuid(body.claimId, 'claimId');
          if (!['delivered', 'failed', 'uncertain', 'deferred'].includes(body.status)) throw fault(400, 'INVALID_STATUS', 'Invalid delivery acknowledgment status.');
          const row = getMessage(id);
          // H1: the credential, not the self-reported nodeId, decides who may
          // settle this row; a mismatch is a security event, not a client bug.
          requireNodeCredential(actor, nodeId, row);
          if (row.node_id !== nodeId || row.claim_id !== claimId) throw fault(409, 'CLAIM_CONFLICT', 'Acknowledgment does not match the claimed message.');
          let result = null;
          let error = null;
          if (body.status === 'delivered') {
            onlyKeys(body.result, ['status', 'outcome', 'messageId']);
            const expected = row.mode === 'submit' ? 'submitted' : 'drafted';
            if (body.error != null || body.result.status !== expected || body.result.outcome !== `input-${expected}` || body.result.messageId !== id) {
              throw fault(400, 'INVALID_RESULT', 'Delivery result does not match message mode and id.');
            }
            result = JSON.stringify({ status: expected, outcome: `input-${expected}`, messageId: id });
          } else {
            onlyKeys(body.error, ['code', 'message']);
            if (body.result != null || typeof body.error.code !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(body.error.code) || typeof body.error.message !== 'string' || !body.error.message || body.error.message.length > 2048) {
              throw fault(400, 'INVALID_RESULT', 'A failed, deferred or uncertain delivery requires a bounded error code and message.');
            }
            error = JSON.stringify({ code: body.error.code, message: body.error.message });
          }
          const now = Date.now();
          if (['delivered', 'failed', 'expired'].includes(row.status)) {
            if (row.status !== body.status || row.result_json !== result || row.error_json !== error) {
              throw fault(409, 'OUTCOME_CONFLICT', 'A final delivery outcome cannot be altered.');
            }
          } else if (row.status === 'deferred') {
            // Replaying the same deferral is idempotent; settling it needs a claim.
            if (body.status !== 'deferred' || row.error_json !== error) {
              throw fault(409, 'OUTCOME_CONFLICT', 'A deferred delivery must be claimed again before it can be settled.');
            }
          } else if (row.status === 'uncertain' && body.status === 'deferred') {
            throw fault(409, 'OUTCOME_CONFLICT', 'A deferral can only report an active claim, not an uncertain message.');
          } else if (row.status === 'delivering' || row.status === 'uncertain') {
            if (body.status === 'deferred') {
              const deferrals = row.deferrals + 1;
              sql("UPDATE messages SET status = 'deferred', deferrals = ?, retry_not_before = ?, result_json = NULL, error_json = ?, updated_at = ? WHERE id = ?").run(
                deferrals, now + Math.min(DEFERRAL_BASE_MS * 2 ** (deferrals - 1), DEFERRAL_MAX_MS), error, now, id,
              );
            } else if (body.status === 'uncertain') {
              sql("UPDATE messages SET status = 'uncertain', ever_uncertain = 1, uncertain_at = ?, uncertain_deadline = ?, uncertain_polls = 0, settlement = 'awaiting-node-evidence', result_json = NULL, error_json = ?, updated_at = ? WHERE id = ?").run(
                now, now + settleMs, error, now, id,
              );
            } else {
              const settlement = !row.ever_uncertain ? null
                : row.settlement === 'no-evidence-budget-exhausted' ? 'resolved-by-node-late' : 'resolved-by-node';
              sql('UPDATE messages SET status = ?, settlement = ?, result_json = ?, error_json = ?, updated_at = ? WHERE id = ?').run(
                body.status, settlement, result, error, now, id,
              );
            }
          } else {
            // 'queued' rows fail the claim match above, so this is the last state.
            throw fault(409, 'OUTCOME_CONFLICT', `Message in status ${row.status} cannot be acknowledged.`);
          }
          respond(res, 200, publicMessage(getMessage(id)));
          return;
        }
        throw fault(404, 'NOT_FOUND', 'Route not found.');
      } catch (error) {
        req.resume();
        if (!res.headersSent && !res.destroyed) {
          const status = Number.isInteger(error.status) ? error.status : 500;
          if (status === 500) process.stderr.write(`openacom hub: ${error.message}\n`);
          respond(res, status, {
            error: {
              code: error.code || 'INTERNAL_ERROR',
              message: status === 500 ? 'Internal hub error.' : error.message,
              ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}),
            },
          });
        }
      }
    });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    server.maxHeadersCount = 32;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host.replace(/^\[|\]$/g, ''), () => { server.removeListener('error', reject); resolve(); });
    });
    // F2: an 'inherited' acl means secure-fs could not take the store away from
    // other accounts; saying so at boot is the whole point of reporting it.
    process.stderr.write(`openacom hub: queue store ${store.file} acl=${store.acl}${store.acl === secureFs.PRIVATE ? '' : ' (credential digests are not private to this account; see lib/secure-fs.js)'}\n`);
    server.once('close', () => store.close());
    return server;
  } catch (error) {
    if (server && server.listening) server.close();
    store.close();
    throw error;
  }
}

function deliveryError(error) {
  return {
    code: error && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'DELIVERY_ERROR',
    message: String(error && error.message || 'Delivery failed without a diagnostic.').slice(0, 2048),
  };
}

async function runNode({ url, token, nodeId, dataDir, targetsFile, historyRetentionMs, onStarted } = {}) {
  endpoint(url);
  identifier(nodeId, 'nodeId');
  // After registration a node only ever uses its own credential, so the hub
  // bootstrap token is needed just once and can then be withdrawn from the box.
  const bootstrap = token === undefined || token === null || token === '' ? null : tokenValue(token);
  const retentionMs = positiveNumber(historyRetentionMs ?? process.env.AGENTRELAY_HISTORY_RETENTION_MS, 'historyRetentionMs', HISTORY_RETENTION_MS);
  const delivery = require('./delivery');
  try {
    const mode = fs.statSync(targetsFile).mode;
    const problem = targetFilePermissionProblem(mode);
    if (problem) {
      throw new Error(`Refusing to load targets file with mode ${(mode & 0o777).toString(8)}: ${problem}. The file holds IPC secrets; chmod 600 it first.`);
    }
    if (process.platform === 'win32') {
      // Mode bits mean nothing here, and taking the file away from other accounts
      // is the targets-file owner's job, not this process's, so say who must keep
      // access instead of pretending the gate was checked.
      process.stderr.write(`openacom node ${nodeId}: warning: file ACLs are not verified on Windows; keep ${path.basename(targetsFile)} readable only by this account (icacls "${targetsFile}" /inheritance:r /grant:r "${secureFs.currentPrincipal() || '<principal>'}":R).\n`);
    }
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Targets file not found: ${targetsFile}`);
    throw error;
  }
  const targets = await delivery.loadTargets(targetsFile);
  const names = Object.keys(targets);
  if (names.length > 128) throw new Error('At most 128 local targets may be advertised.');
  names.forEach((name) => identifier(name, 'target'));
  const filename = `node-${createHash('sha256').update(nodeId).digest('hex')}.sqlite`;
  const store = openStore(dataDir, filename);
  const { db, sql } = store;
  let stopped = false;
  let timer;
  let heartbeatPending;
  let fatal;
  const stop = () => { stopped = true; };
  const client = { url, token: null };
  const sessionId = randomUUID();
  const log = (message) => process.stderr.write(`openacom node ${nodeId}: ${message}\n`);
  // F2: this store holds the plaintext node credential, so its real ACL is
  // stated at startup rather than assumed.
  log(`receipt store ${store.file} acl=${store.acl}${store.acl === secureFs.PRIVATE ? '' : ' (the node credential in it is not private to this account; see lib/secure-fs.js)'}`);
  // F1: the decision belongs to desktop-delivery; this only reports what that
  // module would do for a submit that arrives with no per-message consent.
  if (names.some((name) => targets[name].type !== 'terminal')) {
    const gate = require('./desktop-delivery').consentFailure(false);
    log(gate
      ? 'desktop targets refuse submit unless the message carries consent:true'
      : 'desktop targets accept submit because this process environment grants consent');
  }
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, claim_id TEXT NOT NULL,
      status TEXT NOT NULL, result_json TEXT, error_json TEXT, pending_ack INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );`);
    ensureColumns(store, 'receipts', { settled: 'INTEGER NOT NULL DEFAULT 0', deferrals: 'INTEGER NOT NULL DEFAULT 0' });
    let instance = sql("SELECT value FROM settings WHERE key = 'instanceId'").get();
    if (!instance) {
      instance = { value: randomUUID() };
      sql("INSERT INTO settings (key, value) VALUES ('instanceId', ?)").run(instance.value);
    }
    // H1: prefer the credential the hub issued to this node id, so a node that
    // has registered once never needs the shared bootstrap token again.
    const stored = sql("SELECT value FROM settings WHERE key = 'nodeToken'").get();
    if (!stored && !bootstrap) {
      throw new Error('AGENTRELAY_TOKEN (the hub bootstrap credential) is required to register a new node id.');
    }
    client.token = stored ? stored.value : bootstrap;
    sql("UPDATE receipts SET status = 'uncertain', error_json = ?, pending_ack = 1, updated_at = ? WHERE status = 'delivering'").run(
      JSON.stringify({ code: 'NODE_RESTARTED', message: 'Node restarted during delivery; input may have been submitted. It will not be replayed.' }), Date.now(),
    );
    const heartbeat = () => request(client, 'POST', `/nodes/${nodeId}/heartbeat`, { instanceId: instance.value, sessionId, targets: names })
      .then((response) => {
        if (response && typeof response.nodeToken === 'string' && response.nodeToken !== client.token) {
          client.token = response.nodeToken;
          sql("INSERT OR REPLACE INTO settings (key, value) VALUES ('nodeToken', ?)").run(response.nodeToken);
          if (response.credentialRotated) log('hub reissued this node credential; the previous holder of this node id is locked out');
        }
        return response;
      });
    const acknowledge = async (receipt) => {
      const settled = await request(client, 'POST', `/messages/${receipt.id}/ack`, {
        nodeId, claimId: receipt.claim_id, status: receipt.status,
        result: receipt.result_json ? JSON.parse(receipt.result_json) : null,
        error: receipt.error_json ? JSON.parse(receipt.error_json) : null,
      });
      // M6: a receipt may only be forgotten once the hub agrees the message is
      // terminal, because the receipt is what stops a redelivery re-running the
      // UI call.
      sql('UPDATE receipts SET pending_ack = 0, settled = ? WHERE id = ?').run(settled && settled.terminal ? 1 : 0, receipt.id);
    };
    const processMessage = async (message) => {
      object(message);
      const input = messageInput({ id: message.id, to: message.to, target: message.target, text: message.text, mode: message.mode, consent: message.consent });
      const claimId = uuid(message.claimId, 'claimId');
      if (input.to !== nodeId || message.status !== 'delivering') throw new Error('Hub returned a message that was not claimed by this node.');
      const payload = JSON.stringify(input);
      const samePayload = (stored) => {
        try {
          const previous = JSON.parse(stored);
          // A receipt written before the consent field existed carries no flag,
          // which means the same thing as false; byte equality would refuse to
          // settle it after an upgrade.
          return previous.id === input.id && previous.to === input.to && previous.target === input.target
            && previous.text === input.text && previous.mode === input.mode && (previous.consent === true) === input.consent;
        } catch { return false; }
      };
      let receipt = sql('SELECT * FROM receipts WHERE id = ?').get(input.id);
      if (receipt) {
        if (!samePayload(receipt.payload_json)) throw fault(409, 'RECEIPT_CONFLICT', 'Hub claim conflicts with the durable local receipt. Refusing to replay.');
        if (receipt.status === 'delivering') throw new Error('Unresolved local delivery receipt; refusing to replay.');
        // A deferral proved the target was untouched, so a fresh claim of the
        // same message is a safe re-attempt rather than a duplicate side effect.
        const redelivery = receipt.status === 'deferred' && receipt.claim_id !== claimId;
        if (!redelivery) {
          if (receipt.claim_id !== claimId) throw fault(409, 'RECEIPT_CONFLICT', 'Hub claim conflicts with the durable local receipt. Refusing to replay.');
          await acknowledge(receipt);
          return;
        }
        log(`${input.id} re-attempt: previous attempt deferred with ${receipt.error_json ? JSON.parse(receipt.error_json).code : 'no code'}`);
      }
      // Commit BEFORE any UI call. A crash from here onward is uncertain, never automatically retried.
      if (receipt) {
        sql("UPDATE receipts SET status = 'delivering', claim_id = ?, result_json = NULL, error_json = NULL, pending_ack = 1, settled = 0, updated_at = ? WHERE id = ?").run(claimId, Date.now(), input.id);
      } else {
        sql("INSERT INTO receipts (id, payload_json, claim_id, status, pending_ack, updated_at) VALUES (?, ?, ?, 'delivering', 1, ?)").run(input.id, payload, claimId, Date.now());
      }
      let status;
      let result = null;
      let error = null;
      try {
        if (!Object.hasOwn(targets, input.target)) {
          throw Object.assign(new Error(`No local target named ${input.target}.`), { code: 'UNKNOWN_TARGET', uncertain: false });
        }
        const outcome = await delivery.deliver(targets[input.target], input.text, { mode: input.mode, messageId: input.id, consent: input.consent });
        const expected = input.mode === 'submit' ? 'submitted' : 'drafted';
        if (!outcome || outcome.status !== expected || outcome.outcome !== `input-${expected}` || outcome.messageId !== input.id) {
          throw Object.assign(new Error('Delivery adapter returned an unrecognized outcome after the UI call.'), { code: 'INVALID_DELIVERY_RESULT', uncertain: true });
        }
        status = 'delivered';
        result = JSON.stringify({ status: expected, outcome: `input-${expected}`, messageId: input.id });
      } catch (failure) {
        // M5: 'deferred' means the adapter proved it never touched the target,
        // which is not the same claim as 'uncertain', so the two never share a
        // path from here on.
        const classified = classifyFailure(failure);
        status = classified.status;
        error = JSON.stringify({ ...deliveryError(failure), code: classified.code });
      }
      // If this durable write fails, leave the pre-delivery receipt intact and terminate rather than replay.
      sql('UPDATE receipts SET status = ?, result_json = ?, error_json = ?, pending_ack = 1, deferrals = deferrals + ?, updated_at = ? WHERE id = ?')
        .run(status, result, error, status === 'deferred' ? 1 : 0, Date.now(), input.id);
      receipt = sql('SELECT * FROM receipts WHERE id = ?').get(input.id);
      await acknowledge(receipt);
      // F1/M5: the operator must learn the next step from the log line itself, so
      // a refused desktop submit does not read like a transport problem.
      const code = error ? JSON.parse(error).code : 'none';
      const detail = status === 'delivered' ? `${JSON.parse(result).outcome}; no model response implied`
        : status === 'deferred' ? `${code}; target untouched, attempt ${receipt.deferrals}/${MAX_DEFERRALS}`
        : status === 'uncertain' ? `${code}; input may already have landed, never redelivered`
        : `${code}; terminal, not retried${code === 'CONSENT_REQUIRED' ? ' - send mode "draft", or consent:true from an approved caller' : ''}`;
      log(`${input.id} ${status} (${detail})`);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    if (onStarted !== undefined) { if (typeof onStarted !== 'function') throw new TypeError('onStarted must be a function'); onStarted({ nodeId, pid: process.pid }); }
    let registered = false;
    let retryMs = 1000;
    let lastMaintenance = 0;
    timer = setInterval(() => {
      if (!registered || heartbeatPending) return;
      heartbeatPending = heartbeat().catch((error) => {
        if (error.status === 409 || error.status === 401 || error.status === 403) fatal = error;
        log(`heartbeat unavailable: ${error.message}`);
      }).finally(() => { heartbeatPending = null; });
    }, HEARTBEAT_MS);
    while (!stopped) {
      if (fatal) throw fatal;
      try {
        if (!registered) { await heartbeat(); registered = true; }
        const pending = sql('SELECT * FROM receipts WHERE pending_ack = 1 ORDER BY updated_at, rowid').all();
        for (const receipt of pending) await acknowledge(receipt);
        if (stopped) break;
        // M6 cleanup rides on the poll loop - no timer, so a test process can
        // exit without waiting on anything.
        const now = Date.now();
        if (now - lastMaintenance >= MAINTENANCE_MS) {
          lastMaintenance = now;
          sql('DELETE FROM receipts WHERE settled = 1 AND pending_ack = 0 AND updated_at <= ?').run(now - retentionMs);
        }
        const response = await request(client, 'GET', `/messages?to=${encodeURIComponent(nodeId)}&sessionId=${sessionId}`);
        if (fatal) throw fatal;
        if (stopped) break;
        if (!response || !Object.hasOwn(response, 'message')) throw new Error('Hub returned an invalid poll response.');
        if (response.message) await processMessage(response.message);
        retryMs = 1000;
        if (!response.message) await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        if (error.code && error.code.startsWith('ERR_SQLITE')) throw error;
        if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429 && error.code !== 'NODE_SESSION') throw error;
        registered = false;
        log(`hub unavailable; retaining durable receipts: ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, retryMs));
        retryMs = Math.min(retryMs * 2, 15000);
      }
    }
  } finally {
    clearInterval(timer);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (heartbeatPending) await heartbeatPending;
    store.close();
  }
}

module.exports = {
  runHub, runNode, request, classifyFailure, targetFilePermissionProblem, MAX_DEFERRALS, DEFERRABLE_CODES,
};
