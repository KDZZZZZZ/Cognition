from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from unittest.mock import AsyncMock

from app.api import chat as chat_api
from app.models import ChatMessage, File, FileType, Session
from app.schemas import Permission, SessionCreateRequest, TaskAnswerRequest


@pytest.mark.asyncio
async def test_chat_session_crud_and_permissions(db_session):
    db_session.add(
        File(
            id="f-md",
            name="note.md",
            file_type=FileType.MD,
            path="/tmp/note.md",
            size=1,
            page_count=1,
            meta={},
        )
    )
    db_session.add(
        File(
            id="f-pdf",
            name="report.pdf",
            file_type=FileType.PDF,
            path="/tmp/report.pdf",
            size=1,
            page_count=1,
            meta={},
        )
    )
    await db_session.commit()

    created = await chat_api.create_session(
        SessionCreateRequest(
            id="sess-1",
            name="Session One",
            permissions={"f-md": "write", "f-pdf": "write"},
        ),
        db=db_session,
    )
    assert created.success is True
    assert created.data["permissions"]["f-md"] == "write"
    # Non-markdown write should be coerced.
    assert created.data["permissions"]["f-pdf"] == "read"

    updated = await chat_api.create_session(
        SessionCreateRequest(id="sess-1", name="Renamed Session", permissions={"f-md": "read"}),
        db=db_session,
    )
    assert updated.data["name"] == "Renamed Session"

    listed = await chat_api.list_sessions(limit=20, db=db_session)
    assert listed.data["count"] >= 1

    session_info = await chat_api.get_session("sess-1", db=db_session)
    assert session_info.data["id"] == "sess-1"
    assert "f-md" in session_info.data["context_files"]

    perm_update = await chat_api.update_session_permissions(
        "sess-1",
        "f-pdf",
        Permission.WRITE,
        db=db_session,
    )
    assert perm_update.data["requested_permission"] == "write"
    assert perm_update.data["permission"] == "read"
    assert perm_update.data["coerced"] is True

    bulk = await chat_api.bulk_update_permissions(
        "sess-1",
        {"f-md": Permission.WRITE, "f-pdf": Permission.NONE},
        db=db_session,
    )
    assert bulk.data["updated_count"] == 2
    assert bulk.data["permissions"]["f-pdf"] == "none"

    db_session.add(
        ChatMessage(id="m1", session_id="sess-1", role="user", content="hello")
    )
    db_session.add(
        ChatMessage(id="m2", session_id="sess-1", role="assistant", content="world")
    )
    await db_session.commit()
    msgs = await chat_api.get_session_messages("sess-1", limit=10, db=db_session)
    assert [item["id"] for item in msgs.data["messages"]] == ["m1", "m2"]

    deleted = await chat_api.delete_session("sess-1", db=db_session)
    assert deleted.success is True

    with pytest.raises(HTTPException):
        await chat_api.delete_session("sess-1", db=db_session)


@pytest.mark.asyncio
async def test_cancel_task_and_answer_task_prompt_success(db_session, monkeypatch: pytest.MonkeyPatch):
    chat_api._cancelled_tasks.clear()
    chat_api._task_to_session.clear()
    chat_api._running_task_by_session.clear()
    chat_api._paused_task_checkpoints.clear()

    db_session.add(Session(id="sess-ans", name="Answer Session", permissions={}))
    await db_session.commit()

    with pytest.raises(HTTPException):
        await chat_api.cancel_task("missing", session_id=None, db=db_session)

    chat_api._task_to_session["task-cancel"] = "sess-ans"
    cancelled = await chat_api.cancel_task("task-cancel", session_id=None, db=db_session)
    assert cancelled.data["status"] == "cancelling"

    checkpoint = {
        "prompt": {
            "prompt_id": "prompt-1",
            "question": "Pick one",
            "options": [
                {"id": "opt-1", "label": "Option 1"},
                {"id": "opt-2", "label": "Option 2"},
            ],
        },
        "messages": [{"role": "system", "content": "resume"}],
        "tool_results": [],
        "citations": [],
        "retrieval_result": {},
        "compact_meta": {"triggered": False},
        "goal": "continue task",
        "model": "mock-model",
        "use_tools": False,
        "task_items": [],
        "memory_epoch": chat_api._init_memory_epoch("task-1", "continue task"),
        "cumulative_tool_call_count": 0,
        "model_round": 0,
    }
    chat_api._paused_task_checkpoints["task-1"] = checkpoint

    monkeypatch.setattr(
        chat_api.llm_service,
        "chat_completion",
        AsyncMock(return_value={"content": "Task completed after answer.", "tool_calls": [], "usage": {}, "model": "mock-model"}),
    )

    response = await chat_api.answer_task_prompt(
        "task-1",
        TaskAnswerRequest(
            session_id="sess-ans",
            prompt_id="prompt-1",
            selected_option_id="opt-2",
        ),
        db=db_session,
    )
    assert response.success is True
    assert response.data["paused"] is False
    assert response.data["content"] == "Task completed after answer."

    stored = (await db_session.execute(select(ChatMessage).where(ChatMessage.session_id == "sess-ans"))).scalars().all()
    assert len(stored) >= 2


@pytest.mark.asyncio
async def test_answer_task_prompt_validation_errors(db_session):
    chat_api._cancelled_tasks.clear()
    chat_api._task_to_session.clear()
    chat_api._running_task_by_session.clear()
    chat_api._paused_task_checkpoints.clear()

    db_session.add(Session(id="sess-v", name="Validation Session", permissions={}))
    await db_session.commit()

    with pytest.raises(HTTPException):
        await chat_api.answer_task_prompt(
            "task-x",
            TaskAnswerRequest(session_id="sess-v", prompt_id="p"),
            db=db_session,
        )

    chat_api._paused_task_checkpoints["task-x"] = {"prompt": {"prompt_id": "p1", "question": "Q?", "options": [{"id": "a", "label": "A"}]}}

    with pytest.raises(HTTPException):
        await chat_api.answer_task_prompt(
            "task-x",
            TaskAnswerRequest(session_id="sess-v", prompt_id="mismatch", selected_option_id="a"),
            db=db_session,
        )

    with pytest.raises(HTTPException):
        await chat_api.answer_task_prompt(
            "task-x",
            TaskAnswerRequest(session_id="sess-v", prompt_id="p1", selected_option_id="not-exist"),
            db=db_session,
        )

    with pytest.raises(HTTPException):
        await chat_api.answer_task_prompt(
            "task-x",
            TaskAnswerRequest(session_id="sess-v", prompt_id="p1", other_text="x" * 1001),
            db=db_session,
        )

    with pytest.raises(HTTPException):
        await chat_api.answer_task_prompt(
            "task-x",
            TaskAnswerRequest(session_id="sess-v", prompt_id="p1"),
            db=db_session,
        )


def test_build_system_prompt_variants():
    prompt_none = chat_api._build_system_prompt({}, {})
    assert "No Files Accessible" in prompt_none

    prompt_with_files = chat_api._build_system_prompt(
        permissions={"f1": "write", "f2": "read"},
        permitted_files_info={
            "f1": {"name": "note.md", "type": "md"},
            "f2": {"name": "report.pdf", "type": "pdf"},
        },
    )
    assert "Files with Write Access" in prompt_with_files
    assert "Files with Read Access" in prompt_with_files
