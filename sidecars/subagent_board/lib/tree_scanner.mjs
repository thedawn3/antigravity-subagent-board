/**
 * 通用子代理树扫描、状态判定、模型与上下文聚合、消息板聚合与 Teamwork 工件发现模块。
 *
 * 全部操作均为本地只读：
 * - 读取 <appData>/brain/<id>/.system_generated/{subagents,messages,logs/transcript.jsonl}
 * - 读取 <appData>/scratch/teamwork/<id>/.agents/teamwork/
 * - 辅以带节流缓存的 ConversationService / GetCascadeTrajectoryGeneratorMetadata RPC
 */

import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  cleanActivitySummary,
  deepUnquoteString,
  extractWorkspaceRoots,
  shortenPath,
  stripRedundantCd,
} from './format_helpers.mjs';
import { formatModelLabel, getConversation, getGeneratorMetadata, getModelCatalog, runWithConcurrency } from './ls_client.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_RE = /^[0-9a-f-]{8,}$/i;
const MAX_TREE_DEPTH = 12;
const PARENT_INDEX_TTL_MS = 3000;
const LS_ACTIVE_MIN_INTERVAL_MS = 2500;
const LS_IDLE_MIN_INTERVAL_MS = 12000;
const TRANSCRIPT_FULL_READ_LIMIT = 16 * 1024 * 1024;
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

// 缓存 1：子代理元数据文件解析缓存（key: filePath -> { key: mtime:size, data }）
// 失效条件：文件 mtime/size 变化；容量上限 1024。
const subagentFileCache = new Map();

// 缓存 2：消息文件解析缓存（key: filePath -> { key: mtime:size, data }）
// 失效条件：文件 mtime/size 变化；容量上限 2048。
const messageFileCache = new Map();

// 缓存 3：transcript.jsonl 增量摘要缓存（key: path -> { ino, size, mtime, readOffset, remainder, summary }）
// 仅追加新行时 O(delta) 扫描；若 inode 变更或文件截断/重写则全量重扫；容量上限 512。
const transcriptSummaryCache = new Map();

// 缓存 4：LS 节点详情缓存（key: conversationId -> { transcriptKey, fetchedAt, convMeta, genData, lsError }）
// 失效条件：该节点 transcript mtime/size 变化且距上次拉取 >= 2.5s；已 killed 节点永久命中不再发起 RPC。
const lsNodeCache = new Map();

// 缓存 5：无 LS 时的本地反向父子索引缓存（3 秒 TTL），避免频繁全扫 brain 目录。
let reverseParentCache = { builtAt: 0, childToParent: new Map() };

// 缓存 6：最近一次构建的子代理组上下文（conversationId -> { rootId, workspaceRoots, roleById, updatedAt }）
// 供 readAgentDetail 快速映射成员角色与工作区短路径，容量上限 256。
const groupContextByConv = new Map();

function lruSet(map, key, value, maxEntries) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  if (map.size > maxEntries) {
    map.delete(map.keys().next().value);
  }
}

export function resolveAppDataDirs() {
  const dirs = [];
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') {
        const appData = dirname(d);
        if (existsSync(join(appData, 'brain'))) dirs.push(appData);
        break;
      }
    }
  }
  for (const product of ['antigravity', 'antigravity-ide', 'antigravity-cli']) {
    const p = join(homedir(), '.gemini', product);
    if (existsSync(join(p, 'brain')) && !dirs.includes(p)) {
      dirs.push(p);
    }
  }
  return dirs;
}

export function findConvLocation(convId) {
  if (!convId || !ID_RE.test(convId)) return null;
  for (const appDataDir of resolveAppDataDirs()) {
    const brainDir = join(appDataDir, 'brain');
    const convDir = join(brainDir, convId);
    if (existsSync(convDir)) {
      return { appDataDir, brainDir, convDir };
    }
  }
  return null;
}

function safeReaddir(dirPath) {
  try {
    return readdirSync(dirPath);
  } catch {
    return [];
  }
}

function readJsonCached(cacheMap, filePath, maxEntries) {
  let st;
  try {
    st = statSync(filePath);
  } catch {
    cacheMap.delete(filePath);
    return null;
  }
  const cacheKey = `${st.mtimeMs}:${st.size}`;
  const hit = cacheMap.get(filePath);
  if (hit && hit.key === cacheKey) {
    lruSet(cacheMap, filePath, hit, maxEntries);
    return hit.data;
  }
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    lruSet(cacheMap, filePath, { key: cacheKey, data }, maxEntries);
    return data;
  } catch {
    return null;
  }
}

function getChildToParentIndex() {
  const now = Date.now();
  if (now - reverseParentCache.builtAt < PARENT_INDEX_TTL_MS) {
    return reverseParentCache.childToParent;
  }
  const childToParent = new Map();
  for (const appDataDir of resolveAppDataDirs()) {
    const brainDir = join(appDataDir, 'brain');
    for (const parentId of safeReaddir(brainDir)) {
      if (!ID_RE.test(parentId)) continue;
      const subDir = join(brainDir, parentId, '.system_generated', 'subagents');
      for (const fn of safeReaddir(subDir)) {
        if (!fn.endsWith('.json')) continue;
        const data = readJsonCached(subagentFileCache, join(subDir, fn), 1024);
        const childId = data?.conversationId || fn.replace(/\.json$/, '');
        if (childId && ID_RE.test(childId)) {
          childToParent.set(childId, parentId);
        }
      }
    }
  }
  reverseParentCache = { builtAt: now, childToParent };
  return childToParent;
}

