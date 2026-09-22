'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const { randomUUID } = require('crypto');

const MAX_TEXT_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 512 * 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function failure(code, message, uncertain = false) {
  return Object.assign(new Error(message), { code, uncertain });
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateInput(text, mode, messageId) {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > MAX_TEXT_BYTES) {
    throw failure('INVALID_TEXT', 'Message text must be non-empty and at most 64 KiB');
  }
  // LF is literal content inside bracketed paste. CR, ESC, C0/C1 and DEL are not.
  if (/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(text)) {
    throw failure('INVALID_TEXT', 'Message text may contain LF, but no other terminal control characters');
  }
  if (mode !== 'submit' && mode !== 'draft') throw failure('INVALID_MODE', 'Mode must be submit or draft');
  if (typeof messageId !== 'string' || !UUID.test(messageId)) throw failure('INVALID_ID', 'messageId must be a UUID');
}

function validateTarget(target) {
  if (!object(target)) throw failure('INVALID_TARGET', 'Each target must be an object');
  let keys;
  if (target.type === 'terminal') {
    keys = ['type', 'socket', 'secret', 'acl'];
    if (typeof target.socket !== 'string' || /[\u0000-\u001f\u007f]/u.test(target.socket)) {
      throw failure('INVALID_TARGET', 'Terminal socket must be a local socket path');
    }
    if (process.platform === 'win32') {
      // openacom- is the current prefix; agentrelay- stays valid so existing
      // targets.json descriptors keep working across the rename
      if (!/^\\\\\.\\pipe\\(openacom|agentrelay)-[a-f0-9]{32}$/.test(target.socket)) {
        throw failure('INVALID_TARGET', 'Terminal socket must be a local OpenAcom named pipe');
      }
    } else if (!path.isAbsolute(target.socket) || Buffer.byteLength(target.socket) > 103) {
      throw failure('INVALID_TARGET', 'Terminal socket must be an absolute Unix socket path of at most 103 bytes');
    }
    if (typeof target.secret !== 'string' || !/^[a-f0-9]{64}$/.test(target.secret)) {
      throw failure('INVALID_TARGET', 'Terminal secret must be copied from its descriptor (64 hexadecimal characters)');
    }
    // Set by lib/secure-fs.js when icacls/chmod could not take the descriptor
    // away from everyone but the owner. Delivering is still allowed, silently
    // ignoring it is not - see warnOnce().
    if (target.acl !== undefined && target.acl !== 'private' && target.acl !== 'inherited') {
      throw failure('INVALID_TARGET', 'Terminal acl must be private or inherited');
    }
  } else if (target.type === 'zcode') {
    keys = ['type', 'sessionId', 'cdpPort', 'cdpTargetId'];
    if (typeof target.sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(target.sessionId)) {
      throw failure('INVALID_TARGET', 'ZCode sessionId is invalid');
    }
    if (target.cdpPort !== undefined && (!Number.isInteger(target.cdpPort) || target.cdpPort < 1 || target.cdpPort > 65535)) {
      throw failure('INVALID_TARGET', 'ZCode cdpPort must be an integer from 1 through 65535');
    }
    if (target.cdpTargetId !== undefined && (typeof target.cdpTargetId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(target.cdpTargetId))) {
      throw failure('INVALID_TARGET', 'ZCode cdpTargetId must be a CDP page target id');
    }
  } else {
    throw failure('INVALID_TARGET', 'Target type must be terminal or zcode');
  }
  if (Object.keys(target).some((key) => !keys.includes(key))) throw failure('INVALID_TARGET', 'Target contains unsupported properties');
  return Object.freeze({ ...target });
}

const warned = new Set();
function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  process.stderr.write(`OpenAcom delivery: ${message}\n`);
}

