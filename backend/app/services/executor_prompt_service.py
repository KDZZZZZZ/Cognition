from typing import Any, Dict, List, Optional, Sequence

from app.prompts.system_prompts import SystemPrompts


def build_permission_summary(permissions: Dict[str, str], permitted_files_info: Dict[str, Dict[str, str]]) -> str:
    read_lines: List[str] = []
    write_lines: List[str] = []
    hidden_lines: List[str] = []
    for file_id, info in permitted_files_info.items():
        perm = str((permissions or {}).get(file_id, "read"))
        line = f"- {info.get('name') or file_id} ({file_id}) [{info.get('type') or 'unknown'}] - {perm}"
        if perm == "write":
            write_lines.append(line)
        elif perm == "none":
            hidden_lines.append(line)
        else:
            read_lines.append(line)

    extras = []
    for file_id, perm in (permissions or {}).items():
        if perm == "none" and file_id not in permitted_files_info:
            extras.append(f"- {file_id} - none")
    hidden_lines.extend(extras)

    parts = ["Permissions Summary"]
    if write_lines:
        parts.append("[Writable Files]\n" + "\n".join(write_lines))
    if read_lines:
        parts.append("[Readable Files]\n" + "\n".join(read_lines))
    if hidden_lines:
        parts.append("[Hidden Files]\n" + "\n".join(hidden_lines))
    return "\n\n".join(parts)


def build_task_summary(router_result: Dict[str, Any], task_state: Optional[Dict[str, Any]]) -> str:
    task = router_result.get("task") if isinstance(router_result.get("task"), dict) else {}
    items = task.get("items") if isinstance(task.get("items"), list) else []
    lines = ["Task Summary", f"Goal: {task.get('goal') or ''}"]
    if task_state:
        lines.append(
            f"State: {task_state.get('state')} ({task_state.get('current_step', 0)}/{task_state.get('total_steps', 0)})"
        )
    if task.get("next_action"):
        lines.append(f"Next Action: {task.get('next_action')}")
    if items:
        lines.append("Items:")
        for item in items:
            if not isinstance(item, dict):
                continue
            lines.append(
                f"- [{item.get('status') or 'waiting'}] {item.get('name') or 'Unnamed'}"
                + (f": {item.get('description')}" if item.get('description') else "")
            )
    return "\n".join(lines)


def build_tool_policy_summary(router_result: Dict[str, Any], tools: Sequence[Dict[str, Any]]) -> str:
    tool_cfg = router_result.get("tool") if isinstance(router_result.get("tool"), dict) else {}
    tool_names = []
    for tool in tools:
        fn = tool.get("function") if isinstance(tool, dict) else None
        name = str((fn or {}).get("name") or "").strip()
        if name:
            tool_names.append(name)
    parts = [
        "Tool Policy",
        f"Execution Mode: {tool_cfg.get('execution_mode') or 'mixed'}",
        f"Allowed Groups: {', '.join(tool_cfg.get('allowed_groups') or []) or 'none'}",
        f"Preferred Tools: {', '.join(tool_cfg.get('preferred_tools') or []) or 'none'}",
        f"Forbidden Tools: {', '.join(tool_cfg.get('forbidden_tools') or []) or 'none'}",
        f"Max Rounds: {tool_cfg.get('max_rounds') or 6}",
        f"Exposed Tools: {', '.join(tool_names) or 'none'}",
    ]
    return "\n".join(parts)


