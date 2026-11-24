import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  realpathSync,
  type WriteStream,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { isSafeConversationId } from './coordinator-usage.js';
import { MAX_WORKER_NAME_LEN, extractMentions, validateWorkerName } from './mentions.js';
import { isValidDshProfileName } from './models.js';
import {
  getProviderConfigSnapshot,
  quoteWinCmdArg,
  resolveDefaultProvider,
  resolveExecutable,
  resolveProviderAdapter,
} from './providers/index.js';
import { buildSwarmMarkdownReport } from './report.js';
import {
  killProcessTree,
  runVerifyCommands,
  terminateProcessTreeWithEscalation,
} from './runner-process.js';
import {
  buildInitialWorkerPrompt,
  buildTimeoutConvergencePrompt,
  buildWakeWorkerPrompt,
  inferMessageKind,
} from './runner-prompts.js';
import {
  enrichDshFailureReason,
  getTaskRoutingCandidates,
  inferTaskCategory,
  pickModelForProviderFromTaskRouting,
  pickRoutedTarget,
  resolveDshModelSelection,
} from './runner-routing.js';
import type { SwarmStore } from './store.js';
import { expandTemplateWorkerBrief, getTemplatesSnapshot } from './templates.js';
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
  type SwarmTemplate,
  type TaskRoutingCategory,
  type WorkerStatus,
  type WorkspaceMode,
  type WorktreeDiffSummary,
  type WorktreePatchResult,
} from './types.js';
import {
  buildAugmentedEnv,
  createWorktree,
  detectGitRepo,
  getWorktreeDiff,
  getWorktreeFullDiff,
  mergeWorktreeBranch,
  previewWorktreeMerge,
  removeWorktree,
} from './worktree.js';

export interface PostDeliverySummary {
  woken: string[];
  deferred: string[];
  skipped?: Array<{ name: string; reason: string }>;
}

function resolveWakeTargets(
  members: Record<string, Pick<MemberState, 'status'>>,
  sender: string,
  all: boolean,
  mentions: string[],
): { targets: string[]; skipped: Array<{ name: string; reason: string }> } {
  const targets: string[] = [];
  const seen = new Set<string>();
  const skipped: Array<{ name: string; reason: string }> = [];
  if (all) {
    for (const [name, m] of Object.entries(members)) {
      if (name === sender || m.status === 'killed') continue;
      if (m.status === 'blocked' || m.status === 'failed') {
        skipped.push({ name, reason: m.status });
        continue;
      }
      seen.add(name);
      targets.push(name);
    }
  } else {
    for (const mention of mentions) {
      if (mention === sender || seen.has(mention)) continue;
      const st = members[mention]?.status;
      if (!st) continue;
      if (st === 'killed' || st === 'blocked') {
        skipped.push({ name: mention, reason: st });
        continue;
      }
      seen.add(mention);
      targets.push(mention);
    }
  }
  return { targets, skipped };
}

interface QueuedTask {
  swarmId: string;
  memberName: string;
  overridePrompt?: string;
  maxDeliveredSeq: number;
  isTimeoutConvergence?: boolean;
  overrideTurnTimeoutSeconds?: number;
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

export interface WaitOptions {
  swarmId?: string;
  since?: number;
  timeoutSeconds?: number;
  until?: 'any_post' | 'mentions_coordinator' | 'all_idle' | 'worker_done';
  workerName?: string;
}

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
    const explicitSingle = input.provider?.trim().toLowerCase();

    const category = inferTaskCategory(
      role,
      permissionMode,
      Boolean(input.tasks?.length),
      input.taskType,
    );

    let nextRrCursor = swarm.rrCursor || 0;
    let usedRouter = false;
    const targets: { name: string; taskText: string; providerId: string; routedModel?: string }[] = [];
    if (input.tasks && input.tasks.length > 0) {
      const baseCheck = validateWorkerName(input.name);
      if (!baseCheck.valid) {
        throw new Error(baseCheck.error);
      }
      for (let i = 0; i < input.tasks.length; i++) {
        const shardName = `${baseCheck.normalized}-${i + 1}`;
        const shardCheck = validateWorkerName(shardName);
        if (!shardCheck.valid) {
          throw new Error(shardCheck.error);
        }
        let providerId: string;
        let routedModel: string | undefined;
        if (explicitProviders.length > 0) {
          providerId = explicitProviders[i % explicitProviders.length];
        } else if (explicitSingle) {
          providerId = explicitSingle;
        } else if (input.customCommand) {
          providerId = 'custom';
        } else {
          const picked = pickRoutedTarget(
            swarm,
            permissionMode,
            providerSnap,
            category,
            nextRrCursor,
          );
          providerId = picked.providerId;
          routedModel = picked.model;
          nextRrCursor = picked.nextCursor;
          usedRouter = true;
        }
        targets.push({
          name: shardCheck.normalized,
          taskText: `${input.brief}\n\nAssigned Slice (${i + 1}/${input.tasks.length}):\n${input.tasks[i]}`,
          providerId,
          routedModel,
        });
      }
    } else if (explicitProviders.length >= 2) {
      const baseCheck = validateWorkerName(input.name);
      if (!baseCheck.valid) {
        throw new Error(baseCheck.error);
      }
      const usedInCall = new Set<string>(Object.keys(swarm.members));
      for (const provId of explicitProviders) {
        const slug =
          provId.replace(/[^a-z0-9_-]+/g, '').slice(0, 12).replace(/[-_]+$/g, '') || 'cli';
        const maxBase = Math.max(1, MAX_WORKER_NAME_LEN - 1 - slug.length);
        const basePart = baseCheck.normalized.slice(0, maxBase).replace(/[-_]+$/g, '') || 'w';
        let fanName = `${basePart}-${slug}`.slice(0, MAX_WORKER_NAME_LEN).replace(/[-_]+$/g, '');
        if (usedInCall.has(fanName)) {
          let idx = 2;
          while (
            usedInCall.has(
              `${fanName.slice(0, Math.max(1, MAX_WORKER_NAME_LEN - 1 - String(idx).length)).replace(/[-_]+$/g, '')}-${idx}`,
            )
          ) {
            idx++;
          }
          fanName = `${fanName.slice(0, Math.max(1, MAX_WORKER_NAME_LEN - 1 - String(idx).length)).replace(/[-_]+$/g, '')}-${idx}`;
        }
        const check = validateWorkerName(fanName);
        if (!check.valid) {
          throw new Error(check.error);
        }
        usedInCall.add(check.normalized);
        targets.push({
          name: check.normalized,
          taskText: input.brief,
          providerId: provId,
        });
      }
    } else {
      const check = validateWorkerName(input.name);
      if (!check.valid) {
        throw new Error(check.error);
      }
      let providerId: string;
      let routedModel: string | undefined;
      if (explicitProviders[0] || explicitSingle) {
        providerId = explicitProviders[0] || explicitSingle!;
      } else if (input.customCommand) {
        providerId = 'custom';
      } else {
        const picked = pickRoutedTarget(
          swarm,
          permissionMode,
          providerSnap,
          category,
          nextRrCursor,
        );
        providerId = picked.providerId;
        routedModel = picked.model;
        nextRrCursor = picked.nextCursor;
        usedRouter = true;
      }
      targets.push({
        name: check.normalized,
        taskText: input.brief,
        providerId,
        routedModel,
      });
    }

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
    const swarm = this.store.tryGetSwarm(swarmId);
    if (!swarm) return;
    const member = swarm.members[task.memberName];
    if (!member || member.status === 'killed') return;

