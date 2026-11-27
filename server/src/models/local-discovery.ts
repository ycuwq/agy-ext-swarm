import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import {
  normalizeAgyModelSlug,
  parseEffortFromModelName,
  sanitizeReasoningEffort,
} from '../../shared/model-options.js';
import { dedupeStrings } from '../providers/shared.js';
import type { ModelCapabilities } from '../types.js';

export { dedupeStrings as dedupeModelIds };

export interface LocalModelsDetection {
  models: string[];
  defaultModel?: string;
  defaultReasoningEffort?: string;
  defaultFastMode?: boolean;
  modelCapabilities?: Record<string, ModelCapabilities>;
  source?: string;
}

export function safeReadJson(filePath: string): Record<string, unknown> | unknown[] | null {
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
  let defaultReasoningEffort: string | undefined;
  let defaultFastMode: boolean | undefined;
  const modelCapabilities: Record<string, ModelCapabilities> = {};
  const sources: string[] = [];

  const tomlPath = join(baseDir, 'config.toml');
  if (existsSync(tomlPath)) {
    try {
      const lines = readFileSync(tomlPath, 'utf8').split('\n');
      let hitConfigToml = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        if (/^\[/.test(trimmed)) break;
        const m = /^\s*model\s*=\s*["']([^"']+)["']/.exec(trimmed);
        if (m?.[1]?.trim()) {
          defaultModel = m[1].trim();
          hitConfigToml = true;
          continue;
        }
        const eff = /^\s*model_reasoning_effort\s*=\s*["']([^"']+)["']/.exec(trimmed);
        if (eff?.[1]) {
          const parsedEff = sanitizeReasoningEffort(eff[1]);
          if (parsedEff) {
            defaultReasoningEffort = parsedEff;
            hitConfigToml = true;
          }
          continue;
        }
        const tier = /^\s*service_tier\s*=\s*["']([^"']+)["']/.exec(trimmed);
        if (tier?.[1]) {
          const normTier = tier[1].trim().toLowerCase();
          if (normTier === 'priority' || normTier === 'fast') {
            defaultFastMode = true;
            hitConfigToml = true;
          } else if (normTier === 'default' || normTier === 'standard' || normTier === 'flex') {
            defaultFastMode = false;
            hitConfigToml = true;
          }
        }
      }
      if (hitConfigToml) {
        sources.push('~/.codex/config.toml');
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
      const cleanId = id.trim();
      if (!cleanId) continue;
      cacheModels.push(cleanId);

      const efforts: string[] = [];
      if (Array.isArray(rec.supported_reasoning_levels)) {
        for (const lvl of rec.supported_reasoning_levels) {
          const rawEffort =
            typeof lvl === 'string'
              ? lvl
              : lvl && typeof lvl === 'object' && !Array.isArray(lvl)
                ? (lvl as Record<string, unknown>).effort
                : undefined;
          const cleanEff = sanitizeReasoningEffort(rawEffort);
          if (cleanEff && !efforts.includes(cleanEff)) {
            efforts.push(cleanEff);
          }
        }
      }
      const defEff = sanitizeReasoningEffort(rec.default_reasoning_level);
      const hasPriorityServiceTier =
        Array.isArray(rec.service_tiers) &&
        rec.service_tiers.some((t) => {
          if (!t || typeof t !== 'object' || Array.isArray(t)) return false;
          const tr = t as Record<string, unknown>;
          const tid = typeof tr.id === 'string' ? tr.id.trim().toLowerCase() : '';
          const tname = typeof tr.name === 'string' ? tr.name.trim().toLowerCase() : '';
          return tid === 'priority' || tid === 'fast' || tname === 'fast';
        });
      const hasFastSpeedTier =
        Array.isArray(rec.additional_speed_tiers) &&
        rec.additional_speed_tiers.some(
          (t) => typeof t === 'string' && (t.trim().toLowerCase() === 'fast' || t.trim().toLowerCase() === 'priority'),
        );
      const supportsFast = hasPriorityServiceTier || hasFastSpeedTier;
      const defTier =
        typeof rec.default_service_tier === 'string'
          ? rec.default_service_tier.trim().toLowerCase()
          : '';
      const modelDefFast =
        defTier === 'priority' || defTier === 'fast'
          ? true
          : defTier === 'default' || defTier === 'standard' || defTier === 'flex'
            ? false
            : undefined;
      if (efforts.length > 0 || defEff || supportsFast || modelDefFast !== undefined) {
        modelCapabilities[cleanId] = {
          ...(efforts.length > 0 ? { reasoningEfforts: efforts } : {}),
          ...(defEff ? { defaultReasoningEffort: defEff } : {}),
          ...(supportsFast ? { supportsFastMode: true } : {}),
          ...(modelDefFast !== undefined ? { defaultFastMode: modelDefFast } : {}),
        };
      }
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

  const models = dedupeStrings([...(defaultModel ? [defaultModel] : []), ...cacheModels]);
  return {
    models,
    ...(defaultModel ? { defaultModel } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(defaultFastMode !== undefined ? { defaultFastMode } : {}),
    ...(Object.keys(modelCapabilities).length > 0 ? { modelCapabilities } : {}),
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
  let defaultReasoningEffort: string | undefined;
  let defaultFastMode: boolean | undefined;
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
    const parsedEffort = sanitizeReasoningEffort(settingsJson.effortLevel);
    if (parsedEffort) {
      defaultReasoningEffort = parsedEffort;
      hitSettings = true;
    }
    if (typeof settingsJson.fastMode === 'boolean') {
      defaultFastMode = settingsJson.fastMode;
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
    models: dedupeStrings(collected),
    ...(defaultModel ? { defaultModel } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(defaultFastMode !== undefined ? { defaultFastMode } : {}),
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
    models: dedupeStrings(collected),
    ...(defaultModel ? { defaultModel } : {}),
    ...(sources.length > 0 ? { source: sources.join(' + ') } : {}),
  };
}

const AGY_EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export function inferAgyModelCapabilities(
  models: Iterable<unknown>,
): Record<string, ModelCapabilities> {
  const baseEfforts = new Map<string, Set<string>>();
  const variants = [];
  for (const model of dedupeStrings(models)) {
    const effort = parseEffortFromModelName(model);
    if (!effort) continue;
    const baseLabel = model.endsWith(')')
      ? model.replace(/\s*\([^)]+\)$/, '').trim()
      : model.slice(0, -effort.length - 1).trim();
    if (!baseLabel) continue;
    const baseSlug = normalizeAgyModelSlug(baseLabel);
    let set = baseEfforts.get(baseSlug);
    if (!set) {
      set = new Set<string>();
      baseEfforts.set(baseSlug, set);
    }
    set.add(effort);
    variants.push({ model, baseLabel, baseSlug, effort });
  }

  const caps = new Map<string, ModelCapabilities>();
  for (const [base, efforts] of baseEfforts) {
    caps.set(base, { reasoningEfforts: AGY_EFFORT_ORDER.filter((eff) => efforts.has(eff)) });
  }
  for (const { baseLabel, baseSlug } of variants) {
    const base = caps.get(baseSlug);
    if (base) caps.set(baseLabel, base);
  }
  for (const { model, baseSlug, effort } of variants) {
    const variant = { ...caps.get(baseSlug), defaultReasoningEffort: effort };
    caps.set(model, variant);
    caps.set(normalizeAgyModelSlug(model), variant);
  }
  return Object.fromEntries(caps);
}

export function detectAgyModels(): LocalModelsDetection {
  const baseDir =
    process.env.AGY_CLI_HOME?.trim() || join(homedir(), '.gemini', 'antigravity-cli');
  const settingsJson = safeReadJson(join(baseDir, 'settings.json'));
  const collected: string[] = [];
  let defaultModel: string | undefined;
  let defaultReasoningEffort: string | undefined;
  let hitSettings = false;

  if (settingsJson && !Array.isArray(settingsJson)) {
    if (typeof settingsJson.model === 'string' && settingsJson.model.trim()) {
      defaultModel = settingsJson.model.trim();
      collected.push(defaultModel);
      defaultReasoningEffort = parseEffortFromModelName(defaultModel);
      hitSettings = true;
    }
    const cm = settingsJson.customModelsConfig;
    const customList = Array.isArray(cm)
      ? cm
      : cm && typeof cm === 'object' && Array.isArray((cm as Record<string, unknown>).models)
        ? ((cm as Record<string, unknown>).models as unknown[])
        : [];
    for (const item of customList) {
      if (typeof item === 'string' && item.trim()) {
        collected.push(item.trim());
        hitSettings = true;
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
        if (id.trim()) {
          collected.push(id.trim());
          hitSettings = true;
        }
      }
    }
  }

  const models = dedupeStrings(collected);
  const inferredCaps = inferAgyModelCapabilities(models);
  return {
    models,
    ...(defaultModel ? { defaultModel } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(Object.keys(inferredCaps).length > 0 ? { modelCapabilities: inferredCaps } : {}),
    ...(hitSettings ? { source: '~/.gemini/antigravity-cli/settings.json' } : {}),
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

  const models = dedupeStrings(collected);
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
      const unique = dedupeStrings(extracted);
      if (unique.length > 0) return unique;
    } catch {
      // Fall through to line-based parser
    }
  }

  const out: string[] = [];
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = (rawLine.split('\r').pop() || '').trim().replace(/^[-*•]\s+/, '');
    if (!line) continue;
    if (/^(?:(?:available|models?|usage|options|flags|commands|descriptions?|error|warn(?:ing)?|info|https?)(?=\s|:|$)|---|===|\[|#)/i.test(line)) {
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
  return dedupeStrings(out);
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
  return dedupeStrings(aliases);
}
