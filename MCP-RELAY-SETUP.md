# Claude Desktop ↔ Codex 本地 MCP 中继

将 `claude-mcp-config.json` 中的 `mcpServers.codex-relay` 合并到 Claude Desktop 的配置文件（通常为 `%APPDATA%\Claude\claude_desktop_config.json`），然后重启 Claude Desktop。

Claude 会获得两个工具：

- `send_to_codex(message)`：写入本地 `relay/to-codex.jsonl`
- `read_codex_replies(limit)`：读取 Codex 回复队列

在 Codex 中读取：`.\relay-codex.ps1 -Action read`；回复 Claude：`.\relay-codex.ps1 -Action reply -Message '回复内容'`。

这是本机 stdio 服务，不监听网络、不上传数据。Codex 仍需由用户发消息触发读取；Claude 也不会被后台主动唤醒。
