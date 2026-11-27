import type { ProviderDescriptor } from './types.js';

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

function templateUsesToken(
  descriptor: Pick<ProviderDescriptor, 'args' | 'resumeArgs'> | undefined,
  token: string,
): boolean {
  if (!descriptor) return false;
  return (
    Boolean(descriptor.args?.some((a) => a.includes(token))) ||
    Boolean(descriptor.resumeArgs?.some((a) => a.includes(token)))
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
    return templateUsesToken(descriptor, '{{reasoningEffort}}');
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
    return templateUsesToken(descriptor, '{{fastMode}}');
  }
  return false;
}

export function getReasoningEffortOptionsForModel(
  descriptor?: ProviderDescriptor,
  model?: string,
): string[] {
  if (!descriptor) return [];
  const trimmed = model?.trim();
  const capsMap = descriptor.modelCapabilities;
  if (trimmed && trimmed !== 'default' && capsMap) {
    const candidates = [trimmed];
    if (descriptor.id === 'dsh') {
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
      const efforts = capsMap[key]?.reasoningEfforts;
      if (efforts && efforts.length > 0) {
        return [...efforts];
      }
    }
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

export function formatModelWithOptions(
  model: string,
  reasoningEffort?: string,
  fastMode?: boolean,
): string {
  const parts: string[] = [];
  const effort = sanitizeReasoningEffort(reasoningEffort);
  if (effort) parts.push(effort);
  if (fastMode === true) parts.push('fast');
  else if (fastMode === false) parts.push('fast off');
  return parts.length > 0 ? `${model} (${parts.join(', ')})` : model;
}
