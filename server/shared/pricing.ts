import type { MemberState, ModelPricing, UsageBreakdown } from './types.js';

export type CostSource = 'custom' | 'reported' | 'catalog' | 'builtin';

export interface ResolvedModelPricing {
  matchedKey: string;
  pricing: ModelPricing;
  source: 'custom' | 'catalog' | 'builtin';
}

export interface CostCalculation {
  amount: number;
  currency: 'USD' | 'CNY';
  source: CostSource;
}

/**
 * Built-in baseline USD per-1M token pricing for common CLI / orchestrator models.
 * Users can override any entry via custom pricing or refresh via the pricing catalog sync.
 */
export const BUILTIN_MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic Claude
  'claude-opus-4-6': { inputPer1M: 5, cacheReadPer1M: 0.5, outputPer1M: 25, currency: 'USD' },
  'claude-opus-4-5': { inputPer1M: 5, cacheReadPer1M: 0.5, outputPer1M: 25, currency: 'USD' },
  'claude-opus-4-1': { inputPer1M: 15, cacheReadPer1M: 1.5, outputPer1M: 75, currency: 'USD' },
  'claude-opus-4': { inputPer1M: 15, cacheReadPer1M: 1.5, outputPer1M: 75, currency: 'USD' },
  'claude-sonnet-4-6': { inputPer1M: 3, cacheReadPer1M: 0.3, outputPer1M: 15, currency: 'USD' },
  'claude-sonnet-4-5': { inputPer1M: 3, cacheReadPer1M: 0.3, outputPer1M: 15, currency: 'USD' },
  'claude-sonnet-4': { inputPer1M: 3, cacheReadPer1M: 0.3, outputPer1M: 15, currency: 'USD' },
  'claude-3-7-sonnet': { inputPer1M: 3, cacheReadPer1M: 0.3, outputPer1M: 15, currency: 'USD' },
  'claude-3-5-sonnet': { inputPer1M: 3, cacheReadPer1M: 0.3, outputPer1M: 15, currency: 'USD' },
  'claude-haiku-4-5': { inputPer1M: 1, cacheReadPer1M: 0.1, outputPer1M: 5, currency: 'USD' },
  'claude-3-5-haiku': { inputPer1M: 0.8, cacheReadPer1M: 0.08, outputPer1M: 4, currency: 'USD' },

  // OpenAI GPT / o-series
  'gpt-5.4': { inputPer1M: 2.5, cacheReadPer1M: 0.25, outputPer1M: 15, currency: 'USD' },
  'gpt-5.3-codex': { inputPer1M: 1.75, cacheReadPer1M: 0.175, outputPer1M: 14, currency: 'USD' },
  'gpt-5.2-codex': { inputPer1M: 1.75, cacheReadPer1M: 0.175, outputPer1M: 14, currency: 'USD' },
  'gpt-5.2': { inputPer1M: 1.75, cacheReadPer1M: 0.175, outputPer1M: 14, currency: 'USD' },
  'gpt-5.1-codex-max': { inputPer1M: 1.25, cacheReadPer1M: 0.125, outputPer1M: 10, currency: 'USD' },
  'gpt-5.1-codex': { inputPer1M: 1.25, cacheReadPer1M: 0.125, outputPer1M: 10, currency: 'USD' },
  'gpt-5.1': { inputPer1M: 1.25, cacheReadPer1M: 0.125, outputPer1M: 10, currency: 'USD' },
  'gpt-5': { inputPer1M: 1.25, cacheReadPer1M: 0.125, outputPer1M: 10, currency: 'USD' },
  'gpt-5-mini': { inputPer1M: 0.25, cacheReadPer1M: 0.025, outputPer1M: 2, currency: 'USD' },
  'gpt-5-nano': { inputPer1M: 0.05, cacheReadPer1M: 0.005, outputPer1M: 0.4, currency: 'USD' },
  'gpt-4.1': { inputPer1M: 2, cacheReadPer1M: 0.5, outputPer1M: 8, currency: 'USD' },
  'gpt-4.1-mini': { inputPer1M: 0.4, cacheReadPer1M: 0.1, outputPer1M: 1.6, currency: 'USD' },
  'gpt-4.1-nano': { inputPer1M: 0.1, cacheReadPer1M: 0.025, outputPer1M: 0.4, currency: 'USD' },
  'gpt-4o': { inputPer1M: 2.5, cacheReadPer1M: 1.25, outputPer1M: 10, currency: 'USD' },
  'gpt-4o-mini': { inputPer1M: 0.15, cacheReadPer1M: 0.075, outputPer1M: 0.6, currency: 'USD' },
  'o3': { inputPer1M: 2, cacheReadPer1M: 0.5, outputPer1M: 8, currency: 'USD' },
  'o4-mini': { inputPer1M: 1.1, cacheReadPer1M: 0.275, outputPer1M: 4.4, currency: 'USD' },
  'o3-mini': { inputPer1M: 1.1, cacheReadPer1M: 0.55, outputPer1M: 4.4, currency: 'USD' },

  // Google Gemini
  'gemini-3.1-pro-preview': { inputPer1M: 2, cacheReadPer1M: 0.2, outputPer1M: 12, currency: 'USD' },
  'gemini-3-pro-preview': { inputPer1M: 2, cacheReadPer1M: 0.2, outputPer1M: 12, currency: 'USD' },
  'gemini-3-flash-preview': { inputPer1M: 0.5, cacheReadPer1M: 0.05, outputPer1M: 3, currency: 'USD' },
  'gemini-2.5-pro': { inputPer1M: 1.25, cacheReadPer1M: 0.125, outputPer1M: 10, currency: 'USD' },
  'gemini-2.5-flash': { inputPer1M: 0.3, cacheReadPer1M: 0.03, outputPer1M: 2.5, currency: 'USD' },
  'gemini-2.5-flash-lite': { inputPer1M: 0.1, cacheReadPer1M: 0.01, outputPer1M: 0.4, currency: 'USD' },

  // DeepSeek / Qwen / GLM / Kimi / MiniMax / Grok
  'deepseek-chat': { inputPer1M: 0.27, cacheReadPer1M: 0.07, outputPer1M: 1.1, currency: 'USD' },
  'deepseek-v3': { inputPer1M: 0.27, cacheReadPer1M: 0.07, outputPer1M: 1.1, currency: 'USD' },
  'deepseek-reasoner': { inputPer1M: 0.55, cacheReadPer1M: 0.14, outputPer1M: 2.19, currency: 'USD' },
  'deepseek-r1': { inputPer1M: 0.55, cacheReadPer1M: 0.14, outputPer1M: 2.19, currency: 'USD' },
  'qwen3-coder-plus': { inputPer1M: 1.2, cacheReadPer1M: 0.24, outputPer1M: 6, currency: 'USD' },
  'qwen3-max': { inputPer1M: 1.2, cacheReadPer1M: 0.24, outputPer1M: 6, currency: 'USD' },
  'glm-4.7': { inputPer1M: 0.6, cacheReadPer1M: 0.11, outputPer1M: 2.2, currency: 'USD' },
  'glm-4.6': { inputPer1M: 0.6, cacheReadPer1M: 0.11, outputPer1M: 2.2, currency: 'USD' },
  'glm-4.5': { inputPer1M: 0.6, cacheReadPer1M: 0.11, outputPer1M: 2.2, currency: 'USD' },
  'kimi-k2.5': { inputPer1M: 0.6, cacheReadPer1M: 0.15, outputPer1M: 2.5, currency: 'USD' },
  'kimi-k2': { inputPer1M: 0.6, cacheReadPer1M: 0.15, outputPer1M: 2.5, currency: 'USD' },
  'minimax-m2.5': { inputPer1M: 0.3, cacheReadPer1M: 0.03, outputPer1M: 1.2, currency: 'USD' },
  'minimax-m2.1': { inputPer1M: 0.3, cacheReadPer1M: 0.03, outputPer1M: 1.2, currency: 'USD' },
  'grok-4': { inputPer1M: 3, cacheReadPer1M: 0.75, outputPer1M: 15, currency: 'USD' },
  'grok-code-fast-1': { inputPer1M: 0.2, cacheReadPer1M: 0.02, outputPer1M: 1.5, currency: 'USD' },
};

