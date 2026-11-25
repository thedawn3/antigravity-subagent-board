/**
 * Subagent Board 核心纯函数离线单元测试（仅使用合成数据，不依赖宿主环境或网络）。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import {
  cleanActivitySummary,
  cleanToolOutputText,
  deepUnquoteString,
  extractWorkspaceRoots,
  parseSystemMessageEnvelope,
  replacePathsInText,
  shortenPath,
  stripRedundantCd,
} from '../sidecars/subagent_board/lib/format_helpers.mjs';
import { formatModelLabel, humanizeTranscriptModel } from '../sidecars/subagent_board/lib/ls_client.mjs';
import {
  clearSwarmReaderCaches,
  readSwarmBoard,
  readSwarmMetadata,
  stripSwarmRoleWrapper,
} from '../sidecars/subagent_board/lib/swarm_reader.mjs';
import { buildToolCallSemantic, parseTranscriptEvents, readAgentDetail } from '../sidecars/subagent_board/lib/transcript_reader.mjs';
import {
  buildGroupSnapshot,
  clearScannerCaches,
  describeToolCall,
  formatShortModelLabel,
} from '../sidecars/subagent_board/lib/tree_scanner.mjs';

const tempDirsToClean = [];
const origExecutableDataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;

function createTempDir(prefix = 'subagent-board-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirsToClean.push(dir);
  return dir;
}

after(() => {
  if (origExecutableDataDir === undefined) {
    delete process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  } else {
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = origExecutableDataDir;
  }
  clearScannerCaches();
  for (const dir of tempDirsToClean) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const DEMO_UUID = '11111111-2222-3333-4444-555555555555';
const DEMO_PARENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const DEMO_ROLE_MAP = {
  [DEMO_UUID]: 'Backend Explorer',
  [DEMO_PARENT]: 'Track Orchestrator',
};
const DEMO_ROOTS = ['/Users/alice/projects/demo-repo', '/home/alice/work/app', 'C:/Users/bob/code/svc'];

test('extractWorkspaceRoots decodes file:// URIs and normalizes slashes', () => {
  const roots = extractWorkspaceRoots([
    'file:///Users/alice/projects/demo-repo/',
    'file:///C:/Users/bob/code/svc',
    '/home/alice/work/app/',
  ]);
  assert.deepEqual(roots, ['/Users/alice/projects/demo-repo', 'C:/Users/bob/code/svc', '/home/alice/work/app']);
});

test('shortenPath collapses macOS, Linux, Windows, and Teamwork paths', () => {
  assert.equal(
    shortenPath(`/Users/alice/.gemini/antigravity/scratch/teamwork/${DEMO_UUID}/.agents/teamwork/PROJECT.md`, DEMO_ROOTS),
    'teamwork/PROJECT.md',
  );
  assert.equal(shortenPath('/Users/alice/projects/demo-repo/src/main.go:42-80', DEMO_ROOTS), 'src/main.go:42-80');
  assert.equal(shortenPath('/home/alice/work/app/pkg/api.ts', DEMO_ROOTS), 'pkg/api.ts');
  assert.equal(shortenPath('C:\\Users\\bob\\code\\svc\\cmd\\app.go', DEMO_ROOTS), 'cmd/app.go');
  assert.equal(shortenPath('/Users/alice/.gemini/antigravity/brain/12345678/.user_uploaded/img.png', []), '附件/img.png');
  assert.equal(shortenPath('/home/alice/a/b/c/d/e/file.txt', []), '~/.../e/file.txt');
});

test('replacePathsInText shortens paths inside prose while keeping punctuation', () => {
  const txt = '已写入 /Users/alice/projects/demo-repo/internal/handler.go:10-20，请检查。';
  assert.equal(replacePathsInText(txt, DEMO_ROOTS), '已写入 internal/handler.go:10-20，请检查。');
});

test('cleanActivitySummary strips markdown noise, shortens paths, and maps UUIDs', () => {
  const raw = `**完成调研**：请查看 [交接报告](file:///Users/alice/projects/demo-repo/docs/spec.md) 并通知 \`${DEMO_UUID}\`。\n- 细节见 /Users/alice/projects/demo-repo/src/index.ts`;
  const cleaned = cleanActivitySummary(raw, DEMO_ROOTS, DEMO_ROLE_MAP, 110);
  assert.ok(!cleaned.includes('**'));
  assert.ok(!cleaned.includes('/Users/alice'));
  assert.ok(cleaned.includes('Backend Explorer'));
  assert.ok(cleaned.includes('src/index.ts'));
});

test('deepUnquoteString unwraps up to two layers of JSON string quoting', () => {
  const doubleQuoted = JSON.stringify(JSON.stringify('# Title\n\nBody'));
  assert.equal(deepUnquoteString(doubleQuoted), '# Title\n\nBody');
  assert.equal(deepUnquoteString(JSON.stringify('# Title\n\nBody')), '# Title\n\nBody');
  assert.equal(deepUnquoteString('no quotes'), 'no quotes');
});

test('stripRedundantCd removes leading workspace cd and shortens inner paths', () => {
  const cmd = 'cd /Users/alice/projects/demo-repo && go test /Users/alice/projects/demo-repo/pkg/...';
  assert.equal(stripRedundantCd(cmd, DEMO_ROOTS), 'go test pkg/...');
});

test('cleanToolOutputText strips timestamps and summarizes confirmations', () => {
  const created = cleanToolOutputText(
    'Created At: 2026-01-01T10:00:00Z\nCompleted At: 2026-01-01T10:00:01.500Z\nCreated file.\n\n---\n\nCreated At: 2026-01-01T10:00:02Z\nCompleted At: 2026-01-01T10:00:03Z\nCreated file.',
    DEMO_ROLE_MAP,
  );
  assert.equal(created.text, '');
  assert.equal(created.shortStatus, '已写入 2 个文件');
  assert.equal(created.durationText, '3.0s');

  const sent = cleanToolOutputText(
    `Created At: 2026-01-01T10:00:00Z\nCompleted At: 2026-01-01T10:00:02Z\nMessage sent to "${DEMO_UUID}".`,
    DEMO_ROLE_MAP,
  );
  assert.equal(sent.shortStatus, '已发送给 Backend Explorer');

  const stdout = cleanToolOutputText('Created At: 2026-01-01T10:00:00Z\nCompleted At: 2026-01-01T10:00:01Z\nok pkg/foo 0.12s', DEMO_ROLE_MAP);
  assert.equal(stdout.shortStatus, '');
  assert.equal(stdout.text, 'ok pkg/foo 0.12s');
});

test('parseSystemMessageEnvelope unpacks agent messages and strips system wrappers', () => {
  const wrapped = `The following is a <SYSTEM_MESSAGE> note.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-01-01T10:00:00Z sender=${DEMO_PARENT} priority=MESSAGE_PRIORITY_HIGH content=Please inspect the API layer.\n</SYSTEM_MESSAGE>`;
  const parsed = parseSystemMessageEnvelope(wrapped);
  assert.equal(parsed.isAgentMessage, true);
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.messages[0].sender, DEMO_PARENT);
  assert.equal(parsed.messages[0].content, 'Please inspect the API layer.');

  const plainSys = parseSystemMessageEnvelope('The following is a <SYSTEM_MESSAGE> note.\n\n<SYSTEM_MESSAGE>\nReminder: work efficiently.\n</SYSTEM_MESSAGE>');
  assert.equal(plainSys.isAgentMessage, false);
  assert.equal(plainSys.content, 'Reminder: work efficiently.');
});

test('model label helpers format transcript and short labels cleanly', () => {
  assert.equal(humanizeTranscriptModel('gemini-4-hydrogen-tiered-high'), 'Gemini 4 Hydrogen (High)');
  assert.equal(humanizeTranscriptModel('gemini-4-neon-tiered-xhigh'), 'Gemini 4 Neon (XHigh)');
  assert.equal(formatModelLabel('MODEL_PLACEHOLDER_M530', '', 'gemini-4-hydrogen-tiered-high', {}), 'Gemini 4 Hydrogen (High)');
  assert.equal(formatShortModelLabel('Gemini 4 Hydrogen (High)'), 'Hydrogen · High');
});

test('stripSwarmRoleWrapper strips Swarm Worker wrapper and keeps plain roles intact', () => {
  assert.equal(stripSwarmRoleWrapper('Swarm Worker (backend-api)'), 'backend-api');
  assert.equal(stripSwarmRoleWrapper('  Swarm Worker ( ui-polish ) '), 'ui-polish');
  assert.equal(stripSwarmRoleWrapper('Backend Explorer'), 'Backend Explorer');
  assert.equal(stripSwarmRoleWrapper(''), '');
});

test('cleanToolOutputText summarizes Swarm post confirmations', () => {
  const postedSeq = cleanToolOutputText('Created At: 2026-01-01T10:00:00Z\nCompleted At: 2026-01-01T10:00:01Z\nPosted #7', {});
  assert.equal(postedSeq.text, '');
  assert.equal(postedSeq.shortStatus, '已发帖 #7');

  const postedPlain = cleanToolOutputText('Message posted.', {});
  assert.equal(postedPlain.text, '');
  assert.equal(postedPlain.shortStatus, '已发群消息');
});

test('describeToolCall and buildToolCallSemantic format Swarm tools with unquoted args', () => {
  const postTc = {
    name: 'post_message',
    args: { text: JSON.stringify('@verifier [done] 完成全部接口开发\n\n细节如下') },
  };
  const postDesc = describeToolCall(postTc, DEMO_ROOTS, DEMO_ROLE_MAP);
  assert.equal(postDesc.actionLabel, '发群消息');
  assert.ok(postDesc.brief.includes('@verifier'));

  const postSem = buildToolCallSemantic(postTc, DEMO_ROOTS, DEMO_ROLE_MAP);
  assert.equal(postSem.actionLabel, '发群消息');
  assert.equal(postSem.target, '@verifier');
  assert.equal(postSem.previewKind, 'markdown');
  assert.ok(postSem.previewText.includes('细节如下'));

  const addTc = {
    name: 'swarm',
    args: {
      action: JSON.stringify('add'),
      name: JSON.stringify('worker-alpha'),
      brief: JSON.stringify('负责实现核心模块'),
    },
  };
  const addSem = buildToolCallSemantic(addTc, DEMO_ROOTS, DEMO_ROLE_MAP);
  assert.equal(addSem.actionLabel, 'Swarm 派员');
  assert.equal(addSem.target, 'worker-alpha');
  assert.equal(addSem.previewKind, 'markdown');
  assert.equal(addSem.previewText, '负责实现核心模块');

  const statusTc = { name: 'swarm', args: { action: JSON.stringify('status') } };
  const statusSem = buildToolCallSemantic(statusTc, DEMO_ROOTS, DEMO_ROLE_MAP);
  assert.equal(statusSem.actionLabel, 'Swarm 状态');
  assert.equal(statusSem.previewKind, 'none');

  const readTc = { name: 'read_board', args: { since: JSON.stringify('4') } };
  const readSem = buildToolCallSemantic(readTc, DEMO_ROOTS, DEMO_ROLE_MAP);
  assert.equal(readSem.actionLabel, '读取消息板');
  assert.equal(readSem.target, 'since #4');
  assert.equal(readSem.previewKind, 'none');

  const waitTc = { name: 'swarm_wait', args: { since: JSON.stringify('4') } };
  const waitSem = buildToolCallSemantic(waitTc, DEMO_ROOTS, DEMO_ROLE_MAP);
  assert.equal(waitSem.actionLabel, '等待群消息');
  assert.equal(waitSem.target, '等待 #4 之后');
  assert.equal(waitSem.previewKind, 'none');

  const taskTc = { name: 'manage_task', args: { Action: JSON.stringify('status'), TaskId: JSON.stringify('task-1') } };
  const taskSem = buildToolCallSemantic(taskTc, DEMO_ROOTS, DEMO_ROLE_MAP);
  assert.equal(taskSem.actionLabel, '后台任务');
  assert.equal(taskSem.target, 'status task-1');
});

test('readSwarmMetadata and readSwarmBoard parse metadata, timestamps, mentions, and invalidate cache on change', () => {
  clearSwarmReaderCaches();
  const rootConvDir = createTempDir('swarm-meta-');
  const swarmDir = join(rootConvDir, '.system_generated', 'swarm');
  mkdirSync(swarmDir, { recursive: true });

  const rootId = '10000000-0000-4000-8000-000000000001';
  const alphaId = '10000000-0000-4000-8000-000000000002';
  const betaId = '10000000-0000-4000-8000-000000000003';

  writeFileSync(join(swarmDir, 'swarm.json'), JSON.stringify({ version: 1, backend: 'local', swarm_id: rootId }));
  writeFileSync(
    join(swarmDir, 'members.json'),
    JSON.stringify({
      title: '合成 Swarm 演示',
      members: {
        coordinator: { conversation_id: rootId, role: 'coordinator', model: 'gemini-4-hydrogen-high', killed: false },
        alpha: {
          conversation_id: alphaId,
          role: 'worker',
          model: 'gemini-4-hydrogen-high',
          workspace_mode: 'inherit',
          phase: 'RUNNING',
          desired_state: 'RUNNING',
          killed: false,
        },
        beta: {
          conversation_id: betaId,
          role: 'worker',
          model: 'gemini-4-neon-tiered-high',
          workspace_mode: 'share',
          phase: 'WAITING',
          desired_state: 'RUNNING',
          killed: true,
          added_by: alphaId,
        },
      },
    }),
  );
  writeFileSync(
    join(swarmDir, 'plan.json'),
    JSON.stringify({
      goal: { title: 'Goal Title', line: 'Goal Line Summary' },
      tasks: { alpha: '实现解析器', beta: '验证边界条件' },
      threads: [{ id: 't1', title: 'Thread 1', tasks: ['alpha', 'beta'] }],
    }),
  );

  const meta = readSwarmMetadata(rootConvDir);
  assert.equal(meta.detected, true);
  assert.equal(meta.title, '合成 Swarm 演示');
  assert.equal(meta.goalTitle, 'Goal Title');
  assert.equal(meta.goalLine, 'Goal Line Summary');
  assert.equal(meta.tasksByMember.alpha, '实现解析器');
  assert.equal(meta.orderedWorkers.length, 2);
  assert.equal(meta.membersByConvId.get(betaId)?.killed, true);
  assert.equal(meta.membersByConvId.get(betaId)?.workspaceMode, 'share');
  assert.equal(meta.convIdByName.get('alpha'), alphaId);

  const boardPath = join(swarmDir, 'board.jsonl');
  writeFileSync(
    boardPath,
    [
      JSON.stringify({
        seq: 1,
        agent: 'coordinator',
        text: '@alpha 请开始工作，完成后联系 `@beta`',
        kind: 'brief',
      }),
      JSON.stringify({
        seq: 2,
        agent: 'alpha',
        text: '@alpha @beta 请同步接口格式',
        time: '2026-01-15 12:30:00',
      }),
      JSON.stringify({
        seq: 3,
        agent: 'beta',
        text: '@all 全体同步进度',
        time: '2026-01-15T04:31:00.000Z',
      }),
      JSON.stringify({
        seq: 4,
        agent: 'alpha',
        text: '补充说明（无 mention）',
        time: '2026-01-15 12:32:00',
      }),
    ].join('\n') + '\n',
  );

  const nudgeMap = new Map([[1, '2026-01-15T04:29:00.123Z']]);
  const board = readSwarmBoard(rootConvDir, {
    convIdByName: meta.convIdByName,
    rootConvId: rootId,
    rootLabel: '主控会话',
    nudgeTimestampsBySeq: nudgeMap,
  });

  assert.equal(board.messages.length, 4);
  assert.equal(board.messages[0].seq, 1);
  assert.equal(board.messages[0].senderConvId, rootId);
  assert.equal(board.messages[0].senderLabel, '主控会话');
  assert.equal(board.messages[0].recipientConvId, alphaId);
  assert.equal(board.messages[0].recipientLabel, 'alpha');
  assert.equal(board.messages[0].timestamp, '2026-01-15T04:29:00.123Z');

  assert.equal(board.messages[1].recipientConvId, '');
  assert.equal(board.messages[1].recipientLabel, '@alpha, @beta');
  assert.ok(board.messages[1].timestampMs > 0);

  assert.equal(board.messages[2].recipientConvId, '');
  assert.equal(board.messages[2].recipientLabel, '全体 (@all)');

  assert.equal(board.messages[3].recipientConvId, '');
  assert.equal(board.messages[3].recipientLabel, '全体 (群板)');
  assert.equal(board.bySeq.get(2)?.senderConvId, alphaId);

  // 追加一行并更新 mtime，验证缓存失效与增量更新
  writeFileSync(
    boardPath,
    [
      JSON.stringify({ seq: 1, agent: 'coordinator', text: '@alpha hi', time: '2026-01-15T04:29:00Z' }),
      JSON.stringify({ seq: 5, agent: 'beta', text: '@coordinator 已完成', time: '2026-01-15T04:33:00Z' }),
    ].join('\n') + '\n',
  );
  const future = new Date(Date.now() + 2000);
  utimesSync(boardPath, future, future);
  const updatedBoard = readSwarmBoard(rootConvDir, {
    convIdByName: meta.convIdByName,
    rootConvId: rootId,
    rootLabel: '主控会话',
  });
  assert.equal(updatedBoard.messages.length, 2);
  assert.equal(updatedBoard.bySeq.get(5)?.recipientConvId, rootId);
  assert.equal(updatedBoard.bySeq.get(5)?.recipientLabel, '主控会话');
});

test('parseTranscriptEvents restores incoming [swarm] nudge messages from swarmBoardBySeq', () => {
  const dir = createTempDir('swarm-tx-');
  const tpPath = join(dir, 'transcript.jsonl');
  const rootId = '20000000-0000-4000-8000-000000000001';
  const alphaId = '20000000-0000-4000-8000-000000000002';

  writeFileSync(
    tpPath,
    [
      JSON.stringify({
        step_index: 0,
        type: 'SYSTEM_MESSAGE',
        created_at: '2026-01-15T05:00:00Z',
        content: `The following is a <SYSTEM_MESSAGE> note.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-01-15T05:00:00Z sender=${rootId} priority=MESSAGE_PRIORITY_HIGH content=[swarm] new board message #2\n</SYSTEM_MESSAGE>`,
      }),
    ].join('\n') + '\n',
  );

  const swarmBoardBySeq = new Map([
    [
      2,
      {
        seq: 2,
        senderConvId: alphaId,
        senderLabel: 'alpha',
        content: '@beta 这是还原后的真实群消息正文',
      },
    ],
  ]);

  const parsed = parseTranscriptEvents(tpPath, {
    roleById: { [rootId]: '主控', [alphaId]: 'alpha' },
    swarmBoardBySeq,
  });

  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].kind, 'incoming_message');
  assert.equal(parsed.events[0].senderId, alphaId);
  assert.equal(parsed.events[0].senderLabel, 'alpha');
  assert.equal(parsed.events[0].content, '@beta 这是还原后的真实群消息正文');
  assert.equal(parsed.events[0].boardSeq, 2);
});

test('buildGroupSnapshot and readAgentDetail integrate Swarm members, fallback models, wait activity, and board fusion', async () => {
  clearScannerCaches();
  const appDataDir = createTempDir('swarm-appdata-');
  const sidecarDataDir = join(appDataDir, 'sidecar_data', 'subagent-board', 'subagent_board');
  mkdirSync(sidecarDataDir, { recursive: true });
  process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = sidecarDataDir;

  const rootId = '30000000-0000-4000-8000-000000000001';
  const workerAId = '30000000-0000-4000-8000-000000000002';
  const workerBId = '30000000-0000-4000-8000-000000000003';
  const nonSwarmSubId = '30000000-0000-4000-8000-000000000004';

  const mkConv = (id) => {
    const convDir = join(appDataDir, 'brain', id);
    mkdirSync(join(convDir, '.system_generated', 'logs'), { recursive: true });
    mkdirSync(join(convDir, '.system_generated', 'messages'), { recursive: true });
    mkdirSync(join(convDir, '.system_generated', 'subagents'), { recursive: true });
    return convDir;
  };

  const rootDir = mkConv(rootId);
  const workerADir = mkConv(workerAId);
  const workerBDir = mkConv(workerBId);
  const nonSwarmDir = mkConv(nonSwarmSubId);

  // 仅给 workerA 写 subagents/*.json（含 Swarm Worker 包裹）；workerB 故意缺失 subagents/*.json 测试自动补全与 killed 同步
  writeFileSync(
    join(rootDir, '.system_generated', 'subagents', `${workerAId}.json`),
    JSON.stringify({
      conversationId: workerAId,
      subagentDescriptor: { typeName: 'worker', role: 'Swarm Worker (worker-a)' },
      state: 'SUBAGENT_STATE_ALIVE',
      spawnStepIndex: 1,
    }),
  );
  // 额外挂载一个没有写进 members.json 的 Swarm Worker 节点，验证纯角色名清洗
  writeFileSync(
    join(workerADir, '.system_generated', 'subagents', `${nonSwarmSubId}.json`),
    JSON.stringify({
      conversationId: nonSwarmSubId,
      subagentDescriptor: { typeName: 'worker', role: 'Swarm Worker (helper-c)' },
      state: 'SUBAGENT_STATE_ALIVE',
      spawnStepIndex: 2,
    }),
  );

  const swarmDir = join(rootDir, '.system_generated', 'swarm');
  mkdirSync(swarmDir, { recursive: true });
  writeFileSync(join(swarmDir, 'swarm.json'), JSON.stringify({ version: 1, swarm_id: rootId }));
  writeFileSync(
    join(swarmDir, 'members.json'),
    JSON.stringify({
      title: '合成集成 Swarm',
      members: {
        coordinator: { conversation_id: rootId, role: 'coordinator', model: 'gemini-4-hydrogen-high', killed: false },
        'worker-a': {
          conversation_id: workerAId,
          role: 'worker',
          model: 'gemini-4-hydrogen-high',
          workspace_mode: 'inherit',
          phase: 'WAITING',
          killed: false,
        },
        'worker-b': {
          conversation_id: workerBId,
          role: 'worker',
          model: 'gemini-4-neon-tiered-high',
          workspace_mode: 'share',
          phase: 'KILLED',
          killed: true,
        },
      },
    }),
  );
  writeFileSync(
    join(swarmDir, 'plan.json'),
    JSON.stringify({
      goal: { title: '集成目标', line: '验证全链路聚合' },
      tasks: { 'worker-a': '开发后端接口', 'worker-b': '执行端到端测试' },
    }),
  );
  writeFileSync(
    join(swarmDir, 'board.jsonl'),
    [
      JSON.stringify({ seq: 1, agent: 'coordinator', text: '@worker-a 开始实现', kind: 'brief' }),
      JSON.stringify({
        seq: 2,
        agent: 'worker-a',
        text: '@worker-b 接口已完成，请验证',
        time: '2026-01-15T06:01:00Z',
      }),
    ].join('\n') + '\n',
  );

  // 写入 root 与 worker 各自的 transcript.jsonl
  writeFileSync(
    join(rootDir, '.system_generated', 'logs', 'transcript.jsonl'),
    JSON.stringify({
      step_index: 0,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-01-15T06:00:00Z',
      model: 'gemini-4-hydrogen-high',
      tool_calls: [{ name: 'swarm_wait', args: { since: '2' } }],
    }) + '\n',
  );
  // workerA：先 post_message 再 swarm_wait，且无 model 字段以测试 swarmModelFallback
  writeFileSync(
    join(workerADir, '.system_generated', 'logs', 'transcript.jsonl'),
    [
      JSON.stringify({
        step_index: 0,
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-01-15T06:00:01Z',
        content: `The following is a <SYSTEM_MESSAGE> note.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-01-15T06:00:01Z sender=${rootId} priority=MESSAGE_PRIORITY_HIGH content=[swarm] new board message #1\n</SYSTEM_MESSAGE>`,
      }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-01-15T06:01:00Z',
        tool_calls: [{ name: 'post_message', args: { text: JSON.stringify('@worker-b 接口已完成，请验证') } }],
      }),
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-01-15T06:01:05Z',
        tool_calls: [{ name: 'swarm_wait', args: { since: '2' } }],
      }),
    ].join('\n') + '\n',
  );
  writeFileSync(
    join(workerBDir, '.system_generated', 'logs', 'transcript.jsonl'),
    JSON.stringify({
      step_index: 0,
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      created_at: '2026-01-15T06:01:01Z',
      content: `The following is a <SYSTEM_MESSAGE> note.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-01-15T06:01:01Z sender=${rootId} priority=MESSAGE_PRIORITY_HIGH content=[swarm] new board message #2\n</SYSTEM_MESSAGE>`,
    }) + '\n',
  );
  writeFileSync(join(nonSwarmDir, '.system_generated', 'logs', 'transcript.jsonl'), '');

  // 写入 messages/*.json：含 #1 唤醒、#1 重复派单、#2 唤醒、空消息、真实直连消息
  writeFileSync(
    join(workerADir, '.system_generated', 'messages', 'm1.json'),
    JSON.stringify({
      id: 'm1',
      sender: rootId,
      recipient: workerAId,
      timestamp: '2026-01-15T06:00:01Z',
      content: '[swarm] new board message #1',
    }),
  );
  writeFileSync(
    join(workerADir, '.system_generated', 'messages', 'm2.json'),
    JSON.stringify({
      id: 'm2',
      sender: rootId,
      recipient: workerAId,
      timestamp: '2026-01-15T06:00:02Z',
      content: 'You have just started. Your assignment (recorded on the board as #1 for @worker-a):\n\n开始工作',
    }),
  );
  writeFileSync(
    join(workerADir, '.system_generated', 'messages', 'm_empty.json'),
    JSON.stringify({
      id: 'm_empty',
      sender: rootId,
      recipient: workerAId,
      timestamp: '2026-01-15T06:00:03Z',
      content: '   ',
    }),
  );
  writeFileSync(
    join(workerBDir, '.system_generated', 'messages', 'm3.json'),
    JSON.stringify({
      id: 'm3',
      sender: rootId,
      recipient: workerBId,
      timestamp: '2026-01-15T06:01:01Z',
      content: '[swarm] new board message #2',
    }),
  );
  writeFileSync(
    join(workerBDir, '.system_generated', 'messages', 'm_direct.json'),
    JSON.stringify({
      id: 'm_direct',
      sender: workerAId,
      recipient: workerBId,
      timestamp: '2026-01-15T06:02:00Z',
      content: '额外直连消息',
    }),
  );

  // 从 workerBId 出发也能通过 members.json 反向边溯源到 rootId
  const snap = await buildGroupSnapshot(workerBId);
  assert.equal(snap.status, 'ready');
  assert.equal(snap.rootConversationId, rootId);
  assert.equal(snap.swarm.detected, true);
  assert.equal(snap.swarm.title, '合成集成 Swarm');
  assert.equal(snap.swarm.goalTitle, '集成目标');
  assert.equal(snap.swarm.goalLine, '验证全链路聚合');
  assert.equal(snap.swarm.boardCount, 2);
  assert.equal(snap.swarm.membersCount, 3);
  assert.equal(snap.nodes.length, 4);

  const nodeA = snap.nodes.find((n) => n.conversationId === workerAId);
  const nodeB = snap.nodes.find((n) => n.conversationId === workerBId);
  const nodeC = snap.nodes.find((n) => n.conversationId === nonSwarmSubId);

  assert.equal(nodeA.role, 'worker-a');
  assert.equal(nodeA.isSwarmMember, true);
  assert.equal(nodeA.swarmTask, '开发后端接口');
  assert.equal(nodeA.modelLabel, 'Gemini 4 Hydrogen (High)');
  assert.ok(nodeA.currentActivity.startsWith('等待群消息 · '));
  assert.ok(!nodeA.currentActivity.includes('swarm_wait'));

  assert.equal(nodeB.role, 'worker-b');
  assert.equal(nodeB.status, 'killed');
  assert.equal(nodeB.subagentState, 'SUBAGENT_STATE_KILLED');
  assert.equal(nodeB.swarmWorkspaceMode, 'share');
  assert.equal(nodeB.modelLabel, 'Gemini 4 Neon (High)');

  assert.equal(nodeC.role, 'helper-c');
  assert.equal(nodeC.isSwarmMember, true);

  // 消息板应仅包含 2 条 board + 1 条直连消息，过滤掉唤醒壳、重复派单与空消息
  assert.equal(snap.messages.length, 3);
  assert.equal(snap.messages[0].kind, 'board');
  assert.equal(snap.messages[0].seq, 1);
  assert.equal(snap.messages[0].timestamp, '2026-01-15T06:00:01.000Z');
  assert.equal(snap.messages[1].kind, 'board');
  assert.equal(snap.messages[1].seq, 2);
  assert.equal(snap.messages[1].senderLabel, 'worker-a');
  assert.equal(snap.messages[1].recipientConvId, workerBId);
  assert.equal(snap.messages[2].content, '额外直连消息');

  // 单代理详情中，workerB 的入站 #2 唤醒应自动还原为 worker-a 与真实正文
  const detailB = await readAgentDetail(workerBId);
  assert.equal(detailB.status, 'ready');
  assert.equal(detailB.events.length, 1);
  assert.equal(detailB.events[0].kind, 'incoming_message');
  assert.equal(detailB.events[0].senderId, workerAId);
  assert.equal(detailB.events[0].senderLabel, 'worker-a');
  assert.equal(detailB.events[0].boardSeq, 2);
  assert.equal(detailB.events[0].content, '@worker-b 接口已完成，请验证');
});
