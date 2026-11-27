import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { parseEffortFromModelName } from '../shared/model-options.js';
import {
  buildSpawnCommand,
  getProviderConfigSnapshot,
  recordObservedProviderDefault,
  resolveExecutable,
  resolveProviderAdapter,
  sanitizeReasoningEffort,
} from './providers/index.js';
import { finalizeSuccessfulTurn, type PostTurnHost } from './runner-postturn.js';
import { terminateProcessTreeWithEscalation } from './runner-process.js';
import {
  buildTimeoutConvergencePrompt,
  buildWakeWorkerPrompt,
} from './runner-prompts.js';
import { enrichDshFailureReason, isRateLimitOrQuotaError } from './runner-routing.js';
import type { SwarmStore } from './store.js';
import {
  DEFAULT_STALL_TIMEOUT_SECONDS,
  DEFAULT_TURN_TIMEOUT_SECONDS,
  type MemberState,
} from './types.js';
import { buildAugmentedEnv } from './worktree.js';

const INVALID_SESSION_ERROR_RE =
  /(?:empty\s+conversation\s+id|invalid\s+(?:session|conversation)\s*id|(?:session|conversation)\s*(?:id\s*)?(?:not\s+found|expired|missing|unknown|does\s+not\s+exist)|no\s+such\s+(?:session|conversation))/i;

export interface QueuedTask {
  swarmId: string;
  memberName: string;
  overridePrompt?: string;
  maxDeliveredSeq: number;
  isTimeoutConvergence?: boolean;
  overrideTurnTimeoutSeconds?: number;
}

/**
 * Narrow capability surface the turn runner needs from `SwarmRuntime`.
 * Keeping this interface small lets the execution/streaming pipeline live in its
 * own module without importing the runtime implementation.
 */
export interface TurnHost {
  readonly store: SwarmStore;
  readonly boardCli: string;
  procKey(swarmId: string, memberName: string): string;
  trackProcess(key: string, proc: ChildProcessWithoutNullStreams): void;
  untrackProcess(key: string): void;
  dropQueuedTasks(swarmId: string): void;
  enqueueTask(
    task: QueuedTask,
    opts?: { front?: boolean },
  ): void;
  failWorkerSafely(
    swarmId: string,
    memberName: string,
    reasonText: string,
    opts?: { skipFailover?: boolean; currentTurnPrompt?: string },
  ): void;
  tryFailoverWorker(
    swarmId: string,
    member: MemberState,
    reasonDetail: string,
    currentTurnPrompt?: string,
  ): boolean;
  recordProviderFailure(swarmId: string, providerId: string, reasonDetail: string): void;
  propagateBlockedDependencyFailures(swarmId: string): void;
  checkAndReleaseBlockedDependents(swarmId: string): Promise<void>;
  postTurnHost(): PostTurnHost;
}

