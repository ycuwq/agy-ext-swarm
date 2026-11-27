/**
 * AGY Ext Swarm board UI — esbuild bundle entrypoint (see build.mjs).
 *
 * The former ~6.3k LOC monolith is decomposed into focused modules:
 *   dom.ts              typed DOM lookups (single source of truth for ids)
 *   store.ts            shared mutable UI state
 *   context.ts          locale-bound translation helper
 *   bridge.ts           typed registry for entrypoint-owned callbacks
 *   helpers.ts          pure helpers, HTML builders, toasts
 *   board-view.ts       board feed, log/diff drawers + their listeners
 *   commander.ts        commander panels, merge/cross-review + their listeners
 *   graph-view.ts       topology SVG graph + replay transport
 *   workers-view.ts     arena boards + workers card list
 *   usage-view.ts       token/cache telemetry + pricing
 *   onboarding-view.ts  first-run wizard
 *   settings-view.ts    settings, provider cards, routing matrix
 *
 * This file keeps MCP App wiring, tool calls, top-level event listeners and boot().
 */
import { applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import * as dom from './dom.js';
import { tr } from './context.js';
import { escapeHtml, formatDurationMs, formatNum } from './format.js';
import { animateNumber, armDoubleClickConfirm, bindTabKeyboardNavigation, clearPendingKillState, computeBoardSignature, computeSignature, copyTextWithToast, extractToolErrorMessage, formatMemberModelWithOptions, getButtonLabel, isEditingInsideWorkersList, resizeComposerInput, setBadgeText, setButtonLabel, showCommanderToast, showGlobalToast, statusLabel, syncSelectOptions } from './helpers.js';
import { detectDefaultLocale, type I18nKey } from './i18n.js';
import { bindGraphEvents, renderGraphAndReplay, stepReplay, stopReplayPlayback } from './graph-view.js';
import { initUiBridge } from './bridge.js';
import { app } from './mcp-app.js';
import { computeTelemetrySummary, formatWorkersTabBadge } from './telemetry-selectors.js';
import {
  bindOnboardingEvents,
  initOnboardingDraft,
  renderOnboardingWizard,
  shouldShowOnboarding,
} from './onboarding-view.js';
import {
  bindSettingsEvents,
  loadProviderConfig,
  renderSettingsView,
} from './settings-view.js';
import { state } from './store.js';
import type { Snapshot, SwarmIndexEntry } from './types.js';
import { bindUsageEvents, renderUsageView } from './usage-view.js';
import { renderWorkers } from './workers-view.js';
import {
  bindBoardEvents,
  isLogRequestPending,
  openNativeSubagentLogs,
  openWorkerDiff,
  openWorkerLogs,
  renderBoard,
  renderDiffDrawerBody,
  renderLogDrawerBody,
  renderMentionQuickbar,
  renderParticipantChips,
} from './board-view.js';
import {
  applyMergeFromUi,
  bindCommanderEvents,
  createWorkerPrFromUi,
  crossReviewFromUi,
  isEditingInsideCommanderPanels,
  previewMergeFromUi,
  syncCommanderControls,
  toggleCommanderPanel,
  updateSwarmBudgetFromUi,
} from './commander.js';

function closeTopbarMoreMenu(): void {
  dom.topbarMoreMenu.classList.add('hidden');
  dom.btnTopbarMore.setAttribute('aria-expanded', 'false');
}

function resetSwarmScopedUiState(closeCommander = true): void {
  state.pendingDeleteSwarm = false;
  if (state.deleteSwarmTimer !== null) {
    window.clearTimeout(state.deleteSwarmTimer);
    state.deleteSwarmTimer = null;
  }
  setButtonLabel(dom.btnDeleteSwarm, tr('app.deleteSwarm'));
  clearPendingKillState();
  state.selectedAgentFilter = null;
  state.replaySeq = null;
  state.expandedSeqs.clear();
  state.seenSeqs.clear();
  state.seenWorkerNames.clear();
  state.prevGaugePcts.clear();
  state.initialBoardLoaded = false;
  state.lastRenderSignature = '';
  state.lastBoardSignature = '';
  state.lastCommanderConfigSignature = '';
  state.switchOpenWorker = null;
  state.switchDrafts.clear();
  state.addProvidersDraft.clear();
  state.openWorkerMenu = null;
  state.workerStatusFilter = 'all';
  state.mergeOpenWorker = null;
  state.mergePreviews.clear();
  state.mergeDrafts.clear();
  state.prResults.clear();
  state.workersDeferredRender = false;
  state.commanderDeferredSync = false;
  state.activeLogTarget = null;
  state.cachedLogLines = [];
  dom.logDrawer.classList.add('hidden');
  state.activeDiffWorker = null;
  state.cachedDiffData = null;
  state.diffComments = [];
  state.activeDiffCommentTarget = null;
  dom.diffDrawer.classList.add('hidden');
  dom.diffDrawerFooter.classList.add('hidden');
  stopReplayPlayback();
  if (closeCommander && (state.activeCommanderPanel === 'add' || state.activeCommanderPanel === 'arena')) {
    toggleCommanderPanel(null);
  }
}

function applyStaticI18n(): void {
  document.documentElement.lang = state.currentLocale === 'zh' ? 'zh-CN' : 'en';
  dom.btnLang.textContent = state.currentLocale === 'zh' ? '🌐 English' : '🌐 中文';

  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n as I18nKey | undefined;
    if (key) el.textContent = tr(key);
  });

  document
    .querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-i18n-placeholder]')
    .forEach((el) => {
      const key = el.dataset.i18nPlaceholder as I18nKey | undefined;
      if (key) el.placeholder = tr(key);
    });

  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    const key = el.dataset.i18nTitle as I18nKey | undefined;
    if (key) el.title = tr(key);
  });

  document.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
    const key = el.getAttribute('data-i18n-aria-label') as I18nKey | null;
    if (key) el.setAttribute('aria-label', tr(key));
  });

  dom.replayPlayBtn.textContent = state.replayPlaying ? tr('graph.pause') : tr('graph.play');
  if (state.activeLogTarget) {
    dom.logDrawerTitle.textContent =
      state.activeLogTarget.kind === 'native'
        ? tr('drawer.titleNativeFor', { name: state.activeLogTarget.label })
        : tr('drawer.titleFor', { name: state.activeLogTarget.name });
    renderLogDrawerBody();
  }
  if (state.activeDiffWorker) {
    dom.diffDrawerTitle.textContent = tr('diff.titleFor', { name: state.activeDiffWorker });
    if (!state.activeDiffCommentTarget) {
      renderDiffDrawerBody();
    }
  }
  dom.btnTogglePricing.textContent = tr(state.pricingExpanded ? 'settings.collapse' : 'settings.expand');
  setButtonLabel(
    dom.btnDeleteSwarm,
    tr(state.pendingDeleteSwarm ? 'app.confirmDeleteSwarm' : 'app.deleteSwarm'),
  );
  dom.cmdKillAll.textContent = tr(state.pendingKillAll ? 'workers.confirmKillAll' : 'workers.killAllBtn');
  if (!state.latestSnapshot?.swarm) {
    dom.composerInput.placeholder = tr('board.composerDisabled');
  }
  if (state.onboardingVisible) {
    renderOnboardingWizard();
  }
  updateTabInk();
}

