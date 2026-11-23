import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import YAML from 'yaml';
import type { ModelInfo, ModelsCatalogResult } from '../types.js';

export interface PatchEntry {
  id?: string;
  name?: string;
  disabled?: unknown;
  config?: Record<string, unknown>;
}

export interface DshPatchOverlayEntry {
  id: string;
  config: Record<string, unknown>;
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

export function isPlainObject(val: unknown): val is Record<string, unknown> {
  return Boolean(val && typeof val === 'object' && !Array.isArray(val));
}

export function isPatchEntryDisabled(entry: PatchEntry | null | undefined): boolean {
  if (!entry || typeof entry !== 'object') return true;
  return Boolean(
    entry.disabled === true ||
      entry.config?.disabled === true ||
      entry.config?.enabled === false,
  );
}

export function isValidDshProfileName(profile: string): boolean {
  const trimmed = profile.trim();
  return Boolean(trimmed && !trimmed.includes('..') && DSH_PROVIDER_ID_RE.test(trimmed));
}

export function extractNpmPackageName(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed || /\s/.test(trimmed) || trimmed.includes('..')) return undefined;
  if (trimmed.startsWith('@')) {
    const parts = trimmed.split('/');
    if (parts.length < 2) return undefined;
    const [scope, pkg] = parts;
    if (!/^@[a-z0-9._~-]+$/i.test(scope) || !/^[a-z0-9._~-]+$/i.test(pkg)) return undefined;
    return `${scope}/${pkg}`;
  }
  const pkg = trimmed.split('/')[0];
  if (!/^[a-z0-9][a-z0-9._~-]*$/i.test(pkg)) return undefined;
  return pkg;
}

export function isCoreDshPackage(pkgName: string): boolean {
  return pkgName.startsWith('@deepseek-ai/');
}

export function isBuiltinDshModelProvider(modelProvider: string): boolean {
  return modelProvider.trim().toLowerCase() === 'deepseek-official';
}

