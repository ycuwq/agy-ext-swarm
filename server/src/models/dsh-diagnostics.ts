import { join } from 'node:path';
import type { DshProfileProviderCheck, ModelsCatalogResult } from '../types.js';
import {
  extractNpmPackageName,
  getDshHome,
  inferEntryBaseProvider,
  isBuiltinDshModelProvider,
  isCoreDshPackage,
  isPatchEntryDisabled,
  isPlainObject,
  isValidDshProfileName,
  listDshModels,
  listSiblingDshProfiles,
  readRawDshPatchEntries,
  readSingleDshProfileCatalog,
  resolveRegionProvider,
  type DshPatchOverlayEntry,
} from './dsh-catalog.js';
import { safeReadJson } from './local-discovery.js';

interface DshProfilePackageInfo {
  exists: boolean;
  packageJsonPath: string;
  bundles: Set<string>;
  dependencies: Set<string>;
  hasBundlesField: boolean;
}

function readDshProfilePackageInfo(safeProfile: string): DshProfilePackageInfo {
  const packageJsonPath = join(getDshHome(), 'profiles', safeProfile, 'package.json');
  const bundles = new Set<string>();
  const dependencies = new Set<string>();
  const raw = safeReadJson(packageJsonPath);
  if (!raw || Array.isArray(raw)) {
    return { exists: false, packageJsonPath, bundles, dependencies, hasBundlesField: false };
  }
  const obj = raw as Record<string, unknown>;
  const dshField = obj.dsh;
  if (isPlainObject(dshField)) {
    const prof = dshField.profile;
    if (isPlainObject(prof) && Array.isArray(prof.bundles)) {
      for (const item of prof.bundles) {
        if (typeof item === 'string' && item.trim()) {
          bundles.add(item.trim());
        }
      }
    }
  }
  for (const depKey of ['dependencies', 'optionalDependencies'] as const) {
    const depObj = obj[depKey];
    if (isPlainObject(depObj)) {
      for (const name of Object.keys(depObj)) {
        const clean = name.trim();
        if (clean) dependencies.add(clean);
      }
    }
  }
  return {
    exists: true,
    packageJsonPath,
    bundles,
    dependencies,
    hasBundlesField: bundles.size > 0,
  };
}

function isPluginActiveInPackage(pkgInfo: DshProfilePackageInfo, pkgName: string): boolean {
  if (!pkgInfo.exists) return false;
  if (pkgInfo.hasBundlesField) return pkgInfo.bundles.has(pkgName);
  return pkgInfo.dependencies.has(pkgName);
}

function isPluginDisabled(
  disabledPlugins: string[] | undefined,
  pluginPackage: string,
  modelProvider: string,
): boolean {
  const unscopedName = pluginPackage.slice(pluginPackage.lastIndexOf('/') + 1);
  const base = /dsh-connect-([a-z0-9][a-z0-9._-]*)/i.exec(unscopedName)?.[1] || modelProvider;
  return disabledPlugins?.some(
    (id) => id === pluginPackage || id === unscopedName || id === 'dsh-connect-' + base,
  ) ?? false;
}

function findMatchingConnectPackageInPkg(
  pkgInfo: DshProfilePackageInfo,
  modelProvider: string,
): string | undefined {
  const mp = modelProvider.trim().toLowerCase();
  if (!mp) return undefined;
  const candidates = new Set<string>([...pkgInfo.bundles, ...pkgInfo.dependencies]);
  for (const pkg of candidates) {
    if (isCoreDshPackage(pkg)) continue;
    const match = /dsh-connect-([a-z0-9][a-z0-9._-]*)/i.exec(pkg);
    if (!match?.[1]) continue;
    const base = match[1].toLowerCase();
    if (mp === base || mp.startsWith(`${base}-`)) {
      return pkg;
    }
  }
  return undefined;
}

interface ResolvedDshProviderOrigin {
  pluginPackage?: string;
  sourceProfile?: string;
  siblingPiAiSource?: string;
  declaredInPrimary: boolean;
}