function updateTabInk(): void {
  const activeBtn = dom.tabsNav.querySelector<HTMLButtonElement>('.tab.active');
  if (!activeBtn) return;
  dom.tabInk.style.width = `${activeBtn.offsetWidth}px`;
  dom.tabInk.style.transform = `translateX(${activeBtn.offsetLeft}px)`;
}

function applyHostContext(): void {
  const ctx = app.getHostContext();
  if (ctx?.theme) {
    applyDocumentTheme(ctx.theme);
  }
  if (ctx?.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
  if (!state.localeOverriddenByUser && ctx?.locale) {
    const detected = detectDefaultLocale(ctx.locale);
    if (detected !== state.currentLocale) {
      state.currentLocale = detected;
      applyStaticI18n();
    }
  }
}

function renderSnapshot(snap: Snapshot, force = false): void {
  if (!state.localeOverriddenByUser && snap.uiPrefs?.locale && snap.uiPrefs.locale !== state.currentLocale) {
    state.currentLocale = snap.uiPrefs.locale;
    applyStaticI18n();
  }

  const prevSnap = state.latestSnapshot;
  state.latestSnapshot = snap;
  if (snap.templatesConfig) {
    state.latestTemplatesConfig = snap.templatesConfig;
  }
  if (snap.providerConfig) {
    const enabledCount = snap.providerConfig.providers.filter((p) => p.enabled).length;
    setBadgeText(dom.badgeSettingsClis, `${enabledCount}/${snap.providerConfig.providers.length}`);
    const previousConfig = state.latestProviderConfig;
    const envById = new Map(
      previousConfig?.repoConfigPath === snap.providerConfig.repoConfigPath
        ? previousConfig?.providers.map((p) => [p.id, p.env] as const)
        : undefined,
    );
    state.latestProviderConfig = {
      ...snap.providerConfig,
      providers: snap.providerConfig.providers.map((provider) => {
        const env = provider.env ?? envById.get(provider.id);
        return env ? { ...provider, env } : provider;
      }),
    };
    if (!previousConfig && state.activeTab === 'settings') {
      renderSettingsView();
    }
    const poolBaseline = `${(snap.providerConfig.activePool || []).join(',')}|${snap.providerConfig.providers.filter((p) => p.enabled).map((p) => p.id).join(',')}|${snap.providerConfig.routingPolicy?.autoFailover ? 1 : 0}`;
    if (poolBaseline !== state.lastKnownPoolBaseline) {
      state.lastKnownPoolBaseline = poolBaseline;
      if (state.activeCommanderPanel !== 'create') {
        state.createPoolDraft = null;
      }
    }
  }
  const hasSwarm = Boolean(snap.swarm);
  dom.btnExportSwarm.classList.toggle('hidden', !hasSwarm);
  dom.btnDeleteSwarm.classList.toggle('hidden', !hasSwarm);
  dom.btnSendSummary.disabled = !hasSwarm;

  const nextOnboardingVisible = shouldShowOnboarding(snap);
  const wasOnboardingVisible = state.onboardingVisible;
  state.onboardingVisible = nextOnboardingVisible;
  dom.onboardingHost.classList.toggle('hidden', !state.onboardingVisible);
  const hideBoardChrome = !hasSwarm || state.onboardingVisible;
  dom.boardToolbar?.classList.toggle('hidden', hideBoardChrome);
  dom.composerWrap?.classList.toggle('hidden', hideBoardChrome);
  if (state.onboardingVisible && !wasOnboardingVisible) {
    if (state.latestProviderConfig && !state.onboardingDraftInitialized) {
      initOnboardingDraft(state.latestProviderConfig, false);
    }
    if (state.latestProviderConfig) {
      renderOnboardingWizard();
    }
    void loadProviderConfig().then(() => {
      if (state.onboardingVisible) {
        if (state.latestProviderConfig && !state.onboardingDraftInitialized) {
          initOnboardingDraft(state.latestProviderConfig, false);
        }
        renderOnboardingWizard();
      }
    });
  } else if (state.onboardingVisible && state.latestProviderConfig && !state.onboardingDraftInitialized) {
    initOnboardingDraft(state.latestProviderConfig, false);
  }

  syncCommanderControls(force);
  const sig = computeSignature(snap);
  if (!force && sig === state.lastRenderSignature) {
    updateLiveWorkerElapsedBadges();
    return;
  }
  state.lastRenderSignature = sig;

  const swarms = snap.swarms || [];
  syncSelectOptions(
    dom.swarmSelect,
    swarms.length ? swarms.map(({ id, title }) => [id, title]) : [['', tr('swarm.noneOption')]],
    state.currentSwarmId,
  );

  const swarm = snap.swarm;
  const summary = computeTelemetrySummary(snap, state.usageScope);
  const prevSummary = prevSnap ? computeTelemetrySummary(prevSnap, state.usageScope) : null;

  setBadgeText(
    dom.badgeUsageHit,
    summary.combinedTotalTokens > 0 ? `${summary.combinedCacheHitRate}%` : '--',
  );
  setBadgeText(
    dom.countWorkers,
    formatWorkersTabBadge(summary.externalCount, summary.nativeCurrent.length),
  );
  dom.countWorkers.title =
    summary.nativeCurrent.length > 0
      ? tr('workers.tabTooltip', {
          total: summary.totalWorkers,
          external: summary.externalCount,
          native: summary.nativeCurrent.length,
        })
      : '';

  if (!swarm) {
    state.seenWorkerNames.clear();
    if (summary.nativeAll.length === 0) {
      state.prevGaugePcts.clear();
    }
    dom.topbar.classList.toggle('is-active', summary.nativeRunning > 0);
    if (summary.nativeRunning > 0) {
      dom.livePill.className = 'pill pill-working';
      dom.livePillText.textContent = tr('status.runningCount', { n: summary.nativeRunning });
    } else if (summary.nativeFailed > 0) {
      dom.livePill.className = 'pill pill-failed';
      dom.livePillText.textContent = tr('status.failedCount', { n: summary.nativeFailed });
    } else if (summary.nativeCurrent.length > 0) {
      dom.livePill.className = 'pill pill-waiting';
      dom.livePillText.textContent = tr('status.idle');
    } else {
      dom.livePill.className = 'pill pill-neutral';
      dom.livePillText.textContent = tr('status.empty');
    }

    if (summary.nativeCurrent.length > 0) {
      dom.metaSummary.innerHTML = `<span class="kpi-item">${escapeHtml(
        tr('swarm.emptyTelemetryNative', {
          n: summary.nativeCurrent.length,
          running: summary.nativeRunning,
          total: formatNum(summary.coordinator.totalTokens),
          hit: summary.coordinator.cacheHitRate,
        }),
      )}</span>`;
    } else if (summary.coordinator.totalTokens > 0) {
      dom.metaSummary.innerHTML = `<span class="kpi-item">${escapeHtml(
        tr('swarm.emptyTelemetryMain', {
          total: formatNum(summary.coordinator.totalTokens),
          hit: summary.coordinator.cacheHitRate,
        }),
      )}</span>`;
    } else {
      dom.metaSummary.innerHTML = `<span class="kpi-item">${escapeHtml(tr('swarm.emptyTelemetry'))}</span>`;
    }

    setBadgeText(dom.countBoard, '0');
    setBadgeText(dom.countEdges, String(summary.nativeCurrent.length));
    dom.agentChips.innerHTML = '';
    dom.mentionQuickbar.innerHTML = '';
    dom.composerInput.disabled = true;
    dom.composerSend.disabled = true;
    dom.composerInput.placeholder = tr('board.composerDisabled');
    dom.composerWrap?.classList.add('is-disabled');
    if (state.onboardingVisible) {
      dom.boardFeed.innerHTML = '';
    } else {
      const readyClis = (
        snap.providerConfig?.providers ||
        state.latestProviderConfig?.providers ||
        []
      ).filter((p) => p.enabled && p.available);
      const cliStripHtml =
        readyClis.length > 0
          ? `<div class="empty-cli-strip">${escapeHtml(tr('board.emptyCliReady', { list: readyClis.map((p) => p.id).join(', ') }))}</div>`
          : `<div class="empty-cli-strip is-warn">${escapeHtml(tr('board.emptyCliNone'))}</div>`;
      dom.boardFeed.innerHTML = `
        <div class="empty-onboarding">
          <div class="empty-onboarding-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="12 2 20 6.5 20 17.5 12 22 4 17.5 4 6.5" />
              <circle cx="12" cy="12" r="2.3" fill="currentColor" stroke="none" />
              <line x1="12" y1="2" x2="12" y2="9.7" />
              <line x1="20" y1="17.5" x2="13.9" y2="13.1" />
              <line x1="4" y1="17.5" x2="10.1" y2="13.1" />
            </svg>
          </div>
          <div class="empty-onboarding-title">${escapeHtml(tr('board.emptySwarm'))}</div>
          <div class="empty-onboarding-hint">${escapeHtml(tr('board.emptyHint'))}</div>
          ${cliStripHtml}
          <div class="empty-onboarding-actions">
            <button type="button" class="btn btn-sm btn-primary" data-empty-action="create">${escapeHtml(tr('board.emptyCreateBtn'))}</button>
            <button type="button" class="btn btn-sm" data-empty-action="templates">${escapeHtml(tr('board.emptyTemplateBtn'))}</button>
            <button type="button" class="btn btn-sm" data-empty-action="onboarding">${escapeHtml(tr('board.emptyOnboardingBtn'))}</button>
            <button type="button" class="btn btn-sm btn-ghost" data-empty-action="settings">${escapeHtml(tr('board.emptySettingsBtn'))}</button>
          </div>
        </div>
      `;
    }
    dom.arenaBoards.innerHTML = '';
    dom.workersBudgetBanner.innerHTML = '';
    dom.workersBudgetBanner.classList.add('hidden');
    if (summary.nativeAll.length > 0 || (snap.hostTelemetry?.availableConversations || []).some((c) => c.subagentCount > 0)) {
      state.dirtyTabs.add('workers');
      state.dirtyTabs.add('graph');
      state.dirtyTabs.add('usage');
      renderActiveDataTab(snap, force);
    } else {
      dom.workersFilterBar.classList.add('hidden');
      dom.workersFilterBar.innerHTML = '';
      dom.workersList.innerHTML = `<div class="empty-state">${escapeHtml(tr('workers.empty'))}</div>`;
      renderGraphAndReplay(snap);
      renderUsageView(snap, prevSnap);
      state.prevSnapForUsage = snap;
      state.dirtyTabs.clear();
    }
    updateTabInk();
    return;
  }

  dom.composerInput.disabled = false;
  dom.composerSend.disabled = false;
  dom.composerInput.placeholder = tr('board.composerPlaceholder');
  dom.composerWrap?.classList.remove('is-disabled');

  dom.topbar.classList.toggle('is-active', summary.totalRunning > 0);

  if (summary.totalRunning > 0) {
    dom.livePill.className = 'pill pill-working';
    dom.livePillText.textContent = tr('status.runningCount', { n: summary.totalRunning });
  } else if (summary.totalFailed > 0) {
    dom.livePill.className = 'pill pill-failed';
    dom.livePillText.textContent = tr('status.failedCount', { n: summary.totalFailed });
  } else {
    dom.livePill.className = 'pill pill-waiting';
    dom.livePillText.textContent = tr('status.idle');
  }

  const prevDshTokens = prevSummary?.external.totalTokens || 0;
  const prevNativeTokens = prevSummary?.native.totalTokens || 0;
  const prevAgyTokens = prevSummary?.coordinator.totalTokens || 0;

  const formatShortTimeout = (sec: number): string => {
    if (sec === 0) return tr('common.off');
    if (sec >= 60 && sec % 60 === 0) return `${sec / 60}m`;
    return `${sec}s`;
  };
  const timeoutTitle = tr('kpi.timeoutsTitle', {
    concurrency: swarm.maxConcurrency,
    turn: swarm.turnTimeoutSeconds === 0 ? tr('common.off') : `${swarm.turnTimeoutSeconds}s`,
    stall: swarm.stallTimeoutSeconds === 0 ? tr('common.off') : `${swarm.stallTimeoutSeconds}s`,
  });

  const nativeHint =
    summary.nativeRunning > 0 ? ` ${tr('kpi.nativeHint', { n: summary.nativeRunning })}` : '';
  const showNativeKpi = summary.nativeCurrent.length > 0 || summary.native.totalTokens > 0;

  dom.metaSummary.innerHTML = `
    <span class="kpi-item">${escapeHtml(tr('kpi.running'))} <span class="kpi-val">${summary.totalRunning}</span>${nativeHint ? `<span class="kpi-sub">${escapeHtml(nativeHint)}</span>` : ''}</span>
    <span class="kpi-sep">·</span>
    <span class="kpi-item">${escapeHtml(tr('kpi.waiting'))} <span class="kpi-val">${summary.totalWaiting}</span></span>
    ${summary.totalFailed > 0 ? `<span class="kpi-sep">·</span><span class="kpi-item">${escapeHtml(tr('kpi.failed'))} <span class="kpi-val">${summary.totalFailed}</span></span>` : ''}
    ${swarm.activeProviders && swarm.activeProviders.length > 1 ? `<span class="kpi-sep">·</span><span class="kpi-item">${escapeHtml(tr('kpi.pool'))} <span class="kpi-val">${swarm.activeProviders.length}</span>${swarm.routingPolicy?.autoFailover ? ` (${escapeHtml(tr('kpi.failover'))})` : ''}</span>` : ''}
    <span class="kpi-sep">·</span>
    <span class="kpi-item">${escapeHtml(tr('kpi.hops'))} <span class="kpi-val">${swarm.hopCount}/${swarm.maxHops}</span></span>
    <span class="kpi-sep">·</span>
    <span class="kpi-item" title="${escapeHtml(timeoutTitle)}">${escapeHtml(tr('kpi.timeouts'))} <span class="kpi-val">${escapeHtml(formatShortTimeout(swarm.turnTimeoutSeconds))}/${escapeHtml(formatShortTimeout(swarm.stallTimeoutSeconds))}</span></span>
    <span class="kpi-sep">·</span>
    <span class="kpi-item">${escapeHtml(tr('kpi.workers'))} <span class="kpi-val" id="kpi-dsh-tok">${formatNum(summary.external.totalTokens)}</span> (${escapeHtml(tr('kpi.hit'))} ${summary.external.cacheHitRate}%)</span>
    ${showNativeKpi ? `<span class="kpi-sep">·</span><span class="kpi-item">${escapeHtml(tr('kpi.nativeSubagents'))} <span class="kpi-val" id="kpi-native-tok">${formatNum(summary.native.totalTokens)}</span> (${escapeHtml(tr('kpi.hit'))} ${summary.native.cacheHitRate}%)</span>` : ''}
    <span class="kpi-sep">·</span>
    <span class="kpi-item">${escapeHtml(tr('kpi.mainModel'))} <span class="kpi-val" id="kpi-agy-tok">${formatNum(summary.coordinator.totalTokens)}</span> (${escapeHtml(tr('kpi.hit'))} ${summary.coordinator.cacheHitRate}%)</span>
  `;

  animateNumber(
    document.getElementById('kpi-dsh-tok'),
    prevDshTokens,
    summary.external.totalTokens,
    formatNum,
  );
  if (showNativeKpi) {
    animateNumber(
      document.getElementById('kpi-native-tok'),
      prevNativeTokens,
      summary.native.totalTokens,
      formatNum,
    );
  }
  animateNumber(
    document.getElementById('kpi-agy-tok'),
    prevAgyTokens,
    summary.coordinator.totalTokens,
    formatNum,
  );

  setBadgeText(dom.countBoard, String(snap.messages.length));
  setBadgeText(dom.countEdges, String(snap.edges.length + summary.nativeCurrent.length));

  state.dirtyTabs.add('board');
  state.dirtyTabs.add('graph');
  state.dirtyTabs.add('workers');
  state.dirtyTabs.add('usage');
  renderActiveDataTab(snap, force);
  updateTabInk();
}

function updateLiveWorkerElapsedBadges(): void {
  if (state.activeTab !== 'workers') return;
  const now = Date.now();
  dom.workersList.querySelectorAll<HTMLElement>('.worker-elapsed.is-live[data-turn-started]').forEach((el) => {
    const started = el.dataset.turnStarted;
    if (!started) return;
    const startMs = Date.parse(started);
    if (!Number.isFinite(startMs) || now < startMs) return;
    const label = tr('workers.elapsedRunning', { dur: formatDurationMs(now - startMs) });
    if (el.textContent !== label) {
      el.textContent = label;
    }
  });
}

function renderActiveDataTab(snap: Snapshot, force = false): void {
  const swarm = snap.swarm;
  const members = swarm ? Object.values(swarm.members || {}) : [];
  if (state.activeTab === 'board') {
    if (!swarm) return;
    const boardSig = computeBoardSignature(snap);
    if (force || boardSig !== state.lastBoardSignature) {
      renderParticipantChips(members);
      renderMentionQuickbar(members);
      renderBoard(snap.messages);
      state.lastBoardSignature = boardSig;
    }
    state.dirtyTabs.delete('board');
  } else if (state.activeTab === 'workers') {
    if (state.workersPointerDown || (!force && isEditingInsideWorkersList())) {
      state.workersDeferredRender = true;
      return;
    }
    state.workersDeferredRender = false;
    renderWorkers(snap);
    state.dirtyTabs.delete('workers');
  } else if (state.activeTab === 'graph') {
    renderGraphAndReplay(snap);
    state.dirtyTabs.delete('graph');
  } else if (state.activeTab === 'usage') {
    renderUsageView(snap, state.prevSnapForUsage);
    state.prevSnapForUsage = snap;
    state.dirtyTabs.delete('usage');
  }
}

async function killWorkerFromUi(name: string, removeWorktree = false): Promise<void> {
  try {
    const res = await app.callServerTool({
      name: 'app_kill_worker',
      arguments: {
        ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
        name,
        remove_worktree: removeWorktree,
      },
    });
    const errMsg = extractToolErrorMessage(res);
    if (errMsg) {
      showGlobalToast(tr('workers.killFailed', { err: errMsg }), true);
      return;
    }
    if (name === 'all') {
      showGlobalToast(tr('workers.killAllSuccess'));
    } else {
      showGlobalToast(tr(removeWorktree ? 'workers.killCleanSuccess' : 'workers.killSuccess', { name }));
    }
    await refreshSnapshot(true);
  } catch (err) {
    showGlobalToast(
      tr('workers.killFailed', { err: err instanceof Error ? err.message : String(err) }),
      true,
    );
  }
}

async function retryOrSwitchWorker(opts: {
  name: string;
  provider?: string;
  model?: string;
  prompt?: string;
  reasoningEffort?: string | null;
  fastMode?: boolean | null;
}): Promise<boolean> {
  try {
    const res = await app.callServerTool({
      name: 'app_retry_worker',
      arguments: {
        ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
        name: opts.name,
        ...(opts.provider ? { provider: opts.provider } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.prompt ? { prompt: opts.prompt } : {}),
        ...(opts.reasoningEffort !== undefined ? { reasoning_effort: opts.reasoningEffort } : {}),
        ...(opts.fastMode !== undefined ? { fast_mode: opts.fastMode } : {}),
      },
    });
    if (res.isError) {
      const msg = res.content?.map((c) => ('text' in c ? c.text : '')).join(' ').trim();
      showCommanderToast(msg || 'Retry/switch failed', true);
      return false;
    }
    await refreshSnapshot(true);
    return true;
  } catch (err) {
    showCommanderToast(err instanceof Error ? err.message : String(err), true);
    return false;
  }
}

let snapshotPoll: Promise<void> | null = null;

function refreshSnapshot(force = false): Promise<void> {
  if (!force && document.hidden) return Promise.resolve();
  if (state.pollInFlight) {
    if (force) {
      state.pendingForceRefresh = true;
      ++state.snapshotRequestSeq;
    }
    return snapshotPoll ?? Promise.resolve();
  }
  state.pollInFlight = true;
  snapshotPoll = pollSnapshots(force);
  return snapshotPoll;
}

async function pollSnapshots(force: boolean): Promise<void> {
  try {
    do {
      state.pendingForceRefresh = false;
      await fetchSnapshot(force);
      force = state.pendingForceRefresh;
    } while (force);
  } finally {
    state.pollInFlight = false;
    snapshotPoll = null;
  }
}

async function fetchSnapshot(force: boolean): Promise<void> {
  const reqSeq = ++state.snapshotRequestSeq;
  const requestedSwarmId = state.currentSwarmId;
  const providerConfigRevision = state.providerConfigRevision;
  try {
    const hasActiveWorker = Object.values(state.latestSnapshot?.swarm?.members || {}).some(
      (m) => m.status === 'working' || m.status === 'queued',
    );
    const shouldFetchDiff =
      state.activeTab === 'workers' &&
      (force ||
        hasActiveWorker ||
        state.lastDiffSwarmId !== requestedSwarmId ||
        Date.now() - state.lastDiffFetchAt >= 10_000);

    const res = await app.callServerTool({
      name: 'app_get_snapshot',
      arguments: {
        ...(requestedSwarmId ? { swarm_id: requestedSwarmId } : {}),
        include_diff: shouldFetchDiff,
      },
    });
    if (reqSeq !== state.snapshotRequestSeq || requestedSwarmId !== state.currentSwarmId) return;
    if (res.structuredContent) {
      const incoming = res.structuredContent as unknown as Snapshot;
      if (shouldFetchDiff) {
        state.lastDiffFetchAt = Date.now();
        state.lastDiffSwarmId = incoming.swarm?.id;
      } else if (
        incoming.swarm?.id &&
        incoming.swarm.id === state.latestSnapshot?.swarm?.id &&
        state.latestSnapshot.diffs
      ) {
        incoming.diffs = state.latestSnapshot.diffs;
      }
      if (providerConfigRevision !== state.providerConfigRevision && state.latestProviderConfig) {
        incoming.providerConfig = state.latestProviderConfig;
      }
      state.currentSwarmId = incoming.swarm?.id;
      renderSnapshot(incoming, force);
    }
    const target = state.activeLogTarget;
    if (target && !isLogRequestPending() && !dom.logDrawer.classList.contains('hidden')) {
      if (target.kind === 'external') {
        if (state.latestSnapshot?.swarm?.members?.[target.name]?.status === 'working') {
          void openWorkerLogs(target.name);
        }
      } else if (state.latestSnapshot?.hostTelemetry?.subagents.some(
        (sub) => sub.id === target.id && sub.status === 'working',
      )) {
        void openNativeSubagentLogs(target.id, target.label);
      }
    }
  } catch (err) {
    console.error('Failed to refresh snapshot:', err);
  }
}

function switchTab(tab: 'board' | 'graph' | 'workers' | 'usage' | 'settings'): void {
  state.activeTab = tab;
  dom.tabsNav.querySelectorAll<HTMLButtonElement>('[role="tab"]').forEach((el) => {
    const isSelected = el.dataset.tab === tab;
    el.classList.toggle('active', isSelected);
    el.setAttribute('aria-selected', String(isSelected));
    el.tabIndex = isSelected ? 0 : -1;
  });
  document.querySelectorAll<HTMLElement>('.tab-panel[role="tabpanel"]').forEach((panel) => {
    const isSelected = panel.id === `tab-${tab}`;
    panel.classList.toggle('active', isSelected);
    panel.hidden = !isSelected;
  });
  updateTabInk();
  if (tab === 'settings') {
    if (state.latestProviderConfig) renderSettingsView();
    void loadProviderConfig();
  } else {
    if (state.latestSnapshot && state.dirtyTabs.has(tab)) {
      renderActiveDataTab(state.latestSnapshot);
    }
    if (tab === 'workers' || !state.latestSnapshot) {
      void refreshSnapshot(true);
    }
  }
}

// Event listeners
bindBoardEvents();
bindGraphEvents();
bindTabKeyboardNavigation(dom.tabsNav);
bindUsageEvents();
bindCommanderEvents();
bindSettingsEvents();
bindOnboardingEvents();

dom.btnTopbarMore.addEventListener('click', (e) => {
  e.stopPropagation();
  const wasHidden = dom.topbarMoreMenu.classList.contains('hidden');
  dom.topbarMoreMenu.classList.toggle('hidden', !wasHidden);
  dom.btnTopbarMore.setAttribute('aria-expanded', String(wasHidden));
});

document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement | null;
  if (target && !dom.topbarMoreWrap.contains(target)) {
    closeTopbarMoreMenu();
  }
  if (state.openWorkerMenu && (!target || !target.closest('.worker-more-wrap'))) {
    state.openWorkerMenu = null;
    if (state.activeTab === 'workers' && state.latestSnapshot) {
      renderWorkers(state.latestSnapshot);
    }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.isComposing) return;
  if (!dom.topbarMoreMenu.classList.contains('hidden')) {
    closeTopbarMoreMenu();
    return;
  }
  if (state.openWorkerMenu) {
    state.openWorkerMenu = null;
    if (state.activeTab === 'workers' && state.latestSnapshot) {
      renderWorkers(state.latestSnapshot);
    }
    return;
  }
  if (!dom.logDrawer.classList.contains('hidden')) {
    state.activeLogTarget = null;
    dom.logDrawer.classList.add('hidden');
    return;
  }
  if (!dom.diffDrawer.classList.contains('hidden')) {
    if (state.activeDiffCommentTarget) {
      state.activeDiffCommentTarget = null;
      renderDiffDrawerBody();
      return;
    }
    state.activeDiffWorker = null;
    dom.diffDrawer.classList.add('hidden');
    return;
  }
  if (state.activeCommanderPanel) {
    toggleCommanderPanel(null);
    return;
  }
  if (!dom.settingsAddPanel.classList.contains('hidden')) {
    dom.settingsAddPanel.classList.add('hidden');
  }
});

