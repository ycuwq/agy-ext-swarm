import type { ModelCapabilities, ProviderDescriptor } from './types.js';

export const REASONING_EFFORT_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

export const DEFAULT_REASONING_EFFORTS_BY_PROVIDER: Record<string, readonly string[]> = {
  codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  dsh: ['low', 'medium', 'high', 'xhigh'],
  agy: ['low', 'medium', 'high', 'xhigh', 'max'],
};

const CUSTOM_DEFAULT_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function sanitizeReasoningEffort(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const norm = raw.trim().toLowerCase();
  if (!norm || norm === 'default' || !REASONING_EFFORT_RE.test(norm)) {
    return undefined;
  }
  return norm;
}

export function parseEffortFromModelName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const m =
    /\((low|medium|high|xhigh|max)\)\s*$/i.exec(trimmed) ||
    /-(low|medium|high|xhigh|max)$/i.exec(trimmed);
  return m?.[1] ? sanitizeReasoningEffort(m[1]) : undefined;
}

export function normalizeAgyModelSlug(model: string, normalizeVersionDots = true): string {
  const lower = model.trim().toLowerCase();
  const effort = parseEffortFromModelName(lower);
  const label = effort ? lower.replace(/\s*\([^)]+\)$/, '-' + effort) : lower;
  const slug = label.replace(/\s+/g, '-');
  return normalizeVersionDots ? slug.replace(/(?<=\d)\.(?=\d)/g, '-') : slug;
}

function templateUsesToken(
  descriptor: Pick<ProviderDescriptor, 'args' | 'resumeArgs'> | undefined,
  tokenName: string,
): boolean {
  if (!descriptor) return false;
  const token = new RegExp('\\{\\{\\??' + tokenName + '(?::|\\}\\})');
  return (
    Boolean(descriptor.args?.some((a) => token.test(a))) ||
    Boolean(descriptor.resumeArgs?.some((a) => token.test(a)))
  );
}

export function providerSupportsReasoningEffort(
  providerId: string,
  descriptor?: Pick<
    ProviderDescriptor,
    'kind' | 'supportsReasoningEffort' | 'args' | 'resumeArgs'
  >,
): boolean {
  if (typeof descriptor?.supportsReasoningEffort === 'boolean') {
    return descriptor.supportsReasoningEffort;
  }
  const norm = providerId.trim().toLowerCase();
  if (norm === 'codex' || norm === 'claude' || norm === 'dsh' || norm === 'agy') {
    return true;
  }
  if (descriptor?.kind === 'custom') {
    return templateUsesToken(descriptor, 'reasoningEffort');
  }
  return false;
}

export function providerSupportsFastMode(
  providerId: string,
  descriptor?: Pick<ProviderDescriptor, 'kind' | 'supportsFastMode' | 'args' | 'resumeArgs'>,
): boolean {
  if (typeof descriptor?.supportsFastMode === 'boolean') {
    return descriptor.supportsFastMode;
  }
  const norm = providerId.trim().toLowerCase();
  if (norm === 'codex' || norm === 'claude') {
    return true;
  }
  if (descriptor?.kind === 'custom') {
    return templateUsesToken(descriptor, 'fastMode');
  }
  return false;
}

export function lookupModelCapability(
  descriptor?: Pick<
    ProviderDescriptor,
    'id' | 'modelCapabilities' | 'modelProvider' | 'detectedModelProvider'
  >,
  model?: string,
): ModelCapabilities | undefined {
  const trimmed = model?.trim();
  const capsMap = descriptor?.modelCapabilities;
  if (!trimmed || trimmed === 'default' || !capsMap) return undefined;
  const candidates = [trimmed];
  if (descriptor?.id === 'dsh') {
    const slashIdx = trimmed.indexOf('/');
    if (slashIdx > 0 && slashIdx < trimmed.length - 1) {
      candidates.push(trimmed.slice(slashIdx + 1).trim());
    }
    const mp = descriptor.modelProvider?.trim() || descriptor.detectedModelProvider?.trim();
    if (mp && !trimmed.startsWith(`${mp}/`)) {
      candidates.push(`${mp}/${trimmed}`);
    }
  }
  for (const key of candidates) {
    if (Object.hasOwn(capsMap, key)) return capsMap[key];
  }

  const slug = normalizeAgyModelSlug(trimmed);
  const dottedSlug = normalizeAgyModelSlug(trimmed, false);
  const fallbacks = new Set([slug, dottedSlug]);
  const effort = parseEffortFromModelName(slug);
  if (effort) {
    fallbacks.add(slug.slice(0, -effort.length - 1));
    fallbacks.add(dottedSlug.slice(0, -effort.length - 1));
  }
  for (const key of fallbacks) {
    if (Object.hasOwn(capsMap, key)) return capsMap[key];
  }
  return undefined;
}