function resolveDshProviderOrigin(
  safeProfile: string,
  mp: string,
  opts: {
    primaryCatalog: ModelsCatalogResult;
    catalog?: ModelsCatalogResult;
    inspectPackages: boolean;
    primaryPkg?: DshProfilePackageInfo;
  },
): ResolvedDshProviderOrigin {
  let pluginPackage = opts.primaryCatalog.providerPlugins?.[mp];
  let sourceProfile: string | undefined;
  let siblingPiAiSource: string | undefined;
  let declaredInPrimary = Boolean(pluginPackage);

  if (!pluginPackage && opts.catalog?.providerPlugins?.[mp]) {
    pluginPackage = opts.catalog.providerPlugins[mp];
    if (opts.catalog.catalogSourceProfile && opts.catalog.catalogSourceProfile !== safeProfile) {
      sourceProfile = opts.catalog.catalogSourceProfile;
    }
  }

  if (!pluginPackage && opts.inspectPackages && opts.primaryPkg) {
    const primaryPkgMatch = findMatchingConnectPackageInPkg(opts.primaryPkg, mp);
    if (primaryPkgMatch) {
      pluginPackage = primaryPkgMatch;
      declaredInPrimary = true;
    }
  }

  if (!pluginPackage) {
    for (const sib of listSiblingDshProfiles(safeProfile)) {
      const sibCatalog = readSingleDshProfileCatalog(sib);
      if (sibCatalog.providerPlugins?.[mp]) {
        pluginPackage = sibCatalog.providerPlugins[mp];
        sourceProfile = sib;
        break;
      }
      if (!siblingPiAiSource && sibCatalog.piAiProviders?.includes(mp)) {
        siblingPiAiSource = sib;
      }
      if (opts.inspectPackages) {
        const pkgMatch = findMatchingConnectPackageInPkg(readDshProfilePackageInfo(sib), mp);
        if (pkgMatch) {
          pluginPackage = pkgMatch;
          sourceProfile = sib;
          break;
        }
      }
    }
  }

  return { pluginPackage, sourceProfile, siblingPiAiSource, declaredInPrimary };
}

export function checkDshProfileProviderPlugin(
  profile: string,
  modelProvider: string | undefined,
  catalog?: ModelsCatalogResult,
): DshProfileProviderCheck {
  const safeProfile = profile.trim() || 'headless';
  const mp = modelProvider?.trim();
  if (!isValidDshProfileName(safeProfile) || !mp || isBuiltinDshModelProvider(mp)) {
    return {
      ok: true,
      profile: safeProfile,
      ...(mp ? { modelProvider: mp } : {}),
    };
  }

  const primaryCatalog = readSingleDshProfileCatalog(safeProfile);
  const primaryPkg = readDshProfilePackageInfo(safeProfile);

  if (primaryCatalog.piAiProviders?.includes(mp)) {
    return {
      ok: true,
      profile: safeProfile,
      modelProvider: mp,
    };
  }

  const { pluginPackage, sourceProfile, siblingPiAiSource, declaredInPrimary } =
    resolveDshProviderOrigin(safeProfile, mp, {
      primaryCatalog,
      catalog,
      inspectPackages: true,
      primaryPkg,
    });

  if (pluginPackage) {
    if (isPluginDisabled(primaryCatalog.disabledPlugins, pluginPackage, mp)) {
      return {
        ok: false,
        profile: safeProfile,
        modelProvider: mp,
        reason: 'plugin-disabled',
        pluginPackage,
        ...(sourceProfile ? { sourceProfile } : {}),
        warning: `dsh provider "${mp}" requires plugin "${pluginPackage}", which is disabled in profile "${safeProfile}" (${primaryCatalog.configPath}).`,
      };
    }
    if (primaryPkg.exists) {
      if (isPluginActiveInPackage(primaryPkg, pluginPackage)) {
        return {
          ok: true,
          profile: safeProfile,
          modelProvider: mp,
          pluginPackage,
        };
      }
    } else if (declaredInPrimary && !sourceProfile) {
      return {
        ok: true,
        profile: safeProfile,
        modelProvider: mp,
        pluginPackage,
      };
    }

    const installCommand = `dsh plugin --profile ${safeProfile} add ${pluginPackage}`;
    const fromClause = sourceProfile ? ` (from profile "${sourceProfile}")` : '';
    return {
      ok: false,
      profile: safeProfile,
      modelProvider: mp,
      reason: 'missing-plugin',
      pluginPackage,
      ...(sourceProfile ? { sourceProfile } : {}),
      installCommand,
      warning: `dsh provider "${mp}" requires plugin "${pluginPackage}"${fromClause}, missing in profile "${safeProfile}". Run: ${installCommand}`,
    };
  }

  if (siblingPiAiSource) {
    return {
      ok: false,
      profile: safeProfile,
      modelProvider: mp,
      reason: 'missing-pi-ai-provider',
      sourceProfile: siblingPiAiSource,
      warning: `dsh provider "${mp}" is configured under "llm-pi-ai" in sibling profile "${siblingPiAiSource}", but not in profile "${safeProfile}" (${primaryCatalog.configPath}). Copy its llm-pi-ai provider config into "${safeProfile}" or choose another provider.`,
    };
  }

  return {
    ok: true,
    profile: safeProfile,
    modelProvider: mp,
  };
}

