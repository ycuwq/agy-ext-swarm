import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
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
import { delimiter, dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import YAML from 'yaml';
import {
  BUILTIN_MODEL_PRICING,
  buildDshSiblingCatalogOverlay,
  buildSpawnCommand,
  buildTakeoverCommand,
  buildWorkerPrBody,
  calcMemberCost,
  calcModelCost,
  checkDshModelCatalogReadiness,
  checkDshProfileCatalogPlugins,
  checkDshProfileProviderPlugin,
  collectUnpricedModels,
  convertCurrency,
  convertRateForDisplay,
  createCustomAdapter,
  detectAgyModels,
  detectClaudeModels,
  detectCodexModels,
  detectCustomLocalModels,
  detectGeminiModels,
  discoverProviderModels,
  dshAdapter,
  expandTemplateArgs,
  formatDshQualifiedModel,
  formatModelWithOptions,
  getBuiltinAdapter,
  getDshNoAdapterHint,
  getDshUnknownModelHint,
  getEffectiveDefaultFastMode,
  getEffectiveDefaultReasoningEffort,
  getProviderConfigSnapshot,
  getProviderModels,
  hydrateWorktree,
  inferAgyModelCapabilities,
  isRateLimitOrQuotaError,
  isValidObservedModelId,
  listDshModels,
  loadWorktreeHooksConfig,
  lookupModelCapability,
  normalizeModelPricingCandidates,
  parseClaudeHelpModelAliases,
  parseDshQualifiedModel,
  parseEffortFromModelName,
  parseLiteLlmPricingCatalog,
  parseModelsFromCliOutput,
  parseOpenRouterPricingCatalog,
  pickRelevantCatalogPricing,
  pickRoutedTarget,
  quoteWinCmdArg,
  resolveModelPricing,
  saveProviderConfigPatch,
  testProviderConnection,
} from '../dist/providers.mjs';

const SERVER_DIR = join(import.meta.dirname, '..');
const PLUGIN_ROOT = join(SERVER_DIR, '..');
const DIST_INDEX = join(SERVER_DIR, 'dist', 'index.mjs');
const BOARD_CLI = join(PLUGIN_ROOT, 'bin', 'ext-board.mjs');
const execFileAsync = promisify(execFile);

function runGit(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function writeExecutableNodeScript(dir, baseName, bodyWithoutShebang) {
  const scriptPath = join(dir, `${baseName}.mjs`);
  writeFileSync(scriptPath, `#!/usr/bin/env node\n${bodyWithoutShebang}`, { mode: 0o755 });
  if (process.platform === 'win32') {
    const cmdPath = join(dir, `${baseName}.cmd`);
    writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf8');
    return cmdPath;
  }
  return scriptPath;
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
  const dshErrEvents = dsh.parseStdoutLine(JSON.stringify({ type: 'error', message: 'dsh boom' }));
  assert.equal(dshErrEvents.find((e) => e.type === 'error')?.message, 'dsh boom');
  assert.equal(dshErrEvents.find((e) => e.type === 'final')?.reasonKind, 'error');
  assert.equal(dshErrEvents.find((e) => e.type === 'final')?.errorText, 'dsh boom');

  // Verify dsh --patch is emitted even when headless uses sibling desktop catalog
  const dshSibHome = mkdtempSync(join(tmpdir(), 'agy-ext-swarm-dsh-sib-'));
  const prevDshHomeForPatch = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = dshSibHome;
    mkdirSync(join(dshSibHome, 'profiles', 'desktop'), { recursive: true });
    writeFileSync(
      join(dshSibHome, 'profiles', 'desktop', 'cordis.patch.yml'),
      '- id: c\n  config:\n    lastCatalog:\n      - id: ds-v4\n        provider: deepseek\n',
      'utf8',
    );
    const sibInv = dsh.buildInvocation({ ...baseCtx, model: 'ds-v4', profile: 'headless' });
    assert.ok(sibInv.args.includes('--patch'), 'dsh must pass --patch when sibling catalog is used');
    assert.ok(
      sibInv.args.indexOf('--patch') > 0 &&
        sibInv.args.indexOf('--patch') < sibInv.args.indexOf('--json'),
      'dsh launcher flag --patch must precede booted-app flags such as --json',
    );
  } finally {
    if (prevDshHomeForPatch === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevDshHomeForPatch;
    rmSync(dshSibHome, { recursive: true, force: true });
  }

  // 2. claude stream-json parser & invocation
  const claude = getBuiltinAdapter('claude');
  assert.ok(claude);
  const claudeInv = claude.buildInvocation({ ...baseCtx, sessionId: 'cl-abc' });
  assert.ok(claudeInv.args.includes('--resume'));
  assert.ok(claudeInv.args.includes('cl-abc'));
  assert.ok(claudeInv.args.includes('acceptEdits'));
  const claudeReadOnly = claude.buildInvocation({
    ...baseCtx,
    permissionMode: 'read-only',
    gitCommonDir: '/repo/.git',
  });
  assert.ok(claudeReadOnly.args.includes('plan'));
  assert.ok(claudeReadOnly.args.includes('--add-dir'));
  assert.ok(claudeReadOnly.args.includes('/repo/.git'));
  assert.ok(claudeReadOnly.args.includes(baseCtx.swarmDir));
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
  const claudeCacheErrEvents = claude.parseStdoutLine(
    JSON.stringify({
      type: 'result',
      is_error: true,
      errors: [{ message: 'claude rate limit' }],
      usage: { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 20, output_tokens: 10 },
    }),
  );
  assert.equal(claudeCacheErrEvents.find((e) => e.type === 'usage')?.inputTokens, 150);
  assert.equal(claudeCacheErrEvents.find((e) => e.type === 'usage')?.totalTokens, 180);
  assert.equal(claudeCacheErrEvents.find((e) => e.type === 'final')?.reasonKind, 'error');
  assert.equal(claudeCacheErrEvents.find((e) => e.type === 'final')?.errorText, 'claude rate limit');
  assert.equal(claudeCacheErrEvents.find((e) => e.type === 'final')?.text, undefined);

  const claudeCostOnlyEvents = claude.parseStdoutLine(
    JSON.stringify({
      type: 'result',
      result: 'ok',
      is_error: false,
      total_cost_usd: 0.0425,
    }),
  );
  assert.equal(claudeCostOnlyEvents.find((e) => e.type === 'usage')?.costUsd, 0.0425);
  assert.equal(claudeCostOnlyEvents.find((e) => e.type === 'usage')?.totalTokens, 0);

  const claudeCostWithUsageEvents = claude.parseStdoutLine(
    JSON.stringify({
      type: 'result',
      result: 'ok',
      is_error: false,
      total_cost_usd: 0.125,
      usage: { input_tokens: 100, output_tokens: 50 },
    }),
  );
  assert.equal(claudeCostWithUsageEvents.find((e) => e.type === 'usage')?.costUsd, 0.125);
  assert.equal(claudeCostWithUsageEvents.find((e) => e.type === 'usage')?.totalTokens, 150);

  // 2b. Pricing engine, fuzzy matching & catalog parsers
  assert.ok(BUILTIN_MODEL_PRICING['claude-sonnet-4-5'], 'Built-in baseline should include claude-sonnet-4-5');
  const litellmParsed = parseLiteLlmPricingCatalog({
    sample_spec: { input_cost_per_token: 99, output_cost_per_token: 99 },
    'claude-sonnet-4': {
      mode: 'chat',
      input_cost_per_token: 0.000003,
      cache_read_input_token_cost: 0.0000003,
      output_cost_per_token: 0.000015,
    },
    'mimo-v2.6-pro': {
      mode: 'chat',
      input_cost_per_token: 0.000002,
      output_cost_per_token: 0.000008,
    },
    'dall-e-3': {
      mode: 'image_generation',
      input_cost_per_token: 0.00001,
      output_cost_per_token: 0.00002,
    },
  });
  assert.equal(litellmParsed.sample_spec, undefined);
  assert.equal(litellmParsed['dall-e-3'], undefined);
  assert.equal(litellmParsed['claude-sonnet-4']?.inputPer1M, 3);
  assert.equal(litellmParsed['claude-sonnet-4']?.cacheReadPer1M, 0.3);
  assert.equal(litellmParsed['claude-sonnet-4']?.outputPer1M, 15);
  assert.equal(litellmParsed['mimo-v2.6-pro']?.inputPer1M, 2);

  const openrouterParsed = parseOpenRouterPricingCatalog({
    data: [
      {
        id: 'openrouter/auto',
        pricing: { prompt: '-1', completion: '-1' },
      },
      {
        id: 'anthropic/claude-sonnet-4',
        pricing: {
          prompt: '0.000003',
          input_cache_read: '0.0000003',
          completion: '0.000015',
        },
      },
      {
        id: 'deepseek/deepseek-chat',
        pricing: { prompt: '0.00000027', completion: '0.0000011' },
      },
    ],
  });
  assert.equal(openrouterParsed['openrouter/auto'], undefined);
  assert.equal(openrouterParsed['anthropic/claude-sonnet-4']?.inputPer1M, 3);
  assert.equal(openrouterParsed['deepseek/deepseek-chat']?.outputPer1M, 1.1);

  assert.ok(
    normalizeModelPricingCandidates('workbuddy/deepseek-chat').includes('deepseek-chat'),
    'Prefix stripping must expose deepseek-chat',
  );
  assert.ok(
    normalizeModelPricingCandidates('claude-haiku-4-5-20251001').includes('claude-haiku-4-5'),
    'Date stripping must expose claude-haiku-4-5',
  );
  assert.equal(
    resolveModelPricing('workbuddy/deepseek-chat')?.source,
    'builtin',
  );
  assert.equal(
    resolveModelPricing('openrouter/anthropic/claude-sonnet-4', undefined, openrouterParsed)?.source,
    'catalog',
  );
  assert.equal(
    resolveModelPricing('claude-haiku-4-5-20251001')?.matchedKey,
    'claude-haiku-4-5',
  );
  assert.equal(
    resolveModelPricing('mimo-v2.6-pro[1m]', undefined, litellmParsed)?.matchedKey,
    'mimo-v2.6-pro',
  );
  assert.equal(
    resolveModelPricing(
      'claude-sonnet-4',
      { 'claude-sonnet-4': { inputPer1M: 21, outputPer1M: 99, currency: 'CNY' } },
      litellmParsed,
    )?.source,
    'custom',
  );

  const pickedCatalog = pickRelevantCatalogPricing(
    { ...litellmParsed, 'unused-huge-model': { inputPer1M: 9, outputPer1M: 9, currency: 'USD' } },
    ['mimo-v2.6-pro[1m]', 'workbuddy/deepseek-chat'],
  );
  assert.deepEqual(Object.keys(pickedCatalog), ['mimo-v2.6-pro']);
  assert.deepEqual(
    collectUnpricedModels(['claude-sonnet-4-5', 'custom-internal-v9'], undefined, litellmParsed),
    ['custom-internal-v9'],
  );

  const reportedMember = {
    name: 'w-rep',
    provider: 'claude',
    model: 'claude-sonnet-4-5',
    workspaceMode: 'inherit',
    permissionMode: 'read-only',
    status: 'waiting',
    turns: 1,
    steps: 1,
    usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, totalTokens: 1_000_000, reportedCostUsd: 0.77 },
  };
  assert.deepEqual(calcMemberCost(reportedMember), { amount: 0.77, currency: 'USD', source: 'reported' });
  assert.deepEqual(
    calcMemberCost(reportedMember, { 'claude-sonnet-4-5': { inputPer1M: 10, outputPer1M: 20, currency: 'CNY' } }),
    { amount: 10, currency: 'CNY', source: 'custom' },
  );
  assert.equal(
    calcModelCost('workbuddy/deepseek-chat', 1_000_000, 0, 1_000_000)?.source,
    'builtin',
  );

  // Catalog suffix/vendor-dot prefix & reasoning-effort tier matching
  const suffixCatalog = {
    'coralbricks/deepseek-v4.1-flash': {
      inputPer1M: 0.01,
      cacheReadPer1M: 0,
      outputPer1M: 1.2,
      currency: 'USD',
    },
    'anthropic.claude-opus-5-5': {
      inputPer1M: 4,
      cacheReadPer1M: 0.2,
      outputPer1M: 20,
      currency: 'USD',
    },
    'global.anthropic.claude-opus-5-5': {
      inputPer1M: 4.4,
      cacheReadPer1M: 0.22,
      outputPer1M: 22,
      currency: 'USD',
    },
    'github_copilot/gemini-4-hydrogen': {
      inputPer1M: 0,
      outputPer1M: 0,
      currency: 'USD',
    },
    'perplexity/google/gemini-4-hydrogen': {
      inputPer1M: 1.5,
      cacheReadPer1M: 0.075,
      outputPer1M: 7.5,
      currency: 'USD',
    },
    'gemini/gemini-4-hydrogen': {
      inputPer1M: 1.5,
      cacheReadPer1M: 0.075,
      outputPer1M: 7.5,
      currency: 'USD',
    },
    'gemini/gemini-4-neon': {
      inputPer1M: 0.5,
      cacheReadPer1M: 0.05,
      outputPer1M: 3,
      currency: 'USD',
    },
  };
  assert.equal(
    resolveModelPricing('workbuddy/deepseek-v4.1-flash', undefined, suffixCatalog)?.matchedKey,
    'coralbricks/deepseek-v4.1-flash',
  );
  assert.equal(
    resolveModelPricing('deepseek-v4.1-flash', undefined, suffixCatalog)?.matchedKey,
    'coralbricks/deepseek-v4.1-flash',
  );
  assert.equal(
    resolveModelPricing('claude-opus-5-5-medium', undefined, suffixCatalog)?.matchedKey,
    'anthropic.claude-opus-5-5',
  );
  assert.equal(
    resolveModelPricing('gemini-4-hydrogen-xhigh', undefined, suffixCatalog)?.matchedKey,
    'gemini/gemini-4-hydrogen',
  );
  assert.equal(
    resolveModelPricing('gemini-4-neon-xhigh', undefined, suffixCatalog)?.matchedKey,
    'gemini/gemini-4-neon',
  );
  const pickedSuffixCatalog = pickRelevantCatalogPricing(suffixCatalog, [
    'deepseek-v4.1-flash',
    'claude-opus-5-5-medium',
    'gemini-4-hydrogen-xhigh',
    'gemini-4-neon-xhigh',
  ]);
  assert.deepEqual(Object.keys(pickedSuffixCatalog).sort(), [
    'anthropic.claude-opus-5-5',
    'coralbricks/deepseek-v4.1-flash',
    'gemini/gemini-4-hydrogen',
    'gemini/gemini-4-neon',
  ]);

  // Unified currency conversion (AUTO / CNY / USD) & persistence
  const cnyOpts = { displayCurrency: 'CNY', usdToCnyRate: 7.2 };
  assert.deepEqual(convertCurrency(1, 'USD', cnyOpts), { amount: 7.2, currency: 'CNY' });
  assert.deepEqual(
    convertRateForDisplay({ inputPer1M: 1, cacheReadPer1M: 0.1, outputPer1M: 5, currency: 'USD' }, cnyOpts),
    { inputPer1M: 7.2, cacheReadPer1M: 0.72, outputPer1M: 36, currency: 'CNY' },
  );
  const cnyCalc = calcModelCost('workbuddy/deepseek-v4.1-flash', 1_000_000, 0, 1_000_000, undefined, suffixCatalog, cnyOpts);
  assert.equal(cnyCalc?.currency, 'CNY');
  assert.ok(Math.abs((cnyCalc?.amount ?? 0) - 1.21 * 7.2) < 1e-6);
  const cnyReported = calcMemberCost(reportedMember, undefined, undefined, cnyOpts);
  assert.equal(cnyReported?.currency, 'CNY');
  assert.ok(Math.abs((cnyReported?.amount ?? 0) - 0.77 * 7.2) < 1e-6);
  const usdFromCnyCustom = calcMemberCost(
    reportedMember,
    { 'claude-sonnet-4-5': { inputPer1M: 7.2, outputPer1M: 14.4, currency: 'CNY' } },
    undefined,
    { displayCurrency: 'USD', usdToCnyRate: 7.2 },
  );
  assert.equal(usdFromCnyCustom?.currency, 'USD');
  assert.ok(Math.abs((usdFromCnyCustom?.amount ?? 0) - 1) < 1e-6);

  const fxTempDir = mkdtempSync(join(tmpdir(), 'agy-fx-test-'));
  try {
    saveProviderConfigPatch(fxTempDir, { displayCurrency: 'CNY', usdToCnyRate: 7.25 });
    const fxSnap = getProviderConfigSnapshot(fxTempDir, undefined, undefined, { bypassCache: true });
    assert.equal(fxSnap.displayCurrency, 'CNY');
    assert.equal(fxSnap.usdToCnyRate, 7.25);
  } finally {
    rmSync(fxTempDir, { recursive: true, force: true });
  }

  // 3. codex exec json parser & invocation
  const codex = getBuiltinAdapter('codex');
  assert.ok(codex);
  const codexInvFirst = codex.buildInvocation(baseCtx);
  assert.equal(codexInvFirst.args[0], 'exec');
  assert.ok(codexInvFirst.args.includes('--sandbox'));
  const codexInvResume = codex.buildInvocation({ ...baseCtx, sessionId: 'th-999' });
  assert.equal(codexInvResume.args[0], 'exec');
  const resumeIdx1 = codexInvResume.args.indexOf('resume');
  assert.ok(resumeIdx1 > 1, 'codex resume must keep parent exec options before resume subcommand');
  assert.deepEqual(codexInvResume.args.slice(resumeIdx1, resumeIdx1 + 3), ['resume', 'th-999', '--json']);
  const sbIdx1 = codexInvResume.args.indexOf('--sandbox');
  assert.ok(sbIdx1 > 0 && sbIdx1 < resumeIdx1 && codexInvResume.args[sbIdx1 + 1] === 'workspace-write');
  const addDirIdx1 = codexInvResume.args.indexOf('--add-dir');
  assert.ok(addDirIdx1 > 0 && addDirIdx1 < resumeIdx1);
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
        usage: { input_tokens: 500, cached_input_tokens: 350, output_tokens: 25 },
      }),
    ),
  ];
  assert.equal(codexEvents.find((e) => e.type === 'session')?.sessionId, 'th-999');
  assert.equal(codexEvents.find((e) => e.type === 'tool_call')?.summary, 'shell: ls -la');
  assert.equal(codexEvents.find((e) => e.type === 'text')?.text, 'codex ok');
  assert.equal(codexEvents.find((e) => e.type === 'usage')?.cacheReadTokens, 350);
  assert.equal(codexEvents.find((e) => e.type === 'usage')?.inputTokens, 150);
  assert.equal(codexEvents.find((e) => e.type === 'usage')?.totalTokens, 525);
  const codexFailEvents = codex.parseStdoutLine(
    JSON.stringify({ type: 'turn.failed', error: { message: 'codex failed' } }),
  );
  assert.equal(codexFailEvents.find((e) => e.type === 'error')?.message, 'codex failed');
  assert.equal(codexFailEvents.find((e) => e.type === 'final')?.reasonKind, 'error');
  assert.equal(codexFailEvents.find((e) => e.type === 'final')?.errorText, 'codex failed');

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
  const geminiErrEvents = gemini.parseStdoutLine(JSON.stringify({ type: 'error', message: 'gemini err' }));
  assert.equal(geminiErrEvents.find((e) => e.type === 'final')?.reasonKind, 'error');
  assert.equal(geminiErrEvents.find((e) => e.type === 'final')?.errorText, 'gemini err');

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
  const customErrEvents = customNdjson.parseStdoutLine(
    JSON.stringify({ type: 'error', text: 'bad output', message: 'custom failed' }),
  );
  assert.equal(customErrEvents.some((e) => e.type === 'text'), false);
  assert.equal(customErrEvents.find((e) => e.type === 'final')?.reasonKind, 'error');
  assert.equal(customErrEvents.find((e) => e.type === 'final')?.errorText, 'custom failed');

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

function testModelDiscovery() {
  const prevEnv = {
    DSH_HOME: process.env.DSH_HOME,
    CODEX_HOME: process.env.CODEX_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME,
    OPENCODE_CONFIG: process.env.OPENCODE_CONFIG,
  };
  const discRoot = mkdtempSync(join(tmpdir(), 'agy-ext-swarm-model-disc-'));

  try {
    // 1. dsh headless read-only fallback to sibling desktop profile
    const dshHome = join(discRoot, 'dsh');
    process.env.DSH_HOME = dshHome;
    mkdirSync(join(dshHome, 'profiles', 'headless'), { recursive: true });
    mkdirSync(join(dshHome, 'profiles', 'desktop'), { recursive: true });
    writeFileSync(join(dshHome, 'profiles', 'headless', 'cordis.patch.yml'), '[]\n', 'utf8');
    writeFileSync(
      join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml'),
      [
        '- id: agent-default-model',
        '  config:',
        '    provider: workbuddy',
        '    model: dsh-sib-flash',
        '- id: model-catalog',
        '  config:',
        '    lastCatalog:',
        '      - id: dsh-sib-flash',
        '        name: DSH Sibling Flash',
        '      - id: dsh-sib-pro',
        '        name: DSH Sibling Pro',
      ].join('\n'),
      'utf8',
    );
    const dshRes = listDshModels('headless');
    assert.equal(dshRes.catalogSourceProfile, 'desktop');
    assert.equal(dshRes.defaultProvider, 'workbuddy');
    assert.equal(dshRes.defaultModel, 'dsh-sib-flash');
    assert.deepEqual(
      dshRes.models.map((m) => m.id),
      ['dsh-sib-flash', 'dsh-sib-pro'],
    );
    assert.deepEqual(dshRes.providers, ['workbuddy']);

    // 1b. dsh multi-provider discovery, model-provider/model helpers, snapshot, and --patch resolution
    mkdirSync(join(dshHome, 'profiles', 'multi'), { recursive: true });
    writeFileSync(
      join(dshHome, 'profiles', 'multi', 'cordis.patch.yml'),
      [
        '- id: agent-default-model',
        '  config:',
        '    provider: workbuddy',
        '    model: shared-flash',
        '- id: dsh-connect-workbuddy',
        '  name: dsh-connect-workbuddy',
        '  config:',
        '    regions:',
        '      cn:',
        '        enabled: true',
        '        lastCatalog:',
        '          - id: shared-flash',
        '            name: Shared Flash CN',
        '          - id: cn-only',
        '            name: CN Only',
        '      global:',
        '        enabled: true',
        '        lastCatalog:',
        '          - id: shared-flash',
        '            name: Shared Flash Global',
        '          - id: global-only',
        '            name: Global Only',
        '      disabledReg:',
        '        enabled: false',
        '        lastCatalog:',
        '          - id: skip-disabled',
        '            name: Skip Disabled',
        '- id: llm-pi-ai',
        '  name: "@deepseek-ai/dsh-llm-pi-ai"',
        '  config:',
        '    providers:',
        '      openrouter:',
        '        models:',
        '          - anthropic/claude-sonnet-4',
        '      disabledProv:',
        '        enabled: false',
        '        models:',
        '          - skip-prov',
        '- id: subagent-model-selection-settings',
        '  config:',
        '    enabled: true',
        '    allowedModels:',
        '      - provider: workbuddy',
        '        model: shared-flash',
        '      - provider: workbuddy',
        '        model: allowed-only',
      ].join('\n'),
      'utf8',
    );
    const multiDsh = listDshModels('multi');
    assert.deepEqual(multiDsh.providers, ['workbuddy', 'workbuddy-global', 'openrouter']);
    assert.ok(
      multiDsh.models.some((m) => m.provider === 'workbuddy' && m.id === 'shared-flash'),
      'Expected workbuddy/shared-flash in multiDsh.models',
    );
    assert.ok(
      multiDsh.models.some((m) => m.provider === 'workbuddy-global' && m.id === 'shared-flash'),
      'Expected workbuddy-global/shared-flash to NOT collide with workbuddy/shared-flash',
    );
    assert.ok(
      multiDsh.models.some((m) => m.provider === 'openrouter' && m.id === 'anthropic/claude-sonnet-4'),
    );
    assert.ok(multiDsh.models.some((m) => m.provider === 'workbuddy' && m.id === 'allowed-only'));
    assert.equal(
      multiDsh.models.some((m) => m.id === 'skip-disabled' || m.id === 'skip-prov'),
      false,
    );

    assert.equal(formatDshQualifiedModel('workbuddy-global', 'shared-flash'), 'workbuddy-global/shared-flash');
    assert.equal(formatDshQualifiedModel('workbuddy', 'workbuddy/shared-flash'), 'workbuddy/shared-flash');
    assert.deepEqual(
      parseDshQualifiedModel('workbuddy-global/shared-flash', ['workbuddy', 'workbuddy-global'], 'workbuddy'),
      { modelProvider: 'workbuddy-global', model: 'shared-flash', qualified: true },
    );
    assert.deepEqual(
      parseDshQualifiedModel('openrouter/anthropic/claude-sonnet-4', ['workbuddy'], 'workbuddy'),
      { modelProvider: 'openrouter', model: 'anthropic/claude-sonnet-4', qualified: true },
    );
    assert.deepEqual(
      parseDshQualifiedModel('anthropic/claude-sonnet-4', ['openrouter'], 'openrouter'),
      { modelProvider: 'openrouter', model: 'anthropic/claude-sonnet-4', qualified: false },
    );
    assert.deepEqual(parseDshQualifiedModel('shared-flash', ['workbuddy'], 'workbuddy'), {
      modelProvider: 'workbuddy',
      model: 'shared-flash',
      qualified: false,
    });

    const dshAdapterTest = getBuiltinAdapter('dsh');
    const patchDir = join(discRoot, 'patches');
    const baseDshCtx = {
      prompt: 'test',
      workerName: 'w-global',
      cwd: discRoot,
      permissionMode: 'read-only',
      profile: 'multi',
      swarmDir: discRoot,
      patchesDir: patchDir,
      boardCli: '/tmp/ext-board.mjs',
    };
    const invDefaultQual = dshAdapterTest.buildInvocation({
      ...baseDshCtx,
      workerName: 'w-def',
      model: 'workbuddy/shared-flash',
    });
    assert.equal(invDefaultQual.args.includes('--patch'), false);

    const invCrossProv = dshAdapterTest.buildInvocation({
      ...baseDshCtx,
      workerName: 'w-cross',
      model: 'workbuddy-global/shared-flash',
    });
    assert.ok(invCrossProv.args.includes('--patch'));
    assert.ok(
      invCrossProv.args.indexOf('--patch') > 0 &&
        invCrossProv.args.indexOf('--patch') < invCrossProv.args.indexOf('--json'),
      'dsh launcher flag --patch must precede --json',
    );
    const crossPatchTxt = readFileSync(join(patchDir, 'w-cross.yml'), 'utf8');
    assert.match(crossPatchTxt, /provider:\s*workbuddy-global/);
    assert.match(crossPatchTxt, /model:\s*shared-flash/);

    const invNestedModel = dshAdapterTest.buildInvocation({
      ...baseDshCtx,
      workerName: 'w-nested',
      model: 'openrouter/anthropic/claude-sonnet-4',
    });
    assert.ok(invNestedModel.args.includes('--patch'));
    assert.ok(
      invNestedModel.args.indexOf('--patch') > 0 &&
        invNestedModel.args.indexOf('--patch') < invNestedModel.args.indexOf('--json'),
      'dsh launcher flag --patch must precede --json',
    );
    const nestedPatchTxt = readFileSync(join(patchDir, 'w-nested.yml'), 'utf8');
    assert.match(nestedPatchTxt, /provider:\s*openrouter/);
    assert.match(nestedPatchTxt, /model:\s*anthropic\/claude-sonnet-4/);

    const snapDataDir = join(discRoot, 'snap-data');
    mkdirSync(snapDataDir, { recursive: true });
    const dshSnap = getProviderConfigSnapshot(snapDataDir, undefined, 'multi', true);
    const dshDesc = dshSnap.providers.find((p) => p.id === 'dsh');
    assert.deepEqual(dshDesc?.detectedModelProviders, ['workbuddy', 'workbuddy-global', 'openrouter']);
    assert.equal(dshDesc?.detectedDefaultModel, 'workbuddy/shared-flash');
    assert.ok(dshDesc?.detectedModels?.includes('workbuddy/shared-flash'));
    assert.ok(dshDesc?.detectedModels?.includes('workbuddy-global/shared-flash'));
    assert.ok(dshDesc?.detectedModels?.includes('openrouter/anthropic/claude-sonnet-4'));
    assert.ok(dshDesc?.detectedModels?.includes('workbuddy/allowed-only'));
    const dshModelsRes = getProviderModels('dsh', snapDataDir, undefined, 'multi');
    assert.deepEqual(dshModelsRes.modelProviders, ['workbuddy', 'workbuddy-global', 'openrouter']);

    writeFileSync(
      join(snapDataDir, 'providers.json'),
      JSON.stringify({
        providers: {
          dsh: {
            enabled: true,
            models: ['workbuddy/shared-flash'],
          },
        },
      }),
      'utf8',
    );
    const dshFilteredSnap = getProviderConfigSnapshot(snapDataDir, undefined, 'multi', true);
    const dshFiltered = dshFilteredSnap.providers.find((p) => p.id === 'dsh');
    assert.deepEqual(dshFiltered?.configuredModels, ['workbuddy/shared-flash']);
    assert.deepEqual(dshFiltered?.models, ['workbuddy/shared-flash']);
    assert.ok(dshFiltered?.detectedModels?.includes('workbuddy-global/shared-flash'));

    // 2. Codex models_cache.json (visibility !== 'hide', priority sort) + config.toml
    const codexHome = join(discRoot, 'codex');
    process.env.CODEX_HOME = codexHome;
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      join(codexHome, 'config.toml'),
      'model = "gpt-config-def"\n[profiles.fast]\nmodel = "ignored-section-model"\n',
      'utf8',
    );
    writeFileSync(
      join(codexHome, 'models_cache.json'),
      JSON.stringify({
        models: [
          { slug: 'gpt-p2', priority: 2, visibility: 'list' },
          { slug: 'gpt-hidden', priority: 0, visibility: 'hide' },
          { slug: 'gpt-p1', priority: 1, visibility: 'list' },
        ],
      }),
      'utf8',
    );
    const codexRes = detectCodexModels();
    assert.equal(codexRes.defaultModel, 'gpt-config-def');
    assert.deepEqual(codexRes.models, ['gpt-config-def', 'gpt-p1', 'gpt-p2']);

    // 3. Claude settings.json (no secret leak) + stats-cache.json
    const claudeDir = join(discRoot, 'claude');
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({
        model: 'claude-pref-model',
        availableModels: ['claude-avail-1'],
        env: {
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-test',
          ANTHROPIC_AUTH_TOKEN: 'secret-token-never-expose',
        },
      }),
      'utf8',
    );
    writeFileSync(
      join(claudeDir, 'stats-cache.json'),
      JSON.stringify({ modelUsage: { 'claude-stats-1': { inputTokens: 10 } } }),
      'utf8',
    );
    const claudeRes = detectClaudeModels();
    assert.equal(claudeRes.defaultModel, 'claude-pref-model');
    assert.equal(claudeRes.models.includes('secret-token-never-expose'), false);
    assert.deepEqual(claudeRes.models, [
      'claude-pref-model',
      'claude-avail-1',
      'claude-sonnet-test',
      'claude-stats-1',
    ]);

    // 4. Gemini settings.json
    const geminiDir = join(discRoot, 'gemini');
    process.env.GEMINI_CLI_HOME = geminiDir;
    mkdirSync(geminiDir, { recursive: true });
    writeFileSync(
      join(geminiDir, 'settings.json'),
      JSON.stringify({ model: { name: 'gemini-test-pro' } }),
      'utf8',
    );
    const geminiRes = detectGeminiModels();
    assert.equal(geminiRes.defaultModel, 'gemini-test-pro');
    assert.deepEqual(geminiRes.models, ['gemini-test-pro']);

    // 5. OpenCode opencode.json (ignoring secrets)
    const ocPath = join(discRoot, 'opencode.json');
    process.env.OPENCODE_CONFIG = ocPath;
    writeFileSync(
      ocPath,
      JSON.stringify({
        model: 'deepseek/ds-v4',
        provider: {
          deepseek: {
            options: { apiKey: 'secret-oc' },
            models: { 'ds-v4': {}, 'ds-flash': {} },
          },
        },
      }),
      'utf8',
    );
    const ocRes = detectCustomLocalModels('opencode', 'opencode');
    assert.equal(ocRes.defaultModel, 'deepseek/ds-v4');
    assert.equal(ocRes.models.includes('secret-oc'), false);
    assert.deepEqual(ocRes.models, ['deepseek/ds-v4', 'deepseek/ds-flash']);

    // 6. CLI output parsers
    const cliText = '\x1b[32mAvailable models:\x1b[0m\n- openai/gpt-1\n* deepseek/r1  fast tier\nhttp://ignored.local\nError: skip line\n';
    assert.deepEqual(parseModelsFromCliOutput(cliText), ['openai/gpt-1', 'deepseek/r1']);
    assert.deepEqual(parseModelsFromCliOutput(JSON.stringify({ models: [{ id: 'j-1' }, { slug: 'j-2' }] })), [
      'j-1',
      'j-2',
    ]);
    assert.deepEqual(
      parseClaudeHelpModelAliases(
        "  --model <model>  Provide an alias (e.g. 'fable', 'opus', or 'sonnet')\n  --other  ignored 'other'",
      ),
      ['fable', 'opus', 'sonnet'],
    );
  } finally {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(discRoot, { recursive: true, force: true });
  }
}

