# OpenAcom Desktop · Distributed

Windows 原生桌面工作台，WPF 界面；默认本机模式，不需要 Hub 凭据。

## 打开

解压便携包后运行 **OpenAcom.exe**。保留同目录的 node.exe、bridge.js、control-api.js、service-host.js、fleet-api.js、remote-agent.js、remote-node-worker.js、lib、tools 和 package.json，不要单独移动 exe。便携包自带 Node.js，无需另装运行环境。

源码目录可运行 desktop/build.cmd，然后打开 desktop/openacom-desktop.exe；源码运行需要 PATH 中有 Node.js 22.5+。

## 使用

- 协作总览：根据最近 200 条 inbox 记录绘制 Agent 通信方向、投递状态环图、路线比例和动态；最多展示六组参与方，其余合并。点击节点查看相关消息，点击会话卡片开始发送。
- 消息收件箱：最近 200 条消息、搜索、完整正文、投递详情、换路线重试、远端状态核实、Hub 重新排队、手动标记已读。
- 会话与节点：左侧为紧凑会话列表，可按项目 → Agent 或按 Agent 类型分组；右侧显示所选会话的内容、地址和操作。单击选择后读取本机会话内容，可刷新、复制地址、发送消息，左右宽度可拖动。项目按完整目录区分，远端缺少类型信息的目标标为未标注。视图选择会保存，切换分组保留选中项；远端目标未提供读取接口时会说明限制。
- 新消息：选择 auto、desktopcdp、desktop、session、relay、mailbox，并填写发送方、超时、CDP 页面、等待回复、签名和远端草稿/提交模式。zcode 默认严格 CDP，投递失败留在 inbox。
- 桌面提交：勾选本次提交许可，并为 ZCode 开启本机 CDP 调试端口（默认 9222）。
- 连接设置：可选连接 Hub，默认仅在内存中保留令牌；勾选记住后使用 Windows 当前用户加密保存；通过 node:nodeId/target 向远端投递。
- 控制中心：保存投递偏好；启动/停止 Hub、节点、HTTP MCP、Web 和 OpenCode 服务；用表单管理目标、钩子和 Agent 分组；读取/新建会话；启动受控终端；检查或启用 ZCode CDP、生成令牌及查看诊断。
- 终端描述文件可用文件选择器导入，无需手工拷贝 socket 和 secret。后台服务归启动它的工作台窗口所有，关闭该窗口会发送停止请求；独立交互终端不随窗口关闭。重启 ZCode 前会确认是否中断现有窗口。
- 结果不确定时先核实 inbox，不自动重发。同一提交保留稳定消息 ID。

“已投递”不代表 Agent 已读或工作完成；预览最多 2000 字符。当前界面显示本机 inbox，包括从这个工作台发起的远端消息，并非 Hub 的全局历史视图。状态刷新不向远端重新投递。

## 分布式控制

- 节点与队列：连接 Hub 后显示真实心跳、目标和全局队列，可按节点/状态筛选，查询详情、请求重排队、查看安全事件和按 Hub 留存策略清理历史。
- 远端消息列表使用新管理接口 GET /admin/messages，不会调用节点的取件接口。旧 Hub 缺少该接口时会提示升级。
- SSH 通道：检查并核对主机指纹，保存信任，再通过私钥或已配置的 SSH agent 启动本机回环转发。连接、停止和日志都在界面。使用密钥登录；不自动忽略未知主机指纹。
- 远端部署：填写主机、用户、唯一节点 ID 和远端可访问的 Hub URL。检测 Node.js 22.5+ → 部署 → 配置远端目标 → 启动。支持停止、重启、查询进程状态和读取日志。
- 部署位置固定在远端用户目录的 .openacom/desktop-managed/<节点ID>。版本文件独立保留；更新不替换正在运行的版本，需显式重启。启动凭据经 SSH 标准输入传递，不保存在命令行或明文配置。
- 停止只使用验证过身份的节点控制端口。身份不能确认时拒绝操作，不按猜测的 PID 杀进程。远端节点不随本机桌面窗口关闭而停止。
- 机器配置可保存多份，不含私钥内容或 Hub 令牌。私钥文件应由你在本机选择；远端仍需具备 SSH 登录权限和可从 PATH 启动的 Node.js。

## 收件箱监听

在左侧“收件箱监听”选择收件地址（* 为全部）、1–60 秒间隔及托盘提示后开始监听。可选提示现有未读消息。最小化后仍工作；退出应用停止监听。读取不会更改已读状态，不会自动重试不确定投递。

监听按 SQLite 创建序号分页，超过单页上限的消息会继续读取。已入箱后的状态变化由界面刷新展示，监听提醒针对新创建的未读消息。该监听针对本机 inbox，Hub 全局队列从分布式页查询。

## 构建与验证

运行 desktop/package.ps1 生成 artifacts/OpenAcom-Desktop.zip。使用 Windows 自带 .NET Framework C# 编译器，无 NuGet 依赖；便携包将本机 Node.js 一并复制。

node --test test/desktop-client.test.js test/desktop-bridge.test.js test/desktop-controls.test.js test/desktop-fleet.test.js

--ui-smoke --out report.json --shot preview 会在屏幕外创建真实 WPF 窗口，检查启动、搜索、默认路线，并输出总览、卡片、消息详情及控制中心、分布式和监听等十二张渲染图。图中的三条消息只用于该显式测试模式，正常启动不会生成演示消息。旧 --selftest / --livetest 保留用于 Hub 协议回归。

发送时若出现 DESKTOP_UNAVAILABLE，界面会显示实际端口与底层原因，并提供“检查 / 启用 ZCode CDP”入口。ZCode 必须在启动时开启 CDP；普通启动不会自动提供 9222 端口。重启工具只操作唯一识别且具有桌面窗口的主进程，不按 ZCode 进程名批量结束 CLI 和 helper。

旧版缺少 Hub 令牌时会在窗口出现前退出；新版无凭据照常打开。运行环境错误和连接错误会显示在窗口中，不再静默退出。

CDP 目标检查会按完整会话 ID 定位，支持本机项目中未列在侧栏最近任务里的会话；无法唯一确认工作区时拒绝，不切换到 CLI。检查按钮只导航和检查输入框，不写入文本。实际提交会等待输入控件更新并确认输入框清空；没有观察到接收时返回 uncertain，禁止自动重发。
