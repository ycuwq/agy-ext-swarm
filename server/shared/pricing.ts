import {
  DEFAULT_USD_TO_CNY_RATE,
  type DisplayCurrency,
  type MemberState,
  type ModelPricing,
  type UsageBreakdown,
} from './types.js';

export type CostSource = 'custom' | 'reported' | 'catalog' | 'builtin';

export interface CostDisplayOptions {
  displayCurrency?: DisplayCurrency;
  usdToCnyRate?: number;
}

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

function pushVariants(
  out: string[],
  seen: Set<string>,
  candidate: string,
  displayFallbacks?: Set<string>,
): void {
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
  // Strip reasoning/effort tier suffixes like `-xhigh`, `-high`, `-medium`, `-low`, `-thinking`
  const noEffort = noColon.replace(/-(?:xhigh|high|medium|low|minimal|thinking|reasoning)$/i, '');
  if (noEffort !== noColon) push(noEffort);
  // Strip trailing date stamps like `-20251001` or `-2025-05-14`
  const basesToDateStrip = noEffort !== noColon ? [noColon, noEffort] : [noColon];
  const noDates: string[] = [];
  for (const base of basesToDateStrip) {
    const nd = base.replace(/(?:-\d{8}|-\d{4}-\d{2}-\d{2})$/, '');
    if (nd !== base) {
      push(nd);
      noDates.push(nd);
    }
  }
  // Normalize dot/dash in Claude version numbers (e.g. `claude-sonnet-4.5` -> `claude-sonnet-4-5`)
  for (const base of [noColon, noEffort, ...noDates]) {
    if (base.toLowerCase().startsWith('claude-')) {
      const dashed = base.replace(/(\d)\.(\d)/g, '$1-$2');
      if (dashed !== base) push(dashed);
    }
  }
  if (displayFallbacks) {
    const lower = noColon.toLowerCase();
    const label = lower.replace(/\s*\([^)]+\)$/, '').trim().replace(/\s+/g, '-');
    const dashed = label.replace(/(?<=\d)\.(?=\d)/g, '-');
    if (label !== lower) displayFallbacks.add(label);
    if (dashed !== label) displayFallbacks.add(dashed);
  }
}

const CATALOG_VENDOR_DOT_PREFIX_RE =
  /^(?:(?:global|us|eu|ap|au)\.)?(?:anthropic|amazon|meta|mistral|cohere|deepseek|google|openai|ai21|qwen|system\.ai)\./;
const CANONICAL_CATALOG_PREFIXES = [
  'anthropic/',
  'anthropic.',
  'openai/',
  'gemini/',
  'google/',
  'deepseek/',
  'openrouter/anthropic/',
  'openrouter/google/',
  'openrouter/openai/',
  'openrouter/deepseek/',
];
const CLOUD_CATALOG_PREFIXES = [
  'vertex_ai/',
  'azure_ai/',
  'azure/',
  'bedrock/',
  'dashscope/',
  'global.anthropic.',
  'us.anthropic.',
  'eu.anthropic.',
  'au.anthropic.',
  'openrouter/',
];

/**
 * Extract canonical bare model name from a provider/region-prefixed catalog key.
 * E.g. `coralbricks/deepseek-v4.1-flash` -> `deepseek-v4.1-flash`,
 *      `global.anthropic.claude-opus-5-5` -> `claude-opus-5-5`.
 */
export function extractCatalogBaseName(catalogKey: string): string {
  const lower = catalogKey.trim().toLowerCase();
  if (!lower) return '';
  const lastSlash = lower.lastIndexOf('/');
  const tail = lastSlash >= 0 ? lower.slice(lastSlash + 1) : lower;
  return tail.replace(CATALOG_VENDOR_DOT_PREFIX_RE, '') || tail;
}

/**
 * Rank competing catalog keys sharing a base name, preferring non-zero rates,
 * bare keys, canonical first-party prefixes, then cloud platforms, then resellers.
 */
export function scoreCatalogKeyMatch(catalogKey: string, pricing: ModelPricing): number {
  const lower = catalogKey.trim().toLowerCase();
  const base = extractCatalogBaseName(lower);
  let score = pricing.inputPer1M > 0 || pricing.outputPer1M > 0 ? 100 : -100;
  if (lower === base) {
    score += 80;
  } else if (CANONICAL_CATALOG_PREFIXES.some((p) => lower.startsWith(p))) {
    score += 50;
  } else if (CLOUD_CATALOG_PREFIXES.some((p) => lower.startsWith(p))) {
    score += 30;
  } else {
    score += 10;
  }
  if (lower.includes(':')) score -= 10;
  return score - lower.length * 0.01;
}

