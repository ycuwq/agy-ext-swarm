import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_DIR = join(import.meta.dirname, '..');
const REPO_ROOT = join(SERVER_DIR, '..');
const INSTALL_SCRIPT = join(REPO_ROOT, 'scripts', 'install.mjs');

const EXPECTED_RUNTIME_FILES = [
  'plugin.json',
  'mcp_config.json',
  'README.md',
  'README.zh-CN.md',
  'LICENSE',
  'assets/logo.svg',
  'assets/preview.svg',
  'bin/ext-board.mjs',
  'rules/AGENTS.md',
  'skills/agy-ext-swarm/SKILL.md',
  'server/dist/index.mjs',
  'server/dist/board.html',
];

const EXPECTED_EXCLUDED_PATHS = [
  'server/node_modules',
  'server/src',
  'server/test',
  'server/dist/index.mjs.map',
  '.git',
];

const EXPECTED_TOOLS = [
  'ext_swarm_create',
  'ext_swarm_providers',
  'ext_swarm_models',
  'ext_swarm_add',
  'ext_swarm_post',
  'ext_swarm_read',
  'ext_swarm_status',
  'ext_swarm_wait',
  'ext_swarm_kill',
  'ext_swarm_update_worker',
  'ext_swarm_merge',
  'ext_swarm_arena',
  'ext_swarm_cross_review',
  'ext_swarm_templates',
  'ext_swarm_apply_template',
  'ext_swarm_delete',
  'ext_swarm_export',
  'ext_swarm_open_board',
  'app_get_snapshot',
  'app_post_message',
  'app_kill_worker',
  'app_get_worker_log',
  'app_bind_conversation',
  'app_set_ui_prefs',
  'app_get_provider_config',
  'app_save_provider_config',
  'app_get_worker_diff',
  'app_retry_worker',
  'app_test_provider',
  'app_delete_swarm',
  'app_export_swarm',
  'app_preview_merge',
  'app_merge_worker',
  'app_create_swarm',
  'app_add_worker',
  'app_start_arena',
  'app_cross_review',
  'app_get_templates',
  'app_save_template',
  'app_apply_template',
];

function runInstallCli(args) {
  return execFileSync(process.execPath, [INSTALL_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

async function main() {
  const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'agy-ext-swarm-standalone-')));
  const pluginsDir = join(tempRoot, 'plugins');
  const installedPluginDir = join(pluginsDir, 'agy-ext-swarm');
  const dataDir = join(tempRoot, 'runtime-data');

  let client;
  try {
    // 1-2. Install via --copy --skip-build into an isolated tmp plugins dir (zero node_modules in hierarchy)
    runInstallCli(['install', '--copy', '--skip-build', '--plugins-dir', pluginsDir]);

    // 3. Verify all runtime files exist and dev/source/node_modules directories are absent
    for (const rel of EXPECTED_RUNTIME_FILES) {
      assert.ok(existsSync(join(installedPluginDir, rel)), `Missing runtime file: ${rel}`);
    }
    for (const rel of EXPECTED_EXCLUDED_PATHS) {
      assert.ok(!existsSync(join(installedPluginDir, rel)), `Excluded path should not be copied: ${rel}`);
    }

    // 4. Verify .data/ preservation across copy upgrades
    const dataMarkerDir = join(installedPluginDir, '.data');
    const dataMarkerFile = join(dataMarkerDir, 'upgrade-marker.txt');
    mkdirSync(dataMarkerDir, { recursive: true });
    writeFileSync(dataMarkerFile, 'preserve-me-v1\n', 'utf8');

    runInstallCli(['install', '--copy', '--skip-build', '--plugins-dir', pluginsDir]);
    assert.ok(existsSync(dataMarkerFile), '.data/upgrade-marker.txt should survive copy upgrade');
    assert.equal(readFileSync(dataMarkerFile, 'utf8'), 'preserve-me-v1\n');

    // 5. Boot standalone dist/index.mjs with zero node_modules and verify MCP tools & board UI
    const standaloneEntry = join(installedPluginDir, 'server', 'dist', 'index.mjs');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [standaloneEntry, `--data-dir=${dataDir}`, `--plugin-root=${installedPluginDir}`],
      cwd: tempRoot,
      stderr: 'pipe',
    });

    client = new Client({ name: 'agy-ext-swarm-standalone-test', version: '0.2.0' });
    await client.connect(transport);

    const toolsRes = await client.listTools();
    const toolNames = toolsRes.tools.map((t) => t.name);
    assert.equal(toolNames.length, EXPECTED_TOOLS.length, `Expected ${EXPECTED_TOOLS.length} tools, got ${toolNames.length}`);
    for (const expectedTool of EXPECTED_TOOLS) {
      assert.ok(toolNames.includes(expectedTool), `Missing expected tool: ${expectedTool}`);
    }

    const resRead = await client.readResource({ uri: 'ui://agy-ext-swarm/board.html' });
    const htmlItem = resRead.contents[0];
    assert.equal(htmlItem.mimeType, 'text/html;profile=mcp-app');
    assert.ok(htmlItem.text.includes('<title>AGY Ext Swarm</title>'), 'board.html should contain AGY Ext Swarm title');

    const providersRes = await client.callTool({ name: 'ext_swarm_providers', arguments: {} });
    assert.ok(!providersRes.isError, `ext_swarm_providers returned error: ${JSON.stringify(providersRes)}`);
    const providersText = providersRes.content.find((c) => c.type === 'text')?.text;
    assert.ok(providersText, 'ext_swarm_providers should return text content');
    const providersPayload = JSON.parse(providersText);
    assert.ok(
      providersPayload && typeof providersPayload.providers === 'object',
      'ext_swarm_providers payload should include providers object',
    );

    await client.close();
    client = undefined;

    // 6. Verify status subcommand
    const statusOut = runInstallCli(['status', '--plugins-dir', pluginsDir]);
    assert.ok(statusOut.includes('agy-ext-swarm'), `Expected agy-ext-swarm in status output:\n${statusOut}`);
    assert.ok(statusOut.includes('Installed: yes'), `Expected Installed: yes in status output:\n${statusOut}`);
    assert.ok(statusOut.includes('Mode: copy'), `Expected Mode: copy in status output:\n${statusOut}`);

    // 7. Verify uninstall subcommand
    runInstallCli(['uninstall', '--plugins-dir', pluginsDir]);
    assert.ok(!existsSync(installedPluginDir), 'Expected installed plugin directory to be removed after uninstall');

    console.log('[standalone.test] ALL STANDALONE ZERO-DEP CHECKS PASSED');
  } finally {
    try {
      await client?.close();
    } catch {
      // Ignore cleanup errors
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[standalone.test] FAILED:', err);
  process.exit(1);
});
