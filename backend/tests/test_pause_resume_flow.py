import json

import pytest
from httpx import ASGITransport, AsyncClient

from app.services.llm_service import llm_service
from app.services.tools.handlers import initialize_tools
from app.services.tools.registry import tool_registry
from main import app


@pytest.fixture
async def client():
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as ac:
        yield ac


@pytest.mark.asyncio
async def test_pause_and_resume_same_task(monkeypatch: pytest.MonkeyPatch, client: AsyncClient):
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
                                    "question": "Select the output style",
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
            "content": "Resumed successfully with the selected option.",
            "tool_calls": [],
            "model": model or "test-model",
            "usage": {"prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20},
        }

    monkeypatch.setattr(llm_service, "chat_completion", fake_chat_completion)

    first = await client.post(
        "/api/v1/chat/completions",
        json={
            "session_id": "pause-session-1",
            "message": "Please continue but ask me first",
            "context_files": [],
            "use_tools": True,
        },
    )
    assert first.status_code == 200
    first_data = first.json()["data"]
    assert first_data["paused"] is True
    assert "awaiting_user_input" in first_data
    task_id = first_data["task_id"]
    prompt = first_data["awaiting_user_input"]
    assert prompt["prompt_id"]

    second = await client.post(
        f"/api/v1/chat/tasks/{task_id}/answer",
        json={
            "session_id": "pause-session-1",
            "prompt_id": prompt["prompt_id"],
            "selected_option_id": "brief",
        },
    )
    assert second.status_code == 200
    second_data = second.json()["data"]
    assert second_data["task_id"] == task_id
    assert second_data.get("paused") is False
    assert "Resumed successfully" in second_data["content"]
    assert calls["count"] >= 2
