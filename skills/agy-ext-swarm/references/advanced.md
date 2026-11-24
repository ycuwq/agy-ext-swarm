# AGY Ext Swarm 高阶能力与配置参考

仅在使用以下高阶编排或排查特定后端配置时按需阅读：

## 1. 多模型 Arena 擂台（`ext_swarm_arena`）

- **适用场景**：高不确定性方案选型、算法/重构对比、或同一需求的多 CLI 实现择优。
- **流程**：为同一 `task` 传入 ≥2 组 `contestants`（`provider` + 可选 `model`），每个参赛者在独立 worktree 并行开发；结束后用 `ext_swarm_status(include_diff: true)`、测试结果和侧边栏 Arena 对比表择优调用 `ext_swarm_merge` 合入，其余通过 `ext_swarm_kill(..., remove_worktree: true)` 清理。

## 2. 跨厂商只读交叉审查（`ext_swarm_cross_review`）

- 自动挑选（或通过 `reviewer_provider` 指定）与 `target_worker` 不同厂商的 CLI，以 `workspace: "inherit"`、`permission_mode: "read-only"` 审计目标分支 Diff 与总结报告；若目标仍在运行会自动挂接 `dependsOn`，可传 `rubric` 定制重点检查项。

## 3. 团队模板与 DAG 前置依赖（`templates` / `depends_on`）

- `ext_swarm_templates` 合并内置模板（`feature-squad`、`bug-hunt`、`doc-and-test`）、全局 `templates.json` 与仓库 `.agy-ext-swarm/templates.json`。
- 含 `depends_on` 的执行器初始进入 `blocked` 状态并免疫 `@all` 广播唤醒；上游全部完成（`waiting` 且 `turns > 0`）后自动注入改动摘要及完整 `reportPath`（`.md`）路径并释放入队；上游失败或被终止时下游自动级联失败，防止 `ext_swarm_wait` / `ext-board wait` 死等。

## 4. 原位换模接力（`ext_swarm_update_worker`）

- 对 `waiting` 或 `failed` 状态的执行器原地切换 `provider` / `model` 并续跑重试，**完整保留已有 `git worktree` 与分支提交**（切换 CLI 后端时会自动清空旧 `sessionId` 以免会话格式冲突）。

## 5. 自定义 CLI 与 `dsh` Profile 隔离

- **自定义 CLI**：可通过 `ext_swarm_add(..., custom_command)` 或全局/项目 `providers.json` 接入任意命令，支持模板变量 `{{prompt}}`、`{{model}}`、`{{cwd}}`、`{{sessionId}}`、`{{permissionMode}}`、`{{workerName}}`、`{{swarmDir}}`、`{{gitCommonDir}}`、`{{boardCli}}`。
- **`dsh` Profile 隔离红线**：默认运行于 `headless` profile；**严禁传入或修改 `desktop`**（由桌面端独占锁定）。插件会只读读取本地/同级 profile（如 `desktop`）的 `cordis.patch.yml` 模型目录并通过 `--patch` 注入本次运行，不改动原 profile 文件。

## 6. 战报导出与历史清理

- `ext_swarm_export` 生成包含成员状态、外部集群与 AGY 主模型（含 Orchestrator 分模型）Token/缓存统计、可选费用估算及完整消息板的 Markdown 战报。
- `ext_swarm_delete` 终止残留进程、清理对应 worktree/分支并彻底删除历史 Swarm 数据。
