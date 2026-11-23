# AGY Ext Swarm — Delegation Router

When a task fits external multi-CLI parallelism, **read the `agy-ext-swarm` skill first** before acting:

- **Trigger**: ≥2 independent modules, feature + review/tests, sharded batches, broad read-only recon, or multi-model Arena/cross-review.
- **Skip**: Q&A, minor single-file edits, tightly coupled debugging, or (in Orchestrator mode) 2–3 small files better handled by AGY's executor.
- **Pre-flight (`ext_swarm_providers`)**: If 0 CLIs are ready, silently handle implicit tasks yourself; on explicit user requests to use/configure the swarm, call `ext_swarm_open_board` for the setup wizard.
- **Plan Mode (`exit_plan_mode` available)**: Call read-only `ext_swarm_*` tools only—never create, spawn, wait, or merge in Plan Mode. Put full specs in the plan; see `skills/agy-ext-swarm/references/orchestrator.md` on handoff or `[plan review]`.
