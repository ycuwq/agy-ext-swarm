import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readCoordinatorUsage, resolveBrainDir } from './coordinator-usage.js';
import {
  getProviderConfigSnapshot,
  getProviderModels,
  saveProviderConfigPatch,
  testProviderConnection,
} from './providers/index.js';
import { SwarmRuntime } from './runner.js';
import { SwarmStore } from './store.js';
import { getTemplatesSnapshot, saveTemplatePatch } from './templates.js';
import type { CustomProviderConfig, SwarmSnapshot } from './types.js';

const APP_RESOURCE_URI = 'ui://agy-ext-swarm/board.html';
const APP_MIME_TYPE = 'text/html;profile=mcp-app';

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const WRITE_LOCAL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const WRITE_EXTERNAL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const DESTRUCTIVE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const CustomCommandSchema = z
  .object({
    displayName: z.string().optional(),
    command: z.string().min(1).describe('Executable binary name or path.'),
    args: z
      .array(z.string())
      .optional()
      .describe(
        'CLI args; supports {{prompt}}, {{model}}, {{cwd}}, {{sessionId}}, {{permissionMode}}, {{workerName}}, {{swarmDir}}, {{gitCommonDir}}, {{boardCli}}.',
      ),
    resume_args: z.array(z.string()).optional(),
    prompt_mode: z.enum(['stdin', 'arg']).optional(),
    output_format: z.enum(['text', 'ndjson']).optional(),
    env: z.record(z.string()).optional(),
    defaultModel: z.string().optional(),
    models: z.array(z.string()).optional(),
  })
  .optional();

function toCustomProviderConfig(
  raw: z.infer<typeof CustomCommandSchema>,
): CustomProviderConfig | undefined {
  if (!raw) return undefined;
  return {
    displayName: raw.displayName,
    command: raw.command,
    args: raw.args,
    resumeArgs: raw.resume_args,
    promptMode: raw.prompt_mode,
    outputFormat: raw.output_format,
    env: raw.env,
    defaultModel: raw.defaultModel,
    models: raw.models,
  };
}

const RoutingPolicySchema = z.object({
  writer_providers: z.array(z.string().min(1)).optional(),
  reader_providers: z.array(z.string().min(1)).optional(),
  auto_failover: z.boolean().optional(),
});

const ProviderEntryConfigInputSchema = z.object({
  enabled: z.boolean().optional(),
  displayName: z.string().optional(),
  command: z.string().optional(),
  defaultModel: z.string().optional(),
  models: z.array(z.string()).optional(),
  profile: z.string().optional(),
  modelProvider: z.string().optional(),
  args: z.array(z.string()).optional(),
  resumeArgs: z.array(z.string()).optional(),
  promptMode: z.enum(['stdin', 'arg']).optional(),
  outputFormat: z.enum(['text', 'ndjson']).optional(),
  env: z.record(z.string()).optional(),
});

function toRoutingPolicy(raw: z.infer<typeof RoutingPolicySchema> | undefined) {
  if (!raw) return undefined;
  return {
    ...(raw.writer_providers ? { writerProviders: raw.writer_providers } : {}),
    ...(raw.reader_providers ? { readerProviders: raw.reader_providers } : {}),
    ...(raw.auto_failover !== undefined ? { autoFailover: raw.auto_failover } : {}),
  };
}

function canonicalPath(p: string): string {
  const abs = resolve(p);
  return existsSync(abs) ? realpathSync(abs) : abs;
}

function parseCliArgs(argv: string[]): { dataDir: string; pluginRoot: string } {
  const selfDir = dirname(fileURLToPath(import.meta.url));
  let dataDir = join(homedir(), '.gemini', 'config', 'plugins', 'agy-ext-swarm', '.data');
  let pluginRoot = resolve(selfDir, '..', '..');

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--data-dir=')) {
      dataDir = arg.slice('--data-dir='.length);
    } else if (arg === '--data-dir' && argv[i + 1]) {
      dataDir = argv[++i];
    } else if (arg.startsWith('--plugin-root=')) {
      pluginRoot = arg.slice('--plugin-root='.length);
    } else if (arg === '--plugin-root' && argv[i + 1]) {
      pluginRoot = argv[++i];
    }
  }

  return {
    dataDir: canonicalPath(dataDir),
    pluginRoot: resolve(pluginRoot),
  };
}

