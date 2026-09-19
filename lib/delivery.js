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
    keys = ['type', 'socket', 'secret'];
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

function loadTargets(file) {
  if (typeof file !== 'string' || !file) throw failure('INVALID_CONFIG', 'A local targets JSON file is required');
  let value;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 256 * 1024) throw new Error('Targets file must be a regular file of at most 256 KiB');
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

async function deliver(target, text, { mode = 'submit', messageId = randomUUID() } = {}) {
  validateInput(text, mode, messageId);
  target = validateTarget(target);
  if (target.type === 'terminal') return sendTerminal(target, text, mode, messageId);
  if (mode !== 'submit') throw failure('UNSUPPORTED_MODE', 'ZCode desktop delivery only supports submit');
  const zcode = require('./adapters/zcode');
  try {
    await zcode.send(target.sessionId, text, {
      desktop: true,
      desktopStrict: true,
      cdpPort: target.cdpPort,
      cdpTargetId: target.cdpTargetId,
      timeoutMs: 15000,
    });
  } catch (error) {
    if (typeof error.uncertain !== 'boolean') error.uncertain = true;
    if (!error.code) error.code = 'DESKTOP_ERROR';
    throw error;
  }
  return { status: 'submitted', outcome: 'input-submitted', messageId };
}

module.exports = { loadTargets, deliver, validateInput, failure, NAME, MAX_REQUEST_BYTES };
