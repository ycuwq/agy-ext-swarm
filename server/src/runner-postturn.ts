import type { SwarmStore } from './store.js';
import { extractMentions } from './mentions.js';
import { runVerifyCommands } from './runner-process.js';
import { inferMessageKind } from './runner-prompts.js';
import type { MemberState, SwarmState } from './types.js';
import type { ChildProcess } from 'node:child_process';
import { getWorktreeDiff } from './worktree.js';

export interface PostTurnHost {
  store: SwarmStore;
  activeVerifyProcs: Map<ChildProcess, { key: string }>;
  isShuttingDown(): boolean;
  enqueueTask(
    task: {
      swarmId: string;
      memberName: string;
      overridePrompt?: string;
      maxDeliveredSeq: number;
    },
    opts?: { front?: boolean },
  ): void;
  pumpQueue(swarmId: string): void;
}

/** Signals whether the caller should stop (`aborted`), continue to dependents (`completed`), or pump an auto-requeued turn (`requeued`). */
export type PostTurnOutcome = 'aborted' | 'completed' | 'requeued';

/**
 * Applies the deterministic post-turn work after a worker process exited cleanly:
 * allowed_files scope check, auto-verify execution, auto-post of the final report,
 * and the transition back to `waiting`/`queued`.
 */
export async function finalizeSuccessfulTurn(
  host: PostTurnHost,
  args: {
    swarmId: string;
    memberName: string;
    procKey: string;
    turnStartedHeadSeq: number;
    maxDeliveredSeq: number;
    finalText: string;
    textChunks: string[];
    latestSwarm: SwarmState;
    latestMember: MemberState;
  },
): Promise<PostTurnOutcome> {
  const { store } = host;
  const { swarmId, memberName, procKey, turnStartedHeadSeq, maxDeliveredSeq } = args;
  const latestSwarm = args.latestSwarm;
  const latestMember = args.latestMember;

  // Keep status as 'working' until diff & auto_verify & final board post finish so `all_idle`
  // does not fire before @mention peer routing queues downstream workers.
  latestMember.activity = undefined;
  latestMember.lastTurnFinishedAt = new Date().toISOString();
  latestMember.lastReadSeq = Math.max(latestMember.lastReadSeq, maxDeliveredSeq);

  let detectedOutOfScope: string[] = [];
  let failedVerifyResults: NonNullable<MemberState['lastVerifyResults']> = [];
  const canSelfHeal =
    latestMember.permissionMode !== 'read-only' &&
    (latestMember.maxVerifyRetries ?? 0) > (latestMember.verifyRetriesUsed ?? 0);

  // Mechanical allowed_files check
  if (
    latestMember.allowedFiles &&
    latestMember.allowedFiles.length > 0 &&
    latestSwarm.gitRepoRoot
  ) {
    const diff = await getWorktreeDiff(
      latestMember.cwd,
      latestMember.baseRef,
      latestMember.allowedFiles,
    );
    const recheckSwarmAfterDiff = store.tryGetSwarm(swarmId);
    const recheckMemberAfterDiff = recheckSwarmAfterDiff?.members[memberName];
    if (
      !recheckSwarmAfterDiff ||
      !recheckMemberAfterDiff ||
      recheckMemberAfterDiff.status === 'killed' ||
      host.isShuttingDown()
    ) {
      host.pumpQueue(swarmId);
      return 'aborted';
    }
    if (diff) {
      latestMember.outOfScopeFiles = diff.outOfScopeFiles;
      detectedOutOfScope = diff.outOfScopeFiles;
      if (diff.outOfScopeFiles.length > 0) {
        store.appendBoardMessage(swarmId, {
          agent: 'system',
          text: canSelfHeal
            ? `[allowed-files] Worker "${latestMember.name}" modified files outside allowed_files (will auto-retry): ${diff.outOfScopeFiles.join(', ')}`
            : `@coordinator [warning] Worker "${latestMember.name}" modified files outside allowed_files: ${diff.outOfScopeFiles.join(', ')}`,
          kind: 'warning',
        });
      }
    }
  }

  // Deterministic host-side verify_commands execution when autoVerify is enabled
  if (
    latestMember.autoVerify &&
    latestMember.permissionMode !== 'read-only' &&
    latestMember.verifyCommands &&
    latestMember.verifyCommands.length > 0
  ) {
    latestMember.activity = 'running verify_commands...';
    store.upsertMember(swarmId, latestMember);
    const verifyResults = await runVerifyCommands(
      host.activeVerifyProcs,
      procKey,
      latestMember.cwd,
      latestMember.verifyCommands,
      60000,
      {
        SWARM_WORKER_NAME: latestMember.name,
        ...(latestMember.workerIndex !== undefined
          ? { SWARM_WORKER_INDEX: String(latestMember.workerIndex) }
          : {}),
        ...(latestMember.portOffset !== undefined
          ? { SWARM_PORT_OFFSET: String(latestMember.portOffset) }
          : {}),
      },
    );
    const recheckSwarmAfterVerify = store.tryGetSwarm(swarmId);
    const recheckMemberAfterVerify = recheckSwarmAfterVerify?.members[memberName];
    if (
      !recheckSwarmAfterVerify ||
      !recheckMemberAfterVerify ||
      recheckMemberAfterVerify.status === 'killed' ||
      host.isShuttingDown()
    ) {
      host.pumpQueue(swarmId);
      return 'aborted';
    }
    latestMember.lastVerifyResults = verifyResults;
    latestMember.activity = undefined;
    failedVerifyResults = verifyResults.filter((r) => !r.passed);
    const allPassed = failedVerifyResults.length === 0;
    const summaryLines = verifyResults.map(
      (r) =>
        `- ${r.passed ? 'PASS' : 'FAIL'} (exit=${r.exitCode ?? '?'}, ${r.durationMs}ms): \`${r.command}\`${!r.passed && r.outputTail ? `\n  ${r.outputTail.slice(-300)}` : ''}`,
    );
    store.appendBoardMessage(swarmId, {
      agent: 'system',
      text: allPassed
        ? `[auto-verify] ${latestMember.name} passed ${verifyResults.length}/${verifyResults.length} verify command(s):\n${summaryLines.join('\n')}`
        : `${canSelfHeal ? '' : '@coordinator [warning] '}[auto-verify] ${latestMember.name} failed verification:\n${summaryLines.join('\n')}`,
      kind: allPassed ? 'system' : 'warning',
    });
  }

  // Auto-post final response if the worker did not already post via ext-board CLI this turn
  const recentMsgs = store.readBoard(swarmId, turnStartedHeadSeq, 200);
  const postedSelfThisTurn = recentMsgs.some((m) => m.agent === latestMember.name);
  const rawOutput = (args.finalText || args.textChunks.join('')).trim();
  if (!postedSelfThisTurn && rawOutput) {
    const parsed = extractMentions(rawOutput, Object.keys(latestSwarm.members));
    const hasMention = parsed.mentions.length > 0 || parsed.all || parsed.mentionsCoordinator;
    const postText = hasMention ? rawOutput : `@coordinator ${rawOutput}`;
    store.appendBoardMessage(swarmId, {
      agent: latestMember.name,
      text: postText,
      kind: inferMessageKind(postText),
    });
  }

  // Self-heal loop: automatically re-queue worker with failure diagnostics when retries remain
  if (canSelfHeal && (failedVerifyResults.length > 0 || detectedOutOfScope.length > 0)) {
    const nextUsed = (latestMember.verifyRetriesUsed ?? 0) + 1;
    const maxRetries = latestMember.maxVerifyRetries ?? 0;
    const afterHealSwarm = store.tryGetSwarm(swarmId);
    const afterHealMember = afterHealSwarm?.members[memberName] || latestMember;
    afterHealMember.verifyRetriesUsed = nextUsed;
    afterHealMember.status = 'queued';
    afterHealMember.pendingWake = false;
    afterHealMember.activity = `auto-fixing verification (${nextUsed}/${maxRetries})...`;
    afterHealMember.lastTurnFinishedAt = latestMember.lastTurnFinishedAt;
    afterHealMember.lastReadSeq = latestMember.lastReadSeq;
    afterHealMember.outOfScopeFiles = latestMember.outOfScopeFiles;
    afterHealMember.lastVerifyResults = latestMember.lastVerifyResults;
    store.upsertMember(swarmId, afterHealMember);

    const failureSections: string[] = [];
    if (detectedOutOfScope.length > 0) {
      failureSections.push(
        `Out-of-scope files modified outside allowed_files (${(afterHealMember.allowedFiles || []).join(', ')}):\n- ${detectedOutOfScope.join('\n- ')}\nRevert edits outside allowed_files.`,
      );
    }
    if (failedVerifyResults.length > 0) {
      const cmdDetails = failedVerifyResults
        .map(
          (r) =>
            `Command: \`${r.command}\` (exit=${r.exitCode ?? '?'})\nOutput tail:\n\`\`\`\n${(r.outputTail || '(no output)').slice(-800)}\n\`\`\``,
        )
        .join('\n\n');
      failureSections.push(`Failed verify_commands:\n${cmdDetails}`);
    }

    const healNotice = store.appendBoardMessage(swarmId, {
      agent: 'system',
      text: `[auto-heal] ${afterHealMember.name} failed post-turn checks; automatically resuming session for self-fix attempt ${nextUsed}/${maxRetries}.`,
      kind: 'system',
    });

    const healPrompt = `[Auto-Verify Self-Heal Attempt ${nextUsed}/${maxRetries}]\nHost-side verification after your last turn failed. Fix the root cause in your workspace "${afterHealMember.cwd}", re-run verification, commit your fixes on branch "${afterHealMember.branch || 'HEAD'}", and report updated status.\n\n${failureSections.join('\n\n')}`;

    host.enqueueTask(
      {
        swarmId,
        memberName: afterHealMember.name,
        overridePrompt: healPrompt,
        maxDeliveredSeq: Math.max(afterHealMember.lastReadSeq, healNotice.seq),
      },
      { front: true },
    );
    return 'requeued';
  }

  // Now transition to waiting (or re-queue if pendingWake arrived while working)
  const afterPostSwarm = store.tryGetSwarm(swarmId);
  const afterPostMember = afterPostSwarm?.members[memberName] || latestMember;
  afterPostMember.activity = undefined;
  afterPostMember.lastTurnFinishedAt = latestMember.lastTurnFinishedAt;
  afterPostMember.lastReadSeq = latestMember.lastReadSeq;
  afterPostMember.outOfScopeFiles = latestMember.outOfScopeFiles;
  afterPostMember.lastVerifyResults = latestMember.lastVerifyResults;

  if (afterPostSwarm && afterPostMember.pendingWake) {
    const remainingUnread = store.readBoard(swarmId, afterPostMember.lastReadSeq, 50);
    if (remainingUnread.length > 0 && afterPostSwarm.hopCount <= afterPostSwarm.maxHops) {
      afterPostMember.status = 'queued';
      afterPostMember.pendingWake = false;
      store.upsertMember(swarmId, afterPostMember);
      host.enqueueTask({
        swarmId,
        memberName: afterPostMember.name,
        maxDeliveredSeq: remainingUnread[remainingUnread.length - 1].seq,
      });
    } else {
      afterPostMember.status = 'waiting';
      afterPostMember.pendingWake = false;
      store.upsertMember(swarmId, afterPostMember);
    }
  } else {
    afterPostMember.status = 'waiting';
    store.upsertMember(swarmId, afterPostMember);
  }

  return 'completed';
}
