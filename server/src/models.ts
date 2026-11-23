import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import YAML from 'yaml';
import type { ModelInfo, ModelsCatalogResult } from './types.js';

interface PatchEntry {
  id?: string;
  name?: string;
  disabled?: unknown;
  config?: Record<string, unknown>;
}

const CUSTOM_TAG_SAFE_OPTIONS = {
  // Ignore !!js or other custom tags gracefully when reading cordis.patch.yml
  customTags: [
    {
      tag: 'tag:yaml.org,2002:js',
      resolve: (str: string) => str,
    },
    {
      tag: '!!js',
      resolve: (str: string) => str,
    },
  ],
};

const DSH_PROVIDER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function isValidDshProfileName(profile: string): boolean {
  const trimmed = profile.trim();
  return Boolean(trimmed && !trimmed.includes('..') && DSH_PROVIDER_ID_RE.test(trimmed));
}

export function formatDshQualifiedModel(provider: string | undefined, modelId: string): string {
  const p = provider?.trim() || '';
  const m = modelId.trim();
  if (!m || m === 'default' || !p) return m;
  if (m.startsWith(`${p}/`)) return m;
  return `${p}/${m}`;
}

export function parseDshQualifiedModel(
  rawModel: string,
  knownProviders?: Iterable<string>,
  fallbackProvider?: string,
): { modelProvider?: string; model: string; qualified: boolean } {
  const trimmed = rawModel.trim();
  const fb = fallbackProvider?.trim() || undefined;
  if (!trimmed || trimmed === 'default') {
    return { modelProvider: fb, model: trimmed || 'default', qualified: false };
  }

  const knownSet = new Set<string>(['deepseek-official']);
  let hasExplicitKnown = Boolean(fb);
  if (fb) knownSet.add(fb);
  if (knownProviders) {
    for (const item of knownProviders) {
      const kp = item?.trim();
      if (kp) {
        knownSet.add(kp);
        hasExplicitKnown = true;
      }
    }
  }

  const slash = trimmed.indexOf('/');
  if (slash > 0 && slash < trimmed.length - 1) {
    const prefix = trimmed.slice(0, slash).trim();
    const rest = trimmed.slice(slash + 1).trim();
    if (
      prefix &&
      rest &&
      DSH_PROVIDER_ID_RE.test(prefix) &&
      (knownSet.has(prefix) || rest.includes('/') || !hasExplicitKnown)
    ) {
      return { modelProvider: prefix, model: rest, qualified: true };
    }
  }

  return { modelProvider: fb, model: trimmed, qualified: false };
}

interface ExtractedCatalogModel {
  provider?: string;
  item: Record<string, unknown>;
}

function inferEntryBaseProvider(entry: PatchEntry): string | undefined {
  const cfg = entry.config;
  if (cfg && typeof cfg === 'object') {
    if (typeof cfg.provider === 'string' && cfg.provider.trim()) {
      return cfg.provider.trim();
    }
    if (typeof cfg.providerId === 'string' && cfg.providerId.trim()) {
      return cfg.providerId.trim();
    }
  }
  for (const candidate of [entry.id, entry.name]) {
    if (typeof candidate !== 'string') continue;
    const connectMatch = /dsh-connect-([a-z0-9][a-z0-9._-]*)/i.exec(candidate);
    if (connectMatch?.[1]) {
      return connectMatch[1].trim().toLowerCase();
    }
  }
  if (
    entry.id === 'llm-deepseek' ||
    (typeof entry.name === 'string' && /dsh-llm-deepseek/i.test(entry.name))
  ) {
    return 'deepseek-official';
  }
  return undefined;
}

function resolveRegionProvider(baseProvider: string | undefined, regionKey: string): string | undefined {
  const rk = regionKey.trim().toLowerCase();
  if (!baseProvider || !rk) return baseProvider;
  if (baseProvider === 'workbuddy') {
    if (rk === 'cn') return 'workbuddy';
    if (rk === 'global' || rk === 'intl') return 'workbuddy-global';
    return `workbuddy-${rk}`;
  }
  if (rk === 'cn' || rk === 'default') return baseProvider;
  return `${baseProvider}-${rk}`;
}

