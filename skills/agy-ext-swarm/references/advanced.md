# AGY Ext Swarm 高阶能力与配置参考

仅在使用以下高阶编排或排查特定后端配置时按需阅读：

## 1. 多模型 Arena 擂台（`ext_swarm_arena`）

- **适用场景**：高不确定性方案选型、算法/重构对比、或同一需求的多 CLI 实现择优。
- **流程**：为同一 `task` 传入 ≥2 组 `contestants`（`provider` + 可选 `model`），每个参赛者在独立 worktree 并行开发；结束后用 `ext_swarm_status(include_diff: true)`、测试结果和侧边栏 Arena 对比表择优调用 `ext_swarm_merge` 合入，其余通过 `ext_swarm_kill(..., remove_worktree: true)` 清理。

## 2. 跨厂商只读交叉审查（`ext_swarm_cross_review`）

- 自动挑选与 `target_worker` 不同厂商的 CLI，也可通过 `reviewer_provider` 指定。审查执行器使用 `workspace: "inherit"` 和 `permission_mode: "read-only"`，审计目标分支的 Diff 与总结报告。目标仍在运行时自动挂接 `depends_on`。
- 可用 `reviewer_model`、`reviewer_name`、`reviewer_reasoning_effort` 和 `reviewer_fast_mode` 设置审查执行器的模型、名称、推理强度和快速档，也可传 `rubric` 定制重点检查项。

## 3. 团队模板与 DAG 前置依赖（`templates` / `depends_on`）

- `ext_swarm_templates` 合并内置模板（`feature-squad`、`bug-hunt`、`doc-and-test`）、全局 `templates.json` 与仓库 `.agy-ext-swarm/templates.json`。
- 含 `depends_on` 的执行器初始进入 `blocked` 状态并免疫 `@all` 广播唤醒；上游全部完成（`waiting` 且 `turns > 0`）后自动注入改动摘要及完整 `reportPath`（`.md`）路径并释放入队；上游失败或被终止时下游自动级联失败，防止 `ext_swarm_wait` / `ext-board wait` 死等。

## 4. 原位换模接力（`ext_swarm_update_worker`）

- 对 `waiting` 或 `failed` 状态的执行器可原地更新 `provider`、`model`、`reasoning_effort` 和 `fast_mode`。向 `reasoning_effort` 传 `null` 或 `"default"`、向 `fast_mode` 传 `null` 可清除对应的覆盖值。
- 切换 CLI 后端或指定 `reset_session: true` 会清除旧 CLI 会话 ID，下一轮从新会话开始，继续使用原 worktree 和分支提交。提供 `prompt` 会立即唤醒执行器。仅需重试时传 `retry: true`。

## 5. 自定义 CLI 与 `dsh` Profile 隔离

- **自定义 CLI**可通过 `ext_swarm_add(..., custom_command)` 或全局 `providers.json` 注册。项目 `providers.json` 可覆盖已注册 provider 的模型、显示名称等设置。命令、参数模板、模型探测参数和环境变量由全局配置提供。
- `args` 和 `resumeArgs` 支持 `{{prompt}}`、`{{model}}`、`{{reasoningEffort}}`、`{{fastMode}}`、`{{cwd}}`、`{{sessionId}}`、`{{permissionMode}}`、`{{workerName}}`、`{{swarmDir}}`、`{{gitCommonDir}}` 和 `{{boardCli}}`。
- 可选参数须独占一个模板项。`{{?model:--model}}` 在指定具体模型时生成 `--model` 和模型值两个参数，`{{?model:--model=}}` 则生成单个 `--model=<值>`。`{{?reasoningEffort:--effort}}` 在设置推理强度时生效。`{{?fastMode:--fast}}` 在快速档为 `true` 或 `false` 时生效。条件未满足时省略整个参数项。
- **`dsh` Profile 隔离红线**：默认运行于 `headless` profile；**严禁传入或修改 `desktop`**（由桌面端独占锁定）。插件会只读读取本地/同级 profile（如 `desktop`）的 `cordis.patch.yml` 模型目录并通过 `--patch` 注入本次运行，不改动原 profile 文件。

## 6. 战报导出与历史清理

- `ext_swarm_export` 生成包含成员状态、外部集群与 AGY 主模型（含 Orchestrator 分模型）Token/缓存统计、可选费用估算及完整消息板的 Markdown 战报。
- `ext_swarm_delete` 终止残留进程、清理对应 worktree/分支并彻底删除历史 Swarm 数据。

## 7. Worktree 预热与端口隔离（`.agy-ext-swarm/worktree.json`）

- 仓库可提供 `.agy-ext-swarm/worktree.json` 自动完成新 worktree 初始化：`copyFiles`（如 `.env.local`）、`symlinkDirs`（如 `node_modules`，路径均校验限制在仓库根目录内）、`setupCommand`（创建时运行，120s 超时）、`teardownCommand`（删除 worktree 前尽力清理）。
- 配置 `portOffsetBase` 与 `portOffsetStep` 后，插件会为每个 worktree 执行器分配独立索引与端口偏移，并通过环境变量 `SWARM_WORKER_INDEX`、`SWARM_PORT_OFFSET` 注入 `setupCommand` 及后续执行器进程，避免并发起测试服务时端口冲突。

## 8. 越界与验证自愈重试（`max_verify_retries`）

- 写入型执行器每轮结束后检查 `allowed_files`。当 `max_verify_retries > 0`、`scope_mode !== 'warn'` 且还有重试额度时，越界修改会触发自动续跑，即使 `auto_verify` 为 `false`。`scope_mode` 默认为 `"enforce"`。`"warn"` 将越界文件报告给协调者，供审查时处理。
- 设置 `auto_verify: true` 后，宿主会运行 `verify_commands`，每条命令的 `verify_timeout_seconds` 默认为 300 秒，可设为 10–1800 秒。命令失败时，如果还有重试额度，Runner 会将报错交给执行器继续修复。人工点击重试或收到协调者新消息时重置计数。

## 9. 限流冷却路由与预算熔断（`cooldowns` / `max_cost_usd`）

- **限流冷却路由**：检测到 429 / 配额耗尽错误后，对应 Provider 会进入临时冷却窗口（默认 900s，可通过环境变量 `EXT_SWARM_COOLDOWN_SECONDS` 调整；`0` 关闭）。冷却中的 Provider 会在 `ext_swarm_providers` 返回的 `cooldowns` 展示，并在路由与 Failover 时自动跳过；设置页支持点击徽章手动清除冷却。
- **预算上限熔断**：`ext_swarm_create` 可传 `max_cost_usd` 设定整群预算上限；触发超额后集群进入 `budgetPaused` 并暂停新派活，可在看板预算条点击恢复或按 `+50%` 上调预算继续执行。

## 10. 直出 GitHub PR（`ext_swarm_merge(action: "pr")`）

- 当执行器分支已自检通过且本机已登录 `gh` CLI 时，可直接调用 `ext_swarm_merge(action: "pr")`（或 UI「Push 并创建 PR」），校验分支名后推送远端并创建预填 Diff 统计、验证结果与交叉审查摘要的 PR。
