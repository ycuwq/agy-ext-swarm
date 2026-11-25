import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildCatalogBaseIndex, normalizeModelPricingCandidates } from '../shared/pricing.js';
import { atomicWriteJson } from './store.js';
import type {
  HostTelemetrySnapshot,
  ModelPricing,
  PricingCatalogMeta,
  ProvidersConfigSnapshot,
  SwarmState,
} from './types.js';

export const LITELLM_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const PRICING_CATALOG_FILENAME = 'pricing-catalog.json';
const SYNC_TIMEOUT_MS = 15_000;

interface PricingCatalogFile {
  source: 'litellm' | 'openrouter';
  fetchedAt: string;
  pricing: Record<string, ModelPricing>;
}

export interface LoadedPricingCatalog {
  meta?: PricingCatalogMeta;
  pricing: Record<string, ModelPricing>;
}

function roundPer1M(perToken: number): number {
  return Math.round(perToken * 1_000_000 * 1_000_000) / 1_000_000;
}

function parseNonNegNumber(raw: unknown): number | undefined {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0 ? raw : undefined;
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }
  return undefined;
}

function sanitizeCatalogMap(raw: unknown): Record<string, ModelPricing> {
  const out: Record<string, ModelPricing> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = k.trim();
    if (!key || !v || typeof v !== 'object' || Array.isArray(v)) continue;
    const rec = v as Record<string, unknown>;
    const inputPer1M = parseNonNegNumber(rec.inputPer1M);
    const outputPer1M = parseNonNegNumber(rec.outputPer1M);
    if (inputPer1M === undefined || outputPer1M === undefined) continue;
    const cacheReadPer1M = parseNonNegNumber(rec.cacheReadPer1M);
    out[key] = {
      inputPer1M,
      outputPer1M,
      currency: rec.currency === 'CNY' ? 'CNY' : 'USD',
      ...(cacheReadPer1M !== undefined ? { cacheReadPer1M } : {}),
    };
  }
  return out;
}

export function parseLiteLlmPricingCatalog(rawJson: unknown): Record<string, ModelPricing> {
  const out: Record<string, ModelPricing> = {};
  if (!rawJson || typeof rawJson !== 'object' || Array.isArray(rawJson)) return out;
  for (const [rawKey, rawVal] of Object.entries(rawJson as Record<string, unknown>)) {
    const key = rawKey.trim().toLowerCase();
    if (!key || key === 'sample_spec' || !rawVal || typeof rawVal !== 'object' || Array.isArray(rawVal)) {
      continue;
    }
    const entry = rawVal as Record<string, unknown>;
    const mode = typeof entry.mode === 'string' ? entry.mode.trim().toLowerCase() : undefined;
    if (mode && mode !== 'chat' && mode !== 'completion' && mode !== 'responses') {
      continue;
    }
    const inPerTok = parseNonNegNumber(entry.input_cost_per_token);
    const outPerTok = parseNonNegNumber(entry.output_cost_per_token);
    if (inPerTok === undefined || outPerTok === undefined) continue;
    const cachePerTok = parseNonNegNumber(entry.cache_read_input_token_cost);
    out[key] = {
      inputPer1M: roundPer1M(inPerTok),
      outputPer1M: roundPer1M(outPerTok),
      currency: 'USD',
      ...(cachePerTok !== undefined ? { cacheReadPer1M: roundPer1M(cachePerTok) } : {}),
    };
  }
  return out;
}

export function parseOpenRouterPricingCatalog(rawJson: unknown): Record<string, ModelPricing> {
  const out: Record<string, ModelPricing> = {};
  if (!rawJson || typeof rawJson !== 'object' || Array.isArray(rawJson)) return out;
  const data = (rawJson as Record<string, unknown>).data;
  if (!Array.isArray(data)) return out;
  for (const item of data) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id.trim().toLowerCase() : '';
    if (!id || !rec.pricing || typeof rec.pricing !== 'object' || Array.isArray(rec.pricing)) {
      continue;
    }
    const p = rec.pricing as Record<string, unknown>;
    const inPerTok = parseNonNegNumber(p.prompt);
    const outPerTok = parseNonNegNumber(p.completion);
    if (inPerTok === undefined || outPerTok === undefined) continue;
    const cachePerTok = parseNonNegNumber(p.input_cache_read);
    out[id] = {
      inputPer1M: roundPer1M(inPerTok),
      outputPer1M: roundPer1M(outPerTok),
      currency: 'USD',
      ...(cachePerTok !== undefined ? { cacheReadPer1M: roundPer1M(cachePerTok) } : {}),
    };
  }
  return out;
}