function findCatalogEntriesRecursive(
  obj: unknown,
  inheritedProvider: string | undefined,
  out: ExtractedCatalogModel[],
  visited = new WeakMap<object, Set<string>>(),
): void {
  if (!obj || typeof obj !== 'object') return;
  const visitKey = inheritedProvider || '';
  let seenForObj = visited.get(obj);
  if (seenForObj?.has(visitKey)) return;
  if (!seenForObj) {
    seenForObj = new Set<string>();
    visited.set(obj, seenForObj);
  }
  seenForObj.add(visitKey);
  if (Array.isArray(obj)) {
    for (const item of obj) {
      findCatalogEntriesRecursive(item, inheritedProvider, out, visited);
    }
    return;
  }
  const rec = obj as Record<string, unknown>;
  if (rec.enabled === false || rec.disabled === true) return;

  const localProvider =
    typeof rec.provider === 'string' && rec.provider.trim()
      ? rec.provider.trim()
      : typeof rec.providerId === 'string' && rec.providerId.trim()
        ? rec.providerId.trim()
        : inheritedProvider;

  if (Array.isArray(rec.lastCatalog)) {
    for (const entry of rec.lastCatalog) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const itemRec = entry as Record<string, unknown>;
        const itemProv =
          typeof itemRec.provider === 'string' && itemRec.provider.trim()
            ? itemRec.provider.trim()
            : localProvider;
        out.push({ provider: itemProv, item: itemRec });
      }
    }
  }

  for (const [key, val] of Object.entries(rec)) {
    if (!val || typeof val !== 'object') continue;
    if (key === 'regions' && !Array.isArray(val)) {
      for (const [regionKey, regionVal] of Object.entries(val as Record<string, unknown>)) {
        if (!regionVal || typeof regionVal !== 'object' || Array.isArray(regionVal)) continue;
        const regionRec = regionVal as Record<string, unknown>;
        if (regionRec.enabled === false || regionRec.disabled === true) continue;
        const regProv = resolveRegionProvider(localProvider, regionKey) || localProvider;
        findCatalogEntriesRecursive(regionVal, regProv, out, visited);
      }
      continue;
    }
    findCatalogEntriesRecursive(val, localProvider, out, visited);
  }
}

function extractConfiguredProvidersModels(
  entry: PatchEntry,
  pushModel: (item: Record<string, unknown> | string, provider?: string) => void,
  addProvider: (provider?: string) => void,
): void {
  const providersField = entry.config?.providers;
  if (!providersField || typeof providersField !== 'object') return;

  const collectFromProviderObj = (provId: string, provRec: Record<string, unknown>) => {
    if (provRec.disabled === true || provRec.enabled === false) return;
    const cleanProv = provId.trim();
    if (!cleanProv) return;
    addProvider(cleanProv);

    const rawModels = provRec.models;
    if (Array.isArray(rawModels)) {
      for (const m of rawModels) {
        if (typeof m === 'string') {
          pushModel(m, cleanProv);
        } else if (m && typeof m === 'object' && !Array.isArray(m)) {
          const mRec = m as Record<string, unknown>;
          if (mRec.disabled === true || mRec.enabled === false) continue;
          const mProv =
            typeof mRec.provider === 'string' && mRec.provider.trim()
              ? mRec.provider.trim()
              : cleanProv;
          pushModel(mRec, mProv);
        }
      }
    } else if (rawModels && typeof rawModels === 'object') {
      for (const [modelKey, modelMeta] of Object.entries(rawModels as Record<string, unknown>)) {
        const id = modelKey.trim();
        if (!id) continue;
        if (modelMeta && typeof modelMeta === 'object' && !Array.isArray(modelMeta)) {
          const metaRec = modelMeta as Record<string, unknown>;
          if (metaRec.disabled === true || metaRec.enabled === false) continue;
          pushModel(
            {
              ...metaRec,
              id: typeof metaRec.id === 'string' && metaRec.id.trim() ? metaRec.id : id,
            },
            cleanProv,
          );
        } else {
          pushModel(id, cleanProv);
        }
      }
    }
  };

  if (Array.isArray(providersField)) {
    for (const item of providersField) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      const provId =
        typeof rec.id === 'string'
          ? rec.id
          : typeof rec.provider === 'string'
            ? rec.provider
            : typeof rec.name === 'string'
              ? rec.name
              : '';
      if (provId.trim()) collectFromProviderObj(provId, rec);
    }
  } else {
    for (const [provKey, provVal] of Object.entries(providersField as Record<string, unknown>)) {
      if (!provVal || typeof provVal !== 'object' || Array.isArray(provVal)) continue;
      collectFromProviderObj(provKey, provVal as Record<string, unknown>);
    }
  }
}

