/**
 * Antigravity 原生 Swarm（.system_generated/swarm/）只读解析与缓存模块。
 *
 * 负责解析：
 * - swarm.json / members.json / plan.json（基于 mtimeMs:size 缓存）
 * - board.jsonl 群聊消息流（基于 mtimeMs:size:ino 缓存原始行并按实时上下文映射）
 * - "Swarm Worker (<name>)" 角色包裹清洗
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ID_RE = /^[0-9a-f-]{8,}$/i;
const SWARM_ROLE_WRAPPER_RE = /^\s*Swarm Worker\s*\((.+)\)\s*$/i;
const LOCAL_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;
const MENTION_TOKEN_RE = /(?:^|[\s(\[「（:：,，、])@(#?[a-z0-9][a-z0-9_-]*)/gi;
const CODE_BLOCK_RE = /```[\s\S]*?```|`[^`\n]*`/g;

// 缓存 1：Swarm 元数据 JSON 解析缓存（key: filePath -> { key: mtimeMs:size, data }），容量上限 512。
const swarmJsonCache = new Map();

// 缓存 2：Swarm 群板 board.jsonl 原始行解析缓存（key: filePath -> { key: mtimeMs:size:ino, entries }），容量上限 256。
const swarmBoardRawCache = new Map();

function lruSet(map, key, value, maxEntries) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  if (map.size > maxEntries) {
    map.delete(map.keys().next().value);
  }
}

/**
 * 测试辅助：清空模块内 Swarm 读取缓存。
 */
export function clearSwarmReaderCaches() {
  swarmJsonCache.clear();
  swarmBoardRawCache.clear();
}

/**
 * 将 "Swarm Worker (foo)" 清洗为干净成员名 "foo"，其余角色文本原样返回。
 */
export function stripSwarmRoleWrapper(role) {
  if (role == null) return '';
  const raw = String(role);
  const m = SWARM_ROLE_WRAPPER_RE.exec(raw);
  if (m && m[1].trim()) {
    return m[1].trim();
  }
  return raw;
}

function readJsonCached(filePath) {
  let st;
  try {
    st = statSync(filePath);
  } catch {
    swarmJsonCache.delete(filePath);
    return null;
  }
  const cacheKey = `${st.mtimeMs}:${st.size}`;
  const hit = swarmJsonCache.get(filePath);
  if (hit && hit.key === cacheKey) {
    lruSet(swarmJsonCache, filePath, hit, 512);
    return hit.data;
  }
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    lruSet(swarmJsonCache, filePath, { key: cacheKey, data }, 512);
    return data;
  } catch {
    return null;
  }
}

function createEmptySwarmMetadata() {
  return {
    detected: false,
    title: '',
    goalTitle: '',
    goalLine: '',
    tasksByMember: {},
    threads: [],
    membersByConvId: new Map(),
    convIdByName: new Map(),
    orderedWorkers: [],
  };
}

/**
 * 只读解析指定会话目录下的 .system_generated/swarm/{swarm.json,members.json,plan.json}。
 */
export function readSwarmMetadata(convDir) {
  if (!convDir) return createEmptySwarmMetadata();
  const swarmDir = join(convDir, '.system_generated', 'swarm');
  if (!existsSync(swarmDir)) return createEmptySwarmMetadata();

  const swarmJson = readJsonCached(join(swarmDir, 'swarm.json'));
  const membersJson = readJsonCached(join(swarmDir, 'members.json'));
  const planJson = readJsonCached(join(swarmDir, 'plan.json'));

  if (!swarmJson && !membersJson && !planJson) {
    return createEmptySwarmMetadata();
  }

  const goalTitle = String(planJson?.goal?.title || '').trim();
  const goalLine = String(planJson?.goal?.line || '').trim();
  const title = String(membersJson?.title || swarmJson?.title || goalTitle || '').trim();
  const tasksByMember =
    planJson?.tasks && typeof planJson.tasks === 'object' && !Array.isArray(planJson.tasks)
      ? { ...planJson.tasks }
      : {};
  const threads = Array.isArray(planJson?.threads) ? planJson.threads : [];

  const membersByConvId = new Map();
  const convIdByName = new Map();
  const orderedWorkers = [];

  const rawMembers =
    membersJson?.members && typeof membersJson.members === 'object' && !Array.isArray(membersJson.members)
      ? membersJson.members
      : {};

  for (const [memberName, info] of Object.entries(rawMembers)) {
    if (!info || typeof info !== 'object') continue;
    const conversationId = String(info.conversation_id || '').trim();
    const role = String(info.role || '').trim();
    const model = String(info.applied_model || info.model || info.desired_model || '').trim();
    const phase = String(info.phase || '').trim();
    const desiredState = String(info.desired_state || '').trim();
    const killed = Boolean(info.killed);
    const workspaceMode = String(info.workspace_mode || '').trim();
    const addedBy = String(info.added_by || '').trim();
    const isCoordinator = memberName === 'coordinator' || role === 'coordinator';

    if (conversationId && ID_RE.test(conversationId)) {
      convIdByName.set(memberName, conversationId);
    }

    const memberRecord = {
      name: memberName,
      conversationId,
      role,
      model,
      phase,
      desiredState,
      killed,
      workspaceMode,
      addedBy,
      task: String(tasksByMember[memberName] || '').trim(),
      isCoordinator,
    };

    if (conversationId && ID_RE.test(conversationId)) {
      membersByConvId.set(conversationId, memberRecord);
    }
    if (!isCoordinator) {
      orderedWorkers.push(memberRecord);
    }
  }

  return {
    detected: true,
    title,
    goalTitle,
    goalLine,
    tasksByMember,
    threads,
    membersByConvId,
    convIdByName,
    orderedWorkers,
  };
}

