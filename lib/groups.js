'use strict';
// Agent groups: which agent may see and touch which session. The registry lives
// in `~/.openacom/groups.json` (override the base dir with AGENTRELAY_HOME) and
// governs the local MCP/CLI service layer only - the hub has no group gate yet
// (v2), and relay_* is deliberately untouched.
//
//   {
//     "groups": { "team-a": ["qoder", "codex-node"] },
//     "owners": {
//       "sess_01H...": "qoder",              // exact session pin
//       "F:/Bob/zurv/**": "zurv-codex",    // workspace glob, first match wins
//       "platform:codex": "codex-node"     // default owner per agent platform
//     }
//   }
//
// Absent file means the feature is off (every session visible, exactly as
// before). A present-but-unreadable file does NOT fall back to visible: it is a
// broken gate, and every governed call says so instead of guessing.
//
// Session ownership resolves in order: exact id pin, then the first workspace
// glob, then the platform default, then unowned.
const path = require('path');
const os = require('os');
const fs = require('fs');
const { protectPath, aggregateAcl, PRIVATE } = require('./secure-fs');

const home = () => process.env.AGENTRELAY_HOME || path.join(os.homedir(), '.openacom');
const GROUPS_FILE = () => path.join(home(), 'groups.json');
const MAX_FILE_CHARS = 262144;

let _acl = null; // aggregate marker of the one protection pass, or null
let _warned = false; // the inherited-access reminder prints once per process
let _clientInfo = null; // clientInfo.name from the MCP initialize handshake
const _globCache = new Map();

// The registry names agent ids and workspace paths, not secrets, but it does map
// who owns what - protect it once per process like the web token, and let the
// caller surface a degraded acl instead of silently running with loose rights.
function protectOnce(file) {
  if (_acl === null) _acl = aggregateAcl([protectPath(path.dirname(file), { directory: true }), protectPath(file)]);
  if (_acl !== PRIVATE && !_warned) {
    _warned = true;
    // Same shape as the web token reminder: stderr only (stdout carries the
    // JSON-RPC stream), and nothing sensitive - the file maps agents to
    // sessions, which is what a readable-by-others copy would leak.
    console.error(`OpenAcom groups registry kept inherited access (${_acl}) - tighten ${file} with icacls/chmod`);
  }
  return _acl;
}

function acl() { return _acl; }

function shapeProblem(parsed) {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'must be a JSON object';
  for (const key of ['groups', 'owners']) {
    const table = parsed[key];
    if (table === undefined || table === null) continue;
    if (typeof table !== 'object' || Array.isArray(table)) return `"${key}" must be an object`;
  }
  for (const [group, members] of Object.entries(parsed.groups || {})) {
    if (!Array.isArray(members) || members.some((m) => typeof m !== 'string' || !m.trim())) {
      return `"groups.${group}" must be an array of agent ids`;
    }
  }
  for (const [pattern, owner] of Object.entries(parsed.owners || {})) {
    if (typeof owner !== 'string' || !owner.trim()) return `"owners.${pattern}" must name one agent id`;
  }
  return null;
}

// Re-read per call so an operator editing the registry takes effect without a
// restart; the file is small and this is a per-tool-call cost, not a per-row one.
function registry() {
  const file = GROUPS_FILE();
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { state: 'absent', file }; }
  if (text.length > MAX_FILE_CHARS) return { state: 'invalid', file, error: `exceeds ${MAX_FILE_CHARS} characters` };
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { return { state: 'invalid', file, error: `is not valid JSON (${e.message})` }; }
  const problem = shapeProblem(parsed);
  if (problem) return { state: 'invalid', file, error: problem };
  protectOnce(file);
  return { state: 'on', file, groups: parsed.groups || {}, owners: parsed.owners || {} };
}

function localWho() {
  try { return `local:${os.userInfo().username}`; } catch { /* fall through */ }
  return `local:${process.env.USERNAME || process.env.USER || process.env.LOGNAME || 'unknown'}`;
}

// Caller identity, first match wins: an explicit env id, then the MCP
// initialize handshake, then an undeclared local operator (the CLI path has no
// initialize at all, so it lands here and keeps full legacy visibility).
function identity() {
  const fromEnv = process.env.OPENACOM_AGENT_ID || process.env.AGENTRELAY_AGENT_ID;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return { agentId: fromEnv.trim(), declared: true, source: 'env' };
  if (_clientInfo) return { agentId: _clientInfo, declared: true, source: 'initialize' };
  return { agentId: localWho(), declared: false, source: 'local' };
}

function setClientInfo(name) {
  if (typeof name === 'string' && name.trim()) _clientInfo = name.trim();
  return _clientInfo;
}

function clientInfo() { return _clientInfo; }

function peersOf(agentId, reg) {
  const out = new Set([agentId]);
  if (!agentId || reg.state !== 'on') return out;
  for (const members of Object.values(reg.groups)) {
    if (members.includes(agentId)) for (const member of members) out.add(member);
  }
  return out;
}

// Windows paths arrive with backslashes and either case; groups.json is written
// with forward slashes. Normalize both sides, then let ** cross separators, *
// stop at them, and ? match one non-separator character.
const normPath = (p) => String(p).replace(/\\/g, '/').replace(/\/{2,}/g, '/');

