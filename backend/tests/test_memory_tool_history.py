import json
from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.database import async_session_maker, init_db
from app.models import SessionTaskState
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
async def test_pause_resume_keeps_full_tool_result_in_memory_epoch(
    monkeypatch: pytest.MonkeyPatch,
    client: AsyncClient,
):
    for tool_name in list(tool_registry.get_tool_names()):
        tool_registry.unregister(tool_name)
    initialize_tools()

    calls = {"count": 0}

    async def fake_chat_completion(*, messages, model=None, stream=False, tools=None, system_prompt=None, on_stream_delta=None):
        calls["count"] += 1
        if calls["count"] == 1:
            return {
                "content": "Need a user choice before continuing.",
                "tool_calls": [
                    {
                        "id": "pause_call_1",
                        "type": "function",
                        "function": {
                            "name": "pause_for_user_choice",
                            "arguments": json.dumps(
                                {
                                    "question": "Select output style",
                                    "options": [
                                        {"id": "brief", "label": "Brief"},
                                        {"id": "detailed", "label": "Detailed"},
                                    ],
                                    "recommended_option_id": "brief",
                                }
                            ),
                        },
                    }
                ],
                "model": model or "test-model",
                "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20},
            }

        return {
            "content": "Resumed successfully.",
            "tool_calls": [],
            "model": model or "test-model",
            "usage": {"prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20},
        }

    monkeypatch.setattr(llm_service, "chat_completion", fake_chat_completion)

    session_id = f"mem-history-{uuid4()}"
    first = await client.post(
        "/api/v1/chat/completions",
        json={
            "session_id": session_id,
            "message": "Pause and ask me before continuing",
            "context_files": [],
            "use_tools": True,
        },
    )
    assert first.status_code == 200
    first_data = first.json()["data"]
    assert first_data["paused"] is True
    task_id = first_data["task_id"]
    prompt = first_data["awaiting_user_input"]

    async with async_session_maker() as db:
        row = (await db.execute(select(SessionTaskState).where(SessionTaskState.session_id == session_id))).scalar_one()
        memory_epoch = (row.artifacts_json or {}).get("memory_epoch") or {}
        calls_before = ((memory_epoch.get("tool_history") or {}).get("calls") or [])
        assert len(calls_before) >= 1
        pause_call_before = calls_before[0]
        assert pause_call_before["tool"] == "pause_for_user_choice"
        assert pause_call_before["result_full"]["success"] is True
        prompt_id_before = pause_call_before["result_full"]["data"]["prompt"]["prompt_id"]

    second = await client.post(
        f"/api/v1/chat/tasks/{task_id}/answer",
        json={
            "session_id": session_id,
            "prompt_id": prompt["prompt_id"],
            "selected_option_id": "brief",
        },
    )
    assert second.status_code == 200
    second_data = second.json()["data"]
    assert second_data["paused"] is False
    assert "Resumed successfully" in second_data["content"]

    async with async_session_maker() as db:
        row = (await db.execute(select(SessionTaskState).where(SessionTaskState.session_id == session_id))).scalar_one()
        memory_epoch = (row.artifacts_json or {}).get("memory_epoch") or {}
        calls_after = ((memory_epoch.get("tool_history") or {}).get("calls") or [])
        pause_calls = [c for c in calls_after if c.get("tool") == "pause_for_user_choice"]
        assert pause_calls
        prompt_id_after = pause_calls[0]["result_full"]["data"]["prompt"]["prompt_id"]
        assert prompt_id_after == prompt_id_before
