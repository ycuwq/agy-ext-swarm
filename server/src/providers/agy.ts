import { sanitizeReasoningEffort } from '../../shared/model-options.js';
import {
  safeParseJsonLine,
  summarizeToolCall,
  toNonNegFinite,
  type CliProviderAdapter,
  type ParsedProviderEvent,
} from './shared.js';

function isPlainRecord(val: unknown): val is Record<string, unknown> {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

const AGY_TOOL_KEY_ALIASES: ReadonlyArray<[string, readonly string[]]> = [
  ['command', ['CommandLine']],
  ['path', ['AbsolutePath', 'TargetFile', 'DirectoryPath', 'SearchPath']],
  ['pattern', ['Query', 'Pattern']],
  ['description', ['Description', 'TaskName']],
];

function normalizeAgyToolInput(input: unknown): unknown {
  if (!isPlainRecord(input)) return input;
  const out: Record<string, unknown> = { ...input };
  for (const [canonical, aliases] of AGY_TOOL_KEY_ALIASES) {
    if (typeof out[canonical] === 'string' && out[canonical]) continue;
    for (const alias of aliases) {
      if (typeof input[alias] === 'string' && input[alias]) {
        out[canonical] = input[alias];
        break;
      }
    }
  }
  return out;
}

function extractConversationId(ev: Record<string, unknown>): string | undefined {
  for (const candidate of [ev, ev.step_update, ev.result]) {
    if (!isPlainRecord(candidate)) continue;
    if (typeof candidate.conversation_id === 'string' && candidate.conversation_id.trim()) {
      return candidate.conversation_id.trim();
    }
  }
  return undefined;
}

const AGY_LABEL_EFFORT_TITLES: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
};

