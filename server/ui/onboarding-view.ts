/**
 * First-run onboarding wizard.
 *
 * Extracted verbatim from the former monolithic `ui/app.ts`; identifiers are
 * bound as follows:
 *   state  -> `store.ts`    (shared mutable UI state)
 *   dom    -> `dom.ts`      (typed DOM refs)
 *   bridge -> `bridge.ts`   (callbacks still owned by the entrypoint)
 * This keeps the module graph acyclic: views never import `app.ts`.
 */
import {
  TASK_ROUTING_ORDER,
  boolToFastDraft,
  buildFastModeOptionsHtml,
  buildPersistConfigFromDescriptor,
  buildReasoningEffortOptionsHtml,
  cssEsc,
  fastDraftToBool,
  getEffortFollowLabel,
  getFastFollowLabel,
  getReasoningEffortOptionsForModel,
  parseFastDraftMode,
  providerBadgeClass,
  providerSupportsFastMode,
  providerSupportsReasoningEffort,
  renderModelChecklistItemsHtml,
  renderProviderStatusBannerHtml,
  sanitizeReasoningEffort,
  serializeTaskRoutingMap,
  showCommanderToast,
  syncEffortSelect,
} from './helpers.js';
import { discoverModelsForProvider, loadProviderConfig, runProviderConnectionTest, saveProviderPatch, switchSettingsSubtab } from './settings-view.js';
import { tr } from './context.js';
import { app } from './mcp-app.js';
import { state } from './store.js';
import * as dom from './dom.js';
import {
  escapeHtml,
  splitModelList,
} from './format.js';
import type {
  ProviderDescriptor,
  ProvidersConfigSnapshot,
  Snapshot,
  TaskRoutingMap,
} from './types.js';
import { CUSTOM_CLI_PRESETS } from './presets.js';
import * as bridge from './bridge.js';
import { registerOnboardingRenderer } from './hooks.js';

export function shouldShowOnboarding(snap: Snapshot): boolean {
  if (state.onboardingForceOpen) return true;
  if (state.onboardingDismissedThisSession) return false;
  return Boolean(
    !snap.uiPrefs?.onboardingCompleted &&
      snap.providerConfig &&
      !snap.providerConfig.globalConfigExists &&
      !snap.swarm &&
      (snap.swarms?.length || 0) === 0,
  );
}

export function initOnboardingDraft(cfg: ProvidersConfigSnapshot, preserveUserEdits = false): void {
  const knownIds = new Set<string>([
    ...state.onboardingDefaultModels.keys(),
    ...state.onboardingDefaultEfforts.keys(),
    ...state.onboardingDefaultFastModes.keys(),
    ...state.onboardingModelsRaw.keys(),
  ]);
  if (!preserveUserEdits) {
    state.onboardingSelectedClis.clear();
    state.onboardingDefaultModels.clear();
    state.onboardingDefaultEfforts.clear();
    state.onboardingDefaultFastModes.clear();
    state.onboardingModelsRaw.clear();
    state.onboardingWriterPool.clear();
    state.onboardingReaderPool.clear();
    for (const p of cfg.providers) {
      const shouldPick = cfg.globalConfigExists ? p.enabled && p.available : p.available;
      if (shouldPick) state.onboardingSelectedClis.add(p.id);
      state.onboardingDefaultModels.set(p.id, p.configuredDefaultModel || '');
      state.onboardingDefaultEfforts.set(p.id, p.configuredDefaultReasoningEffort || '');
      state.onboardingDefaultFastModes.set(p.id, boolToFastDraft(p.configuredDefaultFastMode));
      state.onboardingModelsRaw.set(p.id, (p.configuredModels || []).join(', '));
    }
    state.onboardingDefaultCli = cfg.configuredDefaultProvider || '';
    state.onboardingUsePool = cfg.globalConfigExists ? Boolean(cfg.activePool?.length) : true;
    state.onboardingFailover = cfg.globalConfigExists ? Boolean(cfg.routingPolicy?.autoFailover) : true;
    for (const id of cfg.routingPolicy?.writerProviders || []) state.onboardingWriterPool.add(id);
    for (const id of cfg.routingPolicy?.readerProviders || []) state.onboardingReaderPool.add(id);
  } else {
    for (const p of cfg.providers) {
      if (!knownIds.has(p.id)) {
        if (p.available && p.enabled) state.onboardingSelectedClis.add(p.id);
        state.onboardingDefaultModels.set(p.id, p.configuredDefaultModel || '');
        state.onboardingDefaultEfforts.set(p.id, p.configuredDefaultReasoningEffort || '');
        state.onboardingDefaultFastModes.set(p.id, boolToFastDraft(p.configuredDefaultFastMode));
        state.onboardingModelsRaw.set(p.id, (p.configuredModels || []).join(', '));
      }
    }
  }
  state.onboardingDraftInitialized = true;
}