interface ModelsCacheEntry {
  mtimeMs: number;
  size: number;
  result: ModelsCatalogResult;
}

const dshModelsCache = new Map<string, ModelsCacheEntry>();

export function getDshHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

export function getProfilePatchPath(profile = 'headless'): string {
  const safeProfile = profile.trim() || 'headless';
  if (!isValidDshProfileName(safeProfile)) {
    throw new Error(
      `Invalid dsh profile name "${profile}". Must match ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ without "..".`,
    );
  }
  return join(getDshHome(), 'profiles', safeProfile, 'cordis.patch.yml');
}

function readSingleDshProfileCatalog(safeProfile: string): ModelsCatalogResult {
  const configPath = getProfilePatchPath(safeProfile);
  let defaultProvider = '';
  let defaultModel = '';
  const models: ModelInfo[] = [];

  if (!existsSync(configPath)) {
    dshModelsCache.delete(configPath);
    return {
      profile: safeProfile,
      configPath,
      exists: false,
      defaultProvider,
      defaultModel,
      models,
      note: `Profile patch file not found at ${configPath}. Configure models in Settings or providers.json if needed.`,
    };
  }

  let st: { mtimeMs: number; size: number } | undefined;
  try {
    st = statSync(configPath);
    const cached = dshModelsCache.get(configPath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.result;
    }
  } catch {
    // Proceed without cache
  }

  try {
    const raw = readFileSync(configPath, 'utf8');
    const parsed = YAML.parse(raw, CUSTOM_TAG_SAFE_OPTIONS) as PatchEntry[] | null;
    const providerSet = new Set<string>();
    if (Array.isArray(parsed)) {
      const seenKeys = new Set<string>();
      const addProvider = (p?: string) => {
        const clean = p?.trim();
        if (clean) providerSet.add(clean);
      };

      // Pass 1: find agent-default-model first
      for (const entry of parsed) {
        if (!entry || typeof entry !== 'object') continue;
        if (entry.disabled === true || entry.config?.disabled === true || entry.config?.enabled === false) continue;
        if (entry.id === 'agent-default-model' && entry.config) {
          if (typeof entry.config.provider === 'string' && entry.config.provider.trim()) {
            defaultProvider = entry.config.provider.trim();
            addProvider(defaultProvider);
          }
          if (typeof entry.config.model === 'string' && entry.config.model.trim()) {
            defaultModel = entry.config.model.trim();
          }
        }
      }

      const pushModel = (rawItem: Record<string, unknown> | string, explicitProvider?: string) => {
        const effProv = explicitProvider?.trim() || defaultProvider || undefined;
        if (effProv) addProvider(effProv);
        if (typeof rawItem === 'string') {
          const id = rawItem.trim();
          if (!id) return;
          const key = `${effProv || ''}::${id}`;
          if (seenKeys.has(key)) return;
          seenKeys.add(key);
          models.push({
            id,
            name: id,
            ...(effProv ? { provider: effProv } : {}),
          });
          return;
        }
        const id = typeof rawItem.id === 'string' ? rawItem.id.trim() : '';
        if (!id) return;
        const key = `${effProv || ''}::${id}`;
        if (seenKeys.has(key)) return;
        seenKeys.add(key);
        models.push({
          id,
          name: typeof rawItem.name === 'string' && rawItem.name.trim() ? rawItem.name : id,
          ...(effProv ? { provider: effProv } : {}),
          contextWindow: typeof rawItem.contextWindow === 'number' ? rawItem.contextWindow : undefined,
          maxTokens: typeof rawItem.maxTokens === 'number' ? rawItem.maxTokens : undefined,
          creditMultiplier:
            typeof rawItem.creditMultiplier === 'number' ? rawItem.creditMultiplier : undefined,
          description:
            typeof rawItem.descriptionEn === 'string'
              ? rawItem.descriptionEn
              : typeof rawItem.descriptionZh === 'string'
                ? rawItem.descriptionZh
                : typeof rawItem.description === 'string'
                  ? rawItem.description
                  : undefined,
          supportsToolCall:
            typeof rawItem.supportsToolCall === 'boolean' ? rawItem.supportsToolCall : undefined,
          supportsImages:
            typeof rawItem.supportsImages === 'boolean' ? rawItem.supportsImages : undefined,
        });
      };

      // Pass 2: configured providers maps/arrays and lastCatalog entries
      for (const entry of parsed) {
        if (!entry || typeof entry !== 'object') continue;
        if (entry.disabled === true || entry.config?.disabled === true || entry.config?.enabled === false) continue;
        extractConfiguredProvidersModels(entry, pushModel, addProvider);
        const rawCatalog: ExtractedCatalogModel[] = [];
        if (entry.config) {
          findCatalogEntriesRecursive(entry.config, inferEntryBaseProvider(entry), rawCatalog);
        }
        for (const item of rawCatalog) {
          pushModel(item.item, item.provider);
        }
      }

      // Pass 3: allowedModels (e.g. subagent-model-selection-settings)
      for (const entry of parsed) {
        if (!entry || typeof entry !== 'object') continue;
        if (entry.disabled === true || entry.config?.disabled === true || entry.config?.enabled === false) continue;
        const allowed = entry.config?.allowedModels;
        if (!Array.isArray(allowed)) continue;
        for (const item of allowed) {
          if (typeof item === 'string' && item.trim()) {
            const parsedItem = parseDshQualifiedModel(item, providerSet, defaultProvider || undefined);
            pushModel(parsedItem.model, parsedItem.modelProvider);
          } else if (item && typeof item === 'object' && !Array.isArray(item)) {
            const rec = item as Record<string, unknown>;
            if (rec.disabled === true || rec.enabled === false) continue;
            const mId = typeof rec.model === 'string' ? rec.model.trim() : typeof rec.id === 'string' ? rec.id.trim() : '';
            const mProv = typeof rec.provider === 'string' ? rec.provider.trim() : undefined;
            if (mProv) addProvider(mProv);
            if (mId) pushModel(mId, mProv);
          }
        }
      }
    }

    const providers: string[] = [];
    if (defaultProvider && providerSet.has(defaultProvider)) {
      providers.push(defaultProvider);
    }
    for (const p of providerSet) {
      if (!providers.includes(p)) providers.push(p);
    }

    const result: ModelsCatalogResult = {
      profile: safeProfile,
      configPath,
      exists: true,
      defaultProvider,
      defaultModel,
      ...(providers.length > 0 ? { providers } : {}),
      models,
      note:
        models.length === 0
          ? 'No lastCatalog entries found in cordis.patch.yml; configure supported models in AGY Ext Swarm Settings or providers.json if needed.'
          : undefined,
    };
    if (st) {
      dshModelsCache.set(configPath, { mtimeMs: st.mtimeMs, size: st.size, result });
    }
    return result;
  } catch (err) {
    dshModelsCache.delete(configPath);
    const msg = err instanceof Error ? err.message : String(err);
    return {
      profile: safeProfile,
      configPath,
      exists: true,
      defaultProvider,
      defaultModel,
      models,
      note: `Failed to parse ${configPath}: ${msg}`,
    };
  }
}

