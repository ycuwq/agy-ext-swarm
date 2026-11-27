import { sanitizeReasoningEffort } from '../../shared/model-options.js';
import {
  safeParseJsonLine,
  summarizeToolCall,
  toNonNegFinite,
  type CliProviderAdapter,
  type ParsedProviderEvent,
} from './shared.js';

// OpenAI Codex CLI adapter
export const codexAdapter: CliProviderAdapter = {
  id: 'codex',
  displayName: 'OpenAI Codex CLI',
  kind: 'builtin',
  command: process.env.CODEX_BIN || 'codex',
  supportsSessionResume: true,
  supportsStreamEvents: true,
  defaultModel: 'default',
  notes: 'Uses `codex exec --json` and `codex exec resume <threadId> --json`.',
  buildInvocation(ctx) {
    const sandboxArgs = ['--sandbox', ctx.permissionMode];
    if (ctx.permissionMode === 'workspace-write') {
      if (ctx.gitCommonDir) sandboxArgs.push('--add-dir', ctx.gitCommonDir);
      sandboxArgs.push('--add-dir', ctx.swarmDir);
    }
    const args = ctx.sessionId
      ? ['exec', ...sandboxArgs, 'resume', ctx.sessionId, '--json']
      : ['exec', '--json', ...sandboxArgs];
    if (ctx.model && ctx.model !== 'default') {
      args.push('-m', ctx.model);
    }
    const effort = sanitizeReasoningEffort(ctx.reasoningEffort);
    if (effort) {
      args.push('-c', `model_reasoning_effort=${JSON.stringify(effort)}`);
    }
    if (ctx.fastMode === true) {
      args.push('-c', 'service_tier="priority"');
    } else if (ctx.fastMode === false) {
      args.push('-c', 'service_tier="default"');
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
    if (ev.type === 'thread.started' && typeof ev.thread_id === 'string' && ev.thread_id.trim()) {
      out.push({ type: 'session', sessionId: ev.thread_id.trim() });
    } else if (ev.type === 'turn.started') {
      out.push({ type: 'turn_start' });
    } else if (ev.type === 'item.started' && ev.item && typeof ev.item === 'object') {
      const item = ev.item as Record<string, unknown>;
      if (item.type === 'command_execution') {
        out.push({ type: 'step_start' });
        out.push({
          type: 'tool_call',
          summary: summarizeToolCall('shell', { command: item.command }),
        });
      }
    } else if (ev.type === 'item.completed' && ev.item && typeof ev.item === 'object') {
      const item = ev.item as Record<string, unknown>;
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        out.push({ type: 'text', text: item.text });
      }
    } else if (ev.type === 'turn.completed') {
      if (ev.usage && typeof ev.usage === 'object') {
        const u = ev.usage as Record<string, unknown>;
        const rawInput = toNonNegFinite(u.input_tokens);
        const cacheReadTokens = toNonNegFinite(u.cached_input_tokens);
        const inputTokens = Math.max(0, rawInput - cacheReadTokens);
        const outputTokens = toNonNegFinite(u.output_tokens);
        out.push({
          type: 'usage',
          inputTokens,
          cacheReadTokens,
          outputTokens,
          totalTokens: inputTokens + cacheReadTokens + outputTokens,
        });
      }
      out.push({ type: 'final', reasonKind: 'completed' });
    } else if (ev.type === 'error' || ev.type === 'turn.failed') {
      const errObj =
        ev.error && typeof ev.error === 'object' ? (ev.error as Record<string, unknown>) : undefined;
      const msg =
        typeof ev.message === 'string'
          ? ev.message
          : errObj && typeof errObj.message === 'string'
            ? errObj.message
            : JSON.stringify(ev);
      out.push({ type: 'error', message: msg });
      if (ev.type === 'turn.failed') {
        out.push({ type: 'final', reasonKind: 'error', errorText: msg });
      }
    }
    return out;
  },
};
