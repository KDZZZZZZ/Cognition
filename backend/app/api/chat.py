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
from app.models import ChatMessage, File as FileModel, FileType, Session, SessionTaskState
from app.prompts.system_prompts import SystemPrompts
from app.schemas import APIResponse, ChatRequest, Permission, SessionCreateRequest, TaskAnswerRequest
from app.services.compaction_service import maybe_compact_history as maybe_compact_history_service
from app.services.context_manifest_service import build_context_manifest as build_context_manifest_service
from app.services.llm_service import llm_service
from app.services.retrieval_service import (
    load_active_viewport_and_excerpt as load_active_viewport_and_excerpt_service,
)
from app.services.retrieval_service import retrieve_context_blocks as retrieve_context_blocks_service
from app.services.task_state_service import default_task_state_snapshot, parse_task_update
from app.services.task_state_service import upsert_task_state as upsert_task_state_service
from app.services.token_budget_service import estimate_messages_tokens, short_text
from app.services.tools.base import PermissionLevel
from app.services.tools.executor import tool_executor
from app.services.tools.middleware import permission_middleware
from app.websocket import manager

router = APIRouter(prefix="/chat", tags=["chat"])
logger = logging.getLogger(__name__)

_running_task_by_session: dict[str, str] = {}
_task_to_session: dict[str, str] = {}
_cancelled_tasks: set[str] = set()
_task_items_by_session: dict[str, list[dict[str, Any]]] = {}
_paused_task_checkpoints: dict[str, dict[str, Any]] = {}


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


