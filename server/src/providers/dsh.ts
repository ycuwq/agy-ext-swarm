import { join } from 'node:path';
import { listDshModels, writeModelPatch } from '../models.js';
import {
  safeParseJsonLine,
  summarizeToolCall,
  type CliProviderAdapter,
  type ParsedProviderEvent,
} from './shared.js';

// DeepSeek Harness (dsh) built-in adapter
export const dshAdapter: CliProviderAdapter = {
  id: 'dsh',
  displayName: 'DeepSeek Harness (dsh)',
  kind: 'builtin',
  command: process.env.DSH_BIN || 'dsh',
  supportsSessionResume: true,
  supportsStreamEvents: true,
  notes: 'Native headless profile with --session-id resume, --patch model selection, and worktree sandbox.',
  buildInvocation(ctx) {
    const args: string[] = [
      '--profile',
      ctx.profile,
      '--json',
      '--permission-mode',
      ctx.permissionMode,
      '--approval-policy',
      'never',
    ];
    if (ctx.sessionId) {
      args.push('--session-id', ctx.sessionId);
    }
    const catalog = listDshModels(ctx.profile);
    const requestedModel = ctx.model?.trim();
    const overrideProvider = ctx.modelProvider?.trim();
    const providerChanged = Boolean(overrideProvider && overrideProvider !== catalog.defaultProvider);
    if (
      requestedModel &&
      requestedModel !== 'default' &&
      (requestedModel !== catalog.defaultModel || providerChanged)
    ) {
      const patchPath = join(ctx.patchesDir, `${ctx.workerName}.yml`);
      const patchProvider = overrideProvider || catalog.defaultProvider || undefined;
      writeModelPatch(patchPath, patchProvider, requestedModel);
      args.push('--patch', patchPath);
    }
    if (ctx.permissionMode === 'workspace-write') {
      if (ctx.gitCommonDir) {
        args.push('--add-dir', ctx.gitCommonDir);
      }
      args.push('--add-dir', ctx.swarmDir);
    }
    args.push('-');
    return {
      command: this.command,
      args,
      stdinText: ctx.prompt,
    };
  },
  parseStdoutLine(line) {
    const ev = safeParseJsonLine(line);
    if (!ev) return [];
    const out: ParsedProviderEvent[] = [];
    const evType = ev.type;
    if (evType === 'session' && typeof ev.sessionId === 'string') {
      out.push({ type: 'session', sessionId: ev.sessionId });
    } else if (evType === 'status') {
      const phase = ev.phase;
      if (phase === 'turn_start') {
        out.push({ type: 'turn_start' });
      } else if (phase === 'step_start') {
        out.push({ type: 'step_start' });
      } else if (phase === 'step_end' && ev.usage && typeof ev.usage === 'object') {
        const u = ev.usage as Record<string, unknown>;
        out.push({
          type: 'usage',
          inputTokens: Number(u.inputTokens || 0),
          outputTokens: Number(u.outputTokens || 0),
          cacheReadTokens: Number(u.cacheReadTokens || 0),
          totalTokens: Number(u.totalTokens || 0),
        });
      } else if (phase === 'turn_end' && ev.reason && typeof ev.reason === 'object') {
        const reason = ev.reason as Record<string, unknown>;
        out.push({
          type: 'final',
          reasonKind: typeof reason.kind === 'string' ? reason.kind : undefined,
          errorText: typeof reason.message === 'string' ? reason.message : undefined,
        });
      }
    } else if (evType === 'tool_call') {
      out.push({ type: 'tool_call', summary: summarizeToolCall(ev.tool, ev.input) });
    } else if (evType === 'text' && typeof ev.text === 'string') {
      out.push({ type: 'text', text: ev.text });
    } else if (evType === 'final') {
      const reason =
        ev.reason && typeof ev.reason === 'object' ? (ev.reason as Record<string, unknown>) : undefined;
      out.push({
        type: 'final',
        sessionId: typeof ev.sessionId === 'string' ? ev.sessionId : undefined,
        text: typeof ev.text === 'string' ? ev.text : undefined,
        reasonKind: typeof reason?.kind === 'string' ? reason.kind : undefined,
        errorText: typeof reason?.message === 'string' ? reason.message : undefined,
      });
    } else if (evType === 'error') {
      out.push({
        type: 'error',
        message:
          typeof ev.message === 'string'
            ? ev.message
            : typeof ev.error === 'string'
              ? ev.error
              : JSON.stringify(ev),
      });
    }
    return out;
  },
};
