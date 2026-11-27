import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { resolveExecutable } from './providers/shared.js';
import { formatWorkerModel } from './report.js';
import type { SwarmStore } from './store.js';
import type {
  BoardMessage,
  CreatePrResult,
  MemberState,
  MergeApplyResult,
  MergePreviewResult,
  SwarmState,
  WorktreePatchResult,
} from './types.js';
import {
  buildAugmentedEnv,
  getWorktreeDiff,
  getWorktreeFullDiff,
  mergeWorktreeBranch,
  previewWorktreeMerge,
  validateGitRefName,
} from './worktree.js';

const execFileAsync = promisify(execFile);

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
    allowedFiles: member.scopeMode === 'warn' ? undefined : member.allowedFiles,
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

export function buildWorkerPrBody(
  swarm: SwarmState,
  member: MemberState,
  messages: BoardMessage[],
  stat?: string,
): string {
  const lines: string[] = [
    `## Summary`,
    `- **Swarm**: ${swarm.title} (\`${swarm.id}\`)`,
    `- **Worker**: \`${member.name}\` (${member.role})`,
    `- **CLI / Model**: \`${member.provider || 'dsh'}\` / \`${formatWorkerModel(member)}\``,
    `- **Branch**: \`${member.branch || 'HEAD'}\``,
  ];

  if (stat?.trim()) {
    lines.push('', '## Diff Stat', '```', stat.trim(), '```');
  }

  if (member.lastVerifyResults && member.lastVerifyResults.length > 0) {
    lines.push('', '## Verification');
    for (const vr of member.lastVerifyResults) {
      lines.push(
        `- ${vr.passed ? 'PASS' : 'FAIL'} \`${vr.command}\` (exit=${vr.exitCode ?? '?'}, ${vr.durationMs}ms)`,
      );
    }
  }

  const workerSummary = [...messages]
    .reverse()
    .find((m) => m.agent === member.name && (m.kind === 'done' || m.kind === 'message'));
  if (workerSummary) {
    lines.push('', '## Worker Report', workerSummary.text.slice(0, 1500));
  }

  const crossReviews = messages.filter(
    (m) =>
      m.agent !== member.name &&
      m.agent !== 'system' &&
      m.agent !== 'coordinator' &&
      (m.mentions.includes(member.name) || m.text.includes(`@${member.name}`)) &&
      (m.kind === 'done' || m.kind === 'message'),
  );
  if (crossReviews.length > 0) {
    const latestRev = crossReviews[crossReviews.length - 1];
    lines.push(
      '',
      `## Cross-Review (@${latestRev.agent})`,
      latestRev.text.slice(0, 1200),
    );
  }

  return lines.join('\n');
}

export interface CreateWorkerPrOptions {
  swarmId?: string;
  workerName: string;
  baseBranch?: string;
  title?: string;
  body?: string;
  draft?: boolean;
  remote?: string;
}

export async function createWorkerPullRequest(
  store: SwarmStore,
  opts: CreateWorkerPrOptions,
): Promise<CreatePrResult> {
  const swarm = store.getSwarm(opts.swarmId);
  const normalized = opts.workerName.trim().toLowerCase();
  const member = swarm.members[normalized];
  if (!member) {
    throw new Error(`Worker "${opts.workerName}" not found in swarm "${swarm.id}".`);
  }
  if (member.status === 'working' || member.status === 'queued') {
    throw new Error(
      `Cannot create PR while worker "${member.name}" is still ${member.status}. Wait until it finishes.`,
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

  const branch = validateGitRefName(member.branch);
  let baseBranch = opts.baseBranch?.trim();
  if (!baseBranch) {
    try {
      const sym = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: swarm.gitRepoRoot,
        env: buildAugmentedEnv(),
      });
      baseBranch = sym.stdout.trim() || 'main';
    } catch {
      baseBranch = 'main';
    }
  }
  baseBranch = validateGitRefName(baseBranch);
  const remote = validateGitRefName(opts.remote?.trim() || 'origin');

  const diffSummary = await getWorktreeDiff(member.cwd, member.baseRef, member.allowedFiles);
  if (member.scopeMode !== 'warn' && member.allowedFiles?.length) {
    const scopeError = !diffSummary || diffSummary.branch !== branch
      ? `Could not verify allowed_files on "${branch}" in worktree "${member.cwd}".`
      : diffSummary.outOfScopeFiles.length > 0
        ? `Refusing to create a PR with files outside allowed_files: ${diffSummary.outOfScopeFiles.join(', ')}.`
        : undefined;
    if (scopeError) {
      return { created: false, workerName: member.name, branch, baseBranch, message: scopeError };
    }
  }
  if (diffSummary && diffSummary.commitCount === 0) {
    const dirtyHint =
      diffSummary.dirtyFiles.length > 0
        ? ` Found ${diffSummary.dirtyFiles.length} uncommitted file(s); commit them on "${branch}" first.`
        : '';
    return {
      created: false,
      workerName: member.name,
      branch,
      baseBranch,
      message: `No commits on "${branch}" ahead of base ref.${dirtyHint}`,
    };
  }

  const ghBin = resolveExecutable('gh');
  if (!ghBin) {
    return {
      created: false,
      workerName: member.name,
      branch,
      baseBranch,
      message: 'GitHub CLI (`gh`) was not found on PATH. Install `gh` and run `gh auth login` first.',
    };
  }

  try {
    await execFileAsync('git', ['push', '-u', remote, branch], {
      cwd: swarm.gitRepoRoot,
      env: buildAugmentedEnv(),
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (err) {
    const rec = err as { stderr?: string; message?: string };
    const detail = (rec.stderr || rec.message || String(err)).trim();
    return {
      created: false,
      workerName: member.name,
      branch,
      baseBranch,
      message: `git push failed: ${detail}`,
    };
  }

  const messages = store.readBoard(swarm.id, 0, 500);
  const prTitle = opts.title?.trim() || `[${swarm.title}] ${member.name}: ${member.role}`;
  const prBody =
    opts.body?.trim() || buildWorkerPrBody(swarm, member, messages, diffSummary?.stat);

  const ghArgs = [
    'pr',
    'create',
    '--head',
    branch,
    '--base',
    baseBranch,
    '--title',
    prTitle,
    '--body',
    prBody,
    ...(opts.draft ? ['--draft'] : []),
  ];

  try {
    const res = await execFileAsync(ghBin, ghArgs, {
      cwd: swarm.gitRepoRoot,
      env: buildAugmentedEnv(),
      maxBuffer: 4 * 1024 * 1024,
    });
    const combined = `${res.stdout}\n${res.stderr}`.trim();
    const urlMatch = /https?:\/\/\S+/.exec(combined);
    const prUrl = urlMatch?.[0];
    const msg = prUrl
      ? `Created PR for @${member.name} (${branch} -> ${baseBranch}): ${prUrl}`
      : `Created PR for @${member.name} (${branch} -> ${baseBranch})`;
    store.appendBoardMessage(swarm.id, {
      agent: 'system',
      text: msg,
      kind: 'system',
    });
    return {
      created: true,
      workerName: member.name,
      branch,
      baseBranch,
      ...(prUrl ? { prUrl } : {}),
      message: msg,
    };
  } catch (err) {
    const rec = err as { stderr?: string; stdout?: string; message?: string };
    const detail = (rec.stderr || rec.stdout || rec.message || String(err)).trim();
    return {
      created: false,
      workerName: member.name,
      branch,
      baseBranch,
      message: `gh pr create failed: ${detail}`,
    };
  }
}
