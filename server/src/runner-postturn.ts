import type { SwarmStore } from './store.js';
import { extractMentions } from './mentions.js';
import { runVerifyCommands } from './runner-process.js';
import { inferMessageKind } from './runner-prompts.js';
import { DEFAULT_VERIFY_TIMEOUT_SECONDS, type MemberState, type SwarmState } from './types.js';
import type { ChildProcess } from 'node:child_process';
import { getWorktreeDiff, snapshotWorktreeChanges } from './worktree.js';

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
  const enforceScope = latestMember.scopeMode !== 'warn';
  const canSelfHeal =
    latestMember.permissionMode !== 'read-only' &&
    (latestMember.maxVerifyRetries ?? 0) > (latestMember.verifyRetriesUsed ?? 0);

  // Mechanical allowed_files check
  if (
    latestMember.workspaceMode === 'worktree' &&
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
      return 'aborted';
    }
    if (diff) {
      latestMember.outOfScopeFiles = diff.outOfScopeFiles;
      detectedOutOfScope = diff.outOfScopeFiles;
      if (diff.outOfScopeFiles.length > 0) {
        store.appendBoardMessage(swarmId, {
          agent: 'system',
          text:
            canSelfHeal && enforceScope
              ? `[allowed-files] Worker "${latestMember.name}" modified files outside allowed_files (will auto-retry): ${diff.outOfScopeFiles.join(', ')}`
              : `@coordinator [warning] Worker "${latestMember.name}" modified files outside allowed_files${enforceScope ? '' : ' (scope_mode=warn)'}: ${diff.outOfScopeFiles.join(', ')}`,
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
    const verifyTimeoutMs =
      (latestMember.verifyTimeoutSeconds ?? DEFAULT_VERIFY_TIMEOUT_SECONDS) * 1000;
    const verifyResults = await runVerifyCommands(
      host.activeVerifyProcs,
      procKey,
      latestMember.cwd,
      latestMember.verifyCommands,
      verifyTimeoutMs,
      {
        SWARM_WORKER_NAME: latestMember.name,
        ...(latestMember.workerIndex !== undefined
          ? { SWARM_WORKER_INDEX: String(latestMember.workerIndex) }
          : {}),
        ...(latestMember.portOffset !== undefined
          ? { SWARM_PORT_OFFSET: String(latestMember.portOffset) }
          : {}),
      },
      () => {
        const member = store.tryGetSwarm(swarmId)?.members[memberName];
        return host.isShuttingDown() || !member || member.status === 'killed';
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

  const hasBlockingScopeViolation = enforceScope && detectedOutOfScope.length > 0;
  const canAutoSnapshot =
    latestMember.permissionMode !== 'read-only' &&
    latestMember.workspaceMode === 'worktree' &&
    Boolean(latestMember.branch) &&
    Boolean(latestSwarm.gitRepoRoot) &&
    (!latestMember.autoVerify || failedVerifyResults.length === 0) &&
    !hasBlockingScopeViolation;
  if (canAutoSnapshot) {
    try {
      const snapRes = await snapshotWorktreeChanges({
        cwd: latestMember.cwd,
        repoRoot: latestSwarm.gitRepoRoot,
        branch: latestMember.branch,
        memberName: latestMember.name,
        allowedFiles: latestMember.allowedFiles,
        scopeMode: latestMember.scopeMode,
      });
      const afterSnapSwarm = store.tryGetSwarm(swarmId);
      const afterSnapMember = afterSnapSwarm?.members[latestMember.name];
      if (afterSnapSwarm && !afterSnapSwarm.deleting && afterSnapMember && afterSnapMember.status !== 'killed') {
        if (snapRes.committed) {
          const shaShort = snapRes.commitSha ? ` (${snapRes.commitSha.slice(0, 7)})` : '';
          const filesPreview =
            snapRes.committedFiles.slice(0, 8).join(', ') +
            (snapRes.committedFiles.length > 8 ? ` (+${snapRes.committedFiles.length - 8} more)` : '');
          store.appendBoardMessage(swarmId, {
            agent: 'system',
            text: `[auto-commit] Snapshot committed ${snapRes.committedFiles.length} verified edit(s) on ${latestMember.branch}${shaShort} for ${latestMember.name}: ${filesPreview}`,
            kind: 'system',
          });
        } else if (snapRes.error) {
          store.appendBoardMessage(swarmId, {
            agent: 'system',
            text: `@coordinator [warning] [auto-commit] Failed to snapshot verified edits for ${latestMember.name} on ${latestMember.branch}: ${snapRes.error}`,
            kind: 'warning',
          });
        }
      }
    } catch (err) {
      const afterSnapSwarm = store.tryGetSwarm(swarmId);
      const afterSnapMember = afterSnapSwarm?.members[latestMember.name];
      if (afterSnapSwarm && !afterSnapSwarm.deleting && afterSnapMember && afterSnapMember.status !== 'killed') {
        const msg = err instanceof Error ? err.message : String(err);
        store.appendBoardMessage(swarmId, {
          agent: 'system',
          text: `@coordinator [warning] [auto-commit] Failed to snapshot verified edits for ${latestMember.name} on ${latestMember.branch}: ${msg}`,
          kind: 'warning',
        });
      }
    }
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
  if (canSelfHeal && (failedVerifyResults.length > 0 || hasBlockingScopeViolation)) {
    const nextUsed = (latestMember.verifyRetriesUsed ?? 0) + 1;
    const maxRetries = latestMember.maxVerifyRetries ?? 0;
    const afterHealSwarm = store.tryGetSwarm(swarmId);
    const afterHealMember = afterHealSwarm?.members[memberName] || latestMember;
    afterHealMember.verifyRetriesUsed = nextUsed;
    afterHealMember.status = 'queued';
    afterHealMember.activity = `auto-fixing verification (${nextUsed}/${maxRetries})...`;
    afterHealMember.lastTurnFinishedAt = latestMember.lastTurnFinishedAt;
    afterHealMember.lastReadSeq = latestMember.lastReadSeq;
    afterHealMember.outOfScopeFiles = latestMember.outOfScopeFiles;
    afterHealMember.lastVerifyResults = latestMember.lastVerifyResults;
    store.upsertMember(swarmId, afterHealMember);

    const failureSections: string[] = [];
    if (hasBlockingScopeViolation) {
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

    store.appendBoardMessage(swarmId, {
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
        maxDeliveredSeq: afterHealMember.lastReadSeq,
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
