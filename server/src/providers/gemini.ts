import {
  safeParseJsonLine,
  summarizeToolCall,
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
      typeof ev.session_id === 'string'
        ? ev.session_id
        : typeof ev.sessionId === 'string'
          ? ev.sessionId
          : undefined;
    if (sid) {
      out.push({ type: 'session', sessionId: sid });
    }
    if (ev.type === 'init') {
      out.push({ type: 'turn_start' });
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
    } else if (ev.type === 'result') {
      const stats = (ev.stats || ev.usage) as Record<string, unknown> | undefined;
      if (stats && typeof stats === 'object') {
        const inputTokens = Number(stats.input_tokens || stats.inputTokens || 0);
        const cacheReadTokens = Number(stats.cached || stats.cacheReadTokens || 0);
        const outputTokens = Number(stats.output_tokens || stats.outputTokens || 0);
        const totalTokens = Number(
          stats.total_tokens || stats.totalTokens || inputTokens + cacheReadTokens + outputTokens,
        );
        out.push({ type: 'usage', inputTokens, cacheReadTokens, outputTokens, totalTokens });
      }
      out.push({
        type: 'final',
        text: typeof ev.response === 'string' ? ev.response : typeof ev.text === 'string' ? ev.text : undefined,
        reasonKind: ev.status === 'error' ? 'error' : 'completed',
      });
    }
    return out;
  },
};
