# OpenAcom

![OpenAcom](banner.png)

**English** · [Chinese](#chinese)

**Opensource, Distributed, and safe agent communication.**

One MCP/CLI command managing agent sessions across desktops and CLIs on different local/remote machines — **Claude Code**, **Codex**, **ZCode**, and **OpenCode**.

```
$ openacom list
AGENT   SESSION                                    TITLE                                 WORKSPACE       UPDATED
------  -----------------------------------------  ------------------------------------  --------------  --------
zcode   sess_5027cd0f-689f-4576-8509-8a76ac51fa36  Cross-session messaging PoC           C:\…\default    just now
claude  275c102a-8cf7-4720-935d-96b6ddfd0af3       Frontend design review                F:\Bob          1h ago
codex   01a07b4b-bc27-7fd1-89c0-dae8c883bf06       Add topic search to the course page   F:\Saba         5h ago

$ openacom send 01a07b4b-bc27-7fd1-89c0-dae8c883bf06 "Research is done, please continue with the next step"
(the target session receives a real user turn; its reply is printed here)
```

`send` delivers a **genuine user turn** to the target session. By default it is
fire-and-forget (the reply lands in the transcript; `--wait` blocks for it), and
for zcode it is CDP-first: when the desktop app runs with
`--remote-debugging-port`, the message enters through the app's real composer
(live refresh, native chain, steer of a running turn); without the debug port
it tries the desktop UIA route (brief focus steal), and if that fails too the
send errors out — never a silent headless run. Because that visible route
presses Enter in a window you may be using, it is consent-gated: pass
`--consent true` for that one message, set `OPENACOM_DESKTOP_CONSENT=1` where
OpenAcom runs, write exactly `1` into the `desktop-consent` file in the OpenAcom
home (`~/.openacom` by default — the resident grant MCP servers spawned by an
already-running app pick up without an app restart; delete the file to revoke),
keep the text unsubmitted with `--desktop --draft`, or deliver
headless with `--no-desktop`. This is the building block for cross-agent
orchestration: let a ZCode session drive a Claude session, script hand-offs
between agents, or poke a long-running session from CI.

## Install

Requires Node.js ≥ 22.13 for normal invocation (uses built-in `node:sqlite`).
Node 22.5–22.12 requires `--experimental-sqlite`; newer Node LTS is recommended.

```bash
npm install -g github:Bring-AI/OpenAcom
```

or from a clone:

```bash
git clone https://github.com/Bring-AI/OpenAcom
npm install -g ./OpenAcom
```

or run in place without installing: `node bin/openacom.js …`

`Bring-AI/OpenAcom` is currently a **private** repository, so installing from GitHub
requires access to it (configure your GitHub credentials first). The package name
`openacom` is not published on npm.

Two derived extras ship in the tree, neither of them a runtime dependency:
`node tools/gen-docs.js` regenerates the static documentation site from this file
plus the source tree into `docs/index.html` (English) and `docs/zh/index.html`
(Chinese) — run it after changing either, because the pages are extracted, never
retyped; and `desktop/` holds a single-file WinForms client for the loopback hub,
built with Windows' own C# compiler through `desktop/build.cmd` into
`desktop/openacom-desktop.exe` (it shows only a SHA-256 fingerprint of the token it
sends, never the token).

## Distributed relay: delivery semantics and hard limits

This chapter is the English statement of what this wave changed about
**meaning** — the delivery invariant, the credential model, the queue
boundaries, and the desktop consent gate. The hands-on setup walkthrough
(`relay hub`, `relay node`, `targets.json`, SSH forwarding, terminal arming) is
currently written up only in Chinese: see the
[Chinese distributed guide](#distributed-guide) at the end of this file. Every
statement here maps to code; nothing below is aspirational.

**Invariant: at-most-once with honest status — never exactly-once.** A node
commits a durable receipt *before* it touches any UI, so a crash can lose a
message but can never run the same UI side effect twice. Full status set:

| Status | Meaning |
|---|---|
| `queued` | Durable in the hub; an offline node can still pick it up later |
| `delivering` | Claimed; UI input is being attempted right now |
| `deferred` | **Proven** untouched (e.g. the terminal's input lock is closed), so it is safe to re-offer — budget `MAX_DEFERRALS` = 6, backoff 5s→10s→… capped at 300s |
| `uncertain` | Cannot prove whether input landed. **Never automatically replayed**; look at the destination first |
| `delivered` | Input reached the UI (`outcome` is `input-submitted` / `input-drafted`) — **not** a model reply |
| `failed` | Delivery failed; read the error code and the local arming state |
| `expired` | Never dispatched within the queue TTL (`error.code` = `QUEUE_EXPIRED`); the target was never touched |

`retryable` is true only for the non-terminal `queued` / `delivering` /
`deferred`. Uncertainty is **sticky and stored**: `everUncertain` stays set
across hub restarts even after the owning node clarifies the row as
`delivered`/`failed`, which is then recorded as `settlement` =
`resolved-by-node` (inside the evidence window) or `resolved-by-node-late`
(after it). A hub restart, an expired 120s lease, or a node session change only
ever **opens** uncertainty (`settlement` = `awaiting-node-evidence`); when the
window passes (30 minutes by default, and the node having polled at least twice
more) the hub still refuses to guess — the status stays `uncertain` and
`settlement` becomes `no-evidence-budget-exhausted`. Only the owning node's own
durable receipt can close it.

### Desktop consent — local and remote defaults differ

| Entry point | Default `mode` for a desktop (`type:"zcode"`) target | What a `submit` needs |
|---|---|---|
| Node delivery (`deliver`, i.e. a `targets.json` desktop target) | `draft` | `consent: true` on that message, or `OPENACOM_DESKTOP_CONSENT=1` in that node's environment |
| Remote relay (`relay_send` / `relay send`) with `mode` omitted | the rule is "target type decides" (desktop `draft`) — but the 0.11.0 hub fills in `submit` at enqueue, so today it is still `submit` | the same two options — a remote desktop submit is consent-gated too |
| Legacy adapter route: CLI `openacom send <zcodeId> …` (the default visible route) | `submit` — that transport has no draft mode | `--consent true` on that message, or `OPENACOM_DESKTOP_CONSENT=1` in this process |
| Legacy adapter route: MCP `send_desktop`, or `send_message` with `inject:true` + `desktop:true` | `submit` — that transport has no draft mode | `consent: true` on that call, or `OPENACOM_DESKTOP_CONSENT=1` in the MCP process |
| Routed MCP `send_message` / `relay_send` with `route:"desktopcdp"` or `mode:"submit"` | `submit` | `consent: true` on that call, `OPENACOM_DESKTOP_CONSENT=1` in the process, or the resident `desktop-consent` file (exactly `1`) in the OpenAcom home |
| MCP `send_message` default (no `inject`) | no desktop contact at all: the message is stored in the target's inbox | nothing — there is no UI side effect to authorize |
| Explicit draft from the CLI: `openacom send <zcodeId> … --desktop --draft` | `draft` (routed through the strict sender) | nothing: it never presses Enter |

Every consent gate above also honors the resident file grant: a
`desktop-consent` file containing exactly `1` in the OpenAcom home
(`AGENTRELAY_HOME`, `~/.openacom` by default). Unlike the env vars it reaches
MCP servers that an already-running desktop app spawned with its inherited
environment, so agents on a single-operator machine can submit without a
per-call flag; `get_paths` reports the file path and whether it is granted, and
deleting the file revokes it immediately.

Asking a submit-only transport for another mode is `INVALID_MODE` rather than a
quiet downgrade, which is why `--draft` has to be paired with `--desktop` (that
combination is what selects the strict sender).

`consent` must be a **literal boolean** — `"true"` or `1` is rejected as
`INVALID_CONSENT` before dispatch, because coercing leniency would press Enter
on somebody's behalf. The env var must be exactly `1`. A refusal is
`CONSENT_REQUIRED` with `uncertain: false` (nothing reached the desktop, so
retrying as `draft` is safe — at a terminal the CLI prints those same two ways
out: `--desktop --draft`, or `--consent true`), and it is deliberately *not*
deferral-eligible, so it never burns redelivery budget. An uncleared desktop
draft blocks further delivery to that same session until a human clears it — an
intentional in-the-loop trade-off: the selection step reports `DESKTOP_TARGET`,
and a composer that cannot be proven empty-and-unique reports `INPUT_LOCKED`
(concurrent deliveries collide on `INPUT_BUSY`). The strict path binds to the
observed ZCode v4 markup only (`v4-composer-input`, a `v4-session-pane-` whose
`data-session-id` matches exactly); when that binding fails it refuses instead
of guessing by title, so a UI revision breaks it together with the identity
defaults below. A node also states which side of the gate it started on, on
stderr (`desktop targets refuse submit unless the message carries consent:true`,
or `desktop targets accept submit because this process environment grants consent`)
next to the receipt store's `acl=` line — treat those startup lines like any
other credential-bearing stderr per the notes below.

### Per-node credentials

`AGENTRELAY_TOKEN` (32+ characters) is now the **bootstrap** credential: it can
enqueue, register a new node id, and read status; it can **not** poll, ack,
`GET /security`, `POST /queue/prune`, or `POST /messages/:id/retry` (403
`NODE_CREDENTIAL_REQUIRED` / `ADMIN_CREDENTIAL_REQUIRED`). Registering
(`POST /nodes/:id/heartbeat`) returns a
`nodeToken` — 43-char base64url, shown in plaintext exactly once; the hub keeps
only the SHA-256 digest of `Bearer <token>` and compares it in
constant time. Poll and ack require it and only ever touch that node's own
queue (otherwise 403 `NODE_FORBIDDEN`, plus a `CREDENTIAL_MISMATCH_ACK` alert).
The node keeps `nodeToken` in its own receipt store (`settings` table of
`~/.openacom/node-<sha256hex(nodeId)>.sqlite` by default, `--data` moves it), so
later starts need no shared bootstrap secret.

Takeover is refused: heartbeating a still-leased node id from a different
instance/session returns 403 `NODE_TAKEOVER` and the original holder keeps
authority; rebinding after the 120s lease goes idle issues a fresh credential
and answers with `credentialRotated: true`, locking the old holder out.
Auditability: `GET /security` (admin; last 200 alerts, kinds
`ADMIN_HEARTBEAT_FOR_REGISTERED_NODE`, `FOREIGN_CREDENTIAL_HEARTBEAT`,
`NODE_TAKEOVER_BLOCKED`, `CREDENTIAL_ROTATED`, `MULTI_SOURCE_HEARTBEAT`,
`CREDENTIAL_MISMATCH_ACK`, throttled to one per kind per 60s) and `GET /nodes`,
which carries per-node `security[kind].count/lastAt` and
`credential.fingerprint/issuedAt`. Neither admin route has a CLI subcommand —
call them with the bootstrap credential yourself.

**Residual risk, stated plainly:** the shared bootstrap credential can still
register a **new** node id and drain that new node's own queue — it never
identifies a machine. The only practical tightening is to start the hub with
`AGENTRELAY_ALLOWED_NODES` (comma-separated): unlisted ids are refused at
registration (403 `NODE_NOT_ALLOWED`), and an **empty allowlist means open
registration**. Separately, `to` must be a registered node or a name in that
allowlist, else 403 `UNKNOWN_NODE` (an allowlisted node that has not connected
yet may be addressed; the message queues until it arrives).

### Queue boundaries

| Environment variable | Default | Effect |
|---|---|---|
| `AGENTRELAY_QUEUE_TTL_MS` | `86400000` (24h) | Undispatched messages age to `expired` |
| `AGENTRELAY_NODE_QUEUE_LIMIT` | `128` | Per-node depth over `queued`/`delivering`/`deferred`/`uncertain`; above it, 429 `QUEUE_FULL` with `error.retryAfterMs`. An idempotent replay of an existing id bypasses the quota |
| `AGENTRELAY_HISTORY_RETENTION_MS` | `604800000` (7d) | Retention for terminal rows and alerts, hub and node alike |

All three must be positive (the limit also an integer) or startup fails — no
silent clamping. **The hub runs no background timer**: expiry and lease decisions
ride the ordinary request path, retention work is throttled to once a minute,
and `POST /queue/prune` (admin) forces a sweep and returns
`{ok,expired,deleted,alerts}`. In-flight claims are never aged out by the TTL —
only by the lease path into `uncertain`, because `expired` asserts the target
was never touched.

### Operator retry

`POST /messages/:id/retry` (admin credential; there is **no CLI subcommand** for
it) puts a message back through the queue. It accepts only the four statuses
`RETRYABLE_FROM` allows — `queued`, `deferred`, `expired`, `failed` — and every
other state is a 409 that says why: `delivered` is `ALREADY_SETTLED` (the owning
node already reported the input landed), `uncertain` is
`UNCERTAIN_NOT_RETRYABLE` (the input may already be in the window, so only that
node may settle it), and `delivering` is `CLAIM_ACTIVE` (a node holds a live
lease). A retry resets the deferral window and budget and restarts the TTL clock,
clears the claim and the previous result/error, and increments `retries`; what it
deliberately does **not** wash away is the attempt history, the sticky
`everUncertain` marker with its `settlement` trail, or the message's recorded
`consent` — retrying the same desktop submit is not a second, quieter
authorization. Re-queueing an already-terminal row counts against the node's
depth again, so it can come back 429 `QUEUE_FULL`; if the row changes state
under the update the call fails with 409 `RETRY_RACED` and the operator reads it
again instead of guessing. The response is the public receipt
(`{ok, id, status, attempts, deferrals, retries, retryable, terminal, expiresAt,
retryEligible}`), where `retryEligible` simply reports whether this endpoint
would take the row right now and `retryable` stays the narrower "the hub may hand
it out again" the sender is told about.

### File permissions and the descriptor boundary

`lib/secure-fs.js` is the one place that actually tightens: POSIX `chmod`
`700`/`600` followed by a re-read of the mode bits; Windows
`icacls <path> /inheritance:r /grant:r "<principal>:F"` (directories get
`(OI)(CI)F`), passed as an argv array and never through a shell. When another
account must keep access, name it with `OPENACOM_ACL_PRINCIPAL` (legacy
`AGENTRELAY_ACL_PRINCIPAL` accepted). Failure does **not** throw: the call
reports `acl: 'inherited'` and writes one stderr line, because a failed
tightening must not block delivery. Consequences you can observe: terminal
descriptors gained an `acl` field (`private` / `inherited`, and delivering to an
`inherited` one warns first), `GET /nodes` gained
`store:{acl,paths:[{path,acl,platform,principal,error?}]}`, hub and node each
print one `... acl=` line at startup, and `get_paths` reports `logDirAcl` plus
`inboxAcl`.

On POSIX a group- or world-readable `targets.json` makes the node **refuse to
start** — it holds the IPC secrets; on Windows you only get a warning, because
the ACL state cannot be re-verified there. Stale terminal descriptors are
neither silently reused nor auto-deleted: they report `DESCRIPTOR_STALE`,
`DESCRIPTOR_ANOMALY`, or `DESCRIPTOR_PERMISSION` for a human to resolve, and
those three are terminal (`failed`), not deferrable. **Limitation:** a Windows
named pipe has no path-based mode and `icacls` will not take its path either, so
pipe access is guarded only by the per-terminal secret — anyone who can read
the descriptor on that machine can inject.

### CDP identity checks — fail closed, not authentication

A localhost CDP port authenticates nobody: whoever wins the port first answers
these requests. Desktop delivery therefore shape-checks before any text goes
out — `Browser`/`Product` in `/json/version` must look like a Chromium-family
engine and its `User-Agent` must carry `Electron/<digit>`; `/json` must contain
**exactly one** page whose `url` has the ZCode main-window shape (`file:`,
`chrome-extension:`, or loopback http); and after the WebSocket connects the
page's own `navigator.userAgent` is cross-checked. Any mismatch is
`CDP_IDENTITY` and a **refusal** — never a fallback. "Nothing is listening"
(`DESKTOP_UNAVAILABLE`) and "something answered but it is not ZCode"
(`CDP_IDENTITY`) stay separate verdicts, because only the first may divert the
legacy transport to UIA. `identity` overrides the three checks (`browser`,
`userAgent`, `pageUrl`; a RegExp or a literal substring, with `null`/`false`/`''`
disabling that one), and a bad field name or type is `INVALID_IDENTITY`. Note
that override is currently reachable **only** by calling `sendDesktopStrict`
programmatically — a zcode entry in `targets.json` rejects an `identity` field
(`INVALID_TARGET`), and the node path does not forward it.

**Honest caveat:** those three defaults are **not verified against a live
machine** — this round was not allowed to touch a real 9222, and this host has
nothing listening. What is guaranteed today is fail-closed behaviour (a mismatch
errors out instead of mis-delivering), *not* protection against an impersonating
local process: this is not authentication, and any local process can copy those
fingerprints. The flip side is that if ZCode ever changes its UA or page URL
shape, the defaults will reject the legitimate target too, and you will need an
explicit `identity`.

### Error codes

| Code | Where | Meaning |
|---|---|---|
| `NODE_CREDENTIAL_REQUIRED` | hub 403 | Bootstrap used for poll/ack; the registration-issued node credential is required |
| `ADMIN_CREDENTIAL_REQUIRED` | hub 403 | Route needs the bootstrap credential (enqueue, `GET /nodes`, `GET /security`, prune, retry) |
| `NODE_FORBIDDEN` | hub 403 | Credential belongs to a different node id |
| `UNKNOWN_NODE` | hub 403 | `to` is neither registered nor in `AGENTRELAY_ALLOWED_NODES` |
| `NODE_NOT_ALLOWED` | hub 403 | Registration refused by the allowlist |
| `NODE_TAKEOVER` | hub 403 | Another instance heartbeats a node id whose lease is still live |
| `INVALID_CONSENT` | hub 400 | `consent` was not a literal boolean |
| `QUEUE_FULL` | hub 429 | Node queue depth exceeded; response carries `error.retryAfterMs` |
| `QUEUE_EXPIRED` | message `error.code` | Never dispatched inside the TTL (`expired`); target untouched |
| `CONSENT_REQUIRED` | local delivery | Desktop submit not authorised; target never touched (`uncertain:false`) |
| `CDP_IDENTITY` | local delivery | The debug port answered, but not as ZCode — text refused |
| `INVALID_IDENTITY` | local delivery | Unknown field or bad type in an `identity` override |
| `DESCRIPTOR_STALE` | local delivery | Socket/pipe is gone; no managed terminal is listening |
| `DESCRIPTOR_ANOMALY` | local delivery | The path is not a socket, or cannot be inspected at all |
| `DESCRIPTOR_PERMISSION` | local delivery | Socket or its directory lets another local user write into it |
| `INJECT_REQUIRED` | MCP call | An inject-only option (or `to:"zcode:new"`) arrived without `inject:true`; refused rather than answered with a mailbox row |
| `INJECT_UNSUPPORTED` | MCP call | `inject:true` asked for a target that has no injection channel (`qoder:`, bridge) — the default path queues it instead |
| `DESKTOP_UNSUPPORTED` | MCP call | Desktop submit is zcode-only; the named session has no desktop route |
| `GROUP_FORBIDDEN` | MCP local gate | The agent-groups registry does not grant this identity that session (`uncertain:false`, checked before any side effect) |
| `ID_CONFLICT` | local mailbox | A stored mailbox id replayed with different `from`/`to`/`text` |
| `ALREADY_SETTLED` | hub 409 | Retry refused: the node reported the input delivered |
| `UNCERTAIN_NOT_RETRYABLE` | hub 409 | Retry refused while uncertain — only the owning node may settle it |
| `CLAIM_ACTIVE` | hub 409 | Retry refused: a node holds a live claim on the row |
| `RETRY_RACED` | hub 409 | The row changed state while the retry was being applied; read it again |

The five local-delivery codes from `CONSENT_REQUIRED` down to
`DESCRIPTOR_PERMISSION` are reported back by the node and the hub settles the row
as `failed` with that code. `QUEUE_EXPIRED` is written by the
hub's own expiry sweep, not by an HTTP rejection.

### Upgrading

Upgrade hub and node **to the same version together, then restart both**: an old
node polling with the bootstrap credential now gets 403, and an old hub does not
understand a `deferred` ack. Receipt comparison is normalized (a stored payload
without `consent` reads as `false`), and new columns are added in place through
`PRAGMA table_info` + `ALTER TABLE`, so no database rebuild is needed.

## Commands

| Command | What it does |
|---|---|
| `openacom list [query...] [--agent zcode\|claude\|codex\|opencode] [--limit N] [--json]` | Unified session table with **fuzzy search** (agent/id/title/workspace, space-separated AND); top 30 by default, `--limit N` overrides |
| `openacom read <sessionId> [--agent A] [--last N] [--json]` | Last turns of any session, system noise filtered |
| `openacom send <message...>` | Fresh zcode session per message (the recommended agent-to-agent pattern; visible in the desktop task list) |
| `openacom send <sessionId> <message...> [--agent A] [--timeout ms] [--json] [--desktop] [--no-desktop] [--consent true\|false] [--draft] [--wait] [--no-wait] [--require-read]` | Deliver a real user turn and print the reply. For zcode this is the visible desktop route by default, so it is consent-gated (`--consent true`, or `OPENACOM_DESKTOP_CONSENT=1`; `--desktop --draft` leaves it unsubmitted; `--no-desktop` is headless). opencode targets steer the exact session live — never forked — and stream the turn in the CLI; blocking by default, `--no-wait` detaches |
| `openacom paths` | Show detected storage locations and CLI paths |
| `openacom inbox [--status S] [--limit N] [--json]` | Tracked sends and their read status (`sent` awaiting ack / `read` / `failed`) |
| `openacom ack <messageId>` | Manually mark a tracked message as read |
| `openacom oc-serve [dir] [--port N]` | Pre-warm a project's shared OpenCode server (normally unnecessary because `send` starts it automatically) |
| `openacom oc-attach [dir] [--port N]` | Open a live OpenCode TUI on the project's shared server, starting the server when needed |
| `openacom web [--port N]` | Local inbox/dashboard on `127.0.0.1:9339` (override with `--port`). **Needs a token now**: on first start it generates `~/.openacom/openacom-web.token` (`0600`) and prints the secret to stderr; pin it with `AGENTRELAY_WEB_TOKEN` instead if you would rather not have it in a log. Every `/api/*` call must carry `X-OpenAcom-Token`, and `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding guard — `[::1]` is refused). The page embeds the token itself, so the one command above is still all you need |
| `openacom mcp` | Run as a stdio MCP server exposing the same operations as tools |

Session ids are matched across all four agents automatically; pass `--agent`
when an id could be ambiguous or to skip the full scan.

## Use as an MCP server

`openacom mcp` runs a stdio MCP server with **11 tools**: 8 local ones plus the
3 distributed ones (`relay_nodes`, `relay_send`, `relay_status`), which call the
hub with the `AGENTRELAY_URL` + `AGENTRELAY_TOKEN` configured on this MCP
process, so without those two they fail when you call them (see the Distributed
relay chapter above, and the Chinese guide at the end for the setup steps).

| Tool | What it does |
|---|---|
| `list_sessions` | Fuzzy session table across all four agents |
| `read_session` | Recent turns of one session (`sessionId`, optional `agent`, `last`) |
| `send_message` | **Stores first, then attempts one selected delivery route**; route:mailbox explicitly stores only |
| `send_desktop` | The one verb whose purpose is pressing Enter in a zcode desktop window: always submit, never degrades, needs consent on every call |
| `post_message` | The same mailbox with your own `from` and a stable `id` for idempotent retries; no injection semantics at all |
| `inbox` | Lists tracked sends and mailbox rows with their status; filter by `to` / `from` / `status` |
| `ack_message` | Settles a read receipt — a `--require-read` send, or a mailbox row |
| `get_paths` | Detected storage and CLI paths, the acl of the two trees this owns, the groups registry, and the identity the gate takes you to be |
| `relay_nodes` | Registered nodes, their security counters and store acl (hub) |
| `relay_send` | Queues a message to a named target on another machine (hub) |
| `relay_status` | Reads one distributed message's durable receipt (hub) |

**Default send: store, then attempt delivery.** `send_message({to,message})` writes the inbox before trying one route. Select `route`: `auto` (default), `session`, `desktopcdp`, `desktop`, `relay`, or `mailbox`. Auto uses strict desktop CDP for zcode, the session adapter for other local agents, or relay for `node:nodeId/target`. The desktopcdp route never falls back to UIA or a headless CLI; zcode must expose its debugger (default loopback port 9222). Desktop submit keeps the existing consent requirement. Desktop explicitly submits through the zcode desktop transport and requires consent. Unknown local transports report refused while retaining the message. Failed or uncertain delivery never silently switches routes or retries.

Results include id/messageId, from, to, route, status, and optional code/detail. Status is stored, queued, accepted, refused, or uncertain; none proves the model read or completed a task. Use `inbox` to inspect retained messages and `ack_message` to acknowledge them. Stable `id` repeats return the original outcome without another attempt; changed payload or route yields ID_CONFLICT. A new explicit attempt needs a new ID after checking the prior outcome. The group gate runs before any storage or delivery.

`route:mailbox`, legacy `inject:false`, and `post_message` explicitly store only. Legacy `inject:true` retains direct injection and its existing read-receipt mode; do not combine inject with route. The new routed path does not retry for read receipts. CLI: `openacom deliver zcode:session hello --from pi:sender --route session --id request-1`. SDK: `require('openacom/routing').sendRouted(to,text,{from,route,id})`. The isolated embedded entry remains unchanged.

**`send_desktop` — the verb that presses Enter.** It is the one MCP entry point
whose job is a live desktop submit, so it is the one that can disturb a window
somebody is typing in, and it stays deliberately narrow: zcode targets only
(`DESKTOP_UNSUPPORTED` otherwise), **always submit** — there is no draft mode
here — and **never degrades**: no headless fallback and no quiet return to the
mailbox. The only route change it makes is when nothing answers the debug port at
all, where the legacy UIA transport drives the on-screen window instead, which
also presses Enter; an endpoint that answers but does not match the ZCode
identity is a hard refusal. Every call needs its own authorization:
`consent:true`, or `OPENACOM_DESKTOP_CONSENT=1` in this MCP process, otherwise
`CONSENT_REQUIRED` with `uncertain:false` — nothing was typed. `from` / `to` /
`message` are required, `timeoutMs` defaults to 60s, and the group gate plus the
CDP identity probe apply exactly as everywhere else. It returns once the input
has landed (`status:"desktop-submitted"`, `delivery:"desktop"`); the turn then
runs inside the app, so read it with `read_session`. When you do not need a live
window, use `send_message`'s default or `post_message` instead.

Wire it in (adjust the path to your install):

Claude Code:

```bash
claude mcp add openacom -- node /path/to/openacom/bin/openacom.js mcp
```

Claude Desktop (`%APPDATA%\Claude\claude_desktop_config.json`):

```json
{ "mcpServers": { "openacom": {
    "command": "node",
    "args": ["C:\\path\\to\\openacom\\bin\\openacom.js", "mcp"]
} } }
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.openacom]
command = "node"
args = ['C:\path\to\openacom\bin\openacom.js', 'mcp']
```

ZCode (`~/.zcode/cli/config.json`):

```json
{ "mcp": { "servers": { "openacom": {
    "command": "node",
    "args": ["C:\\path\\to\\openacom\\bin\\openacom.js", "mcp"]
} } } }
```

OpenCode (`~/.config/opencode/opencode.jsonc`):

```json
{ "mcp": { "openacom": {
    "type": "local",
    "command": ["node", "C:\\path\\to\\openacom\\bin\\openacom.js", "mcp"],
    "enabled": true
} } }
```

The default `send_message` call returns as soon as the row is stored (see
above); `inject:true` with `wait:true` blocks until the target finishes and
returns its reply. All the caveats below apply to that injected turn — it
appends to the target session's real history and spends its tokens. Consent is
symmetric now: `relay_send`, `send_message` with `inject:true` + `desktop:true`,
and `send_desktop` each take a `consent` argument, and on all three an omitted
or false `consent` still passes if this MCP process's environment sets
`OPENACOM_DESKTOP_CONSENT=1`, or if the resident `desktop-consent` file in the
OpenAcom home contains exactly `1`; without either, the call comes back
`CONSENT_REQUIRED` having touched nothing (see Desktop consent above).

`relay_send` takes `{to, target, text, mode?, id?, consent?}`, and an omitted
`mode` **means "let the target type decide"**: a desktop target gets `draft`
(text lands in the composer, nobody presses Enter) while terminal and other
targets get `submit`; only an explicit `submit` needs consent. That decision is
made on the **node** side (`effectiveMode` in `lib/delivery.js`), so it holds
only if nothing upstream fills the field in for you — `relay_send` stops sending
it when you omit it, but **as of 0.11.0 the hub still defaults an absent `mode`
to `submit` at enqueue** (`messageInput` in `lib/distributed.js`), and the
`relay send` CLI does the same. Closing those two is part of this wave; until
then a remote send that omits `mode` is still a submit and still faces the
consent gate.

### OpenCode sends — direct steer, live in the CLI

`send` to an opencode session runs `opencode run -s <id>` with the message
over stdin: a genuine user turn in **that exact session**, never `--fork`ed
(a fork would divert the turn into a copy the live session never sees). The
CLI streams the turn live — session header, tool progress, then the reply —
so a steer is visible the moment it happens:

```
$ openacom send ses_f4fa6e7b... "Continue with the next step"
> build · muse-spark-1.3-contributor-free
→ Read src/index.ts
Done, next step implemented.
[session: ses_f4fa6e7b...]
```

Blocking is the default for opencode targets; `--no-wait` detaches into the
background (reply lands in the transcript; `read` to review). With `--json`
the live stream goes to stderr and the final reply stays clean on stdout.

### OpenCode live TUI delivery — the shared server (automatic)

`opencode run` boots a **throwaway instance** each time: two instances share
nothing but the SQLite file, so a TUI already open on the session shows the
delivered turn only after you reopen it — the same staleness zcode's desktop
had. OpenCode's own fix is a persistent server: it is the single event source
and pushes every turn over SSE to TUIs attached to it.

OpenAcom rides that with zero manual steps: every `send` to an opencode
session **ensures the project's shared server by itself** — reuse when up,
start when missing — then posts `POST /session/<id>/message`, so **every
attached TUI shows the turn live**: the user message, tool progress, the
streaming reply.

```
$ openacom send ses_f4fa6e7b... "Continue with the next step"
opencode server started for F:/Saba - live TUI: opencode attach http://127.0.0.1:44231
Done, next step implemented.
[session: ses_f4fa6e7b...]
$ openacom oc-attach F:/Saba             # opens the live TUI; no URL lookup or paste
```

- The attach hint prints exactly once, when the send booted the server.
  Later sends reuse it silently.
- `serve` is project-scoped, so each directory gets a **deterministic port**
  derived from the path (44000-44996); sender and server derive it
  identically, no registry. `AGENTRELAY_OPENCODE_URL` overrides the probe,
  `AGENTRELAY_OPENCODE_NOSERVE=1` disables auto-start entirely.
- The adapter verifies the target session actually lives on the probed server
  (port-collision guard) before posting.
- No server possible? Transparent fallback to the `run` paths above —
  delivery always works, live refresh is the upgrade.
- Blocking sends return the finished reply from the server; `--no-wait` posts
  through a detached helper so the turn survives the CLI exiting.
- `openacom oc-serve [dir] [--port N]` only pre-warms the server (and
  prints the attach line) without sending. The same shared-server behavior
  reaches MCP `send_message` on its injected path (`inject:true`) — one adapter,
  CLI and MCP alike.
- `openacom oc-attach [dir] [--port N]` is the one-step viewer command: it
  starts the same server when needed and attaches a TUI in the current terminal.

### Read receipts — tracked sends that redeliver until acknowledged

A plain `send` proves *input delivered*, nothing more. When you need the target
to actually **receive and process** a message, add `--require-read` (CLI) or
`requireRead: true` on MCP `send_message` (which is an inject-only option, so it
needs `inject:true`) — or, on the default path, just have the recipient call
`ack_message` on the row id: a mailbox row is written once and never
redelivered, so it simply reads `sent` until somebody acknowledges it.

- the message carries a receipt footer with a unique id and asks the target to
  ack — by calling the `ack_message` MCP tool, or (works even before the
  target's MCP process has restarted with the new tools) by simply replying
  with a line containing `ACK-<id>`;
- OpenAcom counts the ack **only in turns the target adds after the send**: it
  baselines how many assistant turns already mention `ACK-<id>` before delivering
  and reads the receipt only when that count grows (a tool call, or a *new*
  assistant turn carrying the token). Re-displaying an older footer — a quoted
  transcript, a recap that pastes the old receipt line — no longer marks anything
  read. If the transcript could not be read before the send, the baseline is
  unknown and no transcript ack is trusted for that attempt at all.
- No ack within `--ack-timeout` (default 90s) → **automatic redelivery**, 3
  attempts total; still nothing → the message is declared `failed` and the sender
  gets an honest error instead of a fake OK.
- Residual limits, unchanged: on stdio MCP the `from` address is not
  authenticated (any local process attaching to this server can claim any
  address), and read status is by definition self-reported — a target that starts
  a fresh turn merely *containing* the token counts as having read it.

```
$ openacom send sess_... "what is the deploy status?" --agent zcode --require-read
READ (attempt 1/3)            # target acknowledged
$ openacom send sess_... "urgent: rotate the staging key now" --agent zcode --require-read --ack-timeout 30000
FAILED after 3 attempts — target never acknowledged
```

Every tracked send lives in the local inbox (`~/.openacom/inbox.sqlite`):
`openacom inbox` (or the MCP `inbox` tool) lists statuses, `openacom ack
<id>` / MCP `ack_message` marks read. A target that never acks — offline
agent, dead session, a human who stopped caring — is *reported*, not retried
forever: 3 strikes and the sender is told. Note the ack waits in the calling
process, so a `requireRead` send blocks (worst case ~3 × ack-timeout); keep
your MCP timeout above that.

### Fresh sessions — recommended for agent-to-agent traffic (zcode)

`openacom send --fresh <message>` runs the message in a **brand-new** zcode
session (headless, synchronous reply, `sessionId` returned). New sessions appear
in the desktop app's task list automatically, and opening one loads its full
transcript — so your agent traffic stays visible in the desktop without ever
injecting into a conversation the user has open (which the app would not
re-render anyway: it keeps open sessions in memory and never re-reads the DB).

```
$ openacom send "Summarize the API research" --json
{ "ok": true, "sessionId": "sess_...", "reply": "..." }
```

`send` with no sessionId defaults to this; `--fresh` is the explicit form. Over
MCP the same thing is `send_message` with `to:"zcode:new"` — creating a session
is injection by definition, so it needs `inject:true` and is refused with
`INJECT_REQUIRED` otherwise.

CLI sends are **fire-and-forget by default** (reply lands in the transcript;
`--wait` blocks for it). For zcode, CLI sends are **CDP-first by default**: when
the desktop app runs with `--remote-debugging-port`, messages go through the
app's real composer — live
refresh, native chain, steer of a running turn — at the cost of the app
switching to that conversation; when the debug port is absent it tries the
desktop UIA route (brief focus steal), and if that fails too the send errors out
instead of silently degrading. Both of those visible branches press Enter, so
they need `--consent true` on that message or `OPENACOM_DESKTOP_CONSENT=1` in the
sender's environment (see Desktop mode below). `--desktop --draft` keeps the text
in the composer without pressing Enter, and `--no-desktop` (CLI) /
`desktop: false` on an injected MCP send (`inject:true` + `desktop:false`)
forces silent headless with no view switch — the default MCP send never reaches
this branch, because it only writes to the inbox. claude/codex CLI sends are
always headless (plus remote-SSH injection for claude remote sessions).

For a continuing back-and-forth, keep resuming that fresh session's id with the
normal `send <id>` — it is a headless session no desktop tab holds, so nothing
can go stale.

### Remote agents (e.g. Claude Code on an SSH server) - HTTP transport

stdio MCP servers can only be spawned by local clients. For agents running on
another machine, OpenAcom also speaks streamable HTTP:

```powershell
# on the Windows machine (one-time per boot):
powershell -ExecutionPolicy Bypass -File tools\relay-remote-up.ps1 -SshHost root@your-server
# starts: local MCP on 127.0.0.1:9322 + an SSH reverse tunnel server:9321 -> local:9322
```

Then on the server, register it in Claude Code (`~/.claude.json`):

```json
{ "mcpServers": { "openacom": { "type": "http", "url": "http://127.0.0.1:9321/mcp" } } }
```

The remote agent gets the same tools operating on your **local** sessions.
Traffic stays inside the SSH tunnel; both endpoints bind localhost only.
## How it works (the interesting parts)

### ZCode provides no session API - how sending was made possible

ZCode desktop keeps every conversation in a local SQLite database
(`~/.zcode/cli/db/db.sqlite`, `message` + `part` tables). OpenAcom reads
sessions straight from that DB. Sending required reverse-engineering three
delivery routes:

- **Headless resume**: the CLI bundled with the desktop app
  (`zcode.cjs --resume <id> --prompt`) materializes the session in its own
  process and runs the turn there. Needs a model provider in
  `~/.zcode/cli/config.json` (`"model": "provider/model-id"`); the desktop app's
  copy under `~/.zcode/v2/config.json` is not read by headless runs.
- **Why the desktop window does not refresh on external writes**: the app is a
  single-writer architecture. The UI renders state held in its app-server's
  memory; the database is its persistence log, not a shared bus. External
  inserts are never re-read (verified: queue-table rows written by outside
  processes stay unclaimed; there is no TCP/pipe control surface; injecting a
  row into the internal session_input queue is ignored). Messages still land and
  the agent still processes them - only the open window does not repaint.
- **CDP route (the default; the only visible route)**: start the app with
  `--remote-debugging-port=9222` and OpenAcom drives the renderer directly -
  locate the session row in the sidebar, focus the composer, insert the message
  as trusted input, press Enter. The turn runs *inside* the app: live refresh,
  native message chain, and with `zcodeInteractionBehavior: "guide"` a message
  arriving mid-turn steers the running agent instead of queueing. Works while
  the window is backgrounded or minimized (renderer-level events, no OS focus
  steal). This is the only way to deliver into a conversation the user has open.
  Headless is now opt-in only (`--no-desktop` / `desktop: false`); a CDP failure
  surfaces as an error instead of silently degrading.

### Remote (SSH) Claude sessions - reading a mirror, writing to the live brain

Claude sessions on SSH workspaces keep only a transcript mirror locally; the
live process (`ccd-cli --resume=<id> --input-format stream-json`) runs on the
server and consumes user turns from its stdin. OpenAcom:

1. resolves the host from the `ssh:<host>:<cwd>` project keys in
   `~/.claude.json` (e.g. `ssh:root@1.2.3.4:/root/TokenGateway`);
2. finds the live runner over SSH by its `--resume=<id>` flag;
3. writes one stream-json user turn into `/proc/<pid>/fd/0`.

The turn executes inside the live process, so the reply streams back to the
Claude desktop in real time and the chain stays native.

### Remote agents driving local sessions

stdio MCP servers can only be spawned by local clients, so for agents on other
machines OpenAcom also speaks streamable HTTP, paired with an SSH reverse
tunnel (`tools/relay-remote-up.ps1`). The script listens on `127.0.0.1:9322`
locally (9321 is commonly taken by other desktop apps) and maps the remote's
unchanged `9321` onto it, so the remote client registers
`http://127.0.0.1:9321/mcp` and gets the same tools operating on your local
sessions; traffic never leaves the SSH tunnel.

### Desktop mode (zcode, Windows) — the only route, by design

A zcode `send` delivers through the **desktop UI over CDP**: it locates the
session in the desktop app's sidebar, focuses the composer, and types the
message in as renderer-level trusted input (no focus stealing). The turn runs
**inside the desktop app**, so its window updates live, the message chain stays
native, and if the session is mid-turn the message **steers** it (requires the
desktop setting `zcodeInteractionBehavior: "guide"`).

There is **no silent fallback**: if CDP delivery fails (app not running with
the debug port, session row not found, composer not reachable), the send
**errors out** — earlier versions quietly degraded to a headless run that could
use a different model than the session UI, or drop the message entirely when
headless was broken. The caller sees the real failure and can retry.
`--no-desktop` (CLI) or `desktop: false` (MCP) is the explicit headless escape
hatch for when you want that behavior on purpose — it is also the route to take
when the consent gate below refuses to submit.

Two gates sit in front of that visible path now:

- **Consent.** This transport always presses Enter, and it has no draft mode of
  its own, so it refuses to type anything until either that individual message
  carries consent (`--consent true` on the CLI, `consent: true` on the strict
  node path, on `relay_send`, and on the two MCP desktop verbs `send_desktop` and
  `send_message` with `inject:true` + `desktop:true`) or the sender's process
  environment sets `OPENACOM_DESKTOP_CONSENT=1` (legacy
  `AGENTRELAY_DESKTOP_CONSENT=1` also works). A refusal is `CONSENT_REQUIRED` with
  `uncertain: false`: the window was never touched. Asking this transport for a
  draft is `INVALID_MODE`, never quietly turned into a submit; add `--desktop`
  with `--draft` and the CLI switches to the strict sender, which stops before
  Enter. The MCP default `send_message` never reaches this transport at all — it
  stores into the target's inbox — so there is nothing to authorize there.
- **Endpoint identity.** Before any text goes out, the port must answer as the
  ZCode desktop: `/json/version` naming a Chromium-family engine with
  `Electron/<digit>` in its `User-Agent`, exactly one identity-shaped page in
  `/json`, and a matching `navigator.userAgent` after connecting. A port that
  answers but does not match is `CDP_IDENTITY` and a hard refusal; only
  "nothing answered" (`DESKTOP_UNAVAILABLE`) may divert to UIA. **These defaults
  are not verified against a live machine** (see CDP identity checks above): the
  guarantee is fail-closed refusal, not protection from an impersonator.

One-time setup:

```powershell
# quit ZCode first (tray icon -> exit), then:
powershell -ExecutionPolicy Bypass -File tools\start-zcode-cdp.ps1
```

This relaunches the app with `--remote-debugging-port=9222` (CDP is a local
control surface — only enable it on a machine you trust). To make it permanent,
add that flag to your ZCode shortcut's Target instead.

Trade-offs: Windows only; the desktop app must be running with the CDP flag;
matches the session by title prefix; returns no reply text (the turn runs
asynchronously in the app).

## Where sessions come from & how sends are delivered

| Agent  | Sessions read from                     | Send channel                                     |
|--------|----------------------------------------|--------------------------------------------------|
| claude | `~/.claude/projects/**/*.jsonl`        | `claude --resume <id> -p` (prompt via stdin)     |
| codex  | `~/.codex/sessions/**/rollout-*.jsonl` | `codex exec resume <id> -` (prompt via stdin)    |
| zcode  | `~/.zcode/cli/db/db.sqlite`            | desktop UI over CDP (default; submit needs `--consent true` or `OPENACOM_DESKTOP_CONSENT=1`, and the port must pass the identity check; `--desktop --draft` types without pressing Enter); `zcode.cjs --resume <id> --prompt <msg>` with `--no-desktop` |
| opencode | `~/.local/share/opencode/opencode.db`  | project shared server `POST /session/<id>/message` (auto-started); `opencode run -s <id>` (message via stdin) as fallback |

The session features above run locally against your existing installs and add no
service, port, or daemon of their own. The opt-in pieces do listen, on
localhost only: `relay hub` (default `127.0.0.1:9330`), the distributed node
itself opens no port (it polls the hub), `web` binds `127.0.0.1:9339` behind its
token, and `mcp-http` binds `127.0.0.1:9321` by default.

**Remote (SSH) Claude workspaces** appear in `list`/`read` with an `ssh:` prefix on
the workspace; subagent transcripts (`agent-*.jsonl`) are never listed as sessions.
`send` to a remote session is supported: OpenAcom resolves the SSH host from the
`ssh:<host>:<cwd>` keys in `~/.claude.json`, finds the live session runner process
(`--resume=<id>`) on that host, and injects the message into its stdin as a
stream-json user turn — the turn runs inside the live process, so the reply streams
to the desktop app in real time. If the session is not currently running, start it
once from the desktop app first. Codex and ZCode sessions are local; no remote
handling applies.

## Per-agent requirements

- **claude** — `claude` CLI on PATH, logged in, and its API endpoint reachable
  (check `ANTHROPIC_BASE_URL` if you use a relay).
- **codex** — `codex` CLI on PATH and authenticated (`~/.codex/auth.json`).
- **zcode** — the desktop install's `zcode.cjs` is auto-detected from
  `ZCODE_WINDOWS_APP_INSTALL_DIR` / `%LOCALAPPDATA%\Programs\ZCode`
  (override with `AGENTRELAY_ZCODE_CLI`). Headless sends additionally need a
  model provider in `~/.zcode/cli/config.json`:

  ```json
  {
    "provider": {
      "bigmodel": {
        "kind": "anthropic",
        "options": { "apiKey": "sk-...", "baseURL": "https://open.bigmodel.cn/api/anthropic" }
      }
    },
    "model": "bigmodel/GLM-5.3"
  }
  ```

  Note `"model"` must be a `"provider/model"` string. The desktop app keeps its
  own copy under `~/.zcode/v2/config.json`, which the headless CLI does **not**
  read — hence this file.

## Caveats

- `send` spends tokens on the target agent and permanently appends to that session's history.
- Sending to a session that is currently busy in its own UI may preempt the active turn.
- **Codex single-writer lock**: a codex session that is currently open in a Codex
  TUI/desktop holds its thread lock, and headless injection into it is refused by
  codex itself (`thread-store conflict`). Deliver in that TUI directly, or close
  the conversation first; `read` is unaffected. Sessions nobody has open send fine.
- **ZCode headless config is fragile across app updates**: headless runs need the
  provider config the bundled CLI resolves relative to its own directory — the
  desktop app has moved it between releases (e.g. `resources\glm\provider\`
  vs `resources\config\provider\`). Our own failure text is
  `headless zcode needs a model provider config at <path> (key "provider" +
  "model")` (and `zcode CLI (zcode.cjs) not found; set AGENTRELAY_ZCODE_CLI to
  its full path` when the CLI itself is missing); the bundled CLI can also report
  a missing built-in provider config in its own words. Either way, copy
  `zcode-builtin.json` to the path the error names. Visible CDP delivery does not
  depend on this file.
- Session storage layouts are the agents' local, undocumented formats and may change between versions.
- Prompt payloads always travel via stdin or a directly-spawned process — never through a shell — so arbitrary quotes/newlines in messages are safe.
- **Desktop consent**: any route that presses Enter in the ZCode window needs
  `OPENACOM_DESKTOP_CONSENT=1` in the sender's environment, or consent on that
  one message (`--consent true` on the CLI; `consent: true` on `relay_send`,
  `send_desktop`, and `send_message` with `inject:true` + `desktop:true`).
  Nothing submits into your desktop without one of the two — expect
  `CONSENT_REQUIRED` the first time, and answer it with `--desktop --draft` or a
  deliberate `--consent true`.
- **The MCP default stores, it does not inject**: a `send_message` call without
  `inject:true` only writes a row into the local inbox, so a target that never
  polls `inbox` never sees it — nothing is pushed and nobody is woken. Live input
  is opt-in: `inject:true`, `send_desktop`, or the CLI `send`.
- **Secrets on disk**: `openacom web` prints its dashboard token to stderr once,
  when it creates `~/.openacom/openacom-web.token`. Do **not** archive that
  stderr into a log file; pin `AGENTRELAY_WEB_TOKEN` in a private place instead.
- **MCP call log**: every tool call is appended to `~/.openacom/logs/mcp-calls.log`
  (moved by `AGENTRELAY_HOME`; dir `0700`, file `0600`, rotated to
  `mcp-calls.log.1` past 1 MiB). Message
  bodies are never stored there — `text`, `message` and `query` are reduced to
  `len=<bytes> sha256:<first 12 hex>` — but every other argument (session ids,
  target names, node ids) is recorded verbatim, so the log still reveals who
  talked to whom.
- **Store permissions**: on POSIX a group/world-readable `targets.json` stops the
  node from starting, and anything `icacls`/`chmod` could not tighten is reported
  as `acl:'inherited'` rather than failing quietly. A Windows named pipe cannot be
  tightened by path at all, so managed terminals there rest on their per-terminal
  secret alone.
- **Upgrade hub and node together**: mixed versions get 403s on poll and
  unparseable `deferred` acks.
- An `uncertain` distributed message is **never** replayed automatically; that is
  the whole point of the status. Check the destination screen before sending again.

<a id="chinese"></a>

## 中文说明

**开源、分布式、安全的 agent 通信。**

**OpenAcom**：一个 MCP/CLI 命令，跨桌面端与 CLI、跨本地与远程机器，统一管理 **Claude Code / Codex / ZCode / OpenCode** 的 agent 会话。

- `openacom list [关键词...]` — 四家 session 混合列表 + **模糊搜索**（匹配 agent/ID/标题/工作区，多词 AND），默认 top 30，`--limit N` 覆盖
- `openacom read <sessionId>` — 读取任意 session 的最近对话（自动跨四家匹配 id）
- `openacom send <消息>` / `send <sessionId> <消息>` — 注入**真实用户回合**。默认异步
  （发完即返回，回复落在会话转录里，用 `read` 查看）；加 `--wait` 则阻塞等回复并打印。
  **zcode 续会话默认可见投递**，会按回车，因此需要 `--consent true`（或进程环境
  `OPENACOM_DESKTOP_CONSENT=1`）；`--desktop --draft` 只填草稿不回车，`--no-desktop`
  走无头。**opencode 例外**：直接 steer 目标会话原地执行（永不 `--fork`），CLI 默认阻塞并实时
  流式打印（头部、工具进度、回复），`--no-wait` 才走后台；`--json` 时实时流走 stderr，
  stdout 只留干净的最终回复
- `openacom oc-serve [目录] [--port N]` — 预热项目目录的**共享 opencode
  server**（确定性端口 = 目录哈希，44000-44996），并打印可直接粘贴的 attach
  命令。平时不需要手动跑：`send` 发往 opencode 会话时会自动起服、自动复用，
  首次起服时 CLI 只提示一次 attach 行；起不了服则自动回退 `opencode run`
  路径，投递永远可用（`AGENTRELAY_OPENCODE_NOSERVE=1` 可彻底关掉自动起服）
- `openacom oc-attach [目录] [--port N]` — 一步打开该项目共享 server 的实时
  TUI；server 未启动时会自动启动，不需要查端口或复制 URL
- `openacom paths` — 显示探测到的存储路径与 CLI（含 `logDirAcl` / `inboxAcl`：这两个
  目录收紧成功是 `private`，`icacls`/`chmod` 没能收住时是 `inherited`）
- `openacom web [--port N]` — 本地收件箱面板（默认 `127.0.0.1:9339`）。**现在需要
  token**：首次启动自动生成 `~/.openacom/openacom-web.token`（`0600`）并把明文
  token 打到 stderr 一次；不想让它进日志就用 `AGENTRELAY_WEB_TOKEN` 固定。所有
  `/api/*` 都要带 `X-OpenAcom-Token`，且 `Host` 必须是 `127.0.0.1:<port>` 或
  `localhost:<port>`（防 DNS 重绑定，`[::1]` 会被拒）。页面自己内嵌 token，
  所以照旧一条命令就能用
- `openacom inbox [--status S] [--limit N] [--json]` — 查看带已读回执的发送记录
  （`sent` 待回执 / `read` 已读 / `failed` 三次未回执判死）
- `openacom ack <messageId>` — 手动把一条追踪消息标记为已读
- **已读回执模式**：`send ... --require-read`（或 MCP `send_message` 的
  `requireRead: true`，它是 inject 专属选项，要配 `inject:true`）——消息尾附带回执单（唯一 id），对方处理后调 `ack_message`
  工具、或在**发送之后新起的** assistant 回合里包含 `ACK-<id>` 即算已读；回执判定
  按发送前的基线计数做增量，所以复述历史页脚、引用旧转录都不再能伪造已读（发送前
  读不到转录时，那一轮干脆不信任转录回执）。超时未回执（默认 90s，`--ack-timeout`
  可调）自动重发，**最多 3 次**，仍无回执则判 `failed` 并如实上报——不再给发送方
  假 OK。记录落在本地收件箱 `~/.openacom/inbox.sqlite`。注意：该模式会阻塞等待
  回执（最坏 ~3×超时），调用方 MCP 超时要留够；stdio 上 `from` 地址无法认证，
  而且"已读"本质上是被接收方自报的——目标只要新起一个含该 token 的回合就算已读
- `openacom mcp` — 以 stdio MCP server 运行：本地 8 工具 + 分布式 3 工具，共 **11 个**
  （逐个说明见下面「MCP 工具一览」）；接入 Claude Code、Claude Desktop、Codex、ZCode 等
  MCP 客户端，配置示例见上方英文段。分布式三件套 `relay_nodes` / `relay_send` /
  `relay_status` 也一直在工具列表里，它们用进程环境的 `AGENTRELAY_URL` +
  `AGENTRELAY_TOKEN` 访问 Hub，没配就调用即失败（见「分布式通信」章节）
- Claude 的 SSH 远程会话：`list`/`read` 以 `ssh:` 前缀标识（子代理转录不会列为 session）；
  `send` 支持远程会话——自动从 `~/.claude.json` 解析主机，在远程主机上找到活运行进程
  （`--resume=<id>`），以 stream-json 用户回合注入其 stdin，回复实时流回桌面应用。
  若目标会话当前未运行，先在桌面应用里启动一次

**MCP 工具一览**（`openacom mcp` 暴露 11 个：本地 8 + 分布式 3）：

| 工具 | 作用 |
|---|---|
| `list_sessions` | 四家 agent 的会话混合表 + 模糊搜索 |
| `read_session` | 读某个会话最近几轮（`sessionId`，可选 `agent`、`last`） |
| `send_message` | **默认先入箱，再尝试所选路线投递一次**；route:mailbox 显式仅入箱 |
| `send_desktop` | 唯一以"在那个窗口里按回车"为目的的动词：永远 submit、绝不降级、每次调用都要 consent |
| `post_message` | 同一个邮箱，但由你自报 `from` 并可带稳定 `id` 做幂等重试；完全不含注入语义 |
| `inbox` | 列出追踪消息与邮箱行及其状态；可按 `to` / `from` / `status` 过滤 |
| `ack_message` | 结回执单：一条 `--require-read` 的发送，或一条邮箱行 |
| `get_paths` | 探测到的存储与 CLI 路径，含本进程两棵树的 acl、groups 注册表位置，以及本 MCP 被认成的身份 |
| `relay_nodes` | 已注册节点、其安全计数与存储 acl（Hub） |
| `relay_send` | 把消息排到另一台机器上的具名目标（Hub） |
| `relay_status` | 读一条分布式消息的耐久回执（Hub） |

**默认先入箱，再尝试投递。** send_message({to,message}) 先保存消息，再走一条路线。route 可选 auto（默认）、session、desktopcdp、desktop、relay、mailbox。auto 对 zcode 默认使用纯桌面 CDP，对其他本机地址使用会话适配器，对 node:nodeId/target 使用 relay。desktopcdp 不回退 UIA 或无头 CLI；zcode 需开启调试端口（默认本机 9222），桌面提交沿用现有 consent 设置。desktop 显式提交到 zcode 桌面，需要 consent。没有可用会话通道时明确返回 refused，消息仍留在 inbox。失败或不确定时不自动换路、不重试。

结果包含 id/messageId、from、to、route、status 和可选 code/detail。状态为 stored、queued、accepted、refused、uncertain，均不代表模型已读或任务完成。通过 inbox 查询保留的消息，ack_message 显式确认已读。同一稳定 id 重复调用只返回原结果，不再次投递；更换内容或路线返回 ID_CONFLICT。核实前次结果后，如需再次尝试需显式使用新 id。组权限在保存和投递前检查。

route:mailbox、旧 inject:false 和 post_message 是显式仅入箱；旧 inject:true 保留原直接注入行为及其回执模式，不要与 route 混用。新路线不因缺少已读回执自动重发。CLI 使用 openacom deliver，SDK 使用 openacom/routing 的 sendRouted；独立 embedded 接口保持原样。

**`send_desktop`——那个会按回车的动词。** 它是 MCP 里唯一以"往桌面窗口注入并提交"为目的的入口，
因此也是唯一会打扰你正在打字的窗口的入口，并被刻意收窄：只支持 zcode 目标（否则
`DESKTOP_UNSUPPORTED`）、**永远 submit**（这里没有草稿模式）、**绝不降级**（不会退回无头，也不会
悄悄改回邮箱）。它唯一的换路是"调试端口根本没人在听"时改走旧的 UIA 传输，那条路同样会按回车；
端口应答但身份不像 ZCode 则是硬拒。每次调用都要各自的授权：`consent:true`，或本 MCP 进程环境里
`OPENACOM_DESKTOP_CONSENT=1`，否则 `CONSENT_REQUIRED` 且 `uncertain:false`——一个字都没进窗口。
`from` / `to` / `message` 必填，`timeoutMs` 默认 60 秒，组闸门与 CDP 身份核验一视同仁。它在输入
落地后返回（`status:"desktop-submitted"`、`delivery:"desktop"`），回合随后在应用内跑，用
`read_session` 看结果。不需要实时窗口时，请改用 `send_message` 的缺省路径或 `post_message`。

安装：`npm install -g github:Bring-AI/OpenAcom`（需 Node ≥ 22.13；22.5–22.12 需加
`--experimental-sqlite`）。`Bring-AI/OpenAcom` 当前是 **private** 仓库：从 GitHub 安装需要
对该仓库有访问权（先配置好 GitHub 凭据）；包名 `openacom` 尚未发布到 npm。

仓库里还有两个"派生件"，都不是运行期依赖：`node tools/gen-docs.js` 从本文件与源码树重新生成静态
文档站到 `docs/index.html`（英文）与 `docs/zh/index.html`（中文）——改了 README 或代码后要重跑，
页面是抽取出来的、不是手抄的；`desktop/` 是一个面向回环 Hub 的单文件 WinForms 客户端，用 Windows
自带的 C# 编译器经 `desktop/build.cmd` 编成 `desktop/openacom-desktop.exe`（它只显示所发 token 的
SHA-256 前缀指纹，不显示也不落盘 token 本身）。

**发送的前提**：claude 需要 `claude` CLI 在 PATH 且 API 可达；codex 需要 `codex` CLI 已认证；
zcode 自动探测桌面版自带的 `zcode.cjs`（可用 `AGENTRELAY_ZCODE_CLI` 指定），且
`~/.zcode/cli/config.json` 里要有 provider/model 配置（`model` 必须是 `"provider/model"` 字符串，
桌面端的 `~/.zcode/v2/config.json` 对无头 CLI 不生效），示例见上方。

**注意**：`send` 会消耗目标 agent 的模型额度并永久写入其 session 历史；给正在忙碌的
session 发送可能抢占当前轮次；session 存储格式是四家 agent 的本地私有格式，随版本可能变化。
**codex 单写入者锁**：正开在 Codex TUI/桌面里的会话持有线程锁，codex 自身会拒绝无头
注入（`thread-store conflict`）——请在那个 TUI 里直接发言，或先关闭该会话；`read` 不受影响。
**zcode 无头配置随桌面更新易失效**：无头运行依赖内置 CLI 按自身目录解析的 provider
配置文件，桌面版更新曾移动过该文件位置（`resources\glm\provider\` ↔
`resources\config\provider\`）。本仓库自己抛的是
`headless zcode needs a model provider config at <path> (key "provider" + "model")`
（找不到 CLI 时是 `zcode CLI (zcode.cjs) not found; set AGENTRELAY_ZCODE_CLI to its full path`）；
内置 CLI 也可能报它自己的「无法定位 … Built-in Provider Config」字样（那句话来自 ZCode，
不在本仓库代码里）。无论哪一条，把 `zcode-builtin.json` 复制到报错指出的路径即可；
CDP 可见投递不依赖此文件。

**fresh 会话模式（默认的 agent 间通信）**：`openacom send <消息>`（不带 sessionId
即走此模式；`--fresh` 为显式形式）在一个
**全新** zcode 会话里执行消息（无头、同步拿回复、返回 sessionId）。新会话会自动出现在
桌面应用的任务列表里，点开即可读完整记录——agent 流量对桌面始终可见，且完全不碰
用户开着的会话（桌面不会重渲染已打开会话的外部写入）。需要多轮往来时，用普通
`send <id>` 续聊这个新会话即可——它没有被任何桌面标签页持有，不存在失效问题。

<a id="distributed-guide"></a>

## 分布式通信：真实 TUI 输入，而不是后台续跑

新增的 `relay` 命令与旧的 `send` 独立：旧 `send` 的 Claude/Codex
后台 resume **不保证当前 TUI 可见**；需要可见输入请使用下面的终端托管方式。

架构：发送端 → 带鉴权的 Hub / SQLite 消息队列 ← 各机器主动轮询的 Node
→ 本机白名单目标。机器之间不需要互相开放端口；只需要能通过 SSH 转发访问
同一个 Hub。没有任何可互通路径时，仍需要一台可达的 SSH 跳板机或组网服务。

### 1. 启动 Hub

```powershell
npm install
# 生成一次；通过可信渠道把同一个 token 配置到各参与机器，不要提交到 Git。
node bin/openacom.js relay token
$env:AGENTRELAY_TOKEN = '<上一步生成的 token>'
node bin/openacom.js relay hub --port 9330
```

Hub 默认仅监听 `127.0.0.1`。客户端配置 `AGENTRELAY_URL`，默认
`http://127.0.0.1:9330`；token 从环境读取，不需要出现在命令参数中。
Unix shell 使用 `export AGENTRELAY_TOKEN='...'`。
可选：启动 Hub 时再设 `AGENTRELAY_ALLOWED_NODES=laptop-a,laptop-b` 把节点注册限制在已知
id 上，并用 `AGENTRELAY_QUEUE_TTL_MS` / `AGENTRELAY_NODE_QUEUE_LIMIT` /
`AGENTRELAY_HISTORY_RETENTION_MS` 调整队列边界（见第 6 节）。

如果 Hub 在可 SSH 登录的跳板机上，每台内网机器建立本地转发：

```sh
ssh -NT -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -L 127.0.0.1:9330:127.0.0.1:9330 user@jump-host
```

如果 Hub 本身在内网 A，A 先把 Hub 反向映射到跳板机：

```sh
# A：跳板机 19330 -> A 的 9330
ssh -NT -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -R 127.0.0.1:19330:127.0.0.1:9330 user@jump-host
# B/C：本机 9330 -> 跳板机 19330 -> A
ssh -NT -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -L 127.0.0.1:9330:127.0.0.1:19330 user@jump-host
```

这些是长运行连接，请用系统服务或自己的 SSH supervisor 保活。Node 会在网络
恢复后继续轮询，但不会替你配置 SSH 认证或重启 SSH。无需启用 `GatewayPorts`，
不要把转发监听改成 `0.0.0.0`。

### 2. 托管需要接收消息的真实终端

```sh
node bin/openacom.js terminal --name coder -- codex
node bin/openacom.js terminal --name reviewer -- claude
node bin/openacom.js terminal --name builder -- opencode
```

`--` 后是本机可执行程序及参数，不是远端下发的 shell 命令。Windows 的 npm
启动器如果只有 `.cmd`，显式启动本机 shell，例如：

```powershell
node bin/openacom.js terminal --name reviewer -- cmd.exe /d /s /c claude
```

包装器使用 `node-pty`（Windows ConPTY / Unix PTY），原样转发终端显示、键盘、
窗口大小。远端消息通过真实 bracketed paste 输入，`submit` 再单独发送 Enter，
`draft` 仅填入输入框。消息中的控制字符会被拒绝；目标必须启用 bracketed paste，
否则拒绝注入。不能把任意已经打开的非托管终端自动接管。

**输入控制默认锁定：**

- 先在真实 TUI 中确认焦点是空的对话输入框，按 `Ctrl-]` 后按 `c` 确认。
- `Ctrl-]` 后按 `a`：允许下一条远端消息。
- `Ctrl-]` 后按大写 `A`：明确授权连续远端消息，适合 Agent 间往返通信。
- `Ctrl-]` 后按 `l`：锁定。普通本地键盘输入会撤销远端授权。
- `draft` 后锁定，避免后续消息覆盖或误提交草稿；清空/处理草稿后重新确认并授权。

这里没有通用的“模型忙碌/输入框焦点识别”：连续模式中消息可能被不同 TUI 当作
steer 或排队输入。授权前确认 TUI 状态，不要在密码框、权限确认框或 shell 上授权。
包装器证明的是输入已写入 PTY，不是模型已接受或完成请求。

### 3. 配置本机目标并启动 Node

包装器在 stderr 打印 descriptor 路径，默认
`~/.openacom/terminals/coder.json`。把该 JSON 对象放到本机 `targets.json`
的目标名下；例如：

```json
{
  "coder": {
    "type": "terminal",
    "socket": "<descriptor 中的 socket>",
    "secret": "<descriptor 中的 secret>",
    "acl": "<descriptor 中的 acl>"
  },
  "desktop": {
    "type": "zcode",
    "sessionId": "<本机 ZCode 会话 ID>"
  }
}
```

`type: "zcode"` 的目标只接受 `sessionId` / `cdpPort` / `cdpTargetId` 三个可选项，多写的字段
（包括 `identity`）会被 `INVALID_TARGET` 拒掉——身份覆写目前只能由程序内直接调用严格投递
时传入（见第 9 节）。

descriptor 含本机注入凭证，勿公开；它现在多一个 `acl` 字段（`private` / `inherited`，
见第 8 节）。终端重启后重新复制 descriptor，并重启
Node 加载配置。每台机器使用不同的 Node ID 和自己的数据目录：
异常退出可能留下 descriptor：必须先确认旧包装器已经停止，才能删除该文件并重新
启动；工具不会覆盖可能属于活跃终端的凭证。`targets.json` 装着这些 secret，POSIX 上如果
group/world 可读，Node 会**拒绝启动**（Windows 只告警，见第 8 节）。

```powershell
$env:AGENTRELAY_TOKEN = '<同一个 token>'
node bin/openacom.js relay node --id laptop-b --targets .\targets.json
```

ZCode 桌面目标走单次、严格的桌面投递，要求 Windows 与已开启的本机 CDP 调试端口。
`mode` **缺省为 `draft`**：文本只落到真实输入框，不回车。`submit` 需要显式授权——该条
消息带 `consent: true`（`relay send … --consent true`，或 MCP `relay_send` 的 `consent`
参数；本地 `openacom send` 用的是同名旗标 `--consent true`），或持有
桌面的那个 Node 进程环境里设 `OPENACOM_DESKTOP_CONSENT=1`（兼容
`AGENTRELAY_DESKTOP_CONSENT=1`）。两者都没有时直接拒绝（`CONSENT_REQUIRED`，且
`uncertain:false`——目标界面从未被碰到）。
找不到唯一会话行，或该会话已经有未清空的草稿时同样拒绝（`DESKTOP_TARGET`；随后确认"空白且
唯一"的输入框失败是 `INPUT_LOCKED`，见第 5 节），不降级为后台运行——未清空的草稿会一直挡住
同一会话的后续投递，直到人工处理，这是 in-the-loop 的有意取舍。
投递前还要过 CDP 身份核验（见第 9 节）；CDP 属于高权限接口，只能绑定本机或受保护的隧道。
要求当前 ZCode v4 的精确 session-id DOM 标记；旧版或变更后的 UI 将拒绝投递。
桌面目标可配置 `cdpPort`（默认 9222）和 `cdpTargetId`；多个 CDP 页面存在时必须
明确指定页面 ID（从本机 `http://127.0.0.1:9222/json` 查看）。

### 4. 发消息、查状态、让 Agent 回信

```sh
node bin/openacom.js relay nodes
node bin/openacom.js relay send laptop-b coder "请检查接口，并把结论发回 laptop-a 的 planner"
node bin/openacom.js relay send laptop-b coder "这是一条待确认草稿" --mode draft
# 省略 --mode：规则上由目标类型决定（桌面 draft、终端 submit）。截至 0.11.0 这一版
# Hub 仍会在入队时把它补成 submit（见上文 relay_send 说明），所以下面两行桌面示例
# 分别把两种结果写清楚，不要靠缺省猜。
node bin/openacom.js relay send laptop-b desktop "当前缺省即 submit，需要授权" --consent true
node bin/openacom.js relay send laptop-b desktop "只要草稿，不回车" --mode draft
node bin/openacom.js relay status <返回的消息ID>
```

`--id <UUID>` 提供幂等提交：同 ID、同内容返回原消息，不重复排队；
同 ID、不同内容报冲突。发送端超时后应使用原 ID 重试，不能随意生成新 ID。

在现有 stdio MCP 配置的进程环境中设置 `AGENTRELAY_URL` / `AGENTRELAY_TOKEN`，
即可使用新增的 `relay_nodes`、`relay_send`、`relay_status`。例如 Claude Desktop：

```json
{ "mcpServers": { "openacom": {
    "command": "node",
    "args": ["C:\\path\\to\\openacom\\bin\\openacom.js", "mcp"],
    "env": { "AGENTRELAY_URL": "http://127.0.0.1:9330", "AGENTRELAY_TOKEN": "<同一个 token>" }
} } }
```

不配置这两个环境变量也不影响本地的 `send_message` / `list_sessions` /
`read_session`——这些本地工具从不经过 Hub；只有 `relay_*` 三件套需要。
`relay_send` 参数为 `{to, target, text, mode?, id?, consent?}`。**`mode` 缺省的语义是"由目标
类型决定"**：桌面目标 `draft`（只填 composer，不回车），终端与其他目标 `submit`；显式
`submit` 才需要 consent。这条判定在**节点侧**做（`lib/delivery.js` 的 `effectiveMode`），
前提是链路上没有人替你补掉 `mode`：MCP 的 `relay_send` 在你省略时就不再发这个字段，但
**截至 0.11.0，Hub 入队仍会把省略的 `mode` 补成 `submit`**（`lib/distributed.js` 的
`messageInput`），CLI `relay send` 同样补 `submit`——这两处的补齐在本轮派工中，改完之后
"省略 = 桌面 draft" 才对远程路线成立；在那之前省略 `mode` 的远程投递实际仍是 submit，
仍然要过授权闸门。双方 Agent 均配置该 MCP，
就能互相发送；回信是显式发送到对方机器/目标的另一条消息，不自动抓取终端输出、
不把工具日志误当最终答案，也不会自动触发无限回信。

**投递不变式：至多一次 + 诚实状态，绝不宣称 exactly-once。**
节点在触碰任何 UI 之前先把耐久回执落库，所以崩溃可能**丢掉**一条消息，但绝不会把同一个
UI 副作用再跑一遍。状态全集：

- `queued`：Hub 已持久保存，离线目标恢复后可领取。
- `delivering`：已被领取，正在尝试 UI 输入。
- `deferred`：已**证明**目标没被碰到（例如输入锁尚未解锁），可以安全重投；预算
  `MAX_DEFERRALS` = 6 次，退避 5s→10s→…，上限 300s。
- `uncertain`：无法证明是否已输入。**永不自动重投**；先看目标界面，再人工决定。
- `delivered`：输入到达 UI（`result.outcome` 是 `input-submitted` 或 `input-drafted`），
  **不代表模型已经回答**。
- `failed`：投递失败，看错误码与本机授权状态。
- `expired`：TTL 内从未被派发（消息里 `error.code` 为 `QUEUE_EXPIRED`），目标从未被碰到。

`retryable` 只在未终态的 `queued` / `delivering` / `deferred` 上为真；`delivered` /
`failed` / `expired` 是终态，`uncertain` 明确不属于可重试。

不确定是**粘性**的：`everUncertain` 一旦置位就永久保留（跨 Hub 重启存活），即使后来被属主
节点澄清为 `delivered` / `failed` 也不会清除，只是把 `settlement` 记成
`resolved-by-node`（证据窗口内）或 `resolved-by-node-late`（窗口之后）。Hub 重启、120s
租约过期、节点会话变更只会**打开**不确定（`settlement` = `awaiting-node-evidence`）；
证据窗口（默认 30 分钟，且该节点至少再轮询 2 次）用尽后 Hub 依然**不改状态**，只把
`settlement` 记成 `no-evidence-budget-exhausted`——关闭不确定只能靠那个节点自己的耐久
回执，Hub 拒绝替用户猜。

**其他安全边界：**

- Hub 队列与本机收据都持久化；外部 UI 操作无法和数据库事务原子提交，因此不承诺
  exactly-once。对不确定的输入宁可要求人工核实，也不自动重复提交。
- 必须一起备份 Hub 数据库和 Node 收据数据库；只恢复其中之一无法保证历史对账。
- 远端不能指定任意进程、shell、socket；目的地只能是 Node 本地配置的目标名称。
- 目前不提供通用桌面注入：严格桌面适配只针对 ZCode；其他桌面程序需要各自适配器。
- 敏感提示词会落盘（Hub 队列、Node 收据、MCP 调用日志——日志里的消息正文已做脱敏，
  规则见第 8 节末尾的「落盘的内容」）。

### 5. 桌面投递的授权闸门

同一个动作在各入口的缺省并不一样，**不要合并理解**：

| 入口 | 桌面目标缺省 `mode` | 想要 `submit` 需要什么 |
|---|---|---|
| Node 的本地投递（`deliver`，即 `targets.json` 里 `type:"zcode"` 的目标） | `draft` | 该条消息 `consent:true`，或本进程 `OPENACOM_DESKTOP_CONSENT=1` |
| 远程 relay（`relay_send` / `relay send`，省略 `mode`） | 规则是"目标类型决定"（桌面 `draft`），但 0.11.0 的 Hub 入队会把它补成 `submit` | 同上：消息带 `consent:true`，或节点进程环境里设该变量 |
| 传统适配器路径：CLI `openacom send <zcodeId> …`（默认可见路线） | `submit`（该传输本身不支持草稿） | 该条消息 `--consent true`，或本进程 `OPENACOM_DESKTOP_CONSENT=1` |
| 传统适配器路径：MCP `send_desktop`，或 `send_message` 的 `inject:true` + `desktop:true` | `submit`（该传输本身不支持草稿） | 该次调用 `consent:true`，或本 MCP 进程 `OPENACOM_DESKTOP_CONSENT=1` |
| MCP `send_message` 缺省（不带 `inject`） | **根本不碰桌面**：只把消息写进目标收件箱 | 不需要授权——没有 UI 副作用 |
| CLI 显式草稿：`openacom send <zcodeId> … --desktop --draft` | `draft`（改走严格发送器） | 不需要授权：它不按回车 |

- 请求 `submit` 之外的模式而落到"只会 submit"的传输上会直接 `INVALID_MODE`，不会被悄悄改成
  回车；`--draft` 因此必须搭配 `--desktop`（它走的是 `desktopStrict` 那条实现）。
- `consent` 必须是**字面 boolean**，`"true"` / `1` 之类都会在派发前被 `INVALID_CONSENT` 拒掉
  （CLI 的 `--consent` 只认 `true` / `false` 两个字面量，其他值在解析阶段就退出）；
  宽松转换等于替用户按下回车。
- 环境变量必须**恰好**是 `1`，空值或笔误不算授权。
- 未获授权时返回 `CONSENT_REQUIRED` 且 `uncertain:false`：文本从未进入桌面，可以安全地改
  成 `draft` 再来一次。在终端里 CLI 会把这两条出路直接印出来（`--desktop --draft` 与
  `--consent true`）。`CONSENT_REQUIRED` 也刻意**不算**可顺延（deferred），不会白烧重投预算。
- 已经填了内容但没提交的桌面草稿会挡住同一会话的后续投递（选中阶段是 `DESKTOP_TARGET`，
  随后若无法确认"空白且唯一"的输入框则是 `INPUT_LOCKED`，两次投递撞在一起是 `INPUT_BUSY`），
  需要人工清空——宁挡不误。
- 严格桌面路径只绑定已实测到的 ZCode v4 DOM 标记（`v4-composer-input`、带精确
  `data-session-id` 的 `v4-session-pane-`），绑不上就拒投而不是按标题猜；UI 改版后这道
  绑定会和第 9 节的身份默认值一起失效。
- 节点启动时会在 stderr 打印一行它所处的那一侧（`desktop targets refuse submit unless
  the message carries consent:true` 或 `desktop targets accept submit because this
  process environment grants consent`），并打印收据库的 `acl=`；同样会打印含路径的语句，
  归档时按第 8 节的凭据条目对待。

### 6. 队列边界

| 环变量 | 默认值 | 作用 |
|---|---|---|
| `AGENTRELAY_QUEUE_TTL_MS` | `86400000`（24 小时） | 从未派发的消息超期转 `expired` |
| `AGENTRELAY_NODE_QUEUE_LIMIT` | `128` | 每节点在队深度；超限 429 `QUEUE_FULL`，响应带 `error.retryAfterMs` |
| `AGENTRELAY_HISTORY_RETENTION_MS` | `604800000`（7 天） | 终态消息与告警的保留期，Hub / Node 共用这一个名字 |

- 深度统计包含 `queued` / `delivering` / `deferred` / `uncertain`，所以一条卡住的
  `uncertain` 会占住名额直到节点回执澄清或保留期清掉；同 id 的幂等重放不受配额阻挡。
- 这三个值必须是正数（limit 还必须是整数），否则启动即报错——不做静默截断或收敛。
- **Hub 不挂后台定时器**：超期与租约判定跑在每个请求路径上，历史清理按 60s 节流顺带执行；
  要立即回收就调 `POST /queue/prune`（admin 凭据），返回 `{ok,expired,deleted,alerts}`。
  派发中的消息**不会**被 TTL 干掉——它们由租约路径转成 `uncertain`，因为 `expired` 声称
  "目标从未被碰到"，不能拿来描述一条可能已经回车输入的消息。

### 7. 凭据边界：bootstrap 与 per-node 凭据

`AGENTRELAY_TOKEN`（32 字符以上）现在是 **bootstrap 凭据**：可以入队消息、可以注册一个新的
node id、可以读状态；**不能** poll、ack、`GET /security`、`POST /queue/prune`、
`POST /messages/:id/retry`（403
`NODE_CREDENTIAL_REQUIRED` / `ADMIN_CREDENTIAL_REQUIRED`）。节点首次注册
（`POST /nodes/:id/heartbeat`）时 Hub 下发 `nodeToken`：43 字符 base64url，明文只出现这一次，Hub
只存 `Bearer <token>` 的 SHA-256 摘要并在比对时用定长时序安全比较。此后 poll/ack 必须用它，
而且只能动自己那条队列（否则 403 `NODE_FORBIDDEN`，并记一条 `CREDENTIAL_MISMATCH_ACK`
告警）。节点把 `nodeToken` 存进自己的收据库（默认
`~/.openacom/node-<sha256hex(nodeId)>.sqlite` 的 `settings` 表；`--data` 改目录），因此
注册成功之后第二次启动不再需要共享 bootstrap。

抢占会被拒：租约（120s）还活着时，用不同 instance/session 心跳同一个 node id → 403
`NODE_TAKEOVER`，原实例保持权威；只有空闲超过租约后改绑才会签发新凭据，并在响应里带
`credentialRotated:true`，旧持有者立即失效。可审计入口：`GET /security`（admin，最近 200
条告警，kind ∈ `ADMIN_HEARTBEAT_FOR_REGISTERED_NODE` / `FOREIGN_CREDENTIAL_HEARTBEAT` /
`NODE_TAKEOVER_BLOCKED` / `CREDENTIAL_ROTATED` / `MULTI_SOURCE_HEARTBEAT` /
`CREDENTIAL_MISMATCH_ACK`，同类每 60s 最多一条），以及 `GET /nodes`——每个节点带
`security[kind].count/lastAt` 与 `credential.fingerprint/issuedAt`。这两个 admin 路由
**没有 CLI 子命令**，需要自己带 bootstrap 调用。

**残余风险（务必知道）**：共享 bootstrap 凭据仍然可以注册**新的** node id 并领取它自己的
队列——bootstrap 不区分"哪台机器"。唯一实际收紧手段是启动 Hub 时设
`AGENTRELAY_ALLOWED_NODES`（逗号分隔）：不在名单里的 node id 注册会被拒（403
`NODE_NOT_ALLOWED`），**名单为空等于放开注册**。另外 `to` 必须是已注册节点或列在该名单里
的名字，否则 403 `UNKNOWN_NODE`（列在名单里但尚未上线的节点允许被寻址，消息会在队列里等）。

### 8. 权限收紧与文件边界

`lib/secure-fs.js` 是唯一真正实现收紧的地方，不再是"调一下 chmod 就当作成功"：非 Windows
上 `chmod 700`（目录）/ `600`（文件）之后再 stat 复核 mode 位；Windows 上执行
`icacls <path> /inheritance:r /grant:r "<principal>:F"`（目录用 `(OI)(CI)F`），参数以数组
直接传给进程、不进 shell。某个服务账户必须保留访问权时，用 `OPENACOM_ACL_PRINCIPAL`
（兼容 `AGENTRELAY_ACL_PRINCIPAL`）指名主体。收紧失败**不抛异常**，而是返回
`acl:'inherited'` 并往 stderr 写一行，因为这个不该拦住投递：

- 终端 descriptor JSON 多了 `acl` 字段（`private` / `inherited`）；指向 `inherited`
  descriptor 的目标在投递前会先告警一次。
- `GET /nodes` 多了 `store` 字段，形如 `{acl, paths:[{path,acl,platform,principal,error?}]}`。
- Hub / Node 启动各向 stderr 打一行 `... acl=<值>`（非 `private` 时附带提示）。
- `get_paths` 回报 `logDirAcl` 与 `inboxAcl`。

POSIX 上 `targets.json` 若 group/world 可读，Node **直接拒绝启动**（里面是 IPC secret）；
Windows 只打警告，因为那边的 ACL 状态无法可靠复核。陈旧的终端 descriptor 既不会静默复用、
也不会自动删除，而是报 `DESCRIPTOR_STALE` / `DESCRIPTOR_ANOMALY` / `DESCRIPTOR_PERMISSION`，
由人确认旧包装器确实停了再处理。这三个码不属于可顺延类，会作为 `failed` 终结。
**局限**：Windows 命名管道没有路径式权限位，`icacls` 也接不了管道路径，所以管道只能靠
per-terminal secret 防护——本机其他用户读得到 descriptor 就等于能注入。

**落盘的内容**：

- 本地数据目录（收件箱、MCP 日志、hooks、面板 token）默认 `~/.openacom`，由
  `AGENTRELAY_HOME` 改；Hub / Node 各自的库用 `--data` 改，两者不共用同一个变量。
- MCP 调用只往 `~/.openacom/logs/mcp-calls.log` 追加（目录 `0700`、文件 `0600`、超过
  1MiB 轮转为 `mcp-calls.log.1`），且 `text` / `message` / `query` 一律写成
  `len=<字节> sha256:<前 12 位>`；其余参数（会话 id、目标名、节点 id）仍按原样记录，
  所以日志依然看得出"谁给谁发过话"。
- `openacom web` 首次启动会把面板 token 打到 stderr 一次：不要把那份 stderr 归档进日志，
  改用 `AGENTRELAY_WEB_TOKEN` 固定。

### 9. CDP 身份核验：fail closed，但不是身份认证

本机 9222 上的 CDP 端点不认证任何人：先抢到端口的进程就能答这些请求。因此桌面投递在任何
文本进入之前做三层形状核验——`GET /json/version` 里 `Browser`/`Product` 必须像 Chromium 系
引擎、`User-Agent` 必须含 `Electron/<数字>`；`GET /json` 里必须**恰好一个**页面的 `url` 符合
ZCode 主窗口形状（`file:` / `chrome-extension:` / 回环 http）；连上 WebSocket 之后再用页面
自己的 `navigator.userAgent` 交叉核一遍。任一层不过即 `CDP_IDENTITY` 并**拒绝投递**，不会
退回去猜。"没人在听"（`DESKTOP_UNAVAILABLE`）和"有人应答但不是 ZCode"（`CDP_IDENTITY`）是
两类不同结果：只有前者允许旧传输改走 UIA，后者是硬拒。

可用 `identity` 入参覆写 `browser` / `userAgent` / `pageUrl` 三项（每项可给 RegExp 或字面
子串；`null` / `false` / 空串关掉那一项），字段名或类型不对是 `INVALID_IDENTITY`。注意这个
入参目前**只能由程序内直接调用 `sendDesktopStrict` 时传入**——`targets.json` 的 zcode 目标
不认 `identity` 字段，节点投递路径也不透传它。

**诚实声明**：这三条默认值**尚未经实机核实**——本轮禁止连接真实 9222，且实测本机没有进程在
监听。所以现在能担保的是"形状不匹配就报错"（fail closed，不会误投），不是"已防住任意本地
进程冒充 ZCode"：这套核验**不构成身份认证**，任何本地进程都可以照抄这些指纹。反过来，如果
ZCode 将来改了 UA 或页面 URL 形状，默认值会把合法目标一起拒掉，那时需要自己传 `identity`。

### 10. 错误码一览

| 错误码 | 出现位置 | 含义 |
|---|---|---|
| `NODE_CREDENTIAL_REQUIRED` | Hub 403 | 拿 bootstrap 去 poll/ack 了，必须用注册时下发的节点凭据 |
| `ADMIN_CREDENTIAL_REQUIRED` | Hub 403 | 该路由要 bootstrap（入队、`GET /nodes`、`GET /security`、prune、retry） |
| `NODE_FORBIDDEN` | Hub 403 | 凭据不属于这个 node id，跨队列取/结消息 |
| `UNKNOWN_NODE` | Hub 403 | `to` 既未注册也不在 `AGENTRELAY_ALLOWED_NODES` |
| `NODE_NOT_ALLOWED` | Hub 403 | 注册请求被 allowlist 拒绝 |
| `NODE_TAKEOVER` | Hub 403 | 租约未过期就有别的实例心跳同一 id |
| `INVALID_CONSENT` | Hub 400 | `consent` 不是字面 boolean |
| `QUEUE_FULL` | Hub 429 | 节点队列深度超限，响应带 `error.retryAfterMs` |
| `QUEUE_EXPIRED` | 消息 `error.code` | TTL 内未被派发（状态 `expired`），目标从未被碰到 |
| `CONSENT_REQUIRED` | 本地投递 | 桌面 submit 未获授权，目标未被触碰（`uncertain:false`） |
| `CDP_IDENTITY` | 本地投递 | 应答调试端口的那个东西不像 ZCode，拒绝注入文本 |
| `INVALID_IDENTITY` | 本地投递 | `identity` 覆写的字段名或类型不合法 |
| `DESCRIPTOR_STALE` | 本地投递 | socket/管道已不存在，没有托管终端在听 |
| `DESCRIPTOR_ANOMALY` | 本地投递 | 那个路径不是 socket，或根本 stat 不了 |
| `DESCRIPTOR_PERMISSION` | 本地投递 | socket 或所在目录允许其他本地用户写入 |
| `INJECT_REQUIRED` | MCP 调用 | 没带 `inject:true` 却传了 inject 专属选项（或 `to:"zcode:new"`）；宁可拒也不回一条邮箱行 |
| `INJECT_UNSUPPORTED` | MCP 调用 | 对没有注入通道的目标（`qoder:` 桥接）要求注入；走缺省路径就会排进邮箱 |
| `DESKTOP_UNSUPPORTED` | MCP 调用 | 桌面 submit 只支持 zcode，被点名的会话没有桌面路线 |
| `GROUP_FORBIDDEN` | MCP 本地闸门 | agent-groups 注册表没把这个会话授予当前身份（`uncertain:false`，在任何副作用之前检查） |
| `ID_CONFLICT` | 本地邮箱 | 已存在的邮箱 id 被配上不同的 `from`/`to`/`text` |
| `ALREADY_SETTLED` | Hub 409 | 重试被拒：节点已报告输入落地 |
| `UNCERTAIN_NOT_RETRYABLE` | Hub 409 | 重试被拒：状态 uncertain 时只有属主节点能结清 |
| `CLAIM_ACTIVE` | Hub 409 | 重试被拒：有节点持有活 claim |
| `RETRY_RACED` | Hub 409 | 应用重试的瞬间行状态变了；重读再决定 |

从 `CONSENT_REQUIRED` 到 `DESCRIPTOR_PERMISSION` 这五条是本地投递错误，经节点回执以 `failed` +
该错误码的形式落进消息记录；`QUEUE_EXPIRED` 由 Hub 的超期扫描写入，不是 HTTP 拒绝；
最后四条 409 全部来自第 12 节的操作员重试端点。

### 11. 升级兼容

Hub 与 Node **必须一起升级到同一版本再重启**：旧 Node 拿 bootstrap 去 poll 会被 403，
旧 Hub 听不懂 `deferred` 回执，旧 Hub 还会把省略的 `mode` 在入队时补成 `submit`（那样"桌面
缺省 draft"在远程路线上就不会生效）。回执比对已做归一化（历史记录里缺 `consent` 等同于
`false`），新增列用 `PRAGMA table_info` + `ALTER TABLE` 原地迁移，不需要重建数据库。

### 12. 操作员重试端点

`POST /messages/:id/retry`（走 admin/bootstrap 凭据；**没有对应的 CLI 子命令**）把一条消息重新
推回队列。它只接受 `RETRYABLE_FROM` 那四个状态：`queued` / `deferred` / `expired` / `failed`；
其余一律 409 并说明原因：`delivered` 是 `ALREADY_SETTLED`（属主节点已报告输入落地）、
`uncertain` 是 `UNCERTAIN_NOT_RETRYABLE`（输入可能已经在窗口里，只有那个节点能结清）、
`delivering` 是 `CLAIM_ACTIVE`（有节点持着活租约）。重试会重置顺延窗口与顺延预算、重开 TTL
时钟、清掉 claim 与上一次的 result/error，并把 `retries` 加一；它**刻意不洗白**的是尝试历史、
粘性的 `everUncertain` 及其 `settlement` 痕迹、以及这条消息记录在案的 `consent`——重试同一个
桌面 submit 不等于第二次、更安静的授权。已终态的行重新入队会再占用节点深度，所以可能回 429
`QUEUE_FULL`；如果行在更新瞬间变了状态，则 409 `RETRY_RACED`，操作员该重读再决定而不是猜。
响应就是公开收据 `{ok, id, status, attempts, deferrals, retries, retryable, terminal,
expiresAt, retryEligible}`：`retryEligible` 只表示这个端点现在肯不肯收这条行，`retryable` 仍是
对发送方承诺的更窄含义（"Hub 可以再次派发它"）。

### 13. 运行与验证范围

运行回归验证：`npm test`。原有本机会话管理命令保持原语义。

验证范围：Windows 上验证了真实 PTY 的中文多行提交、输入锁、草稿保护，以及实际
Codex TUI 的可见草稿注入；Hub 重启恢复、幂等提交、鉴权和崩溃不重放有回归覆盖。
严格桌面 CDP 在隔离浏览器页面验证提交/草稿拒绝，并只读检查了本机 ZCode DOM；
没有向已有 ZCode 会话发送测试消息；第 9 节的三条 CDP 身份默认值尚未做实机核实。
另已在 Linux 上通过回归测试，并通过真实 SSH 反向隧道验证 Windows → Linux
OpenCode 1.18.31 的可见提交与模型回复，以及远端 OpenCode 经 MCP → Windows
OpenCode 的可见草稿回信。macOS 和 Claude TUI 尚未实测。

## 实现原理（重点）

### ZCode 没有官方 session API，发送是怎么做出来的

ZCode 桌面把全部对话存在本地 SQLite（`~/.zcode/cli/db/db.sqlite`，`message`+`part`
表）。读取直接查库；发送逆出了三条路：

- **无头 resume**：桌面自带的 CLI（`zcode.cjs --resume <id> --prompt`）在自己的进程里
  物化会话并执行回合。需要在 `~/.zcode/cli/config.json` 配模型
  （`"model": "provider/model-id"`）；桌面的 `~/.zcode/v2/config.json` 对无头无效。
- **为什么外部写入后桌面窗口不刷新**：桌面是"单写入者"架构——界面渲染的是 app-server
  内存里的状态，数据库只是它的持久化日志而非共享总线。外部插入永远不会被重读（实测：
  外部写的队列表行无人认领；无 TCP/管道控制面；直接插 `session_input` 也被无视）。
  消息其实已送达、agent 也处理了，只是开着的窗口不重绘。
- **CDP 路线（默认路线，也是唯一可见路线）**：桌面以 `--remote-debugging-port=9222`
  启动后，OpenAcom 直接驱动渲染层——侧边栏定位会话行、聚焦输入框、以受信任输入
  插入消息、回车。回合在应用**内部**执行：实时刷新、消息链原生；配合
  `zcodeInteractionBehavior: "guide"`，回合进行中到达的消息直接**抢占引导**运行中的
  agent 而非排队。窗口最小化/后台照常（渲染层事件，不抢 OS 焦点）。这是向"用户正
  开着的会话"投递的唯一途径。CDP 投递失败会**直接报错**，不再静默降级为无头
  （旧行为可能用不同模型跑、甚至在无头损坏时整条消息丢失）；`--no-desktop` /
  `desktop: false` 是显式的无头逃生通道。这条可见路线前面有两道闸门：授权闸门（它会真的
  按回车，需 `OPENACOM_DESKTOP_CONSENT=1` 或该条消息 `consent:true`）和端口身份核验
  （端口必须"看起来像 ZCode"才肯注入），见第 5、9 节；被 `CONSENT_REQUIRED` 拒掉时，
  无头路径同样是可选的逃生通道。

### 远程（SSH）Claude 会话——本地是镜像，大脑在服务器

SSH 工作区的 Claude 会话在本地只有转录镜像；活进程
（`ccd-cli --resume=<id> --input-format stream-json`）跑在服务器上、从 stdin 消费用户
回合。OpenAcom：① 从 `~/.claude.json` 的 `ssh:<host>:<cwd>` 项目键解析主机；
② SSH 上去按 `--resume=<id>` 找活进程；③ 往 `/proc/<pid>/fd/0` 写一行 stream-json
用户回合。回合在活进程内执行，回复实时流回 Claude 桌面，链原生。

### 远程 agent 操控本地 session

stdio MCP 只能被同机客户端拉起，故另提供 HTTP 传输 + SSH 反向隧道
（`tools/relay-remote-up.ps1`）。脚本默认监听本地 `127.0.0.1:9322`（9321 常被
其他桌面应用占用），并把远程机器上不变的 `9321` 映射到本地 `9322`；远端注册
`http://127.0.0.1:9321/mcp` 即获得操作本地 session 的同一组工具，流量不出 SSH 隧道。

**远程 agent 接入（HTTP 传输）**：stdio MCP 只能被同机客户端拉起。跑在服务器上的
agent（如 SSH 里的 Claude Code）改用 HTTP 传输：Windows 上运行
`tools/relay-remote-up.ps1`（启动本地 `127.0.0.1:9322` 的 MCP + SSH 反向隧道
`服务器:9321 → 本地:9322`），再在服务器的 `~/.claude.json` 注册
`{"mcpServers":{"openacom":{"type":"http","url":"http://127.0.0.1:9321/mcp"}}}`。
远程 agent 即获得操作**本地** session 的同一组工具；流量全程走 SSH 隧道，两端只绑
localhost。重启电脑后需重跑 relay-remote-up.ps1。

**desktop 模式（zcode / Windows）**：CLI 的 zcode `send` 默认走桌面可见投递：CDP 驱动
真实输入框（需桌面以 `--remote-debugging-port=9222` 启动；`--desktop` 为显式形式；MCP 侧的对应
入口是 `send_desktop`，或 `send_message` 的 `inject:true` + `desktop:true`）——在侧边栏定位会话
→ 向真实输入框注入受信任输入事件 → 回车发送。回合由桌面应用自己执行——**窗口实时刷新、消息链
原生**；若该会话正在跑回合，消息会以 guide 模式抢占（运行中的 agent 立即看到；需桌面设置
`zcodeInteractionBehavior: "guide"`）。`--no-desktop`（MCP 侧是 `inject:true` +
`desktop:false`）才是显式的无头路径：直接写数据库，桌面窗口不会实时刷新；而 MCP
`send_message` 的缺省路径压根不进这条链路，它只往目标收件箱落一行。

这条传统传输**只有 submit 一种模式**（它没有草稿概念，向它请求 `draft` 是 `INVALID_MODE`，
不会被悄悄当成回车），而 submit 会在你正在用的窗口里按回车，所以它被授权闸门挡住：该条消息
`--consent true`，或发送方进程环境里有 `OPENACOM_DESKTOP_CONSENT=1`（旧名
`AGENTRELAY_DESKTOP_CONSENT=1` 同样有效；必须恰好是 `1`）。MCP 的两个桌面动词
（`send_desktop`、`send_message` 的 `inject:true` + `desktop:true`）各自带 `consent` 入参，缺省
不授权时与 CLI 同一条规则。没有授权时是 `CONSENT_REQUIRED` + `uncertain:false`
——文本从未进过桌面；CLI 在这种情况下会直接印出两条出路（`--desktop --draft` 留草稿给人看，
或 `--consent true` 明确批准回车）。想在桌面里留草稿就必须走严格发送器：`--desktop --draft`。
`targets.json` 里 `type:"zcode"` 的目标缺省又是 `draft`，别把三者混为一谈；差异见
「分布式通信」第 5 节的表。注入前还要过端口身份核验（同一章第 9 节，含"默认值未经实机
核实、不构成身份认证"的诚实声明）。

一次性准备：托盘退出 ZCode 后运行 `tools\start-zcode-cdp.ps1`（以
`--remote-debugging-port=9222` 重启应用；CDP 是本地控制面，只在可信机器上开启；
也可把该参数加进快捷方式 Target 常开）。代价：仅 Windows、需桌面应用以此方式运行、
按标题前缀匹配会话、拿不到回复文本（回合在应用内异步执行）。

MIT licensed.
