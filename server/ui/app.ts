import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import {
  calcInputCacheHit,
  calcModelCostValue,
  escapeHtml,
  formatArgsForInput,
  formatMessageHtml,
  formatMoney,
  formatNum,
  formatTime as formatTimeLocale,
  parseArgsFromInput,
  splitModelList,
  sumMembersCost,
  sumModelMapCost,
} from './format.js';
import { detectDefaultLocale, t, type I18nKey, type Locale } from './i18n.js';
import { CUSTOM_CLI_PRESETS } from './presets.js';
import { renderDiffHtml, renderStructuredEventsHtml } from './render-events.js';
import type {
  BoardMessage,
  CoordinatorConversationEntry,
  CoordinatorUsageSummary,
  GraphEdge,
  MemberState,
  MergeApplyResult,
  MergePreviewResult,
  ModelPricing,
  ProviderDescriptor,
  ProvidersConfigSnapshot,
  ProviderTestResult,
  Snapshot,
  SwarmIndexEntry,
  SwarmState,
  SwarmTemplate,
  TemplatesConfigSnapshot,
  TokenUsage,
  UiPrefs,
  UsageBreakdown,
  VerifyCommandResult,
  WorktreeDiffSummary,
  WorktreePatchResult,
} from './types.js';

const app = new App({ name: 'AGY Ext Swarm', version: '0.2.0' }, {});

// Persistent UI state preserved across 2.5s polls
let currentLocale: Locale = detectDefaultLocale();
let localeOverriddenByUser = false;
let currentSwarmId: string | undefined;
let latestSnapshot: Snapshot | null = null;
let lastRenderSignature = '';
let pollInFlight = false;
let activeTab: 'board' | 'graph' | 'workers' | 'usage' | 'settings' = 'board';
let selectedAgentFilter: string | null = null;
let selectedKindFilter: 'all' | 'done' | 'alerts' = 'all';
let usageScope: 'swarm' | 'session' = 'swarm';
const expandedSeqs = new Set<number>();
const seenSeqs = new Set<number>();
const seenWorkerNames = new Set<string>();
const prevGaugePcts = new Map<string, number>();
let initialBoardLoaded = false;
let pendingKillConfirm: string | null = null;

// Replay state
let replaySeq: number | null = null;
let replayPlaying = false;
let replayTimer: number | null = null;
let hoveredNode: string | null = null;

// Event drawer state
let activeLogWorker: string | null = null;
let logRawMode = false;
let cachedLogLines: string[] = [];

// Diff drawer, worker switch & merge state
let activeDiffWorker: string | null = null;
let cachedDiffData: WorktreePatchResult | null = null;
let switchOpenWorker: string | null = null;
const switchDrafts = new Map<string, { provider: string; model: string; prompt: string }>();
let mergeOpenWorker: string | null = null;
const mergePreviews = new Map<string, { loading: boolean; data?: MergePreviewResult; error?: string }>();
const mergeDrafts = new Map<
  string,
  { mode: 'squash' | 'cherry-pick' | 'merge'; removeWt: boolean; commitMsg: string }
>();
let pendingDeleteSwarm = false;

// Commander bar state
let activeCommanderPanel: 'create' | 'add' | 'arena' | 'templates' | null = null;
let commanderToastTimer: number | null = null;
let latestTemplatesConfig: TemplatesConfigSnapshot | null = null;
let arenaSlots: Array<{ provider: string; model: string }> = [];
let createPoolDraft: string[] | null = null;
const addProvidersDraft = new Set<string>();
const tplRoleOverrides = new Map<string, { provider?: string; model?: string }>();

// Settings state
let latestProviderConfig: ProvidersConfigSnapshot | null = null;
const settingsExpanded = new Set<string>();
const settingsDraftModels = new Map<string, string[]>();
const settingsTestResults = new Map<string, ProviderTestResult>();
const testingProviders = new Set<string>();
let pricingExpanded = false;
let routingExpanded = false;
const routingDraftActive = new Set<string>();
const routingDraftWriter = new Set<string>();
const routingDraftReader = new Set<string>();
let routingDraftSynced = false;
let pendingDeleteProvider: string | null = null;
let settingsToastTimer: number | null = null;

// Onboarding wizard state
let onboardingForceOpen = false;
let onboardingDismissedThisSession = false;
let onboardingVisible = false;
let onboardingDraftInitialized = false;
let onboardingStep: 1 | 2 | 3 = 1;
let onboardingTestingAll = false;
let onboardingSaving = false;
const onboardingSelectedClis = new Set<string>();
const onboardingDefaultModels = new Map<string, string>();
const onboardingModelsRaw = new Map<string, string>();
let onboardingDefaultCli = '';
let onboardingUsePool = true;
let onboardingFailover = true;
const onboardingWriterPool = new Set<string>();
const onboardingReaderPool = new Set<string>();

// DOM refs
const topbar = document.getElementById('topbar') as HTMLElement;
const swarmSelect = document.getElementById('swarm-select') as HTMLSelectElement;
const livePill = document.getElementById('live-pill') as HTMLSpanElement;
const livePillText = document.getElementById('live-pill-text') as HTMLSpanElement;
const metaSummary = document.getElementById('meta-summary') as HTMLDivElement;
const btnExportSwarm = document.getElementById('btn-export-swarm') as HTMLButtonElement;
const btnDeleteSwarm = document.getElementById('btn-delete-swarm') as HTMLButtonElement;
const btnLang = document.getElementById('btn-lang') as HTMLButtonElement;
const btnRefresh = document.getElementById('btn-refresh') as HTMLButtonElement;
const btnSendSummary = document.getElementById('btn-send-summary') as HTMLButtonElement;
const tabsNav = document.getElementById('tabs-nav') as HTMLElement;
const tabInk = document.getElementById('tab-ink') as HTMLSpanElement;
const countBoard = document.getElementById('count-board') as HTMLSpanElement;
const countEdges = document.getElementById('count-edges') as HTMLSpanElement;
const countWorkers = document.getElementById('count-workers') as HTMLSpanElement;
const badgeUsageHit = document.getElementById('badge-usage-hit') as HTMLSpanElement;
const badgeSettingsClis = document.getElementById('badge-settings-clis') as HTMLSpanElement;

const boardFilter = document.getElementById('board-filter') as HTMLInputElement;
const autoFollow = document.getElementById('auto-follow') as HTMLInputElement;
const agentChips = document.getElementById('agent-chips') as HTMLDivElement;
const onboardingHost = document.getElementById('onboarding-host') as HTMLDivElement;
const boardFeed = document.getElementById('board-feed') as HTMLDivElement;
const btnJumpLatest = document.getElementById('btn-jump-latest') as HTMLButtonElement;
const mentionQuickbar = document.getElementById('mention-quickbar') as HTMLDivElement;
const composerForm = document.getElementById('composer-form') as HTMLFormElement;
const composerInput = document.getElementById('composer-input') as HTMLInputElement;
const composerSend = document.getElementById('composer-send') as HTMLButtonElement;
const composerWrap = document.querySelector('.composer-wrap') as HTMLDivElement | null;

const graphCaption = document.getElementById('graph-caption') as HTMLSpanElement;
const mentionGraph = document.getElementById('mention-graph') as unknown as SVGSVGElement;
const replayPlayBtn = document.getElementById('replay-play') as HTMLButtonElement;
const replayPrevBtn = document.getElementById('replay-prev') as HTMLButtonElement;
const replayNextBtn = document.getElementById('replay-next') as HTMLButtonElement;
const replaySlider = document.getElementById('replay-slider') as HTMLInputElement;
const replayCounter = document.getElementById('replay-counter') as HTMLSpanElement;
const replayLiveBtn = document.getElementById('replay-live') as HTMLButtonElement;
const replayPreview = document.getElementById('replay-preview') as HTMLDivElement;

const workersList = document.getElementById('workers-list') as HTMLDivElement;
const arenaBoards = document.getElementById('arena-boards') as HTMLDivElement;
const cmdToggleCreate = document.getElementById('cmd-toggle-create') as HTMLButtonElement;
const cmdToggleAdd = document.getElementById('cmd-toggle-add') as HTMLButtonElement;
const cmdToggleArena = document.getElementById('cmd-toggle-arena') as HTMLButtonElement;
const cmdToggleTemplates = document.getElementById('cmd-toggle-templates') as HTMLButtonElement;
const commanderToast = document.getElementById('commander-toast') as HTMLDivElement;

const cmdPanelCreate = document.getElementById('cmd-panel-create') as HTMLFormElement;
const createSwarmRepo = document.getElementById('create-swarm-repo') as HTMLInputElement;
const createSwarmTitle = document.getElementById('create-swarm-title') as HTMLInputElement;
const createSwarmProvider = document.getElementById('create-swarm-provider') as HTMLSelectElement;
const createSwarmPool = document.getElementById('create-swarm-pool') as HTMLDivElement;
const createSwarmFailover = document.getElementById('create-swarm-failover') as HTMLInputElement;
const cmdCreateCancel = document.getElementById('cmd-create-cancel') as HTMLButtonElement;

const cmdPanelAdd = document.getElementById('cmd-panel-add') as HTMLFormElement;
const addWorkerName = document.getElementById('add-worker-name') as HTMLInputElement;
const addWorkerRole = document.getElementById('add-worker-role') as HTMLInputElement;
const addWorkerProviders = document.getElementById('add-worker-providers') as HTMLDivElement;
const addWorkerModel = document.getElementById('add-worker-model') as HTMLInputElement;
const dlAddModels = document.getElementById('dl-add-models') as HTMLDataListElement;
const addWorkerPerm = document.getElementById('add-worker-perm') as HTMLSelectElement;
const addWorkerWs = document.getElementById('add-worker-ws') as HTMLSelectElement;
const addWorkerDeps = document.getElementById('add-worker-deps') as HTMLInputElement;
const addWorkerTasks = document.getElementById('add-worker-tasks') as HTMLTextAreaElement;
const addWorkerBrief = document.getElementById('add-worker-brief') as HTMLTextAreaElement;
const cmdAddCancel = document.getElementById('cmd-add-cancel') as HTMLButtonElement;

const cmdPanelArena = document.getElementById('cmd-panel-arena') as HTMLFormElement;
const arenaBaseName = document.getElementById('arena-base-name') as HTMLInputElement;
const arenaPerm = document.getElementById('arena-perm') as HTMLSelectElement;
const arenaQuickPicks = document.getElementById('arena-quick-picks') as HTMLDivElement;
const arenaContestants = document.getElementById('arena-contestants') as HTMLDivElement;
const arenaAddRow = document.getElementById('arena-add-row') as HTMLButtonElement;
const arenaTask = document.getElementById('arena-task') as HTMLTextAreaElement;
const cmdArenaCancel = document.getElementById('cmd-arena-cancel') as HTMLButtonElement;

const cmdPanelTemplates = document.getElementById('cmd-panel-templates') as HTMLDivElement;
const tplApplyForm = document.getElementById('tpl-apply-form') as HTMLFormElement;
const tplSelect = document.getElementById('tpl-select') as HTMLSelectElement;
const tplDesc = document.getElementById('tpl-desc') as HTMLDivElement;
const tplRoleGrid = document.getElementById('tpl-role-grid') as HTMLDivElement;
const tplRepo = document.getElementById('tpl-repo') as HTMLInputElement;
const tplTitle = document.getElementById('tpl-title') as HTMLInputElement;
const tplGoal = document.getElementById('tpl-goal') as HTMLTextAreaElement;
const tplToggleSave = document.getElementById('tpl-toggle-save') as HTMLButtonElement;
const tplDeleteBtn = document.getElementById('tpl-delete-btn') as HTMLButtonElement;
const cmdTemplatesCancel = document.getElementById('cmd-templates-cancel') as HTMLButtonElement;
const tplSaveForm = document.getElementById('tpl-save-form') as HTMLFormElement;
const tplSaveId = document.getElementById('tpl-save-id') as HTMLInputElement;
const tplSaveName = document.getElementById('tpl-save-name') as HTMLInputElement;
const tplSaveDesc = document.getElementById('tpl-save-desc') as HTMLInputElement;
const tplSaveWorkers = document.getElementById('tpl-save-workers') as HTMLTextAreaElement;
const tplSaveCancel = document.getElementById('tpl-save-cancel') as HTMLButtonElement;
const logDrawer = document.getElementById('log-drawer') as HTMLDivElement;
const logDrawerTitle = document.getElementById('log-drawer-title') as HTMLSpanElement;
const logDrawerCount = document.getElementById('log-drawer-count') as HTMLSpanElement;
const logModeToggle = document.getElementById('log-mode-toggle') as HTMLButtonElement;
const logDrawerRefresh = document.getElementById('log-drawer-refresh') as HTMLButtonElement;
const logDrawerClose = document.getElementById('log-drawer-close') as HTMLButtonElement;
const logDrawerBody = document.getElementById('log-drawer-body') as HTMLDivElement;

const convSelect = document.getElementById('conv-select') as HTMLSelectElement;
const usageHero = document.getElementById('usage-hero') as HTMLDivElement;
const usageSplit = document.getElementById('usage-split') as HTMLDivElement;
const usageDetails = document.getElementById('usage-details') as HTMLDivElement;
const usagePricingHint = document.getElementById('usage-pricing-hint') as HTMLDivElement;

const diffDrawer = document.getElementById('diff-drawer') as HTMLDivElement;
const diffDrawerTitle = document.getElementById('diff-drawer-title') as HTMLSpanElement;
const diffDrawerBranch = document.getElementById('diff-drawer-branch') as HTMLSpanElement;
const diffDrawerCopy = document.getElementById('diff-drawer-copy') as HTMLButtonElement;
const diffDrawerRefresh = document.getElementById('diff-drawer-refresh') as HTMLButtonElement;
const diffDrawerClose = document.getElementById('diff-drawer-close') as HTMLButtonElement;
const diffDrawerBody = document.getElementById('diff-drawer-body') as HTMLDivElement;

const btnTogglePricing = document.getElementById('btn-toggle-pricing') as HTMLButtonElement;
const pricingBody = document.getElementById('pricing-body') as HTMLDivElement;
const pricingCountBadge = document.getElementById('pricing-count-badge') as HTMLSpanElement;
const pricingList = document.getElementById('pricing-list') as HTMLDivElement;
const pricingForm = document.getElementById('pricing-form') as HTMLFormElement;
const pricingModelInput = document.getElementById('pricing-model') as HTMLInputElement;
const dlPricingModels = document.getElementById('dl-pricing-models') as HTMLDataListElement;
const pricingCurrencySelect = document.getElementById('pricing-currency') as HTMLSelectElement;
const pricingInputRate = document.getElementById('pricing-input') as HTMLInputElement;
const pricingCacheRate = document.getElementById('pricing-cache') as HTMLInputElement;
const pricingOutputRate = document.getElementById('pricing-output') as HTMLInputElement;

const settingsDefaultSelect = document.getElementById('settings-default-provider') as HTMLSelectElement;
const settingsOpenOnboardingBtn = document.getElementById('settings-open-onboarding') as HTMLButtonElement;
const settingsRescanBtn = document.getElementById('settings-rescan') as HTMLButtonElement;
const settingsToggleAddBtn = document.getElementById('settings-toggle-add') as HTMLButtonElement;
const settingsMetaEl = document.getElementById('settings-meta') as HTMLDivElement;
const settingsToastEl = document.getElementById('settings-toast') as HTMLDivElement;
const settingsAddPanel = document.getElementById('settings-add-panel') as HTMLFormElement;
const settingsAddCancelBtn = document.getElementById('settings-add-cancel') as HTMLButtonElement;
const customAddIdInput = document.getElementById('custom-add-id') as HTMLInputElement;
const customAddNameInput = document.getElementById('custom-add-name') as HTMLInputElement;
const customAddCmdInput = document.getElementById('custom-add-cmd') as HTMLInputElement;
const customAddDefaultModelInput = document.getElementById('custom-add-default-model') as HTMLInputElement;
const customAddPromptMode = document.getElementById('custom-add-prompt-mode') as HTMLSelectElement;
const customAddOutputFormat = document.getElementById('custom-add-output-format') as HTMLSelectElement;
const customAddArgsInput = document.getElementById('custom-add-args') as HTMLInputElement;
const customAddResumeArgsInput = document.getElementById('custom-add-resume-args') as HTMLInputElement;
const customAddModelsInput = document.getElementById('custom-add-models') as HTMLInputElement;
const settingsProvidersList = document.getElementById('settings-providers-list') as HTMLDivElement;
const btnToggleRouting = document.getElementById('btn-toggle-routing') as HTMLButtonElement;
const routingBody = document.getElementById('routing-body') as HTMLDivElement;
const routingCountBadge = document.getElementById('routing-count-badge') as HTMLSpanElement;
const routingSummaryChips = document.getElementById('routing-summary-chips') as HTMLDivElement;
const routingActivePool = document.getElementById('routing-active-pool') as HTMLDivElement;
const routingWriterPool = document.getElementById('routing-writer-pool') as HTMLDivElement;
const routingReaderPool = document.getElementById('routing-reader-pool') as HTMLDivElement;
const routingAutoFailover = document.getElementById('routing-auto-failover') as HTMLInputElement;
const routingSaveBtn = document.getElementById('routing-save-btn') as HTMLButtonElement;

function tr(key: I18nKey, vars?: Record<string, string | number>): string {
  return t(currentLocale, key, vars);
}

function setButtonLabel(btn: HTMLButtonElement | null | undefined, text: string): void {
  if (!btn) return;
  const labelEl = btn.querySelector<HTMLElement>('.btn-label');
  if (labelEl) {
    labelEl.textContent = text;
  } else {
    btn.textContent = text;
  }
}

function getButtonLabel(btn: HTMLButtonElement | null | undefined): string {
  if (!btn) return '';
  const labelEl = btn.querySelector<HTMLElement>('.btn-label');
  return (labelEl ? labelEl.textContent : btn.textContent) ?? '';
}

function setBadgeText(el: HTMLElement, next: string): void {
  const prev = el.textContent ?? '';
  if (prev === next) return;
  el.textContent = next;
  if (prev !== '' && prev !== '--') {
    el.classList.remove('badge-pop');
    void el.offsetWidth;
    el.classList.add('badge-pop');
  }
}

function providerBadgeClass(provider?: string): string {
  const p = (provider || 'dsh').toLowerCase();
  if (p === 'claude' || p.startsWith('claude-')) return 'prov-claude';
  if (p === 'codex' || p.startsWith('codex-')) return 'prov-codex';
  if (p === 'gemini' || p.startsWith('gemini-')) return 'prov-gemini';
  if (p === 'dsh') return 'prov-dsh';
  return 'prov-custom';
}

async function withBusyButton<T>(
  btn: HTMLButtonElement | null | undefined,
  fn: () => Promise<T>,
  busyLabel?: string,
): Promise<T | undefined> {
  if (btn?.disabled) return undefined;
  const prevText = getButtonLabel(btn);
  if (btn) {
    btn.disabled = true;
    btn.classList.add('is-busy');
    setButtonLabel(btn, busyLabel || tr('cmd.working'));
  }
  try {
    return await fn();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('is-busy');
      setButtonLabel(btn, prevText);
    }
  }
}

function applyStaticI18n(): void {
  document.documentElement.lang = currentLocale === 'zh' ? 'zh-CN' : 'en';
  btnLang.textContent = currentLocale === 'zh' ? 'EN' : '中文';

  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n as I18nKey | undefined;
    if (key) el.textContent = tr(key);
  });

  document.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]').forEach((el) => {
    const key = el.dataset.i18nPlaceholder as I18nKey | undefined;
    if (key) el.placeholder = tr(key);
  });

  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    const key = el.dataset.i18nTitle as I18nKey | undefined;
    if (key) el.title = tr(key);
  });

  replayPlayBtn.textContent = replayPlaying ? tr('graph.pause') : tr('graph.play');
  if (activeLogWorker) {
    logDrawerTitle.textContent = tr('drawer.titleFor', { name: activeLogWorker });
    renderLogDrawerBody();
  }
  if (activeDiffWorker) {
    diffDrawerTitle.textContent = tr('diff.titleFor', { name: activeDiffWorker });
    renderDiffDrawerBody();
  }
  btnTogglePricing.textContent = tr(pricingExpanded ? 'settings.collapse' : 'settings.expand');
  btnToggleRouting.textContent = tr(routingExpanded ? 'settings.collapse' : 'settings.expand');
  setButtonLabel(
    btnDeleteSwarm,
    tr(pendingDeleteSwarm ? 'app.confirmDeleteSwarm' : 'app.deleteSwarm'),
  );
  if (!latestSnapshot?.swarm) {
    composerInput.placeholder = tr('board.composerDisabled');
  }
  if (onboardingVisible) {
    renderOnboardingWizard();
  }
  updateTabInk();
}

function formatTime(iso: string): string {
  return formatTimeLocale(iso, currentLocale);
}

