import logging
import json
import uuid
from copy import deepcopy
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from app.config import settings
from app.database import get_db
from app.langgraph_runtime import GRAPH_VERSION, run_task_registry_turn
from app.models import ChatMessage, File as FileModel, FileType, Session, SessionTask, SessionTaskState
from app.prompts.system_prompts import SystemPrompts
from app.schemas import APIResponse, ChatRequest, Permission, SessionCreateRequest, TaskAnswerRequest
from app.services.compaction_service import (
    compact_dialogue_bucket as compact_dialogue_bucket_service,
    maybe_compact_history as maybe_compact_history_service,
)
from app.services.context_pack_service import (
    build_context_pack as build_context_pack_service,
    build_task_registry_context_pack,
)
from app.services.orchestrator_service import orchestrate_request
from app.services.llm_service import llm_service
from app.services.retrieval_service import (
    load_active_viewport_and_excerpt as load_active_viewport_and_excerpt_service,
)
from app.services.retrieval_service import retrieve_context_blocks as retrieve_context_blocks_service
from app.services.router_agent_service import route_request as route_request_service
from app.services.step_catalog_service import get_global_rules_text, get_step_definition
from app.services.step_executor_service import (
    build_missing_inputs_markdown,
    filter_tools_for_step,
    prioritize_tools_with_router_hints,
    resolve_step_missing_inputs,
)
from app.services.task_state_service import default_task_state_snapshot, parse_task_update
from app.services.task_state_service import upsert_task_state as upsert_task_state_service
from app.services.task_registry_service import (
    complete_step,
    create_task_registry,
    ensure_registry_cursor,
    get_active_registry_snapshot,
    get_registry_snapshot,
    mark_registry_cancelled,
    mark_step_blocked,
    mark_step_running,
    resume_blocked_step,
)
from app.services.token_budget_service import estimate_messages_tokens, short_text
from app.services.tools.base import PermissionLevel
from app.services.tools.executor import tool_executor
from app.services.tools.middleware import permission_middleware
from app.services.viewport_memory_service import build_viewport_memory as build_viewport_memory_service
from app.websocket import manager

router = APIRouter(prefix="/chat", tags=["chat"])
logger = logging.getLogger(__name__)

_running_task_by_session: dict[str, str] = {}
_task_to_session: dict[str, str] = {}
_cancelled_tasks: set[str] = set()
_task_items_by_session: dict[str, list[dict[str, Any]]] = {}
_paused_task_checkpoints: dict[str, dict[str, Any]] = {}
FILE_ACCESS_REQUIRED_HINTS = {
    "当前页",
    "这一页",
    "这页",
    "hidden",
    "隐藏",
    "文档",
    "文件",
    "教材",
    "论文",
    "note",
    "pdf",
    "刚才",
    "继续引用",
    "cite",
    "page",
}
TOOL_FORCE_HINTS = {
    "调用工具",
    "用工具",
    "tool call",
    "call tool",
    "use tools",
    "按顺序调用",
    "依次调用",
    "工具审计",
    "tool audit",
}
FORCED_TOOL_NAME_PRIORITY = (
    "locate_relevant_segments",
    "read_document_segments",
    "inspect_document_visual",
    "get_document_outline",
    "get_index_status",
    "explain_retrieval",
    "read_webpage_blocks",
    "update_block",
    "insert_block",
    "update_file",
    "add_file_charts_to_note",
    "delete_block",
)


class TaskCancelledError(Exception):
    """Raised when a running task is cancelled by user action."""


def get_available_tools_for_session(session: Session, context) -> List[dict]:
    return tool_executor.get_available_tools(context)


def _is_task_cancelled(task_id: str) -> bool:
    return task_id in _cancelled_tasks


def _assert_task_not_cancelled(task_id: str) -> None:
    if _is_task_cancelled(task_id):
        raise TaskCancelledError(f"Task {task_id} has been cancelled")


def _session_task_items(session_id: str) -> list[dict[str, Any]]:
    if session_id not in _task_items_by_session:
        _task_items_by_session[session_id] = []
    return _task_items_by_session[session_id]


def _find_task_item(
    task_items: list[dict[str, Any]],
    *,
    task_item_id: Optional[str] = None,
    task_name: Optional[str] = None,
    allow_completed: bool = True,
) -> Optional[dict[str, Any]]:
    lowered_name = (task_name or "").strip().lower()
    for item in task_items:
        if task_item_id and item.get("id") == task_item_id:
            if allow_completed or item.get("status") != "completed":
                return item
        if lowered_name and str(item.get("name") or "").strip().lower() == lowered_name:
            if allow_completed or item.get("status") != "completed":
                return item
    return None


def _compute_task_board_counts(task_items: list[dict[str, Any]]) -> dict[str, int]:
    total = len(task_items)
    completed = sum(1 for item in task_items if item.get("status") == "completed")
    running = sum(1 for item in task_items if item.get("status") == "running")
    waiting = sum(1 for item in task_items if item.get("status") == "waiting")
    return {
        "total": total,
        "completed": completed,
        "running": running,
        "waiting": waiting,
    }


def _message_likely_requires_file_access(message: str) -> bool:
    lowered = str(message or "").strip().lower()
    if not lowered:
        return False
    return any(hint.lower() in lowered for hint in FILE_ACCESS_REQUIRED_HINTS)


def _message_explicitly_requests_tool_calls(message: str) -> bool:
    lowered = str(message or "").strip().lower()
    if not lowered:
        return False
    if any(hint.lower() in lowered for hint in TOOL_FORCE_HINTS):
        return True
    has_tool_token = ("工具" in lowered) or ("tool" in lowered)
    has_action_token = any(token in lowered for token in ("调用", "先调用", "先用", "先使用", "call", "use"))
    return has_tool_token and has_action_token


def _tool_spec_name(tool_spec: Dict[str, Any]) -> str:
    function = tool_spec.get("function") if isinstance(tool_spec, dict) else None
    return str((function or {}).get("name") or tool_spec.get("name") or "").strip()


def _ordered_tool_names(tool_specs: List[Dict[str, Any]]) -> List[str]:
    names: List[str] = []
    for tool in tool_specs or []:
        name = _tool_spec_name(tool)
        if not name:
            continue
        if name in names:
            continue
        names.append(name)
    return names


def _build_forced_tool_choice(tool_specs: List[Dict[str, Any]]) -> Any:
    available = set(_ordered_tool_names(tool_specs))
    for name in FORCED_TOOL_NAME_PRIORITY:
        if name in available:
            return {"type": "function", "function": {"name": name}}
    return "required"


def _build_forced_tool_call(
    *,
    tool_specs: List[Dict[str, Any]],
    current_user_message: str,
    readable_file_ids: List[str],
    active_file_id: Optional[str],
    active_page: Optional[int],
) -> Optional[Dict[str, Any]]:
    tool_names = _ordered_tool_names(tool_specs)
    if not tool_names:
        return None

    target_file_id = ""
    if active_file_id and active_file_id in readable_file_ids:
        target_file_id = active_file_id
    elif readable_file_ids:
        target_file_id = readable_file_ids[0]

    query_text = short_text(str(current_user_message or "").strip(), 160) or "current question"

    def tool_call(name: str, args: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "id": f"forced_{name}",
            "type": "function",
            "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)},
        }

    if target_file_id:
        if "locate_relevant_segments" in tool_names:
            return tool_call(
                "locate_relevant_segments",
                {"query": query_text, "file_id": target_file_id, "top_k": 3},
            )
        if "read_document_segments" in tool_names:
            return tool_call(
                "read_document_segments",
                {
                    "file_id": target_file_id,
                    "anchor_page": max(int(active_page or 1), 1),
                    "page_window": 1,
                },
            )
        if "inspect_document_visual" in tool_names:
            return tool_call(
                "inspect_document_visual",
                {
                    "file_id": target_file_id,
                    "query": query_text,
                    "page": max(int(active_page or 1), 1),
                    "max_images": 1,
                },
            )
        if "get_document_outline" in tool_names:
            return tool_call("get_document_outline", {"file_id": target_file_id})
        if "get_index_status" in tool_names:
            return tool_call("get_index_status", {"file_id": target_file_id})
        if "explain_retrieval" in tool_names:
            return tool_call("explain_retrieval", {"query": query_text, "file_id": target_file_id})

    if "deliver_task" in tool_names:
        return None
    return None


def _parse_tool_call(raw_call: Dict[str, Any]) -> tuple[str, Dict[str, Any], str]:
    if "function" in raw_call:
        tool_name = raw_call["function"]["name"]
        tool_args = raw_call["function"].get("arguments", {})
        tool_call_id = str(raw_call.get("id") or "")
    else:
        tool_name = raw_call.get("name")
        tool_args = raw_call.get("arguments", {})
        tool_call_id = str(raw_call.get("id") or "")

    if isinstance(tool_args, str):
        try:
            tool_args = json.loads(tool_args)
        except json.JSONDecodeError:
            tool_args = {}

    if not isinstance(tool_args, dict):
        tool_args = {}

    return tool_name, tool_args, tool_call_id


def _action_kind_for_tool(tool_name: str) -> str:
    tool = (tool_name or "").strip()
    if tool in {"locate_relevant_segments", "read_document_segments", "get_document_outline", "read_webpage_blocks", "explain_retrieval", "get_index_status", "inspect_document_visual"}:
        return "read"
    if tool in {"insert_block", "add_file_charts_to_note"}:
        return "create"
    if tool in {"update_file", "update_block"}:
        return "update"
    if tool in {"delete_block"}:
        return "delete"
    if tool in {"register_task", "deliver_task"}:
        return "task"
    if tool in {"pause_for_user_choice"}:
        return "pause"
    return "other"


def _append_unique_citations(
    citations: List[Dict[str, Any]],
    new_items: List[Dict[str, Any]],
) -> None:
    existing = {
        (
            str(item.get("file_id") or ""),
            int(item.get("page") or 0),
            str(item.get("segment_id") or ""),
            str(item.get("source_mode") or ""),
        )
        for item in citations
        if isinstance(item, dict)
    }
    for item in new_items:
        if not isinstance(item, dict):
            continue
        key = (
            str(item.get("file_id") or ""),
            int(item.get("page") or 0),
            str(item.get("segment_id") or ""),
            str(item.get("source_mode") or ""),
        )
        if key in existing:
            continue
        existing.add(key)
        citations.append(item)


