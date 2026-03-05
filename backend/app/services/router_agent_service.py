import json
import re
from typing import Any, Dict, List, Optional

from app.config import settings
from app.prompts.system_prompts import SystemPrompts
from app.services.agent_registry_service import load_agent_registry, registry_summary_for_router, resolve_registry_selection, sanitize_router_mode
from app.services.llm_service import llm_service
from app.services.token_budget_service import short_text


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


ROUTER_DEFAULT_MAX_ROUNDS = 6


def _extract_first_json_object(text: str) -> Optional[Dict[str, Any]]:
    if not text:
        return None

    code_block_match = re.search(r"```json\s*(\{.*\})\s*```", text, flags=re.DOTALL)
    if code_block_match:
        try:
            parsed = json.loads(code_block_match.group(1))
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            pass

    depth = 0
    start = -1
    for idx, ch in enumerate(text):
        if ch == "{":
            if depth == 0:
                start = idx
            depth += 1
        elif ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start >= 0:
                    try:
                        parsed = json.loads(text[start : idx + 1])
                    except Exception:
                        start = -1
                        continue
                    if isinstance(parsed, dict):
                        return parsed
                    start = -1
    return None


def fallback_router(message: str, *, permitted_files_info: Dict[str, Dict[str, str]]) -> Dict[str, Any]:
    lowered = (message or "").lower()
    primary = "general_assistant"
    mixed: List[str] = []
    tool_groups = ["reader", "control"]
    template_ids = ["answer_template"]
    if any(token in lowered for token in ["paper", "论文", "abstract", "experiment"]):
        primary = "paper_reading"
        tool_groups = ["reader", "visual", "control"]
        template_ids = ["paper_template"]
    elif any(token in lowered for token in ["教材", "theorem", "definition", "chapter", "section"]):
        primary = "textbook_learning"
        tool_groups = ["reader", "editor", "control"]
        template_ids = ["textbook_template", "section_template"]
    if any(token in lowered for token in ["note", "笔记", "修改", "rewrite", "edit", "写入"]):
        if primary != "note_edit":
            mixed.append("note_edit")
        tool_groups = sorted(set(tool_groups + ["editor"]))

    goal = short_text(message or "", 240)
    task_item = {
        "id": "task-1",
        "name": short_text(goal or "Handle current request", 60) or "Handle current request",
        "description": goal,
        "status": "running",
    }
    return {
        "router_version": 1,
        "mode": {
            "primary": primary,
            "mixed": mixed,
            "weights": {primary: 1.0, **{item: 0.5 for item in mixed}},
        },
        "tool": {
            "execution_mode": "mixed",
            "allowed_groups": tool_groups,
            "preferred_tools": ["locate_relevant_segments", "read_document_segments"],
            "forbidden_tools": ["register_task"],
            "max_rounds": ROUTER_DEFAULT_MAX_ROUNDS,
        },
        "task": {
            "goal": goal,
            "state": "planning",
            "items": [task_item],
            "next_action": "Inspect current context and continue with the highest-signal step.",
        },
        "context": {
            "need_viewport_memory": True,
            "need_effective_note_view": True,
            "need_retrieval": bool(permitted_files_info),
            "cite_required": bool(permitted_files_info),
        },
        "output": {
            "shape": "answer",
            "template_ids": template_ids,
            "workflow_ids": ["general", primary, *mixed],
        },
        "executor_brief": goal,
    }


def _sanitize_tool_payload(raw: Any, registry: Dict[str, Any]) -> Dict[str, Any]:
    payload = raw if isinstance(raw, dict) else {}
    allowed_groups = []
    for item in payload.get("allowed_groups") or []:
        text = str(item or "").strip()
        if text in {"reader", "visual", "editor", "control"} and text not in allowed_groups:
            allowed_groups.append(text)
    if not allowed_groups:
        primary = sanitize_router_mode({"mode": {}}, registry)["primary"]
        mode_def = (registry.get("modes") or {}).get(primary) or {}
        allowed_groups = list(mode_def.get("default_tool_groups") or ["reader", "control"])

    preferred_tools = []
    for item in payload.get("preferred_tools") or []:
        text = str(item or "").strip()
        if text in TOOL_GROUPS and text not in preferred_tools:
            preferred_tools.append(text)

    forbidden_tools = []
    for item in payload.get("forbidden_tools") or []:
        text = str(item or "").strip()
        if text in TOOL_GROUPS and text not in forbidden_tools:
            forbidden_tools.append(text)
    if "register_task" not in forbidden_tools:
        forbidden_tools.append("register_task")

    try:
        max_rounds = max(1, min(8, int(payload.get("max_rounds") or ROUTER_DEFAULT_MAX_ROUNDS)))
    except Exception:
        max_rounds = ROUTER_DEFAULT_MAX_ROUNDS

    execution_mode = str(payload.get("execution_mode") or "mixed").strip() or "mixed"
    return {
        "execution_mode": execution_mode,
        "allowed_groups": allowed_groups,
        "preferred_tools": preferred_tools,
        "forbidden_tools": forbidden_tools,
        "max_rounds": max_rounds,
    }