export function applyCustomPreset(presetKey: string): boolean {
  const p = CUSTOM_CLI_PRESETS[presetKey];
  if (!p) return false;
  dom.customAddIdInput.value = p.id;
  dom.customAddNameInput.value = p.name;
  dom.customAddCmdInput.value = p.command;
  dom.customAddDefaultModelInput.value = p.defaultModel;
  dom.customAddPromptMode.value = p.promptMode;
  dom.customAddOutputFormat.value = p.outputFormat;
  dom.customAddArgsInput.value = p.args;
  dom.customAddResumeArgsInput.value = p.resumeArgs;
  dom.customAddListModelsArgsInput.value = p.listModelsArgs || '';
  return true;
}

export function openCustomCliCreator(presetKey?: string): void {
  state.onboardingForceOpen = false;
  state.onboardingVisible = false;
  dom.onboardingHost.classList.add('hidden');
  bridge.switchTab('settings');
  switchSettingsSubtab('clis');
  dom.settingsAddPanel.classList.remove('hidden');
  if (presetKey) {
    applyCustomPreset(presetKey);
    dom.customAddCmdInput.focus();
  } else {
    dom.settingsAddPanel.reset();
    dom.customAddIdInput.focus();
  }
  dom.settingsAddPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

export async function dismissOnboardingWizard(): Promise<void> {
  const wasFirstTime = !state.onboardingForceOpen;
  state.onboardingForceOpen = false;
  state.onboardingDismissedThisSession = true;
  state.onboardingVisible = false;
  dom.onboardingHost.classList.add('hidden');
  if (wasFirstTime) {
    if (state.latestSnapshot) {
      state.latestSnapshot.uiPrefs = { ...state.latestSnapshot.uiPrefs, onboardingCompleted: true };
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
  if (state.latestSnapshot) {
    bridge.renderSnapshot(state.latestSnapshot, true);
  }
}

export async function openOnboardingWizard(): Promise<void> {
  state.onboardingForceOpen = true;
  state.onboardingDismissedThisSession = false;
  state.onboardingStep = 1;
  if (state.latestProviderConfig) {
    initOnboardingDraft(state.latestProviderConfig, false);
  }
  bridge.switchTab('board');
  await loadProviderConfig();
  if (state.latestProviderConfig) initOnboardingDraft(state.latestProviderConfig, false);
  state.onboardingVisible = true;
  dom.onboardingHost.classList.remove('hidden');
  renderOnboardingWizard();
}

export async function testSelectedOnboardingClis(): Promise<void> {
  const cfg = state.latestProviderConfig;
  if (!cfg || state.onboardingTestingAll) return;
  const targets = cfg.providers.filter((p) => state.onboardingSelectedClis.has(p.id)).map((p) => p.id);
  if (targets.length === 0) return;
  state.onboardingTestingAll = true;
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
    state.onboardingTestingAll = false;
    if (state.onboardingVisible) renderOnboardingWizard();
  }
}

export async function saveOnboardingWizard(): Promise<void> {
  const cfg = state.latestProviderConfig;
  if (!cfg || state.onboardingSaving) return;
  const selected = cfg.providers.filter((p) => state.onboardingSelectedClis.has(p.id));
  if (selected.length === 0) return;

  state.onboardingSaving = true;
  renderOnboardingWizard();
  try {
    const upsertProviders = cfg.providers.map((p) => {
      const isSelected = state.onboardingSelectedClis.has(p.id);
      const baseCfg = buildPersistConfigFromDescriptor(p, isSelected);
      if (isSelected) {
        const defModel = (state.onboardingDefaultModels.get(p.id) || '').trim();
        if (defModel) baseCfg.defaultModel = defModel;
        else delete baseCfg.defaultModel;
        const defEffort = sanitizeReasoningEffort(state.onboardingDefaultEfforts.get(p.id));
        if (defEffort && providerSupportsReasoningEffort(p.id, p)) {
          baseCfg.defaultReasoningEffort = defEffort;
        } else {
          delete baseCfg.defaultReasoningEffort;
        }
        const defFast = fastDraftToBool(state.onboardingDefaultFastModes.get(p.id));
        if (typeof defFast === 'boolean' && providerSupportsFastMode(p.id, p)) {
          baseCfg.defaultFastMode = defFast;
        } else {
          delete baseCfg.defaultFastMode;
        }
        const modelsList = splitModelList(state.onboardingModelsRaw.get(p.id) || '');
        if (modelsList.length > 0) baseCfg.models = modelsList;
        else delete baseCfg.models;
      }
      return { id: p.id, config: baseCfg };
    });

    const defaultProviderArg =
      selected.length === 1
        ? selected[0].id
        : state.onboardingDefaultCli && state.onboardingSelectedClis.has(state.onboardingDefaultCli)
          ? state.onboardingDefaultCli
          : null;

    const activePoolArg = selected.length >= 2 && state.onboardingUsePool ? selected.map((p) => p.id) : null;
    const writers = [...state.onboardingWriterPool].filter((id) => state.onboardingSelectedClis.has(id));
    const readers = [...state.onboardingReaderPool].filter((id) => state.onboardingSelectedClis.has(id));
    const prevPolicy = cfg.routingPolicy;
    const keptTaskRouting: TaskRoutingMap = {};
    if (prevPolicy?.taskRouting) {
      for (const cat of TASK_ROUTING_ORDER) {
        const items = (prevPolicy.taskRouting[cat] || []).filter((t) =>
          state.onboardingSelectedClis.has(t.provider),
        );
        if (items.length > 0) keptTaskRouting[cat] = items;
      }
    }
    const preservedTaskPayload = serializeTaskRoutingMap(keptTaskRouting);
    const preservedNotes = prevPolicy?.routingNotes?.trim() || '';
    const hasPoolPolicy =
      selected.length >= 2 && (writers.length > 0 || readers.length > 0 || state.onboardingFailover);
    const hasPreservedPolicy =
      Boolean(prevPolicy?.delegationMode && prevPolicy.delegationMode !== 'balanced') ||
      Boolean(preservedTaskPayload) ||
      Boolean(preservedNotes);
    const routingPolicyArg =
      hasPoolPolicy || hasPreservedPolicy
        ? {
            ...(selected.length >= 2 && writers.length > 0 ? { writer_providers: writers } : {}),
            ...(selected.length >= 2 && readers.length > 0 ? { reader_providers: readers } : {}),
            ...(selected.length >= 2
              ? { auto_failover: state.onboardingFailover }
              : prevPolicy?.autoFailover !== undefined
                ? { auto_failover: prevPolicy.autoFailover }
                : {}),
            ...(prevPolicy?.delegationMode ? { delegation_mode: prevPolicy.delegationMode } : {}),
            ...(preservedTaskPayload ? { task_routing: preservedTaskPayload } : {}),
            ...(preservedNotes ? { routing_notes: preservedNotes } : {}),
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
    state.settingsDraftModels.clear();

    if (state.latestSnapshot) {
      state.latestSnapshot.uiPrefs = { ...state.latestSnapshot.uiPrefs, onboardingCompleted: true };
    }
    try {
      await app.callServerTool({
        name: 'app_set_ui_prefs',
        arguments: { onboarding_completed: true },
      });
    } catch {
      // Non-fatal
    }

    state.onboardingForceOpen = false;
    state.onboardingDismissedThisSession = true;
    state.onboardingVisible = false;
    dom.onboardingHost.classList.add('hidden');
    await bridge.refreshSnapshot(true);
    showCommanderToast(tr('onb.savedToast', { n: selected.length }));
  } finally {
    state.onboardingSaving = false;
    if (state.onboardingVisible) renderOnboardingWizard();
  }
}

export function renderOnboardingCliRow(p: ProviderDescriptor): string {
  const checked = state.onboardingSelectedClis.has(p.id);
  const testRes = state.settingsTestResults.get(p.id);
  const isTesting = state.testingProviders.has(p.id);
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
        <button type="button" class="btn btn-sm btn-ghost" data-onb-test="${escapeHtml(p.id)}" ${isTesting || state.onboardingTestingAll ? 'disabled' : ''}>
          ${escapeHtml(tr(isTesting ? 'settings.testingBtn' : 'settings.testBtn'))}
        </button>
      </div>
      ${renderProviderStatusBannerHtml(p, testRes)}
    </div>
  `;
}

export function renderOnboardingWizard(): void {
  const cfg = state.latestProviderConfig;
  if (!cfg) return;
  const selected = cfg.providers.filter((p) => state.onboardingSelectedClis.has(p.id));
  if (state.onboardingStep === 3 && selected.length < 2) {
    state.onboardingStep = 2;
  }
  const hasPoolStep = selected.length >= 2;
  const readyProviders = cfg.providers.filter((p) => p.available);
  const missingProviders = cfg.providers.filter((p) => !p.available);

  const stepClass = (stepNum: 1 | 2 | 3): string =>
    state.onboardingStep === stepNum ? 'is-active' : state.onboardingStep > stepNum ? 'is-done' : '';

  const skipLabel = state.onboardingForceOpen ? tr('onb.close') : tr('onb.skip');

  let bodyHtml = '';
  let footerHtml = '';

  if (state.onboardingStep === 1) {
    bodyHtml = `
      <div class="onboarding-scan-bar">
        <span>${escapeHtml(tr('onb.scanSummary', { ready: readyProviders.length, total: cfg.providers.length }))}</span>
        <div class="onboarding-scan-actions">
          <button type="button" class="btn btn-sm btn-ghost" data-onb-rescan ${state.onboardingTestingAll ? 'disabled' : ''}>${escapeHtml(tr('onb.rescan'))}</button>
          <button type="button" class="btn btn-sm btn-ghost" data-onb-test-all ${state.onboardingTestingAll || selected.length === 0 ? 'disabled' : ''}>${escapeHtml(tr(state.onboardingTestingAll ? 'onb.testingSelected' : 'onb.testSelected'))}</button>
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
  } else if (state.onboardingStep === 2) {
    const cardsHtml = selected
      .map((p) => {
        const defVal = state.onboardingDefaultModels.get(p.id) ?? '';
        const listVal = state.onboardingModelsRaw.get(p.id) ?? '';
        const selectedList = splitModelList(listVal);
        const checkedSet = new Set(selectedList);
        const detected = p.detectedModels || [];
        const candidates = Array.from(new Set([...selectedList, ...detected, ...p.configuredModels]));
        const isDiscovering = state.discoveringProviders.has(p.id);
        const checklist = renderModelChecklistItemsHtml({
          providerId: p.id,
          providerDesc: p,
          candidates,
          checkedSet,
          defaultModel: defVal.trim(),
          checkAttr: 'data-onb-model-check',
          starAttr: 'data-onb-set-default',
          groupSelectAttr: 'data-onb-group-select',
          groupClearAttr: 'data-onb-group-clear',
        });
        const defEffortVal = sanitizeReasoningEffort(state.onboardingDefaultEfforts.get(p.id)) || '';
        const defFastVal = state.onboardingDefaultFastModes.get(p.id) || 'default';
        const showEffort = providerSupportsReasoningEffort(p.id, p);
        const showFast = providerSupportsFastMode(p.id, p);
        const effortFieldHtml = showEffort
          ? `
              <label class="settings-field">
                <span>${escapeHtml(tr('settings.defaultEffortLabel'))}</span>
                <select class="input input-sm" data-onb-def-effort="${escapeHtml(p.id)}">${buildReasoningEffortOptionsHtml({
                  efforts: getReasoningEffortOptionsForModel(p, defVal.trim() || p.detectedDefaultModel),
                  value: defEffortVal,
                  emptyLabel: getEffortFollowLabel(p),
                })}</select>
              </label>`
          : '';
        const fastFieldHtml = showFast
          ? `
              <label class="settings-field">
                <span>${escapeHtml(tr('settings.fastModeLabel'))}</span>
                <select class="input input-sm" data-onb-def-fast="${escapeHtml(p.id)}">${buildFastModeOptionsHtml({
                  value: defFastVal,
                  emptyLabel: getFastFollowLabel(p),
                })}</select>
              </label>`
          : '';
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
                <datalist id="dl-onb-${escapeHtml(p.id)}">${candidates.map((m) => `<option value="${escapeHtml(m)}"></option>`).join('')}</datalist>
              </label>${effortFieldHtml}${fastFieldHtml}
            </div>
            <div class="model-picker-box">
              <div class="model-picker-head">
                <div class="model-picker-meta">
                  <span>${escapeHtml(tr('settings.detectedModelsHeader', { checked: selectedList.length, total: candidates.length }))}</span>
                  ${p.detectedModelsSource ? `<span class="model-picker-source">${escapeHtml(tr('settings.detectedSource', { src: p.detectedModelsSource }))}</span>` : ''}
                </div>
                <div class="model-picker-actions">
                  <button type="button" class="btn btn-sm btn-ghost" data-onb-discover="${escapeHtml(p.id)}" ${isDiscovering ? 'disabled' : ''}>${escapeHtml(tr(isDiscovering ? 'settings.discoveringModels' : 'settings.discoverModelsBtn'))}</button>
                  ${candidates.length > 0 ? `<button type="button" class="btn btn-sm btn-ghost" data-onb-select-all="${escapeHtml(p.id)}">${escapeHtml(tr('settings.selectAllModels'))}</button><button type="button" class="btn btn-sm btn-ghost" data-onb-clear-models="${escapeHtml(p.id)}">${escapeHtml(tr('settings.clearModels'))}</button>` : ''}
                </div>
              </div>
              <div class="model-check-grid${checklist.grouped ? ' is-grouped' : ''}">${checklist.html}</div>
              <div class="model-add-row">
                <input class="input input-sm mono-input" type="text" data-onb-manual-input="${escapeHtml(p.id)}" placeholder="${escapeHtml(tr('onb.manualAddModelPh'))}" />
                <button type="button" class="btn btn-sm" data-onb-manual-add="${escapeHtml(p.id)}">${escapeHtml(tr('settings.addModelBtn'))}</button>
              </div>
            </div>
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
              : `<button type="button" class="btn btn-sm btn-primary" data-onb-save ${state.onboardingSaving ? 'disabled' : ''}>${escapeHtml(tr(state.onboardingSaving ? 'onb.saving' : 'onb.saveStart'))}</button>`
          }
        </div>
      </div>
    `;
  } else {
    const primaryOpts = [
      `<option value="">${escapeHtml(tr('onb.primaryAuto'))}</option>`,
      ...selected.map(
        (p) =>
          `<option value="${escapeHtml(p.id)}" ${state.onboardingDefaultCli === p.id ? 'selected' : ''}>${escapeHtml(`${p.displayName} (${p.id})`)}</option>`,
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
          <input type="checkbox" data-onb-use-pool ${state.onboardingUsePool ? 'checked' : ''} />
          <span>${escapeHtml(tr('onb.enablePoolLabel'))}</span>
        </label>
        <label class="checkbox-label">
          <input type="checkbox" data-onb-failover ${state.onboardingFailover ? 'checked' : ''} />
          <span>${escapeHtml(tr('onb.enableFailoverLabel'))}</span>
        </label>
        <details class="cmd-advanced">
          <summary class="cmd-advanced-summary">${escapeHtml(tr('onb.roleSplitSummary'))}</summary>
          <div class="routing-grid" style="margin-top:8px">
            <div class="settings-field">
              <span>${escapeHtml(tr('onb.writerPoolLabel'))}</span>
              <div class="cli-check-grid">${roleChecks('writer', state.onboardingWriterPool)}</div>
            </div>
            <div class="settings-field">
              <span>${escapeHtml(tr('onb.readerPoolLabel'))}</span>
              <div class="cli-check-grid">${roleChecks('reader', state.onboardingReaderPool)}</div>
            </div>
          </div>
        </details>
      </div>
    `;

    footerHtml = `
      <div class="onboarding-footer">
        <button type="button" class="btn btn-sm btn-ghost" data-onb-back="2">${escapeHtml(tr('onb.back'))}</button>
        <div class="onboarding-footer-right">
          <button type="button" class="btn btn-sm btn-primary" data-onb-save ${state.onboardingSaving ? 'disabled' : ''}>${escapeHtml(tr(state.onboardingSaving ? 'onb.saving' : 'onb.saveStart'))}</button>
        </div>
      </div>
    `;
  }

  dom.onboardingHost.innerHTML = `
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

  dom.onboardingHost.querySelector('[data-onb-skip]')?.addEventListener('click', () => {
    void dismissOnboardingWizard();
  });
  dom.onboardingHost.querySelector('[data-onb-rescan]')?.addEventListener('click', () => {
    void loadProviderConfig().then(() => {
      if (state.latestProviderConfig) initOnboardingDraft(state.latestProviderConfig, true);
      if (state.onboardingVisible) renderOnboardingWizard();
    });
  });
  dom.onboardingHost.querySelector('[data-onb-test-all]')?.addEventListener('click', () => {
    void testSelectedOnboardingClis();
  });
  dom.onboardingHost.querySelectorAll<HTMLInputElement>('[data-onb-cli]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.onbCli;
      if (!id) return;
      if (cb.checked) state.onboardingSelectedClis.add(id);
      else state.onboardingSelectedClis.delete(id);
      renderOnboardingWizard();
    });
  });
  dom.onboardingHost.querySelectorAll<HTMLButtonElement>('[data-onb-test]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.onbTest;
      if (id) void runProviderConnectionTest(id);
    });
  });
  dom.onboardingHost.querySelectorAll<HTMLButtonElement>('[data-onb-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      openCustomCliCreator(btn.dataset.onbPreset);
    });
  });
  dom.onboardingHost.querySelectorAll<HTMLButtonElement>('[data-onb-custom]').forEach((btn) => {
    btn.addEventListener('click', () => {
      openCustomCliCreator();
    });
  });
  dom.onboardingHost.querySelectorAll<HTMLInputElement>('[data-onb-def-model]').forEach((input) => {
    input.addEventListener('input', () => {
      const id = input.dataset.onbDefModel;
      if (!id) return;
      const val = input.value.trim();
      state.onboardingDefaultModels.set(id, input.value);
      const card = input.closest('.onboarding-model-card');
      const effSel = card?.querySelector<HTMLSelectElement>(
        `[data-onb-def-effort="${cssEsc(id)}"]`,
      );
      const provDesc = cfg.providers.find((x) => x.id === id);
      if (effSel && provDesc && providerSupportsReasoningEffort(provDesc.id, provDesc)) {
        const nextEff = syncEffortSelect({
          select: effSel,
          efforts: getReasoningEffortOptionsForModel(
            provDesc,
            val || provDesc.detectedDefaultModel,
          ),
          value: effSel.value,
          emptyLabel: getEffortFollowLabel(provDesc),
        });
        state.onboardingDefaultEfforts.set(id, nextEff);
      }
      card?.querySelectorAll<HTMLButtonElement>('[data-onb-set-default]').forEach((star) => {
        const isDef = Boolean(val) && star.dataset.model === val;
        star.classList.toggle('is-active', isDef);
        star.closest('.model-check-item')?.classList.toggle('is-default', isDef);
      });
    });
  });
  dom.onboardingHost.querySelectorAll<HTMLSelectElement>('[data-onb-def-effort]').forEach((sel) => {
    sel.addEventListener('change', () => {
      const id = sel.dataset.onbDefEffort;
      if (!id) return;
      state.onboardingDefaultEfforts.set(id, sanitizeReasoningEffort(sel.value) || '');
    });
  });
  dom.onboardingHost.querySelectorAll<HTMLSelectElement>('[data-onb-def-fast]').forEach((sel) => {
    sel.addEventListener('change', () => {
      const id = sel.dataset.onbDefFast;
      if (!id) return;
      state.onboardingDefaultFastModes.set(id, parseFastDraftMode(sel.value));
    });
  });
  dom.onboardingHost.querySelectorAll<HTMLInputElement>('[data-onb-model-check]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.onbModelCheck;
      const model = cb.value;
      if (!id || !model) return;
      const cur = splitModelList(state.onboardingModelsRaw.get(id) || '');
      const next = cb.checked
        ? Array.from(new Set([...cur, model]))
        : cur.filter((x) => x !== model);
      state.onboardingModelsRaw.set(id, next.join(', '));
      renderOnboardingWizard();
    });
  });
  dom.onboardingHost.querySelectorAll<HTMLButtonElement>('[data-onb-set-default]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.onbSetDefault;
      const model = btn.dataset.model;
      if (!id || !model) return;
      state.onboardingDefaultModels.set(id, model);
      const provDesc = cfg.providers.find((x) => x.id === id);
      const curEff = state.onboardingDefaultEfforts.get(id);
      if (provDesc && curEff && !getReasoningEffortOptionsForModel(provDesc, model).includes(curEff)) {
        state.onboardingDefaultEfforts.set(id, '');
      }
      const cur = splitModelList(state.onboardingModelsRaw.get(id) || '');
      if (!cur.includes(model)) {
        state.onboardingModelsRaw.set(id, [...cur, model].join(', '));
      }
      renderOnboardingWizard();
    });
  });
  dom.onboardingHost.querySelectorAll<HTMLButtonElement>('[data-onb-discover]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.onbDiscover;
      if (id) void discoverModelsForProvider(id);
    });
  });
  dom.onboardingHost.querySelectorAll<HTMLButtonElement>('[data-onb-select-all]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.onbSelectAll;
      const prov = id ? cfg.providers.find((x) => x.id === id) : undefined;
      if (!id || !prov) return;
      const merged = Array.from(
        new Set([
          ...splitModelList(state.onboardingModelsRaw.get(id) || ''),
          ...(prov.detectedModels || []),
          ...prov.configuredModels,
        ]),
      );
      state.onboardingModelsRaw.set(id, merged.join(', '));
      if (!state.onboardingDefaultModels.get(id)?.trim() && prov.detectedDefaultModel) {
        state.onboardingDefaultModels.set(id, prov.detectedDefaultModel);
      }
      renderOnboardingWizard();
    });
  });
  dom.onboardingHost.querySelectorAll<HTMLButtonElement>('[data-onb-clear-models]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.onbClearModels;
      if (!id) return;
      state.onboardingModelsRaw.set(id, '');
      renderOnboardingWizard();
    });
  });
  dom.onboardingHost
    .querySelectorAll<HTMLButtonElement>('[data-onb-group-select], [data-onb-group-clear]')
    .forEach((btn) => {
      btn.addEventListener('click', () => {
        const isSelect = btn.hasAttribute('data-onb-group-select');
        const id = isSelect ? btn.dataset.onbGroupSelect : btn.dataset.onbGroupClear;
        const groupEl = btn.closest('.model-provider-group');
        if (!id || !groupEl) return;
        const groupModels = [
          ...groupEl.querySelectorAll<HTMLInputElement>('[data-onb-model-check]'),
        ]
          .map((cb) => cb.value)
          .filter(Boolean);
        const cur = splitModelList(state.onboardingModelsRaw.get(id) || '');
        const next = isSelect
          ? Array.from(new Set([...cur, ...groupModels]))
          : cur.filter((m) => !groupModels.includes(m));
        state.onboardingModelsRaw.set(id, next.join(', '));
        renderOnboardingWizard();
      });
    });
  dom.onboardingHost.querySelectorAll<HTMLButtonElement>('[data-onb-manual-add]').forEach((btn) => {
    const addManual = () => {
      const id = btn.dataset.onbManualAdd;
      const input = id
        ? dom.onboardingHost.querySelector<HTMLInputElement>(`[data-onb-manual-input="${cssEsc(id)}"]`)
        : null;
      if (!id || !input) return;
      const items = splitModelList(input.value);
      if (items.length === 0) return;
      const merged = Array.from(new Set([...splitModelList(state.onboardingModelsRaw.get(id) || ''), ...items]));
      state.onboardingModelsRaw.set(id, merged.join(', '));
      renderOnboardingWizard();
    };
    btn.addEventListener('click', addManual);
    const id = btn.dataset.onbManualAdd;
    const input = id
      ? dom.onboardingHost.querySelector<HTMLInputElement>(`[data-onb-manual-input="${cssEsc(id)}"]`)
      : null;
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addManual();
      }
    });
  });
  dom.onboardingHost.querySelector<HTMLSelectElement>('[data-onb-default-cli]')?.addEventListener('change', (e) => {
    state.onboardingDefaultCli = (e.target as HTMLSelectElement).value;
  });
  dom.onboardingHost.querySelector<HTMLInputElement>('[data-onb-use-pool]')?.addEventListener('change', (e) => {
    state.onboardingUsePool = (e.target as HTMLInputElement).checked;
  });
  dom.onboardingHost.querySelector<HTMLInputElement>('[data-onb-failover]')?.addEventListener('change', (e) => {
    state.onboardingFailover = (e.target as HTMLInputElement).checked;
  });
  dom.onboardingHost.querySelectorAll<HTMLInputElement>('[data-onb-role]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const targetSet = cb.dataset.onbRole === 'writer' ? state.onboardingWriterPool : state.onboardingReaderPool;
      if (cb.checked) targetSet.add(cb.value);
      else targetSet.delete(cb.value);
    });
  });
  dom.onboardingHost.querySelector<HTMLButtonElement>('[data-onb-next]')?.addEventListener('click', (e) => {
    const step = Number((e.currentTarget as HTMLButtonElement).dataset.onbNext);
    if (step === 2 || step === 3) {
      state.onboardingStep = step;
      renderOnboardingWizard();
    }
  });
  dom.onboardingHost.querySelector<HTMLButtonElement>('[data-onb-back]')?.addEventListener('click', (e) => {
    const step = Number((e.currentTarget as HTMLButtonElement).dataset.onbBack);
    if (step === 1 || step === 2) {
      state.onboardingStep = step;
      renderOnboardingWizard();
    }
  });
  dom.onboardingHost.querySelector<HTMLButtonElement>('[data-onb-save]')?.addEventListener('click', () => {
    void saveOnboardingWizard();
  });
}

// Register the wizard renderer so settings-view can refresh it without
// importing this module (breaks the settings-view <-> onboarding-view cycle).
registerOnboardingRenderer(renderOnboardingWizard);

/** Wire onboarding/preset entries. Called once from the entrypoint. */
export function bindOnboardingEvents(): void {
  dom.settingsOpenOnboardingBtn.addEventListener('click', () => {
    void openOnboardingWizard();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const presetKey = btn.dataset.preset;
      if (presetKey) applyCustomPreset(presetKey);
    });
  });
}
