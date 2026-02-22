import logging
import json
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from app.config import settings
from app.database import get_db
from app.models import ChatMessage, File as FileModel, FileType, Session
from app.prompts.system_prompts import SystemPrompts
from app.schemas import APIResponse, ChatRequest, Permission
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


class TaskCancelledError(Exception):
    """Raised when a running task is cancelled by user action."""


def get_available_tools_for_session(session: Session, context) -> List[dict]:
    return tool_executor.get_available_tools(context)


def _is_task_cancelled(task_id: str) -> bool:
    return task_id in _cancelled_tasks


def _assert_task_not_cancelled(task_id: str) -> None:
    if _is_task_cancelled(task_id):
        raise TaskCancelledError(f"Task {task_id} has been cancelled")


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
    compact_meta: Dict[str, Any] = {"triggered": False}
    final_content = ""
    task_state_snapshot: Dict[str, Any] = default_task_state_snapshot(task_id)
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
            initial_permissions = request.permissions or {}
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
            session.permissions = request.permissions
            flag_modified(session, "permissions")
            await db.commit()
            permission_middleware.invalidate_cache(request.session_id)

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
            artifacts_json={},
        )
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
        base_messages.append({"role": "user", "content": request.message})

        compact_result = await maybe_compact_history_service(
            db=db,
            session_id=request.session_id,
            history_messages=history_messages,
            pre_compact_messages=base_messages,
            compact_mode=request.compact_mode or "auto",
        )
        messages = compact_result["messages"]
        compact_meta = compact_result["compact_meta"]
        latest_compact_summary = compact_result.get("latest_summary")

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
        )
        manifest_block = "[Context Manifest]\n```json\n" + json.dumps(manifest, ensure_ascii=False, indent=2) + "\n```"

        context_blocks = [manifest_block]
        if request.viewport_context:
            context_blocks.append(f"[Current Viewport Context]\n{request.viewport_context}")
        if active_excerpt:
            context_blocks.append(f"[Active Viewport Excerpt]\n{active_excerpt}")
        context_blocks.extend(context_parts)

        context_payload = (
            "[Relevant Context from Documents]:\n"
            + "\n\n".join(context_blocks)
            + "\n\nUse this context to answer the user's question. Cite your sources."
        )
        # Guard against context overflow by trimming retrieval blocks first.
        while (
            estimate_messages_tokens(messages + [{"role": "system", "content": context_payload}])
            > settings.COMPACT_FORCE_TOKENS
            and len(context_parts) > 1
        ):
            context_parts = context_parts[:-1]
            context_blocks = [manifest_block]
            if request.viewport_context:
                context_blocks.append(f"[Current Viewport Context]\n{request.viewport_context}")
            if active_excerpt:
                context_blocks.append(f"[Active Viewport Excerpt]\n{active_excerpt}")
            context_blocks.extend(context_parts)
            context_payload = (
                "[Relevant Context from Documents]:\n"
                + "\n\n".join(context_blocks)
                + "\n\nUse this context to answer the user's question. Cite your sources."
            )

        messages.append({"role": "system", "content": context_payload})
        logger.info(
            "context_budget session_id=%s task_id=%s retrieval_chunks=%s tokens_before=%s tokens_after=%s compact_trigger_reason=%s",
            request.session_id,
            task_id,
            len(context_parts),
            compact_meta.get("before_tokens"),
            compact_meta.get("after_tokens"),
            compact_meta.get("reason"),
        )

        _assert_task_not_cancelled(task_id)
        await _emit_task_event(
            db=db,
            session_id=request.session_id,
            task_id=task_id,
            event_type="context_ready",
            stage="planning",
            message=f"Prepared context manifest + {len(context_parts)} retrieval blocks",
            progress=25,
            status="running",
            payload={
                "context_block_count": len(context_parts),
                "retrieval_used_tokens": retrieval_result.get("used_tokens", 0),
                "semantic_fallback": retrieval_result.get("semantic_failed", False),
                "compact_triggered": compact_meta.get("triggered", False),
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
            artifacts_json={"manifest": {"retrieval_refs_count": len(retrieval_refs)}},
        )
        logger.info(
            "task_state_transition session_id=%s task_id=%s from=%s to=%s",
            request.session_id,
            task_id,
            previous_state,
            task_state_snapshot.get("state"),
        )

        available_tools = get_available_tools_for_session(session, context) if request.use_tools else None

        _assert_task_not_cancelled(task_id)
        await _emit_task_event(
            db=db,
            session_id=request.session_id,
            task_id=task_id,
            event_type="model_call_started",
            stage="executing",
            message="Calling language model",
            progress=35,
            status="running",
        )

        response = await llm_service.chat_completion(
            messages=messages,
            model=request.model,
            tools=available_tools,
        )

        _assert_task_not_cancelled(task_id)
        await _emit_task_event(
            db=db,
            session_id=request.session_id,
            task_id=task_id,
            event_type="model_call_completed",
            stage="executing",
            message="Model returned initial response",
            progress=55,
            status="running",
            payload={"tool_call_count": len(response.get("tool_calls") or [])},
        )
        tool_call_count = len(response.get("tool_calls") or [])
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
                artifacts_json={
                    "tool_call_count": tool_call_count,
                    "task_update": task_update.get("raw", {}),
                },
            )
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
                current_step=2,
                total_steps=max(2, tool_call_count + 2),
                plan_json={"stage": "model_call_completed"},
                artifacts_json={"tool_call_count": tool_call_count},
            )
            logger.info(
                "task_state_transition session_id=%s task_id=%s from=%s to=%s",
                request.session_id,
                task_id,
                previous_state,
                task_state_snapshot.get("state"),
            )

        final_content = response.get("content", "")

        if request.use_tools and response.get("tool_calls"):
            total_calls = len(response.get("tool_calls", []))
            for idx, tool_call in enumerate(response.get("tool_calls", [])):
                _assert_task_not_cancelled(task_id)
                tool_progress = 55 + int(((idx + 1) / max(total_calls, 1)) * 25)

                if "function" in tool_call:
                    tool_name = tool_call["function"]["name"]
                    tool_args = tool_call["function"].get("arguments", {})
                    if isinstance(tool_args, str):
                        try:
                            tool_args = json.loads(tool_args)
                        except json.JSONDecodeError:
                            tool_args = {}
                else:
                    tool_name = tool_call.get("name")
                    tool_args = tool_call.get("arguments", {})

                await _emit_task_event(
                    db=db,
                    session_id=request.session_id,
                    task_id=task_id,
                    event_type="tool_started",
                    stage="executing",
                    message=f"Running tool: {tool_name}",
                    progress=tool_progress,
                    status="running",
                    payload={"tool": tool_name, "index": idx + 1, "total": total_calls},
                )

                result = await tool_executor.execute(
                    tool_name=tool_name,
                    arguments=tool_args,
                    context=context,
                )
                tool_results.append({"tool": tool_name, "result": result.to_dict()})

                if result.success:
                    summary = f"\n\n[Tool {tool_name} executed successfully"
                    if result.data:
                        if "file_name" in result.data:
                            summary += f" on {result.data['file_name']}"
                        if "version_id" in result.data:
                            summary += f" (version: {result.data['version_id']})"
                    summary += "]"
                    final_content += summary
                else:
                    final_content += f"\n\n[Tool Error: {result.error}]"

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
                    },
                )
                previous_state = task_state_snapshot.get("state")
                task_state_snapshot = await upsert_task_state_service(
                    db=db,
                    session_id=request.session_id,
                    task_id=task_id,
                    state="executing",
                    goal=request.message,
                    current_step=min(2 + idx + 1, max(2, total_calls + 2)),
                    total_steps=max(2, total_calls + 2),
                    plan_json={"stage": "tool_execution"},
                    artifacts_json={"last_tool": tool_name, "tool_index": idx + 1, "tool_total": total_calls},
                )
                logger.info(
                    "task_state_transition session_id=%s task_id=%s from=%s to=%s",
                    request.session_id,
                    task_id,
                    previous_state,
                    task_state_snapshot.get("state"),
                )

            if tool_results:
                _assert_task_not_cancelled(task_id)
                await _emit_task_event(
                    db=db,
                    session_id=request.session_id,
                    task_id=task_id,
                    event_type="followup_started",
                    stage="executing",
                    message="Generating final response with tool results",
                    progress=85,
                    status="running",
                )

                messages.append({"role": "assistant", "content": response.get("content", "")})
                for tool_result in tool_results:
                    tool_payload = tool_result["result"]
                    if tool_payload.get("success"):
                        tool_content = f"Tool executed successfully: {tool_payload.get('data', {})}"
                    else:
                        tool_content = f"Tool failed: {tool_payload.get('error', 'Unknown error')}"
                    messages.append(
                        {
                            "role": "tool",
                            "name": tool_result["tool"],
                            "content": tool_content,
                        }
                    )
                try:
                    followup = await llm_service.chat_completion(
                        messages=messages,
                        model=request.model,
                        tools=available_tools,
                    )
                    final_content = followup.get("content", final_content)
                    if followup.get("model"):
                        response["model"] = followup["model"]
                except Exception:
                    pass

        _assert_task_not_cancelled(task_id)

        db.add(user_message)
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
            current_step=max(2, len(tool_results) + 2),
            total_steps=max(2, len(tool_results) + 2),
            plan_json={"stage": "completed"},
            artifacts_json={"tool_result_count": len(tool_results)},
            last_message_id=assistant_message.id,
        )
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
            },
        )
    except TaskCancelledError:
        db.add(user_message)
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
            artifacts_json={},
            last_message_id=cancelled_message.id,
        )
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
            },
        )
    except Exception as e:
        try:
            db.add(user_message)
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
                artifacts_json={},
                last_message_id=error_message.id,
            )
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
    finally:
        _running_task_by_session.pop(request.session_id, None)
        _task_to_session.pop(task_id, None)
        _cancelled_tasks.discard(task_id)


@router.post("/tasks/{task_id}/cancel", response_model=APIResponse)
async def cancel_task(
    task_id: str,
    session_id: Optional[str] = None,
):
    target_session = _task_to_session.get(task_id) or session_id
    if not target_session:
        raise HTTPException(status_code=404, detail=f"Task not found: {task_id}")

    _cancelled_tasks.add(task_id)

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

    permissions_dict = session.permissions or {}
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
    session.permissions[file_id] = permission.value
    flag_modified(session, "permissions")
    await db.commit()
    permission_middleware.invalidate_cache(session_id)

    return APIResponse(
        success=True,
        data={"session_id": session_id, "file_id": file_id, "permission": permission.value},
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

    permissions_dict = {
        file_id: perm.value if isinstance(perm, Permission) else perm
        for file_id, perm in permissions.items()
    }
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
