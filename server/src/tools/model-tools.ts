import { resolve } from 'node:path';
import { z } from 'zod';
import { readCoordinatorUsage } from '../coordinator-usage.js';
import { getProviderConfigSnapshot, getProviderModels } from '../providers/index.js';
import { getTemplatesSnapshot } from '../templates.js';
import type { SwarmSnapshot } from '../types.js';
import {
  APP_RESOURCE_URI,
  ArenaContestantSchema,
  CustomCommandSchema,
  DESTRUCTIVE_ANNOTATIONS,
  PermissionModeSchema,
  READ_ONLY_ANNOTATIONS,
  RoutingPolicySchema,
  WRITE_EXTERNAL_ANNOTATIONS,
  WRITE_LOCAL_ANNOTATIONS,
  WorkspaceModeSchema,
  buildBoardSnapshot,
  formatSwarmSummary,
  redactMemberForModel,
  redactProviderForModel,
  redactSwarmForModel,
  safeTool,
  textResult,
  toCustomProviderConfig,
  toRoutingPolicy,
  type ToolContext,
} from './common.js';

export function registerModelTools(ctx: ToolContext): void {
  const { server, store, runtime, dataDir, brainDir } = ctx;

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
          .describe(
            'Kill stalled worker when silent on stdout/stderr for N seconds (0 disables, default 120).',
          ),
        profile: z
          .string()
          .optional()
          .describe('dsh profile name when using dsh workers (default "headless"; never pass "desktop").'),
        default_provider: z
          .string()
          .optional()
          .describe(
            'Default CLI provider ID ("dsh", "claude", "codex", "gemini", or custom ID). Auto-detected if omitted.',
          ),
        active_providers: z
          .array(z.string().min(1))
          .optional()
          .describe(
            'Optional multi-select CLI working pool for this swarm (e.g. ["dsh", "claude", "codex"]); workers rotate across this pool when provider is omitted.',
          ),
        routing_policy: RoutingPolicySchema.optional().describe(
          'Optional role routing (writer_providers, reader_providers) and auto_failover policy.',
        ),
        coordinator_conversation_id: z
          .string()
          .optional()
          .describe(
            'Optional Antigravity conversation ID for main-model Token/Cache telemetry (auto-detected if omitted).',
          ),
      },
    },
    safeTool(async (args) => {
      const state = await runtime.createSwarm({
        title: args.title,
        repoRoot: args.repo_root,
        maxConcurrency: args.max_concurrency,
        maxHops: args.max_hops,
        turnTimeoutSeconds: args.turn_timeout_seconds,
        stallTimeoutSeconds: args.stall_timeout_seconds,
        profile: args.profile,
        defaultProvider: args.default_provider,
        activeProviders: args.active_providers,
        routingPolicy: toRoutingPolicy(args.routing_policy),
        coordinatorConversationId: args.coordinator_conversation_id,
      });
      return textResult({ ok: true, swarm: state });
    }),
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
      return textResult({
        defaultProvider: snap.effectiveDefaultProvider,
        configuredDefaultProvider: snap.configuredDefaultProvider,
        activePool: snap.activePool,
        routingPolicy: snap.routingPolicy,
        globalConfigPath: snap.globalConfigPath,
        globalConfigExists: snap.globalConfigExists,
        needsOnboarding: !store.getUiPrefs().onboardingCompleted && !snap.globalConfigExists,
        repoConfigPath: snap.repoConfigPath,
        repoConfigExists: snap.repoConfigExists,
        providers: snap.providers.map(redactProviderForModel),
      });
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
      return textResult(getProviderModels(provider, dataDir, resolvedRepo, profile || undefined));
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
          .describe(
            'Single CLI provider ID: "dsh", "claude", "codex", "gemini", "custom", or a custom ID from providers.json.',
          ),
        providers: z
          .array(z.string().min(1))
          .optional()
          .describe(
            'Optional multi-select CLI providers: when passed with `tasks`, shards distribute round-robin across CLIs; when passed without `tasks`, launches one worker per selected CLI.',
          ),
        models_by_provider: z
          .record(z.string())
          .optional()
          .describe(
            'Optional per-provider model map (providerId -> modelId) used with multi-select `providers` or pool routing.',
          ),
        custom_command: CustomCommandSchema.describe(
          'Inline custom CLI configuration when spawning any third-party CLI command.',
        ),
        model: z
          .string()
          .optional()
          .describe('Model ID for this worker (omit to use provider default).'),
        permission_mode: PermissionModeSchema.optional().describe(
          'Sandbox permission preset (default "workspace-write").',
        ),
        workspace: WorkspaceModeSchema.optional().describe(
          'Workspace isolation mode (default "worktree" for writers in git repos).',
        ),
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
          .describe(
            'Deterministically run verify_commands in worker cwd after each completed turn and post results to the board (default false).',
          ),
        depends_on: z
          .array(z.string().min(1))
          .optional()
          .describe(
            'Optional upstream worker names that must finish (status=waiting, turns>=1) before this worker unlocks and starts.',
          ),
        arena_group: z.string().optional().describe('Optional arena comparison group label.'),
      },
    },
    safeTool(async (args) => {
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
      return textResult({
        ok: true,
        ...res,
        added: res.added.map(redactMemberForModel),
      });
    }),
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
    safeTool(({ swarm_id, text }) => {
      const message = runtime.postAsCoordinator(swarm_id, text);
      return textResult({ ok: true, message });
    }),
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
    safeTool(({ swarm_id, since, limit }) => {
      const swarm = store.getSwarm(swarm_id);
      store.drainInbox(swarm.id);
      const messages = store.readBoard(swarm.id, since ?? 0, limit ?? 100);
      return textResult({
        swarmId: swarm.id,
        headSeq: swarm.headSeq,
        messages,
      });
    }),
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
    safeTool(async ({ swarm_id, include_diff }) => {
      const res = await runtime.getStatus(swarm_id, include_diff ?? false);
      const { usage: coordinatorUsage } = readCoordinatorUsage(brainDir, res.swarm);
      return textResult({
        ...res,
        swarm: redactSwarmForModel(res.swarm),
        coordinatorUsage,
      });
    }),
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
        worker_name: z.string().optional().describe('Worker name when until="worker_done".'),
      },
    },
    safeTool(async ({ swarm_id, since, timeout_seconds, until, worker_name }) => {
      const res = await runtime.waitForCondition({
        swarmId: swarm_id,
        since,
        timeoutSeconds: timeout_seconds,
        until,
        workerName: worker_name,
      });
      return textResult(res);
    }),
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
    safeTool(async ({ swarm_id, name, remove_worktree }) => {
      const res = await runtime.killWorker(swarm_id, name, remove_worktree ?? false);
      return textResult({ ok: true, ...res });
    }),
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
        provider: z
          .string()
          .optional()
          .describe('New CLI provider ID (clears old CLI sessionId when switching CLIs).'),
        custom_command: CustomCommandSchema.describe(
          'Inline custom CLI config if switching to provider="custom".',
        ),
        model: z.string().optional().describe('New model ID to use on this worker.'),
        prompt: z.string().optional().describe('Optional follow-up instruction posted to wake the worker.'),
        retry: z
          .boolean()
          .optional()
          .describe(
            'Immediately enqueue/wake worker to resume work (default true if prompt omitted? Specify true to run immediately).',
          ),
      },
    },
    safeTool(async (args) => {
      const res = await runtime.updateAndRetryWorker({
        swarmId: args.swarm_id,
        name: args.name,
        provider: args.provider,
        customCommand: toCustomProviderConfig(args.custom_command),
        model: args.model,
        prompt: args.prompt,
        retry: args.retry,
      });
      return textResult({
        ok: true,
        ...res,
        member: redactMemberForModel(res.member),
      });
    }),
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
    safeTool(async ({ swarm_id, remove_worktrees }) => {
      const res = await runtime.deleteSwarm(swarm_id, remove_worktrees ?? true);
      return textResult({ ok: true, ...res });
    }),
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
    safeTool(async ({ swarm_id }) => {
      const swarm = store.getSwarm(swarm_id);
      const { usage: coordinatorUsage } = readCoordinatorUsage(brainDir, swarm);
      const cfg = getProviderConfigSnapshot(dataDir, swarm.repoRoot, swarm.profile);
      const res = await runtime.exportSwarmMarkdown(swarm.id, coordinatorUsage, cfg.pricing);
      return textResult({ ok: true, ...res });
    }),
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
    safeTool(async ({ swarm_id, worker, action, mode, target_branch, commit_message, remove_worktree }) => {
      if ((action || 'preview') === 'preview') {
        const preview = await runtime.previewWorkerMerge({
          swarmId: swarm_id,
          workerName: worker,
          targetBranch: target_branch,
        });
        return textResult({ ok: true, preview });
      }
      const result = await runtime.mergeWorker({
        swarmId: swarm_id,
        workerName: worker,
        targetBranch: target_branch,
        mode,
        commitMessage: commit_message,
        removeWorktreeAfter: remove_worktree,
      });
      return textResult({ ok: result.merged, ...result }, !result.merged);
    }),
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
          .array(ArenaContestantSchema)
          .min(2)
          .describe('List of 2 or more provider/model configurations to race in parallel worktrees.'),
        base_name: z.string().optional().describe('Optional arena group prefix (e.g. "arena-auth").'),
        permission: PermissionModeSchema.optional().describe(
          'Default permission mode for contestants (default "workspace-write").',
        ),
      },
    },
    safeTool(async ({ swarm_id, task, contestants, base_name, permission }) => {
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
      return textResult({ ok: true, ...res });
    }),
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
    safeTool(async ({ swarm_id, target_worker, reviewer_provider, reviewer_model, reviewer_name, rubric }) => {
      const res = await runtime.startCrossReview({
        swarmId: swarm_id,
        targetWorker: target_worker,
        reviewerProvider: reviewer_provider,
        reviewerModel: reviewer_model,
        reviewerName: reviewer_name,
        rubric,
      });
      return textResult({ ok: true, ...res });
    }),
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
    safeTool(({ swarm_id, repo_root }) => {
      const swarm = store.tryGetSwarm(swarm_id);
      return textResult(getTemplatesSnapshot(dataDir, repo_root?.trim() || swarm?.repoRoot));
    }),
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
    safeTool(async ({ swarm_id, template_id, goal, repo_root, title, provider_overrides, model_overrides }) => {
      const res = await runtime.applyTemplate({
        swarmId: swarm_id,
        templateId: template_id,
        goal,
        repoRoot: repo_root,
        title,
        providerOverrides: provider_overrides,
        modelOverrides: model_overrides,
      });
      return textResult({ ok: true, ...res });
    }),
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
      const snapshot = await buildBoardSnapshot(ctx, {
        swarmId: swarm_id,
        messageLimit: 200,
        includeDiff: false,
      });
      if (!snapshot.swarm) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No AGY Ext Swarm has been created yet. Use ext_swarm_create to start one.',
            },
          ],
          structuredContent: snapshot as Record<string, unknown>,
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: formatSwarmSummary(snapshot as SwarmSnapshot),
          },
        ],
        structuredContent: snapshot as unknown as Record<string, unknown>,
      };
    },
  );
}
