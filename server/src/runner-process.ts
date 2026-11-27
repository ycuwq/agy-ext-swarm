import { execFile, spawn, type ChildProcess } from 'node:child_process';
import type { VerifyCommandResult } from './types.js';
import { buildAugmentedEnv } from './worktree.js';

export function killProcessTree(
  proc: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM',
): void {
  if (process.platform === 'win32' && proc.pid) {
    execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, (err) => {
      if (err && proc.exitCode === null && proc.signalCode === null) {
        try {
          proc.kill(signal);
        } catch {
          // Best-effort fallback when taskkill is unavailable.
        }
      }
    });
    return;
  }

  if (process.platform !== 'win32' && proc.pid) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // Fallback if process group already gone
    }
  }
  try {
    proc.kill(signal);
  } catch {
    // Ignore
  }
}

function isProcessTreeAlive(proc: ChildProcess): boolean {
  if (process.platform !== 'win32' && proc.pid) {
    try {
      process.kill(-proc.pid, 0);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return true;
    }
  }
  return Boolean(proc.pid && proc.exitCode === null && proc.signalCode === null);
}

async function waitForProcessTreeExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessTreeAlive(proc)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, Math.min(25, remaining)));
  }
}

export async function terminateProcessTreeWithEscalation(
  proc: ChildProcess,
  escalationMs = 3000,
): Promise<void> {
  if (!isProcessTreeAlive(proc)) return;
  killProcessTree(proc, 'SIGTERM');
  await waitForProcessTreeExit(proc, escalationMs);
  // The shell may exit before its children. Check the whole process group.
  if (isProcessTreeAlive(proc)) {
    killProcessTree(proc, 'SIGKILL');
    await waitForProcessTreeExit(proc, 250);
  }
}

export async function runTimedShellCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  outputLimit: number,
  trackProcess: (child: ChildProcess) => () => void,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolveCmd) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [], {
        cwd,
        env,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (err) {
      resolveCmd({ exitCode: 1, output: err instanceof Error ? err.message : String(err) });
      return;
    }

    const untrackProcess = trackProcess(child);
    let out = '';
    let settled = false;
    let closed = false;
    let timedOut = false;
    let terminationDone = false;
    let safetyTimer: NodeJS.Timeout | undefined;
    const append = (chunk: Buffer) => {
      out = (out + chunk.toString('utf8')).slice(-outputLimit);
    };
    const finish = (code: number, extra?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (safetyTimer) clearTimeout(safetyTimer);
      untrackProcess();
      resolveCmd({
        exitCode: code,
        output: (extra ? `${out}\n${extra}` : out).trim(),
      });
    };
    const finishTimeout = () => finish(124, `Timed out after ${timeoutMs}ms`);
    const onClose = (code: number, error?: string) => {
      closed = true;
      if (!timedOut) finish(code, error);
      else if (terminationDone) finishTimeout();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateProcessTreeWithEscalation(child, 1500).then(() => {
        terminationDone = true;
        if (closed) finishTimeout();
      });
      safetyTimer = setTimeout(finishTimeout, 1800);
    }, timeoutMs);
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (err) => onClose(1, err.message));
    child.on('close', (code) => onClose(code ?? 1));
  });
}

export async function runVerifyCommands(
  activeVerifyProcs: Map<ChildProcess, { key: string }>,
  workerKey: string,
  cwd: string,
  commands: string[],
  timeoutMs = 300000,
  extraEnv?: Record<string, string | undefined>,
  isAborted?: () => boolean,
): Promise<VerifyCommandResult[]> {
  const results: VerifyCommandResult[] = [];
  const env = buildAugmentedEnv(extraEnv);
  for (const command of commands) {
    if (isAborted?.()) break;
    const start = Date.now();
    const ranAt = new Date().toISOString();
    const res = await runTimedShellCommand(command, cwd, env, timeoutMs, 64 * 1024, (child) => {
      activeVerifyProcs.set(child, { key: workerKey });
      return () => activeVerifyProcs.delete(child);
    });

    results.push({
      command,
      exitCode: res.exitCode,
      passed: res.exitCode === 0,
      durationMs: Date.now() - start,
      outputTail: res.output.slice(-1200),
      ranAt,
    });
  }
  return results;
}
