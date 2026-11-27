/**
 * Model pricing catalog sync, unified currency controls, and custom rate editor.
 */
import * as bridge from './bridge.js';
import { tr } from './context.js';
import * as dom from './dom.js';
import {
  collectUnpricedModels,
  convertRateForDisplay,
  escapeHtml,
  resolveModelPricing,
  type CostDisplayOptions,
} from './format.js';
import { extractToolErrorMessage, withBusyButton } from './helpers.js';
import { app } from './mcp-app.js';
import { state } from './store.js';
import { DEFAULT_USD_TO_CNY_RATE, type ProvidersConfigSnapshot } from './types.js';

export interface PricingEventDeps {
  saveProviderPatch: (
    patch: Record<string, unknown>,
    successMessage: string,
    clearDraftId?: string,
  ) => Promise<boolean>;
  showSettingsToast: (message: string, isError?: boolean) => void;
}

function getDisplayCostOpts(cfg?: ProvidersConfigSnapshot | null): CostDisplayOptions {
  return {
    displayCurrency: cfg?.displayCurrency || 'AUTO',
    usdToCnyRate: cfg?.usdToCnyRate ?? DEFAULT_USD_TO_CNY_RATE,
  };
}

export function prefillPricingModelForm(model: string, prefillRates = false): void {
  dom.pricingModelInput.value = model;
  const cfg = state.latestProviderConfig || state.latestSnapshot?.providerConfig;
  const rate = prefillRates ? resolveModelPricing(model, cfg?.pricing, cfg?.pricingCatalog)?.pricing : undefined;
  const currency = rate ? rate.currency ?? 'USD' : cfg?.displayCurrency;
  if (currency === 'CNY' || currency === 'USD') {
    dom.pricingCurrencySelect.value = currency;
  }
  if (rate) {
    dom.pricingInputRate.value = String(rate.inputPer1M);
    dom.pricingOutputRate.value = String(rate.outputPer1M);
    dom.pricingCacheRate.value = rate.cacheReadPer1M === undefined ? '' : String(rate.cacheReadPer1M);
  }
  dom.pricingInputRate.focus();
}

function describePricingRates(rate: NonNullable<ProvidersConfigSnapshot['pricing']>[string], options: CostDisplayOptions): string {
  const shown = convertRateForDisplay(rate, options);
  const symbol = shown.currency === 'CNY' ? '¥' : '$';
  return tr('pricing.rateSummary', {
    input: `${symbol}${shown.inputPer1M}`,
    cache: shown.cacheReadPer1M === undefined ? '–' : `${symbol}${shown.cacheReadPer1M}`,
    output: `${symbol}${shown.outputPer1M}`,
  });
}

