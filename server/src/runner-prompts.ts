import type { BoardMessage, BoardMessageKind, MemberState, SwarmState } from './types.js';

export function inferMessageKind(text: string): BoardMessageKind {
  if (/\[blocker\]/i.test(text)) return 'blocker';
  if (/\[done\]/i.test(text)) return 'done';
  return 'message';
}

export function buildInitialWorkerPrompt(opts: {
  swarm: SwarmState;
  member: MemberState;
  brief: string;
  briefSeq: number;
  swarmDir: string;
  boardCli: string;
}): string {
  const { swarm, member, brief, briefSeq, swarmDir, boardCli } = opts;
  const lines: string[] = [
    `You are worker "${member.name}" (role: ${member.role}) in AGY Ext Swarm "${swarm.title}" (${swarm.id}).`,
    `Working directory: ${member.cwd}`,
    `Permission mode: ${member.permissionMode}`,
    `Your assignment is board post #${briefSeq}.`,
  ];

  if (member.branch) {
    lines.push(
      `Git isolation: You are on dedicated branch "${member.branch}" (base commit ${member.baseRef || 'HEAD'}). Commit your work on this branch when done; do NOT switch branches or touch other worktrees.`,
    );
  }

  if (member.allowedFiles && member.allowedFiles.length > 0) {
    lines.push(
      '',
      member.scopeMode === 'warn'
        ? 'PREFERRED FILE SCOPE (out-of-scope edits will be flagged as warnings for review):'
        : 'STRICT FILE WHITELIST (you MUST ONLY modify or create paths matching these):',
      ...member.allowedFiles.map((f) => `- ${f}`),
      member.scopeMode === 'warn'
        ? 'Avoid edits outside this scope unless strictly needed; any out-of-scope edits are reported to reviewers.'
        : 'Do NOT modify files outside this whitelist.',
    );
  }

  if (member.verifyCommands && member.verifyCommands.length > 0) {
    lines.push(
      '',
      'MANDATORY VERIFICATION COMMANDS (run before reporting [done]):',
      ...member.verifyCommands.map((c) => `- ${c}`),
    );
  }

  lines.push('', 'COLLABORATION PROTOCOL:');
  lines.push(
    '- Report completion with `@coordinator [done] ...` (or `@coordinator [blocker] ...` if blocked). Only @mention another worker if your assignment explicitly specifies a peer handoff.',
    '- Reference prior board posts by sequence number (e.g. `#4`) rather than copying long reports.',
  );

  if (member.permissionMode !== 'read-only') {
    lines.push(
      `- Final stdout auto-posts on exit; use ext-board only for mid-turn interim posts or reading peer posts (lastReadSeq=${member.lastReadSeq}):`,
      `  node "${boardCli}" post --swarm-dir "${swarmDir}" --as "${member.name}" "@coordinator ..." | node "${boardCli}" read --swarm-dir "${swarmDir}" --since ${member.lastReadSeq}`,
    );
  } else {
    lines.push(
      '- You are in headless read-only mode: do not attempt file edits, and do NOT stop to write an approval plan waiting for "Proceed". Run your read-only inspection directly and output your final report immediately.',
    );
  }

  const effectiveTurnTimeout = member.turnTimeoutSeconds ?? swarm.turnTimeoutSeconds;
  lines.push('', 'EXECUTION GUIDELINES:');
  if (effectiveTurnTimeout > 0) {
    lines.push(
      `- Time budget: This turn has a hard limit of ${effectiveTurnTimeout}s (~${Math.max(1, Math.round(effectiveTurnTimeout / 60))} min). Pace exploration so you have enough time left to synthesize and post your final report.`,
    );
  }
  if (member.permissionMode !== 'read-only') {
    lines.push(
      '- Quality bar: Do NOT relax existing test assertions or use `as any` to bypass type errors.',
    );
  }
  lines.push(
    '- Do NOT spawn nested subagents or child multi-agent orchestrators inside this worker (parallelism is already coordinated externally by AGY Ext Swarm).',
    '- Explore efficiently: prefer targeted `rg` and batched file reads over dozens of small sequential shell commands; stop exploring once you have sufficient evidence for your conclusions.',
  );

  lines.push('', 'ASSIGNMENT:', brief);
  return lines.join('\n');
}