function flushDeferredWorkers(): void {
  if (state.workersPointerDown || isEditingInsideWorkersList()) return;
  if (state.workersDeferredRender && state.activeTab === 'workers' && state.latestSnapshot) {
    state.dirtyTabs.add('workers');
    renderActiveDataTab(state.latestSnapshot, true);
  }
}

function flushDeferredCommander(): void {
  if (state.commanderPointerDown || isEditingInsideCommanderPanels()) return;
  if (state.commanderDeferredSync) syncCommanderControls(true);
}

function bindDeferredRender(
  container: HTMLElement,
  setPointerDown: (down: boolean) => void,
  flush: () => void,
): void {
  const pointers = new Set<number>();
  container.addEventListener('pointerdown', (event) => {
    pointers.add(event.pointerId);
    setPointerDown(true);
  });
  const finishPointer = (event: PointerEvent) => {
    if (!pointers.has(event.pointerId)) return;
    window.setTimeout(() => {
      pointers.delete(event.pointerId);
      setPointerDown(pointers.size > 0);
      flush();
    }, 0);
  };
  window.addEventListener('pointerup', finishPointer, true);
  window.addEventListener('pointercancel', finishPointer, true);
  container.addEventListener('focusout', () => window.setTimeout(flush, 0));
}

bindDeferredRender(dom.workersList.closest<HTMLElement>('.workers-stage') || dom.workersList, (down) => { state.workersPointerDown = down; }, flushDeferredWorkers);
bindDeferredRender(dom.commanderBar, (down) => { state.commanderPointerDown = down; }, flushDeferredCommander);

