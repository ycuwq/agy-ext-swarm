import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import {
  DEFAULT_REASONING_EFFORTS_BY_PROVIDER,
  lookupModelCapability,
  parseEffortFromModelName,
  sanitizeReasoningEffort,
} from '../../shared/model-options.js';
import {
  checkDshModelCatalogReadiness,
  checkDshProfileCatalogPlugins,
  checkDshProfileProviderPlugin,
  detectAgyModels,
  detectClaudeModels,
  detectCodexModels,
  detectCustomLocalModels,
  detectGeminiModels,
  formatDshQualifiedModel,
  getDshHome,
  inferAgyModelCapabilities,
  isValidDshProfileName,
  listDshModels,
  parseClaudeHelpModelAliases,
  parseDshQualifiedModel,
  parseModelsFromCliOutput,
  type LocalModelsDetection,
} from '../models.js';
import type {
  CustomProviderConfig,
  DiscoverModelsResult,
  ModelCapabilities,
  ModelInfo,
  ProviderDescriptor,
  ProviderTestResult,
  ProvidersConfigSnapshot,
  ProvidersFileConfig,
} from '../types.js';
import { buildAugmentedEnv } from '../worktree.js';
import {
  BUILTIN_ADAPTERS,
  applyBuiltinOverride,
  dedupeStrings,
  getBuiltinAdapter,
  hasMeaningfulEntryConfig,
  loadCustomProviders,
  mergeProvidersConfig,
  persistProviderConfigPatch,
  type SaveProviderConfigPatch,
} from './config-store.js';
import { createCustomAdapter } from './custom.js';
import { quoteWinCmdArg, resolveExecutable, type CliProviderAdapter } from './shared.js';

export {
  BUILTIN_ADAPTERS,
  applyBuiltinOverride,
  getBuiltinAdapter,
  loadCustomProviders,
  type SaveProviderConfigPatch,
};

const execFileAsync = promisify(execFile);

const PROVIDER_SNAPSHOT_TTL_MS = 10_000;
const RUNTIME_DISCOVERED_TTL_MS = 10 * 60_000;
const providerSnapshotCache = new Map<
  string,
  { expiresAt: number; mtimeSig: string; snapshot: ProvidersConfigSnapshot }
>();
const runtimeDiscoveredModelsCache = new Map<
  string,
  {
    models: string[];
    defaultModel?: string;
    modelCapabilities?: Record<string, ModelCapabilities>;
    source?: string;
    expiresAt: number;
  }
>();

const observedProviderDefaults = new Map<
  string,
  { model?: string; reasoningEffort?: string; fastMode?: boolean }
>();

export function recordObservedProviderDefault(
  providerId: string,
  command: string,
  obs: { model?: string; reasoningEffort?: string; fastMode?: boolean },
): void {
  const id = providerId.trim().toLowerCase();
  const cmd = command.trim();
  if (!id || !cmd) return;
  const model = obs.model?.trim();
  const reasoningEffort = sanitizeReasoningEffort(obs.reasoningEffort);
  const fastMode = typeof obs.fastMode === 'boolean' ? obs.fastMode : undefined;
  if (!model && !reasoningEffort && fastMode === undefined) return;
  const key = `${id}|${cmd}`;
  const prev = observedProviderDefaults.get(key);
  const next = {
    model: model || prev?.model,
    reasoningEffort: reasoningEffort || prev?.reasoningEffort,
    fastMode: fastMode !== undefined ? fastMode : prev?.fastMode,
  };
  if (
    prev &&
    prev.model === next.model &&
    prev.reasoningEffort === next.reasoningEffort &&
    prev.fastMode === next.fastMode
  ) {
    return;
  }
  observedProviderDefaults.set(key, next);
  providerSnapshotCache.clear();
}

function collectEffortOptions(
  modelCapabilities: Record<string, ModelCapabilities> | undefined,
  fallback: readonly string[],
): string[] {
  const union = new Set<string>();
  if (modelCapabilities) {
    for (const cap of Object.values(modelCapabilities)) {
      for (const eff of cap.reasoningEfforts || []) union.add(eff);
    }
  }
  return union.size > 0 ? Array.from(union) : [...fallback];
}

