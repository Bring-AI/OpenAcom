'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const pty = require('node-pty');
const { deliver } = require('../lib/delivery');
const { protectPath, aggregateAcl, currentPrincipal, PRIVATE, INHERITED } = require('../lib/secure-fs');
const { describeDescriptorConflict } = require('../lib/terminal');

function captureStderr() {
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
  return { written, restore: () => { process.stderr.write = original; } };
}

// Real PTYs catch both input packet-boundary bugs and nested Windows ConPTY
// switching the upstream terminal into Win32 encoded keyboard mode.
test('managed PTY accepts coalesced ownership controls and protects a visible draft', { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-pty-'));
  const program = path.join(dir, 'receiver.cjs');
  fs.writeFileSync(program, `
process.stdin.setRawMode(true); process.stdin.resume();
process.stdout.write('\x1b[?2004hRECEIVER_READY\\r\\n');
let bytes = '', draft = '';
process.stdin.on('data', chunk => {
  bytes += chunk.toString('utf8');
  while (bytes.length) {
    if (bytes.startsWith('\x1b[200~')) {
      const end = bytes.indexOf('\x1b[201~');
      if (end < 0) return;
      draft += bytes.slice(6, end); bytes = bytes.slice(end + 6);
      process.stdout.write('DRAFT:' + JSON.stringify(draft) + '\\r\\n');
    } else if (bytes[0] === '\\r') {
      process.stdout.write('SUBMIT:' + JSON.stringify(draft) + '\\r\\n'); draft = ''; bytes = bytes.slice(1);
    } else if ('\x1b[200~'.startsWith(bytes)) return;
    else bytes = bytes.slice(1);
  }
});
`);
  let output = '';
  let exited = false;
  const child = pty.spawn(process.execPath, [path.resolve(__dirname, '../bin/openacom.js'), 'terminal', '--name', 'test', '--data', dir, '--', process.execPath, program], {
    name: 'xterm-256color', cols: 120, rows: 30, cwd: dir, env: { ...process.env },
  });
  const subscription = child.onData(chunk => { output += chunk; });
  const exit = new Promise(resolve => child.onExit(() => { exited = true; resolve(); }));
  async function until(predicate) {
    const deadline = Date.now() + 8000;
    while (!predicate()) {
      if (exited || Date.now() > deadline) throw new Error('PTY condition not reached: ' + output.slice(-2000));
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try {
    await until(() => output.includes('RECEIVER_READY'));
    const target = JSON.parse(fs.readFileSync(path.join(dir, 'terminals', 'test.json'), 'utf8'));
    // M1: the descriptor has to state whether its paths really got tightened.
    assert.ok([PRIVATE, INHERITED].includes(target.acl), `descriptor must carry an acl marker, got ${JSON.stringify(target.acl)}`);
    await assert.rejects(deliver(target, 'locked', { mode: 'submit', messageId: randomUUID() }), { code: 'INPUT_LOCKED', uncertain: false });
    child.write('\x1dc\x1dA');
    await until(() => output.includes('Continuous remote ownership enabled'));
    assert.equal((await deliver(target, '你好\nline two', { mode: 'submit', messageId: randomUUID() })).outcome, 'input-submitted');
    await until(() => output.includes('SUBMIT:"你好\\nline two"'));
    assert.equal((await deliver(target, 'pending', { mode: 'draft', messageId: randomUUID() })).outcome, 'input-drafted');
    await until(() => output.includes('DRAFT:"pending"'));
    await assert.rejects(deliver(target, 'overwrite', { mode: 'submit', messageId: randomUUID() }), { code: 'PENDING_DRAFT', uncertain: false });
    assert.equal(output.includes('SUBMIT:"pending"'), false);
    assert.equal(output.includes('overwrite'), false);
  } finally {
    child.kill();
    const graceful = await Promise.race([exit.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 2000))]);
    if (!graceful) {
      child.kill('SIGKILL');
      await exit;
    }
    subscription.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(graceful, true, 'Terminal wrapper must release stdin and exit after shutdown');
  }
});

