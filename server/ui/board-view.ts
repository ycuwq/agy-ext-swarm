/**
 * Board feed rendering plus the log and diff drawers.
 *
 * Extracted verbatim from the former monolithic `ui/app.ts`; identifiers are
 * bound as follows:
 *   state  -> `store.ts`    (shared mutable UI state)
 *   dom    -> `dom.ts`      (typed DOM refs)
 *   bridge -> `bridge.ts`   (callbacks still owned by the entrypoint)
 * This keeps the module graph acyclic: views never import `app.ts`.
 */
import { computeBoardSignature, extractToolErrorMessage, formatRouteText, formatTime, kindLabel, resizeComposerInput, showGlobalToast, withBusyButton } from './helpers.js';
import { tr } from './context.js';
import { state } from './store.js';
import * as dom from './dom.js';
import {
  escapeHtml,
  formatMessageHtml,
} from './format.js';
import { renderDiffHtml, renderStructuredEventsHtml } from './render-events.js';
import type {
  BoardMessage,
  MemberState,
  WorktreePatchResult,
} from './types.js';
import { app } from './mcp-app.js';
import { openOnboardingWizard } from './onboarding-view.js';
import * as bridge from './bridge.js';

export function renderParticipantChips(members: MemberState[]): void {
  const names = ['coordinator', ...members.map((m) => m.name)];
  dom.agentChips.innerHTML = '';
  if (names.length <= 1) return;

  const allChip = document.createElement('button');
  allChip.type = 'button';
  allChip.className = `agent-chip${state.selectedAgentFilter === null ? ' active' : ''}`;
  allChip.textContent = tr('board.allParticipants');
  allChip.onclick = () => {
    state.selectedAgentFilter = null;
    renderParticipantChips(members);
    if (state.latestSnapshot) renderBoard(state.latestSnapshot.messages);
  };
  dom.agentChips.appendChild(allChip);

  for (const name of names) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `agent-chip${state.selectedAgentFilter === name ? ' active' : ''}`;
    btn.textContent = name;
    btn.onclick = () => {
      state.selectedAgentFilter = state.selectedAgentFilter === name ? null : name;
      renderParticipantChips(members);
      if (state.latestSnapshot) renderBoard(state.latestSnapshot.messages);
    };
    dom.agentChips.appendChild(btn);
  }
}

export function renderMentionQuickbar(members: MemberState[]): void {
  const activeWorkers = members.filter((m) => m.status !== 'killed').map((m) => m.name);
  dom.mentionQuickbar.innerHTML = '';
  if (activeWorkers.length === 0) return;

  for (const tag of ['@all', ...activeWorkers.map((n) => `@${n}`)]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quick-mention';
    btn.textContent = tag;
    btn.onclick = () => {
      const cur = dom.composerInput.value;
      const spacer = cur && !cur.endsWith(' ') ? ' ' : '';
      dom.composerInput.value = `${cur}${spacer}${tag} `;
      resizeComposerInput();
      dom.composerInput.focus();
    };
    dom.mentionQuickbar.appendChild(btn);
  }
}