interface PricingCatalogIndices {
  loaded: LoadedPricingCatalog;
  lowerKeyMap: Map<string, [string, ModelPricing]>;
  baseIndex: Map<string, { matchedKey: string; pricing: ModelPricing }>;
}

interface CachedPricingCatalog extends PricingCatalogIndices {
  mtimeMs: number;
  size: number;
}

const pricingCatalogCache = new Map<string, CachedPricingCatalog>();

function buildLowerKeyMap(catalogPricing: Record<string, ModelPricing>): Map<string, [string, ModelPricing]> {
  const lowerKeyMap = new Map<string, [string, ModelPricing]>();
  for (const entry of Object.entries(catalogPricing)) {
    const lk = entry[0].toLowerCase();
    if (!lowerKeyMap.has(lk)) {
      lowerKeyMap.set(lk, entry);
    }
  }
  return lowerKeyMap;
}

function loadPricingCatalogIndexed(dataDir: string): PricingCatalogIndices {
  const filePath = join(dataDir, PRICING_CATALOG_FILENAME);
  let st: { mtimeMs: number; size: number };
  try {
    st = statSync(filePath);
  } catch {
    pricingCatalogCache.delete(filePath);
    return {
      loaded: { pricing: {} },
      lowerKeyMap: new Map(),
      baseIndex: new Map(),
    };
  }
  const cached = pricingCatalogCache.get(filePath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return {
      loaded: cached.loaded,
      lowerKeyMap: cached.lowerKeyMap,
      baseIndex: cached.baseIndex,
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<PricingCatalogFile>;
    const pricing = sanitizeCatalogMap(parsed?.pricing);
    const modelCount = Object.keys(pricing).length;
    const loaded: LoadedPricingCatalog =
      (parsed?.source === 'litellm' || parsed?.source === 'openrouter') &&
      typeof parsed.fetchedAt === 'string' &&
      parsed.fetchedAt.trim()
        ? {
            meta: {
              source: parsed.source,
              fetchedAt: parsed.fetchedAt,
              modelCount,
            },
            pricing,
          }
        : { pricing };
    const lowerKeyMap = buildLowerKeyMap(pricing);
    const baseIndex = buildCatalogBaseIndex(pricing);
    if (pricingCatalogCache.size >= 16) {
      const oldest = pricingCatalogCache.keys().next().value;
      if (oldest) pricingCatalogCache.delete(oldest);
    }
    pricingCatalogCache.set(filePath, {
      mtimeMs: st.mtimeMs,
      size: st.size,
      loaded,
      lowerKeyMap,
      baseIndex,
    });
    return { loaded, lowerKeyMap, baseIndex };
  } catch {
    pricingCatalogCache.delete(filePath);
    return {
      loaded: { pricing: {} },
      lowerKeyMap: new Map(),
      baseIndex: new Map(),
    };
  }
}

export function loadPricingCatalog(dataDir: string): LoadedPricingCatalog {
  return loadPricingCatalogIndexed(dataDir).loaded;
}

function pickRelevantWithIndices(
  catalogPricing: Record<string, ModelPricing>,
  lowerKeyMap: Map<string, [string, ModelPricing]>,
  baseIndex: Map<string, { matchedKey: string; pricing: ModelPricing }>,
  modelsNeeded: Iterable<string>,
): Record<string, ModelPricing> {
  const out: Record<string, ModelPricing> = {};
  if (lowerKeyMap.size === 0) return out;

  for (const rawModel of modelsNeeded) {
    const candidates = normalizeModelPricingCandidates(rawModel);
    let matched = false;
    for (const cand of candidates) {
      if (Object.hasOwn(catalogPricing, cand)) {
        out[cand] = catalogPricing[cand];
        matched = true;
        break;
      }
      const lowerHit = lowerKeyMap.get(cand.toLowerCase());
      if (lowerHit) {
        out[lowerHit[0]] = lowerHit[1];
        matched = true;
        break;
      }
    }
    if (!matched) {
      for (const cand of candidates) {
        const baseHit = baseIndex.get(cand.toLowerCase());
        if (baseHit) {
          out[baseHit.matchedKey] = baseHit.pricing;
          break;
        }
      }
    }
  }
  return out;
}

export function pickRelevantCatalogPricing(
  catalogPricing: Record<string, ModelPricing>,
  modelsNeeded: Iterable<string>,
): Record<string, ModelPricing> {
  const lowerKeyMap = buildLowerKeyMap(catalogPricing);
  if (lowerKeyMap.size === 0) return {};
  const baseIndex = buildCatalogBaseIndex(catalogPricing);
  return pickRelevantWithIndices(catalogPricing, lowerKeyMap, baseIndex, modelsNeeded);
}

export function collectSnapshotModelNames(
  providerConfig: ProvidersConfigSnapshot,
  swarm?: SwarmState | null,
  hostTelemetry?: HostTelemetrySnapshot,
): string[] {
  const out: string[] = [];
  for (const p of providerConfig.providers) {
    for (const m of p.models) out.push(m);
  }
  if (swarm) {
    for (const m of Object.values(swarm.members || {})) {
      if (m.model) out.push(m.model);
    }
  }
  if (hostTelemetry) {
    for (const m of Object.keys(hostTelemetry.coordinator.byModelSession || {})) out.push(m);
    for (const m of Object.keys(hostTelemetry.coordinator.byModelSinceSwarm || {})) out.push(m);
    for (const m of Object.keys(hostTelemetry.subagentUsage.byModelSession || {})) out.push(m);
    for (const m of Object.keys(hostTelemetry.subagentUsage.byModelSinceSwarm || {})) out.push(m);
    for (const sub of hostTelemetry.subagents || []) {
      if (sub.model) out.push(sub.model);
      for (const sm of sub.models || []) out.push(sm);
    }
  }
  return out;
}

export function attachPricingCatalogToSnapshot(
  dataDir: string,
  providerConfig: ProvidersConfigSnapshot,
  swarm?: SwarmState | null,
  hostTelemetry?: HostTelemetrySnapshot,
): ProvidersConfigSnapshot {
  const { loaded, lowerKeyMap, baseIndex } = loadPricingCatalogIndexed(dataDir);
  if (!loaded.meta && Object.keys(loaded.pricing).length === 0) {
    return providerConfig;
  }
  const relevant = pickRelevantWithIndices(
    loaded.pricing,
    lowerKeyMap,
    baseIndex,
    collectSnapshotModelNames(providerConfig, swarm, hostTelemetry),
  );
  return {
    ...providerConfig,
    ...(loaded.meta ? { pricingCatalogMeta: loaded.meta } : {}),
    ...(Object.keys(relevant).length > 0 ? { pricingCatalog: relevant } : {}),
  };
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
  }
  return res.json();
}

