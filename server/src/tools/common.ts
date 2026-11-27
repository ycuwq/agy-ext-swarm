import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sanitizeReasoningEffort } from '../../shared/model-options.js';
import { readHostTelemetry } from '../host/index.js';
import { attachPricingCatalogToSnapshot } from '../pricing-catalog.js';
import { getProviderConfigSnapshot } from '../providers/index.js';
import type { SwarmRuntime } from '../runner.js';
import type { SwarmStore } from '../store.js';
import { getTemplatesSnapshot } from '../templates.js';
import {
  MAX_TURN_TIMEOUT_SECONDS,
  type CustomProviderConfig,
  type MemberState,
  type ProviderDescriptor,
  type ProviderEntryConfig,
  type ProviderRoutingPolicy,
  type SwarmSnapshot,
  type SwarmState,
  type TaskModelTarget,
  type TaskRoutingCategory,
  type TaskRoutingMap,
} from '../types.js';

export const APP_RESOURCE_URI = 'ui://agy-ext-swarm/board.html';
export const APP_MIME_TYPE = 'text/html;profile=mcp-app';

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const WRITE_LOCAL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export const WRITE_EXTERNAL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export const DESTRUCTIVE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export const APP_ONLY_META = {
  ui: {
    visibility: ['app'] as Array<'app' | 'model'>,
  },
};

export interface ToolContext {
  server: McpServer;
  store: SwarmStore;
  runtime: SwarmRuntime;
  dataDir: string;
  brainDir: string | null;
}

export const PermissionModeSchema = z.enum([
  'read-only',
  'workspace-write',
  'danger-full-access',
]);

export const WorkspaceModeSchema = z.enum(['worktree', 'inherit']);

export const ScopeModeSchema = z.enum(['enforce', 'warn']);

export const CustomCommandSchema = z
  .object({
    displayName: z.string().optional(),
    command: z.string().min(1).describe('Executable binary name or path.'),
    args: z
      .array(z.string())
      .optional()
      .describe(
        'CLI args; supports {{prompt}}, {{model}}, {{reasoningEffort}}, {{fastMode}}, {{cwd}}, {{sessionId}}, {{permissionMode}}, {{workerName}}, {{swarmDir}}, {{gitCommonDir}}, {{boardCli}}.',
      ),
    resume_args: z.array(z.string()).optional(),
    prompt_mode: z.enum(['stdin', 'arg']).optional(),
    output_format: z.enum(['text', 'ndjson']).optional(),
    env: z.record(z.string()).optional(),
    defaultModel: z.string().optional(),
    models: z.array(z.string()).optional(),
  })
  .optional();

export const TaskRoutingCategorySchema = z.enum([
  'complex',
  'coding',
  'frontend',
  'review',
  'research',
  'batch',
]);

export const DelegationModeSchema = z.enum(['balanced', 'prefer-external', 'manual-only']);

export const TaskModelTargetSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().optional(),
    reasoning_effort: z.string().optional(),
    fast_mode: z.boolean().optional(),
  })
  .strict();

export const RoutingPolicySchema = z
  .object({
    writer_providers: z.array(z.string().min(1)).optional(),
    reader_providers: z.array(z.string().min(1)).optional(),
    auto_failover: z.boolean().optional(),
    delegation_mode: DelegationModeSchema.optional(),
    task_routing: z
      .object({
        complex: z.array(TaskModelTargetSchema).optional(),
        coding: z.array(TaskModelTargetSchema).optional(),
        frontend: z.array(TaskModelTargetSchema).optional(),
        review: z.array(TaskModelTargetSchema).optional(),
        research: z.array(TaskModelTargetSchema).optional(),
        batch: z.array(TaskModelTargetSchema).optional(),
      })
      .strict()
      .optional(),
    routing_notes: z.string().max(600).optional(),
  })
  .strict();

export const ProviderEntryConfigInputSchema = z.object({
  enabled: z.boolean().optional(),
  displayName: z.string().optional(),
  command: z.string().optional(),
  defaultModel: z.string().optional(),
  defaultReasoningEffort: z.string().nullable().optional(),
  defaultFastMode: z.boolean().nullable().optional(),
  models: z.array(z.string()).optional(),
  profile: z.string().optional(),
  modelProvider: z.string().optional(),
  args: z.array(z.string()).optional(),
  resumeArgs: z.array(z.string()).optional(),
  listModelsArgs: z.array(z.string()).optional(),
  promptMode: z.enum(['stdin', 'arg']).optional(),
  outputFormat: z.enum(['text', 'ndjson']).optional(),
  env: z.record(z.string()).optional(),
});

export const ArenaContestantSchema = z.object({
  name: z.string().optional(),
  provider: z.string().min(1),
  model: z.string().optional(),
  reasoning_effort: z.string().optional(),
  fast_mode: z.boolean().optional(),
  permission: PermissionModeSchema.optional(),
  role: z.string().optional(),
});