function animateNumber(
  el: HTMLElement | null,
  from: number,
  to: number,
  formatter: (n: number) => string,
): void {
  if (!el) return;
  if (from === to || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = formatter(to);
    return;
  }
  const start = performance.now();
  const duration = 420;
  const tick = (now: number) => {
    const tNorm = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - tNorm, 3);
    const cur = Math.round(from + (to - from) * eased);
    el.textContent = formatter(cur);
    if (tNorm < 1) {
      window.requestAnimationFrame(tick);
    }
  };
  window.requestAnimationFrame(tick);
}

function updateTabInk(): void {
  const activeBtn = tabsNav.querySelector<HTMLButtonElement>('.tab.active');
  if (!activeBtn) return;
  tabInk.style.width = `${activeBtn.offsetWidth}px`;
  tabInk.style.transform = `translateX(${activeBtn.offsetLeft}px)`;
}

function statusLabel(status: MemberState['status']): string {
  return tr(`status.${status}` as I18nKey);
}

function kindLabel(kind: string): string {
  const key = `kind.${kind}` as I18nKey;
  return kind in { brief: 1, done: 1, blocker: 1, warning: 1, error: 1, system: 1, message: 1 }
    ? tr(key)
    : kind;
}

function applyHostContext(): void {
  const ctx = app.getHostContext();
  if (ctx?.theme) {
    applyDocumentTheme(ctx.theme);
  }
  if (ctx?.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
  if (!localeOverriddenByUser && ctx?.locale) {
    const detected = detectDefaultLocale(ctx.locale);
    if (detected !== currentLocale) {
      currentLocale = detected;
      applyStaticI18n();
    }
  }
}

function computeSignature(snap: Snapshot): string {
  const s = snap.swarm;
  const cu = snap.coordinatorUsage;
  const cuSig = cu
    ? `${cu.conversationId || ''}:${cu.sessionTotal.totalTokens}:${cu.sessionTotal.cacheReadTokens}:${cu.sinceSwarmStart.totalTokens}:${cu.sinceSwarmStart.cacheReadTokens}:${Object.keys(cu.byModelSession || {}).length}:${Object.keys(cu.byModelSinceSwarm || {}).length}`
    : '';
  const convSig = (snap.availableConversations || []).map((c) => `${c.id}:${c.updatedAt}`).join(',');
  const localeSig = currentLocale;
  const pricingSig = Object.entries(snap.providerConfig?.pricing || {})
    .map(([m, p]) => `${m}:${p.inputPer1M}:${p.cacheReadPer1M || 0}:${p.outputPer1M}:${p.currency || 'USD'}`)
    .join(',');
  const tplSig = (snap.templatesConfig?.templates || []).map((t) => `${t.id}:${t.workers.length}`).join(',');
  const poolSig = `${(snap.providerConfig?.activePool || []).join(',')}:${(snap.providerConfig?.routingPolicy?.writerProviders || []).join(',')}:${(snap.providerConfig?.routingPolicy?.readerProviders || []).join(',')}:${snap.providerConfig?.routingPolicy?.autoFailover ? 1 : 0}`;
  const onbSig = `${snap.uiPrefs?.onboardingCompleted ? 1 : 0}:${snap.providerConfig?.globalConfigExists ? 1 : 0}`;
  if (!s) {
    return `none:${localeSig}:${(snap.swarms || []).length}:${cuSig}:${convSig}:${pricingSig}:${tplSig}:${poolSig}:${onbSig}`;
  }
  const memberSig = Object.values(s.members || {})
    .map(
      (m) =>
        `${m.name}:${m.provider}:${m.model}:${m.status}:${m.turns}:${m.steps}:${m.usage?.totalTokens}:${m.usage?.cacheReadTokens}:${m.activity || ''}:${m.outOfScopeFiles?.length || 0}:${m.lastVerifyResults?.length || 0}:${m.dependsOn?.join(',') || ''}:${m.arenaGroup || ''}:${m.failedProviders?.join(',') || ''}`,
    )
    .join('|');
  const diffSig = snap.diffs
    ? Object.entries(snap.diffs)
        .map(([k, v]) => `${k}:${v?.commitCount || 0}:${v?.changedFiles?.length || 0}`)
        .join('|')
    : '';
  return `${localeSig}:${s.id}:${s.headSeq}:${s.hopCount}:${(s.activeProviders || []).join(',')}:${s.coordinatorConversationId || ''}:${snap.messages.length}:${memberSig}:${diffSig}:${cuSig}:${convSig}:${pricingSig}:${tplSig}:${poolSig}:${onbSig}`;
}

function aggregateDshUsage(members: MemberState[]): UsageBreakdown {
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let calls = 0;
  for (const m of members) {
    inputTokens += m.usage?.inputTokens || 0;
    cacheReadTokens += m.usage?.cacheReadTokens || 0;
    outputTokens += m.usage?.outputTokens || 0;
    calls += m.steps || 0;
  }
  const promptTokens = inputTokens + cacheReadTokens;
  const totalTokens = promptTokens + outputTokens;
  return {
    inputTokens,
    cacheReadTokens,
    promptTokens,
    outputTokens,
    totalTokens,
    cacheHitRate: calcInputCacheHit(inputTokens, cacheReadTokens),
    calls,
  };
}

function shouldShowOnboarding(snap: Snapshot): boolean {
  if (onboardingForceOpen) return true;
  if (onboardingDismissedThisSession) return false;
  return Boolean(
    !snap.uiPrefs?.onboardingCompleted &&
      snap.providerConfig &&
      !snap.providerConfig.globalConfigExists &&
      !snap.swarm &&
      (snap.swarms?.length || 0) === 0,
  );
}

function initOnboardingDraft(cfg: ProvidersConfigSnapshot, preserveUserEdits = false): void {
  const knownIds = new Set<string>([
    ...onboardingDefaultModels.keys(),
    ...onboardingModelsRaw.keys(),
  ]);
  if (!preserveUserEdits) {
    onboardingSelectedClis.clear();
    onboardingDefaultModels.clear();
    onboardingModelsRaw.clear();
    onboardingWriterPool.clear();
    onboardingReaderPool.clear();
    for (const p of cfg.providers) {
      const shouldPick = cfg.globalConfigExists ? p.enabled && p.available : p.available;
      if (shouldPick) onboardingSelectedClis.add(p.id);
      onboardingDefaultModels.set(p.id, p.configuredDefaultModel || '');
      onboardingModelsRaw.set(p.id, (p.configuredModels || []).join(', '));
    }
    onboardingDefaultCli = cfg.configuredDefaultProvider || '';
    onboardingUsePool = cfg.globalConfigExists ? Boolean(cfg.activePool?.length) : true;
    onboardingFailover = cfg.globalConfigExists ? Boolean(cfg.routingPolicy?.autoFailover) : true;
    for (const id of cfg.routingPolicy?.writerProviders || []) onboardingWriterPool.add(id);
    for (const id of cfg.routingPolicy?.readerProviders || []) onboardingReaderPool.add(id);
  } else {
    for (const p of cfg.providers) {
      if (!knownIds.has(p.id)) {
        if (p.available && p.enabled) onboardingSelectedClis.add(p.id);
        onboardingDefaultModels.set(p.id, p.configuredDefaultModel || '');
        onboardingModelsRaw.set(p.id, (p.configuredModels || []).join(', '));
      }
    }
  }
  onboardingDraftInitialized = true;
}

function applyCustomPreset(presetKey: string): boolean {
  const p = CUSTOM_CLI_PRESETS[presetKey];
  if (!p) return false;
  customAddIdInput.value = p.id;
  customAddNameInput.value = p.name;
  customAddCmdInput.value = p.command;
  customAddDefaultModelInput.value = p.defaultModel;
  customAddPromptMode.value = p.promptMode;
  customAddOutputFormat.value = p.outputFormat;
  customAddArgsInput.value = p.args;
  customAddResumeArgsInput.value = p.resumeArgs;
  return true;
}

function openCustomCliCreator(presetKey?: string): void {
  onboardingForceOpen = false;
  onboardingVisible = false;
  onboardingHost.classList.add('hidden');
  switchTab('settings');
  settingsAddPanel.classList.remove('hidden');
  if (presetKey) {
    applyCustomPreset(presetKey);
    customAddCmdInput.focus();
  } else {
    settingsAddPanel.reset();
    customAddIdInput.focus();
  }
  settingsAddPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function dismissOnboardingWizard(): Promise<void> {
  const wasFirstTime = !onboardingForceOpen;
  onboardingForceOpen = false;
  onboardingDismissedThisSession = true;
  onboardingVisible = false;
  onboardingHost.classList.add('hidden');
  if (wasFirstTime) {
    if (latestSnapshot) {
      latestSnapshot.uiPrefs = { ...latestSnapshot.uiPrefs, onboardingCompleted: true };
    }
    try {
      await app.callServerTool({
        name: 'app_set_ui_prefs',
        arguments: { onboarding_completed: true },
      });
    } catch {
      // Non-fatal if persistence fails
    }
  }
  if (latestSnapshot) {
    renderSnapshot(latestSnapshot, true);
  }
}

async function openOnboardingWizard(): Promise<void> {
  onboardingForceOpen = true;
  onboardingDismissedThisSession = false;
  onboardingStep = 1;
  if (latestProviderConfig) {
    initOnboardingDraft(latestProviderConfig, false);
  }
  switchTab('board');
  if (!latestProviderConfig) {
    await loadProviderConfig();
    if (latestProviderConfig) initOnboardingDraft(latestProviderConfig, false);
  }
  onboardingVisible = true;
  onboardingHost.classList.remove('hidden');
  renderOnboardingWizard();
}

async function testSelectedOnboardingClis(): Promise<void> {
  const cfg = latestProviderConfig;
  if (!cfg || onboardingTestingAll) return;
  const targets = cfg.providers.filter((p) => onboardingSelectedClis.has(p.id)).map((p) => p.id);
  if (targets.length === 0) return;
  onboardingTestingAll = true;
  renderOnboardingWizard();
  const queue = [...targets];
  const worker = async () => {
    while (queue.length > 0) {
      const id = queue.shift();
      if (id) await runProviderConnectionTest(id);
    }
  };
  try {
    await Promise.all([worker(), ...(targets.length > 1 ? [worker()] : [])]);
  } finally {
    onboardingTestingAll = false;
    if (onboardingVisible) renderOnboardingWizard();
  }
}

async function saveOnboardingWizard(): Promise<void> {
  const cfg = latestProviderConfig;
  if (!cfg || onboardingSaving) return;
  const selected = cfg.providers.filter((p) => onboardingSelectedClis.has(p.id));
  if (selected.length === 0) return;

  onboardingSaving = true;
  renderOnboardingWizard();
  try {
    const upsertProviders = cfg.providers.map((p) => {
      const isSelected = onboardingSelectedClis.has(p.id);
      const baseCfg = buildPersistConfigFromDescriptor(p, isSelected);
      if (isSelected) {
        const defModel = (onboardingDefaultModels.get(p.id) || '').trim();
        if (defModel) baseCfg.defaultModel = defModel;
        else delete baseCfg.defaultModel;
        const modelsList = splitModelList(onboardingModelsRaw.get(p.id) || '');
        if (modelsList.length > 0) baseCfg.models = modelsList;
        else delete baseCfg.models;
      }
      return { id: p.id, config: baseCfg };
    });

    const defaultProviderArg =
      selected.length === 1
        ? selected[0].id
        : onboardingDefaultCli && onboardingSelectedClis.has(onboardingDefaultCli)
          ? onboardingDefaultCli
          : null;

    const activePoolArg = selected.length >= 2 && onboardingUsePool ? selected.map((p) => p.id) : null;
    const writers = [...onboardingWriterPool].filter((id) => onboardingSelectedClis.has(id));
    const readers = [...onboardingReaderPool].filter((id) => onboardingSelectedClis.has(id));
    const routingPolicyArg =
      selected.length >= 2 && (writers.length > 0 || readers.length > 0 || onboardingFailover)
        ? {
            ...(writers.length > 0 ? { writer_providers: writers } : {}),
            ...(readers.length > 0 ? { reader_providers: readers } : {}),
            auto_failover: onboardingFailover,
          }
        : null;

    const ok = await saveProviderPatch(
      {
        upsert_providers: upsertProviders,
        default_provider: defaultProviderArg,
        active_pool: activePoolArg,
        routing_policy: routingPolicyArg,
      },
      tr('onb.savedToast', { n: selected.length }),
    );
    if (!ok) return;

    if (latestSnapshot) {
      latestSnapshot.uiPrefs = { ...latestSnapshot.uiPrefs, onboardingCompleted: true };
    }
    try {
      await app.callServerTool({
        name: 'app_set_ui_prefs',
        arguments: { onboarding_completed: true },
      });
    } catch {
      // Non-fatal
    }

    onboardingForceOpen = false;
    onboardingDismissedThisSession = true;
    onboardingVisible = false;
    onboardingHost.classList.add('hidden');
    await refreshSnapshot(true);
    showCommanderToast(tr('onb.savedToast', { n: selected.length }));
  } finally {
    onboardingSaving = false;
    if (onboardingVisible) renderOnboardingWizard();
  }
}

function renderOnboardingCliRow(p: ProviderDescriptor): string {
  const checked = onboardingSelectedClis.has(p.id);
  const testRes = settingsTestResults.get(p.id);
  const isTesting = testingProviders.has(p.id);
  const pathText = p.resolvedPath ? `${p.command} → ${p.resolvedPath}` : p.command;
  return `
    <div class="onboarding-cli-row${checked ? ' is-selected' : ''}">
      <div class="onboarding-cli-top">
        <label class="onboarding-cli-check">
          <input type="checkbox" data-onb-cli="${escapeHtml(p.id)}" ${checked ? 'checked' : ''} />
          <div class="onboarding-cli-meta">
            <div class="onboarding-cli-name-row">
              <span class="onboarding-cli-name">${escapeHtml(p.displayName)}</span>
              <span class="provider-badge ${providerBadgeClass(p.id)}">${escapeHtml(p.id)}</span>
              <span class="badge ${p.available ? 'badge-done' : 'badge-warning'}">${escapeHtml(tr(p.available ? 'settings.installed' : 'settings.missingBin'))}</span>
            </div>
            <div class="onboarding-cli-path">${escapeHtml(pathText)}</div>
          </div>
        </label>
        <button type="button" class="btn btn-sm btn-ghost" data-onb-test="${escapeHtml(p.id)}" ${isTesting || onboardingTestingAll ? 'disabled' : ''}>
          ${escapeHtml(tr(isTesting ? 'settings.testingBtn' : 'settings.testBtn'))}
        </button>
      </div>
      ${
        testRes
          ? `<div class="provider-test-result ${testRes.ok ? 'is-ok' : 'is-fail'}">
              <strong>${escapeHtml(testRes.ok ? tr('settings.testPassed', { ms: testRes.latencyMs }) : tr('settings.testFailed', { ms: testRes.latencyMs }))}</strong>
              <span class="provider-test-meta">${escapeHtml(testRes.details)}${testRes.warnings?.length ? ` · ${escapeHtml(testRes.warnings.join('; '))}` : ''}</span>
            </div>`
          : ''
      }
    </div>
  `;
}

function renderOnboardingWizard(): void {
  const cfg = latestProviderConfig;
  if (!cfg) return;
  const selected = cfg.providers.filter((p) => onboardingSelectedClis.has(p.id));
  if (onboardingStep === 3 && selected.length < 2) {
    onboardingStep = 2;
  }
  const hasPoolStep = selected.length >= 2;
  const readyProviders = cfg.providers.filter((p) => p.available);
  const missingProviders = cfg.providers.filter((p) => !p.available);

  const stepClass = (stepNum: 1 | 2 | 3): string =>
    onboardingStep === stepNum ? 'is-active' : onboardingStep > stepNum ? 'is-done' : '';

  const skipLabel = onboardingForceOpen ? tr('onb.close') : tr('onb.skip');

  let bodyHtml = '';
  let footerHtml = '';

  if (onboardingStep === 1) {
    bodyHtml = `
      <div class="onboarding-scan-bar">
        <span>${escapeHtml(tr('onb.scanSummary', { ready: readyProviders.length, total: cfg.providers.length }))}</span>
        <div class="onboarding-scan-actions">
          <button type="button" class="btn btn-sm btn-ghost" data-onb-rescan ${onboardingTestingAll ? 'disabled' : ''}>${escapeHtml(tr('onb.rescan'))}</button>
          <button type="button" class="btn btn-sm btn-ghost" data-onb-test-all ${onboardingTestingAll || selected.length === 0 ? 'disabled' : ''}>${escapeHtml(tr(onboardingTestingAll ? 'onb.testingSelected' : 'onb.testSelected'))}</button>
        </div>
      </div>
      ${
        readyProviders.length === 0
          ? `<div class="onboarding-zero-box">
              <div class="onboarding-zero-title">${escapeHtml(tr('onb.noCliTitle'))}</div>
              <div class="onboarding-zero-hint">${escapeHtml(tr('onb.noCliHint'))}</div>
              <div class="preset-bar">
                <button type="button" class="detected-chip-btn" data-onb-preset="opencode">OpenCode</button>
                <button type="button" class="detected-chip-btn" data-onb-preset="aider">Aider</button>
                <button type="button" class="detected-chip-btn" data-onb-preset="qwen">Qwen Code</button>
                <button type="button" class="detected-chip-btn" data-onb-preset="goose">Goose</button>
                <button type="button" class="btn btn-sm" data-onb-custom>${escapeHtml(tr('onb.addCustomBtn'))}</button>
              </div>
            </div>`
          : `<div class="onboarding-group-label">${escapeHtml(tr('onb.readyGroup'))} (${readyProviders.length})</div>
             <div class="onboarding-cli-list">${readyProviders.map(renderOnboardingCliRow).join('')}</div>`
      }
      ${
        missingProviders.length > 0
          ? `<details class="cmd-advanced">
              <summary class="cmd-advanced-summary">${escapeHtml(tr('onb.missingGroup', { n: missingProviders.length }))}</summary>
              <div class="onboarding-cli-list" style="margin-top:8px">${missingProviders.map(renderOnboardingCliRow).join('')}</div>
            </details>`
          : ''
      }
      ${selected.length === 0 ? `<div class="onboarding-warn">${escapeHtml(tr('onb.selectAtLeastOne'))}</div>` : ''}
    `;

    footerHtml = `
      <div class="onboarding-footer">
        <button type="button" class="btn btn-sm btn-ghost" data-onb-custom>${escapeHtml(tr('onb.addCustomBtn'))}</button>
        <div class="onboarding-footer-right">
          <button type="button" class="btn btn-sm btn-primary" data-onb-next="2" ${selected.length === 0 ? 'disabled' : ''}>${escapeHtml(tr('onb.nextModels'))}</button>
        </div>
      </div>
    `;
  } else if (onboardingStep === 2) {
    const cardsHtml = selected
      .map((p) => {
        const defVal = onboardingDefaultModels.get(p.id) ?? '';
        const listVal = onboardingModelsRaw.get(p.id) ?? '';
        const detected = p.detectedModels || [];
        const dlOptions = Array.from(new Set([...splitModelList(listVal), ...detected, ...p.configuredModels]));
        return `
          <div class="onboarding-model-card">
            <div class="onboarding-model-head">
              <div class="onboarding-cli-name-row">
                <span class="onboarding-cli-name">${escapeHtml(p.displayName)}</span>
                <span class="provider-badge ${providerBadgeClass(p.id)}">${escapeHtml(p.id)}</span>
              </div>
              <span class="onboarding-cli-path"><code>${escapeHtml(p.command)}</code></span>
            </div>
            <div class="settings-form-grid">
              <label class="settings-field span-2">
                <span>${escapeHtml(tr('settings.defaultModelLabel'))}</span>
                <input class="input input-sm mono-input" type="text" list="dl-onb-${escapeHtml(p.id)}" data-onb-def-model="${escapeHtml(p.id)}" value="${escapeHtml(defVal)}" placeholder="${escapeHtml(p.detectedDefaultModel ? `${p.detectedDefaultModel} (auto)` : tr('onb.defaultModelPh'))}" />
                <datalist id="dl-onb-${escapeHtml(p.id)}">${dlOptions.map((m) => `<option value="${escapeHtml(m)}"></option>`).join('')}</datalist>
              </label>
              <label class="settings-field span-2">
                <span>${escapeHtml(tr('onb.modelsListLabel'))}</span>
                <input class="input input-sm mono-input" type="text" data-onb-models-list="${escapeHtml(p.id)}" value="${escapeHtml(listVal)}" placeholder="${escapeHtml(tr('onb.modelsListPh'))}" />
              </label>
            </div>
            ${
              p.id === 'dsh'
                ? detected.length > 0
                  ? `<div class="detected-box">
                      <div class="detected-head">
                        <span>${escapeHtml(tr('settings.detectedSection', { profile: p.profile || 'headless', model: p.detectedDefaultModel || 'default' }))}</span>
                        <button type="button" class="btn btn-sm btn-ghost" data-onb-import="${escapeHtml(p.id)}">${escapeHtml(tr('settings.importAllDetected', { n: detected.length }))}</button>
                      </div>
                      <div class="detected-chips">
                        ${detected.map((m) => `<button type="button" class="detected-chip-btn" data-onb-add-model="${escapeHtml(p.id)}" data-model="${escapeHtml(m)}">+ ${escapeHtml(m)}</button>`).join('')}
                      </div>
                    </div>`
                  : `<div class="onboarding-cli-path">${escapeHtml(tr('onb.dshNoCatalog', { profile: p.profile || 'headless' }))}</div>`
                : ''
            }
          </div>
        `;
      })
      .join('');

    bodyHtml = `
      <div class="onboarding-subtitle">${escapeHtml(tr('onb.modelsHint'))}</div>
      <div class="onboarding-cli-list">${cardsHtml}</div>
    `;

    footerHtml = `
      <div class="onboarding-footer">
        <button type="button" class="btn btn-sm btn-ghost" data-onb-back="1">${escapeHtml(tr('onb.back'))}</button>
        <div class="onboarding-footer-right">
          ${
            hasPoolStep
              ? `<button type="button" class="btn btn-sm btn-primary" data-onb-next="3">${escapeHtml(tr('onb.nextPool'))}</button>`
              : `<button type="button" class="btn btn-sm btn-primary" data-onb-save ${onboardingSaving ? 'disabled' : ''}>${escapeHtml(tr(onboardingSaving ? 'onb.saving' : 'onb.saveStart'))}</button>`
          }
        </div>
      </div>
    `;
  } else {
    const primaryOpts = [
      `<option value="">${escapeHtml(tr('onb.primaryAuto'))}</option>`,
      ...selected.map(
        (p) =>
          `<option value="${escapeHtml(p.id)}" ${onboardingDefaultCli === p.id ? 'selected' : ''}>${escapeHtml(`${p.displayName} (${p.id})`)}</option>`,
      ),
    ].join('');

    const roleChecks = (role: 'writer' | 'reader', checkedSet: Set<string>) =>
      selected
        .map(
          (p) => `
          <label class="cli-check-pill">
            <input type="checkbox" data-onb-role="${role}" value="${escapeHtml(p.id)}" ${checkedSet.has(p.id) ? 'checked' : ''} />
            <span>${escapeHtml(p.id)}</span>
          </label>`,
        )
        .join('');

    bodyHtml = `
      <div class="onboarding-pool-box">
        <div class="onboarding-cli-name">${escapeHtml(tr('onb.poolTitle', { n: selected.length }))}</div>
        <label class="settings-field">
          <span>${escapeHtml(tr('onb.primaryCliLabel'))}</span>
          <select class="input input-sm" data-onb-default-cli>${primaryOpts}</select>
        </label>
        <label class="checkbox-label">
          <input type="checkbox" data-onb-use-pool ${onboardingUsePool ? 'checked' : ''} />
          <span>${escapeHtml(tr('onb.enablePoolLabel'))}</span>
        </label>
        <label class="checkbox-label">
          <input type="checkbox" data-onb-failover ${onboardingFailover ? 'checked' : ''} />
          <span>${escapeHtml(tr('onb.enableFailoverLabel'))}</span>
        </label>
        <details class="cmd-advanced">
          <summary class="cmd-advanced-summary">${escapeHtml(tr('onb.roleSplitSummary'))}</summary>
          <div class="routing-grid" style="margin-top:8px">
            <div class="settings-field">
              <span>${escapeHtml(tr('onb.writerPoolLabel'))}</span>
              <div class="cli-check-grid">${roleChecks('writer', onboardingWriterPool)}</div>
            </div>
            <div class="settings-field">
              <span>${escapeHtml(tr('onb.readerPoolLabel'))}</span>
              <div class="cli-check-grid">${roleChecks('reader', onboardingReaderPool)}</div>
            </div>
          </div>
        </details>
      </div>
    `;

    footerHtml = `
      <div class="onboarding-footer">
        <button type="button" class="btn btn-sm btn-ghost" data-onb-back="2">${escapeHtml(tr('onb.back'))}</button>
        <div class="onboarding-footer-right">
          <button type="button" class="btn btn-sm btn-primary" data-onb-save ${onboardingSaving ? 'disabled' : ''}>${escapeHtml(tr(onboardingSaving ? 'onb.saving' : 'onb.saveStart'))}</button>
        </div>
      </div>
    `;
  }

  onboardingHost.innerHTML = `
    <div class="onboarding-card">
      <div class="onboarding-head">
        <div class="onboarding-title-wrap">
          <div class="onboarding-title">${escapeHtml(tr('onb.title'))}</div>
          <div class="onboarding-subtitle">${escapeHtml(tr('onb.subtitle'))}</div>
        </div>
        <button type="button" class="btn btn-sm btn-ghost" data-onb-skip>${escapeHtml(skipLabel)}</button>
      </div>
      <div class="onboarding-steps">
        <span class="onboarding-step-pill ${stepClass(1)}">${escapeHtml(tr('onb.step1'))}</span>
        <span class="onboarding-step-pill ${stepClass(2)}">${escapeHtml(tr('onb.step2'))}</span>
        ${hasPoolStep ? `<span class="onboarding-step-pill ${stepClass(3)}">${escapeHtml(tr('onb.step3'))}</span>` : ''}
      </div>
      ${bodyHtml}
      ${footerHtml}
    </div>
  `;

  onboardingHost.querySelector('[data-onb-skip]')?.addEventListener('click', () => {
    void dismissOnboardingWizard();
  });
  onboardingHost.querySelector('[data-onb-rescan]')?.addEventListener('click', () => {
    void loadProviderConfig().then(() => {
      if (latestProviderConfig) initOnboardingDraft(latestProviderConfig, true);
      if (onboardingVisible) renderOnboardingWizard();
    });
  });
  onboardingHost.querySelector('[data-onb-test-all]')?.addEventListener('click', () => {
    void testSelectedOnboardingClis();
  });
  onboardingHost.querySelectorAll<HTMLInputElement>('[data-onb-cli]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.onbCli;
      if (!id) return;
      if (cb.checked) onboardingSelectedClis.add(id);
      else onboardingSelectedClis.delete(id);
      renderOnboardingWizard();
    });
  });
  onboardingHost.querySelectorAll<HTMLButtonElement>('[data-onb-test]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.onbTest;
      if (id) void runProviderConnectionTest(id);
    });
  });
  onboardingHost.querySelectorAll<HTMLButtonElement>('[data-onb-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      openCustomCliCreator(btn.dataset.onbPreset);
    });
  });
  onboardingHost.querySelectorAll<HTMLButtonElement>('[data-onb-custom]').forEach((btn) => {
    btn.addEventListener('click', () => {
      openCustomCliCreator();
    });
  });
  onboardingHost.querySelectorAll<HTMLInputElement>('[data-onb-def-model]').forEach((input) => {
    input.addEventListener('input', () => {
      const id = input.dataset.onbDefModel;
      if (id) onboardingDefaultModels.set(id, input.value);
    });
  });
  onboardingHost.querySelectorAll<HTMLInputElement>('[data-onb-models-list]').forEach((input) => {
    input.addEventListener('input', () => {
      const id = input.dataset.onbModelsList;
      if (id) onboardingModelsRaw.set(id, input.value);
    });
  });
  onboardingHost.querySelectorAll<HTMLButtonElement>('[data-onb-import]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.onbImport;
      const prov = id ? cfg.providers.find((x) => x.id === id) : undefined;
      if (!id || !prov) return;
      const merged = Array.from(
        new Set([...splitModelList(onboardingModelsRaw.get(id) || ''), ...(prov.detectedModels || [])]),
      );
      onboardingModelsRaw.set(id, merged.join(', '));
      if (!onboardingDefaultModels.get(id)?.trim() && prov.detectedDefaultModel) {
        onboardingDefaultModels.set(id, prov.detectedDefaultModel);
      }
      renderOnboardingWizard();
    });
  });
  onboardingHost.querySelectorAll<HTMLButtonElement>('[data-onb-add-model]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.onbAddModel;
      const model = btn.dataset.model;
      if (!id || !model) return;
      const merged = Array.from(new Set([...splitModelList(onboardingModelsRaw.get(id) || ''), model]));
      onboardingModelsRaw.set(id, merged.join(', '));
      renderOnboardingWizard();
    });
  });
  onboardingHost.querySelector<HTMLSelectElement>('[data-onb-default-cli]')?.addEventListener('change', (e) => {
    onboardingDefaultCli = (e.target as HTMLSelectElement).value;
  });
  onboardingHost.querySelector<HTMLInputElement>('[data-onb-use-pool]')?.addEventListener('change', (e) => {
    onboardingUsePool = (e.target as HTMLInputElement).checked;
  });
  onboardingHost.querySelector<HTMLInputElement>('[data-onb-failover]')?.addEventListener('change', (e) => {
    onboardingFailover = (e.target as HTMLInputElement).checked;
  });
  onboardingHost.querySelectorAll<HTMLInputElement>('[data-onb-role]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const targetSet = cb.dataset.onbRole === 'writer' ? onboardingWriterPool : onboardingReaderPool;
      if (cb.checked) targetSet.add(cb.value);
      else targetSet.delete(cb.value);
    });
  });
  onboardingHost.querySelector<HTMLButtonElement>('[data-onb-next]')?.addEventListener('click', (e) => {
    const step = Number((e.currentTarget as HTMLButtonElement).dataset.onbNext);
    if (step === 2 || step === 3) {
      onboardingStep = step;
      renderOnboardingWizard();
    }
  });
  onboardingHost.querySelector<HTMLButtonElement>('[data-onb-back]')?.addEventListener('click', (e) => {
    const step = Number((e.currentTarget as HTMLButtonElement).dataset.onbBack);
    if (step === 1 || step === 2) {
      onboardingStep = step;
      renderOnboardingWizard();
    }
  });
  onboardingHost.querySelector<HTMLButtonElement>('[data-onb-save]')?.addEventListener('click', () => {
    void saveOnboardingWizard();
  });
}

