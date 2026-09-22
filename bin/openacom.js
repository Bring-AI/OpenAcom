#!/usr/bin/env node
'use strict';
const path = require('path');
const { adaptersToUse, findSession } = require('../lib/core');
const ADAPTERS = require('../lib/core').ADAPTERS;
const { fmtTime, printTable, truncate, whichCli, resolveZcodeCli, zcodeConfigPath } = require('../lib/util');

const HELP = `OpenAcom — one MCP/CLI command managing agent sessions across desktops and CLIs (Claude Code / Codex / ZCode / OpenCode), local and remote

Usage:
  openacom deliver <agent:sessionId|node:nodeId/target> <message...> --from <agent:sessionId> [--route auto|session|desktopcdp|desktop|relay|mailbox] [--id ID] [--consent true]  inbox then one delivery attempt
  openacom list  [query...] [--agent A] [--workspace DIR] [--limit N] [--json]   fuzzy search; --workspace lists sessions of one project (substring path match)
  openacom read  <sessionId> [--agent A] [--last N] [--json]
  openacom send  <message...>             fresh zcode session per message (recommended; visible in the desktop task list)
  openacom send  <sessionId> <message...> [--agent A] [--timeout ms] [--json] [--desktop] [--consent true|false] [--draft] [--wait] [--no-wait]  resume a session
  openacom send  <sessionId> <message...> --require-read [--ack-timeout ms]  send with read receipt: auto-redeliver until acked, 3 attempts max
  openacom send-desktop <sessionId> <message...> [--consent true] [--timeout ms] [--json]   INJECT into the ZCode desktop window and press Enter (Windows; needs one consent signal; no fallback)
  openacom inbox [--status pending|sent|read|failed] [--limit N] [--json]  tracked sends and their read status
  openacom ack    <messageId>    manually mark a tracked message as read
  openacom paths
  openacom oc-serve [dir] [--port N]   pre-warm the shared opencode server (send auto-starts it anyway)
  openacom oc-attach [dir] [--port N]   open a live TUI on the project's shared server (starts it if needed)
  openacom mcp   Run as a stdio MCP server exposing the same operations as tools
  openacom relay --help   durable multi-machine messaging over SSH-forwardable HTTP
  openacom terminal --name TARGET -- PROGRAM [ARGS...]   visible, controlled TUI input

Notes:
  - sessionId is matched across all agents unless --agent pins one.
  - send delivers a real new turn to the target session and prints its reply
    (synchronous headless resume; costs model tokens on the target agent).
  - The injected desktop route (--desktop, zcode on Windows) types the text into
    the real ZCode window and presses Enter, so a submit there needs consent.
    Without consent it is refused (CONSENT_REQUIRED) and nothing is typed:
      --draft            leave the text in the composer for a human to review;
                         presses no Enter, so it needs no consent. Requires
                         --desktop, because only that sender can stop before Enter.
      --consent true     an operator approved pressing Enter for THIS message.
      --no-desktop       do not inject: run the turn headless instead (needs
                         zcode.cjs + a provider config) and print its reply.
    OPENACOM_DESKTOP_CONSENT=1 grants submit to every injected desktop send from
    that process - the blunt option, for a machine you personally own. The
    desktop-consent file (exactly "1", in the OpenAcom home ~/.openacom) is the
    same resident grant for already-running MCP servers; delete it to revoke.
    All four are flags about INJECTION. None of them is a precondition of sending,
    and a refused injection is not a half-sent message: the target stays untouched.
  - send-desktop is the named injection entry point: it submits through the ZCode
    desktop UI and never retreats - no headless run, no stored message, and no
    second transport after anything was typed. What it does NOT do is skip your
    approval, so it still needs --consent true or OPENACOM_DESKTOP_CONSENT=1.
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
  const requireNext = (arr, i, name) => {
    if (i + 1 >= arr.length) die(`option ${name} requires a value`);
    return arr[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--agent') flags.agent = argv[++i];
    else if (a === '--route' || a === '--from' || a === '--id' || a === '--mode') { flags[a.slice(2)] = requireNext(argv, i, a); i++; }
    else if (a === '--limit') flags.limit = parseInt(argv[++i], 10);
    else if (a === '--last' || a === '-n') flags.last = parseInt(argv[++i], 10);
    else if (a === '--timeout') flags.timeout = parseInt(argv[++i], 10);
    else if (a === '--port') flags.port = parseInt(argv[++i], 10);
    else if (a === '--json') flags.json = true;
    else if (a === '--desktop') flags.desktop = true;
    else if (a === '--consent') flags.consent = parseBool(argv, ++i, a);
    else if (a === '--draft') flags.draft = true;
    else if (a === '--fresh') flags.fresh = true;
    else if (a === '--wait') flags.wait = true;
    else if (a === '--require-read') flags.requireRead = true;
    else if (a === '--ack-timeout') flags.ackTimeout = parseInt(requireNext(argv, i, a), 10);
    else if (a === '--status') flags.status = requireNext(argv, i, a);
    else if (a === '--workspace' || a === '-w') flags.workspace = requireNext(argv, i, a);
    else if (a === '--no-wait') flags.noWait = true;
    else if (a === '--no-desktop') flags.desktop = false;
    else if (a === '--help' || a === '-h') flags.help = true;
    else flags._.push(a);
  }
  return flags;
}

function die(msg, code = 1) { console.error('error: ' + msg); process.exit(code); }

// A consent flag is a claim about what the operator approved, so a value that is
// not one of the two literals has to stop the command: coercing "yes"/"1"/""
// would read a typo as an authorisation (or throw one away).
function parseBool(argv, i, name) {
  const value = argv[i];
  if (value === undefined || value.startsWith('--')) die(`option ${name} requires a value: ${name} true`);
  if (value === 'true') return true;
  if (value === 'false') return false;
  die(`option ${name} takes true or false, got "${value}"; example: openacom send <sessionId> <message> ${name} true`);
}

// The adapter's CONSENT_REQUIRED text is a paragraph written for a relay
// operator. At a terminal the useful answer is the command that would have
// worked, so name the two ways out and keep the exit code.
function dieSend(e, id, hints) {
  const message = (e && e.message) || String(e);
  if (e && e.code === 'CONSENT_REQUIRED') {
    console.error(`error: CONSENT_REQUIRED - the injected desktop submit was refused; nothing was typed into ${id}.`);
    for (const line of hints || [
      `  review it instead:   openacom send ${id} <message> --desktop --draft`,
      `  send it as approved: openacom send ${id} <message> --desktop --consent true`,
    ]) console.error(line);
    process.exit(1);
  }
  die(message);
}

// The injection route, named for what it does. It is deliberately NOT a mode of
// `send`: a desktop injection types into a live window and presses Enter, so it
// is only ever reached by asking for it, and it has no retreat - no headless run,
// no stored message - when it cannot deliver.
async function cmdSendDesktop(flags) {
  const [id, ...rest] = flags._;
  const message = rest.join(' ');
  if (!id || !message) die('send-desktop needs: <sessionId> <message...>   (injects into the ZCode desktop window and presses Enter)');
  if (flags.desktop === false) die('--no-desktop contradicts send-desktop: this command IS the desktop route; use "openacom send" to avoid injecting');
  if (flags.consent === false) die('--consent false asks for nothing; omit the flag (a submit then needs --consent true, or OPENACOM_DESKTOP_CONSENT=1 where you own the desktop)');
  const hits = findSession(id, flags.agent);
  if (hits.length === 0) die(`session not found: ${id} (run "openacom list")`);
  if (hits.length > 1) die(`session id exists in ${hits.map((h) => h.name).join(' & ')}; pass --agent`);
  const a = hits[0];
  if (a.name !== 'zcode') die(`send-desktop injects into the ZCode desktop UI; ${id} is a ${a.name} session`);
  const sess = typeof a.get === 'function' ? a.get(id) : null;
  if (!sess) die(`zcode session not found: ${id}`);
  const opts = { consent: flags.consent === true };
  if (flags.timeout) opts.timeoutMs = flags.timeout;
  const hints = [
    `  send it as approved: openacom send-desktop ${id} <message> --consent true`,
    `  or set OPENACOM_DESKTOP_CONSENT=1 for a ZCode desktop you personally own`,
  ];
  try {
    const out = await require('../lib/desktop-delivery').deliverDesktop(sess, message, opts);
    if (flags.json) { console.log(JSON.stringify({ ok: true, ...out }, null, 2)); return; }
    console.log(`OK ${out.transport === 'uia' ? '(UIA: focus was taken to type it)' : 'via CDP'} - ${out.outcome} on ${out.sessionId}; ${out.note}`);
  } catch (e) {
    if (flags.json) { console.log(JSON.stringify({ ok: false, sessionId: id, error: e.message, code: e.code || 'ERROR', uncertain: e.uncertain === true }, null, 2)); process.exit(1); }
    dieSend(e, id, hints);
  }
}

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
  if (hits.length === 0) die(`session not found: ${id} (run "openacom list")`);
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
  if (hits.length === 0) die(`session not found: ${id} (run "openacom list")`);
  if (hits.length > 1) die(`session id exists in ${hits.map((h) => h.name).join(' & ')}; pass --agent`);
  const a = hits[0];
  // --consent and --draft are claims about a desktop submit. Accepted where an
  // adapter can actually see them, refused everywhere else: a flag that is
  // quietly dropped is how an unapproved send becomes an approved one.
  if (flags.consent !== undefined && a.name !== 'zcode') die(`--consent only applies to a zcode desktop submit, not to a ${a.name} session`);
  if (flags.consent !== undefined && flags.desktop === false) die('--consent is pointless with --no-desktop: the headless route never presses Enter in your window');
  if (flags.draft && !(flags.desktop === true && a.name === 'zcode')) {
    if (a.name !== 'zcode') die(`--draft is a zcode desktop composer feature, not a ${a.name} one`);
    if (flags.desktop === false) die('--draft cannot combine with --no-desktop: a headless send has no composer to leave the text in');
    die(`--draft needs the explicit desktop route: openacom send ${id} <message> --desktop --draft`);
  }
  if (flags.desktop) {
    if (a.name !== 'zcode') die('--desktop is only implemented for zcode sessions');
    if (typeof a.sendDesktop !== 'function') die('desktop mode requires Windows');
    if (flags.draft) {
      // Draft is the one desktop mode that presses no Enter, so it goes through
      // the strict sender - which is also the only sender that has a mode.
      try {
        const out = await a.send(id, message, {
          desktop: true, desktopStrict: true, mode: 'draft',
          ...(flags.timeout ? { timeoutMs: flags.timeout } : {}),
          ...(flags.consent === undefined ? {} : { consent: flags.consent }),
        });
        console.log(typeof out === 'string' && out ? out : 'OK drafted (text is in the composer, nothing sent)');
      } catch (e) { dieSend(e, id); }
      return;
    }
    try {
      const out = a.sendDesktop(id, message, flags.consent === undefined ? {} : { consent: flags.consent });
      console.log(out || 'OK');
    } catch (e) { dieSend(e, id); }
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
  // A zcode resume with no --desktop at all still lands on the desktop route
  // (lib/adapters/zcode.js), so --consent has to reach it. Only when the caller
  // said it: turning an absent flag into false would overwrite the adapter default.
  if (flags.consent !== undefined) opts.consent = flags.consent;
  if (flags.requireRead) {
    try {
      const outcome = await require('../lib/inbox').trackedSend(a, id, `cli:${a.name}`, message, {
        ackTimeoutMs: flags.ackTimeout || 90e3,
        maxAttempts: 3,
        sendOpts: opts,
      });
      const ok = outcome.status === 'read';
      if (flags.json) { console.log(JSON.stringify({ ok, agent: a.name, sessionId: id, ...outcome }, null, 2)); if (!ok) process.exit(1); }
      else {
        if (!ok) process.exitCode = 1;
        console.log(outcome.status === 'read' ? `READ (attempt ${outcome.attemptsUsed}/3)` : `FAILED after ${outcome.attemptsUsed} attempts — target never acknowledged`);
        for (const p of outcome.problems || []) console.error(`  - ${p}`);
      }
    } catch (e) { die(e.message); }
    return;
  }
  try {
    const reply = await a.send(id, message, opts);
    if (flags.json) console.log(JSON.stringify({ ok: true, agent: a.name, sessionId: id, reply }, null, 2));
    else if (a.name === 'opencode' && !opts.noWait) console.error(`\n[session: ${id}]`);
    else console.log(reply || '(empty reply)');
  } catch (e) {
    if (flags.json) { console.log(JSON.stringify({ ok: false, agent: a.name, sessionId: id, error: e.message }, null, 2)); process.exit(1); }
    dieSend(e, id);
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

// Open a live TUI on the project's shared server, in this terminal. The
// server is started first when needed, so this is the only command a viewer
// ever runs - no port lookup, no URL paste.
async function cmdOcAttach(flags) {
  const oc = require('../lib/adapters/opencode');
  const dir = path.resolve(flags._[0] || process.cwd());
  const port = flags.port || oc.serverPortFor(dir);
  const base = `http://127.0.0.1:${port}`;
  if (!(await oc.probeServer(base, null, 1500))) {
    console.error(`shared server not up for ${dir}; starting...`);
    try { await oc.startServer(dir, { port }); }
    catch (e) { die(e.message); }
  }
  const exe = oc.cliPath();
  if (!exe || exe === 'opencode') die('opencode executable not found');
  const { spawnSync } = require('child_process');
  const r = spawnSync(exe, ['attach', base], { cwd: dir, stdio: 'inherit' });
  if (r.error) die(`failed to launch opencode attach: ${r.error.message}`);
  process.exit(r.status ?? 0);
}

