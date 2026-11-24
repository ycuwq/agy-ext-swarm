/**
 * Pure, stateless UI helpers, HTML builders and toast utilities.
 *
 * Extracted verbatim from the former monolithic `ui/app.ts`; identifiers are
 * bound as follows:
 *   state  -> `store.ts`    (shared mutable UI state)
 *   dom    -> `dom.ts`      (typed DOM refs)
 * This keeps the module graph acyclic: views never import `app.ts`.
 */
import { type I18nKey } from './i18n.js';
import { tr } from './context.js';
import { state } from './store.js';
import * as dom from './dom.js';
import {
  calcInputCacheHit,
  calcMemberCostValue,
  escapeHtml,
  formatMoney,
  formatNum,
  formatTime as formatTimeLocale,
} from './format.js';
import type {
  BoardMessage,
  MemberState,
  ProviderDescriptor,
  ProviderTestResult,
  Snapshot,
  TaskModelTarget,
  TaskRoutingCategory,
  TaskRoutingMap,
  UsageBreakdown,
} from './types.js';

export const TASK_ROUTING_ORDER: TaskRoutingCategory[] = [
  'complex',
  'coding',
  'frontend',
  'review',
  'research',
  'batch',
];

export function setButtonLabel(btn: HTMLButtonElement | null | undefined, text: string): void {
  if (!btn) return;
  const labelEl = btn.querySelector<HTMLElement>('.btn-label');
  if (labelEl) {
    labelEl.textContent = text;
  } else {
    btn.textContent = text;
  }
}

export function getButtonLabel(btn: HTMLButtonElement | null | undefined): string {
  if (!btn) return '';
  const labelEl = btn.querySelector<HTMLElement>('.btn-label');
  return (labelEl ? labelEl.textContent : btn.textContent) ?? '';
}

export function setBadgeText(el: HTMLElement, next: string): void {
  const prev = el.textContent ?? '';
  if (prev === next) return;
  el.textContent = next;
  if (prev !== '' && prev !== '--') {
    el.classList.remove('badge-pop');
    void el.offsetWidth;
    el.classList.add('badge-pop');
  }
}

export function providerBadgeClass(provider?: string): string {
  const p = (provider || 'dsh').toLowerCase();
  if (p === 'claude' || p.startsWith('claude-')) return 'prov-claude';
  if (p === 'codex' || p.startsWith('codex-')) return 'prov-codex';
  if (p === 'gemini' || p.startsWith('gemini-')) return 'prov-gemini';
  if (p === 'dsh') return 'prov-dsh';
  return 'prov-custom';
}

