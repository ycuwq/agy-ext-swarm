import type { ChildProcess } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  getEffectiveDefaultFastMode,
  getEffectiveDefaultReasoningEffort,
  providerSupportsFastMode,
  providerSupportsReasoningEffort,
  sanitizeReasoningEffort,
} from '../shared/model-options.js';
import { isSafeConversationId } from './host/index.js';
import { validateWorkerName } from './mentions.js';
import { isValidDshProfileName } from './models.js';
import {
  getProviderConfigSnapshot,
  resolveDefaultProvider,
  resolveProviderAdapter,
} from './providers/index.js';
import { loadPricingCatalog } from './pricing-catalog.js';
import { buildSwarmMarkdownReport } from './report.js';
import {
  checkAndReleaseBlockedDependents,
  collectUpstreamContext,
  propagateBlockedDependencyFailures,
  type DependencyHost,
} from './runner-deps.js';
import {
  createWorkerPullRequest,
  getWorkerFullDiff,
  mergeWorker,
  previewWorkerMerge,
  type CreateWorkerPrOptions,
  type MergeWorkerOptions,
  type PreviewWorkerMergeOptions,
} from './runner-merge.js';
import {
  applyTemplate,
  startArena,
  startCrossReview,
  type ApplyTemplateOptions,
  type ApplyTemplateResult,
  type OrchestrationHost,
  type StartArenaOptions,
  type StartArenaResult,
  type StartCrossReviewOptions,
  type StartCrossReviewResult,
} from './runner-orchestration.js';
import { terminateProcessTreeWithEscalation } from './runner-process.js';
import type { PostTurnHost } from './runner-postturn.js';
import { buildInitialWorkerPrompt } from './runner-prompts.js';
import { planWorkerTargets } from './runner-targets.js';
import {
  applySwarmBudgetUpdate,
  computeSwarmEstimatedCostUsd,
  ProviderCooldownTracker,
} from './runner-guardrails.js';
import {
  getTaskRoutingCandidates,
  inferTaskCategory,
  isRateLimitOrQuotaError,
  pickTaskRoutingEntryForProvider,
  resolveDshModelSelection,
} from './runner-routing.js';
import type { SwarmStore } from './store.js';
import {
  runWorkerTurn,
  type QueuedTask,
  type TurnHost,
} from './runner-turn.js';
import {
  buildAsyncWaitCommand,
  postAsCoordinator,
  postAsCoordinatorWithDelivery,
  resolveWakeTargets,
  waitForCondition,
  type PostDeliverySummary,
  type WaitOptions,
} from './runner-wait.js';
import {
  DEFAULT_STALL_TIMEOUT_SECONDS,
  DEFAULT_TURN_TIMEOUT_SECONDS,
  MAX_STALL_TIMEOUT_SECONDS,
  MAX_TURN_TIMEOUT_SECONDS,
  MAX_VERIFY_TIMEOUT_SECONDS,
  type BoardMessage,
  type CreatePrResult,
  type CustomProviderConfig,
  type MemberState,
  type MergeApplyResult,
  type MergePreviewResult,
  type ModelPricing,
  type PermissionMode,
  type ProviderCooldownEntry,
  type ProviderDescriptor,
  type ProviderRoutingPolicy,
  type ScopeMode,
  type SwarmState,
  type TaskRoutingCategory,
  type WorkspaceMode,
  type WorktreeDiffSummary,
  type WorktreePatchResult,
} from './types.js';
import {
  createWorktree,
  detectGitRepo,
  getWorktreeDiff,
  hydrateWorktree,
  loadWorktreeHooksConfig,
  removeWorktree,
} from './worktree.js';
import { activeWorktreeHookProcs } from './worktree-hooks.js';

function resolveWorkerModelOptions(
  providerId: string,
  requestedModel: string,
  descriptor: ProviderDescriptor | undefined,
  customCommand: CustomProviderConfig | undefined,
  rawEffort: string | undefined,
  rawFast: boolean | undefined,
) {
  const capabilityHint = customCommand
    ? { kind: 'custom' as const, args: customCommand.args, resumeArgs: customCommand.resumeArgs }
    : descriptor;
  const supportsEffort = providerSupportsReasoningEffort(providerId, capabilityHint);
  const supportsFast = providerSupportsFastMode(providerId, capabilityHint);
  const reasoningEffort = supportsEffort ? sanitizeReasoningEffort(rawEffort) : undefined;
  const fastMode = supportsFast ? rawFast : undefined;
  const resolvedModel =
    requestedModel === 'default' &&
    descriptor?.detectedDefaultModel &&
    descriptor.detectedDefaultModel !== 'default'
      ? descriptor.detectedDefaultModel
      : undefined;
  const modelForCap =
    resolvedModel || (requestedModel && requestedModel !== 'default' ? requestedModel : undefined);
  const resolvedReasoningEffort =
    !reasoningEffort && supportsEffort
      ? getEffectiveDefaultReasoningEffort(descriptor, modelForCap, { includeConfigured: false })
      : undefined;
  const resolvedFastMode =
    fastMode === undefined && supportsFast
      ? getEffectiveDefaultFastMode(descriptor, modelForCap, { includeConfigured: false })
      : undefined;
  return {
    reasoningEffort,
    fastMode,
    resolvedModel,
    resolvedReasoningEffort,
    resolvedFastMode,
  };
}

export interface AddWorkerInput {
  swarmId?: string;
  name: string;
  brief: string;
  tasks?: string[];
  provider?: string;
  providers?: string[];
  modelsByProvider?: Record<string, string>;
  customCommand?: CustomProviderConfig;
  model?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  permissionMode?: PermissionMode;
  workspace?: WorkspaceMode;
  role?: string;
  taskType?: TaskRoutingCategory;
  allowedFiles?: string[];
  scopeMode?: ScopeMode;
  verifyCommands?: string[];
  autoVerify?: boolean;
  verifyTimeoutSeconds?: number;
  maxVerifyRetries?: number;
  dependsOn?: string[];
  arenaGroup?: string;
  turnTimeoutSeconds?: number;
}

export interface AddWorkerResult {
  swarmId: string;
  added: MemberState[];
  warnings: string[];
  briefSeqs: number[];
}

export type { PostDeliverySummary, WaitOptions } from './runner-wait.js';

export class SwarmRuntime {
  private readonly store: SwarmStore;
  private readonly pluginRoot: string;
  private readonly boardCli: string;
  private readonly pendingWorkerAdds = new Map<string, Promise<AddWorkerResult>>();
  private readonly activeTurns = new Set<string>();
  private readonly runningProcs = new Map<string, ChildProcess>();
  private readonly activeVerifyProcs = new Map<ChildProcess, { key: string }>();
  private readonly queues = new Map<string, QueuedTask[]>();
  private readonly initialPrompts = new Map<string, string>();
  private readonly cooldowns = new ProviderCooldownTracker();
  private shuttingDown = false;