export function checkDshProfileCatalogPlugins(
  profile: string,
  modelProviders: Iterable<string | undefined>,
  catalog?: ModelsCatalogResult,
): DshProfileProviderCheck[] {
  const safeProfile = profile.trim() || 'headless';
  const seenProviders = new Set<string>();
  const grouped = new Map<
    string,
    { providers: string[]; check: DshProfileProviderCheck }
  >();

  for (const rawProv of modelProviders) {
    const mp = rawProv?.trim();
    if (!mp || seenProviders.has(mp)) continue;
    seenProviders.add(mp);
    const res = checkDshProfileProviderPlugin(safeProfile, mp, catalog);
    if (res.ok) continue;
    const key = `${res.reason || 'unknown'}:${res.pluginPackage || res.modelProvider || mp}`;
    const existing = grouped.get(key);
    if (existing) {
      if (!existing.providers.includes(mp)) {
        existing.providers.push(mp);
      }
    } else {
      grouped.set(key, { providers: [mp], check: res });
    }
  }

  const out: DshProfileProviderCheck[] = [];
  for (const { providers, check } of grouped.values()) {
    if (providers.length <= 1) {
      out.push(check);
      continue;
    }
    const provList = providers.join(', ');
    let warning = check.warning;
    if (check.reason === 'missing-plugin' && check.pluginPackage) {
      const fromClause = check.sourceProfile ? ` (from profile "${check.sourceProfile}")` : '';
      const cmd = check.installCommand || `dsh plugin --profile ${check.profile} add ${check.pluginPackage}`;
      warning = `dsh providers "${provList}" require plugin "${check.pluginPackage}"${fromClause}, missing in profile "${check.profile}". Run: ${cmd}`;
    } else if (check.reason === 'plugin-disabled' && check.pluginPackage) {
      warning = `dsh providers "${provList}" require plugin "${check.pluginPackage}", which is disabled in profile "${check.profile}".`;
    } else if (check.reason === 'missing-pi-ai-provider' && check.sourceProfile) {
      warning = `dsh providers "${provList}" are configured under "llm-pi-ai" in sibling profile "${check.sourceProfile}", but not in profile "${check.profile}".`;
    }
    out.push({
      ...check,
      ...(warning ? { warning } : {}),
    });
  }
  return out;
}

