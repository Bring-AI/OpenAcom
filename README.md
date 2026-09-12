# Claude ↔ Codex MCP Relay

![Relay overview](relay-banner.png)

本项目让 Claude Desktop 与 Codex 通过本机 MCP 中继互发消息，并支持精确指定 Claude Desktop session。

## 能做什么

- 枚举运行中的 Claude Desktop sessions
- 按 `sessionId`、`taskId` 与项目目录精确路由
- 从 Codex 向指定 Claude session 发送消息并等待回执
- 全程使用本机通信，不监听公网

## 快速开始

1. 将 `claude-mcp-config.json` 合并到 `%APPDATA%\\Claude\\claude_desktop_config.json`。
2. 确认 `CODEX_BRIDGE_DESKTOP_TASKS` 为 `1`，重启 Claude Desktop。
3. 在 Codex 中调用 `list_claude_sessions`。
4. 使用返回的 `sessionId`、`taskId` 和 `cwd` 调用 `send_to_claude_session`。

示例参数：

```json
{
  "target": "<sessionId>",
  "expectedCwd": "F:\\Bob",
  "expectedTaskId": "<taskId>",
  "message": "请继续处理",
  "waitSec": 30
}
```

## 文件

- `mcp_relay_server.py`：本地 MCP stdio 服务
- `claude-mcp-config.json`：Claude Desktop 配置片段
- `MCP-RELAY-SETUP.md`：配置说明
- `relay-codex.ps1`：本地 inbox/outbox 辅助脚本

## 注意

发送前应先列出 sessions，并使用精确 ID，避免消息进入错误会话。