def sanitize_router_result(raw: Optional[Dict[str, Any]], *, message: str, permitted_files_info: Dict[str, Dict[str, str]]) -> Dict[str, Any]:
    registry = load_agent_registry()
    payload = raw if isinstance(raw, dict) else fallback_router(message, permitted_files_info=permitted_files_info)
    mode_payload = sanitize_router_mode(payload, registry)
    tool_payload = _sanitize_tool_payload(payload.get("tool"), registry)
    task_payload = payload.get("task") if isinstance(payload.get("task"), dict) else {}
    task_items = []
    for idx, item in enumerate(task_payload.get("items") or []):
        if not isinstance(item, dict):
            continue
        name = short_text(str(item.get("name") or "").strip(), 80)
        if not name:
            continue
        task_items.append(
            {
                "id": str(item.get("id") or f"task-{idx + 1}"),
                "name": name,
                "description": short_text(str(item.get("description") or "").strip(), 240) or None,
                "status": str(item.get("status") or ("running" if idx == 0 else "waiting")).strip() or "waiting",
            }
        )
    if not task_items:
        fallback = fallback_router(message, permitted_files_info=permitted_files_info)
        task_items = fallback["task"]["items"]

    context_payload = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    output_payload = payload.get("output") if isinstance(payload.get("output"), dict) else {}
    resolved = resolve_registry_selection({"mode": mode_payload, "output": output_payload}, registry)

    return {
        "router_version": 1,
        "mode": mode_payload,
        "tool": tool_payload,
        "task": {
            "goal": short_text(str(task_payload.get("goal") or message or ""), 280),
            "state": str(task_payload.get("state") or "planning").strip() or "planning",
            "items": task_items,
            "next_action": short_text(str(task_payload.get("next_action") or "continue"), 200),
        },
        "context": {
            "need_viewport_memory": bool(context_payload.get("need_viewport_memory", True)),
            "need_effective_note_view": bool(context_payload.get("need_effective_note_view", True)),
            "need_retrieval": bool(context_payload.get("need_retrieval", bool(permitted_files_info))),
            "cite_required": bool(context_payload.get("cite_required", bool(permitted_files_info))),
        },
        "output": {
            "shape": str(output_payload.get("shape") or "answer").strip() or "answer",
            "template_ids": resolved["template_ids"],
            "workflow_ids": resolved["workflow_ids"],
        },
        "executor_brief": short_text(str(payload.get("executor_brief") or message or ""), 320),
    }


async def route_request(
    *,
    message: str,
    permitted_files_info: Dict[str, Dict[str, str]],
    permissions: Dict[str, str],
    viewport: Optional[Dict[str, Any]],
    task_state: Optional[Dict[str, Any]],
    model: Optional[str] = None,
) -> Dict[str, Any]:
    registry = load_agent_registry()
    file_summary = []
    for file_id, info in permitted_files_info.items():
        file_summary.append(
            {
                "file_id": file_id,
                "name": info.get("name"),
                "type": info.get("type"),
                "permission": permissions.get(file_id, "read"),
            }
        )

    router_prompt = {
        "registry": registry_summary_for_router(registry),
        "visible_files": file_summary[:24],
        "viewport": viewport,
        "task_state": task_state,
        "user_request": message,
    }

    parsed = None
    if settings.LEGACY_MODE_ROUTER_ENABLED:
        try:
            response = await llm_service.chat_completion(
                messages=[{"role": "user", "content": json.dumps(router_prompt, ensure_ascii=False, indent=2)}],
                model=model,
                tools=None,
                system_prompt=SystemPrompts.ROUTER_SYSTEM_PROMPT,
            )
            parsed = _extract_first_json_object(str(response.get("content") or ""))
        except Exception:
            parsed = None

    sanitized = sanitize_router_result(parsed, message=message, permitted_files_info=permitted_files_info)
    resolved = resolve_registry_selection(sanitized, registry)
    router_state = {
        "primary_mode": sanitized["mode"]["primary"],
        "mixed_modes": sanitized["mode"].get("mixed") or [],
        "workflow_ids": resolved["workflow_ids"],
        "template_ids": resolved["template_ids"],
        "tool_mode": sanitized["tool"]["execution_mode"],
    }
    return {
        "router_result": sanitized,
        "router_state": router_state,
        "selection": resolved,
    }


def filter_tool_definitions(
    tools: List[Dict[str, Any]],
    *,
    allowed_groups: List[str],
    forbidden_tools: List[str],
) -> List[Dict[str, Any]]:
    if not tools:
        return []
    allowed_set = set(allowed_groups or [])
    forbidden_set = set(forbidden_tools or [])
    filtered = []
    for tool in tools:
        function = tool.get("function") if isinstance(tool, dict) else None
        name = str((function or {}).get("name") or "").strip()
        if not name:
            continue
        if name in forbidden_set:
            continue
        group = TOOL_GROUPS.get(name)
        if allowed_set and group not in allowed_set:
            continue
        filtered.append(tool)
    return filtered
