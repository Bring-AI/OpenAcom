'use strict';
// The one implementation behind both entry points: no CLI semantics, nothing on stdout, no process.exit, no side effect before a call.
// Errors thrown here always carry `code`, and `uncertain` matches lib/delivery.js: false means the target was provably untouched.

const path = require('path');
const { homedir } = require('os');

const ADDRESS = /^(zcode|claude|codex|opencode):\S+$/;
const MAILBOX_ADDRESS = /^[A-Za-z][A-Za-z0-9_.-]*:\S+$/;
const MAILBOX_ID_MAX = 200;

// Lazy so requiring this module opens no store, spawns no child and binds no port.
const core = () => require('./core');
const mailboxStore = () => require('./inbox');
const failure = (code, message, uncertain = false) => require('./delivery').failure(code, message, uncertain);

const DERIVED_CODES = [
  [/^session not found/, 'SESSION_NOT_FOUND'],
  [/session id exists in/, 'AMBIGUOUS_SESSION'],
  [/^target session not found/, 'SESSION_NOT_FOUND'],
  [/unknown agent/, 'UNKNOWN_AGENT'],
  [/^unknown message id/, 'NOT_FOUND'],
];

// These codes all prove the refusal happened before anything reached a target, so uncertain is false whatever the caller asked for.
const CERTAIN_CODES = new Set(['SESSION_NOT_FOUND', 'AMBIGUOUS_SESSION', 'UNKNOWN_AGENT', 'INVALID_ARGUMENT', 'NOT_FOUND']);

// A 4xx from the hub is a definitive refusal; anything else may already have landed.
function annotated(error, code, uncertain) {
  const original = error instanceof Error ? error : failure(code, String((error && error.message) || error), uncertain);
  const defined = typeof original.code === 'string' && original.code;
  const derived = defined ? original.code : (DERIVED_CODES.find(([pattern]) => pattern.test(original.message || '')) || [])[1] || code;
  const refused = (Number.isInteger(original.status) && original.status >= 400 && original.status < 500) || CERTAIN_CODES.has(derived);
  return Object.assign(original, {
    code: derived,
    uncertain: typeof original.uncertain === 'boolean' ? original.uncertain : (refused ? false : uncertain),
  });
}

function call(action, code, uncertain) {
  try { return action(); } catch (error) { throw annotated(error, code, uncertain); }
}

async function attempt(action, code, uncertain) {
  try { return await action(); } catch (error) { throw annotated(error, code, uncertain); }
}

function requireText(value, name, maxLength) {
  if (typeof value !== 'string' || !value.trim()) throw failure('INVALID_ARGUMENT', `${name} must be a non-empty string`);
  if (maxLength && Buffer.byteLength(value, 'utf8') > maxLength) throw failure('INVALID_ARGUMENT', `${name} exceeds ${maxLength} UTF-8 bytes`);
  return value;
}

// The agent keys this build knows, taken from the adapter registry rather than a copy.
function agents() {
  return Object.keys(core().ADAPTERS);
}

// An unknown agent name must not come back as "no sessions", which is what a missing registry key looks like downstream.
function requireAgent(agent) {
  if (agent === undefined || agent === null) return;
  if (typeof agent !== 'string' || !core().ADAPTERS[agent]) throw failure('UNKNOWN_AGENT', `unknown agent "${agent}" (expected ${agents().join(' | ')})`);
}

// The adapter that owns this id, with the published wording kept for callers that match on it.
function knownSession(sessionId, agent) {
  const hits = core().findSession(sessionId, agent);
  if (hits.length === 0) throw failure('SESSION_NOT_FOUND', `session not found: ${sessionId}`);
  if (hits.length > 1) throw failure('AMBIGUOUS_SESSION', `session id exists in ${hits.map((h) => h.name).join(' & ')}; pass agent`);
  return hits[0];
}

function scanSessions(opts) {
  let rows = [];
  const adapters = opts.agent ? [core().ADAPTERS[opts.agent]] : Object.values(core().ADAPTERS);
  for (const adapter of adapters) {
    if (!adapter.available()) continue;
    rows.push(...adapter.list(0));
  }
  if (opts.query) {
    const terms = String(opts.query).toLowerCase().split(/\s+/).filter(Boolean);
    rows = rows.filter((row) => {
      const hay = `${row.agent} ${row.id} ${row.title} ${row.workspace}`.toLowerCase();
      return terms.every((term) => hay.includes(term));
    });
  }
  rows.sort((x, y) => y.mtime - x.mtime);
  return opts.limit && opts.limit > 0 ? rows.slice(0, opts.limit) : rows;
}

