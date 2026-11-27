import type { SwarmStore } from './store.js';
import type { BoardMessage, MemberState, SwarmState, WorkerStatus } from './types.js';

export interface PostDeliverySummary {
  woken: string[];
  deferred: string[];
  skipped?: Array<{ name: string; reason: string }>;
}

export interface WaitOptions {
  swarmId?: string;
  since?: number;
  timeoutSeconds?: number;
  until?: 'any_post' | 'mentions_coordinator' | 'all_idle' | 'worker_done';
  workerName?: string;
}

export interface WaitResult {
  timedOut: boolean;
  reason: string;
  swarm: SwarmState;
  messages: BoardMessage[];
}

export interface WaitCommandOptions {
  since?: number;
  until?: 'all_idle' | 'mentions_coordinator' | 'any_post' | 'worker_done';
  workerName?: string;
}

export function resolveWakeTargets(
  members: Record<string, Pick<MemberState, 'status'>>,
  sender: string,
  all: boolean,
  mentions: string[],
): { targets: string[]; skipped: Array<{ name: string; reason: string }> } {
  const targets: string[] = [];
  const seen = new Set<string>();
  const skipped: Array<{ name: string; reason: string }> = [];
  if (all) {
    for (const [name, m] of Object.entries(members)) {
      if (name === sender || m.status === 'killed') continue;
      if (m.status === 'blocked' || m.status === 'failed') {
        skipped.push({ name, reason: m.status });
        continue;
      }
      seen.add(name);
      targets.push(name);
    }
  } else {
    for (const mention of mentions) {
      if (mention === sender || seen.has(mention)) continue;
      const st = members[mention]?.status;
      if (!st) continue;
      if (st === 'killed' || st === 'blocked') {
        skipped.push({ name: mention, reason: st });
        continue;
      }
      seen.add(mention);
      targets.push(mention);
    }
  }
  return { targets, skipped };
}

export function postAsCoordinator(
  store: SwarmStore,
  swarmId: string | undefined,
  text: string,
): BoardMessage {
  const swarm = store.getSwarm(swarmId);
  return store.appendBoardMessage(swarm.id, {
    agent: 'coordinator',
    text,
    kind: 'message',
  });
}

export function postAsCoordinatorWithDelivery(
  store: SwarmStore,
  swarmId: string | undefined,
  text: string,
): { message: BoardMessage; delivery: PostDeliverySummary } {
  const swarm = store.getSwarm(swarmId);
  const preMembers: Record<string, { status: WorkerStatus }> = {};
  for (const [name, m] of Object.entries(swarm.members)) {
    preMembers[name] = { status: m.status };
  }
  const message = postAsCoordinator(store, swarm.id, text);
  const { targets, skipped } = resolveWakeTargets(
    preMembers,
    message.agent,
    message.all,
    message.mentions,
  );
  const woken: string[] = [];
  const deferred: string[] = [];
  for (const targetName of targets) {
    const st = preMembers[targetName]?.status;
    if (st === 'working' || st === 'queued') {
      deferred.push(targetName);
    } else {
      woken.push(targetName);
    }
  }
  return {
    message,
    delivery: {
      woken,
      deferred,
      ...(skipped.length > 0 ? { skipped } : {}),
    },
  };
}

export function buildAsyncWaitCommand(
  store: SwarmStore,
  boardCli: string,
  swarmId: string | undefined,
  opts?: WaitCommandOptions,
): string {
  const swarm = store.getSwarm(swarmId);
  const swarmDir = store.getSwarmDir(swarm.id);
  const until = opts?.until || 'all_idle';
  const since =
    typeof opts?.since === 'number' && Number.isFinite(opts.since) && opts.since >= 0
      ? Math.floor(opts.since)
      : swarm.headSeq;
  const quoteArg = (val: string) =>
    process.platform === 'win32'
      ? `"${val.replace(/"/g, '\\"')}"`
      : `'${val.replace(/'/g, "'\\''")}'`;
  const parts = [
    'node',
    quoteArg(boardCli),
    'wait',
    '--swarm-dir',
    quoteArg(swarmDir),
    '--since',
    String(since),
    '--until',
    until,
  ];
  if (until === 'worker_done' && opts?.workerName?.trim()) {
    parts.push('--worker', quoteArg(opts.workerName.trim().toLowerCase()));
  }
  return parts.join(' ');
}