dom.btnLang.addEventListener('click', async () => {
  closeTopbarMoreMenu();
  state.localeOverriddenByUser = true;
  state.currentLocale = state.currentLocale === 'zh' ? 'en' : 'zh';
  applyStaticI18n();
  if (state.latestSnapshot) {
    renderSnapshot(state.latestSnapshot, true);
  }
  if (state.activeTab === 'settings' && state.latestProviderConfig) {
    renderSettingsView();
  }
  try {
    await app.callServerTool({
      name: 'app_set_ui_prefs',
      arguments: { locale: state.currentLocale },
    });
  } catch {
    // Non-fatal if persistence fails
  }
});

dom.tabsNav.querySelectorAll<HTMLButtonElement>('[role="tab"]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab as 'board' | 'graph' | 'workers' | 'usage' | 'settings';
    if (tab) switchTab(tab);
  });
});

async function bindConversationFromUi(convId: string): Promise<void> {
  if (!convId) return;
  try {
    const res = await app.callServerTool({
      name: 'app_bind_conversation',
      arguments: {
        ...(state.latestSnapshot?.swarm ? { swarm_id: state.latestSnapshot.swarm.id } : {}),
        conversation_id: convId,
      },
    });
    const errMsg = extractToolErrorMessage(res);
    if (errMsg) {
      showGlobalToast(tr('app.convBindFailed', { err: errMsg }), true);
      return;
    }
    await refreshSnapshot(true);
  } catch (err) {
    showGlobalToast(
      tr('app.convBindFailed', { err: err instanceof Error ? err.message : String(err) }),
      true,
    );
  }
}