function pushVariants(out: string[], seen: Set<string>, candidate: string): void {
  const push = (v: string) => {
    const clean = v.trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  };
  push(candidate);
  // Strip bracket context suffixes like `[1m]`
  const noBracket = candidate.replace(/\[[^\]]+\]$/, '');
  if (noBracket !== candidate) push(noBracket);
  // Strip router modifier tags like `:free` / `:thinking` / `:exacto`
  const noColon = noBracket.replace(/:[a-z0-9._-]+$/i, '');
  if (noColon !== noBracket) push(noColon);
  // Strip trailing date stamps like `-20251001` or `-2025-05-14`
  const noDate = noColon.replace(/(?:-\d{8}|-\d{4}-\d{2}-\d{2})$/, '');
  if (noDate !== noColon) push(noDate);
  // Normalize dot/dash in Claude version numbers (e.g. `claude-sonnet-4.5` -> `claude-sonnet-4-5`)
  for (const base of [noColon, noDate]) {
    if (base.startsWith('claude-')) {
      const dashed = base.replace(/(\d)\.(\d)/g, '$1-$2');
      if (dashed !== base) push(dashed);
    }
  }
}

/**
 * Generate candidate lookup keys for a raw model ID in descending specificity:
 * exact -> full path variants -> subpaths after `/` -> bare basename & stripped suffixes.
 */
