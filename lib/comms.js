'use strict';
// Pure embedded entry. Host adapters own execution and routing; no retry or fallback.
const { createHash, randomUUID } = require('node:crypto');
const DEFAULT_HISTORY_LIMIT = 200;
const DEFAULT_PREVIEW_LIMIT = 2000;
const states = new Set(['accepted', 'refused', 'uncertain']);
const failure = (code, message) => Object.assign(new Error(message), { code, uncertain: false });
// Copy through an owned buffer so a preview cannot retain a large parent string.
const copy = (value, limit) => Buffer.from(String(value).slice(0, limit), 'utf16le').toString('utf16le');

function parseAddress(address, resolvers = []) {
  if (typeof address !== 'string' || !address.trim()) throw failure('ADDRESS_INVALID', 'address must be a non-empty string');
  const text = address.trim();
  for (const resolve of resolvers) {
    const parsed = resolve(text);
    if (parsed) {
      if ((parsed.kind === 'session' && typeof parsed.sessionId === 'string' && parsed.sessionId) ||
          (parsed.kind === 'node' && typeof parsed.nodeId === 'string' && parsed.nodeId && typeof parsed.target === 'string' && parsed.target)) return parsed;
      throw failure('ADDRESS_INVALID', 'resolver returned an unsupported or incomplete address');
    }
  }
  const node = /^node:([^/\s]+)\/(\S+)$/.exec(text);
  if (node) return { kind: 'node', nodeId: node[1], target: node[2] };
  if (text.startsWith('node:')) throw failure('ADDRESS_INVALID', 'node address requires node:<nodeId>/<target>');
  const session = /^([A-Za-z][A-Za-z0-9_.-]*):(\S+)$/.exec(text);
  if (session) return { kind: 'session', agent: session[1], sessionId: session[2] };
  throw failure('ADDRESS_INVALID', 'expected agent:sessionId or node:<nodeId>/<target>');
}

function normalizeResult(raw, messageId) {
  const result = { messageId, status: 'uncertain' };
  if (raw && typeof raw === 'object') {
    if (typeof raw.accepted === 'boolean') {
      const stages = Array.isArray(raw.prompt?.stages) ? raw.prompt.stages : [];
      result.status = !raw.accepted ? 'refused' : stages.includes('turn_started') ? 'accepted' : 'uncertain';
    } else if (states.has(raw.status)) result.status = raw.status;
    if (raw.code !== undefined) result.code = copy(raw.code, 200);
    if (raw.detail !== undefined) result.detail = copy(raw.detail, 500);
  } else if (typeof raw === 'string') {
    // Legacy adapters return unstructured text: it cannot prove acceptance.
    result.detail = copy(raw, 500);
  }
  return result;
}

function makeClient(opts, service) {
  const adapter = opts.adapter;
  const resolvers = [].concat(opts.addressResolver || []);
  const limit = opts.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 10000) throw failure('INVALID_ARGUMENT', 'historyLimit must be an integer from 0 to 10000');
  const ring = [];
  let disposed = false;
  const guard = () => { if (disposed) throw failure('DISPOSED', 'this client has been disposed'); };
  const defaultGuard = () => {
    if (opts.home !== undefined) throw failure('HOME_UNSUPPORTED', 'built-in session adapters cannot isolate a custom home; inject a host adapter');
  };
  // Reuse the CLI/MCP SDK for legacy sessions and relay operations, only on demand.
  const sdk = () => require('./sdk');
  const relayOptions = { url: opts.url, token: opts.token };

  async function send(to, text, sendOpts = {}) {
    guard();
    if (typeof text !== 'string' || !text.trim()) throw failure('EMPTY_MESSAGE', 'message text must be non-empty');
    if (sendOpts.id !== undefined && sendOpts.requestId !== undefined && sendOpts.id !== sendOpts.requestId) throw failure('INVALID_ARGUMENT', 'id and requestId must agree');
    const messageId = sendOpts.requestId ?? sendOpts.id ?? randomUUID();
    if (typeof messageId !== 'string' || !messageId.trim() || messageId.length > 200) throw failure('INVALID_ARGUMENT', 'message ID must contain 1 to 200 characters');
    const from = sendOpts.from === undefined ? opts.from : sendOpts.from;
    if (from !== undefined && from !== null && (typeof from !== 'string' || from.length > 2000)) throw failure('INVALID_ARGUMENT', 'from must be a string of at most 2000 characters');
    if (typeof to !== 'string' || to.length > 2000) throw failure('ADDRESS_INVALID', 'to must be a string of at most 2000 characters');
    const entry = {
      messageId, from, to, at: Date.now(), bytes: Buffer.byteLength(text, 'utf8'),
      sha12: createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12),
      textPreview: copy(text, DEFAULT_PREVIEW_LIMIT), truncated: text.length > DEFAULT_PREVIEW_LIMIT,
    };
    let result;
    let delegated = false;
    try {
      const parsed = parseAddress(to, resolvers);
      const pass = { ...sendOpts, id: messageId, requestId: messageId, ...(from === undefined ? {} : { from }) };
      if (parsed.kind === 'node') {
        if (!service) throw failure('REQUIRES_SERVICE', 'node addresses require createCommunicationService');
        delegated = true;
        const response = await sdk().relaySend(parsed.nodeId, parsed.target, text, { ...relayOptions, ...pass });
        // Queue acceptance is not confirmation of input delivery or model activity.
        result = { messageId, status: 'uncertain', code: 'RELAY_QUEUED', detail: copy(`hub:${response?.status || 'queued'}`, 500) };
      } else if (adapter) {
        delegated = true;
        result = normalizeResult(await adapter.send(parsed.sessionId, text, pass), messageId);
      } else {
        defaultGuard();
        if (!sdk().agents().includes(parsed.agent)) throw failure('ADDRESS_UNKNOWN_AGENT', `unknown built-in agent: ${parsed.agent}`);
        delegated = true;
        result = normalizeResult(await sdk().send(parsed.sessionId, text, { ...pass, agent: parsed.agent }), messageId);
      }
    } catch (error) {
      result = { messageId, status: delegated && error?.uncertain !== false ? 'uncertain' : 'refused',
        ...(error?.code === undefined ? {} : { code: copy(error.code, 200) }), detail: copy(error?.message || error, 500) };
    }
    Object.assign(entry, result);
    // A send already delegated may finish after shutdown, but cannot repopulate history.
    if (!disposed && limit) { ring.push(entry); if (ring.length > limit) ring.shift(); }
    return { ...entry };
  }
  const client = {
    send,
    async list(options = {}) { guard(); if (adapter) return adapter.list(options); defaultGuard(); return sdk().listSessions(options); },
    async read(id, options = {}) { guard(); if (adapter) return adapter.read(id, options); defaultGuard(); return sdk().readSession(id, options); },
    history(filter = {}) { guard(); return ring.filter(row => ['from', 'to', 'status', 'code'].every(key => filter[key] === undefined || row[key] === filter[key])).map(row => ({ ...row })); },
    async dispose() { disposed = true; ring.length = 0; },
    get disposed() { return disposed; },
  };
  if (service) {
    client.relayNodes = async () => { guard(); return sdk().relayNodes(relayOptions); };
    client.relayStatus = async id => { guard(); return sdk().relayStatus(id, relayOptions); };
  }
  return client;
}
function createClient(opts = {}) { return makeClient(opts, false); }
function createCommunicationService(opts = {}) { return makeClient(opts, true); }
module.exports = { createClient, createCommunicationService, parseAddress, DEFAULT_HISTORY_LIMIT, DEFAULT_PREVIEW_LIMIT };