export function renderPricingSection(cfg: ProvidersConfigSnapshot): void {
  const entries = Object.entries(cfg.pricing || {});
  const displayOpts = getDisplayCostOpts(cfg);
  if (document.activeElement !== dom.pricingDisplayCurrency) {
    dom.pricingDisplayCurrency.value = displayOpts.displayCurrency || 'AUTO';
  }
  if (document.activeElement !== dom.pricingFxRate) {
    dom.pricingFxRate.value = String(displayOpts.usdToCnyRate ?? DEFAULT_USD_TO_CNY_RATE);
  }
  dom.btnTogglePricing.textContent = tr(state.pricingExpanded ? 'settings.collapse' : 'settings.expand');
  dom.pricingBody.classList.toggle('hidden', !state.pricingExpanded);

  if (cfg.pricingCatalogMeta) {
    const srcName = cfg.pricingCatalogMeta.source === 'openrouter' ? 'OpenRouter' : 'LiteLLM';
    let timeStr = cfg.pricingCatalogMeta.fetchedAt;
    try {
      timeStr = new Date(cfg.pricingCatalogMeta.fetchedAt).toLocaleString();
    } catch {
      // keep raw ISO string
    }
    dom.pricingCatalogStatus.textContent = tr('pricing.catalogSynced', {
      source: srcName,
      count: cfg.pricingCatalogMeta.modelCount,
      time: timeStr,
    });
  } else {
    dom.pricingCatalogStatus.textContent = tr('pricing.catalogBuiltinOnly');
  }

  const knownModels = new Set<string>();
  for (const p of cfg.providers) {
    for (const m of p.models) knownModels.add(m);
  }
  const ht = state.latestSnapshot?.hostTelemetry;
  if (ht) {
    for (const m of Object.keys(ht.coordinator.byModelSession || {})) knownModels.add(m);
    for (const m of Object.keys(ht.coordinator.byModelSinceSwarm || {})) knownModels.add(m);
    for (const m of Object.keys(ht.subagentUsage.byModelSession || {})) knownModels.add(m);
    for (const m of Object.keys(ht.subagentUsage.byModelSinceSwarm || {})) knownModels.add(m);
    for (const sub of ht.subagents || []) {
      if (sub.model && sub.model !== 'host-default') knownModels.add(sub.model);
      for (const sm of sub.models || []) knownModels.add(sm);
    }
  }
  for (const m of Object.values(state.latestSnapshot?.swarm?.members || {})) {
    const model = m.resolvedModel || m.model;
    if (model) knownModels.add(model);
  }
  knownModels.delete('default');
  dom.dlPricingModels.innerHTML = Array.from(knownModels)
    .map((m) => `<option value="${escapeHtml(m)}"></option>`)
    .join('');

  const unpriced = collectUnpricedModels(knownModels, cfg.pricing, cfg.pricingCatalog);
  dom.pricingUnpricedWrap.classList.toggle('hidden', unpriced.length === 0);
  if (unpriced.length > 0) {
    dom.pricingUnpricedChips.innerHTML = unpriced
      .map(
        (m) =>
          `<button type="button" class="pricing-unpriced-chip" data-fill-pricing-model="${escapeHtml(m)}">${escapeHtml(m)}</button>`,
      )
      .join('');
    dom.pricingUnpricedChips
      .querySelectorAll<HTMLButtonElement>('[data-fill-pricing-model]')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          const targetModel = btn.dataset.fillPricingModel;
          if (targetModel) prefillPricingModelForm(targetModel);
        });
      });
  } else {
    dom.pricingUnpricedChips.innerHTML = '';
  }

  const autoResolvedRows: Array<{
    model: string;
    matchedKey: string;
    source: 'catalog' | 'builtin';
    rate: NonNullable<ProvidersConfigSnapshot['pricing']>[string];
  }> = [];
  for (const model of knownModels) {
    const resolved = resolveModelPricing(model, cfg.pricing, cfg.pricingCatalog);
    if (resolved && resolved.source !== 'custom') {
      autoResolvedRows.push({
        model,
        matchedKey: resolved.matchedKey,
        source: resolved.source,
        rate: resolved.pricing,
      });
    }
  }

  dom.pricingCountBadge.textContent = String(entries.length + autoResolvedRows.length);

  if (entries.length === 0 && autoResolvedRows.length === 0) {
    dom.pricingList.innerHTML = `<div class="empty-state-compact" style="padding:6px 0">${escapeHtml(tr('pricing.empty'))}</div>`;
    return;
  }

  const customRowsHtml = entries
    .map(([model, rate]) => {
      return `
        <div class="pricing-row">
          <div>
            <code>${escapeHtml(model)}</code>
            <span class="provider-badge">${escapeHtml(tr('pricing.sourceCustom'))}</span>
            <span class="pricing-row-rates"> · ${escapeHtml(describePricingRates(rate, displayOpts))}</span>
          </div>
          <button type="button" class="btn btn-sm btn-ghost btn-ghost-danger" data-delete-pricing="${escapeHtml(model)}">${escapeHtml(tr('pricing.deleteBtn'))}</button>
        </div>
      `;
    })
    .join('');

  const autoRowsHtml = autoResolvedRows
    .map(({ model, matchedKey, source, rate }) => {
      const srcLabel = tr(source === 'catalog' ? 'pricing.sourceCatalog' : 'pricing.sourceBuiltin');
      return `
        <div class="pricing-row">
          <div>
            <code title="${escapeHtml(matchedKey)}">${escapeHtml(model)}</code>
            <span class="provider-badge" title="${escapeHtml(matchedKey)}">${escapeHtml(srcLabel)}</span>
            <span class="pricing-row-rates"> · ${escapeHtml(describePricingRates(rate, displayOpts))}</span>
          </div>
          <button type="button" class="btn btn-sm btn-ghost" data-override-pricing="${escapeHtml(model)}">${escapeHtml(tr('pricing.overrideBtn'))}</button>
        </div>
      `;
    })
    .join('');

  dom.pricingList.innerHTML = customRowsHtml + autoRowsHtml;
}

