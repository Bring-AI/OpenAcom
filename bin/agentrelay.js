#!/usr/bin/env node
'use strict';
const path = require('path');
const { adaptersToUse, findSession } = require('../lib/core');
const ADAPTERS = require('../lib/core').ADAPTERS;
const { fmtTime, printTable, truncate, whichCli, resolveZcodeCli, zcodeConfigPath } = require('../lib/util');

const HELP = `AgentRelay — one MCP/CLI command managing agent sessions across desktops and CLIs (Claude Code / Codex / ZCode / OpenCode), local and remote

Usage:
  agentrelay list  [query...] [--agent zcode|claude|codex|opencode] [--limit N] [--json]   fuzzy search (title/id/workspace), top 30 default
  agentrelay read  <sessionId> [--agent A] [--last N] [--json]
  agentrelay send  <message...>             fresh zcode session per message (recommended; visible in the desktop task list)
  agentrelay send  <sessionId> <message...> [--agent A] [--timeout ms] [--json] [--desktop] [--wait] [--no-wait]  resume a session
  agentrelay paths
  agentrelay oc-serve [dir] [--port N]   pre-warm the shared opencode server (send auto-starts it anyway)
  agentrelay mcp   Run as a stdio MCP server exposing the same operations as tools
  agentrelay relay --help   durable multi-machine messaging over SSH-forwardable HTTP
  agentrelay terminal --name TARGET -- PROGRAM [ARGS...]   visible, controlled TUI input

Notes:
  - sessionId is matched across all agents unless --agent pins one.
  - send delivers a real new turn to the target session and prints its reply
    (synchronous headless resume; costs model tokens on the target agent).
  - opencode targets are steered directly: the message lands in that exact
    session (never forked), and the CLI streams the turn live (header, tool
    progress, reply). Blocking is the default; --no-wait detaches instead.
  - opencode sends auto-start the project's shared server when needed, so an
    attached TUI shows the turn live with zero setup (AGENTRELAY_OPENCODE_URL
    overrides the probe; AGENTRELAY_OPENCODE_NOSERVE=1 disables auto-start and
    falls back to run). oc-serve only pre-warms.
  - Env overrides: AGENTRELAY_ZCODE_CLI (path to zcode.cjs).
`;

function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--agent') flags.agent = argv[++i];
    else if (a === '--limit') flags.limit = parseInt(argv[++i], 10);
    else if (a === '--last' || a === '-n') flags.last = parseInt(argv[++i], 10);
    else if (a === '--timeout') flags.timeout = parseInt(argv[++i], 10);
    else if (a === '--port') flags.port = parseInt(argv[++i], 10);
    else if (a === '--json') flags.json = true;
    else if (a === '--desktop') flags.desktop = true;
    else if (a === '--fresh') flags.fresh = true;
    else if (a === '--wait') flags.wait = true;
    else if (a === '--no-wait') flags.noWait = true;
    else if (a === '--no-desktop') flags.desktop = false;
    else if (a === '--help' || a === '-h') flags.help = true;
    else flags._.push(a);
  }
  return flags;
}

function die(msg, code = 1) { console.error('error: ' + msg); process.exit(code); }

