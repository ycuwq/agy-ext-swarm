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
  2. If zero external CLI providers are available on the machine, silently handle the task directly without mentioning or forcing `agy-ext-swarm`.
  3. Otherwise, automatically select the right squad template or worker DAG (`ext_swarm_apply_template`, or `ext_swarm_create` + `ext_swarm_add`), omit per-worker `provider` whenever an active pool/routing policy covers the role so load-balancing and `autoFailover` work automatically, and call `ext_swarm_open_board` so progress is live-visible.
- **Avoid over-orchestrating small tasks**: Do NOT spin up external CLIs or worktrees for quick Q&A, single-file minor edits, simple one-off commands, or tightly coupled single-thread debugging.