def _collect_citations_from_tool_result(
    *,
    tool_name: str,
    result_payload: Dict[str, Any],
    target_file_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    if not isinstance(result_payload, dict) or result_payload.get("success") is not True:
        return []

    data = result_payload.get("data") if isinstance(result_payload.get("data"), dict) else {}
    source_mode = f"tool:{tool_name}"
    fallback_file_id = str(data.get("file_id") or target_file_id or "")
    out: List[Dict[str, Any]] = []

    if tool_name == "read_document_segments":
        for block in data.get("blocks") or []:
            if not isinstance(block, dict):
                continue
            page = block.get("page")
            if page is None:
                continue
            out.append(
                {
                    "file_id": fallback_file_id,
                    "page": page,
                    "section": block.get("section"),
                    "segment_id": block.get("segment_id"),
                    "segment_type": block.get("segment_type"),
                    "content": short_text(str(block.get("text") or ""), 200),
                    "source_mode": source_mode,
                }
            )
    elif tool_name == "locate_relevant_segments":
        for hit in data.get("hits") or []:
            if not isinstance(hit, dict):
                continue
            page = hit.get("page")
            if page is None:
                continue
            out.append(
                {
                    "file_id": str(hit.get("file_id") or fallback_file_id),
                    "page": page,
                    "section": hit.get("section"),
                    "segment_id": hit.get("segment_id"),
                    "segment_type": hit.get("segment_type"),
                    "content": short_text(str(hit.get("text") or ""), 200),
                    "source_mode": source_mode,
                }
            )
    elif tool_name == "get_document_outline":
        for item in data.get("outline") or []:
            if not isinstance(item, dict):
                continue
            page = item.get("page")
            if page is None:
                continue
            out.append(
                {
                    "file_id": fallback_file_id,
                    "page": page,
                    "section": item.get("section"),
                    "segment_id": item.get("segment_id"),
                    "content": short_text(str(item.get("title") or ""), 120),
                    "source_mode": source_mode,
                }
            )
    elif tool_name == "inspect_document_visual":
        visual_page = data.get("page")
        if visual_page is not None:
            out.append(
                {
                    "file_id": fallback_file_id,
                    "page": visual_page,
                    "section": None,
                    "segment_id": None,
                    "segment_type": "visual",
                    "content": short_text(str(data.get("answer") or data.get("description") or ""), 200),
                    "source_mode": source_mode,
                }
            )

    return out


EDITOR_TOOL_NAMES = {
    "update_file",
    "update_block",
    "insert_block",
    "delete_block",
    "add_file_charts_to_note",
}


def _normalize_tool_file_arguments(
    *,
    tool_name: str,
    tool_args: Dict[str, Any],
    permissions: Dict[str, Any],
    permitted_files_info: Dict[str, Dict[str, str]],
) -> tuple[Dict[str, Any], Optional[str]]:
    patched_args = dict(tool_args or {})
    resolved_file_id: Optional[str] = None

    def _resolve_file_ref(
        raw_value: str,
        *,
        require_write: bool,
        require_md: bool = False,
    ) -> Optional[str]:
        if not raw_value:
            return None
        if raw_value in (permissions or {}) or raw_value in (permitted_files_info or {}):
            return raw_value

        matches = []
        for file_id, info in (permitted_files_info or {}).items():
            perm = str((permissions or {}).get(file_id) or "")
            file_type = str((info or {}).get("type") or "")
            file_name = str((info or {}).get("name") or "").strip()
            if file_name != raw_value:
                continue
            if require_write and perm != "write":
                continue
            if not require_write and perm not in {"read", "write"}:
                continue
            if require_md and file_type != "md":
                continue
            matches.append(file_id)
        return matches[0] if len(matches) == 1 else None

    explicit_file_id = str(patched_args.get("file_id") or "").strip()
    if explicit_file_id:
        normalized = _resolve_file_ref(
            explicit_file_id,
            require_write=tool_name in EDITOR_TOOL_NAMES,
            require_md=tool_name in EDITOR_TOOL_NAMES,
        )
        if normalized and normalized != explicit_file_id:
            patched_args["file_id"] = normalized
            resolved_file_id = normalized

    explicit_source_file_id = str(patched_args.get("source_file_id") or "").strip()
    if explicit_source_file_id:
        normalized_source = _resolve_file_ref(
            explicit_source_file_id,
            require_write=False,
            require_md=False,
        )
        if normalized_source and normalized_source != explicit_source_file_id:
            patched_args["source_file_id"] = normalized_source
            if not resolved_file_id:
                resolved_file_id = normalized_source

    if tool_name not in EDITOR_TOOL_NAMES or explicit_file_id:
        return patched_args, resolved_file_id

    writable_md_ids = [
        file_id
        for file_id, perm in (permissions or {}).items()
        if str(perm or "") == "write" and str((permitted_files_info.get(file_id) or {}).get("type") or "") == "md"
    ]
    if len(writable_md_ids) != 1:
        return patched_args, resolved_file_id

    inferred_file_id = writable_md_ids[0]
    patched_args["file_id"] = inferred_file_id
    return patched_args, inferred_file_id


def _now_iso() -> str:
    return datetime.utcnow().isoformat()


def _estimate_object_tokens(value: Any) -> int:
    try:
        text = json.dumps(value, ensure_ascii=False)
    except Exception:
        text = str(value)
    return max(1, len(text) // 4)


def _digest_object(value: Any, *, limit: int = 320) -> str:
    try:
        text = json.dumps(value, ensure_ascii=False)
    except Exception:
        text = str(value)
    return short_text(text, limit)


def _init_memory_epoch(task_id: str, goal: str) -> Dict[str, Any]:
    now = _now_iso()
    return {
        "lifecycle": "epoch",
        "epoch_id": task_id,
        "state": "planning",
        "started_at": now,
        "updated_at": now,
        "dialogue": {
            "lifecycle": "epoch",
            "latest_user_goal": short_text(goal or "", 280) if goal else None,
            "current_focus": {"book": None, "section": None},
            "next_action": None,
            "recent_turns": [],
        },
        "tool_history": {
            "lifecycle": "epoch",
            "calls": [],
            "stats": {"total": 0, "failed": 0, "write_ops": 0},
        },
        "task_list": {
            "lifecycle": "epoch",
            "items": [],
            "counts": {"total": 0, "running": 0, "waiting": 0, "completed": 0},
        },
    }


def _with_memory_epoch_artifacts(artifacts: Optional[Dict[str, Any]], memory_epoch: Dict[str, Any]) -> Dict[str, Any]:
    merged = dict(artifacts or {})
    merged["memory_epoch"] = memory_epoch
    return merged


def _append_dialogue_turn(memory_epoch: Dict[str, Any], *, role: str, content: str) -> None:
    dialogue = memory_epoch.setdefault("dialogue", {})
    recent_turns = dialogue.setdefault("recent_turns", [])
    turn = {
        "turn_id": str(uuid.uuid4()),
        "role": role,
        "ts": _now_iso(),
        "content_digest": short_text(content or "", 320),
    }
    recent_turns.append(turn)
    if len(recent_turns) > 30:
        del recent_turns[:-30]
    if role == "user" and (content or "").strip():
        dialogue["latest_user_goal"] = short_text(content, 280)


def _sync_epoch_state(memory_epoch: Dict[str, Any], task_state: Optional[Dict[str, Any]]) -> None:
    if not isinstance(task_state, dict):
        return
    memory_epoch["state"] = task_state.get("state", memory_epoch.get("state"))
    memory_epoch["updated_at"] = _now_iso()
    next_action = task_state.get("next_action")
    if next_action is not None:
        memory_epoch.setdefault("dialogue", {}).setdefault("next_action", None)
        memory_epoch["dialogue"]["next_action"] = short_text(str(next_action), 200)


def _sync_focus_from_viewport(
    memory_epoch: Dict[str, Any],
    *,
    viewport: Optional[Dict[str, Any]],
    permitted_files_info: Dict[str, Dict[str, str]],
) -> None:
    if not isinstance(viewport, dict):
        return
    file_id = str(viewport.get("file_id") or "").strip()
    page = viewport.get("page")
    if not file_id:
        return
    file_name = ((permitted_files_info.get(file_id) or {}).get("name") or "").strip() or file_id
    section = f"p.{page}" if page is not None else None
    current_focus = memory_epoch.setdefault("dialogue", {}).setdefault("current_focus", {})
    current_focus["book"] = file_name
    current_focus["section"] = section
    memory_epoch["updated_at"] = _now_iso()


def _sync_task_list(memory_epoch: Dict[str, Any], task_items: List[Dict[str, Any]]) -> None:
    normalized_items: List[Dict[str, Any]] = []
    for item in task_items:
        if not isinstance(item, dict):
            continue
        normalized_items.append(
            {
                "id": item.get("id"),
                "name": item.get("name"),
                "description": item.get("description"),
                "status": item.get("status"),
                "completion_summary": item.get("completion_summary"),
                "created_at": item.get("created_at"),
                "updated_at": item.get("updated_at"),
            }
        )
    memory_epoch.setdefault("task_list", {})["items"] = normalized_items
    memory_epoch["task_list"]["counts"] = _compute_task_board_counts(task_items)
    memory_epoch["updated_at"] = _now_iso()


def _all_task_items_completed(task_items: List[Dict[str, Any]]) -> bool:
    counts = _compute_task_board_counts(task_items)
    return counts["total"] > 0 and counts["completed"] == counts["total"]


def _empty_retrieval_result(*, mode: str) -> Dict[str, Any]:
    return {
        "context_parts": [],
        "citations": [],
        "retrieval_refs": [],
        "used_tokens": 0,
        "semantic_failed": False,
        "visual_hits_count": 0,
        "retrieval_diagnostics": {
            "mode": mode,
            "fused_hits": 0,
            "text_hits": 0,
            "image_hits": 0,
            "fallback_flags": [],
        },
    }


def _build_context_payload(
    *,
    context_blocks: List[str],
    use_tools: bool,
) -> str:
    header = "[Context Manifest and Viewport]" if use_tools else "[Relevant Context from Documents]"
    guidance = (
        "Use the manifest for permissions, active viewport, task state, and recent memory. "
        "Do not assume unseen document content. When you need evidence from files, call retrieval/read tools yourself. "
        "You may use chart/image tools when they materially improve the answer or note, but do not replace explanation with images only."
        if use_tools
        else "Use this context to answer the user's question. Cite your sources."
    )
    return header + ":\n" + "\n\n".join(context_blocks) + "\n\n" + guidance


def _maybe_append_round_completion_prompt(messages: List[Dict[str, Any]], task_items: List[Dict[str, Any]]) -> None:
    if not _all_task_items_completed(task_items):
        return
    prompt = (
        "当前task已经全部完成,是否结束本回合。"
        "如果所有目标均已完成且无需继续检索、贴图或编辑，请直接给出最终答复并结束；"
        "如果仍有缺口，先明确缺口，再继续调用必要工具。"
        "不要为了调用工具而调用工具，也不要只贴图不解释。"
    )
    if messages:
        last = messages[-1]
        if last.get("role") == "system" and prompt in str(last.get("content") or ""):
            return
    messages.append({"role": "system", "content": prompt})


def _record_tool_call(
    memory_epoch: Dict[str, Any],
    *,
    tool_name: str,
    tool_args: Dict[str, Any],
    result_payload: Dict[str, Any],
    action_kind: str,
    target_file_id: Optional[str],
    started_at: str,
    ended_at: str,
) -> None:
    tool_history = memory_epoch.setdefault("tool_history", {})
    calls = tool_history.setdefault("calls", [])
    stats = tool_history.setdefault("stats", {"total": 0, "failed": 0, "write_ops": 0})

    call_record = {
        "index": len(calls) + 1,
        "tool": tool_name,
        "arguments_full": tool_args,
        "result_full": result_payload,
        "success": bool(result_payload.get("success")),
        "error_code": result_payload.get("error_code"),
        "started_at": started_at,
        "ended_at": ended_at,
        "action_kind": action_kind,
        "target_file_id": target_file_id or None,
        "arguments_digest": _digest_object(tool_args, limit=260),
        "result_digest": _digest_object(result_payload, limit=360),
    }
    calls.append(call_record)
    stats["total"] = len(calls)
    stats["failed"] = len([c for c in calls if not c.get("success")])
    stats["write_ops"] = len([c for c in calls if c.get("action_kind") in {"create", "update", "delete"}])
    memory_epoch["updated_at"] = _now_iso()


def _epoch_for_prompt(memory_epoch: Dict[str, Any]) -> Dict[str, Any]:
    epoch_prompt = deepcopy(memory_epoch)
    calls = ((epoch_prompt.get("tool_history") or {}).get("calls") or [])
    if not calls:
        return epoch_prompt

    # Injection defaults to digest-only; include full payload for recent calls if budget allows.
    for call in calls:
        call["arguments_full"] = None
        call["result_full"] = None

    budget_tokens = 2200
    used_tokens = 0
    included = 0
    for idx in range(len(calls) - 1, -1, -1):
        source_call = (((memory_epoch.get("tool_history") or {}).get("calls") or [])[idx]) if idx < len(
            ((memory_epoch.get("tool_history") or {}).get("calls") or [])
        ) else None
        if not isinstance(source_call, dict):
            continue
        needed = _estimate_object_tokens(source_call.get("result_full")) + _estimate_object_tokens(source_call.get("arguments_full"))
        if used_tokens + needed > budget_tokens:
            continue
        calls[idx]["arguments_full"] = source_call.get("arguments_full")
        calls[idx]["result_full"] = source_call.get("result_full")
        used_tokens += needed
        included += 1
        if included >= 2:
            break

    return epoch_prompt


def _build_memory_payload(compact_meta: Dict[str, Any], memory_epoch: Dict[str, Any]) -> Dict[str, Any]:
    compact = compact_meta.get("memory_snapshot") if isinstance(compact_meta, dict) else None
    if not isinstance(compact, dict):
        compact = {
            "lifecycle": "session",
            "trigger": {
                "context_window_tokens": int(settings.MODEL_CONTEXT_WINDOW_TOKENS or 256000),
                "trigger_ratio": float(settings.COMPACT_TRIGGER_RATIO or 0.8),
            },
            "latest": {
                "compaction_id": None,
                "sequence": 0,
                "summary": "No compaction yet.",
                "key_state": {
                    "current_goal": None,
                    "current_material": None,
                    "current_section": None,
                    "next_step": None,
                },
                "hard_constraints": [],
                "temporary_decisions": [],
                "unwritten_conclusions": [],
                "open_loops": [],
                "updated_at": None,
            },
            "history_tail": [],
        }

    return {
        "lifecycle": "session",
        "compact": compact,
        "epoch": _epoch_for_prompt(memory_epoch),
    }


def _history_messages_for_layered_pack(
    history_messages: List[ChatMessage],
    *,
    exclude_message_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    for msg in history_messages:
        if exclude_message_id and msg.id == exclude_message_id:
            continue
        if msg.role not in {"user", "assistant"}:
            continue
        items.append(
            {
                "id": msg.id,
                "role": msg.role,
                "content": msg.content,
                "timestamp": msg.timestamp.isoformat() if msg.timestamp else None,
            }
        )
    return items


async def _sync_router_task_items(
    *,
    db: AsyncSession,
    session_id: str,
    task_id: str,
    task_items: List[Dict[str, Any]],
    router_items: List[Dict[str, Any]],
) -> None:
    if not isinstance(router_items, list):
        return

    for raw in router_items:
        if not isinstance(raw, dict):
            continue
        task_name = str(raw.get("name") or "").strip()
        if not task_name:
            continue
        task_item_id = str(raw.get("id") or "").strip() or str(uuid.uuid4())
        existing = _find_task_item(task_items, task_item_id=task_item_id, task_name=task_name, allow_completed=True)
        if existing is None:
            task_item = {
                "id": task_item_id,
                "name": task_name,
                "description": raw.get("description"),
                "status": str(raw.get("status") or "waiting"),
                "completion_summary": None,
                "created_at": datetime.utcnow().isoformat(),
                "updated_at": datetime.utcnow().isoformat(),
            }
            task_items.append(task_item)
            counts = _compute_task_board_counts(task_items)
            await _emit_task_event(
                db=db,
                session_id=session_id,
                task_id=task_id,
                event_type="task_item_registered",
                stage="planning",
                message=f"Registered task: {task_name}",
                progress=18,
                status="running",
                payload={"task_item": task_item, "counts": counts},
            )
        else:
            existing["description"] = raw.get("description") or existing.get("description")
            if existing.get("status") != "completed":
                existing["status"] = str(raw.get("status") or existing.get("status") or "waiting")
            existing["updated_at"] = datetime.utcnow().isoformat()

    running_items = [item for item in task_items if item.get("status") == "running"]
    if not running_items:
        waiting = [item for item in task_items if item.get("status") == "waiting"]
        if waiting:
            waiting[0]["status"] = "running"
            waiting[0]["updated_at"] = datetime.utcnow().isoformat()
            counts = _compute_task_board_counts(task_items)
            await _emit_task_event(
                db=db,
                session_id=session_id,
                task_id=task_id,
                event_type="task_item_started",
                stage="planning",
                message=f"Started task: {waiting[0]['name']}",
                progress=20,
                status="running",
                payload={"task_item": waiting[0], "counts": counts},
            )


async def _prepare_layered_execution_context(
    *,
    db: AsyncSession,
    session_id: str,
    message: str,
    user_message_id: Optional[str],
    permissions: Dict[str, str],
    permitted_files_info: Dict[str, Dict[str, str]],
    context_permissions: Dict[str, PermissionLevel],
    request_use_tools: bool,
    active_file_id: Optional[str],
    active_page: Optional[int],
    active_visible_unit: Optional[str],
    active_visible_start: Optional[int],
    active_visible_end: Optional[int],
    active_anchor_block_id: Optional[str],
    history_messages: List[ChatMessage],
    task_state_snapshot: Optional[Dict[str, Any]],
    task_items: List[Dict[str, Any]],
    task_id: str,
    memory_epoch: Dict[str, Any],
    model: Optional[str],
    available_tools: Optional[List[Dict[str, Any]]],
) -> Dict[str, Any]:
    active_ctx = await load_active_viewport_and_excerpt_service(
        db=db,
        session_id=session_id,
        context_permissions=context_permissions,
        active_file_id=active_file_id,
        active_page=active_page,
        active_visible_unit=active_visible_unit,
        active_visible_start=active_visible_start,
        active_visible_end=active_visible_end,
        active_anchor_block_id=active_anchor_block_id,
    )
    active_viewport = active_ctx.get("viewport")
    _sync_focus_from_viewport(
        memory_epoch,
        viewport=active_viewport,
        permitted_files_info=permitted_files_info,
    )

    await _emit_task_event(
        db=db,
        session_id=session_id,
        task_id=task_id,
        event_type="router_started",
        stage="planning",
        message="Running router agent",
        progress=12,
        status="running",
    )

    router_payload = await route_request_service(
        message=message,
        permitted_files_info=permitted_files_info,
        permissions=permissions or {},
        viewport=active_viewport,
        task_state=task_state_snapshot,
        model=model,
    )
    router_result = router_payload["router_result"]
    router_state = router_payload["router_state"]
    selection = router_payload["selection"]

    await _sync_router_task_items(
        db=db,
        session_id=session_id,
        task_id=task_id,
        task_items=task_items,
        router_items=((router_result.get("task") or {}).get("items") or []),
    )
    _sync_task_list(memory_epoch, task_items)

    await _emit_task_event(
        db=db,
        session_id=session_id,
        task_id=task_id,
        event_type="router_completed",
        stage="planning",
        message=f"Router selected {router_state['primary_mode']}",
        progress=18,
        status="running",
        payload=router_state,
    )

    viewport_memory = await build_viewport_memory_service(
        db=db,
        session_id=session_id,
        context_permissions=context_permissions,
        active_file_id=active_viewport.get("file_id") if active_viewport else active_file_id,
        active_page=active_viewport.get("page") if active_viewport else active_page,
        active_visible_unit=active_visible_unit,
        active_visible_start=active_visible_start,
        active_visible_end=active_visible_end,
        active_anchor_block_id=active_anchor_block_id,
        require_effective_note_view=bool(((router_result.get("context") or {}).get("need_effective_note_view", True))),
    )

    retrieval_result = _empty_retrieval_result(mode="deferred_to_tools")
    if not request_use_tools and ((router_result.get("context") or {}).get("need_retrieval") is True):
        readable_files = [
            fid for fid, perm in (permissions or {}).items()
            if not fid.startswith("_") and perm in ("read", "write")
        ]
        retrieval_result = await retrieve_context_blocks_service(
            db=db,
            query=message,
            readable_files=readable_files,
            permitted_files_info=permitted_files_info,
            active_file_id=active_viewport.get("file_id") if active_viewport else active_file_id,
            active_page=active_viewport.get("page") if active_viewport else active_page,
        )

    retrieval_summary = None
    if retrieval_result.get("context_parts"):
        retrieval_summary = "\n\n".join(retrieval_result.get("context_parts")[:4])

    history_dicts = _history_messages_for_layered_pack(history_messages, exclude_message_id=user_message_id)

    await _emit_task_event(
        db=db,
        session_id=session_id,
        task_id=task_id,
        event_type="context_pack_started",
        stage="planning",
        message="Packing layered execution context",
        progress=22,
        status="running",
    )

    context_pack = await build_context_pack_service(
        db=db,
        session_id=session_id,
        current_user_message=message,
        history_messages=history_dicts,
        router_result=router_result,
        selection=selection,
        permissions=permissions or {},
        permitted_files_info=permitted_files_info,
        task_state=task_state_snapshot,
        viewport_memory=viewport_memory,
        available_tools=available_tools or [],
        previous_tool_results=None,
        memory_epoch=memory_epoch,
        model=model,
    )

    if retrieval_summary:
        system_prompt = str(context_pack["messages"][0]["content"] or "")
        system_prompt += "\n\n[Retrieved Context]\n" + retrieval_summary
        context_pack["messages"][0]["content"] = system_prompt
        context_pack["budget_meta"]["buckets"]["runtime_bucket"]["used"] += estimate_tokens(retrieval_summary)
        context_pack["budget_meta"]["total_input_tokens"] += estimate_tokens(retrieval_summary)

    await _emit_task_event(
        db=db,
        session_id=session_id,
        task_id=task_id,
        event_type="context_pack_completed",
        stage="planning",
        message="Layered execution context ready",
        progress=26,
        status="running",
        payload={
            "router_state": router_state,
            "budget_meta": context_pack.get("budget_meta"),
            "viewport_memory_refs": ((viewport_memory or {}).get("refs") or []),
            "retrieval_diagnostics": retrieval_result.get("retrieval_diagnostics", {}),
        },
    )

    if context_pack.get("budget_meta", {}).get("triggered"):
        await _emit_task_event(
            db=db,
            session_id=session_id,
            task_id=task_id,
            event_type="budget_rebalanced",
            stage="planning",
            message="Context budget rebalanced for layered pack",
            progress=27,
            status="running",
            payload=context_pack.get("budget_meta"),
        )

    return {
        "active_viewport": active_viewport,
        "router_result": router_result,
        "router_state": router_state,
        "selection": selection,
        "viewport_memory": viewport_memory,
        "retrieval_result": retrieval_result,
        "context_pack": context_pack,
    }


async def _load_file_type_map(db: AsyncSession, file_ids: list[str]) -> Dict[str, str]:
    normalized = [fid for fid in file_ids if fid and not fid.startswith("_")]
    if not normalized:
        return {}

    result = await db.execute(select(FileModel).where(FileModel.id.in_(normalized)))
    rows = result.scalars().all()
    file_type_map: Dict[str, str] = {}
    for row in rows:
        raw = row.file_type.value if hasattr(row.file_type, "value") else row.file_type
        file_type_map[row.id] = str(raw)
    return file_type_map


async def _coerce_permissions_for_non_md_write(
    db: AsyncSession,
    permissions: Optional[dict[str, Any]],
) -> tuple[dict[str, str], dict[str, Dict[str, Any]]]:
    if not permissions:
        return {}, {}

    normalized: dict[str, str] = {}
    for fid, perm in permissions.items():
        if isinstance(perm, Permission):
            normalized[fid] = perm.value
        else:
            normalized[fid] = str(perm)

    file_type_map = await _load_file_type_map(db, list(normalized.keys()))
    effective: dict[str, str] = {}
    diagnostics: dict[str, Dict[str, Any]] = {}

    for fid, perm in normalized.items():
        if fid.startswith("_"):
            effective[fid] = perm
            continue

        coerced = False
        reason = None
        file_type = file_type_map.get(fid)
        final_perm = perm
        if perm == "write" and file_type != "md":
            final_perm = "read"
            coerced = True
            reason = "write_permission_only_allowed_for_md"

        effective[fid] = final_perm
        diagnostics[fid] = {
            "requested_permission": perm,
            "effective_permission": final_perm,
            "coerced": coerced,
            "reason": reason,
            "file_type": file_type,
        }

    return effective, diagnostics


def _extract_prompt_from_pause_result(result_payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    data = result_payload.get("data") if isinstance(result_payload, dict) else None
    if not isinstance(data, dict):
        return None
    prompt = data.get("prompt")
    if not isinstance(prompt, dict):
        return None
    prompt_id = str(prompt.get("prompt_id") or "").strip()
    question = str(prompt.get("question") or "").strip()
    options = prompt.get("options")
    if not prompt_id or not question or not isinstance(options, list) or not options:
        return None
    return prompt


async def _persist_pause_checkpoint(
    *,
    db: AsyncSession,
    session_id: str,
    task_id: str,
    checkpoint: Dict[str, Any],
) -> None:
    _paused_task_checkpoints[task_id] = checkpoint

    result = await db.execute(select(SessionTaskState).where(SessionTaskState.session_id == session_id))
    row = result.scalar_one_or_none()
    if not row:
        return

    artifacts = dict(row.artifacts_json or {})
    artifacts["pause_checkpoint"] = checkpoint
    row.artifacts_json = artifacts
    row.blocked_reason = "awaiting_user_input"
    row.updated_at = datetime.utcnow()


async def _load_pause_checkpoint(
    *,
    db: AsyncSession,
    session_id: str,
    task_id: str,
) -> Optional[Dict[str, Any]]:
    checkpoint = _paused_task_checkpoints.get(task_id)
    if checkpoint:
        return checkpoint

    result = await db.execute(select(SessionTaskState).where(SessionTaskState.session_id == session_id))
    row = result.scalar_one_or_none()
    if not row:
        return None
    artifacts = row.artifacts_json or {}
    raw = artifacts.get("pause_checkpoint")
    if isinstance(raw, dict):
        _paused_task_checkpoints[task_id] = raw
        return raw
    return None


async def _clear_pause_checkpoint(
    *,
    db: AsyncSession,
    session_id: str,
    task_id: str,
) -> None:
    _paused_task_checkpoints.pop(task_id, None)
    should_commit = False
    result = await db.execute(select(SessionTaskState).where(SessionTaskState.session_id == session_id))
    row = result.scalar_one_or_none()
    if not row:
        return
    artifacts = dict(row.artifacts_json or {})
    if "pause_checkpoint" in artifacts:
        artifacts.pop("pause_checkpoint", None)
        row.artifacts_json = artifacts
        row.updated_at = datetime.utcnow()
        should_commit = True
    if should_commit:
        await db.commit()


async def _emit_task_event(
    *,
    db: AsyncSession,
    session_id: str,
    task_id: str,
    event_type: str,
    stage: str,
    message: str,
    progress: Optional[int] = None,
    status: str = "running",
    payload: Optional[Dict[str, Any]] = None,
    persist: bool = True,
) -> Dict[str, Any]:
    event_id = str(uuid.uuid4())
    timestamp = datetime.utcnow().isoformat()
    event_payload: Dict[str, Any] = {
        "event_id": event_id,
        "session_id": session_id,
        "task_id": task_id,
        "event_type": event_type,
        "stage": stage,
        "message": message,
        "progress": progress,
        "status": status,
        "timestamp": timestamp,
        "payload": payload or {},
    }

    await manager.broadcast_to_session(
        session_id,
        {
            "type": "task_progress",
            "data": event_payload,
        },
    )

    if persist:
        db.add(
            ChatMessage(
                id=event_id,
                session_id=session_id,
                role="task_event",
                content=message,
                tool_results=event_payload,
            )
        )

    return event_payload


async def _emit_assistant_stream_event(
    *,
    session_id: str,
    task_id: str,
    event_type: str,
    content: str = "",
    delta: str = "",
    round_index: Optional[int] = None,
) -> None:
    await manager.broadcast_to_session(
        session_id,
        {
            "type": "assistant_stream",
            "data": {
                "session_id": session_id,
                "task_id": task_id,
                "event_type": event_type,
                "content": content,
                "delta": delta,
                "round": round_index,
                "timestamp": datetime.utcnow().isoformat(),
            },
        },
    )


def _registry_cursor_from_snapshot(snapshot: Optional[Dict[str, Any]]) -> tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
    if not isinstance(snapshot, dict):
        return None, None
    tasks = snapshot.get("tasks") if isinstance(snapshot.get("tasks"), list) else []
    active_task_id = str(snapshot.get("active_task_id") or "").strip()
    active_task = None
    if active_task_id:
        active_task = next(
            (item for item in tasks if isinstance(item, dict) and str(item.get("task_id") or "") == active_task_id),
            None,
        )
    if active_task is None:
        active_task = next(
            (
                item
                for item in tasks
                if isinstance(item, dict) and str(item.get("status") or "") in {"running", "blocked", "pending"}
            ),
            None,
        )
    if not isinstance(active_task, dict):
        return None, None

    steps = active_task.get("steps") if isinstance(active_task.get("steps"), list) else []
    active_step = next(
        (
            item
            for item in steps
            if isinstance(item, dict) and str(item.get("status") or "") in {"running", "blocked"}
        ),
        None,
    )
    if active_step is None:
        step_index = int(active_task.get("current_step_index") or 0)
        active_step = next(
            (
                item
                for item in steps
                if isinstance(item, dict)
                and int(item.get("index") or 0) == step_index
                and str(item.get("status") or "") in {"pending", "running", "blocked"}
            ),
            None,
        )
    if active_step is None:
        active_step = next(
            (
                item
                for item in steps
                if isinstance(item, dict) and str(item.get("status") or "") == "pending"
            ),
            None,
        )
    return active_task, active_step if isinstance(active_step, dict) else None


def _registry_previous_outputs(snapshot: Optional[Dict[str, Any]], *, active_task_id: Optional[str]) -> List[Dict[str, Any]]:
    if not isinstance(snapshot, dict):
        return []
    outputs: List[Dict[str, Any]] = []
    tasks = snapshot.get("tasks") if isinstance(snapshot.get("tasks"), list) else []
    for task in tasks:
        if not isinstance(task, dict):
            continue
        steps = task.get("steps") if isinstance(task.get("steps"), list) else []
        for step in steps:
            if not isinstance(step, dict):
                continue
            if str(step.get("status") or "") != "completed":
                continue
            preview = str(step.get("output_preview") or "").strip()
            if not preview:
                continue
            outputs.append(
                {
                    "task_id": task.get("task_id"),
                    "task_goal": task.get("goal"),
                    "step_type": step.get("type"),
                    "output_preview": preview,
                }
            )
    if active_task_id:
        outputs.sort(key=lambda item: (str(item.get("task_id") or "") != active_task_id, str(item.get("step_type") or "")))
    return outputs


def _render_previous_outputs_text(previous_outputs: List[Dict[str, Any]]) -> str:
    if not previous_outputs:
        return ""
    parts: List[str] = []
    for item in previous_outputs[-8:]:
        parts.append(
            f"- Task: {item.get('task_goal') or item.get('task_id')} | "
            f"Step: {item.get('step_type')}\n"
            f"{short_text(str(item.get('output_preview') or ''), 600)}"
        )
    return "\n\n".join(parts)


async def _persist_registry_pause_checkpoint(
    *,
    db: AsyncSession,
    registry_id: str,
    task_id: str,
    checkpoint: Dict[str, Any],
) -> None:
    _paused_task_checkpoints[registry_id] = checkpoint
    task_row_result = await db.execute(select(SessionTask).where(SessionTask.id == task_id))
    task_row = task_row_result.scalar_one_or_none()
    if not task_row:
        return
    artifacts = dict(task_row.artifacts_json or {})
    artifacts["pause_checkpoint"] = checkpoint
    task_row.artifacts_json = artifacts
    task_row.updated_at = datetime.utcnow()


async def _load_registry_pause_checkpoint(
    *,
    db: AsyncSession,
    registry_id: str,
) -> Optional[Dict[str, Any]]:
    checkpoint = _paused_task_checkpoints.get(registry_id)
    if checkpoint:
        return checkpoint
    task_result = await db.execute(
        select(SessionTask).where(SessionTask.registry_id == registry_id).order_by(SessionTask.task_order.asc())
    )
    tasks = task_result.scalars().all()
    for task in tasks:
        artifacts = task.artifacts_json or {}
        raw = artifacts.get("pause_checkpoint")
        if isinstance(raw, dict):
            _paused_task_checkpoints[registry_id] = raw
            return raw
    return None


async def _clear_registry_pause_checkpoint(
    *,
    db: AsyncSession,
    registry_id: str,
) -> None:
    _paused_task_checkpoints.pop(registry_id, None)
    task_result = await db.execute(select(SessionTask).where(SessionTask.registry_id == registry_id))
    tasks = task_result.scalars().all()
    changed = False
    for task in tasks:
        artifacts = dict(task.artifacts_json or {})
        if "pause_checkpoint" in artifacts:
            artifacts.pop("pause_checkpoint", None)
            task.artifacts_json = artifacts
            task.updated_at = datetime.utcnow()
            changed = True
    if changed:
        await db.flush()


def _task_registry_event_payload(
    snapshot: Optional[Dict[str, Any]],
    *,
    active_task: Optional[Dict[str, Any]] = None,
    active_step: Optional[Dict[str, Any]] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "task_registry": snapshot,
    }
    if active_task is not None:
        payload["task"] = active_task
    if active_step is not None:
        payload["step"] = active_step
    if extra:
        payload.update(extra)
    return payload


async def _execute_task_registry_flow(
    *,
    db: AsyncSession,
    session: Session,
    session_id: str,
    registry_id: str,
    current_user_message: str,
    history_messages: List[ChatMessage],
    context,
    permitted_files_info: Dict[str, Dict[str, str]],
    available_tools_all: List[Dict[str, Any]],
    router_tool_hints: Optional[Dict[str, Any]],
    router_state: Optional[Dict[str, Any]],
    model: Optional[str],
    use_tools: bool,
    active_file_id: Optional[str],
    active_page: Optional[int],
    active_visible_unit: Optional[str],
    active_visible_start: Optional[int],
    active_visible_end: Optional[int],
    active_anchor_block_id: Optional[str],
    compact_mode: Optional[str],
    defer_compaction: bool = False,
) -> Dict[str, Any]:
    combined_outputs: List[str] = []
    latest_user_facing_output = ""
    tool_results: List[Dict[str, Any]] = []
    citations: List[Dict[str, Any]] = []
    retrieval_meta: Dict[str, Any] = {}
    compact_meta: Dict[str, Any] = {"triggered": False}
    budget_meta: Dict[str, Any] = {"triggered": False}
    compact_phase = "none"
    execution_meta: Dict[str, Any] = {
        "runtime": "legacy",
        "graph_version": 0,
        "node_timings_ms": {},
        "compact_phase": compact_phase,
    }
    last_response: Dict[str, Any] = {}
    global_rules_text = get_global_rules_text()
    normalized_router_tool_hints = router_tool_hints if isinstance(router_tool_hints, dict) else {}
    router_max_rounds = normalized_router_tool_hints.get("max_rounds")
    try:
        max_tool_rounds_default = max(1, min(8, int(router_max_rounds)))
    except Exception:
        max_tool_rounds_default = 6

    while True:
        _assert_task_not_cancelled(registry_id)
        registry_snapshot = await get_registry_snapshot(db, registry_id)
        active_task, active_step = _registry_cursor_from_snapshot(registry_snapshot)
        if not registry_snapshot or not active_task or not active_step:
            break

        step_type = str(active_step.get("type") or "")
        step_definition = get_step_definition(step_type)
        previous_outputs = _registry_previous_outputs(
            registry_snapshot,
            active_task_id=str(active_task.get("task_id") or ""),
        )
        previous_outputs_text = _render_previous_outputs_text(previous_outputs)
        viewport_memory = await build_viewport_memory_service(
            db=db,
            session_id=session_id,
            context_permissions=context.permissions,
            active_file_id=active_file_id,
            active_page=active_page,
            active_visible_unit=active_visible_unit,
            active_visible_start=active_visible_start,
            active_visible_end=active_visible_end,
            active_anchor_block_id=active_anchor_block_id,
            require_effective_note_view=True,
        )
        missing_inputs = resolve_step_missing_inputs(
            step_type=step_type,
            user_message=current_user_message,
            permissions=session.permissions or {},
            permitted_files_info=permitted_files_info,
            viewport_memory=viewport_memory,
            prior_outputs=previous_outputs,
        )

        registry_row, task_row, step_row = await ensure_registry_cursor(db=db, registry_id=registry_id)
        if not registry_row or not task_row or not step_row:
            break

        if missing_inputs:
            blocked_markdown = build_missing_inputs_markdown(step_type, missing_inputs)
            await mark_step_blocked(
                db=db,
                registry=registry_row,
                task=task_row,
                step=step_row,
                reason="missing_required_inputs",
                missing_inputs=missing_inputs,
                output_markdown=blocked_markdown,
                output_json={"step_type": step_type},
            )
            blocked_snapshot = await get_registry_snapshot(db, registry_id)
            await _emit_task_event(
                db=db,
                session_id=session_id,
                task_id=registry_id,
                event_type="step_blocked",
                stage="blocked",
                message=f"Step blocked: {step_type}",
                progress=None,
                status="paused",
                payload=_task_registry_event_payload(
                    blocked_snapshot,
                    active_task=active_task,
                    active_step=active_step,
                    extra={"missing_inputs": missing_inputs},
                ),
            )
            return {
                "paused": False,
                "failed": False,
                "blocked": True,
                "content": blocked_markdown,
                "tool_results": tool_results,
                "citations": citations,
                "budget_meta": budget_meta,
                "compact_meta": compact_meta,
                "retrieval_meta": retrieval_meta,
                "execution_meta": execution_meta,
                "compact_phase": compact_phase,
                "task_registry": blocked_snapshot,
                "awaiting_user_input": None,
                "response": last_response,
            }

        await mark_step_running(db=db, registry=registry_row, task=task_row, step=step_row)
        registry_snapshot = await get_registry_snapshot(db, registry_id)
        active_task, active_step = _registry_cursor_from_snapshot(registry_snapshot)

        if int(active_step.get("index") or 0) == 0:
            await _emit_task_event(
                db=db,
                session_id=session_id,
                task_id=registry_id,
                event_type="task_started",
                stage="executing",
                message=f"Task started: {active_task.get('goal')}",
                progress=20,
                status="running",
                payload=_task_registry_event_payload(
                    registry_snapshot,
                    active_task=active_task,
                    active_step=active_step,
                ),
            )

        await _emit_task_event(
            db=db,
            session_id=session_id,
            task_id=registry_id,
            event_type="step_started",
            stage="executing",
            message=f"Step started: {step_type}",
            progress=25,
            status="running",
            payload=_task_registry_event_payload(
                registry_snapshot,
                active_task=active_task,
                active_step=active_step,
            ),
        )

        if step_type == "CONTEXT_COMPACT":
            compact_anchor = {
                "registry_id": registry_id,
                "completed_tasks": [
                    {
                        "task_id": task.get("task_id"),
                        "goal": task.get("goal"),
                        "completed_steps": [
                            step.get("type")
                            for step in (task.get("steps") or [])
                            if isinstance(step, dict) and str(step.get("status") or "") == "completed"
                        ],
                    }
                    for task in (registry_snapshot.get("tasks") or [])
                    if isinstance(task, dict) and str(task.get("status") or "") == "completed"
                ],
                "next_step": None,
            }
            current_task_id = task_row.id
            _, next_task_row, next_step_row = await complete_step(
                db=db,
                registry=registry_row,
                task=task_row,
                step=step_row,
                output_markdown=None,
                output_json={"step_type": step_type},
                citations=[],
                compact_anchor=compact_anchor,
                task_artifacts={
                    **(task_row.artifacts_json or {}),
                    "compact_anchor": compact_anchor,
                },
            )
            registry_snapshot = await get_registry_snapshot(db, registry_id)
            await _emit_task_event(
                db=db,
                session_id=session_id,
                task_id=registry_id,
                event_type="step_completed",
                stage="executing",
                message=f"Step completed: {step_type}",
                progress=90,
                status="running" if registry_snapshot and registry_snapshot.get("status") == "running" else "completed",
                payload=_task_registry_event_payload(
                    registry_snapshot,
                    active_task=active_task,
                    active_step=active_step,
                    extra={"compact_anchor": compact_anchor},
                ),
            )
            if next_task_row is None and next_step_row is None:
                await _emit_task_event(
                    db=db,
                    session_id=session_id,
                    task_id=registry_id,
                    event_type="task_completed",
                    stage="done",
                    message=f"Task completed: {active_task.get('goal')}",
                    progress=100,
                    status="completed",
                    payload=_task_registry_event_payload(registry_snapshot),
                )
                await _emit_task_event(
                    db=db,
                    session_id=session_id,
                    task_id=registry_id,
                    event_type="registry_completed",
                    stage="done",
                    message="Task registry completed",
                    progress=100,
                    status="completed",
                    payload=_task_registry_event_payload(registry_snapshot),
                )
            elif next_task_row and next_task_row.id != current_task_id:
                next_snapshot = await get_registry_snapshot(db, registry_id)
                next_task, next_step = _registry_cursor_from_snapshot(next_snapshot)
                await _emit_task_event(
                    db=db,
                    session_id=session_id,
                    task_id=registry_id,
                    event_type="task_completed",
                    stage="executing",
                    message=f"Task completed: {active_task.get('goal')}",
                    progress=92,
                    status="running",
                    payload=_task_registry_event_payload(next_snapshot),
                )
                await _emit_task_event(
                    db=db,
                    session_id=session_id,
                    task_id=registry_id,
                    event_type="task_started",
                    stage="executing",
                    message=f"Task started: {next_task.get('goal') if next_task else next_task_row.goal}",
                    progress=93,
                    status="running",
                    payload=_task_registry_event_payload(next_snapshot, active_task=next_task, active_step=next_step),
                )
            continue

        step_tools = filter_tools_for_step(
            step_type=step_type,
            tools=available_tools_all,
            user_message=current_user_message,
            permissions=session.permissions or {},
            permitted_files_info=permitted_files_info,
        )
        step_tools = prioritize_tools_with_router_hints(
            tools=step_tools,
            router_tool_hints=normalized_router_tool_hints,
        )
        if _message_explicitly_requests_tool_calls(current_user_message):
            step_tools = [tool for tool in step_tools if _tool_spec_name(tool) != "pause_for_user_choice"]
        step_allowed_groups = [str(item) for item in (step_definition.get("allowed_tool_groups") or [])]
        readable_files = _readable_file_ids(
            permissions=session.permissions or {},
            permitted_files_info=permitted_files_info,
        )
        retrieval_summary_text = None
        if readable_files and any(group in {"reader", "visual"} for group in step_allowed_groups):
            await _emit_task_event(
                db=db,
                session_id=session_id,
                task_id=registry_id,
                event_type="retrieval_started",
                stage="executing",
                message=f"Running retrieval bundle for {step_type}",
                progress=30,
                status="running",
                payload=_task_registry_event_payload(
                    registry_snapshot,
                    active_task=active_task,
                    active_step=active_step,
                ),
            )
            retrieval_result = await retrieve_context_blocks_service(
                db=db,
                query=current_user_message,
                readable_files=readable_files,
                permitted_files_info=permitted_files_info,
                active_file_id=active_file_id,
                active_page=active_page,
            )
            retrieval_meta = retrieval_result.get("retrieval_meta") if isinstance(retrieval_result, dict) else retrieval_meta
            retrieval_summary_text = "\n\n".join((retrieval_result or {}).get("context_parts") or [])[:5000]
            await _emit_task_event(
                db=db,
                session_id=session_id,
                task_id=registry_id,
                event_type="retrieval_completed",
                stage="executing",
                message=f"Retrieval completed for {step_type}",
                progress=34,
                status="running",
                payload=_task_registry_event_payload(
                    registry_snapshot,
                    active_task=active_task,
                    active_step=active_step,
                    extra={"retrieval_meta": retrieval_meta},
                ),
            )
        context_pack = await build_task_registry_context_pack(
            db=db,
            session_id=session_id,
            current_user_message=current_user_message,
            history_messages=_history_messages_for_layered_pack(history_messages),
            registry_snapshot=registry_snapshot,
            active_task=active_task,
            active_step=active_step,
            step_definition=step_definition,
            global_rules_text=global_rules_text,
            permissions=session.permissions or {},
            permitted_files_info=permitted_files_info,
            viewport_memory=viewport_memory,
            available_tools=step_tools if use_tools else [],
            router_tool_hints=normalized_router_tool_hints,
            previous_tool_results=tool_results,
            previous_step_outputs_text=previous_outputs_text,
            retrieval_summary_text=retrieval_summary_text,
            model=model,
            compact_mode=compact_mode,
            defer_compaction=defer_compaction,
        )
        budget_meta = context_pack.get("budget_meta") or {"triggered": False}
        try:
            window_usage = (budget_meta or {}).get("window_usage") or {}
            logger.info(
                "task_registry budget monitor session_id=%s registry_id=%s step=%s total=%s window=%s ratio=%s status=%s reason=%s",
                session_id,
                registry_id,
                step_type,
                budget_meta.get("total_input_tokens"),
                budget_meta.get("context_window_tokens"),
                window_usage.get("ratio"),
                window_usage.get("status"),
                budget_meta.get("reason"),
            )
        except Exception:
            pass
        compact_snapshot = context_pack.get("compact_snapshot") or {}
        compact_phase = str(context_pack.get("compact_phase") or compact_phase)
        execution_meta["compact_phase"] = compact_phase
        compact_meta = {
            "triggered": bool(context_pack.get("compact_triggered")),
            "reason": budget_meta.get("reason"),
            "compaction_id": context_pack.get("compact_compaction_id") or compact_snapshot.get("compaction_id"),
            "before_tokens": context_pack.get("compact_before_tokens"),
            "after_tokens": context_pack.get("compact_after_tokens"),
        }
        if compact_phase == "deferred":
            await _emit_task_event(
                db=db,
                session_id=session_id,
                task_id=registry_id,
                event_type="compact_deferred",
                stage="executing",
                message=f"Compaction deferred during {step_type}",
                progress=36,
                status="running",
                payload=_task_registry_event_payload(
                    registry_snapshot,
                    active_task=active_task,
                    active_step=active_step,
                    extra={"compact_meta": compact_meta},
                ),
            )
        elif compact_phase == "hard_emergency":
            await _emit_task_event(
                db=db,
                session_id=session_id,
                task_id=registry_id,
                event_type="compact_executed",
                stage="executing",
                message=f"Hard emergency compact executed during {step_type}",
                progress=36,
                status="running",
                payload=_task_registry_event_payload(
                    registry_snapshot,
                    active_task=active_task,
                    active_step=active_step,
                    extra={"compact_meta": compact_meta},
                ),
            )

        transient_messages: List[Dict[str, Any]] = []
        model_round = 0
        max_tool_rounds = max_tool_rounds_default
        step_content = ""
        force_tool_call_requested = (
            bool(use_tools)
            and bool(step_tools)
            and _message_explicitly_requests_tool_calls(current_user_message)
            and any(group in {"reader", "visual", "editor"} for group in step_allowed_groups)
        )
        forced_tool_choice = _build_forced_tool_choice(step_tools) if force_tool_call_requested else "auto"
        force_tool_retry_used = False
        force_tool_bootstrap_used = False

        while True:
            _assert_task_not_cancelled(registry_id)
            messages = [*context_pack["messages"], *transient_messages]
            await _emit_task_event(
                db=db,
                session_id=session_id,
                task_id=registry_id,
                event_type="model_call_started",
                stage="executing",
                message=f"Calling language model for {step_type} (round {model_round + 1})",
                progress=35,
                status="running",
                payload=_task_registry_event_payload(
                    registry_snapshot,
                    active_task=active_task,
                    active_step=active_step,
                    extra={"budget_meta": budget_meta, "compact_meta": compact_meta},
                ),
            )

            round_index = model_round + 1
            allow_model_streaming = not str(model or "").strip().lower().startswith("claude-")
            streamed_chunks: List[str] = []

            async def on_stream_delta(delta: str) -> None:
                if not delta:
                    return
                streamed_chunks.append(delta)
                await _emit_assistant_stream_event(
                    session_id=session_id,
                    task_id=registry_id,
                    event_type="delta",
                    delta=delta,
                    content="".join(streamed_chunks),
                    round_index=round_index,
                )

            if allow_model_streaming:
                await _emit_assistant_stream_event(
                    session_id=session_id,
                    task_id=registry_id,
                    event_type="started",
                    round_index=round_index,
                )

            desired_tool_choice: Any = (
                forced_tool_choice
                if (force_tool_call_requested and model_round == 0 and use_tools and step_tools)
                else "auto"
            )
            tool_choice_candidates: List[Any] = [desired_tool_choice]
            if desired_tool_choice != "required":
                tool_choice_candidates.append("required")
            if desired_tool_choice != "auto":
                tool_choice_candidates.append("auto")
            seen_tool_choices: set[str] = set()
            normalized_candidates: List[Any] = []
            for candidate in tool_choice_candidates:
                key = json.dumps(candidate, ensure_ascii=False, sort_keys=True) if isinstance(candidate, dict) else str(candidate)
                if key in seen_tool_choices:
                    continue
                seen_tool_choices.add(key)
                normalized_candidates.append(candidate)

            last_call_error: Optional[Exception] = None
            for candidate in normalized_candidates:
                try:
                    last_response = await llm_service.chat_completion(
                        messages=messages,
                        model=model,
                        stream=allow_model_streaming,
                        tools=step_tools if use_tools else None,
                        tool_choice=candidate,
                        on_stream_delta=on_stream_delta if allow_model_streaming else None,
                    )
                    break
                except Exception as exc:
                    last_call_error = exc
                    continue
            else:
                if last_call_error:
                    raise last_call_error
                raise RuntimeError("Model call failed without explicit exception")

            if allow_model_streaming:
                await _emit_assistant_stream_event(
                    session_id=session_id,
                    task_id=registry_id,
                    event_type="completed",
                    content=last_response.get("content", "") or "".join(streamed_chunks),
                    round_index=round_index,
                )

            round_tool_calls = last_response.get("tool_calls") or []
            await _emit_task_event(
                db=db,
                session_id=session_id,
                task_id=registry_id,
                event_type="model_call_completed",
                stage="executing",
                message=f"Model returned response for {step_type}",
                progress=55,
                status="running",
                payload=_task_registry_event_payload(
                    registry_snapshot,
                    active_task=active_task,
                    active_step=active_step,
                    extra={"round": model_round + 1, "tool_call_count": len(round_tool_calls)},
                ),
            )

            step_content = str(last_response.get("content") or "").strip()
            if (
                use_tools
                and force_tool_call_requested
                and not round_tool_calls
                and not force_tool_retry_used
                and model_round == 0
                and step_tools
            ):
                force_tool_retry_used = True
                transient_messages.append(
                    {
                        "role": "system",
                        "content": (
                            "Tool invocation is required for this step. "
                            "Call at least one exposed tool now and do not simulate execution."
                        ),
                    }
                )
                continue
            if (
                use_tools
                and force_tool_call_requested
                and not round_tool_calls
                and force_tool_retry_used
                and not force_tool_bootstrap_used
                and model_round == 0
            ):
                forced_call = _build_forced_tool_call(
                    tool_specs=step_tools,
                    current_user_message=current_user_message,
                    readable_file_ids=readable_files,
                    active_file_id=active_file_id,
                    active_page=active_page,
                )
                if forced_call:
                    force_tool_bootstrap_used = True
                    round_tool_calls = [forced_call]
            if not use_tools or not round_tool_calls:
                break
            if model_round >= max_tool_rounds:
                step_content = (step_content + "\n\n[Agent reached max tool rounds for this step.]").strip()
                break

            transient_messages.append(
                {
                    "role": "assistant",
                    "content": last_response.get("content", ""),
                    "tool_calls": round_tool_calls,
                }
            )

            for idx, tool_call in enumerate(round_tool_calls):
                _assert_task_not_cancelled(registry_id)
                tool_name, tool_args, tool_call_id = _parse_tool_call(tool_call)
                if not tool_call_id:
                    tool_call_id = f"{tool_name}:{idx}"
                tool_args, inferred_file_id = _normalize_tool_file_arguments(
                    tool_name=tool_name,
                    tool_args=tool_args,
                    permissions=session.permissions or {},
                    permitted_files_info=permitted_files_info,
                )
                action_kind = _action_kind_for_tool(tool_name)
                target_file_id = str(tool_args.get("file_id") or "")
                target_file_name = (
                    (permitted_files_info.get(target_file_id) or {}).get("name")
                    if target_file_id
                    else None
                )
                await _emit_task_event(
                    db=db,
                    session_id=session_id,
                    task_id=registry_id,
                    event_type="tool_started",
                    stage="executing",
                    message=f"Running tool: {tool_name}",
                    progress=60,
                    status="running",
                    payload=_task_registry_event_payload(
                        registry_snapshot,
                        active_task=active_task,
                        active_step=active_step,
                        extra={
                            "tool": tool_name,
                            "action_kind": action_kind,
                            "target_file_id": target_file_id or None,
                            "target_file_name": target_file_name,
                            "target_file_inferred": bool(inferred_file_id),
                        },
                    ),
                )

                result = await tool_executor.execute(tool_name=tool_name, arguments=tool_args, context=context)
                result_payload = result.to_dict()
                tool_results.append({"tool": tool_name, "result": result_payload})
                _append_unique_citations(
                    citations,
                    _collect_citations_from_tool_result(
                        tool_name=tool_name,
                        result_payload=result_payload,
                        target_file_id=target_file_id or None,
                    ),
                )
                transient_messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "content": json.dumps(
                            {
                                "ok": result.success,
                                "tool": tool_name,
                                "data": result_payload.get("data", {}),
                                "error": result_payload.get("error"),
                                "error_code": result_payload.get("error_code"),
                            },
                            ensure_ascii=False,
                        ),
                    }
                )

                await _emit_task_event(
                    db=db,
                    session_id=session_id,
                    task_id=registry_id,
                    event_type="tool_completed",
                    stage="executing",
                    message=f"Tool finished: {tool_name}",
                    progress=70,
                    status="running",
                    payload=_task_registry_event_payload(
                        registry_snapshot,
                        active_task=active_task,
                        active_step=active_step,
                        extra={
                            "tool": tool_name,
                            "success": result.success,
                            "error": result.error,
                            "action_kind": action_kind,
                            "target_file_id": target_file_id or None,
                            "target_file_name": target_file_name,
                            "target_file_inferred": bool(inferred_file_id),
                        },
                    ),
                )

                if (
                    result.success
                    and tool_name == "pause_for_user_choice"
                    and (result.data or {}).get("pause_requested") is True
                ):
                    prompt = _extract_prompt_from_pause_result(result_payload)
                    if not prompt:
                        raise ValueError("pause_for_user_choice returned invalid prompt payload")

                    checkpoint = {
                        "session_id": session_id,
                        "registry_id": registry_id,
                        "task_id": task_row.id,
                        "step_index": step_row.step_index,
                        "goal": active_task.get("goal"),
                        "model": model,
                        "use_tools": use_tools,
                        "active_file_id": active_file_id,
                        "active_page": active_page,
                        "active_visible_unit": active_visible_unit,
                    "active_visible_start": active_visible_start,
                    "active_visible_end": active_visible_end,
                        "active_anchor_block_id": active_anchor_block_id,
                        "compact_mode": compact_mode,
                        "router_state": router_state or {},
                        "router_tool_hints": normalized_router_tool_hints,
                        "tool_results": tool_results,
                        "budget_meta": budget_meta,
                        "compact_meta": compact_meta,
                        "prompt": prompt,
                    }
                    await _persist_registry_pause_checkpoint(
                        db=db,
                        registry_id=registry_id,
                        task_id=task_row.id,
                        checkpoint=checkpoint,
                    )
                    await mark_step_blocked(
                        db=db,
                        registry=registry_row,
                        task=task_row,
                        step=step_row,
                        reason="awaiting_user_input",
                        missing_inputs=[],
                        output_markdown="Task paused: waiting for user choice.",
                        output_json={"prompt": prompt},
                    )
                    paused_snapshot = await get_registry_snapshot(db, registry_id)
                    await _emit_task_event(
                        db=db,
                        session_id=session_id,
                        task_id=registry_id,
                        event_type="user_input_requested",
                        stage="blocked",
                        message="User input required to continue task",
                        progress=None,
                        status="paused",
                        payload=_task_registry_event_payload(
                            paused_snapshot,
                            active_task=active_task,
                            active_step=active_step,
                            extra={"prompt": prompt, "action_kind": "pause", "tool": tool_name},
                        ),
                    )
                    return {
                        "paused": True,
                        "failed": False,
                        "blocked": False,
                        "content": "Task paused: waiting for user choice.",
                        "tool_results": tool_results,
                        "citations": citations,
                        "budget_meta": budget_meta,
                        "compact_meta": compact_meta,
                        "retrieval_meta": retrieval_meta,
                        "execution_meta": execution_meta,
                        "compact_phase": compact_phase,
                        "task_registry": paused_snapshot,
                        "awaiting_user_input": prompt,
                        "response": last_response,
                    }

            model_round += 1
            viewport_memory = await build_viewport_memory_service(
                db=db,
                session_id=session_id,
                context_permissions=context.permissions,
                active_file_id=active_file_id,
                active_page=active_page,
                active_visible_unit=active_visible_unit,
                active_visible_start=active_visible_start,
                active_visible_end=active_visible_end,
                active_anchor_block_id=active_anchor_block_id,
                require_effective_note_view=True,
            )
            context_pack = await build_task_registry_context_pack(
                db=db,
                session_id=session_id,
                current_user_message=current_user_message,
                history_messages=_history_messages_for_layered_pack(history_messages),
                registry_snapshot=registry_snapshot,
                active_task=active_task,
                active_step=active_step,
                step_definition=step_definition,
                global_rules_text=global_rules_text,
                permissions=session.permissions or {},
                permitted_files_info=permitted_files_info,
                viewport_memory=viewport_memory,
                available_tools=step_tools if use_tools else [],
                router_tool_hints=normalized_router_tool_hints,
                previous_tool_results=tool_results,
                previous_step_outputs_text=previous_outputs_text,
                retrieval_summary_text=retrieval_summary_text,
                model=model,
                compact_mode=compact_mode,
                defer_compaction=defer_compaction,
            )
            budget_meta = context_pack.get("budget_meta") or budget_meta
            try:
                window_usage = (budget_meta or {}).get("window_usage") or {}
                logger.info(
                    "task_registry budget monitor session_id=%s registry_id=%s step=%s round=%s total=%s window=%s ratio=%s status=%s reason=%s",
                    session_id,
                    registry_id,
                    step_type,
                    model_round,
                    budget_meta.get("total_input_tokens"),
                    budget_meta.get("context_window_tokens"),
                    window_usage.get("ratio"),
                    window_usage.get("status"),
                    budget_meta.get("reason"),
                )
            except Exception:
                pass
            compact_snapshot = context_pack.get("compact_snapshot") or {}
            compact_phase = str(context_pack.get("compact_phase") or compact_phase)
            execution_meta["compact_phase"] = compact_phase
            compact_meta = {
                "triggered": bool(context_pack.get("compact_triggered")),
                "reason": budget_meta.get("reason"),
                "compaction_id": context_pack.get("compact_compaction_id") or compact_snapshot.get("compaction_id"),
                "before_tokens": context_pack.get("compact_before_tokens"),
                "after_tokens": context_pack.get("compact_after_tokens"),
            }

        visible_output = step_content
        if visible_output:
            latest_user_facing_output = visible_output
            combined_outputs.append(visible_output)

        current_task_id = task_row.id
        _, next_task_row, next_step_row = await complete_step(
            db=db,
            registry=registry_row,
            task=task_row,
            step=step_row,
            output_markdown=step_content or None,
            output_json={
                "step_type": step_type,
                "budget_meta": budget_meta,
                "compact_meta": compact_meta,
            },
            citations=citations,
            task_artifacts={
                **(task_row.artifacts_json or {}),
                "budget_meta": budget_meta,
                "viewport_memory_refs": (viewport_memory or {}).get("refs") or [],
            },
        )
        registry_snapshot = await get_registry_snapshot(db, registry_id)
        await _emit_task_event(
            db=db,
            session_id=session_id,
            task_id=registry_id,
            event_type="step_completed",
            stage="executing",
            message=f"Step completed: {step_type}",
            progress=88,
            status="running" if registry_snapshot and registry_snapshot.get("status") == "running" else "completed",
            payload=_task_registry_event_payload(
                registry_snapshot,
                active_task=active_task,
                active_step=active_step,
                extra={"budget_meta": budget_meta, "compact_meta": compact_meta},
            ),
        )

        if next_task_row is None and next_step_row is None:
            await _emit_task_event(
                db=db,
                session_id=session_id,
                task_id=registry_id,
                event_type="task_completed",
                stage="done",
                message=f"Task completed: {active_task.get('goal')}",
                progress=96,
                status="completed",
                payload=_task_registry_event_payload(registry_snapshot),
            )
            await _emit_task_event(
                db=db,
                session_id=session_id,
                task_id=registry_id,
                event_type="registry_completed",
                stage="done",
                message="Task registry completed",
                progress=100,
                status="completed",
                payload=_task_registry_event_payload(registry_snapshot),
            )
            break

        if next_task_row and next_task_row.id != current_task_id:
            next_snapshot = await get_registry_snapshot(db, registry_id)
            next_task, next_step = _registry_cursor_from_snapshot(next_snapshot)
            await _emit_task_event(
                db=db,
                session_id=session_id,
                task_id=registry_id,
                event_type="task_completed",
                stage="executing",
                message=f"Task completed: {active_task.get('goal')}",
                progress=90,
                status="running",
                payload=_task_registry_event_payload(next_snapshot),
            )
            await _emit_task_event(
                db=db,
                session_id=session_id,
                task_id=registry_id,
                event_type="task_started",
                stage="executing",
                message=f"Task started: {next_task.get('goal') if next_task else next_task_row.goal}",
                progress=92,
                status="running",
                payload=_task_registry_event_payload(next_snapshot, active_task=next_task, active_step=next_step),
            )

    final_content = (
        latest_user_facing_output.strip()
        or "\n\n".join([item for item in combined_outputs if item.strip()]).strip()
        or "Task completed."
    )
    compact_mode_normalized = str(compact_mode or "auto").strip().lower()
    if defer_compaction and compact_mode_normalized != "off":
        force_finalize_compact = compact_mode_normalized == "force"
        window_usage = (budget_meta or {}).get("window_usage") if isinstance(budget_meta, dict) else {}
        try:
            window_ratio = float((window_usage or {}).get("ratio") or 0.0)
        except Exception:
            window_ratio = 0.0
        finalize_reasons = {
            "over_target_budget",
            "history_rebalanced",
            "runtime_trimmed",
            "hard_emergency_limit",
            "force_compact",
        }
        should_finalize_compact = (
            force_finalize_compact
            or bool((budget_meta or {}).get("triggered"))
            or window_ratio >= float(settings.COMPACT_TRIGGER_RATIO or 0.8)
            or str((budget_meta or {}).get("reason") or "") in finalize_reasons
        )
        conversational = _history_messages_for_layered_pack(history_messages)
        conversational.append(
            {
                "id": f"{registry_id}:assistant-final",
                "role": "assistant",
                "content": final_content,
            }
        )
        older_messages = conversational[:-6] if len(conversational) > 6 else []
        if older_messages and should_finalize_compact:
            compact_budget = int(
                max(
                    256,
                    settings.MODEL_CONTEXT_WINDOW_TOKENS
                    * float(settings.COMPACT_TRIGGER_RATIO or 0.8)
                    * float(settings.COMPACT_DIALOGUE_BUCKET_RATIO or 0.3),
                )
            )
            finalize_compact = await compact_dialogue_bucket_service(
                db=db,
                session_id=session_id,
                older_messages=older_messages,
                budget_tokens=compact_budget,
                model=model,
                task_registry_snapshot=registry_snapshot if isinstance(registry_snapshot, dict) else None,
                active_task=active_task if isinstance(active_task, dict) else None,
                active_step=active_step if isinstance(active_step, dict) else None,
                trigger_reason="turn_finalize_auto",
            )
            if finalize_compact.get("triggered"):
                compact_phase = "turn_finalize"
                compact_meta = {
                    "triggered": True,
                    "reason": "turn_finalize_auto",
                    "compaction_id": finalize_compact.get("compaction_id"),
                    "before_tokens": finalize_compact.get("before_tokens"),
                    "after_tokens": finalize_compact.get("after_tokens"),
                }
                await _emit_task_event(
                    db=db,
                    session_id=session_id,
                    task_id=registry_id,
                    event_type="compact_executed",
                    stage="done",
                    message="Turn-finalize compact executed",
                    progress=99,
                    status="completed",
                    payload=_task_registry_event_payload(
                        registry_snapshot,
                        active_task=active_task if isinstance(active_task, dict) else None,
                        active_step=active_step if isinstance(active_step, dict) else None,
                        extra={"compact_meta": compact_meta},
                    ),
                )
    execution_meta = {
        "runtime": "langgraph" if settings.LANGGRAPH_RUNTIME_ENABLED else "legacy",
        "graph_version": GRAPH_VERSION if settings.LANGGRAPH_RUNTIME_ENABLED else 0,
        "node_timings_ms": execution_meta.get("node_timings_ms") if isinstance(execution_meta, dict) else {},
        "compact_phase": compact_phase,
    }
    completed_snapshot = await get_registry_snapshot(db, registry_id)
    return {
        "paused": False,
        "failed": False,
        "blocked": False,
        "content": final_content,
        "tool_results": tool_results,
        "citations": citations,
        "budget_meta": budget_meta,
        "compact_meta": compact_meta,
        "retrieval_meta": retrieval_meta,
        "execution_meta": execution_meta,
        "compact_phase": compact_phase,
        "task_registry": completed_snapshot,
        "awaiting_user_input": None,
        "response": last_response,
    }


async def _visible_file_info_for_session(
    *,
    db: AsyncSession,
    session: Session,
    context_files: List[str],
) -> Dict[str, Dict[str, str]]:
    visible_file_ids = set(context_files or [])
    for fid, perm in (session.permissions or {}).items():
        if fid.startswith("_"):
            continue
        if perm in ("read", "write"):
            visible_file_ids.add(fid)
        elif perm == "none" and fid in visible_file_ids:
            visible_file_ids.remove(fid)

    permitted_files_info: Dict[str, Dict[str, str]] = {}
    if visible_file_ids:
        files_result = await db.execute(
            select(FileModel)
            .where(FileModel.id.in_(list(visible_file_ids)))
            .where(FileModel.file_type != FileType.FOLDER)
        )
        files = files_result.scalars().all()
        permitted_files_info = {
            f.id: {"name": f.name, "type": f.file_type.value}
            for f in files
        }
    return permitted_files_info


def _readable_file_ids(
    *,
    permissions: Dict[str, str],
    permitted_files_info: Dict[str, Dict[str, str]],
) -> List[str]:
    readable: List[str] = []
    for file_id in permitted_files_info.keys():
        perm = str((permissions or {}).get(file_id) or "")
        if perm in {"read", "write"}:
            readable.append(file_id)
    return readable


async def _chat_completion_task_registry(request: ChatRequest, db: AsyncSession) -> APIResponse:
    registry_id = request.task_id or str(uuid.uuid4())
    existing_task_id = _running_task_by_session.get(request.session_id)
    if existing_task_id and existing_task_id != registry_id:
        raise HTTPException(
            status_code=409,
            detail=f"Session already has a running task ({existing_task_id}). Cancel it before starting a new one.",
        )

    _running_task_by_session[request.session_id] = registry_id
    _task_to_session[registry_id] = request.session_id
    keep_task_mapping = False
    compact_meta: Dict[str, Any] = {"triggered": False}
    budget_meta: Dict[str, Any] = {"triggered": False}

    try:
        result = await db.execute(select(Session).where(Session.id == request.session_id))
        session = result.scalar_one_or_none()

        if not session:
            initial_permissions, _ = await _coerce_permissions_for_non_md_write(
                db=db,
                permissions=request.permissions or {},
            )
            session = Session(
                id=request.session_id,
                name=f"Session {request.session_id[:8]}",
                permissions=initial_permissions,
            )
            db.add(session)
            await db.commit()
            await db.refresh(session)
            permission_middleware.invalidate_cache(request.session_id)
        elif request.permissions is not None:
            coerced_permissions, _ = await _coerce_permissions_for_non_md_write(
                db=db,
                permissions=request.permissions or {},
            )
            session.permissions = coerced_permissions
            flag_modified(session, "permissions")
            await db.commit()
            permission_middleware.invalidate_cache(request.session_id)

        current_permissions = session.permissions or {}
        normalized_permissions, _ = await _coerce_permissions_for_non_md_write(
            db=db,
            permissions=current_permissions,
        )
        if normalized_permissions != current_permissions:
            session.permissions = normalized_permissions
            flag_modified(session, "permissions")
            await db.commit()
            permission_middleware.invalidate_cache(request.session_id)

        user_message = ChatMessage(
            id=str(uuid.uuid4()),
            session_id=request.session_id,
            role="user",
            content=request.message,
        )
        db.add(user_message)
        await db.commit()
        await db.refresh(user_message)

        context = await permission_middleware.create_context(
            session_id=request.session_id,
            db=db,
        )
        permitted_files_info = await _visible_file_info_for_session(
            db=db,
            session=session,
            context_files=request.context_files or [],
        )
        readable_files = [
            file_id
            for file_id, perm in (context.permissions or {}).items()
            if perm in {PermissionLevel.READ, PermissionLevel.WRITE}
        ]
        file_access_requested = bool(request.active_file_id) or bool(request.context_files) or _message_likely_requires_file_access(request.message)
        if not readable_files and file_access_requested:
            denied_text = (
                "我当前没有权限访问可读文件，无法继续引用或总结已隐藏文档的内容。"
                "请先恢复目标文件的 read/write 权限后再继续。"
            )
            assistant_message = ChatMessage(
                id=str(uuid.uuid4()),
                session_id=request.session_id,
                role="assistant",
                content=denied_text,
                tool_calls=[],
                tool_results=[],
                citations=[],
            )
            db.add(assistant_message)
            await db.commit()
            return APIResponse(
                success=True,
                data={
                    "message_id": assistant_message.id,
                    "content": denied_text,
                    "role": "assistant",
                    "timestamp": assistant_message.timestamp.isoformat(),
                    "tool_calls": [],
                    "tool_results": [],
                    "citations": [],
                    "task_id": registry_id,
                    "paused": False,
                    "cancelled": False,
                    "failed": False,
                    "task_registry": {
                        "registry_id": registry_id,
                        "session_id": request.session_id,
                        "status": "blocked",
                        "active_task_id": None,
                        "goal_summary": short_text(request.message, 160),
                        "catalog_version": 1,
                        "tasks": [],
                    },
                    "task_state": {
                        "task_id": registry_id,
                        "state": "blocked",
                        "current_step": 0,
                        "total_steps": 0,
                    },
                    "compact_meta": compact_meta,
                    "budget_meta": budget_meta,
                },
            )

        history_result = await db.execute(
            select(ChatMessage)
            .where(ChatMessage.session_id == request.session_id)
            .order_by(ChatMessage.timestamp)
            .limit(200)
        )
        history_messages = history_result.scalars().all()

        available_tools_all = get_available_tools_for_session(session, context) if request.use_tools else []

        active_ctx = await load_active_viewport_and_excerpt_service(
            db=db,
            session_id=request.session_id,
            context_permissions=context.permissions,
            active_file_id=request.active_file_id,
            active_page=request.active_page,
            active_visible_unit=request.active_visible_unit,
            active_visible_start=request.active_visible_start,
            active_visible_end=request.active_visible_end,
            active_anchor_block_id=request.active_anchor_block_id,
        )
        active_registry = await get_active_registry_snapshot(db, request.session_id)
        active_registry_state = None
        if isinstance(active_registry, dict):
            active_registry_state = {
                "task_id": active_registry.get("registry_id"),
                "state": active_registry.get("status"),
                "current_step": 0,
                "total_steps": len((active_registry.get("tasks") or [])),
            }
        await _emit_task_event(
            db=db,
            session_id=request.session_id,
            task_id=registry_id,
            event_type="registry_started",
            stage="planning",
            message="Building task registry",
            progress=8,
            status="running",
        )
        await _emit_task_event(
            db=db,
            session_id=request.session_id,
            task_id=registry_id,
            event_type="router_started",
            stage="planning",
            message="Running router agent for tool guidance",
            progress=10,
            status="running",
        )
        router_payload = await route_request_service(
            message=request.message,
            permitted_files_info=permitted_files_info,
            permissions=session.permissions or {},
            viewport=active_ctx.get("viewport"),
            task_state=active_registry_state,
            model=request.model,
        )
        router_result = router_payload.get("router_result") if isinstance(router_payload, dict) else {}
        router_state = router_payload.get("router_state") if isinstance(router_payload, dict) else {}
        router_tool_hints = (router_result.get("tool") if isinstance(router_result, dict) else None) or {}
        await _emit_task_event(
            db=db,
            session_id=request.session_id,
            task_id=registry_id,
            event_type="router_completed",
            stage="planning",
            message="Router tool guidance ready",
            progress=12,
            status="running",
            payload=router_state if isinstance(router_state, dict) else {},
        )
        orchestrated = await orchestrate_request(
            message=request.message,
            permitted_files_info=permitted_files_info,
            permissions=session.permissions or {},
            viewport=active_ctx.get("viewport"),
            active_registry=active_registry,
            model=request.model,
        )
        registry_snapshot = await create_task_registry(
            db=db,
            session_id=request.session_id,
            registry_id=registry_id,
            source_message_id=user_message.id,
            tasks=orchestrated["orchestrator_result"]["tasks"],
            catalog_version=orchestrated["catalog_version"],
        )
        await _emit_task_event(
            db=db,
            session_id=request.session_id,
            task_id=registry_id,
            event_type="registry_completed",
            stage="planning",
            message="Task registry ready",
            progress=15,
            status="running",
            payload=_task_registry_event_payload(
                registry_snapshot,
                extra={
                    "warning": orchestrated.get("warning"),
                    "fallback_used": orchestrated.get("fallback_used"),
                    "router_state": router_state,
                },
            ),
        )

        execution_kwargs = {
            "db": db,
            "session": session,
            "session_id": request.session_id,
            "registry_id": registry_id,
            "current_user_message": request.message,
            "history_messages": history_messages,
            "context": context,
            "permitted_files_info": permitted_files_info,
            "available_tools_all": available_tools_all,
            "router_tool_hints": router_tool_hints,
            "router_state": router_state if isinstance(router_state, dict) else {},
            "model": request.model,
            "use_tools": request.use_tools,
            "active_file_id": request.active_file_id,
            "active_page": request.active_page,
            "active_visible_unit": request.active_visible_unit,
            "active_visible_start": request.active_visible_start,
            "active_visible_end": request.active_visible_end,
            "active_anchor_block_id": request.active_anchor_block_id,
            "compact_mode": request.compact_mode,
            "defer_compaction": not bool(settings.COMPACT_DURING_EXECUTION),
        }
        if settings.LANGGRAPH_RUNTIME_ENABLED:
            execution = await run_task_registry_turn(
                initial_state={
                    "session_id": request.session_id,
                    "user_message": request.message,
                    "readable_files": _readable_file_ids(
                        permissions=session.permissions or {},
                        permitted_files_info=permitted_files_info,
                    ),
                    "permitted_files_info": permitted_files_info,
                    "active_file_id": request.active_file_id,
                    "active_page": request.active_page,
                },
                execute_turn=_execute_task_registry_flow,
                execute_kwargs=execution_kwargs,
            )
        else:
            execution = await _execute_task_registry_flow(**execution_kwargs)
        compact_meta = execution.get("compact_meta") or compact_meta
        budget_meta = execution.get("budget_meta") or budget_meta

        if execution.get("paused"):
            await db.commit()
            keep_task_mapping = True
            return APIResponse(
                success=True,
                data={
                    "message_id": str(uuid.uuid4()),
                    "content": execution.get("content"),
                    "role": "assistant",
                    "timestamp": datetime.utcnow().isoformat(),
                    "tool_calls": execution.get("response", {}).get("tool_calls"),
                    "tool_results": execution.get("tool_results"),
                    "citations": execution.get("citations"),
                    "task_id": registry_id,
                    "paused": True,
                    "awaiting_user_input": execution.get("awaiting_user_input"),
                    "task_registry": execution.get("task_registry"),
                    "task_state": {
                        "task_id": registry_id,
                        "state": "blocked",
                        "current_step": 0,
                        "total_steps": len((execution.get("task_registry") or {}).get("tasks") or []),
                    },
                    "router_state": router_state,
                    "compact_meta": compact_meta,
                    "budget_meta": budget_meta,
                    "retrieval_meta": execution.get("retrieval_meta"),
                    "execution_meta": execution.get("execution_meta"),
                },
            )

        assistant_message = ChatMessage(
            id=str(uuid.uuid4()),
            session_id=request.session_id,
            role="assistant",
            content=str(execution.get("content") or ""),
            tool_calls=(execution.get("response") or {}).get("tool_calls"),
            tool_results=execution.get("tool_results"),
            citations=execution.get("citations"),
        )
        db.add(assistant_message)
        await db.commit()

        await _clear_registry_pause_checkpoint(db=db, registry_id=registry_id)
        return APIResponse(
            success=True,
                data={
                    "message_id": assistant_message.id,
                    "content": assistant_message.content,
                    "role": "assistant",
                    "timestamp": assistant_message.timestamp.isoformat(),
                "tool_calls": assistant_message.tool_calls,
                "tool_results": execution.get("tool_results"),
                    "citations": execution.get("citations"),
                    "task_id": registry_id,
                    "paused": False,
                    "cancelled": False,
                    "failed": False,
                    "task_registry": execution.get("task_registry"),
                    "task_state": {
                        "task_id": registry_id,
                        "state": (execution.get("task_registry") or {}).get("status"),
                    "current_step": 0,
                    "total_steps": len(((execution.get("task_registry") or {}).get("tasks") or [])),
                },
                "router_state": router_state,
                "compact_meta": compact_meta,
                "budget_meta": budget_meta,
                "retrieval_meta": execution.get("retrieval_meta"),
                "execution_meta": execution.get("execution_meta"),
            },
        )
    finally:
        _running_task_by_session.pop(request.session_id, None)
        if not keep_task_mapping:
            _task_to_session.pop(registry_id, None)
        _cancelled_tasks.discard(registry_id)


async def _answer_task_prompt_task_registry(
    task_id: str,
    payload: TaskAnswerRequest,
    db: AsyncSession,
) -> APIResponse:
    session_id = payload.session_id
    running_task_id = _running_task_by_session.get(session_id)
    if running_task_id and running_task_id != task_id:
        raise HTTPException(
            status_code=409,
            detail=f"Session already has a running task ({running_task_id}).",
        )

    checkpoint = await _load_registry_pause_checkpoint(db=db, registry_id=task_id)
    if not checkpoint:
        raise HTTPException(status_code=404, detail=f"No paused checkpoint found for task {task_id}")

    prompt = checkpoint.get("prompt") if isinstance(checkpoint, dict) else None
    if not isinstance(prompt, dict):
        raise HTTPException(status_code=400, detail="Invalid paused checkpoint payload")

    prompt_id = str(prompt.get("prompt_id") or "").strip()
    if not prompt_id or prompt_id != payload.prompt_id:
        raise HTTPException(status_code=400, detail="prompt_id mismatch")

    selected_option_id = str(payload.selected_option_id or "").strip()
    other_text = str(payload.other_text or "").strip()
    option_label: Optional[str] = None
    options = prompt.get("options") if isinstance(prompt.get("options"), list) else []

    if selected_option_id:
        for item in options:
            if not isinstance(item, dict):
                continue
            if str(item.get("id") or "").strip() == selected_option_id:
                option_label = str(item.get("label") or "").strip() or selected_option_id
                break
        if not option_label:
            raise HTTPException(status_code=400, detail="selected_option_id not found in prompt options")
    elif other_text:
        if len(other_text) > 1000:
            raise HTTPException(status_code=400, detail="other_text exceeds max length 1000")
        option_label = other_text
    else:
        raise HTTPException(status_code=400, detail="Either selected_option_id or other_text is required")

    answer_text = (
        f"[Paused Prompt Answer]\n"
        f"Question: {prompt.get('question')}\n"
        f"Answer: {option_label}"
    )

    user_answer_message = ChatMessage(
        id=str(uuid.uuid4()),
        session_id=session_id,
        role="user",
        content=answer_text,
    )
    db.add(user_answer_message)
    await db.commit()
    await db.refresh(user_answer_message)

    result = await db.execute(select(Session).where(Session.id == session_id))
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    context = await permission_middleware.create_context(session_id=session_id, db=db)
    available_tools_all = get_available_tools_for_session(session, context)
    permitted_files_info = await _visible_file_info_for_session(
        db=db,
        session=session,
        context_files=[],
    )

    await resume_blocked_step(db=db, registry_id=task_id)
    await _emit_task_event(
        db=db,
        session_id=session_id,
        task_id=task_id,
        event_type="task_resumed",
        stage="executing",
        message="Task resumed with user input",
        progress=50,
        status="running",
        payload={"prompt_id": prompt_id},
    )

    history_result = await db.execute(
        select(ChatMessage)
        .where(ChatMessage.session_id == session_id)
        .order_by(ChatMessage.timestamp)
        .limit(200)
    )
    history_messages = history_result.scalars().all()

    _running_task_by_session[session_id] = task_id
    _task_to_session[task_id] = session_id
    keep_task_mapping = False

    try:
        execution_kwargs = {
            "db": db,
            "session": session,
            "session_id": session_id,
            "registry_id": task_id,
            "current_user_message": answer_text,
            "history_messages": history_messages,
            "context": context,
            "permitted_files_info": permitted_files_info,
            "available_tools_all": available_tools_all,
            "router_tool_hints": checkpoint.get("router_tool_hints") if isinstance(checkpoint, dict) else None,
            "router_state": checkpoint.get("router_state") if isinstance(checkpoint, dict) else None,
            "model": checkpoint.get("model"),
            "use_tools": bool(checkpoint.get("use_tools", True)),
            "active_file_id": checkpoint.get("active_file_id"),
            "active_page": checkpoint.get("active_page"),
            "active_visible_unit": checkpoint.get("active_visible_unit"),
            "active_visible_start": checkpoint.get("active_visible_start"),
            "active_visible_end": checkpoint.get("active_visible_end"),
            "active_anchor_block_id": checkpoint.get("active_anchor_block_id"),
            "compact_mode": checkpoint.get("compact_mode") or "auto",
            "defer_compaction": not bool(settings.COMPACT_DURING_EXECUTION),
        }
        if settings.LANGGRAPH_RUNTIME_ENABLED:
            execution = await run_task_registry_turn(
                initial_state={
                    "session_id": session_id,
                    "user_message": answer_text,
                    "readable_files": _readable_file_ids(
                        permissions=session.permissions or {},
                        permitted_files_info=permitted_files_info,
                    ),
                    "permitted_files_info": permitted_files_info,
                    "active_file_id": checkpoint.get("active_file_id"),
                    "active_page": checkpoint.get("active_page"),
                },
                execute_turn=_execute_task_registry_flow,
                execute_kwargs=execution_kwargs,
            )
        else:
            execution = await _execute_task_registry_flow(**execution_kwargs)

        if execution.get("paused"):
            await db.commit()
            keep_task_mapping = True
            return APIResponse(
                success=True,
                data={
                    "message_id": str(uuid.uuid4()),
                    "content": execution.get("content"),
                    "role": "assistant",
                    "timestamp": datetime.utcnow().isoformat(),
                    "tool_calls": execution.get("response", {}).get("tool_calls"),
                    "tool_results": execution.get("tool_results"),
                    "citations": execution.get("citations"),
                    "task_id": task_id,
                    "paused": True,
                    "awaiting_user_input": execution.get("awaiting_user_input"),
                    "task_registry": execution.get("task_registry"),
                    "router_state": checkpoint.get("router_state"),
                    "compact_meta": execution.get("compact_meta"),
                    "budget_meta": execution.get("budget_meta"),
                    "retrieval_meta": execution.get("retrieval_meta"),
                    "execution_meta": execution.get("execution_meta"),
                },
            )

        assistant_message = ChatMessage(
            id=str(uuid.uuid4()),
            session_id=session_id,
            role="assistant",
            content=str(execution.get("content") or ""),
            tool_calls=(execution.get("response") or {}).get("tool_calls"),
            tool_results=execution.get("tool_results"),
            citations=execution.get("citations"),
        )
        db.add(assistant_message)
        await db.commit()
        await _clear_registry_pause_checkpoint(db=db, registry_id=task_id)

        return APIResponse(
            success=True,
                data={
                    "message_id": assistant_message.id,
                    "content": assistant_message.content,
                    "role": "assistant",
                    "timestamp": assistant_message.timestamp.isoformat(),
                "tool_calls": assistant_message.tool_calls,
                    "tool_results": execution.get("tool_results"),
                    "citations": execution.get("citations"),
                    "task_id": task_id,
                    "paused": False,
                    "cancelled": False,
                    "failed": False,
                    "task_registry": execution.get("task_registry"),
                    "router_state": checkpoint.get("router_state"),
                    "compact_meta": execution.get("compact_meta"),
                    "budget_meta": execution.get("budget_meta"),
                    "retrieval_meta": execution.get("retrieval_meta"),
                    "execution_meta": execution.get("execution_meta"),
                },
        )
    finally:
        _running_task_by_session.pop(session_id, None)
        if not keep_task_mapping:
            _task_to_session.pop(task_id, None)
        _cancelled_tasks.discard(task_id)


async def _cancel_task_registry(task_id: str, session_id: Optional[str], db: AsyncSession) -> APIResponse:
    target_session = _task_to_session.get(task_id) or session_id
    if not target_session:
        raise HTTPException(status_code=404, detail=f"Task not found: {task_id}")

    _cancelled_tasks.add(task_id)
    await _clear_registry_pause_checkpoint(db=db, registry_id=task_id)
    await mark_registry_cancelled(db, task_id)
    await db.commit()

    await manager.broadcast_to_session(
        target_session,
        {
            "type": "task_progress",
            "data": {
                "event_id": str(uuid.uuid4()),
                "session_id": target_session,
                "task_id": task_id,
                "event_type": "cancel_requested",
                "stage": "blocked",
                "message": "Cancellation requested",
                "progress": None,
                "status": "cancelling",
                "timestamp": datetime.utcnow().isoformat(),
                "payload": {},
            },
        },
    )

    return APIResponse(
        success=True,
        data={
            "task_id": task_id,
            "session_id": target_session,
            "status": "cancelling",
        },
    )


@router.post("/completions", response_model=APIResponse)
async def chat_completion(request: ChatRequest, db: AsyncSession = Depends(get_db)):
    if settings.TASK_REGISTRY_ENABLED:
        return await _chat_completion_task_registry(request, db)

    task_id = request.task_id or str(uuid.uuid4())
    existing_task_id = _running_task_by_session.get(request.session_id)
    if existing_task_id and existing_task_id != task_id:
        raise HTTPException(
            status_code=409,
            detail=f"Session already has a running task ({existing_task_id}). Cancel it before starting a new one.",
        )

    _running_task_by_session[request.session_id] = task_id
    _task_to_session[task_id] = request.session_id

    response: Dict[str, Any] = {}
    tool_results: List[Dict[str, Any]] = []
    citations: List[Dict[str, Any]] = []
    retrieval_result: Dict[str, Any] = {}
    compact_meta: Dict[str, Any] = {"triggered": False}
    budget_meta: Dict[str, Any] = {"triggered": False}
    router_state: Dict[str, Any] = {}
    router_result: Dict[str, Any] = {}
    selection: Dict[str, Any] = {}
    final_content = ""
    task_state_snapshot: Dict[str, Any] = default_task_state_snapshot(task_id)
    memory_epoch: Dict[str, Any] = _init_memory_epoch(task_id, request.message)
    _append_dialogue_turn(memory_epoch, role="user", content=request.message)
    keep_task_mapping = False
    user_message = ChatMessage(
        id=str(uuid.uuid4()),
        session_id=request.session_id,
        role="user",
        content=request.message,
    )

    try:
        # Get or create session
        result = await db.execute(select(Session).where(Session.id == request.session_id))
        session = result.scalar_one_or_none()

        if not session:
            initial_permissions, _ = await _coerce_permissions_for_non_md_write(
                db=db,
                permissions=request.permissions or {},
            )
            session = Session(
                id=request.session_id,
                name=f"Session {request.session_id[:8]}",
                permissions=initial_permissions,
            )
            db.add(session)
            await db.commit()
            await db.refresh(session)
            permission_middleware.invalidate_cache(request.session_id)
        elif request.permissions is not None:
            coerced_permissions, _ = await _coerce_permissions_for_non_md_write(
                db=db,
                permissions=request.permissions or {},
            )
            session.permissions = coerced_permissions
            flag_modified(session, "permissions")
            await db.commit()
            permission_middleware.invalidate_cache(request.session_id)

        current_permissions = session.permissions or {}
        normalized_permissions, _ = await _coerce_permissions_for_non_md_write(
            db=db,
            permissions=current_permissions,
        )
        if normalized_permissions != current_permissions:
            session.permissions = normalized_permissions
            flag_modified(session, "permissions")
            await db.commit()
            permission_middleware.invalidate_cache(request.session_id)

        db.add(user_message)
        await db.commit()
        await db.refresh(user_message)

        _assert_task_not_cancelled(task_id)
        await _emit_task_event(
            db=db,
            session_id=request.session_id,
            task_id=task_id,
            event_type="task_started",
            stage="planning",
            message="Task started",
            progress=5,
            status="running",
        )
        previous_state = task_state_snapshot.get("state")
        task_state_snapshot = await upsert_task_state_service(
            db=db,
            session_id=request.session_id,
            task_id=task_id,
            state="planning",
            goal=request.message,
            current_step=0,
            total_steps=0,
            plan_json={"mode": "auto"},
            artifacts_json=_with_memory_epoch_artifacts({}, memory_epoch),
        )
        _sync_epoch_state(memory_epoch, task_state_snapshot)
        logger.info(
            "task_state_transition session_id=%s task_id=%s from=%s to=%s",
            request.session_id,
            task_id,
            previous_state,
            task_state_snapshot.get("state"),
        )

        # Visible files: explicit context files + permitted files from session map.
        visible_file_ids = set(request.context_files or [])
        if session.permissions:
            for fid, perm in session.permissions.items():
                if fid.startswith("_"):
                    continue
                if perm in ("read", "write"):
                    visible_file_ids.add(fid)
                elif perm == "none" and fid in visible_file_ids:
                    visible_file_ids.remove(fid)

        permitted_files_info: Dict[str, Dict[str, str]] = {}
        if visible_file_ids:
            files_result = await db.execute(
                select(FileModel)
                .where(FileModel.id.in_(list(visible_file_ids)))
                .where(FileModel.file_type != FileType.FOLDER)
            )
            files = files_result.scalars().all()
            permitted_files_info = {
                f.id: {"name": f.name, "type": f.file_type.value}
                for f in files
            }

        context = await permission_middleware.create_context(
            session_id=request.session_id,
            db=db,
        )

        history_result = await db.execute(
            select(ChatMessage)
            .where(ChatMessage.session_id == request.session_id)
            .order_by(ChatMessage.timestamp)
            .limit(200)
        )
        history_messages = history_result.scalars().all()
        available_tools_all = get_available_tools_for_session(session, context) if request.use_tools else None
        task_items = _session_task_items(request.session_id)
        _sync_task_list(memory_epoch, task_items)

        layered_context = await _prepare_layered_execution_context(
            db=db,
            session_id=request.session_id,
            message=request.message,
            user_message_id=user_message.id,
            permissions=session.permissions or {},
            permitted_files_info=permitted_files_info,
            context_permissions=context.permissions,
            request_use_tools=request.use_tools,
            active_file_id=request.active_file_id,
            active_page=request.active_page,
            active_visible_unit=request.active_visible_unit,
            active_visible_start=request.active_visible_start,
            active_visible_end=request.active_visible_end,
            active_anchor_block_id=request.active_anchor_block_id,
            history_messages=history_messages,
            task_state_snapshot=task_state_snapshot,
            task_items=task_items,
            task_id=task_id,
            memory_epoch=memory_epoch,
            model=request.model,
            available_tools=available_tools_all,
        )
        active_viewport = layered_context["active_viewport"]
        retrieval_result = layered_context["retrieval_result"]
        citations = retrieval_result.get("citations", [])
        router_result = layered_context["router_result"]
        router_state = layered_context["router_state"]
        selection = layered_context["selection"]
        budget_meta = layered_context["context_pack"]["budget_meta"]
        compact_meta = {
            "triggered": bool(layered_context["context_pack"].get("compact_triggered")),
            "reason": budget_meta.get("reason"),
            "compaction_id": ((layered_context["context_pack"].get("compact_snapshot") or {}).get("compaction_id")),
        }
        base_messages = list(layered_context["context_pack"]["messages"])
        transient_messages: List[Dict[str, Any]] = []
        available_tools = layered_context["context_pack"]["tools"] if request.use_tools else None
        max_tool_rounds = int(((router_result.get("tool") or {}).get("max_rounds") or 6))

        logger.info(
            "layered_context session_id=%s task_id=%s primary_mode=%s budget_reason=%s total_input_tokens=%s",
            request.session_id,
            task_id,
            router_state.get("primary_mode"),
            budget_meta.get("reason"),
            budget_meta.get("total_input_tokens"),
        )

        _assert_task_not_cancelled(task_id)
        await _emit_task_event(
            db=db,
            session_id=request.session_id,
            task_id=task_id,
            event_type="context_ready",
            stage="planning",
            message="Prepared layered router/context/executor pack",
            progress=25,
            status="running",
            payload={
                "router_state": router_state,
                "retrieval_used_tokens": retrieval_result.get("used_tokens", 0),
                "semantic_fallback": retrieval_result.get("semantic_failed", False),
                "visual_hits_count": retrieval_result.get("visual_hits_count", 0),
                "retrieval_diagnostics": retrieval_result.get("retrieval_diagnostics", {}),
                "retrieval_deferred_to_tools": request.use_tools and not retrieval_result.get("context_parts"),
                "compact_triggered": compact_meta.get("triggered", False),
                "budget_meta": budget_meta,
            },
        )

        previous_state = task_state_snapshot.get("state")
        task_state_snapshot = await upsert_task_state_service(
            db=db,
            session_id=request.session_id,
            task_id=task_id,
            state="executing",
            goal=request.message,
            current_step=1,
            total_steps=1,
            plan_json={"stage": "context_ready", "router_state": router_state, "workflow_ids": selection.get("workflow_ids"), "template_ids": selection.get("template_ids")},
            artifacts_json=_with_memory_epoch_artifacts(
                {
                    "router_state": router_state,
                    "workflow_ids": selection.get("workflow_ids"),
                    "template_ids": selection.get("template_ids"),
                    "budget_meta": budget_meta,
                    "viewport_memory_refs": ((layered_context.get("viewport_memory") or {}).get("refs") or []),
                },
                memory_epoch,
            ),
        )
        _sync_epoch_state(memory_epoch, task_state_snapshot)
        logger.info(
            "task_state_transition session_id=%s task_id=%s from=%s to=%s",
            request.session_id,
            task_id,
            previous_state,
            task_state_snapshot.get("state"),
        )
        model_round = 0
        cumulative_tool_call_count = 0
        response = {}

        while True:
            _assert_task_not_cancelled(task_id)
            messages = [*base_messages, *transient_messages]
            await _emit_task_event(
                db=db,
                session_id=request.session_id,
                task_id=task_id,
                event_type="model_call_started",
                stage="executing",
                message=f"Calling language model (round {model_round + 1})",
                progress=35,
                status="running",
            )

            round_index = model_round + 1
            allow_model_streaming = not str(request.model or "").strip().lower().startswith("claude-")
            streamed_chunks: List[str] = []

            async def on_stream_delta(delta: str) -> None:
                if not delta:
                    return
                streamed_chunks.append(delta)
                await _emit_assistant_stream_event(
                    session_id=request.session_id,
                    task_id=task_id,
                    event_type="delta",
                    delta=delta,
                    content="".join(streamed_chunks),
                    round_index=round_index,
                )

            if allow_model_streaming:
                await _emit_assistant_stream_event(
                    session_id=request.session_id,
                    task_id=task_id,
                    event_type="started",
                    round_index=round_index,
                )

            response = await llm_service.chat_completion(
                messages=messages,
                model=request.model,
                stream=allow_model_streaming,
                tools=available_tools,
                on_stream_delta=on_stream_delta if allow_model_streaming else None,
            )

            if allow_model_streaming:
                await _emit_assistant_stream_event(
                    session_id=request.session_id,
                    task_id=task_id,
                    event_type="completed",
                    content=response.get("content", "") or "".join(streamed_chunks),
                    round_index=round_index,
                )

            round_tool_calls = response.get("tool_calls") or []
            cumulative_tool_call_count += len(round_tool_calls)

            _assert_task_not_cancelled(task_id)
            await _emit_task_event(
                db=db,
                session_id=request.session_id,
                task_id=task_id,
                event_type="model_call_completed",
                stage="executing",
                message="Model returned response",
                progress=55,
                status="running",
                payload={
                    "round": model_round + 1,
                    "tool_call_count": len(round_tool_calls),
                    "tool_call_total": cumulative_tool_call_count,
                },
            )

            task_update = parse_task_update(response.get("content", ""))
            if task_update.get("parsed"):
                previous_state = task_state_snapshot.get("state")
                task_state_snapshot = await upsert_task_state_service(
                    db=db,
                    session_id=request.session_id,
                    task_id=task_id,
                    state=task_update.get("state", "executing"),
                    goal=request.message,
                    current_step=task_update.get("current_step", 2),
                    total_steps=max(task_update.get("total_steps", 2), 2),
                    next_action=task_update.get("next_action"),
                    blocked_reason=task_update.get("blocked_reason"),
                    plan_json={"stage": "model_task_update"},
                    artifacts_json=_with_memory_epoch_artifacts(
                        {
                            "tool_call_count": cumulative_tool_call_count,
                            "task_update": task_update.get("raw", {}),
                        },
                        memory_epoch,
                    ),
                )
                _sync_epoch_state(memory_epoch, task_state_snapshot)
                logger.info(
                    "task_state_transition session_id=%s task_id=%s from=%s to=%s",
                    request.session_id,
                    task_id,
                    previous_state,
                    task_state_snapshot.get("state"),
                )
            else:
                if task_update.get("warning"):
                    logger.warning(
                        "task_update_parse_warning session_id=%s task_id=%s warning=%s",
                        request.session_id,
                        task_id,
                        task_update.get("warning"),
                    )
                previous_state = task_state_snapshot.get("state")
                task_state_snapshot = await upsert_task_state_service(
                    db=db,
                    session_id=request.session_id,
                    task_id=task_id,
                    state="executing",
                    goal=request.message,
                    current_step=max(2, cumulative_tool_call_count + 1),
                    total_steps=max(2, cumulative_tool_call_count + 2),
                    plan_json={"stage": "model_call_completed"},
                    artifacts_json=_with_memory_epoch_artifacts(
                        {"tool_call_count": cumulative_tool_call_count},
                        memory_epoch,
                    ),
                )
                _sync_epoch_state(memory_epoch, task_state_snapshot)
                logger.info(
                    "task_state_transition session_id=%s task_id=%s from=%s to=%s",
                    request.session_id,
                    task_id,
                    previous_state,
                    task_state_snapshot.get("state"),
                )

            final_content = response.get("content", "")
            if (final_content or "").strip():
                _append_dialogue_turn(memory_epoch, role="assistant", content=final_content)
            if not request.use_tools or not round_tool_calls:
                break

            if model_round >= max_tool_rounds:
                final_content = (
                    (response.get("content") or "").strip()
                    + "\n\n[Agent reached max tool rounds. Please continue if more work is needed.]"
                ).strip()
                break

            assistant_tool_message: Dict[str, Any] = {
                "role": "assistant",
                "content": response.get("content", ""),
            }
            if round_tool_calls:
                assistant_tool_message["tool_calls"] = round_tool_calls
            transient_messages.append(assistant_tool_message)
            total_calls = len(round_tool_calls)

            for idx, tool_call in enumerate(round_tool_calls):
                _assert_task_not_cancelled(task_id)
                tool_progress = 55 + int(((idx + 1) / max(total_calls, 1)) * 25)
                tool_started_at = _now_iso()
                tool_name, tool_args, tool_call_id = _parse_tool_call(tool_call)
                if not tool_call_id:
                    tool_call_id = f"{tool_name}:{idx}"
                tool_args, inferred_file_id = _normalize_tool_file_arguments(
                    tool_name=tool_name,
                    tool_args=tool_args,
                    permissions=session.permissions or {},
                    permitted_files_info=permitted_files_info,
                )
                action_kind = _action_kind_for_tool(tool_name)
                target_file_id = str(tool_args.get("file_id") or "")
                target_file_name = (
                    (permitted_files_info.get(target_file_id) or {}).get("name")
                    if target_file_id
                    else None
                )

                await _emit_task_event(
                    db=db,
                    session_id=request.session_id,
                    task_id=task_id,
                    event_type="tool_started",
                    stage="executing",
                    message=f"Running tool: {tool_name}",
                    progress=tool_progress,
                    status="running",
                    payload={
                        "tool": tool_name,
                        "index": idx + 1,
                        "total": total_calls,
                        "action_kind": action_kind,
                        "target_file_id": target_file_id or None,
                        "target_file_name": target_file_name,
                        "target_file_inferred": bool(inferred_file_id),
                    },
                )

                result = await tool_executor.execute(
                    tool_name=tool_name,
                    arguments=tool_args,
                    context=context,
                )
                result_payload = result.to_dict()
                tool_ended_at = _now_iso()
                tool_results.append({"tool": tool_name, "result": result_payload})
                _record_tool_call(
                    memory_epoch,
                    tool_name=tool_name,
                    tool_args=tool_args,
                    result_payload=result_payload,
                    action_kind=action_kind,
                    target_file_id=target_file_id or None,
                    started_at=tool_started_at,
                    ended_at=tool_ended_at,
                )

                if result.success:
                    transient_messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tool_call_id,
                            "content": json.dumps(
                                {
                                    "ok": True,
                                    "tool": tool_name,
                                    "data": result_payload.get("data", {}),
                                },
                                ensure_ascii=False,
                            ),
                        }
                    )
                else:
                    transient_messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tool_call_id,
                            "content": json.dumps(
                                {
                                    "ok": False,
                                    "tool": tool_name,
                                    "error": result_payload.get("error", "Unknown error"),
                                    "error_code": result_payload.get("error_code"),
                                },
                                ensure_ascii=False,
                            ),
                        }
                    )

                await _emit_task_event(
                    db=db,
                    session_id=request.session_id,
                    task_id=task_id,
                    event_type="tool_completed",
                    stage="executing",
                    message=f"Tool finished: {tool_name}",
                    progress=tool_progress,
                    status="running",
                    payload={
                        "tool": tool_name,
                        "success": result.success,
                        "error": result.error,
                        "action_kind": action_kind,
                        "target_file_id": target_file_id or None,
                        "target_file_name": target_file_name,
                    },
                )

                if (
                    result.success
                    and tool_name == "pause_for_user_choice"
                    and (result.data or {}).get("pause_requested") is True
                ):
                    prompt = _extract_prompt_from_pause_result(result_payload)
                    if not prompt:
                        raise ValueError("pause_for_user_choice returned invalid prompt payload")

                    checkpoint = {
                        "session_id": request.session_id,
                        "task_id": task_id,
                        "messages": [*base_messages, *transient_messages],
                        "base_messages": base_messages,
                        "transient_messages": transient_messages,
                        "tool_results": tool_results,
                        "citations": citations,
                        "retrieval_result": retrieval_result,
                        "compact_meta": compact_meta,
                        "budget_meta": budget_meta,
                        "router_result": router_result,
                        "router_state": router_state,
                        "selection": selection,
                        "goal": request.message,
                        "model": request.model,
                        "use_tools": request.use_tools,
                        "task_items": task_items,
                        "memory_epoch": memory_epoch,
                        "cumulative_tool_call_count": cumulative_tool_call_count,
                        "model_round": model_round,
                        "prompt": prompt,
                        "paused_at": datetime.utcnow().isoformat(),
                    }
                    await _persist_pause_checkpoint(
                        db=db,
                        session_id=request.session_id,
                        task_id=task_id,
                        checkpoint=checkpoint,
                    )

                    previous_state = task_state_snapshot.get("state")
                    task_state_snapshot = await upsert_task_state_service(
                        db=db,
                        session_id=request.session_id,
                        task_id=task_id,
                        state="blocked",
                        goal=request.message,
                        current_step=max(2, cumulative_tool_call_count + idx + 1),
                        total_steps=max(2, cumulative_tool_call_count + total_calls + 1),
                        next_action="await_user_input",
                        blocked_reason="awaiting_user_input",
                        plan_json={"stage": "paused_waiting_user_input"},
                        artifacts_json=_with_memory_epoch_artifacts(
                            {"pause_checkpoint": checkpoint},
                            memory_epoch,
                        ),
                    )
                    _sync_epoch_state(memory_epoch, task_state_snapshot)
                    logger.info(
                        "task_state_transition session_id=%s task_id=%s from=%s to=%s",
                        request.session_id,
                        task_id,
                        previous_state,
                        task_state_snapshot.get("state"),
                    )

                    await _emit_task_event(
                        db=db,
                        session_id=request.session_id,
                        task_id=task_id,
                        event_type="user_input_requested",
                        stage="blocked",
                        message="User input required to continue task",
                        progress=None,
                        status="paused",
                        payload={
                            "prompt": prompt,
                            "action_kind": "pause",
                            "tool": tool_name,
                        },
                    )

                    await db.commit()
                    keep_task_mapping = True

                    return APIResponse(
                        success=True,
                        data={
                            "message_id": str(uuid.uuid4()),
                            "content": "Task paused: waiting for user choice.",
                            "role": "assistant",
                            "timestamp": datetime.utcnow().isoformat(),
                            "tool_calls": response.get("tool_calls"),
                            "tool_results": tool_results,
                            "citations": citations,
                            "usage": response.get("usage", {}),
                            "model": response.get("model"),
                            "task_id": task_id,
                            "paused": True,
                            "awaiting_user_input": prompt,
                            "task_state": task_state_snapshot,
                            "compact_meta": compact_meta,
                            "budget_meta": budget_meta,
                            "router_state": router_state,
                            "retrieval_diagnostics": retrieval_result.get("retrieval_diagnostics", {}),
                        },
                    )

                if result.success and tool_name == "register_task":
                    data = result.data or {}
                    task_name = str(data.get("task_name") or "").strip()
                    if task_name:
                        task_item_id = str(data.get("task_item_id") or str(uuid.uuid4()))
                        existing_item = _find_task_item(
                            task_items,
                            task_item_id=task_item_id,
                            task_name=task_name,
                        )
                        if existing_item is None:
                            has_running = any(item.get("status") == "running" for item in task_items)
                            task_item = {
                                "id": task_item_id,
                                "name": task_name,
                                "description": data.get("task_description"),
                                "status": "waiting" if has_running else "running",
                                "completion_summary": None,
                                "created_at": datetime.utcnow().isoformat(),
                                "updated_at": datetime.utcnow().isoformat(),
                            }
                            task_items.append(task_item)
                        else:
                            existing_item["description"] = data.get("task_description") or existing_item.get(
                                "description"
                            )
                            existing_item["updated_at"] = datetime.utcnow().isoformat()
                            task_item = existing_item

                        counts = _compute_task_board_counts(task_items)
                        await _emit_task_event(
                            db=db,
                            session_id=request.session_id,
                            task_id=task_id,
                            event_type="task_item_registered",
                            stage="executing",
                            message=f"Registered task: {task_item['name']}",
                            progress=tool_progress,
                            status="running",
                            payload={"task_item": task_item, "counts": counts},
                        )
                        _sync_task_list(memory_epoch, task_items)

                if result.success and tool_name == "deliver_task":
                    data = result.data or {}
                    task_name = str(data.get("task_name") or "").strip()
                    completion_summary = str(data.get("completion_summary") or "").strip()
                    task_item_id = str(data.get("task_item_id") or "").strip() or None

                    task_item = _find_task_item(
                        task_items,
                        task_item_id=task_item_id,
                        task_name=task_name,
                        allow_completed=False,
                    )
                    if task_item is None and task_name:
                        task_item = {
                            "id": task_item_id or str(uuid.uuid4()),
                            "name": task_name,
                            "description": None,
                            "status": "completed",
                            "completion_summary": completion_summary or None,
                            "created_at": datetime.utcnow().isoformat(),
                            "updated_at": datetime.utcnow().isoformat(),
                        }
                        task_items.append(task_item)
                    elif task_item is not None:
                        task_item["status"] = "completed"
                        task_item["completion_summary"] = completion_summary or task_item.get("completion_summary")
                        task_item["updated_at"] = datetime.utcnow().isoformat()

                    if task_item:
                        # Promote first waiting task to running when no task is currently running.
                        has_running = any(item.get("status") == "running" for item in task_items)
                        if not has_running:
                            waiting_candidates = [item for item in task_items if item.get("status") == "waiting"]
                            if waiting_candidates:
                                waiting_candidates[0]["status"] = "running"
                                waiting_candidates[0]["updated_at"] = datetime.utcnow().isoformat()
                                await _emit_task_event(
                                    db=db,
                                    session_id=request.session_id,
                                    task_id=task_id,
                                    event_type="task_item_started",
                                    stage="executing",
                                    message=f"Started task: {waiting_candidates[0]['name']}",
                                    progress=tool_progress,
                                    status="running",
                                    payload={
                                        "task_item": waiting_candidates[0],
                                        "counts": _compute_task_board_counts(task_items),
                                    },
                                )

                        counts = _compute_task_board_counts(task_items)
                        await _emit_task_event(
                            db=db,
                            session_id=request.session_id,
                            task_id=task_id,
                            event_type="task_item_delivered",
                            stage="executing",
                            message=f"Delivered task: {task_item['name']}",
                            progress=tool_progress,
                            status="running",
                            payload={"task_item": task_item, "counts": counts},
                        )
                        _sync_task_list(memory_epoch, task_items)

                previous_state = task_state_snapshot.get("state")
                task_state_snapshot = await upsert_task_state_service(
                    db=db,
                    session_id=request.session_id,
                    task_id=task_id,
                    state="executing",
                    goal=request.message,
                    current_step=max(2, cumulative_tool_call_count + idx + 1),
                    total_steps=max(2, cumulative_tool_call_count + total_calls + 1),
                    plan_json={"stage": "tool_execution"},
                    artifacts_json=_with_memory_epoch_artifacts(
                        {
                            "last_tool": tool_name,
                            "tool_index": idx + 1,
                            "tool_total": total_calls,
                        },
                        memory_epoch,
                    ),
                )
                _sync_epoch_state(memory_epoch, task_state_snapshot)
                logger.info(
                    "task_state_transition session_id=%s task_id=%s from=%s to=%s",
                    request.session_id,
                    task_id,
                    previous_state,
                    task_state_snapshot.get("state"),
                )

            refreshed_viewport_memory = await build_viewport_memory_service(
                db=db,
                session_id=request.session_id,
                context_permissions=context.permissions,
                active_file_id=active_viewport.get("file_id") if active_viewport else request.active_file_id,
                active_page=active_viewport.get("page") if active_viewport else request.active_page,
                active_visible_unit=request.active_visible_unit,
                active_visible_start=request.active_visible_start,
                active_visible_end=request.active_visible_end,
                active_anchor_block_id=request.active_anchor_block_id,
                require_effective_note_view=bool(((router_result.get("context") or {}).get("need_effective_note_view", True))),
            )
            refreshed_pack = await build_context_pack_service(
                db=db,
                session_id=request.session_id,
                current_user_message=request.message,
                history_messages=_history_messages_for_layered_pack(history_messages, exclude_message_id=user_message.id),
                router_result=router_result,
                selection=selection,
                permissions=session.permissions or {},
                permitted_files_info=permitted_files_info,
                task_state=task_state_snapshot,
                viewport_memory=refreshed_viewport_memory,
                available_tools=available_tools_all or [],
                previous_tool_results=tool_results,
                memory_epoch=memory_epoch,
                model=request.model,
            )
            if retrieval_result.get("context_parts"):
                refreshed_pack["messages"][0]["content"] = (
                    str(refreshed_pack["messages"][0]["content"] or "")
                    + "\n\n[Retrieved Context]\n"
                    + "\n\n".join(retrieval_result.get("context_parts")[:4])
                )
            base_messages = list(refreshed_pack["messages"])
            available_tools = refreshed_pack["tools"] if request.use_tools else None
            budget_meta = refreshed_pack["budget_meta"]
            compact_meta = {
                "triggered": bool(refreshed_pack.get("compact_triggered")),
                "reason": budget_meta.get("reason"),
                "compaction_id": ((refreshed_pack.get("compact_snapshot") or {}).get("compaction_id")),
            }

            model_round += 1
            _assert_task_not_cancelled(task_id)
            await _emit_task_event(
                db=db,
                session_id=request.session_id,
                task_id=task_id,
                event_type="followup_started",
                stage="executing",
                message="Generating follow-up response with tool results",
                progress=85,
                status="running",
            )

        _assert_task_not_cancelled(task_id)

        assistant_message = ChatMessage(
            id=str(uuid.uuid4()),
            session_id=request.session_id,
            role="assistant",
            content=final_content,
            tool_calls=response.get("tool_calls"),
            tool_results=tool_results,
            citations=citations,
        )
        db.add(assistant_message)
        previous_state = task_state_snapshot.get("state")
        task_state_snapshot = await upsert_task_state_service(
            db=db,
            session_id=request.session_id,
            task_id=task_id,
            state="done",
            goal=request.message,
            current_step=max(2, cumulative_tool_call_count + 2),
            total_steps=max(2, cumulative_tool_call_count + 2),
            plan_json={"stage": "completed"},
            artifacts_json=_with_memory_epoch_artifacts(
                {"tool_result_count": len(tool_results)},
                memory_epoch,
            ),
            last_message_id=assistant_message.id,
        )
        _sync_epoch_state(memory_epoch, task_state_snapshot)
        logger.info(
            "task_state_transition session_id=%s task_id=%s from=%s to=%s",
            request.session_id,
            task_id,
            previous_state,
            task_state_snapshot.get("state"),
        )
        await _emit_task_event(
            db=db,
            session_id=request.session_id,
            task_id=task_id,
            event_type="task_completed",
            stage="done",
            message="Task completed",
            progress=100,
            status="completed",
        )
        await db.commit()

        await _clear_pause_checkpoint(db=db, session_id=request.session_id, task_id=task_id)
        _cancelled_tasks.discard(task_id)
        return APIResponse(
            success=True,
            data={
                "message_id": assistant_message.id,
                "content": final_content,
                "role": "assistant",
                "timestamp": assistant_message.timestamp.isoformat(),
                "tool_calls": response.get("tool_calls"),
                "tool_results": tool_results,
                "citations": citations,
                "usage": response.get("usage", {}),
                "model": response.get("model"),
                "task_id": task_id,
                "task_state": task_state_snapshot,
                "compact_meta": compact_meta,
                "budget_meta": budget_meta,
                "router_state": router_state,
                "retrieval_diagnostics": retrieval_result.get("retrieval_diagnostics", {}),
            },
        )
    except TaskCancelledError:
        cancelled_message = ChatMessage(
            id=str(uuid.uuid4()),
            session_id=request.session_id,
            role="assistant",
            content="Task cancelled by user.",
            tool_results={"task_id": task_id, "status": "cancelled"},
        )
        db.add(cancelled_message)
        previous_state = task_state_snapshot.get("state")
        task_state_snapshot = await upsert_task_state_service(
            db=db,
            session_id=request.session_id,
            task_id=task_id,
            state="blocked",
            goal=request.message,
            current_step=0,
            total_steps=0,
            blocked_reason="cancelled_by_user",
            plan_json={"stage": "cancelled"},
            artifacts_json=_with_memory_epoch_artifacts({}, memory_epoch),
            last_message_id=cancelled_message.id,
        )
        _sync_epoch_state(memory_epoch, task_state_snapshot)
        logger.info(
            "task_state_transition session_id=%s task_id=%s from=%s to=%s",
            request.session_id,
            task_id,
            previous_state,
            task_state_snapshot.get("state"),
        )
        await _emit_task_event(
            db=db,
            session_id=request.session_id,
            task_id=task_id,
            event_type="task_cancelled",
            stage="blocked",
            message="Task cancelled by user",
            progress=100,
            status="cancelled",
        )
        await db.commit()
        await _clear_pause_checkpoint(db=db, session_id=request.session_id, task_id=task_id)
        return APIResponse(
            success=True,
            data={
                "message_id": cancelled_message.id,
                "content": cancelled_message.content,
                "role": "assistant",
                "timestamp": cancelled_message.timestamp.isoformat(),
                "tool_calls": [],
                "tool_results": [],
                "citations": [],
                "task_id": task_id,
                "cancelled": True,
                "task_state": task_state_snapshot,
                "compact_meta": compact_meta,
                "budget_meta": locals().get("budget_meta"),
                "router_state": locals().get("router_state"),
                "retrieval_diagnostics": retrieval_result.get("retrieval_diagnostics", {}),
            },
        )
    except Exception as e:
        error_message: Optional[ChatMessage] = None
        try:
            error_message = ChatMessage(
                id=str(uuid.uuid4()),
                session_id=request.session_id,
                role="assistant",
                content=f"Task failed: {e}",
                tool_results={"task_id": task_id, "status": "failed"},
            )
            db.add(error_message)
            previous_state = task_state_snapshot.get("state")
            task_state_snapshot = await upsert_task_state_service(
                db=db,
                session_id=request.session_id,
                task_id=task_id,
                state="blocked",
                goal=request.message,
                current_step=0,
                total_steps=0,
                blocked_reason=short_text(str(e), 600),
                plan_json={"stage": "failed"},
                artifacts_json=_with_memory_epoch_artifacts({}, memory_epoch),
                last_message_id=error_message.id,
            )
            _sync_epoch_state(memory_epoch, task_state_snapshot)
            logger.info(
                "task_state_transition session_id=%s task_id=%s from=%s to=%s",
                request.session_id,
                task_id,
                previous_state,
                task_state_snapshot.get("state"),
            )
            await _emit_task_event(
                db=db,
                session_id=request.session_id,
                task_id=task_id,
                event_type="task_failed",
                stage="blocked",
                message=f"Task failed: {e}",
                progress=100,
                status="failed",
            )
            await db.commit()
        except Exception:
            await db.rollback()
            raise HTTPException(status_code=500, detail=f"Failed to get LLM response: {e}")

        await _clear_pause_checkpoint(db=db, session_id=request.session_id, task_id=task_id)
        return APIResponse(
            success=True,
            data={
                "message_id": error_message.id if error_message else str(uuid.uuid4()),
                "content": error_message.content if error_message else f"Task failed: {e}",
                "role": "assistant",
                "timestamp": error_message.timestamp.isoformat() if error_message else datetime.utcnow().isoformat(),
                "tool_calls": [],
                "tool_results": [],
                "citations": [],
                "task_id": task_id,
                "failed": True,
                "task_state": task_state_snapshot,
                "compact_meta": compact_meta,
                "budget_meta": locals().get("budget_meta"),
                "router_state": locals().get("router_state"),
                "retrieval_diagnostics": retrieval_result.get("retrieval_diagnostics", {}),
            },
        )
    finally:
        _running_task_by_session.pop(request.session_id, None)
        if not keep_task_mapping:
            _task_to_session.pop(task_id, None)
        _cancelled_tasks.discard(task_id)


