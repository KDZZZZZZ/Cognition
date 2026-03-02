from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.api import chat as chat_api
from app.database import async_session_maker, init_db
from app.models import DocumentPageAsset, DocumentSegment, File, FileIndexStatus, FileType, SessionTaskState
from app.services.llm_service import llm_service
from app.services.tools.handlers import initialize_tools
from app.services.tools.registry import tool_registry
from main import app


@dataclass
class _Hit:
    segment_id: str
    file_id: str
    page: int | None
    section: str | None
    source_type: str
    score: float
    source_mode: str
    reason: str | None
    text: str


@pytest.fixture
async def client():
    await init_db()
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as ac:
        yield ac


@pytest.mark.asyncio
async def test_chat_completion_defers_retrieval_until_tools_request_it(
    monkeypatch: pytest.MonkeyPatch,
    client: AsyncClient,
    tmp_path: Path,
):
    for tool_name in list(tool_registry.get_tool_names()):
        tool_registry.unregister(tool_name)
    initialize_tools()

    note_path = tmp_path / "deferred-note.md"
    note_path.write_text("# Deferred\n", encoding="utf-8")
    note_id = f"note-{uuid4()}"
    session_id = f"deferred-tools-{uuid4()}"

    async with async_session_maker() as db:
        db.add(
            File(
                id=note_id,
                name="deferred-note.md",
                file_type=FileType.MD,
                path=str(note_path),
                size=note_path.stat().st_size,
                page_count=1,
                meta={},
            )
        )
        await db.commit()

    captured_messages: list[dict] = []

    async def fake_chat_completion(*, messages, model=None, stream=False, tools=None, system_prompt=None, on_stream_delta=None):
        del model, stream, tools, system_prompt, on_stream_delta
        captured_messages[:] = messages
        return {
            "content": "I will inspect files with tools when needed.",
            "tool_calls": [],
            "model": "mock-model",
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }

    monkeypatch.setattr(llm_service, "chat_completion", fake_chat_completion)
    monkeypatch.setattr(
        chat_api,
        "retrieve_context_blocks_service",
        AsyncMock(side_effect=AssertionError("tool mode should not run eager retrieval")),
    )

    response = await client.post(
        "/api/v1/chat/completions",
        json={
            "session_id": session_id,
            "message": "Read the note if needed, but decide yourself.",
            "context_files": [note_id],
            "permissions": {note_id: "write"},
            "use_tools": True,
        },
    )

    assert response.status_code == 200
    payload = response.json()["data"]
    assert payload["content"] == "I will inspect files with tools when needed."
    assert payload["retrieval_diagnostics"]["mode"] == "deferred_to_tools"
    manifest_message = next(
        message["content"]
        for message in captured_messages
        if message.get("role") == "system" and "[Context Manifest]" in str(message.get("content") or "")
    )
    assert "call retrieval/read tools yourself" in manifest_message
    assert "do not replace explanation with images only" in manifest_message


@pytest.mark.asyncio
async def test_chat_completion_prompts_model_to_end_round_after_all_tasks_complete(
    monkeypatch: pytest.MonkeyPatch,
    client: AsyncClient,
):
    for tool_name in list(tool_registry.get_tool_names()):
        tool_registry.unregister(tool_name)
    initialize_tools()

    session_id = f"round-wrap-{uuid4()}"
    llm_rounds = {"count": 0}
    saw_wrap_prompt = {"value": False}

    async def fake_chat_completion(*, messages, model=None, stream=False, tools=None, system_prompt=None, on_stream_delta=None):
        del model, stream, tools, system_prompt, on_stream_delta
        llm_rounds["count"] += 1
        if llm_rounds["count"] == 1:
            return {
                "content": "Registering and delivering the task.",
                "tool_calls": [
                    {
                        "id": "call-register",
                        "type": "function",
                        "function": {
                            "name": "register_task",
                            "arguments": json.dumps({"task_name": "Summarize findings", "task_description": "One-pass summary"}),
                        },
                    },
                    {
                        "id": "call-deliver",
                        "type": "function",
                        "function": {
                            "name": "deliver_task",
                            "arguments": json.dumps({"task_name": "Summarize findings", "completion_summary": "Summary is complete"}),
                        },
                    },
                ],
                "model": "mock-model",
                "usage": {"prompt_tokens": 4, "completion_tokens": 4, "total_tokens": 8},
            }

        saw_wrap_prompt["value"] = any(
            message.get("role") == "system"
            and "当前task已经全部完成,是否结束本回合" in str(message.get("content") or "")
            for message in messages
        )
        return {
            "content": "All tasks complete.",
            "tool_calls": [],
            "model": "mock-model",
            "usage": {"prompt_tokens": 3, "completion_tokens": 3, "total_tokens": 6},
        }

    monkeypatch.setattr(llm_service, "chat_completion", fake_chat_completion)
    monkeypatch.setattr(
        chat_api,
        "retrieve_context_blocks_service",
        AsyncMock(side_effect=AssertionError("tool mode should not run eager retrieval")),
    )

    response = await client.post(
        "/api/v1/chat/completions",
        json={
            "session_id": session_id,
            "message": "Handle this task from start to finish.",
            "use_tools": True,
        },
    )

    assert response.status_code == 200
    payload = response.json()["data"]
    assert payload["content"] == "All tasks complete."
    assert llm_rounds["count"] == 2
    assert saw_wrap_prompt["value"] is True


