# AGY Ext Swarm — Antigravity 外部多 CLI 协作集群插件

> **[English](./README.md)** | 中文文档

一个独立开源的 Antigravity（AGY）插件：由 Antigravity 担任 **Coordinator（架构设计 / 任务拆解 / Diff 审查 / 合入把关）**，在共享消息板上并行调度本机多种外部无头编码 CLI 执行器——内置支持 **`dsh`（DeepSeek Harness）**、**Claude Code（`claude`）**、**OpenAI Codex（`codex`）**、**Gemini CLI（`gemini`）**，并支持通过配置或内联参数接入**任意自定义 CLI 命令**。

![AGY Ext Swarm 侧边栏预览](./assets/preview.svg)

## 核心能力

- **多 CLI 模型自动发现、按任务场景路由与配置中心双子页**：支持一键探测本机缓存与 CLI 模型列表（`app_discover_models`）、复选框式模型池与 `dsh` 多供应商分组选择、按任务场景绑定模型偏好（`task_routing` / `task_type`）、配置 AGY 与外部 CLI 委派策略（`balanced` / `prefer-external` / `manual-only`）与默认运行超时，并将配置中心拆分为「CLI 与模型」和「协同与路由」双子页。
- **首次启动 CLI & 模型配置引导向导**：初次打开自动扫描本机可用 CLI，支持一步勾选启用后端、默认模型及可选读写角色池并批量保存配置。
- **免手动配置、AI 主动自动调用（`rules/AGENTS.md`）**：内置插件级常驻规则与自动编队策略，当识别到多模块并行开发、批量分片任务、只读代码调研或交叉审查时，Antigravity 会自动探测可用 CLI 并按预设/工作池直接建群派活；日常小改动或禁用插件时零打扰、自动回退。
- **可插拔外部 CLI 后端与一键预设模板**：全面兼容 macOS、Linux 与 Windows（支持 `PATHEXT` 与 `.cmd`/`.bat`），内置 **OpenCode**、**Aider**、**Qwen Code**、**Goose** 等常见开源 CLI 一键预设，以及 `custom_command` / `providers.json` 任意拓展。
- **侧边栏交互式控制台（Commander Bar）与配置中心**：无需手写工具调用或 JSON，直接在执行器页签一键新建 Swarm、启动执行器（支持 `depends_on` DAG 依赖、`allowed_files` 白名单、`verify_commands` / `auto_verify`）、从当前 Swarm 生成并套用模板、发起多模型 Arena 擂台、查看运行耗时与使用 `Kill & Clean` / `Kill All` 清理 worktree、管理 CLI 后端/单价与环境变量（`KEY=VALUE`），并提供防轮询抢焦点与多行消息输入（`Enter` 发送、`Shift+Enter` 换行）。
- **确定性 DAG 前置依赖调度（`depends_on`）**：带依赖的执行器初始进入 `blocked` 状态并屏蔽 `@all` 等提前唤醒，上游全部成功后自动注入改动摘要、消息摘要与完整 `.md` 报告路径（`reportPath`）并释放入队；上游失败或被终止时自动级联止损，防止 `wait` 死等。
- **零副作用冲突预检、安全合入与直出 PR（`ext_swarm_merge`）**：通过 `git merge-tree --write-tree` 零副作用预检分支冲突，支持按 `squash`（默认）、`cherry-pick` 或 `merge` 安全合入并可选清理 worktree；或一键调用本机 `gh` 推送分支并创建 PR（`action: "pr"` / UI「Push 并创建 PR」），自动填充改动统计、验收结果与 Cross-Review 结论。
- **多 CLI Arena 同题竞技与跨厂商自动审查**：使用不同 CLI / 模型在隔离 worktree 并行作答（`ext_swarm_arena`），在侧边栏横向对比提交数、改动文件与 Token，并一键调用另一家模型只读交叉审查（`ext_swarm_cross_review`）。
- **可复用团队编排模板（`templates.json`）**：内置 `feature-squad`、`bug-hunt`、`doc-and-test` 模板，并与全局及仓库级 `.agy-ext-swarm/templates.json` 合并。
- **共享消息板、Markdown 报告落盘与自动收敛看门狗**：追加式 `board.jsonl` 协作，内置 `max_hops` 自主跳数熔断、worker 长汇报自动落盘纯 Markdown（`reports/seq-*.md`，UI 支持一键复制路径）、设置页/UI 可调 `turn_timeout_seconds`（默认 `1800s` / 30 分钟，硬超时且保留会话时自动触发 1 次收敛续跑汇报）与静默卡死看门狗（`stall_timeout_seconds`，默认 `300s` / 5 分钟）。
- **会话持久化续跑、原位换模与一键终端接管**：支持复用 `sessionId` / `thread_id`、保留原 `git worktree` 与分支原地换模或重试，并提供 **`>_ 接管`** 一键复制本地终端接管命令，以及 `全部` / `需关注` / `运行中` / `待合并` 状态筛选条。
- **Git Worktree 预热隔离、行内 Diff 批注打回与自愈重试**：支持仓库级 `.agy-ext-swarm/worktree.json`（`copyFiles`、`symlinkDirs`、`setupCommand`、`teardownCommand` 及 `portOffsetBase`/`portOffsetStep` 自动注入 `SWARM_WORKER_INDEX` / `SWARM_PORT_OFFSET`）；`allowed_files` 与 `auto_verify: true` 支持配合 **`max_verify_retries`** 触发失败自动自愈循环；彩色 Git Diff 抽屉支持点击代码行添加**行内批注 → 一键发回 `@worker` 修复**。
- **限流冷却路由与预算上限熔断（`max_cost_usd`）**：识别到 429 / 配额用尽后自动将对应 Provider 放入临时冷却期（路由与 Failover 自动跳过并在设置页显示冷却倒计时），并支持按 Swarm 配置 `max_cost_usd` 成本上限与超额自动暂停/恢复控制。
- **主模型 + 外部集群统一监控、三层自动计费与 Markdown 战报导出**：并排统计新增输入、缓存读取与标准输入缓存命中率，兼容 **AGY Orchestrator（Plan/Execute）** 多模型拆分明细（`byModelSession` / `byModelSinceSwarm`）；内置三层自动计费引擎（CLI 原生 `total_cost_usd` 实付 + 内置主流模型基准 + 按需联网同步 **LiteLLM / OpenRouter** 公开报价目录及自定义覆盖，零后台静默联网），支持全局统一 **CNY 人民币 / USD 美元** 换算与自定义汇率，并可一键导出 Markdown 复盘报告或清理历史 Swarm。

