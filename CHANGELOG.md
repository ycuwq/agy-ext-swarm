# Changelog

All notable changes to **AGY Ext Swarm** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.1] - 2026-11-27

### Added

- **Built-In `review-loop` Closed-Loop Template (`server/src/templates.ts`)**: Added a vendor-neutral `Review Loop (Implement <-> Cross-Review)` built-in template pairing an isolated worktree `impl` (`Feature Implementer`, `scopeMode: "warn"`, `autoVerify: true`, `verifyTimeoutSeconds: 300`, `maxVerifyRetries: 2`) with a read-only `reviewer` (`Architecture Reviewer`, `dependsOn: ["impl"]`) using a 4-state verdict protocol (`VERDICT: PASS` / `FIX` / `ROLLBACK` / `NEEDS_HUMAN`) with automatic `routingPolicy.taskRouting` (`coding` / `review`) and anti-mention instructions preventing accidental `@impl` re-wakes on non-`FIX` verdicts.
- **Per-Worker Template Overrides (`allowed_files_overrides` & `verify_commands_overrides`)**: Extended `ApplyTemplateOptions`, `ext_swarm_apply_template`, and `app_apply_template` so callers can inject project-specific `allowed_files` whitelists and `verify_commands` into generic templates such as `review-loop` without hardcoding project commands.

### Fixed

- **UI Template Capture Field Preservation (`server/ui/commander.ts`)**: Updated "From Current Swarm" template capture (`tplFromSwarmBtn`) to preserve `scopeMode`, `verifyTimeoutSeconds`, `maxVerifyRetries`, and `turnTimeoutSeconds`.
- **Peer-Wake Self-Heal Retry Reset (`server/src/runner.ts`)**: Reset `verifyRetriesUsed = 0` when a worker is woken by any external board message (`msg.agent !== targetName`), ensuring rework rounds triggered by `@reviewer` (`VERDICT: FIX`) retain their full `auto_verify` self-heal retry allowance.
- **Template & Closed-Loop Regression Coverage (`server/test/providers.test.mjs`)**: Added tests verifying custom `templates.json` field preservation and numeric clamping, `review-loop` auto-routing, `allowed_files_overrides` / `verify_commands_overrides`, and the end-to-end `self-heal -> FIX -> scope_mode=warn -> PASS` closed loop.

## [0.8.0] - 2026-11-27

### Added

- **Built-In Antigravity CLI (`agy`) Provider (`server/src/providers/agy.ts`)**: Added first-class `agy` provider support using `--input-format stream-json --output-format stream-json`, `--conversation` session resume, `--effort` / display-label tier handling, terminal takeover commands (`server/shared/takeover.ts`), sandboxed read-only review (`--mode plan`, `--sandbox`, `--add-dir` for `swarmDir`/`gitCommonDir`), and async `agy models` discovery fallback in `ext_swarm_models` when the local cache is empty.
- **Cross-CLI Reasoning Effort & Fast Mode (`server/shared/model-options.ts`, `server/ui/model-options-ui.ts`)**: Added `reasoning_effort` and `fast_mode` controls across `agy`, `claude`, `codex`, `dsh`, and custom CLI templates (`{{reasoningEffort}}`, `{{fastMode}}`, and conditional flags `{{?model:--flag}}` / `{{?reasoningEffort:--flag}}` / `{{?fastMode:--flag}}`), wired through MCP schemas, task-scene routing, templates, Onboarding, Settings, Commander, and Worker cards.
- **Resolved Default Model & Effort Observability**: Automatically records and surfaces each provider's actual runtime default model and effective reasoning effort / fast mode across Settings, Onboarding, Commander selectors, and Worker cards (`observedDefaultModel` / `effectiveDefaultModel` / `defaultReasoningEffort` / `defaultFastMode`).
- **Nested-Worker Recursion Guard & Verification Controls**:
  - Added a hard environment guard (`assertNotNestedWorker`) rejecting mutating `ext_swarm_*` and `app_*` orchestration tools whenever `EXT_SWARM_AGENT` or `DSH_SWARM_AGENT` is set.
  - Added configurable `verify_timeout_seconds` (default `300s`, range `10–1800s`) for `auto_verify` commands.
  - Added `scope_mode: "enforce" | "warn"` for `allowed_files` so out-of-scope edits can either trigger self-heal retries (`enforce`) or warn the coordinator for contextual review (`warn`).
  - Added `reset_session: true` to `ext_swarm_update_worker` to clear a worker's stored CLI session ID in place while preserving its worktree and branch.