@router.post("/tasks/{task_id}/cancel", response_model=APIResponse)
async def cancel_task(
    task_id: str,
    session_id: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    if settings.TASK_REGISTRY_ENABLED:
        return await _cancel_task_registry(task_id, session_id, db)

    target_session = _task_to_session.get(task_id) or session_id
    if not target_session:
        raise HTTPException(status_code=404, detail=f"Task not found: {task_id}")

    _cancelled_tasks.add(task_id)
    await _clear_pause_checkpoint(db=db, session_id=target_session, task_id=task_id)

    await manager.broadcast_to_session(
        target_session,
        {
            "type": "task_progress",
            "data": {
                "event_id": str(uuid.uuid4()),
                "session_id": target_session,
                "task_id": task_id,
                "event_type": "cancel_requested",
                "stage": "blocked",
                "message": "Cancellation requested",
                "progress": None,
                "status": "cancelling",
                "timestamp": datetime.utcnow().isoformat(),
                "payload": {},
            },
        },
    )

    return APIResponse(
        success=True,
        data={
            "task_id": task_id,
            "session_id": target_session,
            "status": "cancelling",
        },
    )


@router.post("/tasks/{task_id}/answer", response_model=APIResponse)
async def answer_task_prompt(
    task_id: str,
    payload: TaskAnswerRequest,
    db: AsyncSession = Depends(get_db),
):
    if settings.TASK_REGISTRY_ENABLED:
        registry_checkpoint = await _load_registry_pause_checkpoint(db=db, registry_id=task_id)
        if isinstance(registry_checkpoint, dict) and str(registry_checkpoint.get("registry_id") or "").strip():
            return await _answer_task_prompt_task_registry(task_id, payload, db)
        # Backward-compatible fallback for legacy pause checkpoints that do not
        # carry registry identifiers.

    session_id = payload.session_id
    running_task_id = _running_task_by_session.get(session_id)
    if running_task_id and running_task_id != task_id:
        raise HTTPException(
            status_code=409,
            detail=f"Session already has a running task ({running_task_id}).",
        )

    checkpoint = await _load_pause_checkpoint(db=db, session_id=session_id, task_id=task_id)
    if not checkpoint:
        raise HTTPException(status_code=404, detail=f"No paused checkpoint found for task {task_id}")

    prompt = checkpoint.get("prompt") if isinstance(checkpoint, dict) else None
    if not isinstance(prompt, dict):
        raise HTTPException(status_code=400, detail="Invalid paused checkpoint payload")

    prompt_id = str(prompt.get("prompt_id") or "").strip()
    if not prompt_id or prompt_id != payload.prompt_id:
        raise HTTPException(status_code=400, detail="prompt_id mismatch")

    selected_option_id = str(payload.selected_option_id or "").strip()
    other_text = str(payload.other_text or "").strip()
    option_label: Optional[str] = None
    options = prompt.get("options") if isinstance(prompt.get("options"), list) else []

    if selected_option_id:
        for item in options:
            if not isinstance(item, dict):
                continue
            if str(item.get("id") or "").strip() == selected_option_id:
                option_label = str(item.get("label") or "").strip() or selected_option_id
                break
        if not option_label:
            raise HTTPException(status_code=400, detail="selected_option_id not found in prompt options")
    elif other_text:
        if len(other_text) > 1000:
            raise HTTPException(status_code=400, detail="other_text exceeds max length 1000")
        option_label = other_text
    else:
        raise HTTPException(status_code=400, detail="Either selected_option_id or other_text is required")

    answer_text = (
        f"[Paused Prompt Answer]\n"
        f"Question: {prompt.get('question')}\n"
        f"Answer: {option_label}"
    )
    user_answer_message = ChatMessage(
        id=str(uuid.uuid4()),
        session_id=session_id,
        role="user",
        content=answer_text,
    )

    result = await db.execute(select(Session).where(Session.id == session_id))
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    current_permissions = session.permissions or {}
    normalized_permissions, _ = await _coerce_permissions_for_non_md_write(
        db=db,
        permissions=current_permissions,
    )
    if normalized_permissions != current_permissions:
        session.permissions = normalized_permissions
        flag_modified(session, "permissions")
        await db.commit()
        permission_middleware.invalidate_cache(session_id)

    db.add(user_answer_message)
    await db.commit()
    await db.refresh(user_answer_message)

    context = await permission_middleware.create_context(session_id=session_id, db=db)
    available_tools_all = get_available_tools_for_session(session, context)
    tool_results = checkpoint.get("tool_results") if isinstance(checkpoint.get("tool_results"), list) else []
    citations = checkpoint.get("citations") if isinstance(checkpoint.get("citations"), list) else []
    retrieval_result = checkpoint.get("retrieval_result") if isinstance(checkpoint.get("retrieval_result"), dict) else {}
    compact_meta = checkpoint.get("compact_meta") if isinstance(checkpoint.get("compact_meta"), dict) else {"triggered": False}
    budget_meta = checkpoint.get("budget_meta") if isinstance(checkpoint.get("budget_meta"), dict) else {"triggered": False}
    router_state = checkpoint.get("router_state") if isinstance(checkpoint.get("router_state"), dict) else {}
    router_result = checkpoint.get("router_result") if isinstance(checkpoint.get("router_result"), dict) else {}
    selection = checkpoint.get("selection") if isinstance(checkpoint.get("selection"), dict) else {}

    goal = str(checkpoint.get("goal") or "").strip() or answer_text
    model = checkpoint.get("model")
    use_tools = bool(checkpoint.get("use_tools", True))
    cumulative_tool_call_count = int(checkpoint.get("cumulative_tool_call_count") or 0)
    model_round = int(checkpoint.get("model_round") or 0)
    final_content = ""
    response: Dict[str, Any] = {}
    keep_task_mapping = False
    task_state_snapshot: Dict[str, Any] = default_task_state_snapshot(task_id)
    max_tool_rounds = int((((router_result.get("tool") or {}) if isinstance(router_result, dict) else {}).get("max_rounds") or 6))
    checkpoint_memory_epoch = checkpoint.get("memory_epoch")
    memory_epoch: Dict[str, Any] = (
        checkpoint_memory_epoch
        if isinstance(checkpoint_memory_epoch, dict)
        else _init_memory_epoch(task_id, goal)
    )
    _append_dialogue_turn(memory_epoch, role="user", content=answer_text)

    checkpoint_task_items = checkpoint.get("task_items")
    if isinstance(checkpoint_task_items, list):
        _task_items_by_session[session_id] = checkpoint_task_items
    task_items = _session_task_items(session_id)
    _sync_task_list(memory_epoch, task_items)

    history_result = await db.execute(
        select(ChatMessage)
        .where(ChatMessage.session_id == session_id)
        .order_by(ChatMessage.timestamp)
        .limit(200)
    )
    history_messages = history_result.scalars().all()

    visible_file_ids = set()
    if session.permissions:
        for fid, perm in session.permissions.items():
            if fid.startswith("_"):
                continue
            if perm in ("read", "write"):
                visible_file_ids.add(fid)
    permitted_files_info: Dict[str, Dict[str, str]] = {}
    if visible_file_ids:
        files_result = await db.execute(
            select(FileModel)
            .where(FileModel.id.in_(list(visible_file_ids)))
            .where(FileModel.file_type != FileType.FOLDER)
        )
        files = files_result.scalars().all()
        permitted_files_info = {
            f.id: {"name": f.name, "type": f.file_type.value}
            for f in files
        }

    if not router_result:
        route_payload = await route_request_service(
            message=goal,
            permitted_files_info=permitted_files_info,
            permissions=session.permissions or {},
            viewport=None,
            task_state=task_state_snapshot,
            model=model,
        )
        router_result = route_payload["router_result"]
        router_state = route_payload["router_state"]
        selection = route_payload["selection"]
        max_tool_rounds = int(((router_result.get("tool") or {}).get("max_rounds") or 6))

    transient_messages = checkpoint.get("transient_messages") if isinstance(checkpoint.get("transient_messages"), list) else []
    refreshed_viewport_memory = await build_viewport_memory_service(
        db=db,
        session_id=session_id,
        context_permissions=context.permissions,
        active_file_id=None,
        active_page=None,
        require_effective_note_view=bool(((router_result.get("context") or {}).get("need_effective_note_view", True))),
    )
    refreshed_pack = await build_context_pack_service(
        db=db,
        session_id=session_id,
        current_user_message=answer_text,
        history_messages=_history_messages_for_layered_pack(history_messages, exclude_message_id=user_answer_message.id),
        router_result=router_result,
        selection=selection,
        permissions=session.permissions or {},
        permitted_files_info=permitted_files_info,
        task_state=task_state_snapshot,
        viewport_memory=refreshed_viewport_memory,
        available_tools=available_tools_all or [],
        previous_tool_results=tool_results,
        memory_epoch=memory_epoch,
        model=model,
    )
    if retrieval_result.get("context_parts"):
        refreshed_pack["messages"][0]["content"] = (
            str(refreshed_pack["messages"][0]["content"] or "")
            + "\n\n[Retrieved Context]\n"
            + "\n\n".join(retrieval_result.get("context_parts")[:4])
        )
    base_messages = list(refreshed_pack["messages"])
    available_tools = refreshed_pack["tools"] if use_tools else None
    budget_meta = refreshed_pack["budget_meta"]
    compact_meta = {
        "triggered": bool(refreshed_pack.get("compact_triggered")),
        "reason": budget_meta.get("reason"),
        "compaction_id": ((refreshed_pack.get("compact_snapshot") or {}).get("compaction_id")),
    }

    _running_task_by_session[session_id] = task_id
    _task_to_session[task_id] = session_id

    try:
        await _emit_task_event(
            db=db,
            session_id=session_id,
            task_id=task_id,
            event_type="task_resumed",
            stage="executing",
            message="Task resumed with user input",
            progress=50,
            status="running",
            payload={"prompt_id": prompt_id},
        )

        previous_state = task_state_snapshot.get("state")
        task_state_snapshot = await upsert_task_state_service(
            db=db,
            session_id=session_id,
            task_id=task_id,
            state="executing",
            goal=goal,
            current_step=max(1, cumulative_tool_call_count + 1),
            total_steps=max(2, cumulative_tool_call_count + 2),
            next_action="continue",
            blocked_reason=None,
            plan_json={"stage": "resumed_after_user_input"},
            artifacts_json=_with_memory_epoch_artifacts(
                {"prompt_id": prompt_id, "selected_option_id": selected_option_id or None},
                memory_epoch,
            ),
        )
        _sync_epoch_state(memory_epoch, task_state_snapshot)
        logger.info(
            "task_state_transition session_id=%s task_id=%s from=%s to=%s",
            session_id,
            task_id,
            previous_state,
            task_state_snapshot.get("state"),
        )

        while True:
            _assert_task_not_cancelled(task_id)
            messages = [*base_messages, *transient_messages]
            await _emit_task_event(
                db=db,
                session_id=session_id,
                task_id=task_id,
                event_type="model_call_started",
                stage="executing",
                message=f"Calling language model (round {model_round + 1})",
                progress=60,
                status="running",
            )

            round_index = model_round + 1
            allow_model_streaming = not str(model or "").strip().lower().startswith("claude-")
            streamed_chunks: List[str] = []

            async def on_stream_delta(delta: str) -> None:
                if not delta:
                    return
                streamed_chunks.append(delta)
                await _emit_assistant_stream_event(
                    session_id=session_id,
                    task_id=task_id,
                    event_type="delta",
                    delta=delta,
                    content="".join(streamed_chunks),
                    round_index=round_index,
                )

            if allow_model_streaming:
                await _emit_assistant_stream_event(
                    session_id=session_id,
                    task_id=task_id,
                    event_type="started",
                    round_index=round_index,
                )

            response = await llm_service.chat_completion(
                messages=messages,
                model=model,
                stream=allow_model_streaming,
                tools=available_tools if use_tools else None,
                on_stream_delta=on_stream_delta if allow_model_streaming else None,
            )

            if allow_model_streaming:
                await _emit_assistant_stream_event(
                    session_id=session_id,
                    task_id=task_id,
                    event_type="completed",
                    content=response.get("content", "") or "".join(streamed_chunks),
                    round_index=round_index,
                )

            round_tool_calls = response.get("tool_calls") or []
            cumulative_tool_call_count += len(round_tool_calls)

            await _emit_task_event(
                db=db,
                session_id=session_id,
                task_id=task_id,
                event_type="model_call_completed",
                stage="executing",
                message="Model returned response",
                progress=70,
                status="running",
                payload={
                    "round": model_round + 1,
                    "tool_call_count": len(round_tool_calls),
                    "tool_call_total": cumulative_tool_call_count,
                },
            )

            task_update = parse_task_update(response.get("content", ""))
            if task_update.get("parsed"):
                previous_state = task_state_snapshot.get("state")
                task_state_snapshot = await upsert_task_state_service(
                    db=db,
                    session_id=session_id,
                    task_id=task_id,
                    state=task_update.get("state", "executing"),
                    goal=goal,
                    current_step=task_update.get("current_step", 2),
                    total_steps=max(task_update.get("total_steps", 2), 2),
                    next_action=task_update.get("next_action"),
                    blocked_reason=task_update.get("blocked_reason"),
                    plan_json={"stage": "resumed_model_task_update"},
                    artifacts_json=_with_memory_epoch_artifacts(
                        {
                            "tool_call_count": cumulative_tool_call_count,
                            "task_update": task_update.get("raw", {}),
                        },
                        memory_epoch,
                    ),
                )
                _sync_epoch_state(memory_epoch, task_state_snapshot)
                logger.info(
                    "task_state_transition session_id=%s task_id=%s from=%s to=%s",
                    session_id,
                    task_id,
                    previous_state,
                    task_state_snapshot.get("state"),
                )

            final_content = response.get("content", "")
            if (final_content or "").strip():
                _append_dialogue_turn(memory_epoch, role="assistant", content=final_content)
            if not use_tools or not round_tool_calls:
                break

            if model_round >= max_tool_rounds:
                final_content = (
                    (response.get("content") or "").strip()
                    + "\n\n[Agent reached max tool rounds. Please continue if more work is needed.]"
                ).strip()
                break

            assistant_tool_message: Dict[str, Any] = {
                "role": "assistant",
                "content": response.get("content", ""),
            }
            if round_tool_calls:
                assistant_tool_message["tool_calls"] = round_tool_calls
            transient_messages.append(assistant_tool_message)
            total_calls = len(round_tool_calls)

            for idx, tool_call in enumerate(round_tool_calls):
                _assert_task_not_cancelled(task_id)
                tool_progress = 70 + int(((idx + 1) / max(total_calls, 1)) * 20)
                tool_started_at = _now_iso()
                tool_name, tool_args, tool_call_id = _parse_tool_call(tool_call)
                if not tool_call_id:
                    tool_call_id = f"{tool_name}:{idx}"
                tool_args, inferred_file_id = _normalize_tool_file_arguments(
                    tool_name=tool_name,
                    tool_args=tool_args,
                    permissions=session.permissions or {},
                    permitted_files_info=permitted_files_info,
                )
                action_kind = _action_kind_for_tool(tool_name)
                target_file_id = str(tool_args.get("file_id") or "")

                await _emit_task_event(
                    db=db,
                    session_id=session_id,
                    task_id=task_id,
                    event_type="tool_started",
                    stage="executing",
                    message=f"Running tool: {tool_name}",
                    progress=tool_progress,
                    status="running",
                    payload={
                        "tool": tool_name,
                        "index": idx + 1,
                        "total": total_calls,
                        "action_kind": action_kind,
                        "target_file_id": target_file_id or None,
                        "target_file_inferred": bool(inferred_file_id),
                    },
                )

                result = await tool_executor.execute(
                    tool_name=tool_name,
                    arguments=tool_args,
                    context=context,
                )
                result_payload = result.to_dict()
                tool_ended_at = _now_iso()
                tool_results.append({"tool": tool_name, "result": result_payload})
                _record_tool_call(
                    memory_epoch,
                    tool_name=tool_name,
                    tool_args=tool_args,
                    result_payload=result_payload,
                    action_kind=action_kind,
                    target_file_id=target_file_id or None,
                    started_at=tool_started_at,
                    ended_at=tool_ended_at,
                )

                if result.success:
                    transient_messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tool_call_id,
                            "content": json.dumps(
                                {
                                    "ok": True,
                                    "tool": tool_name,
                                    "data": result_payload.get("data", {}),
                                },
                                ensure_ascii=False,
                            ),
                        }
                    )
                else:
                    transient_messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tool_call_id,
                            "content": json.dumps(
                                {
                                    "ok": False,
                                    "tool": tool_name,
                                    "error": result_payload.get("error", "Unknown error"),
                                    "error_code": result_payload.get("error_code"),
                                },
                                ensure_ascii=False,
                            ),
                        }
                    )

                await _emit_task_event(
                    db=db,
                    session_id=session_id,
                    task_id=task_id,
                    event_type="tool_completed",
                    stage="executing",
                    message=f"Tool finished: {tool_name}",
                    progress=tool_progress,
                    status="running",
                    payload={
                        "tool": tool_name,
                        "success": result.success,
                        "error": result.error,
                        "action_kind": action_kind,
                        "target_file_id": target_file_id or None,
                    },
                )

                if (
                    result.success
                    and tool_name == "pause_for_user_choice"
                    and (result.data or {}).get("pause_requested") is True
                ):
                    pause_prompt = _extract_prompt_from_pause_result(result_payload)
                    if not pause_prompt:
                        raise ValueError("pause_for_user_choice returned invalid prompt payload")

                    next_checkpoint = {
                        "session_id": session_id,
                        "task_id": task_id,
                        "messages": [*base_messages, *transient_messages],
                        "base_messages": base_messages,
                        "transient_messages": transient_messages,
                        "tool_results": tool_results,
                        "citations": citations,
                        "retrieval_result": retrieval_result,
                        "compact_meta": compact_meta,
                        "budget_meta": budget_meta,
                        "router_result": router_result,
                        "router_state": router_state,
                        "selection": selection,
                        "goal": goal,
                        "model": model,
                        "use_tools": use_tools,
                        "task_items": task_items,
                        "memory_epoch": memory_epoch,
                        "cumulative_tool_call_count": cumulative_tool_call_count,
                        "model_round": model_round,
                        "prompt": pause_prompt,
                        "paused_at": datetime.utcnow().isoformat(),
                    }
                    await _persist_pause_checkpoint(
                        db=db,
                        session_id=session_id,
                        task_id=task_id,
                        checkpoint=next_checkpoint,
                    )

                    previous_state = task_state_snapshot.get("state")
                    task_state_snapshot = await upsert_task_state_service(
                        db=db,
                        session_id=session_id,
                        task_id=task_id,
                        state="blocked",
                        goal=goal,
                        current_step=max(2, cumulative_tool_call_count + idx + 1),
                        total_steps=max(2, cumulative_tool_call_count + total_calls + 1),
                        next_action="await_user_input",
                        blocked_reason="awaiting_user_input",
                        plan_json={"stage": "paused_waiting_user_input"},
                        artifacts_json=_with_memory_epoch_artifacts(
                            {"pause_checkpoint": next_checkpoint},
                            memory_epoch,
                        ),
                    )
                    _sync_epoch_state(memory_epoch, task_state_snapshot)
                    logger.info(
                        "task_state_transition session_id=%s task_id=%s from=%s to=%s",
                        session_id,
                        task_id,
                        previous_state,
                        task_state_snapshot.get("state"),
                    )

                    await _emit_task_event(
                        db=db,
                        session_id=session_id,
                        task_id=task_id,
                        event_type="user_input_requested",
                        stage="blocked",
                        message="User input required to continue task",
                        progress=None,
                        status="paused",
                        payload={
                            "prompt": pause_prompt,
                            "action_kind": "pause",
                            "tool": tool_name,
                        },
                    )

                    await db.commit()
                    keep_task_mapping = True

                    return APIResponse(
                        success=True,
                        data={
                            "message_id": str(uuid.uuid4()),
                            "content": "Task paused: waiting for user choice.",
                            "role": "assistant",
                            "timestamp": datetime.utcnow().isoformat(),
                            "tool_calls": response.get("tool_calls"),
                            "tool_results": tool_results,
                            "citations": citations,
                            "usage": response.get("usage", {}),
                            "model": response.get("model"),
                            "task_id": task_id,
                            "paused": True,
                            "awaiting_user_input": pause_prompt,
                            "task_state": task_state_snapshot,
                            "compact_meta": compact_meta,
                            "budget_meta": budget_meta,
                            "router_state": router_state,
                            "retrieval_diagnostics": retrieval_result.get("retrieval_diagnostics", {}),
                        },
                    )

            refreshed_viewport_memory = await build_viewport_memory_service(
                db=db,
                session_id=session_id,
                context_permissions=context.permissions,
                active_file_id=None,
                active_page=None,
                require_effective_note_view=bool(((router_result.get("context") or {}).get("need_effective_note_view", True))),
            )
            refreshed_pack = await build_context_pack_service(
                db=db,
                session_id=session_id,
                current_user_message=answer_text,
                history_messages=_history_messages_for_layered_pack(history_messages, exclude_message_id=user_answer_message.id),
                router_result=router_result,
                selection=selection,
                permissions=session.permissions or {},
                permitted_files_info=permitted_files_info,
                task_state=task_state_snapshot,
                viewport_memory=refreshed_viewport_memory,
                available_tools=available_tools_all or [],
                previous_tool_results=tool_results,
                memory_epoch=memory_epoch,
                model=model,
            )
            if retrieval_result.get("context_parts"):
                refreshed_pack["messages"][0]["content"] = (
                    str(refreshed_pack["messages"][0]["content"] or "")
                    + "\n\n[Retrieved Context]\n"
                    + "\n\n".join(retrieval_result.get("context_parts")[:4])
                )
            base_messages = list(refreshed_pack["messages"])
            available_tools = refreshed_pack["tools"] if use_tools else None
            budget_meta = refreshed_pack["budget_meta"]
            compact_meta = {
                "triggered": bool(refreshed_pack.get("compact_triggered")),
                "reason": budget_meta.get("reason"),
                "compaction_id": ((refreshed_pack.get("compact_snapshot") or {}).get("compaction_id")),
            }

            model_round += 1
            await _emit_task_event(
                db=db,
                session_id=session_id,
                task_id=task_id,
                event_type="followup_started",
                stage="executing",
                message="Generating follow-up response with tool results",
                progress=90,
                status="running",
            )

        assistant_message = ChatMessage(
            id=str(uuid.uuid4()),
            session_id=session_id,
            role="assistant",
            content=final_content,
            tool_calls=response.get("tool_calls"),
            tool_results=tool_results,
            citations=citations,
        )
        db.add(assistant_message)
        previous_state = task_state_snapshot.get("state")
        task_state_snapshot = await upsert_task_state_service(
            db=db,
            session_id=session_id,
            task_id=task_id,
            state="done",
            goal=goal,
            current_step=max(2, cumulative_tool_call_count + 2),
            total_steps=max(2, cumulative_tool_call_count + 2),
            plan_json={"stage": "completed"},
            artifacts_json=_with_memory_epoch_artifacts(
                {"tool_result_count": len(tool_results)},
                memory_epoch,
            ),
            last_message_id=assistant_message.id,
        )
        _sync_epoch_state(memory_epoch, task_state_snapshot)
        logger.info(
            "task_state_transition session_id=%s task_id=%s from=%s to=%s",
            session_id,
            task_id,
            previous_state,
            task_state_snapshot.get("state"),
        )
        await _emit_task_event(
            db=db,
            session_id=session_id,
            task_id=task_id,
            event_type="task_completed",
            stage="done",
            message="Task completed",
            progress=100,
            status="completed",
        )
        await db.commit()

        await _clear_pause_checkpoint(db=db, session_id=session_id, task_id=task_id)
        _cancelled_tasks.discard(task_id)
        return APIResponse(
            success=True,
            data={
                "message_id": assistant_message.id,
                "content": final_content,
                "role": "assistant",
                "timestamp": assistant_message.timestamp.isoformat(),
                "tool_calls": response.get("tool_calls"),
                "tool_results": tool_results,
                "citations": citations,
                "usage": response.get("usage", {}),
                "model": response.get("model"),
                "task_id": task_id,
                "paused": False,
                "task_state": task_state_snapshot,
                "compact_meta": compact_meta,
                "budget_meta": budget_meta,
                "router_state": router_state,
                "retrieval_diagnostics": retrieval_result.get("retrieval_diagnostics", {}),
            },
        )
    except TaskCancelledError:
        cancelled_message = ChatMessage(
            id=str(uuid.uuid4()),
            session_id=session_id,
            role="assistant",
            content="Task cancelled by user.",
            tool_results={"task_id": task_id, "status": "cancelled"},
        )
        db.add(cancelled_message)
        await _emit_task_event(
            db=db,
            session_id=session_id,
            task_id=task_id,
            event_type="task_cancelled",
            stage="blocked",
            message="Task cancelled by user",
            progress=100,
            status="cancelled",
        )
        await db.commit()
        await _clear_pause_checkpoint(db=db, session_id=session_id, task_id=task_id)
        return APIResponse(
            success=True,
            data={
                "message_id": cancelled_message.id,
                "content": cancelled_message.content,
                "role": "assistant",
                "timestamp": cancelled_message.timestamp.isoformat(),
                "tool_calls": [],
                "tool_results": [],
                "citations": [],
                "task_id": task_id,
                "cancelled": True,
                "paused": False,
                "budget_meta": budget_meta,
                "router_state": router_state,
            },
        )
    except Exception as exc:
        failed_message = ChatMessage(
            id=str(uuid.uuid4()),
            session_id=session_id,
            role="assistant",
            content=f"Task failed: {exc}",
            tool_results={"task_id": task_id, "status": "failed"},
        )
        db.add(failed_message)
        await _emit_task_event(
            db=db,
            session_id=session_id,
            task_id=task_id,
            event_type="task_failed",
            stage="blocked",
            message=f"Task failed: {exc}",
            progress=100,
            status="failed",
        )
        await db.commit()
        await _clear_pause_checkpoint(db=db, session_id=session_id, task_id=task_id)
        return APIResponse(
            success=True,
            data={
                "message_id": failed_message.id,
                "content": failed_message.content,
                "role": "assistant",
                "timestamp": failed_message.timestamp.isoformat(),
                "tool_calls": [],
                "tool_results": [],
                "citations": [],
                "task_id": task_id,
                "failed": True,
                "paused": False,
                "budget_meta": budget_meta,
                "router_state": router_state,
            },
        )
    finally:
        _running_task_by_session.pop(session_id, None)
        if not keep_task_mapping:
            _task_to_session.pop(task_id, None)
        _cancelled_tasks.discard(task_id)


