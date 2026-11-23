# AGY Ext Swarm — External Multi-CLI Agent Swarm Plugin for Antigravity

> **[中文文档](./README.zh-CN.md)** | English

An open-source Antigravity (AGY) plugin that lets Antigravity act as the **Coordinator** (architect, task splitter, diff reviewer, and merger) while orchestrating external headless coding CLI workers across **`dsh` (DeepSeek Harness)**, **Claude Code (`claude`)**, **OpenAI Codex (`codex`)**, **Gemini CLI (`gemini`)**, or **any custom CLI command** over a shared message board.

![AGY Ext Swarm Side-Pane Preview](./assets/preview.svg)

## Key Capabilities

- **Zero-Setup AI Auto-Delegation (`rules/AGENTS.md`)**: Includes an always-on plugin rule that guides Antigravity to automatically compose and launch CLI squads for multi-module coding, batch tasks, broad research, or cross-review without manual squad setup—while staying out of the way for small single-file edits or when disabled.
- **Pluggable External CLI Providers & One-Click Presets**: Auto-detects available CLIs across macOS, Linux, and Windows (`PATH`/`PATHEXT`), with one-click templates for popular coding CLIs (**OpenCode**, **Aider**, **Qwen Code**, **Goose**) plus inline `custom_command` or `providers.json`.
- **Interactive UI Commander & Settings**: Create swarms, launch workers (with `depends_on` DAG dependencies), start Multi-CLI Arenas, apply Team Playbook Templates, configure CLI binaries/models/pricing, and preview/merge worktrees directly from the side-pane UI.
- **Deterministic DAG Orchestration (`depends_on`)**: Downstream workers queue as `blocked`, ignore premature `@all` / peer wakes, unlock automatically with upstream diffs & board summaries once dependencies succeed, and fail safely without deadlock if upstream breaks.
- **Zero-Side-Effect Conflict Preview & Safe Merge (`ext_swarm_merge`)**: Uses `git merge-tree --write-tree` to detect conflicts without touching the working tree, then merges cleanly via `squash`, `cherry-pick`, or `merge` with automatic abort-on-error and optional worktree cleanup.
- **Multi-CLI Arena & Cross-Vendor Auto Review**: Race 2+ CLI backends in parallel isolated worktrees (`ext_swarm_arena`), compare commits/diff/tokens side by side, and trigger another CLI vendor to perform a read-only audit (`ext_swarm_cross_review`).
- **Reusable Team Templates (`templates.json`)**: Ships with built-in playbooks (`feature-squad`, `bug-hunt`, `doc-and-test`) merged with global/repo `templates.json`.
- **Shared Message Board, Timeouts & Watchdog**: Append-only `board.jsonl` with `@name`, `@group`, `@all`, `@coordinator`, `max_hops`, hard `turn_timeout_seconds`, and silence `stall_timeout_seconds` watchdog.
- **Session Resume & In-Place Switch / Retry**: Captures `sessionId` / `thread_id` across follow-up wakes and lets you retry failed workers or switch their `provider` / `model` in place while preserving their existing `git worktree` and branch.
- **Git Worktree Isolation, Colored Diff Drawer & Auto Verify**: Parallel writers run in isolated `git worktree` branches (`ext-swarm/<swarmId>/<worker>`); optional `allowed_files` whitelists check out-of-scope edits mechanically, `auto_verify: true` deterministically runs `verify_commands` host-side after each turn, and the Workers tab includes a full colored Git Diff drawer.
- **Unified Token, Cache & Cost Telemetry + Markdown Export**: Tracks **AGY Main Model** and **External CLI Workers** side-by-side (`cacheRead / (input + cacheRead)`), calculates optional estimated costs when model rates are set, and supports exporting full Markdown post-mortem reports (`ext_swarm_export`) or cleaning up historical swarms (`ext_swarm_delete`).
- **Bilingual Side-Pane MCP App (`中 / EN`)**: Interactive Board, curved Bezier Graph & Replay scrubber (with DAG edges), Workers Commander + Event/Diff/Merge Drawers, Usage Dashboard, and Settings Center.

## Supported CLI Providers

