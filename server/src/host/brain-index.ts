import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { HostConversationEntry, NativeSubagentStatus } from '../../shared/types.js';
import { parseTranscriptFile, readTranscriptTitleHead, type ParsedTranscript } from './transcript.js';

const SAFE_CONVERSATION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const TOPOLOGY_CACHE_TTL_MS = 3000;

export function isSafeConversationId(id: string): boolean {
  return SAFE_CONVERSATION_ID_RE.test(id.trim());
}

export interface RawSubagentDescriptor {
  conversationId: string;
  typeName: string;
  role: string;
  state?: string;
  spawnStepIndex: number;
  workspaceUris?: string[];
  descriptorMtimeMs: number;
}

export interface BrainTopologySnapshot {
  brainDir: string;
  childToParent: Map<string, string>;
  parentToDescriptors: Map<string, RawSubagentDescriptor[]>;
  transcriptMtimes: Map<string, number>;
}

interface DescriptorFileCacheEntry {
  mtimeMs: number;
  size: number;
  descriptor: RawSubagentDescriptor;
}

let cachedTopology: {
  brainDir: string;
  expiresAt: number;
  data: BrainTopologySnapshot;
  descriptorFiles: Map<string, DescriptorFileCacheEntry>;
} | null = null;

export function clearBrainIndexCache(): void {
  cachedTopology = null;
}

