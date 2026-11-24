import { existsSync } from 'node:fs';
import type { SwarmStore } from './store.js';
import type {
  MergeApplyResult,
  MergePreviewResult,
  WorktreePatchResult,
} from './types.js';
import {
  getWorktreeFullDiff,
  mergeWorktreeBranch,
  previewWorktreeMerge,
} from './worktree.js';

export async function getWorkerFullDiff(
  store: SwarmStore,
  swarmId: string | undefined,
  name: string,
): Promise<WorktreePatchResult> {
  const swarm = store.getSwarm(swarmId);
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

export interface PreviewWorkerMergeOptions {
  swarmId?: string;
  workerName: string;
  targetBranch?: string;
}

export async function previewWorkerMerge(
  store: SwarmStore,
  opts: PreviewWorkerMergeOptions,
): Promise<MergePreviewResult> {
  const swarm = store.getSwarm(opts.swarmId);
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

export interface MergeWorkerOptions {
  swarmId?: string;
  workerName: string;
  targetBranch?: string;
  mode?: 'squash' | 'cherry-pick' | 'merge';
  commitMessage?: string;
  removeWorktreeAfter?: boolean;
}

export async function mergeWorker(
  store: SwarmStore,
  opts: MergeWorkerOptions,
): Promise<MergeApplyResult> {
  const swarm = store.getSwarm(opts.swarmId);
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
      const latestSwarm = store.tryGetSwarm(swarm.id);
      const latestMember = latestSwarm?.members[member.name];
      if (latestMember) {
        latestMember.branch = undefined;
        latestMember.workspaceMode = 'inherit';
        latestMember.cwd = swarm.repoRoot;
        store.upsertMember(swarm.id, latestMember);
      }
    }
    store.appendBoardMessage(swarm.id, {
      agent: 'system',
      text: `Merged @${member.name} (${result.branch} -> ${result.targetBranch}, mode=${result.mode}${result.commitSha ? `, ${result.commitSha.slice(0, 7)}` : ''})${result.worktreeRemoved ? ' [worktree removed]' : ''}.`,
      kind: 'system',
    });
  } else {
    store.appendBoardMessage(swarm.id, {
      agent: 'system',
      text: `@coordinator [warning] Merge blocked for @${member.name}: ${result.message}`,
      kind: 'warning',
    });
  }

  return result;
}