// Every session across the agents this machine can read, newest first: [{ agent, id, title, workspace, mtime }, ...].
function listSessions(opts = {}) {
  requireAgent(opts.agent);
  return call(() => scanSessions(opts), 'SESSION_QUERY_FAILED', false);
}

// The last turns of one session: [{ role, text }, ...]; pass opts.agent when an id exists in more than one agent.
function readSession(sessionId, opts = {}) {
  requireText(sessionId, 'sessionId', 200);
  requireAgent(opts.agent);
  return call(() => knownSession(sessionId, opts.agent).messages(sessionId, opts.last || 10), 'SESSION_READ_FAILED', false);
}

// Deliver with the adapter's own semantics and return what it gave back; opts: { agent, fresh, noWait, timeoutMs, desktop, cwd }.
async function send(sessionId, message, opts = {}) {
  if (opts.fresh) return attempt(() => core().ADAPTERS.zcode.sendFresh(message, opts), 'SEND_FAILED', true);
  const adapter = call(() => knownSession(sessionId, opts.agent), 'SEND_FAILED', false);
  return attempt(() => adapter.send(sessionId, message, opts), 'SEND_FAILED', true);
}

// Send with a read receipt: lib/inbox.js redelivers until the target acks, up to maxAttempts, then reports status 'failed'.
async function sendTracked(sessionId, message, { from = 'sdk', agent, ackTimeoutMs, maxAttempts, pollMs, sendOpts } = {}) {
  const adapter = call(() => knownSession(sessionId, agent), 'SEND_FAILED', false);
  return attempt(() => mailboxStore().trackedSend(adapter, sessionId, from, message, {
    ackTimeoutMs, maxAttempts, pollMs, sendOpts: sendOpts || {},
  }), 'SEND_FAILED', true);
}

function sendOptions(opts) {
  const sendOpts = {};
  if (opts.timeoutMs !== undefined) sendOpts.timeoutMs = opts.timeoutMs;
  if (opts.desktop === true || opts.desktop === false) sendOpts.desktop = opts.desktop;
  sendOpts.noWait = opts.wait !== true;
  return sendOpts;
}

// `send` with argument checks and a mandatory sender, so the receiver can see who wrote to it exactly as over MCP.
async function sendMessage(agent, sessionId, text, opts = {}) {
  requireText(sessionId, 'sessionId', 200);
  requireText(text, 'text', 65536);
  if (typeof agent !== 'string' || !agent.trim()) throw failure('INVALID_ARGUMENT', 'agent must name one of zcode | claude | codex | opencode');
  const from = typeof opts.from === 'string' ? opts.from.trim() : '';
  if (!ADDRESS.test(from)) throw failure('INVALID_ARGUMENT', `opts.from must be "agent:sessionId" of the sender, got ${JSON.stringify(from)}`);
  // The tracked path carries the raw text because lib/inbox.js appends its own receipt footer.
  if (opts.requireRead) {
    return sendTracked(sessionId, text, {
      from, agent, ackTimeoutMs: opts.ackTimeoutMs, maxAttempts: opts.maxAttempts, pollMs: opts.pollMs,
      sendOpts: sendOptions(opts),
    });
  }
  const message = opts.noSignature ? text : `${text}\n\n[via OpenAcom · from ${from}]`;
  return send(sessionId, message, { agent, ...sendOptions(opts) });
}

// Hub connection settings for one call, defaulting to AGENTRELAY_URL / AGENTRELAY_TOKEN.
function connection(opts) {
  const base = require('./distributed-cli').connection();
  return { url: opts.url === undefined ? base.url : opts.url, token: opts.token === undefined ? base.token : opts.token };
}

// Queue a message on a relay node; opts: { url, token, mode, id, consent }.
async function relaySend(to, target, text, opts = {}) {
  requireText(to, 'to', 64);
  requireText(target, 'target', 64);
  requireText(text, 'text', 65536);
  if (opts.consent !== undefined && typeof opts.consent !== 'boolean') throw failure('INVALID_ARGUMENT', 'consent must be the boolean true or false');
  // An omitted mode stays absent so the destination chooses draft or submit for its own target type.
  const body = {
    to, target, text,
    ...(opts.mode === undefined || opts.mode === null ? {} : { mode: opts.mode }),
    ...(opts.id === undefined ? {} : { id: opts.id }),
    ...(opts.consent === undefined ? {} : { consent: opts.consent }),
  };
  return attempt(() => require('./distributed').request(connection(opts), 'POST', '/messages', body), 'RELAY_UNAVAILABLE', true);
}

// Durable delivery state of one relay message, including status, attempts, retryable and terminal.
async function relayStatus(id, opts = {}) {
  requireText(id, 'id', 200);
  return attempt(() => require('./distributed').request(connection(opts), 'GET', `/messages/${encodeURIComponent(id)}`), 'RELAY_UNAVAILABLE', false);
}

