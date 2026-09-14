# AgentRelay

**English** · [中文说明](#中文说明)

One CLI to read and message sessions of the local coding agents **Claude Code**, **Codex**, and **ZCode**.

```
agentrelay list                      # all sessions, all agents
agentrelay read  <sessionId>         # last turns of a session
agentrelay send  <sessionId> <msg>   # deliver a real turn, print the reply
agentrelay paths                     # show detected storage/CLI paths
```

Sending is a synchronous headless resume: the target session receives a genuine
user turn (visible in its own history), runs one agent turn, and the reply is
printed to your terminal. Great for cross-agent orchestration — e.g. let a ZCode
session drive a Claude session, or script hand-offs between agents.

## Install

Requires Node.js >= 22.5 (`node:sqlite` is used for the ZCode database).

```bash
git clone https://github.com/wwy155/claude-codex-mcp-relay
npm install -g ./claude-codex-mcp-relay/agentrelay
```

Or run in place: `node bin/agentrelay.js ...`

## Where sessions come from

| Agent  | Sessions                                   | Send mechanism                        |
|--------|--------------------------------------------|---------------------------------------|
| claude | `~/.claude/projects/**/*.jsonl`            | `claude --resume <id> -p` (stdin)     |
| codex  | `~/.codex/sessions/**/rollout-*.jsonl`     | `codex exec resume <id> -` (stdin)    |
| zcode  | `~/.zcode/cli/db/db.sqlite`                | `zcode.cjs --resume <id> --prompt`    |

Session ids are matched across all three agents; pass `--agent zcode|claude|codex`
when an id is ambiguous or to skip the scan.

## Requirements per agent

- **claude**: `claude` CLI on PATH and logged in.
- **codex**: `codex` CLI on PATH and authenticated (`~/.codex/auth.json`).
- **zcode**: the desktop install's `zcode.cjs` (auto-detected from
  `ZCODE_WINDOWS_APP_INSTALL_DIR` / `%LOCALAPPDATA%/Programs/ZCode`, or set
  `AGENTRELAY_ZCODE_CLI`). Headless runs also need a model provider in
  `~/.zcode/cli/config.json`:

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

  (The desktop app keeps its own copy under `~/.zcode/v2/config.json`; the
  headless CLI does not read that file, hence this one.)

## Caveats

- `send` spends tokens on the target agent and appends to that session's real history.
- Sending to a session that is currently busy in its own UI may preempt the active turn.
- Storage formats are the agents' local, undocumented layouts; they can change between versions.
- Everything stays on your machine; no network service is involved beyond the model APIs.

## 中文说明

一个 CLI 读取并给本地 **Claude Code / Codex / ZCode** 的 session 发消息。

- `agentrelay list` — 列出三个 agent 的全部 session（标题、工作区、更新时间）
- `agentrelay read <sessionId>` — 读取某个 session 的最近对话
- `agentrelay send <sessionId> <消息>` — 向目标 session 注入一条**真实用户回合**，
  对方 agent 处理后把回复打印到终端（同步、无头 resume）
- `agentrelay paths` — 显示探测到的存储路径与 CLI

session id 会在三个 agent 间自动匹配；冲突时用 `--agent` 指定。
`send` 会消耗目标 agent 的模型额度，并永久写入该 session 的历史。
ZCode 发送需要 `~/.zcode/cli/config.json` 里有 provider/model 配置（见上方示例），
桌面端的 `~/.zcode/v2/config.json` 对无头 CLI 不生效。

MIT licensed.