export function buildCatalogBaseIndex(
  map: Record<string, ModelPricing>,
): Map<string, { matchedKey: string; pricing: ModelPricing }> {
  const scored = new Map<string, { matchedKey: string; pricing: ModelPricing; score: number }>();
  for (const [k, v] of Object.entries(map)) {
    const base = extractCatalogBaseName(k);
    if (!base) continue;
    const score = scoreCatalogKeyMatch(k, v);
    const prev = scored.get(base);
    if (!prev || score > prev.score) {
      scored.set(base, { matchedKey: k, pricing: v, score });
    }
  }
  const out = new Map<string, { matchedKey: string; pricing: ModelPricing }>();
  for (const [base, entry] of scored.entries()) {
    out.set(base, { matchedKey: entry.matchedKey, pricing: entry.pricing });
  }
  return out;
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
  const displayFallbacks = new Set<string>();
  const lower = trimmed.toLowerCase();

  pushVariants(out, seen, trimmed, displayFallbacks);
  if (lower !== trimmed) {
    pushVariants(out, seen, lower, displayFallbacks);
  }

  const segments = lower.split('/').filter(Boolean);
  for (let i = 1; i < segments.length; i += 1) {
    pushVariants(out, seen, segments.slice(i).join('/'), displayFallbacks);
  }
  for (const label of displayFallbacks) {
    pushVariants(out, seen, label);
  }

  return out;
}

interface PricingMatch {
  matchedKey: string;
  pricing: ModelPricing;
}

const pricingIndices = new WeakMap<
  Record<string, ModelPricing>,
  { lowerIndex: Map<string, PricingMatch>; baseIndex?: Map<string, PricingMatch> }
>();

function getPricingIndices(map: Record<string, ModelPricing>) {
  let indices = pricingIndices.get(map);
  if (!indices) {
    const lowerIndex = new Map<string, PricingMatch>();
    for (const [matchedKey, pricing] of Object.entries(map)) {
      const lowerKey = matchedKey.toLowerCase();
      if (!lowerIndex.has(lowerKey)) lowerIndex.set(lowerKey, { matchedKey, pricing });
    }
    indices = { lowerIndex };
    pricingIndices.set(map, indices);
  }
  return indices;
}

