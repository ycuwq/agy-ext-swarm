import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import type { HostUsageBucket, UsageBreakdown } from '../../shared/types.js';
import { readTailLines } from '../tail-file.js';

const MAX_TRANSCRIPT_CACHE_SIZE = 256;
const MAX_TITLE_CACHE_SIZE = 256;

export interface ParsedPlannerStep {
  model: string;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  timestampMs: number;
}

export interface LastTranscriptEvent {
  type: string;
  status?: string;
  source?: string;
  createdAtMs: number;
  hasToolCalls: boolean;
  toolNames: string[];
  hasSendMessage: boolean;
  errorText?: string;
}

export interface ParsedTranscript {
  title: string;
  turns: number;
  systemTurns: number;
  plannerSteps: number;
  models: string[];
  latestModel: string;
  steps: ParsedPlannerStep[];
  firstTimestampMs: number;
  lastTimestampMs: number;
  fileMtimeMs: number;
  lastTurnStartedMs: number;
  lastTurnFinishedMs: number;
  lastToolName?: string;
  lastAssistantText?: string;
  lastError?: string;
  lastEvent?: LastTranscriptEvent;
}

interface TranscriptCacheEntry {
  ino: number;
  mtimeMs: number;
  size: number;
  lastByteOffset: number;
  data: ParsedTranscript;
}

interface TitleCacheEntry {
  ino: number;
  mtimeMs: number;
  size: number;
  title: string;
}

const transcriptCache = new Map<string, TranscriptCacheEntry>();
const titleCache = new Map<string, TitleCacheEntry>();

export function clearTranscriptCache(): void {
  transcriptCache.clear();
  titleCache.clear();
}