@router.post("/sessions", response_model=APIResponse)
async def create_session(
    payload: SessionCreateRequest,
    db: AsyncSession = Depends(get_db),
):
    session_id = payload.id or str(uuid.uuid4())
    session_name = (payload.name or "").strip() or f"Session {session_id[:8]}"
    session_permissions, session_permission_diagnostics = await _coerce_permissions_for_non_md_write(
        db=db,
        permissions=payload.permissions or {},
    )

    result = await db.execute(select(Session).where(Session.id == session_id))
    existing = result.scalar_one_or_none()
    if existing:
        existing.name = session_name
        existing.permissions = session_permissions
        flag_modified(existing, "permissions")
        await db.commit()
        permission_middleware.invalidate_cache(session_id)
        return APIResponse(
            success=True,
            data={
                "id": existing.id,
                "name": existing.name,
                "created_at": existing.created_at.isoformat(),
                "updated_at": existing.updated_at.isoformat(),
                "permissions": existing.permissions or {},
                "permission_diagnostics": session_permission_diagnostics,
            },
        )

    session = Session(
        id=session_id,
        name=session_name,
        permissions=session_permissions,
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)
    permission_middleware.invalidate_cache(session_id)

    return APIResponse(
        success=True,
        data={
            "id": session.id,
            "name": session.name,
            "created_at": session.created_at.isoformat(),
            "updated_at": session.updated_at.isoformat(),
            "permissions": session.permissions or {},
            "permission_diagnostics": session_permission_diagnostics,
        },
    )