/**
 * 从当前会话向上溯源至整棵树的根会话 ID。
 * 优先使用 ConversationService/GetConversation 的 metadata.rootConversationId；
 * 若 LS 不可用，则通过本地反向父子边向上爬至根（带 visited 防环）。
 */
export async function resolveRootConversation(convId) {
  if (!convId || !ID_RE.test(convId)) return { rootId: convId || '', convResp: null };

  let convResp = null;
  try {
    convResp = await getConversation(convId);
    const rootFromLs = convResp?.metadata?.rootConversationId;
    if (rootFromLs && ID_RE.test(rootFromLs)) {
      return { rootId: rootFromLs, convResp };
    }
  } catch {
    // LS 不可用时走本地反向索引兜底
  }

  const index = getChildToParentIndex();
  let cur = convId;
  const visited = new Set([cur]);
  while (index.has(cur)) {
    const parent = index.get(cur);
    if (!parent || visited.has(parent)) break;
    visited.add(parent);
    cur = parent;
  }
  return { rootId: cur, convResp };
}

const TOOL_ACTION_LABELS = {
  read_file: '读取',
  view_file: '读取',
  write_file: '编辑',
  edit_file: '编辑',
  run_command: '运行',
  search_web: '搜索',
  grep_search: '搜索',
  find_by_name: '搜索',
  invoke_subagent: '派发',
  send_message: '通信',
  manage_subagents: '调度',
  update_steps: '进度',
  update_focus: '状态',
  enter_plan_mode: '规划',
  exit_plan_mode: '规划',
};

/**
 * 将完整模型名精简为适合窄行右侧对齐展示的短标签。
 * 例如："Gemini 4 Hydrogen (High)" -> "Hydrogen · High"
 */
export function formatShortModelLabel(modelLabel) {
  const raw = String(modelLabel || '').trim();
  if (!raw) return '未知';
  let s = raw.replace(/^(?:Gemini|Claude|GPT)\s+\d+(?:\.\d+)?\s+/i, '');
  s = s.replace(/\s*\(([^)]+)\)\s*$/, ' · $1');
  return s || raw;
}

/**
 * 提取单条工具调用的结构化动作标签、目标与中文紧凑活动描述。
 */
export function describeToolCall(toolCall, workspaceRoots = [], roleById = {}) {
  if (!toolCall || typeof toolCall !== 'object') {
    return { actionLabel: '', target: '', brief: '' };
  }
  const name = toolCall.name || '';
  if (!name) return { actionLabel: '', target: '', brief: '' };
  const args = toolCall.args && typeof toolCall.args === 'object' ? toolCall.args : {};

  let target = '';
  const rawPath = deepUnquoteString(args.Path || args.AbsolutePath || args.TargetFile || '').trim();
  if (args.CommandLine) {
    target = stripRedundantCd(args.CommandLine, workspaceRoots).slice(0, 64);
  } else if (rawPath) {
    const short = shortenPath(rawPath, workspaceRoots);
    const startLine = deepUnquoteString(args.StartLine).trim();
    const endLine = deepUnquoteString(args.EndLine).trim();
    if ((name === 'read_file' || name === 'view_file') && startLine) {
      target = endLine ? `${short} (L${startLine}-${endLine})` : `${short} (L${startLine}+)`;
    } else {
      target = short;
    }
  } else if (args.Role) {
    target = deepUnquoteString(args.Role).slice(0, 44);
  } else if (args.query || args.Query) {
    target = deepUnquoteString(args.query || args.Query).slice(0, 48);
  } else if (args.Pattern) {
    target = deepUnquoteString(args.Pattern).slice(0, 48);
  } else if (args.Prompt) {
    target = cleanActivitySummary(args.Prompt, workspaceRoots, roleById, 52);
  } else if (args.Url) {
    target = deepUnquoteString(args.Url).slice(0, 56);
  } else if (args.Recipient) {
    const rid = deepUnquoteString(args.Recipient).trim();
    const rLabel = roleById[rid] || (rid.length > 16 ? rid.slice(0, 8) : rid);
    target = `→ ${rLabel}`;
  }

  const mapped = TOOL_ACTION_LABELS[name];
  if (mapped) {
    if (name === 'invoke_subagent') {
      return {
        actionLabel: mapped,
        target: target || '子代理',
        brief: target ? `派发子代理 ${target}` : '派发子代理',
      };
    }
    if (name === 'send_message') {
      return { actionLabel: mapped, target: target || '发送消息', brief: target ? `发送消息 ${target}` : '发送消息' };
    }
    if (name === 'manage_subagents') {
      return { actionLabel: mapped, target: '管理子代理', brief: '管理子代理' };
    }
    if (name === 'update_steps') {
      return { actionLabel: mapped, target: '更新进度', brief: '更新进度' };
    }
    return {
      actionLabel: mapped,
      target,
      brief: target ? `${mapped} ${target}` : mapped,
    };
  }

  return {
    actionLabel: name,
    target,
    brief: target ? `${name}: ${target}` : name,
  };
}