export function listDshModels(profile = 'headless'): ModelsCatalogResult {
  const safeProfile = profile.trim() || 'headless';
  if (!isValidDshProfileName(safeProfile)) {
    return {
      profile: safeProfile,
      configPath: '',
      exists: false,
      defaultProvider: '',
      defaultModel: '',
      models: [],
      note: `Invalid dsh profile name "${safeProfile}".`,
    };
  }
  const primary = readSingleDshProfileCatalog(safeProfile);
  if (primary.models.length > 0) {
    return primary;
  }

  const profilesDir = join(getDshHome(), 'profiles');
  if (existsSync(profilesDir)) {
    try {
      const siblings = readdirSync(profilesDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== safeProfile)
        .map((d) => d.name);
      const priorityOrder = ['desktop', 'tui', 'web'];
      siblings.sort((a, b) => {
        const ia = priorityOrder.indexOf(a);
        const ib = priorityOrder.indexOf(b);
        if (ia !== -1 && ib !== -1) return ia - ib;
        if (ia !== -1) return -1;
        if (ib !== -1) return 1;
        return a.localeCompare(b);
      });
      for (const sibling of siblings) {
        const sibRes = readSingleDshProfileCatalog(sibling);
        if (sibRes.models.length > 0) {
          const useSiblingDefaults = !primary.defaultProvider && !primary.defaultModel;
          const mergedProviders = Array.from(
            new Set(
              [
                primary.defaultProvider,
                ...(primary.providers || []),
                sibRes.defaultProvider,
                ...(sibRes.providers || []),
              ]
                .map((x) => x?.trim() || '')
                .filter(Boolean),
            ),
          );
          return {
            ...primary,
            defaultProvider: useSiblingDefaults ? sibRes.defaultProvider : primary.defaultProvider,
            defaultModel: useSiblingDefaults ? sibRes.defaultModel : primary.defaultModel,
            ...(mergedProviders.length > 0 ? { providers: mergedProviders } : {}),
            models: sibRes.models,
            catalogSourceProfile: sibling,
            note: `Loaded ${sibRes.models.length} model(s) (read-only) from sibling profile "${sibling}"; runtime still uses profile "${safeProfile}".`,
          };
        }
      }
    } catch {
      // Best-effort read-only fallback
    }
  }

  return primary;
}

