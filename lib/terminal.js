'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { randomBytes, timingSafeEqual } = require('crypto');
const { StringDecoder } = require('string_decoder');
const { validateInput, failure, NAME, MAX_REQUEST_BYTES } = require('./delivery');

// Ownership is explicitly local: c confirms an empty composer, a grants one
// input, A grants continuous remote ownership, l locks. Any ordinary local
// input cancels the grant. A remote draft always locks until c and a/A.
async function runTerminal({ name, dataDir = path.join(os.homedir(), '.agentrelay'), command, args = [] } = {}) {
  if (typeof name !== 'string' || !NAME.test(name)) throw failure('INVALID_NAME', 'Terminal name must contain 1-64 letters, digits, dots, hyphens or underscores, starting with a letter or digit');
  if (typeof command !== 'string' || !command || command.includes('\0') || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw failure('INVALID_COMMAND', 'A local executable and string argument array are required');
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw failure('TTY_REQUIRED', 'Managed terminal requires a real interactive stdin and stdout TTY; no headless fallback');
  }
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    throw failure('INVALID_COMMAND', 'Launch a real executable. For a trusted local .cmd/.bat shim explicitly launch cmd.exe /d /s /c or use node.exe and the CLI script');
  }
  let pty;
  try { pty = require('node-pty'); }
  catch (error) { throw failure('PTY_UNAVAILABLE', `node-pty >=1.1.0 is required: ${error.message}`); }
  const directory = path.join(path.resolve(dataDir), 'terminals');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw failure('INVALID_DIRECTORY', 'Terminal descriptor directory must be a real directory');
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  const descriptorPath = path.join(directory, `${name}.json`);
  const secret = randomBytes(32).toString('hex');
  const secretBytes = Buffer.from(secret, 'ascii');
  let socketDirectory;
  let endpoint;
  if (process.platform === 'win32') {
    endpoint = `\\\\.\\pipe\\agentrelay-${randomBytes(16).toString('hex')}`;
  } else {
    socketDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrelay-'));
    fs.chmodSync(socketDirectory, 0o700);
    endpoint = path.join(socketDirectory, 'input.sock');
    if (Buffer.byteLength(endpoint) > 103) {
      fs.rmdirSync(socketDirectory);
      throw failure('SOCKET_PATH', 'Temporary directory path is too long for a Unix socket; set TMPDIR to a shorter private path');
    }
  }
  let child;
  let descriptorCreated = false;
  let finished = false;
  let inputInstalled = false;
  let dataSubscription;
  let exitSubscription;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const clients = new Set();
  const wasRaw = process.stdin.isRaw;
  const wasFlowing = process.stdin.readableFlowing;
  const decoder = new StringDecoder('utf8');
  let bracketedPaste = false;
  let outputTail = '';
  let outputPending = '';
  let pasteMatch = 0;
  let localPaste = false;
  let prefix = false;
  let ownership = 'locked';
  let needsConfirmation = true;
  let pendingDraft = false;
  let injecting = false;
  let manualBytes = 0;
  let queuedManual = [];
  let injectionTimer;
  let cancelInjection;
  const note = (text) => process.stderr.write(`\r\n[AgentRelay] ${text}\r\n`);

  function finish(code, kill = false) {
    if (finished) return;
    finished = true;
    clearTimeout(injectionTimer);
    if (cancelInjection) cancelInjection(failure('TERMINAL_EXITED', 'Terminal exited during input; do not blindly retry', true));
    if (kill && child) { try { child.kill(); } catch {} }
    dataSubscription?.dispose();
    exitSubscription?.dispose();
    if (inputInstalled) {
      process.stdin.removeListener('data', onInput);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onIoError);
      process.stdout.removeListener('resize', onResize);
      process.stdout.removeListener('drain', onDrain);
      process.stdout.removeListener('error', onIoError);
      try { process.stdin.setRawMode(Boolean(wasRaw)); } catch {}
      if (wasFlowing !== true) process.stdin.pause();
      try { process.stdout.write(outputPending + '\x1b[?2004l'); } catch {}
    }
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGHUP', onSighup);
    process.removeListener('exit', onProcessExit);
    for (const client of clients) client.destroy();
    try { server.close(); } catch {}
    if (descriptorCreated) { try { fs.unlinkSync(descriptorPath); } catch {} }
    if (socketDirectory) {
      try { fs.unlinkSync(endpoint); } catch {}
      try { fs.rmdirSync(socketDirectory); } catch {}
    }
    resolveDone(Number.isInteger(code) && code >= 0 ? code : 1);
  }
  function onSigint() { finish(130, true); }
  function onSigterm() { finish(143, true); }
  function onSighup() { finish(129, true); }
  function onProcessExit() { finish(1, true); }
  function onEnd() { finish(0, true); }
  function onIoError() { finish(1, true); }
  function onResize() {
    try { child.resize(process.stdout.columns || 80, process.stdout.rows || 24); }
    catch { finish(1, true); }
  }
  function onDrain() { if (!finished) child.resume(); }
  function forwardLocal(text) {
    ownership = 'locked';
    needsConfirmation = true;
    if (injecting) {
      manualBytes += Buffer.byteLength(text);
      if (manualBytes > 64 * 1024) {
        note('Local input overflow during injection; terminating rather than dropping input.');
        finish(1, true);
      } else queuedManual.push(text);
    } else {
      try { child.write(text); } catch { finish(1, true); }
    }
  }
  function control(key) {
    if (key === 'l') {
      ownership = 'locked';
      note('Remote input locked.');
    } else if (key === 'c') {
      ownership = 'locked';
      needsConfirmation = false;
      pendingDraft = false;
      note('You confirmed the composer is empty. Ctrl-] a arms once; Ctrl-] A grants continuous remote ownership.');
    } else if (key === 'a' || key === 'A') {
      if (pendingDraft || needsConfirmation) {
        note('Not armed: manually clear/submit any existing input, then Ctrl-] c to confirm the composer is empty.');
      } else if (!bracketedPaste) {
        note('Not armed: application has not enabled bracketed paste.');
      } else {
        ownership = key === 'A' ? 'continuous' : 'once';
        note(key === 'A' ? 'Continuous remote ownership enabled until local input/lock/draft. No busy detection: input may steer or queue in this TUI.' : 'One remote input armed.');
      }
    } else if (key === '\x1d') {
      forwardLocal('\x1d');
    } else {
      forwardLocal('\x1d' + key);
    }
  }
  function onInput(chunk) {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    if (!text || finished) return;
    let ordinary = '';
    const flush = () => {
      if (ordinary) { forwardLocal(ordinary); ordinary = ''; }
    };
    // Input is a stream: control prefixes and clipboard delimiters may span
    // reads, and several local controls may arrive in the same read.
    for (const key of text) {
      const wasPasting = localPaste;
      const marker = localPaste ? '\x1b[201~' : '\x1b[200~';
      if (key === marker[pasteMatch]) {
        pasteMatch++;
        if (pasteMatch === marker.length) { localPaste = !localPaste; pasteMatch = 0; }
      } else {
        pasteMatch = key === '\x1b' ? 1 : 0;
      }
      if (injecting || wasPasting || localPaste) {
        if (prefix) { ordinary += '\x1d'; prefix = false; }
        ordinary += key;
      } else if (prefix) {
        flush();
        prefix = false;
        control(key);
      } else if (key === '\x1d') {
        flush();
        prefix = true;
      } else {
        ordinary += key;
      }
      if (finished) return;
    }
    flush();
  }
  function filterWindowsInputMode(text) {
    // ConPTY asks terminal frontends for Win32 key events. This wrapper is the
    // frontend: passing that request to the outer terminal changes our stdin
    // byte protocol. Consume only mode 9001, retaining other private modes.
    const filtered = (outputPending + text).replace(/\x1b\[\?([0-9;]+)([hl])/g, (sequence, parameters, action) => {
      const modes = parameters.split(';');
      if (!modes.includes('9001')) return sequence;
      const remaining = modes.filter((mode) => mode !== '9001');
      return remaining.length ? '\x1b[?' + remaining.join(';') + action : '';
    });
    const partial = /\x1b(?:\[(?:\?[0-9;]*)?)?$/.exec(filtered);
    outputPending = partial ? partial[0] : '';
    return partial ? filtered.slice(0, partial.index) : filtered;
  }
  function onOutput(text) {
    const scan = outputTail + text;
    for (const match of scan.matchAll(/\x1b\[\?([0-9;]+)([hl])|\x1bc/g)) {
      if (!match[1]) bracketedPaste = false;
      else if (match[1].split(';').includes('2004')) bracketedPaste = match[2] === 'h';
    }
    outputTail = scan.slice(-64);
    const visible = process.platform === 'win32' ? filterWindowsInputMode(text) : text;
    if (visible && !process.stdout.write(visible)) child.pause();
  }
  async function inject(request) {
    if (finished || !child) throw failure('TERMINAL_EXITED', 'Terminal is not running');
    if (injecting) throw failure('INPUT_BUSY', 'Another input delivery is in progress');
    if (pendingDraft) throw failure('PENDING_DRAFT', 'A previous draft is pending; local operator must clear/submit it and confirm with Ctrl-] c');
    if (ownership === 'locked' || needsConfirmation || prefix) throw failure('INPUT_LOCKED', 'Remote input is locked; local operator must confirm empty composer with Ctrl-] c and arm with a or A');
    if (!bracketedPaste) throw failure('PASTE_UNAVAILABLE', 'Application has not enabled bracketed paste; refusing unsafe injection');
    const continuous = ownership === 'continuous';
    ownership = continuous ? 'continuous' : 'locked';
    needsConfirmation = !continuous;
    injecting = true;
    let attempted = false;
    try {
      attempted = true;
      child.write('\x1b[200~' + request.text + '\x1b[201~');
      // Keep Enter a distinct PTY write/event, never part of the paste payload.
      await new Promise((resolve, reject) => {
        cancelInjection = reject;
        injectionTimer = setTimeout(resolve, 50);
      });
      cancelInjection = undefined;
      if (finished || !bracketedPaste) throw failure('INPUT_UNCERTAIN', 'Terminal exited or disabled bracketed paste after insertion', true);
      if (request.mode === 'submit') {
        child.write('\r');
      } else {
        pendingDraft = true;
        ownership = 'locked';
        needsConfirmation = true;
      }
      const status = request.mode === 'submit' ? 'submitted' : 'drafted';
      return { ok: true, status, outcome: `input-${status}`, messageId: request.messageId };
    } catch (error) {
      ownership = 'locked';
      needsConfirmation = true;
      pendingDraft = attempted;
      throw failure(error.code || 'INPUT_UNCERTAIN', error.message, attempted);
    } finally {
      cancelInjection = undefined;
      injecting = false;
      if (!finished && queuedManual.length) {
        const queued = queuedManual;
        queuedManual = [];
        manualBytes = 0;
        for (const text of queued) forwardLocal(text);
      }
    }
  }
  const server = net.createServer((client) => {
    clients.add(client);
    let received = 0;
    let handled = false;
    const chunks = [];
    const deadline = setTimeout(() => client.destroy(), 5000);
    client.on('error', () => {});
    client.on('close', () => { clearTimeout(deadline); clients.delete(client); });
    const reply = (value) => { if (!client.destroyed) client.end(JSON.stringify(value) + '\n'); };
    const reject = (error) => reply({ ok: false, error: { code: error.code || 'INVALID_REQUEST', message: error.message.slice(0, 1000), uncertain: error.uncertain === true } });
    client.on('data', (chunk) => {
      if (handled) return;
      received += chunk.length;
      if (received > MAX_REQUEST_BYTES) { handled = true; reject(failure('REQUEST_TOO_LARGE', 'Local request is too large')); return; }
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      handled = true;
      try {
        const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!request || typeof request !== 'object' || Array.isArray(request)) throw failure('INVALID_REQUEST', 'Expected an input request object');
        if (typeof request.secret !== 'string' || !/^[a-f0-9]{64}$/.test(request.secret) || !timingSafeEqual(Buffer.from(request.secret, 'ascii'), secretBytes)) {
          throw failure('UNAUTHORIZED', 'Invalid local terminal credentials');
        }
        if (Object.keys(request).some((key) => !['secret', 'text', 'mode', 'messageId'].includes(key))) throw failure('INVALID_REQUEST', 'Unsupported input request properties');
        validateInput(request.text, request.mode, request.messageId);
        inject(request).then(reply, reject);
      } catch (error) { reject(error); }
    });
  });
  server.maxConnections = 32;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, () => { server.removeListener('error', reject); resolve(); });
    });
    server.on('error', () => finish(1, true));
    if (process.platform !== 'win32') fs.chmodSync(endpoint, 0o600);
    // Never overwrite a live (or stale) descriptor silently. Stale descriptors
    // may be removed locally only after checking that the wrapper is not alive.
    fs.writeFileSync(descriptorPath, JSON.stringify({ type: 'terminal', socket: endpoint, secret }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    descriptorCreated = true;
    child = pty.spawn(command, args, {
      name: process.env.TERM || 'xterm-256color',
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
      cwd: process.cwd(),
      env: { ...process.env },
    });
    dataSubscription = child.onData(onOutput);
    exitSubscription = child.onExit(({ exitCode, signal }) => finish(signal ? 128 + signal : exitCode));
    process.stdin.setRawMode(true);
    inputInstalled = true;
    process.stdin.on('data', onInput);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onIoError);
    process.stdout.on('resize', onResize);
    process.stdout.on('drain', onDrain);
    process.stdout.on('error', onIoError);
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    process.on('SIGHUP', onSighup);
    process.on('exit', onProcessExit);
    process.stdin.resume();
    note(`Terminal ${name}; descriptor: ${descriptorPath}`);
    note('Remote input starts locked. Confirm empty composer: Ctrl-] c; arm once: Ctrl-] a; continuous ownership: Ctrl-] A; lock: Ctrl-] l.');
    note('Any local input or remote draft locks delivery. Continuous mode cannot detect model activity; input may steer/queue. Ctrl-] Ctrl-] sends a literal Ctrl-].');
    return await done;
  } catch (error) {
    finish(1, true);
    if (error.code === 'EEXIST') throw failure('DESCRIPTOR_EXISTS', `Descriptor already exists: ${descriptorPath}; remove it only after confirming the old wrapper is stopped`);
    throw error;
  }
}

module.exports = { runTerminal };
