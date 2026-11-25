import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  HostSubagentUsageSummary,
  NativeSubagentState,
  NativeSubagentStatus,
  TokenUsage,
} from '../../shared/types.js';
import {
  type BrainTopologySnapshot,
  type RawSubagentDescriptor,
  resolveSafeBrainSubpath,
} from './brain-index.js';
import { fetchLiveChildRunStates } from './conversation-api.js';
import {
  aggregateSteps,
  emptyBreakdown,
  type ParsedPlannerStep,
  type ParsedTranscript,
  parseTranscriptFile,
} from './transcript.js';

const SWARM_SPAWN_GRACE_MS = 60_000;
const ACTIVE_WINDOW_DEFAULT_MS = 180_000;
const ACTIVE_WINDOW_CMD_MS = 300_000;
const MESSAGE_CACHE_MAX = 128;

interface ChildMessageStats {
  messagesToParent: number;
  lastReplyAtMs: number;
  lastReplyPreview?: string;
}

interface MessageDirCacheEntry {
  dirMtimeMs: number;
  fileCount: number;
  statsBySender: Map<string, ChildMessageStats>;
}

const parentMessageCache = new Map<string, MessageDirCacheEntry>();

function normalizePreview(raw: unknown, maxLen = 240): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 3)}...` : cleaned;
}

function readMessageDirStats(messagesDir: string | null): Map<string, ChildMessageStats> {
  const empty = new Map<string, ChildMessageStats>();
  if (!messagesDir || !existsSync(messagesDir)) return empty;

  let dirSt;
  let files: string[];
  try {
    dirSt = statSync(messagesDir);
    files = readdirSync(messagesDir).filter((f) => f.endsWith('.json') && f !== 'read.json');
  } catch {
    return empty;
  }

  const cached = parentMessageCache.get(messagesDir);
  if (
    cached &&
    cached.dirMtimeMs === dirSt.mtimeMs &&
    cached.fileCount === files.length
  ) {
    return cached.statsBySender;
  }

  const statsBySender = new Map<string, ChildMessageStats>();
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(messagesDir, file), 'utf8')) as Record<string, unknown>;
      const sender = typeof raw.sender === 'string' ? raw.sender.trim() : '';
      if (!sender) continue;
      const tsMs =
        typeof raw.timestamp === 'string' && Number.isFinite(Date.parse(raw.timestamp))
          ? Date.parse(raw.timestamp)
          : 0;
      const preview = normalizePreview(raw.content, 240);

      const cur = statsBySender.get(sender) || {
        messagesToParent: 0,
        lastReplyAtMs: 0,
      };
      cur.messagesToParent += 1;
      if (tsMs >= cur.lastReplyAtMs) {
        cur.lastReplyAtMs = tsMs;
        if (preview) cur.lastReplyPreview = preview;
      } else if (!cur.lastReplyPreview && preview) {
        cur.lastReplyPreview = preview;
      }
      statsBySender.set(sender, cur);
    } catch {
      // Ignore unreadable message JSON
    }
  }

  if (parentMessageCache.has(messagesDir)) {
    parentMessageCache.delete(messagesDir);
  } else if (parentMessageCache.size >= MESSAGE_CACHE_MAX) {
    const oldest = parentMessageCache.keys().next().value;
    if (oldest) parentMessageCache.delete(oldest);
  }
  parentMessageCache.set(messagesDir, {
    dirMtimeMs: dirSt.mtimeMs,
    fileCount: files.length,
    statsBySender,
  });

  return statsBySender;
}

function inferStatusFromTranscript(
  desc: RawSubagentDescriptor,
  parsed: ParsedTranscript | null,
  msgStats: ChildMessageStats | undefined,
  liveApiStates: Map<string, 'working' | 'waiting'> | null,
  nowMs: number,
): { status: NativeSubagentStatus; statusSource: 'api' | 'transcript' } {
  if (desc.state && desc.state !== 'SUBAGENT_STATE_ALIVE') {
    return { status: 'killed', statusSource: 'transcript' };
  }

  const apiState = liveApiStates?.get(desc.conversationId);
  if (apiState) {
    return { status: apiState, statusSource: 'api' };
  }

  if (!parsed) {
    const isFresh = nowMs - desc.descriptorMtimeMs <= ACTIVE_WINDOW_DEFAULT_MS;
    return { status: isFresh ? 'working' : 'waiting', statusSource: 'transcript' };
  }

  const ev = parsed.lastEvent;
  if (!ev) {
    const isFresh = nowMs - parsed.fileMtimeMs <= ACTIVE_WINDOW_DEFAULT_MS;
    return { status: isFresh ? 'working' : 'waiting', statusSource: 'transcript' };
  }

  if (ev.type === 'ERROR_MESSAGE') {
    return { status: 'failed', statusSource: 'transcript' };
  }

  if (ev.type === 'PLANNER_RESPONSE' && ev.status === 'DONE' && !ev.hasToolCalls) {
    return { status: 'waiting', statusSource: 'transcript' };
  }

  if (
    ev.type === 'PLANNER_RESPONSE' &&
    ev.hasSendMessage &&
    msgStats &&
    msgStats.lastReplyAtMs >= ev.createdAtMs - 2000 &&
    nowMs - parsed.fileMtimeMs > 5000
  ) {
    return { status: 'waiting', statusSource: 'transcript' };
  }

  const activeWindowMs =
    parsed.lastToolName === 'run_command' ? ACTIVE_WINDOW_CMD_MS : ACTIVE_WINDOW_DEFAULT_MS;
  const isFresh = nowMs - parsed.fileMtimeMs <= activeWindowMs;
  return { status: isFresh ? 'working' : 'waiting', statusSource: 'transcript' };
}

function toTokenUsage(steps: ParsedPlannerStep[]): TokenUsage {
  const { total } = aggregateSteps(steps);
  return {
    inputTokens: total.inputTokens,
    cacheReadTokens: total.cacheReadTokens,
    outputTokens: total.outputTokens,
    totalTokens: total.totalTokens,
  };
}

export function emptySubagentUsageSummary(): HostSubagentUsageSummary {
  return {
    totalCount: 0,
    currentSwarmCount: 0,
    runningCount: 0,
    sessionTotal: emptyBreakdown(),
    sinceSwarmStart: emptyBreakdown(),
    byModelSession: {},
    byModelSinceSwarm: {},
  };
}

export async function readNativeSubagents(opts: {
  brainDir: string;
  topology: BrainTopologySnapshot;
  parentConversationId: string;
  swarmCreatedAtMs: number;
}): Promise<{
  subagents: NativeSubagentState[];
  subagentUsage: HostSubagentUsageSummary;
}> {
  const { brainDir, topology, parentConversationId, swarmCreatedAtMs } = opts;
  const descriptors = topology.parentToDescriptors.get(parentConversationId) || [];
  if (descriptors.length === 0) {
    return {
      subagents: [],
      subagentUsage: emptySubagentUsageSummary(),
    };
  }

  const nowMs = Date.now();
  const liveApiStates = await fetchLiveChildRunStates(parentConversationId);
  const parentMsgsDir = resolveSafeBrainSubpath(
    brainDir,
    parentConversationId,
    '.system_generated',
    'messages',
  );
  const parentMsgStats = readMessageDirStats(parentMsgsDir);

  let latestSpawnStep = 0;
  for (const d of descriptors) {
    if (d.spawnStepIndex > latestSpawnStep) latestSpawnStep = d.spawnStepIndex;
  }

  const hasSwarmWindow = Number.isFinite(swarmCreatedAtMs);
  const allSessionSteps: ParsedPlannerStep[] = [];
  const allSinceSteps: ParsedPlannerStep[] = [];
  const subagents: NativeSubagentState[] = [];

  for (const desc of descriptors) {
    const childId = desc.conversationId;
    const childTranscriptPath = resolveSafeBrainSubpath(
      brainDir,
      childId,
      '.system_generated',
      'logs',
      'transcript.jsonl',
    );
    const parsed = childTranscriptPath ? parseTranscriptFile(childTranscriptPath) : null;
    const msgStats = parentMsgStats.get(childId);

    const childMsgsDir = resolveSafeBrainSubpath(brainDir, childId, '.system_generated', 'messages');
    const childMsgStats = readMessageDirStats(childMsgsDir);
    const fromParentCount = childMsgStats.get(parentConversationId)?.messagesToParent ?? 0;

    const { status, statusSource } = inferStatusFromTranscript(
      desc,
      parsed,
      msgStats,
      liveApiStates,
      nowMs,
    );

    const createdMs = parsed?.firstTimestampMs || desc.descriptorMtimeMs;
    const updatedMs = parsed?.lastTimestampMs || parsed?.fileMtimeMs || desc.descriptorMtimeMs;

    const inCurrentSwarm = hasSwarmWindow
      ? status === 'working' ||
        createdMs >= swarmCreatedAtMs - SWARM_SPAWN_GRACE_MS ||
        updatedMs >= swarmCreatedAtMs
      : status === 'working' || (latestSpawnStep > 0 && desc.spawnStepIndex === latestSpawnStep);

    const childSteps = parsed?.steps || [];
    allSessionSteps.push(...childSteps);

    const sinceSteps = inCurrentSwarm
      ? hasSwarmWindow
        ? childSteps.filter(
            (s) => s.timestampMs === 0 || s.timestampMs >= swarmCreatedAtMs - SWARM_SPAWN_GRACE_MS,
          )
        : childSteps
      : [];
    allSinceSteps.push(...sinceSteps);

    const activity =
      status === 'working'
        ? parsed?.lastToolName
          ? `Running ${parsed.lastToolName}`
          : 'Thinking…'
        : undefined;

    const lastFromParentMs = childMsgStats.get(parentConversationId)?.lastReplyAtMs || 0;
    const latestTurnStartMs = Math.max(parsed?.lastTurnStartedMs || 0, lastFromParentMs);
    const lastTurnStartedAt =
      latestTurnStartMs > 0
        ? new Date(latestTurnStartMs).toISOString()
        : new Date(createdMs).toISOString();
    const lastTurnFinishedAt =
      status !== 'working' && parsed?.lastTurnFinishedMs && parsed.lastTurnFinishedMs > 0
        ? new Date(parsed.lastTurnFinishedMs).toISOString()
        : status !== 'working' && updatedMs > 0
          ? new Date(updatedMs).toISOString()
          : undefined;

    const primaryModel = parsed?.latestModel || parsed?.models[0] || 'host-default';
    const effectiveTurns =
      parsed?.turns || fromParentCount || parsed?.systemTurns || (parsed?.plannerSteps ? 1 : 0);

    subagents.push({
      id: childId,
      shortId: childId.slice(0, 8),
      parentConversationId,
      role: desc.role,
      typeName: desc.typeName,
      status,
      statusSource,
      ...(desc.state ? { rawState: desc.state } : {}),
      model: primaryModel,
      models: parsed?.models || [],
      spawnStepIndex: desc.spawnStepIndex,
      inCurrentSwarm,
      turns: effectiveTurns,
      steps: parsed?.plannerSteps || 0,
      usage: toTokenUsage(childSteps),
      usageSinceSwarm: toTokenUsage(sinceSteps),
      ...(activity ? { activity } : {}),
      ...(parsed?.lastToolName ? { lastTool: parsed.lastToolName } : {}),
      ...(status === 'failed' && parsed?.lastError ? { lastError: parsed.lastError } : {}),
      ...(msgStats?.lastReplyPreview
        ? { lastReplyPreview: msgStats.lastReplyPreview }
        : parsed?.lastAssistantText
          ? { lastReplyPreview: parsed.lastAssistantText }
          : {}),
      messagesToParent: msgStats?.messagesToParent || 0,
      messagesFromParent: fromParentCount || parsed?.turns || 0,
      ...(desc.workspaceUris ? { workspaceUris: desc.workspaceUris } : {}),
      createdAt: new Date(createdMs).toISOString(),
      updatedAt: new Date(updatedMs).toISOString(),
      lastTurnStartedAt,
      ...(lastTurnFinishedAt ? { lastTurnFinishedAt } : {}),
    });
  }

  subagents.sort((a, b) => {
    if (a.inCurrentSwarm !== b.inCurrentSwarm) return a.inCurrentSwarm ? -1 : 1;
    const aRun = a.status === 'working' ? 1 : 0;
    const bRun = b.status === 'working' ? 1 : 0;
    if (aRun !== bRun) return bRun - aRun;
    if (a.spawnStepIndex !== b.spawnStepIndex) return b.spawnStepIndex - a.spawnStepIndex;
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });

  const sessionAgg = aggregateSteps(allSessionSteps);
  const sinceAgg = aggregateSteps(allSinceSteps);

  return {
    subagents,
    subagentUsage: {
      totalCount: subagents.length,
      currentSwarmCount: subagents.filter((s) => s.inCurrentSwarm).length,
      runningCount: subagents.filter((s) => s.status === 'working').length,
      sessionTotal: sessionAgg.total,
      sinceSwarmStart: sinceAgg.total,
      byModelSession: sessionAgg.byModel,
      byModelSinceSwarm: sinceAgg.byModel,
    },
  };
}
