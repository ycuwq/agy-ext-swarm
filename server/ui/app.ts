/**
 * AGY Ext Swarm board UI — esbuild bundle entrypoint (see build.mjs).
 *
 * The former ~6.3k LOC monolith is decomposed into focused modules:
 *   dom.ts              typed DOM lookups (single source of truth for ids)
 *   store.ts            shared mutable UI state
 *   context.ts          locale-bound translation helper
 *   bridge.ts           typed registry for entrypoint-owned callbacks
 *   helpers.ts          pure helpers, HTML builders, toasts
 *   graph-view.ts       topology SVG graph + replay transport
 *   workers-view.ts     arena boards + workers card list
 *   usage-view.ts       token/cache telemetry + pricing
 *   onboarding-view.ts  first-run wizard
 *   settings-view.ts    settings, provider cards, routing matrix
 *
 * This file keeps MCP App wiring, tool calls, event listeners and boot().
 */
import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import { computeGraphEdgesFromMessages } from '../shared/graph.js';
import {
  escapeHtml,
  formatDurationMs,
  formatMessageHtml,
  formatNum,
  formatTime as formatTimeLocale,
  parseArgsFromInput,
  parseEnvText,
  splitModelList,
} from './format.js';
import { detectDefaultLocale, t, type I18nKey, type Locale } from './i18n.js';
import { CUSTOM_CLI_PRESETS } from './presets.js';
import { renderDiffHtml, renderStructuredEventsHtml } from './render-events.js';
import {
  DEFAULT_STALL_TIMEOUT_SECONDS,
  DEFAULT_TURN_TIMEOUT_SECONDS,
  MAX_STALL_TIMEOUT_SECONDS,
  MAX_TURN_TIMEOUT_SECONDS,
  type BoardMessage,
  MemberState,
  MergeApplyResult,
  MergePreviewResult,
  Snapshot,
  SwarmIndexEntry,
  SwarmState,
  SwarmTemplate,
  TaskRoutingMap,
  TemplatesConfigSnapshot,
  WorktreePatchResult,
} from './types.js';
import { app } from './mcp-app.js';
import { tr } from './context.js';
import { state, type DataTab } from './store.js';
import * as dom from './dom.js';
import { initUiBridge } from './bridge.js';
import { renderGraphAndReplay, stepReplay, stopReplayPlayback } from './graph-view.js';
import { TASK_ROUTING_ORDER, aggregateDshUsage, animateNumber, clearPendingKillState, computeBoardSignature, computeSignature, extractToolErrorMessage, formatRouteText, formatTime, getButtonLabel, isEditingInsideWorkersList, kindLabel, parseOptionalTimeoutInput, renderCliCheckboxGrid, resizeComposerInput, serializeTaskRoutingMap, setBadgeText, setButtonLabel, showCommanderToast, showGlobalToast, statusLabel, withBusyButton } from './helpers.js';
import { applyCustomPreset, initOnboardingDraft, openOnboardingWizard, renderOnboardingWizard, shouldShowOnboarding } from './onboarding-view.js';
import { getEnabledProvidersForUi, loadProviderConfig, renderPricingSection, renderRoutingSummaryChips, renderSettingsView, saveProviderPatch, showSettingsToast, switchSettingsSubtab, syncAddWorkerModelDatalist, syncProviderModelDatalists } from './settings-view.js';
import { renderUsageView } from './usage-view.js';
import { renderWorkers } from './workers-view.js';









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
  state.mergeOpenWorker = null;
  state.mergePreviews.clear();
  state.mergeDrafts.clear();
  state.workersDeferredRender = false;
  state.commanderDeferredSync = false;
  state.activeLogWorker = null;
  state.cachedLogLines = [];
  dom.logDrawer.classList.add('hidden');
  state.activeDiffWorker = null;
  state.cachedDiffData = null;
  dom.diffDrawer.classList.add('hidden');
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
    renderDiffDrawerBody();
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

function renderParticipantChips(members: MemberState[]): void {
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

function renderMentionQuickbar(members: MemberState[]): void {
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


function renderBoard(messages: BoardMessage[]): void {
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

function jumpToSeq(seqNum: number): void {
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






function renderLogDrawerBody(): void {
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

async function openWorkerLogs(name: string): Promise<void> {
  state.activeLogWorker = name;
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

function renderDiffDrawerBody(): void {
  const data = state.cachedDiffData;
  if (!data) {
    dom.diffDrawerBody.innerHTML = `<div class="empty-state-compact">${escapeHtml(tr('diff.empty'))}</div>`;
    return;
  }
  dom.diffDrawerBranch.textContent = data.branch || 'HEAD';
  if (!data.patch.trim()) {
    dom.diffDrawerBody.innerHTML = `<div class="empty-state-compact">${escapeHtml(tr('diff.empty'))}</div>`;
    return;
  }
  dom.diffDrawerBody.innerHTML = renderDiffHtml(data, tr);
}

async function openWorkerDiff(name: string): Promise<void> {
  state.activeDiffWorker = name;
  dom.logDrawer.classList.add('hidden');
  dom.diffDrawerTitle.textContent = tr('diff.titleFor', { name });
  dom.diffDrawerBody.innerHTML = `<div class="empty-state-compact">...</div>`;
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

dom.settingsDefaultSelect.addEventListener('change', () => {
  const val = dom.settingsDefaultSelect.value.trim();
  void saveProviderPatch(
    { default_provider: val ? val : null },
    tr('settings.savedToast'),
  );
});

dom.settingsOpenOnboardingBtn.addEventListener('click', () => {
  void openOnboardingWizard();
});

dom.settingsRescanBtn.addEventListener('click', () => {
  void loadProviderConfig();
});

dom.settingsToggleAddBtn.addEventListener('click', () => {
  dom.settingsAddPanel.classList.toggle('hidden');
  if (!dom.settingsAddPanel.classList.contains('hidden')) {
    dom.customAddIdInput.focus();
  }
});

dom.settingsAddCancelBtn.addEventListener('click', () => {
  dom.settingsAddPanel.classList.add('hidden');
  dom.settingsAddPanel.reset();
});

document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const presetKey = btn.dataset.preset;
    if (presetKey) applyCustomPreset(presetKey);
  });
});

document.querySelectorAll<HTMLButtonElement>('[data-settings-subtab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const subtab = btn.dataset.settingsSubtab as 'clis' | 'routing';
    if (subtab) switchSettingsSubtab(subtab);
  });
});