export function bindPricingEvents(deps: PricingEventDeps): void {
  const { saveProviderPatch, showSettingsToast } = deps;

  dom.pricingList.addEventListener('click', async (e) => {
    const target = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>('button');
    if (!target) return;
    const delModel = target.dataset.deletePricing;
    if (delModel) {
      const removed = await saveProviderPatch(
        { upsert_pricing: { model: delModel, pricing: null } },
        tr('settings.savedToast'),
      );
      if (removed) await bridge.refreshSnapshot(true);
      return;
    }
    const overrideModel = target.dataset.overridePricing;
    if (overrideModel) {
      prefillPricingModelForm(overrideModel, true);
    }
  });

  dom.btnTogglePricing.addEventListener('click', () => {
    state.pricingExpanded = !state.pricingExpanded;
    if (state.latestProviderConfig) {
      renderPricingSection(state.latestProviderConfig);
    }
  });

  dom.btnSyncPricing.addEventListener('click', () => {
    void withBusyButton(dom.btnSyncPricing, async () => {
      const swarmId = state.currentSwarmId;
      try {
        const res = await app.callServerTool({
          name: 'app_save_provider_config',
          arguments: {
            sync_pricing_catalog: 'auto',
            ...(swarmId ? { swarm_id: swarmId } : {}),
            ...(state.latestSnapshot?.swarm && state.latestSnapshot.swarm.id === swarmId
              ? { repo_root: state.latestSnapshot.swarm.repoRoot }
              : {}),
          },
        });
        if (res.isError) {
          showSettingsToast(
            tr('pricing.syncFailed', { error: extractToolErrorMessage(res) || tr('common.operationFailed') }),
            true,
          );
          return;
        }
        const payload = res.structuredContent as { providerConfig?: ProvidersConfigSnapshot } | undefined;
        if (payload?.providerConfig) {
          if (swarmId === state.currentSwarmId) {
            ++state.providerConfigRevision;
            state.latestProviderConfig = payload.providerConfig;
            if (state.latestSnapshot) state.latestSnapshot.providerConfig = payload.providerConfig;
            bridge.syncCommanderControls(true);
            renderPricingSection(payload.providerConfig);
          }
          const meta = payload.providerConfig.pricingCatalogMeta;
          if (!meta || meta.modelCount <= 0) {
            showSettingsToast(tr('pricing.syncStaleServer'), true);
            return;
          }
          const srcName = meta.source === 'openrouter' ? 'OpenRouter' : 'LiteLLM';
          showSettingsToast(
            tr('pricing.syncedToast', { source: srcName, count: meta.modelCount }),
          );
        }
        await bridge.refreshSnapshot(true);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showSettingsToast(tr('pricing.syncFailed', { error: msg }), true);
      }
    });
  });

  const saveCurrencySettings = async () => {
    const rawCurrency = dom.pricingDisplayCurrency.value;
    const display_currency =
      rawCurrency === 'CNY' || rawCurrency === 'USD' ? rawCurrency : 'AUTO';
    const usd_to_cny_rate = Number(dom.pricingFxRate.value);
    if (!Number.isFinite(usd_to_cny_rate) || usd_to_cny_rate <= 0 || usd_to_cny_rate > 1000) {
      showSettingsToast(tr('pricing.invalidFxRate'), true);
      return;
    }
    const ok = await saveProviderPatch(
      { display_currency, usd_to_cny_rate },
      tr('settings.savedToast'),
    );
    if (ok) {
      await bridge.refreshSnapshot(true);
    }
  };
  dom.pricingDisplayCurrency.addEventListener('change', () => {
    void saveCurrencySettings();
  });
  dom.pricingFxRate.addEventListener('change', () => {
    void saveCurrencySettings();
  });

  dom.pricingForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const model = dom.pricingModelInput.value.trim();
    const inputVal = dom.pricingInputRate.value.trim();
    const outputVal = dom.pricingOutputRate.value.trim();
    const inputPer1M = Number(inputVal);
    const outputPer1M = Number(outputVal);
    const cacheVal = dom.pricingCacheRate.value.trim();
    const cacheReadPer1M = cacheVal ? Number(cacheVal) : undefined;
    const currency = dom.pricingCurrencySelect.value === 'CNY' ? 'CNY' : 'USD';
    if (
      !model ||
      !inputVal ||
      !outputVal ||
      dom.pricingCacheRate.validity.badInput ||
      [inputPer1M, outputPer1M, cacheReadPer1M ?? 0].some((rate) => !Number.isFinite(rate) || rate < 0)
    ) {
      showSettingsToast(tr('pricing.invalidRates'), true);
      return;
    }

    const ok = await saveProviderPatch(
      {
        upsert_pricing: {
          model,
          pricing: {
            inputPer1M,
            outputPer1M,
            currency,
            ...(cacheReadPer1M !== undefined ? { cacheReadPer1M } : {}),
          },
        },
      },
      tr('settings.savedToast'),
    );
    if (ok) {
      dom.pricingForm.reset();
      await bridge.refreshSnapshot(true);
    }
  });
}
