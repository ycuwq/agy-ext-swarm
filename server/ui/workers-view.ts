/**
 * Arena boards and the Workers card list.
 *
 * Extracted verbatim from the former monolithic `ui/app.ts`; identifiers are
 * bound as follows:
 *   state  -> `store.ts`    (shared mutable UI state)
 *   dom    -> `dom.ts`      (typed DOM refs)
 *   bridge -> `bridge.ts`   (callbacks still owned by the entrypoint)
 * This keeps the module graph acyclic: views never import `app.ts`.
 */
import {
  boolToFastDraft,
  buildFastModeOptionsHtml,
  buildTakeoverCommand,
  clearPendingKillState,
  fastDraftToBool,
  formatDefaultEffortLabel,
  formatDefaultFastLabel,
  getDisplayModelForMember,
  getReasoningEffortOptionsForModel,
  isEditingInsideWorkersList,
  parseFastDraftMode,
  providerBadgeClass,
  providerSupportsFastMode,
  providerSupportsReasoningEffort,
  renderModelOptionBadgesHtml,
  renderSwarmBudgetBanner,
  resizeComposerInput,
  sanitizeReasoningEffort,
  showGlobalToast,
  statusLabel,
  syncEffortSelect,
  withBusyButton,
} from './helpers.js';
import { tr } from './context.js';
import { state, type WorkerSourceFilter, type WorkerStatusFilter } from './store.js';
import * as dom from './dom.js';
import {
  calcInputCacheHit,
  escapeHtml,
  formatDurationMs,
  formatNum,
} from './format.js';
import {
  matchesNativeStatusFilter,
  renderNativeSubagentsSection,
} from './native-workers-section.js';
import { selectNativeSubagents } from './telemetry-selectors.js';
import type {
  MemberState,
  Snapshot,
  WorktreeDiffSummary,
} from './types.js';
import * as bridge from './bridge.js';

export function renderArenaBoards(
  snap: Snapshot,
  members: MemberState[],
  diffs: Record<string, WorktreeDiffSummary | null>,
): void {
  const groups = new Map<string, MemberState[]>();
  for (const m of members) {
    if (!m.arenaGroup) continue;
    const list = groups.get(m.arenaGroup) || [];
    list.push(m);
    groups.set(m.arenaGroup, list);
  }
  dom.arenaBoards.innerHTML = '';
  for (const [groupName, groupMembers] of groups.entries()) {
    const card = document.createElement('div');
    card.className = 'arena-card';
    const rowsHtml = groupMembers
      .map((m) => {
        const diff = diffs[m.name];
        const totalTok = m.usage?.totalTokens || 0;
        const changesText = m.branch
          ? `${diff?.commitCount ?? 0}c / ${diff?.changedFiles?.length ?? 0}f`
          : m.workspaceMode;
        const dm = getDisplayModelForMember(m);
        return `
          <tr>
            <td><strong>${escapeHtml(m.name)}</strong></td>
            <td><span class="provider-badge ${providerBadgeClass(m.provider)}">${escapeHtml(m.provider || 'dsh')}</span><span class="arena-model-text"${dm.title ? ` title="${escapeHtml(dm.title)}"` : ''}>${escapeHtml(dm.label)}</span>${renderModelOptionBadgesHtml(m.reasoningEffort, m.fastMode, { effort: m.resolvedReasoningEffort, fast: m.resolvedFastMode })}</td>
            <td>${escapeHtml(statusLabel(m.status))}</td>
            <td>${escapeHtml(changesText)}</td>
            <td>${escapeHtml(formatNum(totalTok))}</td>
            <td>
              <div class="arena-row-actions">
                ${m.workspaceMode === 'worktree' || m.branch ? `<button type="button" class="btn btn-sm" data-arena-diff="${escapeHtml(m.name)}">${escapeHtml(tr('workers.diffBtn'))}</button>` : ''}
                ${m.workspaceMode === 'worktree' && m.branch && m.status !== 'killed' ? `<button type="button" class="btn btn-sm" data-arena-merge="${escapeHtml(m.name)}">${escapeHtml(tr('workers.mergeBtn'))}</button>` : ''}
                ${m.status !== 'killed' ? `<button type="button" class="btn btn-sm" data-arena-review="${escapeHtml(m.name)}">${escapeHtml(tr('workers.reviewBtn'))}</button>` : ''}
              </div>
            </td>
          </tr>
        `;
      })
      .join('');
    card.innerHTML = `
      <div class="arena-card-title">${escapeHtml(tr('arena.sectionTitle', { group: groupName }))}</div>
      <table class="arena-table">
        <thead>
          <tr>
            <th>${escapeHtml(tr('arena.colWorker'))}</th>
            <th>${escapeHtml(tr('arena.colCli'))}</th>
            <th>${escapeHtml(tr('arena.colStatus'))}</th>
            <th>${escapeHtml(tr('arena.colChanges'))}</th>
            <th>${escapeHtml(tr('arena.colTokens'))}</th>
            <th>${escapeHtml(tr('arena.colActions'))}</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    `;
    card.querySelectorAll<HTMLButtonElement>('[data-arena-diff]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const wName = btn.dataset.arenaDiff;
        if (wName) void bridge.openWorkerDiff(wName);
      });
    });
    card.querySelectorAll<HTMLButtonElement>('[data-arena-merge]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const wName = btn.dataset.arenaMerge;
        if (!wName) return;
        state.mergeOpenWorker = state.mergeOpenWorker === wName ? null : wName;
        if (state.mergeOpenWorker === wName) void bridge.previewMergeFromUi(wName);
        renderWorkers(snap);
      });
    });
    card.querySelectorAll<HTMLButtonElement>('[data-arena-review]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const wName = btn.dataset.arenaReview;
        if (wName) void bridge.crossReviewFromUi(wName);
      });
    });
    dom.arenaBoards.appendChild(card);
  }
}

