/**
 * 公共路径缩短、转义还原、工具输出清洗与系统消息拆包工具模块。
 *
 * 供 tree_scanner.mjs 与 transcript_reader.mjs 复用，避免原始绝对路径、
 * 双重序列化 JSON 与重复时间戳噪音直接暴露到前端阅读界面。
 */

import { basename } from 'node:path';

const TEAMWORK_RE = /(?:^|.*\/)scratch\/teamwork\/[0-9a-f-]{8,}\/\.agents\/teamwork\/(.*)$/i;
const UPLOADED_RE = /(?:^|.*\/)\.gemini\/antigravity\/brain\/[0-9a-f-]{8,}\/\.user_uploaded\/(.*)$/i;
const BRAIN_RE = /(?:^|.*\/)\.gemini\/antigravity\/brain\/[0-9a-f-]{8,}\/(.*)$/i;
const HOME_USER_RE = /^(?:\/Users|\/home|[A-Za-z]:\/Users)\/[^/]+\/(.*)$/i;
const ABS_PATH_IN_TEXT_RE = /(?<![A-Za-z0-9_:/.-])((?:\/(?:Users|home|var|tmp|opt|etc|Volumes)\/|[A-Za-z]:[\\/]Users[\\/])[^\s`"'<>()[\]]+)/g;
const UUID_IN_TEXT_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;

/**
 * 去除字符串中最多两层 JSON 字符串引号转义，还原真实多行正文。
 */
export function deepUnquoteString(val) {
  if (val == null) return '';
  let cur = String(val);
  for (let i = 0; i < 2; i += 1) {
    const trimmed = cur.trim();
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'string') {
          cur = parsed;
          continue;
        }
      } catch {
        // 解析失败说明并非合法 JSON 包裹，保留原文退出
      }
    }
    break;
  }
  return cur;
}

/**
 * 从 workspaceUris 中解码出去重且按长度降序排列的工作区根目录列表。
 */
export function extractWorkspaceRoots(workspaceUris) {
  const roots = new Set();
  for (const raw of workspaceUris || []) {
    let p = String(raw || '').trim();
    if (!p) continue;
    if (p.startsWith('file://')) {
      try {
        p = decodeURIComponent(p.slice(7));
      } catch {
        p = p.slice(7);
      }
    }
    p = p.replace(/\\/g, '/').replace(/^\/([A-Za-z]:\/)/, '$1').replace(/\/+$/, '');
    if (p) roots.add(p);
  }
  return Array.from(roots).sort((a, b) => b.length - a.length);
}

/**
 * 将冗长绝对路径折叠为直观短路径（原路径保留用于 tooltip 与 file:// 打开）。
 */
export function shortenPath(rawPath, workspaceRoots = []) {
  const input = String(rawPath || '').trim();
  if (!input) return '';

  // 拆分尾部行号/锚点后缀（例如 :43-52 或 #L10-L20）
  let pathPart = input;
  let suffix = '';
  const suffixMatch = /^(.*?)(#L\d+(?:-L?\d+)?|:\d+(?:-\d+)?)$/i.exec(input);
  if (suffixMatch) {
    pathPart = suffixMatch[1];
    suffix = suffixMatch[2];
  }

  const normalized = pathPart.replace(/\\/g, '/').replace(/\/+$/, '') || pathPart;

  const twMatch = TEAMWORK_RE.exec(normalized);
  if (twMatch) {
    const rel = twMatch[1] || '';
    return (rel ? `teamwork/${rel}` : 'teamwork') + suffix;
  }

  const upMatch = UPLOADED_RE.exec(normalized);
  if (upMatch) {
    return `附件/${upMatch[1]}` + suffix;
  }

  const brMatch = BRAIN_RE.exec(normalized);
  if (brMatch) {
    return `brain/${brMatch[1]}` + suffix;
  }

  for (const root of workspaceRoots) {
    const cleanRoot = String(root || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!cleanRoot) continue;
    if (normalized === cleanRoot) {
      return (basename(cleanRoot) || cleanRoot) + suffix;
    }
    if (normalized.startsWith(`${cleanRoot}/`)) {
      return normalized.slice(cleanRoot.length + 1) + suffix;
    }
  }

  const homeMatch = HOME_USER_RE.exec(normalized);
  if (homeMatch) {
    const rest = homeMatch[1];
    const segs = rest.split('/').filter(Boolean);
    if (segs.length > 4) {
      return `~/.../${segs.slice(-2).join('/')}` + suffix;
    }
    return `~/${rest}` + suffix;
  }

  return pathPart + suffix;
}

/**
 * 将文本中的 Unix/Windows 绝对路径替换为短路径，保留前后标点（保护 Go 通配符 /...）。
 */
export function replacePathsInText(text, workspaceRoots = []) {
  const raw = String(text || '');
  if (!raw) return '';
  return raw.replace(ABS_PATH_IN_TEXT_RE, (full) => {
    if (/\/\.\.\.$/.test(full)) {
      const base = full.slice(0, -4);
      const shortBase = shortenPath(base, workspaceRoots).replace(/\/+$/, '');
      return `${shortBase}/...`;
    }
    const trailMatch = /^(.*?)([.,;:!?'"`）)】》]+)$/.exec(full);
    if (trailMatch) {
      const cleanPath = trailMatch[1];
      const trail = trailMatch[2];
      // 保留路径末尾冒号+行号（如 :43-52），只剥离纯标点
      if (/^:\d+(?:-\d+)?$/.test(trail)) {
        return shortenPath(full, workspaceRoots);
      }
      return shortenPath(cleanPath, workspaceRoots) + trail;
    }
    return shortenPath(full, workspaceRoots);
  });
}