### Changed

- **UI Bundle Size Optimization (`server/build.mjs`)**: Deduplicated `zod/v4` across `@modelcontextprotocol/ext-apps` and trimmed unused locale tables during UI bundling, keeping `server/dist/board.html` well under the 1 MiB MCP App budget.
- **Shared UI & Runtime Modularization**: Extracted shared model-option UI helpers (`server/ui/model-options-ui.ts`) and file tail helper (`server/src/tail-file.ts`), unified provider spawn command construction (`buildSpawnCommand`), and synced `SKILL.md`, `references/advanced.md`, `rules/AGENTS.md`, `README.md`, `README.zh-CN.md`, and `CONTRIBUTING.md`.

### Fixed

- **Security, Worktree & Process Hardening**: Fixed worktree/hook safety and cleanup paths, hardened `agy` read-only config guidance (`~/.gemini/antigravity-cli/settings.json`), improved installer `.data/` preservation and rollback on symlink/copy fallback (`scripts/install.mjs`), and stabilized `runner-process` / `worktree` / `host` brain-index edge cases.
- **Concurrent Wait & Lifecycle Accuracy**: Tracked explicit `swarm.deleting` state so concurrent `ext_swarm_wait` and `ext-board wait` callers distinguish `swarm_deleted` from `all_workers_killed`, scoped observed provider default recording by profile, and kept `dsh` model lookups free of side-effectful plugin checks when listing models.
- **Board UI & Accessibility Audit Fixes**: Hardened XSS escaping, focus/scroll preservation, modal/drawer keyboard & interaction states, pricing/usage rendering, graph/timeline views, and bilingual (`zh` / `en`) strings across `server/ui/*`, backed by expanded regression coverage in `server/test/providers.test.mjs`.

## [0.7.0] - 2026-11-26

### Added

- **Read-Only Native Antigravity Subagent Observability (`server/src/host/*`)**: Discovers native Antigravity subagents via `.system_generated/subagents/*.json`, incremental byte-offset `transcript.jsonl` parsing, `.system_generated/messages/*.json` reply tracking, and optional `ConversationService` live run-state calibration; adds read-only `app_get_native_subagent_log` tool and `HostTelemetrySnapshot` domain model.
- **Unified Workers View, Wave Scoping & Inline Conversation Switcher**: Displays external CLI workers and read-only `AGY Native` subagents side by side with `All` / `External CLIs` / `Native` source filters, `Current Wave` / `All History` wave scoping, live elapsed timers, current tool activity, reply previews, unified Event Stream Drawer inspection (including `SYSTEM_MESSAGE` prompts), and an inline conversation switcher (usable even without an active external swarm).
- **Dual-Track Topology Graph & Parallel Swimlane Timeline**: Renders read-only native subagent nodes and dispatch/reply edges in the interactive topology graph, plus a toggleable **Swimlanes** timeline view plotting external CLI workers and native subagents on a shared horizontal time axis.
- **3-Way Token & Cost Attribution + Markdown Report Upgrade**: Extends Usage gauges, split bar, pricing model discovery, and `ext_swarm_export` Markdown reports to attribute tokens, cache hit rates, and costs across **AGY Main Model (Coordinator)**, **Native Subagents**, and **External CLI Workers**.
- **Host Telemetry Test Suite (`test:host`)**: Added `server/test/host-telemetry.test.mjs` and wired it into root scripts, CI, and Release workflows.

### Changed

- Replaced legacy `server/src/coordinator-usage.ts` and `SwarmSnapshot.coordinatorUsage` / `availableConversations` with the cohesive `server/src/host/` layer and `SwarmSnapshot.hostTelemetry` contract; updated `app_bind_conversation` to persist `observedConversationId` even without an active swarm.

### Fixed

- **Top-Level Conversation Auto-Selection**: Filtered child subagent directories out of `availableConversations` and auto-resolved child IDs back to their root parent conversation so active subagents no longer hijack the main conversation selector.
- **Host Transcript Performance & Edge Cases**: Added 16 KB head-only title scanning (`readTranscriptTitleHead`), increased transcript/message caches (`256` / `128`), handled `SYSTEM_MESSAGE`-based native subagent turns, guarded `sinceSwarmStart` with `inCurrentSwarm`, fixed nested workers grid layout, and escaped hover reply previews in the graph view.

## [0.6.0] - 2026-11-24

### Added

