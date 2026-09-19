'use strict';
// User hooks: commands fired on inbox lifecycle events. Configure in
// ~/.openacom/hooks.json mapping event names to one command or an array of
// commands. Each firing runs the command detached with the event JSON on
// stdin and AGENTRELAY_EVENT / AGENTRELAY_MESSAGE_ID in the environment;
// stderr goes to ~/.openacom/logs/hooks.log. Hook failures never affect
// delivery - the message flow cannot see them.
//
//   {
//     "message.read":  "node C:/scripts/notify.js",
//     "message.failed": ["node C:/scripts/alert.js", "msg.exe / beep"]
//   }
const path = require('path');
const { homedir } = require('os');
const fs = require('fs');

const EVENTS = ['message.created', 'message.sent', 'message.read', 'message.failed'];

const home = () => process.env.AGENTRELAY_HOME || path.join(homedir(), '.openacom');
const hooksFile = () => path.join(home(), 'hooks.json');

function loadHooks() {
  try {
    const raw = JSON.parse(fs.readFileSync(hooksFile(), 'utf8'));
    const out = {};
    for (const [k, v] of Object.entries(raw || {})) {
      if (!EVENTS.includes(k) || v == null) continue;
      out[k] = Array.isArray(v) ? v.map(String) : [String(v)];
    }
    return out;
  } catch { return {}; } // missing/invalid config = no hooks
}

// Fire-and-forget: never throws, never blocks the sender beyond the spawn.
// The event JSON travels in the OPENACOM_EVENT env var (payloads are bounded
// summaries), not stdin - detached children with piped stdin deadlock on
// Windows. stdio is fully detached, so a broken hook can never touch delivery.
function fire(event, payload = {}) {
  try {
    const cmds = loadHooks()[event];
    if (!cmds || !cmds.length) return;
    const { spawn } = require('child_process');
    const body = JSON.stringify({ event, at: Date.now(), ...payload });
    for (const cmd of cmds) {
      try {
        const child = spawn(cmd, {
          shell: true,
          detached: true,
          stdio: 'ignore',
          env: Object.assign({}, process.env, { OPENACOM_EVENT: body, AGENTRELAY_EVENT: body }),
        });
        child.on('error', () => { /* a broken hook must not break delivery */ });
        child.unref();
      } catch { /* a broken hook must not break delivery */ }
    }
  } catch { /* hooks must never break delivery */ }
}

module.exports = { EVENTS, hooksFile, loadHooks, fire };