export function writeModelPatch(
  patchPath: string,
  provider: string | undefined,
  model: string,
): void {
  mkdirSync(dirname(patchPath), { recursive: true });
  const trimmedProvider = provider?.trim();
  const config: Record<string, string> = trimmedProvider
    ? { provider: trimmedProvider, model }
    : { model };
  const doc = [
    {
      id: 'agent-default-model',
      name: '@deepseek-ai/dsh-agent-default-model',
      config,
    },
  ];
  writeFileSync(patchPath, YAML.stringify(doc), 'utf8');
}

export interface LocalModelsDetection {
  models: string[];
  defaultModel?: string;
  source?: string;
}

function dedupeModelIds(items: Iterable<unknown>): string[] {
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

function safeReadJson(filePath: string): Record<string, unknown> | unknown[] | null {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown> | unknown[]) : null;
  } catch {
    return null;
  }
}

export function detectCodexModels(): LocalModelsDetection {
  const baseDir = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  let defaultModel: string | undefined;
  const sources: string[] = [];

  const tomlPath = join(baseDir, 'config.toml');
  if (existsSync(tomlPath)) {
    try {
      const lines = readFileSync(tomlPath, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        if (/^\[/.test(trimmed)) break;
        const m = /^\s*model\s*=\s*["']([^"']+)["']/.exec(trimmed);
        if (m?.[1]?.trim()) {
          defaultModel = m[1].trim();
          sources.push('~/.codex/config.toml');
          break;
        }
      }
    } catch {
      // Best-effort read
    }
  }

  const cacheModels: string[] = [];
  const cachePath = join(baseDir, 'models_cache.json');
  const cacheJson = safeReadJson(cachePath);
  if (cacheJson && !Array.isArray(cacheJson) && Array.isArray(cacheJson.models)) {
    const entries = cacheJson.models
      .map((item, idx) => ({ item, idx }))
      .filter(
        ({ item }) =>
          item && typeof item === 'object' && !Array.isArray(item) && (item as Record<string, unknown>).visibility !== 'hide',
      )
      .sort((a, b) => {
        const pa = typeof (a.item as Record<string, unknown>).priority === 'number'
          ? ((a.item as Record<string, unknown>).priority as number)
          : 9999;
        const pb = typeof (b.item as Record<string, unknown>).priority === 'number'
          ? ((b.item as Record<string, unknown>).priority as number)
          : 9999;
        return pa !== pb ? pa - pb : a.idx - b.idx;
      });
    for (const { item } of entries) {
      const rec = item as Record<string, unknown>;
      const id = typeof rec.slug === 'string' ? rec.slug : typeof rec.id === 'string' ? rec.id : '';
      if (id.trim()) cacheModels.push(id.trim());
    }
    if (cacheModels.length > 0) {
      sources.unshift('~/.codex/models_cache.json');
    }
  }

  if (cacheModels.length === 0) {
    const fallbackPath = join(baseDir, 'model-catalogs.json');
    const fallbackJson = safeReadJson(fallbackPath);
    if (fallbackJson) {
      const candidates = Array.isArray(fallbackJson)
        ? fallbackJson
        : Array.isArray(fallbackJson.models)
          ? fallbackJson.models
          : Object.values(fallbackJson).flatMap((v) => (Array.isArray(v) ? v : []));
      for (const item of candidates) {
        if (typeof item === 'string') {
          cacheModels.push(item);
        } else if (item && typeof item === 'object' && !Array.isArray(item)) {
          const rec = item as Record<string, unknown>;
          if (rec.visibility === 'hide') continue;
          const id =
            typeof rec.slug === 'string'
              ? rec.slug
              : typeof rec.id === 'string'
                ? rec.id
                : typeof rec.name === 'string'
                  ? rec.name
                  : '';
          if (id.trim()) cacheModels.push(id.trim());
        }
      }
      if (cacheModels.length > 0) {
        sources.unshift('~/.codex/model-catalogs.json');
      }
    }
  }

  const models = dedupeModelIds([...(defaultModel ? [defaultModel] : []), ...cacheModels]);
  return {
    models,
    ...(defaultModel ? { defaultModel } : {}),
    ...(sources.length > 0 ? { source: Array.from(new Set(sources)).join(' + ') } : {}),
  };
}

const ALLOWED_CLAUDE_ENV_MODEL_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
] as const;

