# Contributing to AGY Ext Swarm

Thank you for helping make **AGY Ext Swarm** better!

## Repository Layout

```text
agy-ext-swarm/
├── assets/                   # Logos & preview SVG graphics
├── bin/                      # Worker-side helper CLI (`ext-board.mjs`)
├── scripts/                  # Cross-platform installer (`install.mjs`)
├── server/
│   ├── src/
│   │   ├── index.ts          # MCP server & 40 tool registrations (18 model + 22 app-only)
│   │   ├── runner.ts         # Worker lifecycle, DAG scheduler, Arena, Cross-Review, Export
│   │   ├── worktree.ts       # Git worktree isolation, diff inspection, merge-tree preview & merge
│   │   ├── templates.ts      # Built-in & custom swarm team playbooks
│   │   ├── store.ts          # Persistent swarm state, JSONL board, UI prefs
│   │   └── providers/        # Built-in (`dsh`, `claude`, `codex`, `gemini`) & custom CLI adapters
│   ├── ui/                   # MCP App UI (`index.html`, `styles.css`, `app.ts`, `i18n.ts`, helpers)
│   └── test/                 # Offline unit/integration suite (`providers.test.mjs`) & live smoke test
└── skills/agy-ext-swarm/     # Coordinator orchestration skill guide
```

## Development Setup

1. Ensure **Node.js >= 20**, **pnpm**, and **git** (>= 2.38 recommended for `git merge-tree --write-tree`) are installed.
2. Build & run tests:
   ```bash
   cd server
   pnpm install
   pnpm typecheck
   pnpm build
   pnpm test:providers
   ```

## Adding a Built-In or Preset CLI Provider

- **Built-in provider**: Add `<id>.ts` under `server/src/providers/` implementing `CliProviderAdapter`, register it in `BUILTIN_ADAPTERS` (`server/src/providers/config.ts`), and export it from `server/src/providers/index.ts`.
- **Custom CLI preset**: Add a tested configuration entry in `server/ui/presets.ts` and a corresponding preset button in `server/ui/index.html`.
- Keep all built-in defaults **vendor/endpoint-neutral** — never hardcode private API domains or default model names that assume a single third-party endpoint.

## Coding & Verification Standards

- All TypeScript imports under `server/src/` and `server/ui/` must use `.js` extensions (`NodeNext` module resolution).
- Keep the compiled MCP App single-file bundle (`server/dist/board.html`) strictly **under 1 MiB** with **zero external `<script src>` or `<link href>` tags** (CSP compliance).
- Run `pnpm typecheck && pnpm build && pnpm test:providers` before opening a pull request.