dom.convSelect.addEventListener('change', () => {
  void bindConversationFromUi(dom.convSelect.value);
});

let swarmSelectedManually = false;

dom.swarmSelect.addEventListener('change', () => {
  swarmSelectedManually = true;
  closeTopbarMoreMenu();
  state.currentSwarmId = dom.swarmSelect.value || undefined;
  resetSwarmScopedUiState();
  void refreshSnapshot(true);
});

dom.btnExportSwarm.addEventListener('click', async () => {
  closeTopbarMoreMenu();
  if (!state.latestSnapshot?.swarm) return;
  try {
    const res = await app.callServerTool({
      name: 'app_export_swarm',
      arguments: {
        ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
      },
    });
    const errMsg = extractToolErrorMessage(res);
    if (errMsg) {
      showGlobalToast(tr('app.exportFailed', { err: errMsg }), true);
      return;
    }
    const payload = res.structuredContent as { filename?: string; markdown?: string } | undefined;
    if (!payload?.markdown) return;
    await copyTextWithToast(payload.markdown);
    const blob = new Blob([payload.markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = payload.filename || 'swarm-report.md';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    showGlobalToast(tr('app.exported'));
    const prevText = getButtonLabel(dom.btnExportSwarm);
    setButtonLabel(dom.btnExportSwarm, tr('app.exported'));
    window.setTimeout(() => {
      setButtonLabel(dom.btnExportSwarm, prevText || tr('app.export'));
    }, 1800);
  } catch (err) {
    showGlobalToast(
      tr('app.exportFailed', { err: err instanceof Error ? err.message : String(err) }),
      true,
    );
  }
});

dom.btnDeleteSwarm.addEventListener('click', async () => {
  if (!state.latestSnapshot?.swarm || state.latestSnapshot.swarm.id !== state.currentSwarmId) return;
  const confirmed = state.pendingDeleteSwarm;
  state.deleteSwarmTimer = armDoubleClickConfirm(confirmed, state.deleteSwarmTimer, () => {
    state.deleteSwarmTimer = null;
    state.pendingDeleteSwarm = false;
    setButtonLabel(dom.btnDeleteSwarm, tr('app.deleteSwarm'));
  });
  state.pendingDeleteSwarm = !confirmed;
  setButtonLabel(dom.btnDeleteSwarm, tr(confirmed ? 'app.deleteSwarm' : 'app.confirmDeleteSwarm'));
  if (!confirmed) return;

  closeTopbarMoreMenu();
  const targetId = state.latestSnapshot.swarm.id;
  try {
    const res = await app.callServerTool({
      name: 'app_delete_swarm',
      arguments: {
        swarm_id: targetId,
        remove_worktrees: true,
      },
    });
    const errMsg = extractToolErrorMessage(res);
    if (errMsg) {
      showGlobalToast(tr('app.deleteSwarmFailed', { err: errMsg }), true);
      return;
    }
    const payload = res.structuredContent as { swarms?: SwarmIndexEntry[] } | undefined;
    if (state.currentSwarmId === targetId) {
      state.currentSwarmId = payload?.swarms?.at(-1)?.id;
      resetSwarmScopedUiState();
    }
    showGlobalToast(tr('app.deleteSwarmSuccess', { id: targetId }));
    await refreshSnapshot(true);
  } catch (err) {
    showGlobalToast(
      tr('app.deleteSwarmFailed', { err: err instanceof Error ? err.message : String(err) }),
      true,
    );
  }
});

dom.btnRefresh.addEventListener('click', () => {
  dom.btnRefresh.classList.remove('is-spinning');
  void dom.btnRefresh.offsetWidth;
  dom.btnRefresh.classList.add('is-spinning');
  window.setTimeout(() => dom.btnRefresh.classList.remove('is-spinning'), 580);
  void refreshSnapshot(true);
  if (state.activeTab === 'settings') {
    void loadProviderConfig();
  }
});

dom.replaySlider.addEventListener('input', () => {
  stopReplayPlayback();
  stepReplay(Number(dom.replaySlider.value));
});

dom.replayPrevBtn.addEventListener('click', () => {
  stopReplayPlayback();
  const maxSeq = state.latestSnapshot?.messages.at(-1)?.seq || 1;
  const cur = state.replaySeq ?? maxSeq;
  stepReplay(cur - 1);
});

dom.replayNextBtn.addEventListener('click', () => {
  stopReplayPlayback();
  const maxSeq = state.latestSnapshot?.messages.at(-1)?.seq || 1;
  const cur = state.replaySeq ?? maxSeq;
  stepReplay(cur + 1);
});

dom.graphModeTopology.addEventListener('click', () => {
  if (state.graphViewMode === 'topology') return;
  state.graphViewMode = 'topology';
  if (state.latestSnapshot) renderGraphAndReplay(state.latestSnapshot);
});

dom.graphModeTimeline.addEventListener('click', () => {
  if (state.graphViewMode === 'timeline') return;
  stopReplayPlayback();
  state.graphViewMode = 'timeline';
  if (state.latestSnapshot) renderGraphAndReplay(state.latestSnapshot);
});

dom.graphToggleNative.addEventListener('change', () => {
  state.graphShowNative = dom.graphToggleNative.checked;
  if (state.latestSnapshot) renderGraphAndReplay(state.latestSnapshot);
});

dom.replayLiveBtn.addEventListener('click', () => {
  stopReplayPlayback();
  state.replaySeq = null;
  if (state.latestSnapshot) {
    renderGraphAndReplay(state.latestSnapshot);
  }
});

dom.replayPlayBtn.addEventListener('click', () => {
  if (!state.latestSnapshot?.swarm || state.latestSnapshot.messages.length === 0) return;
  if (state.replayPlaying) {
    stopReplayPlayback();
    return;
  }
  const maxSeq = state.latestSnapshot.messages[state.latestSnapshot.messages.length - 1].seq;
  if (state.replaySeq === null || state.replaySeq >= maxSeq) {
    state.replaySeq = 1;
  }
  state.replayPlaying = true;
  dom.replayPlayBtn.textContent = tr('graph.pause');
  renderGraphAndReplay(state.latestSnapshot);

  state.replayTimer = window.setInterval(() => {
    if (!state.latestSnapshot?.swarm) {
      stopReplayPlayback();
      return;
    }
    const head = state.latestSnapshot.messages.at(-1)?.seq || 1;
    const next = (state.replaySeq ?? 1) + 1;
    if (next > head) {
      stopReplayPlayback();
      state.replaySeq = null;
      renderGraphAndReplay(state.latestSnapshot);
      return;
    }
    state.replaySeq = next;
    renderGraphAndReplay(state.latestSnapshot);
  }, 1400);
});

dom.composerInput.addEventListener('input', () => {
  resizeComposerInput();
});

dom.composerInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    dom.composerForm.requestSubmit();
  }
});

