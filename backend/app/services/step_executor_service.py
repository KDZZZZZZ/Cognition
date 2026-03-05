from typing import Any, Dict, List, Sequence

from app.services.step_catalog_service import get_step_definition


TOOL_GROUPS: Dict[str, str] = {
    "locate_relevant_segments": "reader",
    "read_document_segments": "reader",
    "read_webpage_blocks": "reader",
    "get_document_outline": "reader",
    "explain_retrieval": "reader",
    "get_index_status": "reader",
    "inspect_document_visual": "visual",
    "update_file": "editor",
    "update_block": "editor",
    "insert_block": "editor",
    "delete_block": "editor",
    "add_file_charts_to_note": "editor",
    "pause_for_user_choice": "control",
    "deliver_task": "control",
    "register_task": "control",
}

WRITE_INTENT_HINTS = {
    "write", "写", "写入", "update", "modify", "edit", "append", "笔记", "note", "整理",
}


def _tool_name(tool: Dict[str, Any]) -> str:
    function = tool.get("function") if isinstance(tool, dict) else None
    return str((function or {}).get("name") or tool.get("name") or "").strip()


def _has_write_intent(message: str) -> bool:
    lowered = (message or "").lower()
    return any(token in lowered for token in WRITE_INTENT_HINTS)


def step_tool_groups(step_type: str) -> List[str]:
    return list(get_step_definition(step_type).get("allowed_tool_groups") or [])


def filter_tools_for_step(
    *,
    step_type: str,
    tools: Sequence[Dict[str, Any]],
    user_message: str,
    permissions: Dict[str, str],
    permitted_files_info: Dict[str, Dict[str, str]],
) -> List[Dict[str, Any]]:
    step_def = get_step_definition(step_type)
    allowed_groups = set(step_def.get("allowed_tool_groups") or [])
    writeback_policy = str(step_def.get("writeback_policy") or "never")
    writable_md_ids = [
        file_id
        for file_id, perm in (permissions or {}).items()
        if perm == "write" and str((permitted_files_info.get(file_id) or {}).get("type") or "") == "md"
    ]
    allow_editor = False
    if writeback_policy == "required":
        allow_editor = bool(writable_md_ids)
    elif writeback_policy == "optional":
        allow_editor = bool(writable_md_ids) and _has_write_intent(user_message)

    filtered: List[Dict[str, Any]] = []
    for tool in tools or []:
        name = _tool_name(tool)
        if not name or name == "register_task":
            continue
        if name in {"pause_for_user_choice", "deliver_task"}:
            filtered.append(tool)
            continue
        group = TOOL_GROUPS.get(name)
        if not group or group not in allowed_groups:
            continue
        if group == "editor" and not allow_editor:
            continue
        filtered.append(tool)
    return filtered


def prioritize_tools_with_router_hints(
    *,
    tools: Sequence[Dict[str, Any]],
    router_tool_hints: Dict[str, Any] | None,
) -> List[Dict[str, Any]]:
    ordered = list(tools or [])
    if not ordered:
        return []

    preferred = []
    for item in (router_tool_hints or {}).get("preferred_tools") or []:
        name = str(item or "").strip()
        if name:
            preferred.append(name)

    if not preferred:
        return ordered

    rank = {name: idx for idx, name in enumerate(preferred)}
    return sorted(
        ordered,
        key=lambda tool: (rank.get(_tool_name(tool), len(rank) + 1),),
    )


def resolve_step_missing_inputs(
    *,
    step_type: str,
    user_message: str,
    permissions: Dict[str, str],
    permitted_files_info: Dict[str, Dict[str, str]],
    viewport_memory: Dict[str, Any] | None,
    prior_outputs: Sequence[Dict[str, Any]] | None,
) -> List[Dict[str, Any]]:
    step_def = get_step_definition(step_type)
    required_inputs = list(step_def.get("required_inputs") or [])
    minimum_substitutes = step_def.get("minimum_substitutes") or {}
    readable_files = [
        file_id for file_id, perm in (permissions or {}).items() if perm in {"read", "write"}
    ]
    writable_notes = [
        file_id
        for file_id, perm in (permissions or {}).items()
        if perm == "write" and str((permitted_files_info.get(file_id) or {}).get("type") or "") == "md"
    ]
    has_viewport = bool((viewport_memory or {}).get("viewport"))
    has_memory_text = bool((viewport_memory or {}).get("memory_text"))
    has_prior_outputs = bool(prior_outputs)
    has_user_reasoning = bool(str(user_message or "").strip())
    paper_files = [
        file_id
        for file_id in readable_files
        if str((permitted_files_info.get(file_id) or {}).get("type") or "") in {"pdf", "web", "docx", "txt"}
    ]

    missing: List[Dict[str, Any]] = []
    for key in required_inputs:
        satisfied = True
        if key == "scope_or_viewport":
            satisfied = has_viewport or has_memory_text or bool(readable_files)
        elif key == "source_material":
            satisfied = has_memory_text or bool(readable_files)
        elif key == "writable_note":
            satisfied = bool(writable_notes)
        elif key == "user_reasoning":
            satisfied = has_user_reasoning
        elif key == "paper_material":
            satisfied = bool(paper_files)
        elif key == "research_topic":
            satisfied = has_user_reasoning
        elif key == "prior_outputs":
            satisfied = has_prior_outputs

        if not satisfied:
            missing.append(
                {
                    "input": key,
                    "description": f"Missing required input: {key}",
                    "minimum_substitute": str(minimum_substitutes.get(key) or ""),
                }
            )
    return missing


def build_missing_inputs_markdown(step_type: str, missing_inputs: List[Dict[str, Any]]) -> str:
    step_def = get_step_definition(step_type)
    lines = [
        f"Current step `{step_type}` is blocked.",
        "",
        f"Purpose: {step_def.get('summary') or step_type}",
        "",
        "Missing input list:",
    ]
    for item in missing_inputs:
        lines.append(f"- {item.get('input')}: {item.get('description')}")
        minimum_substitute = str(item.get("minimum_substitute") or "").strip()
        if minimum_substitute:
            lines.append(f"  Minimum substitute: {minimum_substitute}")
    return "\n".join(lines)
