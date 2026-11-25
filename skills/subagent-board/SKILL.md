---
name: subagent-board
description: 打开子代理组可视化看板或巡检当前会话的整棵子代理树（兼容 /teamwork、invoke_subagent、run_workflow、team-* 与 /swarm），汇总每个子代理的运行状态、所用模型、上下文 Token 消耗、代理间消息流与异常排查。当用户要求查看子代理进度、子代理对话、模型或上下文消耗时使用。
---

# Subagent Board（子代理组看板）

面向 Antigravity 2.0 桌面端的通用子代理组可视化插件，零侵入、零额外 Token 消耗。

## 1. 一键打开右侧辅助栏看板

确认插件处于启用状态后，直接在回复中输出如下 `sidecar://` 胶囊链接，用户点击即可在右侧辅助栏展开实时看板：

```markdown
[子代理组看板](sidecar://subagent-board/subagent_board/)
```

## 2. 文字版子代理组巡检（仅当用户明确要求汇总或排查时执行）

如需在对话内直接输出巡检摘要，可按以下只读路径检查当前会话及其根/子会话数据（严禁修改或写入）：

1. **定位子代理元数据**：检查 `~/.gemini/antigravity/brain/<conversationId>/.system_generated/subagents/*.json`（包含 `subagentDescriptor.typeName`、`subagentDescriptor.role`、`state`、`spawnStepIndex`），并可递归追踪子代理目录下的同级 `subagents/`。若为原生 `/swarm` 会话（即使不存在 `subagents/` 目录），还需检查根会话的 `~/.gemini/antigravity/brain/<rootConversationId>/.system_generated/swarm/{swarm.json,members.json,plan.json}` 获取完整成员列表、模型、工作区模式、任务分配与 `killed` 状态。
2. **检查活动与模型/Token**：读取对应子代理的 `~/.gemini/antigravity/brain/<childId>/.system_generated/logs/transcript.jsonl` 尾部 `PLANNER_RESPONSE`（含 `model`、`input_tokens`、`cache_read_tokens`、`output_tokens`、`tool_calls`、`status`）。
3. **检查代理间消息与群板**：读取 `.system_generated/messages/*.json`（忽略 `read.json`），汇总 `sender`、`recipient`、`timestamp` 与 `renderDetails.messageTitle`；若存在 `~/.gemini/antigravity/brain/<rootConversationId>/.system_generated/swarm/board.jsonl`，直接读取各行 `{ seq, agent, text, time, kind }` 以还原真实群聊消息内容，避免仅看到 `[swarm] new board message #N` 唤醒壳。
4. **检查 Teamwork 工件**：若存在 `~/.gemini/antigravity/scratch/teamwork/<id>/.agents/teamwork/`，只读查看 `PROJECT.md` 与各节点的 `progress.md` / `handoff.md`。
