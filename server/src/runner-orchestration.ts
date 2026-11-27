import { randomBytes } from 'node:crypto';
import { MAX_WORKER_NAME_LEN, validateWorkerName } from './mentions.js';
import { getProviderConfigSnapshot } from './providers/index.js';
import type { AddWorkerInput, AddWorkerResult } from './runner.js';
import type { SwarmStore } from './store.js';
import { expandTemplateWorkerBrief, getTemplatesSnapshot } from './templates.js';
import type {
  MemberState,
  PermissionMode,
  ProviderRoutingPolicy,
  SwarmState,
  SwarmTemplate,
} from './types.js';
import { getWorktreeFullDiff } from './worktree.js';

export interface CreateSwarmParams {
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
}

export interface OrchestrationHost {
  store: SwarmStore;
  addWorker(input: AddWorkerInput): Promise<AddWorkerResult>;
  createSwarm(params: CreateSwarmParams): Promise<SwarmState>;
}

export interface StartArenaOptions {
  swarmId?: string;
  task: string;
  contestants: Array<{
    name?: string;
    provider: string;
    model?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
    permissionMode?: PermissionMode;
    role?: string;
  }>;
  baseName?: string;
  permissionMode?: PermissionMode;
}

export interface StartArenaResult {
  swarmId: string;
  arenaGroup: string;
  contestants: MemberState[];
  briefSeqs: number[];
  warnings: string[];
}

