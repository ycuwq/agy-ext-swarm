import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCustomAdapter, getBuiltinAdapter, listDshModels } from '../dist/providers.mjs';

const SERVER_DIR = join(import.meta.dirname, '..');
const PLUGIN_ROOT = join(SERVER_DIR, '..');
const DIST_INDEX = join(SERVER_DIR, 'dist', 'index.mjs');

function runGit(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function parseJsonToolResult(res) {
  assert.ok(!res.isError, `Tool returned error: ${JSON.stringify(res)}`);
  const textItem = res.content.find((c) => c.type === 'text');
  assert.ok(textItem, 'Expected text content in tool result');
  return JSON.parse(textItem.text);
}

function testBuiltinAdapterParsers() {
  const baseCtx = {
    prompt: 'hello world',
    workerName: 'worker-1',
    cwd: '/tmp/wt',
    model: 'test-model',
    permissionMode: 'workspace-write',
    profile: 'headless',
    swarmDir: '/tmp/swarm',
    patchesDir: '/tmp/swarm/patches',
    gitCommonDir: '/tmp/repo/.git',
    boardCli: '/tmp/ext-board.mjs',
  };

  // 1. dsh parser & invocation
  const dsh = getBuiltinAdapter('dsh');
  assert.ok(dsh);
  const dshEvents = [
    ...dsh.parseStdoutLine(JSON.stringify({ type: 'session', sessionId: 'session-123' })),
    ...dsh.parseStdoutLine(JSON.stringify({ type: 'status', phase: 'turn_start', turn: 1 })),
    ...dsh.parseStdoutLine(
      JSON.stringify({ type: 'tool_call', tool: 'bash', input: { command: 'pnpm test' } }),
    ),
    ...dsh.parseStdoutLine(
      JSON.stringify({
        type: 'status',
        phase: 'step_end',
        usage: { inputTokens: 100, cacheReadTokens: 400, outputTokens: 50, totalTokens: 550 },
      }),
    ),
    ...dsh.parseStdoutLine(
      JSON.stringify({ type: 'final', sessionId: 'session-123', reason: { kind: 'completed' }, text: 'OK' }),
    ),
  ];
  assert.equal(dshEvents.find((e) => e.type === 'session')?.sessionId, 'session-123');
  assert.equal(dshEvents.find((e) => e.type === 'tool_call')?.summary, 'bash: pnpm test');
  assert.equal(dshEvents.find((e) => e.type === 'usage')?.cacheReadTokens, 400);
  assert.equal(dshEvents.find((e) => e.type === 'final')?.text, 'OK');

  // 2. claude stream-json parser & invocation
  const claude = getBuiltinAdapter('claude');
  assert.ok(claude);
  const claudeInv = claude.buildInvocation({ ...baseCtx, sessionId: 'cl-abc' });
  assert.ok(claudeInv.args.includes('--resume'));
  assert.ok(claudeInv.args.includes('cl-abc'));
  assert.ok(claudeInv.args.includes('acceptEdits'));
  const claudeEvents = [
    ...claude.parseStdoutLine(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cl-abc' }),
    ),
    ...claude.parseStdoutLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: 'src/index.ts' } },
            { type: 'text', text: 'Done reading' },
          ],
        },
      }),
    ),
    ...claude.parseStdoutLine(
      JSON.stringify({
        type: 'result',
        result: '@coordinator [done] claude ok',
        is_error: false,
        usage: { input_tokens: 200, cache_read_input_tokens: 800, output_tokens: 40 },
      }),
    ),
  ];
  assert.equal(claudeEvents.find((e) => e.type === 'session')?.sessionId, 'cl-abc');
  assert.equal(claudeEvents.find((e) => e.type === 'tool_call')?.summary, 'Read: src/index.ts');
  assert.equal(claudeEvents.find((e) => e.type === 'usage')?.totalTokens, 1040);
  assert.equal(claudeEvents.find((e) => e.type === 'final')?.text, '@coordinator [done] claude ok');

  // 3. codex exec json parser & invocation
  const codex = getBuiltinAdapter('codex');
  assert.ok(codex);
  const codexInvFirst = codex.buildInvocation(baseCtx);
  assert.equal(codexInvFirst.args[0], 'exec');
  assert.ok(codexInvFirst.args.includes('--sandbox'));
  const codexInvResume = codex.buildInvocation({ ...baseCtx, sessionId: 'th-999' });
  assert.deepEqual(codexInvResume.args.slice(0, 3), ['exec', 'resume', 'th-999']);
  const codexEvents = [
    ...codex.parseStdoutLine(JSON.stringify({ type: 'thread.started', thread_id: 'th-999' })),
    ...codex.parseStdoutLine(JSON.stringify({ type: 'turn.started' })),
    ...codex.parseStdoutLine(
      JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'ls -la' } }),
    ),
    ...codex.parseStdoutLine(
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'codex ok' } }),
    ),
    ...codex.parseStdoutLine(
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 150, cached_input_tokens: 350, output_tokens: 25 },
      }),
    ),
  ];
  assert.equal(codexEvents.find((e) => e.type === 'session')?.sessionId, 'th-999');
  assert.equal(codexEvents.find((e) => e.type === 'tool_call')?.summary, 'shell: ls -la');
  assert.equal(codexEvents.find((e) => e.type === 'text')?.text, 'codex ok');
  assert.equal(codexEvents.find((e) => e.type === 'usage')?.cacheReadTokens, 350);

  // 4. gemini stream-json parser & invocation
  const gemini = getBuiltinAdapter('gemini');
  assert.ok(gemini);
  const geminiInv = gemini.buildInvocation(baseCtx);
  assert.ok(geminiInv.args.includes('--output-format'));
  assert.ok(geminiInv.args.includes('--yolo'));
  const geminiEvents = [
    ...gemini.parseStdoutLine(JSON.stringify({ type: 'init', session_id: 'gm-42' })),
    ...gemini.parseStdoutLine(
      JSON.stringify({ type: 'tool_use', tool_name: 'run_shell', parameters: { command: 'npm test' } }),
    ),
    ...gemini.parseStdoutLine(
      JSON.stringify({
        type: 'result',
        response: '@coordinator [done] gemini ok',
        status: 'success',
        stats: { input_tokens: 120, cached: 600, output_tokens: 30, total_tokens: 750 },
      }),
    ),
  ];
  assert.equal(geminiEvents.find((e) => e.type === 'session')?.sessionId, 'gm-42');
  assert.equal(geminiEvents.find((e) => e.type === 'tool_call')?.summary, 'run_shell: npm test');
  assert.equal(geminiEvents.find((e) => e.type === 'usage')?.totalTokens, 750);
  assert.equal(geminiEvents.find((e) => e.type === 'final')?.text, '@coordinator [done] gemini ok');

  // 5. custom NDJSON adapter parser
  const customNdjson = createCustomAdapter('custom-ndjson', {
    command: 'my-cli',
    args: ['--cwd', '{{cwd}}', '--prompt', '{{prompt}}'],
    promptMode: 'arg',
    outputFormat: 'ndjson',
  });
  const customInv = customNdjson.buildInvocation(baseCtx);
  assert.deepEqual(customInv.args, ['--cwd', '/tmp/wt', '--prompt', 'hello world']);
  const customEvents = [
    ...customNdjson.parseStdoutLine(JSON.stringify({ session_id: 'cu-1', type: 'turn_start' })),
    ...customNdjson.parseStdoutLine(JSON.stringify({ type: 'tool_call', tool: 'edit', input: { path: 'a.ts' } })),
    ...customNdjson.parseStdoutLine(JSON.stringify({ type: 'result', result: 'custom done', usage: { input_tokens: 10, output_tokens: 5 } })),
  ];
  assert.equal(customEvents.find((e) => e.type === 'session')?.sessionId, 'cu-1');
  assert.equal(customEvents.find((e) => e.type === 'final')?.text, 'custom done');

  // 6. Verify listDshModels returns empty defaults when profile patch is absent, parses YAML anchors, and invalidates cache on update/delete
  const fakeDshHome = mkdtempSync(join(tmpdir(), 'agy-ext-swarm-empty-dsh-'));
  const prevDshHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = fakeDshHome;
    const emptyCatalog = listDshModels('nonexistent-profile');
    assert.equal(emptyCatalog.exists, false);
    assert.equal(emptyCatalog.defaultProvider, '');
    assert.equal(emptyCatalog.defaultModel, '');
    assert.deepEqual(emptyCatalog.models, []);

    const profDir = join(fakeDshHome, 'profiles', 'testprof');
    mkdirSync(profDir, { recursive: true });
    const ymlPath = join(profDir, 'cordis.patch.yml');
    writeFileSync(
      ymlPath,
      [
        '- id: agent-default-model',
        '  config:',
        '    provider: deepseek',
        '    model: model-a',
        '- id: catalog-holder',
        '  config:',
        '    shared: &shared_cat',
        '      lastCatalog:',
        '        - id: model-a',
        '          name: Model A',
        '    aliasRef: *shared_cat',
      ].join('\n') + '\n',
      'utf8',
    );
    const cat1 = listDshModels('testprof');
    const cat1Cached = listDshModels('testprof');
    assert.equal(cat1.exists, true);
    assert.equal(cat1.defaultProvider, 'deepseek');
    assert.equal(cat1.defaultModel, 'model-a');
    assert.deepEqual(cat1.models.map((m) => m.id), ['model-a']);
    assert.equal(cat1Cached, cat1, 'Expected cached ModelsCatalogResult when cordis.patch.yml unchanged');

    writeFileSync(
      ymlPath,
      [
        '- id: agent-default-model',
        '  config:',
        '    provider: deepseek',
        '    model: model-b',
        '- id: catalog-holder',
        '  config:',
        '    lastCatalog:',
        '      - id: model-a',
        '        name: Model A',
        '      - id: model-b',
        '        name: Model B',
      ].join('\n') + '\n',
      'utf8',
    );
    const bumped = new Date(Date.now() + 2000);
    utimesSync(ymlPath, bumped, bumped);
    const cat2 = listDshModels('testprof');
    assert.equal(cat2.defaultModel, 'model-b');
    assert.deepEqual(cat2.models.map((m) => m.id), ['model-a', 'model-b']);

    rmSync(ymlPath);
    const catDeleted = listDshModels('testprof');
    assert.equal(catDeleted.exists, false);
  } finally {
    if (prevDshHome === undefined) {
      delete process.env.DSH_HOME;
    } else {
      process.env.DSH_HOME = prevDshHome;
    }
    rmSync(fakeDshHome, { recursive: true, force: true });
  }
}

