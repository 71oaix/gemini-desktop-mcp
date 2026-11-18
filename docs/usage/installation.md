# 安装与配置

## 要求

- Windows 11（已实测），当前 Windows 用户已登录桌面。
- Node.js 22.13 或更新版本，且 `node.exe`、`npm.cmd` 在当前 `PATH` 中。
- 自行准备合法来源的 Gemini Windows 桌面客户端 1.16.0，且文件须匹配本仓库基线。仓库不提供安装包，也不保证其他同名客户端兼容。
- 当前用户对 Gemini 安装目录有写权限；补丁只替换 `resources/app.asar`，并校验基线列出的 unpacked 资源。
- 首次安装补丁前完全退出客户端，确认没有生成中的回答和未保存草稿。

## 一键安装

从 [GitHub Releases](https://github.com/71oaix/gemini-desktop-mcp/releases/latest) 下载 Windows 安装 ZIP。将它解压到单独的长期存放目录，例如 `C:\Tools\gemini-desktop-mcp`。补丁和 Codex 配置会记住这个目录的绝对路径。需要换目录时，先按下文回滚，再在新目录安装并更新旧的 Codex 配置。

从托盘菜单完全退出 Gemini，再双击解压后的 `Install.cmd`，或在 PowerShell 中执行：

```powershell
.\Install.cmd
```

脚本只面向已存在的 Gemini 1.16.0 默认安装目录 `%LOCALAPPDATA%\Google\Gemini\app-1.16.0`。它不会下载或附带 Gemini、Node.js、凭据或运行记录，也不会强制结束客户端、保存或丢弃草稿、自动升级或自动回滚。首次运行会：

1. 检查 Node.js 版本、`npm` 和固定版本 `Gemini.exe`；
2. 执行 `npm ci` 安装项目依赖；
3. 用 `desktop-patch.cjs check` 校验基线，`build --writable` 构建到 `state/desktop-build`，再在确认客户端已退出后执行 `install`；
4. 默认调用 `activate.ps1 -AddIfMissing` 配置 Codex。非 Codex 调用方使用 `.\Install.cmd -SkipCodex`，然后按 [mcp.example.toml](../../mcp.example.toml) 手动配置其他 MCP 客户端。

再次运行 `Install.cmd` 时，如果检测到已知的可写补丁，不会重建或自动替换，而是核对已安装补丁的校验值和状态目录。配置 Codex 时，再检查页面可用和原生挂钩。检测到未知版本/哈希、只读补丁、配置节歧义或嵌套表、客户端仍在运行、Node/npm 不可用或任一子步骤失败时，安装停止，不继续写入；只读补丁不会自动回滚，需要按下方手动回滚步骤处理。

如果 Codex 配置检查失败，客户端补丁可能已经安装，但配置文件不会被修改。修正配置后重新运行 `Install.cmd` 即可复用已验证的补丁。

## 手动安装与回滚

桌面补丁只修改已知 1.16.0 安装目录中的应用包文件（`resources/app.asar`），并用 `desktop-baseline.json` 校验版本与文件哈希。基线为 `appVersion 1.16.0`，实际运行时为 Electron 44.5.1。版本或哈希不符时停止，不修补未知版本。`--assert-closed` 表示调用方已人工确认客户端完整退出；脚本不会替你关闭窗口、保存或丢弃草稿。

在仓库根目录的 PowerShell 中执行：

```powershell
npm ci

$install = Join-Path $env:LOCALAPPDATA 'Google/Gemini/app-1.16.0'
$staging = Join-Path (Get-Location) 'state/desktop-build'

node desktop-patch.cjs check --install-dir $install --json
node desktop-patch.cjs build --install-dir $install --staging $staging --writable --json
node desktop-patch.cjs install --install-dir $install --staging $staging --yes --assert-closed --json
```

`check` 应返回 `ok: true` 且 `issues` 为空；安装后再次检查会显示 `status: patched`。客户端不在默认目录时，把 `$install` 改成实际安装目录。`build` 会重建 staging，staging 必须位于本项目 `state/` 内。备份、安装清单与回滚记录在 `state/desktop-backup/1.16.0`。

安装后启动 Gemini，确认已登录并处于可用页面，然后执行：

```powershell
node client.cjs health
node client.cjs connect
```

`connect` 只检查连接和页面可用性，不发送聊天消息。

恢复原厂客户端（沿用前面的 `$install`，或在新会话中重新设置）：

```powershell
node desktop-patch.cjs rollback --install-dir $install --yes --assert-closed --json
```

升级本项目桥接代码前也要先回滚到库存 `app.asar`，再重新 `build` 和 `install`；`build` 只接受原始基线。客户端升级后版本或哈希变化时停止安装，不要沿用旧补丁。补丁会修改已安装客户端文件，可能影响官方支持状态；请自行评估并遵守 Google 的适用条款。

## 接入 MCP

按 [mcp.example.toml](../../mcp.example.toml) 配置 MCP 客户端。示例采用 Codex 的 `mcp_servers` TOML 表；其他 MCP 客户端只需在各自的 stdio 配置中填入相同的 `command`、`args` 和环境变量。`command` 指向 Node 可执行文件，`args` 指向本仓库的 `server.cjs`。请把示例路径改成你自己的绝对路径。`GEMINI_WORK_STATE` 可省略，默认使用仓库下 `state/desktop-v1`；如保留或修改，必须与补丁使用的 `--bridge-state` 一致。不要使用别人机器上的路径或端口。

Codex 用户可执行 `./activate.ps1` 更新指向本目录的 `[mcp_servers.gemini]`；首次没有该节时使用 `./activate.ps1 -AddIfMissing`（`Install.cmd` 默认会这样做）。脚本先只读检查配置：存在嵌套、重复、内联或无法解析的 Gemini 配置，或现有节指向其他安装目录时停止，不修改配置；确认安全后才核验桌面桥（必要时启动客户端），保留其他配置节，并把首次旧配置节备份到被忽略的 `state/`。配置以原子替换写入。其他 MCP 客户端使用上述模板即可。

配置或升级后需要重载或重连 MCP 客户端，新增工具才会出现在工具列表中。`server.cjs` 按需启动后台进程，不需要单独常驻启动 MCP 服务。
