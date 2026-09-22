# OpenAcom 简明使用指南：MCP 与命令行

适用于本机已安装的 **OpenAcom 0.16.0**。原 agentrelay 已替换为 openacom。

日常流程：**查会话 → 发送消息 → 查状态或回复**。默认发送会先写入 inbox，再尝试投递一次；失败或不确定时保留记录，不自动换路线重发。

示例中的 `SESSION_ID`、`MY_SESSION_ID`、`MESSAGE_ID` 需要替换为实际值。本机会话地址格式为 `agent:sessionId`，例如 `zcode:sess_...`；人工从命令行发送时可使用 `desktop:operator` 作为发送方。

## 1. 通过 MCP 使用

### 接入客户端

本机 ZCode、Claude Code、Claude Desktop 已配置 OpenAcom；已打开的会话若看不到新工具，重连 MCP 或重启客户端即可。

对于采用 `mcpServers` 配置格式的客户端，本机配置如下：

```json
{
  "mcpServers": {
    "openacom": {
      "command": "node",
      "args": [
        "C:\\Users\\63494\\AppData\\Roaming\\npm\\node_modules\\openacom\\bin\\openacom.js",
        "mcp"
      ]
    }
  }
}
```

ZCode CLI 使用相同的服务器条目，但放在 `mcp.servers` 下。其他电脑的安装路径可能不同，可运行 `npm root -g`，在输出目录后接 `openacom/bin/openacom.js`。

MCP 客户端会自动启动该进程；通常不需要手动运行 `openacom mcp`。

### 常用工具

| 工具 | 用途 |
| --- | --- |
| `list_sessions` | 查找会话，取得 `agent` 和 `id` |
| `read_session` | 读取会话最近几轮内容 |
| `send_message` | 先入箱，再按所选路线投递 |
| `inbox` | 查询消息记录与状态 |
| `ack_message` | 显式标记消息已读 |
| `post_message` | 只存入邮箱，不向会话投递 |
| `relay_nodes` / `relay_send` / `relay_status` | 查询远端节点、发送远端消息、查询远端回执 |

下面的 JSON 是**工具参数**，不是发到聊天框里的普通消息。

**查找 zcode 会话**：调用 `list_sessions`：

```json
{"agent":"zcode","limit":10}
```

**向找到的会话发送消息**：调用 `send_message`。本例允许在 zcode 桌面提交这条消息，即按 Enter：

```json
{
  "from": "codex:MY_SESSION_ID",
  "to": "zcode:SESSION_ID",
  "message": "请检查这次修改，完成后回复。",
  "id": "request-001",
  "consent": true
}
```

不写 `route` 即使用 `auto`；zcode 会选择 `desktopcdp`。发送方地址应填写自己的实际身份。

**查询投递记录**：调用 `inbox`：

```json
{"to":"zcode:SESSION_ID","limit":10}
```

**查看对方回复**：调用 `read_session`：

```json
{"agent":"zcode","sessionId":"SESSION_ID","last":10}
```

**处理后确认已读**：调用 `ack_message`：

```json
{"id":"MESSAGE_ID"}
```

当前版本的 MCP `inbox` 返回状态等元数据，不包含消息正文。会话回复用 `read_session` 查看；已入箱消息的正文可在桌面端查看。

## 2. 通过命令行使用

以下示例可在 PowerShell 中执行。

```powershell
# 查看帮助
openacom --help

# 列出最近的 zcode 会话
openacom list --agent zcode --limit 10 --json

# 按关键词查找会话
openacom list "SDK" --limit 10 --json

# 读取会话最近 10 轮
openacom read SESSION_ID --agent zcode --last 10 --json

# 发送到 zcode：先入箱，默认走桌面 CDP；允许本次提交
openacom deliver zcode:SESSION_ID "请检查这次修改" --from desktop:operator --id request-001 --consent true

# 指定会话适配器路线
openacom deliver codex:SESSION_ID "请查看测试结果" --from desktop:operator --route session

# 只存入邮箱，不投递
openacom deliver qoder:boss "留一条消息" --from desktop:operator --route mailbox

# 查询消息记录，JSON 包含完整消息 ID
openacom inbox --limit 20 --json

# 确认某条消息已读
openacom ack MESSAGE_ID
```