function loadBoardHtml(pluginRoot: string): string {
  const overridePath = process.env.EXT_SWARM_APP_HTML;
  const htmlPath = overridePath
    ? resolve(overridePath)
    : join(pluginRoot, 'server', 'dist', 'board.html');
  if (!existsSync(htmlPath)) {
    return `<!doctype html><html><body><p>AGY Ext Swarm UI bundle not found at ${htmlPath}. Run pnpm build in server/.</p></body></html>`;
  }
  return readFileSync(htmlPath, 'utf8');
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function formatSwarmSummary(snapshot: SwarmSnapshot): string {
  const s = snapshot.swarm;
  const members = Object.values(s.members);
  const working = members.filter((m) => m.status === 'working' || m.status === 'queued').length;
  const waiting = members.filter((m) => m.status === 'waiting').length;
  const failed = members.filter((m) => m.status === 'failed').length;
  return `AGY Ext Swarm "${s.title}" (${s.id}) | head=#${s.headSeq} | members=${members.length} (working=${working}, waiting=${waiting}, failed=${failed})`;
}

async function main(): Promise<void> {
  const { dataDir, pluginRoot } = parseCliArgs(process.argv.slice(2));
  const brainDir = resolveBrainDir(dataDir);
  const store = new SwarmStore(dataDir);
  const runtime = new SwarmRuntime(store, pluginRoot);

  const server = new McpServer({
    name: 'agy-ext-swarm',
    version: '0.2.0',
  });

  // Register MCP App HTML resource
  server.registerResource(
    'AGY Ext Swarm Board UI',
    APP_RESOURCE_URI,
    {
      description: 'Live side-pane dashboard for AGY Ext Swarm board, topology replay, workers, and usage.',
      mimeType: APP_MIME_TYPE,
      _meta: {
        ui: {
          prefersBorder: false,
        },
      },
    },
    async () => ({
      contents: [
        {
          uri: APP_RESOURCE_URI,
          mimeType: APP_MIME_TYPE,
          text: loadBoardHtml(pluginRoot),
          _meta: {
            ui: {
              prefersBorder: false,
            },
          },
        },
      ],
    }),
  );

  // 1. ext_swarm_create
  server.registerTool(
    'ext_swarm_create',
    {
      title: 'Create External Swarm',
      description:
        'Create a new AGY Ext Swarm anchored to a workspace directory (auto-detects git repository for worktree isolation and auto-selects an available CLI provider if default_provider is omitted).',
      annotations: WRITE_LOCAL_ANNOTATIONS,
      inputSchema: {
        title: z.string().min(1).describe('Short descriptive title for the swarm.'),
        repo_root: z.string().min(1).describe('Absolute path to the workspace/repository root.'),
        max_concurrency: z
          .number()
          .int()
          .min(1)
          .max(16)
          .optional()
          .describe('Maximum concurrent running CLI worker processes (default 4).'),
        max_hops: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Circuit breaker for autonomous worker-to-worker @mention hops (default 12).'),
        turn_timeout_seconds: z
          .number()
          .int()
          .min(0)
          .max(7200)
          .optional()
          .describe('Hard timeout per worker turn in seconds (0 disables, default 300).'),
        stall_timeout_seconds: z
          .number()
          .int()
          .min(0)
          .max(3600)
          .optional()
          .describe('Kill stalled worker when silent on stdout/stderr for N seconds (0 disables, default 120).'),
        profile: z
          .string()
          .optional()
          .describe('dsh profile name when using dsh workers (default "headless"; never pass "desktop").'),
        default_provider: z
          .string()
          .optional()
          .describe('Default CLI provider ID ("dsh", "claude", "codex", "gemini", or custom ID). Auto-detected if omitted.'),
        active_providers: z
          .array(z.string().min(1))
          .optional()
          .describe('Optional multi-select CLI working pool for this swarm (e.g. ["dsh", "claude", "codex"]); workers rotate across this pool when provider is omitted.'),
        routing_policy: RoutingPolicySchema.optional().describe(
          'Optional role routing (writer_providers, reader_providers) and auto_failover policy.',
        ),
        coordinator_conversation_id: z
          .string()
          .optional()
          .describe('Optional Antigravity conversation ID for main-model Token/Cache telemetry (auto-detected if omitted).'),
      },
    },
    async ({
      title,
      repo_root,
      max_concurrency,
      max_hops,
      turn_timeout_seconds,
      stall_timeout_seconds,
      profile,
      default_provider,
      active_providers,
      routing_policy,
      coordinator_conversation_id,
    }) => {
      try {
        const state = await runtime.createSwarm({
          title,
          repoRoot: repo_root,
          maxConcurrency: max_concurrency,
          maxHops: max_hops,
          turnTimeoutSeconds: turn_timeout_seconds,
          stallTimeoutSeconds: stall_timeout_seconds,
          profile,
          defaultProvider: default_provider,
          activeProviders: active_providers,
          routingPolicy: toRoutingPolicy(routing_policy),
          coordinatorConversationId: coordinator_conversation_id,
        });
        return {
          content: [{ type: 'text', text: jsonText({ ok: true, swarm: state }) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  // 2. ext_swarm_providers
  server.registerTool(
    'ext_swarm_providers',
    {
      title: 'List CLI Providers',
      description:
        'List built-in (dsh, claude, codex, gemini) and custom CLI providers with enabled status, binary availability, configured models, active multi-CLI pool, routing policy, and effective defaultProvider.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        repo_root: z
          .string()
          .optional()
          .describe('Optional workspace root to also inspect <repo>/.agy-ext-swarm/providers.json.'),
        profile: z.string().optional().describe('Optional dsh profile override.'),
      },
    },
    async ({ repo_root, profile }) => {
      const resolvedRepo = repo_root ? resolve(repo_root) : undefined;
      const snap = getProviderConfigSnapshot(dataDir, resolvedRepo, profile || undefined, true);
      return {
        content: [
          {
            type: 'text',
            text: jsonText({
              defaultProvider: snap.effectiveDefaultProvider,
              configuredDefaultProvider: snap.configuredDefaultProvider,
              activePool: snap.activePool,
              routingPolicy: snap.routingPolicy,
              globalConfigPath: snap.globalConfigPath,
              globalConfigExists: snap.globalConfigExists,
              needsOnboarding: !store.getUiPrefs().onboardingCompleted && !snap.globalConfigExists,
              repoConfigPath: snap.repoConfigPath,
              repoConfigExists: snap.repoConfigExists,
              providers: snap.providers,
            }),
          },
        ],
      };
    },
  );

  // 3. ext_swarm_models
  server.registerTool(
    'ext_swarm_models',
    {
      title: 'List Provider Models',
      description:
        'List available models for a CLI provider (merges configured models in Settings/providers.json with auto-discovered cordis.patch.yml lastCatalog for dsh).',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        provider: z
          .string()
          .optional()
          .describe('CLI provider ID (defaults to auto-detected provider).'),
        profile: z.string().optional().describe('Optional dsh profile override.'),
        repo_root: z.string().optional().describe('Optional workspace root for repo providers.json.'),
      },
    },
    async ({ provider, profile, repo_root }) => {
      const resolvedRepo = repo_root ? resolve(repo_root) : undefined;
      const result = getProviderModels(provider, dataDir, resolvedRepo, profile || undefined);
      return {
        content: [
          {
            type: 'text',
            text: jsonText(result),
          },
        ],
      };
    },
  );

  // 4. ext_swarm_add
  server.registerTool(
    'ext_swarm_add',
    {
      title: 'Add Swarm Worker(s)',
      description:
        'Spawn one headless CLI worker (or a sharded pool <name>-1..<name>-k via tasks) using dsh, claude, codex, gemini, or custom_command with git worktree isolation and allowed_files whitelist.',
      annotations: WRITE_EXTERNAL_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional().describe('Target swarm ID (defaults to latest swarm).'),
        name: z
          .string()
          .min(1)
          .describe('Lowercase worker name (e.g. "parser", "verifier"). Reserved: all, coordinator.'),
        brief: z.string().min(1).describe('Self-contained task brief posted publicly to the board.'),
        tasks: z
          .array(z.string().min(1))
          .optional()
          .describe('Optional per-worker slice targets; spawns <name>-1 through <name>-N.'),
        provider: z
          .string()
          .optional()
          .describe('Single CLI provider ID: "dsh", "claude", "codex", "gemini", "custom", or a custom ID from providers.json.'),
        providers: z
          .array(z.string().min(1))
          .optional()
          .describe('Optional multi-select CLI providers: when passed with `tasks`, shards distribute round-robin across CLIs; when passed without `tasks`, launches one worker per selected CLI.'),
        models_by_provider: z
          .record(z.string())
          .optional()
          .describe('Optional per-provider model map (providerId -> modelId) used with multi-select `providers` or pool routing.'),
        custom_command: CustomCommandSchema.describe(
          'Inline custom CLI configuration when spawning any third-party CLI command.',
        ),
        model: z
          .string()
          .optional()
          .describe('Model ID for this worker (omit to use provider default).'),
        permission_mode: z
          .enum(['read-only', 'workspace-write', 'danger-full-access'])
          .optional()
          .describe('Sandbox permission preset (default "workspace-write").'),
        workspace: z
          .enum(['worktree', 'inherit'])
          .optional()
          .describe('Workspace isolation mode (default "worktree" for writers in git repos).'),
        role: z
          .string()
          .optional()
          .describe('Role label such as "worker", "verifier", or "researcher".'),
        allowed_files: z
          .array(z.string().min(1))
          .optional()
          .describe('Optional relative file/directory whitelist mechanically checked after each turn.'),
        verify_commands: z
          .array(z.string().min(1))
          .optional()
          .describe('Optional verification commands the worker must run before reporting [done].'),
        auto_verify: z
          .boolean()
          .optional()
          .describe('Deterministically run verify_commands in worker cwd after each completed turn and post results to the board (default false).'),
        depends_on: z
          .array(z.string().min(1))
          .optional()
          .describe('Optional upstream worker names that must finish (status=waiting, turns>=1) before this worker unlocks and starts.'),
        arena_group: z
          .string()
          .optional()
          .describe('Optional arena comparison group label.'),
      },
    },
    async (args) => {
      try {
        const res = await runtime.addWorker({
          swarmId: args.swarm_id,
          name: args.name,
          brief: args.brief,
          tasks: args.tasks,
          provider: args.provider,
          providers: args.providers,
          modelsByProvider: args.models_by_provider,
          customCommand: toCustomProviderConfig(args.custom_command),
          model: args.model,
          permissionMode: args.permission_mode,
          workspace: args.workspace,
          role: args.role,
          allowedFiles: args.allowed_files,
          verifyCommands: args.verify_commands,
          autoVerify: args.auto_verify,
          dependsOn: args.depends_on,
          arenaGroup: args.arena_group,
        });
        return {
          content: [{ type: 'text', text: jsonText({ ok: true, ...res }) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  // 5. ext_swarm_post
  server.registerTool(
    'ext_swarm_post',
    {
      title: 'Post to Swarm Board',
      description:
        'Post a message as coordinator to the shared board. Mentioning @worker wakes waiting/failed workers.',
      annotations: WRITE_EXTERNAL_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional().describe('Target swarm ID (defaults to latest swarm).'),
        text: z.string().min(1).describe('Message text; include @name or @all to wake workers.'),
      },
    },
    async ({ swarm_id, text }) => {
      try {
        const message = runtime.postAsCoordinator(swarm_id, text);
        return {
          content: [{ type: 'text', text: jsonText({ ok: true, message }) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  // 6. ext_swarm_read
  server.registerTool(
    'ext_swarm_read',
    {
      title: 'Read Swarm Board',
      description: 'Read board messages after sequence number `since`.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional().describe('Target swarm ID (defaults to latest swarm).'),
        since: z.number().int().min(0).optional().describe('Return messages with seq > since (default 0).'),
        limit: z.number().int().min(1).max(500).optional().describe('Maximum messages to return (default 100).'),
      },
    },
    async ({ swarm_id, since, limit }) => {
      try {
        const swarm = store.getSwarm(swarm_id);
        store.drainInbox(swarm.id);
        const messages = store.readBoard(swarm.id, since ?? 0, limit ?? 100);
        return {
          content: [
            {
              type: 'text',
              text: jsonText({
                swarmId: swarm.id,
                headSeq: swarm.headSeq,
                messages,
              }),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  // 7. ext_swarm_status
  server.registerTool(
    'ext_swarm_status',
    {
      title: 'Swarm Status',
      description:
        'Inspect all workers (provider, status, model, activity, sessionId, token usage, worktree branch, coordinatorUsage, and optional diff/out-of-scope check).',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional().describe('Target swarm ID (defaults to latest swarm).'),
        include_diff: z
          .boolean()
          .optional()
          .describe('Include git diff stats and allowed_files violation check for worktrees.'),
      },
    },
    async ({ swarm_id, include_diff }) => {
      try {
        const res = await runtime.getStatus(swarm_id, include_diff ?? false);
        const { usage: coordinatorUsage } = readCoordinatorUsage(brainDir, res.swarm);
        return {
          content: [{ type: 'text', text: jsonText({ ...res, coordinatorUsage }) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  // 8. ext_swarm_wait
  server.registerTool(
    'ext_swarm_wait',
    {
      title: 'Wait on Swarm',
      description:
        'Wait up to 90s for a board post, @coordinator mention, worker completion, or all workers becoming idle.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional().describe('Target swarm ID (defaults to latest swarm).'),
        since: z.number().int().min(0).optional().describe('Board sequence cursor to watch after.'),
        timeout_seconds: z
          .number()
          .min(1)
          .max(90)
          .optional()
          .describe('Maximum seconds to wait (1-90, default 45).'),
        until: z
          .enum(['any_post', 'mentions_coordinator', 'all_idle', 'worker_done'])
          .optional()
          .describe('Wake condition (default "any_post").'),
        worker_name: z
          .string()
          .optional()
          .describe('Worker name when until="worker_done".'),
      },
    },
    async ({ swarm_id, since, timeout_seconds, until, worker_name }) => {
      try {
        const res = await runtime.waitForCondition({
          swarmId: swarm_id,
          since,
          timeoutSeconds: timeout_seconds,
          until,
          workerName: worker_name,
        });
        return {
          content: [{ type: 'text', text: jsonText(res) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  // 9. ext_swarm_kill
  server.registerTool(
    'ext_swarm_kill',
    {
      title: 'Kill Swarm Worker(s)',
      description:
        'Terminate one worker, a sharded group, or "all", optionally deleting temporary git worktrees and branches.',
      annotations: DESTRUCTIVE_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional().describe('Target swarm ID (defaults to latest swarm).'),
        name: z.string().min(1).describe('Worker name, group prefix, or "all".'),
        remove_worktree: z
          .boolean()
          .optional()
          .describe('Also remove worker git worktree directory and branch (default false).'),
      },
    },
    async ({ swarm_id, name, remove_worktree }) => {
      try {
        const res = await runtime.killWorker(swarm_id, name, remove_worktree ?? false);
        return {
          content: [{ type: 'text', text: jsonText({ ok: true, ...res }) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  // 10. ext_swarm_update_worker
  server.registerTool(
    'ext_swarm_update_worker',
    {
      title: 'Switch Worker Provider / Model or Retry',
      description:
        'Update provider/model or retry a waiting/failed worker in place while keeping its existing git worktree and branch intact.',
      annotations: WRITE_EXTERNAL_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional().describe('Target swarm ID (defaults to latest swarm).'),
        name: z.string().min(1).describe('Existing waiting/failed worker name.'),
        provider: z.string().optional().describe('New CLI provider ID (clears old CLI sessionId when switching CLIs).'),
        custom_command: CustomCommandSchema.describe('Inline custom CLI config if switching to provider="custom".'),
        model: z.string().optional().describe('New model ID to use on this worker.'),
        prompt: z.string().optional().describe('Optional follow-up instruction posted to wake the worker.'),
        retry: z.boolean().optional().describe('Immediately enqueue/wake worker to resume work (default true if prompt omitted? Specify true to run immediately).'),
      },
    },
    async (args) => {
      try {
        const res = await runtime.updateAndRetryWorker({
          swarmId: args.swarm_id,
          name: args.name,
          provider: args.provider,
          customCommand: toCustomProviderConfig(args.custom_command),
          model: args.model,
          prompt: args.prompt,
          retry: args.retry,
        });
        return {
          content: [{ type: 'text', text: jsonText({ ok: true, ...res }) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  // 11. ext_swarm_delete
  server.registerTool(
    'ext_swarm_delete',
    {
      title: 'Delete Swarm',
      description:
        'Terminate any remaining processes, clean up worktrees/branches, and delete a historical swarm record.',
      annotations: DESTRUCTIVE_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional().describe('Target swarm ID (defaults to latest swarm).'),
        remove_worktrees: z
          .boolean()
          .optional()
          .describe('Remove worker git worktrees and branches (default true).'),
      },
    },
    async ({ swarm_id, remove_worktrees }) => {
      try {
        const res = await runtime.deleteSwarm(swarm_id, remove_worktrees ?? true);
        return {
          content: [{ type: 'text', text: jsonText({ ok: true, ...res }) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  // 12. ext_swarm_export
  server.registerTool(
    'ext_swarm_export',
    {
      title: 'Export Swarm Markdown Report',
      description:
        'Generate a Markdown post-mortem / battle report covering workers, token/cache telemetry, optional cost estimates, diffs, and the full board transcript.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional().describe('Target swarm ID (defaults to latest swarm).'),
      },
    },
    async ({ swarm_id }) => {
      try {
        const swarm = store.getSwarm(swarm_id);
        const { usage: coordinatorUsage } = readCoordinatorUsage(brainDir, swarm);
        const cfg = getProviderConfigSnapshot(dataDir, swarm.repoRoot, swarm.profile);
        const res = await runtime.exportSwarmMarkdown(swarm.id, coordinatorUsage, cfg.pricing);
        return {
          content: [{ type: 'text', text: jsonText({ ok: true, ...res }) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  // 13. ext_swarm_merge
  server.registerTool(
    'ext_swarm_merge',
    {
      title: 'Preview or Merge Worker Worktree',
      description:
        'Run zero-side-effect conflict detection (action="preview") using git merge-tree, or safely apply a worker worktree branch into target branch (action="apply", modes: squash/cherry-pick/merge).',
      annotations: DESTRUCTIVE_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional().describe('Target swarm ID (defaults to latest swarm).'),
        worker: z.string().min(1).describe('Name of the worktree worker to preview or merge.'),
        action: z
          .enum(['preview', 'apply'])
          .optional()
          .describe('preview checks conflicts without modifying working tree (default); apply performs the merge.'),
        mode: z
          .enum(['squash', 'cherry-pick', 'merge'])
          .optional()
          .describe('Merge strategy when action="apply" (default "squash").'),
        target_branch: z
          .string()
          .optional()
          .describe('Target branch name (defaults to currently checked out branch).'),
        commit_message: z.string().optional().describe('Optional custom commit message for squash/merge.'),
        remove_worktree: z
          .boolean()
          .optional()
          .describe('Whether to remove worker worktree and branch after a successful merge (default false).'),
      },
    },
    async ({ swarm_id, worker, action, mode, target_branch, commit_message, remove_worktree }) => {
      try {
        if ((action || 'preview') === 'preview') {
          const preview = await runtime.previewWorkerMerge({
            swarmId: swarm_id,
            workerName: worker,
            targetBranch: target_branch,
          });
          return {
            content: [{ type: 'text', text: jsonText({ ok: true, preview }) }],
          };
        }
        const result = await runtime.mergeWorker({
          swarmId: swarm_id,
          workerName: worker,
          targetBranch: target_branch,
          mode,
          commitMessage: commit_message,
          removeWorktreeAfter: remove_worktree,
        });
        return {
          isError: !result.merged,
          content: [{ type: 'text', text: jsonText({ ok: result.merged, ...result }) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  // 14. ext_swarm_arena
  server.registerTool(
    'ext_swarm_arena',
    {
      title: 'Launch Multi-CLI Arena Competition',
      description:
        'Spawn 2+ CLI providers/models side by side in isolated git worktrees to tackle the exact same task cleanly for comparison.',
      annotations: WRITE_EXTERNAL_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional().describe('Target swarm ID (defaults to latest swarm).'),
        task: z.string().min(1).describe('Shared task specification assigned to every arena contestant.'),
        contestants: z
          .array(
            z.object({
              name: z.string().optional(),
              provider: z.string().min(1),
              model: z.string().optional(),
              permission: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
              role: z.string().optional(),
            }),
          )
          .min(2)
          .describe('List of 2 or more provider/model configurations to race in parallel worktrees.'),
        base_name: z.string().optional().describe('Optional arena group prefix (e.g. "arena-auth").'),
        permission: z
          .enum(['read-only', 'workspace-write', 'danger-full-access'])
          .optional()
          .describe('Default permission mode for contestants (default "workspace-write").'),
      },
    },
    async ({ swarm_id, task, contestants, base_name, permission }) => {
      try {
        const res = await runtime.startArena({
          swarmId: swarm_id,
          task,
          contestants: contestants.map((c) => ({
            name: c.name,
            provider: c.provider,
            model: c.model,
            permissionMode: c.permission,
            role: c.role,
          })),
          baseName: base_name,
          permissionMode: permission,
        });
        return {
          content: [{ type: 'text', text: jsonText({ ok: true, ...res }) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  // 15. ext_swarm_cross_review
  server.registerTool(
    'ext_swarm_cross_review',
    {
      title: 'Cross-Vendor Code Review',
      description:
        'Spawn a read-only reviewer using a different CLI provider (or specified reviewer_provider) to audit target_worker changes.',
      annotations: WRITE_EXTERNAL_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional().describe('Target swarm ID (defaults to latest swarm).'),
        target_worker: z.string().min(1).describe('Worker whose output and worktree diff should be reviewed.'),
        reviewer_provider: z
          .string()
          .optional()
          .describe('Reviewer CLI provider ID (auto-selects another available provider if omitted).'),
        reviewer_model: z.string().optional().describe('Optional model ID for reviewer.'),
        reviewer_name: z.string().optional().describe('Optional worker name for the reviewer.'),
        rubric: z.string().optional().describe('Optional custom review checklist or focus areas.'),
      },
    },
    async ({
      swarm_id,
      target_worker,
      reviewer_provider,
      reviewer_model,
      reviewer_name,
      rubric,
    }) => {
      try {
        const res = await runtime.startCrossReview({
          swarmId: swarm_id,
          targetWorker: target_worker,
          reviewerProvider: reviewer_provider,
          reviewerModel: reviewer_model,
          reviewerName: reviewer_name,
          rubric,
        });
        return {
          content: [{ type: 'text', text: jsonText({ ok: true, ...res }) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  // 16. ext_swarm_templates
  server.registerTool(
    'ext_swarm_templates',
    {
      title: 'List Swarm Team Templates',
      description:
        'List built-in and custom reusable swarm playbooks/templates (merged from global dataDir and repo .agy-ext-swarm/templates.json).',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional().describe('Optional swarm ID to resolve repo_root.'),
        repo_root: z.string().optional().describe('Optional workspace root to inspect repo templates.'),
      },
    },
    async ({ swarm_id, repo_root }) => {
      try {
        const swarm = swarm_id ? store.tryGetSwarm(swarm_id) : store.tryGetSwarm(undefined);
        const snap = getTemplatesSnapshot(dataDir, repo_root?.trim() || swarm?.repoRoot);
        return {
          content: [{ type: 'text', text: jsonText(snap) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  // 17. ext_swarm_apply_template
  server.registerTool(
    'ext_swarm_apply_template',
    {
      title: 'Apply Swarm Team Template',
      description:
        'Instantiate a multi-worker DAG team playbook (optionally creating a new swarm if swarm_id is omitted) with {{goal}} injection.',
      annotations: WRITE_EXTERNAL_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional().describe('Existing swarm ID (omit + provide repo_root to create one).'),
        template_id: z.string().min(1).describe('Template ID (e.g. "feature-squad", "bug-hunt", "doc-and-test").'),
        goal: z.string().min(1).describe('Shared task goal injected into template worker briefs.'),
        repo_root: z.string().optional().describe('Workspace root when creating a new swarm.'),
        title: z.string().optional().describe('Optional swarm title when creating a new swarm.'),
        provider_overrides: z
          .record(z.string())
          .optional()
          .describe('Optional per-worker provider overrides (workerName -> providerId).'),
        model_overrides: z
          .record(z.string())
          .optional()
          .describe('Optional per-worker model overrides (workerName -> modelId).'),
      },
    },
    async ({ swarm_id, template_id, goal, repo_root, title, provider_overrides, model_overrides }) => {
      try {
        const res = await runtime.applyTemplate({
          swarmId: swarm_id,
          templateId: template_id,
          goal,
          repoRoot: repo_root,
          title,
          providerOverrides: provider_overrides,
          modelOverrides: model_overrides,
        });
        return {
          content: [{ type: 'text', text: jsonText({ ok: true, ...res }) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  // 18. ext_swarm_open_board (MCP App entrypoint)
  server.registerTool(
    'ext_swarm_open_board',
    {
      title: 'AGY Ext Swarm Board',
      description:
        'Open the live AGY Ext Swarm board, topology replay, workers, and token usage cockpit in the interactive MCP App view.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional().describe('Optional swarm ID to focus (defaults to latest swarm).'),
      },
      _meta: {
        ui: {
          resourceUri: APP_RESOURCE_URI,
        },
        'com.google.antigravity/ui': {
          entrypoints: [
            { type: 'aux_pane', title: 'AGY Ext Swarm' },
            { type: 'global', title: 'AGY Ext Swarm' },
          ],
        },
      },
    },
    async ({ swarm_id }) => {
      const swarm = store.tryGetSwarm(swarm_id);
      const { usage: coordinatorUsage, conversations: availableConversations } =
        readCoordinatorUsage(brainDir, swarm ?? null);
      const providerConfig = getProviderConfigSnapshot(dataDir, swarm?.repoRoot, swarm?.profile);
      const templatesConfig = getTemplatesSnapshot(dataDir, swarm?.repoRoot);
      const uiPrefs = store.getUiPrefs();

      if (!swarm) {
        const emptySnapshot = {
          swarm: null,
          messages: [],
          edges: [],
          swarms: store.listSwarms(),
          coordinatorUsage,
          availableConversations,
          providers: providerConfig.providers,
          providerConfig,
          templatesConfig,
          uiPrefs,
        };
        return {
          content: [
            {
              type: 'text',
              text: 'No AGY Ext Swarm has been created yet. Use ext_swarm_create to start one.',
            },
          ],
          structuredContent: emptySnapshot,
        };
      }

      store.drainInbox(swarm.id);
      const snapshot: SwarmSnapshot = {
        swarm,
        messages: store.readBoard(swarm.id, 0, 200),
        edges: store.computeGraphEdges(swarm.id),
        swarms: store.listSwarms(),
        coordinatorUsage,
        availableConversations,
        providers: providerConfig.providers,
        providerConfig,
        templatesConfig,
        uiPrefs,
      };
      return {
        content: [{ type: 'text', text: formatSwarmSummary(snapshot) }],
        structuredContent: snapshot as unknown as Record<string, unknown>,
      };
    },
  );

  // App-only tools (hidden from model)
  server.registerTool(
    'app_get_snapshot',
    {
      title: 'Get Swarm Snapshot',
      description: 'Internal UI polling endpoint returning full swarm snapshot and worktree diffs.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional(),
        include_diff: z.boolean().optional(),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({ swarm_id, include_diff }) => {
      const swarms = store.listSwarms();
      const swarm = store.tryGetSwarm(swarm_id);
      const { usage: coordinatorUsage, conversations: availableConversations } =
        readCoordinatorUsage(brainDir, swarm ?? null);
      const providerConfig = getProviderConfigSnapshot(dataDir, swarm?.repoRoot, swarm?.profile);
      const templatesConfig = getTemplatesSnapshot(dataDir, swarm?.repoRoot);
      const uiPrefs = store.getUiPrefs();

      if (!swarm) {
        return {
          content: [{ type: 'text', text: 'No swarm found' }],
          structuredContent: {
            swarm: null,
            messages: [],
            edges: [],
            swarms,
            diffs: {},
            coordinatorUsage,
            availableConversations,
            providers: providerConfig.providers,
            providerConfig,
            templatesConfig,
            uiPrefs,
          },
        };
      }
      store.drainInbox(swarm.id);
      const { diffs } = await runtime.getStatus(swarm.id, include_diff ?? true);
      const snapshot: SwarmSnapshot = {
        swarm,
        messages: store.readBoard(swarm.id, 0, 300),
        edges: store.computeGraphEdges(swarm.id),
        swarms,
        diffs,
        coordinatorUsage,
        availableConversations,
        providers: providerConfig.providers,
        providerConfig,
        templatesConfig,
        uiPrefs,
      };
      return {
        content: [{ type: 'text', text: formatSwarmSummary(snapshot) }],
        structuredContent: snapshot as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'app_set_ui_prefs',
    {
      title: 'Set UI Preferences',
      description: 'Persist UI preferences (such as locale and onboarding state) in plugin data directory.',
      annotations: WRITE_LOCAL_ANNOTATIONS,
      inputSchema: {
        locale: z.enum(['zh', 'en']).optional(),
        onboarding_completed: z.boolean().optional(),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({ locale, onboarding_completed }) => {
      const uiPrefs = store.setUiPrefs({ locale, onboardingCompleted: onboarding_completed });
      return {
        content: [{ type: 'text', text: jsonText({ ok: true, uiPrefs }) }],
        structuredContent: { ok: true, uiPrefs },
      };
    },
  );

  server.registerTool(
    'app_get_provider_config',
    {
      title: 'Get CLI & Model Config',
      description: 'Read configured and auto-detected CLI providers and supported models for the Settings UI.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional(),
        repo_root: z.string().optional(),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({ swarm_id, repo_root }) => {
      const swarm = store.tryGetSwarm(swarm_id);
      const effectiveRepo = repo_root ? resolve(repo_root) : swarm?.repoRoot;
      const providerConfig = getProviderConfigSnapshot(dataDir, effectiveRepo, swarm?.profile, true);
      return {
        content: [{ type: 'text', text: jsonText({ ok: true, providerConfig }) }],
        structuredContent: { ok: true, providerConfig },
      };
    },
  );

  server.registerTool(
    'app_save_provider_config',
    {
      title: 'Save CLI & Model Config',
      description: 'Persist CLI provider enablement, default provider, model lists, optional pricing, and custom CLI definitions to global providers.json.',
      annotations: WRITE_LOCAL_ANNOTATIONS,
      inputSchema: {
        default_provider: z.string().nullable().optional(),
        active_pool: z.array(z.string()).nullable().optional(),
        routing_policy: RoutingPolicySchema.nullable().optional(),
        upsert_provider: z
          .object({
            id: z.string().min(1),
            config: ProviderEntryConfigInputSchema.nullable(),
          })
          .optional(),
        upsert_providers: z
          .array(
            z.object({
              id: z.string().min(1),
              config: ProviderEntryConfigInputSchema.nullable(),
            }),
          )
          .optional(),
        remove_provider: z.string().optional(),
        upsert_pricing: z
          .object({
            model: z.string().min(1),
            pricing: z
              .object({
                inputPer1M: z.number().min(0),
                cacheReadPer1M: z.number().min(0).optional(),
                outputPer1M: z.number().min(0),
                currency: z.enum(['USD', 'CNY']).optional(),
              })
              .nullable(),
          })
          .optional(),
        swarm_id: z.string().optional(),
        repo_root: z.string().optional(),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({
      default_provider,
      active_pool,
      routing_policy,
      upsert_provider,
      upsert_providers,
      remove_provider,
      upsert_pricing,
      swarm_id,
      repo_root,
    }) => {
      try {
        saveProviderConfigPatch(dataDir, {
          defaultProvider: default_provider,
          activePool: active_pool,
          routingPolicy:
            routing_policy === null
              ? null
              : routing_policy !== undefined
                ? toRoutingPolicy(routing_policy)
                : undefined,
          upsertProvider: upsert_provider,
          upsertProviders: upsert_providers,
          removeProvider: remove_provider,
          upsertPricing: upsert_pricing,
        });
        const swarm = store.tryGetSwarm(swarm_id);
        const effectiveRepo = repo_root ? resolve(repo_root) : swarm?.repoRoot;
        const providerConfig = getProviderConfigSnapshot(dataDir, effectiveRepo, swarm?.profile, true);
        return {
          content: [{ type: 'text', text: jsonText({ ok: true, providerConfig }) }],
          structuredContent: { ok: true, providerConfig },
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  server.registerTool(
    'app_get_worker_diff',
    {
      title: 'Get Worker Git Diff',
      description: 'Read full git diff patch (including untracked files) for a worker worktree.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional(),
        name: z.string().min(1),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({ swarm_id, name }) => {
      try {
        const diff = await runtime.getWorkerFullDiff(swarm_id, name);
        return {
          content: [{ type: 'text', text: jsonText({ ok: true, diff }) }],
          structuredContent: { ok: true, diff },
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  server.registerTool(
    'app_retry_worker',
    {
      title: 'Retry or Switch Worker from UI',
      description: 'Switch provider/model and/or retry a waiting or failed worker from the MCP App UI.',
      annotations: WRITE_EXTERNAL_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional(),
        name: z.string().min(1),
        provider: z.string().optional(),
        model: z.string().optional(),
        prompt: z.string().optional(),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({ swarm_id, name, provider, model, prompt }) => {
      try {
        const res = await runtime.updateAndRetryWorker({
          swarmId: swarm_id,
          name,
          provider,
          model,
          prompt,
          retry: true,
        });
        return {
          content: [{ type: 'text', text: jsonText({ ok: true, ...res }) }],
          structuredContent: { ok: true, ...res },
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  server.registerTool(
    'app_test_provider',
    {
      title: 'Test CLI Provider Connection',
      description: 'Probe a configured CLI provider binary (--version, latency, and dsh profile status).',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        provider_id: z.string().min(1),
        swarm_id: z.string().optional(),
        repo_root: z.string().optional(),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({ provider_id, swarm_id, repo_root }) => {
      const swarm = store.tryGetSwarm(swarm_id);
      const effectiveRepo = repo_root ? resolve(repo_root) : swarm?.repoRoot;
      const result = await testProviderConnection(
        provider_id,
        dataDir,
        effectiveRepo,
        swarm?.profile,
      );
      return {
        content: [{ type: 'text', text: jsonText({ ok: true, result }) }],
        structuredContent: { ok: true, result },
      };
    },
  );

  server.registerTool(
    'app_delete_swarm',
    {
      title: 'Delete Swarm from UI',
      description: 'Delete a historical swarm and optionally remove its temporary worktrees.',
      annotations: DESTRUCTIVE_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional(),
        remove_worktrees: z.boolean().optional(),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({ swarm_id, remove_worktrees }) => {
      try {
        const res = await runtime.deleteSwarm(swarm_id, remove_worktrees ?? true);
        return {
          content: [{ type: 'text', text: jsonText({ ok: true, ...res }) }],
          structuredContent: { ok: true, ...res, swarms: store.listSwarms() },
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  server.registerTool(
    'app_export_swarm',
    {
      title: 'Export Swarm Report from UI',
      description: 'Generate downloadable Markdown post-mortem report for a swarm.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional(),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({ swarm_id }) => {
      try {
        const swarm = store.getSwarm(swarm_id);
        const { usage: coordinatorUsage } = readCoordinatorUsage(brainDir, swarm);
        const cfg = getProviderConfigSnapshot(dataDir, swarm.repoRoot, swarm.profile);
        const res = await runtime.exportSwarmMarkdown(swarm.id, coordinatorUsage, cfg.pricing);
        return {
          content: [{ type: 'text', text: jsonText({ ok: true, ...res }) }],
          structuredContent: { ok: true, ...res },
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  server.registerTool(
    'app_bind_conversation',
    {
      title: 'Bind Coordinator Conversation',
      description: 'Bind an Antigravity conversation ID to a swarm for main-model token telemetry.',
      annotations: WRITE_LOCAL_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional(),
        conversation_id: z.string().min(1),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({ swarm_id, conversation_id }) => {
      try {
        const swarm = store.setCoordinatorConversation(swarm_id, conversation_id);
        const { usage: coordinatorUsage } = readCoordinatorUsage(brainDir, swarm);
        return {
          content: [{ type: 'text', text: `Bound ${conversation_id}` }],
          structuredContent: { ok: true, swarm, coordinatorUsage },
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  server.registerTool(
    'app_post_message',
    {
      title: 'App Post Message',
      description: 'Post a coordinator message from the MCP App UI.',
      annotations: WRITE_EXTERNAL_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional(),
        text: z.string().min(1),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({ swarm_id, text }) => {
      try {
        const message = runtime.postAsCoordinator(swarm_id, text);
        return {
          content: [{ type: 'text', text: `Posted #${message.seq}` }],
          structuredContent: { ok: true, message },
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  server.registerTool(
    'app_kill_worker',
    {
      title: 'App Kill Worker',
      description: 'Kill a worker from the MCP App UI.',
      annotations: DESTRUCTIVE_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional(),
        name: z.string().min(1),
        remove_worktree: z.boolean().optional(),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({ swarm_id, name, remove_worktree }) => {
      try {
        const res = await runtime.killWorker(swarm_id, name, remove_worktree ?? false);
        return {
          content: [{ type: 'text', text: jsonText(res) }],
          structuredContent: { ok: true, ...res },
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  server.registerTool(
    'app_get_worker_log',
    {
      title: 'App Get Worker Log',
      description: 'Read tail lines of a worker NDJSON log for inspection in the UI.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional(),
        name: z.string().min(1),
        tail_lines: z.number().int().min(1).max(300).optional(),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({ swarm_id, name, tail_lines }) => {
      try {
        const swarm = store.getSwarm(swarm_id);
        const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '');
        const logPath = join(store.getLogsDir(swarm.id), `${safeName}.ndjson`);
        if (!existsSync(logPath)) {
          return {
            content: [{ type: 'text', text: 'No logs yet.' }],
            structuredContent: { name: safeName, lines: [] },
          };
        }
        const rawLines = readFileSync(logPath, 'utf8')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        const sliced = rawLines.slice(-(tail_lines ?? 80));
        return {
          content: [{ type: 'text', text: `Loaded ${sliced.length} log lines` }],
          structuredContent: { name: safeName, lines: sliced },
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  server.registerTool(
    'app_preview_merge',
    {
      title: 'App Preview Worker Merge',
      description: 'Run zero-side-effect git merge-tree conflict check for a worker branch from UI.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional(),
        name: z.string().min(1),
        target_branch: z.string().optional(),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({ swarm_id, name, target_branch }) => {
      try {
        const preview = await runtime.previewWorkerMerge({
          swarmId: swarm_id,
          workerName: name,
          targetBranch: target_branch,
        });
        return {
          content: [{ type: 'text', text: jsonText(preview) }],
          structuredContent: { ok: true, preview },
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  server.registerTool(
    'app_merge_worker',
    {
      title: 'App Merge Worker Branch',
      description: 'Safely merge a worker worktree branch into target branch from UI.',
      annotations: DESTRUCTIVE_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional(),
        name: z.string().min(1),
        mode: z.enum(['squash', 'cherry-pick', 'merge']).optional(),
        target_branch: z.string().optional(),
        commit_message: z.string().optional(),
        remove_worktree: z.boolean().optional(),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({ swarm_id, name, mode, target_branch, commit_message, remove_worktree }) => {
      try {
        const result = await runtime.mergeWorker({
          swarmId: swarm_id,
          workerName: name,
          mode,
          targetBranch: target_branch,
          commitMessage: commit_message,
          removeWorktreeAfter: remove_worktree,
        });
        return {
          isError: !result.merged,
          content: [{ type: 'text', text: jsonText(result) }],
          structuredContent: { ok: result.merged, ...result },
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  server.registerTool(
    'app_create_swarm',
    {
      title: 'App Create Swarm',
      description: 'Create a new swarm directly from the MCP App UI.',
      annotations: WRITE_LOCAL_ANNOTATIONS,
      inputSchema: {
        repo_root: z.string().min(1),
        title: z.string().optional(),
        default_provider: z.string().optional(),
        active_providers: z.array(z.string().min(1)).optional(),
        routing_policy: RoutingPolicySchema.optional(),
        max_concurrency: z.number().int().min(1).max(16).optional(),
        max_hops: z.number().int().min(1).max(50).optional(),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({
      repo_root,
      title,
      default_provider,
      active_providers,
      routing_policy,
      max_concurrency,
      max_hops,
    }) => {
      try {
        const swarm = await runtime.createSwarm({
          repoRoot: repo_root,
          title: title?.trim() || 'Swarm',
          defaultProvider: default_provider,
          activeProviders: active_providers,
          routingPolicy: toRoutingPolicy(routing_policy),
          maxConcurrency: max_concurrency,
          maxHops: max_hops,
        });
        return {
          content: [{ type: 'text', text: `Created swarm ${swarm.id}` }],
          structuredContent: { ok: true, swarm },
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  server.registerTool(
    'app_add_worker',
    {
      title: 'App Add Worker',
      description: 'Add and start (or queue/block) a worker directly from the MCP App UI.',
      annotations: WRITE_EXTERNAL_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional(),
        name: z.string().min(1),
        brief: z.string().min(1),
        tasks: z.array(z.string().min(1)).optional(),
        provider: z.string().optional(),
        providers: z.array(z.string().min(1)).optional(),
        models_by_provider: z.record(z.string()).optional(),
        model: z.string().optional(),
        permission_mode: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
        workspace: z.enum(['worktree', 'inherit']).optional(),
        role: z.string().optional(),
        depends_on: z.array(z.string().min(1)).optional(),
        arena_group: z.string().optional(),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async (args) => {
      try {
        const res = await runtime.addWorker({
          swarmId: args.swarm_id,
          name: args.name,
          brief: args.brief,
          tasks: args.tasks,
          provider: args.provider,
          providers: args.providers,
          modelsByProvider: args.models_by_provider,
          model: args.model,
          permissionMode: args.permission_mode,
          workspace: args.workspace,
          role: args.role,
          dependsOn: args.depends_on,
          arenaGroup: args.arena_group,
        });
        return {
          content: [{ type: 'text', text: jsonText({ ok: true, ...res }) }],
          structuredContent: { ok: true, ...res },
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  server.registerTool(
    'app_start_arena',
    {
      title: 'App Start Arena',
      description: 'Launch an isolated multi-CLI arena competition directly from UI.',
      annotations: WRITE_EXTERNAL_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional(),
        task: z.string().min(1),
        contestants: z
          .array(
            z.object({
              name: z.string().optional(),
              provider: z.string().min(1),
              model: z.string().optional(),
              permission: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
              role: z.string().optional(),
            }),
          )
          .min(2),
        base_name: z.string().optional(),
        permission: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({ swarm_id, task, contestants, base_name, permission }) => {
      try {
        const res = await runtime.startArena({
          swarmId: swarm_id,
          task,
          contestants: contestants.map((c) => ({
            name: c.name,
            provider: c.provider,
            model: c.model,
            permissionMode: c.permission,
            role: c.role,
          })),
          baseName: base_name,
          permissionMode: permission,
        });
        return {
          content: [{ type: 'text', text: jsonText({ ok: true, ...res }) }],
          structuredContent: { ok: true, ...res },
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  server.registerTool(
    'app_cross_review',
    {
      title: 'App Cross Review',
      description: 'Trigger cross-vendor read-only review of a worker directly from UI.',
      annotations: WRITE_EXTERNAL_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional(),
        target_worker: z.string().min(1),
        reviewer_provider: z.string().optional(),
        reviewer_model: z.string().optional(),
        rubric: z.string().optional(),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({ swarm_id, target_worker, reviewer_provider, reviewer_model, rubric }) => {
      try {
        const res = await runtime.startCrossReview({
          swarmId: swarm_id,
          targetWorker: target_worker,
          reviewerProvider: reviewer_provider,
          reviewerModel: reviewer_model,
          rubric,
        });
        return {
          content: [{ type: 'text', text: jsonText({ ok: true, ...res }) }],
          structuredContent: { ok: true, ...res },
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  server.registerTool(
    'app_get_templates',
    {
      title: 'App Get Templates',
      description: 'Fetch built-in and custom team templates for the MCP App UI.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional(),
        repo_root: z.string().optional(),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({ swarm_id, repo_root }) => {
      const swarm = swarm_id ? store.tryGetSwarm(swarm_id) : store.tryGetSwarm(undefined);
      const templatesConfig = getTemplatesSnapshot(dataDir, repo_root?.trim() || swarm?.repoRoot);
      return {
        content: [{ type: 'text', text: jsonText(templatesConfig) }],
        structuredContent: { ok: true, templatesConfig },
      };
    },
  );

  server.registerTool(
    'app_save_template',
    {
      title: 'App Save Template',
      description: 'Create, update, or remove a custom swarm team template in global templates.json.',
      annotations: WRITE_LOCAL_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional(),
        remove_template_id: z.string().optional(),
        upsert_template: z
          .object({
            id: z.string().min(1),
            name: z.string().min(1),
            description: z.string().optional(),
            defaultTitle: z.string().optional(),
            workers: z
              .array(
                z.object({
                  name: z.string().min(1),
                  role: z.string().optional(),
                  brief: z.string().min(1),
                  provider: z.string().optional(),
                  model: z.string().optional(),
                  workspace: z.enum(['worktree', 'inherit']).optional(),
                  permission: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
                  dependsOn: z.array(z.string()).optional(),
                  allowedFiles: z.array(z.string()).optional(),
                  verifyCommands: z.array(z.string()).optional(),
                  autoVerify: z.boolean().optional(),
                }),
              )
              .min(1),
          })
          .optional(),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({ swarm_id, remove_template_id, upsert_template }) => {
      try {
        const swarm = swarm_id ? store.tryGetSwarm(swarm_id) : store.tryGetSwarm(undefined);
        const templatesConfig = saveTemplatePatch(dataDir, swarm?.repoRoot, {
          removeTemplateId: remove_template_id,
          upsertTemplate: upsert_template
            ? {
                ...upsert_template,
                description: upsert_template.description || '',
                workers: upsert_template.workers.map((w) => ({
                  ...w,
                  role: w.role || w.name,
                })),
              }
            : undefined,
        });
        return {
          content: [{ type: 'text', text: jsonText({ ok: true, templatesConfig }) }],
          structuredContent: { ok: true, templatesConfig },
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  server.registerTool(
    'app_apply_template',
    {
      title: 'App Apply Template',
      description: 'Instantiate a swarm team template directly from the MCP App UI.',
      annotations: WRITE_EXTERNAL_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional(),
        template_id: z.string().min(1),
        goal: z.string().min(1),
        repo_root: z.string().optional(),
        title: z.string().optional(),
        provider_overrides: z.record(z.string()).optional(),
        model_overrides: z.record(z.string()).optional(),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({ swarm_id, template_id, goal, repo_root, title, provider_overrides, model_overrides }) => {
      try {
        const res = await runtime.applyTemplate({
          swarmId: swarm_id,
          templateId: template_id,
          goal,
          repoRoot: repo_root,
          title,
          providerOverrides: provider_overrides,
          modelOverrides: model_overrides,
        });
        return {
          content: [{ type: 'text', text: jsonText({ ok: true, ...res }) }],
          structuredContent: { ok: true, ...res },
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  const onShutdown = () => {
    runtime.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', onShutdown);
  process.on('SIGTERM', onShutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[agy-ext-swarm] MCP server listening on stdio (dataDir=${dataDir})`);
}

main().catch((err) => {
  console.error('[agy-ext-swarm] Fatal error:', err);
  process.exit(1);
});