export function listSiblingDshProfiles(safeProfile: string): string[] {
  const profilesDir = join(getDshHome(), 'profiles');
  if (!existsSync(profilesDir)) return [];
  try {
    const siblings = readdirSync(profilesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== safeProfile && isValidDshProfileName(d.name))
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
    return siblings;
  } catch {
    return [];
  }
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

export function inferEntryBaseProvider(entry: PatchEntry): string | undefined {
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

export function resolveRegionProvider(baseProvider: string | undefined, regionKey: string): string | undefined {
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
      if (isPlainObject(entry)) {
        const itemProv =
          typeof entry.provider === 'string' && entry.provider.trim()
            ? entry.provider.trim()
            : localProvider;
        out.push({ provider: itemProv, item: entry });
      }
    }
  }

  for (const [key, val] of Object.entries(rec)) {
    if (!val || typeof val !== 'object') continue;
    if (key === 'regions' && !Array.isArray(val)) {
      for (const [regionKey, regionVal] of Object.entries(val as Record<string, unknown>)) {
        if (!isPlainObject(regionVal)) continue;
        if (regionVal.enabled === false || regionVal.disabled === true) continue;
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
        } else if (isPlainObject(m)) {
          if (m.disabled === true || m.enabled === false) continue;
          const mProv =
            typeof m.provider === 'string' && m.provider.trim()
              ? m.provider.trim()
              : cleanProv;
          pushModel(m, mProv);
        }
      }
    } else if (rawModels && typeof rawModels === 'object') {
      for (const [modelKey, modelMeta] of Object.entries(rawModels as Record<string, unknown>)) {
        const id = modelKey.trim();
        if (!id) continue;
        if (isPlainObject(modelMeta)) {
          if (modelMeta.disabled === true || modelMeta.enabled === false) continue;
          pushModel(
            {
              ...modelMeta,
              id: typeof modelMeta.id === 'string' && modelMeta.id.trim() ? modelMeta.id : id,
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
      if (!isPlainObject(item)) continue;
      const provId =
        typeof item.id === 'string'
          ? item.id
          : typeof item.provider === 'string'
            ? item.provider
            : typeof item.name === 'string'
              ? item.name
              : '';
      if (provId.trim()) collectFromProviderObj(provId, item);
    }
  } else {
    for (const [provKey, provVal] of Object.entries(providersField as Record<string, unknown>)) {
      if (!isPlainObject(provVal)) continue;
      collectFromProviderObj(provKey, provVal);
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

export function readRawDshPatchEntries(safeProfile: string): PatchEntry[] {
  const configPath = getProfilePatchPath(safeProfile);
  if (!existsSync(configPath)) return [];
  try {
    const raw = readFileSync(configPath, 'utf8');
    const parsed = YAML.parse(raw, CUSTOM_TAG_SAFE_OPTIONS) as unknown;
    return Array.isArray(parsed) ? (parsed as PatchEntry[]) : [];
  } catch {
    return [];
  }
}

export function readSingleDshProfileCatalog(safeProfile: string): ModelsCatalogResult {
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
    const providerPlugins: Record<string, string> = {};
    const piAiProviderSet = new Set<string>();
    const disabledPluginSet = new Set<string>();
    if (Array.isArray(parsed)) {
      const seenKeys = new Set<string>();
      const addProvider = (p?: string) => {
        const clean = p?.trim();
        if (clean) providerSet.add(clean);
      };

      // Pass 1: find agent-default-model first
      for (const entry of parsed) {
        if (!entry || typeof entry !== 'object') continue;
        if (isPatchEntryDisabled(entry)) continue;
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
        if (isPatchEntryDisabled(entry)) {
          const pkg = extractNpmPackageName(entry.name);
          if (pkg && !isCoreDshPackage(pkg)) {
            disabledPluginSet.add(pkg);
          }
          if ((!pkg || !isCoreDshPackage(pkg)) && typeof entry.id === 'string' && entry.id.trim()) {
            disabledPluginSet.add(entry.id.trim());
          }
          continue;
        }
        const entryPkg = extractNpmPackageName(entry.name);
        const isExternalPkg = Boolean(entryPkg && !isCoreDshPackage(entryPkg));
        const isPiAiEntry = entry.id === 'llm-pi-ai' || entryPkg === '@deepseek-ai/dsh-llm-pi-ai';
        const entryProviders = new Set<string>();
        const addEntryProvider = (p?: string) => {
          addProvider(p);
          const clean = p?.trim();
          if (clean) entryProviders.add(clean);
        };
        const pushEntryModel = (rawItem: Record<string, unknown> | string, explicitProvider?: string) => {
          const ep = explicitProvider?.trim();
          if (ep) entryProviders.add(ep);
          pushModel(rawItem, explicitProvider);
        };

        extractConfiguredProvidersModels(entry, pushEntryModel, addEntryProvider);
        const rawCatalog: ExtractedCatalogModel[] = [];
        if (entry.config) {
          findCatalogEntriesRecursive(entry.config, inferEntryBaseProvider(entry), rawCatalog);
        }
        for (const item of rawCatalog) {
          const itemProv = item.provider?.trim();
          if (itemProv) entryProviders.add(itemProv);
          pushModel(item.item, item.provider);
        }
        if (isExternalPkg) {
          const baseProv = inferEntryBaseProvider(entry);
          if (baseProv) entryProviders.add(baseProv);
        }
        if (isExternalPkg && entryPkg) {
          for (const prov of entryProviders) {
            if (!providerPlugins[prov]) {
              providerPlugins[prov] = entryPkg;
            }
          }
        }
        if (isPiAiEntry) {
          for (const prov of entryProviders) {
            piAiProviderSet.add(prov);
          }
        }
      }

      // Pass 3: allowedModels (e.g. subagent-model-selection-settings)
      for (const entry of parsed) {
        if (!entry || typeof entry !== 'object') continue;
        if (isPatchEntryDisabled(entry)) continue;
        const allowed = entry.config?.allowedModels;
        if (!Array.isArray(allowed)) continue;
        for (const item of allowed) {
          if (typeof item === 'string' && item.trim()) {
            const parsedItem = parseDshQualifiedModel(item, providerSet, defaultProvider || undefined);
            pushModel(parsedItem.model, parsedItem.modelProvider);
          } else if (isPlainObject(item)) {
            if (item.disabled === true || item.enabled === false) continue;
            const mId = typeof item.model === 'string' ? item.model.trim() : typeof item.id === 'string' ? item.id.trim() : '';
            const mProv = typeof item.provider === 'string' ? item.provider.trim() : undefined;
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
      ...(Object.keys(providerPlugins).length > 0 ? { providerPlugins } : {}),
      ...(piAiProviderSet.size > 0 ? { piAiProviders: Array.from(piAiProviderSet) } : {}),
      ...(disabledPluginSet.size > 0 ? { disabledPlugins: Array.from(disabledPluginSet) } : {}),
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

  const siblings = listSiblingDshProfiles(safeProfile);
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
      const mergedProviderPlugins: Record<string, string> = {
        ...(sibRes.providerPlugins || {}),
        ...(primary.providerPlugins || {}),
      };
      return {
        ...primary,
        defaultProvider: useSiblingDefaults ? sibRes.defaultProvider : primary.defaultProvider,
        defaultModel: useSiblingDefaults ? sibRes.defaultModel : primary.defaultModel,
        ...(mergedProviders.length > 0 ? { providers: mergedProviders } : {}),
        ...(Object.keys(mergedProviderPlugins).length > 0
          ? { providerPlugins: mergedProviderPlugins }
          : {}),
        models: sibRes.models,
        catalogSourceProfile: sibling,
        note: `Loaded ${sibRes.models.length} model(s) (read-only) from sibling profile "${sibling}"; runtime still uses profile "${safeProfile}".`,
      };
    }
  }

  return primary;
}

export function writeModelPatch(
  patchPath: string,
  provider: string | undefined,
  model: string,
  extraEntries?: DshPatchOverlayEntry[],
): void {
  mkdirSync(dirname(patchPath), { recursive: true });
  const trimmedProvider = provider?.trim();
  const config: Record<string, string> = trimmedProvider
    ? { provider: trimmedProvider, model }
    : { model };
  const doc: Array<Record<string, unknown>> = [
    {
      id: 'agent-default-model',
      name: '@deepseek-ai/dsh-agent-default-model',
      config,
    },
  ];
  if (extraEntries?.length) {
    for (const extra of extraEntries) {
      const id = extra.id.trim();
      if (!id || id === 'agent-default-model') continue;
      doc.push({
        id,
        config: extra.config,
      });
    }
  }
  writeFileSync(patchPath, YAML.stringify(doc), 'utf8');
}
