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
    description: 'List recent sessions of the local and remote Claude Code / Codex / ZCode agents, newest first. Returns JSON rows with agent, id, title, workspace (ssh: prefix marks a remote Claude workspace), and update time.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: ['zcode', 'claude', 'codex'], description: 'Restrict to one agent' },
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
        agent: { type: 'string', enum: ['zcode', 'claude', 'codex'] },
        last: { type: 'number', description: 'Number of turns to return (default 10)' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_message',
    description: 'Send a message to a session as a real user turn. Fire-and-forget by default: returns immediately while the turn runs in the background (its reply lands in the session transcript; read later with read_session). Pass wait:true to block for the reply instead. Spends tokens on the target agent and appends to its history.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Omit when fresh:true' },
        message: { type: 'string' },
        agent: { type: 'string', enum: ['zcode', 'claude', 'codex'], description: 'Required if the id exists in several agents' },
        timeoutMs: { type: 'number', description: 'Only relevant with wait:true (default 300000)' },
        wait: { type: 'boolean', default: false, description: 'true = block until the target finishes and return its reply (can take minutes — mind your own MCP call timeout). Default false = return immediately.' },
        desktop: { type: 'boolean', description: 'zcode only, Windows only: deliver through the desktop app UI so its window live-updates (steals focus briefly; no reply text returned)' },
        fresh: { type: 'boolean', description: 'zcode only: run the message in a brand-new session instead of resuming sessionId. The new session appears in the desktop task list and can be opened to read the transcript. If set, sessionId is not required.' },
      },
      required: ['message'],
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
  const adapters = agent ? [ADAPTERS[agent]].filter(Boolean) : Object.values(ADAPTERS);
  for (const a of adapters) {
    if (!a.available()) continue;
    rows.push(...a.list(args.limit || 30));
  }
  rows.sort((x, y) => y.mtime - x.mtime);
  return JSON.stringify(rows.slice(0, args.limit || 30), null, 2);
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
  // no-wait is the default; wait:true blocks for the reply
  const opts = {};
  if (args.timeoutMs) opts.timeoutMs = args.timeoutMs;
  if (args.wait === true) opts.noWait = false; else opts.noWait = true;
  if (args.fresh) {
    const out = require('./adapters/zcode').sendFresh(args.message, opts);
    return JSON.stringify({ ok: true, sessionId: out.id, note: out.reply }, null, 2);
  }
  if (!args.sessionId) throw new Error('sessionId is required (unless fresh: true)');
  const hits = findSession(args.sessionId, args.agent);
  if (hits.length === 0) throw new Error(`session not found: ${args.sessionId}`);
  if (hits.length > 1) throw new Error(`session id exists in ${hits.map((h) => h.name).join(' & ')}; pass "agent"`);
  const a = hits[0];
  if (args.desktop) {
    if (a.name !== 'zcode' || typeof a.sendDesktop !== 'function') throw new Error('desktop mode is zcode-only and Windows-only');
    return a.sendDesktop(args.sessionId, args.message) || 'OK sent via desktop UI';
  }
  const out = a.send(args.sessionId, args.message, opts);
  return typeof out === 'string' && out.startsWith('OK (no-wait)') ? out : JSON.stringify({ ok: true, reply: out }, null, 2);
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

module.exports = { run };