function invalidateRuntimeDiscoveryCacheForProviders(dirtyIds: Set<string>): void {
  if (dirtyIds.size === 0) return;
  for (const key of runtimeDiscoveredModelsCache.keys()) {
    const sep = key.indexOf('|');
    const keyId = sep >= 0 ? key.slice(0, sep) : key;
    if (dirtyIds.has(keyId)) {
      runtimeDiscoveredModelsCache.delete(key);
    }
  }
  for (const key of observedProviderDefaults.keys()) {
    const sep = key.indexOf('|');
    const keyId = sep >= 0 ? key.slice(0, sep) : key;
    if (dirtyIds.has(keyId)) {
      observedProviderDefaults.delete(key);
    }
  }
}

export function saveProviderConfigPatch(
  dataDir: string,
  patch: SaveProviderConfigPatch,
): ProvidersFileConfig {
  const prevProviders = mergeProvidersConfig(dataDir).globalCfg.providers || {};
  const out = persistProviderConfigPatch(dataDir, patch);
  const nextProviders = out.providers || {};
  providerSnapshotCache.clear();

  const dirtyIds = new Set<string>();
  for (const id of new Set([...Object.keys(prevProviders), ...Object.keys(nextProviders)])) {
    const a = prevProviders[id];
    const b = nextProviders[id];
    if (
      (a?.command || '') !== (b?.command || '') ||
      (a?.profile || '') !== (b?.profile || '') ||
      JSON.stringify(a?.listModelsArgs || []) !== JSON.stringify(b?.listModelsArgs || []) ||
      JSON.stringify(a?.env || {}) !== JSON.stringify(b?.env || {})
    ) {
      dirtyIds.add(id);
    }
  }
  invalidateRuntimeDiscoveryCacheForProviders(dirtyIds);
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

  const priority = ['dsh', 'claude', 'codex', 'gemini', 'agy'];
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

function detectBuiltinLocalModels(id: string): LocalModelsDetection {
  if (id === 'codex') return detectCodexModels();
  if (id === 'claude') return detectClaudeModels();
  if (id === 'gemini') return detectGeminiModels();
  if (id === 'agy') return detectAgyModels();
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
  const modelCapabilities =
    local.modelCapabilities || cached.modelCapabilities
      ? { ...(local.modelCapabilities || {}), ...(cached.modelCapabilities || {}) }
      : undefined;
  const source =
    local.source && cached.source && local.source !== cached.source
      ? `${local.source} + ${cached.source}`
      : local.source || cached.source;
  return {
    models,
    ...(defaultModel ? { defaultModel } : {}),
    ...(local.defaultReasoningEffort ? { defaultReasoningEffort: local.defaultReasoningEffort } : {}),
    ...(local.defaultFastMode !== undefined ? { defaultFastMode: local.defaultFastMode } : {}),
    ...(modelCapabilities && Object.keys(modelCapabilities).length > 0 ? { modelCapabilities } : {}),
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

async function runCliProbe(
  resolvedPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxBuffer = 256 * 1024,
): Promise<{ stdout: string; stderr: string }> {
  const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolvedPath);
  const execCmd = useShell ? quoteWinCmdArg(resolvedPath) : resolvedPath;
  const execArgs = useShell ? args.map(quoteWinCmdArg) : args;
  const res = await execFileAsync(execCmd, execArgs, {
    env,
    timeout: timeoutMs,
    maxBuffer,
    shell: useShell,
    ...(useShell ? { windowsVerbatimArguments: true } : {}),
  });
  return { stdout: res.stdout || '', stderr: res.stderr || '' };
}

export interface ProviderConfigSnapshotOptions {
  bypassCache?: boolean;
  checkDshPlugins?: boolean;
}

export function getProviderConfigSnapshot(
  dataDir: string,
  repoRoot?: string,
  profileOverride?: string,
  bypassCacheOrOpts: boolean | ProviderConfigSnapshotOptions = false,
): ProvidersConfigSnapshot {
  const bypassCache =
    typeof bypassCacheOrOpts === 'boolean'
      ? bypassCacheOrOpts
      : Boolean(bypassCacheOrOpts.bypassCache);
  const checkDshPlugins =
    typeof bypassCacheOrOpts === 'boolean' ? false : Boolean(bypassCacheOrOpts.checkDshPlugins);
  const globalPath = join(dataDir, 'providers.json');
  const repoPath = repoRoot ? join(repoRoot, '.agy-ext-swarm', 'providers.json') : undefined;
  const dshHome = getDshHome();
  const cacheKey = `${dataDir}|${repoRoot || ''}|${profileOverride || ''}|${dshHome}|${checkDshPlugins ? '1' : '0'}`;
  const now = Date.now();
  const cached = !bypassCache ? providerSnapshotCache.get(cacheKey) : undefined;
  const dshProfileHint =
    profileOverride?.trim() ||
    cached?.snapshot.providers.find((p) => p.id === 'dsh')?.profile ||
    'headless';
  const dshMtimeParts =
    checkDshPlugins && isValidDshProfileName(dshProfileHint)
      ? [
          fileMtimeToken(join(dshHome, 'profiles', dshProfileHint, 'package.json')),
          fileMtimeToken(join(dshHome, 'profiles', dshProfileHint, 'cordis.patch.yml')),
        ]
      : [];
  const mtimeSig = [
    fileMtimeToken(globalPath),
    fileMtimeToken(repoPath),
    ...dshMtimeParts,
  ].join(':');
  if (cached && now < cached.expiresAt && cached.mtimeSig === mtimeSig) {
    return cached.snapshot;
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
      const parsedDefault = parseDshQualifiedModel(
        defaultModel,
        detectedModelProviders,
        configuredModelProvider || detectedModelProvider,
      );
      const configuredModelProviders = configuredModels
        .map(
          (m) =>
            parseDshQualifiedModel(
              m,
              detectedModelProviders,
              configuredModelProvider || detectedModelProvider,
            ).modelProvider,
        )
        .filter((x): x is string => Boolean(x));
      const providersToCheck = dedupeStrings([
        parsedDefault.modelProvider,
        configuredModelProvider,
        ...configuredModelProviders,
        ...detectedModelProviders,
      ]);
      const dshChecks =
        checkDshPlugins && resolvedPath !== null && enabled
          ? checkDshProfileCatalogPlugins(effectiveProfile, providersToCheck, catalog)
          : [];
      const dshWarnings = dshChecks
        .map((c) => c.warning)
        .filter((w): w is string => Boolean(w));
      const dshModelCapabilities: Record<string, ModelCapabilities> = {};
      for (const m of catalog.models) {
        const qualifiedKey = formatDshQualifiedModel(
          m.provider || catalog.defaultProvider || configuredModelProvider || undefined,
          m.id,
        );
        if ((m.reasoningEfforts && m.reasoningEfforts.length > 0) || m.defaultReasoningEffort) {
          dshModelCapabilities[qualifiedKey] = {
            ...(m.reasoningEfforts && m.reasoningEfforts.length > 0
              ? { reasoningEfforts: m.reasoningEfforts }
              : {}),
            ...(m.defaultReasoningEffort ? { defaultReasoningEffort: m.defaultReasoningEffort } : {}),
          };
        }
      }
      const dshEffortOptions = collectEffortOptions(
        dshModelCapabilities,
        DEFAULT_REASONING_EFFORTS_BY_PROVIDER.dsh,
      );
      const dshDefaultCap = lookupModelCapability(
        {
          id: 'dsh',
          modelCapabilities: dshModelCapabilities,
          modelProvider: configuredModelProvider,
          detectedModelProvider,
        },
        defaultModel,
      );
      const configuredDefaultReasoningEffort = entry?.defaultReasoningEffort;
      const detectedDefaultReasoningEffort = catalog.defaultReasoningEffort || undefined;
      const defaultReasoningEffort =
        configuredDefaultReasoningEffort ||
        detectedDefaultReasoningEffort ||
        sanitizeReasoningEffort(dshDefaultCap?.defaultReasoningEffort);
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
        supportsReasoningEffort: true,
        reasoningEffortOptions: dshEffortOptions,
        supportsFastMode: false,
        defaultModel,
        configuredDefaultModel,
        detectedDefaultModel,
        ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
        ...(configuredDefaultReasoningEffort ? { configuredDefaultReasoningEffort } : {}),
        ...(detectedDefaultReasoningEffort ? { detectedDefaultReasoningEffort } : {}),
        detectedModelProvider,
        ...(detectedModelProviders.length > 0 ? { detectedModelProviders } : {}),
        models,
        configuredModels,
        detectedModels: detected.models,
        ...(detected.source ? { detectedModelsSource: detected.source } : {}),
        ...(Object.keys(dshModelCapabilities).length > 0
          ? { modelCapabilities: dshModelCapabilities }
          : {}),
        profile: effectiveProfile,
        ...(configuredProfile ? { configuredProfile } : {}),
        modelProvider: configuredModelProvider,
        hasOverride: hasMeaningfulEntryConfig(entry),
        ...(entry?.listModelsArgs && entry.listModelsArgs.length > 0
          ? { listModelsArgs: entry.listModelsArgs }
          : {}),
        env: entry?.env,
        notes: base.notes,
        ...(dshWarnings.length > 0 ? { warnings: dshWarnings } : {}),
      });
    } else {
      const detected = mergeLocalAndRuntimeModels(
        runtimeCacheKey(base.id, command, entry?.listModelsArgs),
        detectBuiltinLocalModels(base.id),
      );
      const obs = observedProviderDefaults.get(`${base.id}|${command.trim()}`);
      const detectedDefaultModel = detected.defaultModel || obs?.model;
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
      const supportsReasoningEffort =
        base.id === 'codex' || base.id === 'claude' || base.id === 'agy';
      const supportsFastMode = base.id === 'codex' || base.id === 'claude';
      const modelCapabilities =
        base.id === 'agy'
          ? {
              ...inferAgyModelCapabilities(models),
              ...(detected.modelCapabilities || {}),
            }
          : detected.modelCapabilities;
      const reasoningEffortOptions =
        base.id === 'codex'
          ? collectEffortOptions(modelCapabilities, DEFAULT_REASONING_EFFORTS_BY_PROVIDER.codex)
          : base.id === 'claude'
            ? [...DEFAULT_REASONING_EFFORTS_BY_PROVIDER.claude]
            : base.id === 'agy'
              ? collectEffortOptions(modelCapabilities, DEFAULT_REASONING_EFFORTS_BY_PROVIDER.agy)
              : undefined;
      const defaultCap = lookupModelCapability({ id: base.id, modelCapabilities }, defaultModel);
      const inferredLabelEffort =
        base.id === 'agy' && defaultModel !== 'default'
          ? parseEffortFromModelName(defaultModel)
          : undefined;
      const configuredDefaultReasoningEffort = supportsReasoningEffort
        ? entry?.defaultReasoningEffort
        : undefined;
      const detectedDefaultReasoningEffort = supportsReasoningEffort
        ? inferredLabelEffort || detected.defaultReasoningEffort || obs?.reasoningEffort
        : undefined;
      const defaultReasoningEffort =
        configuredDefaultReasoningEffort ||
        detectedDefaultReasoningEffort ||
        (supportsReasoningEffort
          ? sanitizeReasoningEffort(defaultCap?.defaultReasoningEffort)
          : undefined);
      const configuredDefaultFastMode = supportsFastMode ? entry?.defaultFastMode : undefined;
      const detectedDefaultFastMode = supportsFastMode
        ? (detected.defaultFastMode ?? obs?.fastMode)
        : undefined;
      const defaultFastMode =
        configuredDefaultFastMode ??
        detectedDefaultFastMode ??
        (supportsFastMode ? defaultCap?.defaultFastMode : undefined);
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
        supportsReasoningEffort,
        ...(reasoningEffortOptions ? { reasoningEffortOptions } : {}),
        supportsFastMode,
        defaultModel,
        configuredDefaultModel,
        ...(detectedDefaultModel ? { detectedDefaultModel } : {}),
        ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
        ...(configuredDefaultReasoningEffort ? { configuredDefaultReasoningEffort } : {}),
        ...(detectedDefaultReasoningEffort ? { detectedDefaultReasoningEffort } : {}),
        ...(defaultFastMode !== undefined ? { defaultFastMode } : {}),
        ...(configuredDefaultFastMode !== undefined ? { configuredDefaultFastMode } : {}),
        ...(detectedDefaultFastMode !== undefined ? { detectedDefaultFastMode } : {}),
        models,
        configuredModels,
        ...(detected.models.length > 0 ? { detectedModels: detected.models } : {}),
        ...(detected.source ? { detectedModelsSource: detected.source } : {}),
        ...(modelCapabilities && Object.keys(modelCapabilities).length > 0
          ? { modelCapabilities }
          : {}),
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
    const hasEffortVar = Boolean(
      entry.args?.some((a) => a.includes('{{reasoningEffort}}')) ||
        entry.resumeArgs?.some((a) => a.includes('{{reasoningEffort}}')),
    );
    const hasFastVar = Boolean(
      entry.args?.some((a) => a.includes('{{fastMode}}')) ||
        entry.resumeArgs?.some((a) => a.includes('{{fastMode}}')),
    );
    const supportsReasoningEffort = hasEffortVar || Boolean(entry.defaultReasoningEffort);
    const supportsFastMode = hasFastVar || typeof entry.defaultFastMode === 'boolean';
    const configuredDefaultReasoningEffort = entry.defaultReasoningEffort;
    const configuredDefaultFastMode = entry.defaultFastMode;
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
      supportsReasoningEffort,
      ...(supportsReasoningEffort
        ? { reasoningEffortOptions: ['low', 'medium', 'high', 'xhigh', 'max'] }
        : {}),
      supportsFastMode,
      defaultModel,
      configuredDefaultModel,
      ...(detectedDefaultModel ? { detectedDefaultModel } : {}),
      ...(configuredDefaultReasoningEffort
        ? {
            defaultReasoningEffort: configuredDefaultReasoningEffort,
            configuredDefaultReasoningEffort,
          }
        : {}),
      ...(configuredDefaultFastMode !== undefined
        ? {
            defaultFastMode: configuredDefaultFastMode,
            configuredDefaultFastMode,
          }
        : {}),
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
    ...(state.defaultTurnTimeoutSeconds !== undefined
      ? { defaultTurnTimeoutSeconds: state.defaultTurnTimeoutSeconds }
      : {}),
    ...(state.defaultStallTimeoutSeconds !== undefined
      ? { defaultStallTimeoutSeconds: state.defaultStallTimeoutSeconds }
      : {}),
    providers: descriptors,
    ...(Object.keys(state.pricing).length > 0 ? { pricing: state.pricing } : {}),
    ...(state.displayCurrency ? { displayCurrency: state.displayCurrency } : {}),
    ...(state.usdToCnyRate !== undefined ? { usdToCnyRate: state.usdToCnyRate } : {}),
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
  const snap = getProviderConfigSnapshot(dataDir, repoRoot, profileOverride, {
    bypassCache: true,
    checkDshPlugins: true,
  });
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

  let versionText = '';
  let probeOk = false;
  let probeError = '';

  for (const flag of ['--version', '-v']) {
    try {
      const res = await runCliProbe(descriptor.resolvedPath, [flag], env, 5000);
      const combined = `${res.stdout}\n${res.stderr}`.trim();
      if (combined) {
        versionText = combined.split('\n')[0].trim().slice(0, 120);
      }
      probeOk = true;
      break;
    } catch (err) {
      probeError = err instanceof Error ? err.message : String(err);
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
    }
    const effectiveDefault = descriptor.defaultModel || catalog.defaultModel || 'default';
    const sourceSuffix = catalog.catalogSourceProfile
      ? ` (from "${catalog.catalogSourceProfile}")`
      : '';
    if (catalog.exists || catalog.models.length > 0) {
      extraDetails.push(
        `profile="${profile}", defaultModel="${effectiveDefault}", catalog=${catalog.models.length} models${sourceSuffix}`,
      );
    }
    if (descriptor.warnings?.length) {
      for (const w of descriptor.warnings) {
        if (!warnings.includes(w)) warnings.push(w);
      }
    }
    const targetModels = dedupeStrings([effectiveDefault, ...descriptor.configuredModels]);
    let usedSiblingOverlay = false;
    for (const m of targetModels) {
      const parsed = parseDshQualifiedModel(
        m,
        descriptor.detectedModelProviders,
        descriptor.modelProvider || catalog.defaultProvider || undefined,
      );
      if (!parsed.model || parsed.model === 'default' || !parsed.modelProvider) continue;
      const mp = parsed.modelProvider;
      if (!checkDshProfileProviderPlugin(profile, mp, catalog).ok) continue;
      const readiness = checkDshModelCatalogReadiness(profile, mp, parsed.model);
      if (readiness.status === 'sibling-overlay') {
        usedSiblingOverlay = true;
      } else if (
        readiness.status === 'missing-in-profile' &&
        readiness.warning &&
        !warnings.includes(readiness.warning)
      ) {
        warnings.push(readiness.warning);
      }
    }
    if (usedSiblingOverlay) {
      extraDetails.push('sibling catalog overlay ready via --patch');
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
    const cmdBase = basename(descriptor.command.trim()).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();

    const listArgs =
      descriptor.listModelsArgs && descriptor.listModelsArgs.length > 0
        ? descriptor.listModelsArgs
        : id === 'opencode' || cmdBase === 'opencode' || id === 'agy' || cmdBase === 'agy'
          ? ['models']
          : undefined;
    if (listArgs && listArgs.length > 0) {
      try {
        const res = await runCliProbe(descriptor.resolvedPath, listArgs, env, 8000, 512 * 1024);
        const outText = res.stdout.trim() || res.stderr.trim();
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
        const res = await runCliProbe(descriptor.resolvedPath, ['--help'], env, 5000);
        cliModels = parseClaudeHelpModelAliases(`${res.stdout}\n${res.stderr}`);
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

  const cliCapabilities =
    id === 'agy' && cliModels.length > 0 ? inferAgyModelCapabilities(cliModels) : undefined;
  const modelCapabilities =
    descriptor.modelCapabilities || cliCapabilities
      ? { ...(descriptor.modelCapabilities || {}), ...(cliCapabilities || {}) }
      : undefined;

  if (cliModels.length > 0) {
    runtimeDiscoveredModelsCache.set(
      runtimeCacheKey(id, descriptor.command, descriptor.listModelsArgs, descriptor.profile),
      {
        models: cliModels,
        ...(cliCapabilities && Object.keys(cliCapabilities).length > 0
          ? { modelCapabilities: cliCapabilities }
          : {}),
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
    ...(modelCapabilities && Object.keys(modelCapabilities).length > 0
      ? { modelCapabilities }
      : {}),
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
  supportsReasoningEffort?: boolean;
  reasoningEffortOptions?: string[];
  supportsFastMode?: boolean;
  defaultReasoningEffort?: string;
  defaultFastMode?: boolean;
  modelCapabilities?: Record<string, ModelCapabilities>;
  models: string[];
  configuredModels: string[];
  detectedModels?: string[];
  modelDetails?: ModelInfo[];
  profile?: string;
  configPath?: string;
  exists?: boolean;
  modelProvider?: string;
  modelProviders?: string[];
  warnings?: string[];
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
      supportsReasoningEffort: descriptor?.supportsReasoningEffort ?? true,
      ...(descriptor?.reasoningEffortOptions
        ? { reasoningEffortOptions: descriptor.reasoningEffortOptions }
        : {}),
      supportsFastMode: false,
      ...(descriptor?.defaultReasoningEffort
        ? { defaultReasoningEffort: descriptor.defaultReasoningEffort }
        : {}),
      ...(descriptor?.modelCapabilities ? { modelCapabilities: descriptor.modelCapabilities } : {}),
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
      ...(descriptor?.warnings?.length ? { warnings: descriptor.warnings } : {}),
      note: catalog.note,
    };
  }

  return {
    provider: resolvedId,
    displayName: descriptor?.displayName || resolvedId,
    enabled: descriptor?.enabled ?? true,
    available: descriptor?.available ?? false,
    defaultModel: descriptor?.defaultModel || 'default',
    ...(descriptor?.supportsReasoningEffort !== undefined
      ? { supportsReasoningEffort: descriptor.supportsReasoningEffort }
      : {}),
    ...(descriptor?.reasoningEffortOptions
      ? { reasoningEffortOptions: descriptor.reasoningEffortOptions }
      : {}),
    ...(descriptor?.supportsFastMode !== undefined
      ? { supportsFastMode: descriptor.supportsFastMode }
      : {}),
    ...(descriptor?.defaultReasoningEffort
      ? { defaultReasoningEffort: descriptor.defaultReasoningEffort }
      : {}),
    ...(descriptor?.defaultFastMode !== undefined
      ? { defaultFastMode: descriptor.defaultFastMode }
      : {}),
    ...(descriptor?.modelCapabilities ? { modelCapabilities: descriptor.modelCapabilities } : {}),
    models: descriptor?.models || ['default'],
    configuredModels: descriptor?.configuredModels || [],
    ...(descriptor?.detectedModels ? { detectedModels: descriptor.detectedModels } : {}),
    note:
      descriptor?.notes ||
      `Pass any model identifier supported by "${resolvedId}" CLI directly to ext_swarm_add.`,
  };
}