export const TemplateWorkerInputSchema = z.object({
  name: z.string().min(1),
  role: z.string().optional(),
  brief: z.string().min(1),
  provider: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  fastMode: z.boolean().optional(),
  workspace: WorkspaceModeSchema.optional(),
  permission: PermissionModeSchema.optional(),
  dependsOn: z.array(z.string()).optional(),
  allowedFiles: z.array(z.string()).optional(),
  scopeMode: ScopeModeSchema.optional(),
  verifyCommands: z.array(z.string()).optional(),
  autoVerify: z.boolean().optional(),
  verifyTimeoutSeconds: z.number().int().min(10).max(1800).optional(),
  maxVerifyRetries: z.number().int().min(0).max(5).optional(),
  turnTimeoutSeconds: z.number().int().min(0).max(MAX_TURN_TIMEOUT_SECONDS).optional(),
});

export const UpsertTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  defaultTitle: z.string().optional(),
  workers: z.array(TemplateWorkerInputSchema).min(1),
});

export function toCustomProviderConfig(
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

export function toProviderEntryConfig(
  raw: z.infer<typeof ProviderEntryConfigInputSchema> | null,
): ProviderEntryConfig | null {
  if (!raw) return null;
  const { defaultReasoningEffort, defaultFastMode, ...rest } = raw;
  const effort = sanitizeReasoningEffort(defaultReasoningEffort);
  return {
    ...rest,
    ...(effort ? { defaultReasoningEffort: effort } : {}),
    ...(typeof defaultFastMode === 'boolean' ? { defaultFastMode } : {}),
  };
}

export function toRoutingPolicy(
  raw: z.infer<typeof RoutingPolicySchema> | undefined,
): ProviderRoutingPolicy | undefined {
  if (!raw) return undefined;
  let taskRouting: TaskRoutingMap | undefined;
  if (raw.task_routing) {
    const out: TaskRoutingMap = {};
    for (const cat of [
      'complex',
      'coding',
      'frontend',
      'review',
      'research',
      'batch',
    ] as TaskRoutingCategory[]) {
      const items = raw.task_routing[cat];
      if (!items || items.length === 0) continue;
      const normalized: TaskModelTarget[] = items
        .map((t) => {
          const effort = sanitizeReasoningEffort(t.reasoning_effort);
          return {
            provider: t.provider.trim().toLowerCase(),
            ...(t.model?.trim() ? { model: t.model.trim() } : {}),
            ...(effort ? { reasoningEffort: effort } : {}),
            ...(typeof t.fast_mode === 'boolean' ? { fastMode: t.fast_mode } : {}),
          };
        })
        .filter((t) => Boolean(t.provider));
      if (normalized.length > 0) out[cat] = normalized;
    }
    if (Object.keys(out).length > 0) taskRouting = out;
  }
  const routingNotes = raw.routing_notes?.trim()
    ? raw.routing_notes.trim().slice(0, 600)
    : undefined;
  const out: ProviderRoutingPolicy = {
    ...(raw.writer_providers ? { writerProviders: raw.writer_providers } : {}),
    ...(raw.reader_providers ? { readerProviders: raw.reader_providers } : {}),
    ...(raw.auto_failover !== undefined ? { autoFailover: raw.auto_failover } : {}),
    ...(raw.delegation_mode ? { delegationMode: raw.delegation_mode } : {}),
    ...(taskRouting ? { taskRouting } : {}),
    ...(routingNotes ? { routingNotes } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

export function redactProviderForModel(
  provider: ProviderDescriptor,
): Omit<ProviderDescriptor, 'env'> & { envKeys?: string[] } {
  const { env, ...rest } = provider;
  const envKeys = env ? Object.keys(env).sort() : [];
  return envKeys.length > 0 ? { ...rest, envKeys } : rest;
}

export function redactMemberForModel(member: MemberState): MemberState {
  const customConfig = member.customConfig;
  const rawEnv = customConfig?.env;
  if (!customConfig || !rawEnv || Object.keys(rawEnv).length === 0) return member;
  const redactedEnv: Record<string, string> = {};
  for (const key of Object.keys(rawEnv).sort()) {
    redactedEnv[key] = '***';
  }
  return {
    ...member,
    customConfig: {
      ...customConfig,
      env: redactedEnv,
    },
  };
}

export function redactSwarmForModel(swarm: SwarmState): SwarmState {
  const members: Record<string, MemberState> = {};
  for (const [k, m] of Object.entries(swarm.members)) {
    members[k] = redactMemberForModel(m);
  }
  return { ...swarm, members };
}

export function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function formatSwarmSummary(snapshot: SwarmSnapshot): string {
  const s = snapshot.swarm;
  const members = Object.values(s.members);
  const working = members.filter((m) => m.status === 'working' || m.status === 'queued').length;
  const waiting = members.filter((m) => m.status === 'waiting').length;
  const failed = members.filter((m) => m.status === 'failed').length;
  return `AGY Ext Swarm "${s.title}" (${s.id}) | head=#${s.headSeq} | members=${members.length} (working=${working}, waiting=${waiting}, failed=${failed})`;
}

export function toolError(err: unknown) {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
  };
}

export function textResult(payload: unknown, isError = false) {
  return {
    ...(isError ? { isError: true as const } : {}),
    content: [
      {
        type: 'text' as const,
        text: typeof payload === 'string' ? payload : jsonText(payload),
      },
    ],
  };
}

export function appResult<T extends Record<string, unknown>>(
  structuredContent: T,
  text?: string,
  isError = false,
) {
  return {
    ...(isError ? { isError: true as const } : {}),
    content: [{ type: 'text' as const, text: text ?? jsonText(structuredContent) }],
    structuredContent,
  };
}

export function safeTool<TArgs, TRes extends Record<string, unknown>>(
  fn: (args: TArgs) => Promise<TRes> | TRes,
): (args: TArgs) => Promise<TRes | ReturnType<typeof toolError>> {
  return async (args: TArgs) => {
    try {
      return await fn(args);
    } catch (err) {
      return toolError(err);
    }
  };
}

export function assertNotNestedWorker(toolName: string): void {
  const extWorker = process.env.EXT_SWARM_AGENT?.trim();
  const dshWorker = process.env.DSH_SWARM_AGENT?.trim();
  const worker = extWorker || dshWorker;
  if (worker) {
    const envVar = extWorker ? 'EXT_SWARM_AGENT' : 'DSH_SWARM_AGENT';
    throw new Error(
      `Nested swarm orchestration is disabled inside worker "${worker}" (${envVar} is set); "${toolName}" cannot be called from inside a swarm worker. Complete your assigned task directly and report findings via stdout or ext-board.`,
    );
  }
}

export function guardNestedTool<TArgs, TRes extends Record<string, unknown>>(
  toolName: string,
  fn: (args: TArgs) => Promise<TRes> | TRes,
): (args: TArgs) => Promise<TRes | ReturnType<typeof toolError>> {
  return safeTool(async (args: TArgs) => {
    assertNotNestedWorker(toolName);
    return await fn(args);
  });
}

export { readTailLines } from '../tail-file.js';

export async function buildProviderTelemetry(
  ctx: ToolContext,
  swarm: SwarmState | null | undefined,
  opts?: { repoRoot?: string; refresh?: boolean },
) {
  const hostTelemetry = await readHostTelemetry(
    ctx.brainDir,
    swarm ?? null,
    ctx.store.getUiPrefs().observedConversationId,
  );
  const baseProviderConfig = getProviderConfigSnapshot(
    ctx.dataDir,
    opts?.repoRoot ?? swarm?.repoRoot,
    swarm?.profile,
    { bypassCache: opts?.refresh, checkDshPlugins: opts?.refresh },
  );
  const cooldowns = ctx.runtime.getActiveCooldowns();
  const providerConfig = attachPricingCatalogToSnapshot(
    ctx.dataDir,
    {
      ...baseProviderConfig,
      ...(Object.keys(cooldowns).length > 0 ? { cooldowns } : {}),
    },
    swarm ?? null,
    hostTelemetry,
  );
  return { hostTelemetry, providerConfig };
}

export async function buildBoardSnapshot(
  ctx: ToolContext,
  opts: { swarmId?: string; messageLimit: number; includeDiff: boolean },
) {
  const swarms = ctx.store.listSwarms();
  const swarm = ctx.store.tryGetSwarm(opts.swarmId);
  const uiPrefs = ctx.store.getUiPrefs();
  const { hostTelemetry, providerConfig } = await buildProviderTelemetry(ctx, swarm);
  const templatesConfig = getTemplatesSnapshot(ctx.dataDir, swarm?.repoRoot);

  if (!swarm) {
    return {
      swarm: null,
      messages: [],
      edges: [],
      swarms,
      ...(opts.includeDiff ? { diffs: {} } : {}),
      hostTelemetry,
      providerConfig,
      templatesConfig,
      uiPrefs,
    };
  }

  ctx.store.drainInbox(swarm.id);
  const diffs = opts.includeDiff
    ? (await ctx.runtime.getStatus(swarm.id, true, true)).diffs
    : undefined;
  const messages = ctx.store.readBoard(swarm.id, 0, opts.messageLimit);
  const edges =
    messages.length < opts.messageLimit
      ? ctx.store.computeGraphEdges(swarm.id, messages)
      : ctx.store.computeGraphEdges(swarm.id);

  const snapshot: SwarmSnapshot = {
    swarm,
    messages,
    edges,
    swarms,
    ...(diffs !== undefined ? { diffs } : {}),
    hostTelemetry,
    providerConfig,
    templatesConfig,
    uiPrefs,
  };
  return snapshot;
}