- **Worktree Hydration & Port Isolation (`.agy-ext-swarm/worktree.json`)**: Supports automatic file copying (`copyFiles`), directory symlinks/junctions (`symlinkDirs`), `setupCommand` / `teardownCommand` hooks, and per-worker port isolation (`portOffsetBase`, `portOffsetStep`) via `SWARM_WORKER_INDEX` and `SWARM_PORT_OFFSET`.
- **Inline Diff Line Comments → Fix Dispatch**: Added clickable line numbers and inline comment threads in the Worker Diff drawer to batch-send targeted fix instructions directly to `@worker`.
- **Self-Heal Verification Loop (`max_verify_retries`)**: Automatically feeds `auto_verify` command failures or `allowed_files` out-of-scope edits back to the worker up to `max_verify_retries` times before marking attention needed, resetting on manual retries or coordinator follow-ups.
- **Provider Cooldown Routing & Swarm Budget Guardrails (`max_cost_usd`)**: Detects rate-limit/quota errors to place providers on temporary cooldown (`EXT_SWARM_COOLDOWN_SECONDS`, default `900s`) with automatic failover skipping and manual Settings clear support; adds per-swarm `max_cost_usd` budget caps, `app_update_swarm_budget`, pause/resume, and one-click `Raise +50%` controls.
- **One-Click Terminal Takeover & Worker Filters**: Added `server/shared/takeover.ts` and `>_ Takeover` copy button to resume a worker's worktree/session locally, plus Workers status filter chips (`All` / `Attention` / `Running` / `Ready to Merge`).
- **Direct GitHub PR Creation (`ext_swarm_merge(action: "pr")`)**: Added `app_create_worker_pr` and `buildWorkerPrBody` to push a worker branch and open a pre-filled PR via `gh pr create` with diff stats, verification results, and Cross-Review summaries.

### Changed

- **Modular Refactor & UI Polish**: Extracted `server/src/worktree-hooks.ts` and `server/src/runner-guardrails.ts`, eliminated the circular import in `server/src/runner-merge.ts`, preserved Diff drawer scroll position with `Cmd/Ctrl+Enter` comment submission, consolidated secondary worker card actions into a `···` popover menu, and added filter chip state highlights plus PR link copy actions.

## [0.5.0] - 2026-11-24

### Added

- **3-Layer Automatic Model Cost Tracking & Catalog Sync**:
  - **Layer 1 (CLI Actuals)**: Captures `total_cost_usd` from `claude` CLI `result` events (`reportedCostUsd`) and accumulates per-worker actual spend automatically.
  - **Layer 2 (Shared Pricing Engine & On-Demand Public Catalogs)**: Built-in USD per-1M baseline rates (`BUILTIN_MODEL_PRICING`) for major models (Claude, GPT / o-series, Gemini, DeepSeek, Qwen, GLM, Kimi, MiniMax, Grok) plus opt-in on-demand sync from **LiteLLM** (`model_prices_and_context_window.json`) and **OpenRouter** (`/api/v1/models`) cached in `pricing-catalog.json` with `mtimeMs`/`size` indexing and zero automatic background network requests.
  - **Layer 3 (Fuzzy Normalization & Unified Currency)**: Strips provider prefixes (`workbuddy/`, `openrouter/`, `azure_ai/`, `anthropic.`), date stamps, `[1m]` context tags, and reasoning effort suffixes (`-xhigh`, `-high`, `-medium`, `-low`, `-thinking`), previews auto-matched active rates with one-click overrides, surfaces clickable unpriced-model chips in Usage & Settings, and adds global **AUTO / CNY (¥) / USD ($)** unified display currency with configurable `USD → CNY` FX rate (default `7.2`) across UI & Markdown exports.
- **Zero-Polling Board Watcher (`ext-board wait`) & Compact Wait Mode**:
  - Event-driven `fs.watch` wait command in `ext-board.mjs` with `asyncWaitCommand` hints and `compact` response mode in `ext_swarm_wait`.
- **Hard-Timeout Auto-Converge & Per-Worker Timeouts**:
  - Raised default timeouts (`turn_timeout_seconds: 1800`, `stall_timeout_seconds: 300`), added configurable global & per-worker turn timeouts (`Settings` UI + MCP schemas), surfaced `post` delivery visibility, and added 1 automatic session-resumed convergence turn on hard timeout.
- **Markdown Worker Report Persistence & Upstream `reportPath`**:
  - Automatically saves unescaped worker reports (`reports/seq-*.md`), injects upstream `reportPath` references into downstream `depends_on` prompts, and adds one-click `.md` path copy badges on the Board UI.
- **Release Notes Automation**:
  - Added `CHANGELOG.md` backfill and wired automated release-note extraction into `.github/workflows/release.yml`.