function globToRegExp(pattern) {
  let re = _globCache.get(pattern);
  if (re) return re;
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        while (pattern[i + 1] === '*') i += 1;
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) out += `\\${c}`;
    else out += c;
  }
  re = new RegExp(`^${out}$`, process.platform === 'win32' ? 'i' : '');
  _globCache.set(pattern, re);
  return re;
}

// Who does this session belong to? Unreadable inputs (no id) simply resolve to
// unowned rather than inventing an owner.
function ownerOf(session, reg) {
  if (reg.state !== 'on') return null;
  const id = String((session && session.id) || '');
  if (Object.prototype.hasOwnProperty.call(reg.owners, id)) return reg.owners[id];
  const workspace = session && session.workspace ? normPath(session.workspace) : '';
  if (workspace) {
    for (const pattern of Object.keys(reg.owners)) {
      if (pattern.startsWith('platform:') || pattern === id) continue;
      if (globToRegExp(normPath(pattern)).test(workspace)) return reg.owners[pattern];
    }
  }
  const platformKey = `platform:${session && session.agent}`;
  if (Object.prototype.hasOwnProperty.call(reg.owners, platformKey)) return reg.owners[platformKey];
  return null;
}

// The gate state for this call: 'full' = legacy visibility (no registry, or a
// caller that declared no identity), 'group' = filtered, 'invalid' = refuse.
function gate() {
  const reg = registry();
  const who = identity();
  if (reg.state === 'invalid') return { mode: 'invalid', who, reg };
  if (reg.state !== 'on' || !who.declared) return { mode: 'full', who, reg, allowed: peersOf(who.agentId, reg) };
  return { mode: 'group', who, reg, allowed: peersOf(who.agentId, reg) };
}

function fault(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code, uncertain: false });
}

function assertGateUsable(gateState, action) {
  if (gateState.mode !== 'invalid') return;
  throw fault('GROUP_REGISTRY_INVALID', `${gateState.reg.file} ${gateState.reg.error}, so ${action} cannot be checked - fix the registry, or delete the file to return to legacy full visibility`);
}

// THE visibility rule, in exactly one place: given a gate state, may this caller
// see this session/address? Wave 10's inbox-first reads must call this too - a
// second copy of peers()/owner resolution would drift the moment either changes.
// Unowned means invisible: it is the caller's own record, never a wildcard.
function canSee(g, session) {
  if (g.mode === 'full') return true;
  const owner = ownerOf(session, g.reg);
  return owner !== null && g.allowed.has(owner);
}

// Never name the owning agent: "session X belongs to Y" is exactly what the
// visibility gate exists to withhold from an out-of-group caller.
function assertVisible(session, action) {
  const g = gate();
  assertGateUsable(g, action);
  if (canSee(g, session)) return g;
  const id = String((session && (session.id || session.session_id)) || 'unknown');
  throw fault('GROUP_FORBIDDEN', `${action} target session ${id} is not visible to agent "${g.who.agentId}" (no group grants you that session) - ask the operator to add your agent id to a shared group in ${g.reg.file}`);
}

// The one deliberate exception to canSee: a queued (non-injected) send has no
// session record to inspect, so the gate only bites when the registry actually
// claims that address (id pin or platform default). An unowned address stays
// queueable - reaching it is the point of the mailbox - an owned one obeys the
// same peer set as a live session.
function assertQueueable(session, action) {
  const g = gate();
  assertGateUsable(g, action);
  if (g.mode !== 'group') return g;
  const owner = ownerOf(session, g.reg);
  if (owner === null || g.allowed.has(owner)) return g;
  throw fault('GROUP_FORBIDDEN', `${action} target ${session.agent}:${session.id} is claimed by another agent in ${g.reg.file} and is not visible to "${g.who.agentId}"`);
}

function addrParts(address) {
  const raw = String(address || '');
  const colon = raw.indexOf(':');
  if (colon <= 0) return { id: raw, agent: raw };
  return { agent: raw.slice(0, colon), id: raw.slice(colon + 1) };
}

function visibleAddress(address, g) {
  const { agent, id } = addrParts(address);
  return canSee(g, { id, agent });
}

// Rows here are session-shaped ({id, agent, workspace}) or inbox-shaped; the
// marker is added to every row in both modes so a client can never mistake a
// filtered list for an unfiltered one.
function filterSessions(rows) {
  const g = gate();
  assertGateUsable(g, 'list_sessions');
  const visible = rows.filter((row) => canSee(g, row));
  return { rows: visible.map((row) => ({ ...row, visibility: g.mode })), visibility: g.mode, hiddenCount: rows.length - visible.length };
}

// An inbox row is visible when either end of its conversation is; both ends are
// resolved through the same ownership chain as sessions.
function filterInboxRows(rows) {
  const g = gate();
  assertGateUsable(g, 'inbox');
  return {
    rows: (g.mode === 'full' ? rows : rows.filter((r) => visibleAddress(r.to_addr, g) || visibleAddress(r.from_addr, g)))
      .map((r) => ({ ...r, visibility: g.mode })),
    visibility: g.mode,
  };
}

module.exports = {
  GROUPS_FILE, registry, acl, identity, setClientInfo, clientInfo, peersOf, ownerOf, gate, canSee,
  assertVisible, assertQueueable, assertGateUsable, filterSessions, filterInboxRows, visibleAddress, normPath,
};
