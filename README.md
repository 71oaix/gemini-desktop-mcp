# Gemini Desktop MCP

通过本机已登录的 Gemini Windows 桌面客户端提供 Gemini 问答：MCP 调用方或本项目 CLI 提交任务，异步取得任务编号，持续查询并取回完整回答。独立任务进入新对话，可在上限内并行；续聊复用本服务保存的父任务会话。常规任务使用客户端页面和观察层，不使用 Playwright、窗口焦点、键鼠或剪贴板。

范围是 Gemini 问答。输入为任务文本和调用方明确提供的 TXT 材料；Gemini 不执行本地 shell，也不编辑本地文件。本项目不是通用自主编码代理，也不管理全部历史对话。

本项目不包含、不分发 Gemini 客户端或其安装包。固定支持 1.16.0 桌面客户端，使用前需要已登录的 Google 账号和可用网络。

## 要求

- Windows 11（已实测），当前 Windows 用户已登录桌面。
- Node.js 22.13 或更新版本。
- 自行准备合法来源的 Gemini Windows 桌面客户端 1.16.0，且文件须匹配本仓库基线。仓库不提供安装包，也不保证其他同名客户端兼容。
- 安装补丁前完全退出客户端，确认没有生成中的回答和未保存草稿。

## 安装（固定 1.16.0 基线）

桌面补丁只修改已知 1.16.0 安装目录中的应用包文件（`resources/app.asar` 及基线列出的 unpacked 资源），并用 `desktop-baseline.json` 校验版本与文件哈希。基线为 `appVersion 1.16.0`，实际运行时为 Electron 44.5.1。版本或哈希不符时停止，不修补未知版本。`--assert-closed` 表示调用方已人工确认客户端完整退出；脚本不会替你关闭窗口、保存或丢弃草稿。

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

按 [mcp.example.toml](mcp.example.toml) 配置 MCP 客户端。示例采用 Codex 的 `mcp_servers` TOML 表；其他 MCP 客户端只需在各自的 stdio 配置中填入相同的 `command`、`args` 和环境变量。`command` 指向 Node 可执行文件，`args` 指向本仓库的 `server.cjs`。请把示例路径改成你自己的绝对路径。`GEMINI_WORK_STATE` 可省略，默认使用仓库下 `state/desktop-v1`；如保留或修改，必须与补丁使用的 `--bridge-state` 一致。不要使用别人机器上的路径或端口。

Codex 用户如已配置 `[mcp_servers.gemini]`，可选择执行 `./activate.ps1` 更新该节。它先核验桌面桥（必要时启动客户端），再使用当前 Node 和仓库实际路径生成配置，保留其他配置节，并把首次旧配置节备份到被忽略的 `state/`。配置以原子替换写入；若没有该节或存在嵌套 Gemini 配置表则停止，不修改配置，应改用模板手动配置。其他 MCP 客户端使用上述模板即可。

配置或升级后需要重载或重连 MCP 客户端，新增工具才会出现在工具列表中。`server.cjs` 按需启动后台进程，不需要单独常驻启动 MCP 服务。

## 使用

CLI 与 MCP 共用同一个持久化队列：

```powershell
node client.cjs health
node client.cjs capabilities
node client.cjs submit request.json
node client.cjs wait task-id 1800
node client.cjs status task-id
node client.cjs result task-id
node client.cjs release task-id [reason]
```

`submit` 立即返回任务编号；`wait` 等待并自动拼接分页，第二个参数是本次等待预算（秒，默认 1800），等待的是队列事件，到期只返回当前状态，不改变任务执行。把任务写入 `request.json`（字段可参考 `request.example.json`），任务正文示例：

```json
{
  "prompt": "用三句话概括附件中的要点。",
  "mode": "chat",
  "model": "hydrogen",
  "files": ["C:/path/material.txt"]
}
```