## 支持的 CLI 执行器后端

| Provider ID | CLI 命令 | 会话续跑 | 流式事件 | 说明 |
| --- | --- | --- | --- | --- |
| `dsh` | `dsh`（`$DSH_BIN`） | `--session-id` | NDJSON（`--json`） | 支持读取 `cordis.patch.yml` 并按执行器通过 `--patch` 指定模型。 |
| `claude` | `claude`（`$CLAUDE_BIN`） | `--resume` | `stream-json` | 自动映射权限预设到 `plan` / `acceptEdits` / `--dangerously-skip-permissions`。 |
| `codex` | `codex`（`$CODEX_BIN`） | `exec resume` | JSONL（`--json`） | 调用 `codex exec` / `codex exec resume` 并传递 `--sandbox`。 |
| `gemini` | `gemini`（`$GEMINI_BIN`） | `--resume` | `stream-json` | 调用 `gemini -p --output-format stream-json`。 |
| `custom` / `<id>` | 任意可执行命令 | 可选 `resumeArgs` | `text` 或 `ndjson` | 可通过 `custom_command` 内联传入或在 `providers.json` 登记。 |

### 自动探测与 `providers.json` 配置

在 `ext_swarm_create` 未显式传 `default_provider` 时，插件按以下优先级自动选择默认后端：
1. 若 `<repo_root>/.agy-ext-swarm/providers.json` 或 `${PLUGIN_DATA}/providers.json` 中设置了 `"defaultProvider"`，优先使用；
2. 否则按 `dsh` → `claude` → `codex` → `gemini` 顺序选择本机 `PATH` 中第一个可用的内置 CLI；
3. 再否则选择第一个可用的自定义 CLI。

