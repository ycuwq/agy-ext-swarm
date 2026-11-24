import { calcInputCacheHit, escapeHtml } from './format.js';
import type { I18nKey } from './i18n.js';
import type { DiffCommentTarget, DiffInlineComment } from './store.js';
import type { WorktreePatchResult } from './types.js';

export type Translator = (key: I18nKey, vars?: Record<string, string | number>) => string;

export function renderStructuredEventsHtml(lines: string[], tr: Translator): string {
  const events: Array<{ type: string; detail: string; cls?: string }> = [];
  const toolResults = new Map<string, string>();

  const parsedObjects: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
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

  const linesHtml = data.patch
    .split('\n')
    .map((line) => {
      if (line.startsWith('diff --git ')) {
        const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
        if (m?.[2]) currentFile = m[2];
        return `<span class="diff-line diff-head">${escapeHtml(line)}</span>`;
      }
      if (line.startsWith('+++ ')) {
        const pathPart = line.slice(4).trim();
        if (pathPart && pathPart !== '/dev/null') {
          currentFile = pathPart.startsWith('b/') ? pathPart.slice(2) : pathPart;
        }
        return `<span class="diff-line diff-head">${escapeHtml(line)}</span>`;
      }
      if (line.startsWith('--- ') || line.startsWith('new file mode') || line.startsWith('index ')) {
        return `<span class="diff-line diff-head">${escapeHtml(line)}</span>`;
      }
      if (line.startsWith('@@')) {
        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (hunk) {
          oldLine = Number(hunk[1]);
          newLine = Number(hunk[2]);
        }
        return `<span class="diff-line diff-hunk">${escapeHtml(line)}</span>`;
      }

      let cls = '';
      let lineType: '+' | '-' | ' ' | null = null;
      let lineNo = 0;
      if (line.startsWith('+') && currentFile) {
        cls = 'diff-add';
        lineType = '+';
        lineNo = newLine++;
      } else if (line.startsWith('-') && currentFile) {
        cls = 'diff-del';
        lineType = '-';
        lineNo = oldLine++;
      } else if (line.startsWith(' ') && currentFile && (newLine > 0 || oldLine > 0)) {
        lineType = ' ';
        lineNo = newLine++;
        oldLine++;
      } else if (line.startsWith('+')) {
        cls = 'diff-add';
      } else if (line.startsWith('-')) {
        cls = 'diff-del';
      }

      if (!lineType || lineNo <= 0) {
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

      const triggerBtn = `<button type="button" class="diff-comment-trigger" data-diff-comment-open data-diff-file="${escapeHtml(currentFile)}" data-diff-line="${lineNo}" data-diff-type="${escapeHtml(lineType)}" data-diff-code="${escapeHtml(codeText)}" title="${escapeHtml(tr('diff.addCommentHint'))}">+</button>`;
      const lineNumLabel = `<span class="diff-ln">${lineNo}</span>`;
      const rowHtml = `<span class="diff-line diff-code-line ${cls}">${triggerBtn}${lineNumLabel}<span class="diff-code-text">${escapeHtml(line)}</span></span>`;

      const commentsHtml = lineComments
        .map(
          (c) =>
            `<div class="diff-inline-comment"><div class="diff-inline-comment-meta"><span>${escapeHtml(c.file)}:${c.line}</span><button type="button" class="diff-inline-del" data-diff-comment-del="${escapeHtml(c.id)}" title="${escapeHtml(tr('diff.removeComment'))}">×</button></div><div class="diff-inline-comment-body">${escapeHtml(c.comment)}</div></div>`,
        )
        .join('');

      const composerHtml = isComposingHere
        ? `<form class="diff-inline-composer" data-diff-comment-form><div class="diff-inline-composer-loc">${escapeHtml(currentFile)}:${lineNo}</div><textarea class="input input-sm diff-inline-textarea" rows="2" required placeholder="${escapeHtml(tr('diff.commentPlaceholder'))}"></textarea><div class="diff-inline-composer-actions"><button type="button" class="btn btn-sm btn-ghost" data-diff-comment-cancel>${escapeHtml(tr('cmd.cancel'))}</button><button type="submit" class="btn btn-sm btn-primary">${escapeHtml(tr('diff.saveComment'))}</button></div></form>`
        : '';

      return `${rowHtml}${commentsHtml}${composerHtml}`;
    })
    .join('');

  return `
    ${data.stat ? `<div class="diff-stat">${escapeHtml(data.stat)}</div>` : ''}
    ${data.truncated ? `<div class="diff-trunc-banner">${escapeHtml(tr('diff.truncated'))}</div>` : ''}
    <pre class="diff-pre">${linesHtml}</pre>
  `;
}