export function getReasoningEffortOptionsForModel(
  descriptor?: ProviderDescriptor,
  model?: string,
): string[] {
  if (!descriptor) return [];
  const cap = lookupModelCapability(descriptor, model);
  if (cap?.reasoningEfforts && cap.reasoningEfforts.length > 0) {
    return [...cap.reasoningEfforts];
  }
  if (descriptor.reasoningEffortOptions && descriptor.reasoningEffortOptions.length > 0) {
    return [...descriptor.reasoningEffortOptions];
  }
  const builtIn = DEFAULT_REASONING_EFFORTS_BY_PROVIDER[descriptor.id];
  if (builtIn) return [...builtIn];
  if (providerSupportsReasoningEffort(descriptor.id, descriptor)) {
    return [...CUSTOM_DEFAULT_EFFORTS];
  }
  return [];
}

export function getEffectiveDefaultReasoningEffort(
  descriptor?: Pick<
    ProviderDescriptor,
    | 'id'
    | 'defaultModel'
    | 'configuredDefaultReasoningEffort'
    | 'detectedDefaultReasoningEffort'
    | 'modelCapabilities'
    | 'modelProvider'
    | 'detectedModelProvider'
  >,
  model?: string,
  opts?: { includeConfigured?: boolean },
): string | undefined {
  if (!descriptor) return undefined;
  const targetModel = model?.trim() || descriptor.defaultModel?.trim();
  const cap = lookupModelCapability(descriptor, targetModel);
  const valid = (eff: string | undefined): string | undefined =>
    eff && (!cap?.reasoningEfforts?.length || cap.reasoningEfforts.includes(eff)) ? eff : undefined;
  if (opts?.includeConfigured !== false) {
    const cfgEff = valid(sanitizeReasoningEffort(descriptor.configuredDefaultReasoningEffort));
    if (cfgEff) return cfgEff;
  }
  if (descriptor.id === 'agy' && targetModel && targetModel !== 'default') {
    const inferred = parseEffortFromModelName(targetModel);
    if (inferred) return inferred;
  }
  const detEff = valid(sanitizeReasoningEffort(descriptor.detectedDefaultReasoningEffort));
  if (detEff) return detEff;
  return sanitizeReasoningEffort(cap?.defaultReasoningEffort);
}

export function getEffectiveDefaultFastMode(
  descriptor?: Pick<
    ProviderDescriptor,
    | 'id'
    | 'defaultModel'
    | 'configuredDefaultFastMode'
    | 'detectedDefaultFastMode'
    | 'modelCapabilities'
    | 'modelProvider'
    | 'detectedModelProvider'
  >,
  model?: string,
  opts?: { includeConfigured?: boolean },
): boolean | undefined {
  if (!descriptor) return undefined;
  if (opts?.includeConfigured !== false && typeof descriptor.configuredDefaultFastMode === 'boolean') {
    return descriptor.configuredDefaultFastMode;
  }
  if (typeof descriptor.detectedDefaultFastMode === 'boolean') {
    return descriptor.detectedDefaultFastMode;
  }
  return lookupModelCapability(descriptor, model?.trim() || descriptor.defaultModel?.trim())
    ?.defaultFastMode;
}

export function formatModelWithOptions(
  model: string,
  reasoningEffort?: string,
  fastMode?: boolean,
): string {
  const parts: string[] = [];
  const effort = sanitizeReasoningEffort(reasoningEffort);
  if (effort && parseEffortFromModelName(model) !== effort) parts.push(effort);
  if (fastMode === true) parts.push('fast');
  else if (fastMode === false) parts.push('fast off');
  return parts.length > 0 ? `${model} (${parts.join(', ')})` : model;
}