async function testDshProfilePluginDetection() {
  const root = mkdtempSync(join(tmpdir(), 'agy-ext-swarm-dsh-plugcheck-'));
  const dshHome = join(root, 'dsh-home');
  const dataDir = join(root, 'data');
  const prevDshHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = dshHome;
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(dshHome, 'profiles', 'desktop'), { recursive: true });
    mkdirSync(join(dshHome, 'profiles', 'headless'), { recursive: true });

    const fakeDsh = writeExecutableNodeScript(
      root,
      'fake-dsh',
      `if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log('0.2.2-mock');
  process.exit(0);
}
process.exit(0);
`,
    );

    writeFileSync(
      join(dataDir, 'providers.json'),
      JSON.stringify({
        providers: {
          dsh: {
            enabled: true,
            command: fakeDsh,
            profile: 'headless',
          },
        },
      }),
      'utf8',
    );

    writeFileSync(
      join(dshHome, 'profiles', 'desktop', 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-desktop',
        dependencies: {
          'dsh-connect-mockprov': '^1.0.0',
          '@acme/custom-llm-bridge': '^2.0.0',
        },
        dsh: {
          profile: {
            bundles: [
              '@deepseek-ai/dsh-base',
              'dsh-connect-mockprov',
              '@acme/custom-llm-bridge',
            ],
          },
        },
      }),
      'utf8',
    );

    writeFileSync(
      join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml'),
      [
        '- id: agent-default-model',
        '  name: "@deepseek-ai/dsh-agent-default-model"',
        '  config:',
        '    provider: mockprov',
        '    model: mock-flash',
        '- id: dsh-connect-mockprov',
        '  name: dsh-connect-mockprov',
        '  config:',
        '    apiKey: sk-secret-must-not-leak',
        '    regions:',
        '      cn:',
        '        enabled: true',
        '        cnBase: https://internal.example.test',
        '        enabledModelIds:',
        '          - only-one',
        '        pool:',
        '          memberAccountIds:',
        '            - secret-acct',
        '        lastCatalog:',
        '          - id: mock-flash',
        '            name: Mock Flash',
        '            contextWindow: 1000000',
        '            maxTokens: 128000',
        '            supportsImages: true',
        '            reasoning:',
        '              supportedEfforts:',
        '                - low',
        '                - high',
        '              defaultEffort: high',
        '              canDisableThinking: true',
        '            promos:',
        '              - secret-promo',
        '            apiKey: per-model-secret',
        '      global:',
        '        enabled: true',
        '        lastCatalog:',
        '          - id: mock-pro',
        '            name: Mock Pro',
        '- id: acme-bridge',
        '  name: "@acme/custom-llm-bridge"',
        '  config:',
        '    lastCatalog:',
        '      - id: acme-fast',
        '        provider: acme-llm',
        '- id: llm-pi-ai',
        '  name: "@deepseek-ai/dsh-llm-pi-ai"',
        '  config:',
        '    providers:',
        '      custom-gw:',
        '        models:',
        '          - gw-model-1',
      ].join('\n'),
      'utf8',
    );

    writeFileSync(
      join(dshHome, 'profiles', 'headless', 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-headless',
        dependencies: {},
        dsh: {
          profile: {
            bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
          },
        },
      }),
      'utf8',
    );
    writeFileSync(join(dshHome, 'profiles', 'headless', 'cordis.patch.yml'), '[]\n', 'utf8');

    const chkMock = checkDshProfileProviderPlugin('headless', 'mockprov');
    assert.equal(chkMock.ok, false);
    assert.equal(chkMock.reason, 'missing-plugin');
    assert.equal(chkMock.pluginPackage, 'dsh-connect-mockprov');
    assert.equal(chkMock.sourceProfile, 'desktop');
    assert.equal(chkMock.installCommand, 'dsh plugin --profile headless add dsh-connect-mockprov');

    const chkAcme = checkDshProfileProviderPlugin('headless', 'acme-llm');
    assert.equal(chkAcme.ok, false);
    assert.equal(chkAcme.reason, 'missing-plugin');
    assert.equal(chkAcme.pluginPackage, '@acme/custom-llm-bridge');
    assert.equal(
      chkAcme.installCommand,
      'dsh plugin --profile headless add @acme/custom-llm-bridge',
    );

    const chkPiAi = checkDshProfileProviderPlugin('headless', 'custom-gw');
    assert.equal(chkPiAi.ok, false);
    assert.equal(chkPiAi.reason, 'missing-pi-ai-provider');
    assert.equal(chkPiAi.sourceProfile, 'desktop');

    const chkBuiltin = checkDshProfileProviderPlugin('headless', 'deepseek-official');
    assert.equal(chkBuiltin.ok, true);

    const grouped = checkDshProfileCatalogPlugins('headless', ['mockprov', 'mockprov-global']);
    assert.equal(grouped.length, 1);
    assert.match(grouped[0].warning || '', /mockprov,\s*mockprov-global/);
    assert.match(
      grouped[0].warning || '',
      /dsh plugin --profile headless add dsh-connect-mockprov/,
    );

    // AI-coding snapshot/models calls MUST NOT read package.json or attach dsh plugin warnings
    const codingSnap = getProviderConfigSnapshot(dataDir, undefined, 'headless', true);
    const codingDsh = codingSnap.providers.find((p) => p.id === 'dsh');
    assert.equal(
      codingDsh?.warnings?.length ?? 0,
      0,
      'AI-coding getProviderConfigSnapshot must not check package.json or emit dsh plugin warnings',
    );
    const codingModels = getProviderModels('dsh', dataDir, undefined, 'headless');
    assert.equal(
      codingModels.warnings?.length ?? 0,
      0,
      'AI-coding getProviderModels must not emit dsh plugin warnings',
    );

    // Settings & Onboarding snapshot/test calls DO check package.json and surface warnings
    const snapMissing = getProviderConfigSnapshot(dataDir, undefined, 'headless', {
      bypassCache: true,
      checkDshPlugins: true,
    });
    const dshMissing = snapMissing.providers.find((p) => p.id === 'dsh');
    assert.ok(
      dshMissing?.warnings?.some((w) =>
        w.includes('dsh plugin --profile headless add dsh-connect-mockprov'),
      ),
      'Config/onboarding snapshot must warn about missing dsh-connect-mockprov',
    );
    const connMissing = await testProviderConnection('dsh', dataDir, undefined, 'headless');
    assert.equal(connMissing.ok, true);
    assert.ok(
      connMissing.warnings?.some((w) =>
        w.includes('dsh plugin --profile headless add dsh-connect-mockprov'),
      ),
      'testProviderConnection must include missing-plugin warning',
    );

    // Patch-only NO_ADAPTER hint helper works without reading package.json
    const noAdapterHint = getDshNoAdapterHint('headless', 'mockprov');
    assert.match(noAdapterHint, /dsh plugin --profile headless add dsh-connect-mockprov/);
    const noAdapterPiAiHint = getDshNoAdapterHint('headless', 'custom-gw');
    assert.match(noAdapterPiAiHint, /llm-pi-ai.*desktop/i);

    // When dsh is disabled, checkDshPlugins: true must skip plugin warnings
    const disabledDataDir = join(root, 'data-disabled');
    mkdirSync(disabledDataDir, { recursive: true });
    writeFileSync(
      join(disabledDataDir, 'providers.json'),
      JSON.stringify({
        providers: {
          dsh: {
            enabled: false,
            command: fakeDsh,
            profile: 'headless',
          },
        },
      }),
      'utf8',
    );
    const snapDisabled = getProviderConfigSnapshot(disabledDataDir, undefined, 'headless', {
      bypassCache: true,
      checkDshPlugins: true,
    });
    assert.equal(
      snapDisabled.providers.find((p) => p.id === 'dsh')?.warnings?.length ?? 0,
      0,
      'Disabled dsh provider must skip package.json plugin warnings',
    );

    // Populate providerSnapshotCache ({ bypassCache: false, checkDshPlugins: true }), then install plugin into headless/package.json
    const cachedSnap = getProviderConfigSnapshot(dataDir, undefined, 'headless', {
      bypassCache: false,
      checkDshPlugins: true,
    });
    assert.ok(
      cachedSnap.providers.find((p) => p.id === 'dsh')?.warnings?.some((w) =>
        w.includes('dsh-connect-mockprov'),
      ),
    );
    const pkgPath = join(dshHome, 'profiles', 'headless', 'package.json');
    writeFileSync(
      pkgPath,
      JSON.stringify({
        name: 'dsh-profile-headless',
        dependencies: { 'dsh-connect-mockprov': '^1.0.0' },
        dsh: {
          profile: {
            bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', 'dsh-connect-mockprov'],
          },
        },
      }),
      'utf8',
    );
    const nextMtime = new Date(Date.now() + 2000);
    utimesSync(pkgPath, nextMtime, nextMtime);

    // Test Plan B: sanitized sibling catalog overlay + --patch emission + readiness checks
    const overlayCn = buildDshSiblingCatalogOverlay('headless', 'mockprov', 'mock-flash');
    assert.ok(overlayCn, 'Expected sanitized sibling catalog overlay for mockprov/mock-flash');
    assert.equal(overlayCn.id, 'dsh-connect-mockprov');
    assert.equal('name' in overlayCn, false, 'Overlay entry must omit name property');
    assert.equal('apiKey' in overlayCn.config, false);
    const cnRegionOverlay = overlayCn.config?.regions?.cn;
    assert.equal(cnRegionOverlay?.enabled, true);
    assert.equal('cnBase' in (cnRegionOverlay || {}), false);
    assert.equal('enabledModelIds' in (cnRegionOverlay || {}), false);
    assert.equal('pool' in (cnRegionOverlay || {}), false);
    assert.deepEqual(cnRegionOverlay?.lastCatalog?.[0], {
      id: 'mock-flash',
      name: 'Mock Flash',
      contextWindow: 1000000,
      maxTokens: 128000,
      supportsImages: true,
      reasoning: {
        supportedEfforts: ['low', 'high'],
        defaultEffort: 'high',
        canDisableThinking: true,
      },
    });

    const overlayFlat = buildDshSiblingCatalogOverlay('headless', 'acme-llm', 'acme-fast');
    assert.equal(overlayFlat?.id, 'acme-bridge');
    assert.equal(overlayFlat?.config?.lastCatalog?.[0]?.id, 'acme-fast');
    assert.equal(
      buildDshSiblingCatalogOverlay('headless', 'custom-gw', 'gw-model-1'),
      undefined,
      'llm-pi-ai entries must not generate plugin catalog overlay',
    );

    const patchesDir = join(root, 'patches');
    const dshAdapterTest = getBuiltinAdapter('dsh');
    const overlayInv = dshAdapterTest.buildInvocation({
      prompt: 'test overlay',
      workerName: 'w-overlay',
      cwd: root,
      model: 'mockprov/mock-flash',
      permissionMode: 'read-only',
      profile: 'headless',
      swarmDir: root,
      patchesDir,
      boardCli: '/tmp/ext-board.mjs',
    });
    assert.ok(overlayInv.args.includes('--patch'));
    const generatedPatch = YAML.parse(readFileSync(join(patchesDir, 'w-overlay.yml'), 'utf8'));
    assert.equal(generatedPatch.length, 2);
    assert.equal(generatedPatch[0].id, 'agent-default-model');
    assert.equal(generatedPatch[0].config.provider, 'mockprov');
    assert.equal(generatedPatch[0].config.model, 'mock-flash');
    assert.equal(generatedPatch[1].id, 'dsh-connect-mockprov');
    assert.equal(generatedPatch[1].config?.regions?.cn?.lastCatalog?.[0]?.id, 'mock-flash');

    assert.equal(checkDshProfileProviderPlugin('headless', 'mockprov').ok, true);
    const readinessOverlay = checkDshModelCatalogReadiness('headless', 'mockprov', 'mock-flash');
    assert.equal(readinessOverlay.status, 'sibling-overlay');
    assert.equal(readinessOverlay.sourceProfile, 'desktop');

    const connAfterInstall = await testProviderConnection('dsh', dataDir, undefined, 'headless');
    assert.equal(connAfterInstall.ok, true);
    assert.equal(
      connAfterInstall.warnings?.some((w) => w.includes('mockprov')) ?? false,
      false,
      `Expected no warnings for mockprov once plugin is installed and sibling overlay is ready, got: ${JSON.stringify(connAfterInstall.warnings)}`,
    );
    assert.match(connAfterInstall.details, /from "desktop"/);
    assert.match(connAfterInstall.details, /sibling catalog overlay ready via --patch/);

    const refreshedSnap = getProviderConfigSnapshot(dataDir, undefined, 'headless', {
      bypassCache: false,
      checkDshPlugins: true,
    });
    const refreshedDsh = refreshedSnap.providers.find((p) => p.id === 'dsh');
    assert.equal(
      refreshedDsh?.warnings?.some((w) => w.includes('dsh-connect-mockprov')) ?? false,
      false,
      'Snapshot cache must invalidate via package.json mtime when plugin is installed',
    );

    // Custom config in headless/cordis.patch.yml without mock-flash must NOT be clobbered
    writeFileSync(
      join(dshHome, 'profiles', 'headless', 'cordis.patch.yml'),
      [
        '- id: dsh-connect-mockprov',
        '  name: dsh-connect-mockprov',
        '  config:',
        '    regions:',
        '      cn:',
        '        cnBase: https://custom.local',
      ].join('\n'),
      'utf8',
    );
    assert.equal(
      buildDshSiblingCatalogOverlay('headless', 'mockprov', 'mock-flash'),
      undefined,
      'Must NOT overwrite user-customized headless plugin config',
    );
    const readinessMissing = checkDshModelCatalogReadiness('headless', 'mockprov', 'mock-flash');
    assert.equal(readinessMissing.status, 'missing-in-profile');
    assert.match(readinessMissing.warning || '', /UNKNOWN_MODEL/);
    const connCustomConflict = await testProviderConnection('dsh', dataDir, undefined, 'headless');
    assert.ok(
      connCustomConflict.warnings?.some((w) => w.includes('UNKNOWN_MODEL')),
      `Expected UNKNOWN_MODEL warning when headless custom config lacks model, got: ${JSON.stringify(connCustomConflict.warnings)}`,
    );
    const unknownHint = getDshUnknownModelHint('headless', 'mockprov', 'mock-flash');
    assert.match(unknownHint, /mock-flash/);
    assert.match(unknownHint, /cordis\.patch\.yml/);

    // Disabling plugin in headless/cordis.patch.yml triggers plugin-disabled warning
    writeFileSync(
      join(dshHome, 'profiles', 'headless', 'cordis.patch.yml'),
      '- id: dsh-connect-mockprov\n  name: dsh-connect-mockprov\n  disabled: true\n',
      'utf8',
    );
    const chkDisabled = checkDshProfileProviderPlugin('headless', 'mockprov');
    assert.equal(chkDisabled.ok, false);
    assert.equal(chkDisabled.reason, 'plugin-disabled');
    assert.equal(chkDisabled.pluginPackage, 'dsh-connect-mockprov');
  } finally {
    if (prevDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevDshHome;
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function main() {
  testBuiltinAdapterParsers();
  testModelDiscovery();
  await testDshProfilePluginDetection();
  console.log('[providers.test] Built-in, model discovery, dsh plugin check & custom adapter unit checks passed');

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
if (mode === 'list-models') {
  console.log('mock-pro\\nmock-flash');
  process.exit(0);
}
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
  const hasDiffHint = prompt.includes('inspect diff: git diff');
  console.log('@coordinator [done] reviewer saw prompt len=' + prompt.length + ' upstream=' + hasUpstreamTag + ' diffHint=' + hasDiffHint);
}
`,
      { mode: 0o755 },
    );

    // Repo-level .agy-ext-swarm/providers.json cannot define custom executable CLIs;
    // register mock-reviewer globally after checking fresh dataDir onboarding state.

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
      'app_discover_models',
      'app_delete_swarm',
      'app_export_swarm',
      'app_preview_merge',
      'app_merge_worker',
      'app_create_swarm',
      'app_update_swarm_budget',
      'app_create_worker_pr',
      'app_add_worker',
      'app_start_arena',
      'app_cross_review',
      'app_get_templates',
      'app_save_template',
      'app_apply_template',
      'app_get_native_subagent_log',
    ]) {
      assert.ok(toolNames.includes(expectedName), `Missing tool: ${expectedName}`);
    }
    assert.equal(toolNames.length, 44, `Expected 44 tools, got ${toolNames.length}`);

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
    const updRetryDesc =
      toolByName.get('ext_swarm_update_worker')?.inputSchema?.properties?.retry?.description || '';
    assert.equal(
      updRetryDesc.includes('?'),
      false,
      `ext_swarm_update_worker.retry schema must not contain draft question marks: ${updRetryDesc}`,
    );
    assert.match(updRetryDesc, /auto-enabled when prompt is provided/i);

    const createProps = toolByName.get('ext_swarm_create')?.inputSchema?.properties || {};
    assert.ok(
      'turn_timeout_seconds' in createProps && 'stall_timeout_seconds' in createProps,
      'ext_swarm_create must expose timeout overrides matching app_create_swarm and runtime',
    );
    const addProps = toolByName.get('ext_swarm_add')?.inputSchema?.properties || {};
    assert.ok(
      'turn_timeout_seconds' in addProps,
      'ext_swarm_add must expose turn_timeout_seconds matching app_add_worker and runtime',
    );
    assert.ok(
      'agent' in (toolByName.get('ext_swarm_read')?.inputSchema?.properties || {}),
      'ext_swarm_read must expose optional agent filter',
    );

    // 4. Verify fresh onboarding state BEFORE writing global providers.json, then configure mock-reviewer globally
    const freshProvList = parseJsonToolResult(
      await client.callTool({ name: 'ext_swarm_providers', arguments: { repo_root: repoDir } }),
    );
    assert.equal(freshProvList.defaultTurnTimeoutSeconds, 1800);
    assert.equal(freshProvList.defaultStallTimeoutSeconds, 300);
    assert.equal(freshProvList.globalConfigExists, false, 'Fresh dataDir should report globalConfigExists=false');
    assert.equal(freshProvList.needsOnboarding, true, 'Fresh dataDir should report needsOnboarding=true');

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

    await client.callTool({
      name: 'app_save_provider_config',
      arguments: {
        default_provider: 'mock-reviewer',
        upsert_provider: {
          id: 'mock-reviewer',
          config: {
            enabled: true,
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
    });
    const provList = parseJsonToolResult(
      await client.callTool({ name: 'ext_swarm_providers', arguments: { repo_root: repoDir } }),
    );
    assert.equal(provList.defaultProvider, 'mock-reviewer');
    assert.equal(provList.globalConfigExists, true);
    const ids = provList.providers.map((p) => p.id);
    for (const expectedId of ['dsh', 'claude', 'codex', 'gemini', 'agy', 'mock-reviewer']) {
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
    assert.equal(created.swarm.turnTimeoutSeconds, 1800);
    assert.equal(created.swarm.stallTimeoutSeconds, 300);

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
    const byModelSince = orchStatus.hostTelemetry?.coordinator?.byModelSinceSwarm;
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
    const wdSwarmRes = await client.callTool({
      name: 'app_create_swarm',
      arguments: {
        title: 'Watchdog Test Swarm',
        repo_root: repoDir,
        turn_timeout_seconds: 10,
        stall_timeout_seconds: 1,
      },
    });
    const wdSwarm = wdSwarmRes.structuredContent;
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

    // 7g. Global timeout defaults, coordinator message classification, prompt budget, and hard-timeout auto-converge
    const saveTimeoutCfgRes = await client.callTool({
      name: 'app_save_provider_config',
      arguments: {
        default_turn_timeout_seconds: 2400,
        default_stall_timeout_seconds: 0,
      },
    });
    assert.equal(saveTimeoutCfgRes.structuredContent?.providerConfig?.defaultTurnTimeoutSeconds, 2400);
    assert.equal(
      saveTimeoutCfgRes.structuredContent?.providerConfig?.defaultStallTimeoutSeconds,
      0,
      '0 stall timeout must be preserved and not treated as falsy',
    );
    const provWithCustomTimeouts = parseJsonToolResult(
      await client.callTool({ name: 'ext_swarm_providers', arguments: { repo_root: repoDir } }),
    );
    assert.equal(provWithCustomTimeouts.defaultTurnTimeoutSeconds, 2400);
    assert.equal(provWithCustomTimeouts.defaultStallTimeoutSeconds, 0);

    const inheritedSwarm = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_create',
        arguments: { title: 'Inherited Timeouts Swarm', repo_root: repoDir },
      }),
    );
    assert.equal(inheritedSwarm.swarm.turnTimeoutSeconds, 2400);
    assert.equal(inheritedSwarm.swarm.stallTimeoutSeconds, 0);
    await client.callTool({
      name: 'app_delete_swarm',
      arguments: { swarm_id: inheritedSwarm.swarm.id, remove_worktrees: true },
    });

    const overrideSwarmRes = await client.callTool({
      name: 'app_create_swarm',
      arguments: {
        title: 'Override Timeouts Swarm',
        repo_root: repoDir,
        turn_timeout_seconds: 900,
        stall_timeout_seconds: 150,
      },
    });
    const overrideSwarm = overrideSwarmRes.structuredContent;
    assert.equal(overrideSwarm.swarm.turnTimeoutSeconds, 900);
    assert.equal(overrideSwarm.swarm.stallTimeoutSeconds, 150);

    // Coordinator messages instructing workers to emit [done]/[blocker] must stay kind='message'
    const coordPost = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_post',
        arguments: {
          swarm_id: overrideSwarm.swarm.id,
          text: '@all 请立即收敛并输出 [done] 或 [blocker] 报告',
        },
      }),
    );
    assert.equal(coordPost.message.kind, 'message');
    await client.callTool({
      name: 'app_delete_swarm',
      arguments: { swarm_id: overrideSwarm.swarm.id, remove_worktrees: true },
    });

    // Reset global timeout defaults back to null (built-in 1800 / 300)
    const resetTimeoutCfgRes = await client.callTool({
      name: 'app_save_provider_config',
      arguments: {
        default_turn_timeout_seconds: null,
        default_stall_timeout_seconds: null,
      },
    });
    assert.equal(resetTimeoutCfgRes.structuredContent?.providerConfig?.defaultTurnTimeoutSeconds, undefined);
    assert.equal(resetTimeoutCfgRes.structuredContent?.providerConfig?.defaultStallTimeoutSeconds, undefined);
    const provResetTimeouts = parseJsonToolResult(
      await client.callTool({ name: 'ext_swarm_providers', arguments: { repo_root: repoDir } }),
    );
    assert.equal(provResetTimeouts.defaultTurnTimeoutSeconds, 1800);
    assert.equal(provResetTimeouts.defaultStallTimeoutSeconds, 300);

    // Hard-timeout auto-converge (Case A: converges on resume; Case B: capped at 1 retry)
    const convergeMockPath = join(tempRoot, 'converge-mock.mjs');
    const convergePromptCapturePath = join(tempRoot, 'converge-prompts.json');
    writeFileSync(
      convergeMockPath,
      `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const phase = process.argv[2] || 'first';
const sid = process.argv[3] || 'sess-conv-1';
const capturePath = ${JSON.stringify(convergePromptCapturePath)};
const prompt = readFileSync(0, 'utf8');
const prev = existsSync(capturePath) ? JSON.parse(readFileSync(capturePath, 'utf8')) : [];
prev.push({ phase, sid, prompt });
writeFileSync(capturePath, JSON.stringify(prev), 'utf8');
if (phase === 'first' || phase === 'first-loop' || phase === 'resume-loop') {
  console.log(JSON.stringify({ type: 'session', sessionId: sid }));
  console.log(JSON.stringify({ type: 'status', phase: 'turn_start' }));
  console.log(JSON.stringify({ type: 'status', phase: 'step_start' }));
  console.log(JSON.stringify({ type: 'tool_call', tool: 'bash', input: { command: 'rg symbol src/' } }));
  const timer = setInterval(() => {
    console.log(JSON.stringify({ type: 'tool_call', tool: 'bash', input: { command: 'read next chunk' } }));
  }, 350);
  timer.ref();
} else if (phase === 'resume-ok') {
  console.log(JSON.stringify({ type: 'session', sessionId: sid }));
  console.log(JSON.stringify({ type: 'status', phase: 'turn_start' }));
  console.log(JSON.stringify({ type: 'status', phase: 'step_start' }));
  console.log(JSON.stringify({
    type: 'final',
    sessionId: sid,
    reason: { kind: 'completed' },
    text: '@coordinator [done] converged smoothly from session ' + sid,
  }));
} else if (phase === 'writer-instant') {
  console.log('@coordinator [done] instant ok');
}
`,
      { mode: 0o755 },
    );

    const convSwarmRes = await client.callTool({
      name: 'app_create_swarm',
      arguments: {
        title: 'Auto-Converge Timeout Test',
        repo_root: repoDir,
        turn_timeout_seconds: 2,
        stall_timeout_seconds: 12,
        routing_policy: { auto_failover: false },
      },
    });
    const convSwarm = convSwarmRes.structuredContent;
    const convId = convSwarm.swarm.id;

    // Case A: Turn 1 times out while actively working -> auto-converge succeeds on Turn 2
    await client.callTool({
      name: 'ext_swarm_add',
      arguments: {
        swarm_id: convId,
        name: 'conv-ok',
        provider: 'custom',
        custom_command: {
          command: 'node',
          args: [convergeMockPath, 'first', 'sess-conv-ok'],
          resume_args: [convergeMockPath, 'resume-ok', '{{sessionId}}'],
          prompt_mode: 'stdin',
          output_format: 'ndjson',
        },
        workspace: 'inherit',
        permission_mode: 'read-only',
        brief: 'Inspect modules and summarize.',
      },
    });
    const convWaitOk = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_wait',
        arguments: { swarm_id: convId, until: 'worker_done', worker_name: 'conv-ok', timeout_seconds: 20 },
      }),
    );
    assert.equal(convWaitOk.timedOut, false);
    assert.equal(convWaitOk.swarm.members['conv-ok'].status, 'waiting');
    assert.equal(convWaitOk.swarm.members['conv-ok'].turns, 2);
    assert.equal(convWaitOk.swarm.members['conv-ok'].retryTurns, 1);
    const convBoardOk = parseJsonToolResult(
      await client.callTool({ name: 'ext_swarm_read', arguments: { swarm_id: convId } }),
    );
    assert.ok(
      convBoardOk.messages.some(
        (m) => m.agent === 'system' && m.kind === 'system' && m.text.includes('[auto-converge]'),
      ),
      'Board should record [auto-converge] system notice',
    );
    assert.ok(
      convBoardOk.messages.some(
        (m) =>
          m.agent === 'conv-ok' &&
          m.kind === 'done' &&
          m.text.includes('converged smoothly from session sess-conv-ok'),
      ),
      'Converged resume turn should post final @coordinator [done] report',
    );
    const capturedPrompts = JSON.parse(readFileSync(convergePromptCapturePath, 'utf8'));
    assert.ok(capturedPrompts.length >= 2);
    assert.ok(capturedPrompts[0].prompt.includes('Time budget: This turn has a hard limit of 2s'));
    assert.ok(capturedPrompts[0].prompt.includes('Do NOT spawn nested subagents'));
    assert.ok(capturedPrompts[1].prompt.includes('STOP reading new files'));
    assert.ok(capturedPrompts[1].prompt.includes('hard timeout (2s)'));

    // Case B: Convergence turn ALSO exceeds timeout -> fails without infinite retry loop
    await client.callTool({
      name: 'ext_swarm_add',
      arguments: {
        swarm_id: convId,
        name: 'conv-loop',
        provider: 'custom',
        custom_command: {
          command: 'node',
          args: [convergeMockPath, 'first-loop', 'sess-conv-loop'],
          resume_args: [convergeMockPath, 'resume-loop', '{{sessionId}}'],
          prompt_mode: 'stdin',
          output_format: 'ndjson',
        },
        workspace: 'inherit',
        permission_mode: 'read-only',
        brief: 'Never finishes even when converging.',
      },
    });
    const convWaitLoop = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_wait',
        arguments: { swarm_id: convId, until: 'worker_done', worker_name: 'conv-loop', timeout_seconds: 20 },
      }),
    );
    assert.equal(convWaitLoop.timedOut, false);
    assert.equal(convWaitLoop.swarm.members['conv-loop'].status, 'failed');
    assert.equal(convWaitLoop.swarm.members['conv-loop'].turns, 2);
    assert.equal(convWaitLoop.swarm.members['conv-loop'].retryTurns, 1);

    // Case C: Non-read-only writer without allowed_files + fresh-session (@name) wake guardrails
    await client.callTool({
      name: 'ext_swarm_add',
      arguments: {
        swarm_id: convId,
        name: 'prompt-writer',
        provider: 'custom',
        custom_command: {
          command: 'node',
          args: [convergeMockPath, 'writer-instant', 'no-session'],
          prompt_mode: 'stdin',
          output_format: 'text',
        },
        workspace: 'inherit',
        permission_mode: 'workspace-write',
        brief: 'Implement feature cleanly.',
      },
    });
    await client.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: convId, until: 'worker_done', worker_name: 'prompt-writer', timeout_seconds: 15 },
    });
    const wakeWriterPost = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_post',
        arguments: { swarm_id: convId, text: '@prompt-writer add follow-up check' },
      }),
    );
    assert.deepEqual(wakeWriterPost.delivery, {
      woken: ['prompt-writer'],
      deferred: [],
    });
    await client.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: convId, until: 'worker_done', worker_name: 'prompt-writer', timeout_seconds: 15 },
    });
    const writerPrompts = JSON.parse(readFileSync(convergePromptCapturePath, 'utf8')).filter(
      (entry) => entry.phase === 'writer-instant',
    );
    assert.equal(writerPrompts.length, 2);
    assert.ok(
      writerPrompts[0].prompt.includes('Do NOT relax existing test assertions'),
      'Writer without allowed_files must still receive code quality rule',
    );
    assert.ok(
      writerPrompts[0].prompt.includes(
        'Only @mention another worker if your assignment explicitly specifies a peer handoff',
      ),
      'Initial worker prompt must restrict unsolicited @peer mentions',
    );
    assert.ok(
      writerPrompts[1].prompt.includes('Do NOT spawn nested subagents') &&
        writerPrompts[1].prompt.includes('Do NOT relax existing test assertions'),
      'Fresh-session wake (!sessionId) must retain anti-subagent and quality guardrails',
    );

    await client.callTool({
      name: 'app_delete_swarm',
      arguments: { swarm_id: convId, remove_worktrees: true },
    });

    // Case D: App/UI per-worker turn_timeout_seconds override inside 1800s default swarm + deferred/skipped delivery visibility
    await client.callTool({
      name: 'app_save_provider_config',
      arguments: {
        upsert_provider: {
          id: 'converge-fast',
          config: {
            enabled: true,
            command: 'node',
            args: [convergeMockPath, 'first', 'sess-ro-fast'],
            resumeArgs: [convergeMockPath, 'resume-ok', '{{sessionId}}'],
            promptMode: 'stdin',
            outputFormat: 'ndjson',
          },
        },
      },
    });
    const perWorkerSwarm = (
      await client.callTool({
        name: 'app_create_swarm',
        arguments: {
          title: 'Per-Worker Timeout & Delivery Test',
          repo_root: repoDir,
          stall_timeout_seconds: 12,
          routing_policy: { auto_failover: false },
        },
      })
    ).structuredContent;
    const pwSwarmId = perWorkerSwarm.swarm.id;
    assert.equal(perWorkerSwarm.swarm.turnTimeoutSeconds, 1800);

    const addRoFast = (
      await client.callTool({
        name: 'app_add_worker',
        arguments: {
          swarm_id: pwSwarmId,
          name: 'ro-fast',
          provider: 'converge-fast',
          workspace: 'inherit',
          permission_mode: 'read-only',
          turn_timeout_seconds: 2,
          brief: 'Focused read-only audit with per-worker 2s budget.',
        },
      })
    ).structuredContent;
    assert.equal(addRoFast.added[0].turnTimeoutSeconds, 2);

    // Immediately post while ro-fast is queued/working -> delivery.deferred must name ro-fast unconditionally
    const deferredPost = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_post',
        arguments: { swarm_id: pwSwarmId, text: '@ro-fast prioritize ledger check' },
      }),
    );
    assert.deepEqual(deferredPost.delivery, {
      woken: [],
      deferred: ['ro-fast'],
    });

    const pwWait = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_wait',
        arguments: { swarm_id: pwSwarmId, until: 'all_idle', timeout_seconds: 20 },
      }),
    );
    assert.equal(pwWait.timedOut, false);
    assert.equal(pwWait.swarm.members['ro-fast'].status, 'waiting');
    assert.ok(pwWait.swarm.members['ro-fast'].retryTurns >= 1);

    const roFastFirstPrompt = JSON.parse(readFileSync(convergePromptCapturePath, 'utf8')).find(
      (entry) => entry.sid === 'sess-ro-fast' && entry.phase === 'first',
    );
    assert.ok(roFastFirstPrompt, 'ro-fast first-turn prompt should be captured');
    assert.ok(
      roFastFirstPrompt.prompt.includes('Time budget: This turn has a hard limit of 2s'),
      'Per-worker turn_timeout_seconds must override swarm 1800s budget in prompt',
    );

    await client.callTool({
      name: 'ext_swarm_kill',
      arguments: { swarm_id: pwSwarmId, name: 'ro-fast' },
    });
    const skippedPost = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_post',
        arguments: { swarm_id: pwSwarmId, text: '@ro-fast ping after kill' },
      }),
    );
    assert.deepEqual(skippedPost.delivery, {
      woken: [],
      deferred: [],
      skipped: [{ name: 'ro-fast', reason: 'killed' }],
    });

    await client.callTool({
      name: 'app_delete_swarm',
      arguments: { swarm_id: pwSwarmId, remove_worktrees: true },
    });
    await client.callTool({
      name: 'app_save_provider_config',
      arguments: { remove_provider: 'converge-fast' },
    });

    // 7h. Event-driven ext-board wait (fs.watch zero-polling wakeup) & asyncWaitCommand
    const waitSwarmRes = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_create',
        arguments: { title: 'Event Wait Swarm', repo_root: repoDir },
      }),
    );
    const waitSwarmId = waitSwarmRes.swarm.id;
    const waitSwarmDir = join(dataDir, 'swarms', waitSwarmId);
    assert.ok(
      typeof waitSwarmRes.asyncWaitCommand === 'string' &&
        waitSwarmRes.asyncWaitCommand.includes('wait') &&
        waitSwarmRes.asyncWaitCommand.includes('--swarm-dir'),
      `ext_swarm_create must return asyncWaitCommand, got: ${waitSwarmRes.asyncWaitCommand}`,
    );

    const addSlowWaitRes = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_add',
        arguments: {
          swarm_id: waitSwarmId,
          name: 'slow-ev',
          provider: 'custom',
          workspace: 'worktree',
          custom_command: {
            command: 'node',
            args: [mockCliPath, 'slow'],
            prompt_mode: 'stdin',
            output_format: 'text',
          },
          brief: 'Finish asynchronously around 450ms.',
        },
      }),
    );
    assert.ok(
      typeof addSlowWaitRes.asyncWaitCommand === 'string' &&
        addSlowWaitRes.asyncWaitCommand.includes('--until all_idle'),
      'ext_swarm_add must return asyncWaitCommand',
    );
    const evStartMs = Date.now();
    const evAllIdleOut = await execFileAsync(process.execPath, [
      BOARD_CLI,
      'wait',
      '--swarm-dir',
      waitSwarmDir,
      '--since',
      String(addSlowWaitRes.briefSeqs[0]),
      '--until',
      'all_idle',
      '--timeout',
      '15',
    ]);
    const evElapsedMs = Date.now() - evStartMs;
    const evAllIdleJson = JSON.parse(evAllIdleOut.stdout.trim());
    assert.equal(evAllIdleJson.ok, true);
    assert.equal(evAllIdleJson.timedOut, false);
    assert.equal(evAllIdleJson.reason, 'all_workers_idle');
    assert.ok(
      evElapsedMs < 2500,
      `fs.watch event wakeup should trigger well before 3s fallback interval (took ${evElapsedMs}ms)`,
    );
    assert.equal(
      evAllIdleJson.members.find((m) => m.name === 'slow-ev')?.status,
      'waiting',
    );
    assert.ok(
      evAllIdleJson.messages.some(
        (m) => m.agent === 'slow-ev' && m.kind === 'done' && m.text.includes('slow upstream finished'),
      ),
      'ext-board wait output should include completed worker [done] post',
    );

    // Immediate exit when condition is already satisfied
    const immStartMs = Date.now();
    const immOut = await execFileAsync(process.execPath, [
      BOARD_CLI,
      'wait',
      '--swarm-dir',
      waitSwarmDir,
      '--until',
      'all_idle',
      '--timeout',
      '10',
    ]);
    assert.ok(Date.now() - immStartMs < 500, 'Already-idle swarm should exit immediately');
    assert.equal(JSON.parse(immOut.stdout.trim()).reason, 'all_workers_idle');

    // Filtered ext_swarm_read by agent + worker-only reportPath + 12KB UTF-8 adaptive wait budget
    const filteredRead = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_read',
        arguments: { swarm_id: waitSwarmId, since: 0, agent: 'slow-ev' },
      }),
    );
    assert.ok(filteredRead.messages.length >= 1, 'Filtered read for slow-ev must find its post');
    assert.ok(
      filteredRead.messages.every((m) => m.agent === 'slow-ev'),
      'Filtered ext_swarm_read must return only posts from slow-ev',
    );
    const doneWorkerMsg = filteredRead.messages.find((m) => m.kind === 'done');
    assert.ok(
      doneWorkerMsg?.reportPath &&
        doneWorkerMsg.reportPath.endsWith('.md') &&
        existsSync(doneWorkerMsg.reportPath),
      'Worker [done] post must persist pure Markdown reportPath on disk',
    );

    // Coordinator long post (>400 chars) must NOT pollute reports/ directory
    const coordLongBody = 'COORD_NOTE: ' + 'z'.repeat(600);
    const coordLongRes = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_post',
        arguments: { swarm_id: waitSwarmId, text: coordLongBody },
      }),
    );
    assert.equal(
      coordLongRes.message.reportPath,
      undefined,
      'Coordinator post must not create a file under reports/',
    );

    // Worker 600-char post via ext-board -> under 12KB UTF-8 budget -> full text + readable reportPath
    const workerMediumBody = 'WORKER_SUMMARY: ' + 'w'.repeat(600);
    await execFileAsync(process.execPath, [
      BOARD_CLI,
      'post',
      '--swarm-dir',
      waitSwarmDir,
      '--as',
      'slow-ev',
      workerMediumBody,
    ]);
    const drainedMedium = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_read',
        arguments: { swarm_id: waitSwarmId, since: coordLongRes.message.seq, agent: 'slow-ev' },
      }),
    );
    const mediumWorkerMsg = drainedMedium.messages.find((m) => m.text === workerMediumBody);
    assert.ok(
      mediumWorkerMsg?.reportPath && existsSync(mediumWorkerMsg.reportPath),
      'Worker >400 char post should persist reportPath .md',
    );
    assert.equal(readFileSync(mediumWorkerMsg.reportPath, 'utf8'), `${workerMediumBody}\n`);

    const underBudgetWaitOut = await execFileAsync(process.execPath, [
      BOARD_CLI,
      'wait',
      '--swarm-dir',
      waitSwarmDir,
      '--since',
      String(mediumWorkerMsg.seq - 1),
      '--until',
      'any_post',
      '--timeout',
      '5',
    ]);
    const underBudgetJson = JSON.parse(underBudgetWaitOut.stdout.trim());
    assert.equal(underBudgetJson.compactMode, undefined);
    const underBudgetMsg = underBudgetJson.messages.find((m) => m.seq === mediumWorkerMsg.seq);
    assert.ok(underBudgetMsg, 'Under-budget wait output should contain the 600+ char worker post');
    assert.equal(underBudgetMsg.truncated, undefined);
    assert.equal(underBudgetMsg.text, workerMediumBody);
    assert.equal(underBudgetMsg.reportPath, mediumWorkerMsg.reportPath);

    // Over 12KB UTF-8 budget using CJK text (~5400 chars < 12000 chars, but ~16.2KB UTF-8 > 12288 bytes)
    const overSince = mediumWorkerMsg.seq;
    const cjkBodies = [];
    const cjkWorkerMsgs = [];
    for (let i = 1; i <= 3; i++) {
      const body = `审查报告${i}：` + '中文缺陷详述'.repeat(300);
      cjkBodies.push(body);
      await execFileAsync(process.execPath, [
        BOARD_CLI,
        'post',
        '--swarm-dir',
        waitSwarmDir,
        '--as',
        'slow-ev',
        body,
      ]);
      const drained = parseJsonToolResult(
        await client.callTool({
          name: 'ext_swarm_read',
          arguments: {
            swarm_id: waitSwarmId,
            since: cjkWorkerMsgs.length ? cjkWorkerMsgs[cjkWorkerMsgs.length - 1].seq : overSince,
            agent: 'slow-ev',
          },
        }),
      );
      const found = drained.messages.find((m) => m.text === body);
      assert.ok(found, `Expected CJK worker post ${i} to be persisted`);
      cjkWorkerMsgs.push(found);
    }
    const overBudgetWaitOut = await execFileAsync(process.execPath, [
      BOARD_CLI,
      'wait',
      '--swarm-dir',
      waitSwarmDir,
      '--since',
      String(overSince),
      '--until',
      'any_post',
      '--timeout',
      '5',
    ]);
    const overBudgetJson = JSON.parse(overBudgetWaitOut.stdout.trim());
    assert.equal(overBudgetJson.compactMode, true);
    assert.equal(overBudgetJson.messages.length, 3);
    for (let i = 0; i < 3; i++) {
      const wm = overBudgetJson.messages[i];
      const expectedText = cjkBodies[i];
      assert.equal(wm.truncated, true);
      assert.equal(wm.textLen, expectedText.length);
      assert.ok(wm.text.length <= 303, `Expected truncated snippet <= 303 chars, got ${wm.text.length}`);
      assert.equal(wm.reportPath, cjkWorkerMsgs[i].reportPath);
      assert.equal(readFileSync(wm.reportPath, 'utf8'), `${expectedText}\n`);
    }

    // Verify fallback ext_swarm_wait shares the same 12KB UTF-8 adaptive compactMode behavior
    const mcpOverWait = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_wait',
        arguments: { swarm_id: waitSwarmId, since: overSince, until: 'any_post', timeout_seconds: 5 },
      }),
    );
    assert.equal(mcpOverWait.compactMode, true);
    assert.equal(mcpOverWait.messages.length, 3);
    for (let i = 0; i < 3; i++) {
      const mm = mcpOverWait.messages[i];
      assert.equal(mm.truncated, true);
      assert.equal(mm.textLen, cjkBodies[i].length);
      assert.ok(mm.text.length <= 303, `Expected MCP wait snippet <= 303 chars, got ${mm.text.length}`);
      assert.equal(mm.reportPath, cjkWorkerMsgs[i].reportPath);
    }

    // Verify downstream depends_on worker receives upstream reportPath in injected context
    await client.callTool({
      name: 'ext_swarm_add',
      arguments: {
        swarm_id: waitSwarmId,
        name: 'synth-ev',
        provider: 'custom',
        custom_command: {
          command: 'node',
          args: [convergeMockPath, 'writer-instant', 'no-session'],
          prompt_mode: 'stdin',
          output_format: 'text',
        },
        workspace: 'inherit',
        permission_mode: 'read-only',
        depends_on: ['slow-ev'],
        brief: 'Synthesize upstream reportPath files.',
      },
    });
    await client.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: waitSwarmId, until: 'worker_done', worker_name: 'synth-ev', timeout_seconds: 15 },
    });
    const synthPrompt = JSON.parse(readFileSync(convergePromptCapturePath, 'utf8')).find(
      (entry) =>
        entry.phase === 'writer-instant' &&
        entry.prompt.includes('[Upstream Dependencies Completed: slow-ev]'),
    );
    assert.ok(synthPrompt, 'Downstream depends_on worker prompt must include upstream context');
    assert.ok(
      synthPrompt.prompt.includes(`reportPath: ${cjkWorkerMsgs[2].reportPath}`),
      'Downstream depends_on prompt must inject upstream reportPath',
    );

    // Concurrent mentions_coordinator & worker_done waits triggered by post + worker completion
    const postCheckRes = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_post',
        arguments: { swarm_id: waitSwarmId, text: '@slow-ev ping for asyncWaitCommand' },
      }),
    );
    assert.ok(
      typeof postCheckRes.asyncWaitCommand === 'string' &&
        postCheckRes.asyncWaitCommand.includes(`--since ${postCheckRes.message.seq}`),
      'ext_swarm_post must return asyncWaitCommand anchored after post seq',
    );
    const [mentionWaitRes, workerDoneWaitRes] = await Promise.all([
      execFileAsync(process.execPath, [
        BOARD_CLI,
        'wait',
        '--swarm-dir',
        waitSwarmDir,
        '--since',
        String(postCheckRes.message.seq),
        '--until',
        'mentions_coordinator',
        '--timeout',
        '15',
      ]),
      execFileAsync(process.execPath, [
        BOARD_CLI,
        'wait',
        '--swarm-dir',
        waitSwarmDir,
        '--since',
        String(postCheckRes.message.seq),
        '--until',
        'worker_done',
        '--worker',
        'slow-ev',
        '--timeout',
        '15',
      ]),
    ]);
    const mentionJson = JSON.parse(mentionWaitRes.stdout.trim());
    assert.equal(mentionJson.timedOut, false);
    assert.equal(mentionJson.reason, 'mentions_coordinator');
    assert.ok(mentionJson.messages.some((m) => m.agent === 'slow-ev'));
    const workerDoneJson = JSON.parse(workerDoneWaitRes.stdout.trim());
    assert.equal(workerDoneJson.timedOut, false);
    assert.equal(workerDoneJson.reason, 'worker_waiting');

    const idleStatusRes = parseJsonToolResult(
      await client.callTool({ name: 'ext_swarm_status', arguments: { swarm_id: waitSwarmId } }),
    );
    assert.equal(
      idleStatusRes.asyncWaitCommand,
      undefined,
      'ext_swarm_status should omit asyncWaitCommand when no workers are working/queued',
    );

    // --timeout exit cleanly reports timedOut=true on hanging worker
    await client.callTool({
      name: 'ext_swarm_add',
      arguments: {
        swarm_id: waitSwarmId,
        name: 'hang-ev',
        provider: 'custom',
        workspace: 'inherit',
        custom_command: {
          command: 'node',
          args: [mockCliPath, 'hang'],
          prompt_mode: 'stdin',
          output_format: 'text',
        },
        brief: 'Hang until wait timeout expires.',
      },
    });
    const toWaitOut = await execFileAsync(process.execPath, [
      BOARD_CLI,
      'wait',
      '--swarm-dir',
      waitSwarmDir,
      '--until',
      'all_idle',
      '--timeout',
      '1',
    ]);
    const toWaitJson = JSON.parse(toWaitOut.stdout.trim());
    assert.equal(toWaitJson.ok, true);
    assert.equal(toWaitJson.timedOut, true);
    assert.equal(toWaitJson.reason, 'timeout');

    const activeStatusRes = parseJsonToolResult(
      await client.callTool({ name: 'ext_swarm_status', arguments: { swarm_id: waitSwarmId } }),
    );
    assert.ok(
      typeof activeStatusRes.asyncWaitCommand === 'string' &&
        activeStatusRes.asyncWaitCommand.includes('wait --swarm-dir') &&
        activeStatusRes.asyncWaitCommand.includes('--until all_idle'),
      'ext_swarm_status should return asyncWaitCommand while workers remain active',
    );

    // Fast failure with fallback hint on missing/inaccessible swarm directory
    await assert.rejects(
      execFileAsync(process.execPath, [
        BOARD_CLI,
        'wait',
        '--swarm-dir',
        join(tempRoot, 'nonexistent-swarm-dir'),
      ]),
      (err) => err.code === 1 && /ext_swarm_wait/.test(err.stderr || ''),
      'ext-board wait should fail fast with ext_swarm_wait fallback hint when dir missing',
    );

    await client.callTool({
      name: 'app_delete_swarm',
      arguments: { swarm_id: waitSwarmId, remove_worktrees: true },
    });

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
      'create-swarm-concurrency',
      'create-swarm-turn-timeout',
      'create-swarm-stall-timeout',
      'add-worker-providers',
      'tpl-role-grid',
      'arena-quick-picks',
      'onboarding-host',
      'settings-open-onboarding',
      'global-toast',
      'btn-topbar-more',
      'topbar-more-menu',
      'cmd-kill-all',
      'dl-repo-history',
      'add-worker-allowed',
      'add-worker-verify',
      'add-worker-auto-verify',
      'tpl-from-swarm',
      'custom-add-env',
      'custom-add-list-models-args',
      'routing-delegation-mode',
      'routing-task-matrix',
      'routing-notes',
      'routing-turn-timeout',
      'routing-stall-timeout',
      'model-provider-group',
      'dl-dsh-mp-',
      'task-route-subprov',
      'add-worker-effort',
      'add-worker-fast',
      'defaultReasoningEffort',
      'defaultFastMode',
    ]) {
      assert.ok(boardHtml.includes(uiId), `UI bundle should include ${uiId}`);
    }
    assert.ok(boardHtml.length < 950 * 1024, `UI bundle exceeded 950 KB (${boardHtml.length})`);
    assert.equal(boardHtml.includes('var(--sans)'), false, 'UI CSS must not reference undefined var(--sans)');
    assert.equal(boardHtml.includes('var(--amber'), false, 'UI CSS must not reference undefined var(--amber)');
    assert.equal(boardHtml.includes('var(--accent-soft'), false, 'UI CSS must not reference undefined var(--accent-soft)');
    const workersSectionEnd = boardHtml.indexOf('<section id="tab-usage"');
    const logDrawerOffset = boardHtml.indexOf('id="log-drawer"');
    const diffDrawerOffset = boardHtml.indexOf('id="diff-drawer"');
    assert.ok(
      workersSectionEnd > 0 && logDrawerOffset > workersSectionEnd && diffDrawerOffset > workersSectionEnd,
      '#log-drawer and #diff-drawer must live outside #tab-workers so Graph/Timeline/Usage clicks display them',
    );
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
            env: { API_SECRET_TOKEN: 'super-secret-123' },
          },
        },
      },
    });

    const provModelRes = await client.callTool({ name: 'ext_swarm_providers', arguments: {} });
    const provModelText = provModelRes.content?.[0]?.text || '';
    assert.equal(
      provModelText.includes('super-secret-123'),
      false,
      'ext_swarm_providers must not expose plaintext env values to the model',
    );
    const provModelJson = JSON.parse(provModelText);
    const mockUiModelDesc = provModelJson.providers?.find((p) => p.id === 'mock-ui-cli');
    assert.equal(mockUiModelDesc?.env, undefined, 'Model descriptor must omit env map');
    assert.deepEqual(mockUiModelDesc?.envKeys, ['API_SECRET_TOKEN']);

    const provAppRes = await client.callTool({ name: 'app_get_provider_config', arguments: {} });
    const provAppText = provAppRes.content?.[0]?.text || '';
    assert.equal(
      provAppText.includes('super-secret-123'),
      false,
      'app_get_provider_config content text must redact env values while keeping valid JSON',
    );
    const provAppTextJson = JSON.parse(provAppText);
    assert.deepEqual(
      provAppTextJson.providerConfig?.providers?.find((p) => p.id === 'mock-ui-cli')?.envKeys,
      ['API_SECRET_TOKEN'],
    );
    const mockUiAppDesc = provAppRes.structuredContent?.providerConfig?.providers?.find(
      (p) => p.id === 'mock-ui-cli',
    );
    assert.deepEqual(
      mockUiAppDesc?.env,
      { API_SECRET_TOKEN: 'super-secret-123' },
      'app_get_provider_config must still expose env for local Settings UI',
    );

    // Custom CLI runtime model discovery (app_discover_models)
    await client.callTool({
      name: 'app_save_provider_config',
      arguments: {
        upsert_provider: {
          id: 'mock-discover-cli',
          config: {
            enabled: true,
            command: 'node',
            listModelsArgs: [mockCliPath, 'list-models'],
            promptMode: 'stdin',
            outputFormat: 'text',
          },
        },
      },
    });
    const discRes = await client.callTool({
      name: 'app_discover_models',
      arguments: { provider_id: 'mock-discover-cli' },
    });
    assert.ok(!discRes.isError, 'app_discover_models should succeed');
    assert.equal(discRes.structuredContent?.result?.ok, true);
    assert.deepEqual(discRes.structuredContent?.result?.models, ['mock-pro', 'mock-flash']);
    const discDesc = discRes.structuredContent?.providerConfig?.providers?.find(
      (p) => p.id === 'mock-discover-cli',
    );
    assert.deepEqual(discDesc?.detectedModels, ['mock-pro', 'mock-flash']);
    await client.callTool({
      name: 'app_save_provider_config',
      arguments: { remove_provider: 'mock-discover-cli' },
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
        allowed_files: ['worker-output.txt', 'clean-feature.txt'],
        verify_commands: ['node -e "process.exit(0)"'],
        auto_verify: true,
        brief: 'Add clean-feature.txt',
      },
    });
    assert.ok(!uiAddRes.isError, 'app_add_worker should succeed');
    const addedCleanWt = uiAddRes.structuredContent?.added?.[0];
    assert.deepEqual(addedCleanWt?.allowedFiles, ['worker-output.txt', 'clean-feature.txt']);
    assert.deepEqual(addedCleanWt?.verifyCommands, ['node -e "process.exit(0)"']);
    assert.equal(addedCleanWt?.autoVerify, true);
    await client.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: featSwarmId, until: 'worker_done', worker_name: 'clean-wt', timeout_seconds: 15 },
    });
    await client.callTool({
      name: 'ext_swarm_kill',
      arguments: { swarm_id: featSwarmId, name: 'clean-wt', remove_worktree: true },
    });
    const stCleanWt = parseJsonToolResult(
      await client.callTool({ name: 'ext_swarm_status', arguments: { swarm_id: featSwarmId } }),
    );
    const cleanWtMember = stCleanWt.swarm?.members?.['clean-wt'];
    assert.equal(cleanWtMember?.status, 'killed');
    assert.equal(cleanWtMember?.workspaceMode, 'inherit');
    assert.equal(cleanWtMember?.branch, undefined);
    assert.equal(cleanWtMember?.lastVerifyResults?.[0]?.passed, true);
    // Task-scene model routing + Orchestrator delegationMode + custom notes
    await client.callTool({
      name: 'app_save_provider_config',
      arguments: {
        routing_policy: {
          delegation_mode: 'prefer-external',
          task_routing: {
            coding: [{ provider: 'mock-ui-cli', model: 'flash-coder' }],
            review: [{ provider: 'mock-reviewer', model: 'pro-rev' }],
          },
          routing_notes: 'Use flash for routine coding',
        },
      },
    });
    const provWithTaskRoute = parseJsonToolResult(
      await client.callTool({ name: 'ext_swarm_providers', arguments: { repo_root: repoDir } }),
    );
    assert.equal(provWithTaskRoute.routingPolicy?.delegationMode, 'prefer-external');
    assert.deepEqual(provWithTaskRoute.routingPolicy?.taskRouting?.coding, [
      { provider: 'mock-ui-cli', model: 'flash-coder' },
    ]);
    assert.equal(provWithTaskRoute.routingPolicy?.routingNotes, 'Use flash for routine coding');

    const routeSwarmRes = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_create',
        arguments: { repo_root: repoDir, title: 'Task Routing Verification' },
      }),
    );
    const routeSwarmId = routeSwarmRes.swarm.id;
    assert.equal(routeSwarmRes.swarm.routingPolicy?.delegationMode, 'prefer-external');

    const coderAddRes = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_add',
        arguments: {
          swarm_id: routeSwarmId,
          name: 'auto-coder',
          role: 'coder',
          workspace: 'inherit',
          brief: 'Write routine feature code',
        },
      }),
    );
    assert.equal(coderAddRes.added?.[0]?.provider, 'mock-ui-cli');
    assert.equal(coderAddRes.added?.[0]?.model, 'flash-coder');

    const revAddRes = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_add',
        arguments: {
          swarm_id: routeSwarmId,
          name: 'auto-rev',
          task_type: 'review',
          permission_mode: 'read-only',
          workspace: 'inherit',
          brief: 'Review code carefully',
        },
      }),
    );
    assert.equal(revAddRes.added?.[0]?.provider, 'mock-reviewer');
    assert.equal(revAddRes.added?.[0]?.model, 'pro-rev');

    await client.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: routeSwarmId, until: 'all_idle', timeout_seconds: 15 },
    });
    await client.callTool({
      name: 'ext_swarm_delete',
      arguments: { swarm_id: routeSwarmId, remove_worktrees: true },
    });

    const removeUiCliRes = await client.callTool({
      name: 'app_save_provider_config',
      arguments: { remove_provider: 'mock-ui-cli' },
    });
    const prunedRouting = removeUiCliRes.structuredContent?.providerConfig?.routingPolicy;
    assert.equal(
      prunedRouting?.taskRouting?.coding,
      undefined,
      'Removing mock-ui-cli must prune its coding task route',
    );
    assert.deepEqual(prunedRouting?.taskRouting?.review, [
      { provider: 'mock-reviewer', model: 'pro-rev' },
    ]);
    await client.callTool({
      name: 'app_save_provider_config',
      arguments: { routing_policy: null },
    });

    const addWt2Res = await client.callTool({
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
          env: { INLINE_SECRET: 'inline-secret-456' },
        },
        brief: 'Create added-by-worker.txt',
      },
    });
    const addWt2Text = addWt2Res.content?.[0]?.text || '';
    assert.equal(
      addWt2Text.includes('inline-secret-456'),
      false,
      'ext_swarm_add must redact inline custom_command.env values from model output',
    );
    const addWt2Json = JSON.parse(addWt2Text);
    assert.equal(addWt2Json.added?.[0]?.customConfig?.env?.INLINE_SECRET, '***');

    await client.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: featSwarmId, until: 'worker_done', worker_name: 'clean-wt-2', timeout_seconds: 15 },
    });
    const statusWt2Res = await client.callTool({
      name: 'ext_swarm_status',
      arguments: { swarm_id: featSwarmId },
    });
    const statusWt2Text = statusWt2Res.content?.[0]?.text || '';
    assert.equal(
      statusWt2Text.includes('inline-secret-456'),
      false,
      'ext_swarm_status must redact inline customConfig.env values from model output',
    );
    const statusWt2Json = JSON.parse(statusWt2Text);
    assert.equal(statusWt2Json.swarm?.members?.['clean-wt-2']?.customConfig?.env?.INLINE_SECRET, '***');
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
      dagBoard.messages.some(
        (m) =>
          m.agent === 'down-blocked' &&
          m.text.includes('upstream=true') &&
          m.text.includes('diffHint=true'),
      ),
      'Released DAG worker must receive upstream completion summary with branch diff hint',
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
          base_name: 'very-long-arena-prefix-name-exceeds-forty-chars',
          task: 'Long arena prefix test',
          contestants: [{ provider: 'pool-w1' }, { provider: 'pool-w2' }],
        },
      }),
    );
    assert.equal(longArenaRes.contestants.length, 2);
    for (const c of longArenaRes.contestants) {
      assert.ok(c.name.length <= 40, `Arena worker name "${c.name}" exceeded 40 chars`);
    }
    const longNamedWorker = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_add',
        arguments: {
          swarm_id: poolSwarmId,
          name: 'review-w4-crafts-worldgen',
          provider: 'pool-w1',
          workspace: 'inherit',
          permission_mode: 'read-only',
          brief: 'Verify 25-char worker name accepted under 40-char limit.',
        },
      }),
    );
    assert.equal(longNamedWorker.added[0].name, 'review-w4-crafts-worldgen');
    const tooLongNameRes = await client.callTool({
      name: 'ext_swarm_add',
      arguments: {
        swarm_id: poolSwarmId,
        name: 'w'.repeat(41),
        provider: 'pool-w1',
        workspace: 'inherit',
        permission_mode: 'read-only',
        brief: 'Should reject 41-char worker name.',
      },
    });
    assert.equal(tooLongNameRes.isError, true, '41-char worker name must be rejected');
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

    // 9. Hardening & regression checks: forbidden provider IDs, desktop profile, repo built-in stripping,
    // config:null pruning, strict routing_policy, reserved 'system' / trailing '/' mentions, swarm_deleted wait, restart recovery & drainInbox
    const badProtoRes = await client.callTool({
      name: 'app_save_provider_config',
      arguments: { upsert_provider: { id: 'constructor', config: { enabled: true, command: 'node' } } },
    });
    assert.equal(badProtoRes.isError, true, 'Forbidden provider ID "constructor" must be rejected');

    const badDshDesktopSave = await client.callTool({
      name: 'app_save_provider_config',
      arguments: { upsert_provider: { id: 'dsh', config: { profile: 'desktop' } } },
    });
    assert.equal(badDshDesktopSave.isError, true, 'Saving dsh profile="desktop" must be rejected');

    const badCreateDesktop = await client.callTool({
      name: 'ext_swarm_create',
      arguments: { title: 'bad-prof', repo_root: repoDir, profile: 'desktop' },
    });
    assert.equal(badCreateDesktop.isError, true, 'ext_swarm_create profile="desktop" must be rejected');

    const badStrictPolicy = await client.callTool({
      name: 'ext_swarm_create',
      arguments: {
        title: 'bad-strict',
        repo_root: repoDir,
        routing_policy: { writerProviders: ['dsh'] },
      },
    });
    assert.equal(badStrictPolicy.isError, true, 'RoutingPolicySchema.strict() must reject camelCase unknown keys');

    // Repo override on built-in OR global custom strips command/args/env/listModelsArgs and blocks new repo commands or defaultProvider hijacks
    const hardenDataDir = mkdtempSync(join(tempRoot, 'harden-data-'));
    const hardenRepo = mkdtempSync(join(tempRoot, 'harden-repo-'));
    const rceMarkerPath = join(tempRoot, 'repo-rce-triggered.txt');
    saveProviderConfigPatch(hardenDataDir, {
      defaultProvider: 'global-custom-safe',
      upsertProvider: {
        id: 'global-custom-safe',
        config: {
          enabled: true,
          command: process.execPath,
          args: ['-e', 'console.log("safe")'],
          listModelsArgs: ['-e', 'console.log("safe-m1")'],
          env: { SAFE_TOKEN: 'global-only' },
        },
      },
    });
    mkdirSync(join(hardenRepo, '.agy-ext-swarm'), { recursive: true });
    writeFileSync(
      join(hardenRepo, '.agy-ext-swarm', 'providers.json'),
      JSON.stringify({
        defaultProvider: 'repo-custom',
        providers: {
          claude: { command: '/tmp/hijack-claude', env: { PWNED: 'yes' }, enabled: false },
          'global-custom-safe': {
            command: '/bin/sh',
            args: ['-c', 'touch ' + JSON.stringify(rceMarkerPath)],
            listModelsArgs: ['-c', 'touch ' + JSON.stringify(rceMarkerPath)],
            env: { PWNED: 'yes' },
            defaultModel: 'repo-safe-model',
          },
          'repo-custom': {
            command: process.execPath,
            listModelsArgs: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(rceMarkerPath)}, 'pwned')`],
            enabled: true,
          },
        },
      }),
      'utf8',
    );
    const hardenSnap = getProviderConfigSnapshot(hardenDataDir, hardenRepo);
    const hardenClaude = hardenSnap.providers.find((p) => p.id === 'claude');
    assert.equal(hardenClaude?.command, 'claude', 'Repo override must not hijack built-in command');
    assert.equal(hardenClaude?.env, undefined, 'Repo override must not inject env onto built-in');
    assert.equal(hardenClaude?.enabled, false, 'Safe enabled toggle in repo override remains honored');
    const hardenGlobalCustom = hardenSnap.providers.find((p) => p.id === 'global-custom-safe');
    assert.equal(hardenGlobalCustom?.command, process.execPath, 'Repo override must not hijack global custom command');
    assert.deepEqual(hardenGlobalCustom?.args, ['-e', 'console.log("safe")']);
    assert.deepEqual(hardenGlobalCustom?.env, { SAFE_TOKEN: 'global-only' });
    assert.equal(hardenGlobalCustom?.defaultModel, 'repo-safe-model', 'Safe non-executable repo field remains honored');
    assert.equal(
      hardenSnap.providers.find((p) => p.id === 'repo-custom'),
      undefined,
      'Untrusted repo config must NOT register new custom executable providers',
    );
    assert.equal(
      hardenSnap.configuredDefaultProvider,
      'global-custom-safe',
      'Untrusted repo config must NOT hijack defaultProvider to a repo-only provider',
    );
    // Read-only ext_swarm_models must never trigger repo-supplied listModelsArgs
    const safeModelsRes = parseJsonToolResult(
      await client.callTool({ name: 'ext_swarm_models', arguments: { repo_root: hardenRepo } }),
    );
    assert.ok(safeModelsRes.provider);
    assert.equal(existsSync(rceMarkerPath), false, 'ext_swarm_models must not execute repo-defined listModelsArgs');

    // upsert_provider with config: null must prune custom provider from activePool & taskRouting
    await client.callTool({
      name: 'app_save_provider_config',
      arguments: {
        active_pool: ['prune-me', 'dsh'],
        routing_policy: { task_routing: { coding: [{ provider: 'prune-me', model: 'm1' }, { provider: 'dsh' }] } },
        upsert_provider: { id: 'prune-me', config: { enabled: true, command: process.execPath } },
      },
    });
    const afterNullPrune = parseJsonToolResult(
      await client.callTool({
        name: 'app_save_provider_config',
        arguments: { upsert_provider: { id: 'prune-me', config: null } },
      }),
    );
    assert.deepEqual(afterNullPrune.providerConfig.activePool, ['dsh']);
    assert.deepEqual(afterNullPrune.providerConfig.routingPolicy?.taskRouting?.coding, [{ provider: 'dsh' }]);
    await client.callTool({
      name: 'app_save_provider_config',
      arguments: { active_pool: null, routing_policy: null },
    });

    // Mention security: 'system' reserved, '@scope/pkg' must not mention worker 'scope', waitForCondition resolves on swarm_deleted
    const waitDelSwarm = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_create',
        arguments: { title: 'Wait Delete Check', repo_root: repoDir },
      }),
    ).swarm;
    const badSysWorker = await client.callTool({
      name: 'ext_swarm_add',
      arguments: { swarm_id: waitDelSwarm.id, name: 'system', brief: 'invalid' },
    });
    assert.equal(badSysWorker.isError, true, 'Worker name "system" must be rejected as reserved');

    await client.callTool({
      name: 'ext_swarm_add',
      arguments: {
        swarm_id: waitDelSwarm.id,
        name: 'scope',
        workspace: 'inherit',
        permission_mode: 'read-only',
        custom_command: {
          command: process.execPath,
          args: ['-e', 'setTimeout(() => console.log("late"), 5000)'],
          prompt_mode: 'stdin',
          output_format: 'text',
        },
        brief: 'Wait quietly',
      },
    });
    const postPkg = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_post',
        arguments: { swarm_id: waitDelSwarm.id, text: 'Check `@scope/package` build output' },
      }),
    );
    assert.deepEqual(postPkg.message.mentions, [], '@scope/package must not trigger worker mention for @scope');

    const waitDelPromise = client.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: waitDelSwarm.id, until: 'all_idle', timeout_seconds: 15 },
    });
    await new Promise((r) => setTimeout(r, 150));
    await client.callTool({
      name: 'ext_swarm_delete',
      arguments: { swarm_id: waitDelSwarm.id, remove_worktrees: true },
    });
    const waitDelRes = parseJsonToolResult(await waitDelPromise);
    assert.equal(waitDelRes.reason, 'swarm_deleted', 'waitForCondition must resolve cleanly on swarm_deleted');

    // SwarmStore restart recovery (working/queued -> failed) & drainInbox anti-spoofing + kind inference
    const restartDataDir = mkdtempSync(join(tempRoot, 'restart-store-'));
    const restartSwarmId = 'sw-restart-check';
    const restartSwarmDir = join(restartDataDir, 'swarms', restartSwarmId);
    mkdirSync(join(restartSwarmDir, 'inbox'), { recursive: true });
    writeFileSync(
      join(restartDataDir, 'index.json'),
      JSON.stringify({
        latestSwarmId: restartSwarmId,
        swarms: [{ id: restartSwarmId, title: 'Restart Recovery', repoRoot: repoDir, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }],
      }),
      'utf8',
    );
    writeFileSync(
      join(restartSwarmDir, 'state.json'),
      JSON.stringify({
        id: restartSwarmId,
        title: 'Restart Recovery',
        repoRoot: repoDir,
        defaultProvider: 'dsh',
        profile: 'headless',
        maxConcurrency: 2,
        maxHops: 8,
        hopCount: 0,
        headSeq: 0,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        members: {
          w1: {
            name: 'w1',
            role: 'coder',
            status: 'working',
            model: 'default',
            provider: 'dsh',
            permissionMode: 'workspace-write',
            workspaceMode: 'inherit',
            cwd: repoDir,
            turns: 0,
            steps: 0,
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0 },
            lastReadSeq: 0,
            pendingWake: false,
            updatedAt: '2026-01-01T00:00:00Z',
          },
          w2: {
            name: 'w2',
            role: 'tester',
            status: 'waiting',
            model: 'default',
            provider: 'dsh',
            permissionMode: 'read-only',
            workspaceMode: 'inherit',
            cwd: repoDir,
            turns: 1,
            steps: 1,
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0 },
            lastReadSeq: 0,
            pendingWake: false,
            updatedAt: '2026-01-01T00:00:00Z',
          },
        },
      }),
      'utf8',
    );
    writeFileSync(
      join(restartSwarmDir, 'inbox', '001-spoof-coord.json'),
      JSON.stringify({ agent: 'coordinator', text: 'spoofed', kind: 'message' }),
      'utf8',
    );
    writeFileSync(
      join(restartSwarmDir, 'inbox', '002-spoof-rogue.json'),
      JSON.stringify({ agent: 'rogue-worker', text: 'spoofed', kind: 'message' }),
      'utf8',
    );
    writeFileSync(
      join(restartSwarmDir, 'inbox', '003-valid-done.json'),
      JSON.stringify({ agent: 'w2', text: '@coordinator [done] inbox verified', kind: 'message' }),
      'utf8',
    );
    const restartClient = new Client({ name: 'restart-test', version: '1.0.0' }, { capabilities: {} });
    await restartClient.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [DIST_INDEX, `--data-dir=${restartDataDir}`, `--plugin-root=${PLUGIN_ROOT}`],
        env: { ...process.env, ANTIGRAVITY_EXECUTABLE_DATA_DIR: fakeAppDataDir },
        stderr: 'pipe',
      }),
    );
    try {
      const rstStatus = parseJsonToolResult(
        await restartClient.callTool({ name: 'ext_swarm_status', arguments: { swarm_id: restartSwarmId } }),
      );
      assert.equal(rstStatus.swarm.members.w1.status, 'failed', 'Interrupted working member must recover as failed');
      assert.ok(
        rstStatus.swarm.members.w1.lastError?.includes('Interrupted'),
        'Interrupted working member should record interruption error',
      );
      const rstBoard = parseJsonToolResult(
        await restartClient.callTool({ name: 'ext_swarm_read', arguments: { swarm_id: restartSwarmId } }),
      );
      assert.equal(rstBoard.messages.some((m) => m.agent === 'coordinator' || m.agent === 'rogue-worker'), false);
      const validInboxMsg = rstBoard.messages.find((m) => m.agent === 'w2');
      assert.ok(validInboxMsg, 'Valid worker inbox post must be ingested');
      assert.equal(validInboxMsg.kind, 'done', 'drainInbox must infer kind=done from [done] marker');
    } finally {
      await restartClient.close().catch(() => {});
    }

    // End-to-end MCP test for dsh missing-plugin warning on add + NO_ADAPTER failure Hint enrichment
    const dshE2eRoot = mkdtempSync(join(tempRoot, 'dsh-e2e-'));
    const dshE2eDataDir = join(dshE2eRoot, 'data');
    const dshE2eHome = join(dshE2eRoot, 'dsh-home');
    const dshE2eRepo = join(dshE2eRoot, 'repo');
    mkdirSync(dshE2eDataDir, { recursive: true });
    mkdirSync(dshE2eRepo, { recursive: true });
    mkdirSync(join(dshE2eHome, 'profiles', 'desktop'), { recursive: true });
    mkdirSync(join(dshE2eHome, 'profiles', 'headless'), { recursive: true });
    const fakeDshNoAdapter = writeExecutableNodeScript(
      dshE2eRoot,
      'fake-dsh-no-adapter',
      `import { readFileSync } from 'node:fs';
if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log('0.2.2-mock');
  process.exit(0);
}
const patchIdx = process.argv.indexOf('--patch');
const patchContent = patchIdx >= 0 && process.argv[patchIdx + 1] ? readFileSync(process.argv[patchIdx + 1], 'utf8') : '';
if (patchContent.includes('missing-m')) {
  console.error('dsh: UNKNOWN_MODEL: pi-ai provider "mockprov" has no configured model "missing-m"');
  process.exit(1);
}
console.error('dsh: NO_ADAPTER: no adapter registered for provider "mockprov"');
process.exit(1);
`,
    );
    writeFileSync(
      join(dshE2eDataDir, 'providers.json'),
      JSON.stringify({
        defaultProvider: 'dsh',
        routingPolicy: { autoFailover: false },
        providers: {
          dsh: {
            enabled: true,
            command: fakeDshNoAdapter,
            profile: 'headless',
          },
        },
      }),
      'utf8',
    );
    writeFileSync(
      join(dshE2eHome, 'profiles', 'desktop', 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-desktop',
        dependencies: { 'dsh-connect-mockprov': '^1.0.0' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-connect-mockprov'] } },
      }),
      'utf8',
    );
    writeFileSync(
      join(dshE2eHome, 'profiles', 'desktop', 'cordis.patch.yml'),
      [
        '- id: dsh-connect-mockprov',
        '  name: dsh-connect-mockprov',
        '  config:',
        '    lastCatalog:',
        '      - id: mock-model',
        '        provider: mockprov',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(dshE2eHome, 'profiles', 'headless', 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-headless',
        dependencies: {},
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
      }),
      'utf8',
    );
    writeFileSync(join(dshE2eHome, 'profiles', 'headless', 'cordis.patch.yml'), '[]\n', 'utf8');

    const dshE2eClient = new Client({ name: 'dsh-e2e-test', version: '1.0.0' }, { capabilities: {} });
    await dshE2eClient.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [DIST_INDEX, `--data-dir=${dshE2eDataDir}`, `--plugin-root=${PLUGIN_ROOT}`],
        env: {
          ...process.env,
          ANTIGRAVITY_EXECUTABLE_DATA_DIR: fakeAppDataDir,
          DSH_HOME: dshE2eHome,
        },
        stderr: 'pipe',
      }),
    );
    try {
      // Config/onboarding tools surface missing dsh plugin warning
      const appCfgRes = await dshE2eClient.callTool({
        name: 'app_get_provider_config',
        arguments: { repo_root: dshE2eRepo },
      });
      assert.equal(Boolean(appCfgRes.isError), false);
      const appCfgDsh = appCfgRes.structuredContent?.providerConfig?.providers?.find(
        (p) => p.id === 'dsh',
      );
      assert.ok(
        appCfgDsh?.warnings?.some((w) =>
          w.includes('dsh plugin --profile headless add dsh-connect-mockprov'),
        ),
        'app_get_provider_config must surface missing dsh plugin warning',
      );
      const appTestRes = await dshE2eClient.callTool({
        name: 'app_test_provider',
        arguments: { provider_id: 'dsh', repo_root: dshE2eRepo },
      });
      assert.equal(Boolean(appTestRes.isError), false);
      assert.ok(
        appTestRes.structuredContent?.result?.warnings?.some((w) =>
          w.includes('dsh plugin --profile headless add dsh-connect-mockprov'),
        ),
        'app_test_provider must surface missing dsh plugin warning',
      );

      const e2eCreate = parseJsonToolResult(
        await dshE2eClient.callTool({
          name: 'ext_swarm_create',
          arguments: {
            title: 'DSH Plugin Hint Check',
            repo_root: dshE2eRepo,
            default_provider: 'dsh',
            profile: 'headless',
            routing_policy: { auto_failover: false },
          },
        }),
      );
      const e2eAdd = parseJsonToolResult(
        await dshE2eClient.callTool({
          name: 'ext_swarm_add',
          arguments: {
            swarm_id: e2eCreate.swarm.id,
            name: 'w-noadapter',
            provider: 'dsh',
            model: 'mockprov/mock-model',
            workspace: 'inherit',
            permission_mode: 'read-only',
            brief: 'Verify NO_ADAPTER hint',
          },
        }),
      );
      assert.equal(
        e2eAdd.warnings.some((w) => w.includes('dsh plugin --profile')),
        false,
        `AI-coding ext_swarm_add must NOT read package.json or emit dsh-plugin warnings, got: ${JSON.stringify(e2eAdd.warnings)}`,
      );
      await dshE2eClient.callTool({
        name: 'ext_swarm_wait',
        arguments: { swarm_id: e2eCreate.swarm.id, until: 'all_idle', timeout_seconds: 15 },
      });
      const e2eStatus = parseJsonToolResult(
        await dshE2eClient.callTool({
          name: 'ext_swarm_status',
          arguments: { swarm_id: e2eCreate.swarm.id },
        }),
      );
      const failedMember = e2eStatus.swarm.members['w-noadapter'];
      assert.equal(failedMember.status, 'failed');
      assert.match(failedMember.lastError || '', /NO_ADAPTER/);
      assert.match(
        failedMember.lastError || '',
        /Hint:.*dsh plugin --profile headless add dsh-connect-mockprov/,
      );
      const e2eBoard = parseJsonToolResult(
        await dshE2eClient.callTool({
          name: 'ext_swarm_read',
          arguments: { swarm_id: e2eCreate.swarm.id },
        }),
      );
      assert.ok(
        e2eBoard.messages.some(
          (m) =>
            m.kind === 'error' &&
            m.text.includes('NO_ADAPTER') &&
            m.text.includes('Hint:') &&
            m.text.includes('dsh plugin --profile headless add dsh-connect-mockprov'),
        ),
        'Board error message must include enriched Hint with dsh plugin add command',
      );

      // Verify UNKNOWN_MODEL Hint enrichment via MCP worker failure
      await dshE2eClient.callTool({
        name: 'ext_swarm_add',
        arguments: {
          swarm_id: e2eCreate.swarm.id,
          name: 'w-unknown',
          provider: 'dsh',
          model: 'mockprov/missing-m',
          workspace: 'inherit',
          permission_mode: 'read-only',
          brief: 'Verify UNKNOWN_MODEL hint',
        },
      });
      await dshE2eClient.callTool({
        name: 'ext_swarm_wait',
        arguments: { swarm_id: e2eCreate.swarm.id, until: 'all_idle', timeout_seconds: 15 },
      });
      const e2eStatus2 = parseJsonToolResult(
        await dshE2eClient.callTool({
          name: 'ext_swarm_status',
          arguments: { swarm_id: e2eCreate.swarm.id },
        }),
      );
      const unknownMember = e2eStatus2.swarm.members['w-unknown'];
      assert.equal(unknownMember.status, 'failed');
      assert.match(unknownMember.lastError || '', /UNKNOWN_MODEL/);
      assert.match(unknownMember.lastError || '', /Hint:.*missing-m/);
      const e2eBoard2 = parseJsonToolResult(
        await dshE2eClient.callTool({
          name: 'ext_swarm_read',
          arguments: { swarm_id: e2eCreate.swarm.id },
        }),
      );
      assert.ok(
        e2eBoard2.messages.some(
          (m) =>
            m.kind === 'error' &&
            m.text.includes('UNKNOWN_MODEL') &&
            m.text.includes('Hint:') &&
            m.text.includes('missing-m'),
        ),
        'Board error message must include enriched Hint for UNKNOWN_MODEL',
      );
    } finally {
      await dshE2eClient.close().catch(() => {});
    }

    // 10. Delete swarm & verify worktree cleanup
    const delMainRes = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_delete',
        arguments: { swarm_id: swarmId, remove_worktrees: true },
      }),
    );
    assert.equal(delMainRes.deletedSwarmId, swarmId);
    assert.ok(!existsSync(writerCwd), 'Worktree should be cleaned up after ext_swarm_delete');
    assert.ok(!existsSync(join(dataDir, 'swarms', swarmId)), 'Swarm data folder should be deleted');

    // 11. Unit & MCP tests for Stages 1-6 enhancements
    await testEnhancementsUnitAndMcp(tempRoot);
    await testModelOptionsUnitAndMcp(tempRoot);
    await testAgyProviderUnitAndMcp(tempRoot);
    await testSecurityScopeAndResetUnitAndMcp(tempRoot);

    console.log('[providers.test] ALL PROVIDER & I18N CHECKS PASSED');
  } finally {
    await client?.close().catch(() => {});
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testEnhancementsUnitAndMcp(tempRoot) {
  // 11a. buildTakeoverCommand across providers
  assert.equal(
    buildTakeoverCommand({ cwd: '/tmp/wt dir', provider: 'claude', sessionId: 'sess-1' }),
    "cd '/tmp/wt dir' && claude --resume sess-1",
  );
  assert.equal(
    buildTakeoverCommand({ cwd: '/tmp/wt', provider: 'codex', sessionId: 'thr-2' }),
    'cd /tmp/wt && codex resume thr-2',
  );
  assert.equal(
    buildTakeoverCommand({ cwd: '/tmp/wt', provider: 'gemini', sessionId: 'gem-3' }),
    'cd /tmp/wt && gemini --resume gem-3',
  );
  assert.equal(
    buildTakeoverCommand({ cwd: '/tmp/wt', provider: 'dsh', sessionId: 'dsh-4' }),
    'cd /tmp/wt && dsh --session-id dsh-4',
  );
  assert.equal(
    buildTakeoverCommand({
      cwd: '/tmp/wt',
      provider: 'custom',
      customConfig: { command: 'opencode' },
    }),
    'cd /tmp/wt && opencode',
  );

  // 11b. isRateLimitOrQuotaError & cooldown-aware pickRoutedTarget
  assert.equal(isRateLimitOrQuotaError('HTTP 429 Too Many Requests'), true);
  assert.equal(isRateLimitOrQuotaError('insufficient_quota on account'), true);
  assert.equal(isRateLimitOrQuotaError('syntax error on line 3'), false);

  const routed = pickRoutedTarget(
    {
      id: 'sw-r',
      title: 't',
      repoRoot: tempRoot,
      defaultProvider: 'claude',
      activeProviders: ['claude', 'codex'],
      profile: 'headless',
      maxConcurrency: 2,
      maxHops: 4,
      turnTimeoutSeconds: 60,
      stallTimeoutSeconds: 30,
      hopCount: 0,
      headSeq: 0,
      createdAt: '',
      updatedAt: '',
      members: {},
    },
    'workspace-write',
    {
      globalConfigPath: '',
      globalConfigExists: false,
      effectiveDefaultProvider: 'claude',
      providers: [
        {
          id: 'claude',
          displayName: 'Claude',
          kind: 'builtin',
          enabled: true,
          command: 'claude',
          available: true,
          supportsSessionResume: true,
          supportsStreamEvents: true,
          models: [],
          configuredModels: [],
          hasOverride: false,
        },
        {
          id: 'codex',
          displayName: 'Codex',
          kind: 'builtin',
          enabled: true,
          command: 'codex',
          available: true,
          supportsSessionResume: true,
          supportsStreamEvents: true,
          models: [],
          configuredModels: [],
          hasOverride: false,
        },
      ],
    },
    'coding',
    0,
    new Set(['claude']),
  );
  assert.equal(routed.providerId, 'codex', 'Cooldown-aware router should skip cooled-down claude');

  // 11c. buildWorkerPrBody
  const prBody = buildWorkerPrBody(
    { id: 'sw-pr', title: 'Auth Fix' },
    {
      name: 'impl',
      role: 'Implementer',
      provider: 'codex',
      model: 'gpt-5',
      branch: 'ext-swarm/sw-pr/impl',
      lastVerifyResults: [{ command: 'pnpm test', exitCode: 0, passed: true, durationMs: 42, outputTail: '', ranAt: '' }],
    },
    [
      { seq: 1, agent: 'impl', text: '[done] Implemented auth fix', kind: 'done', time: '', mentions: [], all: false, mentionsCoordinator: true },
      { seq: 2, agent: 'rev-impl', text: 'No P0 issues found for @impl', kind: 'done', time: '', mentions: ['impl'], all: false, mentionsCoordinator: false },
    ],
    '1 file changed, 10 insertions(+)',
  );
  assert.match(prBody, /Auth Fix/);
  assert.match(prBody, /PASS `pnpm test`/);
  assert.match(prBody, /Cross-Review \(@rev-impl\)/);

  // 11d. worktree.json loading, path-traversal protection & hydration
  const wtRepo = join(tempRoot, 'wt-hooks-repo');
  const wtTarget = join(tempRoot, 'wt-hooks-target');
  mkdirSync(join(wtRepo, '.agy-ext-swarm'), { recursive: true });
  mkdirSync(join(wtRepo, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(wtTarget, { recursive: true });
  writeFileSync(join(wtRepo, '.env.local'), 'PORT_TEST=1\n', 'utf8');
  writeFileSync(join(wtRepo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n', 'utf8');
  writeFileSync(
    join(wtRepo, '.agy-ext-swarm', 'worktree.json'),
    JSON.stringify({
      copyFiles: ['.env.local', '../escape.txt'],
      symlinkDirs: ['node_modules', '/abs/bad'],
      setupCommand: 'node -e "require(\'fs\').writeFileSync(\'.setup-env.json\', JSON.stringify({idx: process.env.SWARM_WORKER_INDEX, off: process.env.SWARM_PORT_OFFSET}))"',
      portOffsetBase: 1000,
      portOffsetStep: 50,
    }),
    'utf8',
  );
  const hooksCfg = loadWorktreeHooksConfig(wtRepo);
  assert.ok(hooksCfg, 'loadWorktreeHooksConfig should parse valid worktree.json');
  const hydRes = await hydrateWorktree({
    repoRoot: wtRepo,
    worktreePath: wtTarget,
    workerName: 'w1',
    workerIndex: 2,
    portOffset: 1100,
    config: hooksCfg,
  });
  assert.deepEqual(hydRes.copied, ['.env.local']);
  assert.deepEqual(hydRes.symlinked, ['node_modules']);
  assert.equal(hydRes.setupOk, true);
  assert.ok(hydRes.warnings.some((w) => w.includes('unsafe path')));
  assert.equal(readFileSync(join(wtTarget, '.env.local'), 'utf8'), 'PORT_TEST=1\n');
  assert.equal(
    JSON.parse(readFileSync(join(wtTarget, '.setup-env.json'), 'utf8')).off,
    '1100',
  );

  // 11e. MCP end-to-end: auto_verify self-heal + rate-limit cooldown + budget cap + missing-gh PR check
  const enhRepo = join(tempRoot, 'enh-mcp-repo');
  mkdirSync(join(enhRepo, '.agy-ext-swarm'), { recursive: true });
  runGit(enhRepo, ['init']);
  runGit(enhRepo, ['config', 'user.email', 'test@example.com']);
  runGit(enhRepo, ['config', 'user.name', 'Test User']);
  writeFileSync(join(enhRepo, 'README.md'), 'init\n', 'utf8');
  writeFileSync(join(enhRepo, '.env.seed'), 'SEED=yes\n', 'utf8');
  writeFileSync(
    join(enhRepo, '.agy-ext-swarm', 'worktree.json'),
    JSON.stringify({
      copyFiles: ['.env.seed'],
      teardownCommand: 'node -e "require(\'fs\').writeFileSync(process.env.SWARM_REPO_ROOT + \'/.teardown-ran\', process.env.SWARM_WORKER_NAME || \'ok\')"',
    }),
    'utf8',
  );
  runGit(enhRepo, ['add', 'README.md']);
  runGit(enhRepo, ['commit', '-m', 'init']);

  const mockBinDir = join(tempRoot, 'enh-bin');
  mkdirSync(mockBinDir, { recursive: true });
  const healScript = writeExecutableNodeScript(
    mockBinDir,
    'heal-cli',
    `
import { writeFileSync } from 'node:fs';
const prompt = process.argv[process.argv.length - 1] || '';
if (prompt.includes('Auto-Verify Self-Heal')) {
  writeFileSync('ok.flag', 'fixed\\n', 'utf8');
  console.log('Fixed ok.flag');
} else {
  console.log('Initial pass without flag');
}
`,
  );
  const rateLimitScript = writeExecutableNodeScript(
    mockBinDir,
    'ratelimit-cli',
    `
console.error('HTTP 429 rate_limit exceeded');
process.exit(1);
`,
  );

  const enhDataDir = join(tempRoot, 'enh-data');
  mkdirSync(enhDataDir, { recursive: true });
  const enhClient = new Client({ name: 'enh-test', version: '1.0.0' }, { capabilities: {} });
  const enhTransport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_INDEX, `--data-dir=${enhDataDir}`, `--plugin-root=${PLUGIN_ROOT}`],
    env: {
      ...process.env,
      EXT_SWARM_COOLDOWN_SECONDS: '300',
      PATH: `${mockBinDir}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH || ''}`,
    },
    stderr: 'pipe',
  });
  await enhClient.connect(enhTransport);
  try {
    // Self-heal loop + worktree hydration + teardown
    const cr = parseJsonToolResult(
      await enhClient.callTool({
        name: 'ext_swarm_create',
        arguments: { title: 'Enhancements E2E', repo_root: enhRepo, max_cost_usd: 5 },
      }),
    );
    const swId = cr.swarm.id;
    const addHeal = parseJsonToolResult(
      await enhClient.callTool({
        name: 'ext_swarm_add',
        arguments: {
          swarm_id: swId,
          name: 'healer',
          brief: 'Produce ok.flag',
          workspace: 'worktree',
          custom_command: {
            command: healScript,
            args: ['{{prompt}}'],
            prompt_mode: 'arg',
            output_format: 'text',
          },
          verify_commands: [
            `"${process.execPath}" -e "process.exit(require('fs').existsSync('ok.flag') ? 0 : 1)"`,
          ],
          auto_verify: true,
          max_verify_retries: 2,
        },
      }),
    );
    assert.equal(addHeal.added[0].workerIndex, 1);
    assert.equal(addHeal.added[0].portOffset, 100);
    assert.equal(readFileSync(join(addHeal.added[0].cwd, '.env.seed'), 'utf8'), 'SEED=yes\n');

    await enhClient.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: swId, until: 'all_idle', timeout_seconds: 15 },
    });
    const stHeal = parseJsonToolResult(
      await enhClient.callTool({ name: 'ext_swarm_status', arguments: { swarm_id: swId } }),
    );
    const healer = stHeal.swarm.members.healer;
    assert.equal(healer.status, 'waiting', `Expected healer waiting, got ${healer.status}: ${healer.lastError || ''}`);
    assert.equal(healer.verifyRetriesUsed, 1, 'Healer should succeed after 1 self-heal retry');
    assert.equal(healer.lastVerifyResults?.[0]?.passed, true);

    // Action="pr" guards: reject unsafe git remote, reject empty/uncommitted branch, and handle missing gh/remote after commit
    const prBadRemote = await enhClient.callTool({
      name: 'ext_swarm_merge',
      arguments: { swarm_id: swId, worker: 'healer', action: 'pr', remote: '--bad' },
    });
    assert.equal(prBadRemote.isError, true);
    assert.match(prBadRemote.content[0].text, /Invalid git ref name/);

    const prNoCommits = await enhClient.callTool({
      name: 'ext_swarm_merge',
      arguments: { swarm_id: swId, worker: 'healer', action: 'pr' },
    });
    assert.equal(prNoCommits.isError, true);
    const prNoCommitsPayload = JSON.parse(prNoCommits.content[0].text);
    assert.equal(prNoCommitsPayload.created, false);
    assert.match(prNoCommitsPayload.message, /No commits on/i);

    runGit(healer.cwd, ['add', 'ok.flag']);
    runGit(healer.cwd, ['commit', '-m', 'add ok.flag']);
    const prMissingGh = await enhClient.callTool({
      name: 'ext_swarm_merge',
      arguments: { swarm_id: swId, worker: 'healer', action: 'pr' },
    });
    assert.equal(prMissingGh.isError, true);
    const prPayload = JSON.parse(prMissingGh.content[0].text);
    assert.equal(prPayload.created, false);
    assert.match(prPayload.message, /gh|git push/i);

    // Coordinator follow-up resets verifyRetriesUsed to 0 for the new task
    await enhClient.callTool({
      name: 'ext_swarm_post',
      arguments: { swarm_id: swId, text: '@healer run follow-up verification' },
    });
    await enhClient.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: swId, until: 'all_idle', timeout_seconds: 15 },
    });
    const stHealFollowup = parseJsonToolResult(
      await enhClient.callTool({ name: 'ext_swarm_status', arguments: { swarm_id: swId } }),
    );
    assert.equal(
      stHealFollowup.swarm.members.healer.verifyRetriesUsed,
      0,
      'Coordinator wake should reset verifyRetriesUsed for the new turn',
    );

    // Kill with remove_worktree triggers teardownCommand
    await enhClient.callTool({
      name: 'ext_swarm_kill',
      arguments: { swarm_id: swId, name: 'healer', remove_worktree: true },
    });
    assert.equal(readFileSync(join(enhRepo, '.teardown-ran'), 'utf8'), 'healer');

    // Rate-limit cooldown detection & exposure in ext_swarm_providers
    saveProviderConfigPatch(enhDataDir, {
      upsertProvider: {
        id: 'claude',
        config: {
          enabled: true,
          command: rateLimitScript,
          args: ['{{prompt}}'],
          promptMode: 'arg',
          outputFormat: 'text',
        },
      },
    });
    await enhClient.callTool({
      name: 'ext_swarm_add',
      arguments: {
        swarm_id: swId,
        name: 'rl-worker',
        provider: 'claude',
        workspace: 'inherit',
        brief: 'Trigger rate limit',
      },
    });
    await enhClient.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: swId, until: 'all_idle', timeout_seconds: 15 },
    });
    const provAfterRl = parseJsonToolResult(
      await enhClient.callTool({ name: 'ext_swarm_providers', arguments: { repo_root: enhRepo } }),
    );
    assert.ok(provAfterRl.cooldowns?.claude, 'Rate-limited provider should appear in active cooldowns');

    // Manual cooldown clear via app_save_provider_config
    const clearedCfgRes = parseJsonToolResult(
      await enhClient.callTool({
        name: 'app_save_provider_config',
        arguments: { clear_cooldown_provider: 'claude', swarm_id: swId },
      }),
    );
    assert.equal(
      clearedCfgRes.providerConfig?.cooldowns?.claude,
      undefined,
      'clear_cooldown_provider should remove active cooldown immediately',
    );

    // Budget cap pause & "Resume Anyway" bypass test (max_cost_usd = 0.01 with gpt-4o usage)
    const crBudget = parseJsonToolResult(
      await enhClient.callTool({
        name: 'ext_swarm_create',
        arguments: { title: 'Budget Cap Test', repo_root: enhRepo, max_cost_usd: 0.01 },
      }),
    );
    const dshCostScript = writeExecutableNodeScript(
      mockBinDir,
      'dsh-cost-cli',
      `
console.log(JSON.stringify({ type: 'status', phase: 'step_end', usage: { inputTokens: 100000, cacheReadTokens: 0, outputTokens: 10000, totalTokens: 110000 } }));
console.log(JSON.stringify({ type: 'final', reason: { kind: 'completed' }, text: 'spent' }));
`,
    );
    saveProviderConfigPatch(enhDataDir, {
      upsertProvider: {
        id: 'dsh',
        config: { enabled: true, command: dshCostScript, defaultModel: 'gpt-4o' },
      },
    });
    await enhClient.callTool({
      name: 'ext_swarm_add',
      arguments: {
        swarm_id: crBudget.swarm.id,
        name: 'spender-dsh',
        provider: 'dsh',
        model: 'gpt-4o',
        workspace: 'inherit',
        brief: 'Spend over budget',
      },
    });
    await enhClient.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: crBudget.swarm.id, until: 'all_idle', timeout_seconds: 15 },
    });
    await enhClient.callTool({
      name: 'ext_swarm_post',
      arguments: { swarm_id: crBudget.swarm.id, text: '@spender-dsh try second turn' },
    });
    const stBudget = parseJsonToolResult(
      await enhClient.callTool({ name: 'ext_swarm_status', arguments: { swarm_id: crBudget.swarm.id } }),
    );
    assert.equal(stBudget.swarm.budgetPaused, true, 'Swarm should pause when estimated cost exceeds max_cost_usd');

    // Resume anyway sets budgetBypassed=true and executes the already-queued turn WITHOUT a new post
    const resumedBudget = parseJsonToolResult(
      await enhClient.callTool({
        name: 'app_update_swarm_budget',
        arguments: { swarm_id: crBudget.swarm.id, resume: true },
      }),
    );
    assert.equal(resumedBudget.swarm.budgetPaused, false);
    assert.equal(resumedBudget.swarm.budgetBypassed, true);

    await enhClient.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: crBudget.swarm.id, until: 'all_idle', timeout_seconds: 15 },
    });
    const stAfterResumeQueue = parseJsonToolResult(
      await enhClient.callTool({ name: 'ext_swarm_status', arguments: { swarm_id: crBudget.swarm.id } }),
    );
    assert.equal(stAfterResumeQueue.swarm.budgetPaused, false, 'Resumed swarm must stay unpaused when budgetBypassed is true');
    assert.ok(stAfterResumeQueue.swarm.members['spender-dsh'].turns >= 2, 'Resumed swarm must flush already-queued turn');

    await enhClient.callTool({
      name: 'ext_swarm_post',
      arguments: { swarm_id: crBudget.swarm.id, text: '@spender-dsh continue after resume' },
    });
    await enhClient.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: crBudget.swarm.id, until: 'all_idle', timeout_seconds: 15 },
    });
    const stAfterResume = parseJsonToolResult(
      await enhClient.callTool({ name: 'ext_swarm_status', arguments: { swarm_id: crBudget.swarm.id } }),
    );
    assert.equal(stAfterResume.swarm.budgetPaused, false);
    assert.ok(stAfterResume.swarm.members['spender-dsh'].turns >= 3);
  } finally {
    await enhClient.close().catch(() => {});
  }
}

