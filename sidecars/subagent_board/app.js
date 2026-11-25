/**
 * Subagent Board 前端控制器（v3 解析与交互全面改良版）。
 *
 * 核心保障：
 * - Sticky 详情导航（← 返回总览永远可见），返回自动恢复树列表滚动位置
 * - 全量安全 Markdown 渲染 + 自动将绝对路径/file:// 链接转为可点击短路径胶囊
 * - 支持 incoming_message（拆包代理间消息）与语义化工具调用渲染
 * - 精准滚动控制：仅首开代理或新步骤追加时跟底，加载更早步骤原地保持视口
 */
(() => {
  const VISIBLE_POLL_MS = 2500;
  const HIDDEN_POLL_MS = 15000;
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const currentConv = () => window.sidecar?.conversationId || params.get('conversationId') || '';

  const apiFetch = (url, init) => {
    const fn = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    return fn(url, init);
  };

  const state = {
    activeTab: 'overview',
    lastRootId: '',
    group: null,
    selectedAgentId: '',
    detailOpen: false,
    savedTreeScrollY: 0,
    agentDetail: null,
    agentDetailConvId: '',
    agentLastStepIdx: -1,
    agentLimit: 150,
    showBreakdown: false,
    collapsedNodes: new Set(),
    allCollapsed: false,
    openDetailsKeys: new Set(),
    expandedLongKeys: new Set(),
    selectedTwCategory: 'all',
    selectedTwPath: '',
    twDocCache: new Map(),
    followBottom: true,
    pollTimer: null,
    sigs: {
      summary: '',
      tree: '',
      messages: '',
      detail: '',
      teamwork: '',
    },
  };

  // ---------- 宿主明暗主题同步与 Header 高度测量 ----------
  function syncScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f7f8)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    document.documentElement.dataset.theme = lum < 0.5 ? 'dark' : 'light';
  }
  syncScheme();
  new MutationObserver(syncScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  function syncHeaderHeight() {
    const h = $('header')?.offsetHeight;
    if (h) document.documentElement.style.setProperty('--header-h', `${h}px`);
  }
  new ResizeObserver(syncHeaderHeight).observe($('header'));

  // Popover 不支持时的轻量回退
  if (!Object.hasOwn(HTMLElement.prototype, 'popover')) {
    const pop = $('stats-popover');
    $('btn-stats').addEventListener('click', (e) => {
      e.stopPropagation();
      pop.classList.toggle('is-popover-open');
    });
    document.addEventListener('click', (e) => {
      if (!pop.contains(e.target) && e.target !== $('btn-stats')) {
        pop.classList.remove('is-popover-open');
      }
    });
  }

  // ---------- 格式化与短路径辅助 ----------
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtTok(n) {
    const v = Number(n || 0);
    if (v >= 1000000) return `${(v / 1000000).toFixed(2)}M`;
    if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
    return String(v);
  }

  function fmtRelTime(iso) {
    if (!iso) return '';
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return '';
    const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (sec < 60) return `${sec}秒前`;
    if (sec < 3600) return `${Math.floor(sec / 60)}分前`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}小时前`;
    return `${Math.floor(sec / 86400)}天前`;
  }

  function fmtClock(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function showToast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.add('hidden'), 2000);
  }

  function shortenPathClient(rawPath) {
    let input = String(rawPath || '').trim();
    if (!input) return '';
    if (input.startsWith('file://')) {
      try {
        input = decodeURIComponent(input.slice(7));
      } catch {
        input = input.slice(7);
      }
    }
    input = input.replace(/^\/([A-Za-z]:[\\/])/, '$1');
    let pathPart = input;
    let suffix = '';
    const suf = /^(.*?)(#L\d+(?:-L?\d+)?|:\d+(?:-\d+)?)$/i.exec(input);
    if (suf) {
      pathPart = suf[1];
      suffix = suf[2];
    }
    const norm = pathPart.replace(/\\/g, '/').replace(/\/+$/, '') || pathPart;
    const tw = /(?:^|.*\/)scratch\/teamwork\/[0-9a-f-]{8,}\/\.agents\/teamwork\/(.*)$/i.exec(norm);
    if (tw) return (tw[1] ? `teamwork/${tw[1]}` : 'teamwork') + suffix;
    const up = /(?:^|.*\/)\.gemini\/antigravity\/brain\/[0-9a-f-]{8,}\/\.user_uploaded\/(.*)$/i.exec(norm);
    if (up) return `附件/${up[1]}` + suffix;
    const br = /(?:^|.*\/)\.gemini\/antigravity\/brain\/[0-9a-f-]{8,}\/(.*)$/i.exec(norm);
    if (br) return `brain/${br[1]}` + suffix;

    const roots = state.group?.workspaceRoots || state.agentDetail?.workspaceRoots || [];
    for (const root of roots) {
      const cr = String(root || '').replace(/\\/g, '/').replace(/\/+$/, '');
      if (!cr) continue;
      if (norm === cr) return (cr.split('/').pop() || cr) + suffix;
      if (norm.startsWith(`${cr}/`)) return norm.slice(cr.length + 1) + suffix;
    }
    const hm = /^(?:\/Users|\/home|[A-Za-z]:\/Users)\/[^/]+\/(.*)$/i.exec(norm);
    if (hm) {
      const segs = hm[1].split('/').filter(Boolean);
      if (segs.length > 4) return `~/.../${segs.slice(-2).join('/')}` + suffix;
      return `~/${hm[1]}` + suffix;
    }
    return pathPart + suffix;
  }

  function toFileUriClient(rawPath) {
    const clean = String(rawPath || '').trim();
    if (!clean) return '';
    if (clean.startsWith('file://')) return clean;
    const norm = clean.replace(/\\/g, '/');
    const isWinAbs = /^[A-Za-z]:\//.test(norm);
    if (!norm.startsWith('/') && !isWinAbs) return '';
    const m = /^([^#:]+(?:^[A-Za-z]:[^#:]+)?|[A-Za-z]:[^#:]+|[^#:]+)(#L\d+(?:-L?\d+)?)?(?::(\d+)(?:-(\d+))?)?$/i.exec(norm);
    const prefix = isWinAbs ? 'file:///' : 'file://';
    if (!m) return `${prefix}${encodeURI(norm)}`;
    const base = `${prefix}${encodeURI(m[1])}`;
    if (m[2]) return `${base}${m[2]}`;
    if (m[3]) return m[4] ? `${base}#L${m[3]}-L${m[4]}` : `${base}#L${m[3]}`;
    return base;
  }

  function makeFileChipHtml(displayLabel, rawTarget, rawUri) {
    const uri = rawUri || toFileUriClient(rawTarget);
    const short = displayLabel || shortenPathClient(rawTarget);
    return `<button type="button" class="file-chip" data-open-file="${esc(uri)}" title="${esc(rawTarget)}">${esc(short)}</button>`;
  }

  /**
   * 强化安全 Markdown 渲染：
   * 先将代码块、链接、行内代码提炼为安全占位符，再整体转义并用可点击文件胶囊美化路径。
   */
  function renderMarkdownSafe(raw) {
    const text = String(raw || '');
    if (!text) return '';

    const tokens = [];
    const putTok = (html) => {
      const idx = tokens.length;
      tokens.push(html);
      return `\u0000TK${idx}\u0000`;
    };

    // 1. 提取围栏代码块（支持 \r?\n 与语言尾随空格）
    let work = text.replace(/```([a-zA-Z0-9_+#.-]*)[ \t]*\r?\n([\s\S]*?)```/g, (_, _lang, code) =>
      putTok(`<pre><code>${esc(code)}</code></pre>`),
    );

    // 2. 提取标准 Markdown 链接 [label](url)
    work = work.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label, target) => {
      if (target.startsWith('file://') || target.startsWith('/') || /^[A-Za-z]:[\\/]/.test(target)) {
        const cleanLabel = /^(?:Users|home|var|tmp|opt|etc|Volumes)\/|^[A-Za-z]:[\\/]|^(?:file:\/\/|\/)/.test(label)
          ? shortenPathClient(label)
          : label;
        return putTok(makeFileChipHtml(cleanLabel, target, target.startsWith('file://') ? target : ''));
      }
      if (/^https?:\/\//i.test(target)) {
        return putTok(`<span class="md-link" title="${esc(target)}">${esc(label)}</span>`);
      }
      return esc(label);
    });

    // 3. 提取行内代码 `...`；若其内容是本地绝对路径，直接转为可点击文件胶囊
    work = work.replace(/`([^`\n]+)`/g, (_, code) => {
      const trimmed = code.trim();
      if (/^(?:\/(?:Users|home|var|tmp|opt|etc|Volumes)\/|[A-Za-z]:[\\/]Users[\\/])[^\s]+$/.test(trimmed)) {
        return putTok(makeFileChipHtml(shortenPathClient(trimmed), trimmed));
      }
      return putTok(`<code>${esc(code)}</code>`);
    });

    const renderInlineSegment = (rawLine) => {
      // 先在转义前提取裸露的绝对路径为安全占位符，避免后续 esc() 把引号转成 &quot; 干扰路径边界
      const withPaths = String(rawLine || '').replace(
        /(?<![A-Za-z0-9_:/.-])((?:\/(?:Users|home|var|tmp|opt|etc|Volumes)\/|[A-Za-z]:[\\/]Users[\\/])[^\s`"'<>()[\],;，。；）】》]+)/g,
        (full) => {
          const trailMatch = /^(.*?)([.,;:!?]+)$/.exec(full);
          if (trailMatch && !/^:\d+(?:-\d+)?$/.test(trailMatch[2])) {
            return putTok(makeFileChipHtml(shortenPathClient(trailMatch[1]), trailMatch[1])) + trailMatch[2];
          }
          return putTok(makeFileChipHtml(shortenPathClient(full), full));
        },
      );
      let escaped = esc(withPaths);
      escaped = escaped
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(?<!\*)\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g, '<em>$1</em>')
        .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
      return escaped.replace(/\u0000TK(\d+)\u0000/g, (_, i) => tokens[Number(i)] || '');
    };

    const lines = work.split(/\r?\n/);
    const out = [];
    let listTag = '';
    let i = 0;

    const closeList = () => {
      if (listTag) {
        out.push(`</${listTag}>`);
        listTag = '';
      }
    };

    while (i < lines.length) {
      const line = lines[i];
      const cbMatch = /^\s*\u0000TK(\d+)\u0000\s*$/.exec(line);
      if (cbMatch && tokens[Number(cbMatch[1])]?.startsWith('<pre>')) {
        closeList();
        out.push(tokens[Number(cbMatch[1])]);
        i += 1;
        continue;
      }

      if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
        closeList();
        out.push('<hr>');
        i += 1;
        continue;
      }

      // 表格
      if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*[-:]+[-|\s:]*$/.test(lines[i + 1])) {
        closeList();
        const parseCells = (row) =>
          row
            .trim()
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map((c) => renderInlineSegment(c.trim()));
        const headers = parseCells(line);
        i += 2;
        const bodyRows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
          bodyRows.push(parseCells(lines[i]));
          i += 1;
        }
        out.push(
          `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${bodyRows
            .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
            .join('')}</tbody></table></div>`,
        );
        continue;
      }

      const hMatch = /^(#{1,4})\s+(.+)$/.exec(line);
      if (hMatch) {
        closeList();
        const lvl = hMatch[1].length;
        out.push(`<h${lvl}>${renderInlineSegment(hMatch[2])}</h${lvl}>`);
        i += 1;
        continue;
      }

      const bqMatch = /^>\s?(.*)$/.exec(line);
      if (bqMatch) {
        closeList();
        out.push(`<blockquote>${renderInlineSegment(bqMatch[1])}</blockquote>`);
        i += 1;
        continue;
      }

      const ulMatch = /^(\s*)[-*]\s+(.+)$/.exec(line);
      if (ulMatch) {
        if (listTag !== 'ul') {
          closeList();
          out.push('<ul>');
          listTag = 'ul';
        }
        const indentPx = Math.min(24, Math.floor(ulMatch[1].length / 2) * 12);
        const styleAttr = indentPx ? ` style="margin-left:${indentPx}px"` : '';
        let content = ulMatch[2];
        const chkMatch = /^\[(x|X| )\]\s+(.+)$/.exec(content);
        if (chkMatch) {
          const checked = chkMatch[1].toLowerCase() === 'x' ? 'checked' : '';
          content = `<input type="checkbox" class="md-chk" disabled ${checked}>${renderInlineSegment(chkMatch[2])}`;
        } else {
          content = renderInlineSegment(content);
        }
        out.push(`<li${styleAttr}>${content}</li>`);
        i += 1;
        continue;
      }

      const olMatch = /^(\s*)\d+\.\s+(.+)$/.exec(line);
      if (olMatch) {
        if (listTag !== 'ol') {
          closeList();
          out.push('<ol>');
          listTag = 'ol';
        }
        const indentPx = Math.min(24, Math.floor(olMatch[1].length / 2) * 12);
        const styleAttr = indentPx ? ` style="margin-left:${indentPx}px"` : '';
        out.push(`<li${styleAttr}>${renderInlineSegment(olMatch[2])}</li>`);
        i += 1;
        continue;
      }

      closeList();
      if (line.trim()) {
        out.push(`<p>${renderInlineSegment(line)}</p>`);
      }
      i += 1;
    }
    closeList();
    return out.join('');
  }

  function openNativeConversation(convId) {
    if (!convId) return;
    if (window.sidecar?.ui?.toggleConversation) {
      window.sidecar.ui.toggleConversation(convId);
    } else {
      showToast('切入原会话需在 Antigravity 客户端内运行');
    }
  }

  function openFileInSidePane(fileUri) {
    if (!fileUri) return;
    const cleanPath = (() => {
      try {
        return decodeURIComponent(fileUri.replace(/^file:\/\//, '').split('#')[0]);
      } catch {
        return '';
      }
    })();

    if (window.sidecar?.ui?.toggleAuxPane) {
      window.sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri: fileUri });
      return;
    }

    // 兜底：若该文件属于当前 Teamwork 工件，直接切换到工件 Tab 预览
    const twDoc = (state.group?.teamwork?.docs || []).find((d) => d.absPath === cleanPath);
    if (twDoc) {
      switchTab('teamwork');
      selectTeamworkDoc(twDoc);
      return;
    }
    showToast(`路径：${shortenPathClient(cleanPath)}`);
  }

  // 全局委托处理所有可点击文件胶囊
  document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('[data-open-file]');
    if (!btn) return;
    e.stopPropagation();
    openFileInSidePane(btn.dataset.openFile);
  });

  // ---------- 滚动跟随与“↓ 最新”悬浮胶囊 ----------
  function isNearBottom() {
    const doc = document.documentElement;
    return doc.scrollHeight - (window.scrollY + window.innerHeight) <= 72;
  }

  function isFollowableViewActive() {
    if (state.activeTab === 'messages') return true;
    if (state.activeTab === 'overview') {
      const wide = $('workspace')?.clientWidth >= 680;
      return state.detailOpen || wide;
    }
    return false;
  }

  function updateJumpButton() {
    const show = isFollowableViewActive() && !state.followBottom && !isNearBottom();
    $('jump-latest').classList.toggle('hidden', !show);
  }

  function scrollToBottomSmooth(instant = false) {
    state.followBottom = true;
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: instant ? 'auto' : 'smooth',
    });
    updateJumpButton();
  }

  window.addEventListener(
    'scroll',
    () => {
      if (isFollowableViewActive()) {
        state.followBottom = isNearBottom();
      }
      updateJumpButton();
    },
    { passive: true },
  );

  $('jump-latest').addEventListener('click', () => scrollToBottomSmooth(false));

  // ---------- 视图与详情导航 ----------
  function setDetailOpen(open, restoreScroll = false) {
    state.detailOpen = open;
    $('workspace').classList.toggle('detail-open', open);
    if (!open && restoreScroll) {
      requestAnimationFrame(() => {
        window.scrollTo({ top: state.savedTreeScrollY || 0, behavior: 'auto' });
        updateJumpButton();
      });
    } else {
      updateJumpButton();
    }
  }

  function switchTab(tabName) {
    if (tabName === 'overview' && state.activeTab === 'overview' && state.detailOpen) {
      setDetailOpen(false, true);
      return;
    }
    state.activeTab = tabName;
    document.querySelectorAll('.tab').forEach((btn) => {
      const on = btn.dataset.tab === tabName;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.tabIndex = on ? 0 : -1;
    });
    document.querySelectorAll('.tab-body').forEach((pane) => {
      pane.classList.toggle('active', pane.id === `pane-${tabName}`);
    });
    if (tabName === 'messages') {
      state.followBottom = true;
      requestAnimationFrame(() => scrollToBottomSmooth(true));
    } else if (tabName === 'teamwork') {
      window.scrollTo({ top: 0, behavior: 'auto' });
      updateJumpButton();
    } else {
      updateJumpButton();
    }
  }

  function openAgentDetail(convId) {
    if (!convId) return;
    if (!state.detailOpen) {
      state.savedTreeScrollY = window.scrollY;
    }
    const changed = state.selectedAgentId !== convId;
    if (changed) {
      state.selectedAgentId = convId;
      state.agentLimit = 150;
      state.agentDetail = null;
      state.agentDetailConvId = '';
      state.agentLastStepIdx = -1;
      state.sigs.detail = '';
      state.followBottom = true;
    }
    $('detail-agent-select').value = convId;
    if (state.activeTab !== 'overview') {
      state.activeTab = 'overview';
      document.querySelectorAll('.tab').forEach((btn) => {
        const on = btn.dataset.tab === 'overview';
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      document.querySelectorAll('.tab-body').forEach((pane) => {
        pane.classList.toggle('active', pane.id === 'pane-overview');
      });
    }
    setDetailOpen(true);
    state.sigs.tree = '';
    renderTree();
    loadAgentDetail(convId, state.agentLimit, { allowAutoScroll: true });
  }

  // ---------- 1. 顶部摘要与 Popover ----------
  function renderSummary(group) {
    const sum = group.summary;
    const sig = JSON.stringify([
      group.rootTitle,
      sum.totalAgents,
      sum.runningCount,
      sum.waitingCount,
      sum.killedCount,
      sum.errorCount,
      sum.totalPromptTokens,
      sum.totalCumulativeOutputTokens,
      sum.avgCacheHitRate,
      sum.peakContext?.usedPct,
      group.messages?.length,
      group.teamwork?.docs?.length,
    ]);
    if (state.sigs.summary === sig) return;
    state.sigs.summary = sig;

    const title = group.rootTitle || group.rootConversationId.slice(0, 8);
    $('root-title').textContent = title;
    $('root-title').title = `${title} (${group.rootConversationId})`;

    const live = $('live-status');
    const lbl = $('live-label');
    if (sum.errorCount > 0) {
      live.className = 'live error';
      lbl.textContent = `${sum.errorCount} 报错 · ${sum.runningCount} 运行`;
    } else if (sum.runningCount > 0) {
      live.className = 'live running';
      lbl.textContent = `${sum.runningCount} 运行中`;
    } else {
      live.className = 'live';
      lbl.textContent = `${sum.totalAgents} 成员`;
    }

    $('pop-agent-counts').textContent = `${sum.runningCount} 运行 / ${sum.waitingCount} 等待 / ${sum.killedCount} 终止`;
    $('sum-prompt').textContent = fmtTok(sum.totalPromptTokens);
    $('sum-output').textContent = fmtTok(sum.totalCumulativeOutputTokens);
    $('sum-cache').textContent = sum.avgCacheHitRate != null ? `${sum.avgCacheHitRate}%` : '-';
    $('sum-peak').textContent = sum.peakContext ? `${sum.peakContext.usedPct}% (${sum.peakContext.role})` : '-';

    $('model-dist').innerHTML = (sum.modelDistribution || [])
      .map((m) => `<span class="mono-chip">${esc(m.label)} ×${m.count}</span>`)
      .join('');

    $('tab-tree-count').textContent = String(sum.totalAgents);
    const nonCronCount = (group.messages || []).filter((m) => !m.isCron).length;
    $('tab-msg-count').textContent = String(nonCronCount || group.messages?.length || 0);

    const twBtn = $('tab-btn-teamwork');
    if (group.teamwork?.detected && group.teamwork.docs?.length) {
      twBtn.classList.remove('hidden');
      $('tab-tw-count').textContent = String(group.teamwork.docs.length);
    } else {
      twBtn.classList.add('hidden');
    }
  }

  // ---------- 2. 置顶焦点区与单色子代理树 ----------
  const STATUS_TEXT = {
    running: '运行中',
    cancelling: '停止中',
    waiting: '等待',
    idle: '空闲',
    error: '报错',
    killed: '已终止',
  };

  function renderFocusSection(nodes) {
    const focusNodes = nodes.filter(
      (n) => n.status === 'running' || n.status === 'cancelling' || n.status === 'error' || (n.status !== 'killed' && n.context?.usedPct >= 75),
    );
    const el = $('focus-section');
    if (!focusNodes.length) {
      el.classList.add('hidden');
      el.innerHTML = '';
      return;
    }
    el.classList.remove('hidden');
    const runCnt = focusNodes.filter((n) => n.status === 'running' || n.status === 'cancelling').length;
    const headTitle = runCnt > 0 ? `正在执行 (${runCnt})` : '需关注节点';
    el.innerHTML = `
      <div class="focus-title">${headTitle}</div>
      ${focusNodes
        .map((n) => {
          const isRun = n.status === 'running';
          const act = n.currentActivity || (n.context.usedPct >= 75 ? `上下文已达 ${n.context.usedPct}%` : STATUS_TEXT[n.status]);
          return `
            <div class="focus-row" data-focus-conv="${esc(n.conversationId)}">
              <span class="status-dot ${esc(n.status)}"></span>
              <div class="focus-main">
                <div style="display:flex;align-items:center;gap:6px">
                  <span class="focus-name">${esc(n.role)}</span>
                  <span class="muted" style="font-size:10.5px">${esc(n.shortModelLabel || n.modelLabel)}</span>
                  <span class="spacer"></span>
                  <span class="mono muted" style="font-size:10.5px">${n.context.usedPct}%</span>
                </div>
                <div class="focus-act ${isRun ? 'animate-shimmer-text' : ''}">${esc(act)}</div>
              </div>
            </div>
          `;
        })
        .join('')}
    `;
    el.querySelectorAll('[data-focus-conv]').forEach((row) => {
      row.addEventListener('click', () => openAgentDetail(row.dataset.focusConv));
    });
  }

  function flattenVisibleTree(root, query, hideKilled, onlyActive) {
    const q = query.trim().toLowerCase();
    const matchesSelf = (node) => {
      if (hideKilled && node.status === 'killed') return false;
      if (onlyActive && node.status !== 'running' && node.status !== 'cancelling' && node.status !== 'error' && node.context?.usedPct < 75) {
        return false;
      }
      if (!q) return true;
      return (
        node.role.toLowerCase().includes(q) ||
        node.typeName.toLowerCase().includes(q) ||
        node.modelLabel.toLowerCase().includes(q) ||
        (node.currentActivity || '').toLowerCase().includes(q)
      );
    };
    const hasMatchInSubtree = (node) => matchesSelf(node) || (node.children || []).some(hasMatchInSubtree);

    const rows = [];
    function walk(node) {
      if (!hasMatchInSubtree(node)) return;
      const visibleChildren = (node.children || []).filter(hasMatchInSubtree);
      rows.push({ node, hasChildren: visibleChildren.length > 0 });
      if (!state.collapsedNodes.has(node.conversationId)) {
        for (const c of visibleChildren) walk(c);
      }
    }
    if (root) walk(root);
    return rows;
  }

  function renderTree() {
    const group = state.group;
    if (!group?.tree) return;

    const query = $('tree-search').value || '';
    const hideKilled = $('tree-hide-killed').checked;
    const onlyActive = $('tree-only-active').checked;
    $('tree-filter-toggle').classList.toggle('active', hideKilled || onlyActive);

    const treeSig = JSON.stringify([
      query,
      hideKilled,
      onlyActive,
      state.selectedAgentId,
      Array.from(state.collapsedNodes).sort(),
      (group.nodes || []).map((n) => [n.conversationId, n.status, n.modelLabel, n.stepCount, n.context.usedTokens, n.currentActivity]),
    ]);
    if (state.sigs.tree === treeSig) return;
    state.sigs.tree = treeSig;

    renderFocusSection(group.nodes || []);
    const rows = flattenVisibleTree(group.tree, query, hideKilled, onlyActive);

    if (!rows.length) {
      $('tree-list').innerHTML = '<div class="empty-body" style="padding:28px 0;text-align:center">没有匹配的子代理节点</div>';
      return;
    }

    $('tree-list').innerHTML = rows
      .map(({ node, hasChildren }) => {
        const isCollapsed = state.collapsedNodes.has(node.conversationId);
        const ctx = node.context || {};
        const pct = Math.min(100, Number(ctx.usedPct || 0));
        const lvlCls = ctx.level === 'crit' ? 'crit' : ctx.level === 'warn' ? 'warn' : '';
        const isSelected = state.selectedAgentId === node.conversationId;
        const isRun = node.status === 'running';
        const depthCapped = Math.min(node.depth, 4);
        const guideLines = Array.from({ length: depthCapped }, (_, i) => `<span class="tree-guide-line" style="left:${i * 12 + 6}px"></span>`).join('');
        const statsParts = [`${node.stepCount}步`];
        if (ctx.cacheHitRate != null) statsParts.push(`缓存${ctx.cacheHitRate}%`);
        const rel = fmtRelTime(node.lastActivityAt);
        if (rel) statsParts.push(rel);

        return `
          <div class="tree-row ${node.status === 'killed' ? 'killed' : ''} ${isSelected ? 'selected' : ''}"
               style="--depth:${node.depth}" data-conv="${esc(node.conversationId)}" role="treeitem">
            ${depthCapped ? `<div class="tree-guides">${guideLines}</div>` : ''}
            <div class="row-line1">
              ${
                hasChildren
                  ? `<button type="button" class="fold-btn" data-fold="${esc(node.conversationId)}" aria-label="展开或折叠">${isCollapsed ? '▸' : '▾'}</button>`
                  : '<span class="fold-spacer"></span>'
              }
              <span class="status-dot ${esc(node.status)}" title="${esc(STATUS_TEXT[node.status] || node.status)}"></span>
              <span class="row-role" title="${esc(node.role)} (${esc(node.typeName)})">${esc(node.role)}</span>
              ${node.isActiveView ? '<span class="row-cur-tag">当前</span>' : ''}
              <span class="row-model" title="${esc(node.modelLabel)}">${esc(node.shortModelLabel || node.modelLabel)}</span>
              <span class="row-ctx mono ${lvlCls}" title="${fmtTok(ctx.usedTokens)} / ${fmtTok(ctx.maxContextTokens)}">
                <span class="mini-bar"><span class="mini-bar-fill ${lvlCls}" style="width:${pct}%"></span></span>
                ${Math.round(pct)}%
              </span>
            </div>
            <button type="button" class="row-jump" data-open-conv="${esc(node.conversationId)}" title="在主窗口切入原会话">
              <svg class="icon" viewBox="0 0 16 16" style="width:12px;height:12px"><path d="M6.5 3.5H3.5v9h9v-3M9.5 2.5h4v4M13.5 2.5 7.5 8.5"/></svg>
            </button>
            <div class="row-line2">
              <span class="row-activity ${isRun ? 'animate-shimmer-text' : ''}" title="${esc(node.currentActivity || '')}">
                ${esc(node.currentActivity || STATUS_TEXT[node.status] || '')}
              </span>
              <span class="row-stats mono">${esc(statsParts.join(' · '))}</span>
            </div>
          </div>
        `;
      })
      .join('');

    $('tree-list').querySelectorAll('[data-fold]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const cid = btn.dataset.fold;
        if (state.collapsedNodes.has(cid)) state.collapsedNodes.delete(cid);
        else state.collapsedNodes.add(cid);
        state.sigs.tree = '';
        renderTree();
      });
    });

    $('tree-list').querySelectorAll('[data-open-conv]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openNativeConversation(btn.dataset.openConv);
      });
    });

    $('tree-list').querySelectorAll('.tree-row').forEach((row) => {
      row.addEventListener('click', () => openAgentDetail(row.dataset.conv));
    });
  }

  // ---------- 3. 消息板（时间正序、swarm_board 风格） ----------
  function renderMessages() {
    const group = state.group;
    if (!group) return;

    const sel = $('msg-agent-filter');
    const prevAgent = sel.value;
    const hideCron = $('msg-hide-cron').checked;
    const q = ($('msg-search').value || '').trim().toLowerCase();
    $('msg-filter-toggle').classList.toggle('active', Boolean(prevAgent) || !hideCron);

    const msgSig = JSON.stringify([
      prevAgent,
      hideCron,
      q,
      group.messages?.length,
      group.messages?.length ? group.messages[group.messages.length - 1].id : '',
      Array.from(state.expandedLongKeys).filter((k) => k.startsWith('msg:')).sort(),
    ]);
    if (state.sigs.messages === msgSig) return;
    state.sigs.messages = msgSig;

    sel.innerHTML = ['<option value="">全部代理</option>']
      .concat((group.nodes || []).map((n) => `<option value="${esc(n.conversationId)}">${esc(n.role)}</option>`))
      .join('');
    sel.value = prevAgent;

    const filtered = (group.messages || []).filter((m) => {
      if (hideCron && m.isCron) return false;
      if (prevAgent && m.senderConvId !== prevAgent && m.recipientConvId !== prevAgent) return false;
      if (q && !`${m.senderLabel} ${m.recipientLabel} ${m.title} ${m.content}`.toLowerCase().includes(q)) return false;
      return true;
    });

    if (!filtered.length) {
      $('msg-list').innerHTML = '<div class="empty-body" style="padding:36px 0;text-align:center">暂无符合条件的消息</div>';
      return;
    }

    const KIND_LABELS = { spawn: '派单', cron: 'Cron', message: '消息' };
    $('msg-list').innerHTML = filtered
      .map((m) => {
        const longKey = `msg:${m.id}`;
        const isOpen = state.expandedLongKeys.has(longKey);
        const isLong = m.content.length > 280 || m.content.split('\n').length > 6;
        return `
          <article class="msg">
            <div class="msg-head">
              <div class="msg-who">
                <button type="button" class="agent-link" data-jump-agent="${esc(m.senderConvId)}">${esc(m.senderLabel)}</button>
                <span class="msg-arrow">→</span>
                <button type="button" class="agent-link" data-jump-agent="${esc(m.recipientConvId)}">${esc(m.recipientLabel)}</button>
                <span class="msg-kind">${KIND_LABELS[m.kind] || ''}</span>
              </div>
              <span class="msg-ts mono">${esc(fmtClock(m.timestamp))}</span>
            </div>
            <div class="md ${isLong ? `clamped ${isOpen ? 'open' : ''}` : ''}">${renderMarkdownSafe(m.content)}</div>
            ${isLong ? `<button type="button" class="link-btn" data-toggle-long="${esc(longKey)}">${isOpen ? '收起' : '展开全文'}</button>` : ''}
          </article>
        `;
      })
      .join('');

    $('msg-list').querySelectorAll('[data-jump-agent]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.jumpAgent) openAgentDetail(btn.dataset.jumpAgent);
      });
    });

    $('msg-list').querySelectorAll('[data-toggle-long]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const k = btn.dataset.toggleLong;
        if (state.expandedLongKeys.has(k)) state.expandedLongKeys.delete(k);
        else state.expandedLongKeys.add(k);
        state.sigs.messages = '';
        renderMessages();
      });
    });

    if (state.activeTab === 'messages' && state.followBottom) {
      requestAnimationFrame(() => scrollToBottomSmooth(true));
    }
  }

  // ---------- 4. 单代理详情（语义化工具调用 + 接收消息拆包 + 精准滚底） ----------
  function syncAgentSelector() {
    const nodes = state.group?.nodes || [];
    const sel = $('detail-agent-select');
    if (!nodes.length) return;
    sel.innerHTML = nodes
      .map((n) => {
        const prefix = n.depth > 0 ? `${'· '.repeat(Math.min(4, n.depth))}` : '';
        return `<option value="${esc(n.conversationId)}">${prefix}${esc(n.role)} · ${esc(STATUS_TEXT[n.status] || n.status)} (${esc(n.shortModelLabel || n.modelLabel)})</option>`;
      })
      .join('');
    if (!state.selectedAgentId || !nodes.some((n) => n.conversationId === state.selectedAgentId)) {
      state.selectedAgentId = state.group.activeConversationId || nodes[0].conversationId;
    }
    sel.value = state.selectedAgentId;
  }

  function renderToolPreviewBody(tc) {
    if (!tc.previewText) return '';
    if (tc.previewKind === 'markdown') {
      return `<div class="tool-preview-md md">${renderMarkdownSafe(tc.previewText)}</div>`;
    }
    if (tc.previewKind === 'command') {
      return `<pre class="code-pre">$ ${esc(tc.previewText)}</pre>`;
    }
    return `<pre class="code-pre">${esc(tc.previewText)}</pre>`;
  }

  function renderAgentDetail({ allowAutoScroll = false } = {}) {
    const detail = state.agentDetail;
    if (!detail || detail.status !== 'ready') {
      $('detail-chat-stream').innerHTML = '<div class="empty-body" style="padding:28px 0;text-align:center">正在加载子代理对话与上下文…</div>';
      return;
    }

    const showTools = $('d-show-tools').checked;
    const showThinking = $('d-show-thinking').checked;
    const showSystem = $('d-show-system').checked;

    const lastEv = detail.events?.length ? detail.events[detail.events.length - 1] : null;
    const newLastStep = lastEv?.stepIndex ?? -1;
    const hasNewSteps = state.agentDetailConvId !== detail.conversationId || newLastStep > state.agentLastStepIdx;

    const detailSig = JSON.stringify([
      detail.conversationId,
      detail.totalEvents,
      detail.events?.length,
      newLastStep,
      lastEv?.outputTokens,
      lastEv?.toolOutput?.totalChars,
      detail.context?.usedTokens,
      state.showBreakdown,
      showTools,
      showThinking,
      showSystem,
    ]);
    if (state.sigs.detail === detailSig) return;
    state.sigs.detail = detailSig;
    state.agentDetailConvId = detail.conversationId;
    state.agentLastStepIdx = newLastStep;

    const ctx = detail.context || {};
    $('d-model').textContent = ctx.modelLabel || '未知模型';
    $('d-ctx-nums').textContent = `${fmtTok(ctx.usedTokens)} / ${fmtTok(ctx.maxContextTokens)} (${ctx.usedPct}%)`;
    $('d-cache').textContent = ctx.cacheHitRate != null ? `缓存 ${ctx.cacheHitRate}%` : '';

    const fill = $('d-ctx-fill');
    fill.style.width = `${Math.min(100, Number(ctx.usedPct || 0))}%`;
    fill.className = `progress-fill ${ctx.level || 'ok'}`;
    $('d-io-tokens').textContent = `输入 ${fmtTok(ctx.inputTokens)} · 缓存 ${fmtTok(ctx.cacheReadTokens)} · 输出 ${fmtTok(ctx.outputTokens)}${ctx.thinkingOutputTokens ? ` (思考 ${fmtTok(ctx.thinkingOutputTokens)})` : ''}`;

    const bdBox = $('d-breakdown-box');
    bdBox.classList.toggle('hidden', !state.showBreakdown);
    if (state.showBreakdown) {
      const groupsHtml = (ctx.groups || [])
        .map((g) => `<div class="bd-row"><span>${esc(g.name)}</span><span class="mono">${fmtTok(g.numTokens)}</span></div>`)
        .join('');
      const stepsHtml = (ctx.topSteps || [])
        .map((s) => `<div class="bd-row"><span>#${s.stepIndex >= 0 ? s.stepIndex : '-'} ${esc(s.toolName)}${s.summary ? `: ${esc(s.summary)}` : ''}</span><span class="mono">${fmtTok(s.numTokens)}</span></div>`)
        .join('');
      bdBox.innerHTML = `
        <div><div class="bd-subhead">分层 Token 构成</div>${groupsHtml || '<div class="muted small">暂无 LS 分解数据</div>'}</div>
        ${stepsHtml ? `<div><div class="bd-subhead">最重步骤 Top 8</div>${stepsHtml}</div>` : ''}
      `;
    }

    $('btn-load-earlier').classList.toggle('hidden', !detail.hasMore);
    $('detail-event-meta').textContent = `${detail.events.length} / ${detail.totalEvents} 步`;

    const visibleEvents = (detail.events || []).filter((ev) => {
      if (ev.kind === 'system' && !showSystem) return false;
      if (ev.kind === 'tool_result' && !showTools) return false;
      return true;
    });

    const streamEl = $('detail-chat-stream');
    if (!visibleEvents.length) {
      streamEl.innerHTML = '<div class="empty-body" style="padding:28px 0;text-align:center">当前过滤条件下无对话记录</div>';
      return;
    }

    streamEl.innerHTML = visibleEvents
      .map((ev) => {
        const timeStr = fmtClock(ev.createdAt);
        if (ev.kind === 'user') {
          const longKey = `user:${detail.conversationId}:${ev.stepIndex}`;
          const isOpen = state.expandedLongKeys.has(longKey);
          const isLong = ev.content.length > 320 || ev.content.split('\n').length > 6;
          return `
            <div class="turn-user">
              <div class="turn-meta"><strong>上级指令 / 用户输入</strong><span class="mono">#${ev.stepIndex} · ${esc(timeStr)}</span></div>
              <div class="md ${isLong ? `clamped ${isOpen ? 'open' : ''}` : ''}">${renderMarkdownSafe(ev.content)}</div>
              ${isLong ? `<button type="button" class="link-btn" data-toggle-long="${esc(longKey)}">${isOpen ? '收起' : '展开全文'}</button>` : ''}
            </div>
          `;
        }
        if (ev.kind === 'incoming_message') {
          if (ev.isCron) {
            const cKey = `cron:${detail.conversationId}:${ev.stepIndex}:${ev.subIndex || 0}`;
            const openAttr = state.openDetailsKeys.has(cKey) ? 'open' : '';
            return `
              <details class="turn-cron" data-dkey="${esc(cKey)}" ${openAttr}>
                <summary>⏱ 定时巡检触发 · ${esc(timeStr)}</summary>
                <div class="md" style="margin-top:6px">${renderMarkdownSafe(ev.content)}</div>
              </details>
            `;
          }
          const longKey = `in:${detail.conversationId}:${ev.stepIndex}:${ev.subIndex || 0}`;
          const isOpen = state.expandedLongKeys.has(longKey);
          const isLong = ev.content.length > 320 || ev.content.split('\n').length > 6;
          const senderBtn = ev.senderId
            ? `<button type="button" class="agent-link" style="font-size:12px" data-jump-sender="${esc(ev.senderId)}">来自 ${esc(ev.senderLabel)}</button>`
            : `<strong>来自 ${esc(ev.senderLabel)}</strong>`;
          return `
            <div class="turn-incoming">
              <div class="turn-meta">${senderBtn}<span class="mono">#${ev.stepIndex} · ${esc(timeStr)}</span></div>
              <div class="md ${isLong ? `clamped ${isOpen ? 'open' : ''}` : ''}">${renderMarkdownSafe(ev.content)}</div>
              ${isLong ? `<button type="button" class="link-btn" data-toggle-long="${esc(longKey)}">${isOpen ? '收起' : '展开全文'}</button>` : ''}
            </div>
          `;
        }
        if (ev.kind === 'system') {
          return `
            <div class="turn-system">
              <div class="turn-meta"><span>系统提示</span><span class="mono">#${ev.stepIndex} · ${esc(timeStr)}</span></div>
              <div class="md">${renderMarkdownSafe(ev.content.slice(0, 1800))}</div>
            </div>
          `;
        }
        if (ev.kind === 'checkpoint') {
          return `<div class="turn-checkpoint">压缩检查点 #${ev.stepIndex} · ${esc(ev.content || '')}</div>`;
        }
        if (ev.kind === 'tool_result') {
          if (ev.shortStatus && !ev.content) {
            return `<div class="tool-badge-ok">✓ ${esc(ev.shortStatus)}</div>`;
          }
          const dKey = `orphan:${detail.conversationId}:${ev.stepIndex}`;
          const openAttr = state.openDetailsKeys.has(dKey) ? 'open' : '';
          return `
            <details class="tool-line" data-dkey="${esc(dKey)}" ${openAttr}>
              <summary><span class="tool-verb">工具返回</span><span class="tool-target">${esc((ev.relatedTools || []).join(' | ') || `#${ev.stepIndex}`)}</span></summary>
              <pre class="code-pre">${esc(ev.content)}</pre>
            </details>
          `;
        }

        // Planner 回合
        const thinkKey = `think:${detail.conversationId}:${ev.stepIndex}`;
        const thinkHtml =
          showThinking && ev.thinking
            ? `<div class="turn-thinking"><details data-dkey="${esc(thinkKey)}" ${state.openDetailsKeys.has(thinkKey) ? 'open' : ''}><summary>思考过程 (${ev.thinking.length} 字)</summary><div class="turn-thinking-body">${esc(ev.thinking)}</div></details></div>`
            : '';

        let toolsHtml = '';
        if (showTools && (ev.toolCalls?.length || ev.toolOutput)) {
          const callsHtml = (ev.toolCalls || [])
            .map((tc, idx) => {
              const openFileBtn = tc.fileUri
                ? `<button type="button" class="tool-open-btn" data-open-file="${esc(tc.fileUri)}" title="在侧栏打开原文件">打开</button>`
                : '';
              if (tc.previewKind === 'none' || !tc.previewText) {
                return `
                  <div class="tool-static">
                    <span class="tool-verb">${esc(tc.actionLabel || tc.name)}</span>
                    <span class="tool-target" title="${esc(tc.target || tc.brief)}">${esc(tc.target || tc.brief)}</span>
                    ${openFileBtn}
                  </div>
                `;
              }
              const tKey = `tool:${detail.conversationId}:${ev.stepIndex}:${idx}`;
              const openAttr = state.openDetailsKeys.has(tKey) ? 'open' : '';
              return `
                <details class="tool-line" data-dkey="${esc(tKey)}" ${openAttr}>
                  <summary>
                    <span class="tool-verb">${esc(tc.actionLabel || tc.name)}</span>
                    <span class="tool-target" title="${esc(tc.target || tc.brief)}">${esc(tc.target || tc.brief)}</span>
                    ${openFileBtn}
                  </summary>
                  ${renderToolPreviewBody(tc)}
                </details>
              `;
            })
            .join('');

          let outHtml = '';
          if (ev.toolOutput) {
            const dur = ev.toolOutput.durationText ? ` · ${ev.toolOutput.durationText}` : '';
            if (ev.toolOutput.shortStatus && !ev.toolOutput.content) {
              outHtml = `<div class="tool-badge-ok">✓ ${esc(ev.toolOutput.shortStatus)}${esc(dur)}</div>`;
            } else if (ev.toolOutput.content) {
              const outKey = `out:${detail.conversationId}:${ev.stepIndex}`;
              const openAttr = state.openDetailsKeys.has(outKey) ? 'open' : '';
              outHtml = `<details data-dkey="${esc(outKey)}" ${openAttr}><summary class="tool-output-summary">查看执行输出 (${ev.toolOutput.totalChars} 字${esc(dur)}${ev.toolOutput.truncated ? ' · 已截断' : ''})</summary><pre class="code-pre">${esc(ev.toolOutput.content)}</pre></details>`;
            }
          }
          toolsHtml = `<div class="tool-group">${callsHtml}${outHtml}</div>`;
        }

        const replyHtml = ev.content ? `<div class="turn-reply md">${renderMarkdownSafe(ev.content)}</div>` : '';
        if (!thinkHtml && !toolsHtml && !replyHtml) return '';

        return `
          <div class="turn-planner">
            <div class="turn-meta">
              <span>${esc(ev.modelLabel || '')}</span>
              <span class="mono">#${ev.stepIndex} · in ${fmtTok(ev.inputTokens + ev.cacheReadTokens)} · out ${fmtTok(ev.outputTokens)} · ${esc(timeStr)}</span>
            </div>
            ${thinkHtml}
            ${toolsHtml}
            ${replyHtml}
          </div>
        `;
      })
      .join('');

    streamEl.querySelectorAll('details[data-dkey]').forEach((det) => {
      det.addEventListener('toggle', () => {
        const key = det.dataset.dkey;
        if (det.open) state.openDetailsKeys.add(key);
        else state.openDetailsKeys.delete(key);
      });
    });

    streamEl.querySelectorAll('[data-toggle-long]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.toggleLong;
        if (state.expandedLongKeys.has(key)) state.expandedLongKeys.delete(key);
        else state.expandedLongKeys.add(key);
        state.sigs.detail = '';
        renderAgentDetail({ allowAutoScroll: false });
      });
    });

    streamEl.querySelectorAll('[data-jump-sender]').forEach((btn) => {
      btn.addEventListener('click', () => openAgentDetail(btn.dataset.jumpSender));
    });

    if (allowAutoScroll && hasNewSteps && state.followBottom && isFollowableViewActive()) {
      requestAnimationFrame(() => scrollToBottomSmooth(true));
    }
  }

  async function loadAgentDetail(convId, limit = 150, { preserveScroll = false, allowAutoScroll = false } = {}) {
    if (!convId) return;
    const prevScrollH = preserveScroll ? document.documentElement.scrollHeight : 0;
    const prevScrollY = preserveScroll ? window.scrollY : 0;
    try {
      const res = await apiFetch(`/api/agent?conversationId=${encodeURIComponent(convId)}&limit=${limit}`, { method: 'GET' });
      const data = await res.json();
      if (state.selectedAgentId === convId) {
        state.agentDetail = data;
        renderAgentDetail({ allowAutoScroll: !preserveScroll && allowAutoScroll });
        if (preserveScroll) {
          requestAnimationFrame(() => {
            const delta = document.documentElement.scrollHeight - prevScrollH;
            window.scrollTo({ top: prevScrollY + Math.max(0, delta), behavior: 'auto' });
          });
        }
      }
    } catch {
      // 忽略单次刷新抖动
    }
  }

  // ---------- 5. Teamwork 工件 ----------
  async function selectTeamworkDoc(doc) {
    if (!doc) return;
    state.selectedTwPath = doc.absPath;
    state.sigs.teamwork = '';
    renderTeamwork();
    if (state.activeTab === 'teamwork') {
      window.scrollTo({ top: 0, behavior: 'auto' });
    }

    $('tw-doc-title').textContent = doc.relPath;
    $('tw-doc-meta').textContent = `${fmtRelTime(doc.updatedAt)} · ${Math.max(1, Math.ceil((doc.size || 0) / 1024))} KB`;
    const openBtn = $('btn-tw-open-file');
    openBtn.classList.remove('hidden');
    openBtn.onclick = () => openFileInSidePane(doc.fileUri);

    const cached = state.twDocCache.get(doc.absPath);
    if (cached && cached.updatedAt === doc.updatedAt) {
      $('tw-doc-body').innerHTML = renderMarkdownSafe(cached.content);
      return;
    }

    $('tw-doc-body').innerHTML = '<div class="muted small">正在读取文档…</div>';
    try {
      const res = await apiFetch(`/api/teamwork-doc?path=${encodeURIComponent(doc.absPath)}`, { method: 'GET' });
      const data = await res.json();
      if (!res.ok) {
        $('tw-doc-body').innerHTML = `<div class="muted small">${esc(data.error || '读取失败')}</div>`;
        return;
      }
      state.twDocCache.set(doc.absPath, { updatedAt: doc.updatedAt, content: data.content });
      $('tw-doc-body').innerHTML = renderMarkdownSafe(data.content);
    } catch {
      $('tw-doc-body').innerHTML = '<div class="muted small">读取文档失败</div>';
    }
  }

  function renderTeamwork() {
    const docs = state.group?.teamwork?.docs || [];
    if (!docs.length) return;

    const twSig = JSON.stringify([
      state.selectedTwCategory,
      state.selectedTwPath,
      docs.map((d) => [d.absPath, d.updatedAt]),
    ]);
    if (state.sigs.teamwork === twSig) return;
    state.sigs.teamwork = twSig;

    const CATS = [
      ['all', '全部'],
      ['plan', '蓝图'],
      ['progress', '进度'],
      ['handoff', '调研'],
      ['brief', '派单'],
    ];
    $('tw-cat-pills').innerHTML = CATS.map(
      ([k, label]) => `<button type="button" class="cat-pill ${state.selectedTwCategory === k ? 'on' : ''}" data-tw-cat="${k}">${label}</button>`,
    ).join('');
    $('tw-cat-pills').querySelectorAll('[data-tw-cat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.selectedTwCategory = btn.dataset.twCat;
        state.sigs.teamwork = '';
        renderTeamwork();
      });
    });

    const filtered = state.selectedTwCategory === 'all' ? docs : docs.filter((d) => d.category === state.selectedTwCategory);
    if (!filtered.some((d) => d.absPath === state.selectedTwPath)) {
      if (filtered.length) {
        selectTeamworkDoc(filtered[0]);
        return;
      }
    }

    const sel = $('tw-doc-select');
    sel.innerHTML = filtered.map((d) => `<option value="${esc(d.absPath)}">${esc(d.relPath)}</option>`).join('');
    sel.value = state.selectedTwPath;

    $('tw-doc-list').innerHTML = filtered
      .map(
        (d) => `
          <button type="button" class="tw-doc-btn ${d.absPath === state.selectedTwPath ? 'active' : ''}" data-tw-path="${esc(d.absPath)}">
            <span class="small" style="word-break:break-all">${esc(d.relPath)}</span>
            <span class="muted" style="font-size:10px">${esc(fmtRelTime(d.updatedAt))}</span>
          </button>
        `,
      )
      .join('');

    $('tw-doc-list').querySelectorAll('[data-tw-path]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const found = filtered.find((d) => d.absPath === btn.dataset.twPath);
        if (found) selectTeamworkDoc(found);
      });
    });
  }

  // ---------- 主轮询 ----------
  async function refreshGroup() {
    const conv = currentConv();
    if (!conv) {
      $('main-loading').classList.add('hidden');
      $('app').classList.add('hidden');
      $('main-empty').classList.remove('hidden');
      return;
    }

    try {
      const res = await apiFetch(`/api/group?conversationId=${encodeURIComponent(conv)}`, { method: 'GET' });
      const data = await res.json();

      if (data.status === 'no-conversation' || data.status === 'empty') {
        $('main-loading').classList.add('hidden');
        $('app').classList.add('hidden');
        $('main-empty').classList.remove('hidden');
        return;
      }
      if (data.status === 'error') {
        $('main-loading').classList.add('hidden');
        $('app').classList.add('hidden');
        $('main-empty').classList.remove('hidden');
        $('empty-reason').textContent = data.error || '加载失败';
        return;
      }

      // 切换到了另一组会话时重置视图状态
      if (state.lastRootId && state.lastRootId !== data.rootConversationId) {
        state.detailOpen = false;
        state.selectedAgentId = '';
        state.agentDetail = null;
        state.agentDetailConvId = '';
        state.agentLastStepIdx = -1;
        state.selectedTwPath = '';
        state.collapsedNodes.clear();
        state.openDetailsKeys.clear();
        state.expandedLongKeys.clear();
        state.sigs = { summary: '', tree: '', messages: '', detail: '', teamwork: '' };
        $('workspace').classList.remove('detail-open');
      }
      state.lastRootId = data.rootConversationId || '';

      state.group = data;
      $('main-loading').classList.add('hidden');
      $('main-empty').classList.add('hidden');
      $('app').classList.remove('hidden');

      renderSummary(data);
      syncAgentSelector();
      renderTree();
      renderMessages();
      if (data.teamwork?.detected) renderTeamwork();

      const wide = $('workspace')?.clientWidth >= 680;
      if (state.activeTab === 'overview' && (state.detailOpen || wide) && state.selectedAgentId) {
        const node = (data.nodes || []).find((n) => n.conversationId === state.selectedAgentId);
        if (!state.agentDetail || node?.status === 'running' || node?.status === 'cancelling') {
          loadAgentDetail(state.selectedAgentId, state.agentLimit, { allowAutoScroll: true });
        }
      }
    } catch {
      $('live-status').className = 'live error';
      $('live-label').textContent = '连接中断';
    }
  }

  function schedulePoll() {
    clearTimeout(state.pollTimer);
    const delay = document.hidden ? HIDDEN_POLL_MS : VISIBLE_POLL_MS;
    state.pollTimer = setTimeout(async () => {
      await refreshGroup();
      schedulePoll();
    }, delay);
  }

  // ---------- 事件绑定 ----------
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  $('btn-refresh').addEventListener('click', () => {
    state.sigs = { summary: '', tree: '', messages: '', detail: '', teamwork: '' };
    refreshGroup();
    if (state.selectedAgentId) loadAgentDetail(state.selectedAgentId, state.agentLimit, { allowAutoScroll: false });
  });

  $('tree-filter-toggle').addEventListener('click', () => {
    const f = $('tree-filters');
    const open = f.classList.toggle('hidden');
    $('tree-filter-toggle').setAttribute('aria-expanded', open ? 'false' : 'true');
  });

  $('msg-filter-toggle').addEventListener('click', () => {
    const f = $('msg-filters');
    const open = f.classList.toggle('hidden');
    $('msg-filter-toggle').setAttribute('aria-expanded', open ? 'false' : 'true');
  });

  $('tree-search').addEventListener('input', renderTree);
  $('tree-hide-killed').addEventListener('change', renderTree);
  $('tree-only-active').addEventListener('change', renderTree);
  $('btn-toggle-expand').addEventListener('click', () => {
    const nodes = state.group?.nodes || [];
    if (!state.allCollapsed) {
      nodes.forEach((n) => {
        if (n.childrenIds?.length && !n.isRoot) state.collapsedNodes.add(n.conversationId);
      });
      state.allCollapsed = true;
      $('btn-toggle-expand').textContent = '全部展开';
    } else {
      state.collapsedNodes.clear();
      state.allCollapsed = false;
      $('btn-toggle-expand').textContent = '全部折叠';
    }
    state.sigs.tree = '';
    renderTree();
  });

  $('btn-back-overview').addEventListener('click', () => setDetailOpen(false, true));
  $('detail-agent-select').addEventListener('change', (e) => openAgentDetail(e.target.value));
  $('btn-open-conv').addEventListener('click', () => openNativeConversation(state.selectedAgentId));
  $('btn-toggle-breakdown').addEventListener('click', () => {
    state.showBreakdown = !state.showBreakdown;
    $('btn-toggle-breakdown').textContent = state.showBreakdown ? '收起明细' : '分层明细';
    state.sigs.detail = '';
    renderAgentDetail({ allowAutoScroll: false });
  });
  $('d-show-tools').addEventListener('change', () => { state.sigs.detail = ''; renderAgentDetail({ allowAutoScroll: false }); });
  $('d-show-thinking').addEventListener('change', () => { state.sigs.detail = ''; renderAgentDetail({ allowAutoScroll: false }); });
  $('d-show-system').addEventListener('change', () => { state.sigs.detail = ''; renderAgentDetail({ allowAutoScroll: false }); });
  $('btn-load-earlier').addEventListener('click', () => {
    state.agentLimit = Math.min(500, state.agentLimit + 150);
    state.sigs.detail = '';
    loadAgentDetail(state.selectedAgentId, state.agentLimit, { preserveScroll: true, allowAutoScroll: false });
  });

  $('msg-agent-filter').addEventListener('change', renderMessages);
  $('msg-hide-cron').addEventListener('change', renderMessages);
  $('msg-search').addEventListener('input', renderMessages);

  $('tw-doc-select').addEventListener('change', (e) => {
    const found = (state.group?.teamwork?.docs || []).find((d) => d.absPath === e.target.value);
    if (found) selectTeamworkDoc(found);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.activeTab === 'overview' && state.detailOpen) {
      setDetailOpen(false, true);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshGroup();
    schedulePoll();
  });

  refreshGroup().then(schedulePoll);
})();