function isAttentionWorker(m: MemberState, diff?: WorktreeDiffSummary | null): boolean {
  const outOfScope = diff?.outOfScopeFiles?.length
    ? diff.outOfScopeFiles
    : m.outOfScopeFiles || [];
  const hasVerifyFail = Boolean(m.lastVerifyResults?.some((r) => !r.passed));
  return (
    m.status === 'failed' ||
    m.status === 'blocked' ||
    outOfScope.length > 0 ||
    hasVerifyFail
  );
}

function isRunningWorker(m: MemberState): boolean {
  return m.status === 'working' || m.status === 'queued';
}

function isMergeableWorker(m: MemberState, diff?: WorktreeDiffSummary | null): boolean {
  if (m.status !== 'waiting' || m.workspaceMode !== 'worktree' || !m.branch) return false;
  if (!diff) return true;
  return (diff.commitCount || 0) > 0 || (diff.changedFiles?.length || 0) > 0 || (diff.dirtyFiles?.length || 0) > 0;
}

function renderWorkersFilterBar(
  snap: Snapshot,
  members: MemberState[],
  diffs: Record<string, WorktreeDiffSummary | null>,
): void {
  const nativeAll = snap.hostTelemetry?.subagents || [];
  const nativeScoped = selectNativeSubagents(snap, state.nativeScopeFilter);
  if (members.length === 0 && nativeAll.length === 0) {
    dom.workersFilterBar.classList.add('hidden');
    dom.workersFilterBar.innerHTML = '';
    return;
  }

  const includeExternal = state.workerSourceFilter !== 'native';
  const includeNative = state.workerSourceFilter !== 'external';
  const activeExt = includeExternal ? members : [];
  const activeNat = includeNative ? nativeScoped : [];

  const counts: Record<WorkerStatusFilter, number> = {
    all: activeExt.length + activeNat.length,
    attention:
      activeExt.filter((m) => isAttentionWorker(m, diffs[m.name])).length +
      activeNat.filter((s) => matchesNativeStatusFilter(s, 'attention')).length,
    running:
      activeExt.filter((m) => isRunningWorker(m)).length +
      activeNat.filter((s) => matchesNativeStatusFilter(s, 'running')).length,
    mergeable: activeExt.filter((m) => isMergeableWorker(m, diffs[m.name])).length,
  };

  const sourceChips: Array<{ id: WorkerSourceFilter; label: string }> = [
    { id: 'all', label: tr('workers.sourceAll', { n: members.length + nativeScoped.length }) },
    { id: 'external', label: tr('workers.sourceExternal', { n: members.length }) },
    { id: 'native', label: tr('workers.sourceNative', { n: nativeScoped.length }) },
  ];
  const sourceHtml =
    nativeAll.length > 0
      ? `<div class="source-filter-row" role="group">${sourceChips
          .map((c) => {
            const active = state.workerSourceFilter === c.id;
            return `<button type="button" class="chip-btn source-filter-chip${active ? ' active' : ''}" data-source-filter="${c.id}">${escapeHtml(c.label)}</button>`;
          })
          .join('')}</div>`
      : '';

  const chips: Array<{ id: WorkerStatusFilter; label: string; count: number; cls?: string }> = [
    { id: 'all', label: tr('workers.filterAll', { n: counts.all }), count: counts.all },
    {
      id: 'attention',
      label: tr('workers.filterAttention', { n: counts.attention }),
      count: counts.attention,
      cls: counts.attention > 0 ? ' has-attention' : '',
    },
    { id: 'running', label: tr('workers.filterRunning', { n: counts.running }), count: counts.running },
    {
      id: 'mergeable',
      label: tr('workers.filterMergeable', { n: counts.mergeable }),
      count: counts.mergeable,
      cls: counts.mergeable > 0 ? ' has-mergeable' : '',
    },
  ];
  dom.workersFilterBar.classList.remove('hidden');
  dom.workersFilterBar.innerHTML = `${sourceHtml}<div class="status-filter-row">${chips
    .map((c) => {
      const active = state.workerStatusFilter === c.id;
      const zeroCls = !active && c.count === 0 ? ' is-zero' : '';
      return `<button type="button" class="chip-btn workers-filter-chip${active ? ' active' : ''}${zeroCls}${c.cls || ''}" data-worker-filter="${c.id}">${escapeHtml(c.label)}</button>`;
    })
    .join('')}</div>`;
  dom.workersFilterBar.querySelectorAll<HTMLButtonElement>('[data-source-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.sourceFilter as WorkerSourceFilter | undefined;
      if (!next) return;
      state.workerSourceFilter = next;
      renderWorkers(snap);
    });
  });
  dom.workersFilterBar.querySelectorAll<HTMLButtonElement>('[data-worker-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.workerFilter as WorkerStatusFilter | undefined;
      if (!next) return;
      state.workerStatusFilter = next;
      renderWorkers(snap);
    });
  });
}

