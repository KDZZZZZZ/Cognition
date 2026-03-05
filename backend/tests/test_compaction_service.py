from datetime import datetime, timedelta
from typing import Any, Dict
from uuid import uuid4

import pytest
from sqlalchemy import delete, select

from app.config import settings
from app.database import async_session_maker, init_db
from app.models import ChatMessage, ConversationCompaction, Session
from app.services.compaction_service import maybe_compact_history
from app.services.llm_service import llm_service


def _build_history(session_id: str, turns: int = 10) -> list[ChatMessage]:
    now = datetime.utcnow()
    history: list[ChatMessage] = []
    for idx in range(turns):
        role = "user" if idx % 2 == 0 else "assistant"
        content = f"{role} turn {idx} " + ("content " * 80)
        history.append(
            ChatMessage(
                id=str(uuid4()),
                session_id=session_id,
                role=role,
                content=content,
                timestamp=now + timedelta(seconds=idx),
            )
        )
    return history


def _base_messages(history: list[ChatMessage]) -> list[Dict[str, str]]:
    messages: list[Dict[str, str]] = [{"role": "system", "content": "system prompt"}]
    for msg in history:
        messages.append({"role": msg.role, "content": msg.content})
    messages.append({"role": "user", "content": "latest request " + ("x" * 600)})
    return messages


@pytest.mark.asyncio
async def test_maybe_compact_history_uses_model_and_writes_memory_snapshot(monkeypatch: pytest.MonkeyPatch):
    await init_db()
    session_id = f"compact-model-{uuid4()}"
    history = _build_history(session_id)
    pre_compact_messages = _base_messages(history)

    async def fake_chat_completion(*, messages, model=None, stream=False, tools=None, system_prompt=None, tool_choice=None, **kwargs):
        return {
            "content": """
            {
              "summary": "model compact summary",
              "key_state": {
                "current_goal": "Goal A",
                "current_material": "Book A",
                "current_section": "Section 2",
                "next_step": "Read next theorem"
              },
              "hard_constraints": ["constraint-1"],
              "temporary_decisions": ["decision-1"],
              "unwritten_conclusions": ["conclusion-1"],
              "open_loops": ["loop-1"]
            }
            """,
            "tool_calls": [],
            "model": model or "test-model",
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }

    monkeypatch.setattr(llm_service, "chat_completion", fake_chat_completion)
    monkeypatch.setattr(settings, "AUTO_COMPACT_ENABLED", True)
    monkeypatch.setattr(settings, "MODEL_CONTEXT_WINDOW_TOKENS", 1200)
    monkeypatch.setattr(settings, "COMPACT_TRIGGER_RATIO", 0.2)
    monkeypatch.setattr(settings, "COMPACT_TARGET_TOKENS", 600)

    async with async_session_maker() as db:
        db.add(Session(id=session_id, name="compact-test", permissions={}))
        await db.commit()

        result = await maybe_compact_history(
            db=db,
            session_id=session_id,
            history_messages=history,
            pre_compact_messages=pre_compact_messages,
            compact_mode="auto",
            memory_epoch={
                "state": "executing",
                "dialogue": {"latest_user_goal": "Goal A", "current_focus": {"book": "Book A", "section": "S2"}},
                "task_list": {"counts": {"total": 1, "running": 1, "waiting": 0, "completed": 0}, "items": []},
                "tool_history": {"calls": []},
            },
            model="kimi-latest",
        )
        await db.commit()

        meta = result["compact_meta"]
        assert meta["triggered"] is True
        assert meta["model_compaction_used"] is True
        assert str(meta["reason"]).endswith("_model")
        assert meta["memory_snapshot"]["latest"]["summary"] == "model compact summary"
        assert meta["memory_snapshot"]["latest"]["key_state"]["current_goal"] == "Goal A"
        assert meta["before_tokens"] >= meta["before_messages_tokens"]
        assert meta["memory_tokens"] > 0
        token_window = meta["token_window"]
        assert token_window["before_total_input_tokens"] == meta["before_tokens"]
        assert token_window["components"]["memory_tokens"] == meta["memory_tokens"]
        assert token_window["components"]["system_tokens"] > 0
        assert token_window["before_occupancy_ratio"] > 0

        row = (
            await db.execute(
                select(ConversationCompaction)
                .where(ConversationCompaction.session_id == session_id)
                .order_by(ConversationCompaction.sequence.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        assert row is not None
        assert row.key_facts_json["model_compaction_used"] is True
        assert row.key_facts_json["memory_snapshot"]["summary"] == "model compact summary"
        assert row.key_facts_json["token_window"]["before_total_input_tokens"] == meta["before_tokens"]

        await db.execute(delete(ConversationCompaction).where(ConversationCompaction.session_id == session_id))
        await db.execute(delete(Session).where(Session.id == session_id))
        await db.commit()


@pytest.mark.asyncio
async def test_maybe_compact_history_falls_back_when_model_output_invalid(monkeypatch: pytest.MonkeyPatch):
    await init_db()
    session_id = f"compact-fallback-{uuid4()}"
    history = _build_history(session_id)
    pre_compact_messages = _base_messages(history)

    async def fake_chat_completion(*, messages, model=None, stream=False, tools=None, system_prompt=None, tool_choice=None, **kwargs):
        return {
            "content": "not-json-response",
            "tool_calls": [],
            "model": model or "test-model",
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }

    monkeypatch.setattr(llm_service, "chat_completion", fake_chat_completion)
    monkeypatch.setattr(settings, "AUTO_COMPACT_ENABLED", True)
    monkeypatch.setattr(settings, "MODEL_CONTEXT_WINDOW_TOKENS", 1200)
    monkeypatch.setattr(settings, "COMPACT_TRIGGER_RATIO", 0.2)
    monkeypatch.setattr(settings, "COMPACT_TARGET_TOKENS", 600)

    async with async_session_maker() as db:
        db.add(Session(id=session_id, name="compact-test", permissions={}))
        await db.commit()

        result = await maybe_compact_history(
            db=db,
            session_id=session_id,
            history_messages=history,
            pre_compact_messages=pre_compact_messages,
            compact_mode="auto",
            memory_epoch={
                "state": "executing",
                "dialogue": {"latest_user_goal": "Goal B", "current_focus": {"book": "Book B", "section": "S3"}},
                "task_list": {"counts": {"total": 1, "running": 1, "waiting": 0, "completed": 0}, "items": []},
                "tool_history": {"calls": []},
            },
            model="kimi-latest",
        )
        await db.commit()

        meta = result["compact_meta"]
        assert meta["triggered"] is True
        assert meta["model_compaction_used"] is False
        assert str(meta["reason"]).endswith("_fallback")
        assert "Compacted conversation history" in meta["memory_snapshot"]["latest"]["summary"]
        assert meta["memory_tokens"] > 0
        assert meta["token_window"]["components"]["system_tokens"] > 0
        assert meta["token_window"]["components"]["memory_tokens"] == meta["memory_tokens"]

        row = (
            await db.execute(
                select(ConversationCompaction)
                .where(ConversationCompaction.session_id == session_id)
                .order_by(ConversationCompaction.sequence.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        assert row is not None
        assert row.key_facts_json["model_compaction_used"] is False
        assert "memory_snapshot" in (row.key_facts_json or {})

        await db.execute(delete(ConversationCompaction).where(ConversationCompaction.session_id == session_id))
        await db.execute(delete(Session).where(Session.id == session_id))
        await db.commit()
