'use strict';

const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { homedir } = require('os');
const { createHash, randomUUID, timingSafeEqual } = require('crypto');

const MAX_BODY = 512 * 1024;
const MAX_TEXT = 64 * 1024;
const LEASE_MS = 120000;
const HEARTBEAT_MS = 10000;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;

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
  onlyKeys(body, ['id', 'to', 'target', 'text', 'mode']);
  const id = body.id === undefined ? randomUUID() : uuid(body.id, 'id');
  const to = identifier(body.to, 'to');
  const target = identifier(body.target, 'target');
  const mode = body.mode === undefined ? 'submit' : body.mode;
  if (mode !== 'submit' && mode !== 'draft') throw fault(400, 'INVALID_MODE', 'mode must be submit or draft.');
  if (typeof body.text !== 'string' || !body.text.trim() || Buffer.byteLength(body.text, 'utf8') > MAX_TEXT || CONTROL.test(body.text)) {
    throw fault(400, 'INVALID_TEXT', 'text must be nonempty, at most 65536 UTF-8 bytes, and contain no terminal controls other than newline.');
  }
  // SQLite stores UTF-8; reject lone UTF-16 surrogates rather than changing a caller's text.
  if (body.text !== Buffer.from(body.text, 'utf8').toString('utf8')) {
    throw fault(400, 'INVALID_TEXT', 'text must contain valid Unicode.');
  }
  return { id, to, target, text: body.text, mode };
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