| Provider ID | CLI Command | Session Resume | Streaming Events | Notes |
| --- | --- | --- | --- | --- |
| `dsh` | `dsh` (`$DSH_BIN`) | `--session-id` | NDJSON (`--json`) | Supports `--patch` per-worker model overrides via `cordis.patch.yml`. |
| `claude` | `claude` (`$CLAUDE_BIN`) | `--resume` | `stream-json` | Maps permission presets to `plan` / `acceptEdits` / `--dangerously-skip-permissions`. |
| `codex` | `codex` (`$CODEX_BIN`) | `exec resume` | JSONL (`--json`) | Runs `codex exec` / `codex exec resume` with `--sandbox`. |
| `gemini` | `gemini` (`$GEMINI_BIN`) | `--resume` | `stream-json` | Runs `gemini -p --output-format stream-json`. |
| `custom` / `<id>` | Any executable | Optional `resumeArgs` | `text` or `ndjson` | Inline via `custom_command` or defined in `providers.json`. |

### Auto-Detection & `providers.json`

When `default_provider` is omitted in `ext_swarm_create`, AGY Ext Swarm automatically picks:
1. `"defaultProvider"` from `<repo_root>/.agy-ext-swarm/providers.json` or `${PLUGIN_DATA}/providers.json`, if set;
2. Otherwise the first built-in CLI found on `PATH` (`dsh` -> `claude` -> `codex` -> `gemini`);
3. Otherwise the first available custom provider.

Example `providers.json`:

```json
{
  "defaultProvider": "my-agent",
  "providers": {
    "my-agent": {
      "displayName": "My Local Coding CLI",
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

Supported template variables in `args` / `resumeArgs`:
`{{prompt}}`, `{{model}}`, `{{cwd}}`, `{{sessionId}}`, `{{permissionMode}}`, `{{workerName}}`, `{{swarmDir}}`, `{{gitCommonDir}}`, `{{boardCli}}`.

## Installation & Build

The repository ships **zero-dependency self-contained runtime bundles** (`server/dist/index.mjs` and `server/dist/board.html`, requiring no `node_modules` or `pnpm` at runtime). Choose any of the following installation methods:

### 1. For `agy` CLI Users (Direct Repository Install)

```bash
agy plugin install https://github.com/ycuwq/agy-ext-swarm
```

### 2. For Antigravity Desktop App Users — `npx` One-Command Install (Recommended, Cross-Platform)

Requires only `Node.js >= 20` (no `git`, `pnpm`, or `agy` CLI needed). Automatically copies the self-contained plugin into `~/.gemini/config/plugins/agy-ext-swarm` while preserving `.data/` across upgrades:

```bash
npx -y agy-ext-swarm install
```

Useful management commands:
```bash
npx -y agy-ext-swarm status               # Inspect install path, version, and bundle health
npx -y agy-ext-swarm install --workspace  # Install into ./.agents/plugins for team/repo sharing
npx -y agy-ext-swarm uninstall            # Uninstall the global plugin
```

### 3. GitHub Release One-Liners & Offline Archives (No `npm` Required)

- **macOS / Linux**:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/ycuwq/agy-ext-swarm/main/scripts/install.sh | bash
  ```
- **Windows (PowerShell)**:
  ```powershell
  irm https://raw.githubusercontent.com/ycuwq/agy-ext-swarm/main/scripts/install.ps1 | iex
  ```