export function getDshNoAdapterHint(profile: string, missingProvider: string): string {
  const safeProfile = profile.trim() || 'headless';
  const mp = missingProvider.trim();
  if (isValidDshProfileName(safeProfile) && mp) {
    const primaryCatalog = readSingleDshProfileCatalog(safeProfile);
    const catalog = listDshModels(safeProfile);
    const { pluginPackage, sourceProfile, siblingPiAiSource } = resolveDshProviderOrigin(
      safeProfile,
      mp,
      { primaryCatalog, catalog, inspectPackages: false },
    );

    if (pluginPackage) {
      if (isPluginDisabled(primaryCatalog.disabledPlugins, pluginPackage, mp)) {
        return `dsh provider "${mp}" requires plugin "${pluginPackage}", which is disabled in profile "${safeProfile}" (${primaryCatalog.configPath}).`;
      }
      const fromClause = sourceProfile ? ` (from profile "${sourceProfile}")` : '';
      return `dsh provider "${mp}" requires plugin "${pluginPackage}"${fromClause}, which is not active in profile "${safeProfile}". Run: dsh plugin --profile ${safeProfile} add ${pluginPackage}`;
    }

    if (siblingPiAiSource) {
      return `dsh provider "${mp}" is configured under "llm-pi-ai" in sibling profile "${siblingPiAiSource}", but not in profile "${safeProfile}" (${primaryCatalog.configPath}). Copy its llm-pi-ai provider config into "${safeProfile}" or choose another provider.`;
    }
  }

  return `provider "${mp || missingProvider}" is not registered in dsh profile "${safeProfile}". If it comes from a dsh plugin in another profile (e.g. "desktop"), install it via \`dsh plugin --profile ${safeProfile} add <plugin-package>\`, or configure it in ~/.dsh/profiles/${safeProfile}/cordis.patch.yml.`;
}

const RESERVED_DSH_OVERLAY_IDS = new Set([
  'agent-default-model',
  'llm-pi-ai',
  'subagent-model-selection-settings',
]);

function sanitizeDshReasoning(raw: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: Record<string, unknown> = {};
  if (Array.isArray(raw.supportedEfforts)) {
    const efforts = raw.supportedEfforts
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.trim())
      .filter(Boolean);
    if (efforts.length > 0) out.supportedEfforts = efforts;
  }
  if (typeof raw.defaultEffort === 'string' && raw.defaultEffort.trim()) {
    out.defaultEffort = raw.defaultEffort.trim();
  }
  if (typeof raw.canDisableThinking === 'boolean') {
    out.canDisableThinking = raw.canDisableThinking;
  }
  if (typeof raw.enabled === 'boolean') {
    out.enabled = raw.enabled;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeDshCatalogModel(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return undefined;
  const out: Record<string, unknown> = { id };
  if (typeof raw.name === 'string' && raw.name.trim()) {
    out.name = raw.name.trim();
  }
  if (typeof raw.provider === 'string' && raw.provider.trim()) {
    out.provider = raw.provider.trim();
  }
  if (typeof raw.contextWindow === 'number' && Number.isFinite(raw.contextWindow) && raw.contextWindow > 0) {
    out.contextWindow = raw.contextWindow;
  }
  if (typeof raw.maxTokens === 'number' && Number.isFinite(raw.maxTokens) && raw.maxTokens > 0) {
    out.maxTokens = raw.maxTokens;
  }
  if (typeof raw.supportsToolCall === 'boolean') {
    out.supportsToolCall = raw.supportsToolCall;
  }
  if (typeof raw.supportsImages === 'boolean') {
    out.supportsImages = raw.supportsImages;
  }
  if (Array.isArray(raw.inputModalities)) {
    const mods = raw.inputModalities
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.trim())
      .filter(Boolean);
    if (mods.length > 0) out.inputModalities = mods;
  }
  const reasoning = sanitizeDshReasoning(raw.reasoning);
  if (reasoning) {
    out.reasoning = reasoning;
  }
  return out;
}

function sanitizeDshCatalogModels(
  items: unknown[],
  requiredModelId: string,
  maxItems = 200,
): Record<string, unknown>[] {
  const all: Record<string, unknown>[] = [];
  const seenIds = new Set<string>();
  for (const item of items) {
    if (!isPlainObject(item)) continue;
    if (item.disabled === true || item.enabled === false) continue;
    const sanitized = sanitizeDshCatalogModel(item);
    if (!sanitized) continue;
    const id = sanitized.id as string;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    all.push(sanitized);
  }
  if (all.length <= maxItems) return all;
  const sliced = all.slice(0, maxItems);
  if (requiredModelId && !sliced.some((m) => m.id === requiredModelId)) {
    const required = all.find((m) => m.id === requiredModelId);
    if (required) {
      sliced[sliced.length - 1] = required;
    }
  }
  return sliced;
}

