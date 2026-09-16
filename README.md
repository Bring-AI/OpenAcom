# AgentRelay

![AgentRelay](banner.png)

**English** · [中文说明](#中文说明)

One MCP/CLI command managing agent sessions across desktops and CLIs on different local/remote machines — **Claude Code**, **Codex**, and **ZCode**.

```
$ agentrelay list
AGENT   SESSION                                    TITLE                                 WORKSPACE       UPDATED
------  -----------------------------------------  ------------------------------------  --------------  --------
zcode   sess_5027cd0f-689f-4576-8509-8a76ac51fa36  Cross-session messaging PoC           C:\…\default    just now
claude  275c102a-8cf7-4720-935d-96b6ddfd0af3       Frontend design review                F:\Bob          1h ago
codex   01a07b4b-bc27-7fd1-89c0-dae8c883bf06       Add topic search to the course page   F:\Saba         5h ago

$ agentrelay send 01a07b4b-bc27-7fd1-89c0-dae8c883bf06 "Research is done, please continue with the next step"
(the target session receives a real user turn; its reply is printed here)
```

`send` delivers a **genuine user turn** to the target session. By default it is
fire-and-forget (the reply lands in the transcript; `--wait` blocks for it), and
for zcode it is CDP-first: when the desktop app runs with
`--remote-debugging-port`, the message enters through the app's real composer
(live refresh, native chain, steer of a running turn), otherwise it runs
headless. This is the building block for cross-agent orchestration: let a ZCode
session drive a Claude session, script hand-offs between agents, or poke a
long-running session from CI.

## Install

Requires Node.js ≥ 22.5 (uses the built-in `node:sqlite`).

```bash
npm install -g github:wwy155/agent-relay
```

or from a clone:

```bash
git clone https://github.com/wwy155/agent-relay
npm install -g ./agent-relay
```

or run in place without installing: `node bin/agentrelay.js …`

## Commands

| Command | What it does |
|---|---|
| `agentrelay list [query...] [--agent zcode\|claude\|codex] [--limit N] [--json]` | Unified session table with **fuzzy search** (agent/id/title/workspace, space-separated AND); top 30 by default, `--limit N` overrides |
| `agentrelay read <sessionId> [--agent A] [--last N] [--json]` | Last turns of any session, system noise filtered |
| `agentrelay send <sessionId> <message...> [--agent A] [--timeout ms] [--json]` | Deliver a real user turn and print the reply |
| `agentrelay paths` | Show detected storage locations and CLI paths |
| `agentrelay mcp` | Run as a stdio MCP server exposing the same operations as tools |

Session ids are matched across all three agents automatically; pass `--agent`
when an id could be ambiguous or to skip the full scan.

## Use as an MCP server

`agentrelay mcp` runs a stdio MCP server exposing four tools — `list_sessions`,
`read_session`, `send_message`, `get_paths` — so any MCP client can drive your
other agents. Wire it in (adjust the path to your install):

Claude Code:

```bash
claude mcp add agentrelay -- node /path/to/agent-relay/bin/agentrelay.js mcp
```

Claude Desktop (`%APPDATA%\Claude\claude_desktop_config.json`):

```json
{ "mcpServers": { "agentrelay": {
    "command": "node",
    "args": ["C:\\path\\to\\agent-relay\\bin\\agentrelay.js", "mcp"]
} } }
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.agentrelay]
command = "node"
args = ['C:\path\to\agent-relay\bin\agentrelay.js', 'mcp']
```

ZCode (`~/.zcode/cli/config.json`):

```json
{ "mcp": { "servers": { "agentrelay": {
    "command": "node",
    "args": ["C:\\path\\to\\agent-relay\\bin\\agentrelay.js", "mcp"]
} } } }
```

`send_message` is fire-and-forget by default (see above); `wait:true` blocks. All caveats apply
below — it appends to the target session's real history and spends its tokens.

### Fresh sessions — recommended for agent-to-agent traffic (zcode)

`agentrelay send --fresh <message>` runs the message in a **brand-new** zcode
session (headless, synchronous reply, `sessionId` returned). New sessions appear
in the desktop app's task list automatically, and opening one loads its full
transcript — so your agent traffic stays visible in the desktop without ever
injecting into a conversation the user has open (which the app would not
re-render anyway: it keeps open sessions in memory and never re-reads the DB).

```
$ agentrelay send "Summarize the API research" --json
{ "ok": true, "sessionId": "sess_...", "reply": "..." }
```

`send` with no sessionId defaults to this; `--fresh` is the explicit form.

Sends are **fire-and-forget by default** (reply lands in the transcript; `--wait`
blocks for it). For zcode, sends are **CDP-first by default**: when the desktop app runs with
`--remote-debugging-port`, messages go through the app's real composer — live
refresh, native chain, steer of a running turn — at the cost of the app
switching to that conversation; when the debug port is absent they fall back to
silent headless automatically. `--no-desktop` (CLI) / `desktop: false` (MCP)
forces silent headless with no view switch. claude/codex sends are always
headless (plus remote-SSH injection for claude remote sessions).

For a continuing back-and-forth, keep resuming that fresh session's id with the
normal `send <id>` — it is a headless session no desktop tab holds, so nothing
can go stale.

### Remote agents (e.g. Claude Code on an SSH server) - HTTP transport

stdio MCP servers can only be spawned by local clients. For agents running on
another machine, AgentRelay also speaks streamable HTTP:

```powershell
# on the Windows machine (one-time per boot):
powershell -ExecutionPolicy Bypass -File tools
elay-remote-up.ps1 -SshHost root@your-server
# starts: local MCP on 127.0.0.1:9321 + an SSH reverse tunnel server:9321 -> local:9321
```

Then on the server, register it in Claude Code (`~/.claude.json`):

```json
{ "mcpServers": { "agentrelay": { "type": "http", "url": "http://127.0.0.1:9321/mcp" } } }
```

The remote agent gets the same four tools operating on your **local** sessions.
Traffic stays inside the SSH tunnel; both endpoints bind localhost only.
## How it works (the interesting parts)

### ZCode provides no session API - how sending was made possible

ZCode desktop keeps every conversation in a local SQLite database
(`~/.zcode/cli/db/db.sqlite`, `message` + `part` tables). AgentRelay reads
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
- **CDP route (default when available)**: start the app with
  `--remote-debugging-port=9222` and AgentRelay drives the renderer directly -
  locate the session row in the sidebar, focus the composer, insert the message
  as trusted input, press Enter. The turn runs *inside* the app: live refresh,
  native message chain, and with `zcodeInteractionBehavior: "guide"` a message
  arriving mid-turn steers the running agent instead of queueing. Works while
  the window is backgrounded or minimized (renderer-level events, no OS focus
  steal). This is the only way to deliver into a conversation the user has open.

### Remote (SSH) Claude sessions - reading a mirror, writing to the live brain

Claude sessions on SSH workspaces keep only a transcript mirror locally; the
live process (`ccd-cli --resume=<id> --input-format stream-json`) runs on the
server and consumes user turns from its stdin. AgentRelay:

1. resolves the host from the `ssh:<host>:<cwd>` project keys in
   `~/.claude.json` (e.g. `ssh:root@1.2.3.4:/root/TokenGateway`);
2. finds the live runner over SSH by its `--resume=<id>` flag;
3. writes one stream-json user turn into `/proc/<pid>/fd/0`.

The turn executes inside the live process, so the reply streams back to the
Claude desktop in real time and the chain stays native.

### Remote agents driving local sessions

stdio MCP servers can only be spawned by local clients, so for agents on other
machines AgentRelay also speaks streamable HTTP on `127.0.0.1:9321`, paired with
an SSH reverse tunnel (`tools/relay-remote-up.ps1`). The remote client registers
`http://127.0.0.1:9321/mcp` and gets the same tools operating on your local
sessions; traffic never leaves the SSH tunnel.

### Desktop mode (zcode, Windows)

By default a zcode `send` runs headless, which writes to the session database
behind the desktop app's back — the app's window will not live-refresh (its UI
keeps its own in-memory state and never re-reads the DB). `--desktop` (CLI) or
`desktop: true` (MCP) takes a different route: it locates the session in the
desktop app's sidebar and delivers the message through the app's real composer
over CDP (renderer-level trusted input events — no focus stealing). The turn
runs **inside the desktop app**, so its window updates live, the message chain
stays native, and if the session is mid-turn the message **steers** it
(requires the desktop setting `zcodeInteractionBehavior: "guide"`).

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
| zcode  | `~/.zcode/cli/db/db.sqlite`            | `zcode.cjs --resume <id> --prompt <msg>`         |

Everything runs locally against your existing installs; AgentRelay itself adds no
service, port, or daemon.

**Remote (SSH) Claude workspaces** appear in `list`/`read` with an `ssh:` prefix on
the workspace; subagent transcripts (`agent-*.jsonl`) are never listed as sessions.
`send` to a remote session is supported: AgentRelay resolves the SSH host from the
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
- Session storage layouts are the agents' local, undocumented formats and may change between versions.
- Prompt payloads always travel via stdin or a directly-spawned process — never through a shell — so arbitrary quotes/newlines in messages are safe.

## 中文说明

**AgentRelay**：一个 MCP/CLI 命令，跨桌面端与 CLI、跨本地与远程机器，统一管理 **Claude Code / Codex / ZCode** 的 agent 会话。

- `agentrelay list [关键词...]` — 三家 session 混合列表 + **模糊搜索**（匹配 agent/ID/标题/工作区，多词 AND），默认 top 30，`--limit N` 覆盖
- `agentrelay read <sessionId>` — 读取任意 session 的最近对话（自动跨三家匹配 id）
- `agentrelay send <消息>` / `send <sessionId> <消息>` — 注入**真实用户回合**。默认异步
  （发完即返回，回复落在会话转录里，用 `read` 查看）；加 `--wait` 则阻塞等回复并打印
- `agentrelay paths` — 显示探测到的存储路径与 CLI
- `agentrelay mcp` — 以 stdio MCP server 运行，把同样能力暴露为 4 个工具
  （`list_sessions` / `read_session` / `send_message` / `get_paths`），可接入
  Claude Code、Claude Desktop、Codex、ZCode 等 MCP 客户端，配置示例见上方英文段
- Claude 的 SSH 远程会话：`list`/`read` 以 `ssh:` 前缀标识（子代理转录不会列为 session）；
  `send` 支持远程会话——自动从 `~/.claude.json` 解析主机，在远程主机上找到活运行进程
  （`--resume=<id>`），以 stream-json 用户回合注入其 stdin，回复实时流回桌面应用。
  若目标会话当前未运行，先在桌面应用里启动一次

安装：`npm install -g github:wwy155/agent-relay`（需 Node ≥ 22.5）。

**发送的前提**：claude 需要 `claude` CLI 在 PATH 且 API 可达；codex 需要 `codex` CLI 已认证；
zcode 自动探测桌面版自带的 `zcode.cjs`（可用 `AGENTRELAY_ZCODE_CLI` 指定），且
`~/.zcode/cli/config.json` 里要有 provider/model 配置（`model` 必须是 `"provider/model"` 字符串，
桌面端的 `~/.zcode/v2/config.json` 对无头 CLI 不生效），示例见上方。

**注意**：`send` 会消耗目标 agent 的模型额度并永久写入其 session 历史；给正在忙碌的
session 发送可能抢占当前轮次；session 存储格式是三家 agent 的本地私有格式，随版本可能变化。

**fresh 会话模式（默认的 agent 间通信）**：`agentrelay send <消息>`（不带 sessionId
即走此模式；`--fresh` 为显式形式）在一个
**全新** zcode 会话里执行消息（无头、同步拿回复、返回 sessionId）。新会话会自动出现在
桌面应用的任务列表里，点开即可读完整记录——agent 流量对桌面始终可见，且完全不碰
用户开着的会话（桌面不会重渲染已打开会话的外部写入）。需要多轮往来时，用普通
`send <id>` 续聊这个新会话即可——它没有被任何桌面标签页持有，不存在失效问题。

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
- **CDP 路线（可用时默认）**：桌面以 `--remote-debugging-port=9222` 启动后，AgentRelay
  直接驱动渲染层——侧边栏定位会话行、聚焦输入框、以受信任输入插入消息、回车。回合在
  应用**内部**执行：实时刷新、消息链原生；配合 `zcodeInteractionBehavior: "guide"`，
  回合进行中到达的消息直接**抢占引导**运行中的 agent 而非排队。窗口最小化/后台照常
  （渲染层事件，不抢 OS 焦点）。这是向"用户正开着的会话"投递的唯一途径。

### 远程（SSH）Claude 会话——本地是镜像，大脑在服务器

SSH 工作区的 Claude 会话在本地只有转录镜像；活进程
（`ccd-cli --resume=<id> --input-format stream-json`）跑在服务器上、从 stdin 消费用户
回合。AgentRelay：① 从 `~/.claude.json` 的 `ssh:<host>:<cwd>` 项目键解析主机；
② SSH 上去按 `--resume=<id>` 找活进程；③ 往 `/proc/<pid>/fd/0` 写一行 stream-json
用户回合。回合在活进程内执行，回复实时流回 Claude 桌面，链原生。

### 远程 agent 操控本地 session

stdio MCP 只能被同机客户端拉起，故另提供 HTTP 传输（127.0.0.1:9321）+ SSH 反向隧道
（`tools
elay-remote-up.ps1`）。远端注册 `http://127.0.0.1:9321/mcp` 即获得操作本地
session 的同一组工具，流量不出 SSH 隧道。

**远程 agent 接入（HTTP 传输）**：stdio MCP 只能被同机客户端拉起。跑在服务器上的
agent（如 SSH 里的 Claude Code）改用 HTTP 传输：Windows 上运行
`tools
elay-remote-up.ps1`（启动本地 127.0.0.1:9321 的 MCP + SSH 反向隧道
`服务器:9321 → 本地:9321`），再在服务器的 `~/.claude.json` 注册
`{"mcpServers":{"agentrelay":{"type":"http","url":"http://127.0.0.1:9321/mcp"}}}`。
远程 agent 即获得操作**本地** session 的同一组工具；流量全程走 SSH 隧道，两端只绑
localhost。重启电脑后需重跑 relay-remote-up.ps1。

**desktop 模式（zcode / Windows）**：默认 zcode 的 `send` 走无头进程，直接写数据库，
桌面窗口不会实时刷新。`agentrelay send <id> <消息> --desktop`（或 MCP 的 `desktop: true`）
改走 CDP：在桌面应用侧边栏定位会话 → 向真实输入框注入受信任输入事件 → 回车发送。
回合由桌面应用自己执行——**窗口实时刷新、消息链原生**；若该会话正在跑回合，消息会以
guide 模式抢占（运行中的 agent 立即看到；需桌面设置 `zcodeInteractionBehavior: "guide"`）。

一次性准备：托盘退出 ZCode 后运行 `tools\start-zcode-cdp.ps1`（以
`--remote-debugging-port=9222` 重启应用；CDP 是本地控制面，只在可信机器上开启；
也可把该参数加进快捷方式 Target 常开）。代价：仅 Windows、需桌面应用以此方式运行、
按标题前缀匹配会话、拿不到回复文本（回合在应用内异步执行）。

MIT licensed.