@router.get("/sessions", response_model=APIResponse)
async def list_sessions(
    limit: int = 200,
    db: AsyncSession = Depends(get_db),
):
    safe_limit = max(1, min(limit, 1000))
    result = await db.execute(
        select(Session)
        .order_by(Session.updated_at.desc(), Session.created_at.desc())
        .limit(safe_limit)
    )
    sessions = result.scalars().all()

    return APIResponse(
        success=True,
        data={
            "sessions": [
                {
                    "id": session.id,
                    "name": session.name,
                    "permissions": session.permissions or {},
                    "created_at": session.created_at.isoformat(),
                    "updated_at": session.updated_at.isoformat(),
                }
                for session in sessions
            ],
            "count": len(sessions),
        },
    )


@router.get("/sessions/{session_id}", response_model=APIResponse)
async def get_session(session_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Session).where(Session.id == session_id))
    session = result.scalar_one_or_none()
    if not session:
        session = Session(
            id=session_id,
            name=f"Session {session_id[:8]}",
            permissions={},
        )
        db.add(session)
        try:
            await db.commit()
            await db.refresh(session)
        except IntegrityError:
            await db.rollback()
            retry = await db.execute(select(Session).where(Session.id == session_id))
            session = retry.scalar_one_or_none()
            if not session:
                raise

    permissions_dict, _ = await _coerce_permissions_for_non_md_write(
        db=db,
        permissions=session.permissions or {},
    )
    if permissions_dict != (session.permissions or {}):
        session.permissions = permissions_dict
        flag_modified(session, "permissions")
        await db.commit()
        permission_middleware.invalidate_cache(session_id)
    context_files = [fid for fid in permissions_dict.keys() if not fid.startswith("_")]
    return APIResponse(
        success=True,
        data={
            "id": session.id,
            "name": session.name,
            "created_at": session.created_at.isoformat(),
            "permissions": permissions_dict,
            "context_files": context_files,
        },
    )