function catalogHasMatchingModel(
  items: unknown[],
  mid: string,
  mp: string,
  fallbackProv: string | undefined,
): boolean {
  return items.some(
    (item) =>
      isPlainObject(item) &&
      item.disabled !== true &&
      item.enabled !== false &&
      typeof item.id === 'string' &&
      item.id.trim() === mid &&
      ((typeof item.provider === 'string' && item.provider.trim()) || fallbackProv) === mp,
  );
}

function getExplicitProviderFields(config: Record<string, unknown>) {
  return {
    ...(typeof config.provider === 'string' && config.provider.trim()
      ? { provider: config.provider.trim() }
      : {}),
    ...(typeof config.providerId === 'string' && config.providerId.trim()
      ? { providerId: config.providerId.trim() }
      : {}),
  };
}

function findDshSiblingCatalogOverlayWithSource(
  profile: string,
  modelProvider: string | undefined,
  modelId: string,
): { entry: DshPatchOverlayEntry; sourceProfile: string } | undefined {
  const safeProfile = profile.trim() || 'headless';
  const mp = modelProvider?.trim();
  const mid = modelId.trim();
  if (!isValidDshProfileName(safeProfile) || !mp || !mid || mid === 'default' || isBuiltinDshModelProvider(mp)) {
    return undefined;
  }

  const primaryCatalog = readSingleDshProfileCatalog(safeProfile);
  if (
    primaryCatalog.models.some(
      (m) => m.id === mid && (m.provider || primaryCatalog.defaultProvider) === mp,
    ) ||
    primaryCatalog.piAiProviders?.includes(mp)
  ) {
    return undefined;
  }

  const primaryEntries = readRawDshPatchEntries(safeProfile);
  const primaryConfiguredIds = new Set<string>();
  for (const entry of primaryEntries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const eid = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!eid) continue;
    const cfg = isPlainObject(entry.config) ? entry.config : undefined;
    if (isPatchEntryDisabled(entry) || (cfg && Object.keys(cfg).length > 0)) {
      primaryConfiguredIds.add(eid);
    }
  }

  for (const sib of listSiblingDshProfiles(safeProfile)) {
    const sibEntries = readRawDshPatchEntries(sib);
    for (const entry of sibEntries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      if (isPatchEntryDisabled(entry)) continue;
      const cfg = isPlainObject(entry.config) ? entry.config : undefined;
      const entryId = typeof entry.id === 'string' ? entry.id.trim() : '';
      if (!entryId || RESERVED_DSH_OVERLAY_IDS.has(entryId)) continue;
      const entryPkg = extractNpmPackageName(typeof entry.name === 'string' ? entry.name : undefined);
      if (entryPkg && isCoreDshPackage(entryPkg)) continue;
      if (primaryConfiguredIds.has(entryId)) continue;
      if (!cfg) continue;

      const baseProv = inferEntryBaseProvider(entry);
      const explicitProviderFields = getExplicitProviderFields(cfg);
      const regionsObj = cfg.regions;
      if (isPlainObject(regionsObj)) {
        for (const [regionKey, regionVal] of Object.entries(regionsObj)) {
          if (!isPlainObject(regionVal)) continue;
          if (regionVal.enabled === false || regionVal.disabled === true) continue;
          if (!Array.isArray(regionVal.lastCatalog)) continue;
          const regionProviderFields = getExplicitProviderFields(regionVal);
          const regProv =
            regionProviderFields.provider ||
            regionProviderFields.providerId ||
            resolveRegionProvider(baseProv, regionKey) ||
            baseProv;
          if (catalogHasMatchingModel(regionVal.lastCatalog, mid, mp, regProv)) {
            const sanitized = sanitizeDshCatalogModels(regionVal.lastCatalog, mid);
            if (sanitized.length > 0) {
              return {
                entry: {
                  id: entryId,
                  config: {
                    ...explicitProviderFields,
                    regions: {
                      [regionKey]: {
                        enabled: true,
                        ...regionProviderFields,
                        lastCatalog: sanitized,
                      },
                    },
                  },
                },
                sourceProfile: sib,
              };
            }
          }
        }
      }

      const flatCatalog = cfg.lastCatalog;
      if (Array.isArray(flatCatalog) && catalogHasMatchingModel(flatCatalog, mid, mp, baseProv)) {
        const sanitized = sanitizeDshCatalogModels(flatCatalog, mid);
        if (sanitized.length > 0) {
          return {
            entry: {
              id: entryId,
              config: {
                ...explicitProviderFields,
                lastCatalog: sanitized,
              },
            },
            sourceProfile: sib,
          };
        }
      }
    }
  }

  return undefined;
}