### Changed

- **Modular Runtime & UI Architecture**:
  - Decomposed `server/src/runner.ts` into focused modules (`runner-turn.ts`, `runner-merge.ts`, `runner-deps.ts`, `runner-orchestration.ts`, `runner-prompts.ts`, `runner-process.ts`) and split `server/ui/app.ts` into `board-view.ts`, `commander.ts`, `workers-view.ts`, `usage-view.ts`, `settings-view.ts`, `pricing-view.ts`, and `onboarding-view.ts`.
  - Enabled strict `noUnusedLocals: true` in `server/tsconfig.json`.
  - Relaxed worker name length constraints and streamlined orchestrator/worker prompts & schemas.
  - Updated `README.md`, `README.zh-CN.md`, and `scripts/install.*` Antigravity 2.0 plugin reload guidance.

### Fixed

- **Windows CI Compatibility**: Added `.cmd` wrapper shims in `server/test/providers.test.mjs` for mock `dsh` CLI scripts and retry-safe temp cleanup so `windows-latest` CI runs execute without shebang failures.
- **UI & Tool Consistency**: Attached pricing catalog metadata in `app_discover_models` responses, switched `app_save_provider_config` annotations to `WRITE_EXTERNAL_ANNOTATIONS`, guarded currency/FX inputs against background polling focus theft, and alerted clearly if an older MCP server process returns no catalog.

### Performance

- Cached parsed `pricing-catalog.json` entries and compiled regex/base-name lookup indices by file `mtimeMs` + `size`, eliminating repeated full-catalog parsing during 2-second UI snapshot polling.

## [0.4.1] - 2026-11-23

### Changed

- Modularized model discovery, provider config storage, and runner helper utilities (`server/src/models/*`, `server/src/providers/*`, `server/src/runner-*`).

### Fixed

- **dsh Integration & Profile Diagnostics**: Fixed `--patch` CLI flag ordering for `dsh`, added sibling profile plugin readiness checks (`checkDshProfileProviderPlugin`, `checkDshProfileCatalogPlugins`), and overlaid sibling catalog model definitions safely without leaking credentials.

## [0.4.0] - 2026-11-23

### Added

- **Multi-CLI Model Auto-Discovery & Task-Scene Routing**: Added `app_discover_models` local cache & CLI model probing, multi-provider `dsh` grouped selection, task-scene routing matrix (`task_routing` / `task_type`), and orchestrator delegation modes (`balanced` / `prefer-external` / `manual-only`).
- **Settings Sub-Tabs**: Split Settings UI into `CLIs & Models` and `Orchestration & Routing` sub-tabs.

### Fixed

- Hardened security boundaries, runtime stability, CLI adapters, and board UI edge cases.

## [0.3.0] - 2026-11-23

### Added

- **First-Time Onboarding Wizard**: Auto-launches on first run to probe installed CLIs, pick default models, optionally split Writer/Reader pools, and persist configuration in one batch.
- **AGY Orchestrator (Plan/Execute) Telemetry**: Added multi-model breakdown tracking (`byModelSession` / `byModelSinceSwarm`) alongside external worker usage.
- **UI & Board Guardrails**: Added adaptive topology polish, worker guards, modularized MCP tool registration, and progressive skill documentation.

### Fixed

- Redacted environment secrets from model-facing tool outputs and hardened UI/worktree synchronization.

## [0.2.0] - 2026-11-23

### Added

- **Initial Public Release**: Zero-dependency bundled MCP server (`dist/index.mjs`) + self-contained MCP App UI (`dist/board.html`) with cross-platform distribution via `npx agy-ext-swarm` and GitHub Release archives.
- **Always-On Auto-Delegation Rule (`rules/AGENTS.md`)**: Guides Antigravity to orchestrate parallel multi-CLI squads (`dsh`, `claude`, `codex`, `gemini`, and custom CLIs) with isolated `git worktree` branches, DAG `depends_on`, conflict-free `git merge-tree` previews, and bilingual (`中 / EN`) side-pane board.

[0.8.1]: https://github.com/ycuwq/agy-ext-swarm/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/ycuwq/agy-ext-swarm/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/ycuwq/agy-ext-swarm/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/ycuwq/agy-ext-swarm/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/ycuwq/agy-ext-swarm/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/ycuwq/agy-ext-swarm/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/ycuwq/agy-ext-swarm/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ycuwq/agy-ext-swarm/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ycuwq/agy-ext-swarm/releases/tag/v0.2.0