  constructor(store: SwarmStore, pluginRoot: string) {
    this.store = store;
    this.pluginRoot = pluginRoot;
    this.boardCli = join(this.pluginRoot, 'bin', 'ext-board.mjs');

    this.store.on('message', (swarmId: string, msg: BoardMessage) => {
      this.handleBoardMessage(swarmId, msg);
    });

    for (const s of this.store.listSwarms()) {
      this.store.startInboxWatcher(s.id);
      this.propagateBlockedDependencyFailures(s.id);
      void this.checkAndReleaseBlockedDependents(s.id).catch((err) => {
        console.error(`[agy-ext-swarm] Failed to restore blocked workers for ${s.id}:`, err);
      });
    }
  }

  private procKey(swarmId: string, memberName: string): string {
    return `${swarmId}:${memberName}`;
  }

  async createSwarm(params: {
    title: string;
    repoRoot: string;
    maxConcurrency?: number;
    maxHops?: number;
    turnTimeoutSeconds?: number;
    stallTimeoutSeconds?: number;
    maxCostUsd?: number;
    profile?: string;
    defaultProvider?: string;
    activeProviders?: string[];
    routingPolicy?: ProviderRoutingPolicy;
    coordinatorConversationId?: string;
  }): Promise<SwarmState> {
    const resolvedRoot = resolve(params.repoRoot);
    if (!existsSync(resolvedRoot)) {
      throw new Error(`repo_root does not exist: ${resolvedRoot}`);
    }
    const absRoot = realpathSync(resolvedRoot);
    const trimmedConvId = params.coordinatorConversationId?.trim();
    if (trimmedConvId && !isSafeConversationId(trimmedConvId)) {
      throw new Error(
        `Invalid coordinator_conversation_id "${params.coordinatorConversationId}". Must match ^[a-zA-Z0-9_-]{1,128}$.`,
      );
    }
    const requestedProfile = params.profile?.trim();
    if (
      requestedProfile !== undefined &&
      requestedProfile !== '' &&
      (!isValidDshProfileName(requestedProfile) || requestedProfile.toLowerCase() === 'desktop')
    ) {
      throw new Error(
        `Invalid dsh profile "${params.profile}". Must match ^[a-zA-Z0-9_-]{1,64}$ and cannot be "desktop".`,
      );
    }
    const gitInfo = await detectGitRepo(absRoot);
    const id = `sw-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
    const providerSnap = getProviderConfigSnapshot(
      this.store.dataDir,
      absRoot,
      requestedProfile || undefined,
    );
    const snapDshProfile = providerSnap.providers.find((p) => p.id === 'dsh')?.profile?.trim();
    const dshProfile =
      requestedProfile ||
      (snapDshProfile &&
      isValidDshProfileName(snapDshProfile) &&
      snapDshProfile.toLowerCase() !== 'desktop'
        ? snapDshProfile
        : 'headless');

    const cleanActiveProviders = params.activeProviders
      ? [...new Set(params.activeProviders.map((p) => p.trim().toLowerCase()).filter(Boolean))]
      : providerSnap.activePool && providerSnap.activePool.length > 0
        ? [...providerSnap.activePool]
        : undefined;

    const fallbackRouting = providerSnap.routingPolicy;
    const dedupeLower = (items: string[]): string[] => [
      ...new Set(items.map((p) => p.trim().toLowerCase()).filter(Boolean)),
    ];
    const mergedRoutingPolicy: ProviderRoutingPolicy | undefined = params.routingPolicy
      ? (() => {
          const delegationMode =
            params.routingPolicy.delegationMode ?? fallbackRouting?.delegationMode;
          const taskRouting =
            fallbackRouting?.taskRouting || params.routingPolicy.taskRouting
              ? {
                  ...(fallbackRouting?.taskRouting || {}),
                  ...(params.routingPolicy.taskRouting || {}),
                }
              : undefined;
          const routingNotes =
            params.routingPolicy.routingNotes !== undefined
              ? params.routingPolicy.routingNotes.trim() || undefined
              : fallbackRouting?.routingNotes;
          const writerProviders =
            params.routingPolicy.writerProviders !== undefined
              ? dedupeLower(params.routingPolicy.writerProviders)
              : fallbackRouting?.writerProviders;
          const readerProviders =
            params.routingPolicy.readerProviders !== undefined
              ? dedupeLower(params.routingPolicy.readerProviders)
              : fallbackRouting?.readerProviders;
          const autoFailover =
            params.routingPolicy.autoFailover ?? fallbackRouting?.autoFailover;
          return {
            ...(writerProviders && writerProviders.length > 0 ? { writerProviders } : {}),
            ...(readerProviders && readerProviders.length > 0 ? { readerProviders } : {}),
            ...(autoFailover !== undefined ? { autoFailover } : {}),
            ...(delegationMode ? { delegationMode } : {}),
            ...(taskRouting && Object.keys(taskRouting).length > 0 ? { taskRouting } : {}),
            ...(routingNotes ? { routingNotes } : {}),
          };
        })()
      : fallbackRouting
        ? { ...fallbackRouting }
        : undefined;

    const defaultProvider =
      params.defaultProvider?.trim().toLowerCase() ||
      (cleanActiveProviders && cleanActiveProviders[0]) ||
      providerSnap.effectiveDefaultProvider ||
      resolveDefaultProvider(this.store.dataDir, absRoot);
    const rawTurnTimeout =
      typeof params.turnTimeoutSeconds === 'number'
        ? params.turnTimeoutSeconds
        : (providerSnap.defaultTurnTimeoutSeconds ?? DEFAULT_TURN_TIMEOUT_SECONDS);
    const turnTimeoutSeconds = Math.min(
      MAX_TURN_TIMEOUT_SECONDS,
      Math.max(0, Math.floor(rawTurnTimeout)),
    );
    const rawStallTimeout =
      typeof params.stallTimeoutSeconds === 'number'
        ? params.stallTimeoutSeconds
        : (providerSnap.defaultStallTimeoutSeconds ?? DEFAULT_STALL_TIMEOUT_SECONDS);
    const stallTimeoutSeconds = Math.min(
      MAX_STALL_TIMEOUT_SECONDS,
      Math.max(0, Math.floor(rawStallTimeout)),
    );
    const maxCostUsd =
      typeof params.maxCostUsd === 'number' && Number.isFinite(params.maxCostUsd) && params.maxCostUsd > 0
        ? Math.min(10000, Math.round(params.maxCostUsd * 10000) / 10000)
        : undefined;
    const state = this.store.createSwarm({
      id,
      title: params.title.trim() || 'AGY Ext Swarm',
      repoRoot: absRoot,
      gitRepoRoot: gitInfo?.repoRoot,
      gitCommonDir: gitInfo?.gitCommonDir,
      coordinatorConversationId: trimmedConvId || undefined,
      defaultProvider,
      activeProviders: cleanActiveProviders,
      routingPolicy: mergedRoutingPolicy,
      profile: dshProfile,
      maxConcurrency: Math.max(1, Math.min(16, params.maxConcurrency ?? 4)),
      maxHops: Math.max(1, Math.min(50, params.maxHops ?? 12)),
      turnTimeoutSeconds,
      stallTimeoutSeconds,
      ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    });
    this.store.startInboxWatcher(state.id);
    return state;
  }

  async addWorker(input: AddWorkerInput): Promise<AddWorkerResult> {
    const swarmId = this.store.resolveSwarmId(input.swarmId);
    const previous = this.pendingWorkerAdds.get(swarmId);
    // Serialize allocation and setup within a swarm so names, indexes and routing
    // cursor values stay reserved until their members are persisted.
    const pending = Promise.resolve(previous)
      .catch(() => undefined)
      .then(() => this.addWorkerToSwarm(swarmId, input));
    this.pendingWorkerAdds.set(swarmId, pending);
    try {
      return await pending;
    } finally {
      if (this.pendingWorkerAdds.get(swarmId) === pending) this.pendingWorkerAdds.delete(swarmId);
    }
  }

  private async addWorkerToSwarm(swarmId: string, input: AddWorkerInput): Promise<AddWorkerResult> {
    if (this.shuttingDown) throw new Error('Swarm runtime is shutting down.');
    const swarm = this.store.getSwarm(swarmId);
    const warnings: string[] = [];

    const providerSnap = getProviderConfigSnapshot(
      this.store.dataDir,
      swarm.repoRoot,
      swarm.profile,
    );
    const permissionMode: PermissionMode = input.permissionMode || 'workspace-write';
    const requestedWorkspace: WorkspaceMode = input.workspace || 'worktree';
    const role = (input.role || 'worker').trim() || 'worker';
    const allowedFiles = input.allowedFiles?.map((s) => s.trim()).filter(Boolean);
    const scopeMode: ScopeMode | undefined =
      input.scopeMode === 'warn' ? 'warn' : input.scopeMode === 'enforce' ? 'enforce' : undefined;
    const verifyCommands = input.verifyCommands?.map((s) => s.trim()).filter(Boolean);
    const verifyTimeoutSeconds =
      typeof input.verifyTimeoutSeconds === 'number' && Number.isFinite(input.verifyTimeoutSeconds)
        ? Math.min(MAX_VERIFY_TIMEOUT_SECONDS, Math.max(10, Math.floor(input.verifyTimeoutSeconds)))
        : undefined;
    const memberTurnTimeout =
      typeof input.turnTimeoutSeconds === 'number' && Number.isFinite(input.turnTimeoutSeconds)
        ? Math.min(MAX_TURN_TIMEOUT_SECONDS, Math.max(0, Math.floor(input.turnTimeoutSeconds)))
        : undefined;
    const maxVerifyRetries =
      typeof input.maxVerifyRetries === 'number' && Number.isFinite(input.maxVerifyRetries)
        ? Math.min(5, Math.max(0, Math.floor(input.maxVerifyRetries)))
        : 0;

    const explicitProviders = (input.providers || [])
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean);

    const category = inferTaskCategory(
      role,
      permissionMode,
      Boolean(input.tasks?.length),
      input.taskType,
    );

    const planned = planWorkerTargets({
      swarm,
      providerSnap,
      name: input.name,
      brief: input.brief,
      tasks: input.tasks,
      provider: input.provider,
      providers: input.providers,
      customCommand: input.customCommand,
      permissionMode,
      category,
      cooldownProviderIds: this.getCooldownProviderIdSet(),
    });
    const targets = planned.targets;
    const advancesRrCursor = planned.usedRouter && planned.nextRrCursor !== (swarm.rrCursor || 0);

    for (const t of targets) {
      if (swarm.members[t.name]) {
        throw new Error(
          `Worker "${t.name}" already exists in swarm "${swarm.id}" (status: ${swarm.members[t.name].status}). Killed names cannot be reused.`,
        );
      }
      if (t.providerId === 'custom' && !input.customCommand) {
        throw new Error('custom_command is required when provider="custom".');
      }
      resolveProviderAdapter(t.providerId, input.customCommand, this.store.dataDir, swarm.repoRoot);
    }

    const dependsOn = input.dependsOn
      ? [...new Set(input.dependsOn.map((d) => d.trim().toLowerCase()).filter(Boolean))]
      : [];
    const fanBaseCheck = validateWorkerName(input.name);
    const arenaGroup =
      input.arenaGroup?.trim() ||
      (explicitProviders.length >= 2 && (!input.tasks || input.tasks.length === 0) && fanBaseCheck.valid
        ? `multi-${fanBaseCheck.normalized}`
        : undefined);

    if (dependsOn.length > 0) {
      const targetNameSet = new Set(targets.map((t) => t.name));
      for (const depName of dependsOn) {
        if (targetNameSet.has(depName)) {
          throw new Error(`Worker cannot depend on itself ("${depName}").`);
        }
        const depMember = swarm.members[depName];
        if (!depMember) {
          throw new Error(
            `Dependency worker "${depName}" does not exist in swarm "${swarm.id}".`,
          );
        }
        if (depMember.status === 'failed' || depMember.status === 'killed') {
          throw new Error(
            `Cannot depend on worker "${depName}" because its status is already "${depMember.status}".`,
          );
        }
      }
    }

    const allDepsReady = () => dependsOn.every((depName) => {
      const dep = swarm.members[depName];
      return Boolean(dep && dep.status === 'waiting' && dep.turns > 0);
    });

    const added: MemberState[] = [];
    const briefSeqs: number[] = [];
    const wtConfig = swarm.gitRepoRoot ? loadWorktreeHooksConfig(swarm.gitRepoRoot) : null;
    let nextWorkerIndex =
      Math.max(
        0,
        ...Object.values(this.store.getSwarm(swarm.id).members).map((m) => m.workerIndex || 0),
      ) + 1;

    for (const target of targets) {
      const providerId = target.providerId;
      const adapter = resolveProviderAdapter(
        providerId,
        input.customCommand,
        this.store.dataDir,
        swarm.repoRoot,
      );
      const descriptor = !input.customCommand
        ? providerSnap.providers.find((p) => p.id === providerId)
        : undefined;

      const taskEntry = pickTaskRoutingEntryForProvider(
        swarm,
        providerId,
        permissionMode,
        category,
      );
      const explicitModel =
        input.modelsByProvider?.[providerId]?.trim() || input.model?.trim() || '';
      const requestedModel =
        explicitModel ||
        target.routedModel ||
        taskEntry?.model?.trim() ||
        descriptor?.defaultModel ||
        adapter.defaultModel ||
        'default';
      const taskEntryModel = taskEntry?.model?.trim();
      const useTaskEntryOptions =
        !explicitModel ||
        !taskEntryModel ||
        explicitModel.toLowerCase() === taskEntryModel.toLowerCase();
      const routedModel = target.routedModel?.trim();
      const useRoutedOptions =
        !explicitModel ||
        !routedModel ||
        explicitModel.toLowerCase() === routedModel.toLowerCase();
      const rawEffort =
        sanitizeReasoningEffort(input.reasoningEffort) ??
        (useRoutedOptions ? sanitizeReasoningEffort(target.routedReasoningEffort) : undefined) ??
        (useTaskEntryOptions ? sanitizeReasoningEffort(taskEntry?.reasoningEffort) : undefined) ??
        sanitizeReasoningEffort(descriptor?.configuredDefaultReasoningEffort);
      const rawFast =
        typeof input.fastMode === 'boolean'
          ? input.fastMode
          : useRoutedOptions && typeof target.routedFastMode === 'boolean'
            ? target.routedFastMode
            : useTaskEntryOptions && typeof taskEntry?.fastMode === 'boolean'
              ? taskEntry.fastMode
              : descriptor?.configuredDefaultFastMode;
      const modelOptions = resolveWorkerModelOptions(
        providerId,
        requestedModel,
        descriptor,
        input.customCommand,
        rawEffort,
        rawFast,
      );
      let modelProvider: string | undefined;

      if (providerId === 'dsh') {
        const resolved = resolveDshModelSelection(requestedModel, descriptor);
        modelProvider = resolved.modelProvider;
        const effectiveProfile = descriptor?.profile || swarm.profile || 'headless';
        if (input.model?.trim() && requestedModel !== 'default' && !resolved.isKnown) {
          warnings.push(
            `Model "${requestedModel}" is not listed in configured models or dsh lastCatalog; dsh may reject it unless supported by profile "${effectiveProfile}".`,
          );
        }
      }

      let effectiveWorkspace: WorkspaceMode = requestedWorkspace;
      let workerCwd = swarm.repoRoot;
      let branch: string | undefined;
      let baseRef: string | undefined;
      const workerIndex = nextWorkerIndex++;
      const portOffset =
        (wtConfig?.portOffsetBase ?? 0) + workerIndex * (wtConfig?.portOffsetStep ?? 100);

      let upstreamSummary = '';
      let member: MemberState;
      const previousCursor = swarm.rrCursor;
      try {
        if (requestedWorkspace === 'worktree') {
          if (!swarm.gitRepoRoot) {
            effectiveWorkspace = 'inherit';
            warnings.push(
              `Worker "${target.name}" requested workspace="worktree", but "${swarm.repoRoot}" is not a git repository with commits; falling back to workspace="inherit".`,
            );
          } else {
            const wt = await createWorktree(
              swarm.gitRepoRoot,
              swarm.id,
              target.name,
              this.store.getWorktreesDir(swarm.id),
            );
            workerCwd = wt.worktreePath;
            branch = wt.branch;
            baseRef = wt.baseRef;
            if (wtConfig) {
              const hydrated = await hydrateWorktree({
                repoRoot: swarm.gitRepoRoot,
                worktreePath: workerCwd,
                workerName: target.name,
                workerIndex,
                portOffset,
                config: wtConfig,
              });
              if (hydrated.warnings.length > 0) {
                warnings.push(...hydrated.warnings);
              }
              const parts: string[] = [];
              if (hydrated.copied.length > 0) {
                parts.push(`copied=${hydrated.copied.join(', ')}`);
              }
              if (hydrated.symlinked.length > 0) {
                parts.push(`symlinked=${hydrated.symlinked.join(', ')}`);
              }
              if (hydrated.setupRan) {
                parts.push(`setup=${hydrated.setupOk ? 'ok' : 'failed'}`);
              }
              if (parts.length > 0) {
                this.store.appendBoardMessage(swarm.id, {
                  agent: 'system',
                  text: `[worktree-hydrate] ${target.name} (index=${workerIndex}, portOffset=${portOffset}): ${parts.join(' | ')}`,
                  kind: hydrated.setupOk ? 'system' : 'warning',
                });
              }
            }
          }
        }
        if (dependsOn.length > 0 && allDepsReady()) {
          upstreamSummary = await this.collectUpstreamContext(swarm.id, dependsOn);
        }
        if (!this.store.tryGetSwarm(swarm.id) || this.shuttingDown) {
          throw new Error(`Swarm "${swarm.id}" is no longer accepting workers.`);
        }
        const now = new Date().toISOString();
        const shouldBlock = !allDepsReady();
        member = {
          name: target.name,
          role,
          status: shouldBlock ? 'blocked' : 'queued',
          model: requestedModel,
          provider: providerId,
          modelProvider,
          ...modelOptions,
          customConfig: input.customCommand,
          permissionMode,
          workspaceMode: effectiveWorkspace,
          cwd: workerCwd,
          branch,
          baseRef,
          turns: 0,
          steps: 0,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            cacheReadTokens: 0,
          },
          lastReadSeq: swarm.headSeq,
          pendingWake: false,
          allowedFiles: allowedFiles && allowedFiles.length > 0 ? allowedFiles : undefined,
          ...(scopeMode ? { scopeMode } : {}),
          verifyCommands: verifyCommands && verifyCommands.length > 0 ? verifyCommands : undefined,
          autoVerify: input.autoVerify ? true : undefined,
          ...(verifyTimeoutSeconds !== undefined ? { verifyTimeoutSeconds } : {}),
          ...(maxVerifyRetries > 0 ? { maxVerifyRetries, verifyRetriesUsed: 0 } : {}),
          dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
          pendingBrief: shouldBlock ? target.taskText : undefined,
          arenaGroup,
          turnTimeoutSeconds: memberTurnTimeout,
          workerIndex,
          portOffset,
          retryTurns: 0,
          createdAt: now,
          updatedAt: now,
        };

        // Persist the routing advance with the member, so failed setup leaves it reusable.
        if (advancesRrCursor) swarm.rrCursor = (swarm.rrCursor || 0) + 1;
        this.store.upsertMember(swarm.id, member);
      } catch (err) {
        swarm.rrCursor = previousCursor;
        delete swarm.members[target.name];
        if (branch && !this.shuttingDown) {
          await removeWorktree(swarm.gitRepoRoot, workerCwd, branch, target.name);
        }
        throw err;
      }

      if (member.status === 'blocked') {
        const blockMsg = this.store.appendBoardMessage(swarm.id, {
          agent: 'system',
          text: `Worker "${member.name}" added as blocked (waiting on: ${dependsOn.join(', ')}).`,
          kind: 'system',
        });
        briefSeqs.push(blockMsg.seq);
        member.lastReadSeq = blockMsg.seq;
        this.store.upsertMember(swarm.id, member);
      } else {
        const promptTaskText = upstreamSummary
          ? `${target.taskText}\n\n${upstreamSummary}`
          : target.taskText;
        const briefMsg = this.store.appendBoardMessage(swarm.id, {
          agent: 'coordinator',
          text: `@${member.name} ${target.taskText}`,
          kind: 'brief',
        });
        briefSeqs.push(briefMsg.seq);

        member.lastReadSeq = briefMsg.seq;
        this.store.upsertMember(swarm.id, member);

        const initialPrompt = buildInitialWorkerPrompt({
          swarm,
          member,
          brief: promptTaskText,
          briefSeq: briefMsg.seq,
          swarmDir: this.store.getSwarmDir(swarm.id),
          boardCli: this.boardCli,
        });
        this.initialPrompts.set(this.procKey(swarm.id, member.name), initialPrompt);
        this.enqueueTask({
          swarmId: swarm.id,
          memberName: member.name,
          overridePrompt: initialPrompt,
          maxDeliveredSeq: briefMsg.seq,
        });
      }

      added.push(member);
    }

    if (added.some((member) => member.status === 'blocked')) {
      await this.checkAndReleaseBlockedDependents(swarm.id);
    }

    return { swarmId: swarm.id, added, warnings, briefSeqs };
  }

  private handleBoardMessage(swarmId: string, msg: BoardMessage): void {
    if (this.shuttingDown) return;
    if (
      msg.kind === 'brief' ||
      msg.kind === 'system' ||
      msg.kind === 'warning' ||
      msg.kind === 'error'
    ) {
      return;
    }

    const swarm = this.store.tryGetSwarm(swarmId);
    if (!swarm) return;

    if (msg.agent === 'coordinator') {
      if (swarm.hopCount !== 0) {
        swarm.hopCount = 0;
        this.store.saveState(swarm);
      }
    }

    const { targets } = resolveWakeTargets(swarm.members, msg.agent, msg.all, msg.mentions);
    if (targets.length === 0) return;

    if (msg.agent !== 'coordinator') {
      if (swarm.hopCount >= swarm.maxHops) {
        this.store.appendBoardMessage(swarmId, {
          agent: 'system',
          text: `@coordinator [circuit-breaker] Autonomous hop limit (${swarm.maxHops}) reached; pausing automatic worker-to-worker wakes until coordinator posts.`,
          kind: 'system',
        });
        return;
      }
      swarm.hopCount += 1;
      this.store.saveState(swarm);
    }

    for (const targetName of targets) {
      const target = swarm.members[targetName];
      if (!target || target.status === 'killed') continue;

      if (msg.agent !== targetName && target.maxVerifyRetries) {
        target.verifyRetriesUsed = 0;
      }

      if (target.status === 'working' || target.status === 'queued') {
        target.pendingWake = true;
        this.store.upsertMember(swarmId, target);
      } else {
        target.status = 'queued';
        target.pendingWake = false;
        this.store.upsertMember(swarmId, target);
        this.enqueueTask({
          swarmId,
          memberName: targetName,
          maxDeliveredSeq: msg.seq,
        });
      }
    }
  }

  private enqueueTask(task: QueuedTask, opts?: { front?: boolean }): void {
    const queue = this.queues.get(task.swarmId) || [];
    const alreadyQueued = queue.some((t) => t.memberName === task.memberName);
    if (!alreadyQueued) {
      if (opts?.front) {
        queue.unshift(task);
      } else {
        queue.push(task);
      }
      this.queues.set(task.swarmId, queue);
    }
    this.pumpQueue(task.swarmId);
  }

  private countRunningInSwarm(swarmId: string): number {
    const prefix = `${swarmId}:`;
    let count = 0;
    for (const key of this.activeTurns) {
      if (key.startsWith(prefix)) count += 1;
    }
    return count;
  }

  getActiveCooldowns(): Record<string, ProviderCooldownEntry> {
    return this.cooldowns.getActive();
  }

  clearProviderCooldown(providerId: string): boolean {
    return this.cooldowns.clear(providerId);
  }

  private getCooldownProviderIdSet(): Set<string> {
    return this.cooldowns.getActiveIdSet();
  }

  private markProviderCooldown(
    swarmId: string | undefined,
    providerId: string,
    reason: string,
  ): ProviderCooldownEntry | null {
    return this.cooldowns.mark(this.store, swarmId, providerId, reason);
  }

  computeSwarmEstimatedCostUsd(swarm: SwarmState): number {
    return computeSwarmEstimatedCostUsd(this.store.dataDir, swarm);
  }

  updateSwarmBudget(
    swarmId: string | undefined,
    opts: { maxCostUsd?: number | null; resume?: boolean },
  ): SwarmState {
    const { swarm, shouldPump } = applySwarmBudgetUpdate(this.store, swarmId, opts);
    if (shouldPump) {
      this.pumpQueue(swarm.id);
    }
    return this.store.getSwarm(swarm.id);
  }

  private pumpQueue(swarmId: string): void {
    if (this.shuttingDown) return;
    const swarm = this.store.tryGetSwarm(swarmId);
    if (!swarm) return;
    if (swarm.budgetPaused) return;

    const queue = this.queues.get(swarmId);
    if (!queue || queue.length === 0) return;

    if (swarm.maxCostUsd && swarm.maxCostUsd > 0 && !swarm.budgetBypassed) {
      const estUsd = this.computeSwarmEstimatedCostUsd(swarm);
      if (estUsd >= swarm.maxCostUsd) {
        swarm.budgetPaused = true;
        swarm.budgetPausedReason = `Estimated worker cost ($${estUsd.toFixed(4)}) reached budget cap ($${swarm.maxCostUsd.toFixed(4)})`;
        this.store.saveState(swarm);
        this.store.appendBoardMessage(swarmId, {
          agent: 'system',
          text: `@coordinator [warning] [budget-cap] ${swarm.budgetPausedReason}. Paused queued turns; raise or clear max_cost_usd to resume.`,
          kind: 'warning',
        });
        return;
      }
    }

    while (queue.length > 0 && this.countRunningInSwarm(swarmId) < swarm.maxConcurrency) {
      // Recovery turns may be enqueued before the previous turn releases its slot.
      const nextIndex = queue.findIndex(
        (task) => !this.activeTurns.has(this.procKey(swarmId, task.memberName)),
      );
      if (nextIndex < 0) break;
      const [next] = queue.splice(nextIndex, 1);
      const member = swarm.members[next.memberName];
      if (!member || member.status === 'killed') continue;

      const key = this.procKey(swarmId, next.memberName);
      this.activeTurns.add(key);
      void this.runWorkerTurn(swarmId, next)
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          this.failWorkerSafely(swarmId, next.memberName, message);
        })
        .finally(() => {
          this.activeTurns.delete(key);
          this.pumpQueue(swarmId);
        });
    }
  }

  private tryFailoverWorker(
    swarmId: string,
    member: MemberState,
    reasonDetail: string,
    currentTurnPrompt?: string,
  ): boolean {
    const swarm = this.store.tryGetSwarm(swarmId);
    if (!swarm || !swarm.routingPolicy?.autoFailover) return false;
    if (member.status === 'killed' || member.customConfig) return false;

    const providerSnap = getProviderConfigSnapshot(
      this.store.dataDir,
      swarm.repoRoot,
      swarm.profile,
    );
    const category = inferTaskCategory(member.role, member.permissionMode, false);
    const cooldownSet = this.getCooldownProviderIdSet();
    const taskCandidates = getTaskRoutingCandidates(
      swarm,
      member.permissionMode,
      category,
      providerSnap,
      cooldownSet,
    );
    const rolePool =
      member.permissionMode === 'read-only'
        ? swarm.routingPolicy.readerProviders || []
        : swarm.routingPolicy.writerProviders || [];
    const combinedPool = [
      ...taskCandidates.map((t) => t.provider),
      ...rolePool,
      ...(swarm.activeProviders || []),
    ];
    const exhausted = new Set<string>([...(member.failedProviders || []), member.provider]);

    const seen = new Set<string>();
    const candidates: string[] = [];
    for (const id of combinedPool) {
      const norm = id.trim().toLowerCase();
      if (!norm || seen.has(norm) || exhausted.has(norm) || cooldownSet.has(norm)) continue;
      seen.add(norm);
      const desc = providerSnap.providers.find((p) => p.id === norm);
      if (desc && desc.enabled && desc.available) {
        candidates.push(norm);
      }
    }
    if (candidates.length === 0) return false;

    const nextId = candidates[0];
    const prevProvider = member.provider;
    let nextAdapter;
    try {
      nextAdapter = resolveProviderAdapter(nextId, undefined, this.store.dataDir, swarm.repoRoot);
    } catch {
      return false;
    }
    const nextDesc = providerSnap.providers.find((p) => p.id === nextId);
    const nextTask = taskCandidates.find((t) => t.provider === nextId);
    const taskModel = nextTask?.model?.trim();

    const nextModel = taskModel || nextDesc?.defaultModel || nextAdapter.defaultModel || 'default';
    const modelOptions = resolveWorkerModelOptions(
      nextId,
      nextModel,
      nextDesc,
      undefined,
      sanitizeReasoningEffort(nextTask?.reasoningEffort) ??
        nextDesc?.configuredDefaultReasoningEffort,
      nextTask?.fastMode ?? nextDesc?.configuredDefaultFastMode,
    );
    member.failedProviders = [...new Set([...(member.failedProviders || []), prevProvider])];
    Object.assign(member, modelOptions, { provider: nextId, model: nextModel });
    member.modelProvider =
      nextId === 'dsh'
        ? resolveDshModelSelection(nextModel, nextDesc).modelProvider
        : undefined;
    member.sessionId = undefined;
    member.lastError = undefined;
    member.activity = `failover -> ${nextId}`;
    member.retryTurns += 1;
    member.status = 'queued';
    this.store.upsertMember(swarmId, member);

    this.store.appendBoardMessage(swarmId, {
      agent: 'system',
      text: `@coordinator [warning] [failover] Worker "${member.name}" switched from ${prevProvider} to ${nextId} after error: ${reasonDetail.slice(0, 360)}`,
      kind: 'warning',
    });

    const pKey = this.procKey(swarmId, member.name);
    const savedInitial = this.initialPrompts.get(pKey);
    const fallbackBrief =
      currentTurnPrompt ||
      savedInitial ||
      this.store.findWorkerBrief(swarmId, member.name)?.text ||
      member.role;
    const failoverPrompt = `[Failover Recovery Notice: previous CLI "${prevProvider}" failed (${reasonDetail.slice(0, 220)}). You are now continuing seamlessly in existing workspace "${member.cwd}"${member.branch ? ` (branch=${member.branch})` : ''}. Inspect current workspace files first, avoid redoing finished edits, and complete the task cleanly.]\n\n${fallbackBrief}`;

    this.initialPrompts.set(pKey, failoverPrompt);
    this.enqueueTask({
      swarmId,
      memberName: member.name,
      overridePrompt: failoverPrompt,
      maxDeliveredSeq: member.lastReadSeq,
    });
    return true;
  }

  private failWorkerSafely(
    swarmId: string,
    memberName: string,
    reasonText: string,
    opts?: { skipFailover?: boolean; currentTurnPrompt?: string },
  ): void {
    try {
      const currentSwarm = this.store.tryGetSwarm(swarmId);
      const currentMember = currentSwarm?.members[memberName];
      if (!currentSwarm || !currentMember || currentMember.status === 'killed') {
        this.pumpQueue(swarmId);
        return;
      }
      if (isRateLimitOrQuotaError(reasonText)) {
        this.markProviderCooldown(swarmId, currentMember.provider || 'dsh', reasonText);
      }
      if (!opts?.skipFailover && this.tryFailoverWorker(swarmId, currentMember, reasonText, opts?.currentTurnPrompt)) {
        return;
      }
      currentMember.status = 'failed';
      currentMember.pendingWake = false;
      currentMember.activity = undefined;
      currentMember.lastError = reasonText;
      currentMember.lastTurnFinishedAt = new Date().toISOString();
      this.store.upsertMember(swarmId, currentMember);
      this.store.appendBoardMessage(swarmId, {
        agent: memberName,
        text: `@coordinator [error] Worker failed: ${reasonText.slice(0, 600)}`,
        kind: 'error',
      });
      this.propagateBlockedDependencyFailures(swarmId);
    } catch (err) {
      console.error(`[agy-ext-swarm] failWorkerSafely error for ${swarmId}/${memberName}:`, err);
    } finally {
      this.pumpQueue(swarmId);
    }
  }

  private async runWorkerTurn(swarmId: string, task: QueuedTask): Promise<void> {
    return runWorkerTurn(this.turnHost(), swarmId, task);
  }

  private turnHost(): TurnHost {
    return {
      store: this.store,
      boardCli: this.boardCli,
      procKey: (swarmId, memberName) => this.procKey(swarmId, memberName),
      trackProcess: (key, proc) => this.runningProcs.set(key, proc),
      untrackProcess: (key) => this.runningProcs.delete(key),
      dropQueuedTasks: (swarmId) => this.queues.delete(swarmId),
      enqueueTask: (task, opts) => this.enqueueTask(task, opts),
      failWorkerSafely: (swarmId, memberName, reasonText, opts) =>
        this.failWorkerSafely(swarmId, memberName, reasonText, opts),
      tryFailoverWorker: (swarmId, member, reasonDetail, currentTurnPrompt) =>
        this.tryFailoverWorker(swarmId, member, reasonDetail, currentTurnPrompt),
      recordProviderFailure: (swarmId, providerId, reasonDetail) => {
        this.markProviderCooldown(swarmId, providerId, reasonDetail);
      },
      propagateBlockedDependencyFailures: (swarmId) =>
        this.propagateBlockedDependencyFailures(swarmId),
      checkAndReleaseBlockedDependents: (swarmId) =>
        this.checkAndReleaseBlockedDependents(swarmId),
      postTurnHost: () => this.postTurnHost(),
    };
  }

  postAsCoordinator(swarmId: string | undefined, text: string): BoardMessage {
    return postAsCoordinator(this.store, swarmId, text);
  }

  postAsCoordinatorWithDelivery(
    swarmId: string | undefined,
    text: string,
  ): { message: BoardMessage; delivery: PostDeliverySummary } {
    return postAsCoordinatorWithDelivery(this.store, swarmId, text);
  }

  buildAsyncWaitCommand(
    swarmId: string | undefined,
    opts?: {
      since?: number;
      until?: 'all_idle' | 'mentions_coordinator' | 'any_post' | 'worker_done';
      workerName?: string;
    },
  ): string {
    return buildAsyncWaitCommand(this.store, this.boardCli, swarmId, opts);
  }

  async getStatus(
    swarmId: string | undefined,
    includeDiff = false,
    skipDrain = false,
  ): Promise<{ swarm: SwarmState; diffs: Record<string, WorktreeDiffSummary | null> }> {
    const swarm = this.store.getSwarm(swarmId);
    if (!skipDrain) {
      this.store.drainInbox(swarm.id);
    }
    const diffs: Record<string, WorktreeDiffSummary | null> = {};
    if (includeDiff) {
      await Promise.all(
        Object.values(swarm.members).map(async (m) => {
          if (m.workspaceMode === 'worktree' && m.status !== 'killed') {
            diffs[m.name] = await getWorktreeDiff(m.cwd, m.baseRef, m.allowedFiles);
          } else {
            diffs[m.name] = null;
          }
        }),
      );
    }
    return { swarm, diffs };
  }

  async waitForCondition(opts: WaitOptions): Promise<{
    timedOut: boolean;
    reason: string;
    swarm: SwarmState;
    messages: BoardMessage[];
  }> {
    return waitForCondition(this.store, opts);
  }

  async getWorkerFullDiff(
    swarmId: string | undefined,
    name: string,
  ): Promise<WorktreePatchResult> {
    return getWorkerFullDiff(this.store, swarmId, name);
  }

  async killWorker(
    swarmId: string | undefined,
    name: string,
    removeWorktreeFlag = false,
  ): Promise<{ killed: string[]; removedWorktrees: string[] }> {
    const swarm = this.store.getSwarm(swarmId);
    const normalized = name.trim().toLowerCase();
    const targetNames: string[] = [];

    if (normalized === 'all') {
      targetNames.push(...Object.keys(swarm.members));
    } else if (swarm.members[normalized]) {
      targetNames.push(normalized);
    } else {
      // Check sharded group prefix
      const prefix = `${normalized}-`;
      for (const mName of Object.keys(swarm.members)) {
        if (mName.startsWith(prefix) && /^\d+$/.test(mName.slice(prefix.length))) {
          targetNames.push(mName);
        }
      }
    }

    if (targetNames.length === 0) {
      throw new Error(`No matching worker "${name}" in swarm "${swarm.id}".`);
    }

    const queue = this.queues.get(swarm.id);
    if (queue) {
      this.queues.set(
        swarm.id,
        queue.filter((t) => !targetNames.includes(t.memberName)),
      );
    }

    const killed: string[] = [];
    const removedWorktrees: string[] = [];

    const terminations = new Map<string, Promise<void[]>>();
    for (const tName of targetNames) {
      const member = swarm.members[tName];
      if (!member) continue;
      if (member.status !== 'killed') killed.push(tName);
      member.status = 'killed';
      member.pendingWake = false;
      member.activity = undefined;
      this.store.upsertMember(swarm.id, member);

      const pKey = this.procKey(swarm.id, tName);
      this.initialPrompts.delete(pKey);
      const stops: Promise<void>[] = [];
      const proc = this.runningProcs.get(pKey);
      if (proc) stops.push(terminateProcessTreeWithEscalation(proc, 3000));
      for (const [verifyProc, meta] of this.activeVerifyProcs) {
        if (meta.key === pKey) stops.push(terminateProcessTreeWithEscalation(verifyProc, 1500));
      }
      terminations.set(tName, Promise.all(stops));
    }

    if (removeWorktreeFlag) {
      for (const [tName, stopped] of terminations) {
        await stopped;
        const member = this.store.tryGetSwarm(swarm.id)?.members[tName];
        if (!member || member.workspaceMode !== 'worktree' || this.shuttingDown) continue;
        const res = await removeWorktree(swarm.gitRepoRoot, member.cwd, member.branch, tName);
        if (res.removedWorktree) {
          removedWorktrees.push(tName);
          member.branch = undefined;
          member.workspaceMode = 'inherit';
          member.cwd = swarm.repoRoot;
          if (this.store.tryGetSwarm(swarm.id)) this.store.upsertMember(swarm.id, member);
        }
      }
    }

    if (killed.length > 0) {
      this.store.appendBoardMessage(swarm.id, {
        agent: 'system',
        text: `Killed worker(s): ${killed.join(', ')}${removedWorktrees.length > 0 ? ` (removed worktrees: ${removedWorktrees.join(', ')})` : ''}`,
        kind: 'system',
      });
      this.propagateBlockedDependencyFailures(swarm.id);
    } else if (removedWorktrees.length > 0) {
      this.store.appendBoardMessage(swarm.id, {
        agent: 'system',
        text: `Removed worktree(s): ${removedWorktrees.join(', ')}`,
        kind: 'system',
      });
    }

    this.pumpQueue(swarm.id);
    return { killed, removedWorktrees };
  }

  async updateAndRetryWorker(opts: {
    swarmId?: string;
    name: string;
    provider?: string;
    model?: string;
    reasoningEffort?: string | null;
    fastMode?: boolean | null;
    customCommand?: CustomProviderConfig;
    resetSession?: boolean;
    prompt?: string;
    retry?: boolean;
  }): Promise<{ swarmId: string; member: MemberState; queued: boolean; warnings: string[] }> {
    const swarm = this.store.getSwarm(opts.swarmId);
    const normName = opts.name.trim().toLowerCase();
    const member = swarm.members[normName];
    if (!member) {
      throw new Error(`Worker "${opts.name}" not found in swarm "${swarm.id}".`);
    }
    if (member.status !== 'waiting' && member.status !== 'failed') {
      throw new Error(
        `Worker "${member.name}" cannot be updated/retried while status is "${member.status}". Only waiting or failed workers can switch provider/model or retry.`,
      );
    }

    const warnings: string[] = [];
    const nextProvider = (
      opts.provider?.trim() ||
      (opts.customCommand ? 'custom' : member.provider || swarm.defaultProvider || 'dsh')
    ).toLowerCase();
    if (nextProvider === 'custom' && !opts.customCommand && member.provider !== 'custom') {
      throw new Error('custom_command is required when switching to provider="custom".');
    }

    const effectiveCustomCmd =
      opts.customCommand ?? (nextProvider === member.provider ? member.customConfig : undefined);
    const adapter = resolveProviderAdapter(
      nextProvider,
      effectiveCustomCmd,
      this.store.dataDir,
      swarm.repoRoot,
    );

    const providerSnap = getProviderConfigSnapshot(
      this.store.dataDir,
      swarm.repoRoot,
      swarm.profile,
    );
    const descriptor = !effectiveCustomCmd
      ? providerSnap.providers.find((p) => p.id === nextProvider)
      : undefined;

    const providerChanged =
      nextProvider !== member.provider || Boolean(opts.customCommand);
    const requestedModel = opts.model?.trim();
    const nextModel =
      requestedModel ||
      (providerChanged
        ? effectiveCustomCmd?.defaultModel || descriptor?.defaultModel || adapter.defaultModel || 'default'
        : member.model);

    const sessionReset = Boolean(!providerChanged && opts.resetSession);
    if (providerChanged) {
      member.sessionId = undefined;
      member.failedProviders = undefined;
      member.customConfig = effectiveCustomCmd;
    } else if (opts.resetSession) {
      member.sessionId = undefined;
    }

    if (nextProvider === 'dsh') {
      const resolved = resolveDshModelSelection(nextModel, descriptor);
      member.modelProvider = resolved.modelProvider;
      const effectiveProfile = descriptor?.profile || swarm.profile || 'headless';
      if (requestedModel && nextModel !== 'default' && !resolved.isKnown) {
        warnings.push(
          `Model "${nextModel}" is not listed in configured models or dsh lastCatalog; dsh may reject it unless supported by profile "${effectiveProfile}".`,
        );
      }
    } else {
      member.modelProvider = undefined;
    }

    const modelChanged = nextModel !== member.model;
    const effortOverridden = opts.reasoningEffort !== undefined;
    const fastOverridden = opts.fastMode !== undefined;
    const retryOptions = resolveWorkerModelOptions(
      nextProvider,
      nextModel,
      descriptor,
      effectiveCustomCmd,
      effortOverridden
        ? (opts.reasoningEffort ?? undefined)
        : providerChanged ? descriptor?.configuredDefaultReasoningEffort : member.reasoningEffort,
      fastOverridden
        ? (opts.fastMode ?? undefined)
        : providerChanged ? descriptor?.configuredDefaultFastMode : member.fastMode,
    );
    const resetResolved = providerChanged || modelChanged || sessionReset;
    member.provider = nextProvider;
    member.model = nextModel;
    member.reasoningEffort = retryOptions.reasoningEffort;
    member.fastMode = retryOptions.fastMode;
    if (resetResolved) member.resolvedModel = retryOptions.resolvedModel;
    if (resetResolved || effortOverridden) {
      member.resolvedReasoningEffort = retryOptions.resolvedReasoningEffort;
    }
    if (resetResolved || fastOverridden) member.resolvedFastMode = retryOptions.resolvedFastMode;

    const shouldRun = Boolean(opts.retry || opts.prompt?.trim());
    if (shouldRun) {
      member.lastError = undefined;
      member.activity = undefined;
      member.retryTurns += 1;
      if (member.maxVerifyRetries) {
        member.verifyRetriesUsed = 0;
      }

      const optParts = [
        member.reasoningEffort ? `effort=${member.reasoningEffort}` : '',
        member.fastMode === true ? 'fast=on' : member.fastMode === false ? 'fast=off' : '',
      ].filter(Boolean);
      const optSuffix = optParts.length > 0 ? `, ${optParts.join(', ')}` : '';
      const actionVerb = sessionReset ? 'Starting fresh session' : 'Resuming';
      const postText = opts.prompt?.trim()
        ? `@${member.name} ${opts.prompt.trim()}`
        : `@${member.name} [retry #${member.retryTurns}] ${actionVerb} in workspace (provider=${nextProvider}, model=${nextModel}${optSuffix}). Please inspect current workspace state and complete your assigned task.`;
      this.store.appendBoardMessage(swarm.id, {
        agent: 'coordinator',
        text: postText,
        kind: 'message',
      });
    } else {
      this.store.upsertMember(swarm.id, member);
    }

    return {
      swarmId: swarm.id,
      member: this.store.getSwarm(swarm.id).members[normName],
      queued: shouldRun,
      warnings,
    };
  }

