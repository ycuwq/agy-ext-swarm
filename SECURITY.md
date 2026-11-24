# Security & Privacy Policy

## Local-Only Execution Model

AGY Ext Swarm runs completely locally on your workstation:

- **Transcript Telemetry**: Main-model usage summaries read Antigravity session `transcript.jsonl` files strictly **read-only**. Nothing is uploaded to external servers, and conversation IDs are validated against path-traversal (`isSafeConversationId`).
- **Process Sandboxing**: External CLI workers execute under explicit permission presets (`read-only`, `workspace-write`, `danger-full-access`) and optional isolated `git worktree` branches plus `allowed_files` checks. When `.agy-ext-swarm/worktree.json` is configured, `copyFiles` and `symlinkDirs` paths are verified with `realpathSync` containment checks (`resolveSafeRepoRelative`) so worktree hydration cannot escape the repository root.
- **Zero Side-Effect Merge Preview & Safe Ref Handling**: Conflict previews run via `git merge-tree --write-tree`, leaving your working directory and index untouched until you explicitly confirm a merge. Branch, target branch, and remote names used in merges, `git push`, and `gh pr create` are validated via `validateGitRefName` before spawning commands.

## Configuration Hygiene

- Never commit personal API keys, environment tokens, or private endpoints into `providers.json`, `templates.json`, or repository pull requests.
- Keep `~/.dsh/profiles/desktop` untouched; automated workers use an isolated profile such as `headless`.

## Reporting a Vulnerability

If you discover a security issue (e.g., command injection in CLI argument handling, path traversal, or unintended filesystem writes), please open a private security advisory or confidential issue on the repository rather than posting exploit payloads publicly.
