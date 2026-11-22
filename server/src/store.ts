import { EventEmitter } from 'node:events';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isSafeConversationId } from './coordinator-usage.js';
import { extractMentions } from './mentions.js';
import type {
  BoardMessage,
  BoardMessageKind,
  GraphEdge,
  MemberState,
  SwarmIndex,
  SwarmState,
  UiPrefs,
} from './types.js';

export function atomicWriteJson(filePath: string, value: unknown): void {
  const dir = join(filePath, '..');
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmpPath, filePath);
}

export class SwarmStore extends EventEmitter {
  readonly dataDir: string;
  private readonly indexPath: string;
  private readonly swarmsDir: string;
  private readonly states = new Map<string, SwarmState>();
  private readonly watchers = new Map<string, { fsWatcher?: FSWatcher; interval: NodeJS.Timeout }>();
  private readonly processingInboxFiles = new Set<string>();
  private index: SwarmIndex;

  constructor(dataDir: string) {
    super();
    this.setMaxListeners(100);
    this.dataDir = dataDir;
    this.indexPath = join(dataDir, 'index.json');
    this.swarmsDir = join(dataDir, 'swarms');
    mkdirSync(this.swarmsDir, { recursive: true });
    this.index = this.loadIndexFromDisk();
    this.loadExistingSwarms();
  }