/**
 * 提取单条工具调用的紧凑活动描述。
 */
export function summarizeToolCallBrief(toolCall, workspaceRoots = [], roleById = {}) {
  return describeToolCall(toolCall, workspaceRoots, roleById).brief;
}

function createEmptySummary() {
  return {
    stepCount: 0,
    generationCount: 0,
    cumulativeOutputTokens: 0,
    lastModel: '',
    lastStepType: '',
    lastStepStatus: '',
    lastCreatedAt: '',
    lastInputTokens: 0,
    lastCacheReadTokens: 0,
    lastOutputTokens: 0,
    lastActionKind: '',
    lastRawToolCall: null,
    lastRawReply: '',
    firstRawUserPrompt: '',
    estimated: false,
  };
}

function applyTranscriptLine(summary, lineText) {
  const trimmed = lineText.trim();
  if (!trimmed) return;
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (!obj || typeof obj !== 'object') return;

  if (typeof obj.step_index === 'number') {
    summary.stepCount = Math.max(summary.stepCount, obj.step_index + 1);
  } else {
    summary.stepCount += 1;
  }
  if (obj.type) summary.lastStepType = obj.type;
  if (obj.status) summary.lastStepStatus = obj.status;
  if (obj.created_at) summary.lastCreatedAt = obj.created_at;

  if (!summary.firstRawUserPrompt && obj.type === 'USER_INPUT' && obj.content) {
    summary.firstRawUserPrompt = String(obj.content).slice(0, 300);
  }

  if (obj.type === 'PLANNER_RESPONSE') {
    summary.generationCount += 1;
    if (obj.model) summary.lastModel = obj.model;
    const inTok = Number(obj.input_tokens || 0);
    const cacheTok = Number(obj.cache_read_tokens || 0);
    const outTok = Number(obj.output_tokens || 0);
    summary.lastInputTokens = inTok;
    summary.lastCacheReadTokens = cacheTok;
    summary.lastOutputTokens = outTok;
    summary.cumulativeOutputTokens += outTok;

    if (Array.isArray(obj.tool_calls) && obj.tool_calls.length) {
      summary.lastActionKind = 'tool';
      summary.lastRawToolCall = obj.tool_calls[obj.tool_calls.length - 1];
    } else if (obj.content) {
      summary.lastActionKind = 'reply';
      summary.lastRawToolCall = null;
      summary.lastRawReply = String(obj.content).slice(0, 500);
    }
  }
}

/**
 * 按字节偏移增量读取 transcript.jsonl 摘要（热路径：未变化零 IO，追加写入 O(delta)）。
 */
function readTranscriptSummaryIncremental(transcriptPath) {
  let st;
  try {
    st = statSync(transcriptPath);
  } catch {
    transcriptSummaryCache.delete(transcriptPath);
    return { summary: null, transcriptKey: 'missing' };
  }

  const transcriptKey = `${st.mtimeMs}:${st.size}:${st.ino}`;
  const hit = transcriptSummaryCache.get(transcriptPath);

  // 完全未变化直接命中缓存（注意 statSync 返回的是 mtimeMs 数值）
  if (hit && hit.ino === st.ino && hit.size === st.size && hit.mtime === st.mtimeMs) {
    lruSet(transcriptSummaryCache, transcriptPath, hit, 512);
    return { summary: hit.summary, transcriptKey };
  }

  // 检查是否可以增量追加读取
  if (hit && hit.ino === st.ino && st.size > hit.size && hit.readOffset <= st.size) {
    let fd = -1;
    try {
      fd = openSync(transcriptPath, 'r');
      const fs = fstatSync(fd);
      const deltaLen = fs.size - hit.readOffset;
      const buf = Buffer.allocUnsafe(deltaLen);
      let readTotal = 0;
      while (readTotal < deltaLen) {
        const n = readSync(fd, buf, readTotal, deltaLen - readTotal, hit.readOffset + readTotal);
        if (n <= 0) break;
        readTotal += n;
      }
      const chunkText = hit.remainder + buf.subarray(0, readTotal).toString('utf-8');
      const lastNl = chunkText.lastIndexOf('\n');
      let completePart = '';
      let nextRemainder = chunkText;
      let nextReadOffset = hit.readOffset;
      if (lastNl >= 0) {
        completePart = chunkText.slice(0, lastNl + 1);
        nextRemainder = chunkText.slice(lastNl + 1);
        nextReadOffset = hit.readOffset + Buffer.byteLength(completePart, 'utf-8') - Buffer.byteLength(hit.remainder, 'utf-8');
      }
      for (const line of completePart.split(/\r?\n/)) {
        applyTranscriptLine(hit.summary, line);
      }
      hit.size = fs.size;
      hit.mtime = fs.mtimeMs;
      hit.readOffset = Math.max(0, nextReadOffset);
      hit.remainder = nextRemainder;
      // 若有未换行的完整 JSON 尾行，只试读不推进 remainder，待换行后再消费
      const viewSummary = { ...hit.summary };
      if (nextRemainder.trim()) {
        applyTranscriptLine(viewSummary, nextRemainder);
      }
      lruSet(transcriptSummaryCache, transcriptPath, hit, 512);
      return { summary: viewSummary, transcriptKey };
    } catch {
      // 增量失败则退化到冷读
    } finally {
      if (fd >= 0) try { closeSync(fd); } catch {}
    }
  }

  // 冷启动或文件重写/截断
  const summary = createEmptySummary();
  let readOffset = 0;
  let remainder = '';
  let fd = -1;
  try {
    fd = openSync(transcriptPath, 'r');
    const fs = fstatSync(fd);
    const startPos = fs.size > TRANSCRIPT_FULL_READ_LIMIT ? Math.max(0, fs.size - TRANSCRIPT_TAIL_BYTES) : 0;
    if (startPos > 0) summary.estimated = true;

    const totalToRead = fs.size - startPos;
    const buf = Buffer.allocUnsafe(totalToRead);
    let readTotal = 0;
    while (readTotal < totalToRead) {
      const n = readSync(fd, buf, readTotal, totalToRead - readTotal, startPos + readTotal);
      if (n <= 0) break;
      readTotal += n;
    }
    let text = buf.subarray(0, readTotal).toString('utf-8');
    let droppedPrefixBytes = 0;
    if (startPos > 0) {
      const firstNl = text.indexOf('\n');
      if (firstNl >= 0) {
        const droppedSlice = text.slice(0, firstNl + 1);
        droppedPrefixBytes = Buffer.byteLength(droppedSlice, 'utf-8');
        text = text.slice(firstNl + 1);
      }
    }
    const lastNl = text.lastIndexOf('\n');
    let completePart = '';
    if (lastNl >= 0) {
      completePart = text.slice(0, lastNl + 1);
      remainder = text.slice(lastNl + 1);
      readOffset = startPos + droppedPrefixBytes + Buffer.byteLength(completePart, 'utf-8');
    } else {
      remainder = text;
      readOffset = startPos + droppedPrefixBytes;
    }
    for (const line of completePart.split(/\r?\n/)) {
      applyTranscriptLine(summary, line);
    }
    const entry = {
      ino: fs.ino,
      size: fs.size,
      mtime: fs.mtimeMs,
      readOffset,
      remainder,
      summary,
    };
    lruSet(transcriptSummaryCache, transcriptPath, entry, 512);
    const viewSummary = { ...summary };
    if (remainder.trim()) {
      applyTranscriptLine(viewSummary, remainder);
    }
    return { summary: viewSummary, transcriptKey };
  } catch {
    return { summary: null, transcriptKey };
  } finally {
    if (fd >= 0) try { closeSync(fd); } catch {}
  }
}