function renderSnapshot(snap: Snapshot, force = false): void {
  if (!localeOverriddenByUser && snap.uiPrefs?.locale && snap.uiPrefs.locale !== currentLocale) {
    currentLocale = snap.uiPrefs.locale;
    applyStaticI18n();
  }

  const prevSnap = latestSnapshot;
  latestSnapshot = snap;
  if (snap.templatesConfig) {
    latestTemplatesConfig = snap.templatesConfig;
  }
  if (snap.providerConfig) {
    const enabledCount = snap.providerConfig.providers.filter((p) => p.enabled).length;
    setBadgeText(badgeSettingsClis, `${enabledCount}/${snap.providerConfig.providers.length}`);
    if (!latestProviderConfig) {
      latestProviderConfig = snap.providerConfig;
      if (activeTab === 'settings') {
        renderSettingsView();
      }
    } else {
      latestProviderConfig.globalConfigExists = snap.providerConfig.globalConfigExists;
      latestProviderConfig.configuredDefaultProvider = snap.providerConfig.configuredDefaultProvider;
      latestProviderConfig.effectiveDefaultProvider = snap.providerConfig.effectiveDefaultProvider;
      latestProviderConfig.pricing = snap.providerConfig.pricing;
      latestProviderConfig.activePool = snap.providerConfig.activePool;
      latestProviderConfig.routingPolicy = snap.providerConfig.routingPolicy;
      latestProviderConfig.providers = snap.providerConfig.providers;
    }
  }
  const hasSwarm = Boolean(snap.swarm);
  btnExportSwarm.classList.toggle('hidden', !hasSwarm);
  btnDeleteSwarm.classList.toggle('hidden', !hasSwarm);
  btnSendSummary.disabled = !hasSwarm;

  const nextOnboardingVisible = shouldShowOnboarding(snap);
  const wasOnboardingVisible = onboardingVisible;
  onboardingVisible = nextOnboardingVisible;
  onboardingHost.classList.toggle('hidden', !onboardingVisible);
  if (onboardingVisible && latestProviderConfig) {
    if (!onboardingDraftInitialized) {
      initOnboardingDraft(latestProviderConfig, false);
    }
    if (!wasOnboardingVisible) {
      renderOnboardingWizard();
    }
  }

  const sig = computeSignature(snap);
  if (!force && sig === lastRenderSignature) {
    return;
  }
  lastRenderSignature = sig;
  syncCommanderControls();

  const swarms = snap.swarms || [];
  swarmSelect.innerHTML = '';
  if (swarms.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = tr('swarm.noneOption');
    swarmSelect.appendChild(opt);
  } else {
    for (const item of swarms) {
      const opt = document.createElement('option');
      opt.value = item.id;
      opt.textContent = item.title;
      swarmSelect.appendChild(opt);
    }
    if (snap.swarm) {
      currentSwarmId = snap.swarm.id;
      swarmSelect.value = snap.swarm.id;
    }
  }

  const swarm = snap.swarm;
  const members = swarm ? Object.values(swarm.members || {}) : [];
  const dshAgg = aggregateDshUsage(members);
  const cu = snap.coordinatorUsage;
  const agyActive = usageScope === 'swarm' && swarm ? cu?.sinceSwarmStart : cu?.sessionTotal;
  const combinedPrompt = dshAgg.promptTokens + (agyActive?.promptTokens || 0);
  const combinedCache = dshAgg.cacheReadTokens + (agyActive?.cacheReadTokens || 0);
  const combinedHit =
    combinedPrompt > 0 ? Math.round((combinedCache / combinedPrompt) * 1000) / 10 : 0;

  setBadgeText(badgeUsageHit, combinedPrompt > 0 ? `${combinedHit}%` : '--');

  if (!swarm) {
    seenWorkerNames.clear();
    prevGaugePcts.clear();
    topbar.classList.remove('is-active');
    livePill.className = 'pill pill-neutral';
    livePillText.textContent = tr('status.empty');
    metaSummary.innerHTML = cu?.sessionTotal.totalTokens
      ? `<span class="kpi-item">${escapeHtml(tr('swarm.emptyTelemetryMain', { total: formatNum(cu.sessionTotal.totalTokens), hit: cu.sessionTotal.cacheHitRate }))}</span>`
      : `<span class="kpi-item">${escapeHtml(tr('swarm.emptyTelemetry'))}</span>`;
    setBadgeText(countBoard, '0');
    setBadgeText(countEdges, '0');
    setBadgeText(countWorkers, '0');
    agentChips.innerHTML = '';
    mentionQuickbar.innerHTML = '';
    composerInput.disabled = true;
    composerSend.disabled = true;
    composerInput.placeholder = tr('board.composerDisabled');
    composerWrap?.classList.add('is-disabled');
    if (onboardingVisible) {
      boardFeed.innerHTML = '';
    } else {
      const readyClis = (
        snap.providerConfig?.providers ||
        latestProviderConfig?.providers ||
        []
      ).filter((p) => p.enabled && p.available);
      const cliStripHtml =
        readyClis.length > 0
          ? `<div class="empty-cli-strip">${escapeHtml(tr('board.emptyCliReady', { list: readyClis.map((p) => p.id).join(', ') }))}</div>`
          : `<div class="empty-cli-strip is-warn">${escapeHtml(tr('board.emptyCliNone'))}</div>`;
      boardFeed.innerHTML = `
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
    arenaBoards.innerHTML = '';
    workersList.innerHTML = `<div class="empty-state">${escapeHtml(tr('workers.empty'))}</div>`;
    mentionGraph.innerHTML = '';
    replayPreview.innerHTML = `<div class="empty-state-compact">${escapeHtml(tr('graph.noTraffic'))}</div>`;
    renderUsageView(snap, prevSnap);
    updateTabInk();
    return;
  }

  composerInput.disabled = false;
  composerSend.disabled = false;
  composerInput.placeholder = tr('board.composerPlaceholder');
  composerWrap?.classList.remove('is-disabled');

  const workingCount = members.filter((m) => m.status === 'working' || m.status === 'queued').length;
  const waitingCount = members.filter((m) => m.status === 'waiting').length;
  const failedCount = members.filter((m) => m.status === 'failed').length;

  topbar.classList.toggle('is-active', workingCount > 0);

  if (workingCount > 0) {
    livePill.className = 'pill pill-working';
    livePillText.textContent = tr('status.runningCount', { n: workingCount });
  } else if (failedCount > 0) {
    livePill.className = 'pill pill-failed';
    livePillText.textContent = tr('status.failedCount', { n: failedCount });
  } else {
    livePill.className = 'pill pill-waiting';
    livePillText.textContent = tr('status.idle');
  }

  const prevDshTokens = prevSnap?.swarm
    ? aggregateDshUsage(Object.values(prevSnap.swarm.members || {})).totalTokens
    : 0;
  const prevAgyTokens =
    usageScope === 'swarm'
      ? prevSnap?.coordinatorUsage?.sinceSwarmStart.totalTokens || 0
      : prevSnap?.coordinatorUsage?.sessionTotal.totalTokens || 0;

  metaSummary.innerHTML = `
    <span class="kpi-item">${escapeHtml(tr('kpi.running'))} <span class="kpi-val">${workingCount}</span></span>
    <span class="kpi-sep">·</span>
    <span class="kpi-item">${escapeHtml(tr('kpi.waiting'))} <span class="kpi-val">${waitingCount}</span></span>
    ${failedCount > 0 ? `<span class="kpi-sep">·</span><span class="kpi-item">${escapeHtml(tr('kpi.failed'))} <span class="kpi-val">${failedCount}</span></span>` : ''}
    ${swarm.activeProviders && swarm.activeProviders.length > 1 ? `<span class="kpi-sep">·</span><span class="kpi-item">${escapeHtml(tr('kpi.pool'))} <span class="kpi-val">${swarm.activeProviders.length}</span>${swarm.routingPolicy?.autoFailover ? ` (${escapeHtml(tr('kpi.failover'))})` : ''}</span>` : ''}
    <span class="kpi-sep">·</span>
    <span class="kpi-item">${escapeHtml(tr('kpi.hops'))} <span class="kpi-val">${swarm.hopCount}/${swarm.maxHops}</span></span>
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

  setBadgeText(countBoard, String(snap.messages.length));
  setBadgeText(countEdges, String(snap.edges.length));
  setBadgeText(countWorkers, String(members.length));

  renderParticipantChips(members);
  renderMentionQuickbar(members);
  renderBoard(snap.messages);
  renderWorkers(members, snap.diffs || {});
  renderGraphAndReplay(swarm, snap.messages);
  renderUsageView(snap, prevSnap);
  updateTabInk();
}

function renderParticipantChips(members: MemberState[]): void {
  const names = ['coordinator', ...members.map((m) => m.name)];
  agentChips.innerHTML = '';
  if (names.length <= 1) return;

  const allChip = document.createElement('button');
  allChip.type = 'button';
  allChip.className = `agent-chip${selectedAgentFilter === null ? ' active' : ''}`;
  allChip.textContent = tr('board.allParticipants');
  allChip.onclick = () => {
    selectedAgentFilter = null;
    renderParticipantChips(members);
    if (latestSnapshot) renderBoard(latestSnapshot.messages);
  };
  agentChips.appendChild(allChip);

  for (const name of names) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `agent-chip${selectedAgentFilter === name ? ' active' : ''}`;
    btn.textContent = name;
    btn.onclick = () => {
      selectedAgentFilter = selectedAgentFilter === name ? null : name;
      renderParticipantChips(members);
      if (latestSnapshot) renderBoard(latestSnapshot.messages);
    };
    agentChips.appendChild(btn);
  }
}

function renderMentionQuickbar(members: MemberState[]): void {
  const activeWorkers = members.filter((m) => m.status !== 'killed').map((m) => m.name);
  mentionQuickbar.innerHTML = '';
  if (activeWorkers.length === 0) return;

  for (const tag of ['@all', ...activeWorkers.map((n) => `@${n}`)]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quick-mention';
    btn.textContent = tag;
    btn.onclick = () => {
      const cur = composerInput.value;
      const spacer = cur && !cur.endsWith(' ') ? ' ' : '';
      composerInput.value = `${cur}${spacer}${tag} `;
      composerInput.focus();
    };
    mentionQuickbar.appendChild(btn);
  }
}

function formatRouteText(msg: BoardMessage): string {
  if (msg.all) return '→ @all';
  const targets = [...msg.mentions];
  if (msg.mentionsCoordinator && msg.agent !== 'coordinator') {
    targets.push('coordinator');
  }
  if (targets.length === 0) return '';
  return `→ ${targets.map((tName) => `@${tName}`).join(' ')}`;
}

function renderBoard(messages: BoardMessage[]): void {
  const search = boardFilter.value.trim().toLowerCase();
  const filtered = messages.filter((m) => {
    if (selectedKindFilter === 'done' && m.kind !== 'done') return false;
    if (
      selectedKindFilter === 'alerts' &&
      m.kind !== 'error' &&
      m.kind !== 'blocker' &&
      m.kind !== 'warning' &&
      m.kind !== 'system'
    ) {
      return false;
    }
    if (selectedAgentFilter) {
      const involves =
        m.agent === selectedAgentFilter ||
        m.mentions.includes(selectedAgentFilter) ||
        (selectedAgentFilter === 'coordinator' && m.mentionsCoordinator) ||
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
    boardFeed.innerHTML = `<div class="empty-state">${escapeHtml(tr('board.emptyMatch'))}</div>`;
    btnJumpLatest.classList.add('hidden');
    return;
  }

  const wasAtBottom =
    boardFeed.scrollHeight - boardFeed.scrollTop - boardFeed.clientHeight < 48;

  boardFeed.innerHTML = '';
  let prevMsg: BoardMessage | null = null;

  for (const m of filtered) {
    const isNew = initialBoardLoaded && !seenSeqs.has(m.seq);
    seenSeqs.add(m.seq);

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
    const isExpanded = expandedSeqs.has(m.seq);
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
        if (expandedSeqs.has(m.seq)) {
          expandedSeqs.delete(m.seq);
        } else {
          expandedSeqs.add(m.seq);
        }
        renderBoard(messages);
      };
      card.appendChild(toggleBtn);
    }

    boardFeed.appendChild(card);
    prevMsg = m;
  }

  initialBoardLoaded = true;

  if (autoFollow.checked && (wasAtBottom || filtered.length <= 6)) {
    boardFeed.scrollTop = boardFeed.scrollHeight;
    btnJumpLatest.classList.add('hidden');
  }
}

function jumpToSeq(seqNum: number): void {
  const target = boardFeed.querySelector<HTMLElement>(`.msg-card[data-seq="${seqNum}"]`);
  if (!target) {
    boardFilter.value = '';
    selectedAgentFilter = null;
    selectedKindFilter = 'all';
    if (latestSnapshot) {
      renderParticipantChips(Object.values(latestSnapshot.swarm?.members || {}));
      renderBoard(latestSnapshot.messages);
    }
  }
  const el = boardFeed.querySelector<HTMLElement>(`.msg-card[data-seq="${seqNum}"]`);
  if (!el) return;
  autoFollow.checked = false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

function computeEdgesFromMessages(
  messages: BoardMessage[],
  memberNames: string[],
): { edges: GraphEdge[]; counts: Map<string, number> } {
  const edgeMap = new Map<string, GraphEdge>();
  const postCounts = new Map<string, number>();

  for (const m of messages) {
    postCounts.set(m.agent, (postCounts.get(m.agent) || 0) + 1);
    const targets = new Set<string>(m.mentions);
    if (m.mentionsCoordinator && m.agent !== 'coordinator') {
      targets.add('coordinator');
    }
    if (m.all) {
      for (const name of memberNames) {
        if (name !== m.agent) targets.add(name);
      }
      if (m.agent !== 'coordinator') targets.add('coordinator');
    }
    for (const target of targets) {
      if (target === m.agent) continue;
      const key = `${m.agent}->${target}`;
      const existing = edgeMap.get(key);
      if (existing) {
        existing.count += 1;
        existing.viaAll = existing.viaAll || m.all;
      } else {
        edgeMap.set(key, { from: m.agent, to: target, count: 1, viaAll: m.all });
      }
    }
  }
  return { edges: Array.from(edgeMap.values()), counts: postCounts };
}

function renderGraphAndReplay(swarm: SwarmState, messages: BoardMessage[]): void {
  const maxSeq = messages.length > 0 ? messages[messages.length - 1].seq : 0;
  replaySlider.min = '1';
  replaySlider.max = String(Math.max(1, maxSeq));

  if (replaySeq !== null && replaySeq > maxSeq) {
    replaySeq = maxSeq > 0 ? maxSeq : null;
  }

  const activeCutoff = replaySeq ?? maxSeq;
  replaySlider.value = String(Math.max(1, activeCutoff));
  replaySlider.disabled = maxSeq === 0;
  replayPlayBtn.disabled = maxSeq <= 1;
  replayPrevBtn.disabled = maxSeq === 0 || activeCutoff <= 1;
  replayNextBtn.disabled = maxSeq === 0 || activeCutoff >= maxSeq;
  replayLiveBtn.classList.toggle('active', replaySeq === null);

  replayCounter.textContent = maxSeq === 0 ? '0 / 0' : `#${activeCutoff} / ${maxSeq}`;
  graphCaption.textContent =
    replaySeq === null
      ? tr('graph.liveCaption', { n: maxSeq })
      : tr('graph.replayCaption', { n: activeCutoff });

  const visibleMessages =
    replaySeq === null ? messages : messages.filter((m) => m.seq <= activeCutoff);
  const currentMsg = visibleMessages[visibleMessages.length - 1];

  const members = Object.values(swarm.members || {});
  const memberNames = members.map((m) => m.name);
  const { edges, counts } = computeEdgesFromMessages(visibleMessages, memberNames);

  const activeEdgeKeys = new Set<string>();
  if (currentMsg) {
    if (currentMsg.all) {
      for (const mName of memberNames) {
        if (mName !== currentMsg.agent) activeEdgeKeys.add(`${currentMsg.agent}->${mName}`);
      }
      if (currentMsg.agent !== 'coordinator') {
        activeEdgeKeys.add(`${currentMsg.agent}->coordinator`);
      }
    } else {
      for (const targetName of currentMsg.mentions) {
        activeEdgeKeys.add(`${currentMsg.agent}->${targetName}`);
      }
      if (currentMsg.mentionsCoordinator && currentMsg.agent !== 'coordinator') {
        activeEdgeKeys.add(`${currentMsg.agent}->coordinator`);
      }
    }
  }

  const width = 600;
  const height = 360;
  const cx = width / 2;
  const cy = height / 2;
  const rx = 205;
  const ry = 122;

  const coords = new Map<string, { x: number; y: number }>();
  const coordY = members.length <= 2 ? 78 : cy;
  coords.set('coordinator', { x: cx, y: coordY });

  members.forEach((m, idx) => {
    if (members.length <= 2) {
      const spread = members.length === 1 ? 0 : idx === 0 ? -150 : 150;
      coords.set(m.name, { x: cx + spread, y: 245 });
    } else {
      const angle = (Math.PI * 2 * idx) / members.length - Math.PI / 2;
      coords.set(m.name, {
        x: cx + Math.cos(angle) * rx,
        y: cy + Math.sin(angle) * ry,
      });
    }
  });

  const edgeDirSet = new Set(edges.map((e) => `${e.from}->${e.to}`));

  const defs = `
    <defs>
      <pattern id="dot-grid" width="20" height="20" patternUnits="userSpaceOnUse">
        <circle cx="10" cy="10" r="1" fill="var(--text-3)" opacity="0.18" />
      </pattern>
      <radialGradient id="hub-aura" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.18" />
        <stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
      </radialGradient>
      <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="3" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      <marker id="arrow-normal" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="var(--accent)" opacity="0.72" />
      </marker>
      <marker id="arrow-active" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="var(--success-text)" />
      </marker>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#dot-grid)" />
    <circle cx="${cx}" cy="${coordY}" r="120" fill="url(#hub-aura)" />
  `;

  const depEdgesSvg = members
    .flatMap((m) =>
      (m.dependsOn || []).map((depName) => {
        const p1 = coords.get(depName);
        const p2 = coords.get(m.name);
        if (!p1 || !p2) return '';
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const len = Math.hypot(dx, dy) || 1;
        const sx = p1.x + (dx / len) * 24;
        const sy = p1.y + (dy / len) * 24;
        const ex = p2.x - (dx / len) * 26;
        const ey = p2.y - (dy / len) * 26;
        return `<line x1="${sx.toFixed(1)}" y1="${sy.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="var(--warning-text)" stroke-width="1.3" stroke-dasharray="3 4" opacity="0.52" marker-end="url(#arrow-normal)" />`;
      }),
    )
    .join('');

  const edgesSvg = edges
    .map((e, idx) => {
      const p1 = coords.get(e.from);
      const p2 = coords.get(e.to);
      if (!p1 || !p2) return '';

      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;

      const hasReverse = edgeDirSet.has(`${e.to}->${e.from}`);
      const curveOffset = hasReverse ? 30 : 12;
      const qx = (p1.x + p2.x) / 2 + nx * curveOffset;
      const qy = (p1.y + p2.y) / 2 + ny * curveOffset;

      const startPad = 24;
      const endPad = 28;
      const sx = p1.x + (dx / len) * startPad;
      const sy = p1.y + (dy / len) * startPad;
      const ex = p2.x - (dx / len) * endPad;
      const ey = p2.y - (dy / len) * endPad;

      const edgeKey = `${e.from}->${e.to}`;
      const isCurrent = activeEdgeKeys.has(edgeKey);
      const dimmed = hoveredNode !== null && e.from !== hoveredNode && e.to !== hoveredNode;
      const stroke = isCurrent ? 'var(--success-text)' : 'var(--accent)';
      const opacity = dimmed ? 0.14 : isCurrent ? 0.98 : 0.56;
      const pathD = `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${qx.toFixed(1)} ${qy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`;
      const pathId = `edge-path-${idx}`;

      const mx = 0.25 * sx + 0.5 * qx + 0.25 * ex;
      const my = 0.25 * sy + 0.5 * qy + 0.25 * ey;

      return `
        <g opacity="${opacity}">
          <path id="${pathId}" d="${pathD}" fill="none" stroke="${stroke}"
            class="${isCurrent ? 'edge-stream' : ''}"
            filter="${isCurrent ? 'url(#glow)' : 'none'}"
            stroke-width="${isCurrent ? 2.6 : Math.min(3.4, 1.2 + e.count * 0.45)}"
            stroke-dasharray="${e.viaAll ? '5 3' : isCurrent ? '6 5' : 'none'}"
            marker-end="url(#${isCurrent ? 'arrow-active' : 'arrow-normal'})" />
          ${
            isCurrent
              ? `<circle r="4.5" fill="var(--success-text)" filter="url(#glow)">
                   <animateMotion dur="1.05s" repeatCount="indefinite">
                     <mpath href="#${pathId}" />
                   </animateMotion>
                 </circle>`
              : ''
          }
          <circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="9.5" fill="var(--bg-2)" stroke="var(--border-1)" />
          <text x="${mx.toFixed(1)}" y="${(my + 3.5).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="700" fill="var(--text-1)">${e.count}</text>
        </g>
      `;
    })
    .join('');

  const allNodes = ['coordinator', ...memberNames];
  const nodesSvg = allNodes
    .map((name) => {
      const p = coords.get(name);
      if (!p) return '';
      const m = members.find((item) => item.name === name);
      const isWorking = m?.status === 'working' || m?.status === 'queued';
      const isActiveActor =
        currentMsg && (currentMsg.agent === name || activeEdgeKeys.has(`${currentMsg.agent}->${name}`));
      const dimmed =
        hoveredNode !== null &&
        hoveredNode !== name &&
        !edges.some((e) => (e.from === hoveredNode && e.to === name) || (e.to === hoveredNode && e.from === name));

      const dotColor =
        name === 'coordinator'
          ? 'var(--accent)'
          : isWorking
            ? 'var(--info-text)'
            : m?.status === 'blocked'
              ? 'var(--warning-text)'
              : m?.status === 'failed'
                ? 'var(--danger-text)'
                : m?.status === 'killed'
                  ? 'var(--text-3)'
                  : 'var(--success-text)';

      const postCount = counts.get(name) || 0;
      const label = postCount > 0 ? `${name} (${postCount})` : name;
      const boxW = Math.max(90, label.length * 7.2 + 28);

      const workingRings = isWorking
        ? `
          <rect class="sonar-ring" x="${(p.x - boxW / 2 - 4).toFixed(1)}" y="${(p.y - 20).toFixed(1)}"
            width="${(boxW + 8).toFixed(1)}" height="40" rx="20"
            fill="none" stroke="var(--info-text)" stroke-width="1.5" />
          <ellipse class="orbit-ring" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}"
            rx="${(boxW / 2 + 10).toFixed(1)}" ry="24"
            fill="none" stroke="var(--accent)" stroke-width="1" stroke-dasharray="4 4" opacity="0.55" />
        `
        : '';

      return `
        <g class="graph-node" data-node="${escapeHtml(name)}" opacity="${dimmed ? 0.3 : 1}" style="cursor:pointer">
          ${workingRings}
          <rect x="${(p.x - boxW / 2).toFixed(1)}" y="${(p.y - 16).toFixed(1)}"
            width="${boxW.toFixed(1)}" height="32" rx="16"
            fill="var(--bg-1)" stroke="${isActiveActor ? 'var(--success-text)' : dotColor}"
            filter="${isWorking || isActiveActor ? 'url(#glow)' : 'none'}"
            stroke-width="${isActiveActor || isWorking ? 2.3 : 1.6}" />
          <circle cx="${(p.x - boxW / 2 + 13).toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.5" fill="${dotColor}" />
          <text x="${(p.x + 6).toFixed(1)}" y="${(p.y + 4).toFixed(1)}" text-anchor="middle"
            font-size="11.5" font-weight="600" fill="var(--text-1)">${escapeHtml(label)}</text>
        </g>
      `;
    })
    .join('');

  mentionGraph.innerHTML = `${defs}${depEdgesSvg}${edgesSvg}${nodesSvg}`;

  mentionGraph.querySelectorAll<SVGGElement>('.graph-node').forEach((g) => {
    g.addEventListener('mouseenter', () => {
      hoveredNode = g.dataset.node || null;
      renderGraphAndReplay(swarm, messages);
    });
    g.addEventListener('mouseleave', () => {
      hoveredNode = null;
      renderGraphAndReplay(swarm, messages);
    });
    g.addEventListener('click', () => {
      const nodeName = g.dataset.node || null;
      if (!nodeName) return;
      selectedAgentFilter = nodeName;
      switchTab('board');
    });
  });

  if (!currentMsg) {
    replayPreview.innerHTML = `<div class="empty-state-compact">${escapeHtml(tr('graph.noMessages'))}</div>`;
  } else {
    const route = formatRouteText(currentMsg);
    replayPreview.innerHTML = `
      <div class="msg-header">
        <div class="msg-author-wrap">
          <span class="msg-author${currentMsg.agent === 'coordinator' ? ' is-coord' : ''}">${escapeHtml(currentMsg.agent)}</span>
          ${route ? `<span class="msg-route">${escapeHtml(route)}</span>` : ''}
          <span class="msg-seq">#${currentMsg.seq}</span>
        </div>
        <span class="msg-time">${escapeHtml(formatTime(currentMsg.time))}</span>
      </div>
      <div class="msg-body">${formatMessageHtml(currentMsg.text.slice(0, 600))}${currentMsg.text.length > 600 ? '...' : ''}</div>
    `;
  }
}

function renderArenaBoards(
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
  arenaBoards.innerHTML = '';
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
        return `
          <tr>
            <td><strong>${escapeHtml(m.name)}</strong></td>
            <td><span class="provider-badge ${providerBadgeClass(m.provider)}">${escapeHtml(m.provider || 'dsh')}</span><span class="arena-model-text">${escapeHtml(m.model)}</span></td>
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
        if (wName) void openWorkerDiff(wName);
      });
    });
    card.querySelectorAll<HTMLButtonElement>('[data-arena-merge]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const wName = btn.dataset.arenaMerge;
        if (!wName) return;
        mergeOpenWorker = mergeOpenWorker === wName ? null : wName;
        if (mergeOpenWorker === wName) void previewMergeFromUi(wName);
        renderWorkers(members, diffs);
      });
    });
    card.querySelectorAll<HTMLButtonElement>('[data-arena-review]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const wName = btn.dataset.arenaReview;
        if (wName) void crossReviewFromUi(wName);
      });
    });
    arenaBoards.appendChild(card);
  }
}

function renderWorkers(
  members: MemberState[],
  diffs: Record<string, WorktreeDiffSummary | null>,
): void {
  renderArenaBoards(members, diffs);
  if (members.length === 0) {
    seenWorkerNames.clear();
    workersList.innerHTML = `<div class="empty-state">${escapeHtml(tr('workers.empty'))}</div>`;
    return;
  }

  workersList.innerHTML = '';
  for (const m of members) {
    const isNewWorker = initialBoardLoaded && !seenWorkerNames.has(m.name);
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
        <span>${escapeHtml(tr('workers.model'))}: <strong>${escapeHtml(m.model)}</strong></span>
        <span>${escapeHtml(tr('workers.turnsSteps', { turns: m.turns, steps: m.steps }))}</span>
        <span>${escapeHtml(tr('workers.perm'))}: ${escapeHtml(m.permissionMode)}</span>
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
        switchTab('board');
        composerInput.value = `@${m.name} `;
        composerInput.focus();
      };
      actions.appendChild(btnMention);
    }

    const btnEvents = document.createElement('button');
    btnEvents.type = 'button';
    btnEvents.className = 'btn btn-sm btn-ghost';
    btnEvents.textContent = tr('workers.events');
    btnEvents.onclick = () => void openWorkerLogs(m.name);
    actions.appendChild(btnEvents);

    if (m.workspaceMode === 'worktree' || m.branch) {
      const btnDiff = document.createElement('button');
      btnDiff.type = 'button';
      btnDiff.className = 'btn btn-sm';
      btnDiff.textContent = tr('workers.diffBtn');
      btnDiff.onclick = () => void openWorkerDiff(m.name);
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
      btnMerge.textContent = tr(mergeOpenWorker === m.name ? 'workers.mergeCancel' : 'workers.mergeBtn');
      btnMerge.onclick = () => {
        if (mergeOpenWorker === m.name) {
          mergeOpenWorker = null;
        } else {
          mergeOpenWorker = m.name;
          void previewMergeFromUi(m.name);
        }
        renderWorkers(members, diffs);
      };
      actions.appendChild(btnMerge);
    }

    if (m.status !== 'killed') {
      const btnReview = document.createElement('button');
      btnReview.type = 'button';
      btnReview.className = 'btn btn-sm btn-ghost';
      btnReview.textContent = tr('workers.reviewBtn');
      btnReview.onclick = () => void withBusyButton(btnReview, () => crossReviewFromUi(m.name));
      actions.appendChild(btnReview);
    }

    if (m.status === 'failed') {
      const btnRetry = document.createElement('button');
      btnRetry.type = 'button';
      btnRetry.className = 'btn btn-sm btn-primary';
      btnRetry.textContent = tr('workers.retryBtn');
      btnRetry.onclick = () =>
        void withBusyButton(btnRetry, () => retryOrSwitchWorker({ name: m.name }));
      actions.appendChild(btnRetry);
    }

    if (m.status === 'waiting' || m.status === 'failed') {
      const btnSwitch = document.createElement('button');
      btnSwitch.type = 'button';
      btnSwitch.className = 'btn btn-sm btn-ghost';
      btnSwitch.textContent = tr(
        switchOpenWorker === m.name ? 'workers.switchCancel' : 'workers.switchBtn',
      );
      btnSwitch.onclick = () => {
        if (switchOpenWorker === m.name) {
          switchOpenWorker = null;
        } else {
          switchOpenWorker = m.name;
          if (!switchDrafts.has(m.name)) {
            switchDrafts.set(m.name, {
              provider: m.provider || 'dsh',
              model: m.model || '',
              prompt: '',
            });
          }
        }
        renderWorkers(members, diffs);
      };
      actions.appendChild(btnSwitch);
    }

    if (m.status !== 'killed') {
      const btnKill = document.createElement('button');
      btnKill.type = 'button';
      btnKill.className = 'btn btn-sm btn-danger btn-kill-end';
      btnKill.textContent =
        pendingKillConfirm === m.name ? tr('workers.confirmKill') : tr('workers.kill');
      btnKill.onclick = () => {
        if (pendingKillConfirm !== m.name) {
          pendingKillConfirm = m.name;
          renderWorkers(members, diffs);
          return;
        }
        pendingKillConfirm = null;
        void killWorkerFromUi(m.name);
      };
      actions.appendChild(btnKill);
    }

    card.appendChild(actions);

    if (switchOpenWorker === m.name && (m.status === 'waiting' || m.status === 'failed')) {
      const draft = switchDrafts.get(m.name) || {
        provider: m.provider || 'dsh',
        model: m.model || '',
        prompt: '',
      };
      const enabledProviders =
        latestSnapshot?.providerConfig?.providers?.filter((p) => p.enabled) ||
        latestProviderConfig?.providers?.filter((p) => p.enabled) ||
        [];
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
            <input class="input input-sm mono-input" type="text" data-sw-model value="${escapeHtml(draft.model)}" />
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
      const promptInp = switchBox.querySelector<HTMLInputElement>('[data-sw-prompt]')!;
      const syncDraft = () => {
        switchDrafts.set(m.name, {
          provider: provSel.value,
          model: modelInp.value,
          prompt: promptInp.value,
        });
      };
      provSel.addEventListener('change', () => {
        const chosen = enabledProviders.find((p) => p.id === provSel.value);
        if (chosen?.defaultModel && !modelInp.value.trim()) {
          modelInp.value = chosen.defaultModel;
        }
        syncDraft();
      });
      modelInp.addEventListener('input', syncDraft);
      promptInp.addEventListener('input', syncDraft);
      const swApplyBtn = switchBox.querySelector<HTMLButtonElement>('[data-sw-apply]')!;
      swApplyBtn.addEventListener('click', () => {
        void withBusyButton(swApplyBtn, async () => {
          const ok = await retryOrSwitchWorker({
            name: m.name,
            provider: provSel.value,
            model: modelInp.value.trim() || undefined,
            prompt: promptInp.value.trim() || undefined,
          });
          if (ok) {
            switchOpenWorker = null;
            switchDrafts.delete(m.name);
            if (latestSnapshot?.swarm) {
              renderWorkers(Object.values(latestSnapshot.swarm.members || {}), latestSnapshot.diffs || {});
            }
          }
        });
      });
      card.appendChild(switchBox);
    }

    if (mergeOpenWorker === m.name && m.branch && m.status !== 'killed') {
      const previewState = mergePreviews.get(m.name);
      const draft = mergeDrafts.get(m.name) || {
        mode: 'squash' as const,
        removeWt: true,
        commitMsg: '',
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
        </div>
        <label class="settings-field">
          <span>${escapeHtml(tr('merge.commitMsgLabel'))}</span>
          <input class="input input-sm" type="text" data-mg-msg value="${escapeHtml(draft.commitMsg)}" placeholder="${escapeHtml(tr('merge.commitMsgPlaceholder'))}" />
        </label>
        <div class="settings-add-footer">
          <button type="button" class="btn btn-sm btn-ghost" data-mg-recheck ${previewState?.loading ? 'disabled' : ''}>${escapeHtml(tr('merge.recheckBtn'))}</button>
          <button type="button" class="btn btn-sm btn-primary" data-mg-apply ${!p || !p.canCleanMerge || previewState?.loading ? 'disabled' : ''}>${escapeHtml(tr('merge.confirmBtn'))}</button>
        </div>
      `;

      const modeSel = mergeBox.querySelector<HTMLSelectElement>('[data-mg-mode]')!;
      const rmChk = mergeBox.querySelector<HTMLInputElement>('[data-mg-rm]')!;
      const msgInp = mergeBox.querySelector<HTMLInputElement>('[data-mg-msg]')!;
      const mgRecheckBtn = mergeBox.querySelector<HTMLButtonElement>('[data-mg-recheck]')!;
      const mgApplyBtn = mergeBox.querySelector<HTMLButtonElement>('[data-mg-apply]')!;
      const syncMergeDraft = () => {
        mergeDrafts.set(m.name, {
          mode: modeSel.value as 'squash' | 'cherry-pick' | 'merge',
          removeWt: rmChk.checked,
          commitMsg: msgInp.value,
        });
      };
      modeSel.addEventListener('change', syncMergeDraft);
      rmChk.addEventListener('change', syncMergeDraft);
      msgInp.addEventListener('input', syncMergeDraft);
      mgRecheckBtn.addEventListener('click', () => {
        void withBusyButton(mgRecheckBtn, () => previewMergeFromUi(m.name));
      });
      mgApplyBtn.addEventListener('click', () => {
        syncMergeDraft();
        void withBusyButton(mgApplyBtn, () => applyMergeFromUi(m.name));
      });
      card.appendChild(mergeBox);
    }

    workersList.appendChild(card);
  }

  seenWorkerNames.clear();
  for (const m of members) {
    seenWorkerNames.add(m.name);
  }
}