    let prompt = task.overridePrompt;
    let maxDeliveredSeq = task.maxDeliveredSeq;
    const drainedBoard = !prompt;

    if (!prompt) {
      const unread = this.store.readBoard(swarmId, member.lastReadSeq, 200);
      if (unread.length === 0) {
        member.status = 'waiting';
        member.pendingWake = false;
        this.store.upsertMember(swarmId, member);
        this.pumpQueue(swarmId);
        return;
      }
      maxDeliveredSeq = Math.max(maxDeliveredSeq, unread[unread.length - 1].seq);
      const originalBrief = !member.sessionId
        ? this.store
            .readBoard(swarmId, 0, 200)
            .find((m) => m.kind === 'brief' && m.mentions.includes(member.name))
        : undefined;
      prompt = buildWakeWorkerPrompt({
        swarm,
        member,
        unread,
        originalBrief,
        swarmDir: this.store.getSwarmDir(swarm.id),
        boardCli: this.boardCli,
      });
    }
    const turnPrompt = prompt;

    const key = this.procKey(swarmId, member.name);
    let effectiveProfile = swarm.profile || 'headless';
    let effectiveModelProvider: string | undefined = member.modelProvider;
    let adapter: ReturnType<typeof resolveProviderAdapter>;
    let invocation: ReturnType<typeof adapter.buildInvocation>;
    let logPath = '';
    let logStream: WriteStream | undefined;
    let proc: ChildProcessWithoutNullStreams;

