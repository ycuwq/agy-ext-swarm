import { buildInitialWorkerPrompt } from './runner-prompts.js';
import type { SwarmStore } from './store.js';
import { getWorktreeDiff } from './worktree.js';

export interface DependencyHost {
  store: SwarmStore;
  boardCli: string;
  /**
   * Invoked when a blocked dependent becomes runnable: the host persists the
   * initial prompt and enqueues the worker turn (queue state lives in the host).
   */
  onDependentReleased(
    swarmId: string,
    memberName: string,
    initialPrompt: string,
    briefSeq: number,
  ): void;
}

export function propagateBlockedDependencyFailures(store: SwarmStore, swarmId: string): void {
  let changed = true;
  while (changed) {
    changed = false;
    const swarm = store.tryGetSwarm(swarmId);
    if (!swarm) return;
    for (const m of Object.values(swarm.members)) {
      if (m.status !== 'blocked') continue;
      const deps = m.dependsOn || [];
      const brokenDepName = deps.find((d) => {
        const dep = swarm.members[d];
        return !dep || dep.status === 'failed' || dep.status === 'killed';
      });
      if (!brokenDepName) continue;
      const depStatus = swarm.members[brokenDepName]?.status || 'missing';
      m.status = 'failed';
      m.activity = undefined;
      m.lastError = `Upstream dependency "${brokenDepName}" is ${depStatus}.`;
      store.upsertMember(swarmId, m);
      store.appendBoardMessage(swarmId, {
        agent: 'system',
        text: `@coordinator [error] Blocked worker "${m.name}" aborted because upstream dependency "${brokenDepName}" is ${depStatus}.`,
        kind: 'error',
      });
      changed = true;
    }
  }
}

export async function collectUpstreamContext(
  store: SwarmStore,
  swarmId: string,
  deps: string[],
): Promise<string> {
  const swarm = store.tryGetSwarm(swarmId);
  if (!swarm || deps.length === 0) return '';
  const boardMsgs = store.readBoard(swarmId, 0, 500);
  const sections: string[] = [];

  for (const depName of deps) {
    const m = swarm.members[depName];
    if (!m) continue;
    const lastPost = [...boardMsgs]
      .reverse()
      .find((msg) => msg.agent === depName && msg.kind !== 'system');
    const diff =
      m.workspaceMode === 'worktree' ? await getWorktreeDiff(m.cwd, m.baseRef, m.allowedFiles) : null;
    const parts: string[] = [`- Upstream @${depName} (status: ${m.status}, turns: ${m.turns}):`];
    if (m.branch) {
      const baseRef = m.baseRef || 'HEAD';
      parts.push(`  branch: ${m.branch} (base: ${baseRef}), cwd: ${m.cwd}`);
      parts.push(`  inspect diff: git diff ${baseRef}..${m.branch}`);
    }
    if (diff && (diff.changedFiles.length > 0 || diff.stat)) {
      parts.push(`  changedFiles: ${diff.changedFiles.join(', ') || '(none)'}`);
      if (diff.outOfScopeFiles.length > 0) {
        parts.push(`  outOfScopeFiles: ${diff.outOfScopeFiles.join(', ')}`);
      }
      if (diff.stat) parts.push(`  stat: ${diff.stat.replace(/\s+/g, ' ').slice(0, 260)}`);
    }
    if (lastPost) {
      parts.push(`  lastPost (#${lastPost.seq}): ${lastPost.text.slice(0, 500)}`);
      if (lastPost.reportPath) {
        parts.push(`  reportPath: ${lastPost.reportPath}`);
      }
    }
    sections.push(parts.join('\n'));
  }

  if (sections.length === 0) return '';
  return `[Upstream Dependencies Completed: ${deps.join(', ')}]\n${sections.join('\n')}`;
}

export async function checkAndReleaseBlockedDependents(
  host: DependencyHost,
  swarmId: string,
): Promise<void> {
  const { store } = host;
  propagateBlockedDependencyFailures(store, swarmId);
  const swarm = store.tryGetSwarm(swarmId);
  if (!swarm) return;
  const blockedMembers = Object.values(swarm.members).filter((m) => m.status === 'blocked');
  if (blockedMembers.length === 0) return;

  for (const candidate of blockedMembers) {
    const latestSwarm = store.tryGetSwarm(swarmId);
    if (!latestSwarm) return;
    const current = latestSwarm.members[candidate.name];
    if (!current || current.status !== 'blocked') continue;
    const deps = current.dependsOn || [];
    const allReady =
      deps.length > 0 &&
      deps.every((d) => {
        const dm = latestSwarm.members[d];
        return Boolean(dm && dm.status === 'waiting' && dm.turns > 0);
      });
    if (!allReady) continue;

    const upstreamSummary = await collectUpstreamContext(store, swarmId, deps);
    const releaseSwarm = store.tryGetSwarm(swarmId);
    const releaseMember = releaseSwarm?.members[candidate.name];
    if (!releaseSwarm || !releaseMember || releaseMember.status !== 'blocked') continue;

    const rawBrief = releaseMember.pendingBrief || releaseMember.role || 'Execute assigned task.';
    const combinedBrief = upstreamSummary ? `${rawBrief}\n\n${upstreamSummary}` : rawBrief;

    releaseMember.status = 'queued';
    releaseMember.pendingBrief = undefined;
    releaseMember.activity = undefined;
    store.upsertMember(swarmId, releaseMember);

    const briefMsg = store.appendBoardMessage(swarmId, {
      agent: 'coordinator',
      text: `@${releaseMember.name} [unblocked after ${deps.join(', ')}] ${rawBrief}`,
      kind: 'brief',
    });
    releaseMember.lastReadSeq = briefMsg.seq;
    store.upsertMember(swarmId, releaseMember);

    const initialPrompt = buildInitialWorkerPrompt({
      swarm: releaseSwarm,
      member: releaseMember,
      brief: combinedBrief,
      briefSeq: briefMsg.seq,
      swarmDir: store.getSwarmDir(swarmId),
      boardCli: host.boardCli,
    });
    host.onDependentReleased(swarmId, releaseMember.name, initialPrompt, briefMsg.seq);
  }
}