async function fetchLsNodeData(node, preloadedRootConv) {
  const isKilled = node.subagentState === 'SUBAGENT_STATE_KILLED';
  const cached = lsNodeCache.get(node.conversationId);
  const now = Date.now();

  // 已终止节点且已有缓存结果时不再发任何 RPC
  if (isKilled && cached) {
    return cached;
  }

  // transcript 未变时的节流策略：
  // - 闲置节点（非 RUNNING/CANCELLING）12 秒内直接复用缓存
  // - 活跃节点 2.5 秒内复用缓存
  const prevRunState = cached?.convMeta?.state?.runState || '';
  const isPrevActive = prevRunState === 'RUN_STATE_RUNNING' || prevRunState === 'RUN_STATE_CANCELLING';
  const minInterval = isPrevActive ? LS_ACTIVE_MIN_INTERVAL_MS : LS_IDLE_MIN_INTERVAL_MS;
  if (cached && cached.transcriptKey === node.transcriptKey && now - cached.fetchedAt < minInterval) {
    return cached;
  }

  let convMeta = preloadedRootConv && preloadedRootConv.id === node.conversationId ? preloadedRootConv : cached?.convMeta || null;
  let genData = cached?.genData || null;
  let lsError = '';

  // 若 transcript 未变且已有生成元数据，仅刷新 GetConversation 检查运行态，节省约 90% RPC
  const needGenFetch = !cached || cached.transcriptKey !== node.transcriptKey || !cached.genData;

  try {
    const [convResp, genResp] = await Promise.all([
      preloadedRootConv && preloadedRootConv.id === node.conversationId
        ? Promise.resolve(preloadedRootConv)
        : getConversation(node.conversationId),
      needGenFetch ? getGeneratorMetadata(node.conversationId) : Promise.resolve(null),
    ]);
    convMeta = convResp || convMeta;
    if (genResp) {
      const gens = Array.isArray(genResp?.generatorMetadata) ? genResp.generatorMetadata : [];
      const lastGen = gens.length ? gens[gens.length - 1] : null;
      const chatModel = lastGen?.chatModel || null;
      const cwm = chatModel?.chatStartMetadata?.contextWindowMetadata || null;
      const usage = chatModel?.usage || null;
      genData = {
        generationCount: gens.length,
        genModelId: usage?.model || chatModel?.model || '',
        modelDisplayName: chatModel?.modelDisplayName || '',
        maxContextTokens: Number(cwm?.maxContextTokens) || 0,
        breakdownTotal: Number(cwm?.tokenBreakdown?.totalTokens || cwm?.estimatedTokensUsed || 0),
        inputTokens: Number(usage?.inputTokens || 0),
        cacheReadTokens: Number(usage?.cacheReadTokens || 0),
        cacheCreationTokens: Number(usage?.cacheCreationTokens || 0),
        outputTokens: Number(usage?.outputTokens || 0),
        thinkingOutputTokens: Number(usage?.thinkingOutputTokens || 0),
      };
    }
  } catch (err) {
    lsError = err?.message || 'LS 不可用';
  }

  const next = {
    transcriptKey: node.transcriptKey,
    fetchedAt: now,
    convMeta,
    genData,
    lsError,
  };
  lruSet(lsNodeCache, node.conversationId, next, 512);
  return next;
}

