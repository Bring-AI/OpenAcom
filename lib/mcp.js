'use strict';
// Stdio MCP server exposing AgentRelay as tools. Zero-dependency: MCP over
// stdio is newline-delimited JSON-RPC 2.0.
const { findSession } = require('./core');
const { resolveZcodeCli, zcodeConfigPath, whichCli } = require('./util');
const path = require('path');
const { homedir } = require('os');

const VERSION = require('../package.json').version;
const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];

const TOOLS = [
  {
    name: 'list_sessions',
    description: 'List recent sessions of the local and remote Claude Code / Codex / ZCode / OpenCode agents, newest first. Returns JSON rows with agent, id, title, workspace (ssh: prefix marks a remote Claude workspace), and update time.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: ['zcode', 'claude', 'codex', 'opencode'], description: 'Restrict to one agent' },
        query: { type: 'string', description: 'Fuzzy search terms (space-separated AND) matched case-insensitively against agent, session id, title and workspace. Search runs over all sessions; results are then capped by limit.' },
        limit: { type: 'number', description: 'Max rows (default 30)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_session',
    description: 'Read the last turns of a session (any agent). System noise is filtered out.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session id from list_sessions' },
        agent: { type: 'string', enum: ['zcode', 'claude', 'codex', 'opencode'] },
        last: { type: 'number', description: 'Number of turns to return (default 10)' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_message',
    description: 'Send a message to a session as a real user turn. from/to are mandatory "agent:sessionId" addresses (e.g. "zcode:sess_...", "claude:...", "codex:..."; to also accepts "zcode:new" for a fresh session). Fire-and-forget by default; wait:true blocks for the reply. The delivered message carries a [via AgentRelay · from <from>] footer so the target can reply back to the sender address.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Sender address "agent:sessionId" — the session you are running in. Find ids with list_sessions.' },
        to: { type: 'string', description: 'Target address "agent:sessionId", or "zcode:new" to run the message in a brand-new zcode session.' },
        message: { type: 'string' },
        wait: { type: 'boolean', default: false, description: 'true = block until the target finishes and return its reply (mind your own MCP timeout). Default false = return immediately; the reply lands in the target transcript (read with read_session).' },
        timeoutMs: { type: 'number', description: 'Only relevant with wait:true (default 300000).' },
        desktop: { type: 'boolean', description: 'zcode targets only. Default (omitted): CDP delivery through the desktop UI when the app runs with --remote-debugging-port (live refresh + steer; the app switches to that conversation), headless otherwise. false = silent headless, no view switch.' },
        noSignature: { type: 'boolean', description: 'Suppress the automatic [via AgentRelay · from ...] footer.' },
      },
      required: ['from', 'to', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_paths',
    description: 'Show detected session storage paths and CLI locations for diagnostics.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function listSessions(args) {
  const { ADAPTERS } = require('./core');
  const rows = [];
  const agent = args.agent;
  const terms = String(args.query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const adapters = agent ? [ADAPTERS[agent]].filter(Boolean) : Object.values(ADAPTERS);
  for (const a of adapters) {
    if (!a.available()) continue;
    rows.push(...a.list(0));
  }
  let filtered = rows;
  if (terms.length) {
    filtered = rows.filter((r) => {
      const hay = `${r.agent} ${r.id} ${r.title} ${r.workspace}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }
  filtered.sort((x, y) => y.mtime - x.mtime);
  const lim = args.limit && args.limit > 0 ? args.limit : 30;
  return JSON.stringify(filtered.slice(0, lim), null, 2);
}

function readSession(args) {
  const hits = findSession(args.sessionId, args.agent);
  if (hits.length === 0) throw new Error(`session not found: ${args.sessionId}`);
  if (hits.length > 1) throw new Error(`session id exists in ${hits.map((h) => h.name).join(' & ')}; pass "agent"`);
  const turns = hits[0].messages(args.sessionId, args.last || 10);
  if (!turns) throw new Error('session found but messages unreadable');
  return turns.map((t) => `[${t.role}] ${t.text}`).join('\n\n');
}

function sendMessage(args) {
  const from = String(args.from || '').trim();
  if (!from) throw new Error('"from" is required: "agent:sessionId" of the sender, e.g. "zcode:sess_..."');
  if (!/^(zcode|claude|codex|opencode):\S+/.test(from)) throw new Error(`invalid "from" (${from}): expected "agent:sessionId"`);
  const to = String(args.to || '').trim();
  if (!to) throw new Error('"to" is required: "agent:sessionId" of the target, or "zcode:new" for a fresh session');
  const tm = to.match(/^(zcode|claude|codex|opencode):(new|\S+)$/);
  if (!tm) throw new Error(`invalid "to" (${to}): expected "agent:sessionId" or "zcode:new"`);
  const targetAgent = tm[1];
  const fresh = tm[2] === 'new';
  if (fresh && targetAgent !== 'zcode') throw new Error('fresh sessions ("agent:new") are zcode-only');

  const opts = {};
  if (args.timeoutMs) opts.timeoutMs = args.timeoutMs;
  if (args.wait === true) opts.noWait = false; else opts.noWait = true;
  if (args.desktop === true) opts.desktop = true;
  else if (args.desktop === false) opts.desktop = false;

  const message = args.noSignature ? args.message : `${args.message}

[via AgentRelay · from ${from}]`;

  if (fresh) {
    const out = require('./adapters/zcode').sendFresh(message, opts);
    return JSON.stringify({ ok: true, from, to: `zcode:${out.id}`, sessionId: out.id, note: out.reply }, null, 2);
  }
  const sessionId = tm[2];
  const hits = findSession(sessionId, targetAgent);
  if (hits.length === 0) throw new Error(`target session not found on ${targetAgent}: ${sessionId} (check list_sessions)`);
  const a = hits[0];
  if (args.desktop === true) {
    if (a.name !== 'zcode' || typeof a.sendDesktop !== 'function') throw new Error('desktop delivery is zcode-only');
    return JSON.stringify({ ok: true, from, to, sessionId, delivery: 'desktop', note: a.sendDesktop(sessionId, message) }, null, 2);
  }
  const out = a.send(sessionId, message, opts);
  if (typeof out === 'string' && /OK (?:sent via CDP|\(no-wait\))/.test(out)) {
    return JSON.stringify({ ok: true, from, to, sessionId, delivery: out.includes('CDP') ? 'desktop-cdp' : 'no-wait', note: 'delivered; turn runs in the target (read_session to see the reply later)' }, null, 2);
  }
  return JSON.stringify({ ok: true, from, to, sessionId, reply: out }, null, 2);
}

function getPaths() {
  return JSON.stringify({
    zcodeDb: path.join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite'),
    zcodeCli: resolveZcodeCli() || null,
    zcodeHeadlessConfig: zcodeConfigPath(),
    claudeProjects: path.join(homedir(), '.claude', 'projects'),
    claudeCli: whichCli('claude') || null,
    codexSessions: path.join(homedir(), '.codex', 'sessions'),
    codexCli: whichCli('codex') || null,
  }, null, 2);
}

const HANDLERS = {
  list_sessions: listSessions,
  read_session: readSession,
  send_message: sendMessage,
  get_paths: getPaths,
};

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

function handleMessage(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize': {
      const requested = params && params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : '2025-06-18';
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'agentrelay', version: VERSION },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params && params.name;
      const handler = HANDLERS[name];
      if (!handler) return rpcError(id, -32602, `unknown tool: ${name}`);
      try {
        const text = handler((params && params.arguments) || {});
        return rpcResult(id, { content: [{ type: 'text', text }], isError: false });
      } catch (e) {
        return rpcResult(id, { content: [{ type: 'text', text: e.message }], isError: true });
      }
    }
    default:
      if (id !== undefined) return rpcError(id, -32601, `method not found: ${method}`);
      return null; // notification we don't know — ignore
  }
}

function run() {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      process.stdout.write(JSON.stringify(rpcError(null, -32700, 'parse error')) + '\n');
      return;
    }
    let resp;
    try { resp = handleMessage(msg); } catch (e) { resp = rpcError(msg.id ?? null, -32603, e.message); }
    if (resp) process.stdout.write(JSON.stringify(resp) + '\n');
  });
  rl.on('close', () => process.exit(0));
}

module.exports = { run, handleMessage };
