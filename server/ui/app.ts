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
import { aggregateDshUsage, animateNumber, clearPendingKillState, computeBoardSignature, computeSignature, extractToolErrorMessage, getButtonLabel, isEditingInsideWorkersList, resizeComposerInput, setBadgeText, setButtonLabel, showCommanderToast, showGlobalToast, statusLabel } from './helpers.js';
import { detectDefaultLocale, type I18nKey } from './i18n.js';
import { renderGraphAndReplay, stepReplay, stopReplayPlayback } from './graph-view.js';
import { initUiBridge } from './bridge.js';
import { app } from './mcp-app.js';
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
import { renderUsageView } from './usage-view.js';
import { renderWorkers } from './workers-view.js';
import {
  bindBoardEvents,
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
  setButtonLabel(dom.btnDeleteSwarm, tr('app.deleteSwarm'));
  clearPendingKillState();
  state.selectedAgentFilter = null;
  state.replaySeq = null;
  state.seenSeqs.clear();
  state.seenWorkerNames.clear();
  state.prevGaugePcts.clear();
  state.initialBoardLoaded = false;
  state.lastRenderSignature = '';
  state.lastBoardSignature = '';
  state.lastCommanderConfigSignature = '';
  state.switchOpenWorker = null;
  state.switchDrafts.clear();
  state.workerStatusFilter = 'all';
  state.mergeOpenWorker = null;
  state.mergePreviews.clear();
  state.mergeDrafts.clear();
  state.prResults.clear();
  state.workersDeferredRender = false;
  state.commanderDeferredSync = false;
  state.activeLogWorker = null;
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

  dom.replayPlayBtn.textContent = state.replayPlaying ? tr('graph.pause') : tr('graph.play');
  if (state.activeLogWorker) {
    dom.logDrawerTitle.textContent = tr('drawer.titleFor', { name: state.activeLogWorker });
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
    if (!state.latestProviderConfig) {
      state.latestProviderConfig = snap.providerConfig;
      if (state.activeTab === 'settings') {
        renderSettingsView();
      }
    } else {
      state.latestProviderConfig.globalConfigExists = snap.providerConfig.globalConfigExists;
      state.latestProviderConfig.configuredDefaultProvider = snap.providerConfig.configuredDefaultProvider;
      state.latestProviderConfig.effectiveDefaultProvider = snap.providerConfig.effectiveDefaultProvider;
      state.latestProviderConfig.pricing = snap.providerConfig.pricing;
      state.latestProviderConfig.activePool = snap.providerConfig.activePool;
      state.latestProviderConfig.routingPolicy = snap.providerConfig.routingPolicy;
      state.latestProviderConfig.defaultTurnTimeoutSeconds =
        snap.providerConfig.defaultTurnTimeoutSeconds;
      state.latestProviderConfig.defaultStallTimeoutSeconds =
        snap.providerConfig.defaultStallTimeoutSeconds;
      state.latestProviderConfig.cooldowns = snap.providerConfig.cooldowns;
      const prevEnvById = new Map<string, Record<string, string>>();
      const prevWarningsById = new Map<string, string[]>();
      for (const prevProv of state.latestProviderConfig.providers) {
        if (prevProv.env) prevEnvById.set(prevProv.id, prevProv.env);
        if (prevProv.warnings?.length) prevWarningsById.set(prevProv.id, prevProv.warnings);
      }
      state.latestProviderConfig.providers = snap.providerConfig.providers.map((np) => {
        const keptEnv = !np.env ? prevEnvById.get(np.id) : undefined;
        const keptWarnings = !np.warnings?.length ? prevWarningsById.get(np.id) : undefined;
        if (!keptEnv && !keptWarnings) return np;
        return {
          ...np,
          ...(keptEnv ? { env: keptEnv } : {}),
          ...(keptWarnings ? { warnings: keptWarnings } : {}),
        };
      });
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

  const sig = computeSignature(snap);
  if (!force && sig === state.lastRenderSignature) {
    updateLiveWorkerElapsedBadges();
    return;
  }
  state.lastRenderSignature = sig;
  syncCommanderControls(force);

  const swarms = snap.swarms || [];
  dom.swarmSelect.innerHTML = '';
  if (swarms.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = tr('swarm.noneOption');
    dom.swarmSelect.appendChild(opt);
  } else {
    for (const item of swarms) {
      const opt = document.createElement('option');
      opt.value = item.id;
      opt.textContent = item.title;
      dom.swarmSelect.appendChild(opt);
    }
    if (snap.swarm) {
      state.currentSwarmId = snap.swarm.id;
      dom.swarmSelect.value = snap.swarm.id;
    }
  }

  const swarm = snap.swarm;
  const members = swarm ? Object.values(swarm.members || {}) : [];
  const dshAgg = aggregateDshUsage(members);
  const cu = snap.coordinatorUsage;
  const agyActive = state.usageScope === 'swarm' && swarm ? cu?.sinceSwarmStart : cu?.sessionTotal;
  const combinedPrompt = dshAgg.promptTokens + (agyActive?.promptTokens || 0);
  const combinedCache = dshAgg.cacheReadTokens + (agyActive?.cacheReadTokens || 0);
  const combinedHit =
    combinedPrompt > 0 ? Math.round((combinedCache / combinedPrompt) * 1000) / 10 : 0;

  setBadgeText(dom.badgeUsageHit, combinedPrompt > 0 ? `${combinedHit}%` : '--');

  if (!swarm) {
    state.seenWorkerNames.clear();
    state.prevGaugePcts.clear();
    dom.topbar.classList.remove('is-active');
    dom.livePill.className = 'pill pill-neutral';
    dom.livePillText.textContent = tr('status.empty');
    dom.metaSummary.innerHTML = cu?.sessionTotal.totalTokens
      ? `<span class="kpi-item">${escapeHtml(tr('swarm.emptyTelemetryMain', { total: formatNum(cu.sessionTotal.totalTokens), hit: cu.sessionTotal.cacheHitRate }))}</span>`
      : `<span class="kpi-item">${escapeHtml(tr('swarm.emptyTelemetry'))}</span>`;
    setBadgeText(dom.countBoard, '0');
    setBadgeText(dom.countEdges, '0');
    setBadgeText(dom.countWorkers, '0');
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
    dom.workersList.innerHTML = `<div class="empty-state">${escapeHtml(tr('workers.empty'))}</div>`;
    dom.mentionGraph.innerHTML = '';
    dom.replayPreview.innerHTML = `<div class="empty-state-compact">${escapeHtml(tr('graph.noTraffic'))}</div>`;
    renderUsageView(snap, prevSnap);
    state.prevSnapForUsage = snap;
    state.dirtyTabs.clear();
    updateTabInk();
    return;
  }

  dom.composerInput.disabled = false;
  dom.composerSend.disabled = false;
  dom.composerInput.placeholder = tr('board.composerPlaceholder');
  dom.composerWrap?.classList.remove('is-disabled');

  const workingCount = members.filter((m) => m.status === 'working' || m.status === 'queued').length;
  const waitingCount = members.filter((m) => m.status === 'waiting').length;
  const failedCount = members.filter((m) => m.status === 'failed').length;

  dom.topbar.classList.toggle('is-active', workingCount > 0);

  if (workingCount > 0) {
    dom.livePill.className = 'pill pill-working';
    dom.livePillText.textContent = tr('status.runningCount', { n: workingCount });
  } else if (failedCount > 0) {
    dom.livePill.className = 'pill pill-failed';
    dom.livePillText.textContent = tr('status.failedCount', { n: failedCount });
  } else {
    dom.livePill.className = 'pill pill-waiting';
    dom.livePillText.textContent = tr('status.idle');
  }

  const prevDshTokens = prevSnap?.swarm
    ? aggregateDshUsage(Object.values(prevSnap.swarm.members || {})).totalTokens
    : 0;
  const prevAgyTokens =
    state.usageScope === 'swarm'
      ? prevSnap?.coordinatorUsage?.sinceSwarmStart.totalTokens || 0
      : prevSnap?.coordinatorUsage?.sessionTotal.totalTokens || 0;

  const formatShortTimeout = (sec: number): string => {
    if (sec === 0) return 'off';
    if (sec >= 60 && sec % 60 === 0) return `${sec / 60}m`;
    return `${sec}s`;
  };
  const timeoutTitle = tr('kpi.timeoutsTitle', {
    concurrency: swarm.maxConcurrency,
    turn: swarm.turnTimeoutSeconds === 0 ? 'off' : `${swarm.turnTimeoutSeconds}s`,
    stall: swarm.stallTimeoutSeconds === 0 ? 'off' : `${swarm.stallTimeoutSeconds}s`,
  });

  dom.metaSummary.innerHTML = `
    <span class="kpi-item">${escapeHtml(tr('kpi.running'))} <span class="kpi-val">${workingCount}</span></span>
    <span class="kpi-sep">·</span>
    <span class="kpi-item">${escapeHtml(tr('kpi.waiting'))} <span class="kpi-val">${waitingCount}</span></span>
    ${failedCount > 0 ? `<span class="kpi-sep">·</span><span class="kpi-item">${escapeHtml(tr('kpi.failed'))} <span class="kpi-val">${failedCount}</span></span>` : ''}
    ${swarm.activeProviders && swarm.activeProviders.length > 1 ? `<span class="kpi-sep">·</span><span class="kpi-item">${escapeHtml(tr('kpi.pool'))} <span class="kpi-val">${swarm.activeProviders.length}</span>${swarm.routingPolicy?.autoFailover ? ` (${escapeHtml(tr('kpi.failover'))})` : ''}</span>` : ''}
    <span class="kpi-sep">·</span>
    <span class="kpi-item">${escapeHtml(tr('kpi.hops'))} <span class="kpi-val">${swarm.hopCount}/${swarm.maxHops}</span></span>
    <span class="kpi-sep">·</span>
    <span class="kpi-item" title="${escapeHtml(timeoutTitle)}">${escapeHtml(tr('kpi.timeouts'))} <span class="kpi-val">${escapeHtml(formatShortTimeout(swarm.turnTimeoutSeconds))}/${escapeHtml(formatShortTimeout(swarm.stallTimeoutSeconds))}</span></span>
    <span class="kpi-sep">·</span>
    <span class="kpi-item">${escapeHtml(tr('kpi.workers'))} <span class="kpi-val" id="kpi-dsh-tok">${formatNum(dshAgg.totalTokens)}</span> (${escapeHtml(tr('kpi.hit'))} ${dshAgg.cacheHitRate}%)</span>
    <span class="kpi-sep">·</span>
    <span class="kpi-item">${escapeHtml(tr('kpi.mainModel'))} <span class="kpi-val" id="kpi-agy-tok">${formatNum(agyActive?.totalTokens || 0)}</span> (${escapeHtml(tr('kpi.hit'))} ${agyActive?.cacheHitRate || 0}%)</span>
  `;

  animateNumber(document.getElementById('kpi-dsh-tok'), prevDshTokens, dshAgg.totalTokens, formatNum);
  animateNumber(
    document.getElementById('kpi-agy-tok'),
    prevAgyTokens,
    agyActive?.totalTokens || 0,
    formatNum,
  );

  setBadgeText(dom.countBoard, String(snap.messages.length));
  setBadgeText(dom.countEdges, String(snap.edges.length));
  setBadgeText(dom.countWorkers, String(members.length));

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
  if (!swarm) return;
  const members = Object.values(swarm.members || {});
  if (state.activeTab === 'board') {
    const boardSig = computeBoardSignature(snap);
    if (force || boardSig !== state.lastBoardSignature) {
      renderParticipantChips(members);
      renderMentionQuickbar(members);
      renderBoard(snap.messages);
      state.lastBoardSignature = boardSig;
    }
    state.dirtyTabs.delete('board');
  } else if (state.activeTab === 'workers') {
    if (!force && isEditingInsideWorkersList()) {
      state.workersDeferredRender = true;
      return;
    }
    state.workersDeferredRender = false;
    renderWorkers(members, snap.diffs || {});
    state.dirtyTabs.delete('workers');
  } else if (state.activeTab === 'graph') {
    renderGraphAndReplay(swarm, snap.messages);
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

async function refreshSnapshot(force = false): Promise<void> {
  if (!force && document.hidden) return;
  if (state.pollInFlight) return;
  state.pollInFlight = true;
  try {
    const hasActiveWorker = Boolean(
      state.latestSnapshot?.swarm &&
        Object.values(state.latestSnapshot.swarm.members || {}).some(
          (m) => m.status === 'working' || m.status === 'queued',
        ),
    );
    const shouldFetchDiff =
      state.activeTab === 'workers' &&
      (force ||
        hasActiveWorker ||
        state.lastDiffSwarmId !== state.currentSwarmId ||
        Date.now() - state.lastDiffFetchAt >= 10_000);

    const res = await app.callServerTool({
      name: 'app_get_snapshot',
      arguments: {
        ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
        include_diff: shouldFetchDiff,
      },
    });
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
      renderSnapshot(incoming, force);
    }
    if (state.activeLogWorker && !dom.logDrawer.classList.contains('hidden')) {
      const worker = state.latestSnapshot?.swarm?.members?.[state.activeLogWorker];
      if (worker?.status === 'working') {
        await openWorkerLogs(state.activeLogWorker);
      }
    }
  } catch (err) {
    console.error('Failed to refresh snapshot:', err);
  } finally {
    state.pollInFlight = false;
  }
}

function switchTab(tab: 'board' | 'graph' | 'workers' | 'usage' | 'settings'): void {
  state.activeTab = tab;
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((el) => {
    const isSelected = el.dataset.tab === tab;
    el.classList.toggle('active', isSelected);
    el.setAttribute('aria-selected', String(isSelected));
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `tab-${tab}`);
  });
  updateTabInk();
  if (tab === 'settings') {
    if (state.latestProviderConfig) renderSettingsView();
    void loadProviderConfig();
  } else {
    if (state.latestSnapshot?.swarm && state.dirtyTabs.has(tab)) {
      renderActiveDataTab(state.latestSnapshot);
    }
    if (tab === 'workers' || !state.latestSnapshot) {
      void refreshSnapshot(true);
    }
  }
}

// Event listeners
bindBoardEvents();
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
  const target = e.target as Node | null;
  if (target && !dom.topbarMoreWrap.contains(target)) {
    closeTopbarMoreMenu();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.isComposing) return;
  if (!dom.topbarMoreMenu.classList.contains('hidden')) {
    closeTopbarMoreMenu();
    return;
  }
  if (!dom.logDrawer.classList.contains('hidden')) {
    state.activeLogWorker = null;
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

dom.workersList.addEventListener('focusout', () => {
  window.setTimeout(() => {
    if (!isEditingInsideWorkersList() && state.workersDeferredRender && state.activeTab === 'workers' && state.latestSnapshot?.swarm) {
      state.workersDeferredRender = false;
      state.dirtyTabs.add('workers');
      renderActiveDataTab(state.latestSnapshot, true);
    }
  }, 0);
});

dom.commanderBar.addEventListener('focusout', () => {
  window.setTimeout(() => {
    if (!isEditingInsideCommanderPanels() && state.commanderDeferredSync) {
      state.commanderDeferredSync = false;
      syncCommanderControls(true);
    }
  }, 0);
});

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

document.querySelectorAll<HTMLButtonElement>('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab as 'board' | 'graph' | 'workers' | 'usage' | 'settings';
    if (tab) switchTab(tab);
  });
});

