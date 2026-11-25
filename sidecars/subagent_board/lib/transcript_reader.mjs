/**
 * 单代理详情读取模块：按需解析指定会话（主会话或任意子代理）的完整对话轨迹
 * 与 LS 上下文分层拆解（System / Rules / Skills / MCP / Chat + Top 重度步骤）。
 *
 * 相比初版，已集成：
 * - SYSTEM_MESSAGE 中的 [Message] 拆包为独立 incoming_message 事件
 * - tool_calls 双重转义还原与语义化预览（markdown / command / code / none / kv）
 * - GENERIC 输出剔除重复时间戳并将纯确认语句收敛为 shortStatus
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  cleanToolOutputText,
  deepUnquoteString,
  parseSystemMessageEnvelope,
  shortenPath,
  stripRedundantCd,
} from './format_helpers.mjs';
import { formatModelLabel, getConversation, getGeneratorMetadata, getModelCatalog, getTrajectory } from './ls_client.mjs';
import { describeToolCall, findConvLocation, getCachedGroupContext } from './tree_scanner.mjs';

const GROUP_LABELS_ZH = {
  TOKEN_TYPE_SYSTEM_PROMPT: '系统提示词',
  TOKEN_TYPE_RULES: '用户/项目规则 (Rules)',
  TOKEN_TYPE_TOOLS: '内置工具定义',
  TOKEN_TYPE_SKILLS: '技能清单 (Skills)',
  TOKEN_TYPE_SUBAGENTS: '子智能体定义',
  TOKEN_TYPE_PLUGINS: '推荐插件目录',
  TOKEN_TYPE_MCP_TOOLS: 'MCP 工具清单',
  TOKEN_TYPE_WORKFLOWS: '旧版工作流',
  TOKEN_TYPE_FLOWS: '工作流',
  TOKEN_TYPE_CHAT_MESSAGES: '对话与工具历史',
};

const MAX_TOOL_OUTPUT_PREVIEW = 3600;
const MAX_CODE_PREVIEW = 4000;

function toFileUriSafe(rawPath, lineSuffix = '') {
  const clean = String(rawPath || '').trim();
  if (!clean.startsWith('/')) return '';
  try {
    return `${pathToFileURL(clean).href}${lineSuffix}`;
  } catch {
    return '';
  }
}

function buildToolCallSemantic(tc, workspaceRoots, roleById) {
  const name = tc?.name || 'tool';
  const args = tc?.args && typeof tc.args === 'object' ? tc.args : {};
  const desc = describeToolCall(tc, workspaceRoots, roleById);

  const getStr = (k) => deepUnquoteString(args[k]);

  let fileUri = '';
  let previewKind = 'kv';
  let previewText = '';
  let target = desc.target || '';

  if (name === 'send_message') {
    const rid = getStr('Recipient').trim();
    const rLabel = roleById[rid] || (rid.length > 16 ? rid.slice(0, 8) : rid);
    target = rLabel ? `→ ${rLabel}` : '发送消息';
    previewKind = 'markdown';
    previewText = getStr('Message');
  } else if (name === 'invoke_subagent') {
    const role = getStr('Role').trim();
    const typeName = getStr('TypeName').trim();
    target = role && typeName ? `${role} (${typeName})` : role || typeName || '子代理';
    previewKind = 'markdown';
    previewText = getStr('Prompt');
  } else if (name === 'read_file' || name === 'view_file') {
    const p = getStr('Path') || getStr('AbsolutePath') || getStr('TargetFile');
    const sLine = getStr('StartLine').trim();
    const eLine = getStr('EndLine').trim();
    const anchor = sLine ? (eLine ? `#L${sLine}-L${eLine}` : `#L${sLine}`) : '';
    fileUri = toFileUriSafe(p, anchor);
    previewKind = 'none';
    previewText = '';
  } else if (name === 'write_file') {
    const p = getStr('Path') || getStr('AbsolutePath') || getStr('TargetFile');
    fileUri = toFileUriSafe(p);
    const content = getStr('Content');
    previewKind = /\.md$/i.test(p) ? 'markdown' : 'code';
    previewText =
      content.length > MAX_CODE_PREVIEW
        ? `${content.slice(0, MAX_CODE_PREVIEW)}\n\n...（共 ${content.length} 字符，已截断）`
        : content;
  } else if (name === 'edit_file') {
    const p = getStr('Path') || getStr('AbsolutePath') || getStr('TargetFile');
    fileUri = toFileUriSafe(p);
    const tStr = getStr('Target');
    const rStr = getStr('Replacement');
    previewKind = 'code';
    const blocks = [];
    if (tStr) blocks.push(`// --- 修改前 ---\n${tStr.slice(0, 1500)}`);
    if (rStr) blocks.push(`// +++ 修改后 +++\n${rStr.slice(0, 1500)}`);
    previewText = blocks.join('\n\n');
  } else if (name === 'run_command') {
    const fullCmd = stripRedundantCd(getStr('CommandLine'), workspaceRoots);
    previewKind = fullCmd ? 'command' : 'none';
    previewText = fullCmd;
  } else {
    // 其余工具输出干净键值对而非原始 JSON 转义块
    const lines = [];
    for (const [k, v] of Object.entries(args)) {
      const cleanVal = deepUnquoteString(v).trim();
      if (!cleanVal) continue;
      const shown = cleanVal.length > 600 ? `${cleanVal.slice(0, 600)}…` : cleanVal;
      lines.push(`${k}: ${shown}`);
    }
    if (lines.length) {
      previewKind = 'kv';
      previewText = lines.join('\n');
    } else {
      previewKind = 'none';
    }
  }

  return {
    name,
    actionLabel: desc.actionLabel || name,
    target,
    brief: desc.brief,
    fileUri,
    previewKind,
    previewText,
  };
}

function summarizeTrajectoryStep(step, workspaceRoots = []) {
  const tc = step?.metadata?.toolCall;
  if (!tc?.name) {
    const rawType = String(step?.type || '').replace(/^CORTEX_STEP_TYPE_/, '');
    return { toolName: rawType.toLowerCase() || 'step', summary: '' };
  }
  const toolName = tc.name;
  let args = {};
  try {
    args = tc.argumentsJson ? JSON.parse(tc.argumentsJson) : {};
  } catch {
    args = {};
  }
  let summary = '';
  if (args.CommandLine) summary = stripRedundantCd(args.CommandLine, workspaceRoots).slice(0, 72);
  else if (args.Path || args.AbsolutePath || args.TargetFile) {
    summary = shortenPath(String(args.Path || args.AbsolutePath || args.TargetFile), workspaceRoots);
  } else if (args.Role) summary = String(args.Role).slice(0, 48);
  else if (args.query) summary = String(args.query).slice(0, 60);
  else if (args.Prompt) summary = String(args.Prompt).replace(/\s+/g, ' ').slice(0, 60);
  else if (args.Url) summary = String(args.Url).slice(0, 60);
  return { toolName, summary };
}

function resolveIncomingSender(rawSender, roleById) {
  const s = String(rawSender || '').trim();
  if (!s) return { senderId: '', senderLabel: '系统', isCron: false };
  const taskMatch = /^([0-9a-f-]{8,})\/(task-\d+)$/i.exec(s);
  if (taskMatch) {
    const ownerId = taskMatch[1];
    const ownerRole = roleById[ownerId] || ownerId.slice(0, 8);
    return {
      senderId: ownerId,
      senderLabel: `定时任务 (${ownerRole} · ${taskMatch[2]})`,
      isCron: true,
    };
  }
  return {
    senderId: s,
    senderLabel: roleById[s] || (s.length > 16 ? s.slice(0, 8) : s),
    isCron: false,
  };
}

function parseTranscriptEvents(transcriptPath, { limit = 150, beforeStep = null, workspaceRoots = [], roleById = {} } = {}) {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return { events: [], totalEvents: 0, hasMore: false, oldestStepIndex: null, lastPlanner: null };
  }

  const rawText = readFileSync(transcriptPath, 'utf-8');
  const lines = rawText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const parsed = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') parsed.push(obj);
    } catch {
      // 忽略写入中的半行
    }
  }

  let lastPlanner = null;
  const allEvents = [];
  let pendingToolNames = [];
  let lastToolPlanner = null;

  for (const obj of parsed) {
    const type = obj.type || '';
    const stepIndex = typeof obj.step_index === 'number' ? obj.step_index : allEvents.length;

    if (type === 'USER_INPUT') {
      pendingToolNames = [];
      lastToolPlanner = null;
      allEvents.push({
        kind: 'user',
        stepIndex,
        createdAt: obj.created_at || '',
        status: obj.status || 'DONE',
        content: String(obj.content || ''),
      });
    } else if (type === 'SYSTEM_MESSAGE') {
      const env = parseSystemMessageEnvelope(obj.content || '');
      if (env.isAgentMessage && env.messages.length) {
        for (let mIdx = 0; mIdx < env.messages.length; mIdx += 1) {
          const msg = env.messages[mIdx];
          const senderInfo = resolveIncomingSender(msg.sender, roleById);
          allEvents.push({
            kind: 'incoming_message',
            stepIndex,
            subIndex: mIdx,
            createdAt: msg.timestamp || obj.created_at || '',
            status: obj.status || 'DONE',
            senderId: senderInfo.senderId,
            senderLabel: senderInfo.senderLabel,
            isCron: senderInfo.isCron || /^\[Cron\b/i.test(msg.content),
            priority: msg.priority || '',
            content: msg.content,
          });
        }
      } else if (env.content) {
        allEvents.push({
          kind: 'system',
          stepIndex,
          createdAt: obj.created_at || '',
          status: obj.status || 'DONE',
          content: env.content,
        });
      }
    } else if (type === 'PLANNER_RESPONSE') {
      lastPlanner = obj;
      const toolCalls = Array.isArray(obj.tool_calls)
        ? obj.tool_calls.map((tc) => buildToolCallSemantic(tc, workspaceRoots, roleById))
        : [];
      pendingToolNames = toolCalls.map((t) => t.brief || t.name);

      const plannerEvent = {
        kind: 'planner',
        stepIndex,
        createdAt: obj.created_at || '',
        status: obj.status || 'DONE',
        modelRaw: obj.model || '',
        inputTokens: Number(obj.input_tokens || 0),
        cacheReadTokens: Number(obj.cache_read_tokens || 0),
        outputTokens: Number(obj.output_tokens || 0),
        thinking: String(obj.thinking || ''),
        content: String(obj.content || ''),
        toolCalls,
        rawToolOutput: '',
        toolOutput: null,
      };
      lastToolPlanner = toolCalls.length > 0 ? plannerEvent : null;
      allEvents.push(plannerEvent);
    } else if (type === 'GENERIC') {
      const fullContent = String(obj.content || '');
      if (lastToolPlanner) {
        lastToolPlanner.rawToolOutput = lastToolPlanner.rawToolOutput
          ? `${lastToolPlanner.rawToolOutput}\n\n---\n\n${fullContent}`
          : fullContent;
        const cleaned = cleanToolOutputText(lastToolPlanner.rawToolOutput, roleById, MAX_TOOL_OUTPUT_PREVIEW);
        lastToolPlanner.toolOutput = {
          content: cleaned.text,
          shortStatus: cleaned.shortStatus,
          durationText: cleaned.durationText,
          totalChars: cleaned.totalChars,
          truncated: cleaned.truncated,
        };
      } else {
        const cleaned = cleanToolOutputText(fullContent, roleById, MAX_TOOL_OUTPUT_PREVIEW);
        if (cleaned.text || cleaned.shortStatus) {
          allEvents.push({
            kind: 'tool_result',
            stepIndex,
            createdAt: obj.created_at || '',
            status: obj.status || 'DONE',
            relatedTools: pendingToolNames.slice(),
            content: cleaned.text,
            shortStatus: cleaned.shortStatus,
            durationText: cleaned.durationText,
            totalChars: cleaned.totalChars,
            truncated: cleaned.truncated,
          });
        }
      }
      pendingToolNames = [];
    } else if (type === 'CHECKPOINT') {
      lastToolPlanner = null;
      allEvents.push({
        kind: 'checkpoint',
        stepIndex,
        createdAt: obj.created_at || '',
        status: obj.status || 'DONE',
        content: String(obj.content || ''),
      });
    }
  }

  // 清理内部拼接字段 rawToolOutput，避免多余传输开销
  for (const ev of allEvents) {
    if ('rawToolOutput' in ev) delete ev.rawToolOutput;
  }

  let filtered = allEvents;
  if (beforeStep != null && Number.isFinite(Number(beforeStep))) {
    filtered = allEvents.filter((e) => e.stepIndex < Number(beforeStep));
  }

  const safeLimit = Math.max(20, Math.min(500, Number(limit) || 150));
  const start = Math.max(0, filtered.length - safeLimit);
  const sliced = filtered.slice(start);

  return {
    events: sliced,
    totalEvents: allEvents.length,
    hasMore: start > 0,
    oldestStepIndex: sliced.length ? sliced[0].stepIndex : null,
    lastPlanner,
  };
}

/**
 * 读取指定会话的上下文分层拆解与对话流详情。
 */