export function resolveBrainDir(dataDir: string): string | null {
  const candidates: string[] = [];
  if (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    candidates.push(join(process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR, 'brain'));
  }
  // AGY mounts plugin data at <appData>/plugin_data/<plugin-name>
  candidates.push(resolve(dataDir, '..', '..', 'brain'));
  if (process.env.ANTIGRAVITY_APP_DATA_DIR) {
    candidates.push(join(process.env.ANTIGRAVITY_APP_DATA_DIR, 'brain'));
  }
  candidates.push(join(homedir(), '.gemini', 'antigravity', 'brain'));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function resolveSafeBrainSubpath(
  brainDir: string,
  conversationId: string,
  ...segments: string[]
): string | null {
  const trimmed = conversationId.trim();
  if (!isSafeConversationId(trimmed)) return null;
  const resolvedRoot = resolve(brainDir);
  const rootPrefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  const target = resolve(resolvedRoot, trimmed, ...segments);
  if (!target.startsWith(rootPrefix)) return null;
  return target;
}

export function getBrainTopology(brainDir: string | null): BrainTopologySnapshot | null {
  if (!brainDir || !existsSync(brainDir)) return null;
  const now = Date.now();
  if (
    cachedTopology &&
    cachedTopology.brainDir === brainDir &&
    now < cachedTopology.expiresAt
  ) {
    return cachedTopology.data;
  }

  let dirs: string[];
  try {
    dirs = readdirSync(brainDir);
  } catch {
    return null;
  }

  const previousFiles = cachedTopology?.brainDir === brainDir
    ? cachedTopology.descriptorFiles
    : undefined;
  const descriptorFiles = new Map<string, DescriptorFileCacheEntry>();
  const childToParent = new Map<string, string>();
  const parentToDescriptors = new Map<string, RawSubagentDescriptor[]>();
  const transcriptMtimes = new Map<string, number>();

  for (const id of dirs) {
    if (id.startsWith('.') || !isSafeConversationId(id)) continue;

    const transcriptPath = resolveSafeBrainSubpath(
      brainDir,
      id,
      '.system_generated',
      'logs',
      'transcript.jsonl',
    );
    if (transcriptPath && existsSync(transcriptPath)) {
      try {
        transcriptMtimes.set(id, statSync(transcriptPath).mtimeMs);
      } catch {
        // Ignore unreadable transcript stat
      }
    }

    const subagentsDir = resolveSafeBrainSubpath(brainDir, id, '.system_generated', 'subagents');
    if (!subagentsDir || !existsSync(subagentsDir)) continue;

    let files: string[];
    try {
      files = readdirSync(subagentsDir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }

    const descriptors: RawSubagentDescriptor[] = [];
    for (const file of files) {
      const fullPath = join(subagentsDir, file);
      try {
        const st = statSync(fullPath);
        const cached = previousFiles?.get(fullPath);
        if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
          descriptorFiles.set(fullPath, cached);
          descriptors.push(cached.descriptor);
          childToParent.set(cached.descriptor.conversationId, id);
          continue;
        }
        const raw = JSON.parse(readFileSync(fullPath, 'utf8')) as Record<string, unknown>;
        const childId =
          typeof raw.conversationId === 'string' && isSafeConversationId(raw.conversationId)
            ? raw.conversationId.trim()
            : '';
        if (!childId || childId === id) continue;

        const descObj =
          raw.subagentDescriptor && typeof raw.subagentDescriptor === 'object'
            ? (raw.subagentDescriptor as Record<string, unknown>)
            : {};
        const typeName =
          typeof descObj.typeName === 'string' && descObj.typeName.trim()
            ? descObj.typeName.trim()
            : 'subagent';
        const role =
          typeof descObj.role === 'string' && descObj.role.trim()
            ? descObj.role.trim()
            : childId.slice(0, 8);
        const state = typeof raw.state === 'string' ? raw.state.trim() : undefined;
        const spawnStepIndex =
          typeof raw.spawnStepIndex === 'number' && Number.isFinite(raw.spawnStepIndex)
            ? raw.spawnStepIndex
            : 0;
        const workspaceUris = Array.isArray(raw.workspaceUris)
          ? raw.workspaceUris.filter((u): u is string => typeof u === 'string' && u.length > 0)
          : undefined;

        const descriptor: RawSubagentDescriptor = {
          conversationId: childId,
          typeName,
          role,
          ...(state ? { state } : {}),
          spawnStepIndex,
          ...(workspaceUris && workspaceUris.length > 0 ? { workspaceUris } : {}),
          descriptorMtimeMs: st.mtimeMs,
        };
        descriptorFiles.set(fullPath, { mtimeMs: st.mtimeMs, size: st.size, descriptor });
        descriptors.push(descriptor);
        childToParent.set(childId, id);
      } catch {
        // Ignore malformed subagent descriptor JSON
      }
    }

    if (descriptors.length > 0) {
      parentToDescriptors.set(id, descriptors);
    }
  }

  const data: BrainTopologySnapshot = {
    brainDir,
    childToParent,
    parentToDescriptors,
    transcriptMtimes,
  };
  cachedTopology = {
    brainDir,
    expiresAt: now + TOPOLOGY_CACHE_TTL_MS,
    data,
    descriptorFiles,
  };
  return data;
}

export function resolveRootConversationId(
  topology: BrainTopologySnapshot | null,
  conversationId: string,
): string {
  const trimmed = conversationId.trim();
  if (!topology) return trimmed;
  let current = trimmed;
  const visited = new Set<string>();
  while (topology.childToParent.has(current) && !visited.has(current)) {
    visited.add(current);
    const parent = topology.childToParent.get(current);
    if (!parent) break;
    current = parent;
  }
  return current;
}

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

export function readMessageDirStats(messagesDir: string | null): Map<string, ChildMessageStats> {
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
  let complete = true;
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
      complete = false;
    }
  }

  parentMessageCache.delete(messagesDir);
  // A write in progress may finish without changing the directory metadata.
  if (!complete) return statsBySender;
  if (parentMessageCache.size >= MESSAGE_CACHE_MAX) {
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

export function inferStatusFromTranscript(
  desc: RawSubagentDescriptor,
  parsed: ParsedTranscript | null,
  msgStats: ChildMessageStats | undefined,
  nowMs: number,
): NativeSubagentStatus {
  if (desc.state && desc.state !== 'SUBAGENT_STATE_ALIVE') {
    return 'killed';
  }

  if (!parsed) {
    const isFresh = nowMs - desc.descriptorMtimeMs <= ACTIVE_WINDOW_DEFAULT_MS;
    return isFresh ? 'working' : 'waiting';
  }

  const ev = parsed.lastEvent;
  if (!ev) {
    const isFresh = nowMs - parsed.fileMtimeMs <= ACTIVE_WINDOW_DEFAULT_MS;
    return isFresh ? 'working' : 'waiting';
  }

  if (ev.type === 'ERROR_MESSAGE') {
    return 'failed';
  }

  if (ev.type === 'PLANNER_RESPONSE' && ev.status === 'DONE' && !ev.hasToolCalls) {
    return 'waiting';
  }

  if (
    ev.type === 'PLANNER_RESPONSE' &&
    ev.hasSendMessage &&
    msgStats &&
    msgStats.lastReplyAtMs >= ev.createdAtMs - 2000 &&
    nowMs - parsed.fileMtimeMs > 5000
  ) {
    return 'waiting';
  }

  const activeWindowMs =
    parsed.lastToolName === 'run_command' ? ACTIVE_WINDOW_CMD_MS : ACTIVE_WINDOW_DEFAULT_MS;
  const isFresh = nowMs - parsed.fileMtimeMs <= activeWindowMs;
  return isFresh ? 'working' : 'waiting';
}

export function listTopLevelConversations(
  brainDir: string | null,
  topology: BrainTopologySnapshot | null,
  limit = 16,
): HostConversationEntry[] {
  if (!brainDir || !topology) return [];

  const now = Date.now();
  const candidates: Array<{
    id: string;
    effectiveMtimeMs: number;
    transcriptPath: string;
    subagentCount: number;
    activeSubagentCount: number;
  }> = [];

  for (const [id, parentMtimeMs] of topology.transcriptMtimes.entries()) {
    // Exclude child subagent conversations from top-level dropdown
    if (topology.childToParent.has(id)) continue;

    const transcriptPath = resolveSafeBrainSubpath(
      brainDir,
      id,
      '.system_generated',
      'logs',
      'transcript.jsonl',
    );
    if (!transcriptPath) continue;

    const descriptors = topology.parentToDescriptors.get(id) || [];
    let effectiveMtimeMs = parentMtimeMs;
    let activeSubagentCount = 0;
    let parentMessages: Map<string, ChildMessageStats> | undefined;

    for (const desc of descriptors) {
      const childMtime = topology.transcriptMtimes.get(desc.conversationId);
      const childRefMs = Math.max(childMtime ?? 0, desc.descriptorMtimeMs);
      if (childRefMs > effectiveMtimeMs) {
        effectiveMtimeMs = childRefMs;
      }
      if (
        (desc.state && desc.state !== 'SUBAGENT_STATE_ALIVE') ||
        now - (childMtime ?? desc.descriptorMtimeMs) > ACTIVE_WINDOW_CMD_MS
      ) {
        continue;
      }

      const childPath = childMtime === undefined ? null : resolveSafeBrainSubpath(
        brainDir, desc.conversationId, '.system_generated', 'logs', 'transcript.jsonl',
      );
      const parsed = childPath ? parseTranscriptFile(childPath) : null;
      if (parsed?.lastEvent?.hasSendMessage && !parentMessages) {
        parentMessages = readMessageDirStats(
          resolveSafeBrainSubpath(brainDir, id, '.system_generated', 'messages'),
        );
      }
      const stats = parentMessages?.get(desc.conversationId);
      if (inferStatusFromTranscript(desc, parsed, stats, now) === 'working') {
        activeSubagentCount += 1;
      }
    }

    candidates.push({
      id,
      effectiveMtimeMs,
      transcriptPath,
      subagentCount: descriptors.length,
      activeSubagentCount,
    });
  }

  candidates.sort((a, b) => b.effectiveMtimeMs - a.effectiveMtimeMs);

  return candidates.slice(0, limit).map((item) => {
    const title = readTranscriptTitleHead(item.transcriptPath);
    const shortId = item.id.slice(0, 8);
    const baseTitle = title ? `${title} (${shortId})` : shortId;
    return {
      id: item.id,
      title: baseTitle,
      updatedAt: new Date(item.effectiveMtimeMs).toISOString(),
      subagentCount: item.subagentCount,
      activeSubagentCount: item.activeSubagentCount,
    };
  });
}