function computeStatus(subagentState, runState, lastStepStatus, stepCount) {
  if (subagentState === 'SUBAGENT_STATE_KILLED') return 'killed';
  if (runState === 'RUN_STATE_RUNNING' || lastStepStatus === 'RUNNING') return 'running';
  if (runState === 'RUN_STATE_CANCELLING') return 'cancelling';
  if (lastStepStatus === 'ERROR') return 'error';
  if (subagentState === 'SUBAGENT_STATE_ALIVE' && stepCount > 0) return 'waiting';
  return 'idle';
}

function readSubagentDescriptors(convDir) {
  const subDir = join(convDir, '.system_generated', 'subagents');
  if (!existsSync(subDir)) return [];
  const items = [];
  for (const fn of safeReaddir(subDir)) {
    if (!fn.endsWith('.json')) continue;
    const data = readJsonCached(subagentFileCache, join(subDir, fn), 1024);
    if (!data || typeof data !== 'object') continue;
    const cid = data.conversationId || fn.replace(/\.json$/, '');
    if (!cid || !ID_RE.test(cid)) continue;
    items.push({
      conversationId: cid,
      typeName: data?.subagentDescriptor?.typeName || 'subagent',
      role: data?.subagentDescriptor?.role || cid.slice(0, 8),
      subagentState: data.state || 'SUBAGENT_STATE_ALIVE',
      spawnStepIndex: typeof data.spawnStepIndex === 'number' ? data.spawnStepIndex : null,
      workspaceUris: Array.isArray(data.workspaceUris) ? data.workspaceUris : [],
    });
  }
  items.sort((a, b) => (a.spawnStepIndex ?? 999999) - (b.spawnStepIndex ?? 999999));
  return items;
}

