import {
  formatDshQualifiedModel,
  getDshNoAdapterHint,
  getDshUnknownModelHint,
  parseDshQualifiedModel,
} from './models.js';
import type {
  PermissionMode,
  ProviderDescriptor,
  ProvidersConfigSnapshot,
  SwarmState,
  TaskModelTarget,
  TaskRoutingCategory,
} from './types.js';

export function resolveDshModelSelection(
  requestedModel: string,
  descriptor: ProviderDescriptor | undefined,
): { modelProvider?: string; effectiveModel: string; isKnown: boolean } {
  const fallbackProv = descriptor?.modelProvider || descriptor?.detectedModelProvider || undefined;
  const knownProviders = [
    ...(descriptor?.detectedModelProviders || []),
    ...(descriptor?.modelProvider ? [descriptor.modelProvider] : []),
    ...(descriptor?.detectedModelProvider ? [descriptor.detectedModelProvider] : []),
  ];
  const parsed = parseDshQualifiedModel(requestedModel, knownProviders, fallbackProv);
  const effectiveModel = parsed.model;
  const knownModels = Array.from(
    new Set([...(descriptor?.models || []), ...(descriptor?.detectedModels || [])]),
  );
  let modelProvider = parsed.modelProvider;
  if (!parsed.qualified && effectiveModel && effectiveModel !== 'default' && knownModels.length > 0) {
    const matchingProvs = new Set<string>();
    for (const m of knownModels) {
      const slashIdx = m.indexOf('/');
      if (slashIdx > 0 && m.slice(slashIdx + 1) === effectiveModel) {
        matchingProvs.add(m.slice(0, slashIdx));
      }
    }
    if (matchingProvs.size === 1) {
      modelProvider = Array.from(matchingProvs)[0];
    }
  }
  modelProvider = modelProvider || fallbackProv;
  let isKnown = true;
  if (effectiveModel && effectiveModel !== 'default' && knownModels.length > 0) {
    const qualifiedCandidate = formatDshQualifiedModel(modelProvider, effectiveModel);
    isKnown =
      knownModels.includes(requestedModel.trim()) ||
      knownModels.includes(qualifiedCandidate) ||
      (!parsed.qualified &&
        knownModels.some((m) => m === effectiveModel || m.endsWith(`/${effectiveModel}`)));
  }
  return { modelProvider, effectiveModel, isKnown };
}

