import type { ChildProcess } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { runTimedShellCommand } from './runner-process.js';
import type { WorktreeHooksConfig } from './types.js';
import { buildAugmentedEnv } from './worktree.js';

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

export const activeWorktreeHookProcs = new Set<ChildProcess>();

function runWorktreeShellCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) {
  return runTimedShellCommand(command, cwd, env, timeoutMs, 32 * 1024, (child) => {
    activeWorktreeHookProcs.add(child);
    return () => activeWorktreeHookProcs.delete(child);
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
    if (!existsSync(resolved.src) || existsSync(resolved.dst)) continue;
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
    if (!existsSync(resolved.src) || existsSync(resolved.dst)) continue;
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
    setupOk = res.exitCode === 0;
    if (!setupOk) {
      warnings.push(
        `worktree.json setupCommand failed (exit=${res.exitCode}): ${res.output.slice(-300) || config.setupCommand}`,
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