export async function runWorkerTurn(
  host: TurnHost,
  swarmId: string,
  task: QueuedTask,
): Promise<void> {
  const swarm = host.store.tryGetSwarm(swarmId);
  if (!swarm) return;
  const member = swarm.members[task.memberName];
  if (!member || member.status === 'killed') return;

  let prompt = task.overridePrompt;
  let maxDeliveredSeq = task.maxDeliveredSeq;
  const drainedBoard = !prompt;

  if (!prompt) {
    if (member.pendingBrief) {
      host.store.appendBoardMessage(swarmId, {
        agent: 'coordinator',
        text: `@${member.name} ${member.pendingBrief}`,
        kind: 'brief',
      });
      member.pendingBrief = undefined;
      host.store.upsertMember(swarmId, member);
    }
    const unread = host.store.readBoard(swarmId, member.lastReadSeq, 200);
    if (unread.length === 0) {
      member.status = 'waiting';
      member.pendingWake = false;
      host.store.upsertMember(swarmId, member);
      return;
    }
    maxDeliveredSeq = Math.max(maxDeliveredSeq, unread[unread.length - 1].seq);
    const originalBrief = !member.sessionId
      ? host.store.findWorkerBrief(swarmId, member.name)
      : undefined;
    prompt = buildWakeWorkerPrompt({
      swarm,
      member,
      unread,
      originalBrief,
      swarmDir: host.store.getSwarmDir(swarm.id),
      boardCli: host.boardCli,
    });
  }
  const turnPrompt = prompt;
  const hadSessionAtStart = Boolean(member.sessionId);

  const key = host.procKey(swarmId, member.name);
  let effectiveProfile = swarm.profile || 'headless';
  let effectiveModelProvider: string | undefined = member.modelProvider;
  let adapter: ReturnType<typeof resolveProviderAdapter>;
  let invocation: ReturnType<typeof adapter.buildInvocation>;
  let logPath = '';
  let logStream: WriteStream | undefined;
  let proc: ChildProcessWithoutNullStreams;

  try {
    adapter = resolveProviderAdapter(
      member.provider || 'dsh',
      member.customConfig,
      host.store.dataDir,
      swarm.repoRoot,
    );

    member.status = 'working';
    if (drainedBoard) {
      member.pendingWake = false;
    }
    member.lastError = undefined;
    member.activity = `starting ${adapter.id}...`;
    member.lastTurnStartedAt = new Date().toISOString();
    host.store.upsertMember(swarmId, member);

    const cfgSnap = getProviderConfigSnapshot(host.store.dataDir, swarm.repoRoot, swarm.profile);
    const providerDesc = !member.customConfig
      ? cfgSnap.providers.find((p) => p.id === (member.provider || 'dsh'))
      : undefined;
    effectiveProfile = providerDesc?.profile || swarm.profile || 'headless';
    effectiveModelProvider =
      member.modelProvider || providerDesc?.modelProvider || providerDesc?.detectedModelProvider;

    invocation = adapter.buildInvocation({
      prompt,
      workerName: member.name,
      cwd: member.cwd,
      model: member.model,
      modelProvider: effectiveModelProvider,
      reasoningEffort: member.reasoningEffort,
      fastMode: member.fastMode,
      permissionMode: member.permissionMode,
      sessionId: member.sessionId,
      profile: effectiveProfile,
      swarmDir: host.store.getSwarmDir(swarmId),
      patchesDir: host.store.getPatchesDir(swarmId),
      gitCommonDir: swarm.gitCommonDir,
      boardCli: host.boardCli,
    });

    logPath = join(host.store.getLogsDir(swarmId), `${member.name}.ndjson`);
    mkdirSync(host.store.getLogsDir(swarmId), { recursive: true });
    if (adapter.supportsStreamEvents) {
      logStream = createWriteStream(logPath, { flags: 'a', encoding: 'utf8' });
      logStream.on('error', () => {
        // Best-effort logging
      });
    }

    const swarmDir = host.store.getSwarmDir(swarmId);
    const env = buildAugmentedEnv({
      ...invocation.env,
      EXT_SWARM_DIR: swarmDir,
      EXT_SWARM_AGENT: member.name,
      DSH_SWARM_DIR: swarmDir,
      DSH_SWARM_AGENT: member.name,
      ...(member.workerIndex !== undefined
        ? { SWARM_WORKER_INDEX: String(member.workerIndex) }
        : {}),
      ...(member.portOffset !== undefined ? { SWARM_PORT_OFFSET: String(member.portOffset) } : {}),
    });

    const resolvedCmd = resolveExecutable(invocation.command) || invocation.command;
    const spawnCmd = buildSpawnCommand(resolvedCmd, invocation.args);
    proc = spawn(spawnCmd.command, spawnCmd.args, {
      cwd: member.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      ...(spawnCmd.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    host.trackProcess(key, proc);
  } catch (err) {
    logStream?.end();
    host.untrackProcess(key);
    const msg = err instanceof Error ? err.message : String(err);
    host.failWorkerSafely(swarmId, member.name, msg, { currentTurnPrompt: turnPrompt });
    return;
  }

  const turnStartedHeadSeq = swarm.headSeq;
  const turnTimeoutSec =
    task.overrideTurnTimeoutSeconds !== undefined
      ? Math.max(0, Math.floor(task.overrideTurnTimeoutSeconds))
      : Math.max(
          0,
          member.turnTimeoutSeconds ?? swarm.turnTimeoutSeconds ?? DEFAULT_TURN_TIMEOUT_SECONDS,
        );
  const stallTimeoutSec = Math.max(0, swarm.stallTimeoutSeconds ?? DEFAULT_STALL_TIMEOUT_SECONDS);
  let lastActivityAt = Date.now();
  let timedOutReason = '';
  let timedOutKind: 'hard' | 'stall' | '' = '';
  let timeoutTermination: Promise<void> | undefined;
  let turnTimer: NodeJS.Timeout | undefined;
  let stallInterval: NodeJS.Timeout | undefined;

  const terminateTimedOut = (kind: 'hard' | 'stall', reasonText: string) => {
    if (timedOutReason) return;
    timedOutKind = kind;
    timedOutReason = reasonText;
    timeoutTermination = terminateProcessTreeWithEscalation(proc, 3000);
  };

  if (turnTimeoutSec > 0) {
    turnTimer = setTimeout(() => {
      terminateTimedOut('hard', `Turn exceeded hard timeout (${turnTimeoutSec}s)`);
    }, turnTimeoutSec * 1000);
    turnTimer.unref?.();
  }
  if (stallTimeoutSec > 0) {
    const checkIntervalMs = Math.min(
      10000,
      Math.max(500, Math.floor((stallTimeoutSec * 1000) / 3)),
    );
    stallInterval = setInterval(() => {
      if (Date.now() - lastActivityAt >= stallTimeoutSec * 1000) {
        terminateTimedOut('stall', `Worker stalled (no output for ${stallTimeoutSec}s)`);
      }
    }, checkIntervalMs);
    stallInterval.unref?.();
  }

  proc.stdin?.on('error', () => {
    // Ignore EPIPE when child exits early
  });
  try {
    if (invocation.stdinText !== undefined) {
      proc.stdin.write(invocation.stdinText);
    }
    proc.stdin.end();
  } catch {
    // Process may exit early
  }

  let stdoutBuffer = '';
  let stdoutAll = '';
  let stderrBuffer = '';
  const textChunks: string[] = [];
  let finalText = '';
  let finalReasonKind = '';
  let turnErrorText = '';
  let sawTurnStart = false;
  let sawStepThisTurn = 0;
  let sawToolCallThisTurn = false;

  const handleLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line) return;
    if (logStream) {
      logStream.write(line + '\n');
    }

    const events = adapter.parseStdoutLine(line);
    if (events.length === 0) return;

    const currentSwarm = host.store.tryGetSwarm(swarmId);
    const currentMember = currentSwarm?.members[member.name];
    if (!currentMember || currentMember.status === 'killed') return;

    for (const ev of events) {
      if (ev.type === 'session') {
        currentMember.sessionId = ev.sessionId;
        host.store.upsertMember(swarmId, currentMember);
      } else if (ev.type === 'turn_start') {
        sawTurnStart = true;
        currentMember.turns += 1;
        currentMember.activity = 'thinking...';
        host.store.upsertMember(swarmId, currentMember);
      } else if (ev.type === 'step_start') {
        sawStepThisTurn += 1;
        currentMember.steps += 1;
        currentMember.activity = `step ${currentMember.steps}...`;
        host.store.upsertMember(swarmId, currentMember, { immediate: false });
      } else if (ev.type === 'usage') {
        currentMember.usage.inputTokens += ev.inputTokens;
        currentMember.usage.outputTokens += ev.outputTokens;
        currentMember.usage.totalTokens += ev.totalTokens;
        currentMember.usage.cacheReadTokens += ev.cacheReadTokens;
        if (ev.costUsd !== undefined && Number.isFinite(ev.costUsd) && ev.costUsd >= 0) {
          currentMember.usage.reportedCostUsd =
            (currentMember.usage.reportedCostUsd ?? 0) + ev.costUsd;
        }
        host.store.upsertMember(swarmId, currentMember, { immediate: false });
      } else if (ev.type === 'tool_call') {
        sawToolCallThisTurn = true;
        currentMember.activity = ev.summary;
        host.store.upsertMember(swarmId, currentMember, { immediate: false });
      } else if (ev.type === 'text') {
        textChunks.push(ev.text);
      } else if (ev.type === 'final') {
        if (ev.sessionId) {
          currentMember.sessionId = ev.sessionId;
          host.store.upsertMember(swarmId, currentMember);
        }
        if (ev.text !== undefined) {
          finalText = ev.text;
        }
        if (ev.reasonKind) {
          finalReasonKind = ev.reasonKind;
        }
        if (ev.errorText) {
          turnErrorText = ev.errorText;
        }
      } else if (ev.type === 'meta') {
        let changed = false;
        const rawModel = ev.model?.trim();
        const obsModel = rawModel && rawModel !== 'default' && !/^<[\s\S]*>$/.test(rawModel)
          ? rawModel
          : undefined;
        if (obsModel && obsModel !== currentMember.resolvedModel) {
          currentMember.resolvedModel = obsModel;
          changed = true;
        }
        const obsEffort = sanitizeReasoningEffort(ev.reasoningEffort);
        if (
          obsEffort &&
          !currentMember.reasoningEffort &&
          obsEffort !== currentMember.resolvedReasoningEffort
        ) {
          currentMember.resolvedReasoningEffort = obsEffort;
          changed = true;
        }
        if (
          typeof ev.fastMode === 'boolean' &&
          currentMember.fastMode === undefined &&
          ev.fastMode !== currentMember.resolvedFastMode
        ) {
          currentMember.resolvedFastMode = ev.fastMode;
          changed = true;
        }
        if (changed) {
          host.store.upsertMember(swarmId, currentMember, { immediate: false });
        }
        const configuredEffort = sanitizeReasoningEffort(currentMember.reasoningEffort);
        const modelMayReflectConfiguredEffort = configuredEffort !== undefined &&
          (currentMember.provider === 'agy' || parseEffortFromModelName(obsModel) === configuredEffort);
        if (
          !currentMember.customConfig &&
          currentMember.model === 'default' &&
          obsModel &&
          !modelMayReflectConfiguredEffort
        ) {
          recordObservedProviderDefault(
            currentMember.provider || 'dsh',
            adapter.command,
            {
              model: obsModel,
              ...(!currentMember.reasoningEffort && obsEffort ? { reasoningEffort: obsEffort } : {}),
              ...(currentMember.fastMode === undefined && typeof ev.fastMode === 'boolean'
                ? { fastMode: ev.fastMode }
                : {}),
            },
            currentMember.provider === 'dsh' ? effectiveProfile : undefined,
          );
        }
      } else if (ev.type === 'error') {
        turnErrorText = ev.message;
      }
    }
  };

  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');

  proc.stdout.on('data', (chunk: Buffer) => {
    lastActivityAt = Date.now();
    const str = stdoutDecoder.write(chunk);
    stdoutAll += str;
    if (stdoutAll.length > 262144) {
      stdoutAll = stdoutAll.slice(-262144);
    }
    stdoutBuffer += str;
    let nlIdx = stdoutBuffer.indexOf('\n');
    while (nlIdx !== -1) {
      const line = stdoutBuffer.slice(0, nlIdx);
      stdoutBuffer = stdoutBuffer.slice(nlIdx + 1);
      handleLine(line);
      nlIdx = stdoutBuffer.indexOf('\n');
    }
  });

  proc.stderr.on('data', (chunk: Buffer) => {
    lastActivityAt = Date.now();
    stderrBuffer += stderrDecoder.write(chunk);
    if (stderrBuffer.length > 8000) {
      stderrBuffer = stderrBuffer.slice(-8000);
    }
  });

  proc.on('error', (err) => {
    stderrBuffer += `\nSpawn error: ${err.message}`;
  });

  const finishTurn = async (code: number | null, signal: NodeJS.Signals | null) => {
    if (turnTimer) clearTimeout(turnTimer);
    if (stallInterval) clearInterval(stallInterval);
    await timeoutTermination;
    host.untrackProcess(key);

    const postTurnHost = host.postTurnHost();
    try {
      const trailingOut = stdoutDecoder.end();
      if (trailingOut) {
        stdoutAll += trailingOut;
        stdoutBuffer += trailingOut;
        let nlIdx = stdoutBuffer.indexOf('\n');
        while (nlIdx !== -1) {
          const line = stdoutBuffer.slice(0, nlIdx);
          stdoutBuffer = stdoutBuffer.slice(nlIdx + 1);
          handleLine(line);
          nlIdx = stdoutBuffer.indexOf('\n');
        }
      }
      stderrBuffer += stderrDecoder.end();
      if (stdoutBuffer.trim()) {
        handleLine(stdoutBuffer);
        stdoutBuffer = '';
      }
      logStream?.end();
      logStream = undefined;

      if (!host.store.tryGetSwarm(swarmId)) {
        host.dropQueuedTasks(swarmId);
        return;
      }

      // Flush any ext-board CLI messages written right before exit
      host.store.drainInbox(swarmId);

      const latestSwarm = host.store.tryGetSwarm(swarmId);
      const latestMember = latestSwarm?.members[member.name];
      if (!latestSwarm || !latestMember || postTurnHost.isShuttingDown()) {
        return;
      }

      if (!sawTurnStart) {
        latestMember.turns += 1;
      }

      if (!finalText && adapter.finalizeOutput) {
        const finalized = adapter.finalizeOutput(stdoutAll, textChunks.join(''));
        finalText = finalized.finalText;
        if (finalized.sessionId) latestMember.sessionId = finalized.sessionId;
        if (finalized.reasonKind) finalReasonKind = finalized.reasonKind;
        if (finalized.errorText) turnErrorText = finalized.errorText;
        if (!adapter.supportsStreamEvents && finalText) {
          try {
            appendFileSync(
              logPath,
              JSON.stringify({ type: 'final', reason: { kind: 'completed' }, text: finalText }) + '\n',
              'utf8',
            );
          } catch {
            // Ignore
          }
        }
      }

      if (latestMember.status === 'killed') {
        latestMember.activity = undefined;
        host.store.upsertMember(swarmId, latestMember);
        return;
      }

      const failed =
        Boolean(timedOutReason) ||
        code !== 0 ||
        Boolean(signal) ||
        (finalReasonKind && finalReasonKind !== 'completed');

      if (failed) {
        const recentMsgsBeforeFail = host.store.readBoard(swarmId, turnStartedHeadSeq, 200);
        const postedTerminalSelfThisTurn = recentMsgsBeforeFail.some(
          (m) =>
            m.agent === latestMember.name && (m.kind === 'done' || m.kind === 'blocker'),
        );
        const canAutoConverge =
          timedOutKind === 'hard' &&
          !task.isTimeoutConvergence &&
          Boolean(latestMember.sessionId) &&
          adapter.supportsSessionResume &&
          !postedTerminalSelfThisTurn &&
          (sawStepThisTurn > 0 || sawToolCallThisTurn || textChunks.length > 0);
        if (canAutoConverge) {
          const convergeTimeoutSec =
            turnTimeoutSec < 60
              ? Math.max(2, turnTimeoutSec)
              : Math.min(300, Math.max(120, Math.round(turnTimeoutSec * 0.25)));
          const progressSteps = sawStepThisTurn || latestMember.steps;
          const progressLabel =
            progressSteps > 0 ? `after ${progressSteps} step(s)` : 'after active progress';
          latestMember.status = 'queued';
          latestMember.activity = 'auto-converging after timeout...';
          latestMember.lastError = undefined;
          latestMember.retryTurns += 1;
          latestMember.lastTurnFinishedAt = new Date().toISOString();
          latestMember.lastReadSeq = Math.max(latestMember.lastReadSeq, maxDeliveredSeq);
          host.store.upsertMember(swarmId, latestMember);

          host.store.appendBoardMessage(swarmId, {
            agent: 'system',
            text: `[auto-converge] Worker "${latestMember.name}" reached the ${turnTimeoutSec}s turn timeout ${progressLabel}. Resuming session to synthesize and output final report immediately (timeout=${convergeTimeoutSec}s).`,
            kind: 'system',
          });
          const convergePrompt = buildTimeoutConvergencePrompt({
            member: latestMember,
            turnTimeoutSec,
            stepsThisTurn: progressSteps,
            swarmDir: host.store.getSwarmDir(swarmId),
            boardCli: host.boardCli,
          });
          host.enqueueTask(
            {
              swarmId,
              memberName: latestMember.name,
              overridePrompt: convergePrompt,
              maxDeliveredSeq: latestMember.lastReadSeq,
              isTimeoutConvergence: true,
              overrideTurnTimeoutSeconds: convergeTimeoutSec,
            },
            { front: true },
          );
          return;
        }

        let reasonDetail =
          timedOutReason ||
          turnErrorText ||
          stderrBuffer.trim().split('\n').slice(-6).join(' | ') ||
          `exit code=${code ?? 'null'} signal=${signal ?? 'none'} reason=${finalReasonKind || 'unknown'}`;
        if (latestMember.provider === 'dsh') {
          reasonDetail = enrichDshFailureReason(
            reasonDetail,
            effectiveProfile,
            latestMember.modelProvider || effectiveModelProvider,
          );
        }
        if (isRateLimitOrQuotaError(reasonDetail)) {
          host.recordProviderFailure(swarmId, latestMember.provider || 'dsh', reasonDetail);
        }
        const isUnusableFirstSession =
          !hadSessionAtStart &&
          latestMember.turns <= 1 &&
          ((!sawStepThisTurn && !sawToolCallThisTurn) ||
            /permission\s+denied\s+in\s+headless\s+mode/i.test(reasonDetail));
        if (
          latestMember.sessionId &&
          (INVALID_SESSION_ERROR_RE.test(reasonDetail) || isUnusableFirstSession)
        ) {
          latestMember.sessionId = undefined;
        }
        if (host.tryFailoverWorker(swarmId, latestMember, reasonDetail, turnPrompt)) {
            return;
        }
        latestMember.status = 'failed';
        latestMember.activity = undefined;
        latestMember.lastError = reasonDetail;
        latestMember.lastTurnFinishedAt = new Date().toISOString();
        latestMember.lastReadSeq = Math.max(latestMember.lastReadSeq, maxDeliveredSeq);
        host.store.upsertMember(swarmId, latestMember);

        host.store.appendBoardMessage(swarmId, {
          agent: latestMember.name,
          text: `@coordinator [error] Worker failed: ${reasonDetail.slice(0, 600)}`,
          kind: 'error',
        });
        host.propagateBlockedDependencyFailures(swarmId);
        return;
      }

      const outcome = await finalizeSuccessfulTurn(postTurnHost, {
        swarmId,
        memberName: member.name,
        procKey: key,
        turnStartedHeadSeq,
        maxDeliveredSeq,
        finalText,
        textChunks,
        latestSwarm,
        latestMember,
      });
      if (outcome === 'completed') {
        await host.checkAndReleaseBlockedDependents(swarmId);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      host.failWorkerSafely(swarmId, member.name, `Post-turn handling error: ${msg}`, {
        skipFailover: true,
      });
      return;
    }
  };
  await new Promise<void>((resolveClose, rejectClose) => {
    proc.once('close', (code, signal) => {
      void finishTurn(code, signal).then(resolveClose, rejectClose);
    });
  });
}