`providers.json` 配置示例：

```json
{
  "defaultProvider": "my-agent",
  "defaultTurnTimeoutSeconds": 1800,
  "defaultStallTimeoutSeconds": 300,
  "providers": {
    "my-agent": {
      "displayName": "我的本地编程 CLI",
      "command": "my-agent-cli",
      "args": ["--cwd", "{{cwd}}", "--model", "{{model}}", "-p", "{{prompt}}"],
      "resumeArgs": ["--cwd", "{{cwd}}", "--resume", "{{sessionId}}", "-p", "{{prompt}}"],
      "promptMode": "arg",
      "outputFormat": "text",
      "defaultModel": "default",
      "models": ["default", "fast"]
    }
  }
}
```

`args` 与 `resumeArgs` 支持的模板变量：
`{{prompt}}`、`{{model}}`、`{{cwd}}`、`{{sessionId}}`、`{{permissionMode}}`、`{{workerName}}`、`{{swarmDir}}`、`{{gitCommonDir}}`、`{{boardCli}}`。

## 安装与构建

仓库已内嵌**零运行时依赖的单文件产物**（`server/dist/index.mjs` 与 `server/dist/board.html`，无需安装 `node_modules` 或 `pnpm`），支持以下四种安装方式：

### 1. 已安装 `agy` CLI 的用户（一行命令直装仓库）

```bash
agy plugin install https://github.com/ycuwq/agy-ext-swarm
```

### 2. 仅使用 Antigravity 桌面 App 的用户 — `npx` 一键安装（推荐，跨平台）

无需 `git`、`pnpm` 或 `agy` CLI，自动将自包含插件文件复制到 `~/.gemini/config/plugins/agy-ext-swarm`（升级时保留 `.data/`）：

```bash
npx -y agy-ext-swarm install
```

常用管理命令：
```bash
npx -y agy-ext-swarm status               # 查看安装路径、版本与产物健康状态
npx -y agy-ext-swarm install --workspace  # 安装到当前项目的 .agents/plugins/（团队共享）
npx -y agy-ext-swarm uninstall            # 卸载全局插件
```

### 3. GitHub Release 一键安装 / 离线压缩包（无需 `npm`）

- **macOS / Linux**：
  ```bash
  curl -fsSL https://raw.githubusercontent.com/ycuwq/agy-ext-swarm/main/scripts/install.sh | bash
  ```
- **Windows (PowerShell)**：
  ```powershell
  irm https://raw.githubusercontent.com/ycuwq/agy-ext-swarm/main/scripts/install.ps1 | iex
  ```