- **Manual Offline Install**: Download `agy-ext-swarm.tar.gz` or `agy-ext-swarm.zip` from [GitHub Releases](https://github.com/ycuwq/agy-ext-swarm/releases) and extract the `agy-ext-swarm/` folder into `~/.gemini/config/plugins/` (or `.agents/plugins/`). No `pnpm install` step is needed.

### 4. From Source (Contributors & Local Development)

```bash
git clone https://github.com/ycuwq/agy-ext-swarm.git
cd agy-ext-swarm
node scripts/install.mjs         # Symlink/junction from git checkout (--copy for standalone copy, --build to rebuild)
```

Manual build:
```bash
cd agy-ext-swarm/server
pnpm install
pnpm build
```

Requirements: `Node.js >= 20`, `git` (`>= 2.38` recommended for `git merge-tree --write-tree`), and at least one CLI provider (`dsh`, `claude`, `codex`, `gemini`, or a custom command).

### Notes on `dsh` Profile Isolation

If using `dsh`, never modify `~/.dsh/profiles/desktop` (locked by the desktop client). Configure your chosen `headless` (or custom) profile via `dsh` (and ensure any desired model catalog entries are populated in `~/.dsh/profiles/<profile>/cordis.patch.yml` or configured in the **Settings** tab / `providers.json`). Nothing is vendor-hardcoded in `agy-ext-swarm`; when no profile model is detected or configured, `dsh` runs with its own CLI defaults.

## MCP Tools (40 Total: 18 Model + 22 App-Only)

### Model Tools (18)
- `ext_swarm_providers`: Inspect available built-in & custom CLI providers, binary status, active multi-CLI pool (`activePool`), role routing policy (`routingPolicy`), and resolved `defaultProvider`.
- `ext_swarm_models`: Query models for a provider (`cordis.patch.yml` `lastCatalog` for `dsh`, or `providers.json` config for others).
- `ext_swarm_create`: Create a swarm anchored at `repo_root` (supports `default_provider`, multi-select `active_providers` working pool, `routing_policy` with writer/reader pools & `auto_failover`, `coordinator_conversation_id`, `turn_timeout_seconds`, `stall_timeout_seconds`).
- `ext_swarm_add`: Spawn one worker, a multi-CLI fan-out (`providers: [...]` without `tasks`), or a `tasks` sharded pool rotated across `providers` / Swarm `routing_policy` (with `models_by_provider`, `workspace`, `permission_mode`, `allowed_files`, `verify_commands`, `auto_verify`, `depends_on` DAG, and `arena_group`).
- `ext_swarm_post`: Post as `coordinator` and wake `@mentioned` workers (excludes `killed` and `blocked` workers).
- `ext_swarm_read`: Read board messages after `since`.
- `ext_swarm_status`: Inspect workers, diffs, `outOfScopeFiles`, `lastVerifyResults`, and `coordinatorUsage`.
- `ext_swarm_wait`: Wait 1–90s for `any_post`, `mentions_coordinator`, `all_idle`, or `worker_done` (with blocked-dependency deadlock safety).
- `ext_swarm_update_worker`: Switch a waiting/failed worker's `provider` or `model` and/or retry in place keeping its worktree intact.
- `ext_swarm_merge`: Zero-side-effect `git merge-tree` conflict preview (`action: "preview"`) and safe branch merge (`action: "apply"`, modes `squash` | `cherry-pick` | `merge`).
- `ext_swarm_arena`: Spawn 2+ CLI providers/models side by side in isolated worktrees on the same task for comparison.
- `ext_swarm_cross_review`: Auto-select (or specify) a different CLI vendor to run a read-only code review of a worker's diff/output.
- `ext_swarm_templates`: List built-in and custom team playbook templates (from global & repo `templates.json`).
- `ext_swarm_apply_template`: Instantiate a DAG team playbook (optionally creating a new swarm) with `{{goal}}` injection.
- `ext_swarm_kill`: Terminate worker(s) or `all`, optionally removing temporary worktrees.
- `ext_swarm_delete`: Terminate remaining processes, clean up worktrees/branches, and delete a historical swarm record.
- `ext_swarm_export`: Generate a Markdown post-mortem report (workers, token/cache stats, optional costs, diffs, and full board transcript).
- `ext_swarm_open_board`: Open the live side-pane / global MCP App UI.

### App-Only Tools (22)
- `app_get_snapshot`, `app_post_message`, `app_kill_worker`, `app_get_worker_log`, `app_get_worker_diff`, `app_retry_worker`, `app_bind_conversation`, `app_set_ui_prefs`, `app_get_provider_config`, `app_save_provider_config`, `app_test_provider`, `app_delete_swarm`, `app_export_swarm`, `app_preview_merge`, `app_merge_worker`, `app_create_swarm`, `app_add_worker`, `app_start_arena`, `app_cross_review`, `app_get_templates`, `app_save_template`, `app_apply_template`.

## Contributing & Security

- See [CONTRIBUTING.md](./CONTRIBUTING.md) and [SECURITY.md](./SECURITY.md).

## Privacy & Security

- Main-model usage telemetry reads local Antigravity `transcript.jsonl` files in **strictly read-only mode** and never mutates Antigravity logs or sends telemetry anywhere externally.
- External CLI workers run locally on your machine under their configured sandbox flags (`read-only`, `workspace-write`, `danger-full-access`).

## Customizing the Side-Pane UI

The UI compiles into a self-contained single-file HTML bundle (`server/dist/board.html`) from:
- `server/ui/index.html`
- `server/ui/styles.css` (uses Antigravity host theme tokens)
- `server/ui/app.ts` & `server/ui/i18n.ts` (`zh` / `en` dictionaries)

After editing:
```bash
cd server && pnpm typecheck && pnpm build
```
Then refresh/restart `agy-ext-swarm_ext_swarm` in Antigravity MCP settings (or set `EXT_SWARM_APP_HTML` during UI iteration).

## Tests

```bash
cd server
pnpm test:providers   # Offline multi-provider, parser, and i18n verification (zero API tokens)
pnpm test:smoke       # Live dsh E2E smoke test
```

## License

[MIT](./LICENSE)
