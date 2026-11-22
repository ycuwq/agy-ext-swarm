#!/usr/bin/env node
/**
 * Zero-dependency CLI helper for headless workers to interact with
 * the AGY Ext Swarm shared board mid-turn.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

function usage() {
  console.error(`Usage:
  ext-board post --swarm-dir <dir> --as <name> [--kind message|done|blocker] <text | ->
  ext-board read --swarm-dir <dir> [--since <N>] [--limit <N>]
  ext-board status --swarm-dir <dir>`);
}

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
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
  const kind = kindRaw === 'done' || kindRaw === 'blocker' ? kindRaw : 'message';

  let text = positional.join(' ');
  if (text === '-') {
    text = readFileSync(0, 'utf8');
  }
  text = text.trim();
  if (!text) {
    console.error('Error: message text cannot be empty.');
    process.exit(2);
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
  const since = Number.parseInt(String(flags.since ?? '0'), 10) || 0;
  const limit = Number.parseInt(String(flags.limit ?? '50'), 10) || 50;
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
  default:
    console.error(`Unknown subcommand: ${subcmd}`);
    usage();
    process.exit(2);
}
