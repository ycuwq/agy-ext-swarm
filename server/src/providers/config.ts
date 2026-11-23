import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import {
  detectClaudeModels,
  detectCodexModels,
  detectCustomLocalModels,
  detectGeminiModels,
  formatDshQualifiedModel,
  isValidDshProfileName,
  listDshModels,
  parseClaudeHelpModelAliases,
  parseModelsFromCliOutput,
  type LocalModelsDetection,
} from '../models.js';
import { atomicWriteJson } from '../store.js';
import type {
  CustomProviderConfig,
  DiscoverModelsResult,
  ModelInfo,
  ModelPricing,
  OrchestratorDelegationMode,
  ProviderDescriptor,
  ProviderEntryConfig,
  ProviderRoutingPolicy,
  ProviderTestResult,
  ProvidersConfigSnapshot,
  ProvidersFileConfig,
  TaskModelTarget,
  TaskRoutingCategory,
  TaskRoutingMap,
} from '../types.js';
import { buildAugmentedEnv } from '../worktree.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { createCustomAdapter } from './custom.js';
import { dshAdapter } from './dsh.js';
import { geminiAdapter } from './gemini.js';
import { quoteWinCmdArg, resolveExecutable, type CliProviderAdapter } from './shared.js';

const execFileAsync = promisify(execFile);

export const BUILTIN_ADAPTERS: Record<string, CliProviderAdapter> = {
  dsh: dshAdapter,
  claude: claudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
};

export function getBuiltinAdapter(id: string): CliProviderAdapter | undefined {
  const norm = id.trim().toLowerCase();
  return Object.hasOwn(BUILTIN_ADAPTERS, norm) ? BUILTIN_ADAPTERS[norm] : undefined;
}

const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const FORBIDDEN_PROVIDER_IDS = new Set([
  'constructor',
  '__proto__',
  'prototype',
  'tostring',
  'valueof',
  'hasownproperty',
]);

function isValidProviderId(id: string): boolean {
  return PROVIDER_ID_RE.test(id) && !FORBIDDEN_PROVIDER_IDS.has(id);
}

