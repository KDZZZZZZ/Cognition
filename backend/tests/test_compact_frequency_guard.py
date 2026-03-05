import json
from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

from app.database import async_session_maker
from app.models import ConversationCompaction
from app.prompts.system_prompts import SystemPrompts
from app.services.llm_service import llm_service
from main import app


@pytest.fixture
async def client():
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as ac:
        yield ac


@pytest.mark.asyncio
async def test_turn_finalize_compact_not_triggered_for_short_low_budget_turns(
    monkeypatch: pytest.MonkeyPatch,
    client: AsyncClient,
):
    session_id = f"compact-guard-{uuid4()}"

    async def fake_chat_completion(*, messages, model=None, stream=False, tools=None, system_prompt=None, on_stream_delta=None, tool_choice=None, **kwargs):
        del messages, model, stream, tools, on_stream_delta
        if system_prompt == SystemPrompts.ORCHESTRATOR_SYSTEM_PROMPT:
            return {
                "content": json.dumps({"tasks": [{"goal": "quick", "steps": ["GEN_PARSE"]}]}),
                "tool_calls": [],
                "model": "mock-model",
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            }
        return {
            "content": "ok",
            "tool_calls": [],
            "model": "mock-model",
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }

    monkeypatch.setattr(llm_service, "chat_completion", fake_chat_completion)

    for idx in range(10):
        response = await client.post(
            "/api/v1/chat/completions",
            json={
                "session_id": session_id,
                "message": f"m{idx} hello",
                "use_tools": False,
            },
        )
        assert response.status_code == 200
        payload = response.json()["data"]
        compact_meta = payload.get("compact_meta") or {}
        assert compact_meta.get("triggered") is not True

    async with async_session_maker() as db:
        count = await db.execute(
            select(func.count(ConversationCompaction.id)).where(ConversationCompaction.session_id == session_id)
        )
        assert int(count.scalar() or 0) == 0
