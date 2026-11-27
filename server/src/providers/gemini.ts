import {
  safeParseJsonLine,
  summarizeToolCall,
  toNonNegFinite,
  type CliProviderAdapter,
  type ParsedProviderEvent,
} from './shared.js';

// Gemini CLI adapter
export const geminiAdapter: CliProviderAdapter = {
  id: 'gemini',
  displayName: 'Gemini CLI',
  kind: 'builtin',
  command: process.env.GEMINI_BIN || 'gemini',
  supportsSessionResume: true,
  supportsStreamEvents: true,
  defaultModel: 'default',
  notes:
    'Uses `gemini -p --output-format stream-json` with optional `--resume <sessionId>`. Note: `workspace-write` currently runs with `--yolo` (same auto-approve behavior as `danger-full-access`).',
  buildInvocation(ctx) {
    const args: string[] = ['-p', '--output-format', 'stream-json'];
    if (ctx.model && ctx.model !== 'default') {
      args.push('-m', ctx.model);
    }
    if (ctx.sessionId) {
      args.push('--resume', ctx.sessionId);
    }
    if (ctx.permissionMode !== 'read-only') {
      args.push('--yolo');
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
    const sid =
      typeof ev.session_id === 'string' && ev.session_id.trim()
        ? ev.session_id.trim()
        : typeof ev.sessionId === 'string' && ev.sessionId.trim()
          ? ev.sessionId.trim()
          : undefined;
    if (sid) {
      out.push({ type: 'session', sessionId: sid });
    }
    if (ev.type === 'init') {
      out.push({ type: 'turn_start' });
      if (typeof ev.model === 'string' && ev.model.trim()) {
        out.push({ type: 'meta', model: ev.model.trim() });
      }
    } else if (ev.type === 'tool_use') {
      out.push({ type: 'step_start' });
      out.push({
        type: 'tool_call',
        summary: summarizeToolCall(ev.tool_name || ev.tool, ev.parameters || ev.input),
      });
    } else if (ev.type === 'message' && ev.role === 'assistant' && typeof ev.content === 'string') {
      out.push({ type: 'text', text: ev.content });
    } else if (ev.type === 'text' && typeof ev.text === 'string') {
      out.push({ type: 'text', text: ev.text });
    } else if (ev.type === 'error') {
      const errObj =
        ev.error && typeof ev.error === 'object' ? (ev.error as Record<string, unknown>) : undefined;
      const msg =
        typeof ev.message === 'string'
          ? ev.message
          : typeof ev.error === 'string'
            ? ev.error
            : errObj && typeof errObj.message === 'string'
              ? errObj.message
              : JSON.stringify(ev);
      out.push({ type: 'error', message: msg });
      out.push({ type: 'final', reasonKind: 'error', errorText: msg });
    } else if (ev.type === 'result') {
      const stats = (ev.stats || ev.usage) as Record<string, unknown> | undefined;
      if (stats && typeof stats === 'object') {
        const inputTokens = toNonNegFinite(stats.input_tokens ?? stats.inputTokens);
        const cacheReadTokens = toNonNegFinite(stats.cached ?? stats.cacheReadTokens);
        const outputTokens = toNonNegFinite(stats.output_tokens ?? stats.outputTokens);
        const parsedTotal = toNonNegFinite(stats.total_tokens ?? stats.totalTokens);
        const totalTokens = parsedTotal > 0 ? parsedTotal : inputTokens + cacheReadTokens + outputTokens;
        out.push({ type: 'usage', inputTokens, cacheReadTokens, outputTokens, totalTokens });
      }
      const isError = ev.status === 'error';
      const errObj =
        ev.error && typeof ev.error === 'object' ? (ev.error as Record<string, unknown>) : undefined;
      const rawText =
        typeof ev.response === 'string'
          ? ev.response
          : typeof ev.text === 'string'
            ? ev.text
            : undefined;
      const errText = isError
        ? typeof ev.error === 'string'
          ? ev.error
          : errObj && typeof errObj.message === 'string'
            ? errObj.message
            : typeof ev.message === 'string'
              ? ev.message
              : rawText || 'Gemini turn failed'
        : undefined;
      out.push({
        type: 'final',
        text: isError ? undefined : rawText,
        reasonKind: isError ? 'error' : 'completed',
        ...(errText ? { errorText: errText } : {}),
      });
    }
    return out;
  },
};