  async deleteSwarm(
    swarmId: string | undefined,
    removeWorktrees = true,
  ): Promise<{ deletedSwarmId: string; removedWorktrees: string[] }> {
    const swarm = this.store.getSwarm(swarmId);
    swarm.deleting = true;
    this.store.saveState(swarm);
    const memberKeys = Object.keys(swarm.members);
    let removedWorktrees: string[] = [];
    if (memberKeys.length > 0) {
      const killRes = await this.killWorker(swarm.id, 'all', removeWorktrees);
      removedWorktrees = killRes.removedWorktrees;
    }
    this.queues.delete(swarm.id);
    for (const pKey of Array.from(this.initialPrompts.keys())) {
      if (pKey.startsWith(`${swarm.id}:`)) {
        this.initialPrompts.delete(pKey);
      }
    }
    this.store.deleteSwarm(swarm.id);
    return { deletedSwarmId: swarm.id, removedWorktrees };
  }

  async exportSwarmMarkdown(
    swarmId: string | undefined,
    hostTelemetry?: import('./types.js').HostTelemetrySnapshot,
    pricing?: Record<string, ModelPricing>,
    displayOpts?: import('../shared/pricing.js').CostDisplayOptions,
  ): Promise<{ filename: string; markdown: string }> {
    const { swarm, diffs } = await this.getStatus(swarmId, true);
    const messages = this.store.readBoard(swarm.id, 0, 5000);
    const { pricing: catalogPricing } = loadPricingCatalog(this.store.dataDir);
    return buildSwarmMarkdownReport(
      swarm,
      diffs,
      messages,
      hostTelemetry,
      pricing,
      catalogPricing,
      displayOpts,
    );
  }

