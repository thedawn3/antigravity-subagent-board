/**
 * Subagent Board Sidecar 服务入口。
 *
 * 提供：
 * - GET /                静态页面
 * - GET /api/group       整棵子代理树、模型/上下文汇总、代理间消息流、Teamwork 工件索引
 * - GET /api/agent       单代理上下文分层拆解与完整对话流
 * - GET /api/teamwork-doc 严格受限的 Teamwork 工件只读预览
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import { buildGroupSnapshot, resolveAppDataDirs } from './lib/tree_scanner.mjs';
import { readAgentDetail } from './lib/transcript_reader.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_DOC_BYTES = 256 * 1024;
const UUID_OR_ID_RE = /^[0-9a-f-]{8,}$/i;

const STATIC = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

/**
 * 校验待读取文档路径必须严格位于 <appDataDir>/scratch/teamwork/ 下且为常规文件。
 */
export function readTeamworkDocSafe(targetPath) {
  const rawPath = String(targetPath || '').trim();
  if (!rawPath || rawPath.includes('\0')) {
    return { ok: false, status: 400, error: '非法文件路径' };
  }

  let realTarget;
  try {
    realTarget = realpathSync(rawPath);
  } catch {
    return { ok: false, status: 404, error: '文件不存在' };
  }

  const allowedRoots = [];
  for (const appDataDir of resolveAppDataDirs()) {
    const twRoot = join(appDataDir, 'scratch', 'teamwork');
    if (existsSync(twRoot)) {
      try {
        allowedRoots.push(realpathSync(twRoot));
      } catch {
        // 忽略无法解析的根目录
      }
    }
  }

  const isInsideAllowed = allowedRoots.some(
    (root) => realTarget === root || realTarget.startsWith(root.endsWith(sep) ? root : `${root}${sep}`),
  );
  if (!isInsideAllowed) {
    return { ok: false, status: 403, error: '仅允许读取 scratch/teamwork 目录下的工件文档' };
  }

  let st;
  try {
    st = statSync(realTarget);
  } catch {
    return { ok: false, status: 404, error: '无法读取文件属性' };
  }
  if (!st.isFile()) {
    return { ok: false, status: 400, error: '目标不是常规文件' };
  }

  let content = readFileSync(realTarget, 'utf-8');
  let truncated = false;
  if (st.size > MAX_DOC_BYTES) {
    content = `${content.slice(0, MAX_DOC_BYTES)}\n\n...（文件超过 256 KB，预览已截断，请点击“在侧栏打开文件”查看完整内容）`;
    truncated = true;
  }

  return {
    ok: true,
    path: realTarget,
    fileUri: pathToFileURL(realTarget).href,
    size: st.size,
    updatedAt: new Date(st.mtimeMs).toISOString(),
    truncated,
    content,
  };
}

const app = new SidecarApp();

app.page(
  '/',
  () => new Response(readFileSync(join(HERE, 'index.html'), 'utf-8'), { contentType: 'text/html; charset=utf-8' }),
);

for (const [route, [file, contentType]] of Object.entries(STATIC)) {
  app.api(route, () => new Response(readFileSync(join(HERE, file), 'utf-8'), { contentType }), 'GET');
}

app.api(
  '/api/group',
  async (data) => {
    const conv = String(data?.conversationId || app.config?.conversationId || '').trim();
    if (!conv || !UUID_OR_ID_RE.test(conv)) {
      return { status: 'no-conversation', activeConversationId: conv };
    }
    try {
      return await buildGroupSnapshot(conv);
    } catch (err) {
      return {
        status: 'error',
        activeConversationId: conv,
        error: err?.message || '扫描子代理组失败',
      };
    }
  },
  'GET',
);

app.api(
  '/api/agent',
  async (data) => {
    const conv = String(data?.conversationId || app.config?.conversationId || '').trim();
    if (!conv || !UUID_OR_ID_RE.test(conv)) {
      return { status: 'no-conversation', conversationId: conv };
    }
    try {
      const limit = Number(data?.limit || 150);
      const beforeStep = data?.beforeStep != null && data.beforeStep !== '' ? Number(data.beforeStep) : null;
      return await readAgentDetail(conv, { limit, beforeStep });
    } catch (err) {
      return {
        status: 'error',
        conversationId: conv,
        error: err?.message || '读取子代理详情失败',
      };
    }
  },
  'GET',
);

app.api(
  '/api/teamwork-doc',
  (data) => {
    const res = readTeamworkDocSafe(data?.path || '');
    if (!res.ok) {
      return new Response(JSON.stringify({ error: res.error }), {
        status: res.status,
        contentType: 'application/json; charset=utf-8',
      });
    }
    return res;
  },
  'GET',
);

// 仅在由 sidecar_sdk 宿主启动或直接作为主模块运行时启动监听，使用 realpathSync 兼容软链接安装方式
let isMain = false;
if (process.argv[1]) {
  try {
    isMain = realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    isMain = fileURLToPath(import.meta.url) === process.argv[1];
  }
}
if (isMain) {
  app.run();
}
