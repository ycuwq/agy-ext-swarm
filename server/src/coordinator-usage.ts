import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type {
  CoordinatorConversationEntry,
  CoordinatorUsageSummary,
  SwarmState,
  UsageBreakdown,
} from './types.js';

const SAFE_CONVERSATION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_TRANSCRIPT_CACHE_SIZE = 32;
const CONVERSATIONS_TTL_MS = 10_000;

export function isSafeConversationId(id: string): boolean {
  return SAFE_CONVERSATION_ID_RE.test(id.trim());
}

interface ParsedPlannerStep {
  model: string;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  timestampMs: number;
}

interface TranscriptCacheEntry {
  mtimeMs: number;
  size: number;
  title: string;
  steps: ParsedPlannerStep[];
}

const transcriptCache = new Map<string, TranscriptCacheEntry>();
let conversationsCache: {
  key: string;
  expiresAt: number;
  entries: CoordinatorConversationEntry[];
} | null = null;

function emptyBreakdown(): UsageBreakdown {
  return {
    inputTokens: 0,
    cacheReadTokens: 0,
    promptTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheHitRate: 0,
    calls: 0,
  };
}

function finalizeBreakdown(acc: UsageBreakdown): UsageBreakdown {
  const promptTokens = acc.inputTokens + acc.cacheReadTokens;
  const totalTokens = promptTokens + acc.outputTokens;
  const cacheHitRate =
    promptTokens > 0 ? Math.round((acc.cacheReadTokens / promptTokens) * 1000) / 10 : 0;
  return {
    inputTokens: acc.inputTokens,
    cacheReadTokens: acc.cacheReadTokens,
    promptTokens,
    outputTokens: acc.outputTokens,
    totalTokens,
    cacheHitRate,
    calls: acc.calls,
  };
}

function addStepToBreakdown(acc: UsageBreakdown, step: ParsedPlannerStep): void {
  acc.inputTokens += step.inputTokens;
  acc.cacheReadTokens += step.cacheReadTokens;
  acc.outputTokens += step.outputTokens;
  acc.calls += 1;
}

function extractTitleFromUserContent(content: unknown): string {
  if (typeof content !== 'string') return '';
  let text = content.trim();
  const reqMatch = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(text);
  if (reqMatch) {
    text = reqMatch[1].trim();
  }
  const singleLine = text.replace(/\s+/g, ' ').trim();
  if (!singleLine) return '';
  return singleLine.length > 42 ? `${singleLine.slice(0, 40)}...` : singleLine;
}

function parseTranscriptFile(transcriptPath: string): TranscriptCacheEntry | null {
  if (!existsSync(transcriptPath)) return null;
  let st;
  try {
    st = statSync(transcriptPath);
  } catch {
    return null;
  }

  const cached = transcriptCache.get(transcriptPath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached;
  }

  let raw = '';
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }

  let title = '';
  const steps: ParsedPlannerStep[] = [];
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (!title && obj.type === 'USER_INPUT' && obj.source === 'USER_EXPLICIT') {
      title = extractTitleFromUserContent(obj.content);
    }

    if (obj.type === 'PLANNER_RESPONSE') {
      const rawIn = Number(obj.input_tokens || 0);
      const rawCache = Number(obj.cache_read_tokens || 0);
      const rawOut = Number(obj.output_tokens || 0);
      const inputTokens = Number.isFinite(rawIn) && rawIn > 0 ? rawIn : 0;
      const cacheReadTokens = Number.isFinite(rawCache) && rawCache > 0 ? rawCache : 0;
      const outputTokens = Number.isFinite(rawOut) && rawOut > 0 ? rawOut : 0;
      if (inputTokens > 0 || cacheReadTokens > 0 || outputTokens > 0) {
        const model =
          typeof obj.model === 'string' && obj.model.trim() ? obj.model.trim() : 'unknown';
        const ts =
          typeof obj.created_at === 'string' ? Date.parse(obj.created_at) : Number.NaN;
        steps.push({
          model,
          inputTokens,
          cacheReadTokens,
          outputTokens,
          timestampMs: Number.isFinite(ts) ? ts : 0,
        });
      }
    }
  }

  const entry: TranscriptCacheEntry = {
    mtimeMs: st.mtimeMs,
    size: st.size,
    title,
    steps,
  };
  if (transcriptCache.has(transcriptPath)) {
    transcriptCache.delete(transcriptPath);
  } else if (transcriptCache.size >= MAX_TRANSCRIPT_CACHE_SIZE) {
    const oldestKey = transcriptCache.keys().next().value;
    if (oldestKey) transcriptCache.delete(oldestKey);
  }
  transcriptCache.set(transcriptPath, entry);
  return entry;
}