  private propagateBlockedDependencyFailures(swarmId: string): void {
    propagateBlockedDependencyFailures(this.store, swarmId);
  }

  private async collectUpstreamContext(swarmId: string, deps: string[]): Promise<string> {
    return collectUpstreamContext(this.store, swarmId, deps);
  }

  private async checkAndReleaseBlockedDependents(swarmId: string): Promise<void> {
    return checkAndReleaseBlockedDependents(this.depsHost(), swarmId);
  }

  private depsHost(): DependencyHost {
    return {
      store: this.store,
      boardCli: this.boardCli,
      onDependentReleased: (swarmId, memberName, initialPrompt, briefSeq) => {
        this.initialPrompts.set(this.procKey(swarmId, memberName), initialPrompt);
        this.enqueueTask({
          swarmId,
          memberName,
          overridePrompt: initialPrompt,
          maxDeliveredSeq: briefSeq,
        });
      },
    };
  }

  private postTurnHost(): PostTurnHost {
    return {
      store: this.store,
      activeVerifyProcs: this.activeVerifyProcs,
      isShuttingDown: () => this.shuttingDown,
      enqueueTask: (task, opts) => this.enqueueTask(task, opts),
    };
  }

  private orchestrationHost(): OrchestrationHost {
    return {
      store: this.store,
      addWorker: (input) => this.addWorker(input),
      createSwarm: (params) => this.createSwarm(params),
    };
  }

