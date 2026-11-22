import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  MergePreviewResult,
  MergeApplyResult,
  WorktreeDiffSummary,
  WorktreePatchResult,
} from './types.js';

const execFileAsync = promisify(execFile);

export function buildAugmentedEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const pathKey =
    process.platform === 'win32'
      ? Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH'
      : 'PATH';
  const existingPath = process.env[pathKey] || '';
  const parts = existingPath.split(delimiter).filter(Boolean);
  if (process.platform !== 'win32') {
    const extraPaths = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'];
    for (const p of extraPaths) {
      if (!parts.includes(p)) {
        parts.push(p);
      }
    }
  }
  const joinedPath = parts.join(delimiter);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extra,
    PATH: joinedPath,
  };
  if (pathKey !== 'PATH') {
    env[pathKey] = joinedPath;
  }
  return env;
}

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const res = await execFileAsync('git', args, {
    cwd,
    env: buildAugmentedEnv(),
    maxBuffer: 4 * 1024 * 1024,
  });
  return { stdout: res.stdout.trimEnd(), stderr: res.stderr.trimEnd() };
}

export interface GitRepoInfo {
  repoRoot: string;
  gitCommonDir: string;
  headRef: string;
}

export async function detectGitRepo(dir: string): Promise<GitRepoInfo | null> {
  if (!existsSync(dir)) return null;
  try {
    const { stdout: topOut } = await runGit(dir, ['rev-parse', '--show-toplevel']);
    const rawRoot = topOut.trim();
    if (!rawRoot) return null;
    const repoRoot = existsSync(rawRoot) ? realpathSync(rawRoot) : rawRoot;

    const { stdout: commonOut } = await runGit(repoRoot, ['rev-parse', '--git-common-dir']);
    const rawCommon = commonOut.trim();
    const resolvedCommon = isAbsolute(rawCommon) ? rawCommon : resolve(repoRoot, rawCommon);
    const gitCommonDir = existsSync(resolvedCommon) ? realpathSync(resolvedCommon) : resolvedCommon;

    let headRef = 'HEAD';
    try {
      const { stdout: headOut } = await runGit(repoRoot, ['rev-parse', 'HEAD']);
      if (headOut.trim()) {
        headRef = headOut.trim();
      }
    } catch {
      // Repo has no commits yet
      return null;
    }

    return { repoRoot, gitCommonDir, headRef };
  } catch {
    return null;
  }
}

export async function createWorktree(
  repoRoot: string,
  swarmId: string,
  workerName: string,
  worktreeBaseDir: string,
): Promise<{ worktreePath: string; branch: string; baseRef: string }> {
  mkdirSync(worktreeBaseDir, { recursive: true });
  const realBaseDir = realpathSync(worktreeBaseDir);
  const worktreePath = join(realBaseDir, workerName);
  const safeSwarm = swarmId.replace(/[^a-zA-Z0-9_-]/g, '-');
  const safeWorker = workerName.replace(/[^a-zA-Z0-9_-]/g, '-');
  const branch = `ext-swarm/${safeSwarm}/${safeWorker}`;

  const { stdout: headOut } = await runGit(repoRoot, ['rev-parse', 'HEAD']);
  const baseRef = headOut.trim();

  if (existsSync(worktreePath)) {
    rmSync(worktreePath, { recursive: true, force: true });
  }

  // Delete stale branch with the same name if any
  try {
    await runGit(repoRoot, ['branch', '-D', branch]);
  } catch {
    // Ignore if branch does not exist
  }

  await runGit(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, baseRef]);
  return { worktreePath, branch, baseRef };
}

function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__DOUBLE_STAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLE_STAR__/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export function isPathAllowed(filePath: string, allowedFiles?: string[]): boolean {
  if (!allowedFiles || allowedFiles.length === 0) return true;
  const rel = normalizeRelPath(filePath);
  for (const rawPattern of allowedFiles) {
    const pattern = normalizeRelPath(rawPattern.trim());
    if (!pattern) continue;
    if (pattern === '.' || pattern === '*' || pattern === '**') return true;
    if (rel === pattern) return true;
    if (rel.startsWith(`${pattern}/`)) return true;
    if (pattern.includes('*') && globToRegex(pattern).test(rel)) return true;
  }
  return false;
}