export function resolveBrainDir(dataDir: string): string | null {
  const candidates: string[] = [];
  if (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    candidates.push(join(process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR, 'brain'));
  }
  // AGY mounts plugin data at <appData>/plugin_data/<plugin-name>
  candidates.push(resolve(dataDir, '..', '..', 'brain'));
  candidates.push(join(homedir(), '.gemini', 'antigravity', 'brain'));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function listRecentConversations(
  brainDir: string | null,
  limit = 12,
): CoordinatorConversationEntry[] {
  if (!brainDir || !existsSync(brainDir)) return [];
  const cacheKey = `${brainDir}:${limit}`;
  const now = Date.now();
  if (conversationsCache && conversationsCache.key === cacheKey && now < conversationsCache.expiresAt) {
    return conversationsCache.entries;
  }

  let dirs: string[];
  try {
    dirs = readdirSync(brainDir);
  } catch {
    return [];
  }

  const found: Array<{ id: string; mtimeMs: number; transcriptPath: string }> = [];
  for (const id of dirs) {
    if (id.startsWith('.') || !isSafeConversationId(id)) continue;
    const transcriptPath = join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl');
    if (!existsSync(transcriptPath)) continue;
    try {
      const st = statSync(transcriptPath);
      found.push({ id, mtimeMs: st.mtimeMs, transcriptPath });
    } catch {
      // Ignore unreadable file
    }
  }

  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const entries = found.slice(0, limit).map((item) => {
    const parsed = parseTranscriptFile(item.transcriptPath);
    const shortId = item.id.slice(0, 8);
    return {
      id: item.id,
      title: parsed?.title ? `${parsed.title} (${shortId})` : shortId,
      updatedAt: new Date(item.mtimeMs).toISOString(),
    };
  });

  conversationsCache = {
    key: cacheKey,
    expiresAt: now + CONVERSATIONS_TTL_MS,
    entries,
  };
  return entries;
}

function aggregateSteps(steps: ParsedPlannerStep[]): {
  total: UsageBreakdown;
  byModel: Record<string, UsageBreakdown>;
} {
  const totalAcc = emptyBreakdown();
  const modelAccs = new Map<string, UsageBreakdown>();

  for (const step of steps) {
    addStepToBreakdown(totalAcc, step);
    let mAcc = modelAccs.get(step.model);
    if (!mAcc) {
      mAcc = emptyBreakdown();
      modelAccs.set(step.model, mAcc);
    }
    addStepToBreakdown(mAcc, step);
  }

  const byModel: Record<string, UsageBreakdown> = {};
  for (const [model, acc] of modelAccs.entries()) {
    byModel[model] = finalizeBreakdown(acc);
  }
  return {
    total: finalizeBreakdown(totalAcc),
    byModel,
  };
}

export function readCoordinatorUsage(
  brainDir: string | null,
  swarm: SwarmState | null,
): {
  usage: CoordinatorUsageSummary;
  conversations: CoordinatorConversationEntry[];
} {
  const conversations = listRecentConversations(brainDir, 12);

  const emptySummary: CoordinatorUsageSummary = {
    conversationId: null,
    sessionTotal: emptyBreakdown(),
    sinceSwarmStart: emptyBreakdown(),
    byModelSession: {},
    byModelSinceSwarm: {},
  };

  if (!brainDir || !existsSync(brainDir)) {
    return { usage: emptySummary, conversations };
  }

  const candidateIds = [
    swarm?.coordinatorConversationId,
    process.env.ANTIGRAVITY_CONVERSATION_ID,
    conversations[0]?.id,
  ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);

  const resolvedBrainRoot = resolve(brainDir);
  const brainPrefix = resolvedBrainRoot.endsWith(sep)
    ? resolvedBrainRoot
    : `${resolvedBrainRoot}${sep}`;

  let selectedId: string | null = null;
  let selectedPath: string | undefined;
  for (const rawId of candidateIds) {
    const id = rawId.trim();
    if (!isSafeConversationId(id)) continue;
    const p = resolve(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl');
    if (!p.startsWith(brainPrefix)) continue;
    if (existsSync(p)) {
      selectedId = id;
      selectedPath = p;
      break;
    }
  }

  if (!selectedId || !selectedPath) {
    return { usage: emptySummary, conversations };
  }

  const parsed = parseTranscriptFile(selectedPath);
  if (!parsed) {
    return { usage: emptySummary, conversations };
  }

  const sessionAgg = aggregateSteps(parsed.steps);
  const swarmStartMs = swarm?.createdAt ? Date.parse(swarm.createdAt) : Number.NaN;
  const sinceSteps = Number.isFinite(swarmStartMs)
    ? parsed.steps.filter((s) => s.timestampMs === 0 || s.timestampMs >= swarmStartMs)
    : [];
  const sinceAgg = aggregateSteps(sinceSteps);

  const convEntry = conversations.find((c) => c.id === selectedId);
  return {
    usage: {
      conversationId: selectedId,
      conversationTitle: convEntry?.title || parsed.title || selectedId.slice(0, 8),
      transcriptPath: selectedPath,
      sessionTotal: sessionAgg.total,
      sinceSwarmStart: sinceAgg.total,
      byModelSession: sessionAgg.byModel,
      byModelSinceSwarm: sinceAgg.byModel,
    },
    conversations,
  };
}