function buildGaugeCardHtml(opts: {
  idPrefix: string;
  title: string;
  subtitle: string;
  breakdown: UsageBreakdown;
  variant: 'agy' | 'dsh';
  costText?: string | null;
  prevPct?: number;
}): string {
  const r = 36;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, opts.breakdown.cacheHitRate));
  const offset = c * (1 - pct / 100);
  const startPct = opts.prevPct !== undefined ? Math.max(0, Math.min(100, opts.prevPct)) : pct;
  const startOffset = c * (1 - startPct / 100);
  return `
    <div class="usage-card">
      <div class="gauge-wrap">
        <svg class="gauge-svg" viewBox="0 0 88 88">
          <circle class="gauge-ring-bg" cx="44" cy="44" r="${r}" />
          <circle class="gauge-ring-fill ${opts.variant}" cx="44" cy="44" r="${r}"
            stroke-dasharray="${c.toFixed(2)}"
            stroke-dashoffset="${startOffset.toFixed(2)}"
            data-target-offset="${offset.toFixed(2)}" />
        </svg>
        <div class="gauge-center">
          <span class="gauge-pct">${pct}%</span>
          <span class="gauge-sub">${escapeHtml(tr('usage.cacheLabel'))}</span>
        </div>
      </div>
      <div class="usage-card-body">
        <div class="usage-card-title">
          <span>${escapeHtml(opts.title)}</span>
          <span class="pill pill-neutral">${escapeHtml(opts.subtitle)}</span>
        </div>
        <div class="usage-card-total">
          <span id="${opts.idPrefix}-total">${formatNum(opts.breakdown.totalTokens)}</span>
          ${opts.costText ? `<span class="usage-cost-pill">${escapeHtml(opts.costText)}</span>` : ''}
        </div>
        <div class="usage-kv-grid">
          <span>${escapeHtml(tr('usage.newInput'))}<b>${formatNum(opts.breakdown.inputTokens)}</b></span>
          <span>${escapeHtml(tr('usage.cacheRead'))}<b>${formatNum(opts.breakdown.cacheReadTokens)}</b></span>
          <span>${escapeHtml(tr('usage.output'))}<b>${formatNum(opts.breakdown.outputTokens)}</b></span>
          <span>${escapeHtml(tr('usage.steps'))}<b>${opts.breakdown.calls}</b></span>
        </div>
      </div>
    </div>
  `;
}

