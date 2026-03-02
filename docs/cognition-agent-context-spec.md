# Cognition Agent Context Spec

## 1. Context Input Hierarchy

```yaml
context_input:
  system_prompt:
    soul: string|null
    role: string
    workflow: string
    rule: string
    note_struct:
      paper_template: string
      textbook_template: string
      section_template: string
    tool_introduction_and_help: string
    file_permissions_and_user_view_list:
      read: object[]
      write: object[]
      none: object[]
      total: int
  memory:
    lifecycle: "session"
    compact:
      lifecycle: "session"
      trigger:
        context_window_tokens: 256000
        trigger_ratio: 0.8
      latest:
        compaction_id: string|null
        sequence: int
        summary: string
        key_state:
          current_goal: string|null
          current_material: string|null
          current_section: string|null
          next_step: string|null
        hard_constraints: string[]
        temporary_decisions: string[]
        unwritten_conclusions: string[]
        open_loops: string[]
        updated_at: string|null
      history_tail: object[]
    epoch:
      lifecycle: "epoch"
      epoch_id: string
      state: "planning|executing|blocked|done|cancelled"
      started_at: string
      updated_at: string
      dialogue:
        lifecycle: "epoch"
        latest_user_goal: string|null
        current_focus:
          book: string|null
          section: string|null
        next_action: string|null
        recent_turns: object[]
      tool_history:
        lifecycle: "epoch"
        calls: object[]
        stats:
          total: int
          failed: int
          write_ops: int
      task_list:
        lifecycle: "epoch"
        items: object[]
        counts:
          total: int
          running: int
          waiting: int
          completed: int
```

## 2. System Prompt Content Rules

- `Soul`: 可选，默认 `null`（当前无前端输入）。
- `Role` / `Workflow` / `Note Struct`: 按 PDF 明确内容直接注入。
- `Rule`: 已补全（编辑规则、检索规则、任务规则、澄清规则、compact rule）。
- `Tool Introduction&Help`: 已补全（检索、编辑、任务、交互、权限）。
- `file_permissions_and_user_view_list`: 运行时由 manifest 注入，反映 read/write/none 视野。

## 3. Memory Lifecycle and Storage

- `memory.lifecycle = session`：会话级保留。
- `epoch.lifecycle = epoch`：`epoch_id = task_id`，任务完成/阻塞/取消后结束该 epoch。
- `tool_history.calls` 在当前 epoch 内全量保存（含完整返回内容）。
- 持久化主存：`SessionTaskState.artifacts_json.memory_epoch`。
- compact 主存：`ConversationCompaction.key_facts_json.memory_snapshot`。

## 4. Tool History Contract (includes full tool return)

`memory.epoch.tool_history.calls[]` 固定字段：

1. `index`
2. `tool`
3. `arguments_full`
4. `result_full`（完整 `ToolResult.to_dict()`）
5. `success`
6. `error_code`
7. `started_at`
8. `ended_at`
9. `action_kind`
10. `target_file_id`
11. `arguments_digest`
12. `result_digest`

规则：

- 记录层必须保留 `result_full` 完整对象。
- 注入层默认只用 digest，并在 token 预算允许时附带最近 N 条完整 `arguments_full/result_full`。
- pause/resume checkpoint 必须同步 `memory_epoch`，保证 `result_full` 不丢失。

## 5. Compact Protocol (Main Model First)

- 触发条件：`estimated_tokens >= MODEL_CONTEXT_WINDOW_TOKENS * COMPACT_TRIGGER_RATIO`。
  - 默认：`256000 * 0.8`。
- 触发时机：本轮模型调用前。
- 输入：`compact_rule + compact.latest + older_messages + epoch hints`。
- 输出 schema：
  - `summary`
  - `key_state` (`current_goal/current_material/current_section/next_step`)
  - `hard_constraints`
  - `temporary_decisions`
  - `unwritten_conclusions`
  - `open_loops`
- 失败回退：主模型 compact 失败时启发式 compact 兜底，不中断请求。

## 5.1 Compact Token Window Stats

`compact_meta` 必须包含 `token_window` 统计，且输入占比口径包含 `system + dialogue + memory + other`：

- `token_window.context_window_tokens`
- `token_window.trigger_ratio`
- `token_window.trigger_tokens`
- `token_window.before_total_input_tokens`
- `token_window.before_messages_tokens`
- `token_window.before_occupancy_ratio`
- `token_window.components.system_tokens`
- `token_window.components.dialogue_tokens`
- `token_window.components.memory_tokens`
- `token_window.components.other_tokens`
- `token_window.components.*_ratio`
- 触发并完成 compact 时额外包含：
  - `token_window.after_total_input_tokens`
  - `token_window.after_messages_tokens`
  - `token_window.after_occupancy_ratio`

口径约定：

- `compact_meta.before_tokens = token_window.before_total_input_tokens`（已包含 memory）。
- `compact_meta.before_messages_tokens` 仅统计消息列表（含 system/user/assistant）。

## 6. Compatibility

为兼容已有消费者，manifest 继续暴露：

- `retrieval_refs`（兼容 `retrieved_context_refs`）
- `task_state`（兼容 `task_state_snapshot`）
- `memory`（兼容 `context_input.memory`）