@pytest.mark.asyncio
async def test_chat_completion_includes_previous_user_turn_in_followup_request(
    monkeypatch: pytest.MonkeyPatch,
    client: AsyncClient,
):
    session_id = f"history-followup-{uuid4()}"
    captured_rounds: list[list[dict[str, str]]] = []

    async def fake_chat_completion(*, messages, model=None, stream=False, tools=None, system_prompt=None, on_stream_delta=None):
        del model, stream, tools, system_prompt, on_stream_delta
        captured_rounds.append(list(messages))
        return {
            "content": "ack",
            "tool_calls": [],
            "model": "mock-model",
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }

    monkeypatch.setattr(llm_service, "chat_completion", fake_chat_completion)
    monkeypatch.setattr(
        chat_api,
        "retrieve_context_blocks_service",
        AsyncMock(return_value={"context_parts": [], "citations": [], "retrieval_refs": [], "diagnostics": {"mode": "empty"}}),
    )

    first_message = "第一轮消息：苹果和香蕉。"
    second_message = "请复述我上一条消息。"

    first = await client.post(
        "/api/v1/chat/completions",
        json={"session_id": session_id, "message": first_message},
    )
    assert first.status_code == 200

    second = await client.post(
        "/api/v1/chat/completions",
        json={"session_id": session_id, "message": second_message},
    )
    assert second.status_code == 200
    assert len(captured_rounds) == 2

    second_round = captured_rounds[1]
    assert any(msg.get("role") == "user" and msg.get("content") == first_message for msg in second_round)
    assert any(msg.get("role") == "assistant" and msg.get("content") == "ack" for msg in second_round)
    assert any(msg.get("role") == "user" and msg.get("content") == second_message for msg in second_round)


@pytest.mark.asyncio
async def test_chat_completion_persists_user_message_before_task_finishes(
    monkeypatch: pytest.MonkeyPatch,
    client: AsyncClient,
):
    session_id = f"user-persist-{uuid4()}"
    message = "这条消息在任务失败时也必须保留。"

    async def failing_chat_completion(*, messages, model=None, stream=False, tools=None, system_prompt=None, on_stream_delta=None):
        del messages, model, stream, tools, system_prompt, on_stream_delta
        raise RuntimeError("model boom")

    monkeypatch.setattr(llm_service, "chat_completion", failing_chat_completion)
    monkeypatch.setattr(
        chat_api,
        "retrieve_context_blocks_service",
        AsyncMock(return_value={"context_parts": [], "citations": [], "retrieval_refs": [], "diagnostics": {"mode": "empty"}}),
    )

    response = await client.post(
        "/api/v1/chat/completions",
        json={"session_id": session_id, "message": message, "use_tools": False},
    )
    assert response.status_code == 200
    assert response.json()["data"]["failed"] is True

    history = await client.get(f"/api/v1/chat/sessions/{session_id}/messages?limit=20")
    assert history.status_code == 200
    messages = history.json()["data"]["messages"]
    assert any(msg["role"] == "user" and msg["content"] == message for msg in messages)