function renderUsageView(snap: Snapshot, prevSnap: Snapshot | null): void {
  const conversations = snap.availableConversations || [];
  const cu = snap.coordinatorUsage;
  const pricingMap = snap.providerConfig?.pricing || latestProviderConfig?.pricing;
  convSelect.innerHTML = '';
  if (conversations.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = tr('usage.noConvLogs');
    convSelect.appendChild(opt);
    convSelect.disabled = true;
  } else {
    convSelect.disabled = false;
    for (const c of conversations) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.title;
      convSelect.appendChild(opt);
    }
    if (cu?.conversationId) {
      convSelect.value = cu.conversationId;
    }
  }

  const swarm = snap.swarm;
  const members = swarm ? Object.values(swarm.members || {}) : [];
  const dshAgg = aggregateDshUsage(members);

  const effectiveScope: 'swarm' | 'session' = swarm ? usageScope : 'session';
  const agyStats: UsageBreakdown =
    (effectiveScope === 'swarm' ? cu?.sinceSwarmStart : cu?.sessionTotal) || {
      inputTokens: 0,
      cacheReadTokens: 0,
      promptTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheHitRate: 0,
      calls: 0,
    };
  const agyModels =
    (effectiveScope === 'swarm' ? cu?.byModelSinceSwarm : cu?.byModelSession) || {};

  const prevAgyTotal =
    (effectiveScope === 'swarm'
      ? prevSnap?.coordinatorUsage?.sinceSwarmStart.totalTokens
      : prevSnap?.coordinatorUsage?.sessionTotal.totalTokens) || 0;
  const prevDshTotal = prevSnap?.swarm
    ? aggregateDshUsage(Object.values(prevSnap.swarm.members || {})).totalTokens
    : 0;

  const agyCostText = sumModelMapCost(agyModels, pricingMap);
  const workerCostText = sumMembersCost(members, pricingMap);

  const prevAgyPct = prevGaugePcts.get('agy');
  const prevDshPct = prevGaugePcts.get('dsh');

  const agyModelCount = Object.keys(agyModels).length;
  const baseSub =
    effectiveScope === 'swarm' && swarm ? tr('usage.agySubSwarm') : tr('usage.agySubSession');

  usageHero.innerHTML =
    buildGaugeCardHtml({
      idPrefix: 'usage-agy',
      title: agyModelCount > 1 ? tr('usage.agyTitleMulti') : tr('usage.agyTitle'),
      subtitle:
        agyModelCount > 1
          ? tr('usage.agySubModels', { scope: baseSub, n: agyModelCount })
          : baseSub,
      breakdown: agyStats,
      variant: 'agy',
      costText: agyCostText,
      prevPct: prevAgyPct,
    }) +
    buildGaugeCardHtml({
      idPrefix: 'usage-dsh',
      title: tr('usage.workersTitleMulti'),
      subtitle: tr('usage.workersCount', { n: members.length }),
      breakdown: dshAgg,
      variant: 'dsh',
      costText: workerCostText,
      prevPct: prevDshPct,
    });

  if (
    (prevAgyPct !== undefined && prevAgyPct !== agyStats.cacheHitRate) ||
    (prevDshPct !== undefined && prevDshPct !== dshAgg.cacheHitRate)
  ) {
    window.requestAnimationFrame(() => {
      usageHero
        .querySelectorAll<SVGCircleElement>('.gauge-ring-fill[data-target-offset]')
        .forEach((circle) => {
          circle.style.strokeDashoffset = circle.dataset.targetOffset || '0';
        });
    });
  }
  prevGaugePcts.set('agy', agyStats.cacheHitRate);
  prevGaugePcts.set('dsh', dshAgg.cacheHitRate);

  animateNumber(document.getElementById('usage-agy-total'), prevAgyTotal, agyStats.totalTokens, formatNum);
  animateNumber(document.getElementById('usage-dsh-total'), prevDshTotal, dshAgg.totalTokens, formatNum);

  const combined = agyStats.totalTokens + dshAgg.totalTokens;
  const dshShare = combined > 0 ? Math.round((dshAgg.totalTokens / combined) * 1000) / 10 : 0;
  const agyShare = combined > 0 ? Math.max(0, Math.round((100 - dshShare) * 10) / 10) : 0;

  usageSplit.innerHTML = `
    <div class="split-header">
      <span>${escapeHtml(tr('usage.splitHeader'))}</span>
      <span>${escapeHtml(tr('usage.splitTotal', { total: formatNum(combined) }))}</span>
    </div>
    <div class="split-bar">
      <div class="split-seg-dsh" style="width:${dshShare}%"></div>
      <div class="split-seg-agy" style="width:${agyShare}%"></div>
    </div>
    <div class="split-legend">
      <span>${escapeHtml(tr('usage.splitWorkers'))}<strong>${dshShare}%</strong> (${formatNum(dshAgg.totalTokens)})${workerCostText ? ` · ${escapeHtml(workerCostText)}` : ''}</span>
      <span>${escapeHtml(tr('usage.splitAgy'))}<strong>${agyShare}%</strong> (${formatNum(agyStats.totalTokens)})${agyCostText ? ` · ${escapeHtml(agyCostText)}` : ''}</span>
    </div>
  `;

  const agyModelEntries = Object.entries(agyModels).sort((a, b) => b[1].totalTokens - a[1].totalTokens);
  const agyRowsHtml =
    agyModelEntries.length === 0
      ? `<div class="empty-state-compact">${escapeHtml(tr('usage.agyByModelEmpty'))}</div>`
      : agyModelEntries
          .map(([modelName, st]) => {
            const c = calcModelCostValue(
              modelName,
              st.inputTokens,
              st.cacheReadTokens,
              st.outputTokens,
              pricingMap,
            );
            return `
            <div class="detail-row">
              <div class="detail-row-top">
                <span>${escapeHtml(modelName)}</span>
                <span>${formatNum(st.totalTokens)}${c ? ` · <span class="usage-cost-pill">${escapeHtml(formatMoney(c.amount, c.currency))}</span>` : ''}</span>
              </div>
              <div class="detail-row-sub">
                <span>${escapeHtml(tr('usage.stepsShort', { n: st.calls }))}</span>
                <span>${escapeHtml(tr('usage.newInput'))}${formatNum(st.inputTokens)}</span>
                <span>${escapeHtml(tr('usage.cacheRead'))}${formatNum(st.cacheReadTokens)}</span>
                <span>${escapeHtml(tr('usage.output'))}${formatNum(st.outputTokens)}</span>
                <span>${escapeHtml(tr('usage.hitShort'))}<b>${st.cacheHitRate}%</b></span>
              </div>
              <div class="token-bar-track">
                <div class="token-bar-cache" style="width:${st.cacheHitRate}%"></div>
                <div class="token-bar-uncached" style="width:${Math.max(0, 100 - st.cacheHitRate)}%"></div>
              </div>
            </div>
          `;
          })
          .join('');

  const dshRowsHtml =
    members.length === 0
      ? `<div class="empty-state-compact">${escapeHtml(tr('usage.workersDetailEmpty'))}</div>`
      : members
          .map((m) => {
            const inTok = m.usage?.inputTokens || 0;
            const cTok = m.usage?.cacheReadTokens || 0;
            const outTok = m.usage?.outputTokens || 0;
            const totTok = m.usage?.totalTokens || inTok + cTok + outTok;
            const hit = calcInputCacheHit(inTok, cTok);
            const c = calcModelCostValue(m.model, inTok, cTok, outTok, pricingMap);
            return `
              <div class="detail-row">
                <div class="detail-row-top">
                  <span>${escapeHtml(m.name)} <span class="provider-badge">${escapeHtml(m.provider || 'dsh')}</span> ${escapeHtml(m.model)}</span>
                  <span>${formatNum(totTok)}${c ? ` · <span class="usage-cost-pill">${escapeHtml(formatMoney(c.amount, c.currency))}</span>` : ''}</span>
                </div>
                <div class="detail-row-sub">
                  <span>${escapeHtml(tr('usage.turnsStepsShort', { turns: m.turns, steps: m.steps }))}</span>
                  <span>${escapeHtml(tr('usage.newInput'))}${formatNum(inTok)}</span>
                  <span>${escapeHtml(tr('usage.cacheRead'))}${formatNum(cTok)}</span>
                  <span>${escapeHtml(tr('usage.output'))}${formatNum(outTok)}</span>
                  <span>${escapeHtml(tr('usage.hitShort'))}<b>${hit}%</b></span>
                </div>
                <div class="token-bar-track">
                  <div class="token-bar-cache" style="width:${hit}%"></div>
                  <div class="token-bar-uncached" style="width:${inTok + cTok > 0 ? Math.max(0, 100 - hit) : 0}%"></div>
                </div>
              </div>
            `;
          })
          .join('');

  usageDetails.innerHTML = `
    <div class="detail-panel">
      <div class="detail-panel-title">${escapeHtml(tr('usage.agyByModelTitle'))}</div>
      ${agyRowsHtml}
    </div>
    <div class="detail-panel">
      <div class="detail-panel-title">${escapeHtml(tr('usage.workersDetailTitle'))}</div>
      ${dshRowsHtml}
    </div>
  `;

  if (!pricingMap || Object.keys(pricingMap).length === 0) {
    usagePricingHint.innerHTML = `<button type="button" id="usage-open-pricing">${escapeHtml(tr('pricing.hintLink'))}</button>`;
    usagePricingHint.querySelector('#usage-open-pricing')?.addEventListener('click', () => {
      pricingExpanded = true;
      switchTab('settings');
    });
  } else {
    usagePricingHint.innerHTML = '';
  }
}

function renderLogDrawerBody(): void {
  logDrawerCount.textContent = String(cachedLogLines.length);
  logModeToggle.textContent = logRawMode ? tr('drawer.structured') : tr('drawer.raw');

  if (cachedLogLines.length === 0) {
    logDrawerBody.innerHTML = `<div class="empty-state-compact">${escapeHtml(tr('drawer.empty'))}</div>`;
    return;
  }

  if (logRawMode) {
    logDrawerBody.innerHTML = `<pre class="raw-log-pre">${escapeHtml(cachedLogLines.join('\n'))}</pre>`;
    logDrawerBody.scrollTop = logDrawerBody.scrollHeight;
    return;
  }

  logDrawerBody.innerHTML = renderStructuredEventsHtml(cachedLogLines, tr);
  logDrawerBody.scrollTop = logDrawerBody.scrollHeight;
}

async function openWorkerLogs(name: string): Promise<void> {
  activeLogWorker = name;
  diffDrawer.classList.add('hidden');
  logDrawerTitle.textContent = tr('drawer.titleFor', { name });
  logDrawer.classList.remove('hidden');
  try {
    const res = await app.callServerTool({
      name: 'app_get_worker_log',
      arguments: {
        ...(currentSwarmId ? { swarm_id: currentSwarmId } : {}),
        name,
        tail_lines: 120,
      },
    });
    const data = res.structuredContent as { name?: string; lines?: string[] } | undefined;
    cachedLogLines = data?.lines || [];
    renderLogDrawerBody();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    cachedLogLines = [tr('drawer.loadError', { err: errMsg })];
    renderLogDrawerBody();
  }
}

async function killWorkerFromUi(name: string): Promise<void> {
  try {
    await app.callServerTool({
      name: 'app_kill_worker',
      arguments: {
        ...(currentSwarmId ? { swarm_id: currentSwarmId } : {}),
        name,
        remove_worktree: false,
      },
    });
    await refreshSnapshot(true);
  } catch (err) {
    console.error('Failed to kill worker:', err);
  }
}

function renderDiffDrawerBody(): void {
  const data = cachedDiffData;
  if (!data) {
    diffDrawerBody.innerHTML = `<div class="empty-state-compact">${escapeHtml(tr('diff.empty'))}</div>`;
    return;
  }
  diffDrawerBranch.textContent = data.branch || 'HEAD';
  if (!data.patch.trim()) {
    diffDrawerBody.innerHTML = `<div class="empty-state-compact">${escapeHtml(tr('diff.empty'))}</div>`;
    return;
  }
  diffDrawerBody.innerHTML = renderDiffHtml(data, tr);
}

async function openWorkerDiff(name: string): Promise<void> {
  activeDiffWorker = name;
  logDrawer.classList.add('hidden');
  diffDrawerTitle.textContent = tr('diff.titleFor', { name });
  diffDrawerBody.innerHTML = `<div class="empty-state-compact">...</div>`;
  diffDrawer.classList.remove('hidden');
  try {
    const res = await app.callServerTool({
      name: 'app_get_worker_diff',
      arguments: {
        ...(currentSwarmId ? { swarm_id: currentSwarmId } : {}),
        name,
      },
    });
    const payload = res.structuredContent as { diff?: WorktreePatchResult } | undefined;
    cachedDiffData = payload?.diff || null;
    renderDiffDrawerBody();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    diffDrawerBody.innerHTML = `<div class="worker-error">${escapeHtml(tr('diff.loadError', { err: errMsg }))}</div>`;
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
        ...(currentSwarmId ? { swarm_id: currentSwarmId } : {}),
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
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const res = await app.callServerTool({
      name: 'app_get_snapshot',
      arguments: {
        ...(currentSwarmId ? { swarm_id: currentSwarmId } : {}),
        include_diff: activeTab === 'workers',
      },
    });
    if (res.structuredContent) {
      renderSnapshot(res.structuredContent as unknown as Snapshot, force);
    }
    if (activeLogWorker && !logDrawer.classList.contains('hidden')) {
      const worker = latestSnapshot?.swarm?.members?.[activeLogWorker];
      if (worker?.status === 'working') {
        await openWorkerLogs(activeLogWorker);
      }
    }
  } catch (err) {
    console.error('Failed to refresh snapshot:', err);
  } finally {
    pollInFlight = false;
  }
}

function switchTab(tab: 'board' | 'graph' | 'workers' | 'usage' | 'settings'): void {
  activeTab = tab;
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
    if (latestProviderConfig) renderSettingsView();
    void loadProviderConfig();
  } else {
    void refreshSnapshot(true);
  }
}

function showSettingsToast(message: string, isError = false): void {
  settingsToastEl.textContent = message;
  settingsToastEl.classList.toggle('is-error', isError);
  settingsToastEl.style.setProperty('--toast-dur', '3.2s');
  settingsToastEl.classList.remove('hidden', 'has-progress');
  void settingsToastEl.offsetWidth;
  settingsToastEl.classList.add('has-progress');
  if (settingsToastTimer !== null) {
    window.clearTimeout(settingsToastTimer);
  }
  settingsToastTimer = window.setTimeout(() => {
    settingsToastEl.classList.add('hidden');
  }, 3200);
}

function buildPersistConfigFromDescriptor(
  p: ProviderDescriptor,
  enabledOverride?: boolean,
): Record<string, unknown> {
  const cfg: Record<string, unknown> = {
    enabled: enabledOverride ?? p.enabled,
  };
  if (p.hasOverride || p.kind === 'custom') {
    if (p.displayName) cfg.displayName = p.displayName;
    if (p.command) cfg.command = p.command;
    if (p.configuredDefaultModel) cfg.defaultModel = p.configuredDefaultModel;
    if (p.configuredModels.length > 0) cfg.models = p.configuredModels;
    if (p.profile) cfg.profile = p.profile;
    if (p.modelProvider) cfg.modelProvider = p.modelProvider;
    if (p.args) cfg.args = p.args;
    if (p.resumeArgs) cfg.resumeArgs = p.resumeArgs;
    if (p.promptMode) cfg.promptMode = p.promptMode;
    if (p.outputFormat) cfg.outputFormat = p.outputFormat;
    if (p.env) cfg.env = p.env;
  }
  return cfg;
}