/**
 * 去除命令前导的 `cd <workspace> &&` 冗余前缀，并缩短命令中的已知绝对路径。
 */
export function stripRedundantCd(cmd, workspaceRoots = []) {
  let s = deepUnquoteString(cmd).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  s = s.replace(/^cd\s+(?:"[^"]+"|'[^']+'|\S+)\s*(?:&&|;)\s*/i, '');
  s = replacePathsInText(s, workspaceRoots);
  return s;
}

/**
 * 清洗单行活动摘要：先还原/去噪/缩短路径/替换 UUID，最后再截断，避免半截路径。
 */
export function cleanActivitySummary(rawText, workspaceRoots = [], roleById = {}, maxLen = 110) {
  let s = deepUnquoteString(rawText);
  if (!s) return '';
  // Markdown 链接 [label](url) -> label
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // 去掉粗体、行内反引号、标题井号与列表前导符
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/(^|\n)\s{0,3}#{1,6}\s+/g, '$1');
  s = s.replace(/(^|\n)\s*[-*]\s+/g, '$1');

  s = replacePathsInText(s, workspaceRoots);
  s = s.replace(UUID_IN_TEXT_RE, (id) => roleById[id] || `${id.slice(0, 8)}`);
  s = s.replace(/\s+/g, ' ').trim();

  if (s.length > maxLen) {
    return `${s.slice(0, maxLen - 1)}…`;
  }
  return s;
}

function parseIsoMs(str) {
  const ms = Date.parse(str);
  return Number.isFinite(ms) ? ms : 0;
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 清洗 GENERIC 工具输出文本：
 * - 剔除头部重复的 Created At / Completed At 行并计算耗时
 * - 识别纯确认类输出并返回紧凑 shortStatus
 */
export function cleanToolOutputText(rawText, roleById = {}, maxChars = 3600) {
  const input = String(rawText || '');
  if (!input.trim()) {
    return { text: '', shortStatus: '', durationText: '', totalChars: 0, truncated: false };
  }

  let firstStartMs = 0;
  let lastEndMs = 0;
  const keptLines = [];

  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    const createdMatch = /^Created At:\s*(.+)$/i.exec(trimmed);
    if (createdMatch) {
      const t = parseIsoMs(createdMatch[1]);
      if (t && (!firstStartMs || t < firstStartMs)) firstStartMs = t;
      continue;
    }
    const completedMatch = /^Completed At:\s*(.+)$/i.exec(trimmed);
    if (completedMatch) {
      const t = parseIsoMs(completedMatch[1]);
      if (t && t > lastEndMs) lastEndMs = t;
      continue;
    }
    keptLines.push(line);
  }

  const durationText = firstStartMs && lastEndMs && lastEndMs >= firstStartMs ? formatDurationMs(lastEndMs - firstStartMs) : '';

  // 合并去掉外围空白
  const cleaned = keptLines
    .join('\n')
    .replace(/^(?:\s*\n)+|(?:\s*\n)+$/g, '')
    .trim();

  if (!cleaned) {
    return { text: '', shortStatus: '', durationText, totalChars: 0, truncated: false };
  }

  // 检查是否属于纯确认型短输出（支持单次或多次 --- 分隔合并）
  const nonSepLines = cleaned
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && l !== '---');

  if (nonSepLines.length > 0 && nonSepLines.every((l) => /^Created file\.$/i.test(l))) {
    return {
      text: '',
      shortStatus: nonSepLines.length > 1 ? `已写入 ${nonSepLines.length} 个文件` : '已写入文件',
      durationText,
      totalChars: 0,
      truncated: false,
    };
  }
  if (nonSepLines.length > 0 && nonSepLines.every((l) => /^Made \d+ replacement/i.test(l))) {
    return { text: '', shortStatus: '已修改文件', durationText, totalChars: 0, truncated: false };
  }
  if (nonSepLines.length === 1) {
    const msgSent = /^Message sent to "([^"]+)"\.?$/i.exec(nonSepLines[0]);
    if (msgSent) {
      const targetId = msgSent[1];
      const targetLabel = roleById[targetId] || targetId.slice(0, 8);
      return { text: '', shortStatus: `已发送给 ${targetLabel}`, durationText, totalChars: 0, truncated: false };
    }
    if (/^OK\.?$/i.test(nonSepLines[0])) {
      return { text: '', shortStatus: '已更新', durationText, totalChars: 0, truncated: false };
    }
  }

  const truncated = cleaned.length > maxChars;
  return {
    text: truncated ? cleaned.slice(0, maxChars) : cleaned,
    shortStatus: '',
    durationText,
    totalChars: cleaned.length,
    truncated,
  };
}

