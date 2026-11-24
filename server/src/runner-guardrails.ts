import { calcMemberCost } from '../shared/pricing.js';
import { loadPricingCatalog } from './pricing-catalog.js';
import { getProviderConfigSnapshot } from './providers/index.js';
import type { SwarmStore } from './store.js';
import type { ProviderCooldownEntry, SwarmState } from './types.js';

export class ProviderCooldownTracker {
  private readonly entries = new Map<string, ProviderCooldownEntry>();

  getActive(): Record<string, ProviderCooldownEntry> {
    const now = Date.now();
    const out: Record<string, ProviderCooldownEntry> = {};
    for (const [id, entry] of this.entries.entries()) {
      const untilMs = Date.parse(entry.until);
      if (!Number.isFinite(untilMs) || untilMs <= now) {
        this.entries.delete(id);
      } else {
        out[id] = entry;
      }
    }
    return out;
  }

  getActiveIdSet(): Set<string> {
    return new Set(Object.keys(this.getActive()));
  }

  clear(providerId: string): boolean {
    const norm = providerId.trim().toLowerCase();
    if (!norm) return false;
    return this.entries.delete(norm);
  }

  mark(
    store: SwarmStore,
    swarmId: string | undefined,
    providerId: string,
    reason: string,
  ): ProviderCooldownEntry | null {
    const norm = providerId.trim().toLowerCase();
    if (!norm || norm === 'custom') return null;
    const rawSec = Number(process.env.EXT_SWARM_COOLDOWN_SECONDS);
    const cooldownSec =
      Number.isFinite(rawSec) && rawSec >= 0 ? Math.min(86400, Math.floor(rawSec)) : 900;
    if (cooldownSec === 0) return null;
    const now = Date.now();
    const entry: ProviderCooldownEntry = {
      providerId: norm,
      triggeredAt: new Date(now).toISOString(),
      until: new Date(now + cooldownSec * 1000).toISOString(),
      reason: reason.slice(0, 240),
    };
    const prev = this.entries.get(norm);
    this.entries.set(norm, entry);
    if (swarmId && (!prev || Date.parse(prev.until) <= now)) {
      const mins = Math.max(1, Math.round(cooldownSec / 60));
      store.appendBoardMessage(swarmId, {
        agent: 'system',
        text: `[cooldown] Provider "${norm}" hit rate-limit/quota; cooling down for ${mins}m (${entry.reason.slice(0, 120)}).`,
        kind: 'warning',
      });
    }
    return entry;
  }
}

export function computeSwarmEstimatedCostUsd(dataDir: string, swarm: SwarmState): number {
  const cfg = getProviderConfigSnapshot(dataDir, swarm.repoRoot, swarm.profile);
  const { pricing: catalogPricing } = loadPricingCatalog(dataDir);
  let totalUsd = 0;
  for (const member of Object.values(swarm.members)) {
    const cost = calcMemberCost(member, cfg.pricing, catalogPricing, {
      displayCurrency: 'USD',
      usdToCnyRate: cfg.usdToCnyRate,
    });
    if (cost) totalUsd += cost.amount;
  }
  return Math.round(totalUsd * 1000000) / 1000000;
}

export function applySwarmBudgetUpdate(
  store: SwarmStore,
  swarmId: string | undefined,
  opts: { maxCostUsd?: number | null; resume?: boolean },
): { swarm: SwarmState; shouldPump: boolean } {
  const swarm = store.getSwarm(swarmId);
  let shouldPump = false;
  if (opts.maxCostUsd === null || opts.maxCostUsd === 0) {
    swarm.maxCostUsd = undefined;
    swarm.budgetBypassed = undefined;
    if (swarm.budgetPaused) {
      swarm.budgetPaused = false;
      swarm.budgetPausedReason = undefined;
      shouldPump = true;
    }
  } else if (
    typeof opts.maxCostUsd === 'number' &&
    Number.isFinite(opts.maxCostUsd) &&
    opts.maxCostUsd > 0
  ) {
    swarm.maxCostUsd = Math.min(10000, Math.round(opts.maxCostUsd * 10000) / 10000);
    const est = computeSwarmEstimatedCostUsd(store.dataDir, swarm);
    if (est < swarm.maxCostUsd) {
      swarm.budgetBypassed = undefined;
    } else if (opts.resume) {
      swarm.budgetBypassed = true;
    }
    if (swarm.budgetPaused && (opts.resume || est < swarm.maxCostUsd)) {
      swarm.budgetPaused = false;
      swarm.budgetPausedReason = undefined;
      shouldPump = true;
    }
  } else if (opts.resume && swarm.budgetPaused) {
    swarm.budgetPaused = false;
    swarm.budgetPausedReason = undefined;
    swarm.budgetBypassed = true;
    shouldPump = true;
  }
  store.saveState(swarm);
  if (shouldPump) {
    store.appendBoardMessage(swarm.id, {
      agent: 'system',
      text: `[budget] Swarm budget updated (${swarm.maxCostUsd ? `cap=$${swarm.maxCostUsd.toFixed(4)}` : 'cap cleared'}); execution resumed.`,
      kind: 'system',
    });
  }
  return { swarm: store.getSwarm(swarm.id), shouldPump };
}
