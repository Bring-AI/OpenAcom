#!/usr/bin/env node
'use strict';
const path = require('path');
const { adaptersToUse, findSession } = require('../lib/core');
const ADAPTERS = require('../lib/core').ADAPTERS;
const { fmtTime, printTable, truncate, whichCli, resolveZcodeCli, zcodeConfigPath } = require('../lib/util');

const HELP = `AgentRelay — one MCP/CLI command managing agent sessions across desktops and CLIs (Claude Code / Codex / ZCode), local and remote

Usage:
  agentrelay list  [--agent zcode|claude|codex] [--limit N] [--json]
  agentrelay read  <sessionId> [--agent A] [--last N] [--json]
  agentrelay send  <message...>             fresh zcode session per message (recommended; visible in the desktop task list)
  agentrelay send  <sessionId> <message...> [--agent A] [--timeout ms] [--json] [--desktop] [--wait]  resume a session (--wait blocks for the reply)
  agentrelay paths
  agentrelay mcp   Run as a stdio MCP server exposing the same operations as tools

Notes:
  - sessionId is matched across all agents unless --agent pins one.
  - send delivers a real new turn to the target session and prints its reply
    (synchronous headless resume; costs model tokens on the target agent).
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
    else if (a === '--json') flags.json = true;
    else if (a === '--desktop') flags.desktop = true;
    else if (a === '--fresh') flags.fresh = true;
    else if (a === '--wait') flags.wait = true;
    else if (a === '--no-desktop') flags.desktop = false;
    else if (a === '--help' || a === '-h') flags.help = true;
    else flags._.push(a);
  }
  return flags;
}

function die(msg, code = 1) { console.error('error: ' + msg); process.exit(code); }

function cmdList(flags) {
  const rows = [];
  for (const a of adaptersToUse(flags.agent)) {
    if (!a.available()) continue;
    try { rows.push(...a.list(flags.limit || 30)); } catch (e) { console.error(`warn: ${a.name}: ${e.message}`); }
  }
  rows.sort((x, y) => y.mtime - x.mtime);
  const top = rows.slice(0, flags.limit || 30);
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

function cmdSend(flags) {
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
  opts.noWait = !flags.wait;
  if (flags.desktop === false) opts.desktop = false; // --no-desktop: force headless
  try {
    const reply = a.send(id, message, opts);
    if (flags.json) console.log(JSON.stringify({ ok: true, agent: a.name, sessionId: id, reply }, null, 2));
    else console.log(reply || '(empty reply)');
  } catch (e) {
    if (flags.json) { console.log(JSON.stringify({ ok: false, agent: a.name, sessionId: id, error: e.message }, null, 2)); process.exit(1); }
    die(e.message);
  }
}

function cmdPaths() {
  const rows = [
    { what: 'zcode sessions db', value: path.join(require('os').homedir(), '.zcode', 'cli', 'db', 'db.sqlite') },
    { what: 'zcode cli (zcode.cjs)', value: resolveZcodeCli() || '(not found — set AGENTRELAY_ZCODE_CLI)' },
    { what: 'zcode headless config', value: zcodeConfigPath() },
    { what: 'claude projects', value: path.join(require('os').homedir(), '.claude', 'projects') },
    { what: 'claude cli', value: whichCli('claude') || '(not found)' },
    { what: 'codex sessions', value: path.join(require('os').homedir(), '.codex', 'sessions') },
    { what: 'codex cli', value: whichCli('codex') || '(not found)' },
  ];
  printTable(rows, [{ key: 'what', label: 'WHAT' }, { key: 'value', label: 'PATH' }]);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseArgs(rest);
  if (flags.help) { console.log(HELP); return; }
  switch (cmd) {
    case 'list': return cmdList(flags);
    case 'read': return cmdRead(flags);
    case 'send': return cmdSend(flags);
    case 'paths': return cmdPaths();
    case 'mcp': return require('../lib/mcp').run();
    case 'mcp-http': return require('../lib/mcp-http').runHttp(parseInt(rest[0], 10) || 9321);
    default: console.log(HELP); process.exit(cmd ? 1 : 0);
  }
}

main();