  async previewWorkerMerge(opts: PreviewWorkerMergeOptions): Promise<MergePreviewResult> {
    return previewWorkerMerge(this.store, opts);
  }

  async mergeWorker(opts: MergeWorkerOptions): Promise<MergeApplyResult> {
    return mergeWorker(this.store, opts);
  }

  async createWorkerPullRequest(opts: CreateWorkerPrOptions): Promise<CreatePrResult> {
    return createWorkerPullRequest(this.store, opts);
  }

  async startArena(opts: StartArenaOptions): Promise<StartArenaResult> {
    return startArena(this.orchestrationHost(), opts);
  }

  async startCrossReview(opts: StartCrossReviewOptions): Promise<StartCrossReviewResult> {
    return startCrossReview(this.orchestrationHost(), opts);
  }

  async applyTemplate(opts: ApplyTemplateOptions): Promise<ApplyTemplateResult> {
    return applyTemplate(this.orchestrationHost(), opts);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    try {
      this.store.closeAllWatchers();
    } finally {
      const processes = [
        ...this.runningProcs.values(),
        ...this.activeVerifyProcs.keys(),
        ...activeWorktreeHookProcs,
      ];
      await Promise.all(processes.map((proc) => terminateProcessTreeWithEscalation(proc, 400)));
    }
  }
}