async function loadProviderConfig(): Promise<void> {
  if (!latestProviderConfig) {
    settingsProvidersList.innerHTML = `<div class="empty-state-compact">${escapeHtml(tr('settings.loading'))}</div>`;
  }
  try {
    const res = await app.callServerTool({
      name: 'app_get_provider_config',
      arguments: {
        ...(currentSwarmId ? { swarm_id: currentSwarmId } : {}),
        ...(latestSnapshot?.swarm?.repoRoot ? { repo_root: latestSnapshot.swarm.repoRoot } : {}),
      },
    });
    const payload = res.structuredContent as { providerConfig?: ProvidersConfigSnapshot } | undefined;
    if (payload?.providerConfig) {
      latestProviderConfig = payload.providerConfig;
      routingDraftSynced = false;
      const enabledCount = latestProviderConfig.providers.filter((p) => p.enabled).length;
      setBadgeText(badgeSettingsClis, `${enabledCount}/${latestProviderConfig.providers.length}`);
      renderSettingsView();
    }
  } catch (err) {
    showSettingsToast(err instanceof Error ? err.message : String(err), true);
  }
}

async function saveProviderPatch(
  patch: Record<string, unknown>,
  successMessage: string,
  clearDraftId?: string,
): Promise<boolean> {
  try {
    const res = await app.callServerTool({
      name: 'app_save_provider_config',
      arguments: {
        ...patch,
        ...(currentSwarmId ? { swarm_id: currentSwarmId } : {}),
        ...(latestSnapshot?.swarm?.repoRoot ? { repo_root: latestSnapshot.swarm.repoRoot } : {}),
      },
    });
    const payload = res.structuredContent as { providerConfig?: ProvidersConfigSnapshot } | undefined;
    if (res.isError) {
      const msg = (res.content?.[0] as { text?: string } | undefined)?.text || 'Failed to save';
      showSettingsToast(msg, true);
      return false;
    }
    if (clearDraftId) {
      settingsDraftModels.delete(clearDraftId);
    }
    if (payload?.providerConfig) {
      latestProviderConfig = payload.providerConfig;
      routingDraftSynced = false;
      const enabledCount = latestProviderConfig.providers.filter((p) => p.enabled).length;
      setBadgeText(badgeSettingsClis, `${enabledCount}/${latestProviderConfig.providers.length}`);
      renderSettingsView();
    }
    showSettingsToast(successMessage, false);
    return true;
  } catch (err) {
    showSettingsToast(err instanceof Error ? err.message : String(err), true);
    return false;
  }
}

function updateCardModelChips(card: HTMLElement, p: ProviderDescriptor): void {
  const draft = settingsDraftModels.get(p.id) ?? [...p.configuredModels];
  settingsDraftModels.set(p.id, draft);

  const chipsWrap = card.querySelector<HTMLDivElement>('.model-tags-wrap');
  const dl = card.querySelector<HTMLDataListElement>(`#dl-models-${p.id}`);
  const defaultInput = card.querySelector<HTMLInputElement>('[data-field="defaultModel"]');
  const currentDefault = defaultInput?.value.trim() || p.defaultModel || '';

  if (chipsWrap) {
    if (draft.length === 0) {
      chipsWrap.innerHTML = `<span class="empty-hint" style="font-size:11px;color:var(--text-3)">${escapeHtml(tr('settings.noConfiguredModels'))}</span>`;
    } else {
      chipsWrap.innerHTML = draft
        .map(
          (m) => `
          <span class="model-chip${m === currentDefault ? ' is-default' : ''}">
            <span>${escapeHtml(m)}</span>
            <button type="button" class="model-chip-rm" data-remove-model="${escapeHtml(m)}" aria-label="Remove ${escapeHtml(m)}">×</button>
          </span>`,
        )
        .join('');

      chipsWrap.querySelectorAll<HTMLButtonElement>('[data-remove-model]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const target = btn.dataset.removeModel;
          const next = (settingsDraftModels.get(p.id) || []).filter((x) => x !== target);
          settingsDraftModels.set(p.id, next);
          updateCardModelChips(card, p);
        });
      });
    }
  }

  if (dl) {
    const candidates = Array.from(new Set([...draft, ...(p.detectedModels || [])]));
    dl.innerHTML = candidates.map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
  }
}

function renderCliCheckboxGrid(
  container: HTMLElement,
  providers: ProviderDescriptor[],
  checkedSet: Set<string>,
  onToggle: (id: string, checked: boolean) => void,
): void {
  container.innerHTML = '';
  for (const p of providers) {
    const label = document.createElement('label');
    label.className = 'cli-check-pill';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = p.id;
    cb.checked = checkedSet.has(p.id);
    cb.addEventListener('change', () => onToggle(p.id, cb.checked));
    const span = document.createElement('span');
    span.textContent = `${p.id}${p.available ? '' : ' [!]'}`;
    span.title = p.displayName;
    label.appendChild(cb);
    label.appendChild(span);
    container.appendChild(label);
  }
}

function renderRoutingSummaryChips(): void {
  const parts: string[] = [];
  if (routingDraftActive.size > 0) {
    for (const id of routingDraftActive) {
      parts.push(`<span class="provider-badge ${providerBadgeClass(id)}">${escapeHtml(id)}</span>`);
    }
  } else {
    parts.push(`<span class="routing-summary-empty">${escapeHtml(tr('routing.summaryEmpty'))}</span>`);
  }
  if (routingAutoFailover.checked) {
    parts.push(`<span class="failover-tag">${escapeHtml(tr('routing.summaryFailoverOn'))}</span>`);
  }
  routingSummaryChips.innerHTML = parts.join('');
}

function renderSettingsRoutingCard(cfg: ProvidersConfigSnapshot): void {
  if (!routingDraftSynced) {
    routingDraftSynced = true;
    routingDraftActive.clear();
    routingDraftWriter.clear();
    routingDraftReader.clear();
    for (const id of cfg.activePool || []) routingDraftActive.add(id);
    for (const id of cfg.routingPolicy?.writerProviders || []) routingDraftWriter.add(id);
    for (const id of cfg.routingPolicy?.readerProviders || []) routingDraftReader.add(id);
    routingAutoFailover.checked = Boolean(cfg.routingPolicy?.autoFailover);
  }

  routingCountBadge.textContent = String(routingDraftActive.size);
  routingBody.classList.toggle('hidden', !routingExpanded);
  btnToggleRouting.textContent = tr(routingExpanded ? 'settings.collapse' : 'settings.expand');
  renderRoutingSummaryChips();
  if (!routingExpanded) return;

  const enabled = cfg.providers.filter((p) => p.enabled);
  renderCliCheckboxGrid(routingActivePool, enabled, routingDraftActive, (id, on) => {
    if (on) routingDraftActive.add(id);
    else routingDraftActive.delete(id);
    routingCountBadge.textContent = String(routingDraftActive.size);
    renderRoutingSummaryChips();
  });
  renderCliCheckboxGrid(routingWriterPool, enabled, routingDraftWriter, (id, on) => {
    if (on) routingDraftWriter.add(id);
    else routingDraftWriter.delete(id);
  });
  renderCliCheckboxGrid(routingReaderPool, enabled, routingDraftReader, (id, on) => {
    if (on) routingDraftReader.add(id);
    else routingDraftReader.delete(id);
  });
}

