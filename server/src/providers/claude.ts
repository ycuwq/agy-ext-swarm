import {
  safeParseJsonLine,
  summarizeToolCall,
  toNonNegFinite,
  type CliProviderAdapter,
  type ParsedProviderEvent,
} from './shared.js';

// Claude Code CLI adapter
export const claudeAdapter: CliProviderAdapter = {
  id: 'claude',
  displayName: 'Claude Code CLI',
  kind: 'builtin',
  command: process.env.CLAUDE_BIN || 'claude',
  supportsSessionResume: true,
  supportsStreamEvents: true,
  defaultModel: 'default',
  notes: 'Uses `claude -p --output-format stream-json --verbose` and `--resume <sessionId>`.',
  buildInvocation(ctx) {
    const args: string[] = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (ctx.model && ctx.model !== 'default') {
      args.push('--model', ctx.model);
    }
    if (ctx.sessionId) {
      args.push('--resume', ctx.sessionId);
    }
    if (ctx.permissionMode === 'read-only') {
      args.push('--permission-mode', 'plan');
    } else if (ctx.permissionMode === 'workspace-write') {
      args.push('--permission-mode', 'acceptEdits');
      if (ctx.gitCommonDir) args.push('--add-dir', ctx.gitCommonDir);
      args.push('--add-dir', ctx.swarmDir);
    } else {
      args.push('--dangerously-skip-permissions');
    }
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
    if (typeof ev.session_id === 'string' && ev.session_id.trim()) {
      out.push({ type: 'session', sessionId: ev.session_id.trim() });
    }
    if (ev.type === 'system' && ev.subtype === 'init') {
      out.push({ type: 'turn_start' });
    } else if (ev.type === 'assistant' && ev.message && typeof ev.message === 'object') {
      out.push({ type: 'step_start' });
      const msg = ev.message as Record<string, unknown>;
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          if (b.type === 'tool_use') {
            out.push({ type: 'tool_call', summary: summarizeToolCall(b.name, b.input) });
          } else if (b.type === 'text' && typeof b.text === 'string') {
            out.push({ type: 'text', text: b.text });
          }
        }
      }
    } else if (ev.type === 'error') {
      const errObj =
        ev.error && typeof ev.error === 'object' ? (ev.error as Record<string, unknown>) : undefined;
      const msg =
        typeof ev.message === 'string'
          ? ev.message
          : errObj && typeof errObj.message === 'string'
            ? errObj.message
            : JSON.stringify(ev);
      out.push({ type: 'error', message: msg });
      out.push({ type: 'final', reasonKind: 'error', errorText: msg });
    } else if (ev.type === 'result') {
      const rawCost =
        typeof ev.total_cost_usd === 'number'
          ? ev.total_cost_usd
          : typeof ev.total_cost_usd === 'string' && ev.total_cost_usd.trim() !== ''
            ? Number(ev.total_cost_usd)
            : Number.NaN;
      const costUsd = Number.isFinite(rawCost) && rawCost >= 0 ? rawCost : undefined;
      if (ev.usage && typeof ev.usage === 'object') {
        const u = ev.usage as Record<string, unknown>;
        const cacheCreationTokens = toNonNegFinite(u.cache_creation_input_tokens);
        const inputTokens = toNonNegFinite(u.input_tokens) + cacheCreationTokens;
        const cacheReadTokens = toNonNegFinite(u.cache_read_input_tokens);
        const outputTokens = toNonNegFinite(u.output_tokens);
        out.push({
          type: 'usage',
          inputTokens,
          cacheReadTokens,
          outputTokens,
          totalTokens: inputTokens + cacheReadTokens + outputTokens,
          ...(costUsd !== undefined ? { costUsd } : {}),
        });
      } else if (costUsd !== undefined) {
        out.push({
          type: 'usage',
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          costUsd,
        });
      }
      const errorsText = Array.isArray(ev.errors)
        ? ev.errors
            .map((e) =>
              typeof e === 'string'
                ? e
                : e && typeof e === 'object' && typeof (e as Record<string, unknown>).message === 'string'
                  ? String((e as Record<string, unknown>).message)
                  : JSON.stringify(e),
            )
            .filter(Boolean)
            .join('; ')
        : undefined;
      const isError = Boolean(ev.is_error);
      const errText = isError
        ? (typeof ev.result === 'string' && ev.result.trim() ? ev.result : errorsText) ||
          'Claude turn failed'
        : undefined;
      out.push({
        type: 'final',
        text: !isError && typeof ev.result === 'string' ? ev.result : undefined,
        reasonKind: isError ? 'error' : 'completed',
        ...(errText ? { errorText: errText } : {}),
      });
    }
    return out;
  },
};