// The hub's fleet view: nodes, credential fingerprints, security alerts and the queue store acl.
async function relayNodes(opts = {}) {
  return attempt(() => require('./distributed').request(connection(opts), 'GET', '/nodes'), 'RELAY_UNAVAILABLE', false);
}

// Raw lib/inbox.js accessors, kept as one namespace because the published relay.inbox.* shape has a single implementation.
const mailbox = {
  list: (opts) => call(() => mailboxStore().list(opts), 'INBOX_READ_FAILED', false),
  get: (id) => call(() => mailboxStore().get(id), 'INBOX_READ_FAILED', false),
  markRead: (id, via) => call(() => mailboxStore().markRead(id, via), 'INBOX_WRITE_FAILED', false),
  path: () => mailboxStore().DB_PATH(),
};

function mailboxRow(row) {
  return {
    id: row.id, from: row.from_addr, to: row.to_addr, status: row.status, delivery: row.delivery || undefined,
    attempts: row.attempts, maxAttempts: row.max_attempts, updatedAt: row.updated_at,
    readAt: row.read_at || undefined, lastError: row.last_error || undefined,
  };
}

// Same-machine mailbox rows as plain objects; opts: { status, from, to, limit }. `relay.inbox` stays the raw-rows namespace.
function inboxMessages(opts = {}) {
  return mailbox.list({
    status: opts.status,
    fromAddr: typeof opts.from === 'string' && opts.from.trim() ? opts.from.trim() : undefined,
    toAddr: typeof opts.to === 'string' && opts.to.trim() ? opts.to.trim() : undefined,
    limit: opts.limit && opts.limit > 0 ? opts.limit : 30,
  }).map(mailboxRow);
}

// One mailbox row, or null when this machine never saw it.
function inboxMessage(id) {
  requireText(id, 'id', 200);
  const row = mailbox.get(id.trim());
  return row ? mailboxRow(row) : null;
}

// Post to another address's mailbox without touching any adapter, so neither side needs a live session.
function postMessage(from, to, text, opts = {}) {
  requireText(text, 'text', 65536);
  for (const [name, value] of [['from', from], ['to', to]]) {
    if (typeof value !== 'string' || !MAILBOX_ADDRESS.test(value.trim())) {
      throw failure('INVALID_ARGUMENT', `${name} must be "agent:sessionId", e.g. "${name === 'from' ? 'codex:sess_1' : 'qoder:boss'}"`);
    }
  }
  if (opts.id !== undefined) requireText(opts.id, 'id', MAILBOX_ID_MAX);
  const posted = call(() => mailboxStore().post({
    id: opts.id === undefined ? undefined : opts.id.trim(), fromAddr: from.trim(), toAddr: to.trim(), text,
  }), 'INBOX_WRITE_FAILED', false);
  return { ...mailboxRow(posted.row), ok: true, ...(posted.replayed ? { replayed: true } : {}) };
}

// Mark a received mailbox item read, which is what stops a tracked send from redelivering it.
function ackMessage(id, opts = {}) {
  requireText(id, 'id', 200);
  const row = mailbox.markRead(id.trim(), typeof opts.via === 'string' && opts.via ? opts.via : 'ack_message');
  return { ok: true, id: row.id, status: row.status, readAt: row.read_at };
}

// Where this installation keeps its stores and what it can reach; same field names as the get_paths MCP tool.
function getPaths() {
  const { resolveZcodeCli, zcodeConfigPath, whichCli } = require('./util');
  const mcp = require('./mcp');
  let opencodeCli = null;
  try { opencodeCli = require('./adapters/opencode').cliPath(); } catch { /* keep null */ }
  return {
    zcodeDb: path.join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite'),
    zcodeCli: resolveZcodeCli() || null,
    zcodeHeadlessConfig: zcodeConfigPath(),
    claudeProjects: path.join(homedir(), '.claude', 'projects'),
    claudeCli: whichCli('claude') || null,
    codexSessions: path.join(homedir(), '.codex', 'sessions'),
    codexCli: whichCli('codex') || null,
    opencodeDb: path.join(homedir(), '.local', 'share', 'opencode', 'opencode.db'),
    opencodeCli,
    inboxDb: mailbox.path(),
    logDir: mcp.traceDir(),
    logDirAcl: mcp.traceAcl(),
    inboxAcl: mailboxStore().acl(),
  };
}

const sendRouted = (to, text, opts) => require('./routing').sendRouted(to, text, opts);

module.exports = {
  sendRouted,
  agents, listSessions, readSession, send, sendTracked, sendMessage,
  relaySend, relayStatus, relayNodes, mailbox, inboxMessages, inboxMessage, postMessage, ackMessage, getPaths,
};

