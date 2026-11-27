/**
 * Token/cache telemetry, gauges and pricing section.
 *
 * Extracted verbatim from the former monolithic `ui/app.ts`; identifiers are
 * bound as follows:
 *   state  -> `store.ts`    (shared mutable UI state)
 *   dom    -> `dom.ts`      (typed DOM refs)
 *   bridge -> `bridge.ts`   (callbacks still owned by the entrypoint)
 * This keeps the module graph acyclic: views never import `app.ts`.
 */
import {
  animateNumber,
  buildGaugeCardHtml,
  getDisplayModelForMember,
  renderModelOptionBadgesHtml,
  renderSwarmBudgetBanner,
} from './helpers.js';
import { prefillPricingModelForm, renderPricingSection } from './pricing-view.js';
import { switchSettingsSubtab } from './settings-view.js';
import { tr } from './context.js';
import { state } from './store.js';
import * as dom from './dom.js';
import {
  calcInputCacheHit,
  calcMemberCostValue,
  calcModelCostValue,
  escapeHtml,
  formatMoney,
  formatNum,
  sumMembersCost,
  sumModelMapCost,
  type CostDisplayOptions,
  type CostSource,
} from './format.js';
import { computeTelemetrySummary } from './telemetry-selectors.js';
import type { Snapshot } from './types.js';
import * as bridge from './bridge.js';

function costSourceTitle(source: CostSource): string {
  switch (source) {
    case 'reported':
      return tr('pricing.sourceReported');
    case 'catalog':
      return tr('pricing.sourceCatalog');
    case 'builtin':
      return tr('pricing.sourceBuiltin');
    case 'custom':
      return tr('pricing.sourceCustom');
  }
}