@router.post("/completions", response_model=APIResponse)
async def chat_completion(request: ChatRequest, db: AsyncSession = Depends(get_db)):
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

        explicit_none = {
            fid for fid, perm in context.permissions.items() if perm == PermissionLevel.NONE
        }
        readable_files = [
            fid for fid in list(visible_file_ids) if fid not in explicit_none
        ]

        active_ctx = await load_active_viewport_and_excerpt_service(
            db=db,
            session_id=request.session_id,
            context_permissions=context.permissions,
            active_file_id=request.active_file_id,
            active_page=request.active_page,
        )
        active_viewport = active_ctx.get("viewport")
        active_excerpt = active_ctx.get("excerpt")
        _sync_focus_from_viewport(
            memory_epoch,
            viewport=active_viewport,
            permitted_files_info=permitted_files_info,
        )

        if request.use_tools:
            await _emit_task_event(
                db=db,
                session_id=request.session_id,
                task_id=task_id,
                event_type="context_manifest_started",
                stage="planning",
                message=f"Preparing context manifest for {len(readable_files)} visible file(s)",
                progress=15,
                status="running",
                payload={
                    "readable_file_count": len(readable_files),
                    "active_file_id": active_viewport.get("file_id") if active_viewport else None,
                    "active_page": active_viewport.get("page") if active_viewport else None,
                    "retrieval_deferred_to_tools": True,
                },
            )
            retrieval_result = _empty_retrieval_result(mode="deferred_to_tools")
        else:
            await _emit_task_event(
                db=db,
                session_id=request.session_id,
                task_id=task_id,
                event_type="retrieval_started",
                stage="planning",
                message=f"Retrieving context from {len(readable_files)} file(s)",
                progress=15,
                status="running",
                payload={
                    "readable_file_count": len(readable_files),
                    "active_file_id": active_viewport.get("file_id") if active_viewport else None,
                    "active_page": active_viewport.get("page") if active_viewport else None,
                },
            )
            retrieval_result = await retrieve_context_blocks_service(
                db=db,
                query=request.message,
                readable_files=readable_files,
                permitted_files_info=permitted_files_info,
                active_file_id=active_viewport.get("file_id") if active_viewport else None,
                active_page=active_viewport.get("page") if active_viewport else None,
            )
        context_parts = retrieval_result.get("context_parts", [])
        citations = retrieval_result.get("citations", [])
        retrieval_refs = retrieval_result.get("retrieval_refs", [])

        history_result = await db.execute(
            select(ChatMessage)
            .where(ChatMessage.session_id == request.session_id)
            .order_by(ChatMessage.timestamp)
            .limit(200)
        )
        history_messages = history_result.scalars().all()

        base_messages = [{"role": "system", "content": _build_system_prompt(session.permissions, permitted_files_info)}]
        for msg in history_messages:
            if msg.role in ("user", "assistant"):
                base_messages.append({"role": msg.role, "content": msg.content})

        compact_result = await maybe_compact_history_service(
            db=db,
            session_id=request.session_id,
            history_messages=history_messages,
            pre_compact_messages=base_messages,
            compact_mode=request.compact_mode or "auto",
            memory_epoch=memory_epoch,
            model=request.model,
        )
        messages = compact_result["messages"]
        compact_meta = compact_result["compact_meta"]
        latest_compact_summary = compact_result.get("latest_summary")
        memory_payload = _build_memory_payload(compact_meta, memory_epoch)

        manifest = build_context_manifest_service(
            session_id=request.session_id,
            task_id=task_id,
            permissions=session.permissions or {},
            permitted_files_info=permitted_files_info,
            viewport=active_viewport,
            active_excerpt=active_excerpt,
            retrieval_refs=retrieval_refs,
            compact_summary=latest_compact_summary,
            task_state=task_state_snapshot,
            system_prompt=SystemPrompts.structured_system_prompt(),
            memory=memory_payload,
        )
        manifest_block = "[Context Manifest]\n```json\n" + json.dumps(manifest, ensure_ascii=False, indent=2) + "\n```"

        context_blocks = [manifest_block]
        if request.viewport_context:
            context_blocks.append(f"[Current Viewport Context]\n{request.viewport_context}")
        if active_excerpt:
            context_blocks.append(f"[Active Viewport Excerpt]\n{active_excerpt}")
        context_blocks.extend(context_parts)

        context_payload = _build_context_payload(
            context_blocks=context_blocks,
            use_tools=request.use_tools,
        )
        context_window_tokens = max(1, int(settings.MODEL_CONTEXT_WINDOW_TOKENS or settings.COMPACT_FORCE_TOKENS))
        # Guard against context overflow by trimming retrieval blocks first.
        while (
            estimate_messages_tokens(messages + [{"role": "system", "content": context_payload}])
            > context_window_tokens
            and len(context_parts) > 1
        ):
            context_parts = context_parts[:-1]
            context_blocks = [manifest_block]
            if request.viewport_context:
                context_blocks.append(f"[Current Viewport Context]\n{request.viewport_context}")
            if active_excerpt:
                context_blocks.append(f"[Active Viewport Excerpt]\n{active_excerpt}")
            context_blocks.extend(context_parts)
            context_payload = _build_context_payload(
                context_blocks=context_blocks,
                use_tools=request.use_tools,
            )

        messages.append({"role": "system", "content": context_payload})
        compact_token_window = compact_meta.get("token_window") if isinstance(compact_meta, dict) else None
        logger.info(
            (
                "context_budget session_id=%s task_id=%s retrieval_chunks=%s "
                "tokens_before=%s tokens_after=%s compact_trigger_reason=%s compact_before_ratio=%s "
                "compact_system_tokens=%s compact_memory_tokens=%s"
            ),
            request.session_id,
            task_id,
            len(context_parts),
            compact_meta.get("before_tokens"),
            compact_meta.get("after_tokens"),
            compact_meta.get("reason"),
            (compact_token_window or {}).get("before_occupancy_ratio") if isinstance(compact_token_window, dict) else None,
            ((compact_token_window or {}).get("components") or {}).get("system_tokens")
            if isinstance(compact_token_window, dict)
            else None,
            ((compact_token_window or {}).get("components") or {}).get("memory_tokens")
            if isinstance(compact_token_window, dict)
            else None,
        )

        _assert_task_not_cancelled(task_id)
        await _emit_task_event(
            db=db,
            session_id=request.session_id,
            task_id=task_id,
            event_type="context_ready",
            stage="planning",
            message=(
                f"Prepared context manifest + {len(context_parts)} retrieval blocks"
                if not request.use_tools
                else "Prepared context manifest; document retrieval deferred to tools"
            ),
            progress=25,
            status="running",
            payload={
                "context_block_count": len(context_parts),
                "retrieval_used_tokens": retrieval_result.get("used_tokens", 0),
                "semantic_fallback": retrieval_result.get("semantic_failed", False),
                "visual_hits_count": retrieval_result.get("visual_hits_count", 0),
                "retrieval_diagnostics": retrieval_result.get("retrieval_diagnostics", {}),
                "retrieval_deferred_to_tools": request.use_tools,
                "compact_triggered": compact_meta.get("triggered", False),
                "compact_token_window": compact_token_window,
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
            plan_json={"stage": "context_ready"},
            artifacts_json=_with_memory_epoch_artifacts(
                {"manifest": {"retrieval_refs_count": len(retrieval_refs)}},
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

        available_tools = get_available_tools_for_session(session, context) if request.use_tools else None

        task_items = _session_task_items(request.session_id)
        _sync_task_list(memory_epoch, task_items)
        max_tool_rounds = 6
        model_round = 0
        cumulative_tool_call_count = 0
        response = {}

        while True:
            _assert_task_not_cancelled(task_id)
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
            messages.append(assistant_tool_message)
            total_calls = len(round_tool_calls)

            for idx, tool_call in enumerate(round_tool_calls):
                _assert_task_not_cancelled(task_id)
                tool_progress = 55 + int(((idx + 1) / max(total_calls, 1)) * 25)
                tool_started_at = _now_iso()
                tool_name, tool_args, tool_call_id = _parse_tool_call(tool_call)
                if not tool_call_id:
                    tool_call_id = f"{tool_name}:{idx}"
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
                    messages.append(
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
                    messages.append(
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
                        "messages": messages,
                        "tool_results": tool_results,
                        "citations": citations,
                        "retrieval_result": retrieval_result,
                        "compact_meta": compact_meta,
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

            _maybe_append_round_completion_prompt(messages, task_items)
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
    available_tools = get_available_tools_for_session(session, context)

    messages = checkpoint.get("messages") if isinstance(checkpoint.get("messages"), list) else []
    messages.append({"role": "user", "content": answer_text})
    tool_results = checkpoint.get("tool_results") if isinstance(checkpoint.get("tool_results"), list) else []
    citations = checkpoint.get("citations") if isinstance(checkpoint.get("citations"), list) else []
    retrieval_result = checkpoint.get("retrieval_result") if isinstance(checkpoint.get("retrieval_result"), dict) else {}
    compact_meta = checkpoint.get("compact_meta") if isinstance(checkpoint.get("compact_meta"), dict) else {"triggered": False}

    goal = str(checkpoint.get("goal") or "").strip() or answer_text
    model = checkpoint.get("model")
    use_tools = bool(checkpoint.get("use_tools", True))
    cumulative_tool_call_count = int(checkpoint.get("cumulative_tool_call_count") or 0)
    model_round = int(checkpoint.get("model_round") or 0)
    final_content = ""
    response: Dict[str, Any] = {}
    keep_task_mapping = False
    task_state_snapshot: Dict[str, Any] = default_task_state_snapshot(task_id)
    max_tool_rounds = 6
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
            messages.append(assistant_tool_message)
            total_calls = len(round_tool_calls)

            for idx, tool_call in enumerate(round_tool_calls):
                _assert_task_not_cancelled(task_id)
                tool_progress = 70 + int(((idx + 1) / max(total_calls, 1)) * 20)
                tool_started_at = _now_iso()
                tool_name, tool_args, tool_call_id = _parse_tool_call(tool_call)
                if not tool_call_id:
                    tool_call_id = f"{tool_name}:{idx}"
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
                    messages.append(
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
                    messages.append(
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
                        "messages": messages,
                        "tool_results": tool_results,
                        "citations": citations,
                        "retrieval_result": retrieval_result,
                        "compact_meta": compact_meta,
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
                            "retrieval_diagnostics": retrieval_result.get("retrieval_diagnostics", {}),
                        },
                    )

            _maybe_append_round_completion_prompt(messages, task_items)
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
