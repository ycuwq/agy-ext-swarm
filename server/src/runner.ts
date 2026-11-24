import type { ChildProcess } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isSafeConversationId } from './coordinator-usage.js';
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
  getWorkerFullDiff,
  mergeWorker,
  previewWorkerMerge,
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
import { killProcessTree, terminateProcessTreeWithEscalation } from './runner-process.js';
import type { PostTurnHost } from './runner-postturn.js';
import { buildInitialWorkerPrompt } from './runner-prompts.js';
import { planWorkerTargets } from './runner-targets.js';
import {
  getTaskRoutingCandidates,
  inferTaskCategory,
  pickModelForProviderFromTaskRouting,
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
  type BoardMessage,
  type CoordinatorUsageSummary,
  type CustomProviderConfig,
  type MemberState,
  type MergeApplyResult,
  type MergePreviewResult,
  type ModelPricing,
  type PermissionMode,
  type ProviderRoutingPolicy,
  type SwarmState,
  type TaskRoutingCategory,
  type WorkspaceMode,
  type WorktreeDiffSummary,
  type WorktreePatchResult,
} from './types.js';
import { createWorktree, detectGitRepo, getWorktreeDiff, removeWorktree } from './worktree.js';

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
  permissionMode?: PermissionMode;
  workspace?: WorkspaceMode;
  role?: string;
  taskType?: TaskRoutingCategory;
  allowedFiles?: string[];
  verifyCommands?: string[];
  autoVerify?: boolean;
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
  private readonly runningProcs = new Map<string, ChildProcess>();
  private readonly activeVerifyProcs = new Map<ChildProcess, { key: string }>();
  private readonly queues = new Map<string, QueuedTask[]>();
  private readonly initialPrompts = new Map<string, string>();
  private shuttingDown = false;

  constructor(store: SwarmStore, pluginRoot: string) {
    this.store = store;
    this.pluginRoot = pluginRoot;
    this.boardCli = join(this.pluginRoot, 'bin', 'ext-board.mjs');

    // Start inbox watchers for persisted swarms
    for (const s of this.store.listSwarms()) {
      this.store.startInboxWatcher(s.id);
    }

    this.store.on('message', (swarmId: string, msg: BoardMessage) => {
      this.handleBoardMessage(swarmId, msg);
    });
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
    });
    this.store.startInboxWatcher(state.id);
    return state;
  }

  async addWorker(input: AddWorkerInput): Promise<AddWorkerResult> {
    const swarm = this.store.getSwarm(input.swarmId);
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
    const verifyCommands = input.verifyCommands?.map((s) => s.trim()).filter(Boolean);
    const memberTurnTimeout =
      typeof input.turnTimeoutSeconds === 'number' && Number.isFinite(input.turnTimeoutSeconds)
        ? Math.min(MAX_TURN_TIMEOUT_SECONDS, Math.max(0, Math.floor(input.turnTimeoutSeconds)))
        : undefined;

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
    });
    const targets = planned.targets;
    let nextRrCursor = planned.nextRrCursor;
    const usedRouter = planned.usedRouter;

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

    const allDepsReady =
      dependsOn.length === 0 ||
      dependsOn.every((depName) => {
        const dep = swarm.members[depName];
        return Boolean(dep && dep.status === 'waiting' && dep.turns > 0);
      });

    if (usedRouter && nextRrCursor !== (swarm.rrCursor || 0)) {
      swarm.rrCursor = nextRrCursor;
      this.store.saveState(swarm);
    }

    const added: MemberState[] = [];
    const briefSeqs: number[] = [];

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

      const requestedModel =
        input.modelsByProvider?.[providerId]?.trim() ||
        input.model?.trim() ||
        target.routedModel ||
        pickModelForProviderFromTaskRouting(swarm, providerId, permissionMode, category) ||
        descriptor?.defaultModel ||
        adapter.defaultModel ||
        'default';
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
        }
      }

      const now = new Date().toISOString();
      const shouldBlock = dependsOn.length > 0 && !allDepsReady;
      const member: MemberState = {
        name: target.name,
        role,
        status: shouldBlock ? 'blocked' : 'queued',
        model: requestedModel,
        provider: providerId,
        modelProvider,
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
        verifyCommands: verifyCommands && verifyCommands.length > 0 ? verifyCommands : undefined,
        autoVerify: input.autoVerify ? true : undefined,
        dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
        pendingBrief: shouldBlock ? target.taskText : undefined,
        arenaGroup,
        turnTimeoutSeconds: memberTurnTimeout,
        retryTurns: 0,
        createdAt: now,
        updatedAt: now,
      };

      // Persist member before brief so mention parser recognizes the new name.
      this.store.upsertMember(swarm.id, member);

      if (shouldBlock) {
        const blockMsg = this.store.appendBoardMessage(swarm.id, {
          agent: 'system',
          text: `Worker "${member.name}" added as blocked (waiting on: ${dependsOn.join(', ')}).`,
          kind: 'system',
        });
        briefSeqs.push(blockMsg.seq);
        member.lastReadSeq = blockMsg.seq;
        this.store.upsertMember(swarm.id, member);
      } else {
        let promptTaskText = target.taskText;
        if (dependsOn.length > 0) {
          const upstreamSummary = await this.collectUpstreamContext(swarm.id, dependsOn);
          if (upstreamSummary) {
            promptTaskText = `${target.taskText}\n\n${upstreamSummary}`;
          }
        }
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

    if (dependsOn.length > 0 && !allDepsReady) {
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
    for (const key of this.runningProcs.keys()) {
      if (key.startsWith(prefix)) count += 1;
    }
    return count;
  }

  private pumpQueue(swarmId: string): void {
    if (this.shuttingDown) return;
    const swarm = this.store.tryGetSwarm(swarmId);
    if (!swarm) return;

    const queue = this.queues.get(swarmId);
    if (!queue || queue.length === 0) return;

    while (queue.length > 0 && this.countRunningInSwarm(swarmId) < swarm.maxConcurrency) {
      const next = queue.shift()!;
      const member = swarm.members[next.memberName];
      if (!member || member.status === 'killed') {
        continue;
      }
      if (this.runningProcs.has(this.procKey(swarmId, next.memberName))) {
        continue;
      }
      void this.runWorkerTurn(swarmId, next).catch((err) => {
        console.error(`[agy-ext-swarm] runWorkerTurn error for ${swarmId}/${next.memberName}:`, err);
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
    const taskCandidates = getTaskRoutingCandidates(
      swarm,
      member.permissionMode,
      category,
      providerSnap,
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
      if (!norm || seen.has(norm) || exhausted.has(norm)) continue;
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
    const taskModel = taskCandidates.find((t) => t.provider === nextId)?.model?.trim();

    const nextModel = taskModel || nextDesc?.defaultModel || nextAdapter.defaultModel || 'default';
    member.failedProviders = [...new Set([...(member.failedProviders || []), prevProvider])];
    member.provider = nextId;
    member.model = nextModel;
    member.modelProvider =
      nextId === 'dsh'
        ? resolveDshModelSelection(nextModel, nextDesc).modelProvider
        : undefined;
    member.sessionId = undefined;
    member.lastError = undefined;
    member.activity = `failover -> ${nextId}`;
    member.retryTurns += 1;
    member.status = 'queued';
    member.pendingWake = false;
    this.store.upsertMember(swarmId, member);

    const notice = this.store.appendBoardMessage(swarmId, {
      agent: 'system',
      text: `@coordinator [warning] [failover] Worker "${member.name}" switched from ${prevProvider} to ${nextId} after error: ${reasonDetail.slice(0, 360)}`,
      kind: 'warning',
    });

    const pKey = this.procKey(swarmId, member.name);
    const savedInitial = this.initialPrompts.get(pKey);
    const fallbackBrief =
      currentTurnPrompt ||
      savedInitial ||
      this.store
        .readBoard(swarmId, 0, 500)
        .find((m) => m.kind === 'brief' && m.mentions.includes(member.name))?.text ||
      member.role;
    const failoverPrompt = `[Failover Recovery Notice: previous CLI "${prevProvider}" failed (${reasonDetail.slice(0, 220)}). You are now continuing seamlessly in existing workspace "${member.cwd}"${member.branch ? ` (branch=${member.branch})` : ''}. Inspect current workspace files first, avoid redoing finished edits, and complete the task cleanly.]\n\n${fallbackBrief}`;

    this.initialPrompts.set(pKey, failoverPrompt);
    this.enqueueTask({
      swarmId,
      memberName: member.name,
      overridePrompt: failoverPrompt,
      maxDeliveredSeq: Math.max(member.lastReadSeq, notice.seq),
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
      pumpQueue: (swarmId) => this.pumpQueue(swarmId),
      enqueueTask: (task, opts) => this.enqueueTask(task, opts),
      failWorkerSafely: (swarmId, memberName, reasonText, opts) =>
        this.failWorkerSafely(swarmId, memberName, reasonText, opts),
      tryFailoverWorker: (swarmId, member, reasonDetail, currentTurnPrompt) =>
        this.tryFailoverWorker(swarmId, member, reasonDetail, currentTurnPrompt),
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

    for (const tName of targetNames) {
      const member = swarm.members[tName];
      if (!member) continue;
      const wasKilled = member.status === 'killed';
      member.status = 'killed';
      member.pendingWake = false;
      member.activity = undefined;
      this.store.upsertMember(swarm.id, member);

      const pKey = this.procKey(swarm.id, tName);
      this.initialPrompts.delete(pKey);
      const proc = this.runningProcs.get(pKey);
      if (proc && proc.exitCode === null && proc.signalCode === null) {
        terminateProcessTreeWithEscalation(proc, 3000);
      }

      for (const [vProc, meta] of this.activeVerifyProcs.entries()) {
        if (meta.key === pKey && vProc.exitCode === null && vProc.signalCode === null) {
          terminateProcessTreeWithEscalation(vProc, 1500);
        }
      }

      if (!wasKilled) {
        killed.push(tName);
      }

      if (removeWorktreeFlag && member.workspaceMode === 'worktree') {
        if (proc && proc.exitCode === null && proc.signalCode === null) {
          await new Promise<void>((resolveWait) => {
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              proc.off('exit', finish);
              proc.off('close', finish);
              resolveWait();
            };
            const timer = setTimeout(finish, 1000);
            timer.unref?.();
            proc.once('exit', finish);
            proc.once('close', finish);
            if (proc.exitCode !== null || proc.signalCode !== null) {
              finish();
            }
          });
        }
        const res = await removeWorktree(swarm.gitRepoRoot, member.cwd, member.branch);
        if (res.removedWorktree) {
          removedWorktrees.push(tName);
          member.branch = undefined;
          member.workspaceMode = 'inherit';
          member.cwd = swarm.repoRoot;
          this.store.upsertMember(swarm.id, member);
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
    customCommand?: CustomProviderConfig;
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
    const nextModel =
      opts.model?.trim() ||
      (providerChanged
        ? effectiveCustomCmd?.defaultModel || descriptor?.defaultModel || adapter.defaultModel || 'default'
        : member.model);

    if (providerChanged) {
      member.sessionId = undefined;
      member.failedProviders = undefined;
      member.customConfig = effectiveCustomCmd;
    }

    if (nextProvider === 'dsh') {
      const resolved = resolveDshModelSelection(nextModel, descriptor);
      member.modelProvider = resolved.modelProvider;
      const effectiveProfile = descriptor?.profile || swarm.profile || 'headless';
      if (opts.model?.trim() && nextModel !== 'default' && !resolved.isKnown) {
        warnings.push(
          `Model "${nextModel}" is not listed in configured models or dsh lastCatalog; dsh may reject it unless supported by profile "${effectiveProfile}".`,
        );
      }
    } else {
      member.modelProvider = undefined;
    }

    member.provider = nextProvider;
    member.model = nextModel;

    const shouldRun = Boolean(opts.retry || opts.prompt?.trim());
    if (shouldRun) {
      member.lastError = undefined;
      member.activity = undefined;
      member.retryTurns += 1;

      const postText = opts.prompt?.trim()
        ? `@${member.name} ${opts.prompt.trim()}`
        : `@${member.name} [retry #${member.retryTurns}] Resuming in workspace (provider=${nextProvider}, model=${nextModel}). Please inspect current workspace state and complete your assigned task.`;
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
    coordinatorUsage?: CoordinatorUsageSummary,
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
      coordinatorUsage,
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
      pumpQueue: (swarmId) => this.pumpQueue(swarmId),
    };
  }

  private orchestrationHost(): OrchestrationHost {
    return {
      store: this.store,
      addWorker: (input) => this.addWorker(input),
      getStatus: (swarmId, includeDiff, skipDrain) =>
        this.getStatus(swarmId, includeDiff, skipDrain),
      createSwarm: (params) => this.createSwarm(params),
    };
  }

  async previewWorkerMerge(opts: PreviewWorkerMergeOptions): Promise<MergePreviewResult> {
    return previewWorkerMerge(this.store, opts);
  }

  async mergeWorker(opts: MergeWorkerOptions): Promise<MergeApplyResult> {
    return mergeWorker(this.store, opts);
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

  shutdown(): void {
    this.shuttingDown = true;
    this.store.closeAllWatchers();
    for (const proc of this.runningProcs.values()) {
      killProcessTree(proc, 'SIGTERM', true);
    }
    this.runningProcs.clear();
    for (const vProc of this.activeVerifyProcs.keys()) {
      killProcessTree(vProc, 'SIGTERM', true);
    }
    this.activeVerifyProcs.clear();
  }
}
