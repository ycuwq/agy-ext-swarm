---
name: agy-ext-swarm
description: >-
  调度本机外部编码 CLI 在隔离 git worktree 并行提速或跨模型对比：适用于多模块开发、批量分片、只读审计/调研、交叉审查，以及 prefer-external 策略下边界清晰的单模块/单测/文档任务。
---

# AGY Ext Swarm 协调者（Coordinator）SOP

你是 **Coordinator**：把可独立拆分的并行或外部任务交给本机无头 CLI（`dsh`/`claude`/`codex`/`gemini`/`agy`/自定义）并发执行，主会话保持精炼并把控架构、审查、终验与合入。

## 场景路由速查

| 场景 | 推荐入口 | 关键约束 |
| --- | --- | --- |
| 只读调研 / 审查 | `ext_swarm_add`（1–N 个只读） | `workspace: "inherit"`, `permission_mode: "read-only"`，要求精确路径与行号 |
| 新功能 + 审查/单测 | `ext_swarm_apply_template("feature-squad")` | 写入 `worktree` → 只读 `reviewer` / `tester`（`depends_on`） |
| Bug 定位与修复 | `ext_swarm_apply_template("bug-hunt")` | 只读定位 → `worktree` 修复 → 只读复验 |
| 批量分片改造/补测 | `ext_swarm_add(tasks: [...])` | 互不重叠切片，按工作池或 `task_type` 自动轮询并发 |
| 多模型比拼 / 交叉审查 | `ext_swarm_arena` / `ext_swarm_cross_review` | 隔离 `worktree` 并行对比，或跨厂商只读复核 Diff |
| 核心架构 / 紧耦合排障 | **不委派（Coordinator 亲自做）** | 高耦合上下文反复同步易返工 |

## 标准执行流程

1. **探路建群**：
   - 先调 `ext_swarm_providers` 检查可用 CLI、`routingPolicy`、`activePool`、限流冷却（`cooldowns`）与默认超时（全局或 `1800s`/`300s`，支持硬超时后基于原会话自动收敛 1 次）；0 可用且非显式要求时直接自行完成，显式请求则调 `ext_swarm_open_board`。
   - 调用 `ext_swarm_create`（必传 `repo_root`；已知会话 ID 时传 `coordinator_conversation_id`，需要成本封顶时传可选 `max_cost_usd`）并 `ext_swarm_open_board`。
   - **并发控制**：并发 5–8 个只读审查员时可直接把 `max_concurrency` 对齐人数，避免分批排队翻倍；超时自动继承设置页配置。
2. **路由派活**：
   - `routingPolicy` 已配置时，**省略 `provider`/`model` 并传入 `task_type`**（`complex`/`coding`/`frontend`/`review`/`research`/`batch`），由路由自动选模（限流冷却中的后端会自动跳过）。
   - 每个 `brief` 须**自包含且边界聚焦**（目标、接口、验收标准；大仓审计按子系统拆细，忌跨多模块无上限通读）；写手必设 `workspace: "worktree"`（存在 `.agy-ext-swarm/worktree.json` 时自动完成环境预热与端口偏移注入）、`allowed_files`（配合 `scope_mode`: `"enforce"` 默认拦截或 `"warn"` 告警交审）、`verify_commands`（可配 `auto_verify: true`、`verify_timeout_seconds` 默认 300s 及 `max_verify_retries` 自动自愈重试），并要求汇报 `[done]` 前在分支提交。
3. **等待与止损**：
   - **零轮询后台等待（长任务推荐）**：派活后通过 `run_command`（`WaitMsBeforeAsync: 500`）执行返回结果里的 `asyncWaitCommand`（底层走内核 `fs.watch`，无 90s 上限），随后**停止调用工具结束本轮**；worker 完工时宿主将自动唤醒你继续合入（等待期 0 token、0 轮询）。若返回 `compactMode: true`，可直接并发 `read_file` 读各条 `reportPath`（`.md`）（无权时用 `ext_swarm_read(agent)`），或由只读 `synthesizer` 读这些 `reportPath` 梳理总览（重型多路审查亦可预先挂接带 `depends_on` 的 `synthesizer` 自动收口）。
   - **降级等待**：若 Terminal Sandbox 禁止访问插件数据目录（`EPERM`/`EACCES`）或只需短等数秒，改用 `ext_swarm_wait`（长任务传 `timeout_seconds: 90`，`until: "mentions_coordinator"` 或 `"all_idle"`）；引用前文直接写 `#序号`。
   - 同一报错连续 2 轮未修通，或出现越界改动、放宽断言、`as any`，立即停损：用 `ext_swarm_update_worker` 原位换模/续跑（必要时传 `reset_session: true` 清空旧会话重来）或 `ext_swarm_kill` 后自行接管。
4. **审查合入与清场**：
   - 合入前查 `ext_swarm_status(include_diff: true)` 并核验分支 Diff；用 `ext_swarm_merge` 先 `preview` 再 `apply`（或直接用 `action: "pr"` 推分支并通过 `gh` 创建 GitHub PR）。
   - 回主工作区重跑全量门禁全绿后，执行 `ext_swarm_kill(name: "all", remove_worktree: true)`。

## 按需参考（Progressive Disclosure）

- **Orchestrator（Plan/Execute）模式**：存在 `exit_plan_mode` 或收到 `[plan review]` 时读 [references/orchestrator.md](./references/orchestrator.md)。
- **高阶用法**：Arena、Cross-Review、模板/`depends_on`、`update_worker`、`dsh` Profile 或战报导出见 [references/advanced.md](./references/advanced.md)。
- **参数详情**：完整字段与默认值见各 `ext_swarm_*` MCP 工具的 JSON Schema。