function renderSettingsView(): void {
  const cfg = latestProviderConfig;
  if (!cfg) return;

  renderSettingsRoutingCard(cfg);

  // Default provider select
  settingsDefaultSelect.innerHTML = '';
  const autoOpt = document.createElement('option');
  autoOpt.value = '';
  autoOpt.textContent = tr('settings.autoEffective', { id: cfg.effectiveDefaultProvider });
  settingsDefaultSelect.appendChild(autoOpt);

  for (const p of cfg.providers) {
    if (!p.enabled) continue;
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.displayName} (${p.id})`;
    settingsDefaultSelect.appendChild(opt);
  }
  settingsDefaultSelect.value = cfg.configuredDefaultProvider || '';

  // Config path meta
  const metaParts = [
    `<span>${escapeHtml(tr('settings.configFileLabel'))} <code>${escapeHtml(cfg.globalConfigPath)}</code></span>`,
  ];
  if (cfg.repoConfigExists && cfg.repoConfigPath) {
    metaParts.push(
      `<span>${escapeHtml(tr('settings.repoOverrideNote', { path: cfg.repoConfigPath }))}</span>`,
    );
  }
  settingsMetaEl.innerHTML = metaParts.join('');

  // Provider cards
  settingsProvidersList.innerHTML = '';
  for (const p of cfg.providers) {
    const expanded = settingsExpanded.has(p.id);
    if (!settingsDraftModels.has(p.id)) {
      settingsDraftModels.set(p.id, [...p.configuredModels]);
    }
    const card = document.createElement('div');
    card.className = `provider-card${expanded ? ' is-expanded' : ''}${p.enabled ? '' : ' is-disabled'}`;

    const isEffectiveDefault = cfg.effectiveDefaultProvider === p.id;
    const cmdText = p.resolvedPath ? `${p.command} → ${p.resolvedPath}` : p.command;
    const detectedCount = p.detectedModels?.length || 0;

    const testRes = settingsTestResults.get(p.id);
    const isTesting = testingProviders.has(p.id);

    card.innerHTML = `
      <div class="provider-head">
        <div class="provider-head-main">
          <div class="provider-title-row">
            <span class="provider-name">${escapeHtml(p.displayName)}</span>
            <span class="provider-id-code">${escapeHtml(p.id)}</span>
            <span class="badge ${p.kind === 'custom' ? 'badge-brief' : ''}">${escapeHtml(tr(p.kind === 'custom' ? 'settings.custom' : 'settings.builtin'))}</span>
            ${isEffectiveDefault ? `<span class="badge badge-done">${escapeHtml(tr('settings.defaultBadge'))}</span>` : ''}
            ${p.kind === 'builtin' && p.hasOverride ? `<span class="badge badge-system">${escapeHtml(tr('settings.overriddenBadge'))}</span>` : ''}
            <span class="badge ${p.available ? 'badge-done' : 'badge-warning'}">${escapeHtml(tr(p.available ? 'settings.installed' : 'settings.missingBin'))}</span>
          </div>
          <div class="provider-sub">
            <span><code>${escapeHtml(cmdText)}</code></span>
            <span>${escapeHtml(tr('workers.model'))}: <code>${escapeHtml(p.defaultModel || 'default')}</code></span>
            <span>${p.models.length > 0 ? `${p.models.length} models` : ''}</span>
          </div>
        </div>
        <div class="provider-head-controls">
          <button type="button" class="btn btn-sm btn-ghost" data-test-provider="${escapeHtml(p.id)}" ${isTesting ? 'disabled' : ''}>
            ${escapeHtml(tr(isTesting ? 'settings.testingBtn' : 'settings.testBtn'))}
          </button>
          <label class="switch-label">
            <input type="checkbox" class="switch-input" data-toggle-enable="${escapeHtml(p.id)}" ${p.enabled ? 'checked' : ''} />
            <span>${escapeHtml(tr('settings.enableToggle'))}</span>
          </label>
          <button type="button" class="btn btn-sm btn-ghost" data-toggle-expand="${escapeHtml(p.id)}">
            ${escapeHtml(tr(expanded ? 'settings.collapse' : 'settings.expand'))}
          </button>
        </div>
      </div>
      ${
        testRes
          ? `
        <div class="provider-test-result ${testRes.ok ? 'is-ok' : 'is-fail'}">
          <strong>${escapeHtml(testRes.ok ? tr('settings.testPassed', { ms: testRes.latencyMs }) : tr('settings.testFailed', { ms: testRes.latencyMs }))}</strong>
          <span class="provider-test-meta">${escapeHtml(testRes.details)}${testRes.warnings?.length ? ` · ${escapeHtml(testRes.warnings.join('; '))}` : ''}</span>
        </div>`
          : ''
      }
    `;

    if (expanded) {
      const body = document.createElement('div');
      body.className = 'provider-body';
      body.innerHTML = `
        <div class="settings-form-grid">
          <label class="settings-field">
            <span>${escapeHtml(tr('settings.displayNameLabel'))}</span>
            <input class="input input-sm" type="text" data-field="displayName" value="${escapeHtml(p.displayName)}" />
          </label>
          <label class="settings-field">
            <span>${escapeHtml(tr('settings.commandLabel'))}</span>
            <input class="input input-sm mono-input" type="text" data-field="command" value="${escapeHtml(p.command)}" />
          </label>
          <label class="settings-field span-2">
            <span>${escapeHtml(tr('settings.defaultModelLabel'))}</span>
            <input class="input input-sm mono-input" type="text" list="dl-models-${escapeHtml(p.id)}" data-field="defaultModel" value="${escapeHtml(p.configuredDefaultModel || '')}" placeholder="${escapeHtml(p.detectedDefaultModel ? `${p.detectedDefaultModel} (auto)` : tr('settings.defaultModelPlaceholder'))}" />
            <datalist id="dl-models-${escapeHtml(p.id)}"></datalist>
          </label>
          ${
            p.id === 'dsh'
              ? `
            <label class="settings-field">
              <span>${escapeHtml(tr('settings.dshProfileLabel'))}</span>
              <input class="input input-sm mono-input" type="text" data-field="profile" value="${escapeHtml(p.profile || 'headless')}" />
            </label>
            <label class="settings-field">
              <span>${escapeHtml(tr('settings.dshModelProviderLabel'))}</span>
              <input class="input input-sm mono-input" type="text" data-field="modelProvider" value="${escapeHtml(p.modelProvider || '')}" placeholder="${escapeHtml(p.detectedModelProvider ? `${p.detectedModelProvider} (auto)` : tr('settings.dshModelProviderPlaceholder'))}" />
            </label>`
              : ''
          }
          ${
            p.kind === 'custom'
              ? `
            <label class="settings-field">
              <span>${escapeHtml(tr('settings.promptModeLabel'))}</span>
              <select class="input input-sm" data-field="promptMode">
                <option value="stdin" ${p.promptMode !== 'arg' ? 'selected' : ''}>stdin</option>
                <option value="arg" ${p.promptMode === 'arg' ? 'selected' : ''}>arg ({{prompt}})</option>
              </select>
            </label>
            <label class="settings-field">
              <span>${escapeHtml(tr('settings.outputFormatLabel'))}</span>
              <select class="input input-sm" data-field="outputFormat">
                <option value="text" ${p.outputFormat !== 'ndjson' ? 'selected' : ''}>text</option>
                <option value="ndjson" ${p.outputFormat === 'ndjson' ? 'selected' : ''}>ndjson</option>
              </select>
            </label>
            <label class="settings-field span-2">
              <span>${escapeHtml(tr('settings.argsLabel'))}</span>
              <input class="input input-sm mono-input" type="text" data-field="args" value="${escapeHtml(formatArgsForInput(p.args))}" placeholder="${escapeHtml(tr('settings.argsHint'))}" />
            </label>
            <label class="settings-field span-2">
              <span>${escapeHtml(tr('settings.resumeArgsLabel'))}</span>
              <input class="input input-sm mono-input" type="text" data-field="resumeArgs" value="${escapeHtml(formatArgsForInput(p.resumeArgs))}" placeholder="${escapeHtml(tr('settings.argsHint'))}" />
            </label>`
              : ''
          }
        </div>

        <div class="settings-field">
          <span>${escapeHtml(tr('settings.modelsLabel'))}</span>
          <div class="model-tags-wrap"></div>
          <div class="model-add-row">
            <input class="input input-sm mono-input" type="text" data-model-input placeholder="${escapeHtml(tr('settings.modelInputPlaceholder'))}" />
            <button type="button" class="btn btn-sm" data-model-add>${escapeHtml(tr('settings.addModelBtn'))}</button>
          </div>
        </div>

        ${
          detectedCount > 0
            ? `
          <div class="detected-box">
            <div class="detected-head">
              <span>${escapeHtml(tr('settings.detectedSection', { profile: p.profile || 'headless', model: p.detectedDefaultModel || 'default' }))}</span>
              <button type="button" class="btn btn-sm btn-ghost" data-import-detected>${escapeHtml(tr('settings.importAllDetected', { n: detectedCount }))}</button>
            </div>
            <div class="detected-chips">
              ${(p.detectedModels || [])
                .map(
                  (m) => `<button type="button" class="detected-chip-btn" data-add-detected="${escapeHtml(m)}">+ ${escapeHtml(m)}</button>`,
                )
                .join('')}
            </div>
          </div>`
            : ''
        }

        <div class="provider-actions-row">
          <div class="provider-actions-left">
            ${
              p.kind === 'builtin' && p.hasOverride
                ? `<button type="button" class="btn btn-sm btn-ghost" data-reset-provider="${escapeHtml(p.id)}">${escapeHtml(tr('settings.resetBtn'))}</button>`
                : p.kind === 'custom'
                  ? `<button type="button" class="btn btn-sm btn-danger" data-delete-provider="${escapeHtml(p.id)}">${escapeHtml(tr(pendingDeleteProvider === p.id ? 'settings.confirmDelete' : 'settings.deleteBtn'))}</button>`
                  : ''
            }
          </div>
          <div class="provider-actions-right">
            <button type="button" class="btn btn-sm btn-primary" data-save-provider="${escapeHtml(p.id)}">${escapeHtml(tr('settings.saveBtn'))}</button>
          </div>
        </div>
      `;

      card.appendChild(body);
      updateCardModelChips(card, p);

      const modelInput = body.querySelector<HTMLInputElement>('[data-model-input]')!;
      const modelAddBtn = body.querySelector<HTMLButtonElement>('[data-model-add]')!;
      const addTypedModels = () => {
        const items = splitModelList(modelInput.value);
        if (items.length === 0) return;
        const cur = settingsDraftModels.get(p.id) || [];
        const next = Array.from(new Set([...cur, ...items]));
        settingsDraftModels.set(p.id, next);
        modelInput.value = '';
        updateCardModelChips(card, p);
      };
      modelAddBtn.addEventListener('click', addTypedModels);
      modelInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addTypedModels();
        }
      });

      const importAllBtn = body.querySelector<HTMLButtonElement>('[data-import-detected]');
      if (importAllBtn) {
        importAllBtn.addEventListener('click', () => {
          const cur = settingsDraftModels.get(p.id) || [];
          const next = Array.from(new Set([...cur, ...(p.detectedModels || [])]));
          settingsDraftModels.set(p.id, next);
          updateCardModelChips(card, p);
        });
      }

      body.querySelectorAll<HTMLButtonElement>('[data-add-detected]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const m = btn.dataset.addDetected;
          if (!m) return;
          const cur = settingsDraftModels.get(p.id) || [];
          if (!cur.includes(m)) {
            settingsDraftModels.set(p.id, [...cur, m]);
            updateCardModelChips(card, p);
          }
        });
      });

      const saveBtn = body.querySelector<HTMLButtonElement>(`[data-save-provider="${p.id}"]`);
      saveBtn?.addEventListener('click', async () => {
        const displayName = body.querySelector<HTMLInputElement>('[data-field="displayName"]')?.value.trim();
        const command = body.querySelector<HTMLInputElement>('[data-field="command"]')?.value.trim();
        const defaultModel = body.querySelector<HTMLInputElement>('[data-field="defaultModel"]')?.value.trim();
        const enabledInput = card.querySelector<HTMLInputElement>(`[data-toggle-enable="${p.id}"]`);
        const enabled = enabledInput ? enabledInput.checked : p.enabled;
        const models = [...(settingsDraftModels.get(p.id) || [])];

        const nextConfig: Record<string, unknown> = {
          enabled,
          ...(displayName ? { displayName } : {}),
          ...(command ? { command } : {}),
          ...(defaultModel ? { defaultModel } : {}),
          ...(models.length > 0 ? { models } : {}),
        };

        if (p.id === 'dsh') {
          const profileVal = body.querySelector<HTMLInputElement>('[data-field="profile"]')?.value.trim();
          const mpVal = body.querySelector<HTMLInputElement>('[data-field="modelProvider"]')?.value.trim();
          if (profileVal && profileVal !== 'headless') nextConfig.profile = profileVal;
          else if (profileVal === 'headless' && p.hasOverride && p.profile && p.profile !== 'headless') {
            nextConfig.profile = 'headless';
          }
          if (mpVal) nextConfig.modelProvider = mpVal;
        }

        if (p.kind === 'custom') {
          if (!command) {
            showSettingsToast(tr('settings.errorRequired'), true);
            return;
          }
          nextConfig.command = command;
          const argsVal = parseArgsFromInput(body.querySelector<HTMLInputElement>('[data-field="args"]')?.value || '');
          const resumeVal = parseArgsFromInput(
            body.querySelector<HTMLInputElement>('[data-field="resumeArgs"]')?.value || '',
          );
          const pmVal = body.querySelector<HTMLSelectElement>('[data-field="promptMode"]')?.value as 'stdin' | 'arg';
          const ofVal = body.querySelector<HTMLSelectElement>('[data-field="outputFormat"]')?.value as 'text' | 'ndjson';
          if (argsVal) nextConfig.args = argsVal;
          if (resumeVal) nextConfig.resumeArgs = resumeVal;
          if (pmVal) nextConfig.promptMode = pmVal;
          if (ofVal) nextConfig.outputFormat = ofVal;
        }

        await saveProviderPatch(
          { upsert_provider: { id: p.id, config: nextConfig } },
          tr('settings.savedToast'),
          p.id,
        );
      });

      const resetBtn = body.querySelector<HTMLButtonElement>(`[data-reset-provider="${p.id}"]`);
      resetBtn?.addEventListener('click', async () => {
        await saveProviderPatch(
          { upsert_provider: { id: p.id, config: null } },
          tr('settings.resetToast'),
          p.id,
        );
      });

      const delBtn = body.querySelector<HTMLButtonElement>(`[data-delete-provider="${p.id}"]`);
      delBtn?.addEventListener('click', async () => {
        if (pendingDeleteProvider !== p.id) {
          pendingDeleteProvider = p.id;
          renderSettingsView();
          return;
        }
        pendingDeleteProvider = null;
        settingsExpanded.delete(p.id);
        await saveProviderPatch(
          { remove_provider: p.id },
          tr('settings.deletedToast', { id: p.id }),
          p.id,
        );
      });
    }

    const testBtn = card.querySelector<HTMLButtonElement>(`[data-test-provider="${p.id}"]`);
    testBtn?.addEventListener('click', () => {
      void runProviderConnectionTest(p.id);
    });

    const enableToggle = card.querySelector<HTMLInputElement>(`[data-toggle-enable="${p.id}"]`);
    enableToggle?.addEventListener('change', async () => {
      const nextCfg = buildPersistConfigFromDescriptor(p, enableToggle.checked);
      await saveProviderPatch(
        { upsert_provider: { id: p.id, config: nextCfg } },
        tr('settings.savedToast'),
      );
    });

    const expandBtn = card.querySelector<HTMLButtonElement>(`[data-toggle-expand="${p.id}"]`);
    expandBtn?.addEventListener('click', () => {
      pendingDeleteProvider = null;
      if (settingsExpanded.has(p.id)) {
        settingsExpanded.delete(p.id);
      } else {
        settingsExpanded.add(p.id);
      }
      renderSettingsView();
    });

    settingsProvidersList.appendChild(card);
  }

  renderPricingSection(cfg);
}

async function runProviderConnectionTest(providerId: string): Promise<void> {
  testingProviders.add(providerId);
  renderSettingsView();
  if (onboardingVisible) renderOnboardingWizard();
  try {
    const res = await app.callServerTool({
      name: 'app_test_provider',
      arguments: {
        provider_id: providerId,
        ...(currentSwarmId ? { swarm_id: currentSwarmId } : {}),
        ...(latestSnapshot?.swarm?.repoRoot ? { repo_root: latestSnapshot.swarm.repoRoot } : {}),
      },
    });
    const payload = res.structuredContent as { result?: ProviderTestResult } | undefined;
    if (payload?.result) {
      settingsTestResults.set(providerId, payload.result);
    }
  } catch (err) {
    settingsTestResults.set(providerId, {
      providerId,
      command: providerId,
      ok: false,
      latencyMs: 0,
      details: err instanceof Error ? err.message : String(err),
    });
  } finally {
    testingProviders.delete(providerId);
    renderSettingsView();
    if (onboardingVisible) renderOnboardingWizard();
  }
}

function renderPricingSection(cfg: ProvidersConfigSnapshot): void {
  const entries = Object.entries(cfg.pricing || {});
  pricingCountBadge.textContent = String(entries.length);
  btnTogglePricing.textContent = tr(pricingExpanded ? 'settings.collapse' : 'settings.expand');
  pricingBody.classList.toggle('hidden', !pricingExpanded);

  const knownModels = new Set<string>();
  for (const p of cfg.providers) {
    for (const m of p.models) knownModels.add(m);
  }
  const cu = latestSnapshot?.coordinatorUsage;
  if (cu) {
    for (const m of Object.keys(cu.byModelSession || {})) knownModels.add(m);
  }
  dlPricingModels.innerHTML = Array.from(knownModels)
    .map((m) => `<option value="${escapeHtml(m)}"></option>`)
    .join('');

  if (entries.length === 0) {
    pricingList.innerHTML = `<div class="empty-state-compact" style="padding:6px 0">${escapeHtml(tr('pricing.empty'))}</div>`;
    return;
  }

  pricingList.innerHTML = entries
    .map(([model, rate]) => {
      const sym = rate.currency === 'CNY' ? '¥' : '$';
      const cacheTxt = rate.cacheReadPer1M !== undefined ? `${sym}${rate.cacheReadPer1M}` : '-';
      return `
        <div class="pricing-row">
          <div>
            <code>${escapeHtml(model)}</code>
            <span class="pricing-row-rates"> · in=${sym}${rate.inputPer1M} · cache=${cacheTxt} · out=${sym}${rate.outputPer1M} / 1M</span>
          </div>
          <button type="button" class="btn btn-sm btn-ghost btn-ghost-danger" data-delete-pricing="${escapeHtml(model)}">${escapeHtml(tr('pricing.deleteBtn'))}</button>
        </div>
      `;
    })
    .join('');

  pricingList.querySelectorAll<HTMLButtonElement>('[data-delete-pricing]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetModel = btn.dataset.deletePricing;
      if (!targetModel) return;
      void saveProviderPatch(
        { upsert_pricing: { model: targetModel, pricing: null } },
        tr('settings.savedToast'),
      );
    });
  });
}

function stopReplayPlayback(): void {
  replayPlaying = false;
  replayPlayBtn.textContent = tr('graph.play');
  if (replayTimer !== null) {
    window.clearInterval(replayTimer);
    replayTimer = null;
  }
}

function stepReplay(nextSeq: number): void {
  if (!latestSnapshot?.swarm) return;
  const maxSeq = latestSnapshot.messages.length
    ? latestSnapshot.messages[latestSnapshot.messages.length - 1].seq
    : 0;
  if (maxSeq === 0) return;
  const clamped = Math.max(1, Math.min(maxSeq, nextSeq));
  replaySeq = clamped >= maxSeq && !replayPlaying ? null : clamped;
  renderGraphAndReplay(latestSnapshot.swarm, latestSnapshot.messages);
}

// Event listeners
btnLang.addEventListener('click', async () => {
  localeOverriddenByUser = true;
  currentLocale = currentLocale === 'zh' ? 'en' : 'zh';
  applyStaticI18n();
  if (latestSnapshot) {
    renderSnapshot(latestSnapshot, true);
  }
  if (activeTab === 'settings' && latestProviderConfig) {
    renderSettingsView();
  }
  try {
    await app.callServerTool({
      name: 'app_set_ui_prefs',
      arguments: { locale: currentLocale },
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

settingsDefaultSelect.addEventListener('change', () => {
  const val = settingsDefaultSelect.value.trim();
  void saveProviderPatch(
    { default_provider: val ? val : null },
    tr('settings.savedToast'),
  );
});

settingsOpenOnboardingBtn.addEventListener('click', () => {
  void openOnboardingWizard();
});

settingsRescanBtn.addEventListener('click', () => {
  void loadProviderConfig();
});

settingsToggleAddBtn.addEventListener('click', () => {
  settingsAddPanel.classList.toggle('hidden');
  if (!settingsAddPanel.classList.contains('hidden')) {
    customAddIdInput.focus();
  }
});

settingsAddCancelBtn.addEventListener('click', () => {
  settingsAddPanel.classList.add('hidden');
  settingsAddPanel.reset();
});

document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const presetKey = btn.dataset.preset;
    if (presetKey) applyCustomPreset(presetKey);
  });
});

btnToggleRouting.addEventListener('click', () => {
  routingExpanded = !routingExpanded;
  if (latestProviderConfig) {
    renderSettingsRoutingCard(latestProviderConfig);
  }
});

routingAutoFailover.addEventListener('change', () => {
  renderRoutingSummaryChips();
});

routingSaveBtn.addEventListener('click', async () => {
  await withBusyButton(routingSaveBtn, async () => {
    const activePool = [...routingDraftActive];
    const writerProviders = [...routingDraftWriter];
    const readerProviders = [...routingDraftReader];
    const autoFailover = routingAutoFailover.checked;
    const routingPolicy =
      writerProviders.length > 0 || readerProviders.length > 0 || autoFailover
        ? {
            ...(writerProviders.length > 0 ? { writer_providers: writerProviders } : {}),
            ...(readerProviders.length > 0 ? { reader_providers: readerProviders } : {}),
            auto_failover: autoFailover,
          }
        : null;

    await saveProviderPatch(
      {
        active_pool: activePool.length > 0 ? activePool : null,
        routing_policy: routingPolicy,
      },
      tr('routing.savedToast'),
    );
    await refreshSnapshot(true);
  });
});

btnTogglePricing.addEventListener('click', () => {
  pricingExpanded = !pricingExpanded;
  if (latestProviderConfig) {
    renderPricingSection(latestProviderConfig);
  }
});

pricingForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const model = pricingModelInput.value.trim();
  const inputPer1M = Number(pricingInputRate.value);
  const outputPer1M = Number(pricingOutputRate.value);
  const cacheVal = pricingCacheRate.value.trim();
  const cacheReadPer1M = cacheVal ? Number(cacheVal) : undefined;
  const currency = pricingCurrencySelect.value === 'CNY' ? 'CNY' : 'USD';
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
    pricingForm.reset();
    await refreshSnapshot(true);
  }
});

settingsAddPanel.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = customAddIdInput.value.trim().toLowerCase();
  const command = customAddCmdInput.value.trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id) || !command) {
    showSettingsToast(tr('settings.errorRequired'), true);
    return;
  }
  const displayName = customAddNameInput.value.trim();
  const defaultModel = customAddDefaultModelInput.value.trim();
  const promptMode = customAddPromptMode.value as 'stdin' | 'arg';
  const outputFormat = customAddOutputFormat.value as 'text' | 'ndjson';
  const args = parseArgsFromInput(customAddArgsInput.value);
  const resumeArgs = parseArgsFromInput(customAddResumeArgsInput.value);
  const models = splitModelList(customAddModelsInput.value);

  const config: Record<string, unknown> = {
    enabled: true,
    command,
    promptMode,
    outputFormat,
    ...(displayName ? { displayName } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    ...(args ? { args } : {}),
    ...(resumeArgs ? { resumeArgs } : {}),
    ...(models.length > 0 ? { models } : {}),
  };

  const ok = await saveProviderPatch(
    { upsert_provider: { id, config } },
    tr('settings.savedToast'),
  );
  if (ok) {
    settingsExpanded.add(id);
    settingsAddPanel.reset();
    settingsAddPanel.classList.add('hidden');
    renderSettingsView();
  }
});

document.querySelectorAll<HTMLButtonElement>('.chip-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const kind = btn.dataset.kind as 'all' | 'done' | 'alerts';
    if (!kind) return;
    selectedKindFilter = kind;
    document.querySelectorAll('.chip-btn').forEach((c) => {
      c.classList.toggle('active', (c as HTMLElement).dataset.kind === kind);
    });
    if (latestSnapshot) renderBoard(latestSnapshot.messages);
  });
});

document.querySelectorAll<HTMLButtonElement>('.scope-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const scope = btn.dataset.scope as 'swarm' | 'session';
    if (!scope) return;
    usageScope = scope;
    document.querySelectorAll('.scope-btn').forEach((c) => {
      c.classList.toggle('active', (c as HTMLElement).dataset.scope === scope);
    });
    if (latestSnapshot) renderSnapshot(latestSnapshot, true);
  });
});

convSelect.addEventListener('change', async () => {
  const convId = convSelect.value;
  if (!convId || !latestSnapshot?.swarm) return;
  try {
    await app.callServerTool({
      name: 'app_bind_conversation',
      arguments: {
        swarm_id: latestSnapshot.swarm.id,
        conversation_id: convId,
      },
    });
    await refreshSnapshot(true);
  } catch (err) {
    console.error('Failed to bind conversation:', err);
  }
});

boardFeed.addEventListener('click', (e) => {
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
    if (activeCommanderPanel !== emptyAct) {
      toggleCommanderPanel(emptyAct);
    }
  } else if (emptyAct === 'onboarding') {
    void openOnboardingWizard();
  } else if (emptyAct === 'settings') {
    switchTab('settings');
  }
});

boardFeed.addEventListener('scroll', () => {
  const nearBottom = boardFeed.scrollHeight - boardFeed.scrollTop - boardFeed.clientHeight < 48;
  btnJumpLatest.classList.toggle('hidden', nearBottom);
});

btnJumpLatest.addEventListener('click', () => {
  autoFollow.checked = true;
  boardFeed.scrollTop = boardFeed.scrollHeight;
  btnJumpLatest.classList.add('hidden');
});

swarmSelect.addEventListener('change', () => {
  pendingDeleteSwarm = false;
  setButtonLabel(btnDeleteSwarm, tr('app.deleteSwarm'));
  currentSwarmId = swarmSelect.value || undefined;
  selectedAgentFilter = null;
  replaySeq = null;
  seenSeqs.clear();
  seenWorkerNames.clear();
  prevGaugePcts.clear();
  initialBoardLoaded = false;
  stopReplayPlayback();
  lastRenderSignature = '';
  void refreshSnapshot(true);
});

btnExportSwarm.addEventListener('click', async () => {
  if (!latestSnapshot?.swarm) return;
  try {
    const res = await app.callServerTool({
      name: 'app_export_swarm',
      arguments: {
        ...(currentSwarmId ? { swarm_id: currentSwarmId } : {}),
      },
    });
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

    const prevText = getButtonLabel(btnExportSwarm);
    setButtonLabel(btnExportSwarm, tr('app.exported'));
    window.setTimeout(() => {
      setButtonLabel(btnExportSwarm, prevText || tr('app.export'));
    }, 1800);
  } catch (err) {
    console.error('Failed to export swarm:', err);
  }
});

btnDeleteSwarm.addEventListener('click', async () => {
  if (!latestSnapshot?.swarm) return;
  if (!pendingDeleteSwarm) {
    pendingDeleteSwarm = true;
    setButtonLabel(btnDeleteSwarm, tr('app.confirmDeleteSwarm'));
    window.setTimeout(() => {
      if (pendingDeleteSwarm) {
        pendingDeleteSwarm = false;
        setButtonLabel(btnDeleteSwarm, tr('app.deleteSwarm'));
      }
    }, 3500);
    return;
  }
  pendingDeleteSwarm = false;
  setButtonLabel(btnDeleteSwarm, tr('app.deleteSwarm'));
  try {
    const res = await app.callServerTool({
      name: 'app_delete_swarm',
      arguments: {
        swarm_id: latestSnapshot.swarm.id,
        remove_worktrees: true,
      },
    });
    const payload = res.structuredContent as { swarms?: SwarmIndexEntry[] } | undefined;
    currentSwarmId = payload?.swarms?.at(-1)?.id;
    selectedAgentFilter = null;
    replaySeq = null;
    seenSeqs.clear();
    seenWorkerNames.clear();
    prevGaugePcts.clear();
    initialBoardLoaded = false;
    lastRenderSignature = '';
    await refreshSnapshot(true);
  } catch (err) {
    console.error('Failed to delete swarm:', err);
  }
});

diffDrawerCopy.addEventListener('click', async () => {
  if (!cachedDiffData?.patch) return;
  try {
    await navigator.clipboard?.writeText(cachedDiffData.patch);
    diffDrawerCopy.textContent = tr('diff.copied');
    window.setTimeout(() => {
      diffDrawerCopy.textContent = tr('diff.copy');
    }, 1600);
  } catch {
    // Non-fatal in sandboxed iframe
  }
});

diffDrawerRefresh.addEventListener('click', () => {
  if (activeDiffWorker) void openWorkerDiff(activeDiffWorker);
});

diffDrawerClose.addEventListener('click', () => {
  activeDiffWorker = null;
  diffDrawer.classList.add('hidden');
});

boardFilter.addEventListener('input', () => {
  if (latestSnapshot) renderBoard(latestSnapshot.messages);
});

btnRefresh.addEventListener('click', () => {
  btnRefresh.classList.remove('is-spinning');
  void btnRefresh.offsetWidth;
  btnRefresh.classList.add('is-spinning');
  window.setTimeout(() => btnRefresh.classList.remove('is-spinning'), 580);
  void refreshSnapshot(true);
  if (activeTab === 'settings') {
    void loadProviderConfig();
  }
});

logModeToggle.addEventListener('click', () => {
  logRawMode = !logRawMode;
  renderLogDrawerBody();
});

logDrawerRefresh.addEventListener('click', () => {
  if (activeLogWorker) void openWorkerLogs(activeLogWorker);
});

logDrawerClose.addEventListener('click', () => {
  activeLogWorker = null;
  logDrawer.classList.add('hidden');
});

replaySlider.addEventListener('input', () => {
  stopReplayPlayback();
  stepReplay(Number(replaySlider.value));
});

replayPrevBtn.addEventListener('click', () => {
  stopReplayPlayback();
  const maxSeq = latestSnapshot?.messages.at(-1)?.seq || 1;
  const cur = replaySeq ?? maxSeq;
  stepReplay(cur - 1);
});

replayNextBtn.addEventListener('click', () => {
  stopReplayPlayback();
  const maxSeq = latestSnapshot?.messages.at(-1)?.seq || 1;
  const cur = replaySeq ?? maxSeq;
  stepReplay(cur + 1);
});

replayLiveBtn.addEventListener('click', () => {
  stopReplayPlayback();
  replaySeq = null;
  if (latestSnapshot?.swarm) {
    renderGraphAndReplay(latestSnapshot.swarm, latestSnapshot.messages);
  }
});

replayPlayBtn.addEventListener('click', () => {
  if (!latestSnapshot?.swarm || latestSnapshot.messages.length === 0) return;
  if (replayPlaying) {
    stopReplayPlayback();
    return;
  }
  const maxSeq = latestSnapshot.messages[latestSnapshot.messages.length - 1].seq;
  if (replaySeq === null || replaySeq >= maxSeq) {
    replaySeq = 1;
  }
  replayPlaying = true;
  replayPlayBtn.textContent = tr('graph.pause');
  renderGraphAndReplay(latestSnapshot.swarm, latestSnapshot.messages);

  replayTimer = window.setInterval(() => {
    if (!latestSnapshot?.swarm) {
      stopReplayPlayback();
      return;
    }
    const head = latestSnapshot.messages.at(-1)?.seq || 1;
    const next = (replaySeq ?? 1) + 1;
    if (next > head) {
      stopReplayPlayback();
      replaySeq = null;
      renderGraphAndReplay(latestSnapshot.swarm, latestSnapshot.messages);
      return;
    }
    replaySeq = next;
    renderGraphAndReplay(latestSnapshot.swarm, latestSnapshot.messages);
  }, 1400);
});

composerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!latestSnapshot?.swarm) return;
  const text = composerInput.value.trim();
  if (!text) return;
  composerInput.value = '';
  try {
    await app.callServerTool({
      name: 'app_post_message',
      arguments: {
        ...(currentSwarmId ? { swarm_id: currentSwarmId } : {}),
        text,
      },
    });
    await refreshSnapshot(true);
  } catch (err) {
    console.error('Failed to post message:', err);
  }
});

btnSendSummary.addEventListener('click', async () => {
  if (!latestSnapshot?.swarm) return;
  const s = latestSnapshot.swarm;
  const members = Object.values(s.members);
  const dshAgg = aggregateDshUsage(members);
  const cu = latestSnapshot.coordinatorUsage;
  const agy = usageScope === 'swarm' ? cu?.sinceSwarmStart : cu?.sessionTotal;
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
  } catch (err) {
    console.error('Failed to push summary:', err);
  }
});

window.addEventListener('resize', () => updateTabInk());

// Must register handlers BEFORE connect()
app.ontoolinput = ({ arguments: args }) => {
  if (args && typeof args.swarm_id === 'string' && args.swarm_id) {
    currentSwarmId = args.swarm_id;
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

function showCommanderToast(message: string, isError = false): void {
  commanderToast.textContent = message;
  commanderToast.classList.toggle('is-error', isError);
  commanderToast.style.setProperty('--toast-dur', '4s');
  commanderToast.classList.remove('hidden', 'has-progress');
  void commanderToast.offsetWidth;
  commanderToast.classList.add('has-progress');
  if (commanderToastTimer !== null) window.clearTimeout(commanderToastTimer);
  commanderToastTimer = window.setTimeout(() => {
    commanderToast.classList.add('hidden');
  }, 4000);
}

function toggleCommanderPanel(next: 'create' | 'add' | 'arena' | 'templates' | null): void {
  activeCommanderPanel = activeCommanderPanel === next ? null : next;
  cmdPanelCreate.classList.toggle('hidden', activeCommanderPanel !== 'create');
  cmdPanelAdd.classList.toggle('hidden', activeCommanderPanel !== 'add');
  cmdPanelArena.classList.toggle('hidden', activeCommanderPanel !== 'arena');
  cmdPanelTemplates.classList.toggle('hidden', activeCommanderPanel !== 'templates');

  if (activeCommanderPanel === 'arena' && arenaSlots.length < 2) {
    const enabled = (
      latestSnapshot?.providerConfig?.providers ||
      latestProviderConfig?.providers ||
      []
    ).filter((p) => p.enabled);
    const preferred = enabled.filter((p) => p.available);
    const seed = preferred.length >= 2 ? preferred : enabled;
    arenaSlots = [
      { provider: seed[0]?.id || 'dsh', model: seed[0]?.defaultModel || '' },
      { provider: seed[1]?.id || seed[0]?.id || 'claude', model: seed[1]?.defaultModel || '' },
    ];
    renderArenaContestantRows();
  }
  if (activeCommanderPanel === 'templates') {
    if (!latestTemplatesConfig) {
      void fetchTemplatesFromServer();
    } else {
      renderTemplatePreview();
    }
  }
}

function getEnabledProvidersForUi(): ProviderDescriptor[] {
  return (
    latestSnapshot?.providerConfig?.providers ||
    latestProviderConfig?.providers ||
    []
  ).filter((p) => p.enabled);
}

function syncAddWorkerModelDatalist(): void {
  const enabled = getEnabledProvidersForUi();
  const targetIds =
    addProvidersDraft.size > 0
      ? [...addProvidersDraft]
      : latestSnapshot?.swarm?.activeProviders?.length
        ? latestSnapshot.swarm.activeProviders
        : [latestSnapshot?.swarm?.defaultProvider || 'dsh'];

  const modelSet = new Set<string>();
  let firstDefault = 'default';
  for (const pid of targetIds) {
    const prov = enabled.find((p) => p.id === pid);
    if (!prov) continue;
    if (firstDefault === 'default' && prov.defaultModel) {
      firstDefault = prov.defaultModel;
    }
    for (const m of prov.models || []) {
      modelSet.add(m);
    }
  }
  dlAddModels.innerHTML = '';
  for (const m of modelSet) {
    const opt = document.createElement('option');
    opt.value = m;
    dlAddModels.appendChild(opt);
  }
  if (!addWorkerModel.value.trim()) {
    addWorkerModel.placeholder = firstDefault;
  }
}

function renderArenaQuickPicks(): void {
  const enabled = getEnabledProvidersForUi();
  const checkedSet = new Set(arenaSlots.map((s) => s.provider));
  renderCliCheckboxGrid(arenaQuickPicks, enabled, checkedSet, (id, on) => {
    const prov = enabled.find((p) => p.id === id);
    if (on) {
      if (!arenaSlots.some((s) => s.provider === id)) {
        arenaSlots.push({ provider: id, model: prov?.defaultModel || '' });
      }
    } else {
      arenaSlots = arenaSlots.filter((s) => s.provider !== id);
    }
    renderArenaContestantRows();
  });
}

function renderArenaContestantRows(): void {
  const providers = getEnabledProvidersForUi();
  renderArenaQuickPicks();
  arenaContestants.innerHTML = '';
  arenaSlots.forEach((slot, idx) => {
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
      <input class="input input-sm mono-input" type="text" data-arena-model value="${escapeHtml(slot.model)}" placeholder="default" />
      <button type="button" class="btn btn-sm btn-ghost" data-arena-rm>×</button>
    `;
    const provSel = row.querySelector<HTMLSelectElement>('[data-arena-prov]')!;
    const modInp = row.querySelector<HTMLInputElement>('[data-arena-model]')!;
    provSel.addEventListener('change', () => {
      arenaSlots[idx].provider = provSel.value;
      renderArenaQuickPicks();
    });
    modInp.addEventListener('input', () => {
      arenaSlots[idx].model = modInp.value;
    });
    row.querySelector<HTMLButtonElement>('[data-arena-rm]')!.addEventListener('click', () => {
      arenaSlots.splice(idx, 1);
      renderArenaContestantRows();
    });
    arenaContestants.appendChild(row);
  });
}