export async function getWorktreeDiff(
  cwd: string,
  baseRef?: string,
  allowedFiles?: string[],
): Promise<WorktreeDiffSummary | null> {
  if (!existsSync(cwd)) return null;
  try {
    const { stdout: branchOut } = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = branchOut.trim() || 'HEAD';
    const ref = baseRef || 'HEAD';

    let commitCount = 0;
    try {
      const { stdout: cntOut } = await runGit(cwd, ['rev-list', '--count', `${ref}..HEAD`]);
      commitCount = Number.parseInt(cntOut.trim(), 10) || 0;
    } catch {
      commitCount = 0;
    }

    const committedFiles: string[] = [];
    if (commitCount > 0) {
      const { stdout: diffNames } = await runGit(cwd, ['diff', '--name-only', `${ref}..HEAD`]);
      for (const line of diffNames.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) committedFiles.push(trimmed);
      }
    }

    const dirtyFiles: string[] = [];
    const { stdout: statusOut } = await runGit(cwd, ['status', '--porcelain']);
    for (const line of statusOut.split('\n')) {
      if (!line.trim()) continue;
      // Porcelain v1 format: XY <path> or XY <old> -> <new>
      let filePart = line.slice(3).trim();
      const arrowIdx = filePart.lastIndexOf(' -> ');
      if (arrowIdx !== -1) {
        filePart = filePart.slice(arrowIdx + 4).trim();
      }
      if (filePart.startsWith('"') && filePart.endsWith('"')) {
        filePart = filePart.slice(1, -1);
      }
      if (filePart) dirtyFiles.push(filePart);
    }

    const changedSet = new Set<string>([...committedFiles, ...dirtyFiles]);
    const changedFiles = Array.from(changedSet).sort();

    let stat = '';
    try {
      const { stdout: statOut } = await runGit(cwd, ['diff', '--stat', ref]);
      stat = statOut.trim();
    } catch {
      stat = '';
    }

    const outOfScopeFiles =
      allowedFiles && allowedFiles.length > 0
        ? changedFiles.filter((f) => !isPathAllowed(f, allowedFiles))
        : [];

    return {
      branch,
      baseRef: ref,
      changedFiles,
      dirtyFiles: Array.from(new Set(dirtyFiles)).sort(),
      commitCount,
      stat,
      outOfScopeFiles,
    };
  } catch {
    return null;
  }
}

export async function getWorktreeFullDiff(
  cwd: string,
  baseRef?: string,
  maxBytes = 120000,
): Promise<WorktreePatchResult | null> {
  if (!existsSync(cwd)) return null;
  try {
    const { stdout: branchOut } = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = branchOut.trim() || 'HEAD';
    const ref = baseRef || 'HEAD';

    let stat = '';
    try {
      const { stdout: statOut } = await runGit(cwd, ['diff', '--stat', ref]);
      stat = statOut.trim();
    } catch {
      stat = '';
    }

    let patch = '';
    try {
      const { stdout: diffOut } = await runGit(cwd, ['diff', '--no-color', ref]);
      patch = diffOut;
    } catch {
      patch = '';
    }

    const untrackedFiles: string[] = [];
    try {
      const { stdout: lsOut } = await runGit(cwd, ['ls-files', '--others', '--exclude-standard']);
      for (const line of lsOut.split('\n')) {
        const f = line.trim();
        if (f) untrackedFiles.push(f);
      }
    } catch {
      // Best-effort
    }

    const extraPatches: string[] = [];
    for (const relPath of untrackedFiles) {
      if (patch.length + extraPatches.join('\n').length > maxBytes) break;
      const absFile = join(cwd, relPath);
      try {
        const st = statSync(absFile);
        if (!st.isFile()) continue;
        const normRel = normalizeRelPath(relPath);
        if (st.size > 16 * 1024) {
          extraPatches.push(
            `diff --git a/${normRel} b/${normRel}\nnew file mode 100644\n--- /dev/null\n+++ b/${normRel}\n@@ -0,0 +1,1 @@\n+[file > 16KB omitted: ${st.size} bytes]`,
          );
          continue;
        }
        const buf = readFileSync(absFile);
        if (buf.includes(0)) {
          extraPatches.push(
            `diff --git a/${normRel} b/${normRel}\nnew file mode 100644\nBinary file b/${normRel} (${st.size} bytes)`,
          );
          continue;
        }
        const text = buf.toString('utf8');
        const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
        const hunkBody = lines.map((l) => `+${l}`).join('\n');
        extraPatches.push(
          `diff --git a/${normRel} b/${normRel}\nnew file mode 100644\n--- /dev/null\n+++ b/${normRel}\n@@ -0,0 +1,${lines.length} @@\n${hunkBody}`,
        );
      } catch {
        // Ignore unreadable files
      }
    }

    if (extraPatches.length > 0) {
      patch = patch ? `${patch}\n${extraPatches.join('\n')}` : extraPatches.join('\n');
    }

    let truncated = false;
    if (patch.length > maxBytes) {
      patch = `${patch.slice(0, maxBytes)}\n... [diff truncated at ${maxBytes} chars]`;
      truncated = true;
    }

    return {
      branch,
      baseRef: ref,
      stat,
      patch,
      truncated,
      untrackedFiles,
    };
  } catch {
    return null;
  }
}

