'use strict';
// Stdio MCP server exposing OpenAcom as tools. Zero-dependency: MCP over
// stdio is newline-delimited JSON-RPC 2.0.
const { findSession, ADAPTERS } = require('./core');
const groups = require('./groups');
const { resolveZcodeCli, zcodeConfigPath, whichCli } = require('./util');
const path = require('path');
const { homedir } = require('os');

const VERSION = require('../package.json').version;
const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];

const TOOLS = [
  {
    name: 'relay_nodes',
    description: 'List distributed machine nodes and their locally allowlisted visible-input targets. Uses AGENTRELAY_URL and AGENTRELAY_TOKEN configured on this MCP process.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'relay_send',
    description: 'Queue a message to a named target on a distributed machine. Terminal targets inject into the actual running TUI; desktop targets fail rather than silently run headless. submit sends Enter; draft only pastes. Omit mode entirely to let the destination decide by target type (desktop draft, terminal submit) - naming a mode yourself removes that safety default. A desktop submit is refused unless consent:true says an operator approved that message - never set it on your own. Returns durable message id, NOT model reply. Supply a stable id to safely retry enqueue. Use relay_status to inspect delivery; uncertain must not be blindly retried. Replies are separate messages sent back to your node and target.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Destination machine id from relay_nodes' },
        target: { type: 'string', description: 'Allowlisted target name on destination machine' },
        text: { type: 'string' },
        // No `default` key: JSON-Schema defaults never reach the request body, and
        // this one is resolved on the destination from the target type.
        mode: { type: 'string', enum: ['submit', 'draft'], description: 'Omit to let the destination decide from the target type: desktop targets get draft (text lands in the composer, nobody presses Enter), terminal targets get submit. Set submit or draft explicitly to override.' },
        id: { type: 'string', description: 'Stable unique id for idempotent enqueue' },
        consent: { type: 'boolean', description: 'Literal boolean, optional and false by default. Only true for a desktop submit an operator explicitly approved; anything else is rejected before delivery.' },
      },
      required: ['to', 'target', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'relay_status',
    description: 'Inspect a durable distributed message receipt. Delivered means UI input delivered, not model completion; uncertain means inspect the destination before sending again.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'list_sessions',
    description: 'List recent sessions of the local and remote Claude Code / Codex / ZCode / OpenCode agents, newest first. Returns JSON rows with agent, id, title, workspace (ssh: prefix marks a remote Claude workspace), and update time. When an agent-groups registry is in effect, only sessions your own identity may see are listed, and every row carries visibility:"group" (filtered) or "full".',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: ['zcode', 'claude', 'codex', 'opencode'], description: 'Restrict to one agent' },
        workspace: { type: 'string', description: 'Filter to sessions whose workspace path contains this directory (case-insensitive, backslash/slash agnostic). Pass your own cwd to list sessions of the same project.' },
        query: { type: 'string', description: 'Fuzzy search terms (space-separated AND) matched case-insensitively against agent, session id, title and workspace. Search runs over the sessions your identity may see; results are then capped by limit.' },
        limit: { type: 'number', description: 'Max rows (default 30)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_session',
    description: 'Read the last turns of a session (any agent). System noise is filtered out. Under an agent-groups registry a session outside your visibility is refused with GROUP_FORBIDDEN rather than quietly returning less.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session id from list_sessions' },
        agent: { type: 'string', enum: ['zcode', 'claude', 'codex', 'opencode'] },
        last: { type: 'number', description: 'Number of turns to return (default 10)' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_message',
    description: 'Store in inbox, then attempt delivery once by default. Select route:auto/session/desktopcdp/desktop/relay/mailbox. auto uses strict desktopcdp for zcode, session for other local addresses, and relay for node:nodeId/target. Failed or uncertain delivery stays in inbox; no automatic retry or route fallback. Stable id replays never send twice. queued/accepted are not read receipts. route:mailbox or inject:false stores only. Explicit inject:true retains the legacy direct-send behavior. Group visibility is checked before storage or delivery.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Sender address "agent:sessionId" - the session you are running in ("zcode:sess_...", "codex:ses_...", "qoder:eab70a5c-..." all parse). Required with inject:true; optional otherwise and defaults to your declared identity.' },
        to: { type: 'string', description: 'Target address "agent:sessionId". Use node:nodeId/target for relay. Unknown local transports are recorded as refused; route:mailbox stores without attempting.' },
        message: { type: 'string' },
        route: { type: 'string', enum: ['auto', 'session', 'desktop', 'desktopcdp', 'relay', 'mailbox'], default: 'auto', description: 'Choose one delivery route. auto selects desktopcdp for zcode (CDP only, no UIA/headless fallback). session uses the owning local adapter with desktop disabled; desktop is strict zcode desktop submit; relay requires node:nodeId/target; mailbox explicitly stores only. No fallback after failure.' },
        cdpPort: { type: 'integer', description: 'desktopcdp port on loopback, default 9222.' },
        cdpTargetId: { type: 'string', description: 'Optional exact CDP page target for desktopcdp.' },
        id: { type: 'string', description: 'Stable message ID, max 200 characters. Same payload and route replays its result without another attempt.' },
        inject: { type: 'boolean', description: 'Legacy compatibility: true sends directly; false stores only. Omit to store then attempt delivery. Do not combine with route.' },
        wait: { type: 'boolean', default: false, description: 'Live session route: true = block until the target finishes and return its reply (mind your own MCP timeout). false = return immediately; the reply lands in the target transcript (read with read_session).' },
        timeoutMs: { type: 'number', description: 'Timeout for the selected live session route.' },
        mode: { type: 'string', enum: ['submit', 'draft'], description: 'relay route only; omit to use the remote target default.' },
        desktop: { type: 'boolean', description: 'Compatibility selector: true chooses desktop when route is omitted, false keeps the session route. Named route is preferred. Default session route disables desktop fallback.' },
        noSignature: { type: 'boolean', description: 'Live routes: suppress the automatic [via OpenAcom · from ...] footer.' },
        consent: { type: 'boolean', description: 'Desktop route: the operator approved pressing Enter in that window for this message (same grant send_desktop requires).' },
        requireRead: { type: 'boolean', description: 'inject:true only. Read-receipt mode: the message carries a receipt id; the target must ack via the ack_message tool (or reply containing ACK-<id>). Unacknowledged sends are redelivered automatically, 3 attempts total, then reported failed. Blocks until read/failed (see ackTimeoutMs). The default mailbox path always gets its receipt the same way - the recipient calls ack_message on the row id.' },
        ackTimeoutMs: { type: 'number', description: 'Read-receipt mode: per-attempt wait for the ack (default 90000).' },
      },
      required: ['to', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_desktop',
    description: 'Expedited path: inject a real user turn into a zcode desktop session through the app UI and press Enter. Named separately from send_message because it is the one verb that touches a window somebody may be typing into: it NEVER degrades (no headless fallback, no draft instead of submit, no quiet fall back to the mailbox) and it is always submit. It requires authorization once per message: consent:true (or OPENACOM_DESKTOP_CONSENT=1 in this MCP process) or the call is refused with CONSENT_REQUIRED. Returns after the input lands; the turn runs in the app - read it with read_session. Reaching an agent with no desktop route is what post_message/send_message default are for.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Sender address "agent:sessionId" - the session you are running in, so the target can reply.' },
        to: { type: 'string', description: 'Target address "zcode:sessionId" (desktop submit is zcode-only).' },
        message: { type: 'string' },
        consent: { type: 'boolean', description: 'Literal true = the operator approved pressing Enter in that window for this message. Off by default; anything but true or the env grant is refused.' },
        timeoutMs: { type: 'number', description: 'How long to wait for the desktop route (default 60000).' },
      },
      required: ['from', 'to', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'post_message',
    description: 'Leave a message in the local OpenAcom mailbox for any address on this machine, WITHOUT delivering it anywhere. The only way to reach an agent that has no live injection channel (no CLI stdin, nothing to steer - e.g. an IDE-side client). The recipient reads it with the inbox tool (to: address filter) and settles it with ack_message. Cross-machine posts go through relay_send, not this tool. Supply a stable id to retry safely: the same id replays only with byte-identical from/to/text.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Sender address "agent:sessionId" - your own, e.g. "codex:sess_...".' },
        to: { type: 'string', description: 'Recipient address "agent:sessionId", e.g. "qoder:boss". Any name is accepted: the mailbox does not resolve sessions.' },
        text: { type: 'string', description: 'Message body. Stored in the local inbox store, so treat it as disk-resident data.' },
        id: { type: 'string', description: 'Optional stable id for an idempotent retry (max 200 chars). Omit for a fresh uuid.' },
      },
      required: ['from', 'to', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'ack_message',
    description: 'Mark a tracked message as read: a read-receipt send (id in the delivered message footer) or a post_message mailbox row (id from the inbox tool). Call this after processing a message that asks for a read acknowledgment.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Message id, from the delivered footer or the inbox tool' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'inbox',
    description: 'List inbox messages and delivery status, including stored, queued, accepted, refused and uncertain. Routed attempts remain here after failure; read requires an acknowledgement. Includes post_message mailbox rows, which carry delivery:"mailbox" and never fail - filter them with "to"/"from" addresses, then ack_message to settle. Under an agent-groups registry only rows whose sender or recipient belongs to your identity are listed, each marked with visibility.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'sent', 'read', 'failed', 'stored', 'queued', 'accepted', 'refused', 'uncertain'] },
        to: { type: 'string', description: 'Exact recipient address, e.g. "qoder:boss" - how a client reads the mail left for it' },
        from: { type: 'string', description: 'Exact sender address, e.g. "codex:sess_..." - what you posted out' },
        limit: { type: 'number', description: 'Max rows (default 30)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_paths',
    description: 'Show detected session storage paths and CLI locations for diagnostics.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function listSessions(args) {
  const { ADAPTERS } = require('./core');
  const rows = [];
  const agent = args.agent;
  const terms = String(args.query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const adapters = agent ? [ADAPTERS[agent]].filter(Boolean) : Object.values(ADAPTERS);
  for (const a of adapters) {
    if (!a.available()) continue;
    rows.push(...a.list(0));
  }
  // The group gate runs before the search, so a query can never confirm that a
  // hidden session exists by matching its title. Every row also carries a
  // visibility marker: a filtered list must not look like an unfiltered one.
  const { rows: allowed } = groups.filterSessions(rows);
  let filtered = allowed;
  const workspace = String(args.workspace || '').trim();
  if (workspace) {
    // same-project listing: compare on normalized paths so C:\A\B, c:/a/b and
    // c:/a/b/ all match the sessions whose workspace lives under that directory
    const needle = workspace.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    filtered = filtered.filter((r) => String(r.workspace || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase().includes(needle));
  }
  if (terms.length) {
    filtered = allowed.filter((r) => {
      const hay = `${r.agent} ${r.id} ${r.title} ${r.workspace}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }
  filtered.sort((x, y) => y.mtime - x.mtime);
  const lim = args.limit && args.limit > 0 ? args.limit : 30;
  return JSON.stringify(filtered.slice(0, lim), null, 2);
}

// Ownership resolution needs the session record, workspace above all. An adapter
// that cannot produce one leaves {id, agent}, which only an id pin or a platform
// default can match - the narrower, fail-closed reading rather than a free pass.
function sessionRow(a, sessionId) {
  try { return (a.get && a.get(sessionId)) || { id: sessionId, agent: a.name }; } catch { return { id: sessionId, agent: a.name }; }
}

function readSession(args) {
  const hits = findSession(args.sessionId, args.agent);
  if (hits.length === 0) throw new Error(`session not found: ${args.sessionId}`);
  if (hits.length > 1) throw new Error(`session id exists in ${hits.map((h) => h.name).join(' & ')}; pass "agent"`);
  groups.assertVisible(sessionRow(hits[0], args.sessionId), 'read_session');
  const turns = hits[0].messages(args.sessionId, args.last || 10);
  if (!turns) throw new Error('session found but messages unreadable');
  return turns.map((t) => `[${t.role}] ${t.text}`).join('\n\n');
}

// Options that only mean something when input is injected into a live session.
// Passing one without inject:true is a caller expecting the old behavior, so it
// is refused loudly rather than quietly answered with a mailbox row.
const INJECT_ONLY_OPTIONS = ['wait', 'requireRead', 'desktop', 'timeoutMs', 'ackTimeoutMs', 'noSignature'];

function fault(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code, uncertain: false });
}

async function sendMessage(args) {
  // Named routes and the new default persist before delivery. Explicit legacy
  // inject remains compatible; inject:false remains the mailbox-only opt-out.
  if (args.route !== undefined || args.inject === undefined) {
    if (args.route !== undefined && args.inject !== undefined) throw fault('INVALID_ROUTE', 'use route or legacy inject, not both');
    const to = String(args.to || '').trim();
    if (!to) throw new Error('"to" is required');
    if (!MAILBOX_ADDR.test(to)) throw new Error('invalid "to": expected agent:sessionId');
    const identity = groups.identity();
    const from = args.from === undefined ? (identity.agentId.includes(':') ? identity.agentId : `${identity.agentId}:mcp`) : String(args.from).trim();
    if (!MAILBOX_ADDR.test(from)) throw new Error('invalid "from": expected agent:sessionId');
    const colon = to.indexOf(':');
    const agent = to.slice(0, colon), sessionId = to.slice(colon + 1);
    // Preserve the group gate before either storing or delivering a message.
    let row = {id:sessionId, agent};
    if (ADAPTERS[agent]) {
      const hits = findSession(sessionId, agent);
      if (hits.length === 1) {
        row = sessionRow(hits[0], sessionId);
        if (args.route !== 'mailbox') groups.assertVisible(row, 'send_message');
      }
    }
    groups.assertQueueable(row, 'send_message');
    return JSON.stringify(await require('./sdk').sendRouted(to, args.message, {...args, from, route:args.route ?? (args.desktop === true ? 'desktop' : 'auto')}), null, 2);
  }
  if (!args.message || !String(args.message).trim()) throw new Error('"message" is required and must be non-empty');
  const to = String(args.to || '').trim();
  if (!to) throw new Error('"to" is required: "agent:sessionId" of the target, or "zcode:new" for a fresh session');
  const bridge = BRIDGE_TARGET.exec(to);
  const asked = INJECT_ONLY_OPTIONS.filter((key) => args[key] !== undefined && args[key] !== false && args[key] !== 0);
  // The default send is a storage write: the target reads its own inbox and
  // settles with ack_message. No adapter, no spawn, no consent, and a peer with
  // no injection channel (qoder) is reachable exactly like one that has it.
  if (args.inject !== true) {
    if (asked.length) {
      throw bridge
        ? fault('INJECT_UNSUPPORTED', `${asked.join('/')} ask ${to} for live injection, which has no injection channel at all - drop them and the message is queued in its inbox instead`)
        : fault('INJECT_REQUIRED', `${asked.join('/')} only take effect when input is injected - pass inject:true for that, or drop them to queue into ${to}'s inbox (the default)`);
    }
    if (/^zcode:new$/i.test(to)) throw fault('INJECT_REQUIRED', 'to:"zcode:new" creates a fresh session, which is injection by definition - pass inject:true');
    return queueMailbox(to, args, bridge ? 'mailbox-bridge' : 'mailbox-send');
  }
  // Explicit injection keeps the previous behavior end to end.
  if (bridge) throw fault('INJECT_UNSUPPORTED', `inject:true cannot drive ${to}: that agent has no injection channel - the default (no inject) queues it in the mailbox`);
  const from = String(args.from || '').trim();
  if (!from) throw new Error('"from" is required: "agent:sessionId" of the sender, e.g. "zcode:sess_..."');
  // Format check only: stdio MCP carries no caller identity, so "from" cannot be
  // authenticated here - any local process attached to this server can claim any
  // address. Cross-machine trust lives in the hub token (lib/distributed). Because
  // nothing is proven by the agent token, the sender shares the mailbox grammar
  // (one constant, no drifting regexes) so a qoder session can reply upstream.
  if (!MAILBOX_ADDR.test(from)) throw new Error(`invalid "from" (${from}): expected "agent:sessionId"`);
  // "to" stays on the four adapter platforms: injection needs a real session there.
  const tm = to.match(/^(zcode|claude|codex|opencode):(new|\S+)$/);
  if (!tm) throw new Error(`invalid "to" (${to}): expected "agent:sessionId" or "zcode:new"`);
  const targetAgent = tm[1];
  const fresh = tm[2] === 'new';
  if (fresh && targetAgent !== 'zcode') throw new Error('fresh sessions ("agent:new") are zcode-only');

  const opts = {};
  if (args.timeoutMs) opts.timeoutMs = args.timeoutMs;
  if (args.wait === true) opts.noWait = false; else opts.noWait = true;
  if (args.desktop === true) opts.desktop = true;
  else if (args.desktop === false) opts.desktop = false;

  const message = withSignature(String(args.message), from, args.noSignature);

  if (fresh) {
    const out = require('./adapters/zcode').sendFresh(message, opts);
    return JSON.stringify({ ok: true, from, to: `zcode:${out.id}`, sessionId: out.id, note: out.reply }, null, 2);
  }
  const sessionId = tm[2];
  const hits = findSession(sessionId, targetAgent);
  if (hits.length === 0) throw new Error(`target session not found on ${targetAgent}: ${sessionId} (check list_sessions)`);
  const a = hits[0];
  // Checked before any delivery side effect: an out-of-group target is refused
  // outright (uncertain:false), never downgraded to a draft or silently retried.
  groups.assertVisible(sessionRow(a, sessionId), 'send_message');
  if (args.desktop === true) return desktopSend(a, sessionId, message, { from, to, sessionId }, args.consent);
  // Direct steer, never fork: the turn always lands in the addressed session
  // itself (`opencode run -s <id>` takes no --fork flag here by design).
  if (args.requireRead) {
    const inbox = require('./inbox');
    const outcome = await inbox.trackedSend(a, sessionId, from, args.message, {
      ackTimeoutMs: args.ackTimeoutMs || 90e3,
      maxAttempts: 3,
      sendOpts: opts,
    });
    return JSON.stringify({ ok: outcome.status === 'read', from, to, sessionId, ...outcome }, null, 2);
  }
  const out = await a.send(sessionId, message, opts);
  if (typeof out === 'string' && /OK (?:sent via CDP|\(no-wait\))/.test(out)) {
    return JSON.stringify({ ok: true, from, to, sessionId, delivery: out.includes('CDP') ? 'desktop-cdp' : 'no-wait', note: 'delivered; turn runs in the target (read_session to see the reply later)' }, null, 2);
  }
  return JSON.stringify({ ok: true, from, to, sessionId, reply: out }, null, 2);
}

// Mailbox post: unlike send_message this never touches an adapter, so no live
// session is required on either side. Addresses keep the "agent:sessionId" shape
// but accept names outside the four adapters (qoder, or anything a client calls
// itself) - stdio MCP carries no caller identity, so "from" is format-checked
// only, exactly as in send_message, and the mailbox is same-machine only.
const MAILBOX_ADDR = /^[A-Za-z][A-Za-z0-9_.-]*:\S+$/;
const MAILBOX_ID_MAX = 200;
const BRIDGE_TARGET = /^(qoder(?:-[A-Za-z0-9_.-]+)?):(\S+)$/i;

// The default send_message path, and the qoder bridge, both land here: write a
// row, hand it to whoever reads that address, and say "stored". `delivery` marks
// which verb and target kind produced the row so a drain seat can select on it.
function queueMailbox(to, args, delivery) {
  const identity = groups.identity();
  if (!MAILBOX_ADDR.test(to)) throw new Error(`invalid "to" (${to}): expected "agent:sessionId", e.g. "qoder:boss"`);
  const claimed = String(args.from || '').trim();
  if (claimed && !MAILBOX_ADDR.test(claimed)) throw new Error(`invalid "from" (${claimed}): expected "agent:sessionId"`);
  const from = claimed || (identity.agentId.includes(':') ? identity.agentId : `${identity.agentId}:mcp`);
  const colon = to.indexOf(':');
  groups.assertQueueable({ id: to.slice(colon + 1), agent: to.slice(0, colon) }, 'send_message');
  const { row, replayed } = require('./inbox').post({ fromAddr: from, toAddr: to, text: String(args.message), delivery });
  return JSON.stringify({
    status: 'mailbox-delivered',
    id: row.id,
    from: row.from_addr,
    to: row.to_addr,
    delivery: row.delivery,
    ...(replayed ? { replayed: true } : {}),
    note: `stored in the local inbox; ${to} reads it with inbox(to:"${to}") and settles it with ack_message. Not injected, not read - nothing happens until the target looks.`,
  }, null, 2);
}

function postMessage(args) {
  const text = typeof args.text === 'string' ? args.text : '';
  if (!text.trim()) throw new Error('"text" is required and must be non-empty');
  if (Buffer.byteLength(text, 'utf8') > 65536) throw new Error('"text" exceeds 65536 UTF-8 bytes');
  for (const key of ['from', 'to']) {
    const value = String(args[key] || '').trim();
    if (!MAILBOX_ADDR.test(value)) throw new Error(`invalid "${key}" (${value}): expected "agent:sessionId", e.g. "${key === 'from' ? 'codex:sess_1' : 'qoder:boss'}"`);
  }
  let id;
  if (args.id !== undefined) {
    if (typeof args.id !== 'string' || !args.id.trim()) throw new Error('"id" must be a non-empty string when given');
    if (args.id.length > MAILBOX_ID_MAX) throw new Error(`"id" exceeds ${MAILBOX_ID_MAX} characters`);
    id = args.id.trim();
  }
  const inbox = require('./inbox');
  const { row, replayed } = inbox.post({ id, fromAddr: args.from.trim(), toAddr: args.to.trim(), text });
  return JSON.stringify({ ok: true, id: row.id, from: row.from_addr, to: row.to_addr, status: row.status, delivery: row.delivery, ...(replayed ? { replayed: true } : {}) }, null, 2);
}

// One desktop entrance in this layer, shared by send_desktop and
// send_message(inject:true,desktop:true): always submit, never degrade, and the
// operator's authorization is required once per message.
// The consent decision belongs to lib/desktop-delivery (one env list, one rule);
// this layer only asks before anything can touch a window, and words the answer
// for a verb that has no draft mode to fall back to.
function consentFailure(consent) {
  const desktop = require('./desktop-delivery');
  if (consent === true || desktop.desktopConsentGranted()) return null;
  if (consent !== undefined && typeof consent !== 'boolean') throw fault('INVALID_CONSENT', `consent must be the boolean true, got ${JSON.stringify(consent)}`);
  return fault('CONSENT_REQUIRED', `a desktop submit presses Enter in a window somebody may be typing into, and send_desktop has no draft mode to fall back to - pass consent:true for this message, or set ${desktop.CONSENT_ENV.join('/')}=1 in this MCP process environment for a desktop you personally control`);
}

function withSignature(message, from, skip) {
  return skip ? message : `${message}\n\n[via OpenAcom · from ${from}]`;
}

async function desktopSend(a, sessionId, message, meta, consent, opts = {}) {
  const gate = consentFailure(consent);
  if (gate) throw gate;
  if (a.name !== 'zcode' || typeof a.sendDesktop !== 'function') {
    throw fault('DESKTOP_UNSUPPORTED', `desktop submit is zcode-only and ${a.name} has no desktop route - the default send_message reaches it through the mailbox instead`);
  }
  const out = await a.sendDesktop(sessionId, message, { ...opts, consent: true });
  return JSON.stringify({
    status: 'desktop-submitted',
    ...meta,
    delivery: 'desktop',
    note: `input landed and Enter was pressed; the turn runs in the desktop app - read it with read_session. ${String(out || '')}`.trim(),
  }, null, 2);
}

async function sendDesktopTool(args) {
  if (!args.message || !String(args.message).trim()) throw new Error('"message" is required and must be non-empty');
  const from = String(args.from || '').trim();
  if (!MAILBOX_ADDR.test(from)) throw new Error(`invalid "from" (${from}): expected "agent:sessionId"`);
  const to = String(args.to || '').trim();
  const tm = to.match(/^(zcode|claude|codex|opencode):(\S+)$/);
  if (!tm) throw new Error(`invalid "to" (${to}): expected "agent:sessionId" of a driveable session`);
  const hits = findSession(tm[2], tm[1]);
  if (hits.length === 0) throw new Error(`target session not found on ${tm[1]}: ${tm[2]} (check list_sessions)`);
  const a = hits[0];
  groups.assertVisible(sessionRow(a, tm[2]), 'send_desktop');
  return desktopSend(a, tm[2], withSignature(String(args.message), from), { from, to, sessionId: tm[2] }, args.consent,
    args.timeoutMs ? { timeoutMs: args.timeoutMs } : {});
}

function getPaths() {
  let opencodeCli = null;
  try { opencodeCli = require('./adapters/opencode').cliPath(); } catch { /* keep null */ }
  return JSON.stringify({
    zcodeDb: path.join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite'),
    zcodeCli: resolveZcodeCli() || null,
    zcodeHeadlessConfig: zcodeConfigPath(),
    claudeProjects: path.join(homedir(), '.claude', 'projects'),
    claudeCli: whichCli('claude') || null,
    codexSessions: path.join(homedir(), '.codex', 'sessions'),
    codexCli: whichCli('codex') || null,
    opencodeDb: path.join(homedir(), '.local', 'share', 'opencode', 'opencode.db'),
    opencodeCli,
    // Privacy of the two trees this process owns. 'inherited' means icacls or
    // chmod could not tighten them; null means nothing has been written yet.
    logDir: traceDir(),
    logDirAcl: traceAcl(),
    inboxAcl: require('./inbox').acl(),
    // Who the group gate takes the caller to be, and the privacy of the registry
    // that decides it. groupsAcl is null until a groups.json has been read.
    groupsFile: groups.GROUPS_FILE(),
    groupsAcl: groups.acl(),
    agentIdentity: groups.identity(),
    // The resident desktop-submit grant this process honors (env vars or the
    // desktop-consent file), so a caller can see why a submit was allowed.
    desktopConsentFile: require('./desktop-delivery').desktopConsentFile(),
    desktopConsent: require('./desktop-delivery').desktopConsentGranted(),
  }, null, 2);
}

async function relayRequest(method, route, body) {
  return require('./distributed').request(require('./distributed-cli').connection(), method, route, body);
}

function consentFlag(value) {
  if (typeof value !== 'boolean') throw new Error('consent must be the boolean true or false');
  return value;
}

const HANDLERS = {
  relay_nodes: () => relayRequest('GET', '/nodes'),
  relay_send: (args) => relayRequest('POST', '/messages', {
    to: args.to, target: args.target, text: args.text,
    // An omitted mode is sent as absent, so the destination picks draft for
    // desktop and submit for terminal; anything the caller names passes straight
    // through (a bogus mode gets the hub's INVALID_MODE, never a quiet downgrade).
    ...(args.mode === undefined || args.mode === null ? {} : { mode: args.mode }),
    ...(args.id === undefined ? {} : { id: args.id }),
    // The sender's own claim of authorisation, carried verbatim to the hub: only
    // forwarded when the caller supplied it, never defaulted on, and never coerced
    // from "true"/1 - a lenient client hears that the type is wrong instead of
    // quietly sending an unapproved Enter.
    ...(args.consent === undefined ? {} : { consent: consentFlag(args.consent) }),
  }),
  relay_status: (args) => {
    if (typeof args.id !== 'string' || !args.id) throw new Error('id is required');
    return relayRequest('GET', '/messages/' + encodeURIComponent(args.id));
  },
  list_sessions: listSessions,
  read_session: readSession,
  send_message: sendMessage,
  send_desktop: sendDesktopTool,
  post_message: postMessage,
  ack_message: (args) => {
    if (typeof args.id !== 'string' || !args.id.trim()) throw new Error('id is required');
    const row = require('./inbox').markRead(args.id.trim());
    return JSON.stringify({ ok: true, id: row.id, status: row.status, readAt: row.read_at }, null, 2);
  },
  inbox: (args) => {
    const found = require('./inbox').list({
      status: args.status,
      fromAddr: typeof args.from === 'string' && args.from.trim() ? args.from.trim() : undefined,
      toAddr: typeof args.to === 'string' && args.to.trim() ? args.to.trim() : undefined,
      limit: args.limit && args.limit > 0 ? args.limit : 30,
    });
    // A row is visible when either end of the conversation belongs to the
    // caller's peer set, so nobody reads mail addressed to another agent.
    const { rows } = groups.filterInboxRows(found);
    return JSON.stringify(rows.map((r) => ({ id: r.id, from: r.from_addr, to: r.to_addr, status: r.status, delivery: r.delivery || undefined, visibility: r.visibility, attempts: r.attempts, maxAttempts: r.max_attempts, updatedAt: r.updated_at, readAt: r.read_at || undefined, lastError: r.last_error || undefined })), null, 2);
  },
  get_paths: getPaths,
};

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

// Append-only diagnostics for every tools/call: request summary + response
// shape. Goes to a file (never stdout - that carries the JSON-RPC stream).
// Body-bearing arguments (text/message/query) are reduced to a length + digest
// so message bodies, source code and internal paths never land on disk.
const TRACE_BODY_KEYS = ['text', 'message', 'query'];
const TRACE_MAX_BYTES = 1024 * 1024;
const TRACE_FILE = 'mcp-calls.log';

const { protectPath, aggregateAcl } = require('./secure-fs');

const _traceAcls = [];

function traceDir() {
  return path.join(process.env.AGENTRELAY_HOME || path.join(homedir(), '.openacom'), 'logs');
}

// Directory-level protection, once per process: on Windows icacls grants with
// (OI)(CI), so files created afterwards inherit the same private access and
// there is no reason to spawn it per traced call.
function protectTraceDir(dir) {
  if (_traceAcls.length === 0) _traceAcls.push(protectPath(dir, { directory: true }));
  return aggregateAcl(_traceAcls);
}

// Only for a log file that does not exist yet - an existing one already carries
// the grant (or mode) it was created with, and this must not run per append.
function protectTraceFile(file) {
  _traceAcls.push(protectPath(file));
  return aggregateAcl(_traceAcls);
}

// Aggregate marker of everything this process protected in the log tree, or
// null while nothing has been written. A single inherited path makes it so.
function traceAcl() { return _traceAcls.length ? aggregateAcl(_traceAcls) : null; }

function traceDigest(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v);
  return `len=${Buffer.byteLength(s)} sha256:${require('crypto').createHash('sha256').update(s).digest('hex').slice(0, 12)}`;
}

function traceCall(tool, args, responseText, isError) {
  try {
    const fs = require('fs');
    const dir = traceDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    protectTraceDir(dir);
    const file = path.join(dir, TRACE_FILE);
    let existed = true;
    try {
      if (fs.statSync(file).size >= TRACE_MAX_BYTES) { fs.renameSync(file, `${file}.1`); existed = false; }
    } catch { existed = false; /* first write */ }
    const safe = Object.assign({}, args);
    for (const k of TRACE_BODY_KEYS) {
      if (safe[k] !== undefined) safe[k] = traceDigest(safe[k]);
    }
    fs.appendFileSync(file,
      `${new Date().toISOString()} tool=${tool} isError=${!!isError} ` +
      `bytes=${responseText == null ? -1 : Buffer.byteLength(responseText)} ` +
      `args=${JSON.stringify(safe).slice(0, 500)}\n`, { mode: 0o600 });
    if (!existed) protectTraceFile(file);
  } catch { /* diagnostics must never break serving */ }
}

// MCP content blocks require text:string. Coerce defensively so a non-string
// handler result can never fail client-side validation (and leave a trace).
function asText(v) {
  if (typeof v === 'string') return v;
  try {
    const j = JSON.stringify(v);
    if (typeof j === 'string') { traceCall('__coerce__', { fromType: Array.isArray(v) ? 'array' : typeof v }, j.slice(0, 200), false); return j; }
  } catch { /* fall through */ }
  return String(v);
}

async function handleMessage(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize': {
      const requested = params && params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : '2025-06-18';
      // Second-priority identity for the group gate (an env id still wins). A
      // client that never initializes - the CLI path - stays undeclared and
      // keeps full legacy visibility.
      groups.setClientInfo(params && params.clientInfo && params.clientInfo.name);
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'openacom', version: VERSION },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params && params.name;
      const handler = HANDLERS[name];
      if (!handler) return rpcError(id, -32602, `unknown tool: ${name}`);
      const callArgs = (params && params.arguments) || {};
      try {
        const text = asText(await handler(callArgs));
        traceCall(name, callArgs, text, false);
        return rpcResult(id, { content: [{ type: 'text', text }], isError: false });
      } catch (e) {
        const text = asText((e && e.message) || String(e));
        traceCall(name, callArgs, text, true);
        return rpcResult(id, { content: [{ type: 'text', text }], isError: true });
      }
    }
    default:
      if (id !== undefined) return rpcError(id, -32601, `method not found: ${method}`);
      return null; // notification we don't know — ignore
  }
}

function run() {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      process.stdout.write(JSON.stringify(rpcError(null, -32700, 'parse error')) + '\n');
      return;
    }
    // handleMessage may be async (blocking sends); never let live child
    // output touch stdout - it carries the JSON-RPC stream.
    Promise.resolve()
      .then(() => handleMessage(msg))
      .then((resp) => { if (resp) process.stdout.write(JSON.stringify(resp) + '\n'); })
      .catch((e) => process.stdout.write(JSON.stringify(rpcError(msg.id ?? null, -32603, e.message)) + '\n'));
  });
  rl.on('close', () => process.exit(0));
}

module.exports = { run, handleMessage, traceCall, TRACE_FILE, traceDir, traceAcl };