export function renderUsageView(snap: Snapshot, prevSnap: Snapshot | null): void {
  const ht = snap.hostTelemetry;
  const conversations = ht?.availableConversations || [];
  const providerCfg = snap.providerConfig || state.latestProviderConfig;
  const pricingMap = providerCfg?.pricing;
  const catalogPricing = providerCfg?.pricingCatalog;
  const displayOpts: CostDisplayOptions = {
    displayCurrency: providerCfg?.displayCurrency,
    usdToCnyRate: providerCfg?.usdToCnyRate,
  };
  dom.convSelect.innerHTML = '';
  if (conversations.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = tr('usage.noConvLogs');
    dom.convSelect.appendChild(opt);
    dom.convSelect.disabled = true;
  } else {
    dom.convSelect.disabled = false;
    for (const c of conversations) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent =
        c.subagentCount > 0
          ? `${c.title} · ${tr('usage.convSubCount', { n: c.subagentCount })}`
          : c.title;
      dom.convSelect.appendChild(opt);
    }
    if (ht?.conversationId) {
      dom.convSelect.value = ht.conversationId;
    }
  }

  const swarm = snap.swarm;
  renderSwarmBudgetBanner(dom.usageBudgetBanner, snap, bridge.updateSwarmBudgetFromUi);

  const summary = computeTelemetrySummary(snap, state.usageScope);
  const prevSummary = prevSnap ? computeTelemetrySummary(prevSnap, state.usageScope) : null;
  const effectiveScope: 'swarm' | 'session' = swarm ? state.usageScope : 'session';
  const hasNative = summary.nativeAll.length > 0;

  const agyCostText = sumModelMapCost(summary.coordinatorByModel, pricingMap, catalogPricing, displayOpts);
  const nativeCostText = sumModelMapCost(summary.nativeByModel, pricingMap, catalogPricing, displayOpts);
  const workerCostText = sumMembersCost(summary.externalMembers, pricingMap, catalogPricing, displayOpts);

  const prevAgyPct = state.prevGaugePcts.get('agy');
  const prevNativePct = state.prevGaugePcts.get('native');
  const prevDshPct = state.prevGaugePcts.get('dsh');

  const agyModelCount = Object.keys(summary.coordinatorByModel).length;
  const baseSub =
    effectiveScope === 'swarm' && swarm ? tr('usage.agySubSwarm') : tr('usage.agySubSession');
  const nativeScopedList =
    effectiveScope === 'swarm' && swarm ? summary.nativeCurrent : summary.nativeAll;

  dom.usageHero.classList.toggle('has-three', hasNative);
  dom.usageHero.innerHTML =
    buildGaugeCardHtml({
      idPrefix: 'usage-agy',
      title: agyModelCount > 1 ? tr('usage.agyTitleMulti') : tr('usage.agyTitle'),
      subtitle:
        agyModelCount > 1
          ? tr('usage.agySubModels', { scope: baseSub, n: agyModelCount })
          : baseSub,
      breakdown: summary.coordinator,
      variant: 'agy',
      costText: agyCostText,
      prevPct: prevAgyPct,
    }) +
    (hasNative
      ? buildGaugeCardHtml({
          idPrefix: 'usage-native',
          title: tr('usage.nativeTitle'),
          subtitle: tr('usage.nativeCount', {
            n: nativeScopedList.length,
            running: summary.nativeRunning,
          }),
          breakdown: summary.native,
          variant: 'native',
          costText: nativeCostText,
          prevPct: prevNativePct,
        })
      : '') +
    buildGaugeCardHtml({
      idPrefix: 'usage-dsh',
      title: tr('usage.workersTitleMulti'),
      subtitle: tr('usage.workersCount', { n: summary.externalCount }),
      breakdown: summary.external,
      variant: 'dsh',
      costText: workerCostText,
      prevPct: prevDshPct,
    });

  if (
    (prevAgyPct !== undefined && prevAgyPct !== summary.coordinator.cacheHitRate) ||
    (hasNative && prevNativePct !== undefined && prevNativePct !== summary.native.cacheHitRate) ||
    (prevDshPct !== undefined && prevDshPct !== summary.external.cacheHitRate)
  ) {
    window.requestAnimationFrame(() => {
      dom.usageHero
        .querySelectorAll<SVGCircleElement>('.gauge-ring-fill[data-target-offset]')
        .forEach((circle) => {
          circle.style.strokeDashoffset = circle.dataset.targetOffset || '0';
        });
    });
  }
  state.prevGaugePcts.set('agy', summary.coordinator.cacheHitRate);
  if (hasNative) state.prevGaugePcts.set('native', summary.native.cacheHitRate);
  state.prevGaugePcts.set('dsh', summary.external.cacheHitRate);

  animateNumber(
    document.getElementById('usage-agy-total'),
    prevSummary?.coordinator.totalTokens || 0,
    summary.coordinator.totalTokens,
    formatNum,
  );
  if (hasNative) {
    animateNumber(
      document.getElementById('usage-native-total'),
      prevSummary?.native.totalTokens || 0,
      summary.native.totalTokens,
      formatNum,
    );
  }
  animateNumber(
    document.getElementById('usage-dsh-total'),
    prevSummary?.external.totalTokens || 0,
    summary.external.totalTokens,
    formatNum,
  );

  const combined = summary.combinedTotalTokens;
  const dshShare =
    combined > 0 ? Math.round((summary.external.totalTokens / combined) * 1000) / 10 : 0;
  const nativeShare =
    combined > 0 && hasNative
      ? Math.round((summary.native.totalTokens / combined) * 1000) / 10
      : 0;
  const agyShare =
    combined > 0 ? Math.max(0, Math.round((100 - dshShare - nativeShare) * 10) / 10) : 0;

  dom.usageSplit.innerHTML = `
    <div class="split-header">
      <span>${escapeHtml(tr('usage.splitHeader'))}</span>
      <span>${escapeHtml(tr('usage.splitTotal', { total: formatNum(combined) }))}</span>
    </div>
    <div class="split-bar">
      <div class="split-seg-dsh" style="width:${dshShare}%"></div>
      ${hasNative ? `<div class="split-seg-native" style="width:${nativeShare}%"></div>` : ''}
      <div class="split-seg-agy" style="width:${agyShare}%"></div>
    </div>
    <div class="split-legend">
      <span>${escapeHtml(tr('usage.splitWorkers'))}<strong>${dshShare}%</strong> (${formatNum(summary.external.totalTokens)})${workerCostText ? ` · ${escapeHtml(workerCostText)}` : ''}</span>
      ${hasNative ? `<span>${escapeHtml(tr('usage.splitNative'))}<strong>${nativeShare}%</strong> (${formatNum(summary.native.totalTokens)})${nativeCostText ? ` · ${escapeHtml(nativeCostText)}` : ''}</span>` : ''}
      <span>${escapeHtml(tr('usage.splitAgy'))}<strong>${agyShare}%</strong> (${formatNum(summary.coordinator.totalTokens)})${agyCostText ? ` · ${escapeHtml(agyCostText)}` : ''}</span>
    </div>
  `;

  const unpricedSet = new Set<string>();
  const agyModelEntries = Object.entries(summary.coordinatorByModel).sort(
    (a, b) => b[1].totalTokens - a[1].totalTokens,
  );
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
              catalogPricing,
              displayOpts,
            );
            if (!c && modelName.trim()) {
              unpricedSet.add(modelName.trim());
            }
            return `
            <div class="detail-row">
              <div class="detail-row-top">
                <span>${escapeHtml(modelName)}</span>
                <span>${formatNum(st.totalTokens)}${c ? ` · <span class="usage-cost-pill" title="${escapeHtml(costSourceTitle(c.source))}">${escapeHtml(formatMoney(c.amount, c.currency))}</span>` : ''}</span>
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

  const nativeRowsHtml =
    nativeScopedList.length === 0
      ? `<div class="empty-state-compact">${escapeHtml(tr('usage.nativeDetailEmpty'))}</div>`
      : nativeScopedList
          .map((sub) => {
            const u = effectiveScope === 'swarm' && swarm ? sub.usageSinceSwarm : sub.usage;
            const inTok = u.inputTokens || 0;
            const cTok = u.cacheReadTokens || 0;
            const outTok = u.outputTokens || 0;
            const totTok = u.totalTokens || inTok + cTok + outTok;
            const hit = calcInputCacheHit(inTok, cTok);
            const c = calcModelCostValue(
              sub.model,
              inTok,
              cTok,
              outTok,
              pricingMap,
              catalogPricing,
              displayOpts,
            );
            if (!c && sub.model.trim() && sub.model !== 'host-default') {
              unpricedSet.add(sub.model.trim());
            }
            return `
              <div class="detail-row">
                <div class="detail-row-top">
                  <span>
                    <button type="button" class="link-btn" data-usage-native-id="${escapeHtml(sub.id)}" data-usage-native-role="${escapeHtml(sub.role)}">${escapeHtml(sub.role)}</button>
                    <span class="provider-badge prov-native">${escapeHtml(sub.typeName)}</span>
                    ${escapeHtml(sub.model)}
                  </span>
                  <span>${formatNum(totTok)}${c ? ` · <span class="usage-cost-pill" title="${escapeHtml(costSourceTitle(c.source))}">${escapeHtml(formatMoney(c.amount, c.currency))}</span>` : ''}</span>
                </div>
                <div class="detail-row-sub">
                  <span>${escapeHtml(tr('usage.turnsStepsShort', { turns: sub.turns, steps: sub.steps }))}</span>
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

  const dshRowsHtml =
    summary.externalMembers.length === 0
      ? `<div class="empty-state-compact">${escapeHtml(tr('usage.workersDetailEmpty'))}</div>`
      : summary.externalMembers
          .map((m) => {
            const inTok = m.usage?.inputTokens || 0;
            const cTok = m.usage?.cacheReadTokens || 0;
            const outTok = m.usage?.outputTokens || 0;
            const totTok = m.usage?.totalTokens || inTok + cTok + outTok;
            const hit = calcInputCacheHit(inTok, cTok);
            const c = calcMemberCostValue(m, pricingMap, catalogPricing, displayOpts);
            const dm = getDisplayModelForMember(m);
            if (!c && dm.label.trim()) {
              unpricedSet.add(dm.label.trim());
            }
            return `
              <div class="detail-row">
                <div class="detail-row-top">
                  <span${dm.title ? ` title="${escapeHtml(dm.title)}"` : ''}>${escapeHtml(m.name)} <span class="provider-badge">${escapeHtml(m.provider || 'dsh')}</span> ${escapeHtml(dm.label)}${renderModelOptionBadgesHtml(m.reasoningEffort, m.fastMode, { effort: m.resolvedReasoningEffort, fast: m.resolvedFastMode })}</span>
                  <span>${formatNum(totTok)}${c ? ` · <span class="usage-cost-pill" title="${escapeHtml(costSourceTitle(c.source))}">${escapeHtml(formatMoney(c.amount, c.currency))}</span>` : ''}</span>
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

  dom.usageDetails.innerHTML = `
    <div class="detail-panel">
      <div class="detail-panel-title">${escapeHtml(tr('usage.agyByModelTitle'))}</div>
      ${agyRowsHtml}
    </div>
    ${
      hasNative
        ? `<div class="detail-panel">
            <div class="detail-panel-title">${escapeHtml(tr('usage.nativeDetailTitle'))}</div>
            ${nativeRowsHtml}
          </div>`
        : ''
    }
    <div class="detail-panel">
      <div class="detail-panel-title">${escapeHtml(tr('usage.workersDetailTitle'))}</div>
      ${dshRowsHtml}
    </div>
  `;

  dom.usageDetails
    .querySelectorAll<HTMLButtonElement>('[data-usage-native-id]')
    .forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.usageNativeId;
        const role = btn.dataset.usageNativeRole || id?.slice(0, 8) || '';
        if (id) void bridge.openNativeSubagentLogs(id, role);
      });
    });

  const unpricedModels = Array.from(unpricedSet);
  if (unpricedModels.length > 0) {
    const chipsHtml = unpricedModels
      .map(
        (m) =>
          `<button type="button" class="pricing-unpriced-chip" data-usage-fill-model="${escapeHtml(m)}">${escapeHtml(m)}</button>`,
      )
      .join('');
    dom.usagePricingHint.innerHTML = `<button type="button" id="usage-open-pricing">${escapeHtml(tr('pricing.hintLink'))}</button><span class="usage-pricing-hint-chips">${chipsHtml}</span>`;
    dom.usagePricingHint.querySelector('#usage-open-pricing')?.addEventListener('click', () => {
      state.pricingExpanded = true;
      bridge.switchTab('settings');
      switchSettingsSubtab('clis');
      if (state.latestProviderConfig) renderPricingSection(state.latestProviderConfig);
    });
    dom.usagePricingHint
      .querySelectorAll<HTMLButtonElement>('[data-usage-fill-model]')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          const targetModel = btn.dataset.usageFillModel;
          state.pricingExpanded = true;
          bridge.switchTab('settings');
          switchSettingsSubtab('clis');
          if (state.latestProviderConfig) renderPricingSection(state.latestProviderConfig);
          if (targetModel) prefillPricingModelForm(targetModel);
        });
      });
  } else {
    dom.usagePricingHint.innerHTML = '';
  }
}
