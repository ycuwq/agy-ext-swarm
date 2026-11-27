import { sanitizeReasoningEffort } from '../../shared/model-options.js';
import type { CustomProviderConfig } from '../types.js';
import {
  expandTemplateArgs,
  isValidObservedModelId,
  safeParseJsonLine,
  summarizeToolCall,
  toNonNegFinite,
  type CliProviderAdapter,
  type ParsedProviderEvent,
} from './shared.js';

export function createCustomAdapter(id: string, config: CustomProviderConfig): CliProviderAdapter {
  const promptMode = config.promptMode || 'stdin';
  const outputFormat = config.outputFormat || 'text';
  const resolvedDefaultModel = config.defaultModel?.trim() || 'default';
  return {
    id,
    displayName: config.displayName || id,
    kind: 'custom',
    command: config.command,
    supportsSessionResume: Boolean(config.resumeArgs && config.resumeArgs.length > 0),
    supportsStreamEvents: outputFormat === 'ndjson',
    defaultModel: resolvedDefaultModel,
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
      const ev = safeParseJsonLine(line);
      if (!ev) return [];
      const out: ParsedProviderEvent[] = [];
      const sid = ev.sessionId ?? ev.session_id ?? ev.thread_id;
      if (typeof sid === 'string' && sid.trim()) {
        out.push({ type: 'session', sessionId: sid.trim() });
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
      const evType = typeof ev.type === 'string' ? ev.type : '';
      if (evType === 'meta') {
        const model =
          typeof ev.model === 'string' && isValidObservedModelId(ev.model) ? ev.model.trim() : undefined;
        const reasoningEffort = sanitizeReasoningEffort(ev.reasoningEffort);
        const fastMode = typeof ev.fastMode === 'boolean' ? ev.fastMode : undefined;
        if (model || reasoningEffort || fastMode !== undefined) {
          out.push({ type: 'meta', model, reasoningEffort, fastMode });
        }
      }
      const isTerminalOrError = evType === 'final' || evType === 'result' || evType === 'error';
      if (typeof ev.text === 'string' && !isTerminalOrError) {
        out.push({ type: 'text', text: ev.text });
      }
      const usageObj = (ev.usage || ev.stats) as Record<string, unknown> | undefined;
      if (usageObj && typeof usageObj === 'object') {
        const inputTokens = toNonNegFinite(usageObj.inputTokens ?? usageObj.input_tokens);
        const cacheReadTokens = toNonNegFinite(
          usageObj.cacheReadTokens ?? usageObj.cache_read_input_tokens ?? usageObj.cached_input_tokens,
        );
        const outputTokens = toNonNegFinite(usageObj.outputTokens ?? usageObj.output_tokens);
        const parsedTotal = toNonNegFinite(usageObj.totalTokens ?? usageObj.total_tokens);
        const totalTokens =
          parsedTotal > 0 ? parsedTotal : inputTokens + cacheReadTokens + outputTokens;
        if (totalTokens > 0) {
          out.push({ type: 'usage', inputTokens, cacheReadTokens, outputTokens, totalTokens });
        }
      }
      if (evType === 'error') {
        const errObj =
          ev.error && typeof ev.error === 'object' ? (ev.error as Record<string, unknown>) : undefined;
        const msg =
          typeof ev.message === 'string'
            ? ev.message
            : typeof ev.text === 'string'
              ? ev.text
              : typeof ev.error === 'string'
                ? ev.error
                : errObj && typeof errObj.message === 'string'
                  ? errObj.message
                  : JSON.stringify(ev);
        out.push({ type: 'error', message: msg });
        out.push({ type: 'final', reasonKind: 'error', errorText: msg });
      } else if (evType === 'final' || evType === 'result') {
        const reasonObj =
          ev.reason && typeof ev.reason === 'object'
            ? (ev.reason as Record<string, unknown>)
            : undefined;
        const reasonKindRaw =
          typeof reasonObj?.kind === 'string'
            ? reasonObj.kind
            : typeof ev.status === 'string' && ev.status === 'error'
              ? 'error'
              : ev.is_error === true
                ? 'error'
                : 'completed';
        const isError = reasonKindRaw !== 'completed';
        const finalTxt =
          typeof ev.text === 'string'
            ? ev.text
            : typeof ev.result === 'string'
              ? ev.result
              : typeof ev.message === 'string'
                ? ev.message
                : undefined;
        out.push({
          type: 'final',
          text: isError ? undefined : finalTxt,
          reasonKind: reasonKindRaw,
          ...(isError ? { errorText: finalTxt || `Custom CLI error (${reasonKindRaw})` } : {}),
        });
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