dom.composerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.latestSnapshot?.swarm || dom.composerSend.disabled) return;
  const text = dom.composerInput.value.trim();
  if (!text) return;
  dom.composerSend.disabled = true;
  try {
    const res = await app.callServerTool({
      name: 'app_post_message',
      arguments: {
        ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
        text,
      },
    });
    const errMsg = extractToolErrorMessage(res);
    if (errMsg) {
      showGlobalToast(tr('app.postFailed', { err: errMsg }), true);
      return;
    }
    dom.composerInput.value = '';
    resizeComposerInput();
    await refreshSnapshot(true);
  } catch (err) {
    showGlobalToast(
      tr('app.postFailed', { err: err instanceof Error ? err.message : String(err) }),
      true,
    );
  } finally {
    dom.composerSend.disabled = !state.latestSnapshot?.swarm;
  }
});

dom.btnSendSummary.addEventListener('click', async () => {
  if (!state.latestSnapshot?.swarm) return;
  const s = state.latestSnapshot.swarm;
  const summary = computeTelemetrySummary(state.latestSnapshot, state.usageScope);
  const summaryLines = [
    tr('summary.header', { title: s.title, id: s.id, head: s.headSeq }),
    tr('summary.workers', {
      total: formatNum(summary.external.totalTokens),
      hit: summary.external.cacheHitRate,
    }),
    ...(summary.nativeCurrent.length > 0
      ? [
          tr('summary.native', {
            n: summary.nativeCurrent.length,
            total: formatNum(summary.native.totalTokens),
            hit: summary.native.cacheHitRate,
          }),
        ]
      : []),
    ...(summary.coordinator.totalTokens > 0
      ? [
          tr('summary.agy', {
            total: formatNum(summary.coordinator.totalTokens),
            hit: summary.coordinator.cacheHitRate,
          }),
        ]
      : []),
    ...summary.externalMembers.map(
      (m) =>
        tr('summary.member', {
          name: m.name,
          status: statusLabel(m.status),
          provider: m.provider || 'dsh',
          model: formatMemberModelWithOptions(m, m.resolvedModel),
          turns: m.turns,
          total: formatNum(m.usage?.totalTokens || 0),
        }) + (m.branch ? tr('summary.branch', { branch: m.branch }) : ''),
    ),
    ...summary.nativeCurrent.map((sub) =>
      tr('summary.nativeMember', {
        role: sub.role,
        shortId: sub.shortId,
        status: statusLabel(sub.status),
        model: sub.model,
        steps: sub.steps,
        total: formatNum(sub.usageSinceSwarm.totalTokens || sub.usage.totalTokens),
      }),
    ),
    tr('summary.footer'),
  ];
  try {
    await app.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: summaryLines.join('\n') }],
    });
    showGlobalToast(tr('app.summaryPushed'));
  } catch (err) {
    showGlobalToast(
      tr('app.summaryPushFailed', { err: err instanceof Error ? err.message : String(err) }),
      true,
    );
  }
});

