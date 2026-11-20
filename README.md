# Gemini Desktop MCP

把 Windows 上的 Gemini 桌面应用接入 Codex。可以请 Gemini 回答问题、阅读 TXT 附件，也可以在原对话里追问。项目同时提供命令行入口。

## 安装前

- Windows 11，当前用户已登录桌面。
- Node.js 22.13 或更新版本，终端能运行 `node` 和 `npm`。
- 自行安装与项目基线匹配的 **Gemini 桌面客户端 1.16.0**，登录 Google 账号并确认能正常联网。无需 Gemini API 密钥。Google 下载页提供当前版本，安装器会核对实际版本和文件哈希。 [下载 Google Gemini 桌面客户端](https://gemini.google/desktop/)

这是独立的第三方项目，与 Google 无隶属关系。项目 ZIP 不含 Gemini 客户端，安装会备份并修改本机 Gemini 的应用包，可能影响官方支持。使用前请确认 Google 的适用条款。

一键安装面向 Gemini 的默认安装位置 `%LOCALAPPDATA%\Google\Gemini\app-1.16.0`。自定义位置见[手动安装](docs/usage/installation.md#手动安装与回滚)。

## 安装

1. 下载 Windows ZIP，解压到单独的长期存放目录，例如 `C:\Tools\gemini-desktop-mcp`。 [下载安装包](https://github.com/71oaix/gemini-desktop-mcp/releases/latest)
2. 保存 Gemini 里的草稿，从托盘完全退出 Gemini，再双击解压后的 `Install.cmd`。
3. 安装器会装好依赖、备份并修补 Gemini 应用包，再登记 Codex 的 MCP 配置。看到安装完成后，重启 Codex。

只用命令行或其他 MCP 客户端时，在解压目录运行 `.\Install.cmd -SkipCodex`，然后打开 Gemini。 [其他 MCP 客户端的配置](docs/usage/installation.md#接入-mcp)

## 第一次提问

在 Codex 里输入：

> 请用 Gemini MCP 回答：为什么天空是蓝色的？把回答带回这个对话。

要追问，可以说「继续刚才的 Gemini 对话，问它日落时为什么偏红」。要让 Gemini 阅读文件，请明确给出 TXT 文件路径。你提交的问题和指定的附件会通过已登录的客户端发送给 Google Gemini。

也可以在解压目录的 PowerShell 里直接提交示例问题：

```powershell
node client.cjs submit request.example.json
node client.cjs wait <任务编号>
```

把 `<任务编号>` 换成第一条命令返回的 `task_id`，不带尖括号。

如果 Codex 找不到 Gemini 工具，先确认安装已完成并重启 Codex。如果工具可见但提问失败，确认 Gemini 已打开、登录，并能进入聊天页，再用 `node client.cjs health` 查看连接状态。

## 文档

- [安装、MCP 配置和回滚](docs/usage/installation.md)
- [提问、发送 TXT 附件和恢复任务](docs/usage/asking-gemini.md)
- [已验证的场景和已知限制](ACCEPTANCE.md)
- [开发、打包和维护约定](AGENTS.md)

本项目源码采用 MIT 许可证。Gemini 客户端、Google 服务及第三方依赖各自适用其原有条款。 [MIT 许可证](LICENSE)