def build_executor_sections(
    *,
    router_result: Dict[str, Any],
    workflows: Sequence[Dict[str, Any]],
    templates: Sequence[Dict[str, Any]],
    permissions: Dict[str, str],
    permitted_files_info: Dict[str, Dict[str, str]],
    task_state: Optional[Dict[str, Any]],
    viewport_memory_summary: Optional[str],
    compact_summary: Optional[str],
    tools: Sequence[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    sections: List[Dict[str, Any]] = [
        {
            "key": "invariant_core",
            "title": "Invariant Core Rules",
            "text": SystemPrompts.invariant_core_prompt(),
            "priority": 1000,
            "required": True,
        },
        {
            "key": "router_brief",
            "title": "Router Brief",
            "text": str(router_result.get("executor_brief") or ""),
            "priority": 950,
            "required": True,
        },
    ]

    for item in workflows:
        sections.append(
            {
                "key": f"workflow:{item['id']}",
                "title": f"Workflow: {item['id']}",
                "text": item.get("text") or "",
                "priority": 800 + int(item.get("priority") or 0),
                "required": item.get("id") == "general",
            }
        )
    for item in templates:
        sections.append(
            {
                "key": f"template:{item['id']}",
                "title": f"Template: {item['id']}",
                "text": item.get("text") or "",
                "priority": 700 + int(item.get("priority") or 0),
                "required": False,
            }
        )

    sections.extend(
        [
            {
                "key": "permissions",
                "title": "Permission Summary",
                "text": build_permission_summary(permissions, permitted_files_info),
                "priority": 650,
                "required": True,
            },
            {
                "key": "task_summary",
                "title": "Task Summary",
                "text": build_task_summary(router_result, task_state),
                "priority": 640,
                "required": True,
            },
            {
                "key": "viewport_memory",
                "title": "Viewport Document Memory",
                "text": viewport_memory_summary or "No active viewport memory.",
                "priority": 630,
                "required": False,
            },
            {
                "key": "compaction_summary",
                "title": "Compaction Summary",
                "text": compact_summary or "No compacted dialogue block.",
                "priority": 620,
                "required": False,
            },
            {
                "key": "tool_policy",
                "title": "Tool Policy",
                "text": build_tool_policy_summary(router_result, tools),
                "priority": 610,
                "required": True,
            },
        ]
    )
    return sections


def render_executor_system_prompt(sections: Sequence[Dict[str, Any]]) -> str:
    blocks = []
    for section in sections:
        text = str(section.get("text") or "").strip()
        if not text:
            continue
        title = str(section.get("title") or section.get("key") or "Section").strip()
        blocks.append(f"[{title}]\n{text}")
    return "\n\n".join(blocks)


def build_step_registry_summary(
    registry_snapshot: Dict[str, Any],
    *,
    active_task: Dict[str, Any],
    active_step: Dict[str, Any],
) -> str:
    tasks = registry_snapshot.get("tasks") if isinstance(registry_snapshot.get("tasks"), list) else []
    lines = [
        "Task Registry Summary",
        f"Registry: {registry_snapshot.get('registry_id')}",
        f"Registry Status: {registry_snapshot.get('status')}",
        f"Active Task: {active_task.get('goal') or active_task.get('task_id')}",
        f"Current Step: {active_step.get('type')} ({active_step.get('index')}/{max(int(active_task.get('total_steps') or 1) - 1, 0)})",
    ]
    if tasks:
        lines.append("Tasks:")
        for task in tasks:
            if not isinstance(task, dict):
                continue
            lines.append(
                f"- [{task.get('status')}] {task.get('goal')}"
                f" ({task.get('current_step_index')}/{task.get('total_steps')})"
            )
    return "\n".join(lines)


def build_step_tool_policy_summary(step_definition: Dict[str, Any], tools: Sequence[Dict[str, Any]]) -> str:
    tool_names = []
    for tool in tools:
        fn = tool.get("function") if isinstance(tool, dict) else None
        name = str((fn or {}).get("name") or "").strip()
        if name:
            tool_names.append(name)
    parts = [
        "Step Tool Policy",
        f"Allowed Groups: {', '.join(step_definition.get('allowed_tool_groups') or []) or 'none'}",
        f"Writeback Policy: {step_definition.get('writeback_policy') or 'never'}",
        f"Result Kind: {step_definition.get('result_kind') or 'answer'}",
        f"Exposed Tools: {', '.join(tool_names) or 'none'}",
    ]
    return "\n".join(parts)


def build_router_tool_hints_summary(router_tool_hints: Optional[Dict[str, Any]]) -> str:
    hints = router_tool_hints if isinstance(router_tool_hints, dict) else {}
    allowed_groups = [str(item or "").strip() for item in (hints.get("allowed_groups") or []) if str(item or "").strip()]
    preferred_tools = [str(item or "").strip() for item in (hints.get("preferred_tools") or []) if str(item or "").strip()]
    forbidden_tools = [str(item or "").strip() for item in (hints.get("forbidden_tools") or []) if str(item or "").strip()]
    execution_mode = str(hints.get("execution_mode") or "mixed").strip() or "mixed"
    max_rounds = hints.get("max_rounds")
    return "\n".join(
        [
            "Router Tool Hints",
            f"Execution Mode: {execution_mode}",
            f"Allowed Groups Hint: {', '.join(allowed_groups) if allowed_groups else 'none'}",
            f"Preferred Tools Hint: {', '.join(preferred_tools) if preferred_tools else 'none'}",
            f"Forbidden Tools Hint: {', '.join(forbidden_tools) if forbidden_tools else 'none'}",
            f"Max Rounds Hint: {max_rounds if max_rounds is not None else 6}",
        ]
    )


def build_step_executor_sections(
    *,
    global_rules_text: str,
    step_definition: Dict[str, Any],
    registry_snapshot: Dict[str, Any],
    active_task: Dict[str, Any],
    active_step: Dict[str, Any],
    permissions: Dict[str, str],
    permitted_files_info: Dict[str, Dict[str, str]],
    viewport_memory_summary: Optional[str],
    compact_summary: Optional[str],
    tools: Sequence[Dict[str, Any]],
    previous_step_outputs_text: Optional[str],
    router_tool_hints: Optional[Dict[str, Any]] = None,
    retrieval_summary_text: Optional[str] = None,
) -> List[Dict[str, Any]]:
    sections: List[Dict[str, Any]] = [
        {
            "key": "invariant_core",
            "title": "Invariant Core Rules",
            "text": SystemPrompts.invariant_core_prompt(),
            "priority": 1000,
            "required": True,
        },
        {
            "key": "global_rules",
            "title": "Global Hard Rules",
            "text": global_rules_text,
            "priority": 980,
            "required": True,
        },
        {
            "key": "task_summary",
            "title": "Task Registry Summary",
            "text": build_step_registry_summary(
                registry_snapshot,
                active_task=active_task,
                active_step=active_step,
            ),
            "priority": 950,
            "required": True,
        },
        {
            "key": "step_rules",
            "title": f"Step Rules: {step_definition.get('type')}",
            "text": str(step_definition.get("rules_text") or ""),
            "priority": 920,
            "required": True,
        },
        {
            "key": "step_method",
            "title": f"Step Method: {step_definition.get('type')}",
            "text": str(step_definition.get("method_text") or ""),
            "priority": 900,
            "required": True,
        },
        {
            "key": "step_template",
            "title": f"Step Template: {step_definition.get('type')}",
            "text": str(step_definition.get("template_text") or ""),
            "priority": 880,
            "required": False,
        },
        {
            "key": "permissions",
            "title": "Permission Summary",
            "text": build_permission_summary(permissions, permitted_files_info),
            "priority": 850,
            "required": True,
        },
        {
            "key": "viewport_memory",
            "title": "Viewport Document Memory",
            "text": viewport_memory_summary or "No active viewport memory.",
            "priority": 820,
            "required": False,
        },
        {
            "key": "retrieval_summary",
            "title": "Retrieved Evidence Summary",
            "text": retrieval_summary_text or "No retrieved evidence summary for this step.",
            "priority": 815,
            "required": False,
        },
        {
            "key": "previous_step_outputs",
            "title": "Previous Step Outputs",
            "text": previous_step_outputs_text or "No previous step outputs in this request.",
            "priority": 810,
            "required": False,
        },
        {
            "key": "compaction_summary",
            "title": "Compaction Summary",
            "text": compact_summary or "No compacted dialogue block.",
            "priority": 800,
            "required": False,
        },
        {
            "key": "tool_policy",
            "title": "Step Tool Policy",
            "text": build_step_tool_policy_summary(step_definition, tools),
            "priority": 780,
            "required": True,
        },
        {
            "key": "router_tool_hints",
            "title": "Router Tool Hints",
            "text": build_router_tool_hints_summary(router_tool_hints),
            "priority": 770,
            "required": False,
        },
        {
            "key": "self_check",
            "title": f"Self Check: {step_definition.get('type')}",
            "text": str(step_definition.get("self_check_text") or ""),
            "priority": 760,
            "required": False,
        },
    ]
    return sections
