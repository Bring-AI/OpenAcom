# Claude ↔ Codex MCP Relay

![Relay overview](relay-banner.png)

**English (default)** · [切换到中文 / Switch to Chinese](#中文)

This project lets Claude Desktop and Codex exchange messages through a local MCP bridge. You can address an exact Claude Desktop session instead of relying on a window title or a vague name.

## How it works

1. Claude Desktop starts the bridge as an MCP `stdio` server.
2. Codex asks `list_claude_sessions` for live sessions and their exact `sessionId`, Desktop `taskId`, and project directory.
3. Codex calls `send_to_claude_session` with those identifiers and a message.
4. The bridge validates the destination, delivers the message locally, and returns a correlated receipt/reply.

No public port is opened and no message is sent to a third-party relay.

## Quick start

Merge `claude-mcp-config.json` into `%APPDATA%\\Claude\\claude_desktop_config.json`, set `CODEX_BRIDGE_DESKTOP_TASKS` to `1`, and restart Claude Desktop. Then list sessions and send using the exact IDs:

```json
{
  "target": "<sessionId>",
  "expectedCwd": "F:\\Bob",
  "expectedTaskId": "<taskId>",
  "message": "Continue with the next step",
  "waitSec": 30
}
```

Use the exact identifiers returned by `list_claude_sessions`; this prevents delivery to the wrong conversation.

## 中文

这个项目让 Claude Desktop 和 Codex 通过本机 MCP 中继互发消息，并支持精确指定 Claude Desktop session。

工作流程：Claude 启动本地 MCP 服务；Codex 先调用 `list_claude_sessions` 获取 `sessionId`、Desktop `taskId` 和项目目录；随后调用 `send_to_claude_session` 发送消息。中继会校验目标并返回对应回执，全程不开放公网端口。

## Files

- `mcp_relay_server.py` — local MCP stdio server
- `claude-mcp-config.json` — Claude Desktop configuration snippet
- `MCP-RELAY-SETUP.md` — setup details
- `relay-codex.ps1` — local inbox/outbox helper
