---
name: agy-ext-swarm
description: >-
  并行调度本机外部编码 CLI 在隔离 git worktree 协同开发、批量分片、只读调研或跨模型对比审查；适用于 ≥2 个独立模块/批量任务或显式多模型协作，单文件小改不启用。
---

# AGY Ext Swarm 协调者（Coordinator）SOP

你是 **Coordinator**，负责把可并行/可分摊工作交给本机外部无头 CLI（`dsh`、`claude`、`codex`、`gemini` 或自定义 CLI），自身保持上下文精炼并把控架构、Diff 审查、全量终验与合入。

## 场景路由速查

| 场景 | 推荐入口 | 关键约束 |
| --- | --- | --- |
| 只读调研 / 排查 | `ext_swarm_add`（1–N 个只读） | `workspace: "inherit"`, `permission_mode: "read-only"`，要求精确路径与行号 |
| 新功能 + 审查/单测 | `ext_swarm_apply_template("feature-squad")` | 写入 `worktree` → 只读 `reviewer`（`depends_on`） |
| Bug 定位与修复 | `ext_swarm_apply_template("bug-hunt")` | 只读定位 → `worktree` 修复 → 只读复验 |
| 批量分片改造/补测 | `ext_swarm_add(tasks: [...])` | 互不重叠的切片目标，按工作池自动轮询并发 |
| 多模型比拼 / 交叉审查 | `ext_swarm_arena` / `ext_swarm_cross_review` | 隔离 worktree 并行对比后择优合入 |
| 核心架构 / 紧耦合排障 | **不委派（Coordinator 亲自做）** | 外部无头执行器易反复返工 |

## 标准执行流程

1. **探路建群**：调用 `ext_swarm_providers` 检查可用 CLI、`globalConfigExists`/`needsOnboarding` 及 `activePool`/`routingPolicy`（0 可用时隐式任务直接回退，显式请求则调 `ext_swarm_open_board`）。随后调用 `ext_swarm_create`（传入 `repo_root`，已知当前会话 ID 时显式传 `coordinator_conversation_id`）并调用 `ext_swarm_open_board`。
2. **路由派活**：若 `activePool`/`routingPolicy` 已覆盖对应读写角色，创建执行器时**省略 `provider`**，自动走负载均衡与 `auto_failover`；为每个执行器编写**自包含** `brief`（目标、接口签名、`[done]` 验收标准），写手必传 `workspace: "worktree"`、`allowed_files`、`verify_commands`，并要求汇报 `[done]` 前在分支提交改动。
3. **优雅等待**：派活或追问后用 `ext_swarm_wait`（建议 `timeout_seconds <= 45`，`until: "mentions_coordinator"` 或 `"all_idle"`）阻塞等待，禁止空转轮询；引用前文消息直接写 `#序号`。
4. **两轮止损**：同一编译/测试错误连续 2 轮未修通，或出现越界修改、放宽测试断言、`as any` 绕过类型检查，立即停损——用 `ext_swarm_update_worker` 原位换模重试，或 `ext_swarm_kill` 后由 Coordinator 接管。
5. **审查合入与清场**：合入前跑 `ext_swarm_status(include_diff: true)` 并核查 `git diff HEAD..<branch>`；用 `ext_swarm_merge` 先 `preview` 再 `apply`；在主工作区亲自重跑全量测试/门禁全绿后，执行 `ext_swarm_kill(name: "all", remove_worktree: true)`。

## 按需参考（Progressive Disclosure）

- **Orchestrator（Plan/Execute）模式**：存在 `exit_plan_mode` 或收到 `[plan review]` 时必读 [references/orchestrator.md](./references/orchestrator.md)。
- **高阶用法**：使用 Arena 对比、Cross-Review、模板/`depends_on`、`update_worker` 换模、自定义 CLI/`dsh` Profile 隔离或战报导出时，再读 [references/advanced.md](./references/advanced.md)。
- **工具参数**：完整字段与默认值见各 `ext_swarm_*` MCP 工具的 JSON Schema。
