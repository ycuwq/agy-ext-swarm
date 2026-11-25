import { calcInputCacheHit } from './format.js';
import { aggregateDshUsage } from './helpers.js';
import type { NativeScopeFilter } from './store.js';
import type {
  MemberState,
  NativeSubagentState,
  Snapshot,
  UsageBreakdown,
} from './types.js';

export interface TelemetrySummary {
  externalMembers: MemberState[];
  externalCount: number;
  externalRunning: number;
  externalWaiting: number;
  externalFailed: number;
  nativeAll: NativeSubagentState[];
  nativeCurrent: NativeSubagentState[];
  nativeRunning: number;
  nativeWaiting: number;
  nativeFailed: number;
  totalRunning: number;
  totalWaiting: number;
  totalFailed: number;
  totalWorkers: number;
  coordinator: UsageBreakdown;
  coordinatorByModel: Record<string, UsageBreakdown>;
  native: UsageBreakdown;
  nativeByModel: Record<string, UsageBreakdown>;
  external: UsageBreakdown;
  combinedTotalTokens: number;
  combinedCacheHitRate: number;
}

const EMPTY_BREAKDOWN: UsageBreakdown = {
  inputTokens: 0,
  cacheReadTokens: 0,
  promptTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheHitRate: 0,
  calls: 0,
};

export function selectNativeSubagents(
  snap: Snapshot | null,
  scope: NativeScopeFilter,
): NativeSubagentState[] {
  const all = snap?.hostTelemetry?.subagents || [];
  if (scope === 'all') return all;
  return all.filter((s) => s.inCurrentSwarm);
}

export function formatWorkersTabBadge(
  externalCount: number,
  nativeCurrentCount: number,
): string {
  if (externalCount > 0 && nativeCurrentCount > 0) {
    return `${externalCount}+${nativeCurrentCount}`;
  }
  return String(externalCount + nativeCurrentCount);
}

export function computeTelemetrySummary(
  snap: Snapshot | null,
  usageScope: 'swarm' | 'session',
): TelemetrySummary {
  const swarm = snap?.swarm ?? null;
  const externalMembers = swarm ? Object.values(swarm.members || {}) : [];
  const externalCount = externalMembers.length;
  const externalRunning = externalMembers.filter(
    (m) => m.status === 'working' || m.status === 'queued',
  ).length;
  const externalWaiting = externalMembers.filter((m) => m.status === 'waiting').length;
  const externalFailed = externalMembers.filter((m) => m.status === 'failed').length;

  const ht = snap?.hostTelemetry;
  const nativeAll = ht?.subagents || [];
  const nativeCurrent = nativeAll.filter((s) => s.inCurrentSwarm);
  const nativeRunning = nativeAll.filter((s) => s.status === 'working').length;
  const nativeWaiting = nativeCurrent.filter((s) => s.status === 'waiting').length;
  const nativeFailed = nativeCurrent.filter((s) => s.status === 'failed').length;

  const effectiveScope: 'swarm' | 'session' = swarm ? usageScope : 'session';
  const coordinator =
    (effectiveScope === 'swarm'
      ? ht?.coordinator.sinceSwarmStart
      : ht?.coordinator.sessionTotal) || EMPTY_BREAKDOWN;
  const coordinatorByModel =
    (effectiveScope === 'swarm'
      ? ht?.coordinator.byModelSinceSwarm
      : ht?.coordinator.byModelSession) || {};

  const native =
    (effectiveScope === 'swarm'
      ? ht?.subagentUsage.sinceSwarmStart
      : ht?.subagentUsage.sessionTotal) || EMPTY_BREAKDOWN;
  const nativeByModel =
    (effectiveScope === 'swarm'
      ? ht?.subagentUsage.byModelSinceSwarm
      : ht?.subagentUsage.byModelSession) || {};

  const external = aggregateDshUsage(externalMembers);

  const combinedPrompt =
    external.promptTokens + native.promptTokens + coordinator.promptTokens;
  const combinedCache =
    external.cacheReadTokens + native.cacheReadTokens + coordinator.cacheReadTokens;
  const combinedInput = Math.max(0, combinedPrompt - combinedCache);
  const combinedTotalTokens =
    external.totalTokens + native.totalTokens + coordinator.totalTokens;

  return {
    externalMembers,
    externalCount,
    externalRunning,
    externalWaiting,
    externalFailed,
    nativeAll,
    nativeCurrent,
    nativeRunning,
    nativeWaiting,
    nativeFailed,
    totalRunning: externalRunning + nativeRunning,
    totalWaiting: externalWaiting + nativeWaiting,
    totalFailed: externalFailed + nativeFailed,
    totalWorkers: externalCount + nativeCurrent.length,
    coordinator,
    coordinatorByModel,
    native,
    nativeByModel,
    external,
    combinedTotalTokens,
    combinedCacheHitRate: calcInputCacheHit(combinedInput, combinedCache),
  };
}