  private loadIndexFromDisk(): SwarmIndex {
    if (!existsSync(this.indexPath)) {
      return { swarms: [] };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath, 'utf8')) as SwarmIndex;
      if (parsed && Array.isArray(parsed.swarms)) {
        return parsed;
      }
    } catch (err) {
      console.error(`[agy-ext-swarm] Failed to read index.json:`, err);
    }
    return { swarms: [] };
  }

  private saveIndex(): void {
    atomicWriteJson(this.indexPath, this.index);
  }

  private loadExistingSwarms(): void {
    for (const entry of this.index.swarms) {
      const statePath = join(this.getSwarmDir(entry.id), 'state.json');
      if (!existsSync(statePath)) continue;
      try {
        const state = JSON.parse(readFileSync(statePath, 'utf8')) as SwarmState;
        if (!state.defaultProvider) {
          state.defaultProvider = 'dsh';
        }
        if (typeof state.turnTimeoutSeconds !== 'number') {
          state.turnTimeoutSeconds = 300;
        }
        if (typeof state.stallTimeoutSeconds !== 'number') {
          state.stallTimeoutSeconds = 120;
        }
        // Any worker marked working/queued when server exited previously is now waiting/failed on restart.
        let mutated = false;
        for (const member of Object.values(state.members)) {
          if (member.status === 'working' || member.status === 'queued') {
            member.status = 'waiting';
            member.activity = undefined;
            mutated = true;
          }
        }
        this.states.set(state.id, state);
        if (mutated) {
          this.saveState(state);
        }
      } catch (err) {
        console.error(`[agy-ext-swarm] Failed to load swarm ${entry.id}:`, err);
      }
    }
  }

  getSwarmDir(swarmId: string): string {
    return join(this.swarmsDir, swarmId);
  }

  getInboxDir(swarmId: string): string {
    return join(this.getSwarmDir(swarmId), 'inbox');
  }

  getLogsDir(swarmId: string): string {
    return join(this.getSwarmDir(swarmId), 'logs');
  }

  getPatchesDir(swarmId: string): string {
    return join(this.getSwarmDir(swarmId), 'patches');
  }

  getWorktreesDir(swarmId: string): string {
    return join(this.getSwarmDir(swarmId), 'worktrees');
  }

  getBoardPath(swarmId: string): string {
    return join(this.getSwarmDir(swarmId), 'board.jsonl');
  }

  listSwarms() {
    return [...this.index.swarms];
  }

  getLatestSwarmId(): string | undefined {
    return this.index.latestSwarmId;
  }

  resolveSwarmId(swarmId?: string): string {
    if (swarmId && this.states.has(swarmId)) {
      return swarmId;
    }
    if (swarmId) {
      throw new Error(`Swarm "${swarmId}" not found.`);
    }
    if (this.index.latestSwarmId && this.states.has(this.index.latestSwarmId)) {
      return this.index.latestSwarmId;
    }
    const last = this.index.swarms[this.index.swarms.length - 1];
    if (last && this.states.has(last.id)) {
      return last.id;
    }
    throw new Error('No swarm exists yet. Call ext_swarm_create first.');
  }

  getSwarm(swarmId?: string): SwarmState {
    const id = this.resolveSwarmId(swarmId);
    const state = this.states.get(id);
    if (!state) {
      throw new Error(`Swarm "${id}" not found.`);
    }
    return state;
  }

  tryGetSwarm(swarmId?: string): SwarmState | undefined {
    try {
      return this.getSwarm(swarmId);
    } catch {
      return undefined;
    }
  }

  createSwarm(params: {
    id: string;
    title: string;
    repoRoot: string;
    gitRepoRoot?: string;
    gitCommonDir?: string;
    coordinatorConversationId?: string;
    defaultProvider?: string;
    activeProviders?: string[];
    routingPolicy?: SwarmState['routingPolicy'];
    profile: string;
    maxConcurrency: number;
    maxHops: number;
    turnTimeoutSeconds?: number;
    stallTimeoutSeconds?: number;
  }): SwarmState {
    const now = new Date().toISOString();
    const dir = this.getSwarmDir(params.id);
    mkdirSync(dir, { recursive: true });
    mkdirSync(this.getInboxDir(params.id), { recursive: true });
    mkdirSync(this.getLogsDir(params.id), { recursive: true });
    mkdirSync(this.getPatchesDir(params.id), { recursive: true });
    mkdirSync(this.getWorktreesDir(params.id), { recursive: true });

    const state: SwarmState = {
      id: params.id,
      title: params.title,
      repoRoot: params.repoRoot,
      gitRepoRoot: params.gitRepoRoot,
      gitCommonDir: params.gitCommonDir,
      coordinatorConversationId: params.coordinatorConversationId,
      defaultProvider: params.defaultProvider?.trim() || 'dsh',
      ...(params.activeProviders && params.activeProviders.length > 0
        ? { activeProviders: params.activeProviders }
        : {}),
      ...(params.routingPolicy ? { routingPolicy: params.routingPolicy } : {}),
      rrCursor: 0,
      profile: params.profile,
      maxConcurrency: params.maxConcurrency,
      maxHops: params.maxHops,
      turnTimeoutSeconds: params.turnTimeoutSeconds ?? 300,
      stallTimeoutSeconds: params.stallTimeoutSeconds ?? 120,
      hopCount: 0,
      headSeq: 0,
      createdAt: now,
      updatedAt: now,
      members: {},
    };

    this.states.set(state.id, state);
    this.saveState(state);

    this.index.latestSwarmId = state.id;
    this.index.swarms.push({
      id: state.id,
      title: state.title,
      repoRoot: state.repoRoot,
      createdAt: now,
      updatedAt: now,
    });
    this.saveIndex();
    this.emit('state', state.id, state);
    return state;
  }

  setCoordinatorConversation(swarmId: string | undefined, conversationId: string): SwarmState {
    const trimmed = conversationId.trim();
    if (trimmed && !isSafeConversationId(trimmed)) {
      throw new Error(
        `Invalid coordinator conversation ID "${conversationId}". Must match ^[a-zA-Z0-9_-]{1,128}$.`,
      );
    }
    const state = this.getSwarm(swarmId);
    state.coordinatorConversationId = trimmed || undefined;
    this.saveState(state);
    return state;
  }

  saveState(state: SwarmState): void {
    state.updatedAt = new Date().toISOString();
    atomicWriteJson(join(this.getSwarmDir(state.id), 'state.json'), state);
    const idxEntry = this.index.swarms.find((s) => s.id === state.id);
    if (idxEntry) {
      idxEntry.updatedAt = state.updatedAt;
      idxEntry.title = state.title;
      this.saveIndex();
    }
    this.emit('state', state.id, state);
  }

  upsertMember(swarmId: string, member: MemberState): void {
    const state = this.getSwarm(swarmId);
    member.updatedAt = new Date().toISOString();
    state.members[member.name] = member;
    this.saveState(state);
  }

  readBoard(swarmId: string, since = 0, limit = 200): BoardMessage[] {
    const boardPath = this.getBoardPath(swarmId);
    if (!existsSync(boardPath)) return [];
    const lines = readFileSync(boardPath, 'utf8').split('\n');
    const out: BoardMessage[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as BoardMessage;
        if (msg.seq > since) {
          out.push(msg);
        }
      } catch {
        // Ignore malformed line
      }
    }
    if (limit > 0 && out.length > limit) {
      return out.slice(-limit);
    }
    return out;
  }

  appendBoardMessage(
    swarmId: string,
    input: { agent: string; text: string; kind?: BoardMessageKind; time?: string },
  ): BoardMessage {
    const state = this.getSwarm(swarmId);
    const knownWorkers = Object.keys(state.members);
    const parsed = extractMentions(input.text, knownWorkers);

    state.headSeq += 1;
    const msg: BoardMessage = {
      seq: state.headSeq,
      agent: input.agent,
      text: input.text,
      kind: input.kind || 'message',
      time: input.time || new Date().toISOString(),
      mentions: parsed.mentions,
      all: parsed.all,
      mentionsCoordinator: parsed.mentionsCoordinator,
    };

    appendFileSync(this.getBoardPath(swarmId), JSON.stringify(msg) + '\n', 'utf8');
    this.saveState(state);
    this.emit('message', swarmId, msg);
    return msg;
  }

  computeGraphEdges(swarmId: string): GraphEdge[] {
    const state = this.getSwarm(swarmId);
    const messages = this.readBoard(swarmId, 0, 5000);
    const memberNames = Object.keys(state.members);
    const edgeMap = new Map<string, GraphEdge>();

    for (const msg of messages) {
      const targets = new Set<string>(msg.mentions);
      if (msg.mentionsCoordinator && msg.agent !== 'coordinator') {
        targets.add('coordinator');
      }
      if (msg.all) {
        for (const m of memberNames) {
          if (m !== msg.agent) targets.add(m);
        }
        if (msg.agent !== 'coordinator') targets.add('coordinator');
      }
      for (const target of targets) {
        if (target === msg.agent) continue;
        const key = `${msg.agent}->${target}`;
        const existing = edgeMap.get(key);
        if (existing) {
          existing.count += 1;
          existing.viaAll = existing.viaAll || msg.all;
        } else {
          edgeMap.set(key, { from: msg.agent, to: target, count: 1, viaAll: msg.all });
        }
      }
    }

    return Array.from(edgeMap.values());
  }

  startInboxWatcher(swarmId: string): void {
    if (this.watchers.has(swarmId)) return;
    const inboxDir = this.getInboxDir(swarmId);
    mkdirSync(inboxDir, { recursive: true });

    const drain = () => {
      this.drainInbox(swarmId);
    };

    let fsWatcher: FSWatcher | undefined;
    try {
      fsWatcher = watch(inboxDir, () => drain());
    } catch {
      // Fallback to interval polling only
    }
    const interval = setInterval(drain, 1000);
    interval.unref?.();
    this.watchers.set(swarmId, { fsWatcher, interval });
    drain();
  }

  drainInbox(swarmId: string): void {
    const inboxDir = this.getInboxDir(swarmId);
    if (!existsSync(inboxDir)) return;
    let files: string[];
    try {
      files = readdirSync(inboxDir)
        .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
        .sort();
    } catch {
      return;
    }

    for (const file of files) {
      const fullPath = join(inboxDir, file);
      if (this.processingInboxFiles.has(fullPath)) continue;
      this.processingInboxFiles.add(fullPath);
      try {
        const raw = readFileSync(fullPath, 'utf8');
        const payload = JSON.parse(raw) as {
          agent?: string;
          text?: string;
          kind?: BoardMessageKind;
          time?: string;
        };
        if (payload.agent && payload.text) {
          this.appendBoardMessage(swarmId, {
            agent: String(payload.agent),
            text: String(payload.text),
            kind: payload.kind || 'message',
            time: payload.time,
          });
        }
        unlinkSync(fullPath);
      } catch (err) {
        console.error(`[agy-ext-swarm] Failed to ingest inbox file ${fullPath}:`, err);
        try {
          unlinkSync(fullPath);
        } catch {
          // Ignore
        }
      } finally {
        this.processingInboxFiles.delete(fullPath);
      }
    }
  }

  getUiPrefs(): UiPrefs {
    const prefsPath = join(this.dataDir, 'ui-prefs.json');
    if (!existsSync(prefsPath)) return {};
    try {
      const parsed = JSON.parse(readFileSync(prefsPath, 'utf8')) as UiPrefs;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  setUiPrefs(patch: Partial<UiPrefs>): UiPrefs {
    const current = this.getUiPrefs();
    const next: UiPrefs = { ...current };
    if (patch.locale === 'zh' || patch.locale === 'en') {
      next.locale = patch.locale;
    }
    atomicWriteJson(join(this.dataDir, 'ui-prefs.json'), next);
    return next;
  }

  deleteSwarm(swarmId: string): void {
    const watcher = this.watchers.get(swarmId);
    if (watcher) {
      clearInterval(watcher.interval);
      watcher.fsWatcher?.close();
      this.watchers.delete(swarmId);
    }
    this.states.delete(swarmId);
    this.index.swarms = this.index.swarms.filter((s) => s.id !== swarmId);
    if (this.index.latestSwarmId === swarmId) {
      this.index.latestSwarmId = this.index.swarms[this.index.swarms.length - 1]?.id;
    }
    this.saveIndex();
    const dir = this.getSwarmDir(swarmId);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
    this.emit('state', swarmId, undefined);
  }

  closeAllWatchers(): void {
    for (const { fsWatcher, interval } of this.watchers.values()) {
      clearInterval(interval);
      fsWatcher?.close();
    }
    this.watchers.clear();
  }
}