/** Built-in Antigravity CLI (`agy`) adapter using bidirectional NDJSON stream-json. */
export const agyAdapter: CliProviderAdapter = {
  id: 'agy',
  displayName: 'Antigravity CLI',
  kind: 'builtin',
  command: process.env.AGY_BIN || 'agy',
  supportsSessionResume: true,
  supportsStreamEvents: true,
  defaultModel: 'default',
  notes:
    'Uses `agy --input-format stream-json --output-format stream-json` with optional `--conversation <sessionId>` and `--effort <level>`.',
  buildInvocation(ctx) {
    const args: string[] = ['--input-format', 'stream-json', '--output-format', 'stream-json'];
    const effort = sanitizeReasoningEffort(ctx.reasoningEffort);
    let modelArg = ctx.model && ctx.model !== 'default' ? ctx.model.trim() : '';
    let emitEffortFlag = Boolean(effort);
    if (modelArg) {
      const labelMatch = /^(.+?)\s*\((low|medium|high|xhigh|max)\)$/i.exec(modelArg);
      if (labelMatch) {
        // agy display-label models encode thinking level in the parenthesized suffix and reject --effort.
        if (effort && AGY_LABEL_EFFORT_TITLES[effort]) {
          modelArg = `${labelMatch[1].trim()} (${AGY_LABEL_EFFORT_TITLES[effort]})`;
        }
        emitEffortFlag = false;
      } else if (effort) {
        // Variant slugs (e.g. gemini-3.8-flash-high) conflict with a differing --effort flag in agy.
        const suffixMatch = /^(.+)-(low|medium|high|xhigh|max)$/i.exec(modelArg);
        if (suffixMatch && suffixMatch[2].toLowerCase() !== effort) {
          modelArg = suffixMatch[1];
        }
      }
      args.push('--model', modelArg);
    }
    if (emitEffortFlag && effort) {
      args.push('--effort', effort);
    }
    if (ctx.sessionId) {
      args.push('--conversation', ctx.sessionId);
    }
    if (ctx.permissionMode === 'read-only') {
      args.push('--mode', 'plan');
    } else if (ctx.permissionMode === 'workspace-write') {
      args.push(
        '--mode',
        'accept-edits',
        '--sandbox',
        '--settings',
        JSON.stringify({ toolPermission: 'proceed-in-sandbox' }),
      );
      if (ctx.gitCommonDir) args.push('--add-dir', ctx.gitCommonDir);
      args.push('--add-dir', ctx.swarmDir);
    } else {
      args.push('--dangerously-skip-permissions');
    }
    return {
      command: this.command,
      args,
      stdinText: JSON.stringify({ event: 'user', message: { content: ctx.prompt } }) + '\n',
    };
  },
  parseStdoutLine(line) {
    const ev = safeParseJsonLine(line);
    if (!ev) return [];
    const out: ParsedProviderEvent[] = [];

    const cid = extractConversationId(ev);
    if (cid) {
      out.push({ type: 'session', sessionId: cid });
    }

    if (ev.event === 'init') {
      out.push({ type: 'turn_start' });
      return out;
    }

    if (ev.event === 'step_update' && isPlainRecord(ev.step_update)) {
      const su = ev.step_update;
      const stepType = typeof su.step_type === 'string' ? su.step_type : '';
      const state = typeof su.state === 'string' ? su.state.toUpperCase() : '';

      if (stepType === 'agent_response') {
        if (typeof su.text_delta === 'string' && su.text_delta) {
          out.push({ type: 'text', text: su.text_delta });
        }
        if (state === 'DONE') {
          out.push({ type: 'step_start' });
        }
      } else if (stepType === 'tool') {
        const toolInfo = isPlainRecord(su.tool_info) ? su.tool_info : undefined;
        const toolName =
          (typeof su.tool_name === 'string' && su.tool_name) ||
          (toolInfo && typeof toolInfo.name === 'string' ? toolInfo.name : 'tool');
        const rawParams = toolInfo?.parameters ?? toolInfo?.input;
        const summary = summarizeToolCall(toolName, normalizeAgyToolInput(rawParams));
        if (state === 'ACTIVE') {
          out.push({ type: 'tool_call', summary });
        } else if (state === 'DONE' || state === 'ERROR') {
          out.push({ type: 'step_start' });
          out.push({ type: 'tool_call', summary });
        }
      } else if (isPlainRecord(su.subagent_info) && state === 'ACTIVE') {
        const subs = su.subagent_info.subagents;
        if (Array.isArray(subs) && subs.length > 0) {
          const roles = subs
            .map((item) => {
              if (!isPlainRecord(item)) return 'subagent';
              return (
                (typeof item.role === 'string' && item.role.trim()) ||
                (typeof item.type_name === 'string' && item.type_name.trim()) ||
                'subagent'
              );
            })
            .join(', ');
          out.push({ type: 'tool_call', summary: `subagent: ${roles}` });
        }
      }

      // Emit usage per completed step only; result.usage is cumulative across resumed turns.
      if (state === 'DONE' && isPlainRecord(su.usage)) {
        const u = su.usage;
        const inputTokens = toNonNegFinite(u.input_tokens);
        const cacheReadTokens = toNonNegFinite(u.cache_read_tokens);
        const outputTokens = toNonNegFinite(u.output_tokens);
        const totalTokens = inputTokens + cacheReadTokens + outputTokens;
        if (totalTokens > 0) {
          out.push({
            type: 'usage',
            inputTokens,
            cacheReadTokens,
            outputTokens,
            totalTokens,
          });
        }
      }
      return out;
    }

    if (ev.event === 'result' && isPlainRecord(ev.result)) {
      const res = ev.result;
      const status = typeof res.status === 'string' ? res.status.trim().toUpperCase() : '';
      const responseText = typeof res.response === 'string' ? res.response : '';
      if (status !== 'SUCCESS') {
        const errText =
          (typeof res.error === 'string' && res.error.trim()) ||
          (status ? `agy turn ended with status ${status}` : 'agy turn failed');
        out.push({ type: 'error', message: errText });
        out.push({ type: 'final', reasonKind: 'error', errorText: errText });
      } else if (
        !responseText.trim() &&
        Array.isArray(res.denied_actions) &&
        res.denied_actions.length > 0
      ) {
        const deniedList = res.denied_actions
          .map((d) => {
            if (!isPlainRecord(d)) return 'action';
            return (
              (typeof d.display_name === 'string' && d.display_name.trim()) ||
              (typeof d.action === 'string' && d.action.trim()) ||
              'action'
            );
          })
          .join(', ');
        const msg =
          `agy permission denied in headless mode: ${deniedList}. ` +
          `Re-run with permission_mode="danger-full-access" (or pre-allow tools in ~/.gemini/antigravity/settings.json).`;
        out.push({ type: 'error', message: msg });
        out.push({ type: 'final', reasonKind: 'error', errorText: msg });
      } else {
        out.push({
          type: 'final',
          text: typeof res.response === 'string' ? res.response : undefined,
          reasonKind: 'completed',
        });
      }
    }

    return out;
  },
};