@router.get("/sessions/{session_id}/messages", response_model=APIResponse)
async def get_session_messages(
    session_id: str,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ChatMessage)
        .where(ChatMessage.session_id == session_id)
        .order_by(ChatMessage.timestamp.desc())
        .limit(limit)
    )
    messages = result.scalars().all()
    return APIResponse(
        success=True,
        data={
            "messages": [
                {
                    "id": msg.id,
                    "role": msg.role,
                    "content": msg.content,
                    "tool_calls": msg.tool_calls,
                    "tool_results": msg.tool_results,
                    "citations": msg.citations,
                    "timestamp": msg.timestamp.isoformat(),
                }
                for msg in reversed(messages)
            ]
        },
    )


@router.post("/sessions/{session_id}/permissions", response_model=APIResponse)
async def update_session_permissions(
    session_id: str,
    file_id: str,
    permission: Permission,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Session).where(Session.id == session_id))
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if not session.permissions:
        session.permissions = {}
    coerced_map, diagnostics = await _coerce_permissions_for_non_md_write(
        db=db,
        permissions={file_id: permission.value},
    )
    effective_permission = coerced_map.get(file_id, permission.value)
    diag = diagnostics.get(file_id, {})
    session.permissions[file_id] = effective_permission
    flag_modified(session, "permissions")
    await db.commit()
    permission_middleware.invalidate_cache(session_id)

    return APIResponse(
        success=True,
        data={
            "session_id": session_id,
            "file_id": file_id,
            "permission": effective_permission,
            "requested_permission": permission.value,
            "coerced": bool(diag.get("coerced")),
            "reason": diag.get("reason"),
        },
    )