    try {
      adapter = resolveProviderAdapter(
        member.provider || 'dsh',
        member.customConfig,
        this.store.dataDir,
        swarm.repoRoot,
      );

      member.status = 'working';
      if (drainedBoard) {
        member.pendingWake = false;
      }
      member.lastError = undefined;
      member.activity = `starting ${adapter.id}...`;
      member.lastTurnStartedAt = new Date().toISOString();
      this.store.upsertMember(swarmId, member);

      const cfgSnap = getProviderConfigSnapshot(this.store.dataDir, swarm.repoRoot, swarm.profile);
      const providerDesc = !member.customConfig
        ? cfgSnap.providers.find((p) => p.id === (member.provider || 'dsh'))
        : undefined;
      effectiveProfile = providerDesc?.profile || swarm.profile || 'headless';
      effectiveModelProvider =
        member.modelProvider || providerDesc?.modelProvider || providerDesc?.detectedModelProvider;

      invocation = adapter.buildInvocation({
        prompt,
        workerName: member.name,
        cwd: member.cwd,
        model: member.model,
        modelProvider: effectiveModelProvider,
        permissionMode: member.permissionMode,
        sessionId: member.sessionId,
        profile: effectiveProfile,
        swarmDir: this.store.getSwarmDir(swarmId),
        patchesDir: this.store.getPatchesDir(swarmId),
        gitCommonDir: swarm.gitCommonDir,
        boardCli: this.boardCli,
      });

      logPath = join(this.store.getLogsDir(swarmId), `${member.name}.ndjson`);
      mkdirSync(this.store.getLogsDir(swarmId), { recursive: true });
      if (adapter.supportsStreamEvents) {
        logStream = createWriteStream(logPath, { flags: 'a', encoding: 'utf8' });
        logStream.on('error', () => {
          // Best-effort logging
        });
      }

      const swarmDir = this.store.getSwarmDir(swarmId);
      const env = buildAugmentedEnv({
        ...invocation.env,
        EXT_SWARM_DIR: swarmDir,
        EXT_SWARM_AGENT: member.name,
        DSH_SWARM_DIR: swarmDir,
        DSH_SWARM_AGENT: member.name,
      });

      const resolvedCmd = resolveExecutable(invocation.command) || invocation.command;
      const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolvedCmd);
      const spawnCmd = useShell ? quoteWinCmdArg(resolvedCmd) : resolvedCmd;
      const spawnArgs = useShell ? invocation.args.map(quoteWinCmdArg) : invocation.args;
      proc = spawn(spawnCmd, spawnArgs, {
        cwd: member.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        shell: useShell,
        ...(useShell ? { windowsVerbatimArguments: true } : {}),
      });
      this.runningProcs.set(key, proc);
    } catch (err) {
      logStream?.end();
      this.runningProcs.delete(key);
      const msg = err instanceof Error ? err.message : String(err);
      this.failWorkerSafely(swarmId, member.name, msg, { currentTurnPrompt: turnPrompt });
      return;
    }

    const turnStartedHeadSeq = swarm.headSeq;
    const turnTimeoutSec =
      task.overrideTurnTimeoutSeconds !== undefined
        ? Math.max(0, Math.floor(task.overrideTurnTimeoutSeconds))
        : Math.max(
            0,
            member.turnTimeoutSeconds ?? swarm.turnTimeoutSeconds ?? DEFAULT_TURN_TIMEOUT_SECONDS,
          );
    const stallTimeoutSec = Math.max(0, swarm.stallTimeoutSeconds ?? DEFAULT_STALL_TIMEOUT_SECONDS);
    let lastActivityAt = Date.now();
    let timedOutReason = '';
    let timedOutKind: 'hard' | 'stall' | '' = '';
    let turnTimer: NodeJS.Timeout | undefined;
    let stallInterval: NodeJS.Timeout | undefined;

    const terminateTimedOut = (kind: 'hard' | 'stall', reasonText: string) => {
      if (timedOutReason) return;
      timedOutKind = kind;
      timedOutReason = reasonText;
      terminateProcessTreeWithEscalation(proc, 3000);
    };

    if (turnTimeoutSec > 0) {
      turnTimer = setTimeout(() => {
        terminateTimedOut('hard', `Turn exceeded hard timeout (${turnTimeoutSec}s)`);
      }, turnTimeoutSec * 1000);
      turnTimer.unref?.();
    }
    if (stallTimeoutSec > 0) {
      const checkIntervalMs = Math.min(
        10000,
        Math.max(500, Math.floor((stallTimeoutSec * 1000) / 3)),
      );
      stallInterval = setInterval(() => {
        if (Date.now() - lastActivityAt >= stallTimeoutSec * 1000) {
          terminateTimedOut('stall', `Worker stalled (no output for ${stallTimeoutSec}s)`);
        }
      }, checkIntervalMs);
      stallInterval.unref?.();
    }

    proc.stdin?.on('error', () => {
      // Ignore EPIPE when child exits early
    });
    try {
      if (invocation.stdinText !== undefined) {
        proc.stdin.write(invocation.stdinText);
      }
      proc.stdin.end();
    } catch {
      // Process may exit early
    }

    let stdoutBuffer = '';
    let stdoutAll = '';
    let stderrBuffer = '';
    const textChunks: string[] = [];
    let finalText = '';
    let finalReasonKind = '';
    let turnErrorText = '';
    let sawTurnStart = false;
    let sawStepThisTurn = 0;
    let sawToolCallThisTurn = false;

    const handleLine = (rawLine: string) => {
      const line = rawLine.trim();
      if (!line) return;
      if (logStream) {
        logStream.write(line + '\n');
      }

      const events = adapter.parseStdoutLine(line);
      if (events.length === 0) return;

      const currentSwarm = this.store.tryGetSwarm(swarmId);
      const currentMember = currentSwarm?.members[member.name];
      if (!currentMember || currentMember.status === 'killed') return;

      for (const ev of events) {
        if (ev.type === 'session') {
          currentMember.sessionId = ev.sessionId;
          this.store.upsertMember(swarmId, currentMember);
        } else if (ev.type === 'turn_start') {
          sawTurnStart = true;
          currentMember.turns += 1;
          currentMember.activity = 'thinking...';
          this.store.upsertMember(swarmId, currentMember);
        } else if (ev.type === 'step_start') {
          sawStepThisTurn += 1;
          currentMember.steps += 1;
          currentMember.activity = `step ${currentMember.steps}...`;
          this.store.upsertMember(swarmId, currentMember, { immediate: false });
        } else if (ev.type === 'usage') {
          currentMember.usage.inputTokens += ev.inputTokens;
          currentMember.usage.outputTokens += ev.outputTokens;
          currentMember.usage.totalTokens += ev.totalTokens;
          currentMember.usage.cacheReadTokens += ev.cacheReadTokens;
          this.store.upsertMember(swarmId, currentMember, { immediate: false });
        } else if (ev.type === 'tool_call') {
          sawToolCallThisTurn = true;
          currentMember.activity = ev.summary;
          this.store.upsertMember(swarmId, currentMember, { immediate: false });
        } else if (ev.type === 'text') {
          textChunks.push(ev.text);
        } else if (ev.type === 'final') {
          if (ev.sessionId) {
            currentMember.sessionId = ev.sessionId;
            this.store.upsertMember(swarmId, currentMember);
          }
          if (ev.text !== undefined) {
            finalText = ev.text;
          }
          if (ev.reasonKind) {
            finalReasonKind = ev.reasonKind;
          }
          if (ev.errorText) {
            turnErrorText = ev.errorText;
          }
        } else if (ev.type === 'error') {
          turnErrorText = ev.message;
        }
      }
    };

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    proc.stdout.on('data', (chunk: Buffer) => {
      lastActivityAt = Date.now();
      const str = stdoutDecoder.write(chunk);
      stdoutAll += str;
      if (stdoutAll.length > 262144) {
        stdoutAll = stdoutAll.slice(-262144);
      }
      stdoutBuffer += str;
      let nlIdx = stdoutBuffer.indexOf('\n');
      while (nlIdx !== -1) {
        const line = stdoutBuffer.slice(0, nlIdx);
        stdoutBuffer = stdoutBuffer.slice(nlIdx + 1);
        handleLine(line);
        nlIdx = stdoutBuffer.indexOf('\n');
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      lastActivityAt = Date.now();
      stderrBuffer += stderrDecoder.write(chunk);
      if (stderrBuffer.length > 8000) {
        stderrBuffer = stderrBuffer.slice(-8000);
      }
    });

    proc.on('error', (err) => {
      stderrBuffer += `\nSpawn error: ${err.message}`;
    });

    proc.on('close', async (code, signal) => {
      if (turnTimer) clearTimeout(turnTimer);
      if (stallInterval) clearInterval(stallInterval);
      this.runningProcs.delete(key);

      try {
        const trailingOut = stdoutDecoder.end();
        if (trailingOut) {
          stdoutAll += trailingOut;
          stdoutBuffer += trailingOut;
          let nlIdx = stdoutBuffer.indexOf('\n');
          while (nlIdx !== -1) {
            const line = stdoutBuffer.slice(0, nlIdx);
            stdoutBuffer = stdoutBuffer.slice(nlIdx + 1);
            handleLine(line);
            nlIdx = stdoutBuffer.indexOf('\n');
          }
        }
        stderrBuffer += stderrDecoder.end();
        if (stdoutBuffer.trim()) {
          handleLine(stdoutBuffer);
          stdoutBuffer = '';
        }
        logStream?.end();
        logStream = undefined;

        if (!this.store.tryGetSwarm(swarmId)) {
          this.queues.delete(swarmId);
          return;
        }

        // Flush any ext-board CLI messages written right before exit
        this.store.drainInbox(swarmId);

        const latestSwarm = this.store.tryGetSwarm(swarmId);
        const latestMember = latestSwarm?.members[member.name];
        if (!latestSwarm || !latestMember) {
          return;
        }

        if (!sawTurnStart) {
          latestMember.turns += 1;
        }

        if (!finalText && adapter.finalizeOutput) {
          const finalized = adapter.finalizeOutput(stdoutAll, textChunks.join(''));
          finalText = finalized.finalText;
          if (finalized.sessionId) latestMember.sessionId = finalized.sessionId;
          if (finalized.reasonKind) finalReasonKind = finalized.reasonKind;
          if (finalized.errorText) turnErrorText = finalized.errorText;
          if (!adapter.supportsStreamEvents && finalText) {
            try {
              appendFileSync(
                logPath,
                JSON.stringify({ type: 'final', reason: { kind: 'completed' }, text: finalText }) + '\n',
                'utf8',
              );
            } catch {
              // Ignore
            }
          }
        }

        if (latestMember.status === 'killed') {
          latestMember.activity = undefined;
          this.store.upsertMember(swarmId, latestMember);
          this.pumpQueue(swarmId);
          return;
        }

        const failed =
          Boolean(timedOutReason) ||
          code !== 0 ||
          Boolean(signal) ||
          (finalReasonKind && finalReasonKind !== 'completed');

        if (failed) {
          const recentMsgsBeforeFail = this.store.readBoard(swarmId, turnStartedHeadSeq, 200);
          const postedTerminalSelfThisTurn = recentMsgsBeforeFail.some(
            (m) =>
              m.agent === latestMember.name && (m.kind === 'done' || m.kind === 'blocker'),
          );
          const canAutoConverge =
            timedOutKind === 'hard' &&
            !task.isTimeoutConvergence &&
            Boolean(latestMember.sessionId) &&
            adapter.supportsSessionResume &&
            !postedTerminalSelfThisTurn &&
            (sawStepThisTurn > 0 || sawToolCallThisTurn || textChunks.length > 0);
          if (canAutoConverge) {
            const convergeTimeoutSec =
              turnTimeoutSec < 60
                ? Math.max(2, turnTimeoutSec)
                : Math.min(300, Math.max(120, Math.round(turnTimeoutSec * 0.25)));
            const progressSteps = sawStepThisTurn || latestMember.steps;
            const progressLabel =
              progressSteps > 0 ? `after ${progressSteps} step(s)` : 'after active progress';
            latestMember.status = 'queued';
            latestMember.activity = 'auto-converging after timeout...';
            latestMember.lastError = undefined;
            latestMember.retryTurns += 1;
            latestMember.lastTurnFinishedAt = new Date().toISOString();
            latestMember.lastReadSeq = Math.max(latestMember.lastReadSeq, maxDeliveredSeq);
            this.store.upsertMember(swarmId, latestMember);

            const convergeNotice = this.store.appendBoardMessage(swarmId, {
              agent: 'system',
              text: `[auto-converge] Worker "${latestMember.name}" reached the ${turnTimeoutSec}s turn timeout ${progressLabel}. Resuming session to synthesize and output final report immediately (timeout=${convergeTimeoutSec}s).`,
              kind: 'system',
            });
            const convergePrompt = buildTimeoutConvergencePrompt({
              member: latestMember,
              turnTimeoutSec,
              stepsThisTurn: progressSteps,
              swarmDir: this.store.getSwarmDir(swarmId),
              boardCli: this.boardCli,
            });
            this.enqueueTask(
              {
                swarmId,
                memberName: latestMember.name,
                overridePrompt: convergePrompt,
                maxDeliveredSeq: Math.max(latestMember.lastReadSeq, convergeNotice.seq),
                isTimeoutConvergence: true,
                overrideTurnTimeoutSeconds: convergeTimeoutSec,
              },
              { front: true },
            );
            return;
          }

          let reasonDetail =
            timedOutReason ||
            turnErrorText ||
            stderrBuffer.trim().split('\n').slice(-6).join(' | ') ||
            `exit code=${code ?? 'null'} signal=${signal ?? 'none'} reason=${finalReasonKind || 'unknown'}`;
          if (latestMember.provider === 'dsh') {
            reasonDetail = enrichDshFailureReason(
              reasonDetail,
              effectiveProfile,
              latestMember.modelProvider || effectiveModelProvider,
            );
          }
          if (this.tryFailoverWorker(swarmId, latestMember, reasonDetail, turnPrompt)) {
            this.pumpQueue(swarmId);
            return;
          }
          latestMember.status = 'failed';
          latestMember.activity = undefined;
          latestMember.lastError = reasonDetail;
          latestMember.lastTurnFinishedAt = new Date().toISOString();
          latestMember.lastReadSeq = Math.max(latestMember.lastReadSeq, maxDeliveredSeq);
          this.store.upsertMember(swarmId, latestMember);

          this.store.appendBoardMessage(swarmId, {
            agent: latestMember.name,
            text: `@coordinator [error] Worker failed: ${reasonDetail.slice(0, 600)}`,
            kind: 'error',
          });
          this.propagateBlockedDependencyFailures(swarmId);
          this.pumpQueue(swarmId);
          return;
        }

        // Keep status as 'working' until diff & auto_verify & final board post finish so `all_idle`
        // does not fire before @mention peer routing queues downstream workers.
        latestMember.activity = undefined;
        latestMember.lastTurnFinishedAt = new Date().toISOString();
        latestMember.lastReadSeq = Math.max(latestMember.lastReadSeq, maxDeliveredSeq);

        // Mechanical allowed_files check
        if (
          latestMember.allowedFiles &&
          latestMember.allowedFiles.length > 0 &&
          latestSwarm.gitRepoRoot
        ) {
          const diff = await getWorktreeDiff(
            latestMember.cwd,
            latestMember.baseRef,
            latestMember.allowedFiles,
          );
          const recheckSwarmAfterDiff = this.store.tryGetSwarm(swarmId);
          const recheckMemberAfterDiff = recheckSwarmAfterDiff?.members[member.name];
          if (
            !recheckSwarmAfterDiff ||
            !recheckMemberAfterDiff ||
            recheckMemberAfterDiff.status === 'killed' ||
            this.shuttingDown
          ) {
            this.pumpQueue(swarmId);
            return;
          }
          if (diff) {
            latestMember.outOfScopeFiles = diff.outOfScopeFiles;
            if (diff.outOfScopeFiles.length > 0) {
              this.store.appendBoardMessage(swarmId, {
                agent: 'system',
                text: `@coordinator [warning] Worker "${latestMember.name}" modified files outside allowed_files: ${diff.outOfScopeFiles.join(', ')}`,
                kind: 'warning',
              });
            }
          }
        }

        // Deterministic host-side verify_commands execution when autoVerify is enabled
        if (
          latestMember.autoVerify &&
          latestMember.permissionMode !== 'read-only' &&
          latestMember.verifyCommands &&
          latestMember.verifyCommands.length > 0
        ) {
          latestMember.activity = 'running verify_commands...';
          this.store.upsertMember(swarmId, latestMember);
          const verifyResults = await runVerifyCommands(
            this.activeVerifyProcs,
            key,
            latestMember.cwd,
            latestMember.verifyCommands,
          );
          const recheckSwarmAfterVerify = this.store.tryGetSwarm(swarmId);
          const recheckMemberAfterVerify = recheckSwarmAfterVerify?.members[member.name];
          if (
            !recheckSwarmAfterVerify ||
            !recheckMemberAfterVerify ||
            recheckMemberAfterVerify.status === 'killed' ||
            this.shuttingDown
          ) {
            this.pumpQueue(swarmId);
            return;
          }
          latestMember.lastVerifyResults = verifyResults;
          latestMember.activity = undefined;
          const allPassed = verifyResults.every((r) => r.passed);
          const summaryLines = verifyResults.map(
            (r) =>
              `- ${r.passed ? 'PASS' : 'FAIL'} (exit=${r.exitCode ?? '?'}, ${r.durationMs}ms): \`${r.command}\`${!r.passed && r.outputTail ? `\n  ${r.outputTail.slice(-300)}` : ''}`,
          );
          this.store.appendBoardMessage(swarmId, {
            agent: 'system',
            text: allPassed
              ? `[auto-verify] ${latestMember.name} passed ${verifyResults.length}/${verifyResults.length} verify command(s):\n${summaryLines.join('\n')}`
              : `@coordinator [warning] [auto-verify] ${latestMember.name} failed verification:\n${summaryLines.join('\n')}`,
            kind: allPassed ? 'system' : 'warning',
          });
        }

        // Auto-post final response if the worker did not already post via ext-board CLI this turn
        const recentMsgs = this.store.readBoard(swarmId, turnStartedHeadSeq, 200);
        const postedSelfThisTurn = recentMsgs.some((m) => m.agent === latestMember.name);
        const rawOutput = (finalText || textChunks.join('')).trim();
        if (!postedSelfThisTurn && rawOutput) {
          const parsed = extractMentions(rawOutput, Object.keys(latestSwarm.members));
          const hasMention =
            parsed.mentions.length > 0 || parsed.all || parsed.mentionsCoordinator;
          const postText = hasMention ? rawOutput : `@coordinator ${rawOutput}`;
          this.store.appendBoardMessage(swarmId, {
            agent: latestMember.name,
            text: postText,
            kind: inferMessageKind(postText),
          });
        }

        // Now transition to waiting (or re-queue if pendingWake arrived while working)
        const afterPostSwarm = this.store.tryGetSwarm(swarmId);
        const afterPostMember = afterPostSwarm?.members[member.name] || latestMember;
        afterPostMember.activity = undefined;
        afterPostMember.lastTurnFinishedAt = latestMember.lastTurnFinishedAt;
        afterPostMember.lastReadSeq = latestMember.lastReadSeq;
        afterPostMember.outOfScopeFiles = latestMember.outOfScopeFiles;
        afterPostMember.lastVerifyResults = latestMember.lastVerifyResults;

        if (afterPostSwarm && afterPostMember.pendingWake) {
          const remainingUnread = this.store.readBoard(swarmId, afterPostMember.lastReadSeq, 50);
          if (remainingUnread.length > 0 && afterPostSwarm.hopCount <= afterPostSwarm.maxHops) {
            afterPostMember.status = 'queued';
            afterPostMember.pendingWake = false;
            this.store.upsertMember(swarmId, afterPostMember);
            this.enqueueTask({
              swarmId,
              memberName: afterPostMember.name,
              maxDeliveredSeq: remainingUnread[remainingUnread.length - 1].seq,
            });
          } else {
            afterPostMember.status = 'waiting';
            afterPostMember.pendingWake = false;
            this.store.upsertMember(swarmId, afterPostMember);
          }
        } else {
          afterPostMember.status = 'waiting';
          this.store.upsertMember(swarmId, afterPostMember);
        }
        await this.checkAndReleaseBlockedDependents(swarmId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.failWorkerSafely(swarmId, member.name, `Post-turn handling error: ${msg}`, {
          skipFailover: true,
        });
        return;
      }

      this.pumpQueue(swarmId);
    });
  }

  postAsCoordinator(swarmId: string | undefined, text: string): BoardMessage {
    const swarm = this.store.getSwarm(swarmId);
    return this.store.appendBoardMessage(swarm.id, {
      agent: 'coordinator',
      text,
      kind: 'message',
    });
  }

  postAsCoordinatorWithDelivery(
    swarmId: string | undefined,
    text: string,
  ): { message: BoardMessage; delivery: PostDeliverySummary } {
    const swarm = this.store.getSwarm(swarmId);
    const preMembers: Record<string, { status: WorkerStatus }> = {};
    for (const [name, m] of Object.entries(swarm.members)) {
      preMembers[name] = { status: m.status };
    }
    const message = this.postAsCoordinator(swarm.id, text);
    const { targets, skipped } = resolveWakeTargets(
      preMembers,
      message.agent,
      message.all,
      message.mentions,
    );
    const woken: string[] = [];
    const deferred: string[] = [];
    for (const targetName of targets) {
      const st = preMembers[targetName]?.status;
      if (st === 'working' || st === 'queued') {
        deferred.push(targetName);
      } else {
        woken.push(targetName);
      }
    }
    return {
      message,
      delivery: {
        woken,
        deferred,
        ...(skipped.length > 0 ? { skipped } : {}),
      },
    };
  }

  buildAsyncWaitCommand(
    swarmId: string | undefined,
    opts?: {
      since?: number;
      until?: 'all_idle' | 'mentions_coordinator' | 'any_post' | 'worker_done';
      workerName?: string;
    },
  ): string {
    const swarm = this.store.getSwarm(swarmId);
    const swarmDir = this.store.getSwarmDir(swarm.id);
    const until = opts?.until || 'all_idle';
    const since =
      typeof opts?.since === 'number' && Number.isFinite(opts.since) && opts.since >= 0
        ? Math.floor(opts.since)
        : swarm.headSeq;
    const quoteArg = (val: string) =>
      process.platform === 'win32'
        ? `"${val.replace(/"/g, '\\"')}"`
        : `'${val.replace(/'/g, "'\\''")}'`;
    const parts = [
      'node',
      quoteArg(this.boardCli),
      'wait',
      '--swarm-dir',
      quoteArg(swarmDir),
      '--since',
      String(since),
      '--until',
      until,
    ];
    if (until === 'worker_done' && opts?.workerName?.trim()) {
      parts.push('--worker', quoteArg(opts.workerName.trim().toLowerCase()));
    }
    return parts.join(' ');
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
    const swarm = this.store.getSwarm(opts.swarmId);
    const swarmId = swarm.id;
    let lastSnapshot: SwarmState = {
      ...swarm,
      members: Object.fromEntries(Object.entries(swarm.members).map(([k, v]) => [k, { ...v }])),
    };
    const since = opts.since ?? swarm.headSeq;
    const timeoutMs = Math.max(1, Math.min(90, opts.timeoutSeconds ?? 45)) * 1000;
    const until = opts.until || 'any_post';
    const normalizedWorkerName = opts.workerName?.trim().toLowerCase() || undefined;

    this.store.drainInbox(swarmId);

    const checkMatch = (): { matched: boolean; reason: string } => {
      const current = this.store.tryGetSwarm(swarmId);
      if (!current) {
        return { matched: true, reason: 'swarm_deleted' };
      }
      lastSnapshot = current;
      const newMsgs = this.store.readBoard(swarmId, since, 200);
      const members = Object.values(current.members);
      const nonKilled = members.filter((m) => m.status !== 'killed');
      const allIdle =
        nonKilled.length > 0 &&
        nonKilled.every((m) => m.status === 'waiting' || m.status === 'failed');
      const hasReleasableBlocked = nonKilled.some(
        (m) =>
          m.status === 'blocked' &&
          (m.dependsOn || []).length > 0 &&
          (m.dependsOn || []).every((d) => {
            const dm = current.members[d];
            return Boolean(dm && dm.status === 'waiting' && dm.turns > 0);
          }),
      );
      const blockedDeadlock =
        !hasReleasableBlocked &&
        nonKilled.length > 0 &&
        nonKilled.every((m) => m.status !== 'working' && m.status !== 'queued') &&
        nonKilled.some((m) => m.status === 'blocked');

      if (until === 'any_post') {
        if (newMsgs.length > 0) return { matched: true, reason: 'new_board_post' };
        if (allIdle && members.some((m) => m.turns > 0)) {
          return { matched: true, reason: 'all_workers_idle' };
        }
        if (blockedDeadlock) {
          return { matched: true, reason: 'blocked_deadlock' };
        }
      } else if (until === 'mentions_coordinator') {
        if (
          newMsgs.some(
            (m) =>
              m.agent !== 'coordinator' &&
              (m.mentionsCoordinator || m.all || m.kind === 'error' || m.kind === 'warning'),
          )
        ) {
          return { matched: true, reason: 'mentions_coordinator' };
        }
        if (allIdle && members.some((m) => m.turns > 0)) {
          return { matched: true, reason: 'all_workers_idle' };
        }
        if (blockedDeadlock) {
          return { matched: true, reason: 'blocked_deadlock' };
        }
      } else if (until === 'all_idle') {
        if (allIdle) return { matched: true, reason: 'all_workers_idle' };
        if (blockedDeadlock) return { matched: true, reason: 'blocked_deadlock' };
      } else if (until === 'worker_done') {
        const target = normalizedWorkerName ? current.members[normalizedWorkerName] : undefined;
        if (!target) return { matched: true, reason: 'worker_not_found' };
        if (
          target.status === 'waiting' ||
          target.status === 'failed' ||
          target.status === 'killed'
        ) {
          return { matched: true, reason: `worker_${target.status}` };
        }
        if (target.status === 'blocked' && blockedDeadlock) {
          return { matched: true, reason: 'blocked_deadlock' };
        }
      }
      return { matched: false, reason: 'waiting' };
    };

    const immediate = checkMatch();
    if (immediate.matched) {
      const latest = this.store.tryGetSwarm(swarmId);
      return {
        timedOut: false,
        reason: immediate.reason,
        swarm: latest || lastSnapshot,
        messages: latest ? this.store.readBoard(swarmId, since, 200) : [],
      };
    }

    return new Promise((resolveWait) => {
      let finished = false;
      const cleanup = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.store.off('message', onEvent);
        this.store.off('state', onEvent);
      };

      const onEvent = (evSwarmId: string) => {
        if (evSwarmId !== swarmId || finished) return;
        const status = checkMatch();
        if (status.matched) {
          cleanup();
          const latest = this.store.tryGetSwarm(swarmId);
          resolveWait({
            timedOut: false,
            reason: status.reason,
            swarm: latest || lastSnapshot,
            messages: latest ? this.store.readBoard(swarmId, since, 200) : [],
          });
        }
      };

      const timer = setTimeout(() => {
        cleanup();
        const latest = this.store.tryGetSwarm(swarmId);
        resolveWait({
          timedOut: Boolean(latest),
          reason: latest ? 'timeout' : 'swarm_deleted',
          swarm: latest || lastSnapshot,
          messages: latest ? this.store.readBoard(swarmId, since, 200) : [],
        });
      }, timeoutMs);

      this.store.on('message', onEvent);
      this.store.on('state', onEvent);
    });
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

  async getWorkerFullDiff(swarmId: string | undefined, name: string): Promise<WorktreePatchResult> {
    const swarm = this.store.getSwarm(swarmId);
    const normName = name.trim().toLowerCase();
    const member = swarm.members[normName];
    if (!member) {
      throw new Error(`Worker "${name}" not found in swarm "${swarm.id}".`);
    }
    if (!existsSync(member.cwd)) {
      throw new Error(`Worker workspace does not exist: ${member.cwd}`);
    }
    if (member.workspaceMode !== 'worktree' && !swarm.gitRepoRoot) {
      return {
        branch: '(no git repo)',
        baseRef: 'HEAD',
        stat: '',
        patch: '',
        truncated: false,
        untrackedFiles: [],
      };
    }
    const patch = await getWorktreeFullDiff(member.cwd, member.baseRef);
    return (
      patch || {
        branch: member.branch || 'HEAD',
        baseRef: member.baseRef || 'HEAD',
        stat: '',
        patch: '',
        truncated: false,
        untrackedFiles: [],
      }
    );
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
  ): Promise<{ filename: string; markdown: string }> {
    const { swarm, diffs } = await this.getStatus(swarmId, true);
    const messages = this.store.readBoard(swarm.id, 0, 5000);
    return buildSwarmMarkdownReport(swarm, diffs, messages, coordinatorUsage, pricing);
  }

  private propagateBlockedDependencyFailures(swarmId: string): void {
    let changed = true;
    while (changed) {
      changed = false;
      const swarm = this.store.tryGetSwarm(swarmId);
      if (!swarm) return;
      for (const m of Object.values(swarm.members)) {
        if (m.status !== 'blocked') continue;
        const deps = m.dependsOn || [];
        const brokenDepName = deps.find((d) => {
          const dep = swarm.members[d];
          return !dep || dep.status === 'failed' || dep.status === 'killed';
        });
        if (!brokenDepName) continue;
        const depStatus = swarm.members[brokenDepName]?.status || 'missing';
        m.status = 'failed';
        m.activity = undefined;
        m.lastError = `Upstream dependency "${brokenDepName}" is ${depStatus}.`;
        this.store.upsertMember(swarmId, m);
        this.store.appendBoardMessage(swarmId, {
          agent: 'system',
          text: `@coordinator [error] Blocked worker "${m.name}" aborted because upstream dependency "${brokenDepName}" is ${depStatus}.`,
          kind: 'error',
        });
        changed = true;
      }
    }
  }

  private async collectUpstreamContext(swarmId: string, deps: string[]): Promise<string> {
    const swarm = this.store.tryGetSwarm(swarmId);
    if (!swarm || deps.length === 0) return '';
    const boardMsgs = this.store.readBoard(swarmId, 0, 500);
    const sections: string[] = [];

    for (const depName of deps) {
      const m = swarm.members[depName];
      if (!m) continue;
      const lastPost = [...boardMsgs]
        .reverse()
        .find((msg) => msg.agent === depName && msg.kind !== 'system');
      const diff =
        m.workspaceMode === 'worktree'
          ? await getWorktreeDiff(m.cwd, m.baseRef, m.allowedFiles)
          : null;
      const parts: string[] = [`- Upstream @${depName} (status: ${m.status}, turns: ${m.turns}):`];
      if (m.branch) {
        const baseRef = m.baseRef || 'HEAD';
        parts.push(`  branch: ${m.branch} (base: ${baseRef}), cwd: ${m.cwd}`);
        parts.push(`  inspect diff: git diff ${baseRef}..${m.branch}`);
      }
      if (diff && (diff.changedFiles.length > 0 || diff.stat)) {
        parts.push(`  changedFiles: ${diff.changedFiles.join(', ') || '(none)'}`);
        if (diff.stat) parts.push(`  stat: ${diff.stat.replace(/\s+/g, ' ').slice(0, 260)}`);
      }
      if (lastPost) {
        parts.push(`  lastPost (#${lastPost.seq}): ${lastPost.text.slice(0, 500)}`);
      }
      sections.push(parts.join('\n'));
    }

    if (sections.length === 0) return '';
    return `[Upstream Dependencies Completed: ${deps.join(', ')}]\n${sections.join('\n')}`;
  }

  private async checkAndReleaseBlockedDependents(swarmId: string): Promise<void> {
    this.propagateBlockedDependencyFailures(swarmId);
    const swarm = this.store.tryGetSwarm(swarmId);
    if (!swarm) return;
    const blockedMembers = Object.values(swarm.members).filter((m) => m.status === 'blocked');
    if (blockedMembers.length === 0) return;

    for (const candidate of blockedMembers) {
      const latestSwarm = this.store.tryGetSwarm(swarmId);
      if (!latestSwarm) return;
      const current = latestSwarm.members[candidate.name];
      if (!current || current.status !== 'blocked') continue;
      const deps = current.dependsOn || [];
      const allReady =
        deps.length > 0 &&
        deps.every((d) => {
          const dm = latestSwarm.members[d];
          return Boolean(dm && dm.status === 'waiting' && dm.turns > 0);
        });
      if (!allReady) continue;

      const upstreamSummary = await this.collectUpstreamContext(swarmId, deps);
      const releaseSwarm = this.store.tryGetSwarm(swarmId);
      const releaseMember = releaseSwarm?.members[candidate.name];
      if (!releaseSwarm || !releaseMember || releaseMember.status !== 'blocked') continue;

      const rawBrief = releaseMember.pendingBrief || releaseMember.role || 'Execute assigned task.';
      const combinedBrief = upstreamSummary ? `${rawBrief}\n\n${upstreamSummary}` : rawBrief;

      releaseMember.status = 'queued';
      releaseMember.pendingBrief = undefined;
      releaseMember.activity = undefined;
      this.store.upsertMember(swarmId, releaseMember);

      const briefMsg = this.store.appendBoardMessage(swarmId, {
        agent: 'coordinator',
        text: `@${releaseMember.name} [unblocked after ${deps.join(', ')}] ${rawBrief}`,
        kind: 'brief',
      });
      releaseMember.lastReadSeq = briefMsg.seq;
      this.store.upsertMember(swarmId, releaseMember);

      const initialPrompt = buildInitialWorkerPrompt({
        swarm: releaseSwarm,
        member: releaseMember,
        brief: combinedBrief,
        briefSeq: briefMsg.seq,
        swarmDir: this.store.getSwarmDir(swarmId),
        boardCli: this.boardCli,
      });
      this.initialPrompts.set(this.procKey(swarmId, releaseMember.name), initialPrompt);
      this.enqueueTask({
        swarmId,
        memberName: releaseMember.name,
        overridePrompt: initialPrompt,
        maxDeliveredSeq: briefMsg.seq,
      });
    }
  }

  async previewWorkerMerge(opts: {
    swarmId?: string;
    workerName: string;
    targetBranch?: string;
  }): Promise<MergePreviewResult> {
    const swarm = this.store.getSwarm(opts.swarmId);
    const normalized = opts.workerName.trim().toLowerCase();
    const member = swarm.members[normalized];
    if (!member) {
      throw new Error(`Worker "${opts.workerName}" not found in swarm "${swarm.id}".`);
    }
    if (!swarm.gitRepoRoot) {
      throw new Error(`Swarm "${swarm.id}" has no git repository root.`);
    }
    if (member.workspaceMode !== 'worktree' || !member.branch) {
      throw new Error(
        `Worker "${member.name}" is not using an isolated git worktree branch (workspace=${member.workspaceMode}).`,
      );
    }
    return previewWorktreeMerge({
      repoRoot: swarm.gitRepoRoot,
      workerName: member.name,
      branch: member.branch,
      workerCwd: member.cwd,
      targetBranch: opts.targetBranch,
    });
  }

  async mergeWorker(opts: {
    swarmId?: string;
    workerName: string;
    targetBranch?: string;
    mode?: 'squash' | 'cherry-pick' | 'merge';
    commitMessage?: string;
    removeWorktreeAfter?: boolean;
  }): Promise<MergeApplyResult> {
    const swarm = this.store.getSwarm(opts.swarmId);
    const normalized = opts.workerName.trim().toLowerCase();
    const member = swarm.members[normalized];
    if (!member) {
      throw new Error(`Worker "${opts.workerName}" not found in swarm "${swarm.id}".`);
    }
    if (member.status === 'working' || member.status === 'queued') {
      throw new Error(
        `Cannot merge while worker "${member.name}" is still ${member.status}. Wait until it finishes or fails.`,
      );
    }
    if (!swarm.gitRepoRoot) {
      throw new Error(`Swarm "${swarm.id}" has no git repository root.`);
    }
    if (member.workspaceMode !== 'worktree' || !member.branch) {
      throw new Error(
        `Worker "${member.name}" is not using an isolated git worktree branch (workspace=${member.workspaceMode}).`,
      );
    }

    const result = await mergeWorktreeBranch({
      repoRoot: swarm.gitRepoRoot,
      workerName: member.name,
      branch: member.branch,
      workerCwd: member.cwd,
      targetBranch: opts.targetBranch,
      mode: opts.mode || 'squash',
      commitMessage: opts.commitMessage,
      removeWorktreeAfter: opts.removeWorktreeAfter,
      allowedFiles: member.allowedFiles,
    });

    if (result.merged) {
      if (result.worktreeRemoved) {
        const latestSwarm = this.store.tryGetSwarm(swarm.id);
        const latestMember = latestSwarm?.members[member.name];
        if (latestMember) {
          latestMember.branch = undefined;
          latestMember.workspaceMode = 'inherit';
          latestMember.cwd = swarm.repoRoot;
          this.store.upsertMember(swarm.id, latestMember);
        }
      }
      this.store.appendBoardMessage(swarm.id, {
        agent: 'system',
        text: `Merged @${member.name} (${result.branch} -> ${result.targetBranch}, mode=${result.mode}${result.commitSha ? `, ${result.commitSha.slice(0, 7)}` : ''})${result.worktreeRemoved ? ' [worktree removed]' : ''}.`,
        kind: 'system',
      });
    } else {
      this.store.appendBoardMessage(swarm.id, {
        agent: 'system',
        text: `@coordinator [warning] Merge blocked for @${member.name}: ${result.message}`,
        kind: 'warning',
      });
    }

    return result;
  }

  async startArena(opts: {
    swarmId?: string;
    task: string;
    contestants: Array<{
      name?: string;
      provider: string;
      model?: string;
      permissionMode?: PermissionMode;
      role?: string;
    }>;
    baseName?: string;
    permissionMode?: PermissionMode;
  }): Promise<{
    swarmId: string;
    arenaGroup: string;
    contestants: MemberState[];
    briefSeqs: number[];
    warnings: string[];
  }> {
    if (!opts.contestants || opts.contestants.length < 2) {
      throw new Error('Arena mode requires at least 2 contestants.');
    }
    const swarm = this.store.getSwarm(opts.swarmId);
    const rawGroup =
      opts.baseName?.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-') ||
      `arena-${randomBytes(2).toString('hex')}`;
    const arenaGroup = rawGroup.replace(/^-+|-+$/g, '') || 'arena';

    const contestants: MemberState[] = [];
    const briefSeqs: number[] = [];
    const warnings: string[] = [];
    const usedNames = new Set<string>(Object.keys(swarm.members));

    for (let i = 0; i < opts.contestants.length; i++) {
      const c = opts.contestants[i];
      const provSlug =
        c.provider
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, '')
          .slice(0, 12)
          .replace(/[-_]+$/g, '') || `cli${i + 1}`;
      let candidate: string;
      if (c.name?.trim()) {
        candidate = c.name.trim().toLowerCase();
      } else {
        const maxBase = Math.max(1, MAX_WORKER_NAME_LEN - 1 - provSlug.length);
        const basePart = arenaGroup.slice(0, maxBase).replace(/[-_]+$/g, '') || 'arena';
        candidate = `${basePart}-${provSlug}`.slice(0, MAX_WORKER_NAME_LEN).replace(/[-_]+$/g, '');
      }
      if (usedNames.has(candidate)) {
        let idx = 2;
        while (true) {
          const suffix = `-${idx}`;
          const basePart = candidate.slice(0, Math.max(1, MAX_WORKER_NAME_LEN - suffix.length)).replace(/[-_]+$/g, '');
          const next = `${basePart}${suffix}`;
          if (!usedNames.has(next)) {
            candidate = next;
            break;
          }
          idx++;
        }
      }
      const check = validateWorkerName(candidate);
      if (!check.valid) {
        throw new Error(`Invalid arena worker name "${candidate}": ${check.error}`);
      }
      usedNames.add(check.normalized);

      const res = await this.addWorker({
        swarmId: swarm.id,
        name: check.normalized,
        brief: `[Arena: ${arenaGroup}] Implement your best solution independently in your isolated worktree.\n\nTask:\n${opts.task}`,
        provider: c.provider,
        model: c.model,
        permissionMode: c.permissionMode || opts.permissionMode || 'workspace-write',
        workspace: 'worktree',
        role: c.role || `arena (${c.provider})`,
        arenaGroup,
      });
      contestants.push(...res.added);
      briefSeqs.push(...res.briefSeqs);
      warnings.push(...res.warnings);
    }

    return { swarmId: swarm.id, arenaGroup, contestants, briefSeqs, warnings };
  }

  async startCrossReview(opts: {
    swarmId?: string;
    targetWorker: string;
    reviewerProvider?: string;
    reviewerModel?: string;
    reviewerName?: string;
    rubric?: string;
  }): Promise<{
    swarmId: string;
    reviewer: MemberState;
    targetWorker: string;
    reviewerProvider: string;
    warnings: string[];
    briefSeqs: number[];
  }> {
    const swarm = this.store.getSwarm(opts.swarmId);
    const targetName = opts.targetWorker.trim().toLowerCase();
    const target = swarm.members[targetName];
    if (!target) {
      throw new Error(`Target worker "${opts.targetWorker}" not found in swarm "${swarm.id}".`);
    }
    if (target.status === 'killed') {
      throw new Error(`Cannot cross-review killed worker "${target.name}".`);
    }

    const warnings: string[] = [];
    let reviewerProvider = opts.reviewerProvider?.trim().toLowerCase();
    let reviewerModel = opts.reviewerModel?.trim() || undefined;
    if (!reviewerProvider) {
      const snap = getProviderConfigSnapshot(this.store.dataDir, swarm.repoRoot, swarm.profile);
      const reviewRoute = (swarm.routingPolicy?.taskRouting?.review || []).find((entry) => {
        if (entry.provider === target.provider) return false;
        const p = snap.providers.find((item) => item.id === entry.provider);
        return Boolean(p && p.enabled && p.available);
      });
      if (reviewRoute) {
        reviewerProvider = reviewRoute.provider;
        if (!reviewerModel && reviewRoute.model) reviewerModel = reviewRoute.model;
      } else {
        const priorityIds = [
          ...(swarm.routingPolicy?.readerProviders || []),
          ...(swarm.activeProviders || []),
          ...snap.providers.map((p) => p.id),
        ];
        const alternateId = priorityIds.find((id) => {
          if (id === target.provider) return false;
          const p = snap.providers.find((item) => item.id === id);
          return Boolean(p && p.enabled && p.available);
        });
        if (alternateId) {
          reviewerProvider = alternateId;
        } else {
          reviewerProvider = target.provider;
          warnings.push(
            `No alternate enabled & available CLI provider found besides "${target.provider}"; reviewing with "${target.provider}".`,
          );
        }
      }
    }

    const baseRevName =
      opts.reviewerName?.trim().toLowerCase() ||
      `rev-${target.name}-${reviewerProvider}`.slice(0, 22).replace(/-+$/, '');
    let candidateName = baseRevName;
    if (swarm.members[candidateName]) {
      let idx = 2;
      while (swarm.members[`${candidateName.slice(0, 19)}-${idx}`]) idx++;
      candidateName = `${candidateName.slice(0, 19)}-${idx}`;
    }

    const briefLines: string[] = [
      `Cross-Vendor Code Review of @${target.name} (provider=${target.provider}, model=${target.model}).`,
      'Inspect correctness, edge cases, regressions, tests, and adherence to requirements.',
    ];
    if (opts.rubric?.trim()) {
      briefLines.push('', `Review Rubric:\n${opts.rubric.trim()}`);
    }

    const targetIsStillRunning =
      target.status === 'working' || target.status === 'queued' || target.status === 'blocked';

    if (!targetIsStillRunning) {
      if (target.workspaceMode === 'worktree') {
        const fullDiff = await getWorktreeFullDiff(target.cwd, target.baseRef, 6000);
        if (fullDiff) {
          briefLines.push(
            '',
            `Target Worktree: cwd=${target.cwd}, branch=${target.branch || ''}`,
            `Diff Stat:\n${fullDiff.stat || '(no stat)'}`,
            `Diff Patch (up to 6000 chars):\n\`\`\`diff\n${fullDiff.patch}\n\`\`\``,
          );
        }
      }
      const msgs = this.store.readBoard(swarm.id, 0, 500);
      const lastTargetPost = [...msgs]
        .reverse()
        .find((m) => m.agent === target.name && m.kind !== 'system');
      if (lastTargetPost) {
        briefLines.push('', `Latest report from @${target.name}:`, lastTargetPost.text.slice(0, 1200));
      }
    }

    briefLines.push(
      '',
      'Output format: group findings by severity (P0 blocker / P1 bug or regression / P2 suggestion) with exact `file:line` references; report "no defects found" if clean, and never speculate about unread files.',
    );

    const addRes = await this.addWorker({
      swarmId: swarm.id,
      name: candidateName,
      brief: briefLines.join('\n'),
      provider: reviewerProvider,
      model: reviewerModel,
      customCommand: reviewerProvider === target.provider ? target.customConfig : undefined,
      permissionMode: 'read-only',
      workspace: 'inherit',
      role: `cross-reviewer (${reviewerProvider})`,
      taskType: 'review',
      dependsOn: targetIsStillRunning ? [target.name] : undefined,
      arenaGroup: target.arenaGroup,
    });

    return {
      swarmId: swarm.id,
      reviewer: addRes.added[0],
      targetWorker: target.name,
      reviewerProvider,
      warnings: [...warnings, ...addRes.warnings],
      briefSeqs: addRes.briefSeqs,
    };
  }

  async applyTemplate(opts: {
    swarmId?: string;
    templateId: string;
    goal: string;
    repoRoot?: string;
    title?: string;
    providerOverrides?: Record<string, string>;
    modelOverrides?: Record<string, string>;
  }): Promise<{
    swarmId: string;
    template: SwarmTemplate;
    added: MemberState[];
    briefSeqs: number[];
    warnings: string[];
  }> {
    let swarm = opts.swarmId
      ? this.store.getSwarm(opts.swarmId)
      : !opts.repoRoot?.trim()
        ? this.store.tryGetSwarm(undefined)
        : undefined;

    const repoForTpl = opts.repoRoot?.trim() || swarm?.repoRoot;
    const snap = getTemplatesSnapshot(this.store.dataDir, repoForTpl);
    const template = snap.templates.find((t) => t.id === opts.templateId.trim().toLowerCase());
    if (!template) {
      throw new Error(
        `Unknown template "${opts.templateId}". Available: ${snap.templates.map((t) => t.id).join(', ')}.`,
      );
    }

    // Topological sort of template workers by dependsOn BEFORE creating swarm
    const byName = new Map(template.workers.map((w) => [w.name, w]));
    const ordered: typeof template.workers = [];
    const stateMap = new Map<string, 'visiting' | 'done'>();

    const visit = (name: string) => {
      const st = stateMap.get(name);
      if (st === 'done') return;
      if (st === 'visiting') {
        throw new Error(`Template "${template.id}" contains a dependency cycle involving "${name}".`);
      }
      const spec = byName.get(name);
      if (!spec) return;
      stateMap.set(name, 'visiting');
      for (const dep of spec.dependsOn || []) {
        if (byName.has(dep)) visit(dep);
      }
      stateMap.set(name, 'done');
      ordered.push(spec);
    };
    for (const w of template.workers) {
      visit(w.name);
    }

    if (!swarm) {
      if (!opts.repoRoot?.trim()) {
        throw new Error('repo_root is required when applying a template without an existing swarm.');
      }
      swarm = await this.createSwarm({
        repoRoot: opts.repoRoot.trim(),
        title: opts.title?.trim() || template.defaultTitle || template.name,
      });
    }

    const added: MemberState[] = [];
    const briefSeqs: number[] = [];
    const warnings: string[] = [];

    for (const spec of ordered) {
      const providerOverride = opts.providerOverrides?.[spec.name];
      const modelOverride = opts.modelOverrides?.[spec.name];
      const res = await this.addWorker({
        swarmId: swarm.id,
        name: spec.name,
        role: spec.role,
        brief: expandTemplateWorkerBrief(spec.brief, opts.goal),
        provider: providerOverride || spec.provider,
        model: modelOverride || spec.model,
        workspace: spec.workspace || 'worktree',
        permissionMode: spec.permission || 'workspace-write',
        dependsOn: spec.dependsOn,
        allowedFiles: spec.allowedFiles,
        verifyCommands: spec.verifyCommands,
        autoVerify: spec.autoVerify,
        turnTimeoutSeconds: spec.turnTimeoutSeconds,
      });
      added.push(...res.added);
      briefSeqs.push(...res.briefSeqs);
      warnings.push(...res.warnings);
    }

    return { swarmId: swarm.id, template, added, briefSeqs, warnings };
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
