# AGY Orchestrator（Plan/Execute）协同说明

在 Orchestrator 模式下，`agy-ext-swarm` 只定位为**执行阶段的并行加速补充**：Planner 负责架构规划与把关，Executor 将计划中可独立拆分的任务并行交给外部 CLI 提速，不额外引入复杂分权流程。仅需遵守以下 3 条外部子进程约束：

1. **Plan 阶段只读**：存在 `exit_plan_mode` 时仅调用只读探测/查询工具（`ext_swarm_providers`/`models`/`templates`/`status`/`read`/`open_board`），禁止建群、派活、`wait` 或合入；将并行任务列表（`repo_root`、worker 边界、`allowed_files`、`verify_commands`）及终验命令写入 Plan 再交出执行权。
2. **`[plan review]` 复用原 `swarm_id`**：外部 CLI 以独立 `detached` 子进程运行，**不会**随切回 Planner 而暂停。回到 Planner 时先带原有 `swarm_id` 调 `ext_swarm_status` / `ext_swarm_read` 同步进展，**禁止重复 `ext_swarm_create`**；若成员仍在健康推进（`working`/`queued` 且步数正常），直接简要确认并调用 `exit_plan_mode` 放行继续等待。
   - *等待建议*：Executor 派活后优先用 `run_command(asyncWaitCommand, WaitMsBeforeAsync: 500)` 并结束本轮等待宿主响应式唤醒，可避免反复调 `ext_swarm_wait` 消耗 Executor 步数并提前触发周期性 `[plan review]`。
3. **先合入 worktree 再改主工作区**：若 Executor 既要合入外部 `worktree` 分支又要在主工作区直接改核心文件，必须**先完成 `ext_swarm_merge(action: "apply")`（或先 commit/stash 主工作区）**再改主工作区，避免未提交追踪改动触发合并安全守卫。