`deliver` 的退出码：`0` 表示已存储、排队或接受；`1` 表示拒绝/错误；`2` 表示投递不确定。最终仍应查看返回的 `status`。

日常通信使用 `deliver`。旧 `send` 是直接发送/恢复会话入口，也能创建新 zcode 会话，与 `deliver` 的“先入箱”流程不同；旧 `--require-read` 模式还会因未收到回执而重发，不要把它用于不确定投递的补救。

## 3. 如何选择路线

MCP 使用 `route`；CLI 使用 `--route`。

| 路线 | 行为 |
| --- | --- |
| `auto` | 默认值：zcode 走 `desktopcdp`，其他支持的平台走 `session`，`node:` 地址走 `relay` |
| `desktopcdp` | 只走 zcode 桌面 CDP，失败后不回退 UIA 或无头 CLI |
| `session` | 使用会话适配器，禁用桌面路线 |
| `desktop` | zcode 桌面兼容路线；CDP 不可用时可能使用 UIA |
| `relay` | 向远端机器上的具名目标投递 |
| `mailbox` | 明确只入箱，不投递 |

zcode 的 CDP 调试端口默认是 **9222**，需要先在桌面端启用。可在 OpenAcom 桌面端的“诊断与 CDP”中操作。MCP 可用 `cdpPort` 指定其他端口；当前 CLI `deliver` 没有对应的 CDP 端口参数。

当前内置会话适配器支持 `zcode`、`claude`、`codex`、`opencode`。其他名字可以作为邮箱地址，但并不意味着具备自动投递通道。

## 4. 远端消息（已有 Hub 和节点时）

先设置本次 PowerShell 会话使用的 Hub 地址和令牌。地址也可以是 SSH 转发到本机的端口：

```powershell
$env:AGENTRELAY_URL = "http://127.0.0.1:19330"
$env:AGENTRELAY_TOKEN = "替换为实际的Hub令牌"

# 查看节点和目标名称
openacom relay nodes

# 发往 machine-a 节点的 coder 目标
openacom deliver node:machine-a/coder "请查看构建结果" --from desktop:operator --route relay

# 使用发送结果中的消息 ID 查询回执
openacom relay status MESSAGE_ID
```

环境变量仍保留 `AGENTRELAY_` 前缀，这是兼容名称，不代表还在使用旧 agentrelay 服务。MCP 的远端工具也需要在 **MCP 服务进程**中配置这些环境变量；在另一个终端设置不会影响已启动的 MCP。

MCP 对应操作是先调用 `relay_nodes`，再调用 `relay_send`：

```json
{"to":"machine-a","target":"coder","text":"请查看构建结果"}
```

随后调用 `relay_status`，参数为 `{"id":"MESSAGE_ID"}`。远端消息若显式指定 `id`，请使用 UUID，例如 `6fba9c32-bd91-4ad0-bf91-f36e980c7158`。省略时会自动生成。

## 5. 看懂结果

- `stored`：只入箱。
- `queued`：Hub 已排队。
- `accepted` / `delivered`：相应投递阶段已接受或送达，不代表模型已读或任务完成。
- `refused`：本次投递被拒绝，查看 `code`、`detail`。
- `uncertain`：可能已经送达，先查目标会话或远端回执，不要直接重复发送。
- `read`：已收到显式已读确认。旧记录的 `sent` 要结合 `delivery` 判断；邮箱记录的 `sent` 也可能只是已存储。

同一消息 ID 及相同发送参数重复调用会返回原结果，不再次投递；更改内容、路线或提交许可等参数却沿用 ID，会产生 `ID_CONFLICT`。确认需要重新尝试时，使用新的 ID，并保留原记录用于核对。
