import { accessSync, constants as fsConstants } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import type { PermissionMode } from '../types.js';
import { buildAugmentedEnv } from '../worktree.js';

export interface ProviderRunContext {
  prompt: string;
  workerName: string;
  cwd: string;
  model: string;
  modelProvider?: string;
  permissionMode: PermissionMode;
  sessionId?: string;
  profile: string;
  swarmDir: string;
  patchesDir: string;
  gitCommonDir?: string;
  boardCli: string;
}

export type ParsedProviderEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'turn_start' }
  | { type: 'step_start' }
  | {
      type: 'usage';
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      totalTokens: number;
    }
  | { type: 'tool_call'; summary: string }
  | { type: 'text'; text: string }
  | {
      type: 'final';
      text?: string;
      sessionId?: string;
      reasonKind?: string;
      errorText?: string;
    }
  | { type: 'error'; message: string };

export interface CliProviderAdapter {
  id: string;
  displayName: string;
  kind: 'builtin' | 'custom';
  command: string;
  supportsSessionResume: boolean;
  supportsStreamEvents: boolean;
  defaultModel?: string;
  notes?: string;
  buildInvocation(ctx: ProviderRunContext): {
    command: string;
    args: string[];
    stdinText?: string;
    env?: Record<string, string>;
  };
  parseStdoutLine(line: string): ParsedProviderEvent[];
  finalizeOutput?(
    stdoutAll: string,
    accumulatedText: string,
  ): {
    finalText: string;
    sessionId?: string;
    reasonKind?: string;
    errorText?: string;
  };
}

export function summarizeToolCall(tool: unknown, input: unknown): string {
  const name = typeof tool === 'string' ? tool : 'tool';
  if (input && typeof input === 'object') {
    const rec = input as Record<string, unknown>;
    if (typeof rec.command === 'string') {
      const cmd = rec.command.replace(/\s+/g, ' ').trim();
      return `${name}: ${cmd.slice(0, 60)}${cmd.length > 60 ? '...' : ''}`;
    }
    if (typeof rec.path === 'string') {
      return `${name}: ${rec.path}`;
    }
    if (typeof rec.file_path === 'string') {
      return `${name}: ${rec.file_path}`;
    }
    if (typeof rec.pattern === 'string') {
      return `${name}: ${rec.pattern}`;
    }
    if (typeof rec.description === 'string') {
      return `${name}: ${rec.description.slice(0, 60)}`;
    }
  }
  return name;
}

function checkExecCandidate(filePath: string): string | null {
  const mode = process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;
  const candidates = [filePath];
  if (process.platform === 'win32' && !extname(filePath)) {
    const pathext = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const ext of pathext) {
      candidates.push(`${filePath}${ext}`);
      candidates.push(`${filePath}${ext.toLowerCase()}`);
    }
  }
  for (const candidate of candidates) {
    try {
      accessSync(candidate, mode);
      return candidate;
    } catch {
      // Try next candidate
    }
  }
  return null;
}

export function resolveExecutable(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  if (isAbsolute(trimmed) || trimmed.includes('/') || trimmed.includes('\\')) {
    return checkExecCandidate(trimmed);
  }
  const env = buildAugmentedEnv();
  const envPath = env.PATH || '';
  for (const dir of envPath.split(delimiter).filter(Boolean)) {
    const found = checkExecCandidate(join(dir, trimmed));
    if (found) return found;
  }
  return null;
}

export function expandTemplateArgs(
  templateArgs: string[],
  ctx: ProviderRunContext,
): { args: string[]; usedPromptVar: boolean } {
  let usedPromptVar = false;
  const vars: Record<string, string> = {
    '{{prompt}}': ctx.prompt,
    '{{model}}': ctx.model,
    '{{cwd}}': ctx.cwd,
    '{{sessionId}}': ctx.sessionId || '',
    '{{permissionMode}}': ctx.permissionMode,
    '{{workerName}}': ctx.workerName,
    '{{swarmDir}}': ctx.swarmDir,
    '{{gitCommonDir}}': ctx.gitCommonDir || '',
    '{{boardCli}}': ctx.boardCli,
  };

  const out: string[] = [];
  for (const raw of templateArgs) {
    if (raw.includes('{{prompt}}')) usedPromptVar = true;
    let expanded = raw;
    for (const [k, v] of Object.entries(vars)) {
      if (expanded.includes(k)) {
        expanded = expanded.split(k).join(v);
      }
    }
    out.push(expanded);
  }
  return { args: out, usedPromptVar };
}