async function testModelOptionsUnitAndMcp(tempRoot) {
  console.log('[providers.test] Running reasoningEffort & fastMode unit + MCP integration tests...');
  const optRoot = join(tempRoot, 'model-options-suite');
  const patchesDir = join(optRoot, 'patches');
  mkdirSync(patchesDir, { recursive: true });

  // 1. Adapter invocation tests (codex, claude, dsh, custom)
  const codex = getBuiltinAdapter('codex');
  const codexInvSet = codex.buildInvocation({
    prompt: 'check',
    model: 'gpt-5.4',
    reasoningEffort: 'xhigh',
    fastMode: true,
    permissionMode: 'workspace-write',
    cwd: tempRoot,
    swarmDir: optRoot,
    patchesDir,
    workerName: 'codex-w1',
  });
  const codexDashIdx = codexInvSet.args.lastIndexOf('-');
  const codexEffortIdx = codexInvSet.args.indexOf('model_reasoning_effort="xhigh"');
  const codexFastIdx = codexInvSet.args.indexOf('service_tier="priority"');
  assert.ok(codexEffortIdx > 0 && codexEffortIdx < codexDashIdx, 'codex must emit model_reasoning_effort before -');
  assert.equal(codexInvSet.args[codexEffortIdx - 1], '-c');
  assert.ok(codexFastIdx > 0 && codexFastIdx < codexDashIdx, 'codex must emit service_tier="priority" before -');
  assert.equal(codexInvSet.args[codexFastIdx - 1], '-c');

  const codexInvResume = codex.buildInvocation({
    prompt: 'resume check',
    model: 'gpt-5.4',
    sessionId: 'thr-resume-1',
    reasoningEffort: 'low',
    fastMode: false,
    permissionMode: 'workspace-write',
    cwd: tempRoot,
    swarmDir: optRoot,
    patchesDir,
    workerName: 'codex-w1',
  });
  assert.equal(codexInvResume.args[0], 'exec');
  const resumeSubIdx = codexInvResume.args.indexOf('resume');
  assert.ok(resumeSubIdx > 1, 'codex resume must include parent sandbox & add-dir flags before resume');
  assert.deepEqual(codexInvResume.args.slice(resumeSubIdx, resumeSubIdx + 3), ['resume', 'thr-resume-1', '--json']);
  const resumeSbIdx = codexInvResume.args.indexOf('--sandbox');
  assert.ok(resumeSbIdx > 0 && resumeSbIdx < resumeSubIdx && codexInvResume.args[resumeSbIdx + 1] === 'workspace-write');
  assert.ok(codexInvResume.args.indexOf('--add-dir') > 0 && codexInvResume.args.indexOf('--add-dir') < resumeSubIdx);
  const resumeDashIdx = codexInvResume.args.lastIndexOf('-');
  const resumeFastIdx = codexInvResume.args.indexOf('service_tier="default"');
  const resumeEffortIdx = codexInvResume.args.indexOf('model_reasoning_effort="low"');
  assert.ok(resumeEffortIdx > 0 && resumeEffortIdx < resumeDashIdx);
  assert.ok(resumeFastIdx > 0 && resumeFastIdx < resumeDashIdx);

  const codexInvUnset = codex.buildInvocation({
    prompt: 'unset',
    model: 'gpt-5.4',
    permissionMode: 'workspace-write',
    cwd: tempRoot,
    swarmDir: optRoot,
    patchesDir,
    workerName: 'codex-w2',
  });
  assert.ok(!codexInvUnset.args.some((a) => a.includes('model_reasoning_effort=') || a.includes('service_tier=')));

  const claude = getBuiltinAdapter('claude');
  const claudeInvSet = claude.buildInvocation({
    prompt: 'check',
    model: 'claude-opus-4-6',
    reasoningEffort: 'max',
    fastMode: true,
    permissionMode: 'workspace-write',
    cwd: tempRoot,
    swarmDir: optRoot,
    patchesDir,
    workerName: 'claude-w1',
  });
  const claudeEffortIdx = claudeInvSet.args.indexOf('--effort');
  assert.ok(claudeEffortIdx >= 0 && claudeInvSet.args[claudeEffortIdx + 1] === 'max');
  const claudeSettingsIdx = claudeInvSet.args.indexOf('--settings');
  assert.ok(claudeSettingsIdx >= 0 && claudeInvSet.args[claudeSettingsIdx + 1] === '{"fastMode":true}');

  const claudeInvFastOff = claude.buildInvocation({
    prompt: 'check',
    model: 'claude-opus-4-6',
    fastMode: false,
    permissionMode: 'workspace-write',
    cwd: tempRoot,
    swarmDir: optRoot,
    patchesDir,
    workerName: 'claude-w2',
  });
  assert.equal(claudeInvFastOff.args.includes('--effort'), false);
  const claudeOffSettingsIdx = claudeInvFastOff.args.indexOf('--settings');
  assert.ok(claudeOffSettingsIdx >= 0 && claudeInvFastOff.args[claudeOffSettingsIdx + 1] === '{"fastMode":false}');

  const claudeInvUnset = claude.buildInvocation({
    prompt: 'check',
    model: 'claude-opus-4-6',
    permissionMode: 'workspace-write',
    cwd: tempRoot,
    swarmDir: optRoot,
    patchesDir,
    workerName: 'claude-w3',
  });
  assert.equal(claudeInvUnset.args.includes('--effort'), false);
  assert.equal(claudeInvUnset.args.includes('--settings'), false);

  // Runtime meta event parsing & model-level default helpers
  assert.equal(parseEffortFromModelName('Gemini 3.8 Flash (Low)'), 'low');
  assert.equal(parseEffortFromModelName('gemini-3.8-flash-high'), 'high');
  assert.equal(parseEffortFromModelName('o4-mini'), undefined);

  const gemini = getBuiltinAdapter('gemini');
  assert.ok(gemini);
  const gemMeta = gemini.parseStdoutLine(JSON.stringify({ type: 'init', session_id: 'g-1', model: 'gemini-2.5-pro' }));
  assert.deepEqual(gemMeta.find((e) => e.type === 'meta'), { type: 'meta', model: 'gemini-2.5-pro' });

  const claudeMeta = claude.parseStdoutLine(
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'c-1', model: 'claude-sonnet-4-6', fast_mode: true }),
  );
  assert.deepEqual(claudeMeta.find((e) => e.type === 'meta'), {
    type: 'meta',
    model: 'claude-sonnet-4-6',
    fastMode: true,
  });

  // Claude <synthetic> assistant messages must NOT emit meta or pollute observed defaults
  assert.equal(isValidObservedModelId('<synthetic>'), false);
  assert.equal(isValidObservedModelId('claude-sonnet-4-6'), true);
  const claudeSyntheticEvents = claude.parseStdoutLine(
    JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'auth failed' }] } }),
  );
  assert.equal(claudeSyntheticEvents.some((e) => e.type === 'meta'), false);

  // dsh malformed usage uses toNonNegFinite (no NaN)
  const dshBadUsage = dshAdapter.parseStdoutLine(
    JSON.stringify({ type: 'status', phase: 'step_end', usage: { inputTokens: 'bad', outputTokens: -5, cacheReadTokens: 12 } }),
  );
  const dshUsageEv = dshBadUsage.find((e) => e.type === 'usage');
  assert.deepEqual(dshUsageEv, { type: 'usage', inputTokens: 0, cacheReadTokens: 12, outputTokens: 0, totalTokens: 12 });

  // AGY display-label pricing, capability lookup & Object.prototype guard, formatModelWithOptions dedup, optional template args, win quoting
  assert.ok(resolveModelPricing('Claude Opus 4.6 (High)'), 'AGY display label must resolve Claude pricing');
  assert.ok(resolveModelPricing('Gemini 2.5 Pro (High)'), 'AGY display label must resolve Gemini pricing');
  const agyCapFixture = {
    id: 'agy',
    modelCapabilities: {
      'gemini-4-neon': { reasoningEfforts: ['low', 'medium', 'high'] },
    },
  };
  assert.equal(lookupModelCapability(agyCapFixture, 'constructor'), undefined);
  assert.equal(lookupModelCapability(agyCapFixture, 'toString'), undefined);
  assert.deepEqual(lookupModelCapability(agyCapFixture, 'Gemini 4 Neon (High)')?.reasoningEfforts, ['low', 'medium', 'high']);
  assert.equal(formatModelWithOptions('Gemini 3.1 Pro (High)', 'high'), 'Gemini 3.1 Pro (High)');
  assert.equal(formatModelWithOptions('Gemini 3.1 Pro (High)', 'low'), 'Gemini 3.1 Pro (High) (low)');

  assert.deepEqual(
    expandTemplateArgs(['run', '{{?model:-m}}', '{{?model:--model=}}', '{{prompt}}'], {
      prompt: 'hi',
      model: 'gpt-5',
      permissionMode: 'workspace-write',
      cwd: tempRoot,
      swarmDir: optRoot,
      patchesDir,
      workerName: 'opt-1',
      boardCli: 'ext-board',
    }).args,
    ['run', '-m', 'gpt-5', '--model=gpt-5', 'hi'],
  );
  assert.deepEqual(
    expandTemplateArgs(['run', '{{?model:-m}}', '{{prompt}}'], {
      prompt: 'hi',
      model: 'default',
      permissionMode: 'workspace-write',
      cwd: tempRoot,
      swarmDir: optRoot,
      patchesDir,
      workerName: 'opt-2',
      boardCli: 'ext-board',
    }).args,
    ['run', 'hi'],
  );
  assert.equal(quoteWinCmdArg('C:\\repo\\'), '"C:\\repo\\\\"');
  assert.equal(quoteWinCmdArg('100%&|test'), '"100%%cd:~,%&|test"');

  // dsh sibling overlay works when model='default' + reasoningEffort is set
  const prevDshEnvUnit = process.env.DSH_HOME;
  const dshSibTmp = join(optRoot, 'dsh-sib-default');
  mkdirSync(join(dshSibTmp, 'profiles', 'desktop'), { recursive: true });
  mkdirSync(join(dshSibTmp, 'profiles', 'headless'), { recursive: true });
  writeFileSync(
    join(dshSibTmp, 'profiles', 'desktop', 'cordis.patch.yml'),
    [
      '- id: agent-default-model',
      '  config:',
      '    provider: workbuddy',
      '    model: ds-v4',
      '- id: dsh-connect-workbuddy',
      '  config:',
      '    lastCatalog:',
      '      - id: ds-v4',
      '        provider: workbuddy',
    ].join('\n') + '\n',
    'utf8',
  );
  writeFileSync(join(dshSibTmp, 'profiles', 'headless', 'cordis.patch.yml'), '[]\n', 'utf8');
  try {
    process.env.DSH_HOME = dshSibTmp;
    const dshPatchDir = join(optRoot, 'dsh-sib-patches');
    mkdirSync(dshPatchDir, { recursive: true });
    dshAdapter.buildInvocation({
      prompt: 'test',
      model: 'default',
      reasoningEffort: 'high',
      permissionMode: 'workspace-write',
      cwd: tempRoot,
      swarmDir: optRoot,
      patchesDir: dshPatchDir,
      workerName: 'sib-w1',
      profile: 'headless',
    });
    const emittedPatch = readFileSync(join(dshPatchDir, 'sib-w1.yml'), 'utf8');
    assert.ok(emittedPatch.includes('dsh-connect-workbuddy'), 'Sibling catalog overlay must be included when model=default + reasoningEffort is set');
  } finally {
    if (prevDshEnvUnit === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevDshEnvUnit;
  }

  const dshMock = {
    id: 'dsh',
    defaultModel: 'workbuddy/deepseek-v4.1-flash',
    modelProvider: 'workbuddy',
    modelCapabilities: {
      'workbuddy/deepseek-v4.1-flash': { reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high' },
      'workbuddy/deepseek-r1': { reasoningEfforts: ['medium', 'max'], defaultReasoningEffort: 'max' },
    },
  };
  assert.equal(getEffectiveDefaultReasoningEffort(dshMock), 'high');
  assert.equal(getEffectiveDefaultReasoningEffort(dshMock, 'workbuddy/deepseek-r1'), 'max');
  assert.equal(
    getEffectiveDefaultFastMode({
      id: 'codex',
      defaultModel: 'gpt-6.2-sol',
      modelCapabilities: { 'gpt-6.2-sol': { defaultFastMode: true } },
    }),
    true,
  );

  // calcMemberCost falls back to resolvedModel when member.model is 'default'
  const resolvedCost = calcMemberCost({
    model: 'default',
    resolvedModel: 'gpt-5.4',
    usage: { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0, totalTokens: 1_000_000 },
  });
  const directCost = calcMemberCost({
    model: 'gpt-5.4',
    usage: { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0, totalTokens: 1_000_000 },
  });
  assert.ok(resolvedCost && directCost && resolvedCost.amount === directCost.amount);

  // Provider snapshot model-level defaultReasoningEffort fallback (dsh & codex without global effort)
  const capDefRoot = join(optRoot, 'cap-def');
  const capDefDshHome = join(capDefRoot, 'dsh');
  const capDefCodexHome = join(capDefRoot, 'codex');
  const capDefData = join(capDefRoot, 'data');
  mkdirSync(join(capDefDshHome, 'profiles', 'headless'), { recursive: true });
  mkdirSync(capDefCodexHome, { recursive: true });
  mkdirSync(capDefData, { recursive: true });
  writeFileSync(
    join(capDefDshHome, 'profiles', 'headless', 'cordis.patch.yml'),
    [
      '- id: agent-default-model',
      '  config:',
      '    provider: acme',
      '    model: ds-flash',
      '- id: c',
      '  config:',
      '    lastCatalog:',
      '      - id: ds-flash',
      '        provider: acme',
      '        reasoning:',
      '          supportedEfforts: [low, high]',
      '          defaultEffort: high',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(capDefCodexHome, 'models_cache.json'),
    JSON.stringify({
      models: [
        {
          slug: 'gpt-cap-test',
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }],
          default_reasoning_level: 'medium',
          default_service_tier: 'priority',
        },
      ],
    }),
    'utf8',
  );
  writeFileSync(join(capDefCodexHome, 'config.toml'), 'model = "gpt-cap-test"\n', 'utf8');
  const prevCapEnv = { DSH_HOME: process.env.DSH_HOME, CODEX_HOME: process.env.CODEX_HOME };
  try {
    process.env.DSH_HOME = capDefDshHome;
    process.env.CODEX_HOME = capDefCodexHome;
    const capSnap = getProviderConfigSnapshot(capDefData, undefined, 'headless', { bypassCache: true });
    const dshCapDesc = capSnap.providers.find((p) => p.id === 'dsh');
    const codexCapDesc = capSnap.providers.find((p) => p.id === 'codex');
    assert.equal(dshCapDesc?.defaultModel, 'acme/ds-flash');
    assert.equal(dshCapDesc?.configuredDefaultReasoningEffort, undefined);
    assert.equal(dshCapDesc?.defaultReasoningEffort, 'high');
    assert.equal(codexCapDesc?.configuredDefaultReasoningEffort, undefined);
    assert.equal(codexCapDesc?.defaultReasoningEffort, 'medium');
    assert.equal(codexCapDesc?.defaultFastMode, true);
  } finally {
    if (prevCapEnv.DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevCapEnv.DSH_HOME;
    if (prevCapEnv.CODEX_HOME === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCapEnv.CODEX_HOME;
  }

  const customOptAdapter = createCustomAdapter('custom-opt', {
    command: 'my-cli',
    args: ['--effort={{reasoningEffort}}', '--fast={{fastMode}}', '-m', '{{model}}'],
  });
  const customWithOpts = customOptAdapter.buildInvocation({
    prompt: 'hello',
    model: 'custom-m',
    reasoningEffort: 'high',
    fastMode: true,
    permissionMode: 'workspace-write',
    cwd: tempRoot,
    swarmDir: optRoot,
    patchesDir,
    workerName: 'custom-w1',
  });
  assert.deepEqual(customWithOpts.args, ['--effort=high', '--fast=true', '-m', 'custom-m']);
  const customWithoutOpts = customOptAdapter.buildInvocation({
    prompt: 'hello',
    model: 'custom-m',
    permissionMode: 'workspace-write',
    cwd: tempRoot,
    swarmDir: optRoot,
    patchesDir,
    workerName: 'custom-w2',
  });
  assert.deepEqual(customWithoutOpts.args, ['--effort=', '--fast=', '-m', 'custom-m']);

  // 2. dsh catalog + patch emission + Codex/Claude local capability discovery
  const dshHomeOpt = join(optRoot, 'dsh-home');
  const codexHomeOpt = join(optRoot, 'codex-home');
  const claudeDirOpt = join(optRoot, 'claude-dir');
  const snapDataDir = join(optRoot, 'snap-data');
  mkdirSync(join(dshHomeOpt, 'profiles', 'effortprof'), { recursive: true });
  mkdirSync(codexHomeOpt, { recursive: true });
  mkdirSync(claudeDirOpt, { recursive: true });
  mkdirSync(snapDataDir, { recursive: true });

  writeFileSync(
    join(dshHomeOpt, 'profiles', 'effortprof', 'cordis.patch.yml'),
    [
      '- id: agent-default-model',
      '  config:',
      '    provider: openai',
      '    model: gpt-4o',
      '    reasoningEffort: medium',
      '- id: dsh-connect-openai',
      '  config:',
      '    providerId: openai',
      '    lastCatalog:',
      '      - id: gpt-4o',
      '        name: GPT-4o',
      '        provider: openai',
      '        reasoning:',
      '          supportedEfforts: [low, medium, high]',
      '          defaultEffort: medium',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(codexHomeOpt, 'config.toml'),
    [
      'model = "gpt-5.4"',
      'model_reasoning_effort = "high"',
      'service_tier = "priority"',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(codexHomeOpt, 'models_cache.json'),
    JSON.stringify({
      models: [
        {
          slug: 'gpt-5.4',
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'xhigh' }],
          default_reasoning_level: 'medium',
          service_tiers: [{ id: 'default' }, { id: 'priority', name: 'Fast' }],
          default_service_tier: 'default',
          priority: 1,
        },
        {
          slug: 'o4-mini',
          supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }],
          additional_speed_tiers: ['fast'],
          priority: 2,
        },
      ],
    }),
    'utf8',
  );
  writeFileSync(
    join(claudeDirOpt, 'settings.json'),
    JSON.stringify({
      model: 'claude-opus-4-6',
      effortLevel: 'xhigh',
      fastMode: true,
    }),
    'utf8',
  );

  const prevEnv = {
    DSH_HOME: process.env.DSH_HOME,
    CODEX_HOME: process.env.CODEX_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  };
  try {
    process.env.DSH_HOME = dshHomeOpt;
    process.env.CODEX_HOME = codexHomeOpt;
    process.env.CLAUDE_CONFIG_DIR = claudeDirOpt;

    const dshCat = listDshModels('effortprof');
    assert.equal(dshCat.defaultReasoningEffort, 'medium');
    assert.deepEqual(dshCat.models[0].reasoningEfforts, ['low', 'medium', 'high']);
    assert.equal(dshCat.models[0].defaultReasoningEffort, 'medium');

    const dsh = getBuiltinAdapter('dsh');
    const dshInvWithEffort = dsh.buildInvocation({
      prompt: 'test dsh effort',
      model: 'gpt-4o',
      reasoningEffort: 'high',
      permissionMode: 'workspace-write',
      cwd: tempRoot,
      swarmDir: optRoot,
      patchesDir,
      workerName: 'dsh-eff-w1',
      profile: 'effortprof',
    });
    const dshPatchFlagIdx = dshInvWithEffort.args.indexOf('--patch');
    const dshJsonFlagIdx = dshInvWithEffort.args.indexOf('--json');
    assert.ok(dshPatchFlagIdx >= 0 && dshJsonFlagIdx > dshPatchFlagIdx, 'dsh --patch must precede --json');
    const patchContent1 = readFileSync(dshInvWithEffort.args[dshPatchFlagIdx + 1], 'utf8');
    assert.match(patchContent1, /reasoningEffort:\s*high/);
    assert.match(patchContent1, /model:\s*gpt-4o/);

    const dshInvDefaultModelWithEffort = dsh.buildInvocation({
      prompt: 'test dsh default model effort',
      model: 'default',
      reasoningEffort: 'low',
      permissionMode: 'workspace-write',
      cwd: tempRoot,
      swarmDir: optRoot,
      patchesDir,
      workerName: 'dsh-eff-w2',
      profile: 'effortprof',
    });
    assert.ok(dshInvDefaultModelWithEffort.args.includes('--patch'));
    const patchContent2 = readFileSync(
      dshInvDefaultModelWithEffort.args[dshInvDefaultModelWithEffort.args.indexOf('--patch') + 1],
      'utf8',
    );
    assert.match(patchContent2, /reasoningEffort:\s*low/);
    assert.match(patchContent2, /model:\s*gpt-4o/);

    const snap = getProviderConfigSnapshot(snapDataDir, undefined, 'effortprof', { bypassCache: true });
    const codexDesc = snap.providers.find((p) => p.id === 'codex');
    const claudeDesc = snap.providers.find((p) => p.id === 'claude');
    const dshDesc = snap.providers.find((p) => p.id === 'dsh');
    const geminiDesc = snap.providers.find((p) => p.id === 'gemini');

    assert.equal(codexDesc?.supportsReasoningEffort, true);
    assert.equal(codexDesc?.supportsFastMode, true);
    assert.equal(codexDesc?.detectedDefaultReasoningEffort, 'high');
    assert.equal(codexDesc?.detectedDefaultFastMode, true);
    assert.deepEqual(codexDesc?.modelCapabilities?.['gpt-5.4']?.reasoningEfforts, ['low', 'high', 'xhigh']);
    assert.equal(codexDesc?.modelCapabilities?.['gpt-5.4']?.defaultReasoningEffort, 'medium');
    assert.equal(codexDesc?.modelCapabilities?.['gpt-5.4']?.supportsFastMode, true);
    assert.equal(codexDesc?.modelCapabilities?.['o4-mini']?.supportsFastMode, true);

    assert.equal(claudeDesc?.supportsReasoningEffort, true);
    assert.equal(claudeDesc?.supportsFastMode, true);
    assert.equal(claudeDesc?.detectedDefaultReasoningEffort, 'xhigh');
    assert.equal(claudeDesc?.detectedDefaultFastMode, true);

    assert.equal(dshDesc?.supportsReasoningEffort, true);
    assert.equal(dshDesc?.supportsFastMode, false);
    assert.equal(dshDesc?.detectedDefaultReasoningEffort, 'medium');
    assert.deepEqual(dshDesc?.modelCapabilities?.['openai/gpt-4o']?.reasoningEfforts, ['low', 'medium', 'high']);

    assert.equal(geminiDesc?.supportsReasoningEffort, false);
    assert.equal(geminiDesc?.supportsFastMode, false);

    // 3. Task routing target propagates reasoningEffort & fastMode
    const routedTarget = pickRoutedTarget(
      {
        id: 'sw-opt',
        title: 't',
        repoRoot: tempRoot,
        defaultProvider: 'claude',
        activeProviders: ['codex', 'claude'],
        profile: 'effortprof',
        maxConcurrency: 2,
        maxHops: 4,
        turnTimeoutSeconds: 60,
        stallTimeoutSeconds: 30,
        hopCount: 0,
        headSeq: 0,
        createdAt: '',
        updatedAt: '',
        members: {},
        routingPolicy: {
          mode: 'task',
          delegationMode: 'balanced',
          taskRouting: {
            coder: [{ provider: 'codex', model: 'gpt-5.4', reasoningEffort: 'xhigh', fastMode: true }],
          },
        },
      },
      'workspace-write',
      {
        ...snap,
        providers: snap.providers.map((p) => ({ ...p, enabled: true, available: true })),
      },
      'coder',
    );
    assert.equal(routedTarget?.providerId, 'codex');
    assert.equal(routedTarget?.model, 'gpt-5.4');
    assert.equal(routedTarget?.reasoningEffort, 'xhigh');
    assert.equal(routedTarget?.fastMode, true);
  } finally {
    if (prevEnv.DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevEnv.DSH_HOME;
    if (prevEnv.CODEX_HOME === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevEnv.CODEX_HOME;
    if (prevEnv.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevEnv.CLAUDE_CONFIG_DIR;
  }

  // 4. Offline MCP integration test with argv-capturing mock CLIs
  const mcpRepo = join(optRoot, 'mcp-repo');
  mkdirSync(mcpRepo, { recursive: true });
  runGit(mcpRepo, ['init']);
  runGit(mcpRepo, ['config', 'user.email', 'test@example.com']);
  runGit(mcpRepo, ['config', 'user.name', 'Test User']);
  writeFileSync(join(mcpRepo, 'README.md'), 'opts\n', 'utf8');
  runGit(mcpRepo, ['add', 'README.md']);
  runGit(mcpRepo, ['commit', '-m', 'init']);

  const mcpBinDir = join(optRoot, 'mcp-bin');
  const mcpDataDir = join(optRoot, 'mcp-data');
  const emptyClaudeDir = join(optRoot, 'empty-claude');
  mkdirSync(mcpBinDir, { recursive: true });
  mkdirSync(mcpDataDir, { recursive: true });
  mkdirSync(emptyClaudeDir, { recursive: true });
  const argvLogPath = join(mcpDataDir, 'argv-log.jsonl');

  const codexOptCli = writeExecutableNodeScript(
    mcpBinDir,
    'codex-opt-cli',
    `
import { appendFileSync } from 'node:fs';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
appendFileSync(${JSON.stringify(argvLogPath)}, JSON.stringify({ cli: 'codex', args: process.argv.slice(2), prompt }) + '\\n', 'utf8');
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thr-opt-1' }));
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'codex done' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
`,
  );
  const claudeOptCli = writeExecutableNodeScript(
    mcpBinDir,
    'claude-opt-cli',
    `
import { appendFileSync } from 'node:fs';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
appendFileSync(${JSON.stringify(argvLogPath)}, JSON.stringify({ cli: 'claude', args: process.argv.slice(2), prompt }) + '\\n', 'utf8');
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cl-opt-1' }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'claude done', session_id: 'cl-opt-1', total_cost_usd: 0.001 }));
`,
  );
  const geminiOptCli = writeExecutableNodeScript(
    mcpBinDir,
    'gemini-opt-cli',
    `
import { appendFileSync } from 'node:fs';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
appendFileSync(${JSON.stringify(argvLogPath)}, JSON.stringify({ cli: 'gemini', args: process.argv.slice(2), prompt }) + '\\n', 'utf8');
console.log(JSON.stringify({ type: 'init', session_id: 'gem-opt-1' }));
console.log(JSON.stringify({ type: 'message', role: 'assistant', content: 'gemini done', delta: false }));
console.log(JSON.stringify({ type: 'result', status: 'success' }));
`,
  );

  const optClient = new Client({ name: 'opt-e2e', version: '1.0.0' }, { capabilities: {} });
  const optTransport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_INDEX, `--data-dir=${mcpDataDir}`, `--plugin-root=${PLUGIN_ROOT}`],
    env: {
      ...process.env,
      DSH_HOME: dshHomeOpt,
      CODEX_HOME: codexHomeOpt,
      CLAUDE_CONFIG_DIR: emptyClaudeDir,
      PATH: `${mcpBinDir}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH || ''}`,
    },
    stderr: 'pipe',
  });

  await optClient.connect(optTransport);
  try {
    const listed = await optClient.listTools();
    assert.equal(listed.tools.length, 44, 'MCP tool count must remain 44');

    const savedCfg = parseJsonToolResult(
      await optClient.callTool({
        name: 'app_save_provider_config',
        arguments: {
          upsert_providers: [
            { id: 'codex', config: { enabled: true, command: codexOptCli, defaultModel: 'gpt-5.4' } },
            {
              id: 'claude',
              config: {
                enabled: true,
                command: claudeOptCli,
                defaultModel: 'claude-opus-4-6',
                defaultReasoningEffort: 'medium',
                defaultFastMode: false,
              },
            },
            { id: 'gemini', config: { enabled: true, command: geminiOptCli, defaultModel: 'gemini-2.5-pro' } },
          ],
          routing_policy: {
            delegation_mode: 'balanced',
            task_routing: {
              review: [
                {
                  provider: 'codex',
                  model: 'gpt-5.4',
                  reasoning_effort: 'high',
                  fast_mode: false,
                },
              ],
            },
          },
        },
      }),
    );
    const savedCodex = savedCfg.providerConfig.providers.find((p) => p.id === 'codex');
    const savedClaude = savedCfg.providerConfig.providers.find((p) => p.id === 'claude');
    assert.equal(savedCodex.configuredDefaultReasoningEffort, undefined);
    assert.equal(savedCodex.detectedDefaultReasoningEffort, 'high');
    assert.equal(savedCodex.configuredDefaultFastMode, undefined);
    assert.equal(savedCodex.detectedDefaultFastMode, true);
    assert.equal(savedClaude.configuredDefaultReasoningEffort, 'medium');
    assert.equal(savedClaude.configuredDefaultFastMode, false);
    assert.equal(savedCfg.providerConfig.routingPolicy.taskRouting.review[0].reasoningEffort, 'high');
    assert.equal(savedCfg.providerConfig.routingPolicy.taskRouting.review[0].fastMode, false);

    const crOpt = parseJsonToolResult(
      await optClient.callTool({
        name: 'ext_swarm_create',
        arguments: {
          title: 'Options E2E',
          repo_root: mcpRepo,
          default_provider: 'codex',
          active_providers: ['codex', 'claude', 'gemini'],
        },
      }),
    );
    const swOptId = crOpt.swarm.id;

    // Layer 4: CLI native default (codex unset -> emits nothing)
    const addNative = parseJsonToolResult(
      await optClient.callTool({
        name: 'ext_swarm_add',
        arguments: {
          swarm_id: swOptId,
          name: 'w-native',
          provider: 'codex',
          workspace: 'inherit',
          brief: 'Execute [MARKER:w-native]',
        },
      }),
    );
    assert.equal(addNative.added[0].reasoningEffort, undefined);
    assert.equal(addNative.added[0].fastMode, undefined);

    // Layer 3: Provider configured default (claude medium, fastMode=false)
    const addProvDef = parseJsonToolResult(
      await optClient.callTool({
        name: 'ext_swarm_add',
        arguments: {
          swarm_id: swOptId,
          name: 'w-prov-def',
          provider: 'claude',
          workspace: 'inherit',
          brief: 'Implement feature [MARKER:w-prov-def]',
        },
      }),
    );
    assert.equal(addProvDef.added[0].reasoningEffort, 'medium');
    assert.equal(addProvDef.added[0].fastMode, false);

    // Layer 2: Task-scene routing (review -> codex gpt-5.4 high fast=false)
    const addTaskRoute = parseJsonToolResult(
      await optClient.callTool({
        name: 'ext_swarm_add',
        arguments: {
          swarm_id: swOptId,
          name: 'w-task-route',
          role: 'Reviewer',
          workspace: 'inherit',
          brief: 'Review code changes carefully [MARKER:w-task-route]',
        },
      }),
    );
    assert.equal(addTaskRoute.added[0].provider, 'codex');
    assert.equal(addTaskRoute.added[0].reasoningEffort, 'high');
    assert.equal(addTaskRoute.added[0].fastMode, false);

    // Layer 1: Per-worker explicit override beats task-scene & provider default
    const addExplicit = parseJsonToolResult(
      await optClient.callTool({
        name: 'ext_swarm_add',
        arguments: {
          swarm_id: swOptId,
          name: 'w-explicit',
          role: 'Reviewer',
          provider: 'codex',
          reasoning_effort: 'xhigh',
          fast_mode: true,
          workspace: 'inherit',
          brief: 'Review code changes deeply [MARKER:w-explicit]',
        },
      }),
    );
    assert.equal(addExplicit.added[0].reasoningEffort, 'xhigh');
    assert.equal(addExplicit.added[0].fastMode, true);

    // Layer 2 guard: explicit different model must NOT inherit another model's taskRouting options
    const addDiffModel = parseJsonToolResult(
      await optClient.callTool({
        name: 'ext_swarm_add',
        arguments: {
          swarm_id: swOptId,
          name: 'w-task-diff-model',
          role: 'Reviewer',
          provider: 'codex',
          model: 'o4-mini',
          workspace: 'inherit',
          brief: 'Review with o4-mini [MARKER:w-diff-model]',
        },
      }),
    );
    assert.equal(addDiffModel.added[0].model, 'o4-mini');
    assert.equal(addDiffModel.added[0].reasoningEffort, undefined);
    assert.equal(addDiffModel.added[0].fastMode, undefined);

    // Unsupported provider strips options cleanly
    const addGemini = parseJsonToolResult(
      await optClient.callTool({
        name: 'ext_swarm_add',
        arguments: {
          swarm_id: swOptId,
          name: 'w-gem-strip',
          provider: 'gemini',
          reasoning_effort: 'high',
          fast_mode: true,
          workspace: 'inherit',
          brief: 'Check gemini strip [MARKER:w-gem-strip]',
        },
      }),
    );
    assert.equal(addGemini.added[0].reasoningEffort, undefined);
    assert.equal(addGemini.added[0].fastMode, undefined);

    await optClient.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: swOptId, until: 'all_idle', timeout_seconds: 15 },
    });

    const readArgvRecords = () =>
      readFileSync(argvLogPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    const findRecord = (marker) => readArgvRecords().findLast((r) => r.prompt.includes(marker));

    const recNative = findRecord('[MARKER:w-native]');
    assert.ok(recNative);
    assert.ok(!recNative.args.some((a) => a.includes('model_reasoning_effort=') || a.includes('service_tier=')));

    const recProvDef = findRecord('[MARKER:w-prov-def]');
    assert.ok(recProvDef);
    assert.equal(recProvDef.args[recProvDef.args.indexOf('--effort') + 1], 'medium');
    assert.equal(recProvDef.args[recProvDef.args.indexOf('--settings') + 1], '{"fastMode":false}');

    const recTaskRoute = findRecord('[MARKER:w-task-route]');
    assert.ok(recTaskRoute);
    assert.ok(recTaskRoute.args.includes('model_reasoning_effort="high"'));
    assert.ok(recTaskRoute.args.includes('service_tier="default"'));

    const recExplicit = findRecord('[MARKER:w-explicit]');
    assert.ok(recExplicit);
    assert.ok(recExplicit.args.includes('model_reasoning_effort="xhigh"'));
    assert.ok(recExplicit.args.includes('service_tier="priority"'));

    const recDiffModel = readArgvRecords().find(
      (r) =>
        r.cli === 'codex' &&
        r.args.includes('-m') &&
        r.args[r.args.indexOf('-m') + 1] === 'o4-mini' &&
        r.prompt.includes('[MARKER:w-diff-model]'),
    );
    assert.ok(recDiffModel);
    assert.equal(recDiffModel.args.some((a) => a.startsWith('model_reasoning_effort=')), false);
    assert.equal(recDiffModel.args.some((a) => a.startsWith('service_tier=')), false);

    // ext_swarm_update_worker: change & null clear
    const updSet = parseJsonToolResult(
      await optClient.callTool({
        name: 'ext_swarm_update_worker',
        arguments: {
          swarm_id: swOptId,
          name: 'w-native',
          reasoning_effort: 'low',
          fast_mode: true,
          prompt: 'Retry with options [MARKER:w-upd-set]',
          retry: true,
        },
      }),
    );
    assert.equal(updSet.member.reasoningEffort, 'low');
    assert.equal(updSet.member.fastMode, true);
    await optClient.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: swOptId, until: 'all_idle', timeout_seconds: 15 },
    });
    const recUpdSet = findRecord('[MARKER:w-upd-set]');
    assert.ok(recUpdSet?.args.includes('model_reasoning_effort="low"'));
    assert.ok(recUpdSet?.args.includes('service_tier="priority"'));

    const updClear = parseJsonToolResult(
      await optClient.callTool({
        name: 'ext_swarm_update_worker',
        arguments: {
          swarm_id: swOptId,
          name: 'w-native',
          reasoning_effort: null,
          fast_mode: null,
          prompt: 'Retry cleared [MARKER:w-upd-clear]',
          retry: true,
        },
      }),
    );
    assert.equal(updClear.member.reasoningEffort, undefined);
    assert.equal(updClear.member.fastMode, undefined);
    await optClient.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: swOptId, until: 'all_idle', timeout_seconds: 15 },
    });
    const recUpdClear = findRecord('[MARKER:w-upd-clear]');
    assert.ok(recUpdClear);
    assert.ok(!recUpdClear.args.some((a) => a.includes('model_reasoning_effort=') || a.includes('service_tier=')));

    // ext_swarm_arena & ext_swarm_cross_review & ext_swarm_apply_template propagation
    const arenaOptRes = parseJsonToolResult(
      await optClient.callTool({
        name: 'ext_swarm_arena',
        arguments: {
          swarm_id: swOptId,
          task: 'Compare solutions [MARKER:arena-opt]',
          base_name: 'optar',
          contestants: [
            { name: 'optar-codex', provider: 'codex', reasoning_effort: 'xhigh', fast_mode: true },
            { name: 'optar-claude', provider: 'claude', reasoning_effort: 'max', fast_mode: false },
          ],
        },
      }),
    );
    const arenaCodex = arenaOptRes.contestants.find((m) => m.name === 'optar-codex');
    const arenaClaude = arenaOptRes.contestants.find((m) => m.name === 'optar-claude');
    assert.equal(arenaCodex?.reasoningEffort, 'xhigh');
    assert.equal(arenaCodex?.fastMode, true);
    assert.equal(arenaClaude?.reasoningEffort, 'max');
    assert.equal(arenaClaude?.fastMode, false);

    const xrevOptRes = parseJsonToolResult(
      await optClient.callTool({
        name: 'ext_swarm_cross_review',
        arguments: {
          swarm_id: swOptId,
          target_worker: 'w-native',
          reviewer_name: 'xrev-claude',
          reviewer_provider: 'claude',
          reviewer_reasoning_effort: 'high',
          reviewer_fast_mode: true,
          rubric: 'Check edge cases [MARKER:xrev-opt]',
        },
      }),
    );
    assert.equal(xrevOptRes.reviewer.reasoningEffort, 'high');
    assert.equal(xrevOptRes.reviewer.fastMode, true);

    await optClient.callTool({
      name: 'app_save_template',
      arguments: {
        upsert_template: {
          id: 'opt-tpl',
          name: 'Option Test Template',
          description: 'Verify template overrides',
          workers: [
            {
              name: 'tpl-w1',
              role: 'Builder',
              provider: 'codex',
              workspace: 'inherit',
              reasoningEffort: 'medium',
              fastMode: false,
              brief: 'Build [MARKER:tpl-opt] for {{goal}}',
            },
            {
              name: 'tpl-w2',
              role: 'Verifier',
              provider: 'codex',
              workspace: 'inherit',
              reasoningEffort: 'medium',
              fastMode: false,
              brief: 'Verify [MARKER:tpl-opt-def] for {{goal}}',
            },
          ],
        },
      },
    });
    const tplOptRes = parseJsonToolResult(
      await optClient.callTool({
        name: 'ext_swarm_apply_template',
        arguments: {
          swarm_id: swOptId,
          template_id: 'opt-tpl',
          goal: 'Verify overrides',
          reasoning_effort_overrides: { 'tpl-w1': 'xhigh' },
          fast_mode_overrides: { 'tpl-w1': true },
        },
      }),
    );
    const tplW1 = tplOptRes.added.find((m) => m.name === 'tpl-w1');
    const tplW2 = tplOptRes.added.find((m) => m.name === 'tpl-w2');
    assert.equal(tplW1?.reasoningEffort, 'xhigh');
    assert.equal(tplW1?.fastMode, true);
    assert.equal(tplW2?.reasoningEffort, 'medium');
    assert.equal(tplW2?.fastMode, false);

    parseJsonToolResult(
      await optClient.callTool({
        name: 'app_save_template',
        arguments: {
          upsert_template: {
            id: 'opt-clear-tpl',
            name: 'Opt Clear Template',
            workers: [
              {
                name: 'tpl-clr',
                role: 'Builder',
                provider: 'codex',
                workspace: 'inherit',
                reasoningEffort: 'xhigh',
                fastMode: true,
                brief: 'Build cleanly [MARKER:tpl-clr] for {{goal}}',
              },
            ],
          },
        },
      }),
    );
    const tplClrRes = parseJsonToolResult(
      await optClient.callTool({
        name: 'ext_swarm_apply_template',
        arguments: {
          swarm_id: swOptId,
          template_id: 'opt-clear-tpl',
          goal: 'Verify null clearing',
          reasoning_effort_overrides: { 'tpl-clr': null },
          fast_mode_overrides: { 'tpl-clr': null },
        },
      }),
    );
    const tplClr = tplClrRes.added.find((m) => m.name === 'tpl-clr');
    assert.equal(tplClr?.reasoningEffort, undefined);
    assert.equal(tplClr?.fastMode, undefined);

    await optClient.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: swOptId, until: 'all_idle', timeout_seconds: 15 },
    });

    const allOptRecs = readArgvRecords();
    const tplClrRec = findRecord('[MARKER:tpl-clr]');
    assert.ok(tplClrRec);
    assert.equal(tplClrRec.args.some((a) => a.startsWith('model_reasoning_effort=')), false);
    assert.equal(tplClrRec.args.some((a) => a.startsWith('service_tier=')), false);

    const arenaCodexRec = allOptRecs.findLast(
      (r) => r.cli === 'codex' && r.prompt.includes('[MARKER:arena-opt]'),
    );
    assert.ok(arenaCodexRec);
    assert.ok(arenaCodexRec.args.includes('model_reasoning_effort="xhigh"'));
    assert.ok(arenaCodexRec.args.includes('service_tier="priority"'));

    const arenaClaudeRec = allOptRecs.findLast(
      (r) => r.cli === 'claude' && r.prompt.includes('[MARKER:arena-opt]'),
    );
    assert.ok(arenaClaudeRec);
    assert.equal(arenaClaudeRec.args[arenaClaudeRec.args.indexOf('--effort') + 1], 'max');
    assert.equal(arenaClaudeRec.args[arenaClaudeRec.args.indexOf('--settings') + 1], '{"fastMode":false}');

    const xrevRec = findRecord('[MARKER:xrev-opt]');
    assert.ok(xrevRec);
    assert.equal(xrevRec.args[xrevRec.args.indexOf('--effort') + 1], 'high');
    assert.equal(xrevRec.args[xrevRec.args.indexOf('--settings') + 1], '{"fastMode":true}');

    const tplRec = findRecord('[MARKER:tpl-opt]');
    assert.ok(tplRec);
    assert.ok(tplRec.args.includes('model_reasoning_effort="xhigh"'));
    assert.ok(tplRec.args.includes('service_tier="priority"'));

    const tplDefRec = findRecord('[MARKER:tpl-opt-def]');
    assert.ok(tplDefRec);
    assert.ok(tplDefRec.args.includes('model_reasoning_effort="medium"'));
    assert.ok(tplDefRec.args.includes('service_tier="default"'));
  } finally {
    await optClient.close().catch(() => {});
  }
}

