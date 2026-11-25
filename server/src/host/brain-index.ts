import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { HostConversationEntry } from '../../shared/types.js';
import { parseTranscriptFile, readTranscriptTitleHead } from './transcript.js';

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

let cachedTopology: {
  brainDir: string;
  expiresAt: number;
  data: BrainTopologySnapshot;
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

        descriptors.push({
          conversationId: childId,
          typeName,
          role,
          ...(state ? { state } : {}),
          spawnStepIndex,
          ...(workspaceUris && workspaceUris.length > 0 ? { workspaceUris } : {}),
          descriptorMtimeMs: st.mtimeMs,
        });
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

function isDescriptorLikelyActive(
  desc: RawSubagentDescriptor,
  transcriptMtimeMs: number | undefined,
  now: number,
): boolean {
  if (desc.state && desc.state !== 'SUBAGENT_STATE_ALIVE') return false;
  const refMs = transcriptMtimeMs ?? desc.descriptorMtimeMs;
  if (now - refMs > 180_000) return false;
  if (!transcriptMtimeMs) return true;
  // Quick check via parsed transcript lastEvent
  return false;
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

    for (const desc of descriptors) {
      const childMtime = topology.transcriptMtimes.get(desc.conversationId);
      const childRefMs = Math.max(childMtime ?? 0, desc.descriptorMtimeMs);
      if (childRefMs > effectiveMtimeMs) {
        effectiveMtimeMs = childRefMs;
      }
      if (isDescriptorLikelyActive(desc, childMtime, now)) {
        activeSubagentCount += 1;
      } else if (childMtime && now - childMtime <= 180_000 && (!desc.state || desc.state === 'SUBAGENT_STATE_ALIVE')) {
        const childPath = resolveSafeBrainSubpath(
          brainDir,
          desc.conversationId,
          '.system_generated',
          'logs',
          'transcript.jsonl',
        );
        const parsedChild = childPath ? parseTranscriptFile(childPath) : null;
        const ev = parsedChild?.lastEvent;
        if (
          ev &&
          ev.type !== 'ERROR_MESSAGE' &&
          !(ev.type === 'PLANNER_RESPONSE' && ev.status === 'DONE' && !ev.hasToolCalls)
        ) {
          activeSubagentCount += 1;
        }
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