function openStore(dataDir, filename) {
  const directory = path.resolve(dataDir || path.join(homedir(), '.agentrelay', 'distributed'));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(directory, filename);
  const db = new DatabaseSync(file);
  let owner;
  const statements = new Map();
  const sql = (query) => {
    let statement = statements.get(query);
    if (!statement) { statement = db.prepare(query); statements.set(query, statement); }
    return statement;
  };
  try {
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
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
    db, sql,
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

function publicMessage(row) {
  return {
    id: row.id, to: row.node_id, target: row.target, text: row.text, mode: row.mode,
    status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    error: row.error_json ? JSON.parse(row.error_json) : null,
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

async function runHub({ host = '127.0.0.1', port = 9330, dataDir, token } = {}) {
  tokenValue(token);
  if (!loopback(host)) throw new Error('Hub must bind a loopback IP address; expose it using SSH or a TLS reverse proxy.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Hub port must be an integer from 0 to 65535.');
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
      CREATE INDEX IF NOT EXISTS message_queue ON messages (node_id, status, created_at);
    `);
    const uncertainError = (message) => JSON.stringify({ code: 'DELIVERY_UNCERTAIN', message });
    sql("UPDATE messages SET status = 'uncertain', updated_at = ?, error_json = ? WHERE status = 'delivering'").run(
      Date.now(), uncertainError('Hub restarted before delivery was acknowledged; input may have been submitted. It will not be replayed.'),
    );
    const authDigest = createHash('sha256').update(`Bearer ${token}`).digest();
    const expire = () => {
      sql("UPDATE messages SET status = 'uncertain', updated_at = ?, error_json = ? WHERE status = 'delivering' AND node_id IN (SELECT id FROM nodes WHERE last_seen < ?)").run(
        Date.now(), uncertainError('Node heartbeat expired before delivery was acknowledged; input may have been submitted. It will not be replayed.'), Date.now() - LEASE_MS,
      );
    };
    const getMessage = (id) => {
      const row = sql('SELECT * FROM messages WHERE id = ?').get(id);
      if (!row) throw fault(404, 'NOT_FOUND', 'Message not found.');
      return row;
    };
    server = http.createServer(async (req, res) => {
      try {
        const supplied = createHash('sha256').update(req.headers.authorization || '').digest();
        if (!timingSafeEqual(authDigest, supplied)) throw fault(401, 'UNAUTHORIZED', 'Bearer authentication required.');
        if (!req.url || req.url.length > 2048 || !req.url.startsWith('/') || req.url.startsWith('//')) {
          throw fault(400, 'INVALID_PATH', 'Invalid request path.');
        }
        const url = new URL(req.url, 'http://127.0.0.1');
        expire();
        if (req.method === 'POST' && url.pathname === '/messages') {
          const input = messageInput(await readJson(req));
          const existing = sql('SELECT * FROM messages WHERE id = ?').get(input.id);
          if (existing) {
            if (existing.node_id !== input.to || existing.target !== input.target || existing.text !== input.text || existing.mode !== input.mode) {
              throw fault(409, 'ID_CONFLICT', 'This message id is already associated with a different payload.');
            }
            respond(res, 200, publicMessage(existing));
          } else {
            const now = Date.now();
            sql("INSERT INTO messages (id, node_id, target, text, mode, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)").run(
              input.id, input.to, input.target, input.text, input.mode, now, now,
            );
            respond(res, 202, publicMessage(getMessage(input.id)));
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/nodes') {
          const nodes = sql('SELECT id, targets_json, last_seen FROM nodes ORDER BY id').all().map((node) => ({
            id: node.id, targets: JSON.parse(node.targets_json), lastSeen: node.last_seen, online: node.last_seen >= Date.now() - LEASE_MS,
          }));
          respond(res, 200, { nodes });
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
          transaction(store, () => {
            const previous = sql('SELECT * FROM nodes WHERE id = ?').get(nodeId);
            if (previous && previous.instance_id !== instanceId && previous.last_seen >= Date.now() - LEASE_MS) {
              throw fault(409, 'NODE_IN_USE', 'Another live node instance is registered with this node id.');
            }
            if (previous && previous.session_id !== sessionId) {
              sql("UPDATE messages SET status = 'uncertain', updated_at = ?, error_json = ? WHERE node_id = ? AND status = 'delivering'").run(
                Date.now(), uncertainError('Node session changed before acknowledgment; input may have been submitted. It will not be replayed.'), nodeId,
              );
            }
            sql('INSERT INTO nodes (id, instance_id, session_id, targets_json, last_seen) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET instance_id = excluded.instance_id, session_id = excluded.session_id, targets_json = excluded.targets_json, last_seen = excluded.last_seen').run(
              nodeId, instanceId, sessionId, JSON.stringify(body.targets), Date.now(),
            );
          });
          respond(res, 200, { ok: true, heartbeatMs: HEARTBEAT_MS });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/messages') {
          const nodeId = identifier(url.searchParams.get('to'), 'to');
          const sessionId = uuid(url.searchParams.get('sessionId'), 'sessionId');
          const claimed = transaction(store, () => {
            const node = sql('SELECT * FROM nodes WHERE id = ?').get(nodeId);
            if (!node || node.session_id !== sessionId || node.last_seen < Date.now() - LEASE_MS) {
              throw fault(409, 'NODE_SESSION', 'Register a current node heartbeat before polling.');
            }
            const active = sql("SELECT * FROM messages WHERE node_id = ? AND status = 'delivering' AND session_id = ? ORDER BY created_at, rowid LIMIT 1").get(nodeId, sessionId);
            if (active) return active;
            const queued = sql("SELECT * FROM messages WHERE node_id = ? AND status = 'queued' ORDER BY created_at, rowid LIMIT 1").get(nodeId);
            if (!queued) return null;
            if (!JSON.parse(node.targets_json).includes(queued.target)) {
              sql("UPDATE messages SET status = 'failed', updated_at = ?, error_json = ? WHERE id = ?").run(
                Date.now(), JSON.stringify({ code: 'UNKNOWN_TARGET', message: `Node has no configured target named ${queued.target}.` }), queued.id,
              );
              return null;
            }
            sql("UPDATE messages SET status = 'delivering', claim_id = ?, session_id = ?, updated_at = ? WHERE id = ?").run(randomUUID(), sessionId, Date.now(), queued.id);
            return getMessage(queued.id);
          });
          respond(res, 200, { message: claimed ? { ...publicMessage(claimed), claimId: claimed.claim_id } : null });
          return;
        }
        const statusPath = /^\/messages\/([^/]+)$/.exec(url.pathname);
        if (req.method === 'GET' && statusPath) {
          respond(res, 200, publicMessage(getMessage(uuid(statusPath[1], 'id'))));
          return;
        }
        const ackPath = /^\/messages\/([^/]+)\/ack$/.exec(url.pathname);
        if (req.method === 'POST' && ackPath) {
          const id = uuid(ackPath[1], 'id');
          const body = await readJson(req);
          onlyKeys(body, ['nodeId', 'claimId', 'status', 'result', 'error']);
          const nodeId = identifier(body.nodeId, 'nodeId');
          const claimId = uuid(body.claimId, 'claimId');
          if (!['delivered', 'failed', 'uncertain'].includes(body.status)) throw fault(400, 'INVALID_STATUS', 'Invalid delivery acknowledgment status.');
          const row = getMessage(id);
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
              throw fault(400, 'INVALID_RESULT', 'A failed or uncertain delivery requires a bounded error code and message.');
            }
            error = JSON.stringify({ code: body.error.code, message: body.error.message });
          }
          if (row.status === 'delivered' || row.status === 'failed') {
            if (row.status !== body.status || row.result_json !== result || row.error_json !== error) {
              throw fault(409, 'OUTCOME_CONFLICT', 'A final delivery outcome cannot be altered.');
            }
          } else if (row.status === 'delivering' || row.status === 'uncertain') {
            sql('UPDATE messages SET status = ?, result_json = ?, error_json = ?, updated_at = ? WHERE id = ?').run(body.status, result, error, Date.now(), id);
          } else throw fault(409, 'NOT_CLAIMED', 'Message has not been claimed for delivery.');
          respond(res, 200, publicMessage(getMessage(id)));
          return;
        }
        throw fault(404, 'NOT_FOUND', 'Route not found.');
      } catch (error) {
        req.resume();
        if (!res.headersSent && !res.destroyed) {
          const status = Number.isInteger(error.status) ? error.status : 500;
          if (status === 500) process.stderr.write(`agentrelay hub: ${error.message}\n`);
          respond(res, status, { error: { code: error.code || 'INTERNAL_ERROR', message: status === 500 ? 'Internal hub error.' : error.message } });
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

async function runNode({ url, token, nodeId, dataDir, targetsFile } = {}) {
  endpoint(url);
  tokenValue(token);
  identifier(nodeId, 'nodeId');
  const delivery = require('./delivery');
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
  const client = { url, token };
  const sessionId = randomUUID();
  const log = (message) => process.stderr.write(`agentrelay node ${nodeId}: ${message}\n`);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, claim_id TEXT NOT NULL,
      status TEXT NOT NULL, result_json TEXT, error_json TEXT, pending_ack INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );`);
    let instance = sql("SELECT value FROM settings WHERE key = 'instanceId'").get();
    if (!instance) {
      instance = { value: randomUUID() };
      sql("INSERT INTO settings (key, value) VALUES ('instanceId', ?)").run(instance.value);
    }
    sql("UPDATE receipts SET status = 'uncertain', error_json = ?, pending_ack = 1, updated_at = ? WHERE status = 'delivering'").run(
      JSON.stringify({ code: 'NODE_RESTARTED', message: 'Node restarted during delivery; input may have been submitted. It will not be replayed.' }), Date.now(),
    );
    const heartbeat = () => request(client, 'POST', `/nodes/${nodeId}/heartbeat`, { instanceId: instance.value, sessionId, targets: names });
    const acknowledge = async (receipt) => {
      await request(client, 'POST', `/messages/${receipt.id}/ack`, {
        nodeId, claimId: receipt.claim_id, status: receipt.status,
        result: receipt.result_json ? JSON.parse(receipt.result_json) : null,
        error: receipt.error_json ? JSON.parse(receipt.error_json) : null,
      });
      sql('UPDATE receipts SET pending_ack = 0 WHERE id = ?').run(receipt.id);
    };
    const processMessage = async (message) => {
      object(message);
      const input = messageInput({ id: message.id, to: message.to, target: message.target, text: message.text, mode: message.mode });
      const claimId = uuid(message.claimId, 'claimId');
      if (input.to !== nodeId || message.status !== 'delivering') throw new Error('Hub returned a message that was not claimed by this node.');
      const payload = JSON.stringify(input);
      let receipt = sql('SELECT * FROM receipts WHERE id = ?').get(input.id);
      if (receipt) {
        if (receipt.payload_json !== payload || receipt.claim_id !== claimId) throw fault(409, 'RECEIPT_CONFLICT', 'Hub claim conflicts with the durable local receipt. Refusing to replay.');
        if (receipt.status === 'delivering') throw new Error('Unresolved local delivery receipt; refusing to replay.');
        await acknowledge(receipt);
        return;
      }
      // Commit BEFORE any UI call. A crash from here onward is uncertain, never automatically retried.
      sql("INSERT INTO receipts (id, payload_json, claim_id, status, pending_ack, updated_at) VALUES (?, ?, ?, 'delivering', 1, ?)").run(input.id, payload, claimId, Date.now());
      let status;
      let result = null;
      let error = null;
      try {
        if (!Object.hasOwn(targets, input.target)) {
          throw Object.assign(new Error(`No local target named ${input.target}.`), { code: 'UNKNOWN_TARGET', uncertain: false });
        }
        const outcome = await delivery.deliver(targets[input.target], input.text, { mode: input.mode, messageId: input.id });
        const expected = input.mode === 'submit' ? 'submitted' : 'drafted';
        if (!outcome || outcome.status !== expected || outcome.outcome !== `input-${expected}` || outcome.messageId !== input.id) {
          throw Object.assign(new Error('Delivery adapter returned an unrecognized outcome after the UI call.'), { code: 'INVALID_DELIVERY_RESULT', uncertain: true });
        }
        status = 'delivered';
        result = JSON.stringify({ status: expected, outcome: `input-${expected}`, messageId: input.id });
      } catch (failure) {
        status = failure && failure.uncertain === false ? 'failed' : 'uncertain';
        error = JSON.stringify(deliveryError(failure));
      }
      // If this durable write fails, leave the pre-delivery receipt intact and terminate rather than replay.
      sql('UPDATE receipts SET status = ?, result_json = ?, error_json = ?, pending_ack = 1, updated_at = ? WHERE id = ?').run(status, result, error, Date.now(), input.id);
      receipt = sql('SELECT * FROM receipts WHERE id = ?').get(input.id);
      await acknowledge(receipt);
      log(`${input.id} ${status}${result ? ` (${JSON.parse(result).outcome}; no model response implied)` : ''}`);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    let registered = false;
    let retryMs = 1000;
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

module.exports = { runHub, runNode, request };