/**
 * 解析 board.jsonl 时间字段（兼容本地 "YYYY-MM-DD HH:MM:SS" 与标准 ISO 字符串）。
 */
function parseBoardTimestamp(rawTime) {
  const s = String(rawTime || '').trim();
  if (!s) return { timestamp: '', timestampMs: 0 };

  const localMatch = LOCAL_DATETIME_RE.exec(s);
  if (localMatch) {
    const year = Number(localMatch[1]);
    const month = Number(localMatch[2]) - 1;
    const day = Number(localMatch[3]);
    const hour = Number(localMatch[4]);
    const minute = Number(localMatch[5]);
    const second = Number(localMatch[6]);
    const msPart = localMatch[7] ? Number(localMatch[7].slice(0, 3).padEnd(3, '0')) : 0;
    const dt = new Date(year, month, day, hour, minute, second, msPart);
    const ms = dt.getTime();
    if (Number.isFinite(ms)) {
      return { timestamp: dt.toISOString(), timestampMs: ms };
    }
  }

  const parsedMs = Date.parse(s);
  if (Number.isFinite(parsedMs)) {
    return { timestamp: new Date(parsedMs).toISOString(), timestampMs: parsedMs };
  }
  return { timestamp: '', timestampMs: 0 };
}

function readBoardRawEntriesCached(boardPath) {
  let st;
  try {
    st = statSync(boardPath);
  } catch {
    swarmBoardRawCache.delete(boardPath);
    return [];
  }

  const cacheKey = `${st.mtimeMs}:${st.size}:${st.ino}`;
  const hit = swarmBoardRawCache.get(boardPath);
  if (hit && hit.key === cacheKey) {
    lruSet(swarmBoardRawCache, boardPath, hit, 256);
    return hit.entries;
  }

  let text = '';
  try {
    text = readFileSync(boardPath, 'utf-8');
  } catch {
    return [];
  }

  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object') {
        entries.push(obj);
      }
    } catch {
      // 忽略正在写入的半行
    }
  }

  lruSet(swarmBoardRawCache, boardPath, { key: cacheKey, entries }, 256);
  return entries;
}

function lookupConvId(convIdByName, name) {
  if (!convIdByName || !name) return '';
  if (convIdByName instanceof Map) {
    return convIdByName.get(name) || '';
  }
  return convIdByName[name] || '';
}

function buildNameLookup(convIdByName) {
  const byLower = new Map();
  if (!convIdByName) return byLower;
  const entries = convIdByName instanceof Map ? convIdByName.entries() : Object.entries(convIdByName);
  for (const [name, cid] of entries) {
    if (!name) continue;
    byLower.set(String(name).toLowerCase(), { name: String(name), convId: String(cid || '') });
  }
  return byLower;
}