export function lookupPricingInMap(
  candidates: string[],
  map: Record<string, ModelPricing> | undefined,
  allowSuffixIndex = false,
): PricingMatch | null {
  if (!map || candidates.length === 0) return null;
  let indices: ReturnType<typeof getPricingIndices> | undefined;
  for (const cand of candidates) {
    if (Object.hasOwn(map, cand)) {
      return { matchedKey: cand, pricing: map[cand] };
    }
    indices ??= getPricingIndices(map);
    const hit = indices.lowerIndex.get(cand.toLowerCase());
    if (hit) return hit;
  }
  if (allowSuffixIndex && indices) {
    const baseIndex = indices.baseIndex ??= buildCatalogBaseIndex(map);
    for (const cand of candidates) {
      const hit = baseIndex.get(cand.toLowerCase());
      if (hit) return hit;
    }
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
  const catalogHit = lookupPricingInMap(candidates, catalogPricing, true);
  if (catalogHit) {
    return { ...catalogHit, source: 'catalog' };
  }
  const builtinHit = lookupPricingInMap(candidates, BUILTIN_MODEL_PRICING);
  if (builtinHit) {
    return { ...builtinHit, source: 'builtin' };
  }
  return null;
}

function resolveFxRate(rate?: number): number {
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_USD_TO_CNY_RATE;
}

function roundRate4(val: number): number {
  return Math.round(val * 10_000) / 10_000;
}

export function convertCurrency(
  amount: number,
  from: 'USD' | 'CNY',
  opts?: CostDisplayOptions,
): { amount: number; currency: 'USD' | 'CNY' } {
  const target = opts?.displayCurrency;
  if (!target || target === 'AUTO' || target === from) {
    return { amount, currency: from };
  }
  const fx = resolveFxRate(opts?.usdToCnyRate);
  if (target === 'CNY') {
    return { amount: amount * fx, currency: 'CNY' };
  }
  return { amount: amount / fx, currency: 'USD' };
}

export function convertRateForDisplay(rate: ModelPricing, opts?: CostDisplayOptions): ModelPricing {
  const from = rate.currency === 'CNY' ? 'CNY' : 'USD';
  const target = opts?.displayCurrency;
  if (!target || target === 'AUTO' || target === from) {
    return { ...rate, currency: from };
  }
  const fx = resolveFxRate(opts?.usdToCnyRate);
  const scale = target === 'CNY' ? fx : 1 / fx;
  return {
    inputPer1M: roundRate4(rate.inputPer1M * scale),
    outputPer1M: roundRate4(rate.outputPer1M * scale),
    currency: target,
    ...(rate.cacheReadPer1M !== undefined
      ? { cacheReadPer1M: roundRate4(rate.cacheReadPer1M * scale) }
      : {}),
  };
}

export function calcRateCost(
  rate: ModelPricing,
  inputTok: number,
  cacheTok: number,
  outputTok: number,
  source: CostSource,
  displayOpts?: CostDisplayOptions,
): CostCalculation {
  const cacheRate = rate.cacheReadPer1M ?? rate.inputPer1M;
  const rawAmount =
    (inputTok * rate.inputPer1M + cacheTok * cacheRate + outputTok * rate.outputPer1M) / 1_000_000;
  const fromCurrency: 'USD' | 'CNY' = rate.currency === 'CNY' ? 'CNY' : 'USD';
  const converted = convertCurrency(rawAmount, fromCurrency, displayOpts);
  return {
    amount: converted.amount,
    currency: converted.currency,
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
  displayOpts?: CostDisplayOptions,
): CostCalculation | null {
  const resolved = resolveModelPricing(model, customPricing, catalogPricing);
  if (!resolved) return null;
  return calcRateCost(resolved.pricing, inputTok, cacheTok, outputTok, resolved.source, displayOpts);
}

/**
 * Calculate member cost with precedence:
 * custom override > CLI-reported cost (`reportedCostUsd`) > synced catalog > built-in table.
 */
export function calcMemberCost(
  member: MemberState,
  customPricing?: Record<string, ModelPricing>,
  catalogPricing?: Record<string, ModelPricing>,
  displayOpts?: CostDisplayOptions,
): CostCalculation | null {
  const u = member.usage || { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0 };
  const rawModel = member.model?.trim() || '';
  const resolved = member.resolvedModel?.trim() || '';
  const effectiveModel = !rawModel || rawModel === 'default' ? resolved || rawModel : rawModel;
  const candidates = Array.from(
    new Set([
      ...normalizeModelPricingCandidates(effectiveModel),
      ...(resolved && effectiveModel !== resolved ? normalizeModelPricingCandidates(resolved) : []),
    ]),
  );
  const customHit = lookupPricingInMap(candidates, customPricing);
  if (customHit) {
    return calcRateCost(
      customHit.pricing,
      u.inputTokens,
      u.cacheReadTokens,
      u.outputTokens,
      'custom',
      displayOpts,
    );
  }
  if (typeof u.reportedCostUsd === 'number' && Number.isFinite(u.reportedCostUsd) && u.reportedCostUsd >= 0) {
    const converted = convertCurrency(u.reportedCostUsd, 'USD', displayOpts);
    return { amount: converted.amount, currency: converted.currency, source: 'reported' };
  }
  return (
    calcModelCost(
      effectiveModel,
      u.inputTokens,
      u.cacheReadTokens,
      u.outputTokens,
      undefined,
      catalogPricing,
      displayOpts,
    ) ||
    (resolved && effectiveModel !== resolved
      ? calcModelCost(
          resolved,
          u.inputTokens,
          u.cacheReadTokens,
          u.outputTokens,
          undefined,
          catalogPricing,
          displayOpts,
        )
      : null)
  );
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
  displayOpts?: CostDisplayOptions,
): string | null {
  const costs = Object.entries(modelsMap).map(([mName, st]) =>
    calcModelCost(
      mName,
      st.inputTokens,
      st.cacheReadTokens,
      st.outputTokens,
      customPricing,
      catalogPricing,
      displayOpts,
    ),
  );
  return formatCostTotals(costs);
}

export function sumMembersCost(
  members: MemberState[],
  customPricing?: Record<string, ModelPricing>,
  catalogPricing?: Record<string, ModelPricing>,
  displayOpts?: CostDisplayOptions,
): string | null {
  const costs = members.map((m) => calcMemberCost(m, customPricing, catalogPricing, displayOpts));
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
