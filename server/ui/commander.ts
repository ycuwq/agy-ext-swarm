/**
 * Commander bar: create/add/arena/templates panels, merge preview/apply,
 * cross-review actions and their event bindings.
 *
 * Extracted verbatim from the former monolithic `ui/app.ts`; identifiers are
 * bound as follows:
 *   state  -> `store.ts`    (shared mutable UI state)
 *   dom    -> `dom.ts`      (typed DOM refs)
 *   bridge -> `bridge.ts`   (callbacks still owned by the entrypoint)
 * This keeps the module graph acyclic: views never import `app.ts`.
 */
import {
  armDoubleClickConfirm,
  boolToFastDraft,
  buildFastModeOptionsHtml,
  buildReasoningEffortOptionsHtml,
  clearPendingKillState,
  cycleFastDraftMode,
  extractToolErrorMessage,
  fastDraftToBool,
  isEditingInsideWorkersList,
  parseFastDraftMode,
  parseOptionalTimeoutInput,
  renderCliCheckboxGrid,
  renderFastTogglePillHtml,
  sanitizeReasoningEffort,
  serializeTaskRoutingMap,
  showCommanderToast,
  showGlobalToast,
  syncEffortSelect,
  updateFastTogglePill,
  withBusyButton,
} from './helpers.js';
import { tr } from './context.js';
import {
  getAddWorkerTargetIds,
  getModelOptionsForUi,
  normalizeModelInput,
  resetModelOptions,
} from './model-options-ui.js';
import { state } from './store.js';
import * as dom from './dom.js';
import { escapeHtml, splitModelList } from './format.js';
import {
  DEFAULT_STALL_TIMEOUT_SECONDS,
  DEFAULT_TURN_TIMEOUT_SECONDS,
  MAX_STALL_TIMEOUT_SECONDS,
  MAX_TURN_TIMEOUT_SECONDS,
  type CreatePrResult,
  type MemberState,
  type MergeApplyResult,
  type MergePreviewResult,
  type SwarmState,
  type SwarmTemplate,
  type TemplatesConfigSnapshot,
} from './types.js';
import { app } from './mcp-app.js';
import { getEnabledProvidersForUi, syncAddWorkerModelDatalist, syncProviderModelDatalists } from './settings-view.js';
import { renderWorkers } from './workers-view.js';
import * as bridge from './bridge.js';
import type { CommanderPanel } from './bridge.js';