dom.routingAutoFailover.addEventListener('change', () => {
  state.routingDraftDirty = true;
  renderRoutingSummaryChips();
});

dom.routingNotesInput.addEventListener('input', () => {
  state.routingDraftDirty = true;
  state.routingDraftNotes = dom.routingNotesInput.value;
  renderRoutingSummaryChips();
});

dom.routingTurnTimeoutInput.addEventListener('input', () => {
  state.routingDraftDirty = true;
  state.routingDraftTurnTimeout = dom.routingTurnTimeoutInput.value;
  renderRoutingSummaryChips();
});

dom.routingStallTimeoutInput.addEventListener('input', () => {
  state.routingDraftDirty = true;
  state.routingDraftStallTimeout = dom.routingStallTimeoutInput.value;
  renderRoutingSummaryChips();
});


dom.routingSaveBtn.addEventListener('click', async () => {
  const defaultTurnTimeoutSeconds = parseOptionalTimeoutInput(
    dom.routingTurnTimeoutInput.value,
    MAX_TURN_TIMEOUT_SECONDS,
  );
  const defaultStallTimeoutSeconds = parseOptionalTimeoutInput(
    dom.routingStallTimeoutInput.value,
    MAX_STALL_TIMEOUT_SECONDS,
  );
  if (defaultTurnTimeoutSeconds === 'invalid' || defaultStallTimeoutSeconds === 'invalid') {
    showSettingsToast(tr('routing.invalidTimeout'), true);
    return;
  }

  await withBusyButton(dom.routingSaveBtn, async () => {
    const activePool = [...state.routingDraftActive];
    const writerProviders = [...state.routingDraftWriter];
    const readerProviders = [...state.routingDraftReader];
    const autoFailover = dom.routingAutoFailover.checked;
    const draftTaskObj: TaskRoutingMap = {};
    for (const cat of TASK_ROUTING_ORDER) {
      const items = state.routingDraftTasks.get(cat);
      if (items && items.length > 0) draftTaskObj[cat] = items;
    }
    const taskRoutingPayload = serializeTaskRoutingMap(draftTaskObj);
    const notesTrimmed = dom.routingNotesInput.value.trim().slice(0, 600);
    const hasCustomPolicy =
      writerProviders.length > 0 ||
      readerProviders.length > 0 ||
      autoFailover ||
      state.routingDraftDelegation !== 'balanced' ||
      Boolean(taskRoutingPayload) ||
      Boolean(notesTrimmed);
    const routingPolicy = hasCustomPolicy
      ? {
          ...(writerProviders.length > 0 ? { writer_providers: writerProviders } : {}),
          ...(readerProviders.length > 0 ? { reader_providers: readerProviders } : {}),
          auto_failover: autoFailover,
          delegation_mode: state.routingDraftDelegation,
          ...(taskRoutingPayload ? { task_routing: taskRoutingPayload } : {}),
          ...(notesTrimmed ? { routing_notes: notesTrimmed } : {}),
        }
      : null;

    const ok = await saveProviderPatch(
      {
        active_pool: activePool.length > 0 ? activePool : null,
        routing_policy: routingPolicy,
        default_turn_timeout_seconds: defaultTurnTimeoutSeconds,
        default_stall_timeout_seconds: defaultStallTimeoutSeconds,
      },
      tr('routing.savedToast'),
    );
    if (ok) {
      state.routingDraftDirty = false;
    }
    await refreshSnapshot(true);
  });
});

dom.btnTogglePricing.addEventListener('click', () => {
  state.pricingExpanded = !state.pricingExpanded;
  if (state.latestProviderConfig) {
    renderPricingSection(state.latestProviderConfig);
  }
});

dom.pricingForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const model = dom.pricingModelInput.value.trim();
  const inputPer1M = Number(dom.pricingInputRate.value);
  const outputPer1M = Number(dom.pricingOutputRate.value);
  const cacheVal = dom.pricingCacheRate.value.trim();
  const cacheReadPer1M = cacheVal ? Number(cacheVal) : undefined;
  const currency = dom.pricingCurrencySelect.value === 'CNY' ? 'CNY' : 'USD';
  if (!model || !Number.isFinite(inputPer1M) || !Number.isFinite(outputPer1M)) return;

  const ok = await saveProviderPatch(
    {
      upsert_pricing: {
        model,
        pricing: {
          inputPer1M,
          outputPer1M,
          currency,
          ...(cacheReadPer1M !== undefined && Number.isFinite(cacheReadPer1M)
            ? { cacheReadPer1M }
            : {}),
        },
      },
    },
    tr('settings.savedToast'),
  );
  if (ok) {
    dom.pricingForm.reset();
    await refreshSnapshot(true);
  }
});

dom.settingsAddPanel.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = dom.customAddIdInput.value.trim().toLowerCase();
  const command = dom.customAddCmdInput.value.trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id) || !command) {
    showSettingsToast(tr('settings.errorRequired'), true);
    return;
  }
  const displayName = dom.customAddNameInput.value.trim();
  const defaultModel = dom.customAddDefaultModelInput.value.trim();
  const promptMode = dom.customAddPromptMode.value as 'stdin' | 'arg';
  const outputFormat = dom.customAddOutputFormat.value as 'text' | 'ndjson';
  const args = parseArgsFromInput(dom.customAddArgsInput.value);
  const resumeArgs = parseArgsFromInput(dom.customAddResumeArgsInput.value);
  const listModelsArgs = parseArgsFromInput(dom.customAddListModelsArgsInput.value);
  const models = splitModelList(dom.customAddModelsInput.value);
  const env = parseEnvText(dom.customAddEnvInput.value);

  const config: Record<string, unknown> = {
    enabled: true,
    command,
    promptMode,
    outputFormat,
    ...(displayName ? { displayName } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    ...(args ? { args } : {}),
    ...(resumeArgs ? { resumeArgs } : {}),
    ...(listModelsArgs ? { listModelsArgs } : {}),
    ...(models.length > 0 ? { models } : {}),
    ...(env ? { env } : {}),
  };

  const ok = await saveProviderPatch(
    { upsert_provider: { id, config } },
    tr('settings.savedToast'),
  );
  if (ok) {
    state.settingsExpanded.add(id);
    dom.settingsAddPanel.reset();
    dom.settingsAddPanel.classList.add('hidden');
    renderSettingsView();
  }
});

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
    if (state.latestSnapshot) renderSnapshot(state.latestSnapshot, true);
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