export function renderBoard(messages: BoardMessage[]): void {
  const search = dom.boardFilter.value.trim().toLowerCase();
  const filtered = messages.filter((m) => {
    if (state.selectedKindFilter === 'done' && m.kind !== 'done') return false;
    if (
      state.selectedKindFilter === 'alerts' &&
      m.kind !== 'error' &&
      m.kind !== 'blocker' &&
      m.kind !== 'warning' &&
      m.kind !== 'system'
    ) {
      return false;
    }
    if (state.selectedAgentFilter) {
      const involves =
        m.agent === state.selectedAgentFilter ||
        m.mentions.includes(state.selectedAgentFilter) ||
        (state.selectedAgentFilter === 'coordinator' && m.mentionsCoordinator) ||
        m.all;
      if (!involves) return false;
    }
    if (search) {
      return (
        m.agent.toLowerCase().includes(search) ||
        m.text.toLowerCase().includes(search) ||
        `#${m.seq}`.includes(search)
      );
    }
    return true;
  });

  if (filtered.length === 0) {
    dom.boardFeed.innerHTML = `<div class="empty-state">${escapeHtml(tr('board.emptyMatch'))}</div>`;
    dom.btnJumpLatest.classList.add('hidden');
    return;
  }

  const wasAtBottom =
    dom.boardFeed.scrollHeight - dom.boardFeed.scrollTop - dom.boardFeed.clientHeight < 48;

  dom.boardFeed.innerHTML = '';
  let prevMsg: BoardMessage | null = null;

  for (const m of filtered) {
    const isNew = state.initialBoardLoaded && !state.seenSeqs.has(m.seq);
    state.seenSeqs.add(m.seq);

    const isGrouped =
      prevMsg !== null &&
      prevMsg.agent === m.agent &&
      prevMsg.kind === m.kind &&
      Math.abs(new Date(m.time).getTime() - new Date(prevMsg.time).getTime()) < 5 * 60 * 1000;

    const card = document.createElement('article');
    card.className = `msg-card kind-${m.kind || 'message'}${isGrouped ? ' grouped' : ''}${isNew ? ' is-new' : ''}`;
    card.dataset.seq = String(m.seq);

    const routeText = formatRouteText(m);
    const kindBadge =
      m.kind && m.kind !== 'message'
        ? `<span class="pill pill-${m.kind === 'done' ? 'waiting' : m.kind === 'error' || m.kind === 'blocker' ? 'failed' : m.kind === 'warning' ? 'warn' : 'neutral'}">${escapeHtml(kindLabel(m.kind))}</span>`
        : '';
    const reportBtn = m.reportPath
      ? `<button type="button" class="msg-report-btn" data-copy-report="${escapeHtml(m.reportPath)}" title="${escapeHtml(m.reportPath)}">${escapeHtml(tr('board.copyReport'))}</button>`
      : '';

    const isLong = m.text.length > 520 || m.text.split('\n').length > 8;
    const isExpanded = state.expandedSeqs.has(m.seq);
    const displayText =
      isLong && !isExpanded ? `${m.text.slice(0, 420).trimEnd()}\n...` : m.text;

    card.innerHTML = `
      <div class="msg-header">
        <div class="msg-author-wrap">
          <span class="msg-author${m.agent === 'coordinator' ? ' is-coord' : ''}">${escapeHtml(m.agent)}</span>
          ${routeText ? `<span class="msg-route">${escapeHtml(routeText)}</span>` : ''}
          ${kindBadge}
          <span class="msg-seq">#${m.seq}</span>
          ${reportBtn}
        </div>
        <span class="msg-time">${escapeHtml(formatTime(m.time))}</span>
      </div>
      <div class="msg-body">${formatMessageHtml(displayText)}</div>
    `;

    if (isLong) {
      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'msg-toggle-more';
      toggleBtn.textContent = isExpanded ? tr('board.showLess') : tr('board.showMore');
      toggleBtn.onclick = () => {
        if (state.expandedSeqs.has(m.seq)) {
          state.expandedSeqs.delete(m.seq);
        } else {
          state.expandedSeqs.add(m.seq);
        }
        renderBoard(messages);
      };
      card.appendChild(toggleBtn);
    }

    dom.boardFeed.appendChild(card);
    prevMsg = m;
  }

  state.initialBoardLoaded = true;

  if (dom.autoFollow.checked && (wasAtBottom || filtered.length <= 6)) {
    dom.boardFeed.scrollTop = dom.boardFeed.scrollHeight;
    dom.btnJumpLatest.classList.add('hidden');
  }
  if (state.latestSnapshot) {
    state.lastBoardSignature = computeBoardSignature(state.latestSnapshot);
  }
}