export function toggleCommanderPanel(next: CommanderPanel): void {
  state.activeCommanderPanel = state.activeCommanderPanel === next ? null : next;
  dom.cmdPanelCreate.classList.toggle('hidden', state.activeCommanderPanel !== 'create');
  dom.cmdPanelAdd.classList.toggle('hidden', state.activeCommanderPanel !== 'add');
  dom.cmdPanelArena.classList.toggle('hidden', state.activeCommanderPanel !== 'arena');
  dom.cmdPanelTemplates.classList.toggle('hidden', state.activeCommanderPanel !== 'templates');
  dom.cmdToggleCreate.setAttribute('aria-expanded', String(state.activeCommanderPanel === 'create'));
  dom.cmdToggleAdd.setAttribute('aria-expanded', String(state.activeCommanderPanel === 'add'));
  dom.cmdToggleArena.setAttribute('aria-expanded', String(state.activeCommanderPanel === 'arena'));
  dom.cmdToggleTemplates.setAttribute('aria-expanded', String(state.activeCommanderPanel === 'templates'));

  const fallbackRepo =
    state.latestSnapshot?.swarm?.repoRoot || state.latestSnapshot?.swarms?.at(-1)?.repoRoot || '';
  if (state.activeCommanderPanel === 'create' && !dom.createSwarmRepo.value.trim() && fallbackRepo) {
    dom.createSwarmRepo.value = fallbackRepo;
  }
  if (state.activeCommanderPanel === 'arena' && state.arenaSlots.length < 2) {
    const enabled = getEnabledProvidersForUi();
    const preferred = enabled.filter((p) => p.available);
    const seed = preferred.length >= 2 ? preferred : enabled;
    state.arenaSlots = [
      { provider: seed[0]?.id || 'dsh', model: '' },
      { provider: seed[1]?.id || seed[0]?.id || 'claude', model: '' },
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

export function renderArenaQuickPicks(): void {
  const enabled = getEnabledProvidersForUi();
  const checkedSet = new Set(state.arenaSlots.map((s) => s.provider));
  renderCliCheckboxGrid(dom.arenaQuickPicks, enabled, checkedSet, (id, on) => {
    if (on) {
      if (!state.arenaSlots.some((s) => s.provider === id)) {
        state.arenaSlots.push({ provider: id, model: '' });
      }
    } else {
      state.arenaSlots = state.arenaSlots.filter((s) => s.provider !== id);
    }
    renderArenaContestantRows();
  });
}

export function renderArenaContestantRows(): void {
  const providers = getEnabledProvidersForUi();
  const allProviders = (state.latestProviderConfig || state.latestSnapshot?.providerConfig)?.providers || providers;
  renderArenaQuickPicks();
  dom.arenaContestants.innerHTML = '';
  state.arenaSlots.forEach((slot, idx) => {
    const row = document.createElement('div');
    row.className = 'arena-contestant-row';
    const slotProvider = allProviders.find((p) => p.id === slot.provider);
    const getOptions = (model: string) => getModelOptionsForUi(slot.provider, model, slotProvider);
    const model = normalizeModelInput(slot.model);
    const optionState = getOptions(model);
    const options = [
      ...(!providers.some((p) => p.id === slot.provider)
        ? [`<option value="${escapeHtml(slot.provider)}" selected>${escapeHtml(slotProvider?.displayName || slot.provider)}</option>`]
        : []),
      ...providers.map((p) =>
        `<option value="${escapeHtml(p.id)}" ${p.id === slot.provider ? 'selected' : ''}>${escapeHtml(p.displayName)} (${escapeHtml(p.id)})</option>`,
      ),
    ].join('');
    row.innerHTML = `
      <select class="input input-sm" data-arena-prov aria-label="${escapeHtml(tr('workers.switchProvider'))}">${options}</select>
      <input class="input input-sm mono-input" type="text" list="dl-prov-models-${escapeHtml(slot.provider)}" data-arena-model value="${escapeHtml(model)}" placeholder="${escapeHtml(tr('cmd.modelAutoPlaceholder'))}" aria-label="${escapeHtml(tr('workers.model'))}" />
      <select class="input input-sm${optionState.supportsEffort ? '' : ' hidden'}" data-arena-effort aria-label="${escapeHtml(tr('cmd.workerEffortLabel'))}">${buildReasoningEffortOptionsHtml({
        efforts: optionState.efforts,
        value: slot.reasoningEffort,
        emptyLabel: optionState.effortLabel,
      })}</select>
      ${renderFastTogglePillHtml(fastDraftToBool(slot.fastMode), 'data-arena-fast' + (optionState.supportsFast ? '' : ' hidden'), optionState.fastLabel)}
      <button type="button" class="btn btn-sm btn-ghost" data-arena-rm aria-label="${escapeHtml(tr('arena.removeContestant'))}">×</button>
    `;
    const provSel = row.querySelector<HTMLSelectElement>('[data-arena-prov]')!;
    const modInp = row.querySelector<HTMLInputElement>('[data-arena-model]')!;
    const effSel = row.querySelector<HTMLSelectElement>('[data-arena-effort]')!;
    const fastBtn = row.querySelector<HTMLButtonElement>('[data-arena-fast]')!;
    provSel.addEventListener('change', () => {
      Object.assign(slot, resetModelOptions(), { provider: provSel.value });
      renderArenaContestantRows();
      dom.arenaContestants.querySelectorAll<HTMLSelectElement>('[data-arena-prov]')[idx]?.focus();
    });
    modInp.addEventListener('input', () => {
      slot.model = modInp.value;
      const options = getOptions(slot.model);
      slot.reasoningEffort = syncEffortSelect({
        select: effSel,
        efforts: options.efforts,
        emptyLabel: options.effortLabel,
      });
      effSel.classList.toggle('hidden', !options.supportsEffort);
      fastBtn.hidden = !options.supportsFast;
      if (!options.supportsFast) slot.fastMode = 'default';
      updateFastTogglePill(fastBtn, fastDraftToBool(slot.fastMode), options.fastLabel);
    });
    effSel.addEventListener('change', () => {
      slot.reasoningEffort = sanitizeReasoningEffort(effSel.value) || '';
    });
    fastBtn.addEventListener('click', () => {
      slot.fastMode = cycleFastDraftMode(slot.fastMode);
      updateFastTogglePill(fastBtn, fastDraftToBool(slot.fastMode), getOptions(slot.model).fastLabel);
    });
    row.querySelector<HTMLButtonElement>('[data-arena-rm]')!.addEventListener('click', () => {
      state.arenaSlots.splice(idx, 1);
      renderArenaContestantRows();
    });
    dom.arenaContestants.appendChild(row);
  });
}

export function renderTemplatePreview(): void {
  const hasSwarm = Boolean(state.latestSnapshot?.swarm);
  dom.tplRepo.closest('label')?.classList.toggle('hidden', hasSwarm);
  dom.tplTitle.closest('label')?.classList.toggle('hidden', hasSwarm);
  dom.tplTitle.hidden = hasSwarm;
  dom.tplRepo.required = !hasSwarm;

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
  const cfg = state.latestProviderConfig || state.latestSnapshot?.providerConfig;
  const allProviders = cfg?.providers || enabled;
  dom.tplRoleGrid.innerHTML = '';
  for (const [idx, w] of tpl.workers.entries()) {
    const key = `${tpl.id}:${w.name}`;
    const saved = state.tplRoleOverrides.get(key) ?? {
      provider: w.provider || '',
      model: w.model || '',
      reasoningEffort: w.reasoningEffort || '',
      fastMode: boolToFastDraft(w.fastMode),
    };
    const row = document.createElement('div');
    row.className = 'tpl-role-row';
    const selectedProvider = saved.provider || '';
    const model = normalizeModelInput(saved.model);
    const provOpts = [
      `<option value="">${escapeHtml(tr('cmd.tplRoleAuto'))}</option>`,
      ...(selectedProvider && !enabled.some((p) => p.id === selectedProvider)
        ? [`<option value="${escapeHtml(selectedProvider)}" selected>${escapeHtml(selectedProvider)}</option>`]
        : []),
      ...enabled.map((p) =>
        `<option value="${escapeHtml(p.id)}" ${p.id === selectedProvider ? 'selected' : ''}>${escapeHtml(p.displayName)} (${escapeHtml(p.id)})</option>`,
      ),
    ].join('');

    const effectiveProvider = selectedProvider || state.latestSnapshot?.swarm?.defaultProvider || cfg?.effectiveDefaultProvider || '';
    const roleProvider = allProviders.find((p) => p.id === effectiveProvider);
    const getOptions = (rawModel: string) => getModelOptionsForUi(effectiveProvider, rawModel, roleProvider);
    const optionState = getOptions(model);
    row.innerHTML = `
      <div class="tpl-role-label-wrap" title="${escapeHtml(w.role)}">
        <span class="tpl-role-label">${escapeHtml(w.name)}</span>
        ${w.dependsOn?.length ? `<span class="tpl-role-dep">← ${escapeHtml(w.dependsOn.join(','))}</span>` : ''}
      </div>
      <select class="input input-sm" data-tpl-role-prov aria-label="${escapeHtml(tr('workers.switchProvider'))}">${provOpts}</select>
      <input class="input input-sm mono-input" type="text" list="dl-prov-models-${escapeHtml(effectiveProvider)}" data-tpl-role-model value="${escapeHtml(model)}" placeholder="${escapeHtml(tr('cmd.modelAutoPlaceholder'))}" aria-label="${escapeHtml(tr('workers.model'))}" />
      <select class="input input-sm${optionState.supportsEffort ? '' : ' hidden'}" data-tpl-role-effort aria-label="${escapeHtml(tr('cmd.workerEffortLabel'))}">${buildReasoningEffortOptionsHtml({
        efforts: optionState.efforts,
        value: saved.reasoningEffort,
        emptyLabel: optionState.effortLabel,
      })}</select>
      ${renderFastTogglePillHtml(fastDraftToBool(saved.fastMode), 'data-tpl-role-fast' + (optionState.supportsFast ? '' : ' hidden'), optionState.fastLabel)}
    `;
    const provSel = row.querySelector<HTMLSelectElement>('[data-tpl-role-prov]')!;
    const modInp = row.querySelector<HTMLInputElement>('[data-tpl-role-model]')!;
    const effSel = row.querySelector<HTMLSelectElement>('[data-tpl-role-effort]')!;
    const fastBtn = row.querySelector<HTMLButtonElement>('[data-tpl-role-fast]')!;
    let fastMode = saved.fastMode || 'default';
    const saveRole = () => state.tplRoleOverrides.set(key, {
      provider: provSel.value,
      model: normalizeModelInput(modInp.value),
      reasoningEffort: sanitizeReasoningEffort(effSel.value),
      fastMode,
    });
    provSel.addEventListener('change', () => {
      state.tplRoleOverrides.set(key, { ...resetModelOptions(), provider: provSel.value });
      renderTemplatePreview();
      dom.tplRoleGrid.querySelectorAll<HTMLSelectElement>('[data-tpl-role-prov]')[idx]?.focus();
    });
    modInp.addEventListener('input', () => {
      const options = getOptions(modInp.value);
      syncEffortSelect({ select: effSel, efforts: options.efforts, emptyLabel: options.effortLabel });
      effSel.classList.toggle('hidden', !options.supportsEffort);
      fastBtn.hidden = !options.supportsFast;
      if (!options.supportsFast) fastMode = 'default';
      updateFastTogglePill(fastBtn, fastDraftToBool(fastMode), options.fastLabel);
      saveRole();
    });
    effSel.addEventListener('change', saveRole);
    fastBtn.addEventListener('click', () => {
      fastMode = cycleFastDraftMode(fastMode);
      saveRole();
      updateFastTogglePill(fastBtn, fastDraftToBool(fastMode), getOptions(modInp.value).fastLabel);
    });
    dom.tplRoleGrid.appendChild(row);
  }

  dom.tplDeleteBtn.classList.toggle('hidden', tpl.kind !== 'custom');
}

export function isEditingInsideCommanderPanels(): boolean {
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

export function computeCommanderConfigSignature(): string {
  const cfg = state.latestProviderConfig || state.latestSnapshot?.providerConfig;
  const swarm = state.latestSnapshot?.swarm;
  return JSON.stringify([
    state.currentLocale,
    swarm?.id,
    swarm?.repoRoot,
    swarm?.defaultProvider,
    swarm?.activeProviders,
    cfg?.effectiveDefaultProvider,
    state.latestSnapshot?.swarms?.map((s) => s.repoRoot),
    cfg?.activePool,
    cfg?.routingPolicy?.autoFailover,
    cfg?.defaultTurnTimeoutSeconds,
    cfg?.defaultStallTimeoutSeconds,
    cfg?.providers.map((p) => [
      p.id, p.displayName, p.enabled, p.available, p.defaultModel, p.defaultReasoningEffort, p.defaultFastMode,
      p.supportsReasoningEffort, p.supportsFastMode, p.reasoningEffortOptions, p.modelCapabilities,
      p.detectedDefaultModel, p.detectedDefaultReasoningEffort, p.detectedDefaultFastMode,
      p.configuredDefaultModel, p.configuredDefaultReasoningEffort, p.configuredDefaultFastMode,
      p.modelProvider, p.detectedModelProvider, p.detectedModelProviders, p.models, p.configuredModels,
      p.detectedModels, p.args, p.resumeArgs, p.warnings,
    ]),
    state.latestTemplatesConfig?.templates,
  ]);
}

function getAddWorkerTargetDescriptors() {
  const cfg = state.latestProviderConfig || state.latestSnapshot?.providerConfig;
  const targetIds = getAddWorkerTargetIds(state.addProvidersDraft, state.latestSnapshot, cfg?.effectiveDefaultProvider);
  return (cfg?.providers || []).filter((p) => targetIds.includes(p.id));
}

export function syncAddWorkerModelOptions(): void {
  const options = getAddWorkerTargetDescriptors().map((p) => getModelOptionsForUi(p.id, dom.addWorkerModel.value, p));
  const supportsEffort = options.some((option) => option.supportsEffort);
  const supportsFast = options.some((option) => option.supportsFast);
  const singleTarget = options.length === 1 ? options[0] : undefined;

  dom.addWorkerEffortField.hidden = !supportsEffort;
  if (supportsEffort) {
    syncEffortSelect({
      select: dom.addWorkerEffort,
      efforts: [...new Set(options.flatMap((option) => option.efforts))],
      value: dom.addWorkerEffort.value,
      emptyLabel: singleTarget?.effortLabel || tr('cmd.followDefault'),
    });
  } else {
    dom.addWorkerEffort.replaceChildren();
  }

  dom.addWorkerFastField.hidden = !supportsFast;
  if (supportsFast) {
    dom.addWorkerFast.innerHTML = buildFastModeOptionsHtml({
      value: parseFastDraftMode(dom.addWorkerFast.value),
      emptyLabel: singleTarget?.fastLabel || tr('cmd.followDefault'),
    });
  } else {
    dom.addWorkerFast.replaceChildren();
  }
}

export function syncCommanderControls(force = false): void {
  const hasSwarm = Boolean(state.latestSnapshot?.swarm);
  const cfg = state.latestProviderConfig || state.latestSnapshot?.providerConfig;
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
  if (state.commanderPointerDown || (!force && isEditingInsideCommanderPanels())) {
    state.commanderDeferredSync = true;
    return;
  }
  state.commanderDeferredSync = false;
  state.lastCommanderConfigSignature = cfgSig;

  syncProviderModelDatalists();
  dom.createSwarmTurnTimeout.placeholder = String(
    cfg?.defaultTurnTimeoutSeconds ?? DEFAULT_TURN_TIMEOUT_SECONDS,
  );
  dom.createSwarmStallTimeout.placeholder = String(
    cfg?.defaultStallTimeoutSeconds ?? DEFAULT_STALL_TIMEOUT_SECONDS,
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
  } else if (cfg?.effectiveDefaultProvider) {
    dom.createSwarmProvider.value = cfg.effectiveDefaultProvider;
  }

  if (state.createPoolDraft === null) {
    const globalPool = cfg?.activePool;
    state.createPoolDraft =
      globalPool && globalPool.length > 0
        ? [...globalPool]
        : enabled.filter((p) => p.available).map((p) => p.id);
    dom.createSwarmFailover.checked = Boolean(
      cfg?.routingPolicy?.autoFailover,
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
    const reset = resetModelOptions(dom.addWorkerModel.value, getAddWorkerTargetDescriptors());
    dom.addWorkerModel.value = reset.model;
    dom.addWorkerEffort.value = reset.reasoningEffort;
    dom.addWorkerFast.value = reset.fastMode;
    syncAddWorkerModelDatalist();
    syncAddWorkerModelOptions();
  });
  syncAddWorkerModelDatalist();
  syncAddWorkerModelOptions();

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

export async function fetchTemplatesFromServer(): Promise<void> {
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

let mergePreviewRequestSeq = 0;

export async function previewMergeFromUi(name: string): Promise<void> {
  const swarmId = state.currentSwarmId;
  const requestSeq = ++mergePreviewRequestSeq;
  const isCurrent = () =>
    requestSeq === mergePreviewRequestSeq &&
    swarmId === state.currentSwarmId &&
    state.mergeOpenWorker === name;
  state.mergePreviews.set(name, { loading: true });
  if (state.latestSnapshot?.swarm) {
    renderWorkers(state.latestSnapshot);
  }
  try {
    const res = await app.callServerTool({
      name: 'app_preview_merge',
      arguments: {
        ...(swarmId ? { swarm_id: swarmId } : {}),
        name,
      },
    });
    if (!isCurrent()) return;
    const errMsg = extractToolErrorMessage(res);
    if (errMsg) {
      state.mergePreviews.set(name, { loading: false, error: errMsg });
    } else {
      const sc = res.structuredContent as { preview?: MergePreviewResult } | undefined;
      state.mergePreviews.set(name, { loading: false, data: sc?.preview });
    }
  } catch (err) {
    if (!isCurrent()) return;
    state.mergePreviews.set(name, {
      loading: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (state.latestSnapshot?.swarm && state.activeTab === 'workers') {
    if (state.workersPointerDown || isEditingInsideWorkersList()) {
      state.workersDeferredRender = true;
    } else {
      renderWorkers(state.latestSnapshot);
    }
  }
}

export async function applyMergeFromUi(name: string): Promise<void> {
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
    await bridge.refreshSnapshot(true);
  } catch (err) {
    showCommanderToast(err instanceof Error ? err.message : String(err), true);
  }
}

export async function createWorkerPrFromUi(name: string): Promise<void> {
  const draft = state.mergeDrafts.get(name);
  try {
    const res = await app.callServerTool({
      name: 'app_create_worker_pr',
      arguments: {
        ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
        name,
        ...(draft?.draftPr ? { draft: true } : {}),
        ...(draft?.commitMsg?.trim() ? { title: draft.commitMsg.trim() } : {}),
      },
    });
    const sc = res.structuredContent as CreatePrResult | undefined;
    if (sc) {
      state.prResults.set(name, sc);
    }
    if (res.isError || sc?.created === false) {
      showCommanderToast(extractToolErrorMessage(res) || sc?.message || 'PR creation failed', true);
    } else {
      showCommanderToast(sc?.message || tr('merge.prCreated'));
    }
    await bridge.refreshSnapshot(true);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    state.prResults.set(name, {
      created: false,
      workerName: name,
      branch: '',
      baseBranch: '',
      message: msg,
    });
    showCommanderToast(msg, true);
  }
}

export async function updateSwarmBudgetFromUi(opts: {
  maxCostUsd?: number | null;
  resume?: boolean;
}): Promise<void> {
  try {
    const res = await app.callServerTool({
      name: 'app_update_swarm_budget',
      arguments: {
        ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
        ...(opts.maxCostUsd !== undefined ? { max_cost_usd: opts.maxCostUsd } : {}),
        ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
      },
    });
    const errMsg = extractToolErrorMessage(res);
    if (errMsg) {
      showCommanderToast(errMsg, true);
      return;
    }
    showCommanderToast(tr('budget.updatedToast'));
    await bridge.refreshSnapshot(true);
  } catch (err) {
    showCommanderToast(err instanceof Error ? err.message : String(err), true);
  }
}

export async function crossReviewFromUi(targetWorker: string): Promise<void> {
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
    await bridge.refreshSnapshot(true);
  } catch (err) {
    showCommanderToast(err instanceof Error ? err.message : String(err), true);
  }
}

/** Wire commander listener bindings. Called once from the entrypoint. */
export function bindCommanderEvents(): void {
  dom.cmdToggleCreate.addEventListener('click', () => toggleCommanderPanel('create'));
  dom.cmdToggleAdd.addEventListener('click', () => toggleCommanderPanel('add'));
  dom.cmdToggleArena.addEventListener('click', () => toggleCommanderPanel('arena'));
  dom.cmdToggleTemplates.addEventListener('click', () => toggleCommanderPanel('templates'));
  dom.cmdKillAll.addEventListener('click', () => {
    if (!state.latestSnapshot?.swarm) return;
    const confirmed = state.pendingKillAll;
    state.pendingKillAllTimer = armDoubleClickConfirm(confirmed, state.pendingKillAllTimer, () => {
      state.pendingKillAll = false;
      state.pendingKillAllTimer = null;
      dom.cmdKillAll.textContent = tr('workers.killAllBtn');
    });
    if (confirmed) {
      clearPendingKillState();
      dom.cmdKillAll.textContent = tr('workers.killAllBtn');
      void bridge.killWorkerFromUi('all', false);
    } else {
      state.pendingKillAll = true;
      dom.cmdKillAll.textContent = tr('workers.confirmKillAll');
    }
  });
  dom.cmdCreateCancel.addEventListener('click', () => toggleCommanderPanel(null));
  dom.cmdAddCancel.addEventListener('click', () => toggleCommanderPanel(null));
  dom.cmdArenaCancel.addEventListener('click', () => toggleCommanderPanel(null));
  dom.cmdTemplatesCancel.addEventListener('click', () => toggleCommanderPanel(null));

  dom.arenaAddRow.addEventListener('click', () => {
    const providers = getEnabledProvidersForUi();
    const next = providers[state.arenaSlots.length % Math.max(1, providers.length)];
    state.arenaSlots.push({ provider: next?.id || 'dsh', model: '' });
    renderArenaContestantRows();
  });

  dom.addWorkerModel.addEventListener('input', () => syncAddWorkerModelOptions());

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
      ...(m.reasoningEffort ? { reasoningEffort: m.reasoningEffort } : {}),
      ...(typeof m.fastMode === 'boolean' ? { fastMode: m.fastMode } : {}),
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
    const rawMaxCost = dom.createSwarmMaxCost.value.trim();
    let maxCostUsd: number | undefined;
    if (rawMaxCost) {
      const n = Number(rawMaxCost);
      if (!Number.isFinite(n) || n < 0 || n > 10000) {
        showCommanderToast(tr('cmd.invalidCreateParams'), true);
        return;
      }
      if (n > 0) maxCostUsd = n;
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
            ...(maxCostUsd !== undefined ? { max_cost_usd: maxCostUsd } : {}),
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
          bridge.resetSwarmScopedUiState(false);
        }
        state.createPoolDraft = null;
        toggleCommanderPanel(null);
        dom.cmdPanelCreate.reset();
        showCommanderToast(tr('cmd.toastCreated', { title: sc?.swarm?.title || repoRoot }));
        await bridge.refreshSnapshot(true);
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
      const rawVerifyRetries = dom.addWorkerMaxVerifyRetries.value.trim();
      const maxVerifyRetries = rawVerifyRetries
        ? Math.min(5, Math.max(0, Math.floor(Number(rawVerifyRetries) || 0)))
        : 0;
      const chosenProviders = [...state.addProvidersDraft];
      const effEffort = !dom.addWorkerEffortField.hidden
        ? sanitizeReasoningEffort(dom.addWorkerEffort.value)
        : undefined;
      const effFast = !dom.addWorkerFastField.hidden
        ? fastDraftToBool(parseFastDraftMode(dom.addWorkerFast.value))
        : undefined;
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
            model: normalizeModelInput(dom.addWorkerModel.value) || undefined,
            ...(effEffort ? { reasoning_effort: effEffort } : {}),
            ...(typeof effFast === 'boolean' ? { fast_mode: effFast } : {}),
            permission_mode: dom.addWorkerPerm.value,
            workspace: dom.addWorkerWs.value,
            ...(tasks.length > 0 ? { tasks } : {}),
            ...(allowedFiles.length > 0 ? { allowed_files: allowedFiles } : {}),
            ...(verifyCommands.length > 0 ? { verify_commands: verifyCommands } : {}),
            ...(autoVerify ? { auto_verify: true } : {}),
            ...(maxVerifyRetries > 0 ? { max_verify_retries: maxVerifyRetries } : {}),
            ...(deps.length > 0 ? { depends_on: deps } : {}),
          },
        });
        const errMsg = extractToolErrorMessage(res);
        if (errMsg) {
          showCommanderToast(errMsg, true);
          return;
        }
        state.addProvidersDraft.clear();
        dom.cmdPanelAdd.reset();
        dom.addWorkerEffort.value = '';
        dom.addWorkerFast.value = 'default';
        syncCommanderControls(true);
        toggleCommanderPanel(null);
        showCommanderToast(tr('cmd.toastAdded', { name }));
        await bridge.refreshSnapshot(true);
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
            contestants: state.arenaSlots.map((s) => {
              const eff = sanitizeReasoningEffort(s.reasoningEffort);
              const fast = fastDraftToBool(s.fastMode);
              const model = normalizeModelInput(s.model);
              return {
                provider: s.provider,
                ...(model ? { model } : {}),
                ...(eff ? { reasoning_effort: eff } : {}),
                ...(typeof fast === 'boolean' ? { fast_mode: fast } : {}),
              };
            }),
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
        await bridge.refreshSnapshot(true);
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
      const reasoningEffortOverrides: Record<string, string | null> = {};
      const fastModeOverrides: Record<string, boolean | null> = {};
      for (const w of tpl?.workers || []) {
        const ov = state.tplRoleOverrides.get(`${templateId}:${w.name}`);
        if (!ov) continue;
        if (ov.provider !== undefined && ov.provider !== (w.provider || '')) {
          providerOverrides[w.name] = ov.provider;
        }
        if (ov.model !== undefined && ov.model !== normalizeModelInput(w.model)) {
          modelOverrides[w.name] = ov.model;
        }
        const ovEffort = sanitizeReasoningEffort(ov.reasoningEffort);
        if (ovEffort) reasoningEffortOverrides[w.name] = ovEffort;
        else if (w.reasoningEffort) reasoningEffortOverrides[w.name] = null;
        const ovFast = fastDraftToBool(ov.fastMode);
        if (typeof ovFast === 'boolean') fastModeOverrides[w.name] = ovFast;
        else if (typeof w.fastMode === 'boolean') fastModeOverrides[w.name] = null;
      }
      try {
        const res = await app.callServerTool({
          name: 'app_apply_template',
          arguments: {
            ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
            template_id: templateId,
            goal,
            ...(!state.latestSnapshot?.swarm ? {
              repo_root: dom.tplRepo.value.trim() || undefined,
              title: dom.tplTitle.value.trim() || undefined,
            } : {}),
            ...(Object.keys(providerOverrides).length > 0
              ? { provider_overrides: providerOverrides }
              : {}),
            ...(Object.keys(modelOverrides).length > 0 ? { model_overrides: modelOverrides } : {}),
            ...(Object.keys(reasoningEffortOverrides).length > 0
              ? { reasoning_effort_overrides: reasoningEffortOverrides }
              : {}),
            ...(Object.keys(fastModeOverrides).length > 0
              ? { fast_mode_overrides: fastModeOverrides }
              : {}),
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
          bridge.resetSwarmScopedUiState(false);
        }
        toggleCommanderPanel(null);
        dom.tplGoal.value = '';
        showCommanderToast(
          tr('cmd.toastTemplateApplied', {
            name: sc?.template?.name || templateId,
            n: sc?.added?.length || 0,
          }),
        );
        await bridge.refreshSnapshot(true);
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
}