dom.convSelect.addEventListener('change', async () => {
  const convId = dom.convSelect.value;
  if (!convId || !state.latestSnapshot?.swarm) return;
  try {
    const res = await app.callServerTool({
      name: 'app_bind_conversation',
      arguments: {
        swarm_id: state.latestSnapshot.swarm.id,
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
});

dom.swarmSelect.addEventListener('change', () => {
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
    try {
      await navigator.clipboard?.writeText(payload.markdown);
    } catch {
      // Clipboard may be restricted in webview; download blob still works
    }
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
  if (!state.latestSnapshot?.swarm) return;
  if (!state.pendingDeleteSwarm) {
    state.pendingDeleteSwarm = true;
    setButtonLabel(dom.btnDeleteSwarm, tr('app.confirmDeleteSwarm'));
    window.setTimeout(() => {
      if (state.pendingDeleteSwarm) {
        state.pendingDeleteSwarm = false;
        setButtonLabel(dom.btnDeleteSwarm, tr('app.deleteSwarm'));
      }
    }, 3500);
    return;
  }
  closeTopbarMoreMenu();
  const targetId = state.latestSnapshot.swarm.id;
  state.pendingDeleteSwarm = false;
  setButtonLabel(dom.btnDeleteSwarm, tr('app.deleteSwarm'));
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
    state.currentSwarmId = payload?.swarms?.at(-1)?.id;
    resetSwarmScopedUiState();
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

dom.replayLiveBtn.addEventListener('click', () => {
  stopReplayPlayback();
  state.replaySeq = null;
  if (state.latestSnapshot?.swarm) {
    renderGraphAndReplay(state.latestSnapshot.swarm, state.latestSnapshot.messages);
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
  renderGraphAndReplay(state.latestSnapshot.swarm, state.latestSnapshot.messages);

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
      renderGraphAndReplay(state.latestSnapshot.swarm, state.latestSnapshot.messages);
      return;
    }
    state.replaySeq = next;
    renderGraphAndReplay(state.latestSnapshot.swarm, state.latestSnapshot.messages);
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
  const members = Object.values(s.members);
  const dshAgg = aggregateDshUsage(members);
  const cu = state.latestSnapshot.coordinatorUsage;
  const agy = state.usageScope === 'swarm' ? cu?.sinceSwarmStart : cu?.sessionTotal;
  const summaryLines = [
    tr('summary.header', { title: s.title, id: s.id, head: s.headSeq }),
    tr('summary.workers', { total: formatNum(dshAgg.totalTokens), hit: dshAgg.cacheHitRate }),
    ...(agy
      ? [tr('summary.agy', { total: formatNum(agy.totalTokens), hit: agy.cacheHitRate })]
      : []),
    ...members.map(
      (m) =>
        tr('summary.member', {
          name: m.name,
          status: statusLabel(m.status),
          provider: m.provider || 'dsh',
          model: m.model,
          turns: m.turns,
          total: formatNum(m.usage?.totalTokens || 0),
        }) + (m.branch ? tr('summary.branch', { branch: m.branch }) : ''),
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
  if (args && typeof args.swarm_id === 'string' && args.swarm_id) {
    state.currentSwarmId = args.swarm_id;
  }
};

app.ontoolresult = (result) => {
  if (result.structuredContent) {
    renderSnapshot(result.structuredContent as unknown as Snapshot, true);
  }
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
  createWorkerPrFromUi,
  crossReviewFromUi,
  killWorkerFromUi,
  openWorkerDiff,
  openWorkerLogs,
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

