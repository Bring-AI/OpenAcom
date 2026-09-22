'use strict';
// Desktop client contract test. Everything here is headless: the exe is built
// with the in-box Windows C# compiler and then run in --selftest / --livetest
// mode, neither of which may create a window (the report proves it with an
// EnumWindows count for its own PID plus a form-construction counter).
//
// Two hubs are used on purpose:
//   * a stub that mirrors lib/distributed.js and records request bodies, so the
//     wire form of "consent unchecked" and the scripted 400/403/404/409/429
//     retry branches can be asserted;
//   * the real hub from lib/distributed.js, so the client's hand-written JSON
//     and field mapping are checked against the shipped contract instead of
//     against a stub written from the same reading of it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const desktopDir = path.join(__dirname, '..', 'desktop');
const buildCmd = path.join(desktopDir, 'build.cmd');
const sourceFile = path.join(desktopDir, 'OpenAcomDesktop.cs');
const exeFile = path.join(desktopDir, 'openacom-desktop.exe');
const skip = process.platform !== 'win32'
  ? 'the desktop client is a WinForms exe built by the Windows-inbox csc.exe'
  : false;

const TOKEN = 'desktop-test-only-secret-0123456789abcdef';
// Mirrors lib/distributed.js: statuses an operator retry may push back into the
// queue, and the codes it refuses everything else with.
const RETRYABLE_FROM = new Set(['queued', 'deferred', 'expired', 'failed']);
// UUID-shaped ids the stub answers with a scripted refusal. They have to be
// UUID-shaped because the real hub validates the id before it looks at the row.
// The same three constants live in the client's --selftest.
const RETRY_SENTINELS = {
  forbidden: '00000000-0000-4000-8000-000000000403',
  conflict: '00000000-0000-4000-8000-000000000409',
  queueFull: '00000000-0000-4000-8000-000000000429',
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-desktop-'));
// Start from a scrubbed environment so a developer's own AGENTRELAY_* settings
// cannot decide which credential path a test exercises; `extra` is applied last.
const cleanEnv = (extra) => {
  const env = { ...process.env };
  delete env.AGENTRELAY_URL;
  delete env.AGENTRELAY_TOKEN;
  env.AGENTRELAY_HOME = path.join(tmp, 'home');
  fs.mkdirSync(env.AGENTRELAY_HOME, { recursive: true });
  return Object.assign(env, extra);
};

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function build() {
  return run(process.env.ComSpec || 'cmd.exe', ['/c', buildCmd], cleanEnv({}));
}

// Runs the exe headlessly and returns { code, report } where the report is the
// JSON the exe wrote to --out.
async function headless(mode, url, token, extraArgs = []) {
  const out = path.join(tmp, `${mode}-${randomUUID()}.json`);
  const args = [`--${mode}`, '--out', out, ...extraArgs];
  if (url) args.push('--url', url);
  if (token) args.push('--token', token);
  const result = await run(exeFile, args, cleanEnv({}));
  let report = null;
  if (fs.existsSync(out)) {
    try { report = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (error) { report = { parseError: error.message, raw: fs.readFileSync(out, 'utf8') }; }
    fs.rmSync(out, { force: true });
  }
  return { ...result, report };
}

const step = (report, name) => {
  const found = report.steps.find((s) => s.name === name);
  assert.ok(found, `expected a ${name} step, got: ${report.steps.map((s) => s.name).join(', ')}`);
  return found;
};

const assertHeadless = (report) => {
  assert.equal(report.windowsForPid, 0, 'the headless mode created a top-level window');
  assert.equal(report.visibleWindowsForPid, 0, 'the headless mode showed a window on the desktop');
  assert.equal(report.formsCreated, 0, 'the headless mode constructed a Form');
  const guard = step(report, 'headless-no-window');
  assert.equal(guard.ok, true, guard.detail);
};

// A stub hub shaped like the real one: same auth rule, same fault envelope, same
// publicMessage fields, and it records every request body verbatim.
function startStubHub() {
  const bodies = [];
  const rows = new Map();
  const json = (res, status, value) => {
    const body = JSON.stringify(value);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      ...(status >= 400 ? { Connection: 'close' } : {}),
    });
    res.end(body);
  };
  const fault = (res, status, code, message) => json(res, status, { error: { code, message } });
  const view = (r) => ({
    id: r.id, to: r.to, target: r.target, text: r.text, mode: r.mode,
    status: r.status, createdAt: r.createdAt, updatedAt: r.updatedAt, consent: r.consent,
    result: null, error: null, attempts: r.attempts, deferrals: r.deferrals,
    deferred: r.status === 'deferred', retries: r.retries,
    retryEligible: RETRYABLE_FROM.has(r.status),
    retryable: !['delivered', 'failed', 'expired'].includes(r.status) && ['queued', 'delivering', 'deferred'].includes(r.status),
    terminal: ['delivered', 'failed', 'expired'].includes(r.status),
    expiresAt: r.expiresAt, everUncertain: false, uncertainAt: null, uncertainDeadline: null, settlement: null,
  });
  const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return fault(res, 401, 'UNAUTHORIZED', 'Bearer authentication required.');
    }
    if (req.method === 'GET' && url.pathname === '/__bodies') return json(res, 200, { bodies });
    const raw = req.method === 'POST' ? await readBody(req) : null;
    if (raw !== null) bodies.push({ method: req.method, path: url.pathname, body: raw });

    if (req.method === 'GET' && url.pathname === '/nodes') {
      return json(res, 200, {
        nodes: [{
          id: 'stub-node', targets: ['coder', 'reviewer'], lastSeen: Date.now(), online: true,
          firstSeen: Date.now() - 60000, registeredAt: Date.now() - 60000, heartbeatSource: '127.0.0.1',
          credential: { issuedAt: Date.now() - 60000, fingerprint: 'deadbeef' },
          security: {
            FOREIGN_CREDENTIAL_HEARTBEAT: { count: 2, lastAt: Date.now() },
            CREDENTIAL_MISMATCH_ACK: { count: 0, lastAt: null },
          },
        }],
        queueTtlMs: 86400000, nodeQueueLimit: 128,
        store: { acl: 'private', paths: [{ path: path.join(tmp, 'hub.sqlite'), acl: 'private', platform: 'win32' }] },
      });
    }
    // The real hub answers an operator credential here with a refusal, because
    // this route is the node claim poll (it needs ?to=&sessionId= and the node
    // credential). The stub reproduces that so the client cannot pass by
    // assuming a listing exists.
    if (req.method === 'GET' && url.pathname === '/messages') {
      return fault(res, 400, 'INVALID_ID', 'to must be 1-64 letters, digits, dots, underscores or hyphens, starting with a letter or digit.');
    }
    if (req.method === 'POST' && url.pathname === '/messages') {
      const input = JSON.parse(raw || '{}');
      const id = input.id || randomUUID();
      const now = Date.now();
      const row = {
        id, to: input.to, target: input.target, text: input.text, mode: input.mode || 'submit',
        status: 'queued', createdAt: now, updatedAt: now, consent: input.consent === true,
        attempts: 0, deferrals: 0, retries: 0, expiresAt: now + 86400000,
      };
      rows.set(id, row);
      return json(res, 202, view(row));
    }
    const retry = /^\/messages\/([^/]+)\/retry(-absent)?$/.exec(url.pathname);
    if (req.method === 'POST' && retry) {
      if (retry[2]) return fault(res, 404, 'NOT_FOUND', 'Route not found.');
      const id = retry[1];
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return fault(res, 400, 'INVALID_ID', 'id must be a UUID.');
      }
      // Scripted refusals, keyed by UUID-shaped sentinels so they survive the id
      // validation the real hub does first.
      if (id === RETRY_SENTINELS.forbidden) {
        return fault(res, 403, 'ADMIN_CREDENTIAL_REQUIRED', 'This route requires the hub bootstrap credential, not a node credential.');
      }
      if (id === RETRY_SENTINELS.conflict) {
        return fault(res, 409, 'ALREADY_SETTLED', 'A message in status delivered is not retryable: the node reported the input delivered.');
      }
      if (id === RETRY_SENTINELS.queueFull) {
        return fault(res, 429, 'QUEUE_FULL', 'Node stub-node already holds 128 undelivered messages (limit 128); retry would exceed it.');
      }
      const row = rows.get(id);
      if (!row) return fault(res, 404, 'NOT_FOUND', 'Message not found.');
      if (!RETRYABLE_FROM.has(row.status)) {
        return fault(res, 409, 'CLAIM_ACTIVE', `A message in status ${row.status} is not retryable: a node holds a live claim.`);
      }
      row.status = 'queued';
      row.deferrals = 0;
      row.retries += 1;
      row.attempts = 2;
      row.updatedAt = Date.now();
      row.expiresAt = Date.now() + 86400000;
      const out = view(row);
      return json(res, 200, {
        ok: true, id: out.id, status: out.status, attempts: out.attempts, deferrals: out.deferrals,
        retries: out.retries, retryable: out.retryable, terminal: out.terminal,
        expiresAt: out.expiresAt, retryEligible: out.retryEligible,
      });
    }
    const detail = /^\/messages\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && detail) {
      const row = rows.get(detail[1]);
      if (!row) return fault(res, 404, 'NOT_FOUND', 'Message not found.');
      return json(res, 200, view(row));
    }
    return fault(res, 404, 'NOT_FOUND', 'Route not found.');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        bodies,
        rows,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test('build.cmd compiles the native desktop sources with the in-box compiler', { skip }, async (t) => {
  const result = await build();
  assert.equal(result.code, 0, `build failed:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /csc\.exe/, 'the build should report which compiler it used');
  const stat = fs.statSync(exeFile);
  assert.ok(stat.size > 0, 'exe is empty');
  // The redesigned WPF shell includes fleet control and embedded layouts; keep the native UI below 512 KiB (bundled Node is measured separately).
  assert.ok(stat.size < 512 * 1024, `native UI exe must stay under 512KB, is ${stat.size} bytes`);

  // Boss's constraint: nothing may be fetched or installed to build this.
  const script = fs.readFileSync(buildCmd, 'utf8');
  assert.doesNotMatch(script, /curl|wget|Invoke-WebRequest|npm |npx |nuget|dotnet build/i,
    'build.cmd must not download or install anything');
  assert.match(script, /Microsoft\.NET\\Framework64\\v4\.0\.30319\\csc\.exe/,
    'build.cmd should prefer the compiler that ships with Windows');

  // The headless modes are dispatched before any window exists, and no headless
  // code path constructs a Form.
  const source = fs.readFileSync(sourceFile, 'utf8');
  const dispatch = source.indexOf('if (opts.SelfTest) return SelfTest.Run(cfg, opts);');
  const ui = source.indexOf('Application.Run(new MainForm(cfg));');
  assert.ok(dispatch > 0 && ui > 0 && dispatch < ui, 'selftest must be dispatched before the UI entry point');
  const selfTestBody = source.slice(source.indexOf('internal static class SelfTest'), source.indexOf('internal static class LiveTest'));
  assert.doesNotMatch(selfTestBody, /new MainForm|Application\.Run|\.Show\(\)/, 'selftest must not touch the UI');
  assert.doesNotMatch(source, /Bearer \$\{|AGENTRELAY_TOKEN\s*=\s*"[A-Za-z0-9]{16,}/, 'no credential literal belongs in the source');
  t.diagnostic(`exe ${stat.size} bytes, compiler reported: ${result.stdout.trim().split('\n')[0]}`);
});

test('--selftest exercises the hub contract and never opens a window', { skip }, async (t) => {
  const hub = await startStubHub();
  try {
    const { code, report, stderr } = await headless('selftest', hub.url, TOKEN);
    assert.ok(report, `no report written; stderr: ${stderr}`);
    assert.equal(report.allOk, true, JSON.stringify(report.steps.filter((s) => !s.ok), null, 2));
    assert.equal(code, 0, 'selftest must exit 0 when every step passes');
    assertHeadless(report);
    assert.equal(report.tokenFingerprint.length, 8);
    assert.ok(!JSON.stringify(report).includes(TOKEN), 'the token must not appear in the report');

    // Nodes page data: id, online/last seen, credential fingerprint, security
    // kinds, store acl.
    const nodes = step(report, 'nodes-list');
    assert.equal(nodes.ok, true, nodes.detail);
    assert.match(nodes.detail, /first=stub-node online=True/);
    assert.match(nodes.detail, /fingerprint=deadbeef/);
    assert.match(nodes.detail, /security=FOREIGN_CREDENTIAL_HEARTBEAT x2/);
    assert.match(nodes.detail, /storeAcl=private/);

    // The hub offers no operator listing, and the client says so instead of
    // showing an empty grid as if there were nothing left to deliver.
    const listing = step(report, 'listing-probe');
    assert.equal(listing.ok, true, listing.detail);
    assert.match(listing.detail, /no operator listing on this hub/);

    // Send: consent unchecked must leave the key off the wire entirely, which is
    // not the same as sending false.
    assert.equal(step(report, 'send-without-consent').ok, true, step(report, 'send-without-consent').detail);
    assert.equal(step(report, 'send-with-consent').ok, true, step(report, 'send-with-consent').detail);
    const wire = step(report, 'wire-consent-omitted');
    assert.equal(wire.ok, true, wire.detail);
    const sends = hub.bodies.filter((b) => b.path === '/messages');
    assert.equal(sends.length, 2, 'expected exactly two POST /messages');
    const silent = sends.find((b) => b.body.includes('hello from selftest'));
    assert.ok(silent, 'the stub never saw the unchecked-consent send');
    assert.ok(!silent.body.includes('consent'), `unchecked consent must be omitted, body was ${silent.body}`);
    assert.deepEqual(Object.keys(JSON.parse(silent.body)).sort(), ['target', 'text', 'to']);
    const loud = sends.find((b) => b.body.includes('consented'));
    assert.equal(JSON.parse(loud.body).consent, true);

    // Message detail row fields.
    const detail = step(report, 'message-detail');
    assert.equal(detail.ok, true, detail.detail);
    assert.match(detail.detail, /status=queued attempts=0 deferrals=0/);
    assert.match(detail.detail, /everUncertain=no/);

    // Retry: the accepted path plus every refusal, each with its own verdict.
    const accepted = step(report, 'retry-accepted');
    assert.equal(accepted.ok, true, accepted.detail);
    assert.match(accepted.detail, /kind=ok/);
    // The hub's 200 body is a superset of { ok, status, attempts }; the client
    // reports the re-queued status plus the counters it just reset.
    assert.match(accepted.detail, /re-queued as queued \(attempts=2, deferrals=0, retries=1, expiresAt=/);
    assert.equal(step(report, 'retry-404-endpoint-missing').ok, true, step(report, 'retry-404-endpoint-missing').detail);
    assert.match(step(report, 'retry-404-endpoint-missing').detail, /kind=endpoint-missing/);
    assert.equal(step(report, 'retry-403-credential').ok, true, step(report, 'retry-403-credential').detail);
    assert.match(step(report, 'retry-403-credential').detail, /kind=insufficient-credential/);
    assert.equal(step(report, 'retry-409-state').ok, true, step(report, 'retry-409-state').detail);
    assert.match(step(report, 'retry-409-state').detail, /kind=state-not-allowed/);
    assert.equal(step(report, 'retry-429-queue-full').ok, true, step(report, 'retry-429-queue-full').detail);
    assert.equal(step(report, 'retry-400-bad-id').ok, true, step(report, 'retry-400-bad-id').detail);
    // A missing message must not be dressed up as a missing endpoint.
    assert.match(step(report, 'retry-404-message-missing-is-not-endpoint-missing').detail, /kind=message-not-found/);

    // Failures are surfaced, never swallowed.
    assert.equal(step(report, 'auth-failure-surfaced').ok, true, step(report, 'auth-failure-surfaced').detail);
    assert.match(step(report, 'auth-failure-surfaced').detail, /401/);
    assert.equal(step(report, 'transport-failure-surfaced').ok, true, step(report, 'transport-failure-surfaced').detail);

    // Which rows may be retried follows the hub, not a guess.
    const classification = step(report, 'retry-button-classification');
    assert.equal(classification.ok, true, classification.detail);
    t.diagnostic(`selftest ${report.steps.length} steps in ${report.elapsedMs}ms`);
  } finally {
    await hub.close();
  }
});

test('credentials are discovered from the environment like the CLI does', { skip }, async () => {
  const hub = await startStubHub();
  try {
    const out = path.join(tmp, `env-${randomUUID()}.json`);
    // No --url and no --token: only AGENTRELAY_URL / AGENTRELAY_TOKEN.
    const result = await run(exeFile, ['--selftest', '--out', out], cleanEnv({
      AGENTRELAY_URL: hub.url,
      AGENTRELAY_TOKEN: TOKEN,
    }));
    const report = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(result.code, 0, JSON.stringify(report.steps.filter((s) => !s.ok), null, 2));
    assert.equal(report.url, hub.url);
    assert.equal(report.tokenSource, 'env AGENTRELAY_TOKEN');
    assert.equal(step(report, 'nodes-list').ok, true, step(report, 'nodes-list').detail);
    assertHeadless(report);
    fs.rmSync(out, { force: true });
  } finally {
    await hub.close();
  }
});

test('a token file under AGENTRELAY_HOME is used when the environment is empty', { skip }, async () => {
  const hub = await startStubHub();
  const home = path.join(tmp, 'home');
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'relay.token'), `${TOKEN}\n`);
    const out = path.join(tmp, `tokenfile-${randomUUID()}.json`);
    const result = await run(exeFile, ['--selftest', '--url', hub.url, '--out', out], cleanEnv({}));
    const report = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(result.code, 0, JSON.stringify(report.steps.filter((s) => !s.ok), null, 2));
    assert.match(report.tokenSource, /relay\.token$/);
    assert.equal(step(report, 'nodes-list').ok, true, step(report, 'nodes-list').detail);
    fs.rmSync(out, { force: true });
  } finally {
    fs.rmSync(path.join(home, 'relay.token'), { force: true });
    await hub.close();
  }
});

test('a refused credential fails loudly instead of showing an empty client', { skip }, async () => {
  const hub = await startStubHub();
  try {
    const { code, report } = await headless('selftest', hub.url, 'wrong-token-but-long-enough-to-pass-the-shape-check');
    assert.equal(code, 1, 'a hub that refuses the credential must not exit 0');
    assert.equal(report.allOk, false);
    assert.equal(step(report, 'nodes-list').ok, false);
    assert.match(step(report, 'nodes-list').detail, /401/);
    assert.equal(step(report, 'auth-failure-surfaced').ok, true, 'the 401 probe itself still has to pass');
    assertHeadless(report);
  } finally {
    await hub.close();
  }
});

test('the token is never offered to a non-loopback hub', { skip }, async () => {
  const out = path.join(tmp, `remote-${randomUUID()}.json`);
  const result = await run(exeFile, ['--selftest', '--url', 'http://hub.example.com:9330', '--token', TOKEN, '--out', out], cleanEnv({}));
  assert.equal(result.code, 2, 'a non-loopback hub URL must be refused before any request');
  const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : result.stdout;
  assert.match(text, /non-loopback host hub\.example\.com/);
  assert.ok(!text.includes(TOKEN), 'the refusal must not echo the token');
  fs.rmSync(out, { force: true });
});

test('--livetest agrees with the hub that ships in lib/distributed.js', { skip }, async (t) => {
  const { runHub } = require('../lib/distributed');
  const dataDir = fs.mkdtempSync(path.join(tmp, 'live-hub-'));
  // An ambient allow-list would make the client's node registration fail for
  // reasons that have nothing to do with the client.
  const allowed = process.env.AGENTRELAY_ALLOWED_NODES;
  delete process.env.AGENTRELAY_ALLOWED_NODES;
  const server = await runHub({ host: '127.0.0.1', port: 0, dataDir, token: TOKEN });
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const { code, report, stderr } = await headless('livetest', url, TOKEN);
    assert.ok(report, `no report written; stderr: ${stderr}`);
    assert.equal(report.allOk, true, JSON.stringify(report.steps.filter((s) => !s.ok), null, 2));
    assert.equal(code, 0);
    assertHeadless(report);
    assert.ok(!JSON.stringify(report).includes(TOKEN), 'the token must not appear in the report');

    assert.equal(step(report, 'live-register-node').ok, true, step(report, 'live-register-node').detail);
    const nodes = step(report, 'live-nodes-list');
    assert.equal(nodes.ok, true, nodes.detail);
    assert.match(nodes.detail, /found=desktop-livetest online=True targets=coder/);
    assert.match(nodes.detail, /storeAcl=(private|inherited)/);

    // Measured against the shipped hub: GET /messages is the node claim poll, so
    // an operator credential gets no listing and the client reports that.
    const listing = step(report, 'live-listing-refused');
    assert.equal(listing.ok, true, listing.detail);
    assert.match(listing.detail, /http=4\d\d code=[A-Z_]+/);

    assert.equal(step(report, 'live-send-unknown-node-refused').ok, true, step(report, 'live-send-unknown-node-refused').detail);
    const sent = step(report, 'live-send-queued');
    assert.equal(sent.ok, true, sent.detail);
    assert.match(sent.detail, /status=queued mode=submit/);
    assert.equal(step(report, 'live-consent-replay-conflict').ok, true, step(report, 'live-consent-replay-conflict').detail);
    const detail = step(report, 'live-detail');
    assert.equal(detail.ok, true, detail.detail);
    assert.match(detail.detail, /textRoundTrip=exact/, 'the hand-written JSON must round-trip UTF-8 text with a newline');
    assert.equal(step(report, 'live-detail-unknown-id').ok, true, step(report, 'live-detail-unknown-id').detail);
    assert.equal(step(report, 'live-auth-refused').ok, true, step(report, 'live-auth-refused').detail);

    // Whether the retry endpoint has landed is a fact about this tree, not an
    // assumption: report which side of it we are on.
    const retry = step(report, 'live-retry-status-quo');
    assert.equal(retry.ok, true, retry.detail);
    t.diagnostic(`retry endpoint on this tree: ${retry.detail.split('|')[0].trim()}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (allowed !== undefined) process.env.AGENTRELAY_ALLOWED_NODES = allowed;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('modern shell opens without credentials and renders its real WPF views', {skip}, async () => {
  const home = fs.mkdtempSync(path.join(tmp,'modern-ui-'));
  const report = path.join(home,'report.json');
  const shot = path.join(home,'view');
  const result = await run(exeFile,['--ui-smoke','--out',report,'--shot',shot],cleanEnv({AGENTRELAY_HOME:home}));
  assert.equal(result.code,0,result.stderr);
  const data=JSON.parse(fs.readFileSync(report,'utf8'));
  assert.equal(data.ok,true,JSON.stringify(data));
  assert.equal(data.windowLoaded,true);
  assert.equal(data.bridgeReady,true);
  assert.equal(data.searchWorks,true);
  assert.equal(data.tokenRequiredForStartup,false);
  assert.equal(data.defaultRoute,'auto');
  assert.equal(data.graphNodes,5);
  assert.equal(data.graphEdges,3);
  assert.equal(data.nodeNavigation,true);
  assert.equal(data.sessionCompose,true);
  assert.equal(data.controlsReady,true);
  assert.equal(data.fleetReady,true);
  assert.equal(data.watchReady,true);
  assert.equal(data.sessionGrouping,true);
  assert.equal(data.sessionMasterDetail,true);
  assert.equal(data.recipientLabel,true);
  assert.equal(data.consentHint,true);
  assert.equal(data.cdpRecovery,true);
  for(const page of ['empty','overview','cdp-unavailable','sessions','session-agents','messages','compose','settings','controls','services','advanced','fleet','remote','watch'])assert.ok(fs.statSync(shot+'-'+page+'.png').size>10000);
});