export async function waitForCondition(
  store: SwarmStore,
  opts: WaitOptions,
): Promise<WaitResult> {
  const swarm = store.getSwarm(opts.swarmId);
  const swarmId = swarm.id;
  let lastSnapshot: SwarmState = {
    ...swarm,
    members: Object.fromEntries(Object.entries(swarm.members).map(([k, v]) => [k, { ...v }])),
  };
  const since = opts.since ?? swarm.headSeq;
  const timeoutMs = Math.max(1, Math.min(90, opts.timeoutSeconds ?? 45)) * 1000;
  const until = opts.until || 'any_post';
  const normalizedWorkerName = opts.workerName?.trim().toLowerCase() || undefined;

  store.drainInbox(swarmId);

  const checkMatch = (): { matched: boolean; reason: string } => {
    const current = store.tryGetSwarm(swarmId);
    if (!current || current.deleting) {
      return { matched: true, reason: 'swarm_deleted' };
    }
    lastSnapshot = current;
    const newMsgs = store.readBoard(swarmId, since, 200);
    const members = Object.values(current.members);
    const nonKilled = members.filter((m) => m.status !== 'killed');
    const allKilled = members.length > 0 && nonKilled.length === 0;
    const allIdle =
      members.length > 0 &&
      nonKilled.every((m) => m.status === 'waiting' || m.status === 'failed');
    const idleReason = allKilled ? 'all_workers_killed' : 'all_workers_idle';
    const hasReleasableBlocked = nonKilled.some(
      (m) =>
        m.status === 'blocked' &&
        (m.dependsOn || []).length > 0 &&
        (m.dependsOn || []).every((d) => {
          const dm = current.members[d];
          return Boolean(dm && dm.status === 'waiting' && dm.turns > 0);
        }),
    );
    const blockedDeadlock =
      !hasReleasableBlocked &&
      nonKilled.length > 0 &&
      nonKilled.every((m) => m.status !== 'working' && m.status !== 'queued') &&
      nonKilled.some((m) => m.status === 'blocked');

    if (until === 'any_post') {
      if (newMsgs.length > 0) return { matched: true, reason: 'new_board_post' };
      if (allIdle && (allKilled || members.some((m) => m.turns > 0))) {
        return { matched: true, reason: idleReason };
      }
      if (blockedDeadlock) {
        return { matched: true, reason: 'blocked_deadlock' };
      }
    } else if (until === 'mentions_coordinator') {
      if (
        newMsgs.some(
          (m) =>
            m.agent !== 'coordinator' &&
            (m.mentionsCoordinator || m.all || m.kind === 'error' || m.kind === 'warning'),
        )
      ) {
        return { matched: true, reason: 'mentions_coordinator' };
      }
      if (allIdle && (allKilled || members.some((m) => m.turns > 0))) {
        return { matched: true, reason: idleReason };
      }
      if (blockedDeadlock) {
        return { matched: true, reason: 'blocked_deadlock' };
      }
    } else if (until === 'all_idle') {
      if (allIdle) return { matched: true, reason: idleReason };
      if (blockedDeadlock) return { matched: true, reason: 'blocked_deadlock' };
    } else if (until === 'worker_done') {
      const target = normalizedWorkerName ? current.members[normalizedWorkerName] : undefined;
      if (!target) return { matched: true, reason: 'worker_not_found' };
      if (
        target.status === 'waiting' ||
        target.status === 'failed' ||
        target.status === 'killed'
      ) {
        return { matched: true, reason: `worker_${target.status}` };
      }
      if (target.status === 'blocked' && blockedDeadlock) {
        return { matched: true, reason: 'blocked_deadlock' };
      }
    }
    return { matched: false, reason: 'waiting' };
  };

  const immediate = checkMatch();
  if (immediate.matched) {
    const latest = store.tryGetSwarm(swarmId);
    return {
      timedOut: false,
      reason: immediate.reason,
      swarm: latest || lastSnapshot,
      messages: latest && !latest.deleting ? store.readBoard(swarmId, since, 200) : [],
    };
  }

  return new Promise((resolveWait) => {
    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      store.off('message', onEvent);
      store.off('state', onEvent);
    };

    const onEvent = (evSwarmId: string) => {
      if (evSwarmId !== swarmId || finished) return;
      const status = checkMatch();
      if (status.matched) {
        cleanup();
        const latest = store.tryGetSwarm(swarmId);
        resolveWait({
          timedOut: false,
          reason: status.reason,
          swarm: latest || lastSnapshot,
          messages: latest && !latest.deleting ? store.readBoard(swarmId, since, 200) : [],
        });
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      const latest = store.tryGetSwarm(swarmId);
      const alive = Boolean(latest && !latest.deleting);
      resolveWait({
        timedOut: alive,
        reason: alive ? 'timeout' : 'swarm_deleted',
        swarm: latest || lastSnapshot,
        messages: alive ? store.readBoard(swarmId, since, 200) : [],
      });
    }, timeoutMs);

    store.on('message', onEvent);
    store.on('state', onEvent);
  });
}