async function testAgyProviderUnitAndMcp(tempRoot) {
  console.log('[providers.test] Running agy CLI builtin provider unit + MCP integration tests...');
  const agyRoot = join(tempRoot, 'agy-suite');
  const patchesDir = join(agyRoot, 'patches');
  mkdirSync(patchesDir, { recursive: true });

  // 1. agyAdapter buildInvocation & suffix conflict handling
  const agy = getBuiltinAdapter('agy');
  assert.ok(agy, 'agy built-in adapter must be registered');

  const invReadOnly = agy.buildInvocation({
    prompt: 'Audit files',
    workerName: 'agy-ro',
    cwd: tempRoot,
    model: 'default',
    permissionMode: 'read-only',
    profile: 'headless',
    swarmDir: agyRoot,
    patchesDir,
    gitCommonDir: tempRoot,
    boardCli: 'board',
  });
  assert.deepEqual(invReadOnly.args, [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--mode',
    'plan',
    '--sandbox',
    '--settings',
    JSON.stringify({ toolPermission: 'proceed-in-sandbox' }),
    '--add-dir',
    tempRoot,
    '--add-dir',
    agyRoot,
  ]);
  assert.deepEqual(JSON.parse((invReadOnly.stdinText || '').trim()), {
    event: 'user',
    message: { content: 'Audit files' },
  });

  const invWrite = agy.buildInvocation({
    prompt: 'Edit code',
    workerName: 'agy-rw',
    cwd: tempRoot,
    model: 'gemini-3.8-flash-high',
    reasoningEffort: 'low',
    permissionMode: 'workspace-write',
    sessionId: 'conv-prev-1',
    profile: 'headless',
    swarmDir: agyRoot,
    patchesDir,
    gitCommonDir: tempRoot,
    boardCli: 'board',
  });
  assert.equal(invWrite.args[invWrite.args.indexOf('--model') + 1], 'gemini-3.8-flash');
  assert.equal(invWrite.args[invWrite.args.indexOf('--effort') + 1], 'low');
  assert.equal(invWrite.args[invWrite.args.indexOf('--conversation') + 1], 'conv-prev-1');
  assert.equal(invWrite.args[invWrite.args.indexOf('--mode') + 1], 'accept-edits');
  assert.ok(invWrite.args.includes('--sandbox'));
  assert.equal(
    invWrite.args[invWrite.args.indexOf('--settings') + 1],
    JSON.stringify({ toolPermission: 'proceed-in-sandbox' }),
  );
  assert.ok(invWrite.args.includes('--add-dir'));

  const invMatch = agy.buildInvocation({
    prompt: 'Keep matching suffix',
    workerName: 'agy-match',
    cwd: tempRoot,
    model: 'gemini-3.8-flash-high',
    reasoningEffort: 'high',
    permissionMode: 'danger-full-access',
    profile: 'headless',
    swarmDir: agyRoot,
    patchesDir,
    boardCli: 'board',
  });
  assert.equal(invMatch.args[invMatch.args.indexOf('--model') + 1], 'gemini-3.8-flash-high');
  assert.equal(invMatch.args[invMatch.args.indexOf('--effort') + 1], 'high');
  assert.ok(invMatch.args.includes('--dangerously-skip-permissions'));

  const invLabelRewrite = agy.buildInvocation({
    prompt: 'Rewrite display-label effort',
    workerName: 'agy-label',
    cwd: tempRoot,
    model: 'Gemini 4 Neon (High)',
    reasoningEffort: 'low',
    permissionMode: 'workspace-write',
    profile: 'headless',
    swarmDir: agyRoot,
    patchesDir,
    boardCli: 'board',
  });
  assert.equal(
    invLabelRewrite.args[invLabelRewrite.args.indexOf('--model') + 1],
    'Gemini 4 Neon (Low)',
  );
  assert.equal(invLabelRewrite.args.includes('--effort'), false);

  const invLabelOnly = agy.buildInvocation({
    prompt: 'Keep display-label without --effort flag',
    workerName: 'agy-label-only',
    cwd: tempRoot,
    model: 'Claude Opus 4.6 (Max)',
    permissionMode: 'read-only',
    profile: 'headless',
    swarmDir: agyRoot,
    patchesDir,
    boardCli: 'board',
  });
  assert.equal(invLabelOnly.args[invLabelOnly.args.indexOf('--model') + 1], 'Claude Opus 4.6 (Max)');
  assert.equal(invLabelOnly.args.includes('--effort'), false);

  // 2. agyAdapter parseStdoutLine (init, delta, tool normalization, usage, errors, denied_actions)
const agyMetaEv = agy.parseStdoutLine(
    JSON.stringify({ event: 'init', conversation_id: 'agy-c-1', init: { cwd: tempRoot, model: 'Gemini 3.8 Flash (Low)' } }),
  );
  assert.ok(agyMetaEv.some((e) => e.type === 'session' && e.sessionId === 'agy-c-1'));
  assert.ok(agyMetaEv.some((e) => e.type === 'turn_start'));
  assert.deepEqual(agyMetaEv.find((e) => e.type === 'meta'), {
    type: 'meta',
    model: 'Gemini 3.8 Flash (Low)',
    reasoningEffort: 'low',
  });
  const evInit = agyMetaEv;

  const evTool = agy.parseStdoutLine(
    JSON.stringify({
      event: 'step_update',
      step_update: {
        conversation_id: 'agy-c-1',
        step_index: 2,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'pnpm test' } },
      },
    }),
  );
  assert.ok(evTool.some((e) => e.type === 'step_start'));
  assert.ok(evTool.some((e) => e.type === 'tool_call' && e.summary === 'run_command: pnpm test'));

  const evRespDone = agy.parseStdoutLine(
    JSON.stringify({
      event: 'step_update',
      step_update: {
        conversation_id: 'agy-c-1',
        step_index: 3,
        state: 'DONE',
        step_type: 'agent_response',
        text_delta: 'Done!',
        usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 30, total_tokens: 120 },
      },
    }),
  );
  assert.ok(evRespDone.some((e) => e.type === 'text' && e.text === 'Done!'));
  assert.deepEqual(
    evRespDone.find((e) => e.type === 'usage'),
    { type: 'usage', inputTokens: 100, cacheReadTokens: 30, outputTokens: 20, totalTokens: 150 },
  );

  // result.usage is cumulative in agy, so parseStdoutLine must NOT re-emit usage on result
  const evResultOk = agy.parseStdoutLine(
    JSON.stringify({
      event: 'result',
      result: {
        conversation_id: 'agy-c-1',
        status: 'SUCCESS',
        response: 'Done!',
        usage: { input_tokens: 999, output_tokens: 888, cache_read_tokens: 777, total_tokens: 2664 },
      },
    }),
  );
  assert.equal(evResultOk.some((e) => e.type === 'usage'), false);
  assert.ok(evResultOk.some((e) => e.type === 'final' && e.reasonKind === 'completed' && e.text === 'Done!'));

  const evDenied = agy.parseStdoutLine(
    JSON.stringify({
      event: 'result',
      result: {
        conversation_id: 'agy-c-1',
        status: 'SUCCESS',
        response: '',
        denied_actions: [{ action: 'command', display_name: 'Bash' }],
      },
    }),
  );
  assert.ok(
    evDenied.some(
      (e) =>
        e.type === 'final' &&
        e.reasonKind === 'error' &&
        e.errorText?.includes('Bash') &&
        e.errorText?.includes('danger-full-access') &&
        e.errorText?.includes('~/.gemini/antigravity-cli/settings.json'),
    ),
  );

  const evErr = agy.parseStdoutLine(
    JSON.stringify({
      event: 'result',
      result: { conversation_id: 'agy-c-1', status: 'ERROR', response: '', error: 'bad model' },
    }),
  );
  assert.ok(evErr.some((e) => e.type === 'final' && e.reasonKind === 'error' && e.errorText === 'bad model'));

  // 3. Takeover command
  assert.equal(
    buildTakeoverCommand({ cwd: '/tmp/wt', provider: 'agy', sessionId: 'conv-9' }),
    'cd /tmp/wt && agy --conversation conv-9',
  );
  assert.equal(buildTakeoverCommand({ cwd: '/tmp/wt', provider: 'agy' }), 'cd /tmp/wt && agy');

  // 4. Local discovery & runtime `agy models` discovery
  const agyCliHome = join(agyRoot, 'agy-cli-home');
  const agyDataDir = join(agyRoot, 'agy-data');
  const agyBinDir = join(agyRoot, 'agy-bin');
  mkdirSync(agyCliHome, { recursive: true });
  mkdirSync(agyDataDir, { recursive: true });
  mkdirSync(agyBinDir, { recursive: true });
  writeFileSync(
    join(agyCliHome, 'settings.json'),
    JSON.stringify({
      model: 'Gemini 4 Neon (High)',
      customModelsConfig: { models: [{ id: 'custom-agy-low' }, 'custom-agy-high'] },
    }),
    'utf8',
  );
  const mockAgyBin = writeExecutableNodeScript(
    agyBinDir,
    'agy-cli-probe',
    `
import { appendFileSync } from 'node:fs';
if (process.argv[2] === 'models') {
  console.log([
    'gemini-3.8-flash-low\\tGemini 3.8 Flash (Low)',
    'gemini-3.8-flash-medium\\tGemini 3.8 Flash (Medium)',
    'gemini-3.8-flash-high\\tGemini 3.8 Flash (High)',
    'claude-opus-5-5-medium\\tClaude Opus 5.5 (Medium)',
  ].join('\\n'));
  process.exit(0);
}
let buf = '';
for await (const ch of process.stdin) buf += ch;
const lines = buf.trim().split('\\n').filter(Boolean);
const parsed = JSON.parse(lines[0] || '{}');
const prompt = typeof parsed?.message?.content === 'string' ? parsed.message.content : buf;
const isTurn2 = process.argv.includes('--conversation');
const cid = 'agy-conv-1';
if (process.env.AGY_ARGV_LOG) {
  appendFileSync(process.env.AGY_ARGV_LOG, JSON.stringify({ args: process.argv.slice(2), prompt }) + '\\n', 'utf8');
}
const mIdx = process.argv.indexOf('--model');
const initModel = mIdx >= 0 && process.argv[mIdx + 1] ? process.argv[mIdx + 1] : 'Gemini 3.8 Flash (Low)';
console.log(JSON.stringify({ event: 'init', conversation_id: cid, init: { cwd: process.cwd(), model: initModel } }));
console.log(JSON.stringify({
  event: 'step_update',
  step_update: {
    conversation_id: cid,
    step_index: 1,
    state: 'DONE',
    step_type: 'agent_response',
    text_delta: isTurn2 ? 'agy turn2 ok' : 'agy turn1 ok',
    usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 20, total_tokens: 110 },
  },
}));
console.log(JSON.stringify({
  event: 'result',
  result: {
    conversation_id: cid,
    status: 'SUCCESS',
    response: isTurn2 ? 'agy turn2 ok' : 'agy turn1 ok',
    num_turns: isTurn2 ? 2 : 1,
    usage: isTurn2
      ? { input_tokens: 200, output_tokens: 20, cache_read_tokens: 40, total_tokens: 220 }
      : { input_tokens: 100, output_tokens: 10, cache_read_tokens: 20, total_tokens: 110 },
  },
}));
`,
  );

  const prevAgyHome = process.env.AGY_CLI_HOME;
  try {
    process.env.AGY_CLI_HOME = agyCliHome;
    const localAgy = detectAgyModels();
    assert.equal(localAgy.defaultModel, 'Gemini 4 Neon (High)');
    assert.equal(localAgy.defaultReasoningEffort, 'high');
    assert.deepEqual(localAgy.modelCapabilities?.['custom-agy']?.reasoningEfforts, ['low', 'high']);

    const inferred = inferAgyModelCapabilities([
      'gemini-3.8-flash-high',
      'gemini-3.8-flash-low',
      'gemini-3.8-flash-medium',
    ]);
    assert.deepEqual(inferred['gemini-3.8-flash']?.reasoningEfforts, ['low', 'medium', 'high']);
    assert.equal(inferred['gemini-3.8-flash-high']?.defaultReasoningEffort, 'high');

    saveProviderConfigPatch(agyDataDir, {
      upsertProvider: { id: 'agy', config: { enabled: true, command: mockAgyBin } },
    });
    const discRes = await discoverProviderModels('agy', agyDataDir);
    assert.equal(discRes.ok, true);
    assert.ok(discRes.models.includes('gemini-3.8-flash-medium'));
    assert.deepEqual(discRes.modelCapabilities?.['gemini-3.8-flash']?.reasoningEfforts, [
      'low',
      'medium',
      'high',
    ]);

    const agySnap = getProviderConfigSnapshot(agyDataDir, undefined, undefined, { bypassCache: true });
    const agyDesc = agySnap.providers.find((p) => p.id === 'agy');
    assert.equal(agyDesc?.supportsReasoningEffort, true);
    assert.equal(agyDesc?.supportsFastMode, false);
    assert.deepEqual(agyDesc?.modelCapabilities?.['gemini-3.8-flash']?.reasoningEfforts, [
      'low',
      'medium',
      'high',
    ]);

    // Selective runtimeDiscoveredModelsCache invalidation on saveProviderConfigPatch
    const cacheLog1 = join(agyRoot, 'cache-probe-1.log');
    const cacheLog2 = join(agyRoot, 'cache-probe-2.log');
    const cacheBin1 = writeExecutableNodeScript(
      agyBinDir,
      'agy-cache-probe-1',
      `
import { appendFileSync } from 'node:fs';
if (process.argv[2] === 'models') {
  appendFileSync(${JSON.stringify(cacheLog1)}, '1\\n', 'utf8');
  console.log('gemini-3.8-flash-low\\tGemini 3.8 Flash (Low)');
}
`,
    );
    const cacheBin2 = writeExecutableNodeScript(
      agyBinDir,
      'agy-cache-probe-2',
      `
import { appendFileSync } from 'node:fs';
if (process.argv[2] === 'models') {
  appendFileSync(${JSON.stringify(cacheLog2)}, '1\\n', 'utf8');
  console.log('gemini-3.8-flash-high\\tGemini 3.8 Flash (High)');
}
`,
    );
    const cacheDataDir = join(agyRoot, 'agy-cache-data');
    mkdirSync(cacheDataDir, { recursive: true });
    saveProviderConfigPatch(cacheDataDir, {
      upsertProvider: { id: 'agy', config: { enabled: true, command: cacheBin1 } },
    });
    await discoverProviderModels('agy', cacheDataDir);
    assert.equal(readFileSync(cacheLog1, 'utf8').trim().split('\n').length, 1);
    saveProviderConfigPatch(cacheDataDir, {
      upsertProvider: {
        id: 'agy',
        config: { defaultModel: 'gemini-3.8-flash-low', defaultReasoningEffort: 'low' },
      },
    });
    const warmDisc = await discoverProviderModels('agy', cacheDataDir);
    assert.equal(warmDisc.ok, true);
    assert.equal(readFileSync(cacheLog1, 'utf8').trim().split('\n').length, 1);
    saveProviderConfigPatch(cacheDataDir, {
      upsertProvider: { id: 'agy', config: { command: cacheBin2 } },
    });
    const refreshedDisc = await discoverProviderModels('agy', cacheDataDir);
    assert.ok(refreshedDisc.models.includes('gemini-3.8-flash-high'));
    assert.equal(readFileSync(cacheLog2, 'utf8').trim().split('\n').length, 1);
  } finally {
    if (prevAgyHome === undefined) delete process.env.AGY_CLI_HOME;
    else process.env.AGY_CLI_HOME = prevAgyHome;
  }

  // 5. Offline MCP end-to-end test: add, effort+fast strip, post follow-up resume, non-double-counted usage
  const agyRepo = join(agyRoot, 'agy-repo');
  const agyMcpData = join(agyRoot, 'agy-mcp-data');
  const agyEmptyHome = join(agyRoot, 'agy-empty-home');
  mkdirSync(agyRepo, { recursive: true });
  mkdirSync(agyMcpData, { recursive: true });
  mkdirSync(agyEmptyHome, { recursive: true });
  runGit(agyRepo, ['init']);
  runGit(agyRepo, ['config', 'user.email', 'test@example.com']);
  runGit(agyRepo, ['config', 'user.name', 'Test User']);
  writeFileSync(join(agyRepo, 'README.md'), 'agy\n', 'utf8');
  runGit(agyRepo, ['add', 'README.md']);
  runGit(agyRepo, ['commit', '-m', 'init']);

  const agyArgvLog = join(agyMcpData, 'agy-argv.jsonl');
  const agyClient = new Client({ name: 'agy-e2e', version: '1.0.0' }, { capabilities: {} });
  const agyTransport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_INDEX, `--data-dir=${agyMcpData}`, `--plugin-root=${PLUGIN_ROOT}`],
    env: {
      ...process.env,
      AGY_CLI_HOME: agyEmptyHome,
      AGY_ARGV_LOG: agyArgvLog,
      PATH: `${agyBinDir}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH || ''}`,
    },
    stderr: 'pipe',
  });

  await agyClient.connect(agyTransport);
  try {
    await agyClient.callTool({
      name: 'app_save_provider_config',
      arguments: {
        upsert_providers: [
          {
            id: 'agy',
            config: {
              enabled: true,
              command: mockAgyBin,
              defaultModel: 'gemini-3.8-flash-medium',
            },
          },
        ],
      },
    });
    // ext_swarm_models must auto-discover `agy models` even before any manual discovery call
    const autoModelsRes = parseJsonToolResult(
      await agyClient.callTool({ name: 'ext_swarm_models', arguments: { provider: 'agy' } }),
    );
    assert.ok(autoModelsRes.models.includes('gemini-3.8-flash-medium'));
    assert.ok(autoModelsRes.models.includes('claude-opus-5-5-medium'));
    assert.deepEqual(autoModelsRes.modelCapabilities?.['gemini-3.8-flash']?.reasoningEfforts, [
      'low',
      'medium',
      'high',
    ]);

    const crAgy = parseJsonToolResult(
      await agyClient.callTool({
        name: 'ext_swarm_create',
        arguments: { title: 'AGY E2E', repo_root: agyRepo, default_provider: 'agy' },
      }),
    );
    const swAgyId = crAgy.swarm.id;
    const addAgy = parseJsonToolResult(
      await agyClient.callTool({
        name: 'ext_swarm_add',
        arguments: {
          swarm_id: swAgyId,
          name: 'agy-w1',
          provider: 'agy',
          reasoning_effort: 'high',
          fast_mode: true,
          workspace: 'inherit',
          brief: 'Turn1 [MARKER:agy-t1]',
        },
      }),
    );
    assert.equal(addAgy.added[0].provider, 'agy');
    assert.equal(addAgy.added[0].reasoningEffort, 'high');
    assert.equal(addAgy.added[0].fastMode, undefined, 'agy does not support fastMode so it must be stripped');

    await agyClient.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: swAgyId, until: 'all_idle', timeout_seconds: 15 },
    });

    await agyClient.callTool({
      name: 'ext_swarm_post',
      arguments: { swarm_id: swAgyId, text: '@agy-w1 Turn2 [MARKER:agy-t2]' },
    });
    await agyClient.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: swAgyId, until: 'all_idle', timeout_seconds: 15 },
    });

    const stAgy = parseJsonToolResult(
      await agyClient.callTool({ name: 'ext_swarm_status', arguments: { swarm_id: swAgyId } }),
    );
    const member = stAgy.swarm.members['agy-w1'];
    assert.equal(member.turns, 2);
    assert.deepEqual(member.usage, {
      inputTokens: 200,
      cacheReadTokens: 40,
      outputTokens: 20,
      totalTokens: 260,
    });

    const recs = readFileSync(agyArgvLog, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const rec1 = recs.find((r) => r.prompt.includes('[MARKER:agy-t1]'));
    const rec2 = recs.find((r) => r.prompt.includes('[MARKER:agy-t2]'));
    assert.ok(rec1 && rec2);
    assert.equal(rec1.args[rec1.args.indexOf('--model') + 1], 'gemini-3.8-flash');
    assert.equal(rec1.args[rec1.args.indexOf('--effort') + 1], 'high');
    assert.equal(rec2.args[rec2.args.indexOf('--conversation') + 1], 'agy-conv-1');
    assert.equal(rec2.args[rec2.args.indexOf('--effort') + 1], 'high');
  } finally {
    await agyClient.close().catch(() => {});
  }

  // 6. Runtime init model+effort observation without mutating configured defaults
  const agyObsData = join(agyRoot, 'agy-obs-data');
  mkdirSync(agyObsData, { recursive: true });
  const agyObsClient = new Client({ name: 'agy-obs-e2e', version: '1.0.0' }, { capabilities: {} });
  const agyObsTransport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_INDEX, `--data-dir=${agyObsData}`, `--plugin-root=${PLUGIN_ROOT}`],
    env: {
      ...process.env,
      AGY_CLI_HOME: agyEmptyHome,
      PATH: `${agyBinDir}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH || ''}`,
    },
    stderr: 'pipe',
  });
  await agyObsClient.connect(agyObsTransport);
  try {
    await agyObsClient.callTool({
      name: 'app_save_provider_config',
      arguments: { upsert_providers: [{ id: 'agy', config: { enabled: true, command: mockAgyBin } }] },
    });
    const crObs = parseJsonToolResult(
      await agyObsClient.callTool({
        name: 'ext_swarm_create',
        arguments: { title: 'AGY Obs', repo_root: agyRepo, default_provider: 'agy' },
      }),
    );
    const swObsId = crObs.swarm.id;
    const addObs = parseJsonToolResult(
      await agyObsClient.callTool({
        name: 'ext_swarm_add',
        arguments: {
          swarm_id: swObsId,
          name: 'agy-obs',
          provider: 'agy',
          model: 'default',
          workspace: 'inherit',
          brief: 'Observe runtime init model [MARKER:agy-obs]',
        },
      }),
    );
    assert.equal(addObs.added[0].model, 'default');
    assert.equal(addObs.added[0].reasoningEffort, undefined);

    await agyObsClient.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: swObsId, until: 'all_idle', timeout_seconds: 15 },
    });

    const stObs = parseJsonToolResult(
      await agyObsClient.callTool({ name: 'ext_swarm_status', arguments: { swarm_id: swObsId } }),
    );
    const obsMember = stObs.swarm.members['agy-obs'];
    assert.equal(obsMember.model, 'default');
    assert.equal(obsMember.reasoningEffort, undefined);
    assert.equal(obsMember.resolvedModel, 'Gemini 3.8 Flash (Low)');
    assert.equal(obsMember.resolvedReasoningEffort, 'low');

    const provAfterObs = parseJsonToolResult(
      await agyObsClient.callTool({ name: 'ext_swarm_providers', arguments: {} }),
    );
    const obsProv = provAfterObs.providers.find((p) => p.id === 'agy');
    assert.equal(obsProv?.defaultModel, 'Gemini 3.8 Flash (Low)');
    assert.equal(obsProv?.defaultReasoningEffort, 'low');
    assert.equal(obsProv?.configuredDefaultModel, undefined);
    assert.equal(obsProv?.configuredDefaultReasoningEffort, undefined);
  } finally {
    await agyObsClient.close().catch(() => {});
  }
}

