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
import { aggregateDshUsage, animateNumber, buildGaugeCardHtml } from './helpers.js';
import { renderPricingSection, switchSettingsSubtab } from './settings-view.js';
import { tr } from './context.js';
import { state } from './store.js';
import * as dom from './dom.js';
import {
  calcInputCacheHit,
  calcModelCostValue,
  escapeHtml,
  formatMoney,
  formatNum,
  sumMembersCost,
  sumModelMapCost,
} from './format.js';
import type {
  Snapshot,
  UsageBreakdown,
} from './types.js';
import * as bridge from './bridge.js';

export function renderUsageView(snap: Snapshot, prevSnap: Snapshot | null): void {
  const conversations = snap.availableConversations || [];
  const cu = snap.coordinatorUsage;
  const pricingMap = snap.providerConfig?.pricing || state.latestProviderConfig?.pricing;
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
      opt.textContent = c.title;
      dom.convSelect.appendChild(opt);
    }
    if (cu?.conversationId) {
      dom.convSelect.value = cu.conversationId;
    }
  }

  const swarm = snap.swarm;
  const members = swarm ? Object.values(swarm.members || {}) : [];
  const dshAgg = aggregateDshUsage(members);

  const effectiveScope: 'swarm' | 'session' = swarm ? state.usageScope : 'session';
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

  const prevAgyPct = state.prevGaugePcts.get('agy');
  const prevDshPct = state.prevGaugePcts.get('dsh');

  const agyModelCount = Object.keys(agyModels).length;
  const baseSub =
    effectiveScope === 'swarm' && swarm ? tr('usage.agySubSwarm') : tr('usage.agySubSession');

  dom.usageHero.innerHTML =
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
      dom.usageHero
        .querySelectorAll<SVGCircleElement>('.gauge-ring-fill[data-target-offset]')
        .forEach((circle) => {
          circle.style.strokeDashoffset = circle.dataset.targetOffset || '0';
        });
    });
  }
  state.prevGaugePcts.set('agy', agyStats.cacheHitRate);
  state.prevGaugePcts.set('dsh', dshAgg.cacheHitRate);

  animateNumber(document.getElementById('usage-agy-total'), prevAgyTotal, agyStats.totalTokens, formatNum);
  animateNumber(document.getElementById('usage-dsh-total'), prevDshTotal, dshAgg.totalTokens, formatNum);

  const combined = agyStats.totalTokens + dshAgg.totalTokens;
  const dshShare = combined > 0 ? Math.round((dshAgg.totalTokens / combined) * 1000) / 10 : 0;
  const agyShare = combined > 0 ? Math.max(0, Math.round((100 - dshShare) * 10) / 10) : 0;

  dom.usageSplit.innerHTML = `
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

  dom.usageDetails.innerHTML = `
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
    dom.usagePricingHint.innerHTML = `<button type="button" id="usage-open-pricing">${escapeHtml(tr('pricing.hintLink'))}</button>`;
    dom.usagePricingHint.querySelector('#usage-open-pricing')?.addEventListener('click', () => {
      state.pricingExpanded = true;
      bridge.switchTab('settings');
      switchSettingsSubtab('clis');
      if (state.latestProviderConfig) renderPricingSection(state.latestProviderConfig);
    });
  } else {
    dom.usagePricingHint.innerHTML = '';
  }
}
