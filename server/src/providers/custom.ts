import type { CustomProviderConfig } from '../types.js';
import {
  expandTemplateArgs,
  summarizeToolCall,
  type CliProviderAdapter,
  type ParsedProviderEvent,
} from './shared.js';

export function createCustomAdapter(id: string, config: CustomProviderConfig): CliProviderAdapter {
  const promptMode = config.promptMode || 'stdin';
  const outputFormat = config.outputFormat || 'text';
  return {
    id,
    displayName: config.displayName || id,
    kind: 'custom',
    command: config.command,
    supportsSessionResume: Boolean(config.resumeArgs && config.resumeArgs.length > 0),
    supportsStreamEvents: outputFormat === 'ndjson',
    defaultModel: config.defaultModel || 'custom',
    notes: `Custom CLI (${outputFormat}, prompt via ${promptMode})`,
    buildInvocation(ctx) {
      const template =
        ctx.sessionId && config.resumeArgs && config.resumeArgs.length > 0
          ? config.resumeArgs
          : config.args || [];
      const { args, usedPromptVar } = expandTemplateArgs(template, ctx);
      let stdinText: string | undefined;
      if (promptMode === 'stdin') {
        stdinText = ctx.prompt;
      } else if (!usedPromptVar) {
        args.push(ctx.prompt);
      }
      return {
        command: config.command,
        args,
        stdinText,
        env: config.env,
      };
    },
    parseStdoutLine(line) {
      if (outputFormat !== 'ndjson') return [];
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return [];
      }
      const out: ParsedProviderEvent[] = [];
      const sid = ev.sessionId ?? ev.session_id ?? ev.thread_id;
      if (typeof sid === 'string' && sid) {
        out.push({ type: 'session', sessionId: sid });
      }
      if (ev.type === 'turn_start' || ev.phase === 'turn_start') {
        out.push({ type: 'turn_start' });
      }
      if (ev.type === 'tool_call' || ev.type === 'tool_use') {
        out.push({
          type: 'tool_call',
          summary: summarizeToolCall(ev.tool || ev.tool_name || ev.name, ev.input),
        });
      }
      if (typeof ev.text === 'string' && ev.type !== 'final') {
        out.push({ type: 'text', text: ev.text });
      }
      const usageObj = (ev.usage || ev.stats) as Record<string, unknown> | undefined;
      if (usageObj && typeof usageObj === 'object') {
        const inputTokens = Number(usageObj.inputTokens ?? usageObj.input_tokens ?? 0);
        const cacheReadTokens = Number(
          usageObj.cacheReadTokens ?? usageObj.cache_read_input_tokens ?? usageObj.cached_input_tokens ?? 0,
        );
        const outputTokens = Number(usageObj.outputTokens ?? usageObj.output_tokens ?? 0);
        const totalTokens = Number(
          usageObj.totalTokens ?? usageObj.total_tokens ?? inputTokens + cacheReadTokens + outputTokens,
        );
        if (totalTokens > 0) {
          out.push({ type: 'usage', inputTokens, cacheReadTokens, outputTokens, totalTokens });
        }
      }
      if (ev.type === 'final' || ev.type === 'result') {
        const finalTxt =
          typeof ev.text === 'string'
            ? ev.text
            : typeof ev.result === 'string'
              ? ev.result
              : typeof ev.message === 'string'
                ? ev.message
                : undefined;
        out.push({ type: 'final', text: finalTxt, reasonKind: 'completed' });
      }
      return out;
    },
    finalizeOutput(stdoutAll, accumulatedText) {
      if (outputFormat === 'ndjson') {
        return { finalText: accumulatedText.trim() };
      }
      return { finalText: stdoutAll.trim() };
    },
  };
}
