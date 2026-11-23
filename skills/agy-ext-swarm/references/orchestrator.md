# AGY Orchestrator（Plan/Execute）协同规范

当主会话运行在 AGY **Orchestrator（Planner ↔ Executor 双模型）** 模式时，形成三层算力漏斗：
- **Layer 1（Planner）**：只读调研、锁定接口与交付规格，输出可执行 Plan 后交出控制权。
- **Layer 2（Executor）**：承担建群、派活、`ext_swarm_wait` 阻塞等待、Diff 初审、合入与全量验证。
- **Layer 3（外部 CLI 集群）**：在隔离 `git worktree` 中并行编码、局部自测或只读审查。

## 1. Plan 阶段约束（存在 `exit_plan_mode`）

- **只读工具白名单**：Plan 阶段只允许调用只读探测/查询工具（`ext_swarm_providers`、`ext_swarm_models`、`ext_swarm_templates`、`ext_swarm_status`、`ext_swarm_read`、`ext_swarm_open_board`）。
- **禁止写操作**：严禁在 Plan 阶段调用 `ext_swarm_create`、`ext_swarm_add`、`ext_swarm_apply_template`、`ext_swarm_wait` 或 `ext_swarm_merge`。
- **Plan 必须携带完整执行规格**：调用 `exit_plan_mode` 前，在计划中明确写出：
  - `repo_root` 与当前会话 `coordinator_conversation_id`（防主模型遥测漂移）；
  - 每个执行器的名称、读写模式、自包含 `brief`（含接口签名）、`allowed_files`、`verify_commands`；
  - 合入顺序与终验命令；
  - `Re-plan if` 回流触发条件（连续两轮编译/测试失败、白名单越界、或合入冲突）。

## 2. `[plan review]` 回流同步（关键）

- 外部 CLI 以独立 `detached` 子进程运行，**不会**因 Executor 切回 Planner 而暂停。
- 每次从 `[plan review]` 回到 Planner 时，**必须先带原有 `swarm_id` 调用 `ext_swarm_status` / `ext_swarm_read` 同步当前进展**，禁止再次调用 `ext_swarm_create` 重复建群。

## 3. 委派门槛与主工作区顺序

- **上调委派门槛**：2–3 个简单小文件的修改优先由 AGY 原生 Executor 直接完成，不必启动 worktree。
- **先合入再改主工作区**：若任务同时包含外部 worktree 改动与 AGY Executor 直接修改主工作区核心文件，务必**先完成所有 worktree 分支的 `ext_swarm_merge(action: "apply")` 再修改主工作区**（或先将主工作区改动 commit/stash），避免未提交追踪改动触发合并安全守卫而阻断合入。
