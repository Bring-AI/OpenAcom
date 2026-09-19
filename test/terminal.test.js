'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const pty = require('node-pty');
const { deliver } = require('../lib/delivery');

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