/**
 * 解析 SYSTEM_MESSAGE 包装内容：
 * - 命中 [Message] timestamp=... sender=... priority=... content=... 则拆解为结构化消息数组
 * - 否则剥离外层系统样板提示与 XML 标签，返回干净的文本
 */
export function parseSystemMessageEnvelope(rawContent) {
  const raw = String(rawContent || '');
  const stripped = raw
    .replace(/^The following is a <SYSTEM_MESSAGE>[\s\S]*?\n<SYSTEM_MESSAGE>\s*\n?/i, '')
    .replace(/\n?<\/SYSTEM_MESSAGE>\s*$/i, '')
    .trim();

  const headerRe = /\[Message\]\s+timestamp=([^\s]+)\s+sender=([^\s]+)\s+priority=([^\s]+)\s+content=/g;
  const matches = Array.from(stripped.matchAll(headerRe));
  if (!matches.length) {
    return { isAgentMessage: false, messages: [], content: stripped };
  }

  const messages = [];
  for (let i = 0; i < matches.length; i += 1) {
    const m = matches[i];
    const bodyStart = m.index + m[0].length;
    const bodyEnd = i + 1 < matches.length ? matches[i + 1].index : stripped.length;
    const body = stripped.slice(bodyStart, bodyEnd).trim();
    messages.push({
      timestamp: m[1] || '',
      sender: m[2] || '',
      priority: m[3] || '',
      content: body,
    });
  }

  return { isAgentMessage: true, messages, content: stripped };
}