function renderTemplatePreview(): void {
  const templates = latestTemplatesConfig?.templates || [];
  const selectedId = tplSelect.value || templates[0]?.id || '';
  const tpl = templates.find((t) => t.id === selectedId) || templates[0];
  if (!tpl) {
    tplDesc.textContent = '';
    tplRoleGrid.innerHTML = '';
    tplDeleteBtn.classList.add('hidden');
    return;
  }
  tplDesc.textContent = tpl.description || tpl.name;

  const enabled = getEnabledProvidersForUi();
  tplRoleGrid.innerHTML = '';
  for (const w of tpl.workers) {
    const key = `${tpl.id}:${w.name}`;
    const saved = tplRoleOverrides.get(key) || {
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

    row.innerHTML = `
      <div class="tpl-role-label-wrap" title="${escapeHtml(w.role)}">
        <span class="tpl-role-label">${escapeHtml(w.name)}</span>
        ${w.dependsOn && w.dependsOn.length > 0 ? `<span class="tpl-role-dep">← ${escapeHtml(w.dependsOn.join(','))}</span>` : ''}
      </div>
      <select class="input input-sm" data-tpl-role-prov>${provOpts}</select>
      <input class="input input-sm mono-input" type="text" data-tpl-role-model value="${escapeHtml(saved.model || '')}" placeholder="model (auto)" />
    `;
    const provSel = row.querySelector<HTMLSelectElement>('[data-tpl-role-prov]')!;
    const modInp = row.querySelector<HTMLInputElement>('[data-tpl-role-model]')!;
    const syncRole = () => {
      tplRoleOverrides.set(key, {
        provider: provSel.value.trim() || undefined,
        model: modInp.value.trim() || undefined,
      });
    };
    provSel.addEventListener('change', syncRole);
    modInp.addEventListener('input', syncRole);
    tplRoleGrid.appendChild(row);
  }

  tplDeleteBtn.classList.toggle('hidden', tpl.kind !== 'custom');
}

function syncCommanderControls(): void {
  const hasSwarm = Boolean(latestSnapshot?.swarm);
  cmdToggleAdd.disabled = !hasSwarm;
  cmdToggleArena.disabled = !hasSwarm;
  cmdToggleCreate.classList.toggle('btn-primary', !hasSwarm);
  cmdToggleCreate.classList.toggle('btn-ghost', hasSwarm);
  cmdToggleAdd.classList.toggle('btn-primary', hasSwarm);
  cmdToggleAdd.classList.toggle('btn-ghost', !hasSwarm);

  if (!hasSwarm && (activeCommanderPanel === 'add' || activeCommanderPanel === 'arena')) {
    toggleCommanderPanel(null);
  }

  const enabled = getEnabledProvidersForUi();
  const prevPrimary = createSwarmProvider.value;
  createSwarmProvider.innerHTML = '';
  for (const p of enabled) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.displayName} (${p.id})${p.available ? '' : ' [!]'}`;
    createSwarmProvider.appendChild(opt);
  }
  if (prevPrimary && enabled.some((p) => p.id === prevPrimary)) {
    createSwarmProvider.value = prevPrimary;
  } else if (latestSnapshot?.swarm?.defaultProvider) {
    createSwarmProvider.value = latestSnapshot.swarm.defaultProvider;
  } else if (latestSnapshot?.providerConfig?.effectiveDefaultProvider) {
    createSwarmProvider.value = latestSnapshot.providerConfig.effectiveDefaultProvider;
  }

  if (createPoolDraft === null) {
    const globalPool = latestSnapshot?.providerConfig?.activePool;
    createPoolDraft =
      globalPool && globalPool.length > 0
        ? [...globalPool]
        : enabled.filter((p) => p.available).map((p) => p.id);
    createSwarmFailover.checked = Boolean(
      latestSnapshot?.providerConfig?.routingPolicy?.autoFailover,
    );
  }
  const createPoolSet = new Set(createPoolDraft);
  renderCliCheckboxGrid(createSwarmPool, enabled, createPoolSet, (id, on) => {
    const cur = new Set(createPoolDraft || []);
    if (on) cur.add(id);
    else cur.delete(id);
    createPoolDraft = [...cur];
  });

  renderCliCheckboxGrid(addWorkerProviders, enabled, addProvidersDraft, (id, on) => {
    if (on) addProvidersDraft.add(id);
    else addProvidersDraft.delete(id);
    syncAddWorkerModelDatalist();
  });
  syncAddWorkerModelDatalist();

  const templates = latestTemplatesConfig?.templates || [];
  const prevTpl = tplSelect.value;
  tplSelect.innerHTML = '';
  for (const tItem of templates) {
    const opt = document.createElement('option');
    opt.value = tItem.id;
    opt.textContent = `${tItem.name} [${tItem.kind}]`;
    tplSelect.appendChild(opt);
  }
  if (prevTpl && templates.some((tItem) => tItem.id === prevTpl)) {
    tplSelect.value = prevTpl;
  }
  renderTemplatePreview();
  if (activeCommanderPanel === 'arena') {
    renderArenaContestantRows();
  }
}

async function fetchTemplatesFromServer(): Promise<void> {
  try {
    const res = await app.callServerTool({
      name: 'app_get_templates',
      arguments: {
        ...(currentSwarmId ? { swarm_id: currentSwarmId } : {}),
      },
    });
    const sc = res.structuredContent as { templatesConfig?: TemplatesConfigSnapshot } | undefined;
    if (sc?.templatesConfig) {
      latestTemplatesConfig = sc.templatesConfig;
      syncCommanderControls();
    }
  } catch (err) {
    showCommanderToast(err instanceof Error ? err.message : String(err), true);
  }
}

async function previewMergeFromUi(name: string): Promise<void> {
  mergePreviews.set(name, { loading: true });
  if (latestSnapshot?.swarm) {
    renderWorkers(Object.values(latestSnapshot.swarm.members || {}), latestSnapshot.diffs || {});
  }
  try {
    const res = await app.callServerTool({
      name: 'app_preview_merge',
      arguments: {
        ...(currentSwarmId ? { swarm_id: currentSwarmId } : {}),
        name,
      },
    });
    const sc = res.structuredContent as { preview?: MergePreviewResult } | undefined;
    mergePreviews.set(name, { loading: false, data: sc?.preview });
  } catch (err) {
    mergePreviews.set(name, {
      loading: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (latestSnapshot?.swarm) {
    renderWorkers(Object.values(latestSnapshot.swarm.members || {}), latestSnapshot.diffs || {});
  }
}

async function applyMergeFromUi(name: string): Promise<void> {
  const draft = mergeDrafts.get(name) || {
    mode: 'squash' as const,
    removeWt: true,
    commitMsg: '',
  };
  try {
    const res = await app.callServerTool({
      name: 'app_merge_worker',
      arguments: {
        ...(currentSwarmId ? { swarm_id: currentSwarmId } : {}),
        name,
        mode: draft.mode,
        remove_worktree: draft.removeWt,
        ...(draft.commitMsg.trim() ? { commit_message: draft.commitMsg.trim() } : {}),
      },
    });
    const sc = res.structuredContent as MergeApplyResult | undefined;
    if (res.isError || sc?.merged === false) {
      showCommanderToast(sc?.message || 'Merge blocked', true);
      void previewMergeFromUi(name);
    } else {
      mergeOpenWorker = null;
      mergePreviews.delete(name);
      mergeDrafts.delete(name);
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
        ...(currentSwarmId ? { swarm_id: currentSwarmId } : {}),
        target_worker: targetWorker,
      },
    });
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

cmdToggleCreate.addEventListener('click', () => toggleCommanderPanel('create'));
cmdToggleAdd.addEventListener('click', () => toggleCommanderPanel('add'));
cmdToggleArena.addEventListener('click', () => toggleCommanderPanel('arena'));
cmdToggleTemplates.addEventListener('click', () => toggleCommanderPanel('templates'));
cmdCreateCancel.addEventListener('click', () => toggleCommanderPanel(null));
cmdAddCancel.addEventListener('click', () => toggleCommanderPanel(null));
cmdArenaCancel.addEventListener('click', () => toggleCommanderPanel(null));
cmdTemplatesCancel.addEventListener('click', () => toggleCommanderPanel(null));

arenaAddRow.addEventListener('click', () => {
  const providers = getEnabledProvidersForUi();
  const next = providers[arenaSlots.length % Math.max(1, providers.length)];
  arenaSlots.push({ provider: next?.id || 'dsh', model: next?.defaultModel || '' });
  renderArenaContestantRows();
});

tplSelect.addEventListener('change', () => renderTemplatePreview());

tplToggleSave.addEventListener('click', () => {
  const hidden = tplSaveForm.classList.toggle('hidden');
  if (!hidden && !tplSaveWorkers.value.trim()) {
    tplSaveWorkers.value = JSON.stringify(
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

tplSaveCancel.addEventListener('click', () => {
  tplSaveForm.classList.add('hidden');
});

tplDeleteBtn.addEventListener('click', async () => {
  const id = tplSelect.value;
  if (!id) return;
  await withBusyButton(tplDeleteBtn, async () => {
    try {
      const res = await app.callServerTool({
        name: 'app_save_template',
        arguments: {
          ...(currentSwarmId ? { swarm_id: currentSwarmId } : {}),
          remove_template_id: id,
        },
      });
      const sc = res.structuredContent as { templatesConfig?: TemplatesConfigSnapshot } | undefined;
      if (sc?.templatesConfig) latestTemplatesConfig = sc.templatesConfig;
      syncCommanderControls();
      showCommanderToast(tr('cmd.toastTemplateDeleted', { id }));
    } catch (err) {
      showCommanderToast(err instanceof Error ? err.message : String(err), true);
    }
  });
});

cmdPanelCreate.addEventListener('submit', async (e) => {
  e.preventDefault();
  const repoRoot = createSwarmRepo.value.trim();
  if (!repoRoot) return;
  const submitBtn = cmdPanelCreate.querySelector<HTMLButtonElement>('button[type="submit"]');
  await withBusyButton(submitBtn, async () => {
    const activeProviders = (createPoolDraft || []).filter(Boolean);
    const autoFailover = createSwarmFailover.checked;
    const routingPolicy =
      latestSnapshot?.providerConfig?.routingPolicy || autoFailover
        ? {
            ...(latestSnapshot?.providerConfig?.routingPolicy?.writerProviders?.length
              ? { writer_providers: latestSnapshot.providerConfig.routingPolicy.writerProviders }
              : {}),
            ...(latestSnapshot?.providerConfig?.routingPolicy?.readerProviders?.length
              ? { reader_providers: latestSnapshot.providerConfig.routingPolicy.readerProviders }
              : {}),
            auto_failover: autoFailover,
          }
        : undefined;
    try {
      const res = await app.callServerTool({
        name: 'app_create_swarm',
        arguments: {
          repo_root: repoRoot,
          title: createSwarmTitle.value.trim() || undefined,
          default_provider: createSwarmProvider.value || undefined,
          ...(activeProviders.length > 0 ? { active_providers: activeProviders } : {}),
          ...(routingPolicy ? { routing_policy: routingPolicy } : {}),
        },
      });
      const sc = res.structuredContent as { swarm?: SwarmState } | undefined;
      if (sc?.swarm?.id) currentSwarmId = sc.swarm.id;
      createPoolDraft = null;
      toggleCommanderPanel(null);
      cmdPanelCreate.reset();
      showCommanderToast(tr('cmd.toastCreated', { title: sc?.swarm?.title || repoRoot }));
      await refreshSnapshot(true);
    } catch (err) {
      showCommanderToast(err instanceof Error ? err.message : String(err), true);
    }
  });
});

cmdPanelAdd.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = addWorkerName.value.trim();
  const brief = addWorkerBrief.value.trim();
  if (!name || !brief) return;
  const submitBtn = cmdPanelAdd.querySelector<HTMLButtonElement>('button[type="submit"]');
  await withBusyButton(submitBtn, async () => {
    const deps = addWorkerDeps.value
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const tasks = addWorkerTasks.value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const chosenProviders = [...addProvidersDraft];
    try {
      await app.callServerTool({
        name: 'app_add_worker',
        arguments: {
          ...(currentSwarmId ? { swarm_id: currentSwarmId } : {}),
          name,
          brief,
          role: addWorkerRole.value.trim() || undefined,
          ...(chosenProviders.length === 1
            ? { provider: chosenProviders[0] }
            : chosenProviders.length >= 2
              ? { providers: chosenProviders }
              : {}),
          model: addWorkerModel.value.trim() || undefined,
          permission_mode: addWorkerPerm.value,
          workspace: addWorkerWs.value,
          ...(tasks.length > 0 ? { tasks } : {}),
          ...(deps.length > 0 ? { depends_on: deps } : {}),
        },
      });
      addProvidersDraft.clear();
      syncCommanderControls();
      toggleCommanderPanel(null);
      cmdPanelAdd.reset();
      showCommanderToast(tr('cmd.toastAdded', { name }));
      await refreshSnapshot(true);
    } catch (err) {
      showCommanderToast(err instanceof Error ? err.message : String(err), true);
    }
  });
});

cmdPanelArena.addEventListener('submit', async (e) => {
  e.preventDefault();
  const task = arenaTask.value.trim();
  if (!task || arenaSlots.length < 2) {
    showCommanderToast(tr('cmd.arenaNeedTwo'), true);
    return;
  }
  const submitBtn = cmdPanelArena.querySelector<HTMLButtonElement>('button[type="submit"]');
  await withBusyButton(submitBtn, async () => {
    try {
      const res = await app.callServerTool({
        name: 'app_start_arena',
        arguments: {
          ...(currentSwarmId ? { swarm_id: currentSwarmId } : {}),
          task,
          base_name: arenaBaseName.value.trim() || undefined,
          permission: arenaPerm.value,
          contestants: arenaSlots.map((s) => ({
            provider: s.provider,
            ...(s.model.trim() ? { model: s.model.trim() } : {}),
          })),
        },
      });
      const sc = res.structuredContent as { arenaGroup?: string } | undefined;
      toggleCommanderPanel(null);
      arenaTask.value = '';
      showCommanderToast(tr('cmd.toastArena', { group: sc?.arenaGroup || 'arena' }));
      await refreshSnapshot(true);
    } catch (err) {
      showCommanderToast(err instanceof Error ? err.message : String(err), true);
    }
  });
});

tplApplyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const templateId = tplSelect.value;
  const goal = tplGoal.value.trim();
  if (!templateId || !goal) return;
  const submitBtn = tplApplyForm.querySelector<HTMLButtonElement>('button[type="submit"]');
  await withBusyButton(submitBtn, async () => {
    const tpl = latestTemplatesConfig?.templates?.find((t) => t.id === templateId);
    const providerOverrides: Record<string, string> = {};
    const modelOverrides: Record<string, string> = {};
    for (const w of tpl?.workers || []) {
      const ov = tplRoleOverrides.get(`${templateId}:${w.name}`);
      if (ov?.provider) providerOverrides[w.name] = ov.provider;
      if (ov?.model) modelOverrides[w.name] = ov.model;
    }
    try {
      const res = await app.callServerTool({
        name: 'app_apply_template',
        arguments: {
          ...(currentSwarmId ? { swarm_id: currentSwarmId } : {}),
          template_id: templateId,
          goal,
          repo_root: tplRepo.value.trim() || undefined,
          title: tplTitle.value.trim() || undefined,
          ...(Object.keys(providerOverrides).length > 0
            ? { provider_overrides: providerOverrides }
            : {}),
          ...(Object.keys(modelOverrides).length > 0 ? { model_overrides: modelOverrides } : {}),
        },
      });
      const sc = res.structuredContent as { swarmId?: string; added?: MemberState[]; template?: SwarmTemplate } | undefined;
      if (sc?.swarmId) currentSwarmId = sc.swarmId;
      toggleCommanderPanel(null);
      tplGoal.value = '';
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

tplSaveForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = tplSaveId.value.trim().toLowerCase();
  const name = tplSaveName.value.trim();
  if (!id || !name) return;
  const submitBtn = tplSaveForm.querySelector<HTMLButtonElement>('button[type="submit"]');
  await withBusyButton(submitBtn, async () => {
    try {
      const workers = JSON.parse(tplSaveWorkers.value);
      const res = await app.callServerTool({
        name: 'app_save_template',
        arguments: {
          ...(currentSwarmId ? { swarm_id: currentSwarmId } : {}),
          upsert_template: {
            id,
            name,
            description: tplSaveDesc.value.trim() || undefined,
            workers,
          },
        },
      });
      const sc = res.structuredContent as { templatesConfig?: TemplatesConfigSnapshot } | undefined;
      if (sc?.templatesConfig) latestTemplatesConfig = sc.templatesConfig;
      tplSaveForm.classList.add('hidden');
      syncCommanderControls();
      tplSelect.value = id;
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
    btnSendSummary.classList.remove('hidden');
  }
  await refreshSnapshot(true);
  window.setInterval(() => {
    void refreshSnapshot(false);
  }, 2500);
}

boot().catch((err) => {
  metaSummary.textContent = `UI error: ${err instanceof Error ? err.message : String(err)}`;
});
