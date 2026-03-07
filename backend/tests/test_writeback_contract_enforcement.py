from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient

from app.api import chat as chat_api
from app.database import async_session_maker, init_db
from app.models import File, FileType
from app.services.llm_service import llm_service
from app.services.tools.handlers import initialize_tools
from app.services.tools.registry import tool_registry
from main import app


@pytest.fixture
async def client():
    await init_db()
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as ac:
        yield ac


@pytest.mark.asyncio
async def test_chat_completion_blocks_when_writeback_contract_unsatisfied(
    monkeypatch: pytest.MonkeyPatch,
    client: AsyncClient,
    tmp_path: Path,
):
    for tool_name in list(tool_registry.get_tool_names()):
        tool_registry.unregister(tool_name)
    initialize_tools()

    note_path = tmp_path / "paper-note.md"
    note_path.write_text("# Paper Note\n", encoding="utf-8")
    paper_path = tmp_path / "paper-source.txt"
    paper_path.write_text("Prophet uses confidence gaps for early commit decoding.", encoding="utf-8")

    note_id = f"note-{uuid4()}"
    paper_id = f"paper-{uuid4()}"
    session_id = f"writeback-{uuid4()}"

    async with async_session_maker() as db:
        db.add(
            File(
                id=note_id,
                name="paper-note.md",
                file_type=FileType.MD,
                path=str(note_path),
                size=note_path.stat().st_size,
                page_count=1,
                meta={},
            )
        )
        db.add(
            File(
                id=paper_id,
                name="paper-source.txt",
                file_type=FileType.TXT,
                path=str(paper_path),
                size=paper_path.stat().st_size,
                page_count=1,
                meta={},
            )
        )
        await db.commit()

    llm_rounds = {"count": 0}
    captured_messages: list[list[dict]] = []

    async def fake_chat_completion(*, messages, model=None, stream=False, tools=None, system_prompt=None, on_stream_delta=None, tool_choice=None, **kwargs):
        del model, stream, tools, system_prompt, on_stream_delta, tool_choice, kwargs
        llm_rounds["count"] += 1
        captured_messages.append(list(messages))
        if llm_rounds["count"] == 1:
            return {
                "content": "先建立论文骨架。",
                "tool_calls": [],
                "model": "mock-model",
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            }
        return {
            "content": "我会把结果写进 note 并生成 pending diff。",
            "tool_calls": [],
            "model": "mock-model",
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }

    monkeypatch.setattr(llm_service, "chat_completion", fake_chat_completion)
    monkeypatch.setattr(
        chat_api,
        "route_request_service",
        AsyncMock(
            return_value={
                "router_result": {
                    "tool": {
                        "max_rounds": 3,
                    }
                },
                "router_state": {},
            }
        ),
    )
    monkeypatch.setattr(
        chat_api,
        "orchestrate_request",
        AsyncMock(
            return_value={
                "orchestrator_result": {
                    "tasks": [
                        {
                            "goal": "写论文摘要卡片并生成 pending diff",
                            "steps": ["P_READ_SKELETON", "P_SUMMARY_CARD"],
                        }
                    ]
                },
                "catalog_version": 1,
                "warning": None,
                "fallback_used": False,
            }
        ),
    )
    monkeypatch.setattr(
        chat_api,
        "retrieve_context_blocks_service",
        AsyncMock(
            return_value={
                "context_parts": [],
                "citations": [],
                "retrieval_refs": [],
                "diagnostics": {"mode": "empty"},
                "retrieval_meta": {},
            }
        ),
    )

    response = await client.post(
        "/api/v1/chat/completions",
        json={
            "session_id": session_id,
            "message": "请根据论文内容生成 1-6 模板并写入当前 note，必须生成 pending diff。",
            "context_files": [note_id, paper_id],
            "permissions": {
                note_id: "write",
                paper_id: "read",
            },
            "use_tools": True,
        },
    )

    assert response.status_code == 200
    payload = response.json()["data"]
    assert payload["blocked"] is True
    assert payload["task_registry"]["status"] == "blocked"
    assert "没有完成写回要求" in payload["content"]
    assert "pending diff" in payload["content"]
    assert payload["tool_results"] == []
    assert llm_rounds["count"] == 3
    assert any(
        message.get("role") == "system"
        and "Writeback contract unsatisfied." in str(message.get("content") or "")
        for message in captured_messages[-1]
    )