export function renderWorkers(snap: Snapshot): void {
  const members = snap.swarm ? Object.values(snap.swarm.members || {}) : [];
  const diffs = snap.diffs || {};
  const nativeAll = snap.hostTelemetry?.subagents || [];
  const hasSubagentConvs = (snap.hostTelemetry?.availableConversations || []).some(
    (c) => c.subagentCount > 0,
  );

  renderSwarmBudgetBanner(
    dom.workersBudgetBanner,
    snap,
    bridge.updateSwarmBudgetFromUi,
  );
  renderWorkersFilterBar(snap, members, diffs);
  renderArenaBoards(snap, members, diffs);

  if (members.length === 0 && nativeAll.length === 0 && !hasSubagentConvs) {
    state.seenWorkerNames.clear();
    dom.workersList.innerHTML = `<div class="empty-state">${escapeHtml(tr('workers.empty'))}</div>`;
    return;
  }

  const showExternal = state.workerSourceFilter !== 'native';
  const showNative = state.workerSourceFilter !== 'external';

  const visibleMembers = showExternal
    ? members.filter((m) => {
        if (state.workerStatusFilter === 'attention') return isAttentionWorker(m, diffs[m.name]);
        if (state.workerStatusFilter === 'running') return isRunningWorker(m);
        if (state.workerStatusFilter === 'mergeable') return isMergeableWorker(m, diffs[m.name]);
        return true;
      })
    : [];

  dom.workersList.innerHTML = '';

  if (showExternal && members.length > 0) {
    if (visibleMembers.length > 0 && nativeAll.length > 0 && showNative) {
      const extHeader = document.createElement('div');
      extHeader.className = 'workers-section-header';
      extHeader.innerHTML = `
        <div class="workers-section-title-group">
          <span class="workers-section-title">${escapeHtml(tr('workers.externalSectionTitle'))}</span>
          <span class="pill pill-neutral">${members.length}</span>
        </div>
      `;
      dom.workersList.appendChild(extHeader);
    }
    if (visibleMembers.length === 0 && !showNative) {
      dom.workersList.innerHTML = `<div class="empty-state">${escapeHtml(tr('workers.filterEmpty'))}</div>`;
      return;
    }
  }

  const extGrid = document.createElement('div');
  extGrid.className = 'workers-list';
  for (const m of visibleMembers) {
    const isNewWorker = state.initialBoardLoaded && !state.seenWorkerNames.has(m.name);
    const card = document.createElement('div');
    card.className = `worker-card${m.status === 'working' ? ' is-working' : ''}${isNewWorker ? ' is-new' : ''}`;

    const diff = diffs[m.name];
    const outOfScope = diff?.outOfScopeFiles?.length
      ? diff.outOfScopeFiles
      : m.outOfScopeFiles || [];

    const inputTok = m.usage?.inputTokens || 0;
    const cacheTok = m.usage?.cacheReadTokens || 0;
    const outputTok = m.usage?.outputTokens || 0;
    const totalTok = m.usage?.totalTokens || inputTok + cacheTok + outputTok;
    const hitRate = calcInputCacheHit(inputTok, cacheTok);
    const uncachedPct = inputTok + cacheTok > 0 ? Math.max(0, 100 - hitRate) : 0;

    const pillClass =
      m.status === 'working'
        ? 'pill-working'
        : m.status === 'queued' || m.status === 'blocked'
          ? 'pill-warn'
          : m.status === 'waiting'
            ? 'pill-waiting'
            : m.status === 'failed'
              ? 'pill-failed'
              : 'pill-neutral';

    const depsHtml =
      m.dependsOn && m.dependsOn.length > 0
        ? `<div class="worker-deps-row"><span>${escapeHtml(tr('workers.dependsOn'))}</span>${m.dependsOn
            .map((d) => `<span class="dep-pill">@${escapeHtml(d)}</span>`)
            .join('')}</div>`
        : '';

    const changedFilesHtml = diff?.changedFiles?.length
      ? `<div class="file-pills">${diff.changedFiles
          .slice(0, 12)
          .map((f) => {
            const isBad = outOfScope.includes(f);
            return `<span class="file-pill${isBad ? ' bad' : ''}">${escapeHtml(f)}</span>`;
          })
          .join('')}${diff.changedFiles.length > 12 ? `<span class="file-pill">${escapeHtml(tr('workers.moreFiles', { n: diff.changedFiles.length - 12 }))}</span>` : ''}</div>`
      : '';

    const wtHtml = m.branch
      ? `
        <div class="worktree-box">
          <div class="worktree-branch">${escapeHtml(m.branch)}</div>
          <div class="worker-meta">
            <span>${escapeHtml(tr('workers.commits'))}: ${diff?.commitCount ?? 0}</span>
            <span>${escapeHtml(tr('workers.changed'))}: ${diff?.changedFiles?.length ?? 0}</span>
            <span>${escapeHtml(tr('workers.dirty'))}: ${diff?.dirtyFiles?.length ?? 0}</span>
          </div>
          ${changedFilesHtml}
        </div>
      `
      : `<div class="worker-meta"><span>${escapeHtml(tr('workers.workspace'))}: ${escapeHtml(m.workspaceMode)}</span><span>${escapeHtml(tr('workers.perm'))}: ${escapeHtml(m.permissionMode)}</span></div>`;

    const activityHtml = m.activity
      ? `
        <div class="worker-activity-row">
          <span class="eq-bars" aria-hidden="true"><i></i><i></i><i></i></span>
          <span class="worker-activity-text">${escapeHtml(m.activity)}</span>
        </div>
      `
      : '';

    const verifyHtml =
      m.lastVerifyResults && m.lastVerifyResults.length > 0
        ? `<div class="verify-box">${m.lastVerifyResults
            .map(
              (vr) => `
              <div>
                <div class="verify-row">
                  <span class="verify-cmd"><code>${escapeHtml(vr.command)}</code></span>
                  <span class="badge ${vr.passed ? 'badge-done' : 'badge-error'}">${escapeHtml(tr(vr.passed ? 'workers.verifyPass' : 'workers.verifyFail'))} (${vr.durationMs}ms)</span>
                </div>
                ${!vr.passed && vr.outputTail ? `<pre class="verify-tail">${escapeHtml(vr.outputTail)}</pre>` : ''}
              </div>`,
            )
            .join('')}</div>`
        : '';

    const failoverChain =
      m.failedProviders && m.failedProviders.length > 0
        ? [...m.failedProviders.filter((x) => x !== m.provider), m.provider || 'dsh'].join(' → ')
        : '';

    let elapsedHtml = '';
    if (m.lastTurnStartedAt) {
      const startMs = Date.parse(m.lastTurnStartedAt);
      if (Number.isFinite(startMs)) {
        const endMs =
          m.status === 'working'
            ? Date.now()
            : m.lastTurnFinishedAt
              ? Date.parse(m.lastTurnFinishedAt)
              : Number.NaN;
        if (Number.isFinite(endMs) && endMs >= startMs) {
          const dur = formatDurationMs(endMs - startMs);
          const label =
            m.status === 'working'
              ? tr('workers.elapsedRunning', { dur })
              : tr('workers.elapsedDone', { dur });
          const liveAttr =
            m.status === 'working' ? ` data-turn-started="${escapeHtml(m.lastTurnStartedAt)}"` : '';
          elapsedHtml = `<span class="worker-elapsed${m.status === 'working' ? ' is-live' : ''}"${liveAttr}>${escapeHtml(label)}</span>`;
        }
      }
    }

    const dm = getDisplayModelForMember(m);
    card.innerHTML = `
      <div class="worker-top">
        <div class="worker-name-wrap">
          <span class="status-dot ${escapeHtml(m.status)}"></span>
          <span class="worker-name">${escapeHtml(m.name)}</span>
          <span class="provider-badge ${providerBadgeClass(m.provider)}">${escapeHtml(m.provider || 'dsh')}</span>
          ${failoverChain ? `<span class="failover-tag" title="${escapeHtml(failoverChain)}">⚡ ${escapeHtml(tr('workers.failoverBadge', { chain: failoverChain }))}</span>` : ''}
          ${m.arenaGroup ? `<span class="arena-tag">${escapeHtml(tr('workers.arenaGroup'))}${escapeHtml(m.arenaGroup)}</span>` : ''}
          <span class="pill ${pillClass}"><span class="pill-dot"></span>${escapeHtml(statusLabel(m.status))}</span>
        </div>
        <span class="pill pill-neutral">${escapeHtml(m.role)}</span>
      </div>

      <div class="worker-meta">
        <span${dm.title ? ` title="${escapeHtml(dm.title)}"` : ''}>${escapeHtml(tr('workers.model'))}: <strong>${escapeHtml(dm.label)}</strong>${renderModelOptionBadgesHtml(m.reasoningEffort, m.fastMode, { effort: m.resolvedReasoningEffort, fast: m.resolvedFastMode })}</span>
        <span>${escapeHtml(tr('workers.turnsSteps', { turns: m.turns, steps: m.steps }))}</span>
        <span>${escapeHtml(tr('workers.perm'))}: ${escapeHtml(m.permissionMode)}</span>
        ${elapsedHtml}
      </div>

      ${depsHtml}
      ${activityHtml}

      <div class="token-meter">
        <div class="token-meter-label">
          <span>${escapeHtml(tr('workers.totalUsage', { total: formatNum(totalTok), input: formatNum(inputTok), output: formatNum(outputTok) }))}</span>
          <span>${escapeHtml(tr('workers.cacheHit', { pct: hitRate }))}</span>
        </div>
        <div class="token-bar-track">
          <div class="token-bar-cache" style="width:${hitRate}%"></div>
          <div class="token-bar-uncached" style="width:${uncachedPct}%"></div>
        </div>
      </div>

      ${wtHtml}
      ${verifyHtml}
      ${m.lastError ? `<div class="worker-error">${escapeHtml(m.lastError)}</div>` : ''}
      ${outOfScope.length > 0 ? `<div class="worker-error">${escapeHtml(tr('workers.whitelistViolation'))}${escapeHtml(outOfScope.join(', '))}</div>` : ''}
    `;

    const actions = document.createElement('div');
    actions.className = 'worker-actions';

    if (m.status !== 'killed') {
      const btnMention = document.createElement('button');
      btnMention.type = 'button';
      btnMention.className = 'btn btn-sm';
      btnMention.textContent = `@${m.name}`;
      btnMention.onclick = () => {
        bridge.switchTab('board');
        dom.composerInput.value = `@${m.name} `;
        resizeComposerInput();
        dom.composerInput.focus();
      };
      actions.appendChild(btnMention);
    }

    const btnEvents = document.createElement('button');
    btnEvents.type = 'button';
    btnEvents.className = 'btn btn-sm btn-ghost';
    btnEvents.textContent = tr('workers.events');
    btnEvents.onclick = () => void bridge.openWorkerLogs(m.name);
    actions.appendChild(btnEvents);

    if (m.workspaceMode === 'worktree' || m.branch) {
      const btnDiff = document.createElement('button');
      btnDiff.type = 'button';
      btnDiff.className = 'btn btn-sm';
      btnDiff.textContent = tr('workers.diffBtn');
      btnDiff.onclick = () => void bridge.openWorkerDiff(m.name);
      actions.appendChild(btnDiff);
    }

    if (
      m.workspaceMode === 'worktree' &&
      m.branch &&
      m.status !== 'working' &&
      m.status !== 'queued' &&
      m.status !== 'killed'
    ) {
      const btnMerge = document.createElement('button');
      btnMerge.type = 'button';
      btnMerge.className = 'btn btn-sm';
      btnMerge.textContent = tr(state.mergeOpenWorker === m.name ? 'workers.mergeCancel' : 'workers.mergeBtn');
      btnMerge.onclick = () => {
        if (state.mergeOpenWorker === m.name) {
          state.mergeOpenWorker = null;
        } else {
          state.mergeOpenWorker = m.name;
          void bridge.previewMergeFromUi(m.name);
        }
        renderWorkers(snap);
      };
      actions.appendChild(btnMerge);
    }

    if (m.status === 'failed') {
      const btnRetry = document.createElement('button');
      btnRetry.type = 'button';
      btnRetry.className = 'btn btn-sm btn-primary';
      btnRetry.textContent = tr('workers.retryBtn');
      btnRetry.onclick = () =>
        void withBusyButton(btnRetry, () => bridge.retryOrSwitchWorker({ name: m.name }));
      actions.appendChild(btnRetry);
    }

    const triggerKillConfirm = (removeWorktree: boolean) => {
      const isSame =
        state.pendingKillAction?.name === m.name && state.pendingKillAction.removeWorktree === removeWorktree;
      if (!isSame) {
        if (state.pendingKillTimer !== null) window.clearTimeout(state.pendingKillTimer);
        state.pendingKillAction = { name: m.name, removeWorktree };
        state.pendingKillTimer = window.setTimeout(() => {
          state.pendingKillAction = null;
          state.pendingKillTimer = null;
          if (state.activeTab === 'workers' && state.latestSnapshot) {
            if (isEditingInsideWorkersList()) {
              state.workersDeferredRender = true;
            } else {
              renderWorkers(state.latestSnapshot);
            }
          }
        }, 3500);
        renderWorkers(snap);
        return;
      }
      clearPendingKillState();
      void bridge.killWorkerFromUi(m.name, removeWorktree);
    };

    const hasWorktree = m.workspaceMode === 'worktree' && Boolean(m.branch);

    if (m.status !== 'killed') {
      const moreWrap = document.createElement('div');
      moreWrap.className = 'worker-more-wrap btn-kill-end';
      const menuOpen = state.openWorkerMenu === m.name;

      const btnMore = document.createElement('button');
      btnMore.type = 'button';
      btnMore.className = `btn btn-sm btn-ghost${menuOpen ? ' is-open' : ''}`;
      btnMore.textContent = '···';
      btnMore.title = tr('app.moreMenu');
      btnMore.setAttribute('aria-expanded', String(menuOpen));
      btnMore.onclick = (e) => {
        e.stopPropagation();
        state.openWorkerMenu = menuOpen ? null : m.name;
        renderWorkers(snap);
      };
      moreWrap.appendChild(btnMore);

      if (menuOpen) {
        const menu = document.createElement('div');
        menu.className = 'worker-more-menu';

        const itemReview = document.createElement('button');
        itemReview.type = 'button';
        itemReview.className = 'btn btn-sm btn-ghost topbar-menu-item';
        itemReview.textContent = tr('workers.reviewBtn');
        itemReview.onclick = () => {
          state.openWorkerMenu = null;
          void withBusyButton(itemReview, () => bridge.crossReviewFromUi(m.name));
        };
        menu.appendChild(itemReview);

        const takeoverCmd = buildTakeoverCommand(m);
        const itemTakeover = document.createElement('button');
        itemTakeover.type = 'button';
        itemTakeover.className = 'btn btn-sm btn-ghost topbar-menu-item';
        itemTakeover.textContent = tr('workers.takeoverBtn');
        itemTakeover.title = takeoverCmd;
        itemTakeover.onclick = () => {
          state.openWorkerMenu = null;
          if (navigator.clipboard?.writeText) {
            void navigator.clipboard
              .writeText(takeoverCmd)
              .then(() => showGlobalToast(tr('workers.takeoverCopiedToast', { name: m.name })))
              .catch(() => showGlobalToast(takeoverCmd));
          } else {
            showGlobalToast(takeoverCmd);
          }
          renderWorkers(snap);
        };
        menu.appendChild(itemTakeover);

        if (m.status === 'waiting' || m.status === 'failed') {
          const itemSwitch = document.createElement('button');
          itemSwitch.type = 'button';
          itemSwitch.className = 'btn btn-sm btn-ghost topbar-menu-item';
          itemSwitch.textContent = tr(
            state.switchOpenWorker === m.name ? 'workers.switchCancel' : 'workers.switchBtn',
          );
          itemSwitch.onclick = () => {
            state.openWorkerMenu = null;
            if (state.switchOpenWorker === m.name) {
              state.switchOpenWorker = null;
            } else {
              state.switchOpenWorker = m.name;
              if (!state.switchDrafts.has(m.name)) {
                state.switchDrafts.set(m.name, {
                  provider: m.provider || 'dsh',
                  model: m.model || '',
                  prompt: '',
                  reasoningEffort: m.reasoningEffort || '',
                  fastMode: boolToFastDraft(m.fastMode),
                });
              }
            }
            renderWorkers(snap);
          };
          menu.appendChild(itemSwitch);
        }

        if (hasWorktree) {
          const confirmingClean =
            state.pendingKillAction?.name === m.name && state.pendingKillAction.removeWorktree;
          const itemKillClean = document.createElement('button');
          itemKillClean.type = 'button';
          itemKillClean.className = 'btn btn-sm btn-ghost btn-ghost-danger topbar-menu-item';
          itemKillClean.textContent = confirmingClean
            ? tr('workers.confirmKillClean')
            : tr('workers.killCleanBtn');
          itemKillClean.onclick = () => {
            if (confirmingClean) state.openWorkerMenu = null;
            triggerKillConfirm(true);
          };
          menu.appendChild(itemKillClean);
        }

        moreWrap.appendChild(menu);
      }

      actions.appendChild(moreWrap);

      const confirmingKill =
        state.pendingKillAction?.name === m.name && !state.pendingKillAction.removeWorktree;
      const btnKill = document.createElement('button');
      btnKill.type = 'button';
      btnKill.className = 'btn btn-sm btn-danger';
      btnKill.textContent = confirmingKill ? tr('workers.confirmKill') : tr('workers.kill');
      btnKill.onclick = () => triggerKillConfirm(false);
      actions.appendChild(btnKill);
    } else if (hasWorktree) {
      const confirmingClean =
        state.pendingKillAction?.name === m.name && state.pendingKillAction.removeWorktree;
      const btnCleanWt = document.createElement('button');
      btnCleanWt.type = 'button';
      btnCleanWt.className = 'btn btn-sm btn-ghost btn-ghost-danger btn-kill-end';
      btnCleanWt.textContent = confirmingClean
        ? tr('workers.confirmKillClean')
        : tr('workers.cleanWtBtn');
      btnCleanWt.onclick = () => triggerKillConfirm(true);
      actions.appendChild(btnCleanWt);
    }

    card.appendChild(actions);

    if (state.switchOpenWorker === m.name && (m.status === 'waiting' || m.status === 'failed')) {
      const draft = state.switchDrafts.get(m.name) || {
        provider: m.provider || 'dsh',
        model: m.model || '',
        prompt: '',
        reasoningEffort: m.reasoningEffort || '',
        fastMode: boolToFastDraft(m.fastMode),
      };
      const allProviders =
        state.latestSnapshot?.providerConfig?.providers ||
        state.latestProviderConfig?.providers ||
        [];
      const enabledProviders = allProviders.filter((p) => p.enabled);
      const switchBox = document.createElement('div');
      switchBox.className = 'worker-switch-box';
      const provOptions = enabledProviders.length
        ? enabledProviders
            .map(
              (p) =>
                `<option value="${escapeHtml(p.id)}" ${p.id === draft.provider ? 'selected' : ''}>${escapeHtml(p.displayName)} (${escapeHtml(p.id)})</option>`,
            )
            .join('')
        : `<option value="${escapeHtml(draft.provider)}" selected>${escapeHtml(draft.provider)}</option>`;

      switchBox.innerHTML = `
        <div class="settings-form-grid">
          <label class="settings-field">
            <span>${escapeHtml(tr('workers.switchProvider'))}</span>
            <select class="input input-sm" data-sw-provider>${provOptions}</select>
          </label>
          <label class="settings-field">
            <span>${escapeHtml(tr('workers.switchModel'))}</span>
            <input class="input input-sm mono-input" type="text" list="dl-prov-models-${escapeHtml(draft.provider)}" data-sw-model value="${escapeHtml(draft.model)}" />
          </label>
          <label class="settings-field" data-sw-effort-field hidden>
            <span>${escapeHtml(tr('workers.switchEffort'))}</span>
            <select class="input input-sm" data-sw-effort></select>
          </label>
          <label class="settings-field" data-sw-fast-field hidden>
            <span>${escapeHtml(tr('workers.switchFast'))}</span>
            <select class="input input-sm" data-sw-fast></select>
          </label>
          <label class="settings-field span-2">
            <span>${escapeHtml(tr('workers.switchPrompt'))}</span>
            <input class="input input-sm" type="text" data-sw-prompt value="${escapeHtml(draft.prompt)}" />
          </label>
        </div>
        <div class="settings-add-footer">
          <button type="button" class="btn btn-sm btn-primary" data-sw-apply>${escapeHtml(tr('workers.switchApply'))}</button>
        </div>
      `;
      const provSel = switchBox.querySelector<HTMLSelectElement>('[data-sw-provider]')!;
      const modelInp = switchBox.querySelector<HTMLInputElement>('[data-sw-model]')!;
      const effortField = switchBox.querySelector<HTMLLabelElement>('[data-sw-effort-field]')!;
      const effortSel = switchBox.querySelector<HTMLSelectElement>('[data-sw-effort]')!;
      const fastField = switchBox.querySelector<HTMLLabelElement>('[data-sw-fast-field]')!;
      const fastSel = switchBox.querySelector<HTMLSelectElement>('[data-sw-fast]')!;
      const promptInp = switchBox.querySelector<HTMLInputElement>('[data-sw-prompt]')!;
      let prevSwitchProvider = draft.provider;
      const readFastSelect = () => parseFastDraftMode(fastSel.value);
      const syncSwitchOptions = (
        desiredEffort: string | undefined,
        desiredFast: 'default' | 'on' | 'off',
      ) => {
        const chosen = allProviders.find((p) => p.id === provSel.value);
        const supportsEffort = providerSupportsReasoningEffort(provSel.value, chosen);
        const supportsFast = providerSupportsFastMode(provSel.value, chosen);
        const swModel = modelInp.value.trim() || chosen?.defaultModel;
        effortField.hidden = !supportsEffort;
        if (supportsEffort) {
          syncEffortSelect({
            select: effortSel,
            efforts: getReasoningEffortOptionsForModel(chosen, swModel),
            value: desiredEffort,
            emptyLabel: formatDefaultEffortLabel(tr('cmd.followDefault'), chosen, swModel),
          });
        } else {
          effortSel.innerHTML = '';
        }
        fastField.hidden = !supportsFast;
        if (supportsFast) {
          fastSel.innerHTML = buildFastModeOptionsHtml({
            value: desiredFast,
            emptyLabel: formatDefaultFastLabel(tr('cmd.followDefault'), chosen, swModel),
          });
          fastSel.value = desiredFast;
        } else {
          fastSel.innerHTML = '';
        }
      };
      syncSwitchOptions(draft.reasoningEffort, draft.fastMode);
      const syncDraft = () => {
        state.switchDrafts.set(m.name, {
          provider: provSel.value,
          model: modelInp.value,
          prompt: promptInp.value,
          reasoningEffort: effortField.hidden ? '' : sanitizeReasoningEffort(effortSel.value) || '',
          fastMode: fastField.hidden ? 'default' : readFastSelect(),
        });
      };
      provSel.addEventListener('change', () => {
        const prevProvDesc = enabledProviders.find((p) => p.id === prevSwitchProvider);
        const chosen = enabledProviders.find((p) => p.id === provSel.value);
        modelInp.setAttribute('list', `dl-prov-models-${provSel.value}`);
        const curModel = modelInp.value.trim();
        if (
          !curModel ||
          curModel === m.model ||
          (prevProvDesc?.defaultModel && curModel === prevProvDesc.defaultModel)
        ) {
          modelInp.value = chosen?.defaultModel || '';
        }
        prevSwitchProvider = provSel.value;
        syncSwitchOptions('', 'default');
        syncDraft();
      });
      modelInp.addEventListener('input', () => {
        syncSwitchOptions(effortSel.value, readFastSelect());
        syncDraft();
      });
      effortSel.addEventListener('change', syncDraft);
      fastSel.addEventListener('change', syncDraft);
      promptInp.addEventListener('input', syncDraft);
      const swApplyBtn = switchBox.querySelector<HTMLButtonElement>('[data-sw-apply]')!;
      swApplyBtn.addEventListener('click', () => {
        void withBusyButton(swApplyBtn, async () => {
          const providerChanged = provSel.value !== (m.provider || '');
          const nextEffortStr = effortField.hidden
            ? ''
            : sanitizeReasoningEffort(effortSel.value) || '';
          const reasoningEffortArg: string | null | undefined = effortField.hidden
            ? undefined
            : nextEffortStr
              ? nextEffortStr
              : !providerChanged && m.reasoningEffort
                ? null
                : undefined;
          const nextFast = fastField.hidden ? 'default' : readFastSelect();
          const fastModeArg: boolean | null | undefined = fastField.hidden
            ? undefined
            : nextFast !== 'default'
              ? fastDraftToBool(nextFast)
              : !providerChanged && typeof m.fastMode === 'boolean'
                ? null
                : undefined;
          const ok = await bridge.retryOrSwitchWorker({
            name: m.name,
            provider: provSel.value,
            model: modelInp.value.trim() || undefined,
            prompt: promptInp.value.trim() || undefined,
            ...(reasoningEffortArg !== undefined ? { reasoningEffort: reasoningEffortArg } : {}),
            ...(fastModeArg !== undefined ? { fastMode: fastModeArg } : {}),
          });
          if (ok) {
            state.switchOpenWorker = null;
            state.switchDrafts.delete(m.name);
            if (state.latestSnapshot) {
              renderWorkers(state.latestSnapshot);
            }
          }
        });
      });
      card.appendChild(switchBox);
    }

    if (state.mergeOpenWorker === m.name && m.branch && m.status !== 'killed') {
      const previewState = state.mergePreviews.get(m.name);
      const prState = state.prResults.get(m.name);
      const draft = state.mergeDrafts.get(m.name) || {
        mode: 'squash' as const,
        removeWt: true,
        commitMsg: '',
        draftPr: false,
      };
      const mergeBox = document.createElement('div');
      mergeBox.className = 'worker-merge-box';

      let statusHtml = `<div class="empty-state-compact">${escapeHtml(tr('merge.checking'))}</div>`;
      const p = previewState?.data;
      if (previewState?.error) {
        statusHtml = `<div class="merge-status-conflict">${escapeHtml(previewState.error)}</div>`;
      } else if (p && !previewState?.loading) {
        statusHtml = p.canCleanMerge
          ? `<div class="merge-status-clean">${escapeHtml(tr('merge.clean', { commits: p.aheadCommits, files: p.changedFiles.length }))}</div>`
          : `<div class="merge-status-conflict">${escapeHtml(tr('merge.conflict'))}${escapeHtml(p.conflictFiles.join(', ') || p.conflictDetails[0] || '')}</div>`;
        if (p.dirtyFiles.length > 0) {
          statusHtml += `<div class="worker-meta">${escapeHtml(tr('merge.dirtyNote', { n: p.dirtyFiles.length }))}</div>`;
        }
        if (p.stat?.trim()) {
          statusHtml += `<pre class="merge-stat-pre">${escapeHtml(p.stat.trim())}</pre>`;
        }
      }

      const prBannerHtml = prState
        ? `<div class="pr-result-note${prState.created ? '' : ' is-error'}">${
            prState.prUrl
              ? `<span class="pr-result-text">${escapeHtml(tr('merge.prLinkLabel'))} <a href="${escapeHtml(prState.prUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(prState.prUrl)}</a></span><button type="button" class="btn btn-sm btn-ghost pr-copy-btn" data-copy-pr-url="${escapeHtml(prState.prUrl)}">${escapeHtml(tr('merge.copyPrUrl'))}</button>`
              : escapeHtml(prState.message)
          }</div>`
        : '';

      const targetBranchLabel = p?.targetBranch || 'HEAD';
      mergeBox.innerHTML = `
        <div class="merge-box-title">${escapeHtml(tr('merge.title', { branch: m.branch, target: targetBranchLabel }))}</div>
        ${statusHtml}
        <div class="merge-controls-row">
          <label class="settings-field">
            <span>${escapeHtml(tr('merge.modeLabel'))}</span>
            <select class="input input-sm" data-mg-mode>
              <option value="squash" ${draft.mode === 'squash' ? 'selected' : ''}>${escapeHtml(tr('merge.modeSquash'))}</option>
              <option value="cherry-pick" ${draft.mode === 'cherry-pick' ? 'selected' : ''}>${escapeHtml(tr('merge.modeCherryPick'))}</option>
              <option value="merge" ${draft.mode === 'merge' ? 'selected' : ''}>${escapeHtml(tr('merge.modeMerge'))}</option>
            </select>
          </label>
          <label class="checkbox-label">
            <input type="checkbox" data-mg-rm ${draft.removeWt ? 'checked' : ''} />
            <span>${escapeHtml(tr('merge.removeWt'))}</span>
          </label>
          <label class="checkbox-label">
            <input type="checkbox" data-mg-draft-pr ${draft.draftPr ? 'checked' : ''} />
            <span>${escapeHtml(tr('merge.draftPr'))}</span>
          </label>
        </div>
        <label class="settings-field">
          <span>${escapeHtml(tr('merge.commitMsgLabel'))}</span>
          <input class="input input-sm" type="text" data-mg-msg value="${escapeHtml(draft.commitMsg)}" placeholder="${escapeHtml(tr('merge.commitMsgPlaceholder'))}" />
        </label>
        ${prBannerHtml}
        <div class="settings-add-footer">
          <button type="button" class="btn btn-sm btn-ghost" data-mg-recheck ${previewState?.loading ? 'disabled' : ''}>${escapeHtml(tr('merge.recheckBtn'))}</button>
          <button type="button" class="btn btn-sm btn-ghost" data-mg-pr>${escapeHtml(tr('merge.createPrBtn'))}</button>
          <button type="button" class="btn btn-sm btn-primary" data-mg-apply ${!p || !p.canCleanMerge || previewState?.loading ? 'disabled' : ''}>${escapeHtml(tr('merge.confirmBtn'))}</button>
        </div>
      `;

      const modeSel = mergeBox.querySelector<HTMLSelectElement>('[data-mg-mode]')!;
      const rmChk = mergeBox.querySelector<HTMLInputElement>('[data-mg-rm]')!;
      const draftPrChk = mergeBox.querySelector<HTMLInputElement>('[data-mg-draft-pr]')!;
      const msgInp = mergeBox.querySelector<HTMLInputElement>('[data-mg-msg]')!;
      const mgRecheckBtn = mergeBox.querySelector<HTMLButtonElement>('[data-mg-recheck]')!;
      const mgPrBtn = mergeBox.querySelector<HTMLButtonElement>('[data-mg-pr]')!;
      const mgApplyBtn = mergeBox.querySelector<HTMLButtonElement>('[data-mg-apply]')!;
      const syncMergeDraft = () => {
        state.mergeDrafts.set(m.name, {
          mode: modeSel.value as 'squash' | 'cherry-pick' | 'merge',
          removeWt: rmChk.checked,
          commitMsg: msgInp.value,
          draftPr: draftPrChk.checked,
        });
      };
      modeSel.addEventListener('change', syncMergeDraft);
      rmChk.addEventListener('change', syncMergeDraft);
      draftPrChk.addEventListener('change', syncMergeDraft);
      msgInp.addEventListener('input', syncMergeDraft);
      mgRecheckBtn.addEventListener('click', () => {
        void withBusyButton(mgRecheckBtn, () => bridge.previewMergeFromUi(m.name));
      });
      mgPrBtn.addEventListener('click', () => {
        syncMergeDraft();
        void withBusyButton(mgPrBtn, () => bridge.createWorkerPrFromUi(m.name));
      });
      mergeBox.querySelector<HTMLButtonElement>('[data-copy-pr-url]')?.addEventListener('click', (e) => {
        const btn = e.currentTarget as HTMLButtonElement;
        const url = btn.dataset.copyPrUrl;
        if (!url) return;
        if (navigator.clipboard?.writeText) {
          void navigator.clipboard
            .writeText(url)
            .then(() => {
              btn.textContent = tr('diff.copied');
              showGlobalToast(tr('merge.prUrlCopied'));
              window.setTimeout(() => {
                btn.textContent = tr('merge.copyPrUrl');
              }, 1600);
            })
            .catch(() => showGlobalToast(url));
        } else {
          showGlobalToast(url);
        }
      });
      mgApplyBtn.addEventListener('click', () => {
        syncMergeDraft();
        void withBusyButton(mgApplyBtn, () => bridge.applyMergeFromUi(m.name));
      });
      card.appendChild(mergeBox);
    }

    extGrid.appendChild(card);
  }

  if (visibleMembers.length > 0) {
    dom.workersList.appendChild(extGrid);
  }

  let nativeRendered = 0;
  if (showNative) {
    nativeRendered = renderNativeSubagentsSection(dom.workersList, snap, {
      statusFilter: state.workerStatusFilter,
      showHeader: true,
      onScopeChange: () => renderWorkers(snap),
    });
  }

  if (visibleMembers.length === 0 && nativeRendered === 0 && dom.workersList.children.length === 0) {
    dom.workersList.innerHTML = `<div class="empty-state">${escapeHtml(tr('workers.filterEmpty'))}</div>`;
  }

  state.seenWorkerNames.clear();
  for (const m of members) {
    state.seenWorkerNames.add(m.name);
  }
}
