import { execFile, spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  MergePreviewResult,
  MergeApplyResult,
  WorktreeDiffSummary,
  WorktreeHooksConfig,
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

function isSubPathInside(rootReal: string, candidatePath: string): boolean {
  const rel = relative(rootReal, candidatePath);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function resolveSafeRepoRelative(
  repoRootReal: string,
  worktreeReal: string,
  rawRelPath: string,
): { src: string; dst: string; rel: string } | null {
  const trimmed = rawRelPath.trim();
  if (!trimmed || isAbsolute(trimmed)) return null;
  const srcResolved = resolve(repoRootReal, trimmed);
  if (!isSubPathInside(repoRootReal, srcResolved)) return null;
  const dstResolved = resolve(worktreeReal, trimmed);
  if (!isSubPathInside(worktreeReal, dstResolved)) return null;
  if (existsSync(srcResolved)) {
    const srcReal = realpathSync(srcResolved);
    if (!isSubPathInside(repoRootReal, srcReal)) return null;
  }
  return { src: srcResolved, dst: dstResolved, rel: trimmed.replace(/\\/g, '/') };
}

export function loadWorktreeHooksConfig(repoRoot: string): WorktreeHooksConfig | null {
  if (!repoRoot) return null;
  const configPath = join(repoRoot, '.agy-ext-swarm', 'worktree.json');
  if (!existsSync(configPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const obj = raw as Record<string, unknown>;
    const toStringArray = (val: unknown): string[] | undefined =>
      Array.isArray(val)
        ? val.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
        : undefined;
    const copyFiles = toStringArray(obj.copyFiles);
    const symlinkDirs = toStringArray(obj.symlinkDirs);
    const setupCommand =
      typeof obj.setupCommand === 'string' && obj.setupCommand.trim()
        ? obj.setupCommand.trim()
        : undefined;
    const teardownCommand =
      typeof obj.teardownCommand === 'string' && obj.teardownCommand.trim()
        ? obj.teardownCommand.trim()
        : undefined;
    const portOffsetBase =
      typeof obj.portOffsetBase === 'number' && Number.isFinite(obj.portOffsetBase)
        ? Math.floor(obj.portOffsetBase)
        : undefined;
    const portOffsetStep =
      typeof obj.portOffsetStep === 'number' &&
      Number.isFinite(obj.portOffsetStep) &&
      obj.portOffsetStep >= 0
        ? Math.floor(obj.portOffsetStep)
        : undefined;
    return {
      ...(copyFiles ? { copyFiles } : {}),
      ...(symlinkDirs ? { symlinkDirs } : {}),
      ...(setupCommand ? { setupCommand } : {}),
      ...(teardownCommand ? { teardownCommand } : {}),
      ...(portOffsetBase !== undefined ? { portOffsetBase } : {}),
      ...(portOffsetStep !== undefined ? { portOffsetStep } : {}),
    };
  } catch {
    return null;
  }
}

async function runWorktreeShellCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ ok: boolean; code: number | null; output: string }> {
  return new Promise((resolveCmd) => {
    let settled = false;
    let out = '';
    const child = spawn(command, [], {
      cwd,
      env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    const append = (chunk: Buffer) => {
      out += chunk.toString('utf8');
      if (out.length > 32 * 1024) out = out.slice(-32 * 1024);
    };
    const finish = (code: number | null, extra?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const combined = (extra ? `${out}\n${extra}` : out).trim();
      resolveCmd({ ok: code === 0, code, output: combined });
    };
    const timer = setTimeout(() => {
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          try {
            child.kill('SIGTERM');
          } catch {
            // Ignore
          }
        }
      } else {
        try {
          child.kill('SIGTERM');
        } catch {
          // Ignore
        }
      }
      finish(124, `Timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (err) => finish(1, err.message));
    child.on('close', (code) => finish(code ?? 1));
  });
}

export interface HydrateWorktreeResult {
  copied: string[];
  symlinked: string[];
  setupRan: boolean;
  setupOk: boolean;
  warnings: string[];
}

export async function hydrateWorktree(opts: {
  repoRoot: string;
  worktreePath: string;
  workerName: string;
  workerIndex?: number;
  portOffset?: number;
  config: WorktreeHooksConfig;
}): Promise<HydrateWorktreeResult> {
  const { repoRoot, worktreePath, workerName, workerIndex, portOffset, config } = opts;
  const repoRootReal = existsSync(repoRoot) ? realpathSync(repoRoot) : resolve(repoRoot);
  const worktreeReal = existsSync(worktreePath) ? realpathSync(worktreePath) : resolve(worktreePath);
  const copied: string[] = [];
  const symlinked: string[] = [];
  const warnings: string[] = [];

  for (const relPath of config.copyFiles || []) {
    const resolved = resolveSafeRepoRelative(repoRootReal, worktreeReal, relPath);
    if (!resolved) {
      warnings.push(`worktree.json copyFiles skipped unsafe path "${relPath}".`);
      continue;
    }
    if (!existsSync(resolved.src)) continue;
    if (existsSync(resolved.dst)) continue;
    try {
      mkdirSync(dirname(resolved.dst), { recursive: true });
      cpSync(resolved.src, resolved.dst, { recursive: true });
      copied.push(resolved.rel);
    } catch (err) {
      warnings.push(
        `worktree.json copyFiles failed for "${resolved.rel}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  for (const relPath of config.symlinkDirs || []) {
    const resolved = resolveSafeRepoRelative(repoRootReal, worktreeReal, relPath);
    if (!resolved) {
      warnings.push(`worktree.json symlinkDirs skipped unsafe path "${relPath}".`);
      continue;
    }
    if (!existsSync(resolved.src)) continue;
    if (existsSync(resolved.dst)) continue;
    try {
      mkdirSync(dirname(resolved.dst), { recursive: true });
      symlinkSync(resolved.src, resolved.dst, process.platform === 'win32' ? 'junction' : 'dir');
      symlinked.push(resolved.rel);
    } catch (err) {
      warnings.push(
        `worktree.json symlinkDirs failed for "${resolved.rel}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  let setupRan = false;
  let setupOk = true;
  if (config.setupCommand) {
    setupRan = true;
    const env = buildAugmentedEnv({
      SWARM_WORKER_NAME: workerName,
      SWARM_REPO_ROOT: repoRootReal,
      ...(workerIndex !== undefined ? { SWARM_WORKER_INDEX: String(workerIndex) } : {}),
      ...(portOffset !== undefined ? { SWARM_PORT_OFFSET: String(portOffset) } : {}),
    });
    const res = await runWorktreeShellCommand(config.setupCommand, worktreeReal, env, 120_000);
    setupOk = res.ok;
    if (!res.ok) {
      warnings.push(
        `worktree.json setupCommand failed (exit=${res.code ?? '?'}): ${res.output.slice(-300) || config.setupCommand}`,
      );
    }
  }

  return { copied, symlinked, setupRan, setupOk, warnings };
}

export async function runWorktreeTeardown(
  repoRoot: string | undefined,
  worktreePath: string,
  workerName?: string,
): Promise<void> {
  if (!repoRoot || !existsSync(worktreePath)) return;
  const config = loadWorktreeHooksConfig(repoRoot);
  if (!config?.teardownCommand) return;
  try {
    const env = buildAugmentedEnv({
      SWARM_REPO_ROOT: repoRoot,
      ...(workerName ? { SWARM_WORKER_NAME: workerName } : {}),
    });
    await runWorktreeShellCommand(config.teardownCommand, worktreePath, env, 30_000);
  } catch {
    // Best-effort teardown
  }
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

    const committedFiles: string[] = [];
    if (commitCount > 0) {
      const { stdout: diffNames } = await runGit(cwd, [
        '-c',
        'core.quotepath=false',
        'diff',
        '--name-only',
        '--no-renames',
        `${ref}..HEAD`,
      ]);
      for (const line of diffNames.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) committedFiles.push(trimmed);
      }
    }

    const { stdout: statusOut } = await runGit(cwd, [
      '-c',
      'core.quotepath=false',
      'status',
      '--porcelain',
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

async function getDirtyFiles(worktreePath?: string): Promise<string[]> {
  if (!worktreePath || !existsSync(worktreePath)) return [];
  const res = await runGitVerbose(worktreePath, [
    '-c',
    'core.quotepath=false',
    'status',
    '--porcelain',
    '-uall',
  ]);
  if (res.code !== 0 || !res.stdout) return [];
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

  const verifyTargetRes = await runGitVerbose(opts.repoRoot, [
    'rev-parse',
    '--verify',
    '--quiet',
    `${targetBranch}^{commit}`,
  ]);
  if (verifyTargetRes.code !== 0) {
    return {
      workerName: opts.workerName,
      branch: workerBranch,
      targetBranch,
      mergeBase: '',
      aheadCommits: 0,
      changedFiles: [],
      dirtyFiles: [],
      canCleanMerge: false,
      conflictFiles: [],
      conflictDetails: [`Unknown or invalid target branch "${targetBranch}".`],
      stat: '',
    };
  }

  const baseRes = await runGitVerbose(opts.repoRoot, ['merge-base', targetBranch, workerBranch]);
  const mergeBase = baseRes.code === 0 ? baseRes.stdout.trim() : '';

  const aheadRes = await runGitVerbose(opts.repoRoot, [
    'rev-list',
    '--count',
    `${targetBranch}..${workerBranch}`,
  ]);
  const aheadCommits = aheadRes.code === 0 ? Number(aheadRes.stdout.trim()) || 0 : 0;

  const diffBase = mergeBase || targetBranch;
  const committedFilesRes = await runGitVerbose(opts.repoRoot, [
    '-c',
    'core.quotepath=false',
    'diff',
    '--name-only',
    '--no-renames',
    diffBase,
    workerBranch,
  ]);
  const committedFiles =
    committedFilesRes.code === 0
      ? committedFilesRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
      : [];

  const dirtyFiles = await getDirtyFiles(opts.workerCwd);
  const changedFiles = [...new Set([...committedFiles, ...dirtyFiles])];

  const statRes = await runGitVerbose(opts.repoRoot, ['diff', '--stat', `${diffBase}..${workerBranch}`]);
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
      '-c',
      'core.quotepath=false',
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

    if (opts.workerCwd && existsSync(opts.workerCwd)) {
      const dirtyBefore = await getDirtyFiles(opts.workerCwd);
      if (dirtyBefore.length > 0) {
        if (opts.allowedFiles && opts.allowedFiles.length > 0) {
          const outOfScope = dirtyBefore.filter((f) => !isPathAllowed(f, opts.allowedFiles));
          if (outOfScope.length > 0) {
            return {
              merged: false,
              mode,
              workerName: opts.workerName,
              branch: workerBranch,
              targetBranch,
              conflictFiles: outOfScope,
              message: `Refusing to auto-snapshot out-of-scope dirty files outside allowed_files: ${outOfScope.join(', ')}. Clean or commit them explicitly first.`,
            };
          }
        }
        const addRes = await runGitVerbose(opts.workerCwd, ['add', '-A']);
        if (addRes.code !== 0) {
          return {
            merged: false,
            mode,
            workerName: opts.workerName,
            branch: workerBranch,
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
            branch: workerBranch,
            targetBranch,
            message: `Failed to commit worktree snapshot: ${commitSnap.stderr || commitSnap.stdout}`,
          };
        }
      }
    }

    const preview = await previewWorktreeMerge({
      repoRoot: opts.repoRoot,
      workerName: opts.workerName,
      branch: workerBranch,
      workerCwd: opts.workerCwd,
      targetBranch,
    });

    if (opts.allowedFiles && opts.allowedFiles.length > 0) {
      const outOfScopeAll = preview.changedFiles.filter((f) => !isPathAllowed(f, opts.allowedFiles));
      if (outOfScopeAll.length > 0) {
        return {
          merged: false,
          mode,
          workerName: opts.workerName,
          branch: workerBranch,
          targetBranch,
          conflictFiles: outOfScopeAll,
          message: `Refusing to merge files outside allowed_files: ${outOfScopeAll.join(', ')}.`,
        };
      }
    }

    if (preview.aheadCommits === 0) {
      let worktreeRemoved = false;
      if (opts.removeWorktreeAfter && opts.workerCwd) {
        const rm = await removeWorktree(opts.repoRoot, opts.workerCwd, workerBranch);
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

    if (!preview.canCleanMerge) {
      return {
        merged: false,
        mode,
        workerName: opts.workerName,
        branch: workerBranch,
        targetBranch,
        conflictFiles: preview.conflictFiles,
        message:
          preview.conflictDetails[0] ||
          `Merge conflicts detected in ${preview.conflictFiles.join(', ') || 'worktree'}; working tree left untouched.`,
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
