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

export function prefillPricingModelForm(model: string): void {
  dom.pricingModelInput.value = model;
  const preferredCurrency = state.latestProviderConfig?.displayCurrency;
  if (preferredCurrency === 'CNY' || preferredCurrency === 'USD') {
    dom.pricingCurrencySelect.value = preferredCurrency;
  }
  dom.pricingInputRate.focus();
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
  const cu = state.latestSnapshot?.coordinatorUsage;
  if (cu) {
    for (const m of Object.keys(cu.byModelSession || {})) knownModels.add(m);
    for (const m of Object.keys(cu.byModelSinceSwarm || {})) knownModels.add(m);
  }
  for (const m of Object.values(state.latestSnapshot?.swarm?.members || {})) {
    if (m.model) knownModels.add(m.model);
  }
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
      const shown = convertRateForDisplay(rate, displayOpts);
      const sym = shown.currency === 'CNY' ? '¥' : '$';
      const cacheTxt = shown.cacheReadPer1M !== undefined ? `${sym}${shown.cacheReadPer1M}` : '-';
      return `
        <div class="pricing-row">
          <div>
            <code>${escapeHtml(model)}</code>
            <span class="provider-badge">${escapeHtml(tr('pricing.sourceCustom'))}</span>
            <span class="pricing-row-rates"> · in=${sym}${shown.inputPer1M} · cache=${cacheTxt} · out=${sym}${shown.outputPer1M} / 1M</span>
          </div>
          <button type="button" class="btn btn-sm btn-ghost btn-ghost-danger" data-delete-pricing="${escapeHtml(model)}">${escapeHtml(tr('pricing.deleteBtn'))}</button>
        </div>
      `;
    })
    .join('');

  const autoRowsHtml = autoResolvedRows
    .map(({ model, matchedKey, source, rate }) => {
      const shown = convertRateForDisplay(rate, displayOpts);
      const sym = shown.currency === 'CNY' ? '¥' : '$';
      const cacheTxt = shown.cacheReadPer1M !== undefined ? `${sym}${shown.cacheReadPer1M}` : '-';
      const srcLabel = tr(source === 'catalog' ? 'pricing.sourceCatalog' : 'pricing.sourceBuiltin');
      return `
        <div class="pricing-row">
          <div>
            <code title="${escapeHtml(matchedKey)}">${escapeHtml(model)}</code>
            <span class="provider-badge" title="${escapeHtml(matchedKey)}">${escapeHtml(srcLabel)}</span>
            <span class="pricing-row-rates"> · in=${sym}${shown.inputPer1M} · cache=${cacheTxt} · out=${sym}${shown.outputPer1M} / 1M</span>
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

  dom.pricingList.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>('button');
    if (!target) return;
    const delModel = target.dataset.deletePricing;
    if (delModel) {
      void saveProviderPatch(
        { upsert_pricing: { model: delModel, pricing: null } },
        tr('settings.savedToast'),
      );
      return;
    }
    const overrideModel = target.dataset.overridePricing;
    if (overrideModel) {
      prefillPricingModelForm(overrideModel);
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
      try {
        const res = await app.callServerTool({
          name: 'app_save_provider_config',
          arguments: {
            sync_pricing_catalog: 'auto',
            ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
            ...(state.latestSnapshot?.swarm?.repoRoot
              ? { repo_root: state.latestSnapshot.swarm.repoRoot }
              : {}),
          },
        });
        if (res.isError) {
          showSettingsToast(
            tr('pricing.syncFailed', { error: extractToolErrorMessage(res) || 'sync error' }),
            true,
          );
          return;
        }
        const payload = res.structuredContent as { providerConfig?: ProvidersConfigSnapshot } | undefined;
        if (payload?.providerConfig) {
          state.latestProviderConfig = payload.providerConfig;
          renderPricingSection(payload.providerConfig);
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
    const fxVal = Number(dom.pricingFxRate.value);
    const usd_to_cny_rate =
      Number.isFinite(fxVal) && fxVal > 0 && fxVal <= 1000 ? fxVal : DEFAULT_USD_TO_CNY_RATE;
    dom.pricingFxRate.value = String(usd_to_cny_rate);
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
      await bridge.refreshSnapshot(true);
    }
  });
}
