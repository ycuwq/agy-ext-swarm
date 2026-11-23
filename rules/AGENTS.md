# AGY Ext Swarm — Parallel CLI Router

Use `agy-ext-swarm` to speed up independent parallel work, broad read-only recon/reviews, or multi-model comparisons via local headless CLIs (read the `agy-ext-swarm` skill before calling Swarm tools).

- **Pre-flight (`ext_swarm_providers`)**: Check ready CLIs and `routingPolicy.delegationMode` / `taskRouting` / `routingNotes`. Skip implicit delegation when 0 CLIs are ready or mode is `manual-only`; `balanced` delegates multi-module/batch/review/recon tasks; `prefer-external` also delegates bounded single modules, tests, or docs.
- **Plan Mode (`exit_plan_mode` available)**: Call read-only `ext_swarm_*` tools only—put parallel worker slices in the plan and see the `agy-ext-swarm` skill's `references/orchestrator.md` on handoff or `[plan review]`.
