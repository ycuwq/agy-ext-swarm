import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearBrainIndexCache,
  clearTranscriptCache,
  parseTranscriptFile,
  readHostTelemetry,
  readNativeSubagentLogLines,
  readTranscriptTitleHead,
} from '../dist/host-telemetry.mjs';

function writeJsonl(path, lines) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

async function main() {
  const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'agy-host-telemetry-test-')));
  try {
    clearTranscriptCache();
    clearBrainIndexCache();

    // 1. Incremental byte-offset parsing + partial line buffering + truncation reset
    const incPath = join(tempRoot, 'inc-transcript.jsonl');
    writeJsonl(incPath, [
      {
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        created_at: '2026-11-25T10:00:00Z',
        content: '<USER_REQUEST>\nRefactor host telemetry\n</USER_REQUEST>',
      },
      {
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-25T10:00:02Z',
        model: 'gemini-4-neon-medium',
        input_tokens: 1000,
        cache_read_tokens: 3000,
        output_tokens: 200,
        status: 'DONE',
        tool_calls: [{ name: 'read_file', args: { Path: '/tmp/a.ts' } }],
      },
    ]);

    const p1 = parseTranscriptFile(incPath);
    assert.ok(p1, 'initial parseTranscriptFile should succeed');
    assert.equal(p1.title, 'Refactor host telemetry');
    assert.equal(p1.turns, 1);
    assert.equal(p1.plannerSteps, 1);
    assert.equal(p1.steps.length, 1);
    assert.equal(p1.lastToolName, 'read_file');

    // Append a partial line (no trailing newline) and verify it does not corrupt state
    appendFileSync(incPath, '{"type":"PLANNER_RESPONSE","model":"gemini-4-neon-xhigh"', 'utf8');
    const pPartial = parseTranscriptFile(incPath);
    assert.equal(pPartial.plannerSteps, 1, 'partial line without newline must wait');

    // Complete that line with trailing newline
    appendFileSync(
      incPath,
      ',"created_at":"2026-11-25T10:00:05Z","input_tokens":500,"cache_read_tokens":1500,"output_tokens":100,"status":"DONE","content":"All checked."}\n',
      'utf8',
    );
    const p2 = parseTranscriptFile(incPath);
    assert.equal(p2.plannerSteps, 2);
    assert.equal(p2.steps.length, 2);
    assert.equal(p2.latestModel, 'gemini-4-neon-xhigh');
    assert.deepEqual(p2.models, ['gemini-4-neon-medium', 'gemini-4-neon-xhigh']);
    assert.equal(p2.lastAssistantText, 'All checked.');

    // Truncate/replace file and verify cache resets cleanly
    writeJsonl(incPath, [
      {
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-25T10:01:00Z',
        model: 'gemini-4-hydrogen',
        input_tokens: 100,
        cache_read_tokens: 0,
        output_tokens: 50,
        status: 'DONE',
      },
    ]);
    const p3 = parseTranscriptFile(incPath);
    assert.equal(p3.plannerSteps, 1);
    assert.equal(p3.steps.length, 1);
    assert.equal(p3.latestModel, 'gemini-4-hydrogen');

    // 2. Multi-wave brain tree + status machine + top-level filtering + child->parent auto-resolution
    const brainDir = join(tempRoot, 'brain');
    const parentId = 'parent-conv-0001';
    const childWorkingId = 'child-work-0001';
    const childWaitingId = 'child-wait-0002';
    const childFailedId = 'child-fail-0003';
    const childKilledId = 'child-kill-0004';
    const childStaleId = 'child-stale-0005';

    const nowMs = Date.now();
    const swarmCreatedAt = new Date(nowMs - 30_000).toISOString();
    const preSwarm10s = new Date(nowMs - 40_000).toISOString(); // inside 60s grace window
    const staleOld = new Date(nowMs - 3_600_000).toISOString(); // 1 hour ago

    // Parent transcript
    writeJsonl(join(brainDir, parentId, '.system_generated', 'logs', 'transcript.jsonl'), [
      {
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        created_at: new Date(nowMs - 120_000).toISOString(),
        content: '<USER_REQUEST>\nAudit the multi-agent architecture\n</USER_REQUEST>',
      },
      {
        type: 'PLANNER_RESPONSE',
        created_at: new Date(nowMs - 90_000).toISOString(),
        model: 'gemini-4-neon-medium',
        input_tokens: 2000,
        cache_read_tokens: 8000,
        output_tokens: 400,
        status: 'DONE',
      },
      {
        type: 'PLANNER_RESPONSE',
        created_at: new Date(nowMs - 15_000).toISOString(),
        model: 'gemini-4-neon-xhigh',
        input_tokens: 1500,
        cache_read_tokens: 8500,
        output_tokens: 500,
        status: 'DONE',
      },
    ]);

    // Subagent descriptors on parent
    const parentSubDir = join(brainDir, parentId, '.system_generated', 'subagents');
    mkdirSync(parentSubDir, { recursive: true });
    const descriptors = [
      {
        conversationId: childWorkingId,
        subagentDescriptor: { typeName: 'research', role: 'Codebase Researcher' },
        state: 'SUBAGENT_STATE_ALIVE',
        spawnStepIndex: 500,
        workspaceUris: ['file:///tmp/repo'],
      },
      {
        conversationId: childWaitingId,
        subagentDescriptor: { typeName: 'browser', role: 'UI Verifier' },
        state: 'SUBAGENT_STATE_ALIVE',
        spawnStepIndex: 500,
      },
      {
        conversationId: childFailedId,
        subagentDescriptor: { typeName: 'research', role: 'Security Auditor' },
        state: 'SUBAGENT_STATE_ALIVE',
        spawnStepIndex: 500,
      },
      {
        conversationId: childKilledId,
        subagentDescriptor: { typeName: 'self', role: 'Cancelled Worker' },
        state: 'SUBAGENT_STATE_KILLED',
        spawnStepIndex: 500,
      },
      {
        conversationId: childStaleId,
        subagentDescriptor: { typeName: 'research', role: 'Old Wave Auditor' },
        state: 'SUBAGENT_STATE_ALIVE',
        spawnStepIndex: 100,
      },
    ];
    for (const d of descriptors) {
      writeFileSync(join(parentSubDir, `${d.conversationId}.json`), JSON.stringify(d, null, 2));
    }

    // Working child: fresh GENERIC step after read_file
    const workPath = join(brainDir, childWorkingId, '.system_generated', 'logs', 'transcript.jsonl');
    writeJsonl(workPath, [
      { type: 'USER_INPUT', source: 'SUBAGENT', created_at: preSwarm10s, content: 'Inspect files' },
      {
        type: 'PLANNER_RESPONSE',
        created_at: new Date(nowMs - 5_000).toISOString(),
        model: 'gemini-4-neon-xhigh',
        input_tokens: 1000,
        cache_read_tokens: 4000,
        output_tokens: 200,
        status: 'DONE',
        tool_calls: [{ name: 'read_file', args: { Path: 'src/index.ts' } }],
      },
      {
        type: 'GENERIC',
        created_at: new Date(nowMs - 2_000).toISOString(),
        status: 'DONE',
        content: 'file contents...',
      },
    ]);

    // Waiting child: DONE PLANNER_RESPONSE without tool calls + message sent to parent
    const waitPath = join(brainDir, childWaitingId, '.system_generated', 'logs', 'transcript.jsonl');
    writeJsonl(waitPath, [
      { type: 'USER_INPUT', source: 'SUBAGENT', created_at: preSwarm10s, content: 'Verify UI' },
      {
        type: 'PLANNER_RESPONSE',
        created_at: new Date(nowMs - 10_000).toISOString(),
        model: 'gemini-4-flash',
        input_tokens: 500,
        cache_read_tokens: 2500,
        output_tokens: 150,
        status: 'DONE',
        content: 'UI verified cleanly.',
      },
    ]);
    const parentMsgDir = join(brainDir, parentId, '.system_generated', 'messages');
    mkdirSync(parentMsgDir, { recursive: true });
    writeFileSync(
      join(parentMsgDir, 'msg-1.json'),
      JSON.stringify({
        id: 'msg-1',
        sender: childWaitingId,
        recipient: parentId,
        timestamp: new Date(nowMs - 9_000).toISOString(),
        content: 'Verified all panels pass.',
      }),
    );

    // Failed child: ERROR_MESSAGE
    writeJsonl(join(brainDir, childFailedId, '.system_generated', 'logs', 'transcript.jsonl'), [
      { type: 'USER_INPUT', source: 'SUBAGENT', created_at: preSwarm10s, content: 'Audit security' },
      {
        type: 'PLANNER_RESPONSE',
        created_at: new Date(nowMs - 20_000).toISOString(),
        model: 'gemini-4-neon-medium',
        input_tokens: 400,
        cache_read_tokens: 600,
        output_tokens: 50,
        status: 'DONE',
      },
      {
        type: 'ERROR_MESSAGE',
        created_at: new Date(nowMs - 18_000).toISOString(),
        content: 'Context limit exceeded',
      },
    ]);

    // Killed child
    writeJsonl(join(brainDir, childKilledId, '.system_generated', 'logs', 'transcript.jsonl'), [
      { type: 'USER_INPUT', source: 'SUBAGENT', created_at: preSwarm10s, content: 'Cancelled' },
    ]);

    // Stale historical child (old wave, old mtime)
    const staleDescPath = join(parentSubDir, `${childStaleId}.json`);
    const stalePath = join(brainDir, childStaleId, '.system_generated', 'logs', 'transcript.jsonl');
    writeJsonl(stalePath, [
      { type: 'USER_INPUT', source: 'SUBAGENT', created_at: staleOld, content: 'Old wave' },
      {
        type: 'PLANNER_RESPONSE',
        created_at: staleOld,
        model: 'gemini-4-neon-medium',
        input_tokens: 10_000,
        cache_read_tokens: 40_000,
        output_tokens: 1_000,
        status: 'DONE',
      },
    ]);
    const staleDate = new Date(nowMs - 3_600_000);
    // Add an extra step missing created_at (timestampMs === 0) to verify it does not leak into sinceSwarmStart
    appendFileSync(
      stalePath,
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        model: 'gemini-4-neon-medium',
        input_tokens: 900,
        cache_read_tokens: 0,
        output_tokens: 100,
        status: 'DONE',
      }) + '\n',
      'utf8',
    );
    utimesSync(stalePath, staleDate, staleDate);
    utimesSync(staleDescPath, staleDate, staleDate);

    // 2b. Real Antigravity subagent transcript shape: SYSTEM_MESSAGE + PLANNER_RESPONSE + GENERIC (no USER_INPUT)
    const realSubId = 'child-sysmsg-0006';
    writeFileSync(
      join(parentSubDir, `${realSubId}.json`),
      JSON.stringify(
        {
          conversationId: realSubId,
          subagentDescriptor: { typeName: 'research', role: 'Real Format Researcher' },
          state: 'SUBAGENT_STATE_ALIVE',
          spawnStepIndex: 500,
        },
        null,
        2,
      ),
    );
    writeJsonl(join(brainDir, realSubId, '.system_generated', 'logs', 'transcript.jsonl'), [
      {
        type: 'SYSTEM_MESSAGE',
        source: 'SYSTEM',
        created_at: preSwarm10s,
        content: 'Investigate host telemetry paths.',
      },
      {
        type: 'PLANNER_RESPONSE',
        created_at: new Date(nowMs - 8_000).toISOString(),
        model: 'gemini-4-hydrogen-high',
        input_tokens: 800,
        cache_read_tokens: 2000,
        output_tokens: 200,
        status: 'DONE',
      },
    ]);

    clearBrainIndexCache();
    clearTranscriptCache();

    // Verify fast head-only title reader on a large padded file (> 32 KB)
    const paddedPath = join(tempRoot, 'large-title.jsonl');
    writeJsonl(paddedPath, [
      {
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        created_at: '2026-11-25T10:00:00Z',
        content: '<USER_REQUEST>\nFast Head Title\n</USER_REQUEST>',
      },
    ]);
    appendFileSync(
      paddedPath,
      JSON.stringify({ type: 'GENERIC', content: 'x'.repeat(40 * 1024) }) + '\n',
      'utf8',
    );
    assert.equal(readTranscriptTitleHead(paddedPath), 'Fast Head Title');

    const mockSwarm = {
      id: 'swm-test',
      title: 'Test Swarm',
      repoRoot: tempRoot,
      defaultProvider: 'dsh',
      profile: 'headless',
      maxConcurrency: 4,
      maxHops: 20,
      turnTimeoutSeconds: 1800,
      stallTimeoutSeconds: 300,
      hopCount: 0,
      headSeq: 0,
      createdAt: swarmCreatedAt,
      updatedAt: swarmCreatedAt,
      members: {},
    };

    // Pass a child conversation ID as preferredConversationId -> must auto-resolve to parent!
    const snap = await readHostTelemetry(brainDir, mockSwarm, childWorkingId);

    assert.equal(snap.conversationId, parentId, 'child ID should resolve to root parent conversation');
    assert.equal(
      snap.availableConversations.length,
      1,
      'child subagent conversations must be excluded from availableConversations',
    );
    assert.equal(snap.availableConversations[0].id, parentId);
    assert.equal(snap.availableConversations[0].subagentCount, 6);
    assert.equal(snap.availableConversations[0].activeSubagentCount, 1);

    // Coordinator usage checks
    assert.equal(snap.coordinator.sessionTotal.totalTokens, 20_900);
    assert.equal(snap.coordinator.sinceSwarmStart.totalTokens, 10_500);

    // Subagent statuses and scoping
    assert.equal(snap.subagents.length, 6);
    const byId = new Map(snap.subagents.map((s) => [s.id, s]));

    assert.equal(byId.get(childWorkingId).status, 'working');
    assert.equal(byId.get(childWorkingId).activity, 'Running read_file');
    assert.equal(byId.get(childWorkingId).inCurrentSwarm, true);

    assert.equal(byId.get(childWaitingId).status, 'waiting');
    assert.equal(byId.get(childWaitingId).messagesToParent, 1);
    assert.equal(byId.get(childWaitingId).lastReplyPreview, 'Verified all panels pass.');
    assert.equal(byId.get(childWaitingId).inCurrentSwarm, true);

    assert.equal(byId.get(childFailedId).status, 'failed');
    assert.equal(byId.get(childFailedId).lastError, 'Context limit exceeded');
    assert.equal(byId.get(childFailedId).inCurrentSwarm, true);

    assert.equal(byId.get(childKilledId).status, 'killed');
    assert.equal(byId.get(childKilledId).inCurrentSwarm, true);

    assert.equal(byId.get(childStaleId).status, 'waiting');
    assert.equal(byId.get(childStaleId).inCurrentSwarm, false, 'stale wave subagent must not be inCurrentSwarm');

    assert.equal(byId.get(realSubId).turns, 1, 'SYSTEM_MESSAGE subagent should count as >= 1 turn');
    assert.equal(byId.get(realSubId).status, 'waiting');
    assert.equal(byId.get(realSubId).inCurrentSwarm, true);

    assert.equal(snap.subagentUsage.totalCount, 6);
    assert.equal(snap.subagentUsage.currentSwarmCount, 5);
    assert.equal(snap.subagentUsage.runningCount, 1);
    // Session total = 5200 + 3150 + 1050 + 52000 + 3000 = 64400
    assert.equal(snap.subagentUsage.sessionTotal.totalTokens, 64_400);
    // Since swarm start excludes stale 52000 (including its timestampMs=0 step) -> 12400
    assert.equal(snap.subagentUsage.sinceSwarmStart.totalTokens, 12_400);

    // 3. Log tail reader + path traversal guard
    const tail = readNativeSubagentLogLines(brainDir, childWorkingId, 10);
    assert.equal(tail.length, 3);
    assert.throws(() => readNativeSubagentLogLines(brainDir, '../escape', 10), /Invalid conversation ID/);

    console.log('[host-telemetry.test] ALL HOST TELEMETRY CHECKS PASSED');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[host-telemetry.test] FAILED:', err);
  process.exit(1);
});
