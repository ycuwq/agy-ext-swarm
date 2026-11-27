import { calcInputCacheHit, escapeHtml } from './format.js';
import type { I18nKey } from './i18n.js';
import type { DiffCommentTarget, DiffInlineComment } from './store.js';
import type { WorktreePatchResult } from './types.js';

export type Translator = (key: I18nKey, vars?: Record<string, string | number>) => string;

type StructuredEvent = { type: string; detail: string; cls?: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function addAgyEvents(ev: Record<string, unknown>, events: StructuredEvent[], tr: Translator): boolean {
  if (ev.event === 'init') {
    const init = asRecord(ev.init);
    const id = ev.conversation_id ?? init?.conversation_id;
    if (typeof id === 'string' && id) events.push({ type: tr('ev.session'), detail: id });
    const model = typeof init?.model === 'string' ? init.model : '';
    events.push({
      type: tr('ev.turn'),
      detail: [tr('ev.turnStart', { n: 1 }), model].filter(Boolean).join(' · '),
    });
    return true;
  }
  if (ev.event === 'step_update') {
    const step = asRecord(ev.step_update);
    if (!step) return true;
    if (step.step_type === 'agent_response' && typeof step.text_delta === 'string' && step.text_delta) {
      const last = events.at(-1);
      if (last?.type === tr('ev.text')) {
        last.detail = (last.detail + step.text_delta).slice(0, 800);
      } else {
        events.push({ type: tr('ev.text'), detail: step.text_delta.slice(0, 800) });
      }
    } else if (step.step_type === 'tool') {
      const info = asRecord(step.tool_info);
      const name = String(step.tool_name ?? info?.name ?? tr('ev.genericTool'));
      const args = info?.parameters ?? info?.input;
      const detail = [step.state, args === undefined ? '' : typeof args === 'string' ? args : JSON.stringify(args)]
        .filter(Boolean).join(' · ');
      events.push({ type: tr('ev.tool', { name }), detail: detail.slice(0, 400), cls: 'tool' });
    }
    const subs = asRecord(step.subagent_info)?.subagents;
    if (Array.isArray(subs) && subs.length > 0) {
      const roles = subs.map((sub) => {
        const info = asRecord(sub);
        return String(info?.role || info?.type_name || tr('ev.subagent'));
      });
      events.push({ type: tr('ev.subagent'), detail: roles.join(', '), cls: 'tool' });
    }
    const usage = asRecord(step.usage);
    if (usage) {
      const input = Number(usage.input_tokens || 0);
      const cache = Number(usage.cache_read_tokens || 0);
      const output = Number(usage.output_tokens || 0);
      events.push({
        type: tr('ev.usage'),
        detail: tr('ev.usageDetail', {
          step: Number(step.step_index ?? step.step ?? 0),
          total: Number(usage.total_tokens ?? input + cache + output),
          cache,
          hit: calcInputCacheHit(input, cache),
        }),
      });
    }
    return true;
  }
  if (ev.event === 'result') {
    const result = asRecord(ev.result) ?? ev;
    const status = typeof result.status === 'string' ? result.status : '';
    const ok = status.toUpperCase() === 'SUCCESS';
    const response = typeof result.response === 'string' ? result.response : '';
    const error = typeof result.error === 'string' ? result.error : '';
    events.push({
      type: tr('ev.final', { reason: ok ? tr('ev.completed') : status || tr('status.failed') }),
      detail: (ok ? response : error || response).slice(0, 500),
      cls: ok ? 'final' : 'error',
    });
    return true;
  }
  return false;
}

export function renderStructuredEventsHtml(lines: string[], tr: Translator): string {
  const events: StructuredEvent[] = [];
  const toolResults = new Map<string, string>();

  const parsedObjects: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const obj = asRecord(JSON.parse(line));
      if (!obj) continue;
      parsedObjects.push(obj);
      if (obj.type === 'tool_result' && typeof obj.callId === 'string') {
        const resStr = typeof obj.result === 'string' ? obj.result : JSON.stringify(obj.result ?? '');
        toolResults.set(obj.callId, resStr.slice(0, 400));
      }
    } catch {
      // Ignore malformed line
    }
  }

  for (const ev of parsedObjects) {
    if (addAgyEvents(ev, events, tr)) continue;
    const evType = String(ev.type || '');
    if (evType === 'session') {
      events.push({ type: tr('ev.session'), detail: `sessionId=${ev.sessionId} cwd=${ev.cwd || ''}` });
    } else if (evType === 'thread.started' && typeof ev.thread_id === 'string') {
      events.push({ type: tr('ev.session'), detail: `thread_id=${ev.thread_id}` });
    } else if (evType === 'system' && ev.subtype === 'init') {
      events.push({
        type: tr('ev.session'),
        detail: `session_id=${ev.session_id || ''}`,
      });
    } else if (evType === 'init') {
      if (ev.session_id || ev.sessionId) {
        events.push({
          type: tr('ev.session'),
          detail: `session_id=${ev.session_id || ev.sessionId}`,
        });
      }
      events.push({ type: tr('ev.turn'), detail: tr('ev.turnStart', { n: 1 }) });
    } else if (evType === 'turn.started') {
      events.push({ type: tr('ev.turn'), detail: tr('ev.turnStart', { n: 1 }) });
    } else if (evType === 'status') {
      const phase = String(ev.phase || '');
      if (phase === 'turn_start') {
        events.push({ type: tr('ev.turn'), detail: tr('ev.turnStart', { n: Number(ev.turn || 1) }) });
      } else if (phase === 'step_end' && ev.usage && typeof ev.usage === 'object') {
        const u = ev.usage as Record<string, unknown>;
        const hit = calcInputCacheHit(Number(u.inputTokens || 0), Number(u.cacheReadTokens || 0));
        events.push({
          type: tr('ev.usage'),
          detail: tr('ev.usageDetail', {
            step: Number(ev.step || 0),
            total: Number(u.totalTokens || 0),
            cache: Number(u.cacheReadTokens || 0),
            hit,
          }),
        });
      }
    } else if (evType === 'thinking' && typeof ev.text === 'string') {
      events.push({ type: tr('ev.thinking'), detail: ev.text.slice(0, 320) });
    } else if (evType === 'tool_call') {
      const callId = typeof ev.callId === 'string' ? ev.callId : '';
      const resultText = toolResults.get(callId);
      const inputStr = JSON.stringify(ev.input ?? {});
      const body = resultText
        ? `${ev.tool}(${inputStr.slice(0, 180)})\n↳ ${resultText}`
        : `${ev.tool}(${inputStr.slice(0, 220)})`;
      events.push({ type: tr('ev.tool', { name: String(ev.tool || 'tool') }), detail: body, cls: 'tool' });
    } else if (evType === 'tool_use') {
      const toolName = String(ev.tool_name || ev.tool || 'tool');
      const inputStr = JSON.stringify(ev.parameters || ev.input || {});
      events.push({ type: tr('ev.tool', { name: toolName }), detail: inputStr.slice(0, 220), cls: 'tool' });
    } else if (evType === 'item.started' && ev.item && typeof ev.item === 'object') {
      const item = ev.item as Record<string, unknown>;
      if (item.type === 'command_execution') {
        events.push({
          type: tr('ev.tool', { name: 'shell' }),
          detail: String(item.command || '').slice(0, 220),
          cls: 'tool',
        });
      }
    } else if (evType === 'item.completed' && ev.item && typeof ev.item === 'object') {
      const item = ev.item as Record<string, unknown>;
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        events.push({ type: tr('ev.text'), detail: item.text.slice(0, 500) });
      }
    } else if (evType === 'assistant' && ev.message && typeof ev.message === 'object') {
      const msg = ev.message as Record<string, unknown>;
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          if (b.type === 'tool_use') {
            events.push({
              type: tr('ev.tool', { name: String(b.name || 'tool') }),
              detail: JSON.stringify(b.input ?? {}).slice(0, 220),
              cls: 'tool',
            });
          } else if (b.type === 'text' && typeof b.text === 'string') {
            events.push({ type: tr('ev.text'), detail: b.text.slice(0, 500) });
          }
        }
      }
    } else if (evType === 'message' && ev.role === 'assistant' && typeof ev.content === 'string') {
      events.push({ type: tr('ev.text'), detail: ev.content.slice(0, 500) });
    } else if (evType === 'text' && typeof ev.text === 'string') {
      events.push({ type: tr('ev.text'), detail: ev.text.slice(0, 500) });
    } else if (evType === 'turn.completed') {
      if (ev.usage && typeof ev.usage === 'object') {
        const u = ev.usage as Record<string, unknown>;
        const inT = Number(u.input_tokens || 0);
        const cT = Number(u.cached_input_tokens || 0);
        const outT = Number(u.output_tokens || 0);
        const hit = calcInputCacheHit(inT, cT);
        events.push({
          type: tr('ev.usage'),
          detail: tr('ev.usageDetail', { step: 1, total: inT + cT + outT, cache: cT, hit }),
        });
      }
      events.push({ type: tr('ev.final', { reason: 'completed' }), detail: '', cls: 'final' });
    } else if (evType === 'result') {
      const u = (ev.usage || ev.stats) as Record<string, unknown> | undefined;
      if (u && typeof u === 'object') {
        const inT = Number(u.input_tokens ?? u.inputTokens ?? 0);
        const cT = Number(u.cache_read_input_tokens ?? u.cached ?? u.cacheReadTokens ?? 0);
        const outT = Number(u.output_tokens ?? u.outputTokens ?? 0);
        const totT = Number(u.total_tokens ?? u.totalTokens ?? inT + cT + outT);
        const hit = calcInputCacheHit(inT, cT);
        events.push({
          type: tr('ev.usage'),
          detail: tr('ev.usageDetail', { step: 1, total: totT, cache: cT, hit }),
        });
      }
      const reason = ev.is_error || ev.status === 'error' ? 'error' : 'completed';
      const detail =
        typeof ev.result === 'string'
          ? ev.result
          : typeof ev.response === 'string'
            ? ev.response
            : typeof ev.text === 'string'
              ? ev.text
              : '';
      events.push({ type: tr('ev.final', { reason }), detail: detail.slice(0, 500), cls: 'final' });
    } else if (evType === 'final') {
      const reason = String((ev.reason as Record<string, unknown> | undefined)?.kind || 'completed');
      events.push({
        type: tr('ev.final', { reason }),
        detail: typeof ev.text === 'string' ? ev.text.slice(0, 500) : '',
        cls: 'final',
      });
    } else if (evType === 'error' || evType === 'turn.failed') {
      events.push({ type: tr('ev.error'), detail: JSON.stringify(ev), cls: 'error' });
    } else if (
      (evType === 'USER_INPUT' || evType === 'SYSTEM_MESSAGE') &&
      typeof ev.content === 'string'
    ) {
      let text = ev.content.trim();
      const reqMatch = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(text);
      if (reqMatch) text = reqMatch[1].trim();
      if (text) {
        events.push({ type: tr('ev.userInput'), detail: text.slice(0, 500) });
      }
    } else if (evType === 'PLANNER_RESPONSE') {
      if (typeof ev.thinking === 'string' && ev.thinking.trim()) {
        events.push({ type: tr('ev.thinking'), detail: ev.thinking.trim().slice(0, 320) });
      }
      if (Array.isArray(ev.tool_calls)) {
        for (const tc of ev.tool_calls) {
          if (!tc || typeof tc !== 'object') continue;
          const rec = tc as Record<string, unknown>;
          const fn = rec.function && typeof rec.function === 'object'
            ? (rec.function as Record<string, unknown>).name
            : undefined;
          const toolName = String(rec.name ?? rec.tool_name ?? fn ?? 'tool');
          const args = rec.args ?? rec.arguments ?? {};
          const argsStr = typeof args === 'string' ? args : JSON.stringify(args);
          events.push({
            type: tr('ev.tool', { name: toolName }),
            detail: argsStr.slice(0, 220),
            cls: 'tool',
          });
        }
      }
      if (typeof ev.content === 'string' && ev.content.trim()) {
        events.push({ type: tr('ev.text'), detail: ev.content.trim().slice(0, 800) });
      }
      const inT = Number(ev.input_tokens || 0);
      const cT = Number(ev.cache_read_tokens || 0);
      const outT = Number(ev.output_tokens || 0);
      if (inT > 0 || cT > 0 || outT > 0) {
        const hit = calcInputCacheHit(inT, cT);
        const stepIdx = Number(ev.step_index || 0);
        const modelTag = typeof ev.model === 'string' && ev.model.trim() ? `${ev.model.trim()} · ` : '';
        events.push({
          type: tr('ev.usage'),
          detail: `${modelTag}${tr('ev.usageDetail', { step: stepIdx, total: inT + cT + outT, cache: cT, hit })}`,
        });
      }
    } else if (evType === 'GENERIC' && typeof ev.content === 'string') {
      const cleaned = ev.content
        .replace(/^(?:Created At|Completed At):[^\n]*\n?/gm, '')
        .trim();
      if (cleaned) {
        events.push({ type: tr('ev.tool', { name: 'output' }), detail: cleaned.slice(0, 360) });
      }
    } else if (evType === 'ERROR_MESSAGE') {
      const detail =
        typeof ev.content === 'string'
          ? ev.content
          : typeof ev.message === 'string'
            ? ev.message
            : JSON.stringify(ev);
      events.push({ type: tr('ev.error'), detail: detail.slice(0, 500), cls: 'error' });
    }
  }

  if (events.length === 0) {
    return `<pre class="raw-log-pre">${escapeHtml(lines.join('\n'))}</pre>`;
  }

  return events
    .slice(-60)
    .map(
      (ev) => `
      <div class="ev-item">
        <div class="ev-head">
          <span class="ev-type ${ev.cls || ''}">${escapeHtml(ev.type)}</span>
        </div>
        <div class="ev-content">${escapeHtml(ev.detail)}</div>
      </div>
    `,
    )
    .join('');
}

