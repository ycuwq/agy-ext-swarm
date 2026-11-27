/**
 * Settings, provider cards, routing matrix and pricing.
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
  cycleTriStateFast,
  extractToolErrorMessage,
  fastDraftToBool,
  formatTimeoutBadgeValue,
  getEffortFollowLabel,
  getFastFollowLabel,
  getReasoningEffortOptionsForModel,
  getSelectableModelsForProvider,
  groupDshModelsForUi,
  parseFastDraftMode,
  parseOptionalTimeoutInput,
  providerBadgeClass,
  providerSupportsFastMode,
  providerSupportsReasoningEffort,
  renderCliCheckboxGrid,
  renderFastTogglePillHtml,
  renderModelChecklistItemsHtml,
  renderModelOptionBadgesHtml,
  renderProviderStatusBannerHtml,
  sanitizeReasoningEffort,
  serializeTaskRoutingMap,
  setBadgeText,
  showGlobalToast,
  splitDshUiModel,
  syncEffortSelect,
  withBusyButton,
} from './helpers.js';
import { renderOnboardingIfRegistered } from './hooks.js';
import { type I18nKey } from './i18n.js';
import { tr } from './context.js';
import { app } from './mcp-app.js';
import { state } from './store.js';
import * as dom from './dom.js';
import {
  DEFAULT_STALL_TIMEOUT_SECONDS,
  DEFAULT_TURN_TIMEOUT_SECONDS,
  MAX_STALL_TIMEOUT_SECONDS,
  MAX_TURN_TIMEOUT_SECONDS,
} from './types.js';
import {
  escapeHtml,
  formatArgsForInput,
  formatEnvText,
  parseArgsFromInput,
  parseEnvText,
  splitModelList,
} from './format.js';
import { bindPricingEvents, renderPricingSection } from './pricing-view.js';
import type {
  DiscoverModelsResult,
  OrchestratorDelegationMode,
  ProviderDescriptor,
  ProviderTestResult,
  ProvidersConfigSnapshot,
  TaskRoutingCategory,
  TaskRoutingMap,
} from './types.js';
import * as bridge from './bridge.js';

export function switchSettingsSubtab(subtab: 'clis' | 'routing'): void {
  state.activeSettingsSubtab = subtab;
  document.querySelectorAll<HTMLButtonElement>('[data-settings-subtab]').forEach((el) => {
    const isSelected = el.dataset.settingsSubtab === subtab;
    el.classList.toggle('is-active', isSelected);
    el.setAttribute('aria-selected', String(isSelected));
  });
  dom.settingsPaneClis.classList.toggle('hidden', subtab !== 'clis');
  dom.settingsPaneRouting.classList.toggle('hidden', subtab !== 'routing');
  if (dom.settingsStage) {
    dom.settingsStage.scrollTop = 0;
  }
  if (subtab === 'routing' && state.latestProviderConfig) {
    renderSettingsRoutingCard(state.latestProviderConfig);
  }
}

export function showSettingsToast(message: string, isError = false): void {
  showGlobalToast(message, isError, 3200);
}

export async function loadProviderConfig(): Promise<void> {
  if (!state.latestProviderConfig) {
    dom.settingsProvidersList.innerHTML = `<div class="empty-state-compact">${escapeHtml(tr('settings.loading'))}</div>`;
  }
  try {
    const res = await app.callServerTool({
      name: 'app_get_provider_config',
      arguments: {
        ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
        ...(state.latestSnapshot?.swarm?.repoRoot ? { repo_root: state.latestSnapshot.swarm.repoRoot } : {}),
      },
    });
    const payload = res.structuredContent as { providerConfig?: ProvidersConfigSnapshot } | undefined;
    if (payload?.providerConfig) {
      state.latestProviderConfig = payload.providerConfig;
      if (!state.routingDraftDirty) {
        state.routingDraftSynced = false;
      }
      const enabledCount = state.latestProviderConfig.providers.filter((p) => p.enabled).length;
      setBadgeText(dom.badgeSettingsClis, `${enabledCount}/${state.latestProviderConfig.providers.length}`);
      renderSettingsView();
    }
  } catch (err) {
    showSettingsToast(err instanceof Error ? err.message : String(err), true);
  }
}

export async function saveProviderPatch(
  patch: Record<string, unknown>,
  successMessage: string,
  clearDraftId?: string,
): Promise<boolean> {
  try {
    const res = await app.callServerTool({
      name: 'app_save_provider_config',
      arguments: {
        ...patch,
        ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
        ...(state.latestSnapshot?.swarm?.repoRoot ? { repo_root: state.latestSnapshot.swarm.repoRoot } : {}),
      },
    });
    const payload = res.structuredContent as { providerConfig?: ProvidersConfigSnapshot } | undefined;
    if (res.isError) {
      const msg = (res.content?.[0] as { text?: string } | undefined)?.text || 'Failed to save';
      showSettingsToast(msg, true);
      return false;
    }
    if (clearDraftId) {
      state.settingsDraftModels.delete(clearDraftId);
    }
    if (payload?.providerConfig) {
      state.latestProviderConfig = payload.providerConfig;
      const touchedRouting =
        'routing_policy' in patch ||
        'active_pool' in patch ||
        'default_turn_timeout_seconds' in patch ||
        'default_stall_timeout_seconds' in patch ||
        'remove_provider' in patch ||
        'upsert_providers' in patch;
      if (
        'routing_policy' in patch ||
        'active_pool' in patch ||
        'default_turn_timeout_seconds' in patch ||
        'default_stall_timeout_seconds' in patch
      ) {
        state.routingDraftDirty = false;
      }
      if (!state.routingDraftDirty || touchedRouting) {
        state.routingDraftSynced = false;
      }
      const enabledCount = state.latestProviderConfig.providers.filter((p) => p.enabled).length;
      setBadgeText(dom.badgeSettingsClis, `${enabledCount}/${state.latestProviderConfig.providers.length}`);
      renderSettingsView();
    }
    showSettingsToast(successMessage, false);
    return true;
  } catch (err) {
    showSettingsToast(err instanceof Error ? err.message : String(err), true);
    return false;
  }
}

export function updateCardModelChips(
  card: HTMLElement,
  p: ProviderDescriptor,
  dropInvalidEffort = false,
): void {
  const draft = state.settingsDraftModels.get(p.id) ?? [...p.configuredModels];
  state.settingsDraftModels.set(p.id, draft);
  const candidates = Array.from(new Set([...draft, ...p.configuredModels, ...(p.detectedModels || [])]));
  const checkedSet = new Set(draft);

  const countEl = card.querySelector<HTMLSpanElement>('.model-picker-count');
  const gridWrap = card.querySelector<HTMLDivElement>('.model-check-grid');
  const dl = card.querySelector<HTMLDataListElement>(`#dl-models-${cssEsc(p.id)}`);
  const defaultInput = card.querySelector<HTMLInputElement>('[data-field="defaultModel"]');
  const currentDefault = defaultInput?.value.trim() || p.defaultModel || '';
  const effortSelect = card.querySelector<HTMLSelectElement>('[data-field="defaultReasoningEffort"]');
  if (effortSelect && providerSupportsReasoningEffort(p.id, p)) {
    syncEffortSelect({
      select: effortSelect,
      efforts: getReasoningEffortOptionsForModel(p, currentDefault),
      value: effortSelect.value,
      emptyLabel: getEffortFollowLabel(p),
      preserveUnknown: !dropInvalidEffort,
    });
  }
  const selectAllBtn = card.querySelector<HTMLButtonElement>('[data-select-all-models]');
  const clearBtn = card.querySelector<HTMLButtonElement>('[data-clear-models]');

  if (countEl) {
    countEl.textContent = tr('settings.detectedModelsHeader', {
      checked: draft.length,
      total: candidates.length,
    });
  }
  selectAllBtn?.classList.toggle('hidden', candidates.length === 0);
  clearBtn?.classList.toggle('hidden', candidates.length === 0);

  if (gridWrap) {
    const rendered = renderModelChecklistItemsHtml({
      providerId: p.id,
      providerDesc: p,
      candidates,
      checkedSet,
      defaultModel: currentDefault,
      filter: state.settingsModelFilters.get(p.id) || '',
      checkAttr: 'data-model-check',
      starAttr: 'data-set-default-model',
      groupSelectAttr: 'data-group-select',
      groupClearAttr: 'data-group-clear',
    });
    gridWrap.classList.toggle('is-grouped', rendered.grouped);
    gridWrap.innerHTML = rendered.html;

    gridWrap.querySelectorAll<HTMLInputElement>('[data-model-check]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const model = cb.value;
        const cur = state.settingsDraftModels.get(p.id) || [];
        const next = cb.checked ? Array.from(new Set([...cur, model])) : cur.filter((x) => x !== model);
        state.settingsDraftModels.set(p.id, next);
        updateCardModelChips(card, p);
      });
    });

    gridWrap.querySelectorAll<HTMLButtonElement>('[data-set-default-model]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const model = btn.dataset.model;
        if (!model) return;
        if (defaultInput) defaultInput.value = model;
        const cur = state.settingsDraftModels.get(p.id) || [];
        if (!cur.includes(model)) {
          state.settingsDraftModels.set(p.id, [...cur, model]);
        }
        updateCardModelChips(card, p, true);
      });
    });

    gridWrap
      .querySelectorAll<HTMLButtonElement>('[data-group-select], [data-group-clear]')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          const isSelect = btn.hasAttribute('data-group-select');
          const groupEl = btn.closest('.model-provider-group');
          if (!groupEl) return;
          const groupModels = [...groupEl.querySelectorAll<HTMLInputElement>('[data-model-check]')]
            .map((cb) => cb.value)
            .filter(Boolean);
          const cur = state.settingsDraftModels.get(p.id) || [];
          const next = isSelect
            ? Array.from(new Set([...cur, ...groupModels]))
            : cur.filter((x) => !groupModels.includes(x));
          state.settingsDraftModels.set(p.id, next);
          updateCardModelChips(card, p);
        });
      });
  }

  if (dl) {
    dl.innerHTML = candidates.map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
  }
}

export function renderRoutingSummaryChips(): void {
  const parts: string[] = [];
  const modeKey: I18nKey =
    state.routingDraftDelegation === 'prefer-external'
      ? 'routing.summaryModeExternal'
      : state.routingDraftDelegation === 'manual-only'
        ? 'routing.summaryModeManual'
        : 'routing.summaryModeBalanced';
  const modeLabel = tr(modeKey);
  parts.push(`<span class="tab-badge">${escapeHtml(modeLabel)}</span>`);

  const configuredTasks = TASK_ROUTING_ORDER.filter(
    (cat) => (state.routingDraftTasks.get(cat)?.length || 0) > 0,
  ).length;
  if (configuredTasks > 0) {
    parts.push(
      `<span class="tab-badge">${escapeHtml(tr('routing.summaryTasks', { n: configuredTasks }))}</span>`,
    );
  }
  if (state.routingDraftActive.size > 0) {
    for (const id of state.routingDraftActive) {
      parts.push(`<span class="provider-badge ${providerBadgeClass(id)}">${escapeHtml(id)}</span>`);
    }
  } else if (configuredTasks === 0) {
    parts.push(`<span class="routing-summary-empty">${escapeHtml(tr('routing.summaryEmpty'))}</span>`);
  }
  if (dom.routingAutoFailover.checked) {
    parts.push(`<span class="failover-tag">${escapeHtml(tr('routing.summaryFailoverOn'))}</span>`);
  }
  const hasNotes = Boolean((dom.routingNotesInput?.value ?? state.routingDraftNotes).trim());
  if (hasNotes) {
    parts.push(`<span class="tab-badge">${escapeHtml(tr('routing.summaryNotes'))}</span>`);
  }
  const parsedTurn = parseOptionalTimeoutInput(
    dom.routingTurnTimeoutInput?.value ?? state.routingDraftTurnTimeout,
    MAX_TURN_TIMEOUT_SECONDS,
  );
  const parsedStall = parseOptionalTimeoutInput(
    dom.routingStallTimeoutInput?.value ?? state.routingDraftStallTimeout,
    MAX_STALL_TIMEOUT_SECONDS,
  );
  const effTurn = parsedTurn === null ? DEFAULT_TURN_TIMEOUT_SECONDS : parsedTurn === 'invalid' ? undefined : parsedTurn;
  const effStall =
    parsedStall === null ? DEFAULT_STALL_TIMEOUT_SECONDS : parsedStall === 'invalid' ? undefined : parsedStall;
  const hasCustomTimeouts =
    (effTurn !== undefined && effTurn !== DEFAULT_TURN_TIMEOUT_SECONDS) ||
    (effStall !== undefined && effStall !== DEFAULT_STALL_TIMEOUT_SECONDS);
  const timeoutSummaryText = hasCustomTimeouts
    ? tr('routing.summaryTimeouts', {
        turn: formatTimeoutBadgeValue(effTurn ?? DEFAULT_TURN_TIMEOUT_SECONDS),
        stall: formatTimeoutBadgeValue(effStall ?? DEFAULT_STALL_TIMEOUT_SECONDS),
      })
    : null;
  if (timeoutSummaryText) {
    parts.push(`<span class="tab-badge">${escapeHtml(timeoutSummaryText)}</span>`);
  }
  dom.routingSummaryChips.innerHTML = parts.join('');

  dom.routingCountBadge.textContent =
    configuredTasks > 0
      ? `${configuredTasks}/6`
      : state.routingDraftActive.size > 0
        ? `${state.routingDraftActive.size} CLI`
        : tr('routing.badgeDefault');

  dom.routingPoolsBadge.textContent =
    state.routingDraftActive.size > 0
      ? tr('routing.poolsBadgeActive', { n: state.routingDraftActive.size })
      : dom.routingAutoFailover.checked
        ? tr('routing.summaryFailoverOn')
        : tr('routing.poolsBadgeIdle');

  dom.routingSaveHint.textContent = [
    modeLabel,
    configuredTasks > 0 ? tr('routing.summaryTasks', { n: configuredTasks }) : null,
    state.routingDraftActive.size > 0 ? tr('routing.poolsBadgeActive', { n: state.routingDraftActive.size }) : null,
    dom.routingAutoFailover.checked ? tr('routing.summaryFailoverOn') : null,
    timeoutSummaryText,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function renderDelegationModeControls(): void {
  const modes: Array<{
    value: OrchestratorDelegationMode;
    titleKey: I18nKey;
    hintKey: I18nKey;
  }> = [
    { value: 'balanced', titleKey: 'routing.modeBalanced', hintKey: 'routing.modeBalancedHint' },
    {
      value: 'prefer-external',
      titleKey: 'routing.modePreferExternal',
      hintKey: 'routing.modePreferExternalHint',
    },
    {
      value: 'manual-only',
      titleKey: 'routing.modeManualOnly',
      hintKey: 'routing.modeManualOnlyHint',
    },
  ];
  dom.routingDelegationMode.innerHTML = modes
    .map((m) => {
      const active = state.routingDraftDelegation === m.value;
      return `
        <label class="delegation-mode-pill${active ? ' is-active' : ''}">
          <input type="radio" name="routing-delegation-mode" value="${m.value}" ${active ? 'checked' : ''} />
          <div class="delegation-mode-text">
            <span class="delegation-mode-title">${escapeHtml(tr(m.titleKey))}</span>
            <span class="delegation-mode-desc">${escapeHtml(tr(m.hintKey))}</span>
          </div>
        </label>`;
    })
    .join('');

  dom.routingDelegationMode
    .querySelectorAll<HTMLInputElement>('input[name="routing-delegation-mode"]')
    .forEach((radio) => {
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        state.routingDraftDirty = true;
        state.routingDraftDelegation = radio.value as OrchestratorDelegationMode;
        dom.routingDelegationMode.querySelectorAll('.delegation-mode-pill').forEach((pill) => {
          pill.classList.toggle('is-active', pill.contains(radio));
        });
        renderRoutingSummaryChips();
      });
    });
}

export function renderTaskRoutingMatrix(enabledProviders: ProviderDescriptor[]): void {
  const taskKeys: Record<TaskRoutingCategory, { title: I18nKey; hint: I18nKey }> = {
    complex: { title: 'routing.task.complex', hint: 'routing.task.complexHint' },
    coding: { title: 'routing.task.coding', hint: 'routing.task.codingHint' },
    frontend: { title: 'routing.task.frontend', hint: 'routing.task.frontendHint' },
    review: { title: 'routing.task.review', hint: 'routing.task.reviewHint' },
    research: { title: 'routing.task.research', hint: 'routing.task.researchHint' },
    batch: { title: 'routing.task.batch', hint: 'routing.task.batchHint' },
  };

  const allProviders =
    state.latestProviderConfig?.providers || state.latestSnapshot?.providerConfig?.providers || enabledProviders;
  const dshDescriptor =
    allProviders.find((p) => p.id === 'dsh') || enabledProviders.find((p) => p.id === 'dsh');

  dom.routingTaskMatrix.innerHTML = '';
  for (const cat of TASK_ROUTING_ORDER) {
    const targets = state.routingDraftTasks.get(cat) || [];
    const existingKeys = new Set(targets.map((t) => `${t.provider}::${t.model || ''}`));
    const row = document.createElement('div');
    row.className = 'task-routing-row';

    const chipsHtml =
      targets.length > 0
        ? targets
            .map((t, idx) => {
              const provDesc = enabledProviders.find((p) => p.id === t.provider);
              let isStale = !provDesc;
              if (provDesc && t.model?.trim()) {
                const selectable = getSelectableModelsForProvider(provDesc);
                if (selectable.length > 0 && !selectable.includes(t.model)) {
                  if (provDesc.id === 'dsh') {
                    const targetParts = splitDshUiModel(t.model, provDesc);
                    const matchedDsh = selectable.some((cand) => {
                      const candParts = splitDshUiModel(cand, provDesc);
                      return (
                        candParts.shortModel === targetParts.shortModel &&
                        (candParts.group || '') === (targetParts.group || '')
                      );
                    });
                    if (!matchedDsh) isStale = true;
                  } else {
                    isStale = true;
                  }
                }
              }
              const split =
                t.provider === 'dsh' && t.model && dshDescriptor
                  ? splitDshUiModel(t.model, dshDescriptor)
                  : null;
              const subProvHtml = split?.group
                ? `<span class="task-route-subprov">${escapeHtml(split.group)}</span>`
                : '';
              const labelModel = split?.group
                ? split.shortModel
                : t.model || tr('settings.defaultTag');
              const effModelForCaps = t.model?.trim() || provDesc?.defaultModel;
              const supportsEffort = providerSupportsReasoningEffort(t.provider, provDesc);
              const supportsFast = providerSupportsFastMode(t.provider, provDesc);
              const effortOptions = supportsEffort
                ? getReasoningEffortOptionsForModel(provDesc, effModelForCaps)
                : [];
              const optParts = [
                t.reasoningEffort ? `effort=${t.reasoningEffort}` : '',
                t.fastMode === true ? 'fast=on' : t.fastMode === false ? 'fast=off' : '',
              ].filter(Boolean);
              const baseTitle = `${t.provider}${t.model ? ` / ${t.model}` : ''}${optParts.length ? ` (${optParts.join(', ')})` : ''}`;
              const chipTitle = isStale ? `${baseTitle} — ${tr('routing.taskStaleHint')}` : baseTitle;
              const effortSelectHtml = supportsEffort
                ? `<select class="task-route-mini-select" data-task-effort="${idx}" aria-label="${escapeHtml(tr('cmd.workerEffortLabel'))}">${buildReasoningEffortOptionsHtml({
                    efforts: effortOptions,
                    value: t.reasoningEffort,
                    emptyLabel: tr('routing.effortDefault'),
                  })}</select>`
                : '';
              const fastBtnHtml = supportsFast
                ? renderFastTogglePillHtml(t.fastMode, `data-task-fast="${idx}"`)
                : '';
              return `
              <span class="task-route-chip${isStale ? ' is-stale' : ''}" title="${escapeHtml(chipTitle)}">
                <span class="provider-badge ${providerBadgeClass(t.provider)}">${escapeHtml(t.provider)}</span>
                ${subProvHtml}
                <code>${escapeHtml(labelModel)}</code>
                ${effortSelectHtml}
                ${fastBtnHtml}
                ${isStale ? '<span class="task-route-stale-mark">(!)</span>' : ''}
                <button type="button" class="model-chip-rm" data-task-rm="${idx}" aria-label="Remove">×</button>
              </span>`;
            })
            .join('')
        : `<span class="task-route-empty">${escapeHtml(tr('routing.taskFallbackHint'))}</span>`;

    const groupsHtml = enabledProviders
      .map((p) => {
        const defModel = p.defaultModel?.trim() || '';
        const modelCandidates = getSelectableModelsForProvider(p);
        if (modelCandidates.length === 0) {
          const defaultOptKey = `${p.id}::`;
          const defaultOptDisabled = existingKeys.has(defaultOptKey) ? 'disabled' : '';
          const defaultText =
            defModel && defModel !== 'default'
              ? `${p.id} (${tr('settings.defaultTag')}: ${defModel})`
              : `${p.id} (${tr('settings.defaultTag')})`;
          return `<optgroup label="${escapeHtml(p.displayName)} (${escapeHtml(p.id)})"><option value="${escapeHtml(defaultOptKey)}" ${defaultOptDisabled}>${escapeHtml(defaultText)}</option></optgroup>`;
        }
        if (p.id === 'dsh') {
          const grouped = groupDshModelsForUi(modelCandidates, p);
          if (grouped.hasNamedGroups) {
            const defaultMp = p.modelProvider?.trim() || p.detectedModelProvider?.trim() || '';
            return grouped.groups
              .map((g) => {
                const opts = g.items
                  .map((item) => {
                    const key = `${p.id}::${item.full}`;
                    const disabled = existingKeys.has(key) ? 'disabled' : '';
                    const isDef =
                      Boolean(defModel) &&
                      (item.full === defModel ||
                        (item.short === defModel && (!defaultMp || g.group === defaultMp)));
                    const baseLabel = g.group
                      ? `${g.group} / ${item.short}`
                      : `${p.id} / ${item.short}`;
                    return `<option value="${escapeHtml(key)}" ${disabled}>${escapeHtml(isDef ? `${baseLabel} ★` : baseLabel)}</option>`;
                  })
                  .join('');
                const groupLabel = g.group
                  ? `DSH · ${g.group}`
                  : `${p.displayName} (${p.id}) · ${g.label}`;
                return `<optgroup label="${escapeHtml(groupLabel)}">${opts}</optgroup>`;
              })
              .join('');
          }
        }
        const modelOpts = modelCandidates
          .map((m) => {
            const key = `${p.id}::${m}`;
            const disabled = existingKeys.has(key) ? 'disabled' : '';
            const baseLabel = `${p.id} / ${m}`;
            const isDef = Boolean(defModel) && m === defModel;
            return `<option value="${escapeHtml(key)}" ${disabled}>${escapeHtml(isDef ? `${baseLabel} ★` : baseLabel)}</option>`;
          })
          .join('');
        return `<optgroup label="${escapeHtml(p.displayName)} (${escapeHtml(p.id)})">${modelOpts}</optgroup>`;
      })
      .join('');

    row.innerHTML = `
      <div class="task-routing-top">
        <div class="task-routing-info">
          <span class="task-routing-name">${escapeHtml(tr(taskKeys[cat].title))}</span>
          <span class="task-routing-hint">${escapeHtml(tr(taskKeys[cat].hint))}</span>
        </div>
        <select class="input input-sm task-route-select" aria-label="${escapeHtml(tr(taskKeys[cat].title))}">
          <option value="">${escapeHtml(tr('routing.taskSelectPlaceholder'))}</option>
          ${groupsHtml}
        </select>
      </div>
      <div class="task-route-chips">${chipsHtml}</div>
    `;

    row.querySelectorAll<HTMLButtonElement>('[data-task-rm]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.taskRm);
        const next = targets.filter((_, i) => i !== idx);
        if (next.length > 0) state.routingDraftTasks.set(cat, next);
        else state.routingDraftTasks.delete(cat);
        state.routingDraftDirty = true;
        renderTaskRoutingMatrix(enabledProviders);
        renderRoutingSummaryChips();
      });
    });

    row.querySelectorAll<HTMLSelectElement>('[data-task-effort]').forEach((effSel) => {
      effSel.addEventListener('change', () => {
        const idx = Number(effSel.dataset.taskEffort);
        const cur = targets[idx];
        if (!cur) return;
        const val = sanitizeReasoningEffort(effSel.value);
        const nextItem = { ...cur };
        if (val) nextItem.reasoningEffort = val;
        else delete nextItem.reasoningEffort;
        const next = targets.map((item, i) => (i === idx ? nextItem : item));
        state.routingDraftTasks.set(cat, next);
        state.routingDraftDirty = true;
        renderTaskRoutingMatrix(enabledProviders);
        renderRoutingSummaryChips();
      });
    });

    row.querySelectorAll<HTMLButtonElement>('[data-task-fast]').forEach((fastBtn) => {
      fastBtn.addEventListener('click', () => {
        const idx = Number(fastBtn.dataset.taskFast);
        const cur = targets[idx];
        if (!cur) return;
        const nextFast = cycleTriStateFast(cur.fastMode);
        const nextItem = { ...cur };
        if (typeof nextFast === 'boolean') nextItem.fastMode = nextFast;
        else delete nextItem.fastMode;
        const next = targets.map((item, i) => (i === idx ? nextItem : item));
        state.routingDraftTasks.set(cat, next);
        state.routingDraftDirty = true;
        renderTaskRoutingMatrix(enabledProviders);
        renderRoutingSummaryChips();
      });
    });

    const selectEl = row.querySelector<HTMLSelectElement>('.task-route-select');
    selectEl?.addEventListener('change', () => {
      const rawVal = selectEl.value;
      if (!rawVal) return;
      const sep = rawVal.indexOf('::');
      const provider = (sep >= 0 ? rawVal.slice(0, sep) : rawVal).trim().toLowerCase();
      const model = sep >= 0 ? rawVal.slice(sep + 2).trim() || undefined : undefined;
      if (!provider) return;
      const key = `${provider}::${model || ''}`;
      if (!existingKeys.has(key)) {
        state.routingDraftTasks.set(cat, [...targets, { provider, ...(model ? { model } : {}) }]);
        state.routingDraftDirty = true;
      }
      selectEl.value = '';
      renderTaskRoutingMatrix(enabledProviders);
      renderRoutingSummaryChips();
    });

    dom.routingTaskMatrix.appendChild(row);
  }
}

export function renderSettingsRoutingCard(cfg: ProvidersConfigSnapshot): void {
  if (!state.routingDraftSynced) {
    state.routingDraftSynced = true;
    state.routingPoolsAutoInit = false;
    state.routingDraftActive.clear();
    state.routingDraftWriter.clear();
    state.routingDraftReader.clear();
    state.routingDraftTasks.clear();
    for (const id of cfg.activePool || []) state.routingDraftActive.add(id);
    for (const id of cfg.routingPolicy?.writerProviders || []) state.routingDraftWriter.add(id);
    for (const id of cfg.routingPolicy?.readerProviders || []) state.routingDraftReader.add(id);
    dom.routingAutoFailover.checked = Boolean(cfg.routingPolicy?.autoFailover);
    state.routingDraftDelegation = cfg.routingPolicy?.delegationMode || 'balanced';
    for (const cat of TASK_ROUTING_ORDER) {
      const list = cfg.routingPolicy?.taskRouting?.[cat];
      if (list && list.length > 0) {
        state.routingDraftTasks.set(
          cat,
          list.map((t) => ({ ...t })),
        );
      }
    }
    state.routingDraftNotes = cfg.routingPolicy?.routingNotes || '';
    dom.routingNotesInput.value = state.routingDraftNotes;
    state.routingDraftTurnTimeout =
      cfg.defaultTurnTimeoutSeconds !== undefined ? String(cfg.defaultTurnTimeoutSeconds) : '';
    state.routingDraftStallTimeout =
      cfg.defaultStallTimeoutSeconds !== undefined ? String(cfg.defaultStallTimeoutSeconds) : '';
    dom.routingTurnTimeoutInput.value = state.routingDraftTurnTimeout;
    dom.routingStallTimeoutInput.value = state.routingDraftStallTimeout;
  }

  const enabled = cfg.providers.filter((p) => p.enabled);
  const enabledIds = new Set(enabled.map((p) => p.id));
  for (const id of [...state.routingDraftActive]) {
    if (!enabledIds.has(id)) state.routingDraftActive.delete(id);
  }
  for (const id of [...state.routingDraftWriter]) {
    if (!enabledIds.has(id)) state.routingDraftWriter.delete(id);
  }
  for (const id of [...state.routingDraftReader]) {
    if (!enabledIds.has(id)) state.routingDraftReader.delete(id);
  }
  renderRoutingSummaryChips();
  dom.routingPoolsSingleHint.classList.toggle('hidden', enabled.length >= 2);
  if (!state.routingPoolsAutoInit) {
    state.routingPoolsAutoInit = true;
    const hasPoolSettings =
      state.routingDraftActive.size > 0 ||
      state.routingDraftWriter.size > 0 ||
      state.routingDraftReader.size > 0 ||
      dom.routingAutoFailover.checked;
    dom.routingPoolsDetails.open = enabled.length >= 2 || hasPoolSettings;
  }

  renderCliCheckboxGrid(dom.routingActivePool, enabled, state.routingDraftActive, (id, on) => {
    state.routingDraftDirty = true;
    if (on) state.routingDraftActive.add(id);
    else state.routingDraftActive.delete(id);
    renderRoutingSummaryChips();
  });
  renderCliCheckboxGrid(dom.routingWriterPool, enabled, state.routingDraftWriter, (id, on) => {
    state.routingDraftDirty = true;
    if (on) state.routingDraftWriter.add(id);
    else state.routingDraftWriter.delete(id);
  });
  renderCliCheckboxGrid(dom.routingReaderPool, enabled, state.routingDraftReader, (id, on) => {
    state.routingDraftDirty = true;
    if (on) state.routingDraftReader.add(id);
    else state.routingDraftReader.delete(id);
  });
  renderDelegationModeControls();
  renderTaskRoutingMatrix(enabled);
}

export function renderSettingsView(): void {
  const cfg = state.latestProviderConfig;
  if (!cfg) return;

  const enabledCount = cfg.providers.filter((p) => p.enabled).length;
  dom.settingsClisCount.textContent = `${enabledCount}/${cfg.providers.length}`;

  syncProviderModelDatalists();
  renderSettingsRoutingCard(cfg);

  // Default provider select
  dom.settingsDefaultSelect.innerHTML = '';
  const autoOpt = document.createElement('option');
  autoOpt.value = '';
  autoOpt.textContent = tr('settings.autoEffective', { id: cfg.effectiveDefaultProvider });
  dom.settingsDefaultSelect.appendChild(autoOpt);

  for (const p of cfg.providers) {
    if (!p.enabled) continue;
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.displayName} (${p.id})`;
    dom.settingsDefaultSelect.appendChild(opt);
  }
  dom.settingsDefaultSelect.value = cfg.configuredDefaultProvider || '';

  // Config path meta
  const metaParts = [
    `<span>${escapeHtml(tr('settings.configFileLabel'))} <code>${escapeHtml(cfg.globalConfigPath)}</code></span>`,
  ];
  if (cfg.repoConfigExists && cfg.repoConfigPath) {
    metaParts.push(
      `<span>${escapeHtml(tr('settings.repoOverrideNote', { path: cfg.repoConfigPath }))}</span>`,
    );
  }
  dom.settingsMetaEl.innerHTML = metaParts.join('');

  // Provider cards
  dom.settingsProvidersList.innerHTML = '';
  for (const p of cfg.providers) {
    const expanded = state.settingsExpanded.has(p.id);
    if (!state.settingsDraftModels.has(p.id)) {
      state.settingsDraftModels.set(p.id, [...p.configuredModels]);
    }
    const card = document.createElement('div');
    card.className = `provider-card${expanded ? ' is-expanded' : ''}${p.enabled ? '' : ' is-disabled'}`;

    const isEffectiveDefault = cfg.effectiveDefaultProvider === p.id;
    const cmdText = p.resolvedPath ? `${p.command} → ${p.resolvedPath}` : p.command;
    const draftNow = state.settingsDraftModels.get(p.id) || [];
    const candidateCount = Array.from(
      new Set([...draftNow, ...p.configuredModels, ...(p.detectedModels || [])]),
    ).length;
    const isDiscovering = state.discoveringProviders.has(p.id);
    const modelFilterVal = state.settingsModelFilters.get(p.id) || '';

    const testRes = state.settingsTestResults.get(p.id);
    const isTesting = state.testingProviders.has(p.id);
    const cooldownEntry = cfg.cooldowns?.[p.id];
    const cooldownRemainMs = cooldownEntry ? Date.parse(cooldownEntry.until) - Date.now() : 0;
    const cooldownBadgeHtml =
      cooldownRemainMs > 0
        ? `<button type="button" class="badge badge-warning badge-clickable" data-clear-cooldown="${escapeHtml(p.id)}" title="${escapeHtml(tr('settings.cooldownClearHint', { reason: cooldownEntry?.reason || '' }))}">⏳ ${escapeHtml(tr('settings.cooldownBadge', { mins: Math.max(1, Math.ceil(cooldownRemainMs / 60000)) }))} ×</button>`
        : '';

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
            ${cooldownBadgeHtml}
          </div>
          <div class="provider-sub">
            <span><code>${escapeHtml(cmdText)}</code></span>
            <span>${escapeHtml(tr('workers.model'))}: <code>${escapeHtml(p.defaultModel || 'default')}</code>${renderModelOptionBadgesHtml(p.defaultReasoningEffort, p.defaultFastMode)}</span>
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
      ${renderProviderStatusBannerHtml(p, testRes)}
    `;

    if (expanded) {
      const detectedMpList =
        p.id === 'dsh'
          ? Array.from(
              new Set(
                [
                  ...(p.detectedModelProviders || []),
                  ...(p.detectedModelProvider ? [p.detectedModelProvider] : []),
                  ...(p.modelProvider ? [p.modelProvider] : []),
                ].filter(Boolean),
              ),
            )
          : [];
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
            providerSupportsReasoningEffort(p.id, p)
              ? `
          <label class="settings-field">
            <span>${escapeHtml(tr('settings.defaultEffortLabel'))}</span>
            <select class="input input-sm" data-field="defaultReasoningEffort">${buildReasoningEffortOptionsHtml({
              efforts: getReasoningEffortOptionsForModel(
                p,
                p.configuredDefaultModel || p.defaultModel,
              ),
              value: p.configuredDefaultReasoningEffort,
              emptyLabel: getEffortFollowLabel(p),
            })}</select>
          </label>`
              : ''
          }
          ${
            providerSupportsFastMode(p.id, p)
              ? `
          <label class="settings-field">
            <span>${escapeHtml(tr('settings.fastModeLabel'))}</span>
            <select class="input input-sm" data-field="defaultFastMode">${buildFastModeOptionsHtml({
              value: boolToFastDraft(p.configuredDefaultFastMode),
              emptyLabel: getFastFollowLabel(p),
            })}</select>
          </label>`
              : ''
          }
          ${
            p.id === 'dsh'
              ? `
            <label class="settings-field">
              <span>${escapeHtml(tr('settings.dshProfileLabel'))}</span>
              <input class="input input-sm mono-input" type="text" data-field="profile" value="${escapeHtml(p.configuredProfile || 'headless')}" />
            </label>
            <label class="settings-field">
              <span>${escapeHtml(tr('settings.dshModelProviderLabel'))}</span>
              <input class="input input-sm mono-input" type="text" list="dl-dsh-mp-${escapeHtml(p.id)}" data-field="modelProvider" value="${escapeHtml(p.modelProvider || '')}" placeholder="${escapeHtml(p.detectedModelProvider ? `${p.detectedModelProvider} (auto)` : tr('settings.dshModelProviderPlaceholder'))}" />
              <datalist id="dl-dsh-mp-${escapeHtml(p.id)}">${detectedMpList.map((mp) => `<option value="${escapeHtml(mp)}"></option>`).join('')}</datalist>
              ${
                detectedMpList.length > 0
                  ? `<div class="dsh-mp-picks"><span>${escapeHtml(tr('settings.detectedModelProvidersHint'))}</span>${detectedMpList
                      .map(
                        (mp) =>
                          `<button type="button" class="dsh-mp-chip${p.modelProvider === mp ? ' is-active' : ''}" data-pick-dsh-mp="${escapeHtml(mp)}">${escapeHtml(mp)}</button>`,
                      )
                      .join('')}</div>`
                  : ''
              }
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
            </label>
            <label class="settings-field span-2">
              <span>${escapeHtml(tr('settings.listModelsArgsLabel'))}</span>
              <input class="input input-sm mono-input" type="text" data-field="listModelsArgs" value="${escapeHtml(formatArgsForInput(p.listModelsArgs))}" placeholder="${escapeHtml(tr('settings.listModelsArgsPlaceholder'))}" />
            </label>
            <label class="settings-field span-2">
              <span>${escapeHtml(tr('settings.envLabel'))}</span>
              <textarea class="input input-sm mono-input cmd-textarea" rows="2" data-field="env" placeholder="${escapeHtml(tr('settings.envPlaceholder'))}">${escapeHtml(formatEnvText(p.env))}</textarea>
            </label>`
              : ''
          }
        </div>

        <div class="model-picker-box">
          <div class="model-picker-head">
            <div class="model-picker-meta">
              <span class="model-picker-count"></span>
              ${p.detectedModelsSource ? `<span class="model-picker-source">${escapeHtml(tr('settings.detectedSource', { src: p.detectedModelsSource }))}</span>` : ''}
            </div>
            <div class="model-picker-actions">
              <button type="button" class="btn btn-sm btn-ghost" data-discover-models ${isDiscovering ? 'disabled' : ''}>${escapeHtml(tr(isDiscovering ? 'settings.discoveringModels' : 'settings.discoverModelsBtn'))}</button>
              <button type="button" class="btn btn-sm btn-ghost" data-select-all-models>${escapeHtml(tr('settings.selectAllModels'))}</button>
              <button type="button" class="btn btn-sm btn-ghost" data-clear-models>${escapeHtml(tr('settings.clearModels'))}</button>
            </div>
          </div>
          ${
            candidateCount > 10 || modelFilterVal
              ? `<input class="input input-sm mono-input model-filter-input" type="text" data-model-filter value="${escapeHtml(modelFilterVal)}" placeholder="${escapeHtml(tr('settings.modelFilterPlaceholder'))}" />`
              : ''
          }
          <div class="model-check-grid"></div>
          <div class="model-add-row">
            <input class="input input-sm mono-input" type="text" data-model-input placeholder="${escapeHtml(tr('settings.modelInputPlaceholder'))}" />
            <button type="button" class="btn btn-sm" data-model-add>${escapeHtml(tr('settings.addModelBtn'))}</button>
          </div>
        </div>

        <div class="provider-actions-row">
          <div class="provider-actions-left">
            ${
              p.kind === 'builtin' && p.hasOverride
                ? `<button type="button" class="btn btn-sm btn-ghost" data-reset-provider="${escapeHtml(p.id)}">${escapeHtml(tr('settings.resetBtn'))}</button>`
                : p.kind === 'custom'
                  ? `<button type="button" class="btn btn-sm btn-danger" data-delete-provider="${escapeHtml(p.id)}">${escapeHtml(tr(state.pendingDeleteProvider === p.id ? 'settings.confirmDelete' : 'settings.deleteBtn'))}</button>`
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

      const defaultModelInp = body.querySelector<HTMLInputElement>('[data-field="defaultModel"]');
      const mpInpEl =
        p.id === 'dsh' ? body.querySelector<HTMLInputElement>('[data-field="modelProvider"]') : null;
      const getEffectivePreviewProvider = (): ProviderDescriptor =>
        mpInpEl ? { ...p, modelProvider: mpInpEl.value.trim() || undefined } : p;
      defaultModelInp?.addEventListener('input', () => {
        updateCardModelChips(card, getEffectivePreviewProvider(), true);
      });

      if (p.id === 'dsh') {
        const syncMpChips = () => {
          const curMp = mpInpEl?.value.trim() || '';
          body.querySelectorAll<HTMLButtonElement>('[data-pick-dsh-mp]').forEach((chip) => {
            chip.classList.toggle('is-active', Boolean(curMp) && chip.dataset.pickDshMp === curMp);
          });
          updateCardModelChips(card, getEffectivePreviewProvider(), true);
        };
        mpInpEl?.addEventListener('input', syncMpChips);
        body.querySelectorAll<HTMLButtonElement>('[data-pick-dsh-mp]').forEach((chip) => {
          chip.addEventListener('click', (e) => {
            e.preventDefault();
            if (!mpInpEl) return;
            const picked = chip.dataset.pickDshMp || '';
            mpInpEl.value = mpInpEl.value.trim() === picked ? '' : picked;
            syncMpChips();
          });
        });
      }

      const modelFilterInp = body.querySelector<HTMLInputElement>('[data-model-filter]');
      modelFilterInp?.addEventListener('input', () => {
        state.settingsModelFilters.set(p.id, modelFilterInp.value);
        updateCardModelChips(card, p);
      });

      const modelInput = body.querySelector<HTMLInputElement>('[data-model-input]')!;
      const modelAddBtn = body.querySelector<HTMLButtonElement>('[data-model-add]')!;
      const addTypedModels = () => {
        const items = splitModelList(modelInput.value);
        if (items.length === 0) return;
        const cur = state.settingsDraftModels.get(p.id) || [];
        const next = Array.from(new Set([...cur, ...items]));
        state.settingsDraftModels.set(p.id, next);
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

      body.querySelector<HTMLButtonElement>('[data-discover-models]')?.addEventListener('click', () => {
        void discoverModelsForProvider(p.id);
      });

      body.querySelector<HTMLButtonElement>('[data-select-all-models]')?.addEventListener('click', () => {
        const cur = state.settingsDraftModels.get(p.id) || [];
        const next = Array.from(new Set([...cur, ...(p.detectedModels || [])]));
        state.settingsDraftModels.set(p.id, next);
        if (defaultModelInp && !defaultModelInp.value.trim() && p.detectedDefaultModel) {
          defaultModelInp.value = p.detectedDefaultModel;
        }
        updateCardModelChips(card, p, true);
      });

      body.querySelector<HTMLButtonElement>('[data-clear-models]')?.addEventListener('click', () => {
        state.settingsDraftModels.set(p.id, []);
        updateCardModelChips(card, p);
      });

      const saveBtn = body.querySelector<HTMLButtonElement>(`[data-save-provider="${cssEsc(p.id)}"]`);
      saveBtn?.addEventListener('click', async () => {
        const displayName = body.querySelector<HTMLInputElement>('[data-field="displayName"]')?.value.trim();
        const command = body.querySelector<HTMLInputElement>('[data-field="command"]')?.value.trim();
        const defaultModel = body.querySelector<HTMLInputElement>('[data-field="defaultModel"]')?.value.trim();
        const defaultReasoningEffort = sanitizeReasoningEffort(
          body.querySelector<HTMLSelectElement>('[data-field="defaultReasoningEffort"]')?.value,
        );
        const defaultFastMode = fastDraftToBool(
          parseFastDraftMode(
            body.querySelector<HTMLSelectElement>('[data-field="defaultFastMode"]')?.value,
          ),
        );
        const enabledInput = card.querySelector<HTMLInputElement>(`[data-toggle-enable="${cssEsc(p.id)}"]`);
        const enabled = enabledInput ? enabledInput.checked : p.enabled;
        const models = [...(state.settingsDraftModels.get(p.id) || [])];

        const nextConfig: Record<string, unknown> = {
          enabled,
          ...(displayName ? { displayName } : {}),
          ...(command ? { command } : {}),
          ...(defaultModel ? { defaultModel } : {}),
          ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
          ...(typeof defaultFastMode === 'boolean' ? { defaultFastMode } : {}),
          ...(models.length > 0 ? { models } : {}),
        };

        if (p.id === 'dsh') {
          const profileVal = body.querySelector<HTMLInputElement>('[data-field="profile"]')?.value.trim();
          const mpVal = body.querySelector<HTMLInputElement>('[data-field="modelProvider"]')?.value.trim();
          if (profileVal && profileVal !== 'headless') nextConfig.profile = profileVal;
          else if (profileVal === 'headless' && p.configuredProfile && p.configuredProfile !== 'headless') {
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
          const listModelsVal = parseArgsFromInput(
            body.querySelector<HTMLInputElement>('[data-field="listModelsArgs"]')?.value || '',
          );
          const pmVal = body.querySelector<HTMLSelectElement>('[data-field="promptMode"]')?.value as 'stdin' | 'arg';
          const ofVal = body.querySelector<HTMLSelectElement>('[data-field="outputFormat"]')?.value as 'text' | 'ndjson';
          if (argsVal) nextConfig.args = argsVal;
          if (resumeVal) nextConfig.resumeArgs = resumeVal;
          if (listModelsVal) nextConfig.listModelsArgs = listModelsVal;
          if (pmVal) nextConfig.promptMode = pmVal;
          if (ofVal) nextConfig.outputFormat = ofVal;
          const envVal = parseEnvText(
            body.querySelector<HTMLTextAreaElement>('[data-field="env"]')?.value || '',
          );
          if (envVal) nextConfig.env = envVal;
        } else if (p.env && Object.keys(p.env).length > 0) {
          nextConfig.env = p.env;
        }

        await saveProviderPatch(
          { upsert_provider: { id: p.id, config: nextConfig } },
          tr('settings.savedToast'),
          p.id,
        );
      });

      const resetBtn = body.querySelector<HTMLButtonElement>(`[data-reset-provider="${cssEsc(p.id)}"]`);
      resetBtn?.addEventListener('click', async () => {
        await saveProviderPatch(
          { upsert_provider: { id: p.id, config: null } },
          tr('settings.resetToast'),
          p.id,
        );
      });

      const delBtn = body.querySelector<HTMLButtonElement>(`[data-delete-provider="${cssEsc(p.id)}"]`);
      delBtn?.addEventListener('click', async () => {
        if (state.pendingDeleteProvider !== p.id) {
          state.pendingDeleteProvider = p.id;
          renderSettingsView();
          return;
        }
        state.pendingDeleteProvider = null;
        state.settingsExpanded.delete(p.id);
        await saveProviderPatch(
          { remove_provider: p.id },
          tr('settings.deletedToast', { id: p.id }),
          p.id,
        );
      });
    }

    const testBtn = card.querySelector<HTMLButtonElement>(`[data-test-provider="${cssEsc(p.id)}"]`);
    testBtn?.addEventListener('click', () => {
      void runProviderConnectionTest(p.id);
    });

    const clearCooldownBtn = card.querySelector<HTMLButtonElement>(
      `[data-clear-cooldown="${cssEsc(p.id)}"]`,
    );
    clearCooldownBtn?.addEventListener('click', () => {
      void saveProviderPatch(
        { clear_cooldown_provider: p.id },
        tr('settings.cooldownCleared', { id: p.id }),
      );
    });

    const enableToggle = card.querySelector<HTMLInputElement>(`[data-toggle-enable="${cssEsc(p.id)}"]`);
    enableToggle?.addEventListener('change', async () => {
      const nextCfg = buildPersistConfigFromDescriptor(p, enableToggle.checked);
      await saveProviderPatch(
        { upsert_provider: { id: p.id, config: nextCfg } },
        tr('settings.savedToast'),
      );
    });

    const expandBtn = card.querySelector<HTMLButtonElement>(`[data-toggle-expand="${cssEsc(p.id)}"]`);
    expandBtn?.addEventListener('click', () => {
      state.pendingDeleteProvider = null;
      if (state.settingsExpanded.has(p.id)) {
        state.settingsExpanded.delete(p.id);
      } else {
        state.settingsExpanded.add(p.id);
      }
      renderSettingsView();
    });

    dom.settingsProvidersList.appendChild(card);
  }

  renderPricingSection(cfg);
}

export async function runProviderConnectionTest(providerId: string): Promise<void> {
  state.testingProviders.add(providerId);
  renderSettingsView();
  if (state.onboardingVisible) renderOnboardingIfRegistered();
  try {
    const res = await app.callServerTool({
      name: 'app_test_provider',
      arguments: {
        provider_id: providerId,
        ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
        ...(state.latestSnapshot?.swarm?.repoRoot ? { repo_root: state.latestSnapshot.swarm.repoRoot } : {}),
      },
    });
    const payload = res.structuredContent as { result?: ProviderTestResult } | undefined;
    if (payload?.result) {
      state.settingsTestResults.set(providerId, payload.result);
    }
  } catch (err) {
    state.settingsTestResults.set(providerId, {
      providerId,
      command: providerId,
      ok: false,
      latencyMs: 0,
      details: err instanceof Error ? err.message : String(err),
    });
  } finally {
    state.testingProviders.delete(providerId);
    renderSettingsView();
    if (state.onboardingVisible) renderOnboardingIfRegistered();
  }
}

export async function discoverModelsForProvider(providerId: string): Promise<void> {
  state.discoveringProviders.add(providerId);
  renderSettingsView();
  if (state.onboardingVisible) renderOnboardingIfRegistered();
  try {
    const res = await app.callServerTool({
      name: 'app_discover_models',
      arguments: {
        provider_id: providerId,
        ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
        ...(state.latestSnapshot?.swarm?.repoRoot ? { repo_root: state.latestSnapshot.swarm.repoRoot } : {}),
      },
    });
    const payload = res.structuredContent as
      | { result?: DiscoverModelsResult; providerConfig?: ProvidersConfigSnapshot }
      | undefined;
    if (payload?.providerConfig) {
      state.latestProviderConfig = payload.providerConfig;
      if (state.latestSnapshot) {
        state.latestSnapshot.providerConfig = payload.providerConfig;
      }
      bridge.syncCommanderControls(true);
    }
    if (res.isError || payload?.result?.ok === false) {
      showGlobalToast(
        tr('settings.discoverFailed', {
          id: providerId,
          err: payload?.result?.error || extractToolErrorMessage(res) || 'Failed',
        }),
        true,
      );
    } else if ((payload?.result?.models?.length || 0) > 0) {
      showGlobalToast(
        tr('settings.discoverSuccess', {
          id: providerId,
          n: payload?.result?.models?.length || 0,
        }),
      );
    } else {
      showGlobalToast(tr('settings.discoverNone', { id: providerId }));
    }
  } catch (err) {
    showGlobalToast(
      tr('settings.discoverFailed', {
        id: providerId,
        err: err instanceof Error ? err.message : String(err),
      }),
      true,
    );
  } finally {
    state.discoveringProviders.delete(providerId);
    renderSettingsView();
    if (state.onboardingVisible) renderOnboardingIfRegistered();
  }
}

export function getEnabledProvidersForUi(): ProviderDescriptor[] {
  return (
    state.latestSnapshot?.providerConfig?.providers ||
    state.latestProviderConfig?.providers ||
    []
  ).filter((p) => p.enabled);
}

export function syncProviderModelDatalists(): void {
  const providers =
    state.latestSnapshot?.providerConfig?.providers || state.latestProviderConfig?.providers || [];
  dom.dynamicModelDatalists.innerHTML = '';
  for (const p of providers) {
    const dl = document.createElement('datalist');
    dl.id = `dl-prov-models-${p.id}`;
    const candidates = Array.from(
      new Set(
        [
          ...(p.configuredDefaultModel && p.configuredDefaultModel !== 'default'
            ? [p.configuredDefaultModel]
            : []),
          ...getSelectableModelsForProvider(p),
        ].filter(Boolean),
      ),
    );
    for (const m of candidates) {
      const opt = document.createElement('option');
      opt.value = m;
      dl.appendChild(opt);
    }
    dom.dynamicModelDatalists.appendChild(dl);
  }
}

export function syncAddWorkerModelDatalist(): void {
  const enabled = getEnabledProvidersForUi();
  const targetIds =
    state.addProvidersDraft.size > 0
      ? [...state.addProvidersDraft]
      : state.latestSnapshot?.swarm?.activeProviders?.length
        ? state.latestSnapshot.swarm.activeProviders
        : [state.latestSnapshot?.swarm?.defaultProvider || 'dsh'];

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
  dom.dlAddModels.innerHTML = '';
  for (const m of modelSet) {
    const opt = document.createElement('option');
    opt.value = m;
    dom.dlAddModels.appendChild(opt);
  }
  if (!dom.addWorkerModel.value.trim()) {
    dom.addWorkerModel.placeholder = firstDefault;
  }
}

/** Wire settings-pane listeners. Called once from the entrypoint. */
export function bindSettingsEvents(): void {
  dom.settingsDefaultSelect.addEventListener('change', () => {
    const val = dom.settingsDefaultSelect.value.trim();
    void saveProviderPatch(
      { default_provider: val ? val : null },
      tr('settings.savedToast'),
    );
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
      await bridge.refreshSnapshot(true);
    });
  });

  bindPricingEvents({ saveProviderPatch, showSettingsToast });

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
}
