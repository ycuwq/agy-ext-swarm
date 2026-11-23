import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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

function findCatalogRecursive(
  obj: unknown,
  out: Record<string, unknown>[],
  visited = new WeakSet<object>(),
): void {
  if (!obj || typeof obj !== 'object') return;
  if (visited.has(obj)) return;
  visited.add(obj);
  if (Array.isArray(obj)) {
    for (const item of obj) {
      findCatalogRecursive(item, out, visited);
    }
    return;
  }
  const rec = obj as Record<string, unknown>;
  if (Array.isArray(rec.lastCatalog)) {
    for (const entry of rec.lastCatalog) {
      if (entry && typeof entry === 'object') {
        out.push(entry as Record<string, unknown>);
      }
    }
  }
  for (const val of Object.values(rec)) {
    if (val && typeof val === 'object') {
      findCatalogRecursive(val, out, visited);
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
  return join(getDshHome(), 'profiles', profile, 'cordis.patch.yml');
}

export function listDshModels(profile = 'headless'): ModelsCatalogResult {
  const safeProfile = profile.trim() || 'headless';
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
    if (Array.isArray(parsed)) {
      const seenIds = new Set<string>();
      for (const entry of parsed) {
        if (!entry || typeof entry !== 'object') continue;
        if (entry.id === 'agent-default-model' && entry.config) {
          if (typeof entry.config.provider === 'string' && entry.config.provider.trim()) {
            defaultProvider = entry.config.provider.trim();
          }
          if (typeof entry.config.model === 'string' && entry.config.model.trim()) {
            defaultModel = entry.config.model.trim();
          }
        }

        const rawCatalog: Record<string, unknown>[] = [];
        if (entry.config) {
          findCatalogRecursive(entry.config, rawCatalog);
        }
        for (const item of rawCatalog) {
          const id = typeof item.id === 'string' ? item.id.trim() : '';
          if (!id || seenIds.has(id)) continue;
          seenIds.add(id);
          models.push({
            id,
            name: typeof item.name === 'string' ? item.name : id,
            contextWindow: typeof item.contextWindow === 'number' ? item.contextWindow : undefined,
            maxTokens: typeof item.maxTokens === 'number' ? item.maxTokens : undefined,
            creditMultiplier: typeof item.creditMultiplier === 'number' ? item.creditMultiplier : undefined,
            description:
              typeof item.descriptionEn === 'string'
                ? item.descriptionEn
                : typeof item.descriptionZh === 'string'
                  ? item.descriptionZh
                  : undefined,
            supportsToolCall: typeof item.supportsToolCall === 'boolean' ? item.supportsToolCall : undefined,
            supportsImages: typeof item.supportsImages === 'boolean' ? item.supportsImages : undefined,
          });
        }
      }
    }

    const result: ModelsCatalogResult = {
      profile: safeProfile,
      configPath,
      exists: true,
      defaultProvider,
      defaultModel,
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