export async function startArena(
  host: OrchestrationHost,
  opts: StartArenaOptions,
): Promise<StartArenaResult> {
  if (!opts.contestants || opts.contestants.length < 2) {
    throw new Error('Arena mode requires at least 2 contestants.');
  }
  const swarm = host.store.getSwarm(opts.swarmId);
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
        const basePart = candidate
          .slice(0, Math.max(1, MAX_WORKER_NAME_LEN - suffix.length))
          .replace(/[-_]+$/g, '');
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

    const res = await host.addWorker({
      swarmId: swarm.id,
      name: check.normalized,
      brief: `[Arena: ${arenaGroup}] Implement your best solution independently in your isolated worktree.\n\nTask:\n${opts.task}`,
      provider: c.provider,
      model: c.model,
      reasoningEffort: c.reasoningEffort,
      fastMode: c.fastMode,
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

export interface StartCrossReviewOptions {
  swarmId?: string;
  targetWorker: string;
  reviewerProvider?: string;
  reviewerModel?: string;
  reviewerReasoningEffort?: string;
  reviewerFastMode?: boolean;
  reviewerName?: string;
  rubric?: string;
}

export interface StartCrossReviewResult {
  swarmId: string;
  reviewer: MemberState;
  targetWorker: string;
  reviewerProvider: string;
  warnings: string[];
  briefSeqs: number[];
}

export async function startCrossReview(
  host: OrchestrationHost,
  opts: StartCrossReviewOptions,
): Promise<StartCrossReviewResult> {
  const swarm = host.store.getSwarm(opts.swarmId);
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
  let routedReviewEffort: string | undefined;
  let routedReviewFast: boolean | undefined;
  if (!reviewerProvider) {
    const snap = getProviderConfigSnapshot(host.store.dataDir, swarm.repoRoot, swarm.profile);
    const reviewRoute = (swarm.routingPolicy?.taskRouting?.review || []).find((entry) => {
      if (entry.provider === target.provider) return false;
      const p = snap.providers.find((item) => item.id === entry.provider);
      return Boolean(p && p.enabled && p.available);
    });
    if (reviewRoute) {
      reviewerProvider = reviewRoute.provider;
      if (!reviewerModel && reviewRoute.model) reviewerModel = reviewRoute.model;
      routedReviewEffort = reviewRoute.reasoningEffort;
      routedReviewFast = reviewRoute.fastMode;
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
    const msgs = host.store.readBoard(swarm.id, 0, 500);
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

  const addRes = await host.addWorker({
    swarmId: swarm.id,
    name: candidateName,
    brief: briefLines.join('\n'),
    provider: reviewerProvider,
    model: reviewerModel,
    reasoningEffort: opts.reviewerReasoningEffort ?? routedReviewEffort,
    fastMode: opts.reviewerFastMode ?? routedReviewFast,
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

export interface ApplyTemplateOptions {
  swarmId?: string;
  templateId: string;
  goal: string;
  repoRoot?: string;
  title?: string;
  providerOverrides?: Record<string, string>;
  modelOverrides?: Record<string, string>;
  reasoningEffortOverrides?: Record<string, string | null>;
  fastModeOverrides?: Record<string, boolean | null>;
  allowedFilesOverrides?: Record<string, string[]>;
  verifyCommandsOverrides?: Record<string, string[]>;
}

export interface ApplyTemplateResult {
  swarmId: string;
  template: SwarmTemplate;
  added: MemberState[];
  briefSeqs: number[];
  warnings: string[];
}

export async function applyTemplate(
  host: OrchestrationHost,
  opts: ApplyTemplateOptions,
): Promise<ApplyTemplateResult> {
  let swarm = opts.swarmId
    ? host.store.getSwarm(opts.swarmId)
    : !opts.repoRoot?.trim()
      ? host.store.tryGetSwarm(undefined)
      : undefined;

  const repoForTpl = opts.repoRoot?.trim() || swarm?.repoRoot;
  const snap = getTemplatesSnapshot(host.store.dataDir, repoForTpl);
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
    swarm = await host.createSwarm({
      repoRoot: opts.repoRoot.trim(),
      title: opts.title?.trim() || template.defaultTitle || template.name,
    });
  }

  const added: MemberState[] = [];
  const briefSeqs: number[] = [];
  const warnings: string[] = [];

  for (const spec of ordered) {
    const provider = opts.providerOverrides && Object.prototype.hasOwnProperty.call(opts.providerOverrides, spec.name)
      ? opts.providerOverrides[spec.name]
      : spec.provider;
    const model = opts.modelOverrides && Object.prototype.hasOwnProperty.call(opts.modelOverrides, spec.name)
      ? opts.modelOverrides[spec.name]
      : spec.model;
    const effortOverride = opts.reasoningEffortOverrides?.[spec.name];
    const fastOverride = opts.fastModeOverrides?.[spec.name];
    const allowedFiles =
      opts.allowedFilesOverrides &&
      Object.prototype.hasOwnProperty.call(opts.allowedFilesOverrides, spec.name)
        ? opts.allowedFilesOverrides[spec.name].map((f) => f.trim()).filter(Boolean)
        : spec.allowedFiles;
    const verifyCommands =
      opts.verifyCommandsOverrides &&
      Object.prototype.hasOwnProperty.call(opts.verifyCommandsOverrides, spec.name)
        ? opts.verifyCommandsOverrides[spec.name].map((c) => c.trim()).filter(Boolean)
        : spec.verifyCommands;
    const res = await host.addWorker({
      swarmId: swarm.id,
      name: spec.name,
      role: spec.role,
      brief: expandTemplateWorkerBrief(spec.brief, opts.goal),
      provider,
      model,
      reasoningEffort:
        effortOverride === null || effortOverride === ''
          ? undefined
          : (effortOverride ?? spec.reasoningEffort),
      fastMode: fastOverride === null ? undefined : (fastOverride ?? spec.fastMode),
      workspace: spec.workspace || 'worktree',
      permissionMode: spec.permission || 'workspace-write',
      dependsOn: spec.dependsOn,
      allowedFiles,
      scopeMode: spec.scopeMode,
      verifyCommands,
      autoVerify: spec.autoVerify,
      verifyTimeoutSeconds: spec.verifyTimeoutSeconds,
      maxVerifyRetries: spec.maxVerifyRetries,
      turnTimeoutSeconds: spec.turnTimeoutSeconds,
    });
    added.push(...res.added);
    briefSeqs.push(...res.briefSeqs);
    warnings.push(...res.warnings);
  }

  return { swarmId: swarm.id, template, added, briefSeqs, warnings };
}