window.addEventListener('resize', () => updateTabInk());

// Must register handlers BEFORE connect()
app.ontoolinput = ({ arguments: args }) => {
  const swarmId = args?.swarm_id;
  if (swarmSelectedManually || typeof swarmId !== 'string' || !swarmId || swarmId === state.currentSwarmId) return;
  state.currentSwarmId = swarmId;
  resetSwarmScopedUiState();
  if (state.pollInFlight || state.latestSnapshot) void refreshSnapshot(true);
};

app.ontoolresult = (result) => {
  if (!result.structuredContent || state.latestSnapshot) return;
  const snap = result.structuredContent as unknown as Snapshot;
  if (state.currentSwarmId && snap.swarm?.id !== state.currentSwarmId) return;
  state.currentSwarmId = snap.swarm?.id;
  renderSnapshot(snap, true);
};

app.onhostcontextchanged = () => {
  applyHostContext();
};

async function boot(): Promise<void> {
  applyStaticI18n();
  window.requestAnimationFrame(() => updateTabInk());
  await app.connect();
  applyHostContext();
  const caps = app.getHostCapabilities();
  if (caps?.message) {
    dom.btnSendSummary.classList.remove('hidden');
  }
  await refreshSnapshot(true);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      void refreshSnapshot(false);
    }
  });
  window.setInterval(() => {
    void refreshSnapshot(false);
  }, 2500);
  window.setInterval(() => {
    if (!document.hidden && state.activeTab === 'workers') {
      updateLiveWorkerElapsedBadges();
    }
  }, 1000);
}

// ---------------------------------------------------------------------------
// Bridge registration: publish entrypoint-owned callbacks to the view modules.
// Runs at module scope so any render path (including boot()) can use them.
// ---------------------------------------------------------------------------
initUiBridge({
  applyMergeFromUi,
  bindConversationFromUi,
  createWorkerPrFromUi,
  crossReviewFromUi,
  killWorkerFromUi,
  openWorkerDiff,
  openWorkerLogs,
  openNativeSubagentLogs,
  previewMergeFromUi,
  refreshSnapshot,
  renderSnapshot,
  resetSwarmScopedUiState,
  retryOrSwitchWorker,
  switchTab,
  syncCommanderControls,
  toggleCommanderPanel,
  updateSwarmBudgetFromUi,
});

boot().catch((err) => {
  dom.metaSummary.textContent = `UI error: ${err instanceof Error ? err.message : String(err)}`;
});