export async function withBusyButton<T>(
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

export function showGlobalToast(message: string, isError = false, durationMs = 3600): void {
  dom.globalToastEl.textContent = message;
  dom.globalToastEl.classList.toggle('is-error', isError);
  dom.globalToastEl.style.setProperty('--toast-dur', `${(durationMs / 1000).toFixed(1)}s`);
  dom.globalToastEl.classList.remove('hidden', 'has-progress');
  void dom.globalToastEl.offsetWidth;
  dom.globalToastEl.classList.add('has-progress');
  if (state.globalToastTimer !== null) {
    window.clearTimeout(state.globalToastTimer);
  }
  state.globalToastTimer = window.setTimeout(() => {
    dom.globalToastEl.classList.add('hidden');
  }, durationMs);
}

export function extractToolErrorMessage(res: {
  isError?: boolean;
  content?: ReadonlyArray<unknown>;
}): string | null {
  if (!res.isError) return null;
  const text = (res.content || [])
    .map((c) =>
      c && typeof c === 'object' && 'text' in c && typeof (c as { text?: unknown }).text === 'string'
        ? (c as { text: string }).text
        : '',
    )
    .join(' ')
    .trim();
  return text || 'Operation failed';
}

export function cssEsc(s: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(s)
    : s.replace(/["\\]/g, '\\$&');
}

export function clearPendingKillState(): void {
  state.pendingKillAction = null;
  if (state.pendingKillTimer !== null) {
    window.clearTimeout(state.pendingKillTimer);
    state.pendingKillTimer = null;
  }
  state.pendingKillAll = false;
  if (state.pendingKillAllTimer !== null) {
    window.clearTimeout(state.pendingKillAllTimer);
    state.pendingKillAllTimer = null;
  }
}

export function resizeComposerInput(): void {
  dom.composerInput.style.height = 'auto';
  const maxH = 110;
  dom.composerInput.style.height = `${Math.min(maxH, Math.max(34, dom.composerInput.scrollHeight))}px`;
}

export function formatTime(iso: string): string {
  return formatTimeLocale(iso, state.currentLocale);
}

export function animateNumber(
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

export function statusLabel(status: MemberState['status']): string {
  return tr(`status.${status}` as I18nKey);
}

export function kindLabel(kind: string): string {
  const key = `kind.${kind}` as I18nKey;
  return kind in { brief: 1, done: 1, blocker: 1, warning: 1, error: 1, system: 1, message: 1 }
    ? tr(key)
    : kind;
}

export function computeBoardSignature(snap: Snapshot): string {
  const s = snap.swarm;
  if (!s) return `none:${state.currentLocale}:${state.onboardingVisible ? 1 : 0}`;
  const members = Object.values(s.members || {});
  const allNames = members.map((m) => m.name).join(',');
  const activeNames = members
    .filter((m) => m.status !== 'killed')
    .map((m) => m.name)
    .join(',');
  const lastMsgSeq = snap.messages.at(-1)?.seq || 0;
  return `${state.currentLocale}:${s.id}:${s.headSeq}:${snap.messages.length}:${lastMsgSeq}:${allNames}:${activeNames}:${state.selectedAgentFilter || ''}:${state.selectedKindFilter}:${dom.boardFilter.value.trim()}:${state.expandedSeqs.size}:${state.onboardingVisible ? 1 : 0}`;
}

export function computeSignature(snap: Snapshot): string {
  const s = snap.swarm;
  const cu = snap.coordinatorUsage;
  const cuSig = cu
    ? `${cu.conversationId || ''}:${cu.sessionTotal.totalTokens}:${cu.sessionTotal.cacheReadTokens}:${cu.sinceSwarmStart.totalTokens}:${cu.sinceSwarmStart.cacheReadTokens}:${Object.keys(cu.byModelSession || {}).length}:${Object.keys(cu.byModelSinceSwarm || {}).length}`
    : '';
  const convSig = (snap.availableConversations || []).map((c) => `${c.id}:${c.updatedAt}`).join(',');
  const localeSig = state.currentLocale;
  const pricingSig = Object.entries(snap.providerConfig?.pricing || {})
    .map(([m, p]) => `${m}:${p.inputPer1M}:${p.cacheReadPer1M || 0}:${p.outputPer1M}:${p.currency || 'USD'}`)
    .join(',');
  const tplSig = (snap.templatesConfig?.templates || []).map((t) => `${t.id}:${t.workers.length}`).join(',');
  const rp = snap.providerConfig?.routingPolicy;
  const taskRouteSig = rp?.taskRouting
    ? Object.entries(rp.taskRouting)
        .map(([k, list]) => `${k}=${(list || []).map((x) => `${x.provider}/${x.model || ''}`).join(',')}`)
        .join(';')
    : '';
  const provSig = (snap.providerConfig?.providers || [])
    .map(
      (p) =>
        `${p.id}:${p.enabled ? 1 : 0}:${p.available ? 1 : 0}:${p.defaultModel || ''}:${p.models.length}`,
    )
    .join(',');
  const timeoutSig = `${snap.providerConfig?.defaultTurnTimeoutSeconds ?? ''}:${snap.providerConfig?.defaultStallTimeoutSeconds ?? ''}`;
  const poolSig = `${(snap.providerConfig?.activePool || []).join(',')}:${(rp?.writerProviders || []).join(',')}:${(rp?.readerProviders || []).join(',')}:${rp?.autoFailover ? 1 : 0}:${rp?.delegationMode || ''}:${taskRouteSig}:${rp?.routingNotes || ''}:${timeoutSig}:${provSig}`;
  const onbSig = `${snap.uiPrefs?.onboardingCompleted ? 1 : 0}:${snap.providerConfig?.globalConfigExists ? 1 : 0}`;
  if (!s) {
    return `none:${localeSig}:${(snap.swarms || []).length}:${cuSig}:${convSig}:${pricingSig}:${tplSig}:${poolSig}:${onbSig}`;
  }
  const memberSig = Object.values(s.members || {})
    .map(
      (m) =>
        `${m.name}:${m.provider}:${m.model}:${m.status}:${m.turns}:${m.steps}:${m.usage?.totalTokens}:${m.usage?.cacheReadTokens}:${m.activity || ''}:${m.workspaceMode}:${m.branch || ''}:${m.lastTurnStartedAt || ''}:${m.lastTurnFinishedAt || ''}:${m.outOfScopeFiles?.length || 0}:${m.lastVerifyResults?.length || 0}:${m.dependsOn?.join(',') || ''}:${m.arenaGroup || ''}:${m.failedProviders?.join(',') || ''}`,
    )
    .join('|');
  const diffSig = snap.diffs
    ? Object.entries(snap.diffs)
        .map(([k, v]) => `${k}:${v?.commitCount || 0}:${v?.changedFiles?.length || 0}`)
        .join('|')
    : '';
  return `${localeSig}:${s.id}:${s.headSeq}:${s.hopCount}:${s.maxConcurrency}:${s.turnTimeoutSeconds}:${s.stallTimeoutSeconds}:${(s.activeProviders || []).join(',')}:${s.coordinatorConversationId || ''}:${snap.messages.length}:${memberSig}:${diffSig}:${cuSig}:${convSig}:${pricingSig}:${tplSig}:${poolSig}:${onbSig}`;
}

export function aggregateDshUsage(members: MemberState[]): UsageBreakdown {
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

export function splitDshUiModel(
  rawModel: string,
  p?: ProviderDescriptor,
): { group: string | null; shortModel: string } {
  const trimmed = rawModel.trim();
  if (!trimmed) return { group: null, shortModel: '' };
  const slash = trimmed.indexOf('/');
  if (slash > 0 && slash < trimmed.length - 1) {
    const prefix = trimmed.slice(0, slash).trim();
    const rest = trimmed.slice(slash + 1).trim();
    const known = new Set<string>(['deepseek-official']);
    for (const mp of p?.detectedModelProviders || []) {
      if (mp.trim()) known.add(mp.trim());
    }
    if (p?.modelProvider?.trim()) known.add(p.modelProvider.trim());
    if (p?.detectedModelProvider?.trim()) known.add(p.detectedModelProvider.trim());
    const hasKnown = Boolean(
      p?.detectedModelProviders?.length ||
        p?.modelProvider?.trim() ||
        p?.detectedModelProvider?.trim(),
    );
    if (known.has(prefix) || rest.includes('/') || !hasKnown) {
      return { group: prefix, shortModel: rest };
    }
  }
  const fb = p?.modelProvider?.trim() || p?.detectedModelProvider?.trim() || null;
  return { group: fb, shortModel: trimmed };
}

export function groupDshModelsForUi(
  candidates: string[],
  p?: ProviderDescriptor,
): {
  hasNamedGroups: boolean;
  groups: Array<{
    group: string | null;
    label: string;
    items: Array<{ full: string; short: string }>;
  }>;
} {
  const buckets = new Map<string | null, Array<{ full: string; short: string }>>();
  for (const full of candidates) {
    const { group, shortModel } = splitDshUiModel(full, p);
    const arr = buckets.get(group) || [];
    arr.push({ full, short: shortModel });
    buckets.set(group, arr);
  }

  const orderedKeys: Array<string | null> = [];
  for (const mp of p?.detectedModelProviders || []) {
    const clean = mp.trim();
    if (clean && buckets.has(clean) && !orderedKeys.includes(clean)) {
      orderedKeys.push(clean);
    }
  }
  for (const k of buckets.keys()) {
    if (k !== null && !orderedKeys.includes(k)) orderedKeys.push(k);
  }
  if (buckets.has(null)) orderedKeys.push(null);

  const hasNamedGroups = orderedKeys.some((k) => k !== null);
  return {
    hasNamedGroups,
    groups: orderedKeys.map((k) => ({
      group: k,
      label: k || tr('settings.modelGroupOther'),
      items: buckets.get(k) || [],
    })),
  };
}

export function renderModelChecklistItemsHtml(opts: {
  providerId: string;
  providerDesc?: ProviderDescriptor;
  candidates: string[];
  checkedSet: Set<string>;
  defaultModel: string;
  filter?: string;
  checkAttr: string;
  starAttr: string;
  groupSelectAttr?: string;
  groupClearAttr?: string;
}): { html: string; grouped: boolean } {
  const needle = (opts.filter || '').trim().toLowerCase();
  const visible = needle
    ? opts.candidates.filter((m) => m.toLowerCase().includes(needle))
    : opts.candidates;
  if (visible.length === 0) {
    return {
      html: `<span class="empty-hint" style="font-size:11px;color:var(--text-3)">${escapeHtml(tr('settings.noDetectedModelsHint'))}</span>`,
      grouped: false,
    };
  }
  const starTitle = escapeHtml(tr('settings.setDefaultModel'));
  const renderItemHtml = (full: string, display: string): string => {
    const checked = opts.checkedSet.has(full);
    let isDef = Boolean(opts.defaultModel) && full === opts.defaultModel;
    if (!isDef && opts.defaultModel && opts.providerId === 'dsh' && opts.providerDesc) {
      const a = splitDshUiModel(full, opts.providerDesc);
      const b = splitDshUiModel(opts.defaultModel, opts.providerDesc);
      isDef = a.shortModel === b.shortModel && (a.group || '') === (b.group || '');
    }
    return `
      <div class="model-check-item${checked ? ' is-checked' : ''}${isDef ? ' is-default' : ''}">
        <label class="model-check-label" title="${escapeHtml(full)}">
          <input type="checkbox" ${opts.checkAttr}="${escapeHtml(opts.providerId)}" value="${escapeHtml(full)}" ${checked ? 'checked' : ''} />
          <code>${escapeHtml(display)}</code>
        </label>
        <button type="button" class="model-star-btn${isDef ? ' is-active' : ''}" ${opts.starAttr}="${escapeHtml(opts.providerId)}" data-model="${escapeHtml(full)}" title="${starTitle}" aria-label="${starTitle}">★</button>
      </div>`;
  };

  if (opts.providerId === 'dsh' && opts.providerDesc) {
    const grouped = groupDshModelsForUi(visible, opts.providerDesc);
    if (grouped.hasNamedGroups) {
      const groupsHtml = grouped.groups
        .map((g) => {
          const groupChecked = g.items.filter((it) => opts.checkedSet.has(it.full)).length;
          const actionsHtml =
            opts.groupSelectAttr && opts.groupClearAttr
              ? `<div class="model-provider-group-actions">
                  <button type="button" class="btn-link-xs" ${opts.groupSelectAttr}="${escapeHtml(opts.providerId)}">${escapeHtml(tr('settings.selectAllModels'))}</button>
                  <button type="button" class="btn-link-xs" ${opts.groupClearAttr}="${escapeHtml(opts.providerId)}">${escapeHtml(tr('settings.clearModels'))}</button>
                </div>`
              : '';
          return `
            <div class="model-provider-group" data-mp-group="${escapeHtml(g.group || '')}">
              <div class="model-provider-group-head">
                <div class="model-provider-group-title">
                  <span class="model-provider-group-badge">${escapeHtml(g.label)}</span>
                  <span class="model-provider-group-count">${groupChecked}/${g.items.length}</span>
                </div>
                ${actionsHtml}
              </div>
              <div class="model-provider-group-items">
                ${g.items.map((it) => renderItemHtml(it.full, it.short)).join('')}
              </div>
            </div>`;
        })
        .join('');
      return { html: groupsHtml, grouped: true };
    }
  }

  return {
    html: visible.map((m) => renderItemHtml(m, m)).join(''),
    grouped: false,
  };
}

export function renderProviderStatusBannerHtml(
  p: ProviderDescriptor,
  testRes: ProviderTestResult | undefined,
): string {
  if (testRes) {
    const stateCls = !testRes.ok ? 'is-fail' : testRes.warnings?.length ? 'is-warn' : 'is-ok';
    const label = testRes.ok
      ? tr('settings.testPassed', { ms: testRes.latencyMs })
      : tr('settings.testFailed', { ms: testRes.latencyMs });
    return `
      <div class="provider-test-result ${stateCls}">
        <strong>${escapeHtml(label)}</strong>
        <span class="provider-test-meta">${escapeHtml(testRes.details)}</span>
        ${testRes.warnings?.length ? testRes.warnings.map((w) => `<div class="provider-test-warning">${escapeHtml(w)}</div>`).join('') : ''}
      </div>`;
  }
  if (p.warnings?.length) {
    return `
      <div class="provider-warning-banner">
        ${p.warnings.map((w) => `<div class="provider-warning-item">${escapeHtml(w)}</div>`).join('')}
      </div>`;
  }
  return '';
}

export function isEditingInsideWorkersList(): boolean {
  const ae = document.activeElement as HTMLElement | null;
  if (!ae || !dom.workersList.contains(ae)) return false;
  return ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT';
}

export function formatRouteText(msg: BoardMessage): string {
  if (msg.all) return '→ @all';
  const targets = [...msg.mentions];
  if (msg.mentionsCoordinator && msg.agent !== 'coordinator') {
    targets.push('coordinator');
  }
  if (targets.length === 0) return '';
  return `→ ${targets.map((tName) => `@${tName}`).join(' ')}`;
}

export function buildGaugeCardHtml(opts: {
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

export function buildPersistConfigFromDescriptor(
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
    const prof = p.id === 'dsh' ? p.configuredProfile : p.profile;
    if (prof) cfg.profile = prof;
    if (p.modelProvider) cfg.modelProvider = p.modelProvider;
    if (p.args) cfg.args = p.args;
    if (p.resumeArgs) cfg.resumeArgs = p.resumeArgs;
    if (p.listModelsArgs) cfg.listModelsArgs = p.listModelsArgs;
    if (p.promptMode) cfg.promptMode = p.promptMode;
    if (p.outputFormat) cfg.outputFormat = p.outputFormat;
    if (p.env) cfg.env = p.env;
  }
  return cfg;
}

export function renderCliCheckboxGrid(
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

export function parseOptionalTimeoutInput(rawVal: string, max: number): number | null | 'invalid' {
  const trimmed = rawVal.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return 'invalid';
  const num = Number(trimmed);
  if (!Number.isSafeInteger(num) || num < 0 || num > max) return 'invalid';
  return num;
}

export function formatTimeoutBadgeValue(sec: number): string {
  return sec === 0 ? 'off' : `${sec}s`;
}

export function getSelectableModelsForProvider(p: ProviderDescriptor): string[] {
  const configured = Array.from(
    new Set((p.configuredModels || []).map((m) => m.trim()).filter(Boolean)),
  );
  if (configured.length > 0) return configured;

  const effectiveModels = Array.from(
    new Set(
      (p.models || [])
        .map((m) => m.trim())
        .filter((m) => Boolean(m) && m !== 'default'),
    ),
  );
  if (effectiveModels.length > 0) return effectiveModels;

  const detected = Array.from(
    new Set((p.detectedModels || []).map((m) => m.trim()).filter(Boolean)),
  );
  if (detected.length > 0) return detected;

  return p.defaultModel && p.defaultModel !== 'default' ? [p.defaultModel] : [];
}

export function serializeTaskRoutingMap(
  taskMap: TaskRoutingMap | undefined,
): Record<string, TaskModelTarget[]> | undefined {
  if (!taskMap) return undefined;
  const out: Record<string, TaskModelTarget[]> = {};
  for (const cat of TASK_ROUTING_ORDER) {
    const list = taskMap[cat];
    if (!list || list.length === 0) continue;
    out[cat] = list.map((t) => ({
      provider: t.provider,
      ...(t.model?.trim() ? { model: t.model.trim() } : {}),
    }));
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function showCommanderToast(message: string, isError = false): void {
  showGlobalToast(message, isError, 4000);
}

export { buildTakeoverCommand } from '../shared/takeover.js';

export function renderSwarmBudgetBanner(
  container: HTMLElement,
  snap: Snapshot | null,
  onUpdateBudget: (opts: { maxCostUsd?: number | null; resume?: boolean }) => Promise<void>,
): void {
  const swarm = snap?.swarm;
  if (!swarm || (!swarm.maxCostUsd && !swarm.budgetPaused)) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }
  const providerCfg = snap?.providerConfig || state.latestProviderConfig;
  const members = Object.values(swarm.members || {});
  let spentUsd = 0;
  for (const m of members) {
    const c = calcMemberCostValue(
      m,
      providerCfg?.pricing,
      providerCfg?.pricingCatalog,
      { displayCurrency: 'USD', usdToCnyRate: providerCfg?.usdToCnyRate },
    );
    if (c) spentUsd += c.amount;
  }
  const cap = swarm.maxCostUsd ?? 0;
  const pct = cap > 0 ? Math.min(100, Math.round((spentUsd / cap) * 1000) / 10) : 100;
  const nextRaiseCap =
    cap > 0 ? Math.max(Math.round(cap * 1.5 * 100) / 100, Math.ceil(spentUsd * 1.5 * 100) / 100) : 0;
  container.classList.remove('hidden');
  container.classList.toggle('is-paused', Boolean(swarm.budgetPaused));
  container.innerHTML = `
    <div class="budget-banner-main">
      <div class="budget-banner-text">
        <strong>${escapeHtml(tr(swarm.budgetPaused ? 'budget.pausedTitle' : 'budget.activeTitle'))}</strong>
        <span>${escapeHtml(
          cap > 0
            ? tr('budget.progressText', {
                spent: formatMoney(spentUsd, 'USD'),
                cap: formatMoney(cap, 'USD'),
                pct,
              })
            : swarm.budgetPausedReason || '',
        )}</span>
      </div>
      <div class="budget-banner-actions">
        ${swarm.budgetPaused ? `<button type="button" class="btn btn-sm btn-primary" data-budget-resume>${escapeHtml(tr('budget.resumeBtn'))}</button>` : ''}
        ${cap > 0 ? `<button type="button" class="btn btn-sm btn-ghost" data-budget-raise>${escapeHtml(tr('budget.raiseBtn', { next: formatMoney(nextRaiseCap, 'USD') }))}</button>` : ''}
        <button type="button" class="btn btn-sm btn-ghost" data-budget-clear>${escapeHtml(tr('budget.clearBtn'))}</button>
      </div>
    </div>
    ${cap > 0 ? `<div class="budget-progress-track"><div class="budget-progress-fill${pct >= 100 ? ' is-full' : ''}" style="width:${pct}%"></div></div>` : ''}
  `;
  container.querySelector<HTMLButtonElement>('[data-budget-resume]')?.addEventListener('click', (e) => {
    void withBusyButton(e.currentTarget as HTMLButtonElement, () =>
      onUpdateBudget({ resume: true }),
    );
  });
  container.querySelector<HTMLButtonElement>('[data-budget-raise]')?.addEventListener('click', (e) => {
    void withBusyButton(e.currentTarget as HTMLButtonElement, () =>
      onUpdateBudget({ maxCostUsd: nextRaiseCap, resume: true }),
    );
  });
  container.querySelector<HTMLButtonElement>('[data-budget-clear]')?.addEventListener('click', (e) => {
    void withBusyButton(e.currentTarget as HTMLButtonElement, () =>
      onUpdateBudget({ maxCostUsd: null, resume: true }),
    );
  });
}