export function buildDshSiblingCatalogOverlay(
  profile: string,
  modelProvider: string | undefined,
  modelId: string,
): DshPatchOverlayEntry | undefined {
  return findDshSiblingCatalogOverlayWithSource(profile, modelProvider, modelId)?.entry;
}

export interface DshModelCatalogReadiness {
  status: 'builtin' | 'in-profile' | 'sibling-overlay' | 'missing-in-profile';
  sourceProfile?: string;
  warning?: string;
}

export function checkDshModelCatalogReadiness(
  profile: string,
  modelProvider: string | undefined,
  modelId: string,
): DshModelCatalogReadiness {
  const safeProfile = profile.trim() || 'headless';
  const mp = modelProvider?.trim();
  const mid = modelId.trim();
  if (!isValidDshProfileName(safeProfile) || !mid || mid === 'default' || !mp || isBuiltinDshModelProvider(mp)) {
    return { status: 'builtin' };
  }

  const primaryCatalog = readSingleDshProfileCatalog(safeProfile);
  if (
    primaryCatalog.models.some(
      (m) => m.id === mid && (m.provider || primaryCatalog.defaultProvider) === mp,
    ) ||
    primaryCatalog.piAiProviders?.includes(mp)
  ) {
    return { status: 'in-profile' };
  }

  const sibMatch = findDshSiblingCatalogOverlayWithSource(safeProfile, mp, mid);
  if (sibMatch) {
    return {
      status: 'sibling-overlay',
      sourceProfile: sibMatch.sourceProfile,
    };
  }

  return {
    status: 'missing-in-profile',
    warning: `Model "${mp}/${mid}" is not saved in profile "${safeProfile}" (${primaryCatalog.configPath}) and cannot be auto-overlaid from a sibling profile; dsh may reject it with UNKNOWN_MODEL unless added to "${safeProfile}"'s cordis.patch.yml.`,
  };
}

export function getDshUnknownModelHint(
  profile: string,
  modelProvider: string,
  modelId: string,
): string {
  const safeProfile = profile.trim() || 'headless';
  const mp = modelProvider.trim();
  const mid = modelId.trim();
  if (isValidDshProfileName(safeProfile)) {
    const primaryCatalog = readSingleDshProfileCatalog(safeProfile);
    if (primaryCatalog.models.length > 0) {
      return `Model "${mid}" is missing from profile "${safeProfile}"'s saved catalog (${primaryCatalog.configPath}); refresh or add it to the plugin's lastCatalog (or llm-pi-ai.providers) in "${safeProfile}", or choose another model supported by "${mp}".`;
    }
    return `Model "${mid}" is not in profile "${safeProfile}"'s saved catalog (${primaryCatalog.configPath}); sync or refresh the plugin's lastCatalog into "${safeProfile}" or choose another model supported by "${mp}".`;
  }
  return `Model "${mid}" is not in dsh profile "${safeProfile}"'s saved catalog; sync the plugin's lastCatalog into ~/.dsh/profiles/${safeProfile}/cordis.patch.yml or choose another model supported by "${mp}".`;
}
