import * as bridge from './bridge.js';
import { tr } from './context.js';
import {
  calcInputCacheHit,
  calcModelCostValue,
  escapeHtml,
  formatDurationMs,
  formatMoney,
  formatNum,
  type CostDisplayOptions,
} from './format.js';
import { showGlobalToast, statusLabel } from './helpers.js';
import { state, type WorkerStatusFilter } from './store.js';
import { selectNativeSubagents } from './telemetry-selectors.js';
import type { NativeSubagentState, Snapshot } from './types.js';

export function matchesNativeStatusFilter(
  sub: NativeSubagentState,
  filter: WorkerStatusFilter,
): boolean {
  if (filter === 'attention') return sub.status === 'failed';
  if (filter === 'running') return sub.status === 'working';
  if (filter === 'mergeable') return false;
  return true;
}

function formatNativeActivity(sub: NativeSubagentState): string {
  if (sub.lastTool) {
    return tr('workers.nativeRunningTool', { tool: sub.lastTool });
  }
  return tr('workers.nativeThinking');
}

export function renderNativeSubagentsSection(
  container: HTMLElement,
  snap: Snapshot,
  opts: {
    statusFilter: WorkerStatusFilter;
    showHeader: boolean;
    onScopeChange: () => void;
  },
): number {
  const allNative = snap.hostTelemetry?.subagents || [];
  const conversations = snap.hostTelemetry?.availableConversations || [];
  const hasSubagentConvs = conversations.some((c) => c.subagentCount > 0);
  const currentNative = selectNativeSubagents(snap, 'current');
  const scoped = selectNativeSubagents(snap, state.nativeScopeFilter);
  const visible = scoped.filter((s) => matchesNativeStatusFilter(s, opts.statusFilter));

  if (allNative.length === 0 && !hasSubagentConvs) {
    return 0;
  }

  const section = document.createElement('div');
  section.className = 'native-workers-section';

  if (opts.showHeader) {
    const convSelectHtml =
      conversations.length > 1
        ? `<select class="conv-select workers-conv-select" data-workers-conv-select aria-label="${escapeHtml(tr('usage.convLabel'))}">${conversations
            .map((c) => {
              const label =
                c.subagentCount > 0
                  ? `${c.title} · ${tr('usage.convSubCount', { n: c.subagentCount })}`
                  : c.title;
              const selected = c.id === snap.hostTelemetry?.conversationId ? ' selected' : '';
              return `<option value="${escapeHtml(c.id)}"${selected}>${escapeHtml(label)}</option>`;
            })
            .join('')}</select>`
        : '';

    const scopeHtml =
      allNative.length > 0
        ? `
          <div class="native-scope-pills" role="group">
            <button type="button" class="chip-btn${state.nativeScopeFilter === 'current' ? ' active' : ''}" data-native-scope="current">
              ${escapeHtml(tr('workers.nativeWaveCurrent', { n: currentNative.length }))}
            </button>
            <button type="button" class="chip-btn${state.nativeScopeFilter === 'all' ? ' active' : ''}" data-native-scope="all">
              ${escapeHtml(tr('workers.nativeWaveAll', { n: allNative.length }))}
            </button>
          </div>
        `
        : '';

    const header = document.createElement('div');
    header.className = 'workers-section-header';
    header.innerHTML = `
      <div class="workers-section-title-group">
        <span class="workers-section-title">${escapeHtml(tr('workers.nativeSectionTitle'))}</span>
        <span class="provider-badge prov-native">${escapeHtml(tr('workers.nativeBadge'))}</span>
        <span class="pill readonly-pill">${escapeHtml(tr('workers.readonlyBadge'))}</span>
      </div>
      <div class="workers-section-controls">
        ${convSelectHtml}
        ${scopeHtml}
      </div>
    `;
    header.querySelector<HTMLSelectElement>('[data-workers-conv-select]')?.addEventListener('change', (e) => {
      const sel = e.currentTarget as HTMLSelectElement;
      if (sel.value) void bridge.bindConversationFromUi(sel.value);
    });
    header.querySelectorAll<HTMLButtonElement>('[data-native-scope]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = btn.dataset.nativeScope as 'current' | 'all' | undefined;
        if (!next || next === state.nativeScopeFilter) return;
        state.nativeScopeFilter = next;
        opts.onScopeChange();
      });
    });
    section.appendChild(header);
  }

  if (allNative.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'empty-state-compact';
    emptyEl.textContent = tr('workers.nativeEmpty');
    section.appendChild(emptyEl);
    container.appendChild(section);
    return 0;
  }

  if (visible.length === 0) {
    const hiddenCount = Math.max(0, allNative.length - currentNative.length);
    const emptyMsg =
      state.nativeScopeFilter === 'current' && hiddenCount > 0 && opts.statusFilter === 'all'
        ? tr('workers.nativeHistoryHidden', { n: hiddenCount })
        : tr('workers.filterEmpty');
    const emptyEl = document.createElement('div');
    emptyEl.className = 'empty-state-compact';
    emptyEl.textContent = emptyMsg;
    section.appendChild(emptyEl);
    container.appendChild(section);
    return 0;
  }

  const providerCfg = snap.providerConfig || state.latestProviderConfig;
  const pricingMap = providerCfg?.pricing;
  const catalogPricing = providerCfg?.pricingCatalog;
  const displayOpts: CostDisplayOptions = {
    displayCurrency: providerCfg?.displayCurrency,
    usdToCnyRate: providerCfg?.usdToCnyRate,
  };

  const grid = document.createElement('div');
  grid.className = 'workers-list';

  for (const sub of visible) {
    const card = document.createElement('div');
    card.className = `worker-card is-native${sub.status === 'working' ? ' is-working' : ''}`;

    const useSwarmUsage = Boolean(snap.swarm) && state.usageScope === 'swarm' && sub.inCurrentSwarm;
    const u = useSwarmUsage ? sub.usageSinceSwarm : sub.usage;
    const inputTok = u.inputTokens || 0;
    const cacheTok = u.cacheReadTokens || 0;
    const outputTok = u.outputTokens || 0;
    const totalTok = u.totalTokens || inputTok + cacheTok + outputTok;
    const hitRate = calcInputCacheHit(inputTok, cacheTok);
    const uncachedPct = inputTok + cacheTok > 0 ? Math.max(0, 100 - hitRate) : 0;

    const costVal = calcModelCostValue(
      sub.model,
      inputTok,
      cacheTok,
      outputTok,
      pricingMap,
      catalogPricing,
      displayOpts,
    );

    const pillClass =
      sub.status === 'working'
        ? 'pill-working'
        : sub.status === 'waiting'
          ? 'pill-waiting'
          : sub.status === 'failed'
            ? 'pill-failed'
            : 'pill-neutral';

    let elapsedHtml = '';
    if (sub.lastTurnStartedAt) {
      const startMs = Date.parse(sub.lastTurnStartedAt);
      if (Number.isFinite(startMs)) {
        const endMs =
          sub.status === 'working'
            ? Date.now()
            : sub.lastTurnFinishedAt
              ? Date.parse(sub.lastTurnFinishedAt)
              : Date.parse(sub.updatedAt);
        if (Number.isFinite(endMs) && endMs >= startMs) {
          const dur = formatDurationMs(endMs - startMs);
          const label =
            sub.status === 'working'
              ? tr('workers.elapsedRunning', { dur })
              : tr('workers.elapsedDone', { dur });
          const liveAttr =
            sub.status === 'working'
              ? ` data-turn-started="${escapeHtml(sub.lastTurnStartedAt)}"`
              : '';
          elapsedHtml = `<span class="worker-elapsed${sub.status === 'working' ? ' is-live' : ''}"${liveAttr}>${escapeHtml(label)}</span>`;
        }
      }
    }

    const activityHtml =
      sub.status === 'working'
        ? `
        <div class="worker-activity-row is-native">
          <span class="eq-bars" aria-hidden="true"><i></i><i></i><i></i></span>
          <span class="worker-activity-text">${escapeHtml(formatNativeActivity(sub))}</span>
        </div>
      `
        : '';

    const replyHtml = sub.lastReplyPreview
      ? `
        <div class="native-reply-box">
          <div class="native-reply-meta">
            <span>${escapeHtml(tr('workers.nativeReplies', { toParent: sub.messagesToParent, fromParent: sub.messagesFromParent }))}</span>
            ${sub.spawnStepIndex > 0 ? `<span>${escapeHtml(tr('workers.nativeWaveTag', { step: sub.spawnStepIndex }))}</span>` : ''}
          </div>
          <div class="native-reply-text">${escapeHtml(sub.lastReplyPreview)}</div>
        </div>
      `
      : '';

    card.innerHTML = `
      <div class="worker-top">
        <div class="worker-name-wrap">
          <span class="status-dot ${escapeHtml(sub.status)}"></span>
          <span class="worker-name">${escapeHtml(sub.role)}</span>
          <span class="provider-badge prov-native">${escapeHtml(tr('workers.nativeBadge'))}</span>
          <span class="pill pill-neutral">${escapeHtml(sub.typeName)}</span>
          <span class="pill ${pillClass}"><span class="pill-dot"></span>${escapeHtml(statusLabel(sub.status))}</span>
        </div>
        <span class="pill readonly-pill">${escapeHtml(tr('workers.readonlyBadge'))}</span>
      </div>

      <div class="worker-meta">
        <span>${escapeHtml(tr('workers.model'))}: <strong>${escapeHtml(sub.model)}</strong></span>
        <span>${escapeHtml(tr('workers.turnsSteps', { turns: sub.turns, steps: sub.steps }))}</span>
        <span>ID: <code>${escapeHtml(sub.shortId)}</code></span>
        ${elapsedHtml}
      </div>

      ${activityHtml}

      <div class="token-meter">
        <div class="token-meter-label">
          <span>${escapeHtml(tr('workers.totalUsage', { total: formatNum(totalTok), input: formatNum(inputTok), output: formatNum(outputTok) }))}${costVal ? ` · <strong>${escapeHtml(formatMoney(costVal.amount, costVal.currency))}</strong>` : ''}</span>
          <span>${escapeHtml(tr('workers.cacheHit', { pct: hitRate }))}</span>
        </div>
        <div class="token-bar-track">
          <div class="token-bar-cache" style="width:${hitRate}%"></div>
          <div class="token-bar-uncached" style="width:${uncachedPct}%"></div>
        </div>
      </div>

      ${replyHtml}
      ${sub.lastError ? `<div class="worker-error">${escapeHtml(sub.lastError)}</div>` : ''}
    `;

    const actions = document.createElement('div');
    actions.className = 'worker-actions';

    const btnTrace = document.createElement('button');
    btnTrace.type = 'button';
    btnTrace.className = 'btn btn-sm btn-ghost';
    btnTrace.textContent = tr('workers.nativeTrace');
    btnTrace.onclick = () => void bridge.openNativeSubagentLogs(sub.id, sub.role);
    actions.appendChild(btnTrace);

    const btnCopyId = document.createElement('button');
    btnCopyId.type = 'button';
    btnCopyId.className = 'btn btn-sm btn-ghost';
    btnCopyId.textContent = tr('workers.nativeCopyId');
    btnCopyId.onclick = () => {
      if (navigator.clipboard?.writeText) {
        void navigator.clipboard
          .writeText(sub.id)
          .then(() => showGlobalToast(tr('workers.nativeIdCopied', { id: sub.shortId })))
          .catch(() => showGlobalToast(sub.id));
      } else {
        showGlobalToast(sub.id);
      }
    };
    actions.appendChild(btnCopyId);

    card.appendChild(actions);
    grid.appendChild(card);
  }

  section.appendChild(grid);

  if (state.nativeScopeFilter === 'current' && allNative.length > currentNative.length) {
    const hint = document.createElement('div');
    hint.className = 'native-history-hint';
    hint.textContent = tr('workers.nativeHistoryHidden', {
      n: allNative.length - currentNative.length,
    });
    section.appendChild(hint);
  }

  container.appendChild(section);
  return visible.length;
}