function extractBoardRecipient(text, nameLookup, rootConvId, rootLabel) {
  // 剔除 Markdown 代码块与行内反引号，避免把示例中的 `@member` 误判为收件人
  const cleanForMentions = String(text || '').replace(CODE_BLOCK_RE, ' ');
  let hasAll = false;
  const channels = [];
  const seenChannels = new Set();
  const matchedMembers = [];
  const seenMembers = new Set();

  for (const match of cleanForMentions.matchAll(MENTION_TOKEN_RE)) {
    const token = String(match[1] || '').trim();
    if (!token) continue;
    const lower = token.toLowerCase();
    if (lower === 'all') {
      hasAll = true;
      continue;
    }
    if (token.startsWith('#')) {
      if (!seenChannels.has(lower)) {
        seenChannels.add(lower);
        channels.push(token);
      }
      continue;
    }
    if (lower === 'coordinator') {
      if (!seenMembers.has('coordinator')) {
        seenMembers.add('coordinator');
        matchedMembers.push({
          name: 'coordinator',
          convId: rootConvId || nameLookup.get('coordinator')?.convId || '',
          label: rootLabel || 'coordinator',
        });
      }
      continue;
    }
    const known = nameLookup.get(lower);
    if (known && !seenMembers.has(lower)) {
      seenMembers.add(lower);
      matchedMembers.push({
        name: known.name,
        convId: known.convId,
        label: stripSwarmRoleWrapper(known.name) || known.name,
      });
    }
  }

  if (hasAll) {
    return { recipientConvId: '', recipientLabel: '全体 (@all)' };
  }
  if (matchedMembers.length === 1) {
    return {
      recipientConvId: matchedMembers[0].convId || '',
      recipientLabel: matchedMembers[0].label,
    };
  }
  if (matchedMembers.length > 1) {
    return {
      recipientConvId: '',
      recipientLabel: matchedMembers.map((m) => `@${m.name}`).join(', '),
    };
  }
  if (channels.length > 0) {
    return {
      recipientConvId: '',
      recipientLabel: channels.map((c) => `@${c}`).join(', '),
    };
  }
  return { recipientConvId: '', recipientLabel: '全体 (群板)' };
}

/**
 * 读取 .system_generated/swarm/board.jsonl，解析并补全时间戳、发送者与 @mention 接收方。
 */
export function readSwarmBoard(
  convDir,
  { convIdByName = new Map(), rootConvId = '', rootLabel = '主会话 (Root)', nudgeTimestampsBySeq = null } = {},
) {
  if (!convDir) return { messages: [], bySeq: new Map() };
  const boardPath = join(convDir, '.system_generated', 'swarm', 'board.jsonl');
  const rawEntries = readBoardRawEntriesCached(boardPath);
  if (!rawEntries.length) {
    return { messages: [], bySeq: new Map() };
  }

  const nameLookup = buildNameLookup(convIdByName);
  const messages = [];
  const bySeq = new Map();

  for (let i = 0; i < rawEntries.length; i += 1) {
    const entry = rawEntries[i];
    const seq = typeof entry.seq === 'number' ? entry.seq : Number(entry.seq) || i + 1;
    const rawAgent = String(entry.agent || '').trim();
    const content = String(entry.text || '');

    let { timestamp, timestampMs } = parseBoardTimestamp(entry.time);
    if (!timestampMs && nudgeTimestampsBySeq instanceof Map && nudgeTimestampsBySeq.has(seq)) {
      const fallback = parseBoardTimestamp(nudgeTimestampsBySeq.get(seq));
      if (fallback.timestampMs) {
        timestamp = fallback.timestamp;
        timestampMs = fallback.timestampMs;
      }
    }

    let senderConvId = '';
    let senderLabel = '系统';
    if (rawAgent === 'coordinator') {
      senderConvId = rootConvId || lookupConvId(convIdByName, 'coordinator') || '';
      senderLabel = rootLabel || 'coordinator';
    } else if (rawAgent) {
      const known = nameLookup.get(rawAgent.toLowerCase());
      senderConvId = known?.convId || lookupConvId(convIdByName, rawAgent) || '';
      senderLabel = stripSwarmRoleWrapper(known?.name || rawAgent) || rawAgent;
    }

    const { recipientConvId, recipientLabel } = extractBoardRecipient(content, nameLookup, rootConvId, rootLabel);

    const record = {
      id: `board-${seq}`,
      kind: 'board',
      isCron: false,
      seq,
      boardKind: String(entry.kind || ''),
      timestamp,
      timestampMs,
      sender: rawAgent,
      senderConvId,
      senderLabel,
      recipient: recipientConvId || recipientLabel,
      recipientConvId,
      recipientLabel,
      title: entry.kind === 'brief' ? 'Swarm 派单' : '',
      priority: '',
      content,
    };

    messages.push(record);
    bySeq.set(seq, record);
  }

  return { messages, bySeq };
}