const gitPathEscapes: Record<string, string> = {
  a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '"': '"', '\\': '\\',
};

function parseDiffPath(header: string): string {
  const encoded = /^"((?:\\.|[^"\\])*)"/.exec(header)?.[1];
  const path = encoded === undefined
    ? header.split('\t', 1)[0]
    : encoded.replace(/\\([0-7]{3}(?:\\[0-7]{3})*|[abfnrtv"\\])/g, (_, escapes: string) => {
        if (!/^[0-7]/.test(escapes)) return gitPathEscapes[escapes];
        const bytes = escapes.split('\\').map((octal) => Number.parseInt(octal, 8));
        return new TextDecoder().decode(Uint8Array.from(bytes));
      });
  if (path === '/dev/null') return '';
  return path.replace(/^[ab]\//, '');
}

function parseGitDiffHeader(header: string): string {
  const quotedOld = /^"(?:\\.|[^"\\])*" /.exec(header);
  if (quotedOld) return parseDiffPath(header.slice(quotedOld[0].length));
  const quotedNew = header.lastIndexOf(' "b/');
  const separator = quotedNew >= 0 ? quotedNew : header.lastIndexOf(' b/');
  return separator >= 0 ? parseDiffPath(header.slice(separator + 1)) : '';
}

export function renderDiffHtml(
  data: WorktreePatchResult,
  tr: Translator,
  opts?: {
    comments?: DiffInlineComment[];
    activeTarget?: DiffCommentTarget | null;
  },
): string {
  const comments = opts?.comments || [];
  const activeTarget = opts?.activeTarget || null;

  let currentFile = '';
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  let inHunk = false;

  const linesHtml = data.patch
    .split('\n')
    .map((line) => {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[3]);
        oldRemaining = Number(hunk[2] ?? 1);
        newRemaining = Number(hunk[4] ?? 1);
        inHunk = oldRemaining > 0 || newRemaining > 0;
        return `<span class="diff-line diff-hunk">${escapeHtml(line)}</span>`;
      }
      if (!inHunk) {
        if (line.startsWith('diff --git ')) {
          currentFile = parseGitDiffHeader(line.slice('diff --git '.length));
        } else if (line.startsWith('+++ ') || line.startsWith('--- ')) {
          currentFile = parseDiffPath(line.slice(4)) || currentFile;
        }
        const isHeader = /^(?:diff --git |\+\+\+ |--- |new file mode |deleted file mode |index )/.test(line);
        return `<span class="diff-line${isHeader ? ' diff-head' : ''}">${escapeHtml(line)}</span>`;
      }

      let cls = '';
      let lineType: '+' | '-' | ' ' | null = null;
      let lineNo = 0;
      if (line.startsWith('+') && newRemaining > 0) {
        cls = 'diff-add';
        lineType = '+';
        lineNo = newLine++;
        --newRemaining;
      } else if (line.startsWith('-') && oldRemaining > 0) {
        cls = 'diff-del';
        lineType = '-';
        lineNo = oldLine++;
        --oldRemaining;
      } else if (line.startsWith(' ') && oldRemaining > 0 && newRemaining > 0) {
        lineType = ' ';
        lineNo = newLine++;
        oldLine++;
        --newRemaining;
        --oldRemaining;
      }
      inHunk = oldRemaining > 0 || newRemaining > 0;

      if (!currentFile || !lineType || lineNo <= 0) {
        return `<span class="diff-line ${cls}">${escapeHtml(line)}</span>`;
      }

      const codeText = line.slice(1);
      const lineComments = comments.filter(
        (c) => c.file === currentFile && c.line === lineNo && c.lineType === lineType,
      );
      const isComposingHere = Boolean(
        activeTarget &&
          activeTarget.file === currentFile &&
          activeTarget.line === lineNo &&
          activeTarget.lineType === lineType,
      );

      const addLabel = tr('diff.addCommentAt', { file: currentFile, line: lineNo });
      const triggerAttrs = `data-diff-comment-open data-diff-file="${escapeHtml(currentFile)}" data-diff-line="${lineNo}" data-diff-type="${escapeHtml(lineType)}" data-diff-code="${escapeHtml(codeText)}" title="${escapeHtml(addLabel)}" aria-label="${escapeHtml(addLabel)}"`;
      const lineButton = `<button type="button" class="diff-ln diff-ln-btn" ${triggerAttrs}><span class="diff-comment-trigger" aria-hidden="true">+</span>${lineNo}</button>`;
      const rowHtml = `<span class="diff-line diff-code-line ${cls}${lineComments.length > 0 ? ' has-comments' : ''}">${lineButton}<span class="diff-code-text">${escapeHtml(line)}</span></span>`;

      const commentsHtml = lineComments
        .map(
          (c) =>
            `<div class="diff-inline-comment"><div class="diff-inline-comment-meta"><span>${escapeHtml(c.file)}:${c.line}</span><button type="button" class="diff-inline-del" data-diff-comment-del="${escapeHtml(c.id)}" title="${escapeHtml(tr('diff.removeComment'))}" aria-label="${escapeHtml(tr('diff.removeComment'))}">×</button></div><div class="diff-inline-comment-body">${escapeHtml(c.comment)}</div></div>`,
        )
        .join('');

      const composerHtml = isComposingHere
        ? `<form class="diff-inline-composer" data-diff-comment-form><div class="diff-inline-composer-loc">${escapeHtml(currentFile)}:${lineNo}</div><textarea class="input input-sm diff-inline-textarea" rows="2" required aria-label="${escapeHtml(tr('diff.commentPlaceholder'))}" placeholder="${escapeHtml(tr('diff.commentPlaceholder'))}"></textarea><div class="diff-inline-composer-actions"><button type="button" class="btn btn-sm btn-ghost" data-diff-comment-cancel>${escapeHtml(tr('cmd.cancel'))}</button><button type="submit" class="btn btn-sm btn-primary">${escapeHtml(tr('diff.saveComment'))}</button></div></form>`
        : '';

      return `${rowHtml}${commentsHtml}${composerHtml}`;
    })
    .join('');

  return `
    ${data.stat ? `<div class="diff-stat">${escapeHtml(data.stat)}</div>` : ''}
    ${data.truncated ? `<div class="diff-trunc-banner">${escapeHtml(tr('diff.truncated'))}</div>` : ''}
    <div class="diff-pre">${linesHtml}</div>
  `;
}