function cmdHooks() {
  const hooks = require('../lib/hooks');
  const loaded = hooks.loadHooks();
  console.log(`hooks file: ${hooks.hooksFile()}`);
  for (const ev of hooks.EVENTS) {
    const cmds = loaded[ev] || [];
    console.log(`  ${ev.padEnd(16)} ${cmds.length ? cmds.join(' , ') : '(none)'}`);
  }
  console.log('\nevent JSON goes to each command\'s stdin; failures log to ~/.openacom/logs/hooks.log');
}

async function cmdWeb(flags) {
  const port = flags.port || parseInt(flags._[0], 10) || 9339;
  await require('../lib/web').startWeb(port);
  // keep the process alive; server handles requests
  setInterval(() => {}, 1 << 30);
}

function cmdInbox(flags) {
  const inbox = require('../lib/inbox');
  const rows = inbox.list({ status: flags.status, limit: flags.limit && flags.limit > 0 ? flags.limit : 30 });
  if (flags.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  const view = rows.map((r) => ({
    id: r.id.slice(0, 8), status: r.status.padEnd(7), att: `${r.attempts}/${r.max_attempts}`,
    to: r.to_addr, updated: new Date(r.updated_at).toISOString().replace('T', ' ').slice(0, 19),
    error: (r.last_error || '').slice(0, 60),
  }));
  if (!view.length) { console.log('(inbox empty)'); return; }
  printTable(view, [
    { key: 'id', label: 'ID' }, { key: 'status', label: 'STATUS' }, { key: 'att', label: 'ATT' },
    { key: 'to', label: 'TO' }, { key: 'updated', label: 'UPDATED' }, { key: 'error', label: 'ERROR' },
  ]);
}

function cmdAck(flags) {
  const id = flags._[0];
  if (!id) die('ack needs: <messageId> (full id or the 8-char prefix shown by inbox)');
  const inbox = require('../lib/inbox');
  let target = null;
  const rows = inbox.list({ limit: 1000 });
  target = rows.find((r) => r.id === id) || rows.find((r) => r.id.startsWith(id));
  if (!target) die(`unknown message id: ${id}`);
  const row = inbox.markRead(target.id);
  console.log(`acknowledged: ${row.id} (status=${row.status})`);
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
    case 'deliver': {
      const [to, ...body] = flags._;
      if (flags.draft || flags.fresh || flags.requireRead || flags.ackTimeout !== undefined) throw new Error('deliver does not create sessions or retry for read receipts; relay draft uses --mode draft');
      const result = await require('../lib/sdk').sendRouted(to, body.join(' '), {
        from:flags.from, route:flags.route ?? (flags.desktop === true ? 'desktop' : 'auto'), id:flags.id,
        consent:flags.consent, timeoutMs:flags.timeout, wait:flags.wait, desktop:flags.desktop, mode:flags.mode,
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.status === 'refused') process.exitCode = 1;
      else if (result.status === 'uncertain') process.exitCode = 2;
      return;
    }
    case 'send': return cmdSend(flags);
    case 'send-desktop': return cmdSendDesktop(flags);
    case 'paths': return cmdPaths();
    case 'inbox': return cmdInbox(flags);
    case 'ack': return cmdAck(flags);
    case 'hooks': return cmdHooks();
    case 'web': return cmdWeb(flags);
    case 'oc-serve': return cmdOcServe(flags);
    case 'oc-attach': return cmdOcAttach(flags);
    case 'mcp': return require('../lib/mcp').run();
    case 'mcp-http': return require('../lib/mcp-http').runHttp(parseInt(rest[0], 10) || 9321);
    default: console.log(HELP); process.exit(cmd ? 1 : 0);
  }
}

// The flag parser and the desktop routing below are the only place those rules
// exist, so a test has to be able to call them without this file running a
// command with the test runner's own argv.
module.exports = { HELP, parseArgs, cmdSend, cmdSendDesktop, die, dieSend };

if (require.main === module) main().catch((e) => { console.error('error: ' + (e && e.message || e)); process.exit(1); });