export function normalizeModelPricingCandidates(rawModel: string): string[] {
  const trimmed = rawModel.trim();
  if (!trimmed) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const lower = trimmed.toLowerCase();

  pushVariants(out, seen, trimmed);
  if (lower !== trimmed) {
    pushVariants(out, seen, lower);
  }

  const segments = lower.split('/').filter(Boolean);
  for (let i = 1; i < segments.length; i += 1) {
    pushVariants(out, seen, segments.slice(i).join('/'));
  }

  return out;
}

function lookupPricingInMap(
  candidates: string[],
  map: Record<string, ModelPricing> | undefined,
): { matchedKey: string; pricing: ModelPricing } | null {
  if (!map) return null;
  for (const cand of candidates) {
    if (Object.hasOwn(map, cand)) {
      return { matchedKey: cand, pricing: map[cand] };
    }
  }
  let lowerIndex: Map<string, { matchedKey: string; pricing: ModelPricing }> | null = null;
  for (const cand of candidates) {
    const lc = cand.toLowerCase();
    if (!lowerIndex) {
      lowerIndex = new Map();
      for (const [k, v] of Object.entries(map)) {
        const lk = k.toLowerCase();
        if (!lowerIndex.has(lk)) {
          lowerIndex.set(lk, { matchedKey: k, pricing: v });
        }
      }
    }
    const hit = lowerIndex.get(lc);
    if (hit) return hit;
  }
  return null;
}

/**
 * Resolve per-1M token pricing with precedence: custom > synced catalog > built-in.
 */
export function resolveModelPricing(
  model: string,
  customPricing?: Record<string, ModelPricing>,
  catalogPricing?: Record<string, ModelPricing>,
): ResolvedModelPricing | null {
  const candidates = normalizeModelPricingCandidates(model);
  if (candidates.length === 0) return null;

  const customHit = lookupPricingInMap(candidates, customPricing);
  if (customHit) {
    return { ...customHit, source: 'custom' };
  }
  const catalogHit = lookupPricingInMap(candidates, catalogPricing);
  if (catalogHit) {
    return { ...catalogHit, source: 'catalog' };
  }
  const builtinHit = lookupPricingInMap(candidates, BUILTIN_MODEL_PRICING);
  if (builtinHit) {
    return { ...builtinHit, source: 'builtin' };
  }
  return null;
}

