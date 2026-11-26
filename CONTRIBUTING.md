# Contributing to AGY Ext Swarm

Thank you for helping make **AGY Ext Swarm** better!

## Repository Layout

```text
agy-ext-swarm/
├── package.json              # Root npm package metadata for `npx agy-ext-swarm` distribution
├── assets/                   # Logos & preview SVG graphics
├── bin/                      # Worker/coordinator helper CLI (`ext-board.mjs`: post, read, status, wait)
├── rules/AGENTS.md           # Always-on parallel CLI router rule
├── scripts/                  # Cross-platform installers (`install.mjs`, `install.sh`, `install.ps1`) & release packager
├── server/
│   ├── shared/               # Shared pricing, types, and terminal takeover helpers (`takeover.ts`)
│   ├── src/
│   │   ├── index.ts          # MCP server entrypoint
│   │   ├── tools/            # 44 tool registrations (`model-tools.ts`, `app-tools.ts`, `common.ts`)
│   │   ├── host/             # Host transcript, brain topology & read-only native subagent telemetry
│   │   ├── runner.ts         # Worker lifecycle, auto-converge, DAG scheduler, Arena, Cross-Review
│   │   ├── runner-*.ts       # Extracted process, prompt, merge, routing, and guardrail (`runner-guardrails.ts`) helpers
│   │   ├── worktree.ts       # Git worktree isolation, diff inspection, merge-tree preview & merge
│   │   ├── worktree-hooks.ts # `.agy-ext-swarm/worktree.json` hydration, port offsets & teardown hooks
│   │   ├── models/           # Model catalog discovery & dsh profile diagnostics
│   │   ├── templates.ts      # Built-in & custom swarm team playbooks
│   │   ├── store.ts          # Persistent swarm state, JSONL board, UI prefs
│   │   └── providers/        # Config store & adapters (`dsh`, `claude`, `codex`, `gemini`, custom)
│   ├── ui/                   # MCP App UI (`index.html`, `styles.css`, `app.ts`, `i18n.ts`, `pricing-view.ts`, `timeline-view.ts`, `native-workers-section.ts`, view helpers)
│   └── test/                 # Offline suites (`host-telemetry.test.mjs`, `providers.test.mjs`, `standalone.test.mjs`) & live smoke test
└── skills/agy-ext-swarm/     # Coordinator SOP & on-demand references
```

## Development Setup

1. Ensure **Node.js >= 20**, **pnpm**, and **git** (>= 2.38 recommended for `git merge-tree --write-tree`) are installed.
2. Build & run tests:
   ```bash
   cd server
   pnpm install
   pnpm typecheck
   pnpm build
   pnpm test:host
   pnpm test:providers
   pnpm test:standalone
   ```

## Release & Distribution

- Keep `version` synchronized across `plugin.json`, root `package.json`, and `server/package.json`, and always commit updated zero-dependency bundles (`server/dist/index.mjs`, `server/dist/providers.mjs`, `server/dist/host-telemetry.mjs`, `server/dist/board.html`) built with `pnpm --dir server build`.
- Test release archive packaging locally with `node scripts/package-release.mjs` (outputs `.tar.gz`, `.zip`, and `SHA256SUMS.txt` under `release/`).
- Tagging and pushing (`git tag vX.Y.Z && git push origin vX.Y.Z`) triggers `.github/workflows/release.yml` to build, test, publish GitHub Release assets, and publish to npm via **OIDC Trusted Publishing** (`npm publish --provenance --access public`, configured on npmjs.com under Trusted Publisher for `ycuwq` / `agy-ext-swarm` / `release.yml`, automatically skipping if that version is already on npm).

## Adding a Built-In or Preset CLI Provider

- **Built-in provider**: Add `<id>.ts` under `server/src/providers/` implementing `CliProviderAdapter`, register it in `BUILTIN_ADAPTERS` (`server/src/providers/config-store.ts`), and export it from `server/src/providers/index.ts`.
- **Custom CLI preset**: Add a tested configuration entry in `server/ui/presets.ts` and a corresponding preset button in `server/ui/index.html`.
- Keep all built-in defaults **vendor/endpoint-neutral** — never hardcode private API domains or default model names that assume a single third-party endpoint.

## Coding & Verification Standards

- All TypeScript imports under `server/src/` and `server/ui/` must use `.js` extensions (`NodeNext` module resolution).
- Keep the compiled MCP App single-file bundle (`server/dist/board.html`) strictly **under 1 MiB** with **zero external `<script src>` or `<link href>` tags** (CSP compliance).
- Run `pnpm typecheck && pnpm build && pnpm test:host && pnpm test:providers && pnpm test:standalone` before opening a pull request.
