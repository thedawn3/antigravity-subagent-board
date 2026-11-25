# Antigravity Subagent Board（子代理组看板）

面向 **Google Antigravity 2.0** 的通用子代理组可视化插件（纯官方 Sidecar UI 规范，零非官方 DOM 注入、零额外 Token 消耗）。

无论通过 `/teamwork` 多层架构师/探索者/审校者编排、直接调用 `invoke_subagent`、`run_workflow`、`team-*` 技能还是 `/swarm`，均可在一个侧栏面板中直观查看整棵子代理树的运行状态、所用模型、上下文消耗、代理间消息流与完整对话轨迹。

---

## 核心特性

1. **子代理树（总览）**：
   - 自动从当前子会话向上溯源至 `rootConversationId` 并向下递归构建整棵子代理树；
   - 置顶「正在执行 / 需关注（报错或上下文 ≥ 75%）」焦点区，运行中节点附带原生流光动效；
   - 单色极简层级树，对齐展示每个节点的**状态点**、**角色名**、**实际使用模型**（如 `Hydrogen · High`、`Neon · XHigh`）、**上下文水位微条**与**中文化动作摘要**（自动剥离冗长工作区前缀与冗余 `cd`）；
   - 支持按角色/模型/活动检索、隐藏已终止节点、一键切入原会话。
2. **容器宽度自适应（Master-Detail）**：
   - 窄侧栏（`< 680px`）下采用分步导航，详情页固定 Sticky 顶栏（`← 返回总览` 随时可见，支持 `Esc` 返回并恢复滚动位置）；
   - 拉宽侧栏（`>= 680px`）自动切换为左树右详情双栏联动视图。
3. **可读性优化的对话流与上下文拆解**：
   - 自动将 `<SYSTEM_MESSAGE>` 中包裹的代理间派单与回报拆包为清晰的「来自 `<发送方>`」消息卡片（Cron 心跳自动折叠）；
   - 还原双重转义参数，将 `send_message` / `invoke_subagent` / `write_file(.md)` 渲染为可读 Markdown，剔除重复时间戳并将纯状态返回收敛为行尾徽标；
   - 内置单代理上下文分层明细（System Prompt / Rules / Skills / MCP / Chat 及最重步骤 Top 8）与智能滚底（上滑自动停止强拽并浮现 `↓ 最新` 胶囊）。
4. **消息板与 Teamwork 工件预览**：
   - 聚合整棵树内所有 `.system_generated/messages/*.json` 跨节点消息流，支持按成员过滤与隐藏 Cron 心跳；
   - 检测到 `scratch/teamwork/<id>/.agents/teamwork/` 时自动显示「工件」Tab，支持按分类预览 `PROJECT.md`、`progress.md`、`handoff.md` 等并一键在侧栏打开原文件。

---

## 零侵入与性能设计

- **只读数据源**：仅读取本地 Language Server Connect 接口（`GetConversation`、`GetCascadeTrajectoryGeneratorMetadata`、`GetCascadeTrajectory`、`GetUserStatus`）及本机 `~/.gemini/antigravity/brain/`（兼容 `antigravity-ide` / `antigravity-cli`）下的只读运行目录。
- **零外部依赖**：后端与前端均基于 Node.js 内置模块与原生 Web 能力构建，无需 `npm install`。
- **分级缓存与节流**：`GetUserStatus` 模型目录缓存 5 分钟；`transcript.jsonl` 按 `mtimeMs:size:ino` 与字节偏移增量读取；闲置/已终止节点大幅降频或零重复 RPC，LS 并发池默认并发度 4。
- **跨平台路径适配**：支持 macOS（`/Users/...`）、Linux（`/home/...`）及 Windows（`C:\Users\...`）路径缩写与安全文件预览校验。

---

## 安装方式

将本仓库克隆（或软链接）到 Antigravity 全局插件目录即可自动热加载，无需重启客户端：

```bash
git clone https://github.com/thedawn3/antigravity-subagent-board.git ~/.gemini/config/plugins/subagent-board
```

启用与使用：

1. 在 Antigravity **Customizations / Plugins** 中确认启用 **子代理组看板 (Subagent Board)**。
2. 点击右侧辅助栏 `+` 号选择 **子代理组看板**，或在任意对话输入 `/subagent-board` 获取一键打开胶囊。

---

## 本地开发与测试

语法检查与单元测试（零外部依赖，仅使用 Node.js 内置 `node:test`）：

```bash
node --check \
  sidecars/subagent_board/main.mjs \
  sidecars/subagent_board/lib/format_helpers.mjs \
  sidecars/subagent_board/lib/ls_client.mjs \
  sidecars/subagent_board/lib/tree_scanner.mjs \
  sidecars/subagent_board/lib/transcript_reader.mjs \
  sidecars/subagent_board/app.js

node --test tests/unit.test.mjs
```

---

## 隐私与安全说明

- 本插件**不收集、不上传任何遥测数据**，所有会话数据仅在本机回环接口与本地浏览器视图中渲染。
- Teamwork 工件读取接口 `/api/teamwork-doc` 通过 `realpath` 严格限制仅允许访问本机 `scratch/teamwork/` 目录内的常规文件，拒绝路径穿越访问。

## License

[MIT](./LICENSE)
