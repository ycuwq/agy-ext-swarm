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

export function listDshModels(profile = 'headless'): ModelsCatalogResult {
  const safeProfile = profile.trim() || 'headless';
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
          return {
            ...primary,
            defaultProvider: primary.defaultProvider || sibRes.defaultProvider,
            defaultModel: primary.defaultModel || sibRes.defaultModel,
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
  return raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
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