function parseTimeMs(iso) {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * 递归扫描子代理树、聚合上下文/模型/状态、收集代理间消息和 Teamwork 工件。
 */
export async function buildGroupSnapshot(activeConvId) {
  const cleanActive = String(activeConvId || '').trim();
  if (!cleanActive || !ID_RE.test(cleanActive)) {
    return { status: 'no-conversation', activeConversationId: cleanActive };
  }

  const { rootId, convResp: activeConvResp } = await resolveRootConversation(cleanActive);
  if (!rootId || !ID_RE.test(rootId)) {
    return { status: 'no-conversation', activeConversationId: cleanActive };
  }

  const catalog = await getModelCatalog();
  const rootLoc = findConvLocation(rootId);
  if (!rootLoc && !activeConvResp) {
    return { status: 'empty', activeConversationId: cleanActive, rootConversationId: rootId };
  }

  // BFS/DFS 构建扁平节点列表与树边
  const rawNodes = [];
  const visited = new Set();

  function walk(convId, parentId, depth, metaFromParent) {
    if (visited.has(convId) || depth > MAX_TREE_DEPTH) return;
    visited.add(convId);

    const loc = findConvLocation(convId);
    const tpPath = loc ? join(loc.convDir, '.system_generated', 'logs', 'transcript.jsonl') : '';
    const { summary: txSummary, transcriptKey } = tpPath
      ? readTranscriptSummaryIncremental(tpPath)
      : { summary: null, transcriptKey: 'missing' };

    const childrenDescs = loc ? readSubagentDescriptors(loc.convDir) : [];

    const node = {
      conversationId: convId,
      parentId: parentId || null,
      depth,
      isRoot: depth === 0,
      isActiveView: convId === cleanActive,
      typeName: depth === 0 ? 'coordinator' : metaFromParent?.typeName || 'subagent',
      role: depth === 0 ? '主会话 (Root)' : metaFromParent?.role || convId.slice(0, 8),
      subagentState: depth === 0 ? 'SUBAGENT_STATE_ALIVE' : metaFromParent?.subagentState || 'SUBAGENT_STATE_ALIVE',
      spawnStepIndex: metaFromParent?.spawnStepIndex ?? null,
      workspaceUris: metaFromParent?.workspaceUris || [],
      loc,
      txSummary,
      transcriptKey,
      childrenIds: childrenDescs.map((c) => c.conversationId),
    };
    rawNodes.push(node);

    for (const child of childrenDescs) {
      walk(child.conversationId, convId, depth + 1, child);
    }
  }

  walk(rootId, null, 0, null);

  // 并发拉取 LS 实时状态与上下文数据（并发度 4）
  const preloadedRoot = activeConvResp?.id === rootId ? activeConvResp : null;
  const lsResults = await runWithConcurrency(rawNodes, 4, (node) => fetchLsNodeData(node, preloadedRoot));

  let lsError = '';
  const nodesById = {};
  const orderedNodes = [];
  const roleByIdInit = {};
  let maxDepth = 0;

  for (let i = 0; i < rawNodes.length; i += 1) {
    const raw = rawNodes[i];
    const ls = lsResults[i] || {};
    if (ls.lsError && !lsError) lsError = ls.lsError;
    const convMeta = ls.convMeta;

    const rawRole = raw.isRoot
      ? convMeta?.annotations?.title || convMeta?.state?.summary || '主会话 (Root)'
      : raw.role;
    roleByIdInit[raw.conversationId] = rawRole;
  }

  // 先收集全组 workspaceRoots 与完整 roleById，再统一生成清洗后的活动摘要
  const allWorkspaceUris = [];
  for (const raw of rawNodes) {
    for (const u of raw.workspaceUris || []) allWorkspaceUris.push(u);
  }
  const workspaceRoots = extractWorkspaceRoots(allWorkspaceUris);
  const roleById = roleByIdInit;

  for (let i = 0; i < rawNodes.length; i += 1) {
    const raw = rawNodes[i];
    const ls = lsResults[i] || {};
    const convMeta = ls.convMeta;
    const gen = ls.genData;
    const tx = raw.txSummary;

    const rootDisplayTitle =
      raw.isRoot && (convMeta?.annotations?.title || convMeta?.state?.summary)
        ? convMeta?.annotations?.title || convMeta?.state?.summary
        : '';

    const modelId = gen?.genModelId || tx?.lastModel || '';
    const modelLabel = formatModelLabel(gen?.genModelId, gen?.modelDisplayName, tx?.lastModel, catalog);
    const catalogEntry = modelId ? catalog[modelId] || null : null;

    const maxContextTokens = gen?.maxContextTokens || 512000;
    const lsBreakdown = gen?.breakdownTotal || 0;
    const txPromptApprox = (tx?.lastInputTokens || 0) + (tx?.lastCacheReadTokens || 0) + (tx?.lastOutputTokens || 0);
    const lsUsagePrompt = (gen?.inputTokens || 0) + (gen?.cacheReadTokens || 0) + (gen?.cacheCreationTokens || 0);
    const usedTokens = lsBreakdown > 0 ? lsBreakdown : lsUsagePrompt > 0 ? lsUsagePrompt : txPromptApprox;
    const usedPct = maxContextTokens > 0 ? Math.round((usedTokens / maxContextTokens) * 1000) / 10 : 0;

    const inputTok = gen?.inputTokens || tx?.lastInputTokens || 0;
    const cacheReadTok = gen?.cacheReadTokens || tx?.lastCacheReadTokens || 0;
    const cacheCreateTok = gen?.cacheCreationTokens || 0;
    const denom = inputTok + cacheReadTok + cacheCreateTok;
    const cacheHitRate = denom > 0 ? Math.round((cacheReadTok / denom) * 1000) / 10 : null;

    const runState = convMeta?.state?.runState || '';
    const stepCount = tx?.stepCount || 0;
    const status = computeStatus(raw.subagentState, runState, tx?.lastStepStatus || '', stepCount);

    const lastActivityAt = convMeta?.state?.updateTime || tx?.lastCreatedAt || convMeta?.metadata?.createTime || '';
    maxDepth = Math.max(maxDepth, raw.depth);

    const cleanReply = tx?.lastRawReply ? cleanActivitySummary(tx.lastRawReply, workspaceRoots, roleById, 110) : '';
    let currentActivity = '';
    if (tx?.lastActionKind === 'tool' && tx?.lastRawToolCall) {
      currentActivity = summarizeToolCallBrief(tx.lastRawToolCall, workspaceRoots, roleById);
    } else if (cleanReply) {
      currentActivity = cleanReply;
    } else if (raw.isRoot && tx?.firstRawUserPrompt) {
      currentActivity = cleanActivitySummary(tx.firstRawUserPrompt, workspaceRoots, roleById, 110);
    }

    const enriched = {
      conversationId: raw.conversationId,
      parentId: raw.parentId,
      depth: raw.depth,
      isRoot: raw.isRoot,
      isActiveView: raw.isActiveView,
      typeName: raw.typeName,
      role: raw.isRoot ? rootDisplayTitle || '主会话 (Root)' : raw.role,
      title: convMeta?.annotations?.title || convMeta?.state?.summary || '',
      subagentState: raw.subagentState,
      runState,
      status,
      spawnStepIndex: raw.spawnStepIndex,
      childrenIds: raw.childrenIds,
      modelId,
      modelLabel,
      shortModelLabel: formatShortModelLabel(modelLabel),
      remainingQuotaPct:
        catalogEntry?.remainingFraction != null ? Math.round(catalogEntry.remainingFraction * 1000) / 10 : null,
      context: {
        usedTokens,
        maxContextTokens,
        usedPct,
        level: usedPct >= 85 ? 'crit' : usedPct >= 70 ? 'warn' : 'ok',
        cacheHitRate,
        inputTokens: inputTok,
        cacheReadTokens: cacheReadTok,
        lastOutputTokens: gen?.outputTokens || tx?.lastOutputTokens || 0,
        cumulativeOutputTokens: tx?.cumulativeOutputTokens || 0,
        source: lsBreakdown > 0 ? 'ls-breakdown' : lsUsagePrompt > 0 ? 'ls-usage' : txPromptApprox > 0 ? 'transcript' : 'none',
      },
      stepCount,
      generationCount: Math.max(gen?.generationCount || 0, tx?.generationCount || 0),
      currentActivity,
      lastReplySnippet: cleanReply,
      lastActivityAt,
      lastActivityMs: parseTimeMs(lastActivityAt),
      workspaceUris: raw.workspaceUris,
      estimated: Boolean(tx?.estimated),
    };

    nodesById[enriched.conversationId] = enriched;
    orderedNodes.push(enriched);
  }

  // 更新组上下文缓存，供 readAgentDetail 复用
  const groupCtx = { rootId, workspaceRoots, roleById, updatedAt: Date.now() };
  for (const n of orderedNodes) {
    lruSet(groupContextByConv, n.conversationId, groupCtx, 256);
  }

  // 聚合消息流与 Teamwork 文档
  const messages = collectGroupMessages(rawNodes, nodesById);
  const teamwork = discoverTeamworkDocs(rawNodes, messages);

  // 计算全组统计摘要
  let runningCount = 0;
  let waitingCount = 0;
  let killedCount = 0;
  let errorCount = 0;
  let totalPromptTokens = 0;
  let totalCumulativeOutputTokens = 0;
  let cacheRates = [];
  const modelMap = new Map();
  let peakNode = null;

  for (const n of orderedNodes) {
    if (n.status === 'running' || n.status === 'cancelling') runningCount += 1;
    else if (n.status === 'waiting' || n.status === 'idle') waitingCount += 1;
    else if (n.status === 'killed') killedCount += 1;
    else if (n.status === 'error') errorCount += 1;

    totalPromptTokens += n.context.usedTokens || 0;
    totalCumulativeOutputTokens += n.context.cumulativeOutputTokens || 0;
    if (n.context.cacheHitRate != null) cacheRates.push(n.context.cacheHitRate);

    if (!peakNode || n.context.usedPct > peakNode.context.usedPct) {
      peakNode = n;
    }

    const mName = n.modelLabel || '未知模型';
    modelMap.set(mName, (modelMap.get(mName) || 0) + 1);
  }

  const avgCacheHitRate =
    cacheRates.length > 0 ? Math.round((cacheRates.reduce((a, b) => a + b, 0) / cacheRates.length) * 10) / 10 : null;

  const modelDistribution = Array.from(modelMap.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

  // 构建递归嵌套树对象供前端渲染
  function buildTreeNode(id) {
    const n = nodesById[id];
    if (!n) return null;
    return {
      ...n,
      children: (n.childrenIds || []).map(buildTreeNode).filter(Boolean),
    };
  }

  const rootNode = nodesById[rootId];
  return {
    status: 'ready',
    activeConversationId: cleanActive,
    rootConversationId: rootId,
    rootTitle: rootNode?.title || rootNode?.role || rootId.slice(0, 8),
    updatedAt: new Date().toISOString(),
    lsError: lsError || null,
    summary: {
      totalAgents: orderedNodes.length,
      runningCount,
      waitingCount,
      killedCount,
      errorCount,
      maxDepth,
      totalPromptTokens,
      totalCumulativeOutputTokens,
      avgCacheHitRate,
      peakContext: peakNode
        ? {
            conversationId: peakNode.conversationId,
            role: peakNode.role,
            usedPct: peakNode.context.usedPct,
            usedTokens: peakNode.context.usedTokens,
            maxContextTokens: peakNode.context.maxContextTokens,
          }
        : null,
      modelDistribution,
    },
    tree: buildTreeNode(rootId),
    nodes: orderedNodes,
    workspaceRoots,
    roleById,
    messages,
    teamwork,
  };
}

/**
 * 获取指定会话所属组的 roleById 与 workspaceRoots 上下文（优先命中缓存，否则仅本地扫描子树）。
 */
export async function getCachedGroupContext(convId) {
  const hit = groupContextByConv.get(convId);
  if (hit && Date.now() - hit.updatedAt < 15000) {
    return hit;
  }
  const { rootId } = await resolveRootConversation(convId);
  if (!rootId) return { rootId: convId, workspaceRoots: [], roleById: {} };

  const roleById = { [rootId]: '主会话 (Root)' };
  const uris = [];
  const visited = new Set();

  function walkLocal(id, depth) {
    if (visited.has(id) || depth > MAX_TREE_DEPTH) return;
    visited.add(id);
    const loc = findConvLocation(id);
    if (!loc) return;
    for (const child of readSubagentDescriptors(loc.convDir)) {
      roleById[child.conversationId] = child.role;
      for (const u of child.workspaceUris || []) uris.push(u);
      walkLocal(child.conversationId, depth + 1);
    }
  }
  walkLocal(rootId, 0);

  const ctx = { rootId, workspaceRoots: extractWorkspaceRoots(uris), roleById, updatedAt: Date.now() };
  for (const id of visited) {
    lruSet(groupContextByConv, id, ctx, 256);
  }
  return ctx;
}

/**
 * 聚合整棵子代理树内所有节点的 .system_generated/messages/*.json。
 */
function collectGroupMessages(rawNodes, nodesById) {
  const seenIds = new Set();
  const list = [];

  const resolveSender = (rawSender) => {
    const s = String(rawSender || '').trim();
    if (!s) return { convId: '', label: '系统', isCron: false };
    const taskMatch = /^([0-9a-f-]{8,})\/(task-\d+)$/i.exec(s);
    if (taskMatch) {
      const ownerId = taskMatch[1];
      const taskName = taskMatch[2];
      const ownerRole = nodesById[ownerId]?.role || ownerId.slice(0, 8);
      return {
        convId: ownerId,
        label: `定时/后台任务 (${ownerRole} · ${taskName})`,
        isCron: true,
      };
    }
    if (nodesById[s]) {
      return { convId: s, label: nodesById[s].role, isCron: false };
    }
    return { convId: s, label: UUID_RE.test(s) ? s.slice(0, 8) : s, isCron: false };
  };

  for (const node of rawNodes) {
    if (!node.loc) continue;
    const msgDir = join(node.loc.convDir, '.system_generated', 'messages');
    if (!existsSync(msgDir)) continue;
    for (const fn of safeReaddir(msgDir)) {
      if (!fn.endsWith('.json') || fn === 'read.json') continue;
      const msg = readJsonCached(messageFileCache, join(msgDir, fn), 2048);
      if (!msg || typeof msg !== 'object') continue;
      const id = msg.id || `${node.conversationId}:${fn}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      const senderInfo = resolveSender(msg.sender);
      const recipInfo = resolveSender(msg.recipient || node.conversationId);
      const toolName = msg?.sourceMetadata?.tool?.toolCall?.name || '';
      const title = msg?.renderDetails?.messageTitle || '';
      const isCron = senderInfo.isCron || /^cron\b/i.test(title) || /^\[Cron\b/i.test(msg.content || '');
      const kind = isCron ? 'cron' : toolName === 'invoke_subagent' ? 'spawn' : 'message';

      list.push({
        id,
        kind,
        isCron,
        timestamp: msg.timestamp || '',
        timestampMs: parseTimeMs(msg.timestamp),
        sender: msg.sender || '',
        senderConvId: senderInfo.convId,
        senderLabel: senderInfo.label,
        recipient: msg.recipient || node.conversationId,
        recipientConvId: recipInfo.convId,
        recipientLabel: recipInfo.label,
        title,
        priority: msg.priority || '',
        content: String(msg.content || ''),
      });
    }
  }

  list.sort((a, b) => a.timestampMs - b.timestampMs);
  return list;
}

/**
 * 发现当前子代理组关联的 Teamwork 工件目录与文档列表。
 */
function discoverTeamworkDocs(rawNodes, messages) {
  const candidateRoots = new Set();
  const appDataDirs = resolveAppDataDirs();

  for (const appDataDir of appDataDirs) {
    for (const n of rawNodes) {
      const p = join(appDataDir, 'scratch', 'teamwork', n.conversationId, '.agents', 'teamwork');
      if (existsSync(p)) candidateRoots.add(p);
    }
    // 也从消息文本中提取可能引用到的 teamwork 根目录（以防挂载在关联会话 ID 下）
    for (const m of messages) {
      const matches = String(m.content || '').matchAll(/scratch\/teamwork\/([0-9a-f-]{8,})\/\.agents\/teamwork/gi);
      for (const match of matches) {
        const p = join(appDataDir, 'scratch', 'teamwork', match[1], '.agents', 'teamwork');
        if (existsSync(p)) candidateRoots.add(p);
      }
    }
  }

  if (!candidateRoots.size) {
    return { detected: false, rootDirs: [], docs: [] };
  }

  const docs = [];
  const seenPaths = new Set();

  for (const twRoot of candidateRoots) {
    for (const entry of safeReaddir(twRoot)) {
      const full = join(twRoot, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }

      if (st.isFile() && entry.endsWith('.md')) {
        if (!seenPaths.has(full)) {
          seenPaths.add(full);
          docs.push({
            relPath: entry,
            absPath: full,
            fileUri: pathToFileURL(full).href,
            category: 'plan',
            groupName: '顶层蓝图',
            size: st.size,
            updatedAt: new Date(st.mtimeMs).toISOString(),
            updatedMs: st.mtimeMs,
          });
        }
      } else if (st.isDirectory()) {
        for (const subEntry of safeReaddir(full)) {
          if (!subEntry.endsWith('.md')) continue;
          const subFull = join(full, subEntry);
          let subSt;
          try {
            subSt = statSync(subFull);
          } catch {
            continue;
          }
          if (!subSt.isFile() || seenPaths.has(subFull)) continue;
          seenPaths.add(subFull);
          const category =
            subEntry === 'progress.md'
              ? 'progress'
              : subEntry === 'handoff.md'
                ? 'handoff'
                : 'brief';
          docs.push({
            relPath: `${entry}/${subEntry}`,
            absPath: subFull,
            fileUri: pathToFileURL(subFull).href,
            category,
            groupName: entry,
            size: subSt.size,
            updatedAt: new Date(subSt.mtimeMs).toISOString(),
            updatedMs: subSt.mtimeMs,
          });
        }
      }
    }
  }

  docs.sort((a, b) => b.updatedMs - a.updatedMs);
  return {
    detected: docs.length > 0 || candidateRoots.size > 0,
    rootDirs: Array.from(candidateRoots),
    docs,
  };
}