export function detectClaudeModels(): LocalModelsDetection {
  const baseDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
  let defaultModel: string | undefined;
  const collected: string[] = [];
  const sources: string[] = [];

  const settingsJson = safeReadJson(join(baseDir, 'settings.json'));
  if (settingsJson && !Array.isArray(settingsJson)) {
    let hitSettings = false;
    if (typeof settingsJson.model === 'string' && settingsJson.model.trim()) {
      defaultModel = settingsJson.model.trim();
      collected.push(defaultModel);
      hitSettings = true;
    }
    if (Array.isArray(settingsJson.availableModels)) {
      for (const m of settingsJson.availableModels) {
        if (typeof m === 'string' && m.trim()) {
          collected.push(m.trim());
          hitSettings = true;
        }
      }
    }
    if (settingsJson.env && typeof settingsJson.env === 'object' && !Array.isArray(settingsJson.env)) {
      const envObj = settingsJson.env as Record<string, unknown>;
      for (const key of ALLOWED_CLAUDE_ENV_MODEL_KEYS) {
        const val = envObj[key];
        if (typeof val === 'string' && val.trim()) {
          if (key === 'ANTHROPIC_MODEL' && !defaultModel) {
            defaultModel = val.trim();
          }
          collected.push(val.trim());
          hitSettings = true;
        }
      }
    }
    if (hitSettings) sources.push('~/.claude/settings.json');
  }

  const statsJson = safeReadJson(join(baseDir, 'stats-cache.json'));
  if (
    statsJson &&
    !Array.isArray(statsJson) &&
    statsJson.modelUsage &&
    typeof statsJson.modelUsage === 'object' &&
    !Array.isArray(statsJson.modelUsage)
  ) {
    const usageKeys = Object.keys(statsJson.modelUsage);
    if (usageKeys.length > 0) {
      collected.push(...usageKeys);
      sources.push('~/.claude/stats-cache.json');
    }
  }

  return {
    models: dedupeModelIds(collected),
    ...(defaultModel ? { defaultModel } : {}),
    ...(sources.length > 0 ? { source: sources.join(' + ') } : {}),
  };
}