async function runGitVerbose(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const res = await execFileAsync('git', args, {
      cwd,
      env: buildAugmentedEnv(),
      maxBuffer: 4 * 1024 * 1024,
    });
    return {
      code: 0,
      stdout: (res.stdout || '').trimEnd(),
      stderr: (res.stderr || '').trimEnd(),
    };
  } catch (err: unknown) {
    const rec = err as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: string };
    return {
      code: typeof rec.code === 'number' ? rec.code : 1,
      stdout: String(rec.stdout || '').trimEnd(),
      stderr: String(rec.stderr || rec.message || '').trimEnd(),
    };
  }
}

async function getDirtyFiles(worktreePath?: string): Promise<string[]> {
  if (!worktreePath || !existsSync(worktreePath)) return [];
  const res = await runGitVerbose(worktreePath, ['status', '--porcelain']);
  if (res.code !== 0 || !res.stdout) return [];
  const files: string[] = [];
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue;
    const rawPath = line.slice(3).trim();
    const arrowIdx = rawPath.indexOf(' -> ');
    files.push(arrowIdx >= 0 ? rawPath.slice(arrowIdx + 4).trim() : rawPath);
  }
  return [...new Set(files)];
}

function parseConflictOutput(combined: string): {
  conflictFiles: string[];
  conflictDetails: string[];
} {
  const files = new Set<string>();
  const details: string[] = [];
  for (const rawLine of combined.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const stageMatch = line.match(/^[0-9]{6}\s+[0-9a-f]+\s+[123]\t(.+)$/i);
    if (stageMatch?.[1]) {
      files.add(stageMatch[1].trim());
      continue;
    }
    if (line.startsWith('CONFLICT')) {
      details.push(line);
      const mergeConflictMatch = line.match(/Merge conflict in (.+)$/);
      if (mergeConflictMatch?.[1]) {
        files.add(mergeConflictMatch[1].trim());
      } else {
        const modDelMatch = line.match(/^CONFLICT\s*\([^)]+\):\s*(.+?)\s+(?:deleted|modified|renamed)\b/);
        if (modDelMatch?.[1]) {
          files.add(modDelMatch[1].trim());
        }
      }
    } else if (line.startsWith('error:') || line.startsWith('fatal:')) {
      details.push(line);
    }
  }
  return { conflictFiles: [...files], conflictDetails: details };
}

async function commitWithAuthorFallback(
  cwd: string,
  extraArgs: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const first = await runGitVerbose(cwd, ['commit', ...extraArgs]);
  if (first.code === 0) return first;
  if (/Author identity unknown|unable to auto-detect email|user\.name|user\.email/i.test(first.stderr + first.stdout)) {
    return runGitVerbose(cwd, [
      '-c',
      'user.name=agy-ext-swarm',
      '-c',
      'user.email=swarm@local',
      'commit',
      ...extraArgs,
    ]);
  }
  return first;
}

