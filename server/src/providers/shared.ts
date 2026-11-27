import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import type { PermissionMode } from '../types.js';
import { buildAugmentedEnv } from '../worktree.js';

export interface ProviderRunContext {
  prompt: string;
  workerName: string;
  cwd: string;
  model: string;
  modelProvider?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
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
      costUsd?: number;
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
  | { type: 'meta'; model?: string; reasoningEffort?: string; fastMode?: boolean }
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

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isValidObservedModelId(model: string): boolean {
  const trimmed = model.trim();
  return (
    trimmed.length > 0 &&
    !/^<.*>$/s.test(trimmed) &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(model) &&
    !/^(default|unknown)$/i.test(trimmed)
  );
}

export function dedupeStrings(items: Iterable<unknown>): string[] {
  const unique = new Set<string>();
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed) unique.add(trimmed);
  }
  return [...unique];
}

export function safeParseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
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
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    const pathext = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    const lowerPath = filePath.toLowerCase();
    if (!pathext.some((ext) => lowerPath.endsWith(ext.toLowerCase()))) {
      for (const ext of pathext) candidates.push(filePath + ext);
    }
  }
  candidates.push(filePath);
  for (const candidate of candidates) {
    try {
      accessSync(candidate, mode);
      if (statSync(candidate).isFile()) {
        return candidate;
      }
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

export function quoteWinCmdArg(arg: string): string {
  // Use doubled quotes so cmd keeps metacharacters inside the quoted argument.
  // As in Rust's batch launcher, an empty %cd:~,% expansion shields each literal %.
  const clean = String(arg).replace(/[\r\n\0]/g, ' ');
  const quoted = clean
    .replace(/(\\*)"/g, '$1$1""')
    .replace(/(\\+)$/, '$1$1')
    .replace(/%/g, '%%cd:~,%');
  return '"' + quoted + '"';
}

export function buildSpawnCommand(command: string, args: string[]) {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(command)) {
    return { command, args, windowsVerbatimArguments: false };
  }
  const commandLine = [command, ...args].map(quoteWinCmdArg).join(' ');
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/e:on', '/v:off', '/s', '/c', '"' + commandLine + '"'],
    windowsVerbatimArguments: true,
  };
}

export function toNonNegFinite(v: unknown): number {
  if (typeof v !== 'number' && typeof v !== 'string') return 0;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
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
    '{{reasoningEffort}}': ctx.reasoningEffort || '',
    '{{fastMode}}': ctx.fastMode === true ? 'true' : ctx.fastMode === false ? 'false' : '',
  };

  const out: string[] = [];
  for (const raw of templateArgs) {
    const optional = /^\{\{\?(model|reasoningEffort|fastMode):([^{}\s]+)\}\}$/.exec(raw);
    if (optional) {
      const [, name, flag] = optional;
      const value = vars['{{' + name + '}}'];
      if (!value || (name === 'model' && value === 'default')) continue;
      if (flag.endsWith('=')) out.push(flag + value);
      else out.push(flag, value);
      continue;
    }
    if (raw.includes('{{prompt}}')) usedPromptVar = true;
    const expanded = raw.replace(
      /\{\{(prompt|model|cwd|sessionId|permissionMode|workerName|swarmDir|gitCommonDir|boardCli|reasoningEffort|fastMode)\}\}/g,
      (token) => vars[token] ?? token,
    );
    out.push(expanded);
  }
  return { args: out, usedPromptVar };
}