export function enrichDshFailureReason(
  reasonDetail: string,
  profile: string,
  fallbackModelProvider?: string,
): string {
  const match =
    /NO_ADAPTER:\s*no adapter registered for provider\s+["']?([a-zA-Z0-9._-]+)["']?/i.exec(
      reasonDetail,
    ) ||
    /NO_ADAPTER\b.*?\bprovider\s+["']?([a-zA-Z0-9._-]+)["']?/i.exec(reasonDetail);
  const missingProvider =
    match?.[1]?.trim() ||
    (/NO_ADAPTER/i.test(reasonDetail) ? fallbackModelProvider?.trim() : undefined);
  if (missingProvider) {
    return `${reasonDetail} | Hint: ${getDshNoAdapterHint(profile, missingProvider)}`;
  }

  const unknownModelMatch =
    /UNKNOWN_MODEL:.*?\bprovider\s+["']?([a-zA-Z0-9._-]+)["']?.*?\bmodel\s+["']?([^"'\s|]+)["']?/i.exec(
      reasonDetail,
    );
  if (unknownModelMatch?.[1] && unknownModelMatch?.[2]) {
    return `${reasonDetail} | Hint: ${getDshUnknownModelHint(
      profile,
      unknownModelMatch[1].trim(),
      unknownModelMatch[2].trim(),
    )}`;
  }

  return reasonDetail;
}

export function inferTaskCategory(
  role: string,
  permissionMode: PermissionMode,
  hasTasks: boolean,
  explicitTaskType?: TaskRoutingCategory,
): TaskRoutingCategory {
  if (explicitTaskType) return explicitTaskType;
  const lower = role.trim().toLowerCase();
  if (/\b(?:review(?:er|s)?|audit(?:or|s)?|qa|verif(?:y|ier|ication)|security)\b/.test(lower)) {
    return 'review';
  }
  if (
    /\b(?:research(?:er)?|recon|explor(?:e|er)|investigat(?:e|or|ion)|analy(?:ze|se|st|sis)|read[-_ ]?only)\b/.test(
      lower,
    )
  ) {
    return 'research';
  }
  if (/\b(?:front[-_ ]?end|frontend|ui|css|web|design(?:er)?|layout|ux)\b/.test(lower)) {
    return 'frontend';
  }
  if (
    /\b(?:tests?|tester|testing|specs?|docs?|documentation|batch|shards?|sharded|migrat(?:e|ion)|lint(?:er)?)\b/.test(
      lower,
    )
  ) {
    return 'batch';
  }
  if (/\b(?:arch(?:itect(?:ure)?)?|complex|core|refactor(?:ing)?|debug(?:ger|ging)?|hard|lead)\b/.test(lower)) {
    return 'complex';
  }
  if (
    /\b(?:writ(?:e|er)|cod(?:e|er|ing)|dev(?:eloper)?|impl(?:ement\w*)?|fix|feat(?:ure)?|build(?:er)?|backend|api)\b/.test(
      lower,
    )
  ) {
    return 'coding';
  }
  if (permissionMode === 'read-only') return 'research';
  if (hasTasks) return 'batch';
  return 'coding';
}

export function isRateLimitOrQuotaError(reason: string): boolean {
  if (!reason) return false;
  return /\b429\b|rate[-_ ]?limit|too many requests|quota|insufficient_quota|usage[-_ ]?limit|credit balance|overloaded_error|capacity/i.test(
    reason,
  );
}

export function getTaskRoutingCandidates(
  swarm: SwarmState,
  permissionMode: PermissionMode,
  category: TaskRoutingCategory,
  providerSnap?: ProvidersConfigSnapshot,
  cooldownProviderIds?: Set<string>,
): TaskModelTarget[] {
  const tr = swarm.routingPolicy?.taskRouting;
  if (!tr) return [];
  let raw: TaskModelTarget[] = [];
  const direct = tr[category];
  if (direct && direct.length > 0) {
    raw = direct;
  } else if (category === 'frontend' || category === 'complex') {
    raw = tr.coding || [];
  } else if (category === 'batch') {
    raw = permissionMode === 'read-only' ? tr.research || tr.coding || [] : tr.coding || [];
  }
  if (!providerSnap) return raw;
  const enabledOnly = raw.filter((t) => {
    const desc = providerSnap.providers.find((p) => p.id === t.provider);
    return Boolean(desc && desc.enabled);
  });
  if (cooldownProviderIds && cooldownProviderIds.size > 0) {
    const healthy = enabledOnly.filter((t) => !cooldownProviderIds.has(t.provider));
    if (healthy.length > 0) return healthy;
  }
  return enabledOnly;
}

export function pickTaskRoutingEntryForProvider(
  swarm: SwarmState,
  providerId: string,
  permissionMode: PermissionMode,
  category: TaskRoutingCategory,
): TaskModelTarget | undefined {
  const candidates = getTaskRoutingCandidates(swarm, permissionMode, category);
  return candidates.find((t) => t.provider === providerId);
}

export function pickRoutedTarget(
  swarm: SwarmState,
  permissionMode: PermissionMode,
  providerSnap: ProvidersConfigSnapshot,
  category: TaskRoutingCategory,
  cursor = swarm.rrCursor || 0,
  cooldownProviderIds?: Set<string>,
): {
  providerId: string;
  model?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  nextCursor: number;
} {
  const taskCandidates = getTaskRoutingCandidates(
    swarm,
    permissionMode,
    category,
    providerSnap,
    cooldownProviderIds,
  );
  if (taskCandidates.length > 0) {
    const chosen = taskCandidates[cursor % taskCandidates.length];
    return {
      providerId: chosen.provider,
      model: chosen.model,
      reasoningEffort: chosen.reasoningEffort,
      fastMode: chosen.fastMode,
      nextCursor: cursor + 1,
    };
  }

  const policy = swarm.routingPolicy;
  const rawPool =
    permissionMode === 'read-only' && policy?.readerProviders && policy.readerProviders.length > 0
      ? policy.readerProviders
      : permissionMode !== 'read-only' && policy?.writerProviders && policy.writerProviders.length > 0
        ? policy.writerProviders
        : swarm.activeProviders && swarm.activeProviders.length > 0
          ? swarm.activeProviders
          : [swarm.defaultProvider || 'dsh'];

  const enabledPool = rawPool.filter((id) => {
    const desc = providerSnap.providers.find((p) => p.id === id);
    return Boolean(desc && desc.enabled);
  });
  if (enabledPool.length > 0) {
    const healthyPool =
      cooldownProviderIds && cooldownProviderIds.size > 0
        ? enabledPool.filter((id) => !cooldownProviderIds.has(id))
        : enabledPool;
    const effectivePool = healthyPool.length > 0 ? healthyPool : enabledPool;
    const chosen = effectivePool[cursor % effectivePool.length];
    return { providerId: chosen, nextCursor: cursor + 1 };
  }
  const firstEnabled =
    providerSnap.providers.find(
      (p) => p.enabled && (!cooldownProviderIds || !cooldownProviderIds.has(p.id)),
    )?.id || providerSnap.providers.find((p) => p.enabled)?.id;
  return { providerId: firstEnabled || swarm.defaultProvider || 'dsh', nextCursor: cursor };
}