export function detectGeminiModels(): LocalModelsDetection {
  const baseDir = process.env.GEMINI_CLI_HOME?.trim() || join(homedir(), '.gemini');
  let defaultModel: string | undefined;
  const collected: string[] = [];
  const sources: string[] = [];

  const settingsJson = safeReadJson(join(baseDir, 'settings.json'));
  if (settingsJson && !Array.isArray(settingsJson)) {
    let hitSettings = false;
    if (typeof settingsJson.model === 'string' && settingsJson.model.trim()) {
      defaultModel = settingsJson.model.trim();
      collected.push(defaultModel);
      hitSettings = true;
    } else if (settingsJson.model && typeof settingsJson.model === 'object' && !Array.isArray(settingsJson.model)) {
      const name = (settingsJson.model as Record<string, unknown>).name;
      if (typeof name === 'string' && name.trim()) {
        defaultModel = name.trim();
        collected.push(defaultModel);
        hitSettings = true;
      }
    }
    if (settingsJson.general && typeof settingsJson.general === 'object' && !Array.isArray(settingsJson.general)) {
      const gModel = (settingsJson.general as Record<string, unknown>).model;
      if (typeof gModel === 'string' && gModel.trim()) {
        if (!defaultModel) defaultModel = gModel.trim();
        collected.push(gModel.trim());
        hitSettings = true;
      }
    }
    if (typeof settingsJson.selectedModel === 'string' && settingsJson.selectedModel.trim()) {
      if (!defaultModel) defaultModel = settingsJson.selectedModel.trim();
      collected.push(settingsJson.selectedModel.trim());
      hitSettings = true;
    }
    if (Array.isArray(settingsJson.models)) {
      for (const item of settingsJson.models) {
        if (typeof item === 'string' && item.trim()) {
          collected.push(item.trim());
          hitSettings = true;
        } else if (item && typeof item === 'object' && !Array.isArray(item)) {
          const rec = item as Record<string, unknown>;
          const id = typeof rec.id === 'string' ? rec.id : typeof rec.name === 'string' ? rec.name : '';
          if (id.trim()) {
            collected.push(id.trim());
            hitSettings = true;
          }
        }
      }
    }
    if (hitSettings) sources.push('~/.gemini/settings.json');
  }

  const envModel = process.env.GEMINI_MODEL?.trim();
  if (envModel) {
    if (!defaultModel) defaultModel = envModel;
    collected.push(envModel);
    sources.push('GEMINI_MODEL');
  }

  return {
    models: dedupeModelIds(collected),
    ...(defaultModel ? { defaultModel } : {}),
    ...(sources.length > 0 ? { source: sources.join(' + ') } : {}),
  };
}