async function main() {
  testBuiltinAdapterParsers();
  console.log('[providers.test] Built-in & custom adapter parser unit checks passed');

  const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'agy-ext-swarm-providers-')));
  const repoDir = join(tempRoot, 'repo');
  const dataDir = join(tempRoot, 'data');
  const fakeAppDataDir = join(tempRoot, 'fake-agy');
  const mockCliPath = join(tempRoot, 'mock-cli.mjs');

  let client;
  try {
    mkdirSync(join(fakeAppDataDir, 'brain'), { recursive: true });
    // 1. Create temp git repo
    mkdirSync(repoDir, { recursive: true });
    runGit(repoDir, ['init']);
    runGit(repoDir, ['config', 'user.email', 'test@example.com']);
    runGit(repoDir, ['config', 'user.name', 'Provider Test']);
    writeFileSync(join(repoDir, 'README.md'), '# Provider Test\n', 'utf8');
    runGit(repoDir, ['add', 'README.md']);
    runGit(repoDir, ['commit', '-m', 'init']);

    // 2. Write a deterministic mock custom CLI executable script (zero tokens / offline)
    writeFileSync(
      mockCliPath,
      `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const mode = process.argv[2] || 'writer';
const prompt = readFileSync(0, 'utf8');
if (mode === 'hang') {
  setTimeout(() => {
    console.log('late');
  }, 15000);
} else if (mode === 'fail') {
  console.error('intentional-mock-failure');
  process.exit(1);
} else if (mode === 'slow') {
  setTimeout(() => {
    writeFileSync(join(process.cwd(), 'upstream.txt'), 'upstream-ready\\n', 'utf8');
    console.log('@coordinator [done] slow upstream finished');
  }, 450);
} else if (mode.startsWith('commit:')) {
  const [, fileName, content] = mode.split(':');
  writeFileSync(join(process.cwd(), fileName || 'work.txt'), (content || 'data') + '\\n', 'utf8');
  execFileSync('git', ['add', fileName || 'work.txt'], { cwd: process.cwd() });
  execFileSync('git', ['-c', 'user.name=Mock', '-c', 'user.email=mock@local', 'commit', '-m', 'mock commit'], {
    cwd: process.cwd(),
  });
  console.log('@coordinator [done] committed ' + (fileName || 'work.txt'));
} else if (mode === 'writer') {
  writeFileSync(join(process.cwd(), 'custom-out.txt'), 'written-by-custom-cli\\n', 'utf8');
  console.log('@reviewer [done] custom cli wrote custom-out.txt');
} else {
  const hasUpstreamTag = prompt.includes('[Upstream Dependencies Completed:');
  console.log('@coordinator [done] reviewer saw prompt len=' + prompt.length + ' upstream=' + hasUpstreamTag);
}
`,
      { mode: 0o755 },
    );

    // Register a custom provider + defaultProvider via repo-level .agy-ext-swarm/providers.json
    mkdirSync(join(repoDir, '.agy-ext-swarm'), { recursive: true });
    writeFileSync(
      join(repoDir, '.agy-ext-swarm', 'providers.json'),
      JSON.stringify(
        {
          defaultProvider: 'mock-reviewer',
          providers: {
            'mock-reviewer': {
              displayName: 'Mock Reviewer CLI',
              command: 'node',
              args: [mockCliPath, 'reviewer'],
              promptMode: 'stdin',
              outputFormat: 'text',
              defaultModel: 'mock-v1',
              models: ['mock-v1', 'mock-v2'],
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    // 3. Connect MCP client
    const transport = new StdioClientTransport({
      command: 'node',
      args: [DIST_INDEX, `--data-dir=${dataDir}`, `--plugin-root=${PLUGIN_ROOT}`],
      env: { ...process.env, ANTIGRAVITY_EXECUTABLE_DATA_DIR: fakeAppDataDir },
      stderr: 'pipe',
    });
    client = new Client({ name: 'providers-test', version: '0.2.0' });
    await client.connect(transport);

    const toolsRes = await client.listTools();
    const toolNames = toolsRes.tools.map((t) => t.name);
    for (const expectedName of [
      'ext_swarm_providers',
      'ext_swarm_update_worker',
      'ext_swarm_merge',
      'ext_swarm_arena',
      'ext_swarm_cross_review',
      'ext_swarm_templates',
      'ext_swarm_apply_template',
      'ext_swarm_delete',
      'ext_swarm_export',
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
    ]) {
      assert.ok(toolNames.includes(expectedName), `Missing tool: ${expectedName}`);
    }
    assert.equal(toolNames.length, 40, `Expected 40 tools, got ${toolNames.length}`);

    const toolByName = new Map(toolsRes.tools.map((t) => [t.name, t]));
    for (const roName of [
      'ext_swarm_providers',
      'ext_swarm_models',
      'ext_swarm_templates',
      'ext_swarm_read',
      'ext_swarm_status',
      'ext_swarm_wait',
      'ext_swarm_export',
      'ext_swarm_open_board',
    ]) {
      const ann = toolByName.get(roName)?.annotations;
      assert.equal(ann?.readOnlyHint, true, `${roName} must have readOnlyHint=true`);
      assert.equal(ann?.destructiveHint, false, `${roName} must have destructiveHint=false`);
    }
    for (const mutName of [
      'ext_swarm_create',
      'ext_swarm_add',
      'ext_swarm_post',
      'ext_swarm_update_worker',
      'ext_swarm_arena',
      'ext_swarm_cross_review',
      'ext_swarm_apply_template',
    ]) {
      const ann = toolByName.get(mutName)?.annotations;
      assert.equal(ann?.readOnlyHint, false, `${mutName} must have readOnlyHint=false`);
      assert.equal(ann?.destructiveHint, false, `${mutName} must have destructiveHint=false`);
    }
    for (const destName of ['ext_swarm_merge', 'ext_swarm_kill', 'ext_swarm_delete']) {
      const ann = toolByName.get(destName)?.annotations;
      assert.equal(ann?.readOnlyHint, false, `${destName} must have readOnlyHint=false`);
      assert.equal(ann?.destructiveHint, true, `${destName} must have destructiveHint=true`);
    }

    // 4. Verify providers list & generalized models query
    const provList = parseJsonToolResult(
      await client.callTool({ name: 'ext_swarm_providers', arguments: { repo_root: repoDir } }),
    );
    assert.equal(provList.defaultProvider, 'mock-reviewer');
    assert.equal(provList.globalConfigExists, false, 'Fresh dataDir should report globalConfigExists=false');
    assert.equal(provList.needsOnboarding, true, 'Fresh dataDir should report needsOnboarding=true');

    // 4a. Onboarding UI prefs persistence & needsOnboarding toggle
    const prefsSkipRes = await client.callTool({
      name: 'app_set_ui_prefs',
      arguments: { locale: 'zh', onboarding_completed: true },
    });
    assert.equal(prefsSkipRes.structuredContent?.uiPrefs?.locale, 'zh');
    assert.equal(prefsSkipRes.structuredContent?.uiPrefs?.onboardingCompleted, true);
    const provAfterSkip = parseJsonToolResult(
      await client.callTool({ name: 'ext_swarm_providers', arguments: { repo_root: repoDir } }),
    );
    assert.equal(provAfterSkip.needsOnboarding, false, 'Skipping onboarding should clear needsOnboarding');

    const prefsResetRes = await client.callTool({
      name: 'app_set_ui_prefs',
      arguments: { onboarding_completed: false },
    });
    assert.equal(prefsResetRes.structuredContent?.uiPrefs?.locale, 'zh', 'Updating onboarding_completed must preserve locale');
    assert.equal(prefsResetRes.structuredContent?.uiPrefs?.onboardingCompleted, false);
    const provAfterReset = parseJsonToolResult(
      await client.callTool({ name: 'ext_swarm_providers', arguments: { repo_root: repoDir } }),
    );
    assert.equal(provAfterReset.needsOnboarding, true);
    await client.callTool({
      name: 'app_set_ui_prefs',
      arguments: { onboarding_completed: true },
    });
    const ids = provList.providers.map((p) => p.id);
    for (const expectedId of ['dsh', 'claude', 'codex', 'gemini', 'mock-reviewer']) {
      assert.ok(ids.includes(expectedId), `Missing provider: ${expectedId}`);
    }
    const mockRevEntry = provList.providers.find((p) => p.id === 'mock-reviewer');
    assert.equal(mockRevEntry.kind, 'custom');

    const revModels = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_models',
        arguments: { provider: 'mock-reviewer', repo_root: repoDir },
      }),
    );
    assert.equal(revModels.defaultModel, 'mock-v1');
    assert.deepEqual(revModels.models, ['mock-v1', 'mock-v2']);

    // 5. Create swarm without default_provider -> should pick "mock-reviewer" from providers.json
    const created = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_create',
        arguments: { title: 'Custom CLI Swarm', repo_root: repoDir },
      }),
    );
    const swarmId = created.swarm.id;
    assert.equal(created.swarm.defaultProvider, 'mock-reviewer');

    // Spawn reviewer using inherited defaultProvider ("mock-reviewer")
    const addRev = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_add',
        arguments: {
          swarm_id: swarmId,
          name: 'reviewer',
          workspace: 'inherit',
          permission_mode: 'read-only',
          brief: 'Stand by for updates.',
        },
      }),
    );
    assert.equal(addRev.added[0].provider, 'mock-reviewer');
    await client.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: swarmId, until: 'all_idle', timeout_seconds: 15 },
    });

    // Spawn writer using inline custom_command in isolated worktree
    const addWriter = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_add',
        arguments: {
          swarm_id: swarmId,
          name: 'writer',
          provider: 'custom',
          custom_command: {
            displayName: 'Inline Mock Writer',
            command: 'node',
            args: [mockCliPath, 'writer'],
            prompt_mode: 'stdin',
            output_format: 'text',
          },
          workspace: 'worktree',
          permission_mode: 'workspace-write',
          allowed_files: ['custom-out.txt'],
          brief: 'Create custom-out.txt',
        },
      }),
    );
    const writerCwd = addWriter.added[0].cwd;
    assert.equal(addWriter.added[0].provider, 'custom');

    // Wait for writer + automatic @reviewer handoff
    const waitRes = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_wait',
        arguments: { swarm_id: swarmId, until: 'all_idle', timeout_seconds: 15 },
      }),
    );
    assert.equal(waitRes.timedOut, false, 'Custom CLI handoff should complete quickly');

    const st = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_status',
        arguments: { swarm_id: swarmId, include_diff: true },
      }),
    );
    assert.equal(st.swarm.members.writer.turns, 1);
    assert.equal(st.swarm.members.reviewer.turns, 2, 'Reviewer should be woken by @reviewer from custom CLI');
    assert.ok(existsSync(join(writerCwd, 'custom-out.txt')), 'custom-out.txt should exist in worktree');
    assert.deepEqual(st.diffs.writer.outOfScopeFiles, []);

    const board = parseJsonToolResult(
      await client.callTool({ name: 'ext_swarm_read', arguments: { swarm_id: swarmId } }),
    );
    assert.ok(
      board.messages.some((m) => m.agent === 'writer' && m.text.includes('custom-out.txt')),
      'Writer custom CLI output should appear on board',
    );
    assert.ok(
      board.messages.some((m) => m.agent === 'reviewer' && m.text.includes('reviewer saw prompt len=')),
      'Reviewer custom CLI wakeup output should appear on board',
    );

    // 6. Verify Settings config persistence (disable CLI, model override, global default, custom CLI add/delete)
    const initialCfgRes = parseJsonToolResult(
      await client.callTool({ name: 'app_get_provider_config', arguments: {} }),
    );
    assert.ok(
      initialCfgRes.providerConfig.providers.every((p) => p.kind === 'custom' || p.enabled === true),
      'Built-in providers should default to enabled=true',
    );

    // Disable codex -> spawning a codex worker must be rejected with clear error
    const disableCodexRes = parseJsonToolResult(
      await client.callTool({
        name: 'app_save_provider_config',
        arguments: {
          upsert_provider: { id: 'codex', config: { enabled: false } },
        },
      }),
    );
    assert.equal(
      disableCodexRes.providerConfig.providers.find((p) => p.id === 'codex')?.enabled,
      false,
    );
    const disabledSpawn = await client.callTool({
      name: 'ext_swarm_add',
      arguments: {
        swarm_id: swarmId,
        name: 'disabled-codex',
        provider: 'codex',
        workspace: 'inherit',
        brief: 'Should fail cleanly',
      },
    });
    assert.equal(disabledSpawn.isError, true, 'Disabled provider spawn should return error');
    assert.match(disabledSpawn.content[0]?.text || '', /disabled/i);

    // Configure claude models + global defaultProvider -> verify ext_swarm_providers & ext_swarm_models match
    await client.callTool({
      name: 'app_save_provider_config',
      arguments: {
        default_provider: 'claude',
        upsert_provider: {
          id: 'claude',
          config: {
            enabled: true,
            defaultModel: 'claude-test-model',
            models: ['claude-test-model', 'claude-fast'],
          },
        },
      },
    });
    const globalProviders = parseJsonToolResult(
      await client.callTool({ name: 'ext_swarm_providers', arguments: {} }),
    );
    assert.equal(globalProviders.defaultProvider, 'claude');
    const claudeDesc = globalProviders.providers.find((p) => p.id === 'claude');
    assert.equal(claudeDesc?.defaultModel, 'claude-test-model');
    assert.deepEqual(claudeDesc?.models, ['claude-test-model', 'claude-fast']);

    const claudeModels = parseJsonToolResult(
      await client.callTool({ name: 'ext_swarm_models', arguments: { provider: 'claude' } }),
    );
    assert.equal(claudeModels.defaultModel, 'claude-test-model');
    assert.deepEqual(claudeModels.models, ['claude-test-model', 'claude-fast']);

    // Add & delete a custom CLI provider -> verify persistence in global providers.json
    await client.callTool({
      name: 'app_save_provider_config',
      arguments: {
        upsert_provider: {
          id: 'mock-ui-cli',
          config: {
            enabled: true,
            displayName: 'Mock UI CLI',
            command: 'node',
            args: [mockCliPath, 'reviewer'],
            defaultModel: 'ui-v1',
            models: ['ui-v1', 'ui-v2'],
          },
        },
      },
    });
    const globalJsonPath = join(dataDir, 'providers.json');
    assert.ok(existsSync(globalJsonPath), 'providers.json should be persisted in dataDir');
    const savedAfterAdd = JSON.parse(readFileSync(globalJsonPath, 'utf8'));
    assert.equal(savedAfterAdd.providers?.['mock-ui-cli']?.defaultModel, 'ui-v1');

    await client.callTool({
      name: 'app_save_provider_config',
      arguments: { remove_provider: 'mock-ui-cli', default_provider: null },
    });
    // Re-enabling built-in codex (even with default displayName/command included) must leave zero override residue
    const reenableCodexRes = await client.callTool({
      name: 'app_save_provider_config',
      arguments: {
        upsert_provider: {
          id: 'codex',
          config: { enabled: true, displayName: 'OpenAI Codex CLI', command: 'codex' },
        },
      },
    });
    assert.equal(
      reenableCodexRes.structuredContent?.providerConfig?.providers?.find((p) => p.id === 'codex')
        ?.hasOverride,
      false,
      'Re-enabling built-in CLI with default fields should clear override cleanly',
    );
    const savedAfterDelete = JSON.parse(readFileSync(globalJsonPath, 'utf8'));
    assert.equal(savedAfterDelete.providers?.['mock-ui-cli'], undefined);
    assert.equal(savedAfterDelete.providers?.codex, undefined);

    // 6b. Atomic batch upsert_providers (first-time onboarding save flow)
    const batchRes = await client.callTool({
      name: 'app_save_provider_config',
      arguments: {
        default_provider: 'claude',
        active_pool: ['dsh', 'claude'],
        routing_policy: {
          writer_providers: ['claude'],
          reader_providers: ['dsh'],
          auto_failover: true,
        },
        upsert_providers: [
          {
            id: 'claude',
            config: {
              enabled: true,
              defaultModel: 'batch-claude',
              models: ['batch-claude', 'batch-sonnet'],
            },
          },
          {
            id: 'gemini',
            config: { enabled: false },
          },
        ],
      },
    });
    const batchCfg = batchRes.structuredContent?.providerConfig;
    assert.equal(batchCfg?.globalConfigExists, true);
    assert.equal(batchCfg?.providers?.find((p) => p.id === 'claude')?.defaultModel, 'batch-claude');
    assert.equal(batchCfg?.providers?.find((p) => p.id === 'gemini')?.enabled, false);
    assert.deepEqual(batchCfg?.activePool, ['dsh', 'claude']);
    assert.equal(batchCfg?.routingPolicy?.autoFailover, true);

    const provAfterBatch = parseJsonToolResult(
      await client.callTool({ name: 'ext_swarm_providers', arguments: {} }),
    );
    assert.equal(provAfterBatch.globalConfigExists, true);
    assert.equal(provAfterBatch.needsOnboarding, false);

    const savedBatchJson = JSON.parse(readFileSync(globalJsonPath, 'utf8'));
    assert.equal(savedBatchJson.providers?.claude?.defaultModel, 'batch-claude');
    assert.equal(savedBatchJson.providers?.gemini?.enabled, false);
    assert.deepEqual(savedBatchJson.activePool, ['dsh', 'claude']);

    await client.callTool({
      name: 'app_save_provider_config',
      arguments: {
        default_provider: null,
        active_pool: null,
        routing_policy: null,
        upsert_providers: [
          { id: 'claude', config: null },
          { id: 'gemini', config: null },
        ],
      },
    });

    // Verify path traversal guard on conversation_id
    const badConvRes = await client.callTool({
      name: 'app_bind_conversation',
      arguments: { swarm_id: swarmId, conversation_id: '../escape' },
    });
    assert.equal(badConvRes.isError, true, 'Invalid conversation_id with path traversal must fail');
    assert.match(badConvRes.content[0]?.text || '', /Invalid/i);

    // 7. Verify Diff Drawer API, in-place Switch/Retry, auto_verify, Test CLI, Pricing, Export & Delete
    // 7a. Full worktree diff including untracked custom-out.txt
    const diffRes = await client.callTool({
      name: 'app_get_worker_diff',
      arguments: { swarm_id: swarmId, name: 'writer' },
    });
    const workerDiff = diffRes.structuredContent?.diff;
    assert.ok(workerDiff?.patch?.includes('diff --git a/custom-out.txt b/custom-out.txt'));
    assert.ok(workerDiff?.patch?.includes('+written-by-custom-cli'));

    // 7b. Switch provider/model & retry in place keeping worktree + branch
    const origBranch = st.swarm.members.writer.branch;
    const updRes = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_update_worker',
        arguments: {
          swarm_id: swarmId,
          name: 'writer',
          provider: 'mock-reviewer',
          model: 'mock-v2',
          prompt: 'Verify files after switch.',
          retry: true,
        },
      }),
    );
    assert.equal(updRes.queued, true);
    assert.equal(updRes.member.cwd, writerCwd, 'Worktree cwd must remain identical on switch');
    assert.equal(updRes.member.branch, origBranch, 'Branch must remain identical on switch');
    assert.equal(updRes.member.model, 'mock-v2');
    await client.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: swarmId, until: 'all_idle', timeout_seconds: 15 },
    });
    const stAfterSwitch = parseJsonToolResult(
      await client.callTool({ name: 'ext_swarm_status', arguments: { swarm_id: swarmId } }),
    );
    assert.equal(stAfterSwitch.swarm.members.writer.turns, 2);
    assert.equal(stAfterSwitch.swarm.members.writer.provider, 'mock-reviewer');

    // 7c. auto_verify deterministic execution (passing & failing commands)
    await client.callTool({
      name: 'ext_swarm_add',
      arguments: {
        swarm_id: swarmId,
        name: 'ver-pass',
        workspace: 'inherit',
        verify_commands: ['node -e "console.log(42)"'],
        auto_verify: true,
        brief: 'Run pass check.',
      },
    });
    await client.callTool({
      name: 'ext_swarm_add',
      arguments: {
        swarm_id: swarmId,
        name: 'ver-fail',
        workspace: 'inherit',
        verify_commands: ['node -e "console.error(\'boom\');process.exit(2)"'],
        auto_verify: true,
        brief: 'Run fail check.',
      },
    });
    await client.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: swarmId, until: 'all_idle', timeout_seconds: 15 },
    });
    const stVerify = parseJsonToolResult(
      await client.callTool({ name: 'ext_swarm_status', arguments: { swarm_id: swarmId } }),
    );
    assert.equal(stVerify.swarm.members['ver-pass'].lastVerifyResults?.[0]?.passed, true);
    assert.equal(stVerify.swarm.members['ver-fail'].lastVerifyResults?.[0]?.passed, false);
    assert.equal(stVerify.swarm.members['ver-fail'].lastVerifyResults?.[0]?.exitCode, 2);
    const boardVerify = parseJsonToolResult(
      await client.callTool({ name: 'ext_swarm_read', arguments: { swarm_id: swarmId } }),
    );
    assert.ok(boardVerify.messages.some((m) => m.text.includes('[auto-verify]') && m.kind === 'system'));
    assert.ok(boardVerify.messages.some((m) => m.text.includes('[auto-verify]') && m.kind === 'warning'));

    // 7d. Provider connection test (success + missing executable diagnostic)
    const testNodeRes = await client.callTool({
      name: 'app_test_provider',
      arguments: { provider_id: 'mock-reviewer', repo_root: repoDir },
    });
    assert.equal(testNodeRes.structuredContent?.result?.ok, true);
    assert.ok(testNodeRes.structuredContent?.result?.version?.startsWith('v'));

    await client.callTool({
      name: 'app_save_provider_config',
      arguments: {
        upsert_provider: {
          id: 'missing-bin-test',
          config: { enabled: true, command: 'definitely-not-installed-xyz-bin-123' },
        },
      },
    });
    const testMissingRes = await client.callTool({
      name: 'app_test_provider',
      arguments: { provider_id: 'missing-bin-test' },
    });
    assert.equal(testMissingRes.structuredContent?.result?.ok, false);
    await client.callTool({
      name: 'app_save_provider_config',
      arguments: { remove_provider: 'missing-bin-test' },
    });

    // 7e. Optional pricing persistence & Markdown report export
    await client.callTool({
      name: 'app_save_provider_config',
      arguments: {
        upsert_pricing: {
          model: 'mock-v2',
          pricing: { inputPer1M: 1.5, cacheReadPer1M: 0.2, outputPer1M: 6, currency: 'USD' },
        },
      },
    });
    const savedPricingFile = JSON.parse(readFileSync(globalJsonPath, 'utf8'));
    assert.equal(savedPricingFile.pricing?.['mock-v2']?.inputPer1M, 1.5);

    const expRes = parseJsonToolResult(
      await client.callTool({ name: 'ext_swarm_export', arguments: { swarm_id: swarmId } }),
    );
    assert.ok(expRes.filename.endsWith('.md'));
    assert.ok(expRes.markdown.includes('# AGY Ext Swarm Report: Custom CLI Swarm'));
    assert.ok(expRes.markdown.includes('## Workers'));
    assert.ok(expRes.markdown.includes('## Message Board Transcript'));
    assert.ok(expRes.markdown.includes('$0.0000'));

    const appExpRes = await client.callTool({
      name: 'app_export_swarm',
      arguments: { swarm_id: swarmId },
    });
    assert.equal(appExpRes.structuredContent?.filename, expRes.filename);

    await client.callTool({
      name: 'app_save_provider_config',
      arguments: { upsert_pricing: { model: 'mock-v2', pricing: null } },
    });

    // 7e-orch. Orchestrator multi-model transcript aggregation & Markdown export breakdown
    const orchLogsDir = join(fakeAppDataDir, 'brain', 'orch-conv-01', '.system_generated', 'logs');
    mkdirSync(orchLogsDir, { recursive: true });
    const futureIso = new Date(Date.now() + 60_000).toISOString();
    writeFileSync(
      join(orchLogsDir, 'transcript.jsonl'),
      [
        JSON.stringify({
          type: 'USER_INPUT',
          source: 'USER_EXPLICIT',
          created_at: futureIso,
          content: '<USER_REQUEST>\nOrchestrator multi-model test\n</USER_REQUEST>',
        }),
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          created_at: futureIso,
          model: 'gemini-4-neon-xhigh',
          input_tokens: 1000,
          cache_read_tokens: 4000,
          output_tokens: 300,
        }),
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          created_at: futureIso,
          model: 'gemini-4-hydrogen',
          input_tokens: 500,
          cache_read_tokens: 4500,
          output_tokens: 200,
        }),
      ].join('\n') + '\n',
      'utf8',
    );
    await client.callTool({
      name: 'app_bind_conversation',
      arguments: { swarm_id: swarmId, conversation_id: 'orch-conv-01' },
    });
    await client.callTool({
      name: 'app_save_provider_config',
      arguments: {
        upsert_pricing: {
          model: 'gemini-4-neon-xhigh',
          pricing: { inputPer1M: 10, cacheReadPer1M: 1, outputPer1M: 30, currency: 'USD' },
        },
      },
    });
    const orchStatus = parseJsonToolResult(
      await client.callTool({ name: 'ext_swarm_status', arguments: { swarm_id: swarmId } }),
    );
    const byModelSince = orchStatus.coordinatorUsage?.byModelSinceSwarm;
    assert.equal(byModelSince?.['gemini-4-neon-xhigh']?.totalTokens, 5300);
    assert.equal(byModelSince?.['gemini-4-neon-xhigh']?.cacheHitRate, 80);
    assert.equal(byModelSince?.['gemini-4-hydrogen']?.totalTokens, 5200);
    assert.equal(byModelSince?.['gemini-4-hydrogen']?.cacheHitRate, 90);

    const orchExp = parseJsonToolResult(
      await client.callTool({ name: 'ext_swarm_export', arguments: { swarm_id: swarmId } }),
    );
    assert.ok(
      orchExp.markdown.includes('Orchestrator / 2 models'),
      'Export markdown should identify Orchestrator multi-model summary',
    );
    assert.ok(
      orchExp.markdown.includes('`gemini-4-neon-xhigh`: 5300 tokens') &&
        orchExp.markdown.includes('est. $0.0230'),
      'Export markdown should include gemini-4-neon-xhigh breakdown and cost estimate',
    );
    assert.ok(
      orchExp.markdown.includes('`gemini-4-hydrogen`: 5200 tokens'),
      'Export markdown should include gemini-4-hydrogen breakdown',
    );
    await client.callTool({
      name: 'app_save_provider_config',
      arguments: { upsert_pricing: { model: 'gemini-4-neon-xhigh', pricing: null } },
    });

    // 7f-pre. Disabling an active worker's provider before follow-up wake must mark worker failed without crashing MCP server
    await client.callTool({
      name: 'app_save_provider_config',
      arguments: {
        upsert_provider: {
          id: 'dis-test-cli',
          config: { enabled: true, command: 'node', args: [mockCliPath, 'reviewer'] },
        },
      },
    });
    await client.callTool({
      name: 'ext_swarm_add',
      arguments: {
        swarm_id: swarmId,
        name: 'dis-worker',
        provider: 'dis-test-cli',
        workspace: 'inherit',
        brief: 'Initial task',
      },
    });
    await client.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: swarmId, until: 'worker_done', worker_name: 'dis-worker', timeout_seconds: 10 },
    });
    await client.callTool({
      name: 'app_save_provider_config',
      arguments: {
        upsert_provider: {
          id: 'dis-test-cli',
          config: { enabled: false, command: 'node', args: [mockCliPath, 'reviewer'] },
        },
      },
    });
    await client.callTool({
      name: 'ext_swarm_post',
      arguments: { swarm_id: swarmId, text: '@dis-worker try again while disabled' },
    });
    const disWait = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_wait',
        arguments: { swarm_id: swarmId, until: 'worker_done', worker_name: 'dis-worker', timeout_seconds: 10 },
      }),
    );
    assert.equal(disWait.swarm.members['dis-worker'].status, 'failed');
    assert.match(disWait.swarm.members['dis-worker'].lastError || '', /disabled/i);
    await client.callTool({
      name: 'app_save_provider_config',
      arguments: { remove_provider: 'dis-test-cli' },
    });

    // 7f. Watchdog stall/timeout termination & app_delete_swarm cleanup
    const wdSwarm = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_create',
        arguments: {
          title: 'Watchdog Test Swarm',
          repo_root: repoDir,
          turn_timeout_seconds: 10,
          stall_timeout_seconds: 1,
        },
      }),
    );
    const wdId = wdSwarm.swarm.id;
    await client.callTool({
      name: 'ext_swarm_add',
      arguments: {
        swarm_id: wdId,
        name: 'hanger',
        provider: 'custom',
        custom_command: {
          command: 'node',
          args: [mockCliPath, 'hang'],
          prompt_mode: 'stdin',
          output_format: 'text',
        },
        workspace: 'inherit',
        brief: 'Hang forever',
      },
    });
    const wdWait = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_wait',
        arguments: { swarm_id: wdId, until: 'worker_done', worker_name: 'hanger', timeout_seconds: 10 },
      }),
    );
    assert.equal(wdWait.timedOut, false, 'Watchdog should kill stalled worker quickly');
    assert.equal(wdWait.swarm.members.hanger.status, 'failed');
    assert.match(wdWait.swarm.members.hanger.lastError || '', /stalled|timeout/i);

    const delWdRes = await client.callTool({
      name: 'app_delete_swarm',
      arguments: { swarm_id: wdId, remove_worktrees: true },
    });
    assert.equal(delWdRes.structuredContent?.deletedSwarmId, wdId);
    assert.ok(!existsSync(join(dataDir, 'swarms', wdId)), 'Deleted swarm directory should be removed');

    // 8. Verify bilingual UI preferences persistence, Settings DOM & resource URI
    const resRead = await client.readResource({ uri: 'ui://agy-ext-swarm/board.html' });
    assert.equal(resRead.contents[0].mimeType, 'text/html;profile=mcp-app');
    const boardHtml = resRead.contents[0].text;
    assert.ok(boardHtml.includes('<title>AGY Ext Swarm</title>'));
    assert.ok(boardHtml.includes('tab-settings'), 'UI bundle should include Settings tab');
    assert.ok(
      boardHtml.includes('settings-providers-list'),
      'UI bundle should include settings-providers-list',
    );
    assert.ok(boardHtml.includes('diff-drawer'), 'UI bundle should include diff-drawer');
    assert.ok(boardHtml.includes('data-preset'), 'UI bundle should include custom CLI presets');
    assert.ok(
      boardHtml.includes('settings-pricing-section'),
      'UI bundle should include pricing section',
    );
    assert.ok(boardHtml.includes('Orchestrator'), 'UI bundle should include Orchestrator labels');
    for (const uiId of [
      'commander-bar',
      'cmd-panel-create',
      'cmd-panel-add',
      'cmd-panel-arena',
      'cmd-panel-templates',
      'arena-boards',
      'settings-routing-card',
      'create-swarm-pool',
      'add-worker-providers',
      'tpl-role-grid',
      'arena-quick-picks',
      'onboarding-host',
      'settings-open-onboarding',
    ]) {
      assert.ok(boardHtml.includes(uiId), `UI bundle should include ${uiId}`);
    }
    assert.ok(boardHtml.length < 950 * 1024, `UI bundle exceeded 950 KB (${boardHtml.length})`);
    assert.equal(
      /<(script|link)\b[^>]*(src|href)\s*=\s*["']https?:\/\//i.test(boardHtml),
      false,
      'UI bundle must remain free of external script/link tags',
    );

    await client.callTool({ name: 'app_set_ui_prefs', arguments: { locale: 'en' } });
    const snap = await client.callTool({ name: 'app_get_snapshot', arguments: { swarm_id: swarmId } });
    assert.equal(snap.structuredContent?.uiPrefs?.locale, 'en');
    assert.equal(
      snap.structuredContent?.uiPrefs?.onboardingCompleted,
      true,
      'Setting locale must preserve onboardingCompleted flag',
    );
    assert.ok(snap.structuredContent?.providerConfig?.providers?.length >= 4);
    assert.ok((snap.structuredContent?.templatesConfig?.templates?.length || 0) >= 3);

    // 8b. Merge Preview (clean + conflict detection, zero working-tree side effects) & Safe Merge (#1)
    const featureRepo = join(tempRoot, 'feature-repo');
    mkdirSync(featureRepo, { recursive: true });
    runGit(featureRepo, ['init']);
    runGit(featureRepo, ['config', 'user.email', 'test@example.com']);
    runGit(featureRepo, ['config', 'user.name', 'Feature Test']);
    writeFileSync(join(featureRepo, 'base.txt'), 'base-v1\n', 'utf8');
    writeFileSync(join(featureRepo, 'shared.txt'), 'line-1\n', 'utf8');
    runGit(featureRepo, ['add', 'base.txt', 'shared.txt']);
    runGit(featureRepo, ['commit', '-m', 'init feature repo']);

    await client.callTool({
      name: 'app_save_provider_config',
      arguments: {
        upsert_provider: {
          id: 'mock-ui-cli',
          config: {
            enabled: true,
            command: 'node',
            args: [mockCliPath, 'writer'],
            promptMode: 'stdin',
            outputFormat: 'text',
          },
        },
      },
    });

    const appCreateRes = await client.callTool({
      name: 'app_create_swarm',
      arguments: {
        repo_root: featureRepo,
        title: 'Feature Suite Swarm',
        default_provider: 'mock-ui-cli',
      },
    });
    assert.ok(!appCreateRes.isError, 'app_create_swarm should succeed');
    const featSwarmId = appCreateRes.structuredContent?.swarm?.id;
    assert.ok(featSwarmId, 'Expected featSwarmId from app_create_swarm');

    // UI-direct app_add_worker test
    const uiAddRes = await client.callTool({
      name: 'app_add_worker',
      arguments: {
        swarm_id: featSwarmId,
        name: 'clean-wt',
        workspace: 'worktree',
        brief: 'Add clean-feature.txt',
      },
    });
    assert.ok(!uiAddRes.isError, 'app_add_worker should succeed');
    await client.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: featSwarmId, until: 'worker_done', worker_name: 'clean-wt', timeout_seconds: 15 },
    });
    await client.callTool({
      name: 'ext_swarm_kill',
      arguments: { swarm_id: featSwarmId, name: 'clean-wt', remove_worktree: true },
    });
    await client.callTool({
      name: 'app_save_provider_config',
      arguments: { remove_provider: 'mock-ui-cli' },
    });

    await client.callTool({
      name: 'ext_swarm_add',
      arguments: {
        swarm_id: featSwarmId,
        name: 'clean-wt-2',
        provider: 'custom',
        workspace: 'worktree',
        custom_command: {
          command: 'node',
          args: [mockCliPath, 'commit:added-by-worker.txt:hello-merge'],
          prompt_mode: 'stdin',
          output_format: 'text',
        },
        brief: 'Create added-by-worker.txt',
      },
    });
    await client.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: featSwarmId, until: 'worker_done', worker_name: 'clean-wt-2', timeout_seconds: 15 },
    });
    const cleanPreviewRes = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_merge',
        arguments: { swarm_id: featSwarmId, worker: 'clean-wt-2', action: 'preview' },
      }),
    );
    assert.equal(cleanPreviewRes.preview.canCleanMerge, true, 'Expected clean merge preview');
    assert.ok(cleanPreviewRes.preview.changedFiles.includes('added-by-worker.txt'));
    assert.equal(existsSync(join(featureRepo, 'added-by-worker.txt')), false, 'Preview must have zero working-tree side effects');

    const cleanMergeRes = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_merge',
        arguments: {
          swarm_id: featSwarmId,
          worker: 'clean-wt-2',
          action: 'apply',
          mode: 'squash',
          remove_worktree: true,
        },
      }),
    );
    assert.equal(cleanMergeRes.merged, true);
    assert.ok(cleanMergeRes.commitSha);
    assert.equal(cleanMergeRes.worktreeRemoved, true);
    assert.equal(readFileSync(join(featureRepo, 'added-by-worker.txt'), 'utf8').trim(), 'hello-merge');

    // Conflict preview & blocked merge worker
    await client.callTool({
      name: 'ext_swarm_add',
      arguments: {
        swarm_id: featSwarmId,
        name: 'conflict-wt',
        provider: 'custom',
        workspace: 'worktree',
        custom_command: {
          command: 'node',
          args: [mockCliPath, 'commit:shared.txt:worker-change'],
          prompt_mode: 'stdin',
          output_format: 'text',
        },
        brief: 'Edit shared.txt in worktree',
      },
    });
    await client.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: featSwarmId, until: 'worker_done', worker_name: 'conflict-wt', timeout_seconds: 15 },
    });
    // Advance main branch conflictingly on shared.txt
    writeFileSync(join(featureRepo, 'shared.txt'), 'main-conflicting-change\n', 'utf8');
    runGit(featureRepo, ['add', 'shared.txt']);
    runGit(featureRepo, ['commit', '-m', 'main diverges on shared.txt']);

    const conflictPreviewRes = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_merge',
        arguments: { swarm_id: featSwarmId, worker: 'conflict-wt', action: 'preview' },
      }),
    );
    assert.equal(conflictPreviewRes.preview.canCleanMerge, false, 'Expected conflict preview to detect conflict');
    assert.ok(
      conflictPreviewRes.preview.conflictFiles.includes('shared.txt'),
      `Expected shared.txt in conflictFiles, got ${JSON.stringify(conflictPreviewRes.preview.conflictFiles)}`,
    );
    assert.equal(
      readFileSync(join(featureRepo, 'shared.txt'), 'utf8'),
      'main-conflicting-change\n',
      'Conflict preview must not modify main working tree',
    );
    const conflictApplyRes = await client.callTool({
      name: 'ext_swarm_merge',
      arguments: { swarm_id: featSwarmId, worker: 'conflict-wt', action: 'apply' },
    });
    assert.equal(conflictApplyRes.isError, true, 'Conflicting merge apply should be rejected cleanly');
    assert.equal(runGit(featureRepo, ['status', '--porcelain']), '', 'Main repo index must stay completely clean');

    // 8c. DAG depends_on orchestration & upstream failure propagation (#2)
    await client.callTool({
      name: 'ext_swarm_add',
      arguments: {
        swarm_id: featSwarmId,
        name: 'up-slow',
        provider: 'custom',
        workspace: 'worktree',
        custom_command: {
          command: 'node',
          args: [mockCliPath, 'slow'],
          prompt_mode: 'stdin',
          output_format: 'text',
        },
        brief: 'Produce upstream output slowly',
      },
    });
    const addBlockedRes = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_add',
        arguments: {
          swarm_id: featSwarmId,
          name: 'down-blocked',
          provider: 'custom',
          workspace: 'inherit',
          depends_on: ['up-slow'],
          custom_command: {
            command: 'node',
            args: [mockCliPath, 'reviewer'],
            prompt_mode: 'stdin',
            output_format: 'text',
          },
          brief: 'Consume upstream output',
        },
      }),
    );
    assert.equal(addBlockedRes.added[0].status, 'blocked', 'Dependent worker must start as blocked');

    // Post @all while up-slow is still working -> down-blocked must stay blocked!
    await client.callTool({
      name: 'ext_swarm_post',
      arguments: { swarm_id: featSwarmId, text: '@all status check while upstream active' },
    });
    const midSt = parseJsonToolResult(
      await client.callTool({ name: 'ext_swarm_status', arguments: { swarm_id: featSwarmId } }),
    );
    assert.equal(midSt.swarm.members['down-blocked'].status, 'blocked', '@all must not unblock DAG worker early');

    const dagWait = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_wait',
        arguments: { swarm_id: featSwarmId, until: 'worker_done', worker_name: 'down-blocked', timeout_seconds: 15 },
      }),
    );
    assert.equal(dagWait.timedOut, false);
    assert.equal(dagWait.swarm.members['up-slow'].status, 'waiting');
    assert.equal(dagWait.swarm.members['down-blocked'].status, 'waiting');
    const dagBoard = parseJsonToolResult(
      await client.callTool({ name: 'ext_swarm_read', arguments: { swarm_id: featSwarmId, since: 0, limit: 200 } }),
    );
    assert.ok(
      dagBoard.messages.some((m) => m.agent === 'down-blocked' && m.text.includes('upstream=true')),
      'Released DAG worker must receive upstream completion summary',
    );

    // Upstream failure propagation
    await client.callTool({
      name: 'ext_swarm_add',
      arguments: {
        swarm_id: featSwarmId,
        name: 'up-fail',
        provider: 'custom',
        workspace: 'inherit',
        custom_command: {
          command: 'node',
          args: [mockCliPath, 'slow'],
          prompt_mode: 'stdin',
          output_format: 'text',
        },
        brief: 'Will be killed',
      },
    });
    await client.callTool({
      name: 'ext_swarm_add',
      arguments: {
        swarm_id: featSwarmId,
        name: 'down-never',
        provider: 'custom',
        workspace: 'inherit',
        depends_on: ['up-fail'],
        custom_command: {
          command: 'node',
          args: [mockCliPath, 'reviewer'],
          prompt_mode: 'stdin',
          output_format: 'text',
        },
        brief: 'Depends on up-fail',
      },
    });
    await client.callTool({
      name: 'ext_swarm_kill',
      arguments: { swarm_id: featSwarmId, name: 'up-fail' },
    });
    const deadWait = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_wait',
        arguments: { swarm_id: featSwarmId, until: 'all_idle', timeout_seconds: 10 },
      }),
    );
    assert.equal(deadWait.timedOut, false, 'Deadlocked blocked dependent must fail immediately without hanging wait');
    assert.equal(deadWait.swarm.members['down-never'].status, 'failed');
    assert.match(deadWait.swarm.members['down-never'].lastError || '', /up-fail/i);

    // 8d. Multi-CLI Arena & Cross-Vendor Auto Review (#4)
    for (const provId of ['arena-cli-a', 'arena-cli-b']) {
      await client.callTool({
        name: 'app_save_provider_config',
        arguments: {
          upsert_provider: {
            id: provId,
            config: {
              enabled: true,
              displayName: provId,
              command: 'node',
              args: [mockCliPath, `commit:${provId}.txt:from-${provId}`],
              promptMode: 'stdin',
              outputFormat: 'text',
              defaultModel: `${provId}-model`,
            },
          },
        },
      });
    }
    const arenaRes = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_arena',
        arguments: {
          swarm_id: featSwarmId,
          base_name: 'race',
          task: 'Solve arena challenge cleanly',
          contestants: [{ provider: 'arena-cli-a' }, { provider: 'arena-cli-b' }],
        },
      }),
    );
    assert.equal(arenaRes.contestants.length, 2);
    assert.equal(arenaRes.arenaGroup, 'race');
    await client.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: featSwarmId, until: 'all_idle', timeout_seconds: 15 },
    });

    const reviewRes = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_cross_review',
        arguments: {
          swarm_id: featSwarmId,
          target_worker: arenaRes.contestants[0].name,
        },
      }),
    );
    assert.equal(reviewRes.reviewer.permissionMode, 'read-only');
    assert.notEqual(
      reviewRes.reviewerProvider,
      arenaRes.contestants[0].provider,
      'Cross-review must auto-pick a different provider when available',
    );
    await client.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: featSwarmId, until: 'worker_done', worker_name: reviewRes.reviewer.name, timeout_seconds: 15 },
    });

    for (const provId of ['arena-cli-a', 'arena-cli-b']) {
      await client.callTool({
        name: 'app_save_provider_config',
        arguments: { remove_provider: provId },
      });
    }

    // 8e. Team Templates & UI-direct apply (#5)
    const tplListRes = parseJsonToolResult(
      await client.callTool({ name: 'ext_swarm_templates', arguments: { swarm_id: featSwarmId } }),
    );
    const builtinIds = tplListRes.templates.map((t) => t.id);
    for (const bId of ['feature-squad', 'bug-hunt', 'doc-and-test']) {
      assert.ok(builtinIds.includes(bId), `Missing built-in template: ${bId}`);
    }

    const saveTplRes = await client.callTool({
      name: 'app_save_template',
      arguments: {
        upsert_template: {
          id: 'custom-pair',
          name: 'Custom Two-Step Pair',
          description: 'Implement then review',
          workers: [
            {
              name: 'coder',
              role: 'Coder',
              workspace: 'worktree',
              permission: 'workspace-write',
              brief: 'Implement goal: {{goal}}',
            },
            {
              name: 'auditor',
              role: 'Auditor',
              workspace: 'inherit',
              permission: 'read-only',
              dependsOn: ['coder'],
              brief: 'Audit @coder for: {{goal}}',
            },
          ],
        },
      },
    });
    assert.ok(
      saveTplRes.structuredContent?.templatesConfig?.templates?.some((t) => t.id === 'custom-pair'),
    );

    const tplRepoDir = join(tempRoot, 'tpl-repo');
    mkdirSync(tplRepoDir, { recursive: true });
    runGit(tplRepoDir, ['init']);
    runGit(tplRepoDir, ['config', 'user.email', 'test@example.com']);
    runGit(tplRepoDir, ['config', 'user.name', 'Template Test']);
    writeFileSync(join(tplRepoDir, 'app.ts'), 'export const x = 1;\n', 'utf8');
    runGit(tplRepoDir, ['add', 'app.ts']);
    runGit(tplRepoDir, ['commit', '-m', 'init']);

    await client.callTool({
      name: 'app_save_provider_config',
      arguments: {
        upsert_provider: {
          id: 'tpl-cli',
          config: {
            enabled: true,
            command: 'node',
            args: [mockCliPath, 'reviewer'],
            promptMode: 'stdin',
            outputFormat: 'text',
          },
        },
      },
    });

    const applyTplRes = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_apply_template',
        arguments: {
          template_id: 'custom-pair',
          goal: 'Verify {{goal}} injection',
          repo_root: tplRepoDir,
          provider_overrides: { coder: 'tpl-cli', auditor: 'tpl-cli' },
        },
      }),
    );
    assert.equal(applyTplRes.added.length, 2);
    const tplSwarmId = applyTplRes.swarmId;
    await client.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: tplSwarmId, until: 'worker_done', worker_name: 'auditor', timeout_seconds: 15 },
    });
    await client.callTool({ name: 'app_save_template', arguments: { remove_template_id: 'custom-pair' } });
    await client.callTool({ name: 'app_save_provider_config', arguments: { remove_provider: 'tpl-cli' } });
    await client.callTool({ name: 'ext_swarm_delete', arguments: { swarm_id: tplSwarmId, remove_worktrees: true } });
    await client.callTool({ name: 'ext_swarm_delete', arguments: { swarm_id: featSwarmId, remove_worktrees: true } });

    // 8f. Multi-CLI working pool, role routing, multi-CLI sharding/fan-out, and auto-failover
    const nodeExecPath = process.execPath;
    for (const [id, arg] of [
      ['pool-w1', 'writer'],
      ['pool-w2', 'writer'],
      ['pool-r1', 'reviewer'],
      ['pool-fail', 'fail'],
    ]) {
      await client.callTool({
        name: 'app_save_provider_config',
        arguments: {
          upsert_provider: {
            id,
            config: {
              enabled: true,
              displayName: id,
              command: nodeExecPath,
              args: [mockCliPath, arg],
              promptMode: 'stdin',
              outputFormat: 'text',
            },
          },
        },
      });
    }

    await client.callTool({
      name: 'app_save_provider_config',
      arguments: {
        active_pool: ['pool-w1', 'pool-w2', 'pool-r1'],
        routing_policy: {
          writer_providers: ['pool-w1', 'pool-w2'],
          reader_providers: ['pool-r1'],
          auto_failover: true,
        },
      },
    });

    const provAfterPool = parseJsonToolResult(
      await client.callTool({ name: 'ext_swarm_providers', arguments: {} }),
    );
    assert.deepEqual(provAfterPool.activePool, ['pool-w1', 'pool-w2', 'pool-r1']);
    assert.deepEqual(provAfterPool.routingPolicy?.writerProviders, ['pool-w1', 'pool-w2']);
    assert.deepEqual(provAfterPool.routingPolicy?.readerProviders, ['pool-r1']);
    assert.equal(provAfterPool.routingPolicy?.autoFailover, true);

    const poolSwarmRes = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_create',
        arguments: {
          title: 'Multi-CLI Pool Swarm',
          repo_root: repoDir,
          active_providers: ['pool-w1', 'pool-w2', 'pool-r1'],
          routing_policy: {
            writer_providers: ['pool-w1', 'pool-w2'],
            reader_providers: ['pool-r1'],
            auto_failover: true,
          },
        },
      }),
    );
    const poolSwarmId = poolSwarmRes.swarm.id;

    // 1) Role routing: 2 workspace-write workers rotate across pool-w1 & pool-w2; 1 read-only routes to pool-r1
    const rw1 = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_add',
        arguments: { swarm_id: poolSwarmId, name: 'rw-1', permission_mode: 'workspace-write', brief: 'w1' },
      }),
    );
    const rw2 = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_add',
        arguments: { swarm_id: poolSwarmId, name: 'rw-2', permission_mode: 'workspace-write', brief: 'w2' },
      }),
    );
    const ro1 = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_add',
        arguments: {
          swarm_id: poolSwarmId,
          name: 'ro-1',
          workspace: 'inherit',
          permission_mode: 'read-only',
          brief: 'r1',
        },
      }),
    );
    assert.deepEqual(
      [rw1.added[0].provider, rw2.added[0].provider].sort(),
      ['pool-w1', 'pool-w2'],
      'Writer workers should distribute round-robin across writer_providers',
    );
    assert.equal(ro1.added[0].provider, 'pool-r1', 'Read-only worker should route to reader_providers');

    // 2) Multi-CLI sharding (`providers` + `tasks`)
    const multiShard = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_add',
        arguments: {
          swarm_id: poolSwarmId,
          name: 'mshard',
          providers: ['pool-w1', 'pool-w2'],
          tasks: ['Slice Alpha', 'Slice Beta'],
          brief: 'Process shards cleanly',
        },
      }),
    );
    assert.equal(multiShard.added.length, 2);
    assert.equal(multiShard.added[0].provider, 'pool-w1');
    assert.equal(multiShard.added[1].provider, 'pool-w2');

    // 3) Multi-CLI fan-out (`providers` without `tasks`)
    const multiFan = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_add',
        arguments: {
          swarm_id: poolSwarmId,
          name: 'fan',
          providers: ['pool-w1', 'pool-w2'],
          brief: 'Solve concurrently across two CLIs',
        },
      }),
    );
    assert.equal(multiFan.added.length, 2);
    assert.equal(multiFan.added[0].name, 'fan-pool-w1');
    assert.equal(multiFan.added[1].name, 'fan-pool-w2');
    assert.equal(multiFan.added[0].arenaGroup, 'multi-fan');

    // 4) Auto-failover: start on failing provider 'pool-fail' -> preserves worktree & recovers on 'pool-w1'
    const failoverAdd = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_add',
        arguments: {
          swarm_id: poolSwarmId,
          name: 'fo-worker',
          provider: 'pool-fail',
          workspace: 'worktree',
          brief: 'Write custom-out.txt after failover',
        },
      }),
    );
    const foWorktreeCwd = failoverAdd.added[0].cwd;
    const foWait = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_wait',
        arguments: { swarm_id: poolSwarmId, until: 'worker_done', worker_name: 'fo-worker', timeout_seconds: 15 },
      }),
    );
    assert.equal(foWait.timedOut, false);
    const foMember = foWait.swarm.members['fo-worker'];
    assert.equal(foMember.status, 'waiting', 'Failover should recover worker to waiting');
    assert.ok(
      foMember.failedProviders?.includes('pool-fail'),
      `Expected pool-fail in failedProviders, got ${JSON.stringify(foMember.failedProviders)}`,
    );
    assert.notEqual(foMember.provider, 'pool-fail', 'Worker must have switched away from failed provider');
    assert.equal(foMember.cwd, foWorktreeCwd, 'Failover must preserve original worker worktree path');
    assert.ok(existsSync(join(foWorktreeCwd, 'custom-out.txt')), 'Fallback provider should have written inside original worktree');

    const foBoard = parseJsonToolResult(
      await client.callTool({ name: 'ext_swarm_read', arguments: { swarm_id: poolSwarmId, since: 0, limit: 200 } }),
    );
    assert.ok(
      foBoard.messages.some((m) => m.text.includes('[failover]') && m.text.includes('pool-fail')),
      'Board should log failover event',
    );

    await client.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: poolSwarmId, until: 'all_idle', timeout_seconds: 15 },
    });

    // 8g. Regression tests for review fixes (#1 orphan swarm, #2 dirty main repo guard, #3 long arena base_name)
    const snapBeforeBadTpl = await client.callTool({ name: 'app_get_snapshot', arguments: {} });
    const swarmCountBeforeBadTpl = snapBeforeBadTpl.structuredContent?.swarms?.length || 0;
    const badTplRes = await client.callTool({
      name: 'ext_swarm_apply_template',
      arguments: { template_id: 'does-not-exist', goal: 'Should fail', repo_root: repoDir },
    });
    assert.equal(badTplRes.isError, true, 'Unknown template should return error');
    const snapAfterBadTpl = await client.callTool({ name: 'app_get_snapshot', arguments: {} });
    assert.equal(
      snapAfterBadTpl.structuredContent?.swarms?.length,
      swarmCountBeforeBadTpl,
      'Failed template lookup must not leave an orphan swarm on disk',
    );

    const longArenaRes = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_arena',
        arguments: {
          swarm_id: poolSwarmId,
          base_name: 'very-long-arena-prefix-name',
          task: 'Long arena prefix test',
          contestants: [{ provider: 'pool-w1' }, { provider: 'pool-w2' }],
        },
      }),
    );
    assert.equal(longArenaRes.contestants.length, 2);
    for (const c of longArenaRes.contestants) {
      assert.ok(c.name.length <= 24, `Arena worker name "${c.name}" exceeded 24 chars`);
    }
    await client.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: poolSwarmId, until: 'all_idle', timeout_seconds: 15 },
    });

    // Dirty tracked edit in main repo should block merge cleanly without touching user edits
    const readmePath = join(repoDir, 'README.md');
    const origReadme = readFileSync(readmePath, 'utf8');
    writeFileSync(readmePath, `${origReadme}uncommitted-user-line\n`, 'utf8');
    const dirtyMergeBlock = await client.callTool({
      name: 'ext_swarm_merge',
      arguments: {
        swarm_id: poolSwarmId,
        worker: 'fo-worker',
        action: 'apply',
      },
    });
    assert.equal(dirtyMergeBlock.isError, true, 'Merge must refuse when main repo has uncommitted tracked edits');
    assert.equal(
      readFileSync(readmePath, 'utf8'),
      `${origReadme}uncommitted-user-line\n`,
      'User uncommitted tracked changes must remain untouched',
    );
    writeFileSync(readmePath, origReadme, 'utf8');

    // 8e. Regression checks: quoted spaced path conflict preview, out-of-scope auto-snapshot block, and O(1) tail log read
    const dirtyConflictRes = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_add',
        arguments: {
          swarm_id: poolSwarmId,
          name: 'spaced-wt',
          provider: 'custom',
          workspace: 'worktree',
          custom_command: {
            command: 'node',
            args: [mockCliPath, 'noop'],
            prompt_mode: 'stdin',
            output_format: 'text',
          },
          brief: 'Spaced path test worker',
        },
      }),
    );
    await client.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: poolSwarmId, until: 'worker_done', worker_name: 'spaced-wt', timeout_seconds: 15 },
    });
    const spacedWtCwd = dirtyConflictRes.added[0].cwd;
    // Create uncommitted spaced file in worker worktree AND commit same spaced path on main
    writeFileSync(join(spacedWtCwd, 'spaced file.txt'), 'worker-spaced\n', 'utf8');
    writeFileSync(join(repoDir, 'spaced file.txt'), 'main-spaced\n', 'utf8');
    runGit(repoDir, ['add', 'spaced file.txt']);
    runGit(repoDir, ['commit', '-m', 'add spaced file on main']);

    const spacedPreview = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_merge',
        arguments: { swarm_id: poolSwarmId, worker: 'spaced-wt', action: 'preview' },
      }),
    );
    assert.equal(spacedPreview.preview.canCleanMerge, false, 'Expected conflict preview to detect overlapping dirty spaced file');
    assert.ok(
      spacedPreview.preview.conflictFiles.includes('spaced file.txt'),
      `Expected "spaced file.txt" in conflictFiles, got ${JSON.stringify(spacedPreview.preview.conflictFiles)}`,
    );

    // Out-of-scope dirty file must block mergeWorker auto-snapshot when allowed_files is set
    const scopedWorkerRes = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_add',
        arguments: {
          swarm_id: poolSwarmId,
          name: 'scoped-wt',
          provider: 'custom',
          workspace: 'worktree',
          allowed_files: ['allowed.txt'],
          custom_command: {
            command: 'node',
            args: [mockCliPath, 'noop'],
            prompt_mode: 'stdin',
            output_format: 'text',
          },
          brief: 'Scoped file test worker',
        },
      }),
    );
    await client.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: poolSwarmId, until: 'worker_done', worker_name: 'scoped-wt', timeout_seconds: 15 },
    });
    writeFileSync(join(scopedWorkerRes.added[0].cwd, 'stray.tmp'), 'out-of-scope\n', 'utf8');
    const scopedMergeBlocked = await client.callTool({
      name: 'ext_swarm_merge',
      arguments: { swarm_id: poolSwarmId, worker: 'scoped-wt', action: 'apply' },
    });
    assert.equal(scopedMergeBlocked.isError, true, 'Merge must refuse auto-snapshot of dirty file outside allowed_files');
    assert.equal(existsSync(join(repoDir, 'stray.tmp')), false, 'Out-of-scope file must not enter main repo');
    assert.equal(runGit(repoDir, ['diff', '--cached', '--name-only']), '', 'Main repo index must stay completely clean');
    assert.equal(
      runGit(scopedWorkerRes.added[0].cwd, ['rev-list', '--count', `${scopedWorkerRes.added[0].baseRef}..HEAD`]),
      '0',
      'Worker worktree must not auto-commit stray.tmp',
    );

    // app_get_worker_log >140 KB tail read must return clean last N JSON lines without partial-line corruption
    const largeLogDir = join(dataDir, 'swarms', poolSwarmId, 'logs');
    mkdirSync(largeLogDir, { recursive: true });
    const padding = 'x'.repeat(240);
    const bigLines = Array.from({ length: 600 }, (_, i) =>
      JSON.stringify({ type: 'text', idx: i, text: `line-${i}-${padding}` }),
    );
    const bigLogText = bigLines.join('\n') + '\n';
    assert.ok(Buffer.byteLength(bigLogText) > 140 * 1024, 'Expected test log > 140 KB');
    writeFileSync(join(largeLogDir, 'spaced-wt.ndjson'), bigLogText, 'utf8');

    const tailLogCall = await client.callTool({
      name: 'app_get_worker_log',
      arguments: { swarm_id: poolSwarmId, name: 'spaced-wt', tail_lines: 5 },
    });
    assert.ok(!tailLogCall.isError, `app_get_worker_log returned error: ${JSON.stringify(tailLogCall)}`);
    const tailLogRes = tailLogCall.structuredContent;
    assert.equal(tailLogRes.lines.length, 5);
    assert.deepEqual(
      tailLogRes.lines.map((l) => JSON.parse(l).idx),
      [595, 596, 597, 598, 599],
      'readTailLines should return exact trailing lines without leading partial corruption',
    );

    await client.callTool({ name: 'ext_swarm_delete', arguments: { swarm_id: poolSwarmId, remove_worktrees: true } });

    await client.callTool({
      name: 'app_save_provider_config',
      arguments: { active_pool: null, routing_policy: null },
    });
    for (const id of ['pool-w1', 'pool-w2', 'pool-r1', 'pool-fail']) {
      await client.callTool({ name: 'app_save_provider_config', arguments: { remove_provider: id } });
    }

    // 9. Delete swarm & verify worktree cleanup
    const delMainRes = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_delete',
        arguments: { swarm_id: swarmId, remove_worktrees: true },
      }),
    );
    assert.equal(delMainRes.deletedSwarmId, swarmId);
    assert.ok(!existsSync(writerCwd), 'Worktree should be cleaned up after ext_swarm_delete');
    assert.ok(!existsSync(join(dataDir, 'swarms', swarmId)), 'Swarm data folder should be deleted');

    console.log('[providers.test] ALL PROVIDER & I18N CHECKS PASSED');
  } finally {
    await client?.close().catch(() => {});
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[providers.test] FAILED:', err);
  process.exit(1);
});