export async function readAgentDetail(conversationId, { limit = 150, beforeStep = null } = {}) {
  const loc = findConvLocation(conversationId);
  const tpPath = loc ? join(loc.convDir, '.system_generated', 'logs', 'transcript.jsonl') : '';

  const [groupCtx, catalog, convRes, genRes, trajRes] = await Promise.all([
    getCachedGroupContext(conversationId).catch(() => ({ workspaceRoots: [], roleById: {} })),
    getModelCatalog(),
    getConversation(conversationId).catch(() => null),
    getGeneratorMetadata(conversationId).catch(() => null),
    getTrajectory(conversationId).catch(() => null),
  ]);

  const workspaceRoots = groupCtx?.workspaceRoots || [];
  const roleById = groupCtx?.roleById || {};

  const parsed = parseTranscriptEvents(tpPath, {
    limit,
    beforeStep,
    workspaceRoots,
    roleById,
  });

  const gens = Array.isArray(genRes?.generatorMetadata) ? genRes.generatorMetadata : [];
  const lastGen = gens.length ? gens[gens.length - 1] : null;
  const chatModel = lastGen?.chatModel || null;
  const cwm = chatModel?.chatStartMetadata?.contextWindowMetadata || null;
  const usage = chatModel?.usage || null;
  const steps = Array.isArray(trajRes?.trajectory?.steps) ? trajRes.trajectory.steps : [];

  const genModelId = usage?.model || chatModel?.model || '';
  const modelLabel = formatModelLabel(genModelId, chatModel?.modelDisplayName, parsed.lastPlanner?.model, catalog);
  const maxContextTokens = Number(cwm?.maxContextTokens) || 512000;

  // 构建分层上下文结构
  const groups = [];
  const topSteps = [];
  if (Array.isArray(cwm?.tokenBreakdown?.groups)) {
    for (const g of cwm.tokenBreakdown.groups) {
      const gType = g.type || '';
      const gTokens = Number(g.numTokens || 0);
      const children = Array.isArray(g.children) ? g.children : [];

      if (gType === 'TOKEN_TYPE_CHAT_MESSAGES') {
        const enrichedChildren = children.map((c) => {
          const m = /^(\d+):\s*(.+)$/.exec(String(c.name || ''));
          const idx = m ? Number(m[1]) : -1;
          const stepType = m ? m[2] : String(c.name || '');
          const step = idx >= 0 && idx < steps.length ? steps[idx] : null;
          const { toolName, summary } = step
            ? summarizeTrajectoryStep(step, workspaceRoots)
            : { toolName: stepType.toLowerCase(), summary: '' };
          const numTokens = Number(c.numTokens || 0);
          const item = {
            name: c.name,
            stepIndex: idx,
            stepType,
            toolName,
            summary,
            numTokens,
          };
          if (numTokens > 0) topSteps.push(item);
          return item;
        });
        groups.push({
          type: gType,
          name: GROUP_LABELS_ZH[gType] || g.name || gType,
          numTokens: gTokens,
          children: enrichedChildren.slice(-24),
        });
      } else {
        groups.push({
          type: gType,
          name: GROUP_LABELS_ZH[gType] || g.name || gType,
          numTokens: gTokens,
          children: children.map((c) => ({
            name: c.name,
            numTokens: Number(c.numTokens || 0),
          })),
        });
      }
    }
  }
  groups.sort((a, b) => b.numTokens - a.numTokens);
  topSteps.sort((a, b) => b.numTokens - a.numTokens);

  const breakdownTotal = Number(cwm?.tokenBreakdown?.totalTokens || cwm?.estimatedTokensUsed || 0);
  const inputTokens = Number(usage?.inputTokens ?? parsed.lastPlanner?.input_tokens ?? 0);
  const cacheReadTokens = Number(usage?.cacheReadTokens ?? parsed.lastPlanner?.cache_read_tokens ?? 0);
  const cacheCreationTokens = Number(usage?.cacheCreationTokens ?? 0);
  const outputTokens = Number(usage?.outputTokens ?? parsed.lastPlanner?.output_tokens ?? 0);
  const thinkingOutputTokens = Number(usage?.thinkingOutputTokens ?? 0);

  const measuredPromptTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
  const usedTokens = breakdownTotal > 0 ? breakdownTotal : measuredPromptTokens > 0 ? measuredPromptTokens + outputTokens : 0;
  const usedPct = maxContextTokens > 0 ? Math.round((usedTokens / maxContextTokens) * 1000) / 10 : 0;
  const cacheHitRate =
    measuredPromptTokens > 0 ? Math.round((cacheReadTokens / measuredPromptTokens) * 1000) / 10 : null;

  const events = parsed.events.map((ev) => {
    if (ev.kind === 'planner') {
      return {
        ...ev,
        modelLabel: formatModelLabel('', '', ev.modelRaw, catalog) || modelLabel,
      };
    }
    return ev;
  });

  return {
    status: 'ready',
    conversationId,
    title: convRes?.annotations?.title || convRes?.state?.summary || '',
    runState: convRes?.state?.runState || '',
    workspaceRoots,
    roleById,
    context: {
      modelId: genModelId || parsed.lastPlanner?.model || '',
      modelLabel,
      usedTokens,
      maxContextTokens,
      usedPct,
      level: usedPct >= 85 ? 'crit' : usedPct >= 70 ? 'warn' : 'ok',
      cacheHitRate,
      inputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      outputTokens,
      thinkingOutputTokens,
      generationCount: gens.length,
      groups,
      topSteps: topSteps.slice(0, 8),
    },
    events,
    totalEvents: parsed.totalEvents,
    hasMore: parsed.hasMore,
    oldestStepIndex: parsed.oldestStepIndex,
  };
}
