'use strict';
// Durable inbox first, one selected delivery route, never automatic retries.
const { randomUUID, createHash } = require('node:crypto');
const fail = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code, uncertain: false });
const address = /^[A-Za-z][A-Za-z0-9_.-]*:\S+$/;
const routes = ['auto', 'session', 'desktop', 'desktopcdp', 'relay', 'mailbox'];

async function sendRouted(to, text, opts = {}) {
  const sdk = require('./sdk');
  const inbox = require('./inbox');
  if (typeof to !== 'string' || !address.test(to) || to.length > 2000) throw fail('INVALID_ARGUMENT', 'invalid "to": expected agent:sessionId or node:nodeId/target');
  if (typeof opts.from !== 'string' || !address.test(opts.from) || opts.from.length > 2000) throw fail('INVALID_ARGUMENT', 'invalid "from": expected agent:sessionId');
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 65536) throw fail('INVALID_ARGUMENT', 'message must contain 1 to 65536 UTF-8 bytes');
  const requested = opts.route ?? 'auto';
  if (!routes.includes(requested)) throw fail('INVALID_ROUTE', `route must be ${routes.join(', ')}`);
  if (opts.requireRead || opts.ackTimeoutMs !== undefined) throw fail('INVALID_ARGUMENT', 'routed delivery does not retry or wait for read receipts; use ack_message on the stored ID');
  const id = opts.requestId ?? opts.id ?? randomUUID();
  if (typeof id !== 'string' || !id.trim() || id.length > 200 || (opts.id !== undefined && opts.id !== id)) throw fail('INVALID_ARGUMENT', 'id and requestId must agree and contain 1 to 200 characters');
  const colon = to.indexOf(':');
  const agent = to.slice(0, colon), sessionId = to.slice(colon + 1);
  const remote = /^node:([^/\s]+)\/(\S+)$/.exec(to);
  if (agent === 'node' && !remote) throw fail('INVALID_ARGUMENT', 'node address requires node:nodeId/target');
  const known = agent !== 'node' && sdk.agents().includes(agent);
  const route = requested === 'auto' ? (remote ? 'relay' : agent === 'zcode' && opts.desktop !== false ? 'desktopcdp' : 'session') : requested;
  if ((route === 'relay') !== !!remote && route !== 'mailbox') throw fail('INVALID_ROUTE', 'relay requires a node address; local routes require a session address');
  if (sessionId === 'new' && known) throw fail('INVALID_ARGUMENT', 'routed delivery needs an existing session; create it first or use legacy inject:true');
  if (opts.desktop !== undefined && opts.desktop !== (route === 'desktop' || route === 'desktopcdp')) throw fail('INVALID_ROUTE', 'desktop option conflicts with route; select route:desktop or route:session');
  if (route === 'mailbox' && (opts.wait || opts.timeoutMs !== undefined || opts.consent !== undefined)) throw fail('INVALID_ROUTE', 'mailbox route only stores; delivery options need a live route');
  if (opts.mode !== undefined && route !== 'relay') throw fail('INVALID_ROUTE', 'mode only applies to relay');
  if (route === 'relay' && opts.wait) throw fail('INVALID_ROUTE', 'relay returns queue state; use relay_status rather than wait');
  if (opts.consent !== undefined && typeof opts.consent !== 'boolean') throw fail('INVALID_ARGUMENT', 'consent must be boolean');
  if (opts.cdpPort !== undefined && (!Number.isInteger(opts.cdpPort) || opts.cdpPort < 1 || opts.cdpPort > 65535)) throw fail('INVALID_ARGUMENT', 'cdpPort must be an integer from 1 to 65535');
  if ((opts.cdpPort !== undefined || opts.cdpTargetId !== undefined) && route !== 'desktopcdp') throw fail('INVALID_ROUTE', 'CDP endpoint options require desktopcdp');
  // Persist the routing decision with the identity to prevent a replay switching transports.
  const key = createHash('sha256').update(JSON.stringify({route, cdpPort:route === 'desktopcdp' ? (opts.cdpPort ?? 9222) : null, cdpTargetId:opts.cdpTargetId ?? null, noSignature:opts.noSignature === true, mode:opts.mode ?? null, url:opts.url ?? null, consent:opts.consent ?? null})).digest('hex');
  // Admission is synchronous: an ID can be claimed only once before any await.
  const previous = inbox.get(id);
  if (previous) {
    if (previous.from_addr !== opts.from || previous.to_addr !== to || previous.text !== text || previous.route_key !== key) throw fail('ID_CONFLICT', 'message ID already belongs to another payload or route');
    return { ...(previous.route_result ? JSON.parse(previous.route_result) : {id, messageId:id, from:opts.from, to, route, status:'uncertain', code:'DELIVERY_IN_PROGRESS'}), replayed:true };
  }
  inbox.create({id, fromAddr:opts.from, toAddr:to, agent, sessionId, text, maxAttempts:1});
  inbox.setFields(id, {delivery:route, route_key:key});
  let delegated = false;
  let result;
  try {
    if (route === 'mailbox') {
      result = {status:'stored', code:'MAILBOX_ONLY'};
    } else {
      const pass = {...opts, id, requestId:id, noWait:opts.wait !== true, desktop:false};
      const body = opts.noSignature ? text : `${text}\n\n[via OpenAcom · from ${opts.from}; message ${id}]`;
      let raw;
      if (route === 'relay') {
        delegated = true;
        inbox.setFields(id, {attempts:1, status:'uncertain'});
        raw = await sdk.relaySend(remote[1], remote[2], body, pass);
        result = {status:'queued', detail:JSON.stringify(raw).slice(0,500)};
      } else {
        if (!known) throw fail('INJECT_UNSUPPORTED', `no session transport for ${agent}; choose route:mailbox`);
        const hits = require('./core').findSession(sessionId, agent);
        if (!hits.length) throw fail('SESSION_NOT_FOUND', `target session not found on ${agent}: ${sessionId}`);
        if (hits.length !== 1) throw fail('AMBIGUOUS_SESSION', 'multiple session owners');
        if (route === 'desktop' || route === 'desktopcdp') {
          const desktop = require('./desktop-delivery');
          if (opts.consent !== true && !desktop.desktopConsentGranted()) throw fail('CONSENT_REQUIRED', 'desktop delivery requires consent:true or the configured desktop consent grant');
          if (agent !== 'zcode' || typeof hits[0].sendDesktop !== 'function') throw fail('DESKTOP_UNSUPPORTED', 'no desktop route for this target');
          delegated = true;
        inbox.setFields(id, {attempts:1, status:'uncertain'});
          raw = route === 'desktopcdp'
            ? await desktop.sendDesktopStrict(hits[0].get(sessionId), body, {mode:'submit', consent:opts.consent === true, timeoutMs:opts.timeoutMs, cdpPort:opts.cdpPort, cdpTargetId:opts.cdpTargetId})
            : await hits[0].sendDesktop(sessionId, body, {...pass, desktop:true});
        } else {
          delegated = true;
        inbox.setFields(id, {attempts:1, status:'uncertain'});
          raw = await hits[0].send(sessionId, body, pass);
        }
        // Raw adapter strings do not prove delivery. Preserve explicit tri-state receipts.
        result = raw && ['accepted','refused','uncertain'].includes(raw.status)
          ? {status:raw.status, ...(raw.code ? {code:String(raw.code).slice(0,200)} : {}), ...(raw.detail ? {detail:String(raw.detail).slice(0,500)} : {})}
          : {status: route === 'desktop' || route === 'desktopcdp' ? 'accepted' : 'uncertain', detail:(raw && typeof raw === 'object' ? JSON.stringify(raw) : String(raw ?? '')).slice(0,500)};
      }
    }
  } catch (error) {
    result = {status:delegated && error?.uncertain !== false ? 'uncertain' : 'refused', code:error?.code || 'DELIVERY_FAILED', detail:String(error?.message || error).slice(0,500)};
  }
  result = {id, messageId:id, from:opts.from, to, route, ...result};
  const current = inbox.get(id);
  inbox.setFields(id, {status:current.status === 'read' ? 'read' : result.status, attempts:delegated ? 1 : 0, last_error:result.status === 'refused' || result.status === 'uncertain' ? (result.code || result.detail || result.status) : null, route_result:JSON.stringify(result)});
  return result;
}
module.exports = {sendRouted};




