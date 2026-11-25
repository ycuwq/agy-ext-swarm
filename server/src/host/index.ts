import { existsSync } from 'node:fs';
import type { HostTelemetrySnapshot, SwarmState } from '../../shared/types.js';
import {
  clearBrainIndexCache,
  getBrainTopology,
  isSafeConversationId,
  listTopLevelConversations,
  resolveBrainDir,
  resolveRootConversationId,
  resolveSafeBrainSubpath,
} from './brain-index.js';
import { emptySubagentUsageSummary, readNativeSubagents } from './subagents.js';
import {
  aggregateSteps,
  clearTranscriptCache,
  emptyHostUsageBucket,
  parseTranscriptFile,
  readTranscriptTailLines,
  readTranscriptTitleHead,
} from './transcript.js';

export {
  clearBrainIndexCache,
  clearTranscriptCache,
  isSafeConversationId,
  parseTranscriptFile,
  readTranscriptTitleHead,
  resolveBrainDir,
};

export async function readHostTelemetry(
  brainDir: string | null,
  swarm: SwarmState | null,
  preferredConversationId?: string,
): Promise<HostTelemetrySnapshot> {
  const topology = getBrainTopology(brainDir);
  const availableConversations = listTopLevelConversations(brainDir, topology, 16);

  const emptySnapshot: HostTelemetrySnapshot = {
    conversationId: null,
    coordinator: emptyHostUsageBucket(),
    subagents: [],
    subagentUsage: emptySubagentUsageSummary(),
    availableConversations,
  };

  if (!brainDir || !existsSync(brainDir) || !topology) {
    return emptySnapshot;
  }

  const candidateIds = [
    swarm?.coordinatorConversationId,
    preferredConversationId,
    process.env.ANTIGRAVITY_CONVERSATION_ID,
    availableConversations[0]?.id,
  ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);

  let selectedId: string | null = null;
  let selectedPath: string | undefined;

  for (const rawId of candidateIds) {
    const safeId = rawId.trim();
    if (!isSafeConversationId(safeId)) continue;
    const rootId = resolveRootConversationId(topology, safeId);
    if (!isSafeConversationId(rootId)) continue;
    const transcriptPath = resolveSafeBrainSubpath(
      brainDir,
      rootId,
      '.system_generated',
      'logs',
      'transcript.jsonl',
    );
    if (!transcriptPath) continue;
    if (existsSync(transcriptPath) || topology.parentToDescriptors.has(rootId)) {
      selectedId = rootId;
      selectedPath = existsSync(transcriptPath) ? transcriptPath : undefined;
      break;
    }
  }

  if (!selectedId) {
    return emptySnapshot;
  }

  const parsed = selectedPath ? parseTranscriptFile(selectedPath) : null;
  const swarmStartMs = swarm?.createdAt ? Date.parse(swarm.createdAt) : Number.NaN;

  let coordinator = emptyHostUsageBucket();
  if (parsed) {
    const sessionAgg = aggregateSteps(parsed.steps);
    const sinceSteps = Number.isFinite(swarmStartMs)
      ? parsed.steps.filter((s) => s.timestampMs === 0 || s.timestampMs >= swarmStartMs)
      : [];
    const sinceAgg = aggregateSteps(sinceSteps);
    coordinator = {
      sessionTotal: sessionAgg.total,
      sinceSwarmStart: sinceAgg.total,
      byModelSession: sessionAgg.byModel,
      byModelSinceSwarm: sinceAgg.byModel,
    };
  }

  const { subagents, subagentUsage } = await readNativeSubagents({
    brainDir,
    topology,
    parentConversationId: selectedId,
    swarmCreatedAtMs: swarmStartMs,
  });

  const convEntry = availableConversations.find((c) => c.id === selectedId);
  return {
    conversationId: selectedId,
    conversationTitle: convEntry?.title || parsed?.title || selectedId.slice(0, 8),
    ...(selectedPath ? { transcriptPath: selectedPath } : {}),
    coordinator,
    subagents,
    subagentUsage,
    availableConversations,
  };
}

export function readNativeSubagentLogLines(
  brainDir: string | null,
  conversationId: string,
  tailLines = 120,
): string[] {
  if (!brainDir || !existsSync(brainDir)) return [];
  const path = resolveSafeBrainSubpath(
    brainDir,
    conversationId,
    '.system_generated',
    'logs',
    'transcript.jsonl',
  );
  if (!path) {
    throw new Error(
      `Invalid conversation ID "${conversationId}". Must match ^[a-zA-Z0-9_-]{1,128}$.`,
    );
  }
  if (!existsSync(path)) return [];
  return readTranscriptTailLines(path, tailLines, 512 * 1024);
}