- `timeout_sec` 可选，范围 20–1800 秒，默认 1800 秒。这是从客户端首次执行开始的总预算，包含页面准备与生成，不包含排队；恢复原任务不重新计时。预算耗尽时保留部分回答和任务占用，继续观察真实完成或冲突，不重发。
- `mode` 可用 `auto`（默认，保持当前模式）、`chat`（对话）、`task`（任务）。对话模式会选择并核实“高”思考；任务模式没有思考等级入口，返回 `thinking_control=not_exposed`、`thinking_level=native`，不冒充高思考。
- `model` 默认 `hydrogen`（4 Hydrogen）。也可填当前页面模型菜单中的唯一名称或完整条目标识，不依赖固定名单；旧别名只作兼容，不代表实时清单。指定模型缺失、歧义、禁用、锁定或升级入口时明确失败，不自动降级、不切换模式、不创建补做任务。
- 续聊使用 `continue_task_id` 指定已完成父任务；续聊继承父任务实际模式，同一会话不再点击模式切换。TXT 在提交时快照；相同任务编号与相同材料复用原任务，不同内容复用编号会被拒绝。
- 附件只支持 TXT：最多 10 个，每个 10 MiB，总计 25 MiB。

MCP 工具为 `gemini_connect / gemini_submit / gemini_status / gemini_wait / gemini_result / gemini_health / gemini_capabilities / gemini_release`。典型顺序是 `gemini_connect → gemini_submit → gemini_wait → gemini_result`；`gemini_result` 返回 `next_offset` 时继续分页。`gemini_status` 可等待至多 20 秒；`gemini_wait` 按队列事件等待，不轮询页面。

### 能力查询

`gemini_capabilities` 无参数，查询已绑定的空闲主页面中的模型名称、可调用 selector、选中与受限状态，以及实际暴露的思考选项。仅 `status=ready` 且 `observed=true` 表示取得本次菜单事实，结果不跨请求缓存。活动任务或其他菜单操作期间返回 `busy`；草稿、附件、弹窗或用户已打开的菜单使查询返回 `blocked`；无法观察或确认清理时返回 `unavailable`。这些状态都不提供可用模型清单。

查询不会启动后台、发送消息、改变模型或思考选择；换文档或用户接手后停止点击。`default_model` 只说明默认选择政策，不保证账号可用；菜单选中也不代表本轮实际推理模型已核实。

## 状态与恢复

`status / result / wait / health` 附带 `activity`，用简明说明和 `next_action` 表达当前在等待什么。`quiet` 表示上次观察器检查可响应但没有新进展，`awaiting_completion` 表示已有回答但结束证据不足，`observation_lost` 表示观察检查失败，`reconnecting` 表示连接恢复中；这些都不会自动重发。任务依据标为 `saved_task`，时间来自已保存证据；健康检查标为 `health_probe` 或 `health_snapshot`，不能把旧记录当作本次探测成功。原有状态、错误码及恢复规则仍是执行依据。

| 状态 | 行为 |
|---|---|
| queued / connecting / submitting / generating | 后台自动执行并保存结果；正常由推送事件驱动，不做周期性页面快照 |
| retry_wait | 网络或地区异常，按 1、2、4、8、15、15 分钟有限退避 |
| partial | 保存部分回答；预算耗尽时任务保留并继续观察，其他部分回答只恢复原会话 |
| uncertain | 发送状态无法确定，只查询或恢复，绝不重发 |
| needs_user_action | 处理登录、验证码、确认弹窗、草稿或冲突后调用 connect |
| completed / failed | 任务结束，结果或失败原因保留 |

完成判定要求唯一的本轮任务标记、与标记严格配对的回答槽位、未截断且去除空白后非空的回答、当前没有 stop 控件、本轮回答内无生成信号，并保持 2 秒稳定。结束证据有两种：页面响应 `complete=true`；或仅在已核实的对话模式下，同一任务、同一已确认会话有唯一且有序的原生 start/complete 通知。原生通知在产生端记录文档与任务绑定，原厂无绑定通知只作诊断。任务模式和未知模式仍要求页面完成控件。原生通知、已有文字或停止按钮消失均不能单独触发完成。

长时间没有新事件时，后台执行一次空闲诊断：ping 观察器并检查最近推送状态，不读取页面。若已有回答但不满足完整结束证据，或观察不到新进度，任务保持 `generating`，状态中带 `completion_unverified` 和 `diagnostic`；`gemini_wait` / CLI `wait` 会立即返回 `wait_reason`，任务、原会话和执行状态均保留。