export function detectCustomLocalModels(providerId: string, command?: string): LocalModelsDetection {
  const normId = providerId.trim().toLowerCase();
  const cmdBase = command ? basename(command.trim()).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase() : '';
  if (normId !== 'opencode' && cmdBase !== 'opencode') {
    return { models: [] };
  }

  const cfgPath =
    process.env.OPENCODE_CONFIG?.trim() || join(homedir(), '.config', 'opencode', 'opencode.json');
  const oc = safeReadJson(cfgPath);
  if (!oc || Array.isArray(oc)) {
    return { models: [] };
  }

  const collected: string[] = [];
  let defaultModel: string | undefined;
  if (typeof oc.model === 'string' && oc.model.trim()) {
    defaultModel = oc.model.trim();
    collected.push(defaultModel);
  }
  if (oc.provider && typeof oc.provider === 'object' && !Array.isArray(oc.provider)) {
    for (const [provName, provCfg] of Object.entries(oc.provider as Record<string, unknown>)) {
      if (!provCfg || typeof provCfg !== 'object' || Array.isArray(provCfg)) continue;
      const modelsObj = (provCfg as Record<string, unknown>).models;
      if (!modelsObj || typeof modelsObj !== 'object' || Array.isArray(modelsObj)) continue;
      for (const modelKey of Object.keys(modelsObj)) {
        if (modelKey.trim()) {
          collected.push(`${provName}/${modelKey.trim()}`);
        }
      }
    }
  }

  const models = dedupeModelIds(collected);
  return {
    models,
    ...(defaultModel ? { defaultModel } : {}),
    ...(models.length > 0 ? { source: '~/.config/opencode/opencode.json' } : {}),
  };
}

function stripAnsi(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g, '');
}

const MODEL_ID_TOKEN_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{1,127}$/;

export function parseModelsFromCliOutput(stdout: string): string[] {
  const clean = stripAnsi(stdout).trim();
  if (!clean) return [];

  if (clean.startsWith('[') || clean.startsWith('{')) {
    try {
      const parsed = JSON.parse(clean) as unknown;
      const arr = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object'
          ? Array.isArray((parsed as Record<string, unknown>).models)
            ? ((parsed as Record<string, unknown>).models as unknown[])
            : Array.isArray((parsed as Record<string, unknown>).data)
              ? ((parsed as Record<string, unknown>).data as unknown[])
              : []
          : [];
      const extracted: string[] = [];
      for (const item of arr) {
        if (typeof item === 'string') {
          extracted.push(item);
        } else if (item && typeof item === 'object' && !Array.isArray(item)) {
          const rec = item as Record<string, unknown>;
          const id =
            typeof rec.id === 'string'
              ? rec.id
              : typeof rec.slug === 'string'
                ? rec.slug
                : typeof rec.name === 'string'
                  ? rec.name
                  : '';
          if (id) extracted.push(id);
        }
      }
      const unique = dedupeModelIds(extracted);
      if (unique.length > 0) return unique;
    } catch {
      // Fall through to line-based parser
    }
  }

  const out: string[] = [];
  for (const rawLine of clean.split('\n')) {
    const line = rawLine.trim().replace(/^[-*•]\s+/, '');
    if (!line) continue;
    if (/^(available|models|usage|options|flags|commands|descriptions?|error|warn|warning|info|http|https|---|===|\[|#)/i.test(line)) {
      continue;
    }
    const firstToken = line.split(/\s+/)[0] || '';
    if (
      !firstToken ||
      firstToken.startsWith('/') ||
      firstToken.startsWith('\\') ||
      /[:.,]$/.test(firstToken) ||
      /^\d+$/.test(firstToken) ||
      !MODEL_ID_TOKEN_RE.test(firstToken)
    ) {
      continue;
    }
    out.push(firstToken);
  }
  return dedupeModelIds(out);
}

export function parseClaudeHelpModelAliases(helpText: string): string[] {
  const clean = stripAnsi(helpText);
  const lines = clean.split('\n');
  let inModelBlock = false;
  const blockLines: string[] = [];

  for (const line of lines) {
    if (!inModelBlock) {
      if (/^\s*--model\b/.test(line)) {
        inModelBlock = true;
        blockLines.push(line);
      }
      continue;
    }
    if (!line.trim()) break;
    if (/^\s{0,4}(?:-[a-zA-Z],\s*)?--(?!model\b)[a-zA-Z]/.test(line)) break;
    blockLines.push(line);
  }

  const aliases: string[] = [];
  const blockText = blockLines.join('\n');
  for (const m of blockText.matchAll(/['"]([a-z][a-z0-9._-]{1,40})['"]/g)) {
    const token = m[1];
    if (token && token !== 'model' && token !== 'default') {
      aliases.push(token);
    }
  }
  return dedupeModelIds(aliases);
}