async function fetchCatalogSource(
  source: 'litellm' | 'openrouter',
): Promise<{ source: 'litellm' | 'openrouter'; pricing: Record<string, ModelPricing> }> {
  const url = source === 'litellm' ? LITELLM_PRICING_URL : OPENROUTER_MODELS_URL;
  const json = await fetchJsonWithTimeout(url, SYNC_TIMEOUT_MS);
  const pricing =
    source === 'litellm' ? parseLiteLlmPricingCatalog(json) : parseOpenRouterPricingCatalog(json);
  if (Object.keys(pricing).length === 0) {
    throw new Error(`No valid model prices returned from ${source}`);
  }
  return { source, pricing };
}

/**
 * Explicitly fetch public community pricing catalog (only called on user Sync click).
 */
export async function syncPricingCatalog(
  dataDir: string,
  preferredSource: 'auto' | 'litellm' | 'openrouter' = 'auto',
): Promise<{ meta: PricingCatalogMeta; pricing: Record<string, ModelPricing> }> {
  const sources: Array<'litellm' | 'openrouter'> =
    preferredSource === 'litellm'
      ? ['litellm']
      : preferredSource === 'openrouter'
        ? ['openrouter']
        : ['litellm', 'openrouter'];

  const errors: string[] = [];
  for (const src of sources) {
    try {
      const { source, pricing } = await fetchCatalogSource(src);
      const fetchedAt = new Date().toISOString();
      const fileData: PricingCatalogFile = { source, fetchedAt, pricing };
      const catalogPath = join(dataDir, PRICING_CATALOG_FILENAME);
      atomicWriteJson(catalogPath, fileData);
      pricingCatalogCache.delete(catalogPath);
      return {
        meta: {
          source,
          fetchedAt,
          modelCount: Object.keys(pricing).length,
        },
        pricing,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${src}: ${msg}`);
    }
  }
  throw new Error(`Failed to sync model pricing catalog (${errors.join('; ')})`);
}