@router.put("/sessions/{session_id}/permissions", response_model=APIResponse)
async def bulk_update_permissions(
    session_id: str,
    permissions: dict[str, Permission],
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Session).where(Session.id == session_id))
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    requested_permissions = {
        file_id: perm.value if isinstance(perm, Permission) else perm
        for file_id, perm in permissions.items()
    }
    permissions_dict, diagnostics = await _coerce_permissions_for_non_md_write(
        db=db,
        permissions=requested_permissions,
    )
    session.permissions = permissions_dict
    flag_modified(session, "permissions")
    await db.commit()
    permission_middleware.invalidate_cache(session_id)

    return APIResponse(
        success=True,
        data={
            "session_id": session_id,
            "permissions": permissions_dict,
            "updated_count": len(permissions_dict),
            "permission_diagnostics": diagnostics,
        },
    )


@router.delete("/sessions/{session_id}", response_model=APIResponse)
async def delete_session(session_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Session).where(Session.id == session_id))
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    await db.execute(ChatMessage.__table__.delete().where(ChatMessage.session_id == session_id))
    await db.delete(session)
    await db.commit()
    permission_middleware.invalidate_cache(session_id)
    _task_items_by_session.pop(session_id, None)

    return APIResponse(
        success=True,
        data={"session_id": session_id, "message": "Session and all associated history deleted successfully"},
    )