export function emptyBreakdown(): UsageBreakdown {
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

export function finalizeBreakdown(acc: UsageBreakdown): UsageBreakdown {
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

export function aggregateSteps(steps: ParsedPlannerStep[]): {
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

export function emptyHostUsageBucket(): HostUsageBucket {
  return {
    sessionTotal: emptyBreakdown(),
    sinceSwarmStart: emptyBreakdown(),
    byModelSession: {},
    byModelSinceSwarm: {},
  };
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

function extractSnippet(value: unknown, maxLen = 260): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen - 3)}...` : normalized;
}

function parseTimestampMs(raw: unknown): number {
  if (typeof raw !== 'string' || !raw) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

function extractToolNames(toolCalls: unknown): string[] {
  if (!Array.isArray(toolCalls)) return [];
  const names: string[] = [];
  for (const tc of toolCalls) {
    if (!tc || typeof tc !== 'object') continue;
    const rec = tc as Record<string, unknown>;
    const fn = rec.function && typeof rec.function === 'object'
      ? (rec.function as Record<string, unknown>).name
      : undefined;
    const name = rec.name ?? rec.tool_name ?? fn;
    if (typeof name === 'string' && name.trim()) {
      names.push(name.trim());
    }
  }
  return names;
}

function createEmptyParsedTranscript(fileMtimeMs: number): ParsedTranscript {
  return {
    title: '',
    turns: 0,
    systemTurns: 0,
    plannerSteps: 0,
    models: [],
    latestModel: '',
    steps: [],
    firstTimestampMs: 0,
    lastTimestampMs: 0,
    fileMtimeMs,
    lastTurnStartedMs: 0,
    lastTurnFinishedMs: 0,
  };
}

function applyTranscriptLines(data: ParsedTranscript, chunkText: string, fileMtimeMs: number): void {
  data.fileMtimeMs = fileMtimeMs;
  for (const rawLine of chunkText.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = typeof obj.type === 'string' ? obj.type : '';
    const status = typeof obj.status === 'string' ? obj.status : undefined;
    const source = typeof obj.source === 'string' ? obj.source : undefined;
    const tsMs = parseTimestampMs(obj.created_at);
    if (tsMs > 0) {
      if (data.firstTimestampMs === 0 || tsMs < data.firstTimestampMs) {
        data.firstTimestampMs = tsMs;
      }
      if (tsMs > data.lastTimestampMs) {
        data.lastTimestampMs = tsMs;
      }
    }

    if (type === 'USER_INPUT') {
      data.turns += 1;
      if (!data.title && source === 'USER_EXPLICIT') {
        data.title = extractTitleFromUserContent(obj.content);
      }
      const turnStart = tsMs > 0 ? tsMs : fileMtimeMs;
      if (turnStart > data.lastTurnStartedMs) {
        data.lastTurnStartedMs = turnStart;
      }
      data.lastEvent = {
        type,
        status,
        source,
        createdAtMs: tsMs,
        hasToolCalls: false,
        toolNames: [],
        hasSendMessage: false,
      };
      continue;
    }

    if (type === 'SYSTEM_MESSAGE') {
      data.systemTurns += 1;
      const turnStart = tsMs > 0 ? tsMs : fileMtimeMs;
      if (turnStart > data.lastTurnStartedMs) {
        data.lastTurnStartedMs = turnStart;
      }
      data.lastEvent = {
        type,
        status,
        source,
        createdAtMs: tsMs,
        hasToolCalls: false,
        toolNames: [],
        hasSendMessage: false,
      };
      continue;
    }

    if (type === 'PLANNER_RESPONSE') {
      data.plannerSteps += 1;
      const model =
        typeof obj.model === 'string' && obj.model.trim() ? obj.model.trim() : 'unknown';
      if (model !== 'unknown') {
        data.latestModel = model;
        if (!data.models.includes(model)) {
          data.models.push(model);
        }
      }

      const rawIn = Number(obj.input_tokens || 0);
      const rawCache = Number(obj.cache_read_tokens || 0);
      const rawOut = Number(obj.output_tokens || 0);
      const inputTokens = Number.isFinite(rawIn) && rawIn > 0 ? rawIn : 0;
      const cacheReadTokens = Number.isFinite(rawCache) && rawCache > 0 ? rawCache : 0;
      const outputTokens = Number.isFinite(rawOut) && rawOut > 0 ? rawOut : 0;
      if (inputTokens > 0 || cacheReadTokens > 0 || outputTokens > 0) {
        data.steps.push({
          model,
          inputTokens,
          cacheReadTokens,
          outputTokens,
          timestampMs: tsMs,
        });
      }

      const toolNames = extractToolNames(obj.tool_calls);
      const hasToolCalls = toolNames.length > 0;
      const hasSendMessage = toolNames.includes('send_message');
      if (hasToolCalls) {
        data.lastToolName = toolNames[toolNames.length - 1];
      }

      const snippet = extractSnippet(obj.content, 260);
      if (snippet) {
        data.lastAssistantText = snippet;
      }
      if (!hasToolCalls && status === 'DONE' && tsMs > data.lastTurnFinishedMs) {
        data.lastTurnFinishedMs = tsMs;
      }

      data.lastEvent = {
        type,
        status,
        source,
        createdAtMs: tsMs,
        hasToolCalls,
        toolNames,
        hasSendMessage,
      };
      continue;
    }

    if (type === 'GENERIC') {
      data.lastEvent = {
        type,
        status,
        source,
        createdAtMs: tsMs,
        hasToolCalls: false,
        toolNames: [],
        hasSendMessage: false,
      };
      continue;
    }

    if (type === 'ERROR_MESSAGE') {
      const errorText =
        extractSnippet(obj.content, 240) ||
        extractSnippet(obj.error, 240) ||
        extractSnippet(obj.message, 240) ||
        'Subagent execution error';
      data.lastError = errorText;
      data.lastEvent = {
        type,
        status,
        source,
        createdAtMs: tsMs,
        hasToolCalls: false,
        toolNames: [],
        hasSendMessage: false,
        errorText,
      };
      continue;
    }

    if (type) {
      data.lastEvent = {
        type,
        status,
        source,
        createdAtMs: tsMs,
        hasToolCalls: false,
        toolNames: [],
        hasSendMessage: false,
      };
    }
  }
}

function readCompleteRange(
  transcriptPath: string,
  startOffset: number,
  endSize: number,
): { text: string; nextOffset: number } | null {
  if (endSize <= startOffset) {
    return { text: '', nextOffset: startOffset };
  }
  const len = endSize - startOffset;
  const fd = openSync(transcriptPath, 'r');
  try {
    const buf = Buffer.allocUnsafe(len);
    let totalRead = 0;
    while (totalRead < len) {
      const n = readSync(fd, buf, totalRead, len - totalRead, startOffset + totalRead);
      if (n <= 0) break;
      totalRead += n;
    }
    if (totalRead === 0) {
      return { text: '', nextOffset: startOffset };
    }
    const slice = buf.subarray(0, totalRead);
    const lastNlIdx = slice.lastIndexOf(0x0a);
    if (lastNlIdx < 0) {
      // No complete newline yet; hold offset until newline is flushed
      return { text: '', nextOffset: startOffset };
    }
    const completeBytes = slice.subarray(0, lastNlIdx + 1);
    return {
      text: completeBytes.toString('utf8'),
      nextOffset: startOffset + lastNlIdx + 1,
    };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function touchCache(key: string, entry: TranscriptCacheEntry): void {
  if (transcriptCache.has(key)) {
    transcriptCache.delete(key);
  } else if (transcriptCache.size >= MAX_TRANSCRIPT_CACHE_SIZE) {
    const oldestKey = transcriptCache.keys().next().value;
    if (oldestKey) transcriptCache.delete(oldestKey);
  }
  transcriptCache.set(key, entry);
}

/**
 * Incrementally parse a transcript JSONL file using inode + byte-offset caching.
 */
export function parseTranscriptFile(transcriptPath: string): ParsedTranscript | null {
  if (!existsSync(transcriptPath)) return null;
  let st;
  try {
    st = statSync(transcriptPath);
  } catch {
    return null;
  }

  const cached = transcriptCache.get(transcriptPath);
  if (cached && cached.ino === st.ino && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    touchCache(transcriptPath, cached);
    return cached.data;
  }

  // Fast incremental append when file grew with same inode
  if (cached && cached.ino === st.ino && st.size >= cached.lastByteOffset) {
    const delta = readCompleteRange(transcriptPath, cached.lastByteOffset, st.size);
    if (delta) {
      if (delta.text) {
        applyTranscriptLines(cached.data, delta.text, st.mtimeMs);
      } else {
        cached.data.fileMtimeMs = st.mtimeMs;
      }
      const updated: TranscriptCacheEntry = {
        ino: st.ino,
        mtimeMs: st.mtimeMs,
        size: st.size,
        lastByteOffset: delta.nextOffset,
        data: cached.data,
      };
      touchCache(transcriptPath, updated);
      return updated.data;
    }
  }

  // Full parse from byte 0 (new file, truncated, or replaced inode)
  const fresh = createEmptyParsedTranscript(st.mtimeMs);
  const full = readCompleteRange(transcriptPath, 0, st.size);
  if (!full) return null;
  if (full.text) {
    applyTranscriptLines(fresh, full.text, st.mtimeMs);
  }
  const entry: TranscriptCacheEntry = {
    ino: st.ino,
    mtimeMs: st.mtimeMs,
    size: st.size,
    lastByteOffset: full.nextOffset,
    data: fresh,
  };
  touchCache(transcriptPath, entry);
  return fresh;
}

export function readTranscriptTitleHead(
  transcriptPath: string,
  maxBytes = 16 * 1024,
): string {
  if (!existsSync(transcriptPath)) return '';
  let st;
  try {
    st = statSync(transcriptPath);
  } catch {
    return '';
  }

  const cached = titleCache.get(transcriptPath);
  if (cached && cached.ino === st.ino && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    titleCache.delete(transcriptPath);
    titleCache.set(transcriptPath, cached);
    return cached.title;
  }

  const fullCached = transcriptCache.get(transcriptPath);
  if (
    fullCached &&
    fullCached.ino === st.ino &&
    fullCached.mtimeMs === st.mtimeMs &&
    fullCached.size === st.size
  ) {
    return fullCached.data.title;
  }

  const readLen = Math.min(st.size, maxBytes);
  let title = '';
  if (readLen > 0) {
    const fd = openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.allocUnsafe(readLen);
      let offset = 0;
      while (offset < readLen) {
        const n = readSync(fd, buf, offset, readLen - offset, offset);
        if (n <= 0) break;
        offset += n;
      }
      let text = buf.subarray(0, offset).toString('utf8');
      if (readLen < st.size) {
        const lastNl = text.lastIndexOf('\n');
        text = lastNl >= 0 ? text.slice(0, lastNl) : '';
      }
      for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (obj.type === 'USER_INPUT' && obj.source === 'USER_EXPLICIT') {
            title = extractTitleFromUserContent(obj.content);
            if (title) break;
          }
        } catch {
          // Ignore malformed/partial line
        }
      }
    } catch {
      return '';
    } finally {
      closeSync(fd);
    }
  }

  if (titleCache.has(transcriptPath)) {
    titleCache.delete(transcriptPath);
  } else if (titleCache.size >= MAX_TITLE_CACHE_SIZE) {
    const oldest = titleCache.keys().next().value;
    if (oldest) titleCache.delete(oldest);
  }
  titleCache.set(transcriptPath, {
    ino: st.ino,
    mtimeMs: st.mtimeMs,
    size: st.size,
    title,
  });
  return title;
}

export function readTranscriptTailLines(
  transcriptPath: string,
  maxLines: number,
  maxBytes = 512 * 1024,
): string[] {
  return readTailLines(transcriptPath, maxLines, maxBytes);
}
