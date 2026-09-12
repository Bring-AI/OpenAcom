# Claude Desktop Session 消息发送方案

`claude-send.ps1` 使用 Windows 原生窗口 API 激活 Claude Desktop，把文本粘贴到当前打开的 session 输入框；只有显式加入 `-Send` 才按 Enter 发送。

## 用法

先在 Claude Desktop 中打开目标 session：

```powershell
.\claude-send.ps1 -Message '请总结上一条回复'                 # 仅填入，不发送
.\claude-send.ps1 -Message '继续处理第 2 项' -Send             # 填入并发送
.\claude-send.ps1 -SessionTitle '项目规划' -Message '继续' -Send
```

`-SessionTitle` 按窗口标题匹配；若 Claude Desktop 没有把会话标题放进窗口标题，请省略它并在发送前手动打开目标 session。脚本不读取或上传会话内容，文本通过本机剪贴板粘贴。

## 集成

可从其他程序调用：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\claude-send.ps1 -Message $text -Send
```

建议生产环境默认不带 `-Send`，由操作者检查后再按 Enter；批处理或快捷键场景再显式传入 `-Send`。