执行进程由轻量 supervisor 监控。进程退出或断线后继续使用原任务编号；队列和桥接各自记录发送边界。不能确认发送时，不通过新建会话规避。正常停止后台：创建 `state/desktop-v1/stop-worker`，等待 `health` 中 supervisor 和 worker 退出；恢复前删除该文件，再执行 `connect`。

`needs_user_action` 且尚未发出（`send_state=not_sent`）的失败任务，应先按错误码和账本查明原因；在补丁和后台未确认恢复前不要释放，也不要按同一编号重交。`release` 可同步已结束的桥记录或关闭从未发送的任务，但不终止已发送的生成。修复并确认当前连接健康后，可关闭明确未发送的失败记录；确需重新执行时使用新的任务编号。过期的重连或释放通知不要重复执行；以当前 `health` 和账本为准。

## 隐私与数据

- 任务 `prompt` 和显式提供的 TXT 内容会通过已登录客户端发送到 Google Gemini，受 Google 的服务条款和账号设置约束。
- 任务记录、部分回答、日志和队列保存在本机 `state/desktop-v1`。该目录已在 `.gitignore` 中，不应提交或公开。
- 桌面桥只监听 `127.0.0.1` 上的随机端口，Bearer 令牌随 Gemini 启动轮换并写入 `state/desktop-v1/discovery.json`。调用方自动发现；不要把令牌写入聊天、文档或日志。
- 本项目不导出浏览器 Cookie 或其他浏览器凭据，不打开调试端口，不自动同意新条款，不修改 VPN，也不会自动丢弃客户端草稿。
- 仓库不提供丢弃草稿、关闭客户端窗口或修改 VPN 的自动化命令；这些操作由使用者自行确认。

## 支持范围与已知限制

- 仅支持 Windows 和固定 1.16.0 桌面客户端；不自动适配新版本，版本或哈希变化时停止。
- 附件仅支持 TXT；不支持 PDF、图片或其他文件类型。
- 同时生成的任务上限为 3（含准备阶段）；第四个任务排队。
- 只支持新建对话和本服务任务的续聊；列出、搜索、读取或续接任意历史会话不在当前范围。
- 不自动选择或回退模型，不自动路由，不自动创建补做任务，不自动重发发送状态不明的任务。
- 最小化窗口、真实网络故障、生成中客户端强制退出、执行进程或桥接任意崩溃组合尚未完整验收。
- 英文界面下「上传和工具」等入口尚未按中文界面同样的实况验证；未见过的异步文件选择路径仍可能弹出系统文件框。
- 页面是否暴露完成控件、菜单是否出现和平台实际推理模型都可能有未核实情形；完成状态表示本轮回答收取完成，不保证回答内容正确。
- 未覆盖无人登录、休眠或跨账号场景。

具体已实测范围和仍存在的缺口见 [ACCEPTANCE.md](ACCEPTANCE.md)。

## 文档

- [ACCEPTANCE.md](ACCEPTANCE.md)：当前验证结论、使用限制和未完成验证。
- [docs/intention/task-service-intention.md](docs/intention/task-service-intention.md)：服务范围、已决定策略和不在范围的能力。
- [docs/specification/capabilities-and-activity.md](docs/specification/capabilities-and-activity.md)：能力查询与 `activity` 状态表达的当前契约。
- [docs/survey/task-service-design-evidence.md](docs/survey/task-service-design-evidence.md)：页面事实、源码机制和证据边界。
- [docs/survey/gemini-web-bridge-comparison.md](docs/survey/gemini-web-bridge-comparison.md)：其他 Gemini 网页桥接方案的只读对照。
- [AGENTS.md](AGENTS.md)：贡献者和维护者必须保留的安全与文档约定。

文档只保留当前有效内容；过期规则和旧批次不归档。清理文档不等于扩大已验证范围。

## 开发检查

```powershell
npm ci
npm test
```

离线测试覆盖包布局、认证、草稿保护、发送边界、附件快照、共享队列、完成判定、并发清理和监督进程。离线通过不能替代真实收发、后台运行、断线和回滚验收。

## 许可证

本项目源码以 MIT 许可证发布，版权归 2026 71oaix，全文见 [LICENSE](LICENSE)。Gemini 客户端、Google 服务及第三方依赖不包含在本许可证范围内，其权利归各自所有者。