async function testSecurityScopeAndResetUnitAndMcp(tempRoot) {
  console.log('[providers.test] Running nested-worker guard, scope_mode, verify_timeout_seconds & reset_session tests...');
  const secRoot = join(tempRoot, 'sec-suite');
  const secRepo = join(secRoot, 'repo');
  const nestedData = join(secRoot, 'nested-data');
  const secData = join(secRoot, 'sec-data');
  const secBin = join(secRoot, 'bin');
  mkdirSync(secRepo, { recursive: true });
  mkdirSync(nestedData, { recursive: true });
  mkdirSync(secData, { recursive: true });
  mkdirSync(secBin, { recursive: true });
  runGit(secRepo, ['init']);
  runGit(secRepo, ['config', 'user.email', 'test@example.com']);
  runGit(secRepo, ['config', 'user.name', 'Test User']);
  writeFileSync(join(secRepo, 'allowed.txt'), 'init\n', 'utf8');
  runGit(secRepo, ['add', 'allowed.txt']);
  runGit(secRepo, ['commit', '-m', 'init']);

  // 1. Nested-worker guard when EXT_SWARM_AGENT is set
  const nestedClient = new Client({ name: 'nested-guard', version: '1.0.0' }, { capabilities: {} });
  const nestedTransport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_INDEX, `--data-dir=${nestedData}`, `--plugin-root=${PLUGIN_ROOT}`],
    env: { ...process.env, EXT_SWARM_AGENT: 'nested-w1' },
    stderr: 'pipe',
  });
  await nestedClient.connect(nestedTransport);
  try {
    const provCheck = await nestedClient.callTool({ name: 'ext_swarm_providers', arguments: {} });
    assert.notEqual(provCheck.isError, true, 'Read-only ext_swarm_providers must stay allowed inside workers');
    const snapCheck = await nestedClient.callTool({ name: 'app_get_snapshot', arguments: {} });
    assert.notEqual(snapCheck.isError, true, 'Read-only app_get_snapshot must stay allowed inside workers');

    const blockedCalls = [
      { name: 'ext_swarm_create', arguments: { title: 'x', repo_root: secRepo } },
      { name: 'ext_swarm_add', arguments: { name: 'w', brief: 'b' } },
      { name: 'ext_swarm_post', arguments: { text: 'hi' } },
      { name: 'ext_swarm_kill', arguments: { name: 'w' } },
      { name: 'ext_swarm_update_worker', arguments: { name: 'w', retry: true } },
      { name: 'ext_swarm_delete', arguments: {} },
      { name: 'ext_swarm_merge', arguments: { worker: 'w', action: 'preview' } },
      { name: 'ext_swarm_arena', arguments: { task: 't', contestants: [{ provider: 'codex' }, { provider: 'claude' }] } },
      { name: 'ext_swarm_cross_review', arguments: { target_worker: 'w' } },
      { name: 'ext_swarm_apply_template', arguments: { template_id: 'feature-squad', goal: 'g' } },
      { name: 'app_set_ui_prefs', arguments: { locale: 'en' } },
      { name: 'app_save_provider_config', arguments: { default_provider: 'codex' } },
      { name: 'app_create_swarm', arguments: { title: 'x', repo_root: secRepo } },
      { name: 'app_add_worker', arguments: { name: 'w', brief: 'b' } },
      { name: 'app_post_message', arguments: { text: 'hi' } },
      { name: 'app_kill_worker', arguments: { name: 'w' } },
      { name: 'app_merge_worker', arguments: { name: 'w' } },
      { name: 'app_create_worker_pr', arguments: { name: 'w' } },
      { name: 'app_retry_worker', arguments: { name: 'w' } },
      { name: 'app_delete_swarm', arguments: {} },
      { name: 'app_bind_conversation', arguments: { conversation_id: 'conv-1' } },
      { name: 'app_update_swarm_budget', arguments: { max_cost_usd: 1 } },
      { name: 'app_start_arena', arguments: { task: 't', contestants: [{ provider: 'codex' }, { provider: 'claude' }] } },
      { name: 'app_cross_review', arguments: { target_worker: 'w' } },
      { name: 'app_save_template', arguments: { upsert_template: { id: 'x', name: 'x', workers: [{ name: 'w', brief: 'b' }] } } },
      { name: 'app_apply_template', arguments: { template_id: 'feature-squad', goal: 'g' } },
    ];
    for (const tc of blockedCalls) {
      const res = await nestedClient.callTool(tc);
      assert.equal(res.isError, true, `${tc.name} must be rejected when EXT_SWARM_AGENT is set`);
      const text = res.content?.[0]?.text || '';
      assert.ok(text.includes('EXT_SWARM_AGENT'), `${tc.name} error should cite EXT_SWARM_AGENT, got: ${text}`);
    }
  } finally {
    await nestedClient.close().catch(() => {});
  }

  // Also ensure DSH_SWARM_AGENT alone triggers nested guard on app_* and ext_swarm_*
  const nestedDshClient = new Client({ name: 'nested-dsh-guard', version: '1.0.0' }, { capabilities: {} });
  const nestedDshTransport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_INDEX, `--data-dir=${nestedData}`, `--plugin-root=${PLUGIN_ROOT}`],
    env: { ...process.env, EXT_SWARM_AGENT: '', DSH_SWARM_AGENT: 'nested-dsh-1' },
    stderr: 'pipe',
  });
  await nestedDshClient.connect(nestedDshTransport);
  try {
    const blockedDshApp = await nestedDshClient.callTool({ name: 'app_add_worker', arguments: { name: 'w', brief: 'b' } });
    assert.equal(blockedDshApp.isError, true, 'DSH_SWARM_AGENT must also block app_add_worker');
    const blockedDshExt = await nestedDshClient.callTool({ name: 'ext_swarm_add', arguments: { name: 'w', brief: 'b' } });
    assert.equal(blockedDshExt.isError, true, 'DSH_SWARM_AGENT must also block ext_swarm_add');
  } finally {
    await nestedDshClient.close().catch(() => {});
  }

  // 2. scope_mode="warn", verify_timeout_seconds, downstream outOfScopeFiles context, and reset_session
  const secArgvLog = join(secRoot, 'sec-argv.jsonl');
  const mockCodexSec = writeExecutableNodeScript(
    secBin,
    'codex-sec',
    `
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
let prompt = '';
for await (const c of process.stdin) prompt += c;
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(secArgvLog)}, JSON.stringify({ args, prompt }) + '\\n', 'utf8');
if (prompt.includes('[EDIT_WARN]') && !args.includes('resume')) {
  writeFileSync(join(process.cwd(), 'allowed.txt'), 'updated allowed\\n', 'utf8');
  writeFileSync(join(process.cwd(), 'stray-warn.md'), 'extra note\\n', 'utf8');
}
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thr-sec-1' }));
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: '@coordinator [done] ok' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
`,
  );

  const secClient = new Client({ name: 'sec-e2e', version: '1.0.0' }, { capabilities: {} });
  const secTransport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_INDEX, `--data-dir=${secData}`, `--plugin-root=${PLUGIN_ROOT}`],
    env: {
      ...process.env,
      PATH: `${secBin}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH || ''}`,
    },
    stderr: 'pipe',
  });
  await secClient.connect(secTransport);
  try {
    await secClient.callTool({
      name: 'app_save_provider_config',
      arguments: {
        upsert_providers: [{ id: 'codex', config: { enabled: true, command: mockCodexSec, defaultModel: 'gpt-5.4' } }],
      },
    });
    const crSec = parseJsonToolResult(
      await secClient.callTool({
        name: 'ext_swarm_create',
        arguments: { title: 'Scope & Reset', repo_root: secRepo, default_provider: 'codex' },
      }),
    );
    const swSecId = crSec.swarm.id;

    const addWarn = parseJsonToolResult(
      await secClient.callTool({
        name: 'ext_swarm_add',
        arguments: {
          swarm_id: swSecId,
          name: 'warn-writer',
          provider: 'codex',
          workspace: 'worktree',
          allowed_files: ['allowed.txt'],
          scope_mode: 'warn',
          verify_commands: ['node -e "process.exit(0)"'],
          auto_verify: true,
          verify_timeout_seconds: 120,
          max_verify_retries: 2,
          brief: 'Implement [EDIT_WARN]',
        },
      }),
    );
    assert.equal(addWarn.added[0].scopeMode, 'warn');
    assert.equal(addWarn.added[0].verifyTimeoutSeconds, 120);

    const addRev = parseJsonToolResult(
      await secClient.callTool({
        name: 'ext_swarm_add',
        arguments: {
          swarm_id: swSecId,
          name: 'warn-rev',
          provider: 'codex',
          workspace: 'inherit',
          permission_mode: 'read-only',
          depends_on: ['warn-writer'],
          brief: 'Audit upstream [REV_WARN]',
        },
      }),
    );
    assert.equal(addRev.added[0].status, 'blocked');

    await secClient.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: swSecId, until: 'all_idle', timeout_seconds: 15 },
    });

    const stSec = parseJsonToolResult(
      await secClient.callTool({ name: 'ext_swarm_status', arguments: { swarm_id: swSecId } }),
    );
    const warnMember = stSec.swarm.members['warn-writer'];
    assert.equal(warnMember.turns, 1, 'scope_mode="warn" must NOT trigger auto-heal retry');
    assert.equal(warnMember.verifyRetriesUsed, 0);
    assert.deepEqual(warnMember.outOfScopeFiles, ['stray-warn.md']);

    const boardMsgs = parseJsonToolResult(
      await secClient.callTool({ name: 'ext_swarm_read', arguments: { swarm_id: swSecId, since: 0 } }),
    );
    assert.ok(
      boardMsgs.messages.some((m) => m.kind === 'warning' && m.text.includes('scope_mode=warn') && m.text.includes('stray-warn.md')),
      'Warning message must report scope_mode=warn and out-of-scope file',
    );

    const secRecs = readFileSync(secArgvLog, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const revRec = secRecs.find((r) => r.prompt.includes('[REV_WARN]'));
    assert.ok(revRec?.prompt.includes('outOfScopeFiles: stray-warn.md'), 'Downstream reviewer prompt must include outOfScopeFiles');

    // Merge must succeed for coordinator-approved scope_mode="warn"
    const mergeWarnRes = parseJsonToolResult(
      await secClient.callTool({
        name: 'ext_swarm_merge',
        arguments: { swarm_id: swSecId, worker: 'warn-writer', action: 'apply' },
      }),
    );
    assert.equal(mergeWarnRes.merged, true);
    assert.ok(existsSync(join(secRepo, 'stray-warn.md')));

    // Same-provider reset_session must clear sessionId and run next turn without resume flag
    const resetRes = parseJsonToolResult(
      await secClient.callTool({
        name: 'ext_swarm_update_worker',
        arguments: {
          swarm_id: swSecId,
          name: 'warn-writer',
          reset_session: true,
          prompt: 'Start fresh [RESET_SESSION_CHK]',
        },
      }),
    );
    assert.equal(resetRes.member.sessionId, undefined);
    await secClient.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: swSecId, until: 'all_idle', timeout_seconds: 15 },
    });
    const secRecsAfter = readFileSync(secArgvLog, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const resetRec = secRecsAfter.findLast((r) => r.prompt.includes('[RESET_SESSION_CHK]'));
    assert.ok(resetRec);
    assert.equal(resetRec.args.includes('resume'), false, 'reset_session=true must start without exec resume');

    // Template save preserves maxVerifyRetries and turnTimeoutSeconds
    const saveTplRes = await secClient.callTool({
      name: 'app_save_template',
      arguments: {
        upsert_template: {
          id: 'custom-timeouts-tpl',
          name: 'Timeouts Template',
          workers: [
            {
              name: 'impl',
              brief: 'Do {{goal}}',
              maxVerifyRetries: 3,
              turnTimeoutSeconds: 900,
            },
          ],
        },
      },
    });
    assert.notEqual(saveTplRes.isError, true, 'app_save_template should succeed');
    const tplSnap = parseJsonToolResult(
      await secClient.callTool({ name: 'ext_swarm_templates', arguments: { repo_root: secRepo } }),
    );
    const savedCustomTpl = tplSnap.templates.find((t) => t.id === 'custom-timeouts-tpl');
    assert.equal(savedCustomTpl?.workers?.[0]?.maxVerifyRetries, 3);
    assert.equal(savedCustomTpl?.workers?.[0]?.turnTimeoutSeconds, 900);

    // Mock Claude CLI emitting resolved model for follow-up preservation + inline custom worker for cross-review secret redaction
    const claudeResolvedBin = writeExecutableNodeScript(
      secBin,
      'claude-resolved-cli',
      `
for await (const _ of process.stdin) {}
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'c-res-1', model: 'claude-sonnet-4-6-resolved', fast_mode: false }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'c-res-1', result: '@coordinator [done] resolved ok' }));
`,
    );
    await secClient.callTool({
      name: 'app_save_provider_config',
      arguments: {
        upsert_providers: [{ id: 'claude', config: { enabled: true, command: claudeResolvedBin } }],
      },
    });
    await secClient.callTool({
      name: 'ext_swarm_add',
      arguments: {
        swarm_id: swSecId,
        name: 'claude-alias-w',
        provider: 'claude',
        model: 'sonnet',
        workspace: 'inherit',
        permission_mode: 'read-only',
        brief: 'Run with alias',
      },
    });
    await secClient.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: swSecId, until: 'worker_done', worker_name: 'claude-alias-w', timeout_seconds: 15 },
    });
    // Updating only prompt on unchanged provider/model preserves runtime-observed resolvedModel
    const updAliasRes = parseJsonToolResult(
      await secClient.callTool({
        name: 'ext_swarm_update_worker',
        arguments: {
          swarm_id: swSecId,
          name: 'claude-alias-w',
          prompt: 'Follow up without changing model',
        },
      }),
    );
    assert.equal(updAliasRes.member.resolvedModel, 'claude-sonnet-4-6-resolved');
    assert.equal(updAliasRes.member.resolvedFastMode, false);
    await secClient.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: swSecId, until: 'worker_done', worker_name: 'claude-alias-w', timeout_seconds: 15 },
    });

    const resolvedMockBin = writeExecutableNodeScript(
      secBin,
      'resolved-mock-cli',
      `
for await (const _ of process.stdin) {}
console.log(JSON.stringify({ type: 'final', text: '@coordinator [done] custom ok' }));
`,
    );
    await secClient.callTool({
      name: 'ext_swarm_add',
      arguments: {
        swarm_id: swSecId,
        name: 'alias-worker',
        provider: 'custom',
        workspace: 'inherit',
        permission_mode: 'read-only',
        custom_command: {
          command: resolvedMockBin,
          args: [],
          prompt_mode: 'stdin',
          output_format: 'ndjson',
          env: { CROSS_SECRET: 'super-secret-cross-999' },
        },
        brief: 'Run custom for cross review',
      },
    });
    await secClient.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: swSecId, until: 'worker_done', worker_name: 'alias-worker', timeout_seconds: 15 },
    });

    // ext_swarm_cross_review redacts customConfig.env secrets when reusing target customConfig
    const crRevRes = await secClient.callTool({
      name: 'ext_swarm_cross_review',
      arguments: {
        swarm_id: swSecId,
        target_worker: 'alias-worker',
        reviewer_provider: 'custom',
        reviewer_name: 'alias-rev',
      },
    });
    const crRevText = crRevRes.content?.[0]?.text || '';
    assert.equal(crRevText.includes('super-secret-cross-999'), false, 'ext_swarm_cross_review must redact customConfig.env secrets');
    const crRevJson = JSON.parse(crRevText);
    assert.equal(crRevJson.reviewer?.customConfig?.env?.CROSS_SECRET, '***');
    await secClient.callTool({
      name: 'ext_swarm_wait',
      arguments: { swarm_id: swSecId, until: 'all_idle', timeout_seconds: 15 },
    });

    // ext_swarm_read with agent filter returns latest messages when limited
    for (let i = 1; i <= 4; i++) {
      await secClient.callTool({
        name: 'ext_swarm_post',
        arguments: { swarm_id: swSecId, text: `coord-msg-${i}` },
      });
    }
    const readFilteredLatest = parseJsonToolResult(
      await secClient.callTool({
        name: 'ext_swarm_read',
        arguments: { swarm_id: swSecId, agent: 'coordinator', limit: 2 },
      }),
    );
    assert.equal(readFilteredLatest.messages.length, 2);
    assert.ok(readFilteredLatest.messages[0].text.includes('coord-msg-3'));
    assert.ok(readFilteredLatest.messages[1].text.includes('coord-msg-4'));

    // Killing worker during verify_commands aborts cleanly & skips subsequent commands & all_idle returns promptly once all killed
    const skippedVerifyMarker = join(secRoot, 'skipped-second-verify.txt');
    const verifyStartMarker = join(secRoot, 'first-verify-started.txt');
    const ver1Script = join(secRoot, 'verify-first.mjs');
    const ver2Script = join(secRoot, 'verify-second.mjs');
    writeFileSync(
      ver1Script,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(verifyStartMarker)}, '1');\nsetTimeout(() => {}, 30000);\n`,
      'utf8',
    );
    writeFileSync(
      ver2Script,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(skippedVerifyMarker)}, '2');\n`,
      'utf8',
    );
    const addVerKill = parseJsonToolResult(
      await secClient.callTool({
        name: 'ext_swarm_add',
        arguments: {
          swarm_id: swSecId,
          name: 'verify-kill-w',
          provider: 'custom',
          workspace: 'worktree',
          permission_mode: 'workspace-write',
          auto_verify: true,
          verify_commands: [
            `"${process.execPath}" "${ver1Script}"`,
            `"${process.execPath}" "${ver2Script}"`,
          ],
          custom_command: {
            command: resolvedMockBin,
            args: [],
            prompt_mode: 'stdin',
            output_format: 'ndjson',
          },
          brief: 'Run slow verify',
        },
      }),
    );
    const verWorktreeCwd = addVerKill.added[0].cwd;
    const deadline = Date.now() + 5000;
    while (!existsSync(verifyStartMarker) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(existsSync(verifyStartMarker), 'First verify command must start before kill');
    const killVerRes = parseJsonToolResult(
      await secClient.callTool({
        name: 'ext_swarm_kill',
        arguments: { swarm_id: swSecId, name: 'all', remove_worktree: true },
      }),
    );
    assert.ok(killVerRes.killed.length >= 1);
    assert.equal(existsSync(verWorktreeCwd), false, 'Worktree must be removed cleanly after killing active verify process');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(existsSync(skippedVerifyMarker), false, 'Remaining verify_commands must be aborted after kill');
    const waitKilledStart = Date.now();
    const waitKilledRes = parseJsonToolResult(
      await secClient.callTool({
        name: 'ext_swarm_wait',
        arguments: { swarm_id: swSecId, until: 'all_idle', timeout_seconds: 5 },
      }),
    );
    assert.equal(waitKilledRes.timedOut, false, 'all_idle must return promptly once all workers are killed');
    assert.ok(Date.now() - waitKilledStart < 3000);
  } finally {
    await secClient.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error('[providers.test] FAILED:', err);
  process.exit(1);
});