export function jumpToSeq(seqNum: number): void {
  const target = dom.boardFeed.querySelector<HTMLElement>(`.msg-card[data-seq="${seqNum}"]`);
  if (!target) {
    dom.boardFilter.value = '';
    state.selectedAgentFilter = null;
    state.selectedKindFilter = 'all';
    if (state.latestSnapshot) {
      renderParticipantChips(Object.values(state.latestSnapshot.swarm?.members || {}));
      renderBoard(state.latestSnapshot.messages);
    }
  }
  const el = dom.boardFeed.querySelector<HTMLElement>(`.msg-card[data-seq="${seqNum}"]`);
  if (!el) return;
  dom.autoFollow.checked = false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

export function renderLogDrawerBody(): void {
  dom.logDrawerCount.textContent = String(state.cachedLogLines.length);
  dom.logModeToggle.textContent = state.logRawMode ? tr('drawer.structured') : tr('drawer.raw');

  if (state.cachedLogLines.length === 0) {
    dom.logDrawerBody.innerHTML = `<div class="empty-state-compact">${escapeHtml(tr('drawer.empty'))}</div>`;
    return;
  }

  if (state.logRawMode) {
    dom.logDrawerBody.innerHTML = `<pre class="raw-log-pre">${escapeHtml(state.cachedLogLines.join('\n'))}</pre>`;
    dom.logDrawerBody.scrollTop = dom.logDrawerBody.scrollHeight;
    return;
  }

  dom.logDrawerBody.innerHTML = renderStructuredEventsHtml(state.cachedLogLines, tr);
  dom.logDrawerBody.scrollTop = dom.logDrawerBody.scrollHeight;
}

export async function openWorkerLogs(name: string): Promise<void> {
  state.activeLogTarget = { kind: 'external', name };
  dom.diffDrawer.classList.add('hidden');
  dom.logDrawerTitle.textContent = tr('drawer.titleFor', { name });
  dom.logDrawer.classList.remove('hidden');
  try {
    const res = await app.callServerTool({
      name: 'app_get_worker_log',
      arguments: {
        ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
        name,
        tail_lines: 120,
      },
    });
    const errMsg = extractToolErrorMessage(res);
    if (errMsg) {
      state.cachedLogLines = [tr('drawer.loadError', { err: errMsg })];
      renderLogDrawerBody();
      return;
    }
    const data = res.structuredContent as { name?: string; lines?: string[] } | undefined;
    state.cachedLogLines = data?.lines || [];
    renderLogDrawerBody();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    state.cachedLogLines = [tr('drawer.loadError', { err: errMsg })];
    renderLogDrawerBody();
  }
}

export async function openNativeSubagentLogs(id: string, label: string): Promise<void> {
  state.activeLogTarget = { kind: 'native', id, label };
  dom.diffDrawer.classList.add('hidden');
  dom.logDrawerTitle.textContent = tr('drawer.titleNativeFor', { name: label });
  dom.logDrawer.classList.remove('hidden');
  try {
    const res = await app.callServerTool({
      name: 'app_get_native_subagent_log',
      arguments: {
        conversation_id: id,
        tail_lines: 120,
      },
    });
    const errMsg = extractToolErrorMessage(res);
    if (errMsg) {
      state.cachedLogLines = [tr('drawer.loadError', { err: errMsg })];
      renderLogDrawerBody();
      return;
    }
    const data = res.structuredContent as { conversationId?: string; lines?: string[] } | undefined;
    state.cachedLogLines = data?.lines || [];
    renderLogDrawerBody();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    state.cachedLogLines = [tr('drawer.loadError', { err: errMsg })];
    renderLogDrawerBody();
  }
}

export function renderDiffDrawerFooter(): void {
  const count = state.diffComments.length;
  dom.diffDrawerFooter.classList.toggle('hidden', count === 0);
  if (count > 0) {
    dom.diffCommentsCount.textContent = tr('diff.commentsCount', { n: count });
    dom.diffCommentsSend.textContent = tr('diff.sendFixTo', {
      name: state.activeDiffWorker || 'worker',
    });
  }
}

export function renderDiffDrawerBody(): void {
  const prevScrollTop = dom.diffDrawerBody.scrollTop;
  const data = state.cachedDiffData;
  if (!data) {
    dom.diffDrawerBody.innerHTML = `<div class="empty-state-compact">${escapeHtml(tr('diff.empty'))}</div>`;
    renderDiffDrawerFooter();
    return;
  }
  dom.diffDrawerBranch.textContent = data.branch || 'HEAD';
  if (!data.patch.trim()) {
    dom.diffDrawerBody.innerHTML = `<div class="empty-state-compact">${escapeHtml(tr('diff.empty'))}</div>`;
    renderDiffDrawerFooter();
    return;
  }
  dom.diffDrawerBody.innerHTML = renderDiffHtml(data, tr, {
    comments: state.diffComments,
    activeTarget: state.activeDiffCommentTarget,
  });
  dom.diffDrawerBody.scrollTop = prevScrollTop;
  renderDiffDrawerFooter();
  if (state.activeDiffCommentTarget) {
    const ta = dom.diffDrawerBody.querySelector<HTMLTextAreaElement>('.diff-inline-textarea');
    ta?.focus({ preventScroll: true });
  }
}

export async function openWorkerDiff(name: string): Promise<void> {
  if (state.activeDiffWorker !== name) {
    state.diffComments = [];
    state.activeDiffCommentTarget = null;
  }
  state.activeDiffWorker = name;
  dom.logDrawer.classList.add('hidden');
  dom.diffDrawerTitle.textContent = tr('diff.titleFor', { name });
  dom.diffDrawerBody.innerHTML = `<div class="empty-state-compact">...</div>`;
  renderDiffDrawerFooter();
  dom.diffDrawer.classList.remove('hidden');
  try {
    const res = await app.callServerTool({
      name: 'app_get_worker_diff',
      arguments: {
        ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
        name,
      },
    });
    const errMsg = extractToolErrorMessage(res);
    if (errMsg) {
      dom.diffDrawerBody.innerHTML = `<div class="worker-error">${escapeHtml(tr('diff.loadError', { err: errMsg }))}</div>`;
      return;
    }
    const payload = res.structuredContent as { diff?: WorktreePatchResult } | undefined;
    state.cachedDiffData = payload?.diff || null;
    renderDiffDrawerBody();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    dom.diffDrawerBody.innerHTML = `<div class="worker-error">${escapeHtml(tr('diff.loadError', { err: errMsg }))}</div>`;
  }
}

/** Wire board/drawer listeners. Called once from the entrypoint. */
export function bindBoardEvents(): void {
  document.querySelectorAll<HTMLButtonElement>('.chip-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.kind as 'all' | 'done' | 'alerts';
      if (!kind) return;
      state.selectedKindFilter = kind;
      document.querySelectorAll('.chip-btn').forEach((c) => {
        c.classList.toggle('active', (c as HTMLElement).dataset.kind === kind);
      });
      if (state.latestSnapshot) renderBoard(state.latestSnapshot.messages);
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.scope-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const scope = btn.dataset.scope as 'swarm' | 'session';
      if (!scope) return;
      state.usageScope = scope;
      document.querySelectorAll('.scope-btn').forEach((c) => {
        c.classList.toggle('active', (c as HTMLElement).dataset.scope === scope);
      });
      if (state.latestSnapshot) bridge.renderSnapshot(state.latestSnapshot, true);
    });
  });

  dom.boardFeed.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    const copyReportBtn = target?.closest<HTMLButtonElement>('[data-copy-report]');
    const reportPath = copyReportBtn?.dataset.copyReport;
    if (reportPath) {
      if (navigator.clipboard?.writeText) {
        void navigator.clipboard
          .writeText(reportPath)
          .then(() => showGlobalToast(tr('board.reportCopied', { path: reportPath })))
          .catch(() => showGlobalToast(tr('board.reportCopyFailed', { path: reportPath }), true));
      } else {
        showGlobalToast(tr('board.reportCopyFailed', { path: reportPath }), true);
      }
      return;
    }
    const jumpBtn = target?.closest<HTMLButtonElement>('[data-jump-seq]');
    if (jumpBtn?.dataset.jumpSeq) {
      jumpToSeq(Number(jumpBtn.dataset.jumpSeq));
      return;
    }
    const emptyBtn = target?.closest<HTMLButtonElement>('[data-empty-action]');
    const emptyAct = emptyBtn?.dataset.emptyAction;
    if (emptyAct === 'create' || emptyAct === 'templates') {
      bridge.switchTab('workers');
      if (state.activeCommanderPanel !== emptyAct) {
        bridge.toggleCommanderPanel(emptyAct);
      }
    } else if (emptyAct === 'onboarding') {
      void openOnboardingWizard();
    } else if (emptyAct === 'settings') {
      bridge.switchTab('settings');
    }
  });

  dom.boardFeed.addEventListener('scroll', () => {
    const nearBottom = dom.boardFeed.scrollHeight - dom.boardFeed.scrollTop - dom.boardFeed.clientHeight < 48;
    dom.btnJumpLatest.classList.toggle('hidden', nearBottom);
  });

  dom.btnJumpLatest.addEventListener('click', () => {
    dom.autoFollow.checked = true;
    dom.boardFeed.scrollTop = dom.boardFeed.scrollHeight;
    dom.btnJumpLatest.classList.add('hidden');
  });

  dom.diffDrawerCopy.addEventListener('click', async () => {
    if (!state.cachedDiffData?.patch) return;
    try {
      await navigator.clipboard?.writeText(state.cachedDiffData.patch);
      dom.diffDrawerCopy.textContent = tr('diff.copied');
      window.setTimeout(() => {
        dom.diffDrawerCopy.textContent = tr('diff.copy');
      }, 1600);
    } catch {
      // Non-fatal in sandboxed iframe
    }
  });

  dom.diffDrawerRefresh.addEventListener('click', () => {
    if (state.activeDiffWorker) void openWorkerDiff(state.activeDiffWorker);
  });

  dom.diffDrawerClose.addEventListener('click', () => {
    state.activeDiffWorker = null;
    state.activeDiffCommentTarget = null;
    dom.diffDrawer.classList.add('hidden');
  });

  dom.diffDrawerBody.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    const openBtn = target?.closest<HTMLButtonElement>('[data-diff-comment-open]');
    if (openBtn) {
      const file = openBtn.dataset.diffFile || '';
      const line = Number(openBtn.dataset.diffLine || '0');
      const lineType = (openBtn.dataset.diffType || ' ') as '+' | '-' | ' ';
      const code = openBtn.dataset.diffCode || '';
      if (file && line > 0) {
        state.activeDiffCommentTarget = { file, line, lineType, code };
        renderDiffDrawerBody();
      }
      return;
    }
    const cancelBtn = target?.closest<HTMLButtonElement>('[data-diff-comment-cancel]');
    if (cancelBtn) {
      state.activeDiffCommentTarget = null;
      renderDiffDrawerBody();
      return;
    }
    const delBtn = target?.closest<HTMLButtonElement>('[data-diff-comment-del]');
    if (delBtn?.dataset.diffCommentDel) {
      const id = delBtn.dataset.diffCommentDel;
      state.diffComments = state.diffComments.filter((c) => c.id !== id);
      renderDiffDrawerBody();
    }
  });

  dom.diffDrawerBody.addEventListener('submit', (e) => {
    const form = (e.target as HTMLElement | null)?.closest<HTMLFormElement>('[data-diff-comment-form]');
    if (!form) return;
    e.preventDefault();
    const activeTarget = state.activeDiffCommentTarget;
    if (!activeTarget) return;
    const ta = form.querySelector<HTMLTextAreaElement>('.diff-inline-textarea');
    const text = ta?.value.trim() || '';
    if (!text) return;
    state.diffComments.push({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      ...activeTarget,
      comment: text,
    });
    state.activeDiffCommentTarget = null;
    renderDiffDrawerBody();
  });

  dom.diffDrawerBody.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) {
      const ta = (e.target as HTMLElement | null)?.closest<HTMLTextAreaElement>('.diff-inline-textarea');
      const form = ta?.closest<HTMLFormElement>('[data-diff-comment-form]');
      if (form) {
        e.preventDefault();
        form.requestSubmit();
      }
    }
  });

  dom.diffCommentsClear.addEventListener('click', () => {
    state.diffComments = [];
    state.activeDiffCommentTarget = null;
    renderDiffDrawerBody();
  });

  dom.diffCommentsSend.addEventListener('click', () => {
    const worker = state.activeDiffWorker;
    if (!worker || state.diffComments.length === 0) return;
    void withBusyButton(dom.diffCommentsSend, async () => {
      const reviewLines = state.diffComments.map((c, idx) => {
        const codePreview = c.code.trim().slice(0, 120);
        return `${idx + 1}. \`${c.file}:${c.line}\` (\`${c.lineType}${codePreview}\`)\n   - ${c.comment}`;
      });
      const promptText = `@${worker} [review-fix] Please address the following ${state.diffComments.length} inline diff comment(s) in your worktree and verify your changes:\n\n${reviewLines.join('\n\n')}`;
      try {
        const res = await app.callServerTool({
          name: 'app_post_message',
          arguments: {
            ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
            text: promptText,
          },
        });
        const errMsg = extractToolErrorMessage(res);
        if (errMsg) {
          showGlobalToast(tr('app.postFailed', { err: errMsg }), true);
          return;
        }
        const count = state.diffComments.length;
        state.diffComments = [];
        state.activeDiffCommentTarget = null;
        state.activeDiffWorker = null;
        dom.diffDrawer.classList.add('hidden');
        showGlobalToast(tr('diff.sentFixToast', { name: worker, n: count }));
        await bridge.refreshSnapshot(true);
      } catch (err) {
        showGlobalToast(
          tr('app.postFailed', { err: err instanceof Error ? err.message : String(err) }),
          true,
        );
      }
    });
  });

  dom.boardFilter.addEventListener('input', () => {
    if (state.latestSnapshot) renderBoard(state.latestSnapshot.messages);
  });

  dom.logModeToggle.addEventListener('click', () => {
    state.logRawMode = !state.logRawMode;
    renderLogDrawerBody();
  });

  dom.logDrawerRefresh.addEventListener('click', () => {
    const t = state.activeLogTarget;
    if (!t) return;
    if (t.kind === 'native') {
      void openNativeSubagentLogs(t.id, t.label);
    } else {
      void openWorkerLogs(t.name);
    }
  });

  dom.logDrawerClose.addEventListener('click', () => {
    state.activeLogTarget = null;
    dom.logDrawer.classList.add('hidden');
  });
}