@pytest.mark.asyncio
async def test_chat_completion_simulates_all_non_pause_tools(
    monkeypatch: pytest.MonkeyPatch,
    client: AsyncClient,
    tmp_path: Path,
):
    for tool_name in list(tool_registry.get_tool_names()):
        tool_registry.unregister(tool_name)
    initialize_tools()

    note_path = tmp_path / "note.md"
    note_path.write_text("# Note\n\nAlpha block\n\nBeta block\n", encoding="utf-8")
    pdf_path = tmp_path / "paper.pdf"
    pdf_path.write_bytes(b"%PDF-1.4")
    web_path = tmp_path / "page.html"
    web_path.write_text("<h1>Paper</h1>", encoding="utf-8")

    note_id = f"note-{uuid4()}"
    pdf_id = f"pdf-{uuid4()}"
    web_id = f"web-{uuid4()}"
    session_id = f"tool-sim-{uuid4()}"

    async with async_session_maker() as db:
        db.add(
            File(
                id=note_id,
                name="note.md",
                file_type=FileType.MD,
                path=str(note_path),
                size=note_path.stat().st_size,
                page_count=1,
                meta={},
            )
        )
        db.add(
            File(
                id=pdf_id,
                name="paper.pdf",
                file_type=FileType.PDF,
                path=str(pdf_path),
                size=pdf_path.stat().st_size,
                page_count=3,
                meta={},
            )
        )
        db.add(
            File(
                id=web_id,
                name="page.html",
                file_type=FileType.WEB,
                path=str(web_path),
                size=web_path.stat().st_size,
                page_count=1,
                meta={},
            )
        )
        await db.commit()

    async with async_session_maker() as db:
        db.add(
            DocumentPageAsset(
                id=f"asset-{uuid4()}",
                file_id=pdf_id,
                page=2,
                image_path=str(tmp_path / "page-2.jpg"),
                image_url="/uploads/page-2.jpg",
                text_anchor="benchmark table with chart",
            )
        )
        db.add(
            DocumentSegment(
                id=f"web-seg-{uuid4()}",
                file_id=web_id,
                source_type="web",
                page=1,
                section="Intro",
                chunk_index=0,
                bbox=None,
                text="Web block content",
                segment_type="paragraph",
                confidence=1.0,
                source="local",
                meta={},
            )
        )
        db.add(
            FileIndexStatus(
                file_id=pdf_id,
                parse_status="ready",
                embedding_status="ready",
                last_error=None,
            )
        )
        await db.commit()

    async def fake_get_outline(*, db, file_id):  # noqa: ARG001
        return [{"segment_id": "outline-1", "page": 1, "section": "Intro", "title": "Intro"}]

    async def fake_locate(**kwargs):  # noqa: ARG001
        target_file_id = str(kwargs.get("file_ids", [pdf_id])[0] if kwargs.get("file_ids") else pdf_id)
        return {
            "hits": [
                _Hit(
                    segment_id="seg-1",
                    file_id=target_file_id,
                    page=2,
                    section="Results",
                    source_type="pdf",
                    score=0.93,
                    source_mode="fusion",
                    reason="chart match",
                    text="Results page with chart and benchmark table.",
                )
            ],
            "diagnostics": {"mode": "mock"},
        }

    async def fake_read_segments(**kwargs):  # noqa: ARG001
        return {
            "file_id": pdf_id,
            "content": "Detailed read of the result section.",
            "segments": [{"segment_id": "seg-1", "page": 2}],
        }

    monkeypatch.setattr(
        "app.services.tools.handlers.reader_tools.reader_orchestrator.get_outline",
        fake_get_outline,
    )
    monkeypatch.setattr(
        "app.services.tools.handlers.reader_tools.reader_orchestrator.locate_relevant_segments",
        fake_locate,
    )
    monkeypatch.setattr(
        "app.services.tools.handlers.reader_tools.reader_orchestrator.read_segments",
        fake_read_segments,
    )
    monkeypatch.setattr(
        "app.services.tools.handlers.chart_tools.reader_orchestrator.locate_relevant_segments",
        fake_locate,
    )
    monkeypatch.setattr(
        "app.services.tools.handlers.editor_ops.manager.broadcast_to_session",
        AsyncMock(return_value=None),
    )

    round_calls = {"count": 0}

    async def fake_chat_completion(*, messages, model=None, stream=False, tools=None, system_prompt=None, on_stream_delta=None):
        del messages, tools, system_prompt
        round_calls["count"] += 1
        if round_calls["count"] == 1:
            return {
                "content": "Using tools to inspect, write, and summarize.",
                "tool_calls": [
                    {
                        "id": "call-register",
                        "type": "function",
                        "function": {
                            "name": "register_task",
                            "arguments": json.dumps({"task_name": "Review uploaded paper", "task_description": "Run the tool chain"}),
                        },
                    },
                    {
                        "id": "call-index",
                        "type": "function",
                        "function": {
                            "name": "get_index_status",
                            "arguments": json.dumps({"file_id": pdf_id}),
                        },
                    },
                    {
                        "id": "call-outline",
                        "type": "function",
                        "function": {
                            "name": "get_document_outline",
                            "arguments": json.dumps({"file_id": pdf_id}),
                        },
                    },
                    {
                        "id": "call-locate",
                        "type": "function",
                        "function": {
                            "name": "locate_relevant_segments",
                            "arguments": json.dumps({"query": "benchmark chart", "file_id": pdf_id, "top_k": 3}),
                        },
                    },
                    {
                        "id": "call-read",
                        "type": "function",
                        "function": {
                            "name": "read_document_segments",
                            "arguments": json.dumps({"file_id": pdf_id, "anchor_page": 2, "page_window": 1}),
                        },
                    },
                    {
                        "id": "call-explain",
                        "type": "function",
                        "function": {
                            "name": "explain_retrieval",
                            "arguments": json.dumps({"query": "benchmark chart", "file_id": pdf_id}),
                        },
                    },
                    {
                        "id": "call-web",
                        "type": "function",
                        "function": {
                            "name": "read_webpage_blocks",
                            "arguments": json.dumps({"file_id": web_id, "block_start": 0, "block_end": 0}),
                        },
                    },
                    {
                        "id": "call-chart",
                        "type": "function",
                        "function": {
                            "name": "add_file_charts_to_note",
                            "arguments": json.dumps({"file_id": note_id, "source_file_id": pdf_id, "query": "benchmark chart", "max_charts": 1}),
                        },
                    },
                    {
                        "id": "call-update-file",
                        "type": "function",
                        "function": {
                            "name": "update_file",
                            "arguments": json.dumps({"file_id": note_id, "content": "# Note\n\nRewritten summary block\n", "summary": "Rewrite note"}),
                        },
                    },
                    {
                        "id": "call-update-block",
                        "type": "function",
                        "function": {
                            "name": "update_block",
                            "arguments": json.dumps({"file_id": note_id, "block_index": 0, "content": "# Note\n\nUpdated intro", "summary": "Update intro block"}),
                        },
                    },
                    {
                        "id": "call-insert-block",
                        "type": "function",
                        "function": {
                            "name": "insert_block",
                            "arguments": json.dumps({"file_id": note_id, "after_block_index": 0, "content": "Inserted findings block", "summary": "Insert findings"}),
                        },
                    },
                    {
                        "id": "call-delete-block",
                        "type": "function",
                        "function": {
                            "name": "delete_block",
                            "arguments": json.dumps({"file_id": note_id, "block_index": 1, "summary": "Delete stale block"}),
                        },
                    },
                    {
                        "id": "call-deliver",
                        "type": "function",
                        "function": {
                            "name": "deliver_task",
                            "arguments": json.dumps({"task_name": "Review uploaded paper", "completion_summary": "Finished the tool-assisted pass"}),
                        },
                    },
                ],
                "model": model or "mock-model",
                "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20},
            }

        if stream and on_stream_delta is not None:
            await on_stream_delta("Done. ")
            await on_stream_delta("All tools completed.")
        return {
            "content": "Done. All tools completed.",
            "tool_calls": [],
            "model": model or "mock-model",
            "usage": {"prompt_tokens": 8, "completion_tokens": 6, "total_tokens": 14},
        }

    monkeypatch.setattr(llm_service, "chat_completion", fake_chat_completion)

    response = await client.post(
        "/api/v1/chat/completions",
        json={
            "session_id": session_id,
            "message": "Use every non-pause tool once.",
            "context_files": [note_id, pdf_id, web_id],
            "permissions": {
                note_id: "write",
                pdf_id: "read",
                web_id: "read",
            },
            "use_tools": True,
        },
    )
    assert response.status_code == 200
    payload = response.json()["data"]
    assert payload.get("paused") is not True
    assert payload["content"] == "Done. All tools completed."
    assert len(payload["tool_results"]) == 13
    assert round_calls["count"] == 2

    async with async_session_maker() as db:
        state = (
            await db.execute(select(SessionTaskState).where(SessionTaskState.session_id == session_id))
        ).scalar_one()
        memory_epoch = (state.artifacts_json or {}).get("memory_epoch") or {}
        tool_history = ((memory_epoch.get("tool_history") or {}).get("calls") or [])
        executed = {entry.get("tool") for entry in tool_history}

    assert executed == {
        "register_task",
        "get_index_status",
        "get_document_outline",
        "locate_relevant_segments",
        "read_document_segments",
        "explain_retrieval",
        "read_webpage_blocks",
        "add_file_charts_to_note",
        "update_file",
        "update_block",
        "insert_block",
        "delete_block",
        "deliver_task",
    }