test('protectPath tightens POSIX paths through chmod', () => {
  const calls = [];
  const privateFile = protectPath('/tmp/openacom/x.json', {
    platform: 'linux',
    principal: 'tester',
    chmod: (target, mode) => calls.push([target, mode]),
    stat: () => ({ mode: 0o100600 }),
  });
  assert.equal(privateFile.acl, PRIVATE);
  assert.deepEqual(calls, [['/tmp/openacom/x.json', 0o600]]);
  const privateDir = protectPath('/tmp/openacom', {
    platform: 'linux',
    directory: true,
    principal: 'tester',
    chmod: (target, mode) => calls.push([target, mode]),
    stat: () => ({ mode: 0o040700 }),
  });
  assert.equal(privateDir.acl, PRIVATE);
  assert.deepEqual(calls[1], ['/tmp/openacom', 0o700]);
});

test('a chmod that did not change the bits is reported, not believed', () => {
  const stderr = captureStderr();
  try {
    // FAT/exFAT and some network mounts accept chmod and keep the old mode.
    const unchanged = protectPath('/media/usb/terminals', {
      platform: 'darwin',
      directory: true,
      principal: 'tester',
      chmod: () => {},
      stat: () => ({ mode: 0o040755 }),
    });
    assert.equal(unchanged.acl, INHERITED);
    assert.match(unchanged.error, /is still 0755 after chmod 0700/);
    assert.match(stderr.written.join(''), /OpenAcom secure-fs:.*still 0755/);
    const threw = protectPath('/media/usb/x.json', {
      platform: 'darwin',
      principal: 'tester',
      chmod: () => { throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' }); },
      stat: () => ({ mode: 0o100600 }),
    });
    assert.equal(threw.acl, INHERITED);
    assert.match(threw.error, /chmod 0600 on \/media\/usb\/x\.json failed: Operation not permitted/);
  } finally {
    stderr.restore();
  }
});

test('protectPath drives icacls through argv, never through a shell', () => {
  const seen = [];
  const spawn = (command, argv, options) => { seen.push({ command, argv, options }); return { status: 0, stdout: 'Successfully processed 1 files', stderr: '' }; };
  const awkward = 'C:\\Users\\First Last\\My App (data)\\terminals';
  assert.equal(protectPath(awkward, { platform: 'win32', directory: true, spawn, principal: 'WORKGROUP\\First Last' }).acl, PRIVATE);
  assert.deepEqual(seen, [{
    command: 'icacls',
    argv: [awkward, '/inheritance:r', '/grant:r', 'WORKGROUP\\First Last:(OI)(CI)F'],
    options: { encoding: 'utf8', windowsHide: true, shell: false },
  }]);
  seen.length = 0;
  protectPath('C:\\temp\\x.json', { platform: 'win32', spawn, principal: 'WORKGROUP\\tester' });
  assert.deepEqual(seen[0].argv, ['C:\\temp\\x.json', '/inheritance:r', '/grant:r', 'WORKGROUP\\tester:F'], 'a file must not get container inheritance flags');
});

test('a failed icacls is reported as inherited access and warned about', () => {
  const stderr = captureStderr();
  try {
    const rejected = protectPath('C:\\temp\\x.json', {
      platform: 'win32',
      spawn: () => ({ status: 1, stdout: '', stderr: 'No mapping between account names and security IDs was done.\r\n' }),
      principal: 'NOPE\\tester',
    });
    assert.equal(rejected.acl, INHERITED);
    assert.match(rejected.error, /icacls for C:\\temp\\x\.json exited 1/);
    assert.match(rejected.error, /No mapping between account names/);
    assert.equal(rejected.error.includes('\r'), false, 'icacls output is flattened before it reaches stderr');
    assert.match(stderr.written.join(''), /OpenAcom secure-fs:.*exited 1/);
    const missingTool = protectPath('C:\\temp\\x.json', {
      platform: 'win32',
      spawn: () => ({ error: Object.assign(new Error('spawn icacls ENOENT'), { code: 'ENOENT' }), status: null }),
      principal: 'WORKGROUP\\tester',
    });
    assert.equal(missingTool.acl, INHERITED);
    assert.match(missingTool.error, /could not start/);
    const noPrincipal = protectPath('C:\\temp\\x.json', { platform: 'win32', spawn: () => ({ status: 0 }), principal: '' });
    assert.equal(noPrincipal.acl, INHERITED);
    assert.match(noPrincipal.error, /OPENACOM_ACL_PRINCIPAL/);
    assert.equal(aggregateAcl([rejected, { acl: PRIVATE }]), INHERITED);
    assert.equal(aggregateAcl([{ acl: PRIVATE }, { acl: PRIVATE }]), PRIVATE);
  } finally {
    stderr.restore();
  }
});

// The injected-spawn cases above prove the argv; this proves icacls really does
// leave only the current account with access. It only ever touches a temp file.
test('real icacls strips inherited access from a private descriptor', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-acl-'));
  try {
    const principal = currentPrincipal();
    assert.ok(principal, 'the current Windows account must be resolvable');
    const file = path.join(dir, 'descriptor.json');
    fs.writeFileSync(file, '{}');
    const directory = protectPath(dir, { directory: true });
    assert.equal(directory.acl, PRIVATE, directory.error || '');
    assert.equal(directory.principal, principal);
    const leaf = protectPath(file);
    assert.equal(leaf.acl, PRIVATE, leaf.error || '');
    const listed = require('node:child_process').spawnSync('icacls', [file], { encoding: 'utf8', windowsHide: true });
    assert.equal(listed.status, 0);
    // icacls prints e.g. "MSI\someone:(F)" for what survived - no (I) lines.
    assert.match(listed.stdout, /:\((?:F|OI|CI)/, listed.stdout);
    assert.equal(listed.stdout.includes('(I)'), false, `inherited entries survived: ${listed.stdout}`);
    const listedDir = require('node:child_process').spawnSync('icacls', [dir], { encoding: 'utf8', windowsHide: true });
    assert.equal(listedDir.stdout.includes(`${principal}:`), true, listedDir.stdout);
    assert.match(listedDir.stdout, /\(OI\)\(CI\)\(F\)/, listedDir.stdout);
    assert.equal(listedDir.stdout.includes('(I)'), false, listedDir.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a leftover descriptor is explained without reusing it or leaking its secret', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-stale-'));
  try {
    const secret = 'c'.repeat(64);
    const absent = process.platform === 'win32' ? `\\\\.\\pipe\\openacom-${'d'.repeat(32)}` : path.join(dir, 'gone.sock');
    const stale = path.join(dir, 'stale.json');
    fs.writeFileSync(stale, JSON.stringify({ type: 'terminal', socket: absent, secret, acl: INHERITED }, null, 2) + '\n');
    const report = describeDescriptorConflict(stale);
    assert.match(report, /stale|no longer usable/i);
    assert.match(report, /not present|does not exist|cannot be inspected/);
    assert.match(report, /acl: "inherited"/);
    assert.equal(report.includes(secret), false, 'a conflict report must never echo the terminal secret');

    fs.writeFileSync(stale, 'not json at all');
    assert.match(describeDescriptorConflict(stale), /does not parse/);
    fs.writeFileSync(stale, JSON.stringify({ type: 'other', socket: absent }));
    assert.match(describeDescriptorConflict(stale), /not an OpenAcom terminal descriptor/);
    assert.match(describeDescriptorConflict(path.join(dir, 'missing.json')), /cannot be read/);

    if (process.platform === 'win32') {
      const pipe = `\\\\.\\pipe\\openacom-${'e'.repeat(32)}`;
      const server = require('node:net').createServer();
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
      try {
        fs.writeFileSync(stale, JSON.stringify({ type: 'terminal', socket: pipe, secret, acl: PRIVATE }));
        assert.match(describeDescriptorConflict(stale), /another managed terminal is live/);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
