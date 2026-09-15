# AgentRelay

**English** · [中文说明](#中文说明)

One CLI to read and message the sessions of your local and remote coding agents — **Claude Code**, **Codex**, and **ZCode**.

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

`send` is a synchronous headless resume: the target session receives a **genuine
user turn** — visible in its own history in the agent's UI — runs one agent turn,
and the reply is printed to your terminal. This is the building block for
cross-agent orchestration: let a ZCode session drive a Claude session, script
hand-offs between agents, or poke a long-running session from CI.

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
| `agentrelay list [--agent zcode\|claude\|codex] [--limit N] [--json]` | Unified session table across all three agents |
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

`send_message` is synchronous (default timeout 300 s) and inherits all the caveats
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
blocks for it). All sends are silent headless by default — no UI involvement, no view switch;
the reply lands in the transcript. For zcode you can opt into **UI delivery**
(`--desktop` / `desktop: true`) when the desktop app runs with
`--remote-debugging-port`: the message goes through the app's real composer for
live refresh and steer of a running turn, at the cost of the app briefly
switching to that conversation. claude/codex sends are always headless (plus
remote-SSH injection for claude remote sessions).

For a continuing back-and-forth, keep resuming that fresh session's id with the
normal `send <id>` — it is a headless session no desktop tab holds, so nothing
can go stale.

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

**AgentRelay**：一个 CLI，读取并给本地及远程的 **Claude Code / Codex / ZCode** session 发消息。

- `agentrelay list` — 三家 agent 的 session 混合列表（标题、工作区、更新时间）
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
