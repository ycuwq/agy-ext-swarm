import {
  safeParseJsonLine,
  summarizeToolCall,
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
    const args: string[] = ctx.sessionId
      ? ['exec', 'resume', ctx.sessionId, '--json']
      : ['exec', '--json', '--sandbox', ctx.permissionMode];
    if (!ctx.sessionId && ctx.permissionMode === 'workspace-write') {
      if (ctx.gitCommonDir) args.push('--add-dir', ctx.gitCommonDir);
      args.push('--add-dir', ctx.swarmDir);
    }
    if (ctx.model && ctx.model !== 'default') {
      args.push('-m', ctx.model);
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
    if (ev.type === 'thread.started' && typeof ev.thread_id === 'string') {
      out.push({ type: 'session', sessionId: ev.thread_id });
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
        const inputTokens = Number(u.input_tokens || 0);
        const cacheReadTokens = Number(u.cached_input_tokens || 0);
        const outputTokens = Number(u.output_tokens || 0);
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
      out.push({
        type: 'error',
        message: typeof ev.message === 'string' ? ev.message : JSON.stringify(ev),
      });
    }
    return out;
  },
};
