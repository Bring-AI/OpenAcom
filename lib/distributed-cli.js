'use strict';
const path = require('path');
const { homedir } = require('os');
const { randomBytes } = require('crypto');

const HELP = `Distributed AgentRelay (separate from legacy headless send)
  agentrelay relay hub [--host 127.0.0.1] [--port 9330] [--data DIR]
  agentrelay relay node --id MACHINE --targets FILE [--url URL] [--data DIR]
  agentrelay relay nodes [--url URL]
  agentrelay relay send MACHINE TARGET MESSAGE [--mode submit|draft] [--id MESSAGE_ID] [--url URL]
  agentrelay relay status MESSAGE_ID [--url URL]
  agentrelay relay token                    generate a shared secret
  agentrelay terminal --name TARGET [--data DIR] -- PROGRAM [ARGS...]
Environment: AGENTRELAY_TOKEN (32+ characters), AGENTRELAY_URL (default http://127.0.0.1:9330).
Only locally configured targets can receive messages. Status means input delivery, not model completion.
Use SSH forwarding for non-public machines. Do not expose the hub or desktop debugging port publicly.
`;

function parse(argv, allowed) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith('--')) { flags._.push(value); continue; }
    const key = value.slice(2);
    if (!allowed.includes(key)) throw new Error(`unknown option ${value}`);
    if (i + 1 === argv.length || argv[i + 1].startsWith('--')) throw new Error(`${value} requires a value`);
    if (Object.hasOwn(flags, key)) throw new Error(`duplicate option ${value}`);
    flags[key] = argv[++i];
  }
  return flags;
}
function connection() {
  return { url: process.env.AGENTRELAY_URL || 'http://127.0.0.1:9330', token: process.env.AGENTRELAY_TOKEN };
}
function dataDir(value) { return path.resolve(value || path.join(homedir(), '.agentrelay')); }
function print(value) { console.log(JSON.stringify(value, null, 2)); }
async function run(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help') { console.log(HELP); return; }
  if (command === 'token') {
    if (rest.length) throw new Error('token takes no arguments');
    console.log(randomBytes(32).toString('hex')); return;
  }
  const options = {
    hub: ['host', 'port', 'data'], node: ['id', 'targets', 'url', 'data'],
    nodes: ['url'], send: ['url', 'mode', 'id'], status: ['url'],
  };
  if (!Object.hasOwn(options, command)) throw new Error(`unknown relay command ${command}\n${HELP}`);
  const flags = parse(rest, options[command]);
  const { runHub, runNode, request } = require('./distributed');
  const conn = { ...connection(), ...(flags.url ? { url: flags.url } : {}) };
  if (command === 'hub') {
    if (flags._.length) throw new Error('hub takes options only');
    const port = flags.port === undefined ? 9330 : Number(flags.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be 1..65535');
    const server = await runHub({ host: flags.host || '127.0.0.1', port, dataDir: dataDir(flags.data), token: conn.token });
    console.error(`AgentRelay hub listening on ${flags.host || '127.0.0.1'}:${port}`);
    const stop = () => server.close();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    return;
  }
  if (command === 'node') {
    if (!flags.id || !flags.targets || flags._.length) throw new Error('node requires --id MACHINE --targets FILE');
    return runNode({ ...conn, nodeId: flags.id, dataDir: dataDir(flags.data), targetsFile: path.resolve(flags.targets) });
  }
  if (command === 'nodes') {
    if (flags._.length) throw new Error('nodes takes no positional arguments');
    return print(await request(conn, 'GET', '/nodes'));
  }
  if (command === 'status') {
    if (flags._.length !== 1) throw new Error('status requires exactly one message id');
    return print(await request(conn, 'GET', '/messages/' + encodeURIComponent(flags._[0])));
  }
  if (flags._.length < 3) throw new Error('send requires MACHINE TARGET MESSAGE');
  const [to, target, ...text] = flags._;
  print(await request(conn, 'POST', '/messages', { to, target, text: text.join(' '), mode: flags.mode || 'submit', ...(flags.id ? { id: flags.id } : {}) }));
}
async function terminal(argv) {
  if (argv.length === 1 && argv[0] === '--help') { console.log(HELP); return 0; }
  const split = argv.indexOf('--');
  if (split < 0 || split === argv.length - 1) throw new Error('terminal requires --name TARGET -- PROGRAM [ARGS...]');
  const flags = parse(argv.slice(0, split), ['name', 'data']);
  if (!flags.name || flags._.length) throw new Error('terminal requires --name TARGET');
  return require('./terminal').runTerminal({ name: flags.name, dataDir: dataDir(flags.data), command: argv[split + 1], args: argv.slice(split + 2) });
}
module.exports = { run, terminal, connection, HELP };
