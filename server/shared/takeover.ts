import type { MemberState } from './types.js';

function quoteShellArg(raw: string): string {
  if (!raw) return "''";
  if (/^[a-zA-Z0-9_./:-]+$/.test(raw)) return raw;
  return `'${raw.replace(/'/g, `'\\''`)}'`;
}

/**
 * Builds a shell command that lets a human take over a worker's workspace and
 * existing CLI session directly in a local terminal.
 */
export function buildTakeoverCommand(member: MemberState): string {
  const cwdPart = `cd ${quoteShellArg(member.cwd || '.')}`;
  const provider = (member.provider || 'dsh').toLowerCase();
  const sid = member.sessionId?.trim();

  if (provider === 'claude') {
    const cmd = sid ? `claude --resume ${quoteShellArg(sid)}` : 'claude';
    return `${cwdPart} && ${cmd}`;
  }
  if (provider === 'codex') {
    const cmd = sid ? `codex resume ${quoteShellArg(sid)}` : 'codex';
    return `${cwdPart} && ${cmd}`;
  }
  if (provider === 'gemini') {
    const cmd = sid ? `gemini --resume ${quoteShellArg(sid)}` : 'gemini';
    return `${cwdPart} && ${cmd}`;
  }
  if (provider === 'dsh') {
    const cmd = sid ? `dsh --session-id ${quoteShellArg(sid)}` : 'dsh';
    return `${cwdPart} && ${cmd}`;
  }
  const customBin = member.customConfig?.command?.trim() || provider;
  return `${cwdPart} && ${quoteShellArg(customBin)}`;
}