function cmdList(flags) {
  const rows = [];
  const terms = flags._.join(' ').toLowerCase().split(/\s+/).filter(Boolean);
  for (const a of adaptersToUse(flags.agent)) {
    if (!a.available()) continue;
    try { rows.push(...a.list(0)); } catch (e) { console.error(`warn: ${a.name}: ${e.message}`); }
  }
  let filtered = rows;
  if (terms.length) {
    filtered = rows.filter((r) => {
      const hay = `${r.agent} ${r.id} ${r.title} ${r.workspace}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }
  filtered.sort((x, y) => y.mtime - x.mtime);
  const lim = flags.limit && flags.limit > 0 ? flags.limit : 30;
  const top = filtered.slice(0, lim);
  if (flags.json) { console.log(JSON.stringify(top, null, 2)); return; }
  printTable(top.map((r) => ({ ...r, updated: fmtTime(r.mtime) })), [
    { key: 'agent', label: 'AGENT' },
    { key: 'id', label: 'SESSION' },
    { key: 'title', label: 'TITLE' },
    { key: 'workspace', label: 'WORKSPACE' },
    { key: 'updated', label: 'UPDATED' },
  ]);
}

function cmdRead(flags) {
  const id = flags._[0];
  if (!id) die('read needs a sessionId');
  const hits = findSession(id, flags.agent);
  if (hits.length === 0) die(`session not found: ${id} (run "agentrelay list")`);
  if (hits.length > 1) die(`session id exists in ${hits.map((h) => h.name).join(' & ')}; pass --agent`);
  const a = hits[0];
  const turns = a.messages(id, flags.last || 10);
  if (!turns) die('session found but messages unreadable');
  if (flags.json) { console.log(JSON.stringify({ agent: a.name, id, turns }, null, 2)); return; }
  console.log(`# ${a.name} · ${id}`);
  for (const t of turns) {
    console.log(`\n[${t.role}] ${truncate(t.text, 500)}`);
  }
}

async function cmdSend(flags) {
  const [first, ...rest] = flags._;
  const idLike = !!first && findSession(first, flags.agent).length > 0;
  // Fresh default: no positional args at all, --fresh, or a single positional
  // that is a message (not a known session id) — the recommended agent-to-agent
  // pattern: new zcode session, visible in the desktop task list, nothing stale.
  if (flags.fresh || !first || (rest.length === 0 && !idLike)) {
    const message = flags._.join(' ');
    if (!message) die('send needs: <message...> (fresh session)  |  <sessionId> <message...> (resume)');
    const a = ADAPTERS.zcode;
    try {
      const optsF = {};
      if (flags.timeout) optsF.timeoutMs = flags.timeout;
      optsF.noWait = !flags.wait;
      const { id, reply } = a.sendFresh(message, optsF);
      if (flags.json) console.log(JSON.stringify({ ok: true, agent: 'zcode', sessionId: id, reply }, null, 2));
      else {
        console.log(reply || '(empty reply)');
        if (id) console.error(`\n[session: ${id}]`);
      }
    } catch (e) { die(e.message); }
    return;
  }
  const id = first;
  const message = rest.join(' ');
  if (!message) die(idLike ? `found session ${id} but no message text (append the message, or use --fresh)` : 'send needs: <sessionId> <message...>');
  const hits = findSession(id, flags.agent);
  if (hits.length === 0) die(`session not found: ${id} (run "agentrelay list")`);
  if (hits.length > 1) die(`session id exists in ${hits.map((h) => h.name).join(' & ')}; pass --agent`);
  const a = hits[0];
  if (flags.desktop) {
    if (a.name !== 'zcode') die('--desktop is only implemented for zcode sessions');
    if (typeof a.sendDesktop !== 'function') die('desktop mode requires Windows');
    try {
      const out = a.sendDesktop(id, message);
      console.log(out || 'OK');
    } catch (e) { die(e.message); }
    return;
  }
  const opts = {};
  if (flags.timeout) opts.timeoutMs = flags.timeout;
  if (a.name === 'opencode') {
    // Direct steer: block and stream the turn live by default; --no-wait
    // detaches into the background. The reply is already on screen, so in
    // human mode there is nothing left to print (only the session tag).
    opts.noWait = !!flags.noWait;
    if (!opts.noWait) {
      opts.onData = flags.json
        ? (s, chunk) => process.stderr.write(chunk)
        : (s, chunk) => (s === 'stdout' ? process.stdout : process.stderr).write(chunk);
    }
  } else {
    opts.noWait = !flags.wait;
  }
  if (flags.desktop === false) opts.desktop = false; // --no-desktop: force headless
  try {
    const reply = await a.send(id, message, opts);
    if (flags.json) console.log(JSON.stringify({ ok: true, agent: a.name, sessionId: id, reply }, null, 2));
    else if (a.name === 'opencode' && !opts.noWait) console.error(`\n[session: ${id}]`);
    else console.log(reply || '(empty reply)');
  } catch (e) {
    if (flags.json) { console.log(JSON.stringify({ ok: false, agent: a.name, sessionId: id, error: e.message }, null, 2)); process.exit(1); }
    die(e.message);
  }
}

function cmdPaths() {
  let opencodeCli = '(not found)';
  try { opencodeCli = require('../lib/adapters/opencode').cliPath(); } catch { /* keep placeholder */ }
  const rows = [
    { what: 'zcode sessions db', value: path.join(require('os').homedir(), '.zcode', 'cli', 'db', 'db.sqlite') },
    { what: 'zcode cli (zcode.cjs)', value: resolveZcodeCli() || '(not found — set AGENTRELAY_ZCODE_CLI)' },
    { what: 'zcode headless config', value: zcodeConfigPath() },
    { what: 'claude projects', value: path.join(require('os').homedir(), '.claude', 'projects') },
    { what: 'claude cli', value: whichCli('claude') || '(not found)' },
    { what: 'codex sessions', value: path.join(require('os').homedir(), '.codex', 'sessions') },
    { what: 'codex cli', value: whichCli('codex') || '(not found)' },
    { what: 'opencode sessions db', value: path.join(require('os').homedir(), '.local', 'share', 'opencode', 'opencode.db') },
    { what: 'opencode cli', value: opencodeCli },
  ];
  printTable(rows, [{ key: 'what', label: 'WHAT' }, { key: 'value', label: 'PATH' }]);
}

// Pre-warm the shared opencode server for a project directory (idempotent).
// Normally unnecessary: `send` to an opencode session ensures the server by
// itself. This only prints the paste-ready attach line up front.
async function cmdOcServe(flags) {
  const oc = require('../lib/adapters/opencode');
  const dir = path.resolve(flags._[0] || process.cwd());
  const port = flags.port || oc.serverPortFor(dir);
  const base = `http://127.0.0.1:${port}`;
  try {
    if (await oc.probeServer(base, null, 1200)) {
      console.log(`opencode server already running at ${base}\n  attach a TUI:  opencode attach ${base}`);
      return;
    }
    const s = await oc.startServer(dir, { port });
    console.log(`opencode server for ${dir}\n  up at ${s.base} (pid ${s.pid}, log ${s.log})\n  attach a TUI:  opencode attach ${s.base}`);
  } catch (e) { die(e.message); }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'relay') return require('../lib/distributed-cli').run(rest);
  if (cmd === 'terminal') {
    process.exitCode = await require('../lib/distributed-cli').terminal(rest);
    return;
  }
  const flags = parseArgs(rest);
  if (flags.help) { console.log(HELP); return; }
  switch (cmd) {
    case 'list': return cmdList(flags);
    case 'read': return cmdRead(flags);
    case 'send': return cmdSend(flags);
    case 'paths': return cmdPaths();
    case 'oc-serve': return cmdOcServe(flags);
    case 'mcp': return require('../lib/mcp').run();
    case 'mcp-http': return require('../lib/mcp-http').runHttp(parseInt(rest[0], 10) || 9321);
    default: console.log(HELP); process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => { console.error('error: ' + (e && e.message || e)); process.exit(1); });
