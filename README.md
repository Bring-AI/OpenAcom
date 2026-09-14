# AgentRelay

**English** · [中文说明](#中文说明)

One CLI to read and message the sessions of your local coding agents — **Claude Code**, **Codex**, and **ZCode**.

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

Session ids are matched across all three agents automatically; pass `--agent`
when an id could be ambiguous or to skip the full scan.

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
`send` refuses remote sessions with a clear error — the CLI runs on your machine
and cannot resume a session inside its remote workspace. Codex and ZCode sessions
are all local on this machine; no remote handling applies.

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

**AgentRelay**：一个 CLI，读取并给本地的 **Claude Code / Codex / ZCode** session 发消息。

- `agentrelay list` — 三家 agent 的 session 混合列表（标题、工作区、更新时间）
- `agentrelay read <sessionId>` — 读取任意 session 的最近对话（自动跨三家匹配 id）
- `agentrelay send <sessionId> <消息>` — 向目标 session 注入一条**真实用户回合**，
  对方 agent 处理后把回复打印到终端（同步无头 resume，消息经 stdin/直接进程传递，不受引号转义影响）
- `agentrelay paths` — 显示探测到的存储路径与 CLI
- Claude 的 SSH 远程工作区在 `list`/`read` 中以 `ssh:` 前缀标识（子代理转录 `agent-*.jsonl`
  不会列为 session）；`send` 会明确拒绝远程会话——CLI 在本机运行，无法在远端工作区恢复 session

安装：`npm install -g github:wwy155/agent-relay`（需 Node ≥ 22.5）。

**发送的前提**：claude 需要 `claude` CLI 在 PATH 且 API 可达；codex 需要 `codex` CLI 已认证；
zcode 自动探测桌面版自带的 `zcode.cjs`（可用 `AGENTRELAY_ZCODE_CLI` 指定），且
`~/.zcode/cli/config.json` 里要有 provider/model 配置（`model` 必须是 `"provider/model"` 字符串，
桌面端的 `~/.zcode/v2/config.json` 对无头 CLI 不生效），示例见上方。

**注意**：`send` 会消耗目标 agent 的模型额度并永久写入其 session 历史；给正在忙碌的
session 发送可能抢占当前轮次；session 存储格式是三家 agent 的本地私有格式，随版本可能变化。

MIT licensed.
