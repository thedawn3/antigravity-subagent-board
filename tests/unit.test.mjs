/**
 * Subagent Board 核心纯函数离线单元测试（仅使用合成数据，不依赖宿主环境或网络）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
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
import { formatShortModelLabel } from '../sidecars/subagent_board/lib/tree_scanner.mjs';

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
