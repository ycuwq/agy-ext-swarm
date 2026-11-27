import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  MergePreviewResult,
  MergeApplyResult,
  WorktreeDiffSummary,
  WorktreePatchResult,
} from './types.js';
import { loadWorktreeHooksConfig, runWorktreeTeardown } from './worktree-hooks.js';

export {
  hydrateWorktree,
  loadWorktreeHooksConfig,
  runWorktreeTeardown,
  type HydrateWorktreeResult,
} from './worktree-hooks.js';

const execFileAsync = promisify(execFile);

export function buildAugmentedEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const pathKey =
    process.platform === 'win32'
      ? Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH'
      : 'PATH';
  const existingPath = process.env[pathKey] || '';
  const parts = existingPath.split(delimiter).filter(Boolean);
  if (process.platform !== 'win32') {
    const home = homedir();
    const extraPaths = [
      '/usr/local/bin',
      '/opt/homebrew/bin',
      ...(home ? [join(home, '.local', 'bin')] : []),
      '/usr/bin',
      '/bin',
    ];
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
  await runGit(repoRoot, ['worktree', 'prune', '--expire', 'now']);

  // Delete stale branch with the same name if any
  try {
    await runGit(repoRoot, ['branch', '-D', branch]);
  } catch {
    // Ignore if branch does not exist
  }

  await runGit(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, baseRef]);
  return { worktreePath, branch, baseRef };
}

export function validateGitRefName(ref: string): string {
  const trimmed = ref.trim();
  if (
    !trimmed ||
    trimmed.startsWith('-') ||
    /[\s\x00-\x1f\x7f~^:?*[\]\\]/.test(trimmed) ||
    trimmed.includes('..') ||
    trimmed.includes('@{') ||
    trimmed.endsWith('/') ||
    trimmed.endsWith('.') ||
    trimmed.endsWith('.lock')
  ) {
    throw new Error(`Invalid git ref name: "${ref}"`);
  }
  return trimmed;
}

const repoMergeLocks = new Map<string, Promise<unknown>>();

function withRepoMergeLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  let lockKey = resolve(repoRoot);
  try {
    lockKey = realpathSync(repoRoot);
  } catch {
    // Keep resolved path
  }
  const prev = repoMergeLocks.get(lockKey) || Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  const cleanupPromise = next.then(
    () => undefined,
    () => undefined,
  );
  repoMergeLocks.set(lockKey, cleanupPromise);
  void cleanupPromise.finally(() => {
    if (repoMergeLocks.get(lockKey) === cleanupPromise) {
      repoMergeLocks.delete(lockKey);
    }
  });
  return next;
}

function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\/\*\*\//g, '__SLASH_DS_SLASH__')
    .replace(/\*\*\//g, '__DS_SLASH__')
    .replace(/\/\*\*/g, '__SLASH_DS__')
    .replace(/\*\*/g, '__DOUBLE_STAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/__SLASH_DS_SLASH__/g, '(?:/|/.+/)')
    .replace(/__DS_SLASH__/g, '(?:.+/)?')
    .replace(/__SLASH_DS__/g, '(?:/.*)?')
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
    if ((pattern.includes('*') || pattern.includes('?')) && globToRegex(pattern).test(rel)) {
      return true;
    }
  }
  return false;
}

function unquoteGitPath(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return t;
}