dom.boardFeed.addEventListener('click', (e) => {
  const target = e.target as HTMLElement | null;
  const jumpBtn = target?.closest<HTMLButtonElement>('[data-jump-seq]');
  if (jumpBtn?.dataset.jumpSeq) {
    jumpToSeq(Number(jumpBtn.dataset.jumpSeq));
    return;
  }
  const emptyBtn = target?.closest<HTMLButtonElement>('[data-empty-action]');
  const emptyAct = emptyBtn?.dataset.emptyAction;
  if (emptyAct === 'create' || emptyAct === 'templates') {
    switchTab('workers');
    if (state.activeCommanderPanel !== emptyAct) {
      toggleCommanderPanel(emptyAct);
    }
  } else if (emptyAct === 'onboarding') {
    void openOnboardingWizard();
  } else if (emptyAct === 'settings') {
    switchTab('settings');
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
  dom.diffDrawer.classList.add('hidden');
});

dom.boardFilter.addEventListener('input', () => {
  if (state.latestSnapshot) renderBoard(state.latestSnapshot.messages);
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

dom.logModeToggle.addEventListener('click', () => {
  state.logRawMode = !state.logRawMode;
  renderLogDrawerBody();
});

dom.logDrawerRefresh.addEventListener('click', () => {
  if (state.activeLogWorker) void openWorkerLogs(state.activeLogWorker);
});

dom.logDrawerClose.addEventListener('click', () => {
  state.activeLogWorker = null;
  dom.logDrawer.classList.add('hidden');
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


function toggleCommanderPanel(next: 'create' | 'add' | 'arena' | 'templates' | null): void {
  state.activeCommanderPanel = state.activeCommanderPanel === next ? null : next;
  dom.cmdPanelCreate.classList.toggle('hidden', state.activeCommanderPanel !== 'create');
  dom.cmdPanelAdd.classList.toggle('hidden', state.activeCommanderPanel !== 'add');
  dom.cmdPanelArena.classList.toggle('hidden', state.activeCommanderPanel !== 'arena');
  dom.cmdPanelTemplates.classList.toggle('hidden', state.activeCommanderPanel !== 'templates');

  const fallbackRepo =
    state.latestSnapshot?.swarm?.repoRoot || state.latestSnapshot?.swarms?.at(-1)?.repoRoot || '';
  if (state.activeCommanderPanel === 'create' && !dom.createSwarmRepo.value.trim() && fallbackRepo) {
    dom.createSwarmRepo.value = fallbackRepo;
  }
  if (state.activeCommanderPanel === 'arena' && state.arenaSlots.length < 2) {
    const enabled = (
      state.latestSnapshot?.providerConfig?.providers ||
      state.latestProviderConfig?.providers ||
      []
    ).filter((p) => p.enabled);
    const preferred = enabled.filter((p) => p.available);
    const seed = preferred.length >= 2 ? preferred : enabled;
    state.arenaSlots = [
      { provider: seed[0]?.id || 'dsh', model: seed[0]?.defaultModel || '' },
      { provider: seed[1]?.id || seed[0]?.id || 'claude', model: seed[1]?.defaultModel || '' },
    ];
    renderArenaContestantRows();
  }
  if (state.activeCommanderPanel === 'templates') {
    if (!dom.tplRepo.value.trim() && fallbackRepo) {
      dom.tplRepo.value = fallbackRepo;
    }
    if (!state.latestTemplatesConfig) {
      void fetchTemplatesFromServer();
    } else {
      renderTemplatePreview();
    }
  }
}




function renderArenaQuickPicks(): void {
  const enabled = getEnabledProvidersForUi();
  const checkedSet = new Set(state.arenaSlots.map((s) => s.provider));
  renderCliCheckboxGrid(dom.arenaQuickPicks, enabled, checkedSet, (id, on) => {
    const prov = enabled.find((p) => p.id === id);
    if (on) {
      if (!state.arenaSlots.some((s) => s.provider === id)) {
        state.arenaSlots.push({ provider: id, model: prov?.defaultModel || '' });
      }
    } else {
      state.arenaSlots = state.arenaSlots.filter((s) => s.provider !== id);
    }
    renderArenaContestantRows();
  });
}

function renderArenaContestantRows(): void {
  const providers = getEnabledProvidersForUi();
  renderArenaQuickPicks();
  dom.arenaContestants.innerHTML = '';
  state.arenaSlots.forEach((slot, idx) => {
    const row = document.createElement('div');
    row.className = 'arena-contestant-row';
    const options = providers.length
      ? providers
          .map(
            (p) =>
              `<option value="${escapeHtml(p.id)}" ${p.id === slot.provider ? 'selected' : ''}>${escapeHtml(p.displayName)} (${escapeHtml(p.id)})</option>`,
          )
          .join('')
      : `<option value="${escapeHtml(slot.provider)}" selected>${escapeHtml(slot.provider)}</option>`;
    row.innerHTML = `
      <select class="input input-sm" data-arena-prov>${options}</select>
      <input class="input input-sm mono-input" type="text" list="dl-prov-models-${escapeHtml(slot.provider)}" data-arena-model value="${escapeHtml(slot.model)}" placeholder="default" />
      <button type="button" class="btn btn-sm btn-ghost" data-arena-rm>×</button>
    `;
    const provSel = row.querySelector<HTMLSelectElement>('[data-arena-prov]')!;
    const modInp = row.querySelector<HTMLInputElement>('[data-arena-model]')!;
    provSel.addEventListener('change', () => {
      const chosen = providers.find((p) => p.id === provSel.value);
      state.arenaSlots[idx].provider = provSel.value;
      state.arenaSlots[idx].model = chosen?.defaultModel || '';
      modInp.value = state.arenaSlots[idx].model;
      modInp.setAttribute('list', `dl-prov-models-${provSel.value}`);
      renderArenaQuickPicks();
    });
    modInp.addEventListener('input', () => {
      state.arenaSlots[idx].model = modInp.value;
    });
    row.querySelector<HTMLButtonElement>('[data-arena-rm]')!.addEventListener('click', () => {
      state.arenaSlots.splice(idx, 1);
      renderArenaContestantRows();
    });
    dom.arenaContestants.appendChild(row);
  });
}

function renderTemplatePreview(): void {
  const templates = state.latestTemplatesConfig?.templates || [];
  const selectedId = dom.tplSelect.value || templates[0]?.id || '';
  const tpl = templates.find((t) => t.id === selectedId) || templates[0];
  if (!tpl) {
    dom.tplDesc.textContent = '';
    dom.tplRoleGrid.innerHTML = '';
    dom.tplDeleteBtn.classList.add('hidden');
    return;
  }
  dom.tplDesc.textContent = tpl.description || tpl.name;

  const enabled = getEnabledProvidersForUi();
  dom.tplRoleGrid.innerHTML = '';
  for (const w of tpl.workers) {
    const key = `${tpl.id}:${w.name}`;
    const saved = state.tplRoleOverrides.get(key) || {
      provider: w.provider || '',
      model: w.model || '',
    };
    const row = document.createElement('div');
    row.className = 'tpl-role-row';
    const provOpts = [
      `<option value="">${escapeHtml(tr('cmd.tplRoleAuto'))}</option>`,
      ...enabled.map(
        (p) =>
          `<option value="${escapeHtml(p.id)}" ${p.id === saved.provider ? 'selected' : ''}>${escapeHtml(p.displayName)} (${escapeHtml(p.id)})</option>`,
      ),
    ].join('');

    const effectiveRoleProv =
      saved.provider ||
      state.latestSnapshot?.swarm?.defaultProvider ||
      state.latestSnapshot?.providerConfig?.effectiveDefaultProvider ||
      '';
    row.innerHTML = `
      <div class="tpl-role-label-wrap" title="${escapeHtml(w.role)}">
        <span class="tpl-role-label">${escapeHtml(w.name)}</span>
        ${w.dependsOn && w.dependsOn.length > 0 ? `<span class="tpl-role-dep">← ${escapeHtml(w.dependsOn.join(','))}</span>` : ''}
      </div>
      <select class="input input-sm" data-tpl-role-prov>${provOpts}</select>
      <input class="input input-sm mono-input" type="text" list="dl-prov-models-${escapeHtml(effectiveRoleProv)}" data-tpl-role-model value="${escapeHtml(saved.model || '')}" placeholder="model (auto)" />
    `;
    const provSel = row.querySelector<HTMLSelectElement>('[data-tpl-role-prov]')!;
    const modInp = row.querySelector<HTMLInputElement>('[data-tpl-role-model]')!;
    const syncRole = () => {
      const chosenProv =
        provSel.value.trim() ||
        state.latestSnapshot?.swarm?.defaultProvider ||
        state.latestSnapshot?.providerConfig?.effectiveDefaultProvider ||
        '';
      modInp.setAttribute('list', `dl-prov-models-${chosenProv}`);
      state.tplRoleOverrides.set(key, {
        provider: provSel.value.trim() || undefined,
        model: modInp.value.trim() || undefined,
      });
    };
    provSel.addEventListener('change', syncRole);
    modInp.addEventListener('input', syncRole);
    dom.tplRoleGrid.appendChild(row);
  }

  dom.tplDeleteBtn.classList.toggle('hidden', tpl.kind !== 'custom');
}

function isEditingInsideCommanderPanels(): boolean {
  const ae = document.activeElement as HTMLElement | null;
  if (!ae) return false;
  const inPanel =
    dom.cmdPanelCreate.contains(ae) ||
    dom.cmdPanelAdd.contains(ae) ||
    dom.cmdPanelArena.contains(ae) ||
    dom.cmdPanelTemplates.contains(ae);
  if (!inPanel) return false;
  return ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT';
}

function computeCommanderConfigSignature(): string {
  const providers =
    state.latestSnapshot?.providerConfig?.providers || state.latestProviderConfig?.providers || [];
  const provSig = providers
    .map(
      (p) =>
        `${p.id}:${p.enabled ? 1 : 0}:${p.available ? 1 : 0}:${p.defaultModel || ''}:${p.detectedModelProvider || ''}:${(p.detectedModelProviders || []).join('|')}:${(p.models || []).join('|')}:${(p.detectedModels || []).join('|')}:${(p.warnings || []).join('|')}`,
    )
    .join(';');
  const tplSig = (state.latestTemplatesConfig?.templates || [])
    .map((t) => `${t.id}:${t.name}:${t.kind}:${t.workers.length}`)
    .join(',');
  const repoRootsSig = (state.latestSnapshot?.swarms || [])
    .map((s) => s.repoRoot || '')
    .join(',');
  const activePoolSig = (state.latestSnapshot?.providerConfig?.activePool || []).join(',');
  const autoFailoverSig = state.latestSnapshot?.providerConfig?.routingPolicy?.autoFailover ? 1 : 0;
  const timeoutDefaultsSig = `${state.latestSnapshot?.providerConfig?.defaultTurnTimeoutSeconds ?? ''}:${state.latestSnapshot?.providerConfig?.defaultStallTimeoutSeconds ?? ''}`;
  return `${state.currentLocale}:${state.latestSnapshot?.swarm?.id || ''}:${state.latestSnapshot?.swarm?.repoRoot || ''}:${state.latestSnapshot?.swarm?.defaultProvider || ''}:${state.latestSnapshot?.providerConfig?.effectiveDefaultProvider || ''}:${repoRootsSig}:${activePoolSig}:${autoFailoverSig}:${timeoutDefaultsSig}:${provSig}:${tplSig}`;
}

function syncCommanderControls(force = false): void {
  const hasSwarm = Boolean(state.latestSnapshot?.swarm);
  const swarmMembers = Object.values(state.latestSnapshot?.swarm?.members || {});
  const hasAliveMembers = swarmMembers.some((m) => m.status !== 'killed');
  dom.cmdToggleAdd.disabled = !hasSwarm;
  dom.cmdToggleArena.disabled = !hasSwarm;
  dom.cmdToggleCreate.classList.toggle('btn-primary', !hasSwarm);
  dom.cmdToggleCreate.classList.toggle('btn-ghost', hasSwarm);
  dom.cmdToggleAdd.classList.toggle('btn-primary', hasSwarm);
  dom.cmdToggleAdd.classList.toggle('btn-ghost', !hasSwarm);
  dom.cmdKillAll.classList.toggle('hidden', !hasAliveMembers);
  dom.cmdKillAll.textContent = tr(state.pendingKillAll ? 'workers.confirmKillAll' : 'workers.killAllBtn');
  dom.tplFromSwarmBtn.classList.toggle('hidden', swarmMembers.length === 0);

  if (!hasSwarm && (state.activeCommanderPanel === 'add' || state.activeCommanderPanel === 'arena')) {
    toggleCommanderPanel(null);
  }

  const cfgSig = computeCommanderConfigSignature();
  if (!force && cfgSig === state.lastCommanderConfigSignature) {
    return;
  }
  if (!force && isEditingInsideCommanderPanels()) {
    state.commanderDeferredSync = true;
    return;
  }
  state.commanderDeferredSync = false;
  state.lastCommanderConfigSignature = cfgSig;

  syncProviderModelDatalists();
  dom.createSwarmTurnTimeout.placeholder = String(
    state.latestSnapshot?.providerConfig?.defaultTurnTimeoutSeconds ?? DEFAULT_TURN_TIMEOUT_SECONDS,
  );
  dom.createSwarmStallTimeout.placeholder = String(
    state.latestSnapshot?.providerConfig?.defaultStallTimeoutSeconds ?? DEFAULT_STALL_TIMEOUT_SECONDS,
  );

  const repoSet = new Set<string>();
  if (state.latestSnapshot?.swarm?.repoRoot) repoSet.add(state.latestSnapshot.swarm.repoRoot);
  for (const sItem of [...(state.latestSnapshot?.swarms || [])].reverse()) {
    if (sItem.repoRoot) repoSet.add(sItem.repoRoot);
  }
  dom.dlRepoHistory.innerHTML = '';
  for (const rPath of repoSet) {
    const opt = document.createElement('option');
    opt.value = rPath;
    dom.dlRepoHistory.appendChild(opt);
  }

  const enabled = getEnabledProvidersForUi();
  const prevPrimary = dom.createSwarmProvider.value;
  dom.createSwarmProvider.innerHTML = '';
  for (const p of enabled) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.displayName} (${p.id})${p.available ? '' : ' [!]'}`;
    dom.createSwarmProvider.appendChild(opt);
  }
  if (prevPrimary && enabled.some((p) => p.id === prevPrimary)) {
    dom.createSwarmProvider.value = prevPrimary;
  } else if (state.latestSnapshot?.swarm?.defaultProvider) {
    dom.createSwarmProvider.value = state.latestSnapshot.swarm.defaultProvider;
  } else if (state.latestSnapshot?.providerConfig?.effectiveDefaultProvider) {
    dom.createSwarmProvider.value = state.latestSnapshot.providerConfig.effectiveDefaultProvider;
  }

  if (state.createPoolDraft === null) {
    const globalPool = state.latestSnapshot?.providerConfig?.activePool;
    state.createPoolDraft =
      globalPool && globalPool.length > 0
        ? [...globalPool]
        : enabled.filter((p) => p.available).map((p) => p.id);
    dom.createSwarmFailover.checked = Boolean(
      state.latestSnapshot?.providerConfig?.routingPolicy?.autoFailover,
    );
  }
  const createPoolSet = new Set(state.createPoolDraft);
  renderCliCheckboxGrid(dom.createSwarmPool, enabled, createPoolSet, (id, on) => {
    const cur = new Set(state.createPoolDraft || []);
    if (on) cur.add(id);
    else cur.delete(id);
    state.createPoolDraft = [...cur];
  });

  renderCliCheckboxGrid(dom.addWorkerProviders, enabled, state.addProvidersDraft, (id, on) => {
    if (on) state.addProvidersDraft.add(id);
    else state.addProvidersDraft.delete(id);
    syncAddWorkerModelDatalist();
  });
  syncAddWorkerModelDatalist();

  const templates = state.latestTemplatesConfig?.templates || [];
  const prevTpl = dom.tplSelect.value;
  dom.tplSelect.innerHTML = '';
  for (const tItem of templates) {
    const opt = document.createElement('option');
    opt.value = tItem.id;
    opt.textContent = `${tItem.name} [${tItem.kind}]`;
    dom.tplSelect.appendChild(opt);
  }
  if (prevTpl && templates.some((tItem) => tItem.id === prevTpl)) {
    dom.tplSelect.value = prevTpl;
  }
  renderTemplatePreview();
  if (state.activeCommanderPanel === 'arena') {
    renderArenaContestantRows();
  }
}

async function fetchTemplatesFromServer(): Promise<void> {
  try {
    const res = await app.callServerTool({
      name: 'app_get_templates',
      arguments: {
        ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
      },
    });
    const errMsg = extractToolErrorMessage(res);
    if (errMsg) {
      showCommanderToast(errMsg, true);
      return;
    }
    const sc = res.structuredContent as { templatesConfig?: TemplatesConfigSnapshot } | undefined;
    if (sc?.templatesConfig) {
      state.latestTemplatesConfig = sc.templatesConfig;
      syncCommanderControls(true);
    }
  } catch (err) {
    showCommanderToast(err instanceof Error ? err.message : String(err), true);
  }
}

async function previewMergeFromUi(name: string): Promise<void> {
  state.mergePreviews.set(name, { loading: true });
  if (state.latestSnapshot?.swarm) {
    renderWorkers(Object.values(state.latestSnapshot.swarm.members || {}), state.latestSnapshot.diffs || {});
  }
  try {
    const res = await app.callServerTool({
      name: 'app_preview_merge',
      arguments: {
        ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
        name,
      },
    });
    const errMsg = extractToolErrorMessage(res);
    if (errMsg) {
      state.mergePreviews.set(name, { loading: false, error: errMsg });
    } else {
      const sc = res.structuredContent as { preview?: MergePreviewResult } | undefined;
      state.mergePreviews.set(name, { loading: false, data: sc?.preview });
    }
  } catch (err) {
    state.mergePreviews.set(name, {
      loading: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (state.latestSnapshot?.swarm) {
    renderWorkers(Object.values(state.latestSnapshot.swarm.members || {}), state.latestSnapshot.diffs || {});
  }
}

async function applyMergeFromUi(name: string): Promise<void> {
  const draft = state.mergeDrafts.get(name) || {
    mode: 'squash' as const,
    removeWt: true,
    commitMsg: '',
  };
  try {
    const res = await app.callServerTool({
      name: 'app_merge_worker',
      arguments: {
        ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
        name,
        mode: draft.mode,
        remove_worktree: draft.removeWt,
        ...(draft.commitMsg.trim() ? { commit_message: draft.commitMsg.trim() } : {}),
      },
    });
    const sc = res.structuredContent as MergeApplyResult | undefined;
    if (res.isError || sc?.merged === false) {
      showCommanderToast(extractToolErrorMessage(res) || sc?.message || 'Merge blocked', true);
      void previewMergeFromUi(name);
    } else {
      state.mergeOpenWorker = null;
      state.mergePreviews.delete(name);
      state.mergeDrafts.delete(name);
      showCommanderToast(tr('merge.applied', { msg: sc?.message || name }));
    }
    await refreshSnapshot(true);
  } catch (err) {
    showCommanderToast(err instanceof Error ? err.message : String(err), true);
  }
}

async function crossReviewFromUi(targetWorker: string): Promise<void> {
  try {
    const res = await app.callServerTool({
      name: 'app_cross_review',
      arguments: {
        ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
        target_worker: targetWorker,
      },
    });
    const errMsg = extractToolErrorMessage(res);
    if (errMsg) {
      showCommanderToast(errMsg, true);
      return;
    }
    const sc = res.structuredContent as { reviewer?: MemberState } | undefined;
    showCommanderToast(
      tr('cmd.toastReviewStarted', {
        reviewer: sc?.reviewer?.name || 'reviewer',
        target: targetWorker,
      }),
    );
    await refreshSnapshot(true);
  } catch (err) {
    showCommanderToast(err instanceof Error ? err.message : String(err), true);
  }
}

dom.cmdToggleCreate.addEventListener('click', () => toggleCommanderPanel('create'));
dom.cmdToggleAdd.addEventListener('click', () => toggleCommanderPanel('add'));
dom.cmdToggleArena.addEventListener('click', () => toggleCommanderPanel('arena'));
dom.cmdToggleTemplates.addEventListener('click', () => toggleCommanderPanel('templates'));
dom.cmdKillAll.addEventListener('click', () => {
  if (!state.latestSnapshot?.swarm) return;
  if (!state.pendingKillAll) {
    state.pendingKillAll = true;
    dom.cmdKillAll.textContent = tr('workers.confirmKillAll');
    if (state.pendingKillAllTimer !== null) window.clearTimeout(state.pendingKillAllTimer);
    state.pendingKillAllTimer = window.setTimeout(() => {
      state.pendingKillAll = false;
      state.pendingKillAllTimer = null;
      dom.cmdKillAll.textContent = tr('workers.killAllBtn');
    }, 3500);
    return;
  }
  clearPendingKillState();
  dom.cmdKillAll.textContent = tr('workers.killAllBtn');
  void killWorkerFromUi('all', false);
});
dom.cmdCreateCancel.addEventListener('click', () => toggleCommanderPanel(null));
dom.cmdAddCancel.addEventListener('click', () => toggleCommanderPanel(null));
dom.cmdArenaCancel.addEventListener('click', () => toggleCommanderPanel(null));
dom.cmdTemplatesCancel.addEventListener('click', () => toggleCommanderPanel(null));

dom.arenaAddRow.addEventListener('click', () => {
  const providers = getEnabledProvidersForUi();
  const next = providers[state.arenaSlots.length % Math.max(1, providers.length)];
  state.arenaSlots.push({ provider: next?.id || 'dsh', model: next?.defaultModel || '' });
  renderArenaContestantRows();
});

dom.tplSelect.addEventListener('change', () => renderTemplatePreview());

dom.tplToggleSave.addEventListener('click', () => {
  const hidden = dom.tplSaveForm.classList.toggle('hidden');
  if (!hidden && !dom.tplSaveWorkers.value.trim()) {
    dom.tplSaveWorkers.value = JSON.stringify(
      [
        {
          name: 'impl',
          role: 'Implementer',
          workspace: 'worktree',
          permission: 'workspace-write',
          brief: 'Implement: {{goal}}',
        },
        {
          name: 'review',
          role: 'Reviewer',
          workspace: 'inherit',
          permission: 'read-only',
          dependsOn: ['impl'],
          brief: 'Review @impl for: {{goal}}',
        },
      ],
      null,
      2,
    );
  }
});

dom.tplSaveCancel.addEventListener('click', () => {
  dom.tplSaveForm.classList.add('hidden');
});

dom.tplFromSwarmBtn.addEventListener('click', () => {
  const swarm = state.latestSnapshot?.swarm;
  if (!swarm) return;
  const allMembers = Object.values(swarm.members || {});
  const chosen = allMembers.filter((m) => m.status !== 'killed');
  const sourceMembers = chosen.length > 0 ? chosen : allMembers;
  if (sourceMembers.length === 0) return;

  const specs = sourceMembers.map((m) => ({
    name: m.name,
    role: m.role,
    workspace: m.workspaceMode,
    permission: m.permissionMode,
    ...(m.provider ? { provider: m.provider } : {}),
    ...(m.model && m.model !== 'default' ? { model: m.model } : {}),
    ...(m.dependsOn?.length ? { dependsOn: m.dependsOn } : {}),
    ...(m.allowedFiles?.length ? { allowedFiles: m.allowedFiles } : {}),
    ...(m.verifyCommands?.length ? { verifyCommands: m.verifyCommands } : {}),
    ...(m.autoVerify ? { autoVerify: true } : {}),
    brief: `Execute ${m.role} tasks for:\n{{goal}}`,
  }));
  dom.tplSaveWorkers.value = JSON.stringify(specs, null, 2);
  if (!dom.tplSaveId.value.trim()) {
    const slug = swarm.title
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
    dom.tplSaveId.value = slug || 'custom-squad';
  }
  if (!dom.tplSaveName.value.trim()) {
    dom.tplSaveName.value = swarm.title;
  }
  showGlobalToast(tr('cmd.tplFromSwarmToast', { n: specs.length }));
});

dom.tplDeleteBtn.addEventListener('click', async () => {
  const id = dom.tplSelect.value;
  if (!id) return;
  await withBusyButton(dom.tplDeleteBtn, async () => {
    try {
      const res = await app.callServerTool({
        name: 'app_save_template',
        arguments: {
          ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
          remove_template_id: id,
        },
      });
      const errMsg = extractToolErrorMessage(res);
      if (errMsg) {
        showCommanderToast(errMsg, true);
        return;
      }
      const sc = res.structuredContent as { templatesConfig?: TemplatesConfigSnapshot } | undefined;
      if (sc?.templatesConfig) state.latestTemplatesConfig = sc.templatesConfig;
      syncCommanderControls(true);
      showCommanderToast(tr('cmd.toastTemplateDeleted', { id }));
    } catch (err) {
      showCommanderToast(err instanceof Error ? err.message : String(err), true);
    }
  });
});

dom.cmdPanelCreate.addEventListener('submit', async (e) => {
  e.preventDefault();
  const repoRoot = dom.createSwarmRepo.value.trim();
  if (!repoRoot) return;
  const rawConc = dom.createSwarmConcurrency.value.trim();
  let maxConcurrency: number | undefined;
  if (rawConc) {
    if (!/^\d+$/.test(rawConc)) {
      showCommanderToast(tr('cmd.invalidCreateParams'), true);
      return;
    }
    const n = Number(rawConc);
    if (!Number.isSafeInteger(n) || n < 1 || n > 16) {
      showCommanderToast(tr('cmd.invalidCreateParams'), true);
      return;
    }
    maxConcurrency = n;
  }
  const parsedTurnTo = parseOptionalTimeoutInput(
    dom.createSwarmTurnTimeout.value,
    MAX_TURN_TIMEOUT_SECONDS,
  );
  const parsedStallTo = parseOptionalTimeoutInput(
    dom.createSwarmStallTimeout.value,
    MAX_STALL_TIMEOUT_SECONDS,
  );
  if (parsedTurnTo === 'invalid' || parsedStallTo === 'invalid') {
    showCommanderToast(tr('routing.invalidTimeout'), true);
    return;
  }

  const submitBtn = dom.cmdPanelCreate.querySelector<HTMLButtonElement>('button[type="submit"]');
  await withBusyButton(submitBtn, async () => {
    const activeProviders = (state.createPoolDraft || []).filter(Boolean);
    const autoFailover = dom.createSwarmFailover.checked;
    const globalPolicy = state.latestSnapshot?.providerConfig?.routingPolicy;
    const taskRoutingPayload = serializeTaskRoutingMap(globalPolicy?.taskRouting);
    const routingPolicy =
      globalPolicy || autoFailover
        ? {
            ...(globalPolicy?.writerProviders?.length
              ? { writer_providers: globalPolicy.writerProviders }
              : {}),
            ...(globalPolicy?.readerProviders?.length
              ? { reader_providers: globalPolicy.readerProviders }
              : {}),
            ...(globalPolicy?.delegationMode
              ? { delegation_mode: globalPolicy.delegationMode }
              : {}),
            ...(taskRoutingPayload ? { task_routing: taskRoutingPayload } : {}),
            ...(globalPolicy?.routingNotes
              ? { routing_notes: globalPolicy.routingNotes }
              : {}),
            auto_failover: autoFailover,
          }
        : undefined;
    try {
      const res = await app.callServerTool({
        name: 'app_create_swarm',
        arguments: {
          repo_root: repoRoot,
          title: dom.createSwarmTitle.value.trim() || undefined,
          default_provider: dom.createSwarmProvider.value || undefined,
          ...(activeProviders.length > 0 ? { active_providers: activeProviders } : {}),
          ...(routingPolicy ? { routing_policy: routingPolicy } : {}),
          ...(maxConcurrency !== undefined ? { max_concurrency: maxConcurrency } : {}),
          ...(parsedTurnTo !== null ? { turn_timeout_seconds: parsedTurnTo } : {}),
          ...(parsedStallTo !== null ? { stall_timeout_seconds: parsedStallTo } : {}),
        },
      });
      const errMsg = extractToolErrorMessage(res);
      if (errMsg) {
        showCommanderToast(errMsg, true);
        return;
      }
      const sc = res.structuredContent as { swarm?: SwarmState } | undefined;
      if (sc?.swarm?.id && sc.swarm.id !== state.currentSwarmId) {
        state.currentSwarmId = sc.swarm.id;
        resetSwarmScopedUiState(false);
      }
      state.createPoolDraft = null;
      toggleCommanderPanel(null);
      dom.cmdPanelCreate.reset();
      showCommanderToast(tr('cmd.toastCreated', { title: sc?.swarm?.title || repoRoot }));
      await refreshSnapshot(true);
    } catch (err) {
      showCommanderToast(err instanceof Error ? err.message : String(err), true);
    }
  });
});

dom.cmdPanelAdd.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = dom.addWorkerName.value.trim();
  const brief = dom.addWorkerBrief.value.trim();
  if (!name || !brief) return;
  const submitBtn = dom.cmdPanelAdd.querySelector<HTMLButtonElement>('button[type="submit"]');
  await withBusyButton(submitBtn, async () => {
    const deps = dom.addWorkerDeps.value
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const tasks = dom.addWorkerTasks.value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const allowedFiles = splitModelList(dom.addWorkerAllowed.value);
    const verifyCommands = dom.addWorkerVerify.value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const autoVerify = dom.addWorkerAutoVerify.checked;
    const chosenProviders = [...state.addProvidersDraft];
    try {
      const res = await app.callServerTool({
        name: 'app_add_worker',
        arguments: {
          ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
          name,
          brief,
          role: dom.addWorkerRole.value.trim() || undefined,
          ...(chosenProviders.length === 1
            ? { provider: chosenProviders[0] }
            : chosenProviders.length >= 2
              ? { providers: chosenProviders }
              : {}),
          model: dom.addWorkerModel.value.trim() || undefined,
          permission_mode: dom.addWorkerPerm.value,
          workspace: dom.addWorkerWs.value,
          ...(tasks.length > 0 ? { tasks } : {}),
          ...(allowedFiles.length > 0 ? { allowed_files: allowedFiles } : {}),
          ...(verifyCommands.length > 0 ? { verify_commands: verifyCommands } : {}),
          ...(autoVerify ? { auto_verify: true } : {}),
          ...(deps.length > 0 ? { depends_on: deps } : {}),
        },
      });
      const errMsg = extractToolErrorMessage(res);
      if (errMsg) {
        showCommanderToast(errMsg, true);
        return;
      }
      state.addProvidersDraft.clear();
      syncCommanderControls(true);
      toggleCommanderPanel(null);
      dom.cmdPanelAdd.reset();
      showCommanderToast(tr('cmd.toastAdded', { name }));
      await refreshSnapshot(true);
    } catch (err) {
      showCommanderToast(err instanceof Error ? err.message : String(err), true);
    }
  });
});

dom.cmdPanelArena.addEventListener('submit', async (e) => {
  e.preventDefault();
  const task = dom.arenaTask.value.trim();
  if (!task || state.arenaSlots.length < 2) {
    showCommanderToast(tr('cmd.arenaNeedTwo'), true);
    return;
  }
  const submitBtn = dom.cmdPanelArena.querySelector<HTMLButtonElement>('button[type="submit"]');
  await withBusyButton(submitBtn, async () => {
    try {
      const res = await app.callServerTool({
        name: 'app_start_arena',
        arguments: {
          ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
          task,
          base_name: dom.arenaBaseName.value.trim() || undefined,
          permission: dom.arenaPerm.value,
          contestants: state.arenaSlots.map((s) => ({
            provider: s.provider,
            ...(s.model.trim() ? { model: s.model.trim() } : {}),
          })),
        },
      });
      const errMsg = extractToolErrorMessage(res);
      if (errMsg) {
        showCommanderToast(errMsg, true);
        return;
      }
      const sc = res.structuredContent as { arenaGroup?: string } | undefined;
      toggleCommanderPanel(null);
      dom.arenaTask.value = '';
      showCommanderToast(tr('cmd.toastArena', { group: sc?.arenaGroup || 'arena' }));
      await refreshSnapshot(true);
    } catch (err) {
      showCommanderToast(err instanceof Error ? err.message : String(err), true);
    }
  });
});

dom.tplApplyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const templateId = dom.tplSelect.value;
  const goal = dom.tplGoal.value.trim();
  if (!templateId || !goal) return;
  const submitBtn = dom.tplApplyForm.querySelector<HTMLButtonElement>('button[type="submit"]');
  await withBusyButton(submitBtn, async () => {
    const tpl = state.latestTemplatesConfig?.templates?.find((t) => t.id === templateId);
    const providerOverrides: Record<string, string> = {};
    const modelOverrides: Record<string, string> = {};
    for (const w of tpl?.workers || []) {
      const ov = state.tplRoleOverrides.get(`${templateId}:${w.name}`);
      if (ov?.provider) providerOverrides[w.name] = ov.provider;
      if (ov?.model) modelOverrides[w.name] = ov.model;
    }
    try {
      const res = await app.callServerTool({
        name: 'app_apply_template',
        arguments: {
          ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
          template_id: templateId,
          goal,
          repo_root: dom.tplRepo.value.trim() || undefined,
          title: dom.tplTitle.value.trim() || undefined,
          ...(Object.keys(providerOverrides).length > 0
            ? { provider_overrides: providerOverrides }
            : {}),
          ...(Object.keys(modelOverrides).length > 0 ? { model_overrides: modelOverrides } : {}),
        },
      });
      const errMsg = extractToolErrorMessage(res);
      if (errMsg) {
        showCommanderToast(errMsg, true);
        return;
      }
      const sc = res.structuredContent as { swarmId?: string; added?: MemberState[]; template?: SwarmTemplate } | undefined;
      if (sc?.swarmId && sc.swarmId !== state.currentSwarmId) {
        state.currentSwarmId = sc.swarmId;
        resetSwarmScopedUiState(false);
      }
      toggleCommanderPanel(null);
      dom.tplGoal.value = '';
      showCommanderToast(
        tr('cmd.toastTemplateApplied', {
          name: sc?.template?.name || templateId,
          n: sc?.added?.length || 0,
        }),
      );
      await refreshSnapshot(true);
    } catch (err) {
      showCommanderToast(err instanceof Error ? err.message : String(err), true);
    }
  });
});

dom.tplSaveForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = dom.tplSaveId.value.trim().toLowerCase();
  const name = dom.tplSaveName.value.trim();
  if (!id || !name) return;
  const submitBtn = dom.tplSaveForm.querySelector<HTMLButtonElement>('button[type="submit"]');
  await withBusyButton(submitBtn, async () => {
    try {
      const workers = JSON.parse(dom.tplSaveWorkers.value);
      const res = await app.callServerTool({
        name: 'app_save_template',
        arguments: {
          ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
          upsert_template: {
            id,
            name,
            description: dom.tplSaveDesc.value.trim() || undefined,
            workers,
          },
        },
      });
      const errMsg = extractToolErrorMessage(res);
      if (errMsg) {
        showCommanderToast(errMsg, true);
        return;
      }
      const sc = res.structuredContent as { templatesConfig?: TemplatesConfigSnapshot } | undefined;
      if (sc?.templatesConfig) state.latestTemplatesConfig = sc.templatesConfig;
      dom.tplSaveForm.classList.add('hidden');
      syncCommanderControls(true);
      dom.tplSelect.value = id;
      renderTemplatePreview();
      showCommanderToast(tr('cmd.toastTemplateSaved', { id }));
    } catch (err) {
      showCommanderToast(err instanceof Error ? err.message : String(err), true);
    }
  });
});

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
  crossReviewFromUi,
  killWorkerFromUi,
  openWorkerDiff,
  openWorkerLogs,
  previewMergeFromUi,
  refreshSnapshot,
  renderSnapshot,
  retryOrSwitchWorker,
  switchTab,
  syncCommanderControls,
});

boot().catch((err) => {
  dom.metaSummary.textContent = `UI error: ${err instanceof Error ? err.message : String(err)}`;
});