export function calcRateCost(
  rate: ModelPricing,
  inputTok: number,
  cacheTok: number,
  outputTok: number,
  source: CostSource,
): CostCalculation {
  const cacheRate = rate.cacheReadPer1M ?? rate.inputPer1M;
  const amount =
    (inputTok * rate.inputPer1M + cacheTok * cacheRate + outputTok * rate.outputPer1M) / 1_000_000;
  return {
    amount,
    currency: rate.currency === 'CNY' ? 'CNY' : 'USD',
    source,
  };
}

export function calcModelCost(
  model: string,
  inputTok: number,
  cacheTok: number,
  outputTok: number,
  customPricing?: Record<string, ModelPricing>,
  catalogPricing?: Record<string, ModelPricing>,
): CostCalculation | null {
  const resolved = resolveModelPricing(model, customPricing, catalogPricing);
  if (!resolved) return null;
  return calcRateCost(resolved.pricing, inputTok, cacheTok, outputTok, resolved.source);
}

/**
 * Calculate member cost with precedence:
 * custom override > CLI-reported cost (`reportedCostUsd`) > synced catalog > built-in table.
 */
export function calcMemberCost(
  member: MemberState,
  customPricing?: Record<string, ModelPricing>,
  catalogPricing?: Record<string, ModelPricing>,
): CostCalculation | null {
  const u = member.usage || { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0 };
  const candidates = normalizeModelPricingCandidates(member.model);
  const customHit = lookupPricingInMap(candidates, customPricing);
  if (customHit) {
    return calcRateCost(customHit.pricing, u.inputTokens, u.cacheReadTokens, u.outputTokens, 'custom');
  }
  if (typeof u.reportedCostUsd === 'number' && Number.isFinite(u.reportedCostUsd) && u.reportedCostUsd >= 0) {
    return { amount: u.reportedCostUsd, currency: 'USD', source: 'reported' };
  }
  return calcModelCost(member.model, u.inputTokens, u.cacheReadTokens, u.outputTokens, undefined, catalogPricing);
}

export function formatMoney(amount: number, currency: 'USD' | 'CNY'): string {
  return `${currency === 'CNY' ? '¥' : '$'}${amount.toFixed(4)}`;
}

function formatCostTotals(
  costs: Array<CostCalculation | null>,
): string | null {
  let totalUsd = 0;
  let totalCny = 0;
  let hasUsd = false;
  let hasCny = false;
  for (const c of costs) {
    if (!c) continue;
    if (c.currency === 'CNY') {
      totalCny += c.amount;
      hasCny = true;
    } else {
      totalUsd += c.amount;
      hasUsd = true;
    }
  }
  const parts: string[] = [];
  if (hasUsd) parts.push(formatMoney(totalUsd, 'USD'));
  if (hasCny) parts.push(formatMoney(totalCny, 'CNY'));
  return parts.length > 0 ? parts.join(' + ') : null;
}

export function sumModelMapCost(
  modelsMap: Record<string, UsageBreakdown>,
  customPricing?: Record<string, ModelPricing>,
  catalogPricing?: Record<string, ModelPricing>,
): string | null {
  const costs = Object.entries(modelsMap).map(([mName, st]) =>
    calcModelCost(mName, st.inputTokens, st.cacheReadTokens, st.outputTokens, customPricing, catalogPricing),
  );
  return formatCostTotals(costs);
}

export function sumMembersCost(
  members: MemberState[],
  customPricing?: Record<string, ModelPricing>,
  catalogPricing?: Record<string, ModelPricing>,
): string | null {
  const costs = members.map((m) => calcMemberCost(m, customPricing, catalogPricing));
  return formatCostTotals(costs);
}

export function collectUnpricedModels(
  models: Iterable<string>,
  customPricing?: Record<string, ModelPricing>,
  catalogPricing?: Record<string, ModelPricing>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of models) {
    const clean = raw.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    if (!resolveModelPricing(clean, customPricing, catalogPricing)) {
      out.push(clean);
    }
  }
  return out;
}