export function parsePorcelainPaths(stdout: string): string[] {
  const paths = new Set<string>();
  if (stdout.includes('\0')) {
    const entries = stdout.split('\0');
    for (let i = 0; i < entries.length && entries[i]; i += 1) {
      const entry = entries[i];
      const status = entry.slice(0, 2);
      paths.add(entry.slice(3));
      if (status.includes('R') || status.includes('C')) {
        // With -z, the destination precedes the source.
        const source = entries[++i];
        if (status.includes('R') && source) paths.add(source);
      }
    }
    return [...paths].sort();
  }

  for (const rawLine of stdout.split('\n')) {
    if (!rawLine.trim()) continue;
    // Porcelain v1 format: XY <path> or XY <old> -> <new>
    const statusCode = rawLine.slice(0, 2);
    const filePart = rawLine.slice(3).trim();
    const arrowIdx = filePart.lastIndexOf(' -> ');
    if (arrowIdx !== -1 && (statusCode.includes('R') || statusCode.includes('C'))) {
      const oldPath = unquoteGitPath(filePart.slice(0, arrowIdx));
      const newPath = unquoteGitPath(filePart.slice(arrowIdx + 4));
      if (oldPath && !statusCode.includes('C')) paths.add(oldPath);
      if (newPath) paths.add(newPath);
      continue;
    }
    const cleaned = unquoteGitPath(filePart);
    if (cleaned) paths.add(cleaned);
  }
  return Array.from(paths).sort();
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

    let committedFiles: string[] = [];
    if (commitCount > 0) {
      const { stdout: diffNames } = await runGit(cwd, [
        'diff',
        '--name-only',
        '--no-renames',
        '-z',
        `${ref}..HEAD`,
        '--',
      ]);
      committedFiles = diffNames.split('\0').filter(Boolean);
    }

    const { stdout: statusOut } = await runGit(cwd, [
      '-c',
      'core.quotepath=false',
      'status',
      '--porcelain',
      '-z',
      '-uall',
    ]);
    const dirtyFiles = parsePorcelainPaths(statusOut);

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

    let realCwd = resolve(cwd);
    try {
      realCwd = realpathSync(cwd);
    } catch {
      // Keep resolved path
    }
    const extraPatches: string[] = [];
    for (const relPath of untrackedFiles) {
      if (patch.length + extraPatches.join('\n').length > maxBytes) break;
      const absFile = join(cwd, relPath);
      try {
        const st = lstatSync(absFile);
        const normRel = normalizeRelPath(relPath);
        if (st.isSymbolicLink()) {
          let linkTarget = '(unreadable)';
          try {
            linkTarget = readlinkSync(absFile);
          } catch {
            // Best-effort link target
          }
          extraPatches.push(
            `diff --git a/${normRel} b/${normRel}\nnew file mode 120000\n--- /dev/null\n+++ b/${normRel}\n@@ -0,0 +1,1 @@\n+[symlink -> ${linkTarget}]`,
          );
          continue;
        }
        if (!st.isFile()) continue;
        const realAbs = realpathSync(absFile);
        const relCheck = relative(realCwd, realAbs);
        if (relCheck.startsWith('..') || isAbsolute(relCheck)) continue;
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

async function getDirtyFiles(worktreePath?: string): Promise<string[] | null> {
  if (!worktreePath || !existsSync(worktreePath)) return [];
  const res = await runGitVerbose(worktreePath, [
    '-c',
    'core.quotepath=false',
    'status',
    '--porcelain',
    '-z',
    '-uall',
  ]);
  if (res.code !== 0) return null;
  return parsePorcelainPaths(res.stdout);
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

export interface SnapshotWorktreeResult {
  committed: boolean;
  commitSha?: string;
  committedFiles: string[];
  skippedReason?: 'clean' | 'no_eligible_files' | 'out_of_scope' | 'invalid_ref';
  outOfScopeFiles: string[];
  error?: string;
}

/**
 * Safely stages and commits eligible dirty edits in a worker worktree after a verified turn,
 * excluding untracked files hydrated via `.agy-ext-swarm/worktree.json` (`copyFiles`/`symlinkDirs`).
 */
export async function snapshotWorktreeChanges(opts: {
  cwd: string;
  repoRoot?: string;
  branch?: string;
  memberName: string;
  allowedFiles?: string[];
  scopeMode?: 'enforce' | 'warn';
}): Promise<SnapshotWorktreeResult> {
  if (opts.branch && !validateGitRefName(opts.branch)) {
    return {
      committed: false,
      committedFiles: [],
      skippedReason: 'invalid_ref',
      outOfScopeFiles: [],
      error: `Invalid git branch ref: ${opts.branch}`,
    };
  }

  const dirtyFiles = await getDirtyFiles(opts.cwd);
  if (!dirtyFiles) {
    return {
      committed: false,
      committedFiles: [],
      outOfScopeFiles: [],
      error: 'git status --porcelain failed in worktree',
    };
  }
  if (dirtyFiles.length === 0) {
    return {
      committed: false,
      committedFiles: [],
      skippedReason: 'clean',
      outOfScopeFiles: [],
    };
  }

  const hooksConfig = loadWorktreeHooksConfig(opts.repoRoot || opts.cwd);
  const hydratedPatterns = [...(hooksConfig?.copyFiles || []), ...(hooksConfig?.symlinkDirs || [])]
    .map((p) => p.replace(/\\/g, '/').replace(/\/+$/, ''))
    .filter(Boolean);

  let untrackedSet = new Set<string>();
  if (hydratedPatterns.length > 0) {
    const untrackedRes = await runGitVerbose(opts.cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
    if (untrackedRes.code === 0 && untrackedRes.stdout) {
      untrackedSet = new Set(
        untrackedRes.stdout
          .split('\0')
          .map((p) => p.trim())
          .filter(Boolean),
      );
    }
  }

  const eligibleDirty = dirtyFiles.filter((filePath) => {
    if (hydratedPatterns.length === 0) return true;
    const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '');
    const isUntracked =
      untrackedSet.has(filePath) ||
      untrackedSet.has(normalized) ||
      (filePath.endsWith('/') && Array.from(untrackedSet).some((u) => u.startsWith(`${normalized}/`)));
    if (!isUntracked) return true;
    return !isPathAllowed(normalized, hydratedPatterns);
  });

  if (eligibleDirty.length === 0) {
    return {
      committed: false,
      committedFiles: [],
      skippedReason: 'no_eligible_files',
      outOfScopeFiles: [],
    };
  }

  const outOfScopeFiles =
    opts.allowedFiles && opts.allowedFiles.length > 0
      ? eligibleDirty.filter((f) => !isPathAllowed(f, opts.allowedFiles!))
      : [];
  if (outOfScopeFiles.length > 0 && opts.scopeMode !== 'warn') {
    return {
      committed: false,
      committedFiles: [],
      skippedReason: 'out_of_scope',
      outOfScopeFiles,
    };
  }

  const CHUNK_SIZE = 100;
  for (let i = 0; i < eligibleDirty.length; i += CHUNK_SIZE) {
    const chunk = eligibleDirty.slice(i, i + CHUNK_SIZE);
    const addRes = await runGitVerbose(opts.cwd, ['add', '-A', '--', ...chunk]);
    if (addRes.code !== 0) {
      return {
        committed: false,
        committedFiles: [],
        outOfScopeFiles,
        error: `git add failed: ${(addRes.stderr || addRes.stdout).trim() || `exit ${addRes.code}`}`,
      };
    }
  }

  const cachedCheck = await runGitVerbose(opts.cwd, ['diff', '--cached', '--quiet']);
  if (cachedCheck.code === 0) {
    return {
      committed: false,
      committedFiles: [],
      skippedReason: 'no_eligible_files',
      outOfScopeFiles,
    };
  }

  const commitRes = await commitWithAuthorFallback(opts.cwd, [
    '-m',
    `chore(swarm): snapshot worker ${opts.memberName} edits`,
  ]);
  if (commitRes.code !== 0) {
    return {
      committed: false,
      committedFiles: [],
      outOfScopeFiles,
      error: `git commit failed: ${(commitRes.stderr || commitRes.stdout).trim() || `exit ${commitRes.code}`}`,
    };
  }

  const shaRes = await runGitVerbose(opts.cwd, ['rev-parse', 'HEAD']);
  const commitSha = shaRes.code === 0 ? shaRes.stdout.trim() : undefined;
  return {
    committed: true,
    commitSha,
    committedFiles: eligibleDirty,
    outOfScopeFiles,
  };
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
  const targetBranch = validateGitRefName(opts.targetBranch?.trim() || currentBranch);
  const workerBranch = validateGitRefName(opts.branch);

  const unavailable = (reason: string): MergePreviewResult => ({
    workerName: opts.workerName,
    branch: workerBranch,
    targetBranch,
    mergeBase: '',
    aheadCommits: 0,
    changedFiles: [],
    dirtyFiles: [],
    canCleanMerge: false,
    conflictFiles: [],
    conflictDetails: [reason],
    stat: '',
  });

  for (const [kind, ref] of [['target', targetBranch], ['worker', workerBranch]]) {
    const result = await runGitVerbose(opts.repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (result.code !== 0) return unavailable(`Unknown or invalid ${kind} branch "${ref}".`);
  }

  const baseRes = await runGitVerbose(opts.repoRoot, ['merge-base', targetBranch, workerBranch]);
  if (baseRes.code !== 0 || !baseRes.stdout) {
    return unavailable(`Could not find a merge base between "${targetBranch}" and "${workerBranch}".`);
  }
  const mergeBase = baseRes.stdout;

  const aheadRes = await runGitVerbose(opts.repoRoot, [
    'rev-list',
    '--count',
    `${targetBranch}..${workerBranch}`,
  ]);
  if (aheadRes.code !== 0) return unavailable(`Could not count commits on "${workerBranch}".`);
  const aheadCommits = Number(aheadRes.stdout) || 0;

  const committedFilesRes = await runGitVerbose(opts.repoRoot, [
    '-c',
    'core.quotepath=false',
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    mergeBase,
    workerBranch,
    '--',
  ]);
  if (committedFilesRes.code !== 0) {
    return unavailable(`Could not inspect committed changes on "${workerBranch}".`);
  }
  const committedFiles = committedFilesRes.stdout.split('\0').filter(Boolean);

  const dirtyFiles = await getDirtyFiles(opts.workerCwd);
  if (!dirtyFiles) return unavailable(`Could not inspect uncommitted changes in "${opts.workerCwd}".`);
  const changedFiles = [...new Set([...committedFiles, ...dirtyFiles])];

  const statRes = await runGitVerbose(opts.repoRoot, ['diff', '--stat', `${mergeBase}..${workerBranch}`]);
  const stat = statRes.code === 0 ? statRes.stdout : '';

  if (aheadCommits === 0 && dirtyFiles.length === 0) {
    return {
      workerName: opts.workerName,
      branch: workerBranch,
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
    const mt = await runGitVerbose(opts.repoRoot, ['merge-tree', '--write-tree', targetBranch, workerBranch]);
    if (mt.code !== 0) {
      const combined = `${mt.stdout}\n${mt.stderr}`;
      if (/unknown option|usage: git merge-tree/i.test(combined) && mergeBase) {
        // Legacy Git (< 2.38) fallback: 3-way merge-tree
        const legacy = await runGitVerbose(opts.repoRoot, [
          'merge-tree',
          mergeBase,
          targetBranch,
          workerBranch,
        ]);
        const legacyOut = `${legacy.stdout}\n${legacy.stderr}`;
        if (legacy.code !== 0) return unavailable(legacyOut.trim() || 'Legacy merge preview failed.');
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

  if (dirtyFiles.length > 0) {
    const targetChangedRes = await runGitVerbose(opts.repoRoot, [
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      mergeBase,
      targetBranch,
      '--',
    ]);
    if (targetChangedRes.code !== 0) {
      return unavailable(`Could not inspect changes to the target branch "${targetBranch}".`);
    }
    const targetChanged = new Set(targetChangedRes.stdout.split('\0').filter(Boolean));
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
    branch: workerBranch,
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
  allowedFiles?: string[];
}): Promise<MergeApplyResult> {
  return withRepoMergeLock(opts.repoRoot, async () => {
    const mode = opts.mode || 'squash';
    const workerBranch = validateGitRefName(opts.branch);
    const headRes = await runGitVerbose(opts.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const currentBranch = headRes.code === 0 && headRes.stdout.trim() ? headRes.stdout.trim() : 'HEAD';
    const targetBranch = validateGitRefName(opts.targetBranch?.trim() || currentBranch);

    if (
      opts.targetBranch?.trim() &&
      targetBranch !== currentBranch &&
      targetBranch !== 'HEAD'
    ) {
      return {
        merged: false,
        mode,
        workerName: opts.workerName,
        branch: workerBranch,
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
        branch: workerBranch,
        targetBranch,
        message: `Target repository (${opts.repoRoot}) has uncommitted tracked changes; commit or stash them before merging.`,
      };
    }

    const reject = (message: string, conflictFiles?: string[]): MergeApplyResult => ({
      merged: false,
      mode,
      workerName: opts.workerName,
      branch: workerBranch,
      targetBranch,
      ...(conflictFiles ? { conflictFiles } : {}),
      message,
    });
    const workerCwd = opts.workerCwd && existsSync(opts.workerCwd) ? opts.workerCwd : undefined;
    if (workerCwd) {
      const workerHead = await runGitVerbose(workerCwd, ['symbolic-ref', '--quiet', 'HEAD']);
      if (workerHead.code !== 0 || workerHead.stdout !== `refs/heads/${workerBranch}`) {
        return reject(`Worker worktree "${workerCwd}" must have "${workerBranch}" checked out before merging.`);
      }
    }

    const previewMerge = () => previewWorktreeMerge({
      repoRoot: opts.repoRoot,
      workerName: opts.workerName,
      branch: workerBranch,
      workerCwd,
      targetBranch,
    });
    const checkPreview = (preview: MergePreviewResult): MergeApplyResult | undefined => {
      const outOfScope = preview.changedFiles.filter((file) => !isPathAllowed(file, opts.allowedFiles));
      if (outOfScope.length > 0) {
        const dirtyOutOfScope = outOfScope.filter((file) => preview.dirtyFiles.includes(file));
        if (dirtyOutOfScope.length > 0) {
          return reject(
            `Refusing to auto-snapshot out-of-scope dirty files outside allowed_files: ${dirtyOutOfScope.join(', ')}. Clean or commit them explicitly first.`,
            outOfScope,
          );
        }
        return reject(`Refusing to merge files outside allowed_files: ${outOfScope.join(', ')}.`, outOfScope);
      }
      if (!preview.canCleanMerge) {
        return reject(
          preview.conflictDetails[0] ||
            `Merge conflicts detected in ${preview.conflictFiles.join(', ') || 'worktree'}.`,
          preview.conflictFiles,
        );
      }
    };

    let preview = await previewMerge();
    const preflightError = checkPreview(preview);
    if (preflightError) return preflightError;

    if (workerCwd && preview.dirtyFiles.length > 0) {
      const addRes = await runGitVerbose(workerCwd, ['add', '-A']);
      if (addRes.code !== 0) {
        return reject(`Failed to stage uncommitted worktree files in ${workerCwd}: ${addRes.stderr}`);
      }
      const commitSnap = await commitWithAuthorFallback(workerCwd, [
        '-m',
        `chore(swarm): snapshot ${opts.workerName} worktree changes`,
      ]);
      if (commitSnap.code !== 0) {
        return reject(`Failed to commit worktree snapshot: ${commitSnap.stderr || commitSnap.stdout}`);
      }
      preview = await previewMerge();
      const snapshotError = checkPreview(preview);
      if (snapshotError) return snapshotError;
    }

    if (preview.aheadCommits === 0) {
      let worktreeRemoved = false;
      if (opts.removeWorktreeAfter && opts.workerCwd) {
        const rm = await removeWorktree(opts.repoRoot, opts.workerCwd, workerBranch, opts.workerName);
        worktreeRemoved = rm.removedWorktree;
      }
      return {
        merged: true,
        mode,
        workerName: opts.workerName,
        branch: workerBranch,
        targetBranch,
        message: 'Already up to date (no commits ahead of target branch).',
        worktreeRemoved,
      };
    }

    const commitMsg =
      opts.commitMessage?.trim() || `feat(swarm): merge ${opts.workerName} (${workerBranch})`;

    if (mode === 'squash') {
      const mergeRes = await runGitVerbose(opts.repoRoot, ['merge', '--squash', workerBranch]);
      if (mergeRes.code !== 0) {
        const parsed = parseConflictOutput(`${mergeRes.stdout}\n${mergeRes.stderr}`);
        await runGitVerbose(opts.repoRoot, ['reset', '--merge']);
        return {
          merged: false,
          mode,
          workerName: opts.workerName,
          branch: workerBranch,
          targetBranch,
          conflictFiles: parsed.conflictFiles,
          message: parsed.conflictDetails[0] || mergeRes.stderr || 'Squash merge failed cleanly.',
        };
      }
      const stagedRes = await runGitVerbose(opts.repoRoot, ['diff', '--cached', '--name-only']);
      if (stagedRes.code !== 0 || !stagedRes.stdout.trim()) {
        await runGitVerbose(opts.repoRoot, ['reset', '--merge']);
        return {
          merged: false,
          mode,
          workerName: opts.workerName,
          branch: workerBranch,
          targetBranch,
          message:
            'Squash merge produced an empty staged diff despite ahead commits; aborted without removing worktree.',
        };
      }
      const commitRes = await commitWithAuthorFallback(opts.repoRoot, ['-m', commitMsg]);
      if (commitRes.code !== 0) {
        await runGitVerbose(opts.repoRoot, ['reset', '--merge']);
        return {
          merged: false,
          mode,
          workerName: opts.workerName,
          branch: workerBranch,
          targetBranch,
          message: `Squash commit failed: ${commitRes.stderr || commitRes.stdout}`,
        };
      }
    } else if (mode === 'merge') {
      let mergeRes = await runGitVerbose(opts.repoRoot, ['merge', '--no-ff', '-m', commitMsg, workerBranch]);
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
          workerBranch,
        ]);
      }
      if (mergeRes.code !== 0) {
        const parsed = parseConflictOutput(`${mergeRes.stdout}\n${mergeRes.stderr}`);
        await runGitVerbose(opts.repoRoot, ['merge', '--abort']);
        return {
          merged: false,
          mode,
          workerName: opts.workerName,
          branch: workerBranch,
          targetBranch,
          conflictFiles: parsed.conflictFiles,
          message: parsed.conflictDetails[0] || mergeRes.stderr || 'Merge failed cleanly.',
        };
      }
    } else {
      const revRes = await runGitVerbose(opts.repoRoot, [
        'rev-list',
        '--reverse',
        `${targetBranch}..${workerBranch}`,
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
            branch: workerBranch,
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
      const rm = await removeWorktree(opts.repoRoot, opts.workerCwd, workerBranch, opts.workerName);
      worktreeRemoved = rm.removedWorktree;
    }

    return {
      merged: true,
      mode,
      workerName: opts.workerName,
      branch: workerBranch,
      targetBranch,
      commitSha,
      message: `Merged ${workerBranch} into ${targetBranch} using ${mode}${commitSha ? ` (${commitSha.slice(0, 7)})` : ''}.`,
      worktreeRemoved,
    };
  });
}

export async function removeWorktree(
  repoRoot: string | undefined,
  worktreePath: string,
  branch?: string,
  workerName?: string,
): Promise<{ removedWorktree: boolean; removedBranch: boolean }> {
  let removedWorktree = false;
  let removedBranch = false;

  await runWorktreeTeardown(repoRoot, worktreePath, workerName);

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
        await runGit(repoRoot, ['worktree', 'prune', '--expire', 'now']);
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
