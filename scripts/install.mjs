#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const serverDir = join(repoRoot, 'server');

function parseArgs(argv) {
  let mode = 'link';
  let pluginsDir = join(homedir(), '.gemini', 'config', 'plugins');
  let uninstall = false;
  let skipBuild = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--copy') {
      mode = 'copy';
    } else if (arg === '--link') {
      mode = 'link';
    } else if (arg === '--uninstall') {
      uninstall = true;
    } else if (arg === '--skip-build') {
      skipBuild = true;
    } else if (arg === '--plugins-dir' && argv[i + 1]) {
      pluginsDir = resolve(argv[++i]);
    } else if (arg.startsWith('--plugins-dir=')) {
      pluginsDir = resolve(arg.slice('--plugins-dir='.length));
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/install.mjs [options]

Options:
  --link                 Symlink repo into Antigravity plugins dir (default)
  --copy                 Copy built plugin files instead of symlinking (helpful on Windows without Developer Mode)
  --plugins-dir <path>   Override target plugins directory (default: ~/.gemini/config/plugins)
  --skip-build           Skip pnpm install/build check
  --uninstall            Remove installed agy-ext-swarm entry from plugins dir
`);
      process.exit(0);
    }
  }
  return { mode, pluginsDir, uninstall, skipBuild };
}

function runCommand(cmd, args, cwd) {
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const targetDir = join(opts.pluginsDir, 'agy-ext-swarm');

  if (opts.uninstall) {
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
      console.log(`Removed ${targetDir}`);
    } else {
      console.log(`Nothing to remove at ${targetDir}`);
    }
    return;
  }

  if (!opts.skipBuild) {
    const distEntry = join(serverDir, 'dist', 'index.mjs');
    const distBoard = join(serverDir, 'dist', 'board.html');
    const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    if (!existsSync(join(serverDir, 'node_modules'))) {
      console.log('[install] Installing server dependencies...');
      runCommand(pnpmCmd, ['install'], serverDir);
    }
    if (!existsSync(distEntry) || !existsSync(distBoard)) {
      console.log('[install] Building AGY Ext Swarm server & single-file UI...');
      runCommand(pnpmCmd, ['build'], serverDir);
    }
  }

  mkdirSync(opts.pluginsDir, { recursive: true });

  try {
    const stat = lstatSync(targetDir);
    if (stat.isSymbolicLink()) {
      const currentTarget = resolve(dirname(targetDir), readlinkSync(targetDir));
      if (currentTarget === repoRoot && opts.mode === 'link') {
        console.log(`Already linked: ${targetDir} -> ${repoRoot}`);
        return;
      }
      rmSync(targetDir, { recursive: true, force: true });
    } else {
      rmSync(targetDir, { recursive: true, force: true });
    }
  } catch {
    // targetDir does not exist yet
  }

  if (opts.mode === 'link') {
    try {
      symlinkSync(repoRoot, targetDir, process.platform === 'win32' ? 'junction' : 'dir');
      console.log(`Installed via symlink/junction: ${targetDir} -> ${repoRoot}`);
      return;
    } catch (err) {
      console.warn(`[install] Symlink failed (${err.message}), falling back to copy...`);
    }
  }

  cpSync(repoRoot, targetDir, {
    recursive: true,
    filter: (src) => {
      const segs = src.split(/[\\/]/);
      if (segs.includes('.git')) return false;
      const srvIdx = segs.lastIndexOf('server');
      if (srvIdx !== -1 && segs[srvIdx + 1] === 'node_modules') return false;
      return true;
    },
  });
  console.log(`Installed via copy to ${targetDir}`);
}

main();