export function buildTimeoutConvergencePrompt(opts: {
  member: MemberState;
  turnTimeoutSec: number;
  stepsThisTurn: number;
  swarmDir: string;
  boardCli: string;
}): string {
  const { member, turnTimeoutSec, stepsThisTurn, swarmDir, boardCli } = opts;
  const progressDesc =
    stepsThisTurn > 0
      ? `after ${stepsThisTurn} active step(s)`
      : 'after active tool/output progress';
  const lines: string[] = [
    `[SYSTEM CONVERGENCE NOTICE FOR WORKER "${member.name}"]`,
    `Your previous turn reached the hard timeout (${turnTimeoutSec}s) ${progressDesc}. Your session context has been preserved.`,
    '',
    'IMMEDIATE CONVERGENCE INSTRUCTIONS:',
    '- STOP reading new files, running broad searches, or executing exploratory shell commands.',
    '- Immediately synthesize everything you already inspected or completed in this session.',
    '- Output your final report NOW starting with `@coordinator [done]` (or `@coordinator [blocker]` if critical parts remain unverified, explicitly separating verified findings from unverified gaps).',
  ];

  if (member.permissionMode !== 'read-only') {
    if (member.branch) {
      lines.push(
        `- If you made clean completed edits on branch "${member.branch}", commit them (or explicitly report uncommitted status and what remains).`,
      );
    }
    lines.push(
      `- You may post via: node "${boardCli}" post --swarm-dir "${swarmDir}" --as "${member.name}" "@coordinator [done] ..." (otherwise your final response text is auto-posted on exit).`,
    );
  } else {
    lines.push(
      '- You are in read-only mode: your final response text will automatically be posted to the shared board on exit.',
    );
  }

  return lines.join('\n');
}

export function buildWakeWorkerPrompt(opts: {
  swarm: SwarmState;
  member: MemberState;
  unread: BoardMessage[];
  originalBrief?: BoardMessage;
  swarmDir: string;
  boardCli: string;
}): string {
  const { swarm, member, unread, originalBrief, swarmDir, boardCli } = opts;
  const lines: string[] = [
    `New board messages for worker "${member.name}" in "${swarm.title}":`,
  ];

  if (!member.sessionId) {
    lines.push(
      `Worker context (fresh CLI session): role=${member.role}, cwd=${member.cwd}${member.branch ? `, branch=${member.branch}` : ''}, permission=${member.permissionMode}.`,
    );
    if (originalBrief && !unread.some((u) => u.seq === originalBrief.seq)) {
      lines.push(`Original assignment [#${originalBrief.seq}]: ${originalBrief.text}`);
    }
    const effectiveTurnTimeout = member.turnTimeoutSeconds ?? swarm.turnTimeoutSeconds;
    if (effectiveTurnTimeout > 0) {
      lines.push(
        `- Time budget: ${effectiveTurnTimeout}s hard turn limit; pace work to finish cleanly.`,
      );
    }
    if (member.permissionMode !== 'read-only') {
      if (member.branch) {
        lines.push(`- Commit completed work on branch "${member.branch}" before reporting [done].`);
      }
      lines.push(
        '- Quality bar: Do NOT relax existing test assertions or use `as any` to bypass type errors.',
      );
    }
    lines.push(
      '- Do NOT spawn nested subagents or child multi-agent orchestrators inside this worker.',
    );
  }

  lines.push(
    '',
    ...unread.map((m) => `[#${m.seq}] (${m.kind}) ${m.agent}: ${m.text}`),
    '',
    'Respond to the @mention above and execute only what is requested.',
  );
  if (member.allowedFiles && member.allowedFiles.length > 0) {
    const scopeReminder = member.scopeMode === 'warn'
      ? 'Reminder - expected file scope (out-of-scope edits generate warnings)'
      : 'Reminder - strict file whitelist';
    lines.push(`${scopeReminder}: ${member.allowedFiles.join(', ')}`);
  }
  if (member.verifyCommands && member.verifyCommands.length > 0) {
    lines.push(`Verification commands: ${member.verifyCommands.join(' ; ')}`);
  }
  if (member.permissionMode !== 'read-only') {
    lines.push(
      `Optional mid-turn post: node "${boardCli}" post --swarm-dir "${swarmDir}" --as "${member.name}" "..."`,
    );
  }
  lines.push('Include `@coordinator` (or your assigned peer target) and `[done]` when finished.');
  return lines.join('\n');
}
