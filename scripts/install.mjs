#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_PLUGIN_FILES } from './manifest.mjs';

const PLUGIN_DIR_NAME = 'agy-ext-swarm';
const MIN_NODE_MAJOR = 20;

const scriptPath = realpathSync(fileURLToPath(import.meta.url));
const __dirname = dirname(scriptPath);
const repoRoot = resolve(__dirname, '..');
const serverDir = join(repoRoot, 'server');

const isInsideNodeModules = /[\\/]node_modules[\\/]/.test(repoRoot);
const isGitCheckout = !isInsideNodeModules && existsSync(join(repoRoot, '.git'));

function getNodeMajorVersion() {
  return Number.parseInt(process.versions.node.split('.')[0] || '0', 10);
}

function readPackageVersion(root) {
  const manifestPath = join(root, 'plugin.json');
  if (!existsSync(manifestPath)) return 'unknown';
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function printHelp() {
  console.log(`Usage: agy-ext-swarm [command] [options]
       node scripts/install.mjs [command] [options]

Commands:
  install                Install or upgrade the plugin (default)
  status                 Show installation status and bundle health
  uninstall              Remove installed ${PLUGIN_DIR_NAME} entry from plugins dir

Options:
  --copy                 Copy self-contained plugin files (default when run via npx or release)
  --link                 Symlink/junction local repo into plugins dir (default in git checkout)
  --build                Force pnpm install/build in a local git checkout before installing
  --skip-build           Skip pnpm install/build check
  --workspace, --project Install into <cwd>/.agents/plugins instead of global plugins dir
  --plugins-dir <path>   Override target plugins directory (default: ~/.gemini/config/plugins)
  --uninstall            Alias for the "uninstall" command
  -v, --version          Print plugin version
  -h, --help             Show this help message`);
}

function parseArgs(argv) {
  let command = 'install';
  let commandSet = false;
  let explicitMode = null;
  let pluginsDir = join(homedir(), '.gemini', 'config', 'plugins');
  let skipBuild = false;
  let forceBuild = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-')) {
      if (!commandSet && (arg === 'install' || arg === 'uninstall' || arg === 'status')) {
        command = arg;
        commandSet = true;
        continue;
      }
      console.error(`Unknown argument: ${arg}`);
      printHelp();
      process.exit(2);
    }

    if (arg === '--copy') {
      explicitMode = 'copy';
    } else if (arg === '--link') {
      explicitMode = 'link';
    } else if (arg === '--uninstall') {
      command = 'uninstall';
      commandSet = true;
    } else if (arg === '--skip-build') {
      skipBuild = true;
    } else if (arg === '--build') {
      forceBuild = true;
    } else if (arg === '--workspace' || arg === '--project') {
      pluginsDir = resolve(process.cwd(), '.agents', 'plugins');
    } else if (arg === '--plugins-dir') {
      const next = argv[i + 1];
      if (!next) {
        console.error('Error: --plugins-dir requires a path argument.');
        process.exit(2);
      }
      pluginsDir = resolve(next);
      i++;
    } else if (arg.startsWith('--plugins-dir=')) {
      const val = arg.slice('--plugins-dir='.length);
      if (!val) {
        console.error('Error: --plugins-dir requires a non-empty path.');
        process.exit(2);
      }
      pluginsDir = resolve(val);
    } else if (arg === '--version' || arg === '-v') {
      console.log(readPackageVersion(repoRoot));
      process.exit(0);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown option: ${arg}`);
      printHelp();
      process.exit(2);
    }
  }

  const mode = explicitMode ?? (isGitCheckout ? 'link' : 'copy');
  if (explicitMode === 'link' && isInsideNodeModules) {
    console.warn(
      '[install] Warning: --link requested from inside node_modules; npm/npx caches may be ephemeral. Prefer --copy.',
    );
  }

  return { command, mode, pluginsDir, skipBuild, forceBuild };
}

function runCommand(cmd, args, cwd) {
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (res.error) {
    console.error(`[install] Failed to run ${cmd} ${args.join(' ')}: ${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

function assertRuntimeBundleReady() {
  const missing = RUNTIME_PLUGIN_FILES.filter((rel) => !existsSync(join(repoRoot, rel)));
  if (missing.length > 0) {
    console.error(
      `[install] Missing required runtime plugin files in ${repoRoot}:\n  - ${missing.join('\n  - ')}`,
    );
    if (isGitCheckout) {
      console.error('[install] Run `cd server && pnpm install && pnpm build` and try again.');
    }
    process.exit(1);
  }
}

function printNextSteps(targetDir, version, upgraded) {
  console.log('');
  console.log(`AGY Ext Swarm v${version} is ${upgraded ? 'updated' : 'installed'} at:`);
  console.log(`  ${targetDir}`);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Open Antigravity Desktop App -> Skills & Customizations to verify "AGY Ext Swarm" is enabled.');
  console.log('  2. If upgrading while Antigravity is running, toggle "AGY Ext Swarm" off and on in Skills & Customizations (or restart Antigravity) to reload the updated MCP server.');
  console.log('  3. Ensure at least one coding CLI (dsh, claude, codex, gemini, agy, or custom) is available in PATH.');
}

function moveDirSafe(src, dest) {
  try {
    renameSync(src, dest);
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'EXDEV') {
      cpSync(src, dest, { recursive: true });
      rmSync(src, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

function copySelfContainedPlugin(targetDir, pluginsDir, relocatedDataDir) {
  const suffix = `${process.pid}-${Date.now()}`;
  const stagingDir = join(pluginsDir, `.${PLUGIN_DIR_NAME}.tmp-${suffix}`);
  const backupDir = join(pluginsDir, `.${PLUGIN_DIR_NAME}.bak-${suffix}`);
  const stagedDataDir = join(stagingDir, '.data');

  let existingStat = null;
  try {
    existingStat = lstatSync(targetDir);
  } catch {
    existingStat = null;
  }
  const hadExisting = existingStat !== null;

  let preservedDataFrom;
  mkdirSync(stagingDir, { recursive: true });
  try {
    for (const relPath of RUNTIME_PLUGIN_FILES) {
      const srcPath = join(repoRoot, relPath);
      const destPath = join(stagingDir, relPath);
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(srcPath, destPath);
      if (process.platform !== 'win32' && relPath === 'bin/ext-board.mjs') {
        chmodSync(destPath, 0o755);
      }
    }

    if (existingStat) {
      renameSync(targetDir, backupDir);
    }
    const oldDataDir =
      relocatedDataDir || (existingStat?.isDirectory() ? join(backupDir, '.data') : undefined);
    if (oldDataDir && existsSync(oldDataDir)) {
      moveDirSafe(oldDataDir, stagedDataDir);
      preservedDataFrom = oldDataDir;
    }
    renameSync(stagingDir, targetDir);
  } catch (err) {
    if (preservedDataFrom && existsSync(stagedDataDir)) {
      try {
        moveDirSafe(stagedDataDir, preservedDataFrom);
      } catch {
        console.warn(`[install] Could not restore .data/ to ${preservedDataFrom}. Preserved it at ${stagedDataDir}.`);
      }
    }

    if (existsSync(backupDir) && !existsSync(targetDir)) {
      try {
        renameSync(backupDir, targetDir);
      } catch {
        // Best-effort restore
      }
    }
    if (!existsSync(stagedDataDir)) {
      rmSync(stagingDir, { recursive: true, force: true });
    }
    throw err;
  }

  if (existsSync(backupDir)) {
    rmSync(backupDir, { recursive: true, force: true });
  }

  const modeLabel = preservedDataFrom ? 'copy (preserved .data/)' : 'copy';
  console.log(`Installed via ${modeLabel} to ${targetDir}`);
  return hadExisting;
}

function cmdStatus(targetDir) {
  console.log(`Plugin path: ${targetDir}`);
  let stat = null;
  try {
    stat = lstatSync(targetDir);
  } catch {
    stat = null;
  }

  if (!stat) {
    console.log('Installed: no');
    return;
  }

  const isLink = stat.isSymbolicLink();
  console.log('Installed: yes');
  console.log(`Mode: ${isLink ? `symlink -> ${readlinkSync(targetDir)}` : 'copy'}`);
  console.log(`Version: ${readPackageVersion(targetDir)}`);

  for (const rel of RUNTIME_PLUGIN_FILES) {
    console.log(`  [${existsSync(join(targetDir, rel)) ? 'ok' : 'missing'}] ${rel}`);
  }
}

function cmdUninstall(targetDir) {
  let exists = false;
  try {
    lstatSync(targetDir);
    exists = true;
  } catch {
    exists = false;
  }
  if (exists) {
    rmSync(targetDir, { recursive: true, force: true });
    console.log(`Removed ${targetDir}`);
  } else {
    console.log(`Nothing to remove at ${targetDir}`);
  }
}

function main() {
  const major = getNodeMajorVersion();
  if (major < MIN_NODE_MAJOR) {
    console.error(
      `[install] Node.js >= ${MIN_NODE_MAJOR} is required (current: ${process.versions.node}).`,
    );
    process.exit(1);
  }

  const opts = parseArgs(process.argv.slice(2));
  const targetDir = join(opts.pluginsDir, PLUGIN_DIR_NAME);

  if (opts.command === 'uninstall') {
    cmdUninstall(targetDir);
    return;
  }

  if (opts.command === 'status') {
    cmdStatus(targetDir);
    return;
  }

  const distEntry = join(serverDir, 'dist', 'index.mjs');
  const distBoard = join(serverDir, 'dist', 'board.html');

  if (
    isGitCheckout &&
    !opts.skipBuild &&
    (opts.forceBuild || !existsSync(distEntry) || !existsSync(distBoard))
  ) {
    const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    if (!existsSync(join(serverDir, 'node_modules'))) {
      console.log('[install] Installing server dependencies...');
      runCommand(pnpmCmd, ['install'], serverDir);
    }
    console.log('[install] Building AGY Ext Swarm server & single-file UI...');
    runCommand(pnpmCmd, ['build'], serverDir);
  }

  assertRuntimeBundleReady();
  mkdirSync(opts.pluginsDir, { recursive: true });

  const version = readPackageVersion(repoRoot);

  if (opts.mode === 'link') {
    let existingStat = null;
    let relocatedDataDir;
    try {
      existingStat = lstatSync(targetDir);
    } catch {
      existingStat = null;
    }

    if (existingStat?.isSymbolicLink()) {
      const currentTarget = resolve(dirname(targetDir), readlinkSync(targetDir));
      if (currentTarget === repoRoot) {
        console.log(`Already linked: ${targetDir} -> ${repoRoot}`);
        printNextSteps(targetDir, version, true);
        return;
      }
      rmSync(targetDir, { recursive: true, force: true });
    } else if (existingStat) {
      if (existingStat.isDirectory()) {
        const oldDataDir = join(targetDir, '.data');
        if (existsSync(oldDataDir)) {
          const repoDataDir = join(repoRoot, '.data');
          if (!existsSync(repoDataDir)) {
            moveDirSafe(oldDataDir, repoDataDir);
            relocatedDataDir = repoDataDir;
            console.log(`[install] Preserved existing .data/ at ${repoDataDir}`);
          } else {
            const dataBackupDir = join(
              opts.pluginsDir,
              `.${PLUGIN_DIR_NAME}.data-bak-${process.pid}-${Date.now()}`,
            );
            moveDirSafe(oldDataDir, dataBackupDir);
            relocatedDataDir = dataBackupDir;
            console.log(`[install] Backed up existing .data/ to ${dataBackupDir}`);
          }
        }
      }
      rmSync(targetDir, { recursive: true, force: true });
    }

    try {
      symlinkSync(repoRoot, targetDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      console.warn(`[install] Symlink failed (${err.message}), falling back to copy...`);
      copySelfContainedPlugin(targetDir, opts.pluginsDir, relocatedDataDir);
      printNextSteps(targetDir, version, existingStat !== null);
      return;
    }
    console.log(`Installed via symlink/junction: ${targetDir} -> ${repoRoot}`);
    printNextSteps(targetDir, version, existingStat !== null);
    return;
  }

  const upgraded = copySelfContainedPlugin(targetDir, opts.pluginsDir);
  printNextSteps(targetDir, version, upgraded);
}

main();