function loadTargets(file) {
  if (typeof file !== 'string' || !file) throw failure('INVALID_CONFIG', 'A local targets JSON file is required');
  let value;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 256 * 1024) throw new Error('Targets file must be a regular file of at most 256 KiB');
      if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
        warnOnce(`mode:${file}`, `${file} holds target secrets and is 0${(stat.mode & 0o777).toString(8)}; run "chmod go-rwx ${file}" (on Windows icacls is the only real gate, see the acl marker)`);
      }
      value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally { fs.closeSync(fd); }
  } catch (error) {
    throw failure('INVALID_CONFIG', `Cannot load targets: ${error.message}`);
  }
  if (!object(value)) throw failure('INVALID_CONFIG', 'Targets JSON must map local target names to descriptors');
  const targets = Object.create(null);
  for (const [name, target] of Object.entries(value)) {
    if (!NAME.test(name)) throw failure('INVALID_CONFIG', `Invalid target name: ${JSON.stringify(name)}`);
    try { targets[name] = validateTarget(target); }
    catch (error) { throw failure('INVALID_CONFIG', `Invalid target ${name}: ${error.message}`); }
    if (targets[name].acl === 'inherited') {
      warnOnce(`acl:${name}:${targets[name].socket}`, `target ${name} was created without tightened file permissions (acl: "inherited"); its socket and secret are protected only by the local secret in ${file}`);
    }
  }
  return Object.freeze(targets);
}

function sendTerminal(target, text, mode, messageId) {
  return new Promise((resolve, reject) => {
    let attempted = false;
    let settled = false;
    let received = 0;
    const chunks = [];
    const socket = net.createConnection(target.socket);
    const timer = setTimeout(() => finish(failure('IPC_TIMEOUT', 'Terminal delivery timed out; do not blindly retry', attempted)), 10000);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    }
    socket.on('connect', () => {
      attempted = true;
      socket.write(JSON.stringify({ secret: target.secret, text, mode, messageId }) + '\n');
    });
    socket.on('data', (chunk) => {
      received += chunk.length;
      if (received > 16384) return finish(failure('IPC_PROTOCOL', 'Terminal response is too large', attempted));
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (response.ok === false && object(response.error) && typeof response.error.message === 'string' && typeof response.error.uncertain === 'boolean') {
          return finish(failure(typeof response.error.code === 'string' ? response.error.code : 'TERMINAL_ERROR', response.error.message.slice(0, 1000), response.error.uncertain));
        }
        const status = mode === 'submit' ? 'submitted' : 'drafted';
        if (response.ok !== true || response.status !== status || response.messageId !== messageId || response.outcome !== `input-${status}`) {
          throw new Error('Unexpected terminal response');
        }
        finish(null, { status, outcome: response.outcome, messageId });
      } catch (error) { finish(failure('IPC_PROTOCOL', error.message, attempted)); }
    });
    socket.on('error', (error) => finish(failure('IPC_ERROR', `Terminal IPC: ${error.message}`, attempted)));
    socket.on('end', () => finish(failure('IPC_CLOSED', 'Terminal disconnected before acknowledging input', attempted)));
    socket.on('close', () => finish(failure('IPC_CLOSED', 'Terminal closed before acknowledging input', attempted)));
  });
}

