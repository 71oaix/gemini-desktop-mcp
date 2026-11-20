# 问答与任务恢复

## 提问和取回回答

CLI 与 MCP 共用同一个持久化队列。最多同时执行 3 个任务，准备中的任务也占名额，其余任务排队。

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

完成判定的细节见[页面观察与完成判定](../survey/task-service-design-evidence.md#已实现的页面接入与完成判定)。

任务标记已经出现，但会话地址仍为 `/app` 时，后台会在原页面做有限次只读恢复。若同一页面随后出现有效会话地址，且标记仍唯一、位于最后一条用户消息中，后台会补绑会话并继续读取回答。用 `gemini_result` 取回答案，任务完成后用 `continue_task_id` 续聊。恢复过程中只观察原页面，发送次数保持不变。

自动尝试结束后，任务仍为 `uncertain`。原页面仍在时，可运行 `gemini_connect`（CLI 为 `node client.cjs connect`）再检查。原页面关闭、客户端重启、标记无法唯一归属或地址与目标会话冲突时，任务会保持待确认。补绑已通过离线回归测试，桌面客户端实测待完成。

长时间没有新事件时，后台执行一次空闲诊断：ping 观察器并检查最近推送状态，不读取页面。若已有回答但不满足完整结束证据，或观察不到新进度，任务保持 `generating`，状态中带 `completion_unverified` 和 `diagnostic`；`gemini_wait` / CLI `wait` 会立即返回 `wait_reason`，任务、原会话和执行状态均保留。

执行进程由轻量 supervisor 监控。进程退出或断线后继续使用原任务编号；队列和桥接各自记录发送边界。不能确认发送时，不通过新建会话规避。正常停止后台：创建 `state/desktop-v1/stop-worker`，等待 `health` 中 supervisor 和 worker 退出；恢复前删除该文件，再执行 `connect`。

`needs_user_action` 且尚未发出（`send_state=not_sent`）的失败任务，应先按错误码和账本查明原因；在补丁和后台未确认恢复前不要释放，也不要按同一编号重交。`release` 可同步已结束的桥记录或关闭从未发送的任务，但不终止已发送的生成。修复并确认当前连接健康后，可关闭明确未发送的失败记录；确需重新执行时使用新的任务编号。过期的重连或释放通知不要重复执行；以当前 `health` 和账本为准。

## 隐私与数据

- 任务 `prompt` 和显式提供的 TXT 内容会通过已登录客户端发送到 Google Gemini，受 Google 的服务条款和账号设置约束。
- 任务记录、部分回答、日志和队列保存在本机 `state/desktop-v1`。该目录已在 `.gitignore` 中，不应提交或公开。
- 桌面桥只监听 `127.0.0.1` 上的随机端口，Bearer 令牌随 Gemini 启动轮换并写入 `state/desktop-v1/discovery.json`。调用方自动发现；不要把令牌写入聊天、文档或日志。
- 本项目不导出浏览器 Cookie 或其他浏览器凭据，不打开调试端口，不自动同意新条款，不修改 VPN，也不会自动丢弃客户端草稿。


已验证的环境和已知限制见[验收记录](../../ACCEPTANCE.md)。
