#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_PLUGIN_FILES } from './manifest.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const releaseDir = join(repoRoot, 'release');
const stageRoot = join(releaseDir, 'stage');
const stagePluginDir = join(stageRoot, 'agy-ext-swarm');

const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function run(cmd, args, cwd, extraEnv = {}) {
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
  if (res.error) {
    throw new Error(`Failed to execute ${cmd} ${args.join(' ')}: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with code ${res.status ?? 1}`);
  }
}

function assertVersionConsistency() {
  const pluginManifest = readJson(join(repoRoot, 'plugin.json'));
  const rootPkg = readJson(join(repoRoot, 'package.json'));
  const serverPkg = readJson(join(repoRoot, 'server', 'package.json'));

  const version = pluginManifest.version;
  if (!version || typeof version !== 'string') {
    throw new Error('plugin.json is missing a valid "version" string.');
  }
  if (rootPkg.version !== version) {
    throw new Error(
      `Version mismatch: plugin.json has ${version} but package.json has ${rootPkg.version}`,
    );
  }
  if (serverPkg.version !== version) {
    throw new Error(
      `Version mismatch: plugin.json has ${version} but server/package.json has ${serverPkg.version}`,
    );
  }
  return version;
}

function assertSelfContainedEntrypoint(entryPath) {
  const code = readFileSync(entryPath, 'utf8');
  const nonBuiltin = new Set();
  const staticImportRe =
    /(?:^|[;\n}])\s*import\s*(?:[\w*{}\s,$]*\bfrom\s*)?['"]([^'"]+)['"]/g;
  for (const m of code.matchAll(staticImportRe)) {
    const spec = m[1];
    if (spec && !NODE_BUILTINS.has(spec)) {
      nonBuiltin.add(spec);
    }
  }
  if (nonBuiltin.size > 0) {
    throw new Error(
      `server/dist/index.mjs contains non-builtin static imports: ${[...nonBuiltin].join(', ')}`,
    );
  }
}

function sha256File(filePath) {
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex');
}

function createZipArchive(sourceDirName, sourceParentDir, outZipPath) {
  if (existsSync(outZipPath)) {
    rmSync(outZipPath, { force: true });
  }
  if (process.platform === 'win32') {
    const srcGlob = join(sourceParentDir, sourceDirName);
    run(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Compress-Archive -Path '${srcGlob.replace(/'/g, "''")}' -DestinationPath '${outZipPath.replace(/'/g, "''")}' -Force`,
      ],
      sourceParentDir,
    );
    return;
  }
  run('zip', ['-rq', outZipPath, sourceDirName], sourceParentDir);
}

function main() {
  const version = assertVersionConsistency();
  const tag = `v${version}`;

  const missing = RELEASE_PLUGIN_FILES.filter((rel) => !existsSync(join(repoRoot, rel)));
  if (missing.length > 0) {
    throw new Error(
      `Missing required release files (run pnpm --dir server build first):\n  - ${missing.join('\n  - ')}`,
    );
  }

  assertSelfContainedEntrypoint(join(repoRoot, 'server', 'dist', 'index.mjs'));

  mkdirSync(releaseDir, { recursive: true });
  rmSync(stageRoot, { recursive: true, force: true });
  mkdirSync(stagePluginDir, { recursive: true });

  const archives = [
    `agy-ext-swarm-${tag}.tar.gz`,
    'agy-ext-swarm.tar.gz',
    `agy-ext-swarm-${tag}.zip`,
    'agy-ext-swarm.zip',
  ];

  try {
    for (const relPath of RELEASE_PLUGIN_FILES) {
      const srcPath = join(repoRoot, relPath);
      const destPath = join(stagePluginDir, relPath);
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(srcPath, destPath);
      if (
        process.platform !== 'win32' &&
        (relPath === 'bin/ext-board.mjs' || relPath === 'scripts/install.mjs')
      ) {
        chmodSync(destPath, 0o755);
      }
    }

    const versionedTar = join(releaseDir, `agy-ext-swarm-${tag}.tar.gz`);
    const latestTar = join(releaseDir, 'agy-ext-swarm.tar.gz');
    const versionedZip = join(releaseDir, `agy-ext-swarm-${tag}.zip`);
    const latestZip = join(releaseDir, 'agy-ext-swarm.zip');

    run(
      'tar',
      ['-czf', versionedTar, '-C', stageRoot, 'agy-ext-swarm'],
      repoRoot,
      { COPYFILE_DISABLE: '1' },
    );
    copyFileSync(versionedTar, latestTar);

    createZipArchive('agy-ext-swarm', stageRoot, versionedZip);
    copyFileSync(versionedZip, latestZip);

    const checksumLines = archives.map((name) => {
      const fullPath = join(releaseDir, name);
      return `${sha256File(fullPath)}  ${name}`;
    });
    const sumsPath = join(releaseDir, 'SHA256SUMS.txt');
    writeFileSync(sumsPath, `${checksumLines.join('\n')}\n`, 'utf8');

    console.log(`[package-release] Packaged AGY Ext Swarm ${tag} in ${releaseDir}:`);
    for (const name of [...archives, 'SHA256SUMS.txt']) {
      const size = statSync(join(releaseDir, name)).size;
      console.log(`  - ${name} (${size} bytes)`);
    }
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

main();
