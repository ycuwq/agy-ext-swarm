import {
  safeParseJsonLine,
  summarizeToolCall,
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
    if (typeof ev.session_id === 'string') {
      out.push({ type: 'session', sessionId: ev.session_id });
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
    } else if (ev.type === 'result') {
      if (ev.usage && typeof ev.usage === 'object') {
        const u = ev.usage as Record<string, unknown>;
        const inputTokens = Number(u.input_tokens || 0);
        const cacheReadTokens = Number(u.cache_read_input_tokens || 0);
        const outputTokens = Number(u.output_tokens || 0);
        out.push({
          type: 'usage',
          inputTokens,
          cacheReadTokens,
          outputTokens,
          totalTokens: inputTokens + cacheReadTokens + outputTokens,
        });
      }
      out.push({
        type: 'final',
        text: typeof ev.result === 'string' ? ev.result : undefined,
        reasonKind: ev.is_error ? 'error' : 'completed',
        errorText: ev.is_error && typeof ev.result === 'string' ? ev.result : undefined,
      });
    }
    return out;
  },
};
