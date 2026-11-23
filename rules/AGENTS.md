# AGY Ext Swarm — Automatic Multi-CLI Delegation

When this plugin is enabled, do not wait for the user to manually configure workers or CLI squads. Proactively invoke the `agy-ext-swarm` skill and its `ext_swarm_*` MCP tools whenever a coding or codebase-analysis task benefits from parallel execution or model offloading:

- **Auto-trigger scenarios**:
  1. Multi-module or multi-file development/refactoring spanning 2+ independent files, adapters, or features.
  2. Feature implementation paired with tests, docs, or post-change review (`feature-squad` / `doc-and-test`).
  3. Batch repetitive fixes, test backfills, or parallelizable tasks across independent targets (`ext_swarm_add` with `tasks`).
  4. Broad read-only codebase reconnaissance/audits alongside main architectural thinking (`workspace: "inherit"`, `permission_mode: "read-only"`).
  5. Requests asking for multi-model comparison, competition, or cross-vendor code review (`ext_swarm_arena` / `ext_swarm_cross_review`).
- **Zero-setup squad composition & graceful fallback**:
  1. Start by calling `ext_swarm_providers` to inspect locally available CLIs and any user-configured `activePool` / `routingPolicy`.
  2. If zero external CLI providers are available on the machine: for implicit tasks, silently handle the task directly without mentioning or forcing `agy-ext-swarm`; if the user explicitly asked to use or configure `agy-ext-swarm`, call `ext_swarm_open_board` to surface the built-in setup wizard and guide them to enable or add a CLI.
  3. Otherwise, automatically select the right squad template or worker DAG (`ext_swarm_apply_template`, or `ext_swarm_create` + `ext_swarm_add`), omit per-worker `provider` whenever an active pool/routing policy covers the role so load-balancing and `autoFailover` work automatically, and call `ext_swarm_open_board` so progress is live-visible.
- **Avoid over-orchestrating small tasks**: Do NOT spin up external CLIs or worktrees for quick Q&A, single-file minor edits, simple one-off commands, or tightly coupled single-thread debugging.
- **Orchestrator / Plan-Execute mode compatibility**:
  1. **Plan phase (`exit_plan_mode` available)**: ONLY invoke read-only inspection tools (`ext_swarm_providers`, `ext_swarm_models`, `ext_swarm_templates`, `ext_swarm_status`, `ext_swarm_read`). Do NOT call `ext_swarm_create`, `ext_swarm_add`, `ext_swarm_apply_template`, `ext_swarm_wait`, or `ext_swarm_merge` in Plan Mode; instead, specify the full swarm plan (`repo_root`, `coordinator_conversation_id`, worker names, self-contained `brief`s, `allowed_files`, `verify_commands`, merge order, and `Re-plan if` triggers for 2-round stop-loss, out-of-scope edits, or merge conflicts) and hand off via `exit_plan_mode` so the execution model handles spawning, waiting, and merging.
  2. **`[plan review]` hand-backs**: Detached CLI workers keep running across Planner/Executor switches. Always sync state via `ext_swarm_status` / `ext_swarm_read` using the existing `swarm_id` before revising the plan, and never duplicate `ext_swarm_create`.
  3. **Raised threshold in Orchestrator mode**: Let AGY's fast execution model directly edit 2–3 small straightforward files; reserve `agy-ext-swarm` for genuinely parallel multi-module work, large sharded batches, long-running tasks, multi-model Arena/Cross-Review, or quota offloading.
  4. **Working-tree ordering**: Avoid uncommitted tracked edits in the main repo before `ext_swarm_merge(action: "apply")` — either merge worktree branches before editing the main repo, or commit/stash main-repo edits first.
