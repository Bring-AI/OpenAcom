'use strict';
// OpenAcom SDK - programmatic access for other Node tools.
//   const relay = require('openacom');
//   await relay.list();  await relay.sendTracked(...);  relay.inbox.list();
// Thin, stable surface over the same modules the CLI and MCP server use.
'use strict';

const { ADAPTERS, findSession } = require('./core');

// All sessions across available agents, newest first. opts: { agent, query, limit }
function listSessions(opts = {}) {
  let rows = [];
  const adapters = opts.agent ? [ADAPTERS[opts.agent]].filter(Boolean) : Object.values(ADAPTERS);
  for (const a of adapters) {
    if (!a.available()) continue;
    rows.push(...a.list(0));
  }
  if (opts.query) {
    const terms = String(opts.query).toLowerCase().split(/\s+/).filter(Boolean);
    rows = rows.filter((r) => {
      const hay = `${r.agent} ${r.id} ${r.title} ${r.workspace}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }
  rows.sort((x, y) => y.mtime - x.mtime);
  return opts.limit && opts.limit > 0 ? rows.slice(0, opts.limit) : rows;
}

// Last turns of one session: [{ role, text }, ...]
function readSession(sessionId, { agent, last = 10 } = {}) {
  const hits = findSession(sessionId, agent);
  if (hits.length === 0) throw new Error(`session not found: ${sessionId}`);
  if (hits.length > 1) throw new Error(`session id exists in ${hits.map((h) => h.name).join(' & ')}; pass agent`);
  return hits[0].messages(sessionId, last);
}

// Deliver a message to a session (or {fresh:true, cwd} for a new zcode
// session). Resolves with the reply when the adapter blocks, or an OK string
// for no-wait deliveries. opts: { agent, noWait, timeoutMs, desktop }
async function send(sessionId, message, opts = {}) {
  if (opts.fresh) return ADAPTERS.zcode.sendFresh(message, opts);
  const hits = findSession(sessionId, opts.agent);
  if (hits.length === 0) throw new Error(`session not found: ${sessionId}`);
  if (hits.length > 1) throw new Error(`session id exists in ${hits.map((h) => h.name).join(' & ')}; pass agent`);
  return hits[0].send(sessionId, message, opts);
}

// Tracked send with read receipt: redelivers until acknowledged (ack_message
// tool or an assistant reply containing ACK-<id>), maxAttempts total, then
// status 'failed'. Resolves { id, status, attempts, maxAttempts, ... }.
async function sendTracked(sessionId, message, { from = 'sdk', agent, ackTimeoutMs, maxAttempts, pollMs, sendOpts } = {}) {
  const hits = findSession(sessionId, agent);
  if (hits.length === 0) throw new Error(`session not found: ${sessionId}`);
  if (hits.length > 1) throw new Error(`session id exists in ${hits.map((h) => h.name).join(' & ')}; pass agent`);
  return require('./inbox').trackedSend(hits[0], sessionId, from, message, { ackTimeoutMs, maxAttempts, pollMs, sendOpts: sendOpts || {} });
}

module.exports = {
  listSessions,
  readSession,
  send,
  sendTracked,
  inbox: {
    list: (opts) => require('./inbox').list(opts),
    get: (id) => require('./inbox').get(id),
    markRead: (id) => require('./inbox').markRead(id),
    path: () => require('./inbox').DB_PATH(),
  },
  hooks: {
    EVENTS: () => require('./hooks').EVENTS,
    file: () => require('./hooks').hooksFile(),
    load: () => require('./hooks').loadHooks(),
  },
  web: {
    start: (port, opts) => require('./web').startWeb(port, opts),
  },
  adapters: ADAPTERS,
};
