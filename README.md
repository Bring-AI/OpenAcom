# Claude ↔ Codex MCP Relay

![Relay overview](relay-banner.png)

**English (default)** · [切换到中文 / Switch to Chinese](#中文)

This project connects Claude Desktop and Codex through a local MCP bridge. Both directions create **real conversation turns** in the destination chat history; messages are not only written to a sidecar file.

## How it works

- **Claude → Codex:** Claude calls `send_to_codex_thread` with an exact Codex `threadId` and `prompt`. Codex receives a new user turn.
- **Codex → Claude:** Codex calls `list_claude_sessions`, then `send_to_claude_session` with the exact Claude `sessionId`, Desktop `taskId`, and project directory.
- The bridge validates the destination, delivers locally, and returns a correlated receipt/reply.

No public port is opened and no third-party relay is used. Inbox/transcript tools are for receipts and inspection; they do not replace conversation messages.

## Quick start

Merge `claude-mcp-config.json` into `%APPDATA%\\Claude\\claude_desktop_config.json`, set `CODEX_BRIDGE_DESKTOP_TASKS` to `1`, and restart Claude Desktop.

Claude → Codex example:

```json
{
  "threadId": "01a07b4b-bc27-7fd1-89c0-dae8c883bf06",
  "prompt": "Please continue the implementation."
}
```

Codex → Claude uses the exact identifiers returned by `list_claude_sessions`:

```json
{
  "target": "<sessionId>",
  "expectedCwd": "F:\\Bob",
  "expectedTaskId": "<taskId>",
  "message": "Continue with the next step",
  "waitSec": 30
}
```

## 中文

这个项目让 Claude Desktop 和 Codex 通过本机 MCP 中继互发**真正的对话消息**。消息会出现在目标 task/session 的正常对话历史中，而不是只写入文件。

- Claude → Codex：调用 `send_to_codex_thread`，传入精确的 `threadId` 和 `prompt`，Codex 会收到一条新的 user turn。
- Codex → Claude：先调用 `list_claude_sessions`，再用精确的 `sessionId`、Desktop `taskId` 和项目目录调用 `send_to_claude_session`。
- `read_claude_inbox`、transcript 等接口只用于读取回执和状态，不代替对话消息。

中继会校验目标 ID 和项目目录，全程不开放公网端口。

## Files

- `mcp_relay_server.py` — local MCP stdio server
- `claude-mcp-config.json` — Claude Desktop configuration snippet
- `MCP-RELAY-SETUP.md` — setup details
- `relay-codex.ps1` — legacy local inbox/outbox helper