// M2: a descriptor can outlive the managed terminal that wrote it, or point at
// something that is not our socket at all. Say what is wrong instead of
// reconnecting to it or deleting it behind the operator's back.
function inspectTerminalEndpoint(socket, {
  platform = process.platform,
  exists = (target) => fs.existsSync(target),
  lstat = (target) => fs.lstatSync(target),
  stat = (target) => fs.statSync(target),
} = {}) {
  if (typeof socket !== 'string' || !socket) return { code: 'INVALID_TARGET', message: 'Terminal descriptor has no socket' };
  if (platform === 'win32') {
    // Named pipes expose no POSIX mode, and stat() on a live pipe answers EBUSY;
    // presence is what can be checked without touching a session.
    if (!exists(socket)) {
      return { code: 'DESCRIPTOR_STALE', message: `Named pipe ${socket} is not present, so no managed terminal is listening on it` };
    }
    return null;
  }
  let found;
  try {
    found = lstat(socket);
  } catch (error) {
    if (error.code === 'ENOENT') return { code: 'DESCRIPTOR_STALE', message: `Socket ${socket} does not exist, so no managed terminal is listening on it` };
    if (error.code === 'ENOTDIR' || error.code === 'EACCES') {
      return { code: 'DESCRIPTOR_STALE', message: `Socket ${socket} cannot be inspected (${error.code}); the descriptor no longer points at a reachable terminal` };
    }
    return { code: 'DESCRIPTOR_ANOMALY', message: `Cannot inspect ${socket}: ${error.message}` };
  }
  if (!found.isSocket()) return { code: 'DESCRIPTOR_ANOMALY', message: `${socket} is not a socket (mode 0${(found.mode & 0o777).toString(8)})` };
  if ((found.mode & 0o077) !== 0) {
    return { code: 'DESCRIPTOR_PERMISSION', message: `${socket} is mode 0${(found.mode & 0o777).toString(8)}, so other local users can push input into this terminal; run "chmod 600 ${socket}" or restart the wrapper` };
  }
  const directory = path.dirname(socket);
  let parent;
  try {
    parent = stat(directory);
  } catch (error) {
    return { code: 'DESCRIPTOR_ANOMALY', message: `Cannot inspect the directory of ${socket}: ${error.message}` };
  }
  if ((parent.mode & 0o022) !== 0) {
    return { code: 'DESCRIPTOR_PERMISSION', message: `Directory ${directory} is mode 0${(parent.mode & 0o777).toString(8)}, so another local user can replace ${path.basename(socket)}; run "chmod 700 ${directory}" or restart the wrapper` };
  }
  return null;
}

async function deliver(target, text, { mode, messageId = randomUUID(), consent = false } = {}) {
  const isDesktop = object(target) && target.type !== 'terminal';
  // Desktop input lands in a window somebody may be using, so submit is opt-in
  // there; a managed terminal stays on its previous submit default because the
  // local operator armed it explicitly.
  const effectiveMode = mode === undefined ? (isDesktop ? 'draft' : 'submit') : mode;
  validateInput(text, effectiveMode, messageId);
  target = validateTarget(target);
  if (target.type === 'terminal') {
    if (target.acl === 'inherited') {
      warnOnce(`acl-socket:${target.socket}`, 'this terminal descriptor was written without tightened permissions (acl: "inherited"); see lib/secure-fs.js');
    }
    const issue = inspectTerminalEndpoint(target.socket);
    if (issue) throw failure(issue.code, `${issue.message}. Refresh the descriptor with "openacom terminal" before delivering`, false);
    return sendTerminal(target, text, effectiveMode, messageId);
  }
  const desktop = require('./desktop-delivery');
  // Checked here as well as inside sendDesktopStrict, so a desktop submit that
  // was never authorised does not even read the local session database.
  if (effectiveMode === 'submit') {
    const gate = desktop.consentFailure(consent === true);
    if (gate) throw gate;
  }
  const zcode = require('./adapters/zcode');
  try {
    const outcome = await desktop.sendDesktopStrict(zcode.get(target.sessionId), text, {
      mode: effectiveMode,
      consent: consent === true,
      cdpPort: target.cdpPort,
      cdpTargetId: target.cdpTargetId,
      timeoutMs: 15000,
    });
    const expected = effectiveMode === 'submit' ? 'submitted' : 'drafted';
    if (!outcome || outcome.status !== expected || outcome.outcome !== `input-${expected}`) {
      throw failure('INVALID_DELIVERY_RESULT', 'Desktop delivery did not confirm its own outcome', true);
    }
    return { status: expected, outcome: outcome.outcome, messageId };
  } catch (error) {
    if (typeof error.uncertain !== 'boolean') error.uncertain = true;
    if (!error.code) error.code = 'DESKTOP_ERROR';
    throw error;
  }
}

module.exports = { loadTargets, deliver, validateInput, validateTarget, inspectTerminalEndpoint, failure, NAME, MAX_REQUEST_BYTES };
