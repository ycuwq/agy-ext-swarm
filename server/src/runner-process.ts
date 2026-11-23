import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import type { VerifyCommandResult } from './types.js';
import { buildAugmentedEnv } from './worktree.js';

export function killProcessTree(
  proc: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM',
  sync = false,
): void {
  if (process.platform === 'win32') {
    if (proc.pid) {
      try {
        if (sync) {
          execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
            timeout: 3000,
          });
        } else {
          execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {
            // Ignore best-effort tree cleanup errors
          });
        }
        return;
      } catch {
        // Fallback below
      }
    }
    try {
      proc.kill(signal);
    } catch {
      // Ignore
    }
    return;
  }

  if (proc.pid) {
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

export function terminateProcessTreeWithEscalation(
  proc: ChildProcess,
  escalationMs = 3000,
): () => void {
  killProcessTree(proc, 'SIGTERM');
  let escTimer: NodeJS.Timeout | undefined = setTimeout(() => {
    escTimer = undefined;
    if (proc.exitCode === null && proc.signalCode === null) {
      killProcessTree(proc, 'SIGKILL');
    }
  }, escalationMs);
  escTimer.unref?.();
  const clearEsc = () => {
    if (escTimer) {
      clearTimeout(escTimer);
      escTimer = undefined;
    }
    proc.off('exit', clearEsc);
    proc.off('close', clearEsc);
  };
  if (proc.exitCode !== null || proc.signalCode !== null) {
    clearEsc();
  } else {
    proc.once('exit', clearEsc);
    proc.once('close', clearEsc);
  }
  return clearEsc;
}

export async function runVerifyCommands(
  activeVerifyProcs: Map<ChildProcess, { key: string }>,
  workerKey: string,
  cwd: string,
  commands: string[],
  timeoutMs = 60000,
): Promise<VerifyCommandResult[]> {
  const results: VerifyCommandResult[] = [];
  const env = buildAugmentedEnv();
  for (const command of commands) {
    const start = Date.now();
    const ranAt = new Date().toISOString();
    const res = await new Promise<{ exitCode: number | null; output: string }>((resolveCmd) => {
      let settled = false;
      let out = '';
      let killTimer: NodeJS.Timeout | undefined;
      let cancelEscalation: (() => void) | undefined;
      let child: ChildProcess;
      const appendChunk = (buf: Buffer) => {
        out += buf.toString('utf8');
        if (out.length > 64 * 1024) {
          out = out.slice(-64 * 1024);
        }
      };
      const finish = (exitCode: number | null, extraMsg?: string) => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        cancelEscalation?.();
        activeVerifyProcs.delete(child);
        const combined = (extraMsg ? `${out}\n${extraMsg}` : out).trim();
        resolveCmd({ exitCode, output: combined });
      };

      try {
        child = spawn(command, [], {
          cwd,
          env,
          shell: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        });
      } catch (err) {
        resolveCmd({
          exitCode: 1,
          output: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      activeVerifyProcs.set(child, { key: workerKey });
      child.stdout?.on('data', appendChunk);
      child.stderr?.on('data', appendChunk);
      child.on('error', (err) => finish(1, err.message));
      child.on('close', (code) => finish(code ?? 1));

      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          cancelEscalation = terminateProcessTreeWithEscalation(child, 1500);
        }
        finish(124, `Timed out after ${timeoutMs}ms`);
      }, timeoutMs);
      killTimer.unref?.();
    });

    results.push({
      command,
      exitCode: res.exitCode ?? 1,
      passed: res.exitCode === 0,
      durationMs: Date.now() - start,
      outputTail: res.output.slice(-1200),
      ranAt,
    });
  }
  return results;
}