def _build_system_prompt(permissions: dict = None, permitted_files_info: dict = None) -> str:
    base_prompt = SystemPrompts.MAIN_SYSTEM_PROMPT

    if not permitted_files_info:
        base_prompt += "\n\n=== No Files Accessible ==="
        base_prompt += "\nYou don't currently have access to any files. The user can grant access in the file permission controls."
        return base_prompt

    base_prompt += f"\n\n=== Files You Can Access ({len(permitted_files_info)} total) ==="
    read_files = []
    write_files = []

    for fid, info in permitted_files_info.items():
        perm = permissions.get(fid, "read") if permissions else "read"
        if perm == "write":
            write_files.append((fid, info))
        else:
            read_files.append((fid, info))

    if write_files:
        base_prompt += "\n\n[Files with Write Access]:"
        for fid, info in write_files:
            base_prompt += f"\n- {info['name']} ({fid}) [{info['type']}] - write"

    if read_files:
        base_prompt += "\n\n[Files with Read Access]:"
        for fid, info in read_files:
            base_prompt += f"\n- {info['name']} ({fid}) [{info['type']}] - read"

    base_prompt += (
        "\n\nYou can only access the files listed above. If the user asks about other files, "
        "explain that you do not have access and ask for permission changes."
    )
    return base_prompt