function dedupeStrings(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function sanitizeEnvMap(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = k.trim();
    if (!key || v === undefined || v === null) continue;
    out[key] = String(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeEntryConfig(raw: unknown): ProviderEntryConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const cfg: ProviderEntryConfig = {};

  if (typeof rec.enabled === 'boolean') cfg.enabled = rec.enabled;
  if (typeof rec.displayName === 'string' && rec.displayName.trim()) {
    cfg.displayName = rec.displayName.trim();
  }
  if (typeof rec.command === 'string' && rec.command.trim()) {
    cfg.command = rec.command.trim();
  }
  if (typeof rec.defaultModel === 'string' && rec.defaultModel.trim()) {
    cfg.defaultModel = rec.defaultModel.trim();
  }
  if (Array.isArray(rec.models)) {
    const models = dedupeStrings(rec.models);
    if (models.length > 0) cfg.models = models;
  }
  if (typeof rec.profile === 'string' && rec.profile.trim()) {
    cfg.profile = rec.profile.trim();
  }
  if (typeof rec.modelProvider === 'string' && rec.modelProvider.trim()) {
    cfg.modelProvider = rec.modelProvider.trim();
  }
  if (Array.isArray(rec.args)) {
    cfg.args = rec.args.map((s) => String(s));
  }
  if (Array.isArray(rec.resumeArgs)) {
    cfg.resumeArgs = rec.resumeArgs.map((s) => String(s));
  }
  if (Array.isArray(rec.listModelsArgs)) {
    const cleanListArgs = rec.listModelsArgs.map((s) => String(s).trim()).filter(Boolean);
    if (cleanListArgs.length > 0) cfg.listModelsArgs = cleanListArgs;
  }
  if (rec.promptMode === 'stdin' || rec.promptMode === 'arg') {
    cfg.promptMode = rec.promptMode;
  }
  if (rec.outputFormat === 'text' || rec.outputFormat === 'ndjson') {
    cfg.outputFormat = rec.outputFormat;
  }
  const env = sanitizeEnvMap(rec.env);
  if (env) cfg.env = env;

  return cfg;
}

function hasMeaningfulEntryConfig(cfg: ProviderEntryConfig | undefined): boolean {
  if (!cfg) return false;
  return Boolean(
    cfg.enabled === false ||
      cfg.displayName ||
      cfg.command ||
      cfg.defaultModel ||
      (cfg.models && cfg.models.length > 0) ||
      cfg.profile ||
      cfg.modelProvider ||
      (cfg.args && cfg.args.length > 0) ||
      (cfg.resumeArgs && cfg.resumeArgs.length > 0) ||
      (cfg.listModelsArgs && cfg.listModelsArgs.length > 0) ||
      cfg.promptMode ||
      cfg.outputFormat ||
      (cfg.env && Object.keys(cfg.env).length > 0),
  );
}

function sanitizePricingMap(raw: unknown): Record<string, ModelPricing> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, ModelPricing> = {};
  for (const [modelKey, val] of Object.entries(raw as Record<string, unknown>)) {
    const model = modelKey.trim();
    if (!model || !val || typeof val !== 'object' || Array.isArray(val)) continue;
    const rec = val as Record<string, unknown>;
    const inputPer1M = Number(rec.inputPer1M);
    const outputPer1M = Number(rec.outputPer1M);
    if (!Number.isFinite(inputPer1M) || inputPer1M < 0 || !Number.isFinite(outputPer1M) || outputPer1M < 0) {
      continue;
    }
    const cacheReadPer1M =
      rec.cacheReadPer1M !== undefined && Number.isFinite(Number(rec.cacheReadPer1M)) && Number(rec.cacheReadPer1M) >= 0
        ? Number(rec.cacheReadPer1M)
        : undefined;
    const currency = rec.currency === 'CNY' ? 'CNY' : rec.currency === 'USD' ? 'USD' : undefined;
    out[model] = {
      inputPer1M,
      outputPer1M,
      ...(cacheReadPer1M !== undefined ? { cacheReadPer1M } : {}),
      ...(currency ? { currency } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeProviderIdList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const norm = item.trim().toLowerCase();
    if (!norm || !isValidProviderId(norm) || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out.length > 0 ? out : undefined;
}

const TASK_ROUTING_CATEGORIES: readonly TaskRoutingCategory[] = [
  'complex',
  'coding',
  'frontend',
  'review',
  'research',
  'batch',
];

function sanitizeTaskRouting(raw: unknown): TaskRoutingMap | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const out: TaskRoutingMap = {};

  for (const cat of TASK_ROUTING_CATEGORIES) {
    const rawList = rec[cat];
    if (!Array.isArray(rawList)) continue;
    const seen = new Set<string>();
    const targets: TaskModelTarget[] = [];
    for (const entry of rawList) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const item = entry as Record<string, unknown>;
      const provider = typeof item.provider === 'string' ? item.provider.trim().toLowerCase() : '';
      if (!provider || !isValidProviderId(provider)) continue;
      const model = typeof item.model === 'string' && item.model.trim() ? item.model.trim() : undefined;
      const key = `${provider}::${model || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ provider, ...(model ? { model } : {}) });
    }
    if (targets.length > 0) {
      out[cat] = targets;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeRoutingPolicy(raw: unknown): ProviderRoutingPolicy | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const writerProviders = sanitizeProviderIdList(rec.writerProviders);
  const readerProviders = sanitizeProviderIdList(rec.readerProviders);
  const autoFailover = typeof rec.autoFailover === 'boolean' ? rec.autoFailover : undefined;
  const delegationMode: OrchestratorDelegationMode | undefined =
    rec.delegationMode === 'balanced' ||
    rec.delegationMode === 'prefer-external' ||
    rec.delegationMode === 'manual-only'
      ? rec.delegationMode
      : undefined;
  const taskRouting = sanitizeTaskRouting(rec.taskRouting);
  const routingNotes =
    typeof rec.routingNotes === 'string' && rec.routingNotes.trim()
      ? rec.routingNotes.trim().slice(0, 600)
      : undefined;

  if (
    !writerProviders &&
    !readerProviders &&
    autoFailover === undefined &&
    !delegationMode &&
    !taskRouting &&
    !routingNotes
  ) {
    return undefined;
  }
  return {
    ...(writerProviders ? { writerProviders } : {}),
    ...(readerProviders ? { readerProviders } : {}),
    ...(autoFailover !== undefined ? { autoFailover } : {}),
    ...(delegationMode ? { delegationMode } : {}),
    ...(taskRouting ? { taskRouting } : {}),
    ...(routingNotes ? { routingNotes } : {}),
  };
}

function readProvidersFile(filePath: string): ProvidersFileConfig {
  if (!existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') {
      const providers: Record<string, ProviderEntryConfig> = {};
      if (parsed.providers && typeof parsed.providers === 'object') {
        for (const [rawId, rawCfg] of Object.entries(parsed.providers as Record<string, unknown>)) {
          const id = rawId.trim().toLowerCase();
          if (!id || !isValidProviderId(id)) continue;
          const sanitized = sanitizeEntryConfig(rawCfg);
          if (sanitized) providers[id] = sanitized;
        }
      }
      const pricing = sanitizePricingMap(parsed.pricing);
      const activePool = sanitizeProviderIdList(parsed.activePool);
      const routingPolicy = sanitizeRoutingPolicy(parsed.routingPolicy);
      return {
        defaultProvider:
          typeof parsed.defaultProvider === 'string' && parsed.defaultProvider.trim()
            ? parsed.defaultProvider.trim().toLowerCase()
            : undefined,
        ...(activePool ? { activePool } : {}),
        ...(routingPolicy ? { routingPolicy } : {}),
        providers: Object.keys(providers).length > 0 ? providers : undefined,
        ...(pricing ? { pricing } : {}),
      };
    }
  } catch (err) {
    console.error(`[agy-ext-swarm] Failed to read ${filePath}:`, err);
  }
  return {};
}

interface MergedProvidersState {
  globalConfigPath: string;
  globalConfigExists: boolean;
  repoConfigPath?: string;
  repoConfigExists: boolean;
  globalCfg: ProvidersFileConfig;
  repoCfg: ProvidersFileConfig;
  configuredDefaultProvider?: string;
  activePool?: string[];
  routingPolicy?: ProviderRoutingPolicy;
  providers: Record<string, ProviderEntryConfig>;
  pricing: Record<string, ModelPricing>;
}

function mergeProvidersConfig(dataDir: string, repoRoot?: string): MergedProvidersState {
  const globalConfigPath = join(dataDir, 'providers.json');
  const globalConfigExists = existsSync(globalConfigPath);
  const repoConfigPath = repoRoot ? join(repoRoot, '.agy-ext-swarm', 'providers.json') : undefined;
  const repoConfigExists = Boolean(repoConfigPath && existsSync(repoConfigPath));
  const globalCfg = readProvidersFile(globalConfigPath);
  const repoCfg = repoConfigPath ? readProvidersFile(repoConfigPath) : {};

  const merged: Record<string, ProviderEntryConfig> = {};
  for (const [id, cfg] of Object.entries(globalCfg.providers || {})) {
    merged[id] = { ...cfg };
  }
  for (const [id, rawCfg] of Object.entries(repoCfg.providers || {})) {
    let cfg = rawCfg;
    if (getBuiltinAdapter(id)) {
      const {
        command: _cmd,
        args: _args,
        resumeArgs: _rArgs,
        listModelsArgs: _lmArgs,
        env: _env,
        ...safeFields
      } = rawCfg;
      if (
        safeFields.profile &&
        (!isValidDshProfileName(safeFields.profile) || safeFields.profile.toLowerCase() === 'desktop')
      ) {
        delete safeFields.profile;
      }
      cfg = safeFields;
    }
    const prev = merged[id];
    merged[id] = prev
      ? {
          ...prev,
          ...cfg,
          env: prev.env || cfg.env ? { ...(prev.env || {}), ...(cfg.env || {}) } : undefined,
        }
      : { ...cfg };
  }

  const pricing: Record<string, ModelPricing> = {
    ...(globalCfg.pricing || {}),
    ...(repoCfg.pricing || {}),
  };

  const activePool = repoCfg.activePool || globalCfg.activePool;
  const mergedTaskRouting =
    globalCfg.routingPolicy?.taskRouting || repoCfg.routingPolicy?.taskRouting
      ? {
          ...(globalCfg.routingPolicy?.taskRouting || {}),
          ...(repoCfg.routingPolicy?.taskRouting || {}),
        }
      : undefined;
  const mergedRouting =
    globalCfg.routingPolicy || repoCfg.routingPolicy
      ? {
          ...(globalCfg.routingPolicy || {}),
          ...(repoCfg.routingPolicy || {}),
          ...(mergedTaskRouting ? { taskRouting: mergedTaskRouting } : {}),
        }
      : undefined;

  return {
    globalConfigPath,
    globalConfigExists,
    repoConfigPath,
    repoConfigExists,
    globalCfg,
    repoCfg,
    configuredDefaultProvider: repoCfg.defaultProvider || globalCfg.defaultProvider,
    activePool,
    routingPolicy: mergedRouting,
    providers: merged,
    pricing,
  };
}

export function loadCustomProviders(
  dataDir: string,
  repoRoot?: string,
): Record<string, CustomProviderConfig> {
  const state = mergeProvidersConfig(dataDir, repoRoot);
  const out: Record<string, CustomProviderConfig> = {};
  for (const [id, cfg] of Object.entries(state.providers)) {
    if (getBuiltinAdapter(id)) continue;
    if (typeof cfg.command === 'string' && cfg.command.trim()) {
      out[id] = { ...cfg, command: cfg.command.trim() };
    }
  }
  return out;
}

export function applyBuiltinOverride(
  base: CliProviderAdapter,
  override?: ProviderEntryConfig,
): CliProviderAdapter {
  if (!override) return base;
  const mergedEnv = override.env ? { ...override.env } : undefined;
  const overridden: CliProviderAdapter = {
    ...base,
    displayName: override.displayName?.trim() || base.displayName,
    command: override.command?.trim() || base.command,
    defaultModel: override.defaultModel?.trim() || base.defaultModel,
    buildInvocation(ctx) {
      const inv = base.buildInvocation.call(overridden, ctx);
      if (mergedEnv) {
        inv.env = { ...mergedEnv, ...(inv.env || {}) };
      }
      return inv;
    },
  };
  return overridden;
}

export interface SaveProviderConfigPatch {
  defaultProvider?: string | null;
  activePool?: string[] | null;
  routingPolicy?: ProviderRoutingPolicy | null;
  upsertProvider?: {
    id: string;
    config: ProviderEntryConfig | null;
  };
  upsertProviders?: Array<{
    id: string;
    config: ProviderEntryConfig | null;
  }>;
  removeProvider?: string;
  upsertPricing?: {
    model: string;
    pricing: ModelPricing | null;
  };
}

export function saveProviderConfigPatch(
  dataDir: string,
  patch: SaveProviderConfigPatch,
): ProvidersFileConfig {
  const globalPath = join(dataDir, 'providers.json');
  const current = readProvidersFile(globalPath);
  const nextProviders: Record<string, ProviderEntryConfig> = { ...(current.providers || {}) };
  const nextPricing: Record<string, ModelPricing> = { ...(current.pricing || {}) };
  let nextDefault = current.defaultProvider;
  let nextActivePool = current.activePool ? [...current.activePool] : undefined;
  let nextRouting = current.routingPolicy ? { ...current.routingPolicy } : undefined;

  if (patch.defaultProvider !== undefined) {
    if (patch.defaultProvider === null || !patch.defaultProvider.trim()) {
      nextDefault = undefined;
    } else {
      const norm = patch.defaultProvider.trim().toLowerCase();
      if (!isValidProviderId(norm)) {
        throw new Error(
          `Invalid defaultProvider "${patch.defaultProvider}". Must match ^[a-z0-9][a-z0-9_-]{0,31}$ and not be reserved.`,
        );
      }
      nextDefault = norm;
    }
  }

  if (patch.activePool !== undefined) {
    if (patch.activePool === null || patch.activePool.length === 0) {
      nextActivePool = undefined;
    } else {
      nextActivePool = sanitizeProviderIdList(patch.activePool);
    }
  }

  if (patch.routingPolicy !== undefined) {
    if (patch.routingPolicy === null) {
      nextRouting = undefined;
    } else {
      nextRouting = sanitizeRoutingPolicy(patch.routingPolicy);
    }
  }

  const pruneProviderReferences = (rmId: string) => {
    if (nextDefault === rmId) {
      nextDefault = undefined;
    }
    if (nextActivePool) {
      nextActivePool = nextActivePool.filter((id) => id !== rmId);
      if (nextActivePool.length === 0) nextActivePool = undefined;
    }
    if (nextRouting) {
      if (nextRouting.writerProviders) {
        nextRouting.writerProviders = nextRouting.writerProviders.filter((id) => id !== rmId);
        if (nextRouting.writerProviders.length === 0) delete nextRouting.writerProviders;
      }
      if (nextRouting.readerProviders) {
        nextRouting.readerProviders = nextRouting.readerProviders.filter((id) => id !== rmId);
        if (nextRouting.readerProviders.length === 0) delete nextRouting.readerProviders;
      }
      if (nextRouting.taskRouting) {
        for (const cat of TASK_ROUTING_CATEGORIES) {
          const list = nextRouting.taskRouting[cat];
          if (!list) continue;
          const filtered = list.filter((t) => t.provider !== rmId);
          if (filtered.length > 0) nextRouting.taskRouting[cat] = filtered;
          else delete nextRouting.taskRouting[cat];
        }
        if (Object.keys(nextRouting.taskRouting).length === 0) {
          delete nextRouting.taskRouting;
        }
      }
      nextRouting = sanitizeRoutingPolicy(nextRouting);
    }
  };

  if (patch.removeProvider) {
    const rmId = patch.removeProvider.trim().toLowerCase();
    delete nextProviders[rmId];
    pruneProviderReferences(rmId);
  }

  const upserts = [
    ...(patch.upsertProviders || []),
    ...(patch.upsertProvider ? [patch.upsertProvider] : []),
  ];

  for (const item of upserts) {
    const id = item.id.trim().toLowerCase();
    if (!isValidProviderId(id)) {
      throw new Error(
        `Invalid provider ID "${item.id}". Must match ^[a-z0-9][a-z0-9_-]{0,31}$ (lowercase letters, numbers, - or _) and not be reserved.`,
      );
    }
    if (item.config === null) {
      delete nextProviders[id];
      if (!getBuiltinAdapter(id)) {
        pruneProviderReferences(id);
      }
    } else {
      const sanitized = sanitizeEntryConfig(item.config) || {};
      const builtinBase = getBuiltinAdapter(id);
      const isBuiltin = Boolean(builtinBase);
      if (
        id === 'dsh' &&
        sanitized.profile &&
        (!isValidDshProfileName(sanitized.profile) || sanitized.profile.toLowerCase() === 'desktop')
      ) {
        throw new Error(
          `Invalid dsh profile "${sanitized.profile}". Must match ^[a-zA-Z0-9_-]{1,64}$ and cannot be "desktop".`,
        );
      }
      if (!isBuiltin && (!sanitized.command || !sanitized.command.trim())) {
        throw new Error(`Custom CLI provider "${id}" requires a non-empty command.`);
      }
      if (isBuiltin && builtinBase) {
        if (sanitized.displayName === builtinBase.displayName) {
          delete sanitized.displayName;
        }
        if (sanitized.command === builtinBase.command) {
          delete sanitized.command;
        }
        if (id === 'dsh' && sanitized.profile === 'headless') {
          delete sanitized.profile;
        }
        if (id !== 'dsh' && builtinBase.defaultModel && sanitized.defaultModel === builtinBase.defaultModel) {
          delete sanitized.defaultModel;
        }
      }
      if (sanitized.enabled === true) {
        delete sanitized.enabled;
      }
      if (isBuiltin && !hasMeaningfulEntryConfig(sanitized)) {
        delete nextProviders[id];
      } else {
        nextProviders[id] = sanitized;
      }
      if (sanitized.enabled === false && nextDefault === id) {
        nextDefault = undefined;
      }
    }
  }

  if (patch.upsertPricing) {
    const modelKey = patch.upsertPricing.model.trim();
    if (!modelKey) {
      throw new Error('Model name for pricing cannot be empty.');
    }
    if (patch.upsertPricing.pricing === null) {
      delete nextPricing[modelKey];
    } else {
      const sanitizedOne = sanitizePricingMap({ [modelKey]: patch.upsertPricing.pricing });
      if (!sanitizedOne || !sanitizedOne[modelKey]) {
        throw new Error(`Invalid pricing values for "${modelKey}".`);
      }
      nextPricing[modelKey] = sanitizedOne[modelKey];
    }
  }

  const out: ProvidersFileConfig = {};
  if (nextDefault) {
    out.defaultProvider = nextDefault;
  }
  if (nextActivePool && nextActivePool.length > 0) {
    out.activePool = nextActivePool;
  }
  if (nextRouting) {
    out.routingPolicy = nextRouting;
  }
  if (Object.keys(nextProviders).length > 0) {
    out.providers = nextProviders;
  }
  if (Object.keys(nextPricing).length > 0) {
    out.pricing = nextPricing;
  }
  atomicWriteJson(globalPath, out);
  providerSnapshotCache.clear();
  runtimeDiscoveredModelsCache.clear();
  return out;
}

export function resolveDefaultProvider(dataDir: string, repoRoot?: string): string {
  const state = mergeProvidersConfig(dataDir, repoRoot);
  const configured = state.configuredDefaultProvider;
  if (configured) {
    const entry = state.providers[configured];
    const isKnown = Boolean(
      getBuiltinAdapter(configured) || (entry && typeof entry.command === 'string' && entry.command.trim()),
    );
    if (isKnown && entry?.enabled !== false) {
      return configured;
    }
  }

  const priority = ['dsh', 'claude', 'codex', 'gemini'];
  for (const id of priority) {
    const adapter = getBuiltinAdapter(id);
    const override = state.providers[id];
    if (!adapter || override?.enabled === false) continue;
    const cmd = override?.command?.trim() || adapter.command;
    if (resolveExecutable(cmd)) {
      return id;
    }
  }

  for (const [id, cfg] of Object.entries(state.providers)) {
    if (getBuiltinAdapter(id) || cfg.enabled === false) continue;
    if (cfg.command && resolveExecutable(cfg.command)) {
      return id;
    }
  }

  for (const id of priority) {
    if (state.providers[id]?.enabled !== false) {
      return id;
    }
  }
  return 'dsh';
}

export function resolveProviderAdapter(
  providerId: string,
  inlineCustomConfig: CustomProviderConfig | undefined,
  dataDir: string,
  repoRoot?: string,
): CliProviderAdapter {
  const id = providerId.trim().toLowerCase() || 'dsh';
  if (inlineCustomConfig) {
    return createCustomAdapter(id, inlineCustomConfig);
  }
  const state = mergeProvidersConfig(dataDir, repoRoot);
  const entry = state.providers[id];
  if (entry?.enabled === false) {
    throw new Error(
      `CLI provider "${id}" is disabled in AGY Ext Swarm settings. Enable it in the Settings tab or providers.json.`,
    );
  }
  const builtin = getBuiltinAdapter(id);
  if (builtin) {
    return applyBuiltinOverride(builtin, entry);
  }
  if (entry && typeof entry.command === 'string' && entry.command.trim()) {
    return createCustomAdapter(id, entry as CustomProviderConfig);
  }
  throw new Error(
    `Unknown CLI provider "${providerId}". Available built-ins: ${Object.keys(BUILTIN_ADAPTERS).join(', ')}. Or pass custom_command / configure ${join(dataDir, 'providers.json')}.`,
  );
}

const PROVIDER_SNAPSHOT_TTL_MS = 10_000;
const RUNTIME_DISCOVERED_TTL_MS = 10 * 60_000;
const providerSnapshotCache = new Map<
  string,
  { expiresAt: number; mtimeSig: string; snapshot: ProvidersConfigSnapshot }
>();
const runtimeDiscoveredModelsCache = new Map<
  string,
  { models: string[]; defaultModel?: string; source?: string; expiresAt: number }
>();

function detectBuiltinLocalModels(id: string): LocalModelsDetection {
  if (id === 'codex') return detectCodexModels();
  if (id === 'claude') return detectClaudeModels();
  if (id === 'gemini') return detectGeminiModels();
  return { models: [] };
}

function runtimeCacheKey(
  id: string,
  command: string,
  listModelsArgs?: string[],
  profile?: string,
): string {
  return `${id}|${command.trim()}|${(listModelsArgs || []).join('\0')}|${profile || ''}`;
}

function mergeLocalAndRuntimeModels(
  cacheKey: string,
  local: LocalModelsDetection,
): LocalModelsDetection {
  const cached = runtimeDiscoveredModelsCache.get(cacheKey);
  if (!cached) return local;
  if (Date.now() >= cached.expiresAt) {
    runtimeDiscoveredModelsCache.delete(cacheKey);
    return local;
  }
  const models = dedupeStrings([...local.models, ...cached.models]);
  const defaultModel = local.defaultModel || cached.defaultModel;
  const source =
    local.source && cached.source && local.source !== cached.source
      ? `${local.source} + ${cached.source}`
      : local.source || cached.source;
  return {
    models,
    ...(defaultModel ? { defaultModel } : {}),
    ...(source ? { source } : {}),
  };
}

function fileMtimeToken(filePath?: string): string {
  if (!filePath || !existsSync(filePath)) return '0';
  try {
    return String(statSync(filePath).mtimeMs);
  } catch {
    return '0';
  }
}

export function getProviderConfigSnapshot(
  dataDir: string,
  repoRoot?: string,
  profileOverride?: string,
  bypassCache = false,
): ProvidersConfigSnapshot {
  const globalPath = join(dataDir, 'providers.json');
  const repoPath = repoRoot ? join(repoRoot, '.agy-ext-swarm', 'providers.json') : undefined;
  const cacheKey = `${dataDir}|${repoRoot || ''}|${profileOverride || ''}`;
  const mtimeSig = `${fileMtimeToken(globalPath)}:${fileMtimeToken(repoPath)}`;
  const now = Date.now();
  if (!bypassCache) {
    const cached = providerSnapshotCache.get(cacheKey);
    if (cached && now < cached.expiresAt && cached.mtimeSig === mtimeSig) {
      return cached.snapshot;
    }
  }

  const state = mergeProvidersConfig(dataDir, repoRoot);
  const descriptors: ProviderDescriptor[] = [];

  for (const base of Object.values(BUILTIN_ADAPTERS)) {
    const entry = state.providers[base.id];
    const enabled = entry?.enabled !== false;
    const displayName = entry?.displayName?.trim() || base.displayName;
    const command = entry?.command?.trim() || base.command;
    const resolvedPath = resolveExecutable(command);
    const configuredModels = dedupeStrings(entry?.models);
    const configuredDefaultModel = entry?.defaultModel?.trim() || undefined;

    if (base.id === 'dsh') {
      const configuredProfile = entry?.profile?.trim() || undefined;
      const effectiveProfile = profileOverride?.trim() || configuredProfile || 'headless';
      const configuredModelProvider = entry?.modelProvider?.trim() || undefined;
      const catalog = listDshModels(effectiveProfile);
      const detectedModelProviders = dedupeStrings([
        ...(catalog.providers || []),
        ...(catalog.defaultProvider ? [catalog.defaultProvider] : []),
      ]);
      const localDsh: LocalModelsDetection = {
        models: dedupeStrings(
          catalog.models.map((m) =>
            formatDshQualifiedModel(
              m.provider || catalog.defaultProvider || configuredModelProvider || undefined,
              m.id,
            ),
          ),
        ),
        defaultModel: catalog.defaultModel
          ? formatDshQualifiedModel(
              catalog.defaultProvider || configuredModelProvider || undefined,
              catalog.defaultModel,
            )
          : undefined,
        source: catalog.catalogSourceProfile
          ? `~/.dsh/profiles/${catalog.catalogSourceProfile} (read-only)`
          : catalog.exists
            ? `~/.dsh/profiles/${effectiveProfile}`
            : undefined,
      };
      const detected = mergeLocalAndRuntimeModels(
        runtimeCacheKey('dsh', command, entry?.listModelsArgs, effectiveProfile),
        localDsh,
      );
      const detectedDefaultModel = detected.defaultModel;
      const detectedModelProvider = catalog.defaultProvider || undefined;
      const qualifiedConfiguredDefault = configuredDefaultModel
        ? configuredDefaultModel.includes('/')
          ? configuredDefaultModel
          : configuredModelProvider
            ? formatDshQualifiedModel(configuredModelProvider, configuredDefaultModel)
            : configuredDefaultModel
        : undefined;
      const defaultModel = qualifiedConfiguredDefault || detectedDefaultModel || 'default';
      const models =
        configuredModels.length > 0
          ? configuredModels
          : detected.models.length > 0
            ? detected.models
            : defaultModel
              ? [defaultModel]
              : [];
      descriptors.push({
        id: base.id,
        displayName,
        kind: 'builtin',
        enabled,
        command,
        available: resolvedPath !== null,
        resolvedPath: resolvedPath || undefined,
        supportsSessionResume: base.supportsSessionResume,
        supportsStreamEvents: base.supportsStreamEvents,
        defaultModel,
        configuredDefaultModel,
        detectedDefaultModel,
        detectedModelProvider,
        ...(detectedModelProviders.length > 0 ? { detectedModelProviders } : {}),
        models,
        configuredModels,
        detectedModels: detected.models,
        ...(detected.source ? { detectedModelsSource: detected.source } : {}),
        profile: effectiveProfile,
        ...(configuredProfile ? { configuredProfile } : {}),
        modelProvider: configuredModelProvider,
        hasOverride: hasMeaningfulEntryConfig(entry),
        ...(entry?.listModelsArgs && entry.listModelsArgs.length > 0
          ? { listModelsArgs: entry.listModelsArgs }
          : {}),
        env: entry?.env,
        notes: base.notes,
      });
    } else {
      const detected = mergeLocalAndRuntimeModels(
        runtimeCacheKey(base.id, command, entry?.listModelsArgs),
        detectBuiltinLocalModels(base.id),
      );
      const detectedDefaultModel = detected.defaultModel;
      const defaultModel =
        configuredDefaultModel || detectedDefaultModel || base.defaultModel || 'default';
      const models =
        configuredModels.length > 0
          ? configuredModels
          : detected.models.length > 0
            ? detected.models
            : defaultModel
              ? [defaultModel]
              : [];
      descriptors.push({
        id: base.id,
        displayName,
        kind: 'builtin',
        enabled,
        command,
        available: resolvedPath !== null,
        resolvedPath: resolvedPath || undefined,
        supportsSessionResume: base.supportsSessionResume,
        supportsStreamEvents: base.supportsStreamEvents,
        defaultModel,
        configuredDefaultModel,
        ...(detectedDefaultModel ? { detectedDefaultModel } : {}),
        models,
        configuredModels,
        ...(detected.models.length > 0 ? { detectedModels: detected.models } : {}),
        ...(detected.source ? { detectedModelsSource: detected.source } : {}),
        hasOverride: hasMeaningfulEntryConfig(entry),
        ...(entry?.listModelsArgs && entry.listModelsArgs.length > 0
          ? { listModelsArgs: entry.listModelsArgs }
          : {}),
        env: entry?.env,
        notes: base.notes,
      });
    }
  }

  for (const [id, entry] of Object.entries(state.providers)) {
    if (getBuiltinAdapter(id)) continue;
    if (typeof entry.command !== 'string' || !entry.command.trim()) continue;
    const adapter = createCustomAdapter(id, entry as CustomProviderConfig);
    const resolvedPath = resolveExecutable(adapter.command);
    const configuredModels = dedupeStrings(entry.models);
    const configuredDefaultModel = entry.defaultModel?.trim() || undefined;
    const detected = mergeLocalAndRuntimeModels(
      runtimeCacheKey(id, adapter.command, entry.listModelsArgs),
      detectCustomLocalModels(id, adapter.command),
    );
    const detectedDefaultModel = detected.defaultModel;
    const defaultModel =
      configuredDefaultModel || detectedDefaultModel || adapter.defaultModel || 'default';
    const models =
      configuredModels.length > 0
        ? configuredModels
        : detected.models.length > 0
          ? detected.models
          : defaultModel
            ? [defaultModel]
            : [];
    descriptors.push({
      id,
      displayName: adapter.displayName,
      kind: 'custom',
      enabled: entry.enabled !== false,
      command: adapter.command,
      available: resolvedPath !== null,
      resolvedPath: resolvedPath || undefined,
      supportsSessionResume: adapter.supportsSessionResume,
      supportsStreamEvents: adapter.supportsStreamEvents,
      defaultModel,
      configuredDefaultModel,
      ...(detectedDefaultModel ? { detectedDefaultModel } : {}),
      models,
      configuredModels,
      ...(detected.models.length > 0 ? { detectedModels: detected.models } : {}),
      ...(detected.source ? { detectedModelsSource: detected.source } : {}),
      hasOverride: true,
      args: entry.args,
      resumeArgs: entry.resumeArgs,
      ...(entry.listModelsArgs ? { listModelsArgs: entry.listModelsArgs } : {}),
      promptMode: entry.promptMode,
      outputFormat: entry.outputFormat,
      env: entry.env,
      notes: adapter.notes,
    });
  }

  const snapshot: ProvidersConfigSnapshot = {
    globalConfigPath: state.globalConfigPath,
    globalConfigExists: state.globalConfigExists,
    repoConfigPath: state.repoConfigPath,
    repoConfigExists: state.repoConfigExists,
    configuredDefaultProvider: state.configuredDefaultProvider,
    effectiveDefaultProvider: resolveDefaultProvider(dataDir, repoRoot),
    ...(state.activePool && state.activePool.length > 0 ? { activePool: state.activePool } : {}),
    ...(state.routingPolicy ? { routingPolicy: state.routingPolicy } : {}),
    providers: descriptors,
    ...(Object.keys(state.pricing).length > 0 ? { pricing: state.pricing } : {}),
  };
  if (providerSnapshotCache.size >= 32) {
    const oldest = providerSnapshotCache.keys().next().value;
    if (oldest) providerSnapshotCache.delete(oldest);
  }
  providerSnapshotCache.set(cacheKey, {
    expiresAt: Date.now() + PROVIDER_SNAPSHOT_TTL_MS,
    mtimeSig,
    snapshot,
  });
  return snapshot;
}

export async function testProviderConnection(
  providerId: string,
  dataDir: string,
  repoRoot?: string,
  profileOverride?: string,
): Promise<ProviderTestResult> {
  const id = providerId.trim().toLowerCase();
  const snap = getProviderConfigSnapshot(dataDir, repoRoot, profileOverride, true);
  const descriptor = snap.providers.find((p) => p.id === id);
  const warnings: string[] = [];

  if (!descriptor) {
    return {
      providerId: id,
      command: id,
      ok: false,
      latencyMs: 0,
      details: `Unknown CLI provider "${providerId}".`,
    };
  }

  if (!descriptor.enabled) {
    warnings.push('Provider is currently disabled in Settings.');
  }

  if (!descriptor.resolvedPath) {
    return {
      providerId: id,
      command: descriptor.command,
      ok: false,
      latencyMs: 0,
      details: `Command "${descriptor.command}" not found in PATH or at specified path.`,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  const start = Date.now();
  const env = buildAugmentedEnv(descriptor.env);
  const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(descriptor.resolvedPath);
  const execCmd = useShell ? quoteWinCmdArg(descriptor.resolvedPath) : descriptor.resolvedPath;

  let versionText = '';
  let probeOk = false;
  let probeError = '';

  for (const flag of ['--version', '-v']) {
    try {
      const res = await execFileAsync(execCmd, useShell ? [quoteWinCmdArg(flag)] : [flag], {
        env,
        timeout: 5000,
        maxBuffer: 256 * 1024,
        shell: useShell,
        ...(useShell ? { windowsVerbatimArguments: true } : {}),
      });
      const combined = `${res.stdout || ''}\n${res.stderr || ''}`.trim();
      if (combined) {
        versionText = combined.split('\n')[0].trim().slice(0, 120);
      }
      probeOk = true;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      probeError = msg;
    }
  }

  const latencyMs = Date.now() - start;

  if (!probeOk) {
    return {
      providerId: id,
      command: descriptor.command,
      resolvedPath: descriptor.resolvedPath,
      ok: false,
      latencyMs,
      details: `Executable found at ${descriptor.resolvedPath}, but version probe failed: ${probeError.slice(0, 240)}`,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  const extraDetails: string[] = [];
  if (versionText) {
    extraDetails.push(`version: ${versionText}`);
  } else {
    extraDetails.push(`executable responded (${latencyMs}ms)`);
  }

  if (id === 'dsh') {
    const profile = profileOverride?.trim() || descriptor.profile || 'headless';
    const catalog = listDshModels(profile);
    if (!catalog.exists) {
      warnings.push(`dsh profile patch file not found: ${catalog.configPath}`);
    } else {
      extraDetails.push(
        `profile="${profile}", defaultModel="${catalog.defaultModel || 'default'}", catalog=${catalog.models.length} models`,
      );
    }
  }

  return {
    providerId: id,
    command: descriptor.command,
    resolvedPath: descriptor.resolvedPath,
    ok: true,
    ...(versionText ? { version: versionText } : {}),
    latencyMs,
    details: extraDetails.join(' | '),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export async function discoverProviderModels(
  providerId: string,
  dataDir: string,
  repoRoot?: string,
  profileOverride?: string,
): Promise<DiscoverModelsResult> {
  const start = Date.now();
  const id = providerId.trim().toLowerCase();
  for (const k of Array.from(runtimeDiscoveredModelsCache.keys())) {
    if (k.startsWith(`${id}|`)) {
      runtimeDiscoveredModelsCache.delete(k);
    }
  }
  providerSnapshotCache.clear();

  const snap = getProviderConfigSnapshot(dataDir, repoRoot, profileOverride, true);
  const descriptor = snap.providers.find((p) => p.id === id);
  if (!descriptor) {
    return {
      providerId: id,
      ok: false,
      models: [],
      latencyMs: Date.now() - start,
      error: `Unknown CLI provider "${providerId}".`,
    };
  }

  const localModels = descriptor.detectedModels || [];
  const defaultModel = descriptor.detectedDefaultModel;
  const localSource = descriptor.detectedModelsSource;
  let cliModels: string[] = [];
  let cliSource: string | undefined;
  let cliError: string | undefined;

  if (descriptor.resolvedPath) {
    const env = buildAugmentedEnv(descriptor.env);
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(descriptor.resolvedPath);
    const execCmd = useShell ? quoteWinCmdArg(descriptor.resolvedPath) : descriptor.resolvedPath;
    const cmdBase = basename(descriptor.command.trim()).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();

    const listArgs =
      descriptor.listModelsArgs && descriptor.listModelsArgs.length > 0
        ? descriptor.listModelsArgs
        : id === 'opencode' || cmdBase === 'opencode'
          ? ['models']
          : undefined;
    if (listArgs && listArgs.length > 0) {
      try {
        const res = await execFileAsync(
          execCmd,
          useShell ? listArgs.map(quoteWinCmdArg) : listArgs,
          {
            env,
            timeout: 8000,
            maxBuffer: 512 * 1024,
            shell: useShell,
            ...(useShell ? { windowsVerbatimArguments: true } : {}),
          },
        );
        const outText = (res.stdout || '').trim() || (res.stderr || '').trim();
        cliModels = parseModelsFromCliOutput(outText);
        if (cliModels.length > 0) {
          cliSource = `CLI: ${descriptor.command} ${listArgs.join(' ')}`;
        }
      } catch (err) {
        if (descriptor.listModelsArgs && descriptor.listModelsArgs.length > 0) {
          cliError = err instanceof Error ? err.message : String(err);
        }
      }
    } else if (id === 'claude') {
      try {
        const res = await execFileAsync(execCmd, useShell ? [quoteWinCmdArg('--help')] : ['--help'], {
          env,
          timeout: 5000,
          maxBuffer: 256 * 1024,
          shell: useShell,
          ...(useShell ? { windowsVerbatimArguments: true } : {}),
        });
        cliModels = parseClaudeHelpModelAliases(`${res.stdout || ''}\n${res.stderr || ''}`);
        if (cliModels.length > 0) cliSource = 'claude --help';
      } catch {
        // Best-effort CLI alias probe
      }
    }
  }

  const models = dedupeStrings([...localModels, ...cliModels]);
  const source =
    localSource && cliSource && localSource !== cliSource
      ? `${localSource} + ${cliSource}`
      : cliSource || localSource;

  if (cliModels.length > 0) {
    runtimeDiscoveredModelsCache.set(
      runtimeCacheKey(id, descriptor.command, descriptor.listModelsArgs, descriptor.profile),
      {
        models: cliModels,
        ...(cliSource ? { source: cliSource } : {}),
        expiresAt: Date.now() + RUNTIME_DISCOVERED_TTL_MS,
      },
    );
    providerSnapshotCache.clear();
  }

  if (cliError && models.length === 0) {
    return {
      providerId: id,
      ok: false,
      models: [],
      latencyMs: Date.now() - start,
      error: cliError.slice(0, 240),
    };
  }

  return {
    providerId: id,
    ok: true,
    models,
    ...(defaultModel ? { defaultModel } : {}),
    ...(source ? { source } : {}),
    latencyMs: Date.now() - start,
  };
}

export function listProviders(
  dataDir: string,
  repoRoot?: string,
  profile = 'headless',
): ProviderDescriptor[] {
  return getProviderConfigSnapshot(dataDir, repoRoot, profile).providers;
}

export interface ProviderModelsResult {
  provider: string;
  displayName: string;
  enabled: boolean;
  available: boolean;
  defaultModel: string;
  models: string[];
  configuredModels: string[];
  detectedModels?: string[];
  modelDetails?: ModelInfo[];
  profile?: string;
  configPath?: string;
  exists?: boolean;
  modelProvider?: string;
  modelProviders?: string[];
  note?: string;
}

export function getProviderModels(
  providerId: string | undefined,
  dataDir: string,
  repoRoot?: string,
  profileOverride?: string,
): ProviderModelsResult {
  const resolvedId = (providerId?.trim() || resolveDefaultProvider(dataDir, repoRoot)).toLowerCase();
  const snap = getProviderConfigSnapshot(dataDir, repoRoot, profileOverride, true);
  const descriptor = snap.providers.find((p) => p.id === resolvedId);

  if (resolvedId === 'dsh') {
    const effectiveProfile = profileOverride?.trim() || descriptor?.profile || 'headless';
    const catalog = listDshModels(effectiveProfile);
    const effectiveModelProvider = descriptor?.modelProvider || catalog.defaultProvider || undefined;
    return {
      provider: 'dsh',
      displayName: descriptor?.displayName || 'DeepSeek Harness (dsh)',
      enabled: descriptor?.enabled ?? true,
      available: descriptor?.available ?? false,
      defaultModel: descriptor?.defaultModel || 'default',
      models: descriptor?.models || [],
      configuredModels: descriptor?.configuredModels || [],
      detectedModels: descriptor?.detectedModels,
      modelDetails: catalog.models,
      profile: effectiveProfile,
      configPath: catalog.configPath,
      exists: catalog.exists,
      modelProvider: effectiveModelProvider,
      ...(descriptor?.detectedModelProviders?.length
        ? { modelProviders: descriptor.detectedModelProviders }
        : {}),
      note: catalog.note,
    };
  }

  return {
    provider: resolvedId,
    displayName: descriptor?.displayName || resolvedId,
    enabled: descriptor?.enabled ?? true,
    available: descriptor?.available ?? false,
    defaultModel: descriptor?.defaultModel || 'default',
    models: descriptor?.models || ['default'],
    configuredModels: descriptor?.configuredModels || [],
    ...(descriptor?.detectedModels ? { detectedModels: descriptor.detectedModels } : {}),
    note:
      descriptor?.notes ||
      `Pass any model identifier supported by "${resolvedId}" CLI directly to ext_swarm_add.`,
  };
}
