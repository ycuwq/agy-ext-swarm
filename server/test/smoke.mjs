import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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

async function main() {
  const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'agy-ext-swarm-smoke-')));
  const repoDir = join(tempRoot, 'repo');
  const dataDir = join(tempRoot, 'data');

  let client;
  let swarmId;
  try {
    // 1. Set up isolated temporary git repository
    execFileSync('mkdir', ['-p', repoDir]);
    runGit(repoDir, ['init']);
    runGit(repoDir, ['config', 'user.email', 'smoke@example.com']);
    runGit(repoDir, ['config', 'user.name', 'Smoke Test']);
    writeFileSync(join(repoDir, 'README.md'), '# Smoke Repo\n', 'utf8');
    runGit(repoDir, ['add', 'README.md']);
    runGit(repoDir, ['commit', '-m', 'init']);

    // 2. Connect MCP Client over stdio to dist/index.mjs
    const transport = new StdioClientTransport({
      command: 'node',
      args: [DIST_INDEX, `--data-dir=${dataDir}`, `--plugin-root=${PLUGIN_ROOT}`],
      stderr: 'pipe',
    });

    client = new Client({ name: 'agy-ext-swarm-smoke', version: '0.2.0' });
    await client.connect(transport);

    // 3. Verify tools & resource metadata
    const toolsRes = await client.listTools();
    const toolNames = toolsRes.tools.map((t) => t.name);
    const expectedTools = [
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
    for (const name of expectedTools) {
      assert.ok(toolNames.includes(name), `Missing expected tool: ${name}`);
    }

    const openBoardTool = toolsRes.tools.find((t) => t.name === 'ext_swarm_open_board');
    assert.equal(openBoardTool?._meta?.ui?.resourceUri, 'ui://agy-ext-swarm/board.html');
    const entrypoints = openBoardTool?._meta?.['com.google.antigravity/ui']?.entrypoints;
    assert.ok(Array.isArray(entrypoints) && entrypoints.length >= 1, 'Missing aux_pane/global entrypoints');

    const resRead = await client.readResource({ uri: 'ui://agy-ext-swarm/board.html' });
    const htmlItem = resRead.contents[0];
    assert.equal(htmlItem.mimeType, 'text/html;profile=mcp-app');
    assert.ok(htmlItem.text.includes('<title>AGY Ext Swarm</title>'), 'HTML resource should contain AGY Ext Swarm title');

    // 4. Verify ext_swarm_models for dsh
    const models = parseJsonToolResult(
      await client.callTool({ name: 'ext_swarm_models', arguments: { provider: 'dsh' } }),
    );
    assert.ok(models.defaultModel, 'Expected defaultModel from profile');
    assert.ok(models.models.length > 0, 'Expected non-empty lastCatalog model list');
    console.log(`[smoke] Models ok: default=${models.defaultModel}, count=${models.models.length}`);

    // 5. Create swarm & verify open_board
    const created = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_create',
        arguments: { title: 'Smoke E2E Swarm', repo_root: repoDir, default_provider: 'dsh' },
      }),
    );
    swarmId = created.swarm.id;
    assert.ok(created.swarm.gitRepoRoot, 'Expected gitRepoRoot detection');

    const openRes = await client.callTool({
      name: 'ext_swarm_open_board',
      arguments: {},
    });
    assert.ok(openRes.structuredContent?.swarm?.id === swarmId, 'open_board should focus new swarm');

    // 6. Add writer in isolated git worktree with allowed_files whitelist
    const addWriter = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_add',
        arguments: {
          swarm_id: swarmId,
          name: 'writer',
          provider: 'dsh',
          workspace: 'worktree',
          permission_mode: 'workspace-write',
          allowed_files: ['hello.txt'],
          brief:
            'Create a file named hello.txt containing exact line "line1", run `git add hello.txt && git commit -m "add line1"`, and reply with "@coordinator [done] created hello.txt". Do not modify any other file.',
        },
      }),
    );
    assert.equal(addWriter.added.length, 1);
    const writerCwd = addWriter.added[0].cwd;
    assert.ok(existsSync(writerCwd), 'Worktree directory should exist');

    async function waitWithChunks(args, maxChunks = 3) {
      let lastRes;
      for (let i = 0; i < maxChunks; i++) {
        lastRes = parseJsonToolResult(
          await client.callTool({
            name: 'ext_swarm_wait',
            arguments: { ...args, timeout_seconds: 40 },
          }),
        );
        if (!lastRes.timedOut) return lastRes;
      }
      return lastRes;
    }

    // Wait for writer turn 1
    const wait1 = await waitWithChunks({ swarm_id: swarmId, until: 'worker_done', worker_name: 'writer' });
    assert.equal(wait1.timedOut, false, 'Writer turn 1 timed out');
    const st1 = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_status',
        arguments: { swarm_id: swarmId, include_diff: true },
      }),
    );
    const w1 = st1.swarm.members.writer;
    assert.equal(w1.status, 'waiting', `Expected writer waiting, got ${w1.status}: ${w1.lastError}`);
    assert.ok(w1.sessionId, 'Expected writer sessionId');
    assert.ok(w1.usage.totalTokens > 0, 'Expected writer usage.totalTokens > 0');
    if (!existsSync(join(writerCwd, 'hello.txt'))) {
      const boardPath = join(dataDir, 'swarms', swarmId, 'board.jsonl');
      const boardText = existsSync(boardPath) ? readFileSync(boardPath, 'utf8') : '(no board)';
      const logPath = join(dataDir, 'swarms', swarmId, 'logs', 'writer.ndjson');
      const logText = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '(no log)';
      assert.fail(`hello.txt missing in ${writerCwd}.\nBoard:\n${boardText}\nLog:\n${logText}`);
    }
    assert.deepEqual(st1.diffs.writer.outOfScopeFiles, [], 'Expected zero out-of-scope edits');
    console.log(`[smoke] Turn 1 ok: sessionId=${w1.sessionId}, tokens=${w1.usage.totalTokens}`);

    // 7. Add read-only reviewer, then wake writer via @writer (session resume) -> writer wakes @reviewer (peer mention)
    await client.callTool({
      name: 'ext_swarm_add',
      arguments: {
        swarm_id: swarmId,
        name: 'reviewer',
        role: 'verifier',
        provider: 'dsh',
        workspace: 'inherit',
        permission_mode: 'read-only',
        brief:
          'Reply IMMEDIATELY right now with "@coordinator [done] reviewer ready" and end your turn (do NOT spawn subagents or call wait tools). In later follow-up turns when @mentioned by @writer, reply ONLY "@coordinator [done] reviewed" and do not mention @writer.',
      },
    });
    // Wait for reviewer initial turn to settle
    const initRevWait = await waitWithChunks({ swarm_id: swarmId, until: 'all_idle' });
    assert.equal(initRevWait.timedOut, false, 'Reviewer initial turn timed out');

    const beforeResumeSeq = parseJsonToolResult(
      await client.callTool({ name: 'ext_swarm_status', arguments: { swarm_id: swarmId } }),
    ).swarm.headSeq;

    // Post follow-up mentioning @writer which must instruct writer to mention @reviewer
    parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_post',
        arguments: {
          swarm_id: swarmId,
          text: '@writer Append a second line "line2" to hello.txt, commit it with `git add hello.txt && git commit -m "add line2"`, and end your reply with "@reviewer [done] updated hello.txt, please acknowledge".',
        },
      }),
    );

    // Wait until both writer (turn 2) and reviewer (woken by writer's @reviewer) finish
    const wRes = await waitWithChunks({ swarm_id: swarmId, since: beforeResumeSeq, until: 'all_idle' }, 5);
    if (wRes.timedOut) {
      const boardPath = join(dataDir, 'swarms', swarmId, 'board.jsonl');
      const boardText = existsSync(boardPath) ? readFileSync(boardPath, 'utf8') : '(no board)';
      assert.fail(`Turn 2 + reviewer handoff timed out.\nMembers: ${JSON.stringify(wRes.swarm?.members)}\nBoard:\n${boardText}`);
    }

    const st2 = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_status',
        arguments: { swarm_id: swarmId, include_diff: true },
      }),
    );
    const w2 = st2.swarm.members.writer;
    const rev2 = st2.swarm.members.reviewer;
    assert.equal(w2.sessionId, w1.sessionId, 'Expected writer to reuse same sessionId on resume');
    assert.ok(w2.turns >= 2, `Expected writer turns >= 2, got ${w2.turns}`);
    assert.ok(rev2.turns >= 2, `Expected reviewer to be woken by @reviewer (turns=${rev2.turns})`);
    const helloContent = readFileSync(join(writerCwd, 'hello.txt'), 'utf8');
    assert.ok(helloContent.includes('line2'), `Expected line2 in hello.txt, got: ${helloContent}`);

    // Verify app_get_snapshot
    const snapRes = await client.callTool({
      name: 'app_get_snapshot',
      arguments: { swarm_id: swarmId, include_diff: true },
    });
    assert.ok(snapRes.structuredContent?.edges?.length > 0, 'Expected graph edges in snapshot');

    // 8. Verify kill & worktree cleanup
    const killRes = parseJsonToolResult(
      await client.callTool({
        name: 'ext_swarm_kill',
        arguments: { swarm_id: swarmId, name: 'all', remove_worktree: true },
      }),
    );
    assert.ok(killRes.killed.includes('writer'));
    assert.ok(!existsSync(writerCwd), 'Worktree directory should be removed after kill');

    console.log('[smoke] ALL E2E CHECKS PASSED');
  } finally {
    try {
      await client?.close();
    } catch {
      // Ignore
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err);
  process.exit(1);
});