export async function previewWorktreeMerge(opts: {
  repoRoot: string;
  workerName: string;
  branch: string;
  workerCwd?: string;
  targetBranch?: string;
}): Promise<MergePreviewResult> {
  const headRes = await runGitVerbose(opts.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const currentBranch = headRes.code === 0 && headRes.stdout.trim() ? headRes.stdout.trim() : 'HEAD';
  const targetBranch = opts.targetBranch?.trim() || currentBranch;

  const baseRes = await runGitVerbose(opts.repoRoot, ['merge-base', targetBranch, opts.branch]);
  const mergeBase = baseRes.code === 0 ? baseRes.stdout.trim() : '';

  const aheadRes = await runGitVerbose(opts.repoRoot, [
    'rev-list',
    '--count',
    `${targetBranch}..${opts.branch}`,
  ]);
  const aheadCommits = aheadRes.code === 0 ? Number(aheadRes.stdout.trim()) || 0 : 0;

  const diffBase = mergeBase || targetBranch;
  const committedFilesRes = await runGitVerbose(opts.repoRoot, [
    'diff',
    '--name-only',
    diffBase,
    opts.branch,
  ]);
  const committedFiles =
    committedFilesRes.code === 0
      ? committedFilesRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
      : [];

  const dirtyFiles = await getDirtyFiles(opts.workerCwd);
  const changedFiles = [...new Set([...committedFiles, ...dirtyFiles])];

  const statRes = await runGitVerbose(opts.repoRoot, ['diff', '--stat', `${diffBase}..${opts.branch}`]);
  const stat = statRes.code === 0 ? statRes.stdout : '';

  if (aheadCommits === 0 && dirtyFiles.length === 0) {
    return {
      workerName: opts.workerName,
      branch: opts.branch,
      targetBranch,
      mergeBase,
      aheadCommits: 0,
      changedFiles: [],
      dirtyFiles: [],
      canCleanMerge: true,
      conflictFiles: [],
      conflictDetails: [],
      stat,
    };
  }

  let canCleanMerge = true;
  const conflictFileSet = new Set<string>();
  const conflictDetails: string[] = [];

  if (aheadCommits > 0) {
    const mt = await runGitVerbose(opts.repoRoot, ['merge-tree', '--write-tree', targetBranch, opts.branch]);
    if (mt.code !== 0) {
      const combined = `${mt.stdout}\n${mt.stderr}`;
      if (/unknown option|usage: git merge-tree/i.test(combined) && mergeBase) {
        // Legacy Git (< 2.38) fallback: 3-way merge-tree
        const legacy = await runGitVerbose(opts.repoRoot, [
          'merge-tree',
          mergeBase,
          targetBranch,
          opts.branch,
        ]);
        const legacyOut = `${legacy.stdout}\n${legacy.stderr}`;
        if (legacyOut.includes('<<<<<<<') || legacyOut.includes('changed in both')) {
          canCleanMerge = false;
          for (const l of legacyOut.split('\n')) {
            if (l.includes('changed in both') || l.includes('result in')) {
              conflictDetails.push(l.trim());
            }
          }
        }
      } else {
        canCleanMerge = false;
        const parsed = parseConflictOutput(combined);
        for (const f of parsed.conflictFiles) conflictFileSet.add(f);
        conflictDetails.push(...parsed.conflictDetails);
        if (conflictDetails.length === 0 && mt.stderr) {
          conflictDetails.push(mt.stderr);
        }
      }
    }
  }

  if (dirtyFiles.length > 0 && mergeBase) {
    const targetChangedRes = await runGitVerbose(opts.repoRoot, [
      'diff',
      '--name-only',
      mergeBase,
      targetBranch,
    ]);
    const targetChanged = new Set(
      targetChangedRes.code === 0
        ? targetChangedRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
        : [],
    );
    for (const dirty of dirtyFiles) {
      if (targetChanged.has(dirty)) {
        canCleanMerge = false;
        conflictFileSet.add(dirty);
        conflictDetails.push(
          `Uncommitted worktree edit "${dirty}" overlaps with changes on ${targetBranch}.`,
        );
      }
    }
  }

  return {
    workerName: opts.workerName,
    branch: opts.branch,
    targetBranch,
    mergeBase,
    aheadCommits,
    changedFiles,
    dirtyFiles,
    canCleanMerge,
    conflictFiles: [...conflictFileSet],
    conflictDetails,
    stat,
  };
}

export async function mergeWorktreeBranch(opts: {
  repoRoot: string;
  workerName: string;
  branch: string;
  workerCwd?: string;
  targetBranch?: string;
  mode?: 'squash' | 'cherry-pick' | 'merge';
  commitMessage?: string;
  removeWorktreeAfter?: boolean;
}): Promise<MergeApplyResult> {
  const mode = opts.mode || 'squash';
  const headRes = await runGitVerbose(opts.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const currentBranch = headRes.code === 0 && headRes.stdout.trim() ? headRes.stdout.trim() : 'HEAD';
  const targetBranch = opts.targetBranch?.trim() || currentBranch;

  if (
    opts.targetBranch?.trim() &&
    opts.targetBranch.trim() !== currentBranch &&
    opts.targetBranch.trim() !== 'HEAD'
  ) {
    return {
      merged: false,
      mode,
      workerName: opts.workerName,
      branch: opts.branch,
      targetBranch,
      message: `Target branch "${targetBranch}" is not checked out in ${opts.repoRoot} (current HEAD is "${currentBranch}"). Switch branches first.`,
    };
  }

  // Ensure main repo working tree / index has no uncommitted tracked modifications
  const wtCleanRes = await runGitVerbose(opts.repoRoot, ['diff', '--quiet']);
  const idxCleanRes = await runGitVerbose(opts.repoRoot, ['diff', '--cached', '--quiet']);
  if (wtCleanRes.code !== 0 || idxCleanRes.code !== 0) {
    return {
      merged: false,
      mode,
      workerName: opts.workerName,
      branch: opts.branch,
      targetBranch,
      message: `Target repository (${opts.repoRoot}) has uncommitted tracked changes; commit or stash them before merging.`,
    };
  }

  if (opts.workerCwd && existsSync(opts.workerCwd)) {
    const dirtyBefore = await getDirtyFiles(opts.workerCwd);
    if (dirtyBefore.length > 0) {
      const addRes = await runGitVerbose(opts.workerCwd, ['add', '-A']);
      if (addRes.code !== 0) {
        return {
          merged: false,
          mode,
          workerName: opts.workerName,
          branch: opts.branch,
          targetBranch,
          message: `Failed to stage uncommitted worktree files in ${opts.workerCwd}: ${addRes.stderr}`,
        };
      }
      const commitSnap = await commitWithAuthorFallback(opts.workerCwd, [
        '-m',
        `chore(swarm): snapshot ${opts.workerName} worktree changes`,
      ]);
      if (commitSnap.code !== 0) {
        return {
          merged: false,
          mode,
          workerName: opts.workerName,
          branch: opts.branch,
          targetBranch,
          message: `Failed to commit worktree snapshot: ${commitSnap.stderr || commitSnap.stdout}`,
        };
      }
    }
  }

  const preview = await previewWorktreeMerge({
    repoRoot: opts.repoRoot,
    workerName: opts.workerName,
    branch: opts.branch,
    workerCwd: opts.workerCwd,
    targetBranch,
  });

  if (preview.aheadCommits === 0) {
    let worktreeRemoved = false;
    if (opts.removeWorktreeAfter && opts.workerCwd) {
      const rm = await removeWorktree(opts.repoRoot, opts.workerCwd, opts.branch);
      worktreeRemoved = rm.removedWorktree;
    }
    return {
      merged: true,
      mode,
      workerName: opts.workerName,
      branch: opts.branch,
      targetBranch,
      message: 'Already up to date (no commits ahead of target branch).',
      worktreeRemoved,
    };
  }

  if (!preview.canCleanMerge) {
    return {
      merged: false,
      mode,
      workerName: opts.workerName,
      branch: opts.branch,
      targetBranch,
      conflictFiles: preview.conflictFiles,
      message:
        preview.conflictDetails[0] ||
        `Merge conflicts detected in ${preview.conflictFiles.join(', ') || 'worktree'}; working tree left untouched.`,
    };
  }

  const commitMsg =
    opts.commitMessage?.trim() || `feat(swarm): merge ${opts.workerName} (${opts.branch})`;

  if (mode === 'squash') {
    const mergeRes = await runGitVerbose(opts.repoRoot, ['merge', '--squash', opts.branch]);
    if (mergeRes.code !== 0) {
      const parsed = parseConflictOutput(`${mergeRes.stdout}\n${mergeRes.stderr}`);
      await runGitVerbose(opts.repoRoot, ['reset', '--merge']);
      return {
        merged: false,
        mode,
        workerName: opts.workerName,
        branch: opts.branch,
        targetBranch,
        conflictFiles: parsed.conflictFiles,
        message: parsed.conflictDetails[0] || mergeRes.stderr || 'Squash merge failed cleanly.',
      };
    }
    const stagedRes = await runGitVerbose(opts.repoRoot, ['diff', '--cached', '--name-only']);
    if (stagedRes.code === 0 && stagedRes.stdout.trim()) {
      const commitRes = await commitWithAuthorFallback(opts.repoRoot, ['-m', commitMsg]);
      if (commitRes.code !== 0) {
        await runGitVerbose(opts.repoRoot, ['reset', '--merge']);
        return {
          merged: false,
          mode,
          workerName: opts.workerName,
          branch: opts.branch,
          targetBranch,
          message: `Squash commit failed: ${commitRes.stderr || commitRes.stdout}`,
        };
      }
    }
  } else if (mode === 'merge') {
    let mergeRes = await runGitVerbose(opts.repoRoot, ['merge', '--no-ff', '-m', commitMsg, opts.branch]);
    if (
      mergeRes.code !== 0 &&
      /Author identity unknown|unable to auto-detect email|user\.name|user\.email/i.test(
        mergeRes.stderr + mergeRes.stdout,
      )
    ) {
      await runGitVerbose(opts.repoRoot, ['merge', '--abort']);
      mergeRes = await runGitVerbose(opts.repoRoot, [
        '-c',
        'user.name=agy-ext-swarm',
        '-c',
        'user.email=swarm@local',
        'merge',
        '--no-ff',
        '-m',
        commitMsg,
        opts.branch,
      ]);
    }
    if (mergeRes.code !== 0) {
      const parsed = parseConflictOutput(`${mergeRes.stdout}\n${mergeRes.stderr}`);
      await runGitVerbose(opts.repoRoot, ['merge', '--abort']);
      return {
        merged: false,
        mode,
        workerName: opts.workerName,
        branch: opts.branch,
        targetBranch,
        conflictFiles: parsed.conflictFiles,
        message: parsed.conflictDetails[0] || mergeRes.stderr || 'Merge failed cleanly.',
      };
    }
  } else {
    const revRes = await runGitVerbose(opts.repoRoot, [
      'rev-list',
      '--reverse',
      `${targetBranch}..${opts.branch}`,
    ]);
    const commits = revRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    if (commits.length > 0) {
      let cpRes = await runGitVerbose(opts.repoRoot, ['cherry-pick', ...commits]);
      if (
        cpRes.code !== 0 &&
        /Author identity unknown|unable to auto-detect email|user\.name|user\.email/i.test(
          cpRes.stderr + cpRes.stdout,
        )
      ) {
        await runGitVerbose(opts.repoRoot, ['cherry-pick', '--abort']);
        cpRes = await runGitVerbose(opts.repoRoot, [
          '-c',
          'user.name=agy-ext-swarm',
          '-c',
          'user.email=swarm@local',
          'cherry-pick',
          ...commits,
        ]);
      }
      if (cpRes.code !== 0) {
        const parsed = parseConflictOutput(`${cpRes.stdout}\n${cpRes.stderr}`);
        await runGitVerbose(opts.repoRoot, ['cherry-pick', '--abort']);
        return {
          merged: false,
          mode,
          workerName: opts.workerName,
          branch: opts.branch,
          targetBranch,
          conflictFiles: parsed.conflictFiles,
          message: parsed.conflictDetails[0] || cpRes.stderr || 'Cherry-pick failed cleanly.',
        };
      }
    }
  }

  const shaRes = await runGitVerbose(opts.repoRoot, ['rev-parse', 'HEAD']);
  const commitSha = shaRes.code === 0 ? shaRes.stdout.trim() : undefined;

  let worktreeRemoved = false;
  if (opts.removeWorktreeAfter && opts.workerCwd) {
    const rm = await removeWorktree(opts.repoRoot, opts.workerCwd, opts.branch);
    worktreeRemoved = rm.removedWorktree;
  }

  return {
    merged: true,
    mode,
    workerName: opts.workerName,
    branch: opts.branch,
    targetBranch,
    commitSha,
    message: `Merged ${opts.branch} into ${targetBranch} using ${mode}${commitSha ? ` (${commitSha.slice(0, 7)})` : ''}.`,
    worktreeRemoved,
  };
}

export async function removeWorktree(
  repoRoot: string | undefined,
  worktreePath: string,
  branch?: string,
): Promise<{ removedWorktree: boolean; removedBranch: boolean }> {
  let removedWorktree = false;
  let removedBranch = false;

  if (repoRoot && existsSync(repoRoot)) {
    try {
      await runGit(repoRoot, ['worktree', 'remove', '--force', worktreePath]);
      removedWorktree = true;
    } catch {
      // Fallback to directory cleanup + prune
      try {
        if (existsSync(worktreePath)) {
          rmSync(worktreePath, { recursive: true, force: true });
          removedWorktree = true;
        }
        await runGit(repoRoot, ['worktree', 'prune']);
      } catch {
        // Best effort
      }
    }

    if (branch) {
      try {
        await runGit(repoRoot, ['branch', '-D', branch]);
        removedBranch = true;
      } catch {
        // Ignore if already deleted or merged
      }
    }
  } else if (existsSync(worktreePath)) {
    rmSync(worktreePath, { recursive: true, force: true });
    removedWorktree = true;
  }

  return { removedWorktree, removedBranch };
}
