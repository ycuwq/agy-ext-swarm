import {
  getEffectiveDefaultFastMode,
  getEffectiveDefaultReasoningEffort,
  getReasoningEffortOptionsForModel,
  lookupModelCapability,
  providerSupportsFastMode,
  providerSupportsReasoningEffort,
} from '../shared/model-options.js';
import { tr } from './context.js';
import type { FastDraftMode } from './store.js';
import type { CustomProviderConfig, ProviderDescriptor, Snapshot } from './types.js';

export function normalizeModelInput(value?: string): string {
  const model = value?.trim() || '';
  return model === 'default' ? '' : model;
}

export function getSelectableModelsForProvider(provider: ProviderDescriptor): string[] {
  for (const models of [provider.configuredModels, provider.models, provider.detectedModels, [provider.defaultModel]]) {
    const normalized = [...new Set((models ?? []).map(normalizeModelInput).filter(Boolean))];
    if (normalized.length) return normalized;
  }
  return [];
}

type DefaultLabelOptions = { includeConfigured?: boolean };

export function formatDefaultEffortLabel(
  base: string,
  provider?: Parameters<typeof getEffectiveDefaultReasoningEffort>[0],
  model?: string,
  options?: DefaultLabelOptions,
): string {
  const effort = getEffectiveDefaultReasoningEffort(provider, normalizeModelInput(model), options);
  return effort ? base + ' (' + effort + ')' : base;
}

export function formatDefaultFastLabel(
  base: string,
  provider?: Parameters<typeof getEffectiveDefaultFastMode>[0],
  model?: string,
  options?: DefaultLabelOptions,
): string {
  const fast = getEffectiveDefaultFastMode(provider, normalizeModelInput(model), options);
  return typeof fast === 'boolean'
    ? base + ' (' + tr(fast ? 'workers.fastOnBadge' : 'workers.fastOffBadge') + ')'
    : base;
}

export function getModelOptionsForUi(
  providerId: string,
  rawModel: string | undefined,
  provider?: ProviderDescriptor,
  opts?: DefaultLabelOptions & { customConfig?: CustomProviderConfig; followLabel?: string },
) {
  const custom = opts?.customConfig;
  const descriptor: ProviderDescriptor | undefined = custom
    ? {
        id: providerId,
        kind: 'custom',
        available: true,
        displayName: providerId,
        supportsSessionResume: Boolean(custom.resumeArgs?.length),
        supportsStreamEvents: custom.outputFormat === 'ndjson',
        configuredModels: custom.models ?? [],
        models: custom.models ?? [],
        hasOverride: false,
        command: custom.command,
        defaultModel: custom.defaultModel,
        configuredDefaultReasoningEffort: custom.defaultReasoningEffort,
        configuredDefaultFastMode: custom.defaultFastMode,
        enabled: custom.enabled ?? true,
        args: custom.args,
        resumeArgs: custom.resumeArgs,
      }
    : provider;
  const model = normalizeModelInput(rawModel) || normalizeModelInput(descriptor?.defaultModel);
  const capability = lookupModelCapability(descriptor, model);
  const supportsEffort = providerSupportsReasoningEffort(providerId, descriptor);
  const supportsFast = providerSupportsFastMode(providerId, descriptor) && capability?.supportsFastMode !== false;
  const label = opts?.followLabel ?? tr('cmd.followDefault');
  return {
    supportsEffort,
    supportsFast,
    efforts: supportsEffort ? getReasoningEffortOptionsForModel(descriptor, model) : [],
    effortLabel: formatDefaultEffortLabel(label, descriptor, model, opts),
    fastLabel: formatDefaultFastLabel(label, descriptor, model, opts),
  };
}

export function resetModelOptions(rawModel?: string, providers: readonly ProviderDescriptor[] = []) {
  const model = normalizeModelInput(rawModel);
  return {
    model: model && providers.some((p) => getSelectableModelsForProvider(p).includes(model)) ? model : '',
    reasoningEffort: '',
    fastMode: 'default' as FastDraftMode,
  };
}

export function getAddWorkerTargetIds(selected: ReadonlySet<string>, snap: Snapshot | null, fallback?: string): string[] {
  if (selected.size > 0) return [...selected];
  if (snap?.swarm?.activeProviders?.length) return snap.swarm.activeProviders;
  return [snap?.swarm?.defaultProvider || fallback || 'dsh'];
}
