#!/usr/bin/env node
/**
 * Zero-dependency CLI helper for headless workers to interact with
 * the AGY Ext Swarm shared board mid-turn.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

function usage() {
  console.error(`Usage:
  ext-board post --swarm-dir <dir> --as <name> [--kind message|done|blocker] <text | ->
  ext-board read --swarm-dir <dir> [--since <N>] [--limit <N>]
  ext-board status --swarm-dir <dir>
  ext-board wait --swarm-dir <dir> [--since <N>] [--until all_idle|mentions_coordinator|any_post|worker_done] [--worker <name>] [--timeout <sec>]`);
}

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next === undefined || (next.startsWith('--') && next !== '--')) {
          flags[key] = 'true';
        } else {
          flags[key] = next;
          i++;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function requireSwarmDir(flags) {
  const dir = flags['swarm-dir'] || process.env.EXT_SWARM_DIR || process.env.DSH_SWARM_DIR;
  if (!dir) {
    console.error('Error: --swarm-dir <dir> (or EXT_SWARM_DIR) is required.');
    process.exit(2);
  }
  return dir;
}

function cmdPost(flags, positional) {
  const swarmDir = requireSwarmDir(flags);
  const sender = String(flags.as || process.env.EXT_SWARM_AGENT || process.env.DSH_SWARM_AGENT || '').trim();
  if (!sender) {
    console.error('Error: --as <name> (or EXT_SWARM_AGENT) is required.');
    process.exit(2);
  }
  const kindRaw = String(flags.kind || 'message').trim().toLowerCase();
  let kind = kindRaw === 'done' || kindRaw === 'blocker' ? kindRaw : 'message';

  let text = positional.join(' ');
  if (text === '-') {
    text = readFileSync(0, 'utf8');
  }
  text = text.trim();
  if (!text) {
    console.error('Error: message text cannot be empty.');
    process.exit(2);
  }

  if (kind === 'message') {
    if (/\[blocker\]/i.test(text)) {
      kind = 'blocker';
    } else if (/\[done\]/i.test(text)) {
      kind = 'done';
    }
  }

  if (kind === 'done' && !/\[done\]/i.test(text)) {
    text = `[done] ${text}`;
  } else if (kind === 'blocker' && !/\[blocker\]/i.test(text)) {
    text = `[blocker] ${text}`;
  }

  const inboxDir = join(swarmDir, 'inbox');
  mkdirSync(inboxDir, { recursive: true });

  const ts = String(Date.now()).padStart(14, '0');
  const id = `${ts}-${process.pid}-${randomBytes(4).toString('hex')}`;
  const tmpFile = join(inboxDir, `.${id}.tmp`);
  const targetFile = join(inboxDir, `${id}.json`);

  const payload = {
    agent: sender,
    text,
    kind,
    time: new Date().toISOString(),
  };

  writeFileSync(tmpFile, JSON.stringify(payload) + '\n', 'utf8');
  renameSync(tmpFile, targetFile);
  console.log(JSON.stringify({ ok: true, queued: id, agent: sender, kind }));
}

function readBoardLines(swarmDir) {
  const boardPath = join(swarmDir, 'board.jsonl');
  if (!existsSync(boardPath)) {
    return [];
  }
  const raw = readFileSync(boardPath, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Ignore partial line if concurrent write is in flight.
    }
  }
  return out;
}

function cmdRead(flags) {
  const swarmDir = requireSwarmDir(flags);
  const parsedSince = Number.parseInt(String(flags.since ?? '0'), 10);
  const since = Number.isFinite(parsedSince) && parsedSince >= 0 ? parsedSince : 0;
  const parsedLimit = Number.parseInt(String(flags.limit ?? '50'), 10);
  const limit = Number.isFinite(parsedLimit) && parsedLimit >= 0 ? parsedLimit : 50;
  const messages = readBoardLines(swarmDir).filter((m) => Number(m.seq) > since);
  const sliced = limit > 0 ? messages.slice(-limit) : messages;
  if (sliced.length === 0) {
    console.log('(no new messages)');
    return;
  }
  for (const msg of sliced) {
    console.log(`[#${msg.seq}] (${msg.kind || 'message'}) ${msg.agent} @ ${msg.time}: ${msg.text}`);
  }
}

function cmdStatus(flags) {
  const swarmDir = requireSwarmDir(flags);
  const statePath = join(swarmDir, 'state.json');
  if (!existsSync(statePath)) {
    console.error(`Error: state.json not found in ${swarmDir}`);
    process.exit(1);
  }
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  console.log(`Swarm: ${state.title} (${state.id}) | head=#${state.headSeq ?? 0} | hops=${state.hopCount ?? 0}/${state.maxHops ?? 12}`);
  const members = Object.values(state.members || {});
  for (const m of members) {
    const activity = m.activity ? ` | activity=${m.activity}` : '';
    const model = m.model ? ` | model=${m.model}` : '';
    console.log(`- ${m.name} [${m.status}] role=${m.role} perm=${m.permissionMode} ws=${m.workspaceMode}${model}${activity}`);
  }
}

function isPermissionErr(err) {
  const code = err && typeof err === 'object' ? err.code : undefined;
  return code === 'EPERM' || code === 'EACCES';
}

function exitWatchPermissionError(err, fallbackReason) {
  const detail = err instanceof Error ? err.message : String(err || fallbackReason || 'Permission denied');
  console.error(
    `[ext-board wait] Cannot access swarm directory (${detail}). Fall back to ext_swarm_wait.`,
  );
  process.exit(1);
}

function formatWaitResult({ timedOut, reason, state, newMsgs, elapsedMs }) {
  const MAX_MESSAGES = 50;
  const MAX_TEXT_LEN = 2000;
  const omittedMessageCount = Math.max(0, newMsgs.length - MAX_MESSAGES);
  const recentMsgs = omittedMessageCount > 0 ? newMsgs.slice(-MAX_MESSAGES) : newMsgs;
  const messages = recentMsgs.map((m) => {
    const rawText = typeof m.text === 'string' ? m.text : '';
    const truncated = rawText.length > MAX_TEXT_LEN;
    return {
      seq: m.seq,
      agent: m.agent,
      kind: m.kind || 'message',
      time: m.time,
      text: truncated ? rawText.slice(0, MAX_TEXT_LEN) + '...' : rawText,
      ...(truncated ? { truncated: true } : {}),
    };
  });
  const members = state
    ? Object.values(state.members || {}).map((m) => ({
        name: m.name,
        status: m.status,
        provider: m.provider,
        model: m.model,
        turns: m.turns || 0,
        steps: m.steps || 0,
        ...(m.branch ? { branch: m.branch } : {}),
        ...(m.lastError ? { lastError: m.lastError } : {}),
      }))
    : [];

  return {
    ok: true,
    timedOut,
    reason,
    swarmId: state?.id || null,
    headSeq: state?.headSeq ?? 0,
    elapsedMs,
    members,
    messages,
    ...(omittedMessageCount > 0 ? { omittedMessageCount } : {}),
  };
}

function cmdWait(flags) {
  const swarmDir = requireSwarmDir(flags);
  const statePath = join(swarmDir, 'state.json');
  const validUntils = new Set(['all_idle', 'mentions_coordinator', 'any_post', 'worker_done']);
  const until = String(flags.until || 'all_idle').trim().toLowerCase();
  if (!validUntils.has(until)) {
    console.error(
      `Invalid --until "${flags.until}". Expected all_idle|mentions_coordinator|any_post|worker_done.`,
    );
    process.exit(2);
  }
  const workerName = String(flags.worker || '').trim().toLowerCase();
  if (until === 'worker_done' && !workerName) {
    console.error('Error: --worker <name> is required when --until worker_done.');
    process.exit(2);
  }

  const parsedSince = Number.parseInt(String(flags.since ?? '0'), 10);
  const since = Number.isFinite(parsedSince) && parsedSince >= 0 ? parsedSince : 0;
  let timeoutSec = 3600;
  if (flags.timeout !== undefined) {
    const parsedTimeout = Number.parseInt(String(flags.timeout), 10);
    if (!Number.isFinite(parsedTimeout) || parsedTimeout < 0) {
      console.error(`Invalid --timeout "${flags.timeout}". Expected non-negative integer seconds.`);
      process.exit(2);
    }
    timeoutSec = parsedTimeout;
  }

  if (!existsSync(swarmDir) || !existsSync(statePath)) {
    console.error(
      `[ext-board wait] Swarm state.json not found or inaccessible in "${swarmDir}". Fall back to ext_swarm_wait.`,
    );
    process.exit(1);
  }

  let initialState;
  try {
    initialState = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch (err) {
    if (isPermissionErr(err)) {
      exitWatchPermissionError(err);
    }
    initialState = null;
  }

  const startedAt = Date.now();
  let lastSnapshot = initialState;

  const evaluateMatch = () => {
    if (!existsSync(swarmDir) || !existsSync(statePath)) {
      return { matched: true, reason: 'swarm_deleted', state: lastSnapshot, newMsgs: [] };
    }
    let state;
    try {
      state = JSON.parse(readFileSync(statePath, 'utf8'));
    } catch (err) {
      if (isPermissionErr(err)) {
        return { matched: false, permissionError: err };
      }
      return { matched: false, transient: true };
    }
    lastSnapshot = state;

    let newMsgs;
    try {
      newMsgs = readBoardLines(swarmDir).filter((m) => Number(m.seq) > since);
    } catch (err) {
      if (isPermissionErr(err)) {
        return { matched: false, permissionError: err };
      }
      return { matched: false, transient: true };
    }

    const members = Object.values(state.members || {});
    const nonKilled = members.filter((m) => m.status !== 'killed');
    const allIdle =
      nonKilled.length > 0 &&
      nonKilled.every((m) => m.status === 'waiting' || m.status === 'failed');
    const hasReleasableBlocked = nonKilled.some(
      (m) =>
        m.status === 'blocked' &&
        Array.isArray(m.dependsOn) &&
        m.dependsOn.length > 0 &&
        m.dependsOn.every((d) => {
          const dm = state.members && state.members[d];
          return Boolean(dm && dm.status === 'waiting' && (dm.turns || 0) > 0);
        }),
    );
    const blockedDeadlock =
      !hasReleasableBlocked &&
      nonKilled.length > 0 &&
      nonKilled.every((m) => m.status !== 'working' && m.status !== 'queued') &&
      nonKilled.some((m) => m.status === 'blocked');

    if (until === 'any_post') {
      if (newMsgs.length > 0) {
        return { matched: true, reason: 'new_board_post', state, newMsgs };
      }
      if (allIdle && members.some((m) => (m.turns || 0) > 0)) {
        return { matched: true, reason: 'all_workers_idle', state, newMsgs };
      }
      if (blockedDeadlock) {
        return { matched: true, reason: 'blocked_deadlock', state, newMsgs };
      }
    } else if (until === 'mentions_coordinator') {
      if (
        newMsgs.some(
          (m) =>
            m.agent !== 'coordinator' &&
            (m.mentionsCoordinator || m.all || m.kind === 'error' || m.kind === 'warning'),
        )
      ) {
        return { matched: true, reason: 'mentions_coordinator', state, newMsgs };
      }
      if (allIdle && members.some((m) => (m.turns || 0) > 0)) {
        return { matched: true, reason: 'all_workers_idle', state, newMsgs };
      }
      if (blockedDeadlock) {
        return { matched: true, reason: 'blocked_deadlock', state, newMsgs };
      }
    } else if (until === 'all_idle') {
      if (allIdle) {
        return { matched: true, reason: 'all_workers_idle', state, newMsgs };
      }
      if (blockedDeadlock) {
        return { matched: true, reason: 'blocked_deadlock', state, newMsgs };
      }
    } else if (until === 'worker_done') {
      const target = state.members ? state.members[workerName] : undefined;
      if (!target) {
        return { matched: true, reason: 'worker_not_found', state, newMsgs };
      }
      if (target.status === 'waiting' || target.status === 'failed' || target.status === 'killed') {
        return { matched: true, reason: `worker_${target.status}`, state, newMsgs };
      }
      if (target.status === 'blocked' && blockedDeadlock) {
        return { matched: true, reason: 'blocked_deadlock', state, newMsgs };
      }
    }

    return { matched: false, state, newMsgs };
  };

  const immediate = evaluateMatch();
  if (immediate.permissionError) {
    exitWatchPermissionError(immediate.permissionError);
  }
  if (immediate.matched) {
    console.log(
      JSON.stringify(
        formatWaitResult({
          timedOut: false,
          reason: immediate.reason,
          state: immediate.state,
          newMsgs: immediate.newMsgs,
          elapsedMs: Date.now() - startedAt,
        }),
      ),
    );
    process.exit(0);
  }

  let finished = false;
  let watcher = null;
  let debounceTimer = null;
  let safetyInterval = null;
  let timeoutTimer = null;

  const cleanup = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (safetyInterval) {
      clearInterval(safetyInterval);
      safetyInterval = null;
    }
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    if (watcher) {
      try {
        watcher.close();
      } catch {
        // Ignore close error
      }
      watcher = null;
    }
  };

  const finishExit = (payload, code = 0) => {
    if (finished) return;
    finished = true;
    cleanup();
    if (payload) {
      console.log(JSON.stringify(payload));
    }
    process.exit(code);
  };

  const runCheck = () => {
    if (finished) return;
    const res = evaluateMatch();
    if (res.permissionError) {
      cleanup();
      finished = true;
      exitWatchPermissionError(res.permissionError);
      return;
    }
    if (res.matched) {
      finishExit(
        formatWaitResult({
          timedOut: false,
          reason: res.reason,
          state: res.state,
          newMsgs: res.newMsgs,
          elapsedMs: Date.now() - startedAt,
        }),
        0,
      );
    }
  };

  const scheduleCheck = () => {
    if (finished || debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      runCheck();
    }, 50);
  };

  try {
    watcher = watch(swarmDir, (_eventType, filename) => {
      if (
        filename &&
        filename !== 'state.json' &&
        filename !== 'board.jsonl'
      ) {
        return;
      }
      scheduleCheck();
    });
    watcher.on('error', (err) => {
      if (!existsSync(swarmDir)) {
        runCheck();
        return;
      }
      if (isPermissionErr(err)) {
        cleanup();
        finished = true;
        exitWatchPermissionError(err);
      }
    });
  } catch (err) {
    exitWatchPermissionError(err);
  }

  safetyInterval = setInterval(runCheck, 3000);
  safetyInterval.unref?.();

  if (timeoutSec > 0) {
    timeoutTimer = setTimeout(() => {
      const latest = evaluateMatch();
      if (latest.matched) {
        finishExit(
          formatWaitResult({
            timedOut: false,
            reason: latest.reason,
            state: latest.state,
            newMsgs: latest.newMsgs,
            elapsedMs: Date.now() - startedAt,
          }),
          0,
        );
        return;
      }
      finishExit(
        formatWaitResult({
          timedOut: true,
          reason: 'timeout',
          state: latest.state || lastSnapshot,
          newMsgs: latest.newMsgs || [],
          elapsedMs: Date.now() - startedAt,
        }),
        0,
      );
    }, timeoutSec * 1000);
  }

  const onSignal = () => {
    cleanup();
    process.exit(0);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

const [, , subcmd, ...rest] = process.argv;
if (!subcmd || subcmd === '-h' || subcmd === '--help') {
  usage();
  process.exit(subcmd ? 0 : 2);
}

const { flags, positional } = parseFlags(rest);

switch (subcmd) {
  case 'post':
    cmdPost(flags, positional);
    break;
  case 'read':
    cmdRead(flags);
    break;
  case 'status':
    cmdStatus(flags);
    break;
  case 'wait':
    cmdWait(flags);
    break;
  default:
    console.error(`Unknown subcommand: ${subcmd}`);
    usage();
    process.exit(2);
}