- **手动离线安装**：从 [GitHub Releases](https://github.com/ycuwq/agy-ext-swarm/releases) 下载 `agy-ext-swarm.tar.gz` 或 `agy-ext-swarm.zip`，解压后将 `agy-ext-swarm/` 目录放入 `~/.gemini/config/plugins/`（或项目 `.agents/plugins/`），无需运行 `pnpm install`。

### 4. 从源码安装与开发构建（贡献者适用）

```bash
git clone https://github.com/ycuwq/agy-ext-swarm.git
cd agy-ext-swarm
node scripts/install.mjs         # 源码目录默认建软链/junction（加 --copy 复制独立产物，加 --build 强制重编）
```

手动构建：
```bash
cd agy-ext-swarm/server
pnpm install
pnpm build
```

环境要求：`Node.js >= 20`、`git`（推荐 `>= 2.38` 以支持 `git merge-tree --write-tree`），以及至少一个目标 CLI（`dsh`、`claude`、`codex`、`gemini` 或自定义命令）。

### `dsh` Profile 隔离提醒

若使用 `dsh`，严禁修改 `~/.dsh/profiles/desktop`（由桌面客户端独占锁定），自动化默认运行于 `headless`（或你在配置页指定的 profile）。当运行 profile 尚未包含 `lastCatalog` 时，插件会**只读**读取本地同级 profile（如 `desktop`）的模型目录并在启动时通过 `--patch` 透传，不改动原 profile 文件；插件内不硬编码任何供应商或默认模型。

## MCP 工具列表（共 43 个：18 模型工具 + 25 UI 专用工具）

### 模型侧工具（18 个）
- `ext_swarm_providers`：查看内置与自定义的 CLI Provider 列表、本地可用状态、全局多选工作 CLI 池（`activePool`）、协同调度策略（`routingPolicy`，含 `delegationMode`、`taskRouting`、`routingNotes`、读写分工与 `autoFailover`）、限流冷却状态（`cooldowns`）、生效默认超时（`defaultTurnTimeoutSeconds` / `defaultStallTimeoutSeconds`）及自动识别出的 `defaultProvider`。
- `ext_swarm_models`：按 `provider` 查询模型（`dsh` 读取 `cordis.patch.yml` 的 `lastCatalog`，其他后端读取配置列表）。
- `ext_swarm_create`：创建 Swarm（支持 `default_provider`、多选工作 CLI 池 `active_providers`、协同策略 `routing_policy` 含 `delegation_mode`、`task_routing`、`routing_notes`、读写分工与故障自动降级 `auto_failover`、可选 `max_cost_usd` 预算上限与 `coordinator_conversation_id`；超时自动继承全局设置页）。
- `ext_swarm_add`：启动单个执行器、多 CLI 并行镜像（传多选 `providers` 且无 `tasks`）或 `tasks` 分片池（支持 `task_type` 任务场景路由、按 `providers` 或工作池轮询/读写角色分配后端，并支持 `models_by_provider`、`workspace`、`permission_mode`、`allowed_files`、`verify_commands`、`auto_verify`、`max_verify_retries`、`depends_on` DAG 依赖与 `arena_group`）。
- `ext_swarm_post`：以 `coordinator` 身份发帖唤醒被 `@` 的执行器（不提前唤醒 `blocked` 或 `killed`），返回投递状态 `delivery`（`woken`/`deferred`/`skipped`）。
- `ext_swarm_read`：增量读取消息板（支持可选 `agent` 发送者过滤）。
- `ext_swarm_status`：查看成员状态、Diff、越界文件、`lastVerifyResults`、主模型用量汇总，并在仍有活跃成员时返回 `asyncWaitCommand`。
- `ext_swarm_wait`：在 1–90 秒内等待新消息、`@coordinator`、全部空闲或指定执行器完工（内置依赖死锁保护及 `12KB` UTF-8 自适应 `compactMode` + `reportPath` 链接）；派活类工具同时返回 `asyncWaitCommand`（基于内核 `fs.watch` 的 `ext-board wait` 与同样 `12KB` 预算），可在长任务中转后台实现 0 轮询响应式唤醒。
- `ext_swarm_update_worker`：为 `waiting`/`failed` 执行器原地更换 `provider`/`model` 或直接重试续跑，保留原 worktree 与分支。
- `ext_swarm_merge`：使用 `git merge-tree` 执行零副作用冲突预检（`action: "preview"`）、安全合入（`action: "apply"`，支持 `squash` / `cherry-pick` / `merge`），或推送分支并通过 `gh` 创建 GitHub PR（`action: "pr"`）。
- `ext_swarm_arena`：同题多 CLI/模型在隔离 worktree 中并行开发，生成分组横向擂台。
- `ext_swarm_cross_review`：自动挑选（或指定）另一厂商 CLI 对目标执行器的改动与消息执行只读交叉审查。
- `ext_swarm_templates`：查询合并内置、全局与仓库级 `.agy-ext-swarm/templates.json` 的团队编排模板。
- `ext_swarm_apply_template`：按 DAG 拓扑顺序一键实例化整套团队编排（可选自动建群并注入 `{{goal}}`）。
- `ext_swarm_kill`：终止执行器或 `all`，可选清理临时 worktree 与分支。
- `ext_swarm_delete`：终止残留进程、清理 worktree/分支并彻底删除历史 Swarm 记录。
- `ext_swarm_export`：生成 Markdown 复盘战报（含成员状态、Token/缓存、可选成本估算与完整消息轨迹）。
- `ext_swarm_open_board`：打开侧边栏 / 全局 MCP App 看板。

### UI 专用工具（25 个）
- `app_get_snapshot`、`app_post_message`、`app_kill_worker`、`app_get_worker_log`、`app_get_worker_diff`、`app_retry_worker`、`app_bind_conversation`、`app_set_ui_prefs`、`app_get_provider_config`、`app_save_provider_config`、`app_test_provider`、`app_discover_models`、`app_delete_swarm`、`app_export_swarm`、`app_preview_merge`、`app_merge_worker`、`app_create_worker_pr`、`app_create_swarm`、`app_update_swarm_budget`、`app_add_worker`、`app_start_arena`、`app_cross_review`、`app_get_templates`、`app_save_template`、`app_apply_template`。

## 贡献与安全

- 请参阅 [CONTRIBUTING.md](./CONTRIBUTING.md) 与 [SECURITY.md](./SECURITY.md)。

## 隐私与安全边界

- 主模型用量统计仅在本地**只读读取** Antigravity `transcript.jsonl`，不会写入或修改任何宿主日志，也不会向任何外部服务器上报数据。
- 在「配置」页为自定义 CLI 设置的 `env` 环境变量仅保存在本地供 UI 读写，并会在返回给主模型侧的工具中自动脱敏（`ext_swarm_providers` 仅暴露 `envKeys` 键名，内联 `custom_command.env` 值在 `add`/`status`/`update` 输出中统一遮蔽为 `***`）。
- 外部 CLI 执行器完全在本地按设定的权限模式（`read-only`、`workspace-write`、`danger-full-access`）运行。

## 自定义侧边栏 UI

UI 源码位于 `server/ui/`（`index.html`、`styles.css`、`app.ts` 入口及 `board-view.ts`/`commander.ts`/`workers-view.ts`/`graph-view.ts`/`usage-view.ts`/`onboarding-view.ts`/`settings-view.ts` 与 `i18n.ts`），修改后执行：

```bash
cd server && pnpm typecheck && pnpm build
```

然后在 Antigravity 的 **Skills & Customizations** 里关闭再重新打开 **AGY Ext Swarm**（或重启一次 Antigravity）即可加载新版界面（调试时可设 `EXT_SWARM_APP_HTML` 指向 `server/dist/board.html`）。

## 测试与发版打包

```bash
cd server
pnpm typecheck        # 服务端与 UI 类型检查
pnpm build            # 构建零依赖单文件产物 dist/index.mjs、dist/providers.mjs 与 dist/board.html
pnpm test:providers   # 离线验证多 Provider、事件解析、脱敏安全与中英文偏好（零额度消耗）
pnpm test:standalone  # 零依赖独立产物包与 HTTP/SSE 看板冒烟测试
pnpm test:smoke       # 真实 dsh 端到端冒烟测试

# 在仓库根目录校验并生成 GitHub Release 归档包与 SHA256 清单
pnpm run pack:release
```

## 开源协议

[MIT](./LICENSE)
