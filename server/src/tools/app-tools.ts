import { join, resolve } from 'node:path';
import { z } from 'zod';
import { readCoordinatorUsage } from '../coordinator-usage.js';
import {
  getProviderConfigSnapshot,
  saveProviderConfigPatch,
  testProviderConnection,
} from '../providers/index.js';
import { getTemplatesSnapshot, saveTemplatePatch } from '../templates.js';
import type { SwarmSnapshot } from '../types.js';
import {
  APP_ONLY_META,
  ArenaContestantSchema,
  DESTRUCTIVE_ANNOTATIONS,
  PermissionModeSchema,
  ProviderEntryConfigInputSchema,
  READ_ONLY_ANNOTATIONS,
  RoutingPolicySchema,
  UpsertTemplateSchema,
  WRITE_EXTERNAL_ANNOTATIONS,
  WRITE_LOCAL_ANNOTATIONS,
  WorkspaceModeSchema,
  appResult,
  buildBoardSnapshot,
  formatSwarmSummary,
  readTailLines,
  safeTool,
  toRoutingPolicy,
  type ToolContext,
} from './common.js';

export function registerAppTools(ctx: ToolContext): void {
  const { server, store, runtime, dataDir, brainDir } = ctx;

  // 1. app_get_snapshot
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
      _meta: APP_ONLY_META,
    },
    async ({ swarm_id, include_diff }) => {
      const snapshot = await buildBoardSnapshot(ctx, {
        swarmId: swarm_id,
        messageLimit: 300,
        includeDiff: include_diff ?? true,
      });
      if (!snapshot.swarm) {
        return appResult(snapshot as Record<string, unknown>, 'No swarm found');
      }
      return appResult(
        snapshot as unknown as Record<string, unknown>,
        formatSwarmSummary(snapshot as SwarmSnapshot),
      );
    },
  );

  // 2. app_set_ui_prefs
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
      _meta: APP_ONLY_META,
    },
    async ({ locale, onboarding_completed }) => {
      const uiPrefs = store.setUiPrefs({ locale, onboardingCompleted: onboarding_completed });
      return appResult({ ok: true, uiPrefs });
    },
  );

  // 3. app_get_provider_config
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
      _meta: APP_ONLY_META,
    },
    async ({ swarm_id, repo_root }) => {
      const swarm = store.tryGetSwarm(swarm_id);
      const effectiveRepo = repo_root ? resolve(repo_root) : swarm?.repoRoot;
      const providerConfig = getProviderConfigSnapshot(dataDir, effectiveRepo, swarm?.profile, true);
      return appResult({ ok: true, providerConfig });
    },
  );

  // 4. app_save_provider_config
  server.registerTool(
    'app_save_provider_config',
    {
      title: 'Save CLI & Model Config',
      description:
        'Persist CLI provider enablement, default provider, model lists, optional pricing, and custom CLI definitions to global providers.json.',
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
      _meta: APP_ONLY_META,
    },
    safeTool(
      ({
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
        return appResult({ ok: true, providerConfig });
      },
    ),
  );

  // 5. app_get_worker_diff
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
      _meta: APP_ONLY_META,
    },
    safeTool(async ({ swarm_id, name }) => {
      const diff = await runtime.getWorkerFullDiff(swarm_id, name);
      return appResult({ ok: true, diff });
    }),
  );

  // 6. app_retry_worker
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
      _meta: APP_ONLY_META,
    },
    safeTool(async ({ swarm_id, name, provider, model, prompt }) => {
      const res = await runtime.updateAndRetryWorker({
        swarmId: swarm_id,
        name,
        provider,
        model,
        prompt,
        retry: true,
      });
      return appResult({ ok: true, ...res });
    }),
  );

  // 7. app_test_provider
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
      _meta: APP_ONLY_META,
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
      return appResult({ ok: true, result });
    },
  );

  // 8. app_delete_swarm
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
      _meta: APP_ONLY_META,
    },
    safeTool(async ({ swarm_id, remove_worktrees }) => {
      const res = await runtime.deleteSwarm(swarm_id, remove_worktrees ?? true);
      return appResult({ ok: true, ...res, swarms: store.listSwarms() });
    }),
  );

  // 9. app_export_swarm
  server.registerTool(
    'app_export_swarm',
    {
      title: 'Export Swarm Report from UI',
      description: 'Generate downloadable Markdown post-mortem report for a swarm.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional(),
      },
      _meta: APP_ONLY_META,
    },
    safeTool(async ({ swarm_id }) => {
      const swarm = store.getSwarm(swarm_id);
      const { usage: coordinatorUsage } = readCoordinatorUsage(brainDir, swarm);
      const cfg = getProviderConfigSnapshot(dataDir, swarm.repoRoot, swarm.profile);
      const res = await runtime.exportSwarmMarkdown(swarm.id, coordinatorUsage, cfg.pricing);
      return appResult({ ok: true, ...res });
    }),
  );

  // 10. app_bind_conversation
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
      _meta: APP_ONLY_META,
    },
    safeTool(({ swarm_id, conversation_id }) => {
      const swarm = store.setCoordinatorConversation(swarm_id, conversation_id);
      const { usage: coordinatorUsage } = readCoordinatorUsage(brainDir, swarm);
      return appResult({ ok: true, swarm, coordinatorUsage }, `Bound ${conversation_id}`);
    }),
  );

  // 11. app_post_message
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
      _meta: APP_ONLY_META,
    },
    safeTool(({ swarm_id, text }) => {
      const message = runtime.postAsCoordinator(swarm_id, text);
      return appResult({ ok: true, message }, `Posted #${message.seq}`);
    }),
  );

  // 12. app_kill_worker
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
      _meta: APP_ONLY_META,
    },
    safeTool(async ({ swarm_id, name, remove_worktree }) => {
      const res = await runtime.killWorker(swarm_id, name, remove_worktree ?? false);
      return appResult({ ok: true, ...res });
    }),
  );

  // 13. app_get_worker_log
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
      _meta: APP_ONLY_META,
    },
    safeTool(({ swarm_id, name, tail_lines }) => {
      const swarm = store.getSwarm(swarm_id);
      const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '');
      const logPath = join(store.getLogsDir(swarm.id), `${safeName}.ndjson`);
      const lines = readTailLines(logPath, tail_lines ?? 80);
      if (lines.length === 0) {
        return appResult({ name: safeName, lines: [] }, 'No logs yet.');
      }
      return appResult({ name: safeName, lines }, `Loaded ${lines.length} log lines`);
    }),
  );

  // 14. app_preview_merge
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
      _meta: APP_ONLY_META,
    },
    safeTool(async ({ swarm_id, name, target_branch }) => {
      const preview = await runtime.previewWorkerMerge({
        swarmId: swarm_id,
        workerName: name,
        targetBranch: target_branch,
      });
      return appResult({ ok: true, preview });
    }),
  );

  // 15. app_merge_worker
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
      _meta: APP_ONLY_META,
    },
    safeTool(async ({ swarm_id, name, mode, target_branch, commit_message, remove_worktree }) => {
      const result = await runtime.mergeWorker({
        swarmId: swarm_id,
        workerName: name,
        mode,
        targetBranch: target_branch,
        commitMessage: commit_message,
        removeWorktreeAfter: remove_worktree,
      });
      return appResult({ ok: result.merged, ...result }, undefined, !result.merged);
    }),
  );

  // 16. app_create_swarm
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
      _meta: APP_ONLY_META,
    },
    safeTool(
      async ({
        repo_root,
        title,
        default_provider,
        active_providers,
        routing_policy,
        max_concurrency,
        max_hops,
      }) => {
        const swarm = await runtime.createSwarm({
          repoRoot: repo_root,
          title: title?.trim() || 'Swarm',
          defaultProvider: default_provider,
          activeProviders: active_providers,
          routingPolicy: toRoutingPolicy(routing_policy),
          maxConcurrency: max_concurrency,
          maxHops: max_hops,
        });
        return appResult({ ok: true, swarm }, `Created swarm ${swarm.id}`);
      },
    ),
  );

  // 17. app_add_worker
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
        permission_mode: PermissionModeSchema.optional(),
        workspace: WorkspaceModeSchema.optional(),
        role: z.string().optional(),
        allowed_files: z.array(z.string().min(1)).optional(),
        verify_commands: z.array(z.string().min(1)).optional(),
        auto_verify: z.boolean().optional(),
        depends_on: z.array(z.string().min(1)).optional(),
        arena_group: z.string().optional(),
      },
      _meta: APP_ONLY_META,
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
      return appResult({ ok: true, ...res });
    }),
  );

  // 18. app_start_arena
  server.registerTool(
    'app_start_arena',
    {
      title: 'App Start Arena',
      description: 'Launch an isolated multi-CLI arena competition directly from UI.',
      annotations: WRITE_EXTERNAL_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional(),
        task: z.string().min(1),
        contestants: z.array(ArenaContestantSchema).min(2),
        base_name: z.string().optional(),
        permission: PermissionModeSchema.optional(),
      },
      _meta: APP_ONLY_META,
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
      return appResult({ ok: true, ...res });
    }),
  );

  // 19. app_cross_review
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
      _meta: APP_ONLY_META,
    },
    safeTool(async ({ swarm_id, target_worker, reviewer_provider, reviewer_model, rubric }) => {
      const res = await runtime.startCrossReview({
        swarmId: swarm_id,
        targetWorker: target_worker,
        reviewerProvider: reviewer_provider,
        reviewerModel: reviewer_model,
        rubric,
      });
      return appResult({ ok: true, ...res });
    }),
  );

  // 20. app_get_templates
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
      _meta: APP_ONLY_META,
    },
    async ({ swarm_id, repo_root }) => {
      const swarm = store.tryGetSwarm(swarm_id);
      const templatesConfig = getTemplatesSnapshot(dataDir, repo_root?.trim() || swarm?.repoRoot);
      return appResult({ ok: true, templatesConfig });
    },
  );

  // 21. app_save_template
  server.registerTool(
    'app_save_template',
    {
      title: 'App Save Template',
      description: 'Create, update, or remove a custom swarm team template in global templates.json.',
      annotations: WRITE_LOCAL_ANNOTATIONS,
      inputSchema: {
        swarm_id: z.string().optional(),
        remove_template_id: z.string().optional(),
        upsert_template: UpsertTemplateSchema.optional(),
      },
      _meta: APP_ONLY_META,
    },
    safeTool(({ swarm_id, remove_template_id, upsert_template }) => {
      const swarm = store.tryGetSwarm(swarm_id);
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
      return appResult({ ok: true, templatesConfig });
    }),
  );

  // 22. app_apply_template
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
      _meta: APP_ONLY_META,
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
      return appResult({ ok: true, ...res });
    }),
  );
}
