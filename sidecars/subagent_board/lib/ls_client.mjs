/**
 * Antigravity Language Server 与 ConversationService RPC 客户端。
 *
 * 封装只读 RPC 调用、5 分钟模型目录缓存、模型友好名称解析以及并发池，
 * 供整棵子代理树扫描与单代理详情查询共用。
 */

import http from 'node:http';
import https from 'node:https';

const USER_STATUS_TTL_MS = 5 * 60 * 1000;
const PLACEHOLDER_RE = /^MODEL_PLACEHOLDER_/i;

// 模型目录缓存：有效期 5 分钟，避免高频轮询重复调用 GetUserStatus
let modelCatalogCache = { fetchedAt: 0, byId: {} };

/**
 * 调用本地 Language Server Connect HTTP+JSON 接口。
 * @param {'LanguageServerService' | 'ConversationService'} serviceName 服务名称
 * @param {string} method RPC 方法名
 * @param {object} body 请求体
 * @param {number} timeoutMs 超时毫秒数，默认 3500
 */
export function lsRequest(serviceName, method, body, timeoutMs = 3500) {
  const addr = (process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const csrf = (process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  if (!addr || !csrf) {
    return Promise.reject(new Error('Language Server 环境变量未就绪'));
  }

  const base = new URL(addr.startsWith('http') ? addr : `http://${addr}`);
  const payload = JSON.stringify(body || {});
  const transport = base.protocol === 'https:' ? https : http;
  const servicePrefix =
    serviceName === 'ConversationService'
      ? '/product.v1.ConversationService'
      : '/exa.language_server_pb.LanguageServerService';

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: base.hostname,
        port: base.port,
        path: `${servicePrefix}/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': csrf,
          'x-antigravity-csrf-token': csrf,
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
        rejectUnauthorized: false,
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`${method}: HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(text ? JSON.parse(text) : {});
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`${method}: 请求超时`)));
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * 获取可用模型目录映射（带 5 分钟缓存，失败时保留旧缓存不阻断主流程）。
 */
export async function getModelCatalog() {
  if (Date.now() - modelCatalogCache.fetchedAt < USER_STATUS_TTL_MS && Object.keys(modelCatalogCache.byId).length) {
    return modelCatalogCache.byId;
  }
  try {
    const resp = await lsRequest('LanguageServerService', 'GetUserStatus', {
      metadata: { ideName: 'antigravity', extensionName: 'antigravity' },
    });
    const configs = resp?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
    const byId = {};
    for (const c of configs) {
      const id = c?.modelOrAlias?.model || c?.modelId;
      if (!id) continue;
      byId[id] = {
        id,
        label: c.label || id,
        remainingFraction: typeof c?.quotaInfo?.remainingFraction === 'number' ? c.quotaInfo.remainingFraction : null,
        resetTime: c?.quotaInfo?.resetTime || '',
      };
    }
    modelCatalogCache = { fetchedAt: Date.now(), byId };
  } catch {
    // 保留旧缓存或空表，交由调用方回退到 transcriptModel 解析
  }
  return modelCatalogCache.byId;
}

const TIER_MAP = {
  xhigh: 'XHigh',
  high: 'High',
  medium: 'Medium',
  med: 'Medium',
  low: 'Low',
  lite: 'Lite',
  fast: 'Fast',
};

function formatTokenWord(word) {
  if (!word) return '';
  if (/^\d+(?:\.\d+)?$/.test(word)) return word;
  const lower = word.toLowerCase();
  if (lower === 'pro') return 'Pro';
  if (lower === 'flash') return 'Flash';
  if (lower === 'mini') return 'Mini';
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * 将 transcript 中的模型短名（如 gemini-4-hydrogen-tiered-high）格式化为可读名称。
 */
export function humanizeTranscriptModel(rawModel) {
  const raw = String(rawModel || '').trim();
  if (!raw || PLACEHOLDER_RE.test(raw)) return '';

  // 匹配 *-tiered-<tier> 或末尾带 -(xhigh|high|medium|low)
  let base = raw;
  let tierLabel = '';
  const tieredMatch = /^(.*?)-tiered-([a-z0-9]+)$/i.exec(raw);
  if (tieredMatch) {
    base = tieredMatch[1];
    tierLabel = TIER_MAP[tieredMatch[2].toLowerCase()] || formatTokenWord(tieredMatch[2]);
  } else {
    const suffixMatch = /^(.*?)-(xhigh|high|medium|low)$/i.exec(raw);
    if (suffixMatch) {
      base = suffixMatch[1];
      tierLabel = TIER_MAP[suffixMatch[2].toLowerCase()] || formatTokenWord(suffixMatch[2]);
    }
  }

  const words = base
    .split(/[-_]+/)
    .filter(Boolean)
    .map(formatTokenWord)
    .join(' ');
  if (!words) return raw;
  return tierLabel ? `${words} (${tierLabel})` : words;
}

/**
 * 综合 LS 模型目录、modelDisplayName 与 transcript.jsonl 模型标识，解析友好展示名称。
 * 优先级：catalog[genModelId]?.label -> 非占位符 displayName -> 可读化 transcriptModel -> 原值兜底。
 */
export function formatModelLabel(genModelId, modelDisplayName, transcriptModel, catalog = {}) {
  const gid = String(genModelId || '').trim();
  if (gid && catalog[gid]?.label) {
    return catalog[gid].label;
  }

  const disp = String(modelDisplayName || '').trim();
  if (disp && !PLACEHOLDER_RE.test(disp)) {
    return disp;
  }

  const humanized = humanizeTranscriptModel(transcriptModel);
  if (humanized) {
    return humanized;
  }

  if (transcriptModel) return String(transcriptModel);
  if (gid) return gid;
  return '未知模型';
}

export function getConversation(conversationId) {
  return lsRequest('ConversationService', 'GetConversation', { conversationId });
}

export function getGeneratorMetadata(conversationId) {
  return lsRequest('LanguageServerService', 'GetCascadeTrajectoryGeneratorMetadata', {
    cascadeId: conversationId,
  });
}

export function getTrajectory(conversationId) {
  return lsRequest('LanguageServerService', 'GetCascadeTrajectory', {
    cascadeId: conversationId,
  });
}

/**
 * 通用有界并发执行池，防止深层子代理树瞬间并发过高打满 Language Server。
 * @template T, R
 * @param {T[]} items 待处理列表
 * @param {number} limit 最大并发数（默认 4）
 * @param {(item: T, index: number) => Promise<R>} worker 异步处理函数
 * @returns {Promise<R[]>}
 */
export async function runWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];
  const cap = Math.max(1, Math.min(limit || 4, list.length));
  const results = new Array(list.length);
  let cursor = 0;

  async function runner() {
    while (cursor < list.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await worker(list[idx], idx);
    }
  }

  await Promise.all(Array.from({ length: cap }, () => runner()));
  return results;
}
