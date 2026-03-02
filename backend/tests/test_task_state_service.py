import uuid

import pytest
from sqlalchemy import select

from app.config import settings
from app.database import async_session_maker
from app.models import Session, SessionTaskState
from app.services.task_state_service import (
    default_task_state_snapshot,
    parse_task_update,
    upsert_task_state,
)


def test_default_task_state_snapshot():
    snap = default_task_state_snapshot("task-1")
    assert snap["task_id"] == "task-1"
    assert snap["state"] == "planning"
    assert snap["current_step"] == 0
    assert snap["total_steps"] == 0


def test_parse_task_update_variants():
    parsed = parse_task_update(
        """
        some text
        ```json
        {"task_update":{"state":"executing","current_step":2,"total_steps":5}}
        ```
        """
    )
    assert parsed["parsed"] is True
    assert parsed["state"] == "executing"
    assert parsed["current_step"] == 2
    assert parsed["total_steps"] == 5

    inline = parse_task_update('{"state":"blocked","current_step":"x","total_steps":"y","blocked_reason":12}')
    assert inline["parsed"] is True
    assert inline["state"] == "blocked"
    assert inline["current_step"] == 0
    assert inline["total_steps"] == 0
    assert inline["blocked_reason"] == "12"

    failed = parse_task_update("no json payload")
    assert failed["parsed"] is False


@pytest.mark.asyncio
async def test_upsert_task_state_disabled(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(settings, "TASK_STATE_MACHINE_ENABLED", False, raising=False)

    async with async_session_maker() as db:
        result = await upsert_task_state(
            db=db,
            session_id="s-disabled",
            task_id="t-disabled",
            state="blocked",
            goal="Goal",
            current_step=1,
            total_steps=3,
        )
        assert result["state"] == "blocked"
        assert result["next_action"] == "retry"


@pytest.mark.asyncio
async def test_upsert_task_state_create_and_update(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(settings, "TASK_STATE_MACHINE_ENABLED", True, raising=False)
    session_id = f"s-{uuid.uuid4()}"

    async with async_session_maker() as db:
        db.add(Session(id=session_id, name="Task Session", permissions={}))
        await db.commit()

        created = await upsert_task_state(
            db=db,
            session_id=session_id,
            task_id="task-a",
            state="planning",
            goal="Initial goal",
            current_step=0,
            total_steps=2,
            artifacts_json={"a": 1},
        )
        await db.commit()
        assert created["state"] == "planning"

        updated = await upsert_task_state(
            db=db,
            session_id=session_id,
            task_id="task-a",
            state="executing",
            goal="Updated goal",
            current_step=1,
            total_steps=2,
            next_action="continue",
            blocked_reason=None,
            plan_json={"steps": [1, 2]},
        )
        await db.commit()
        assert updated["state"] == "executing"
        assert updated["next_action"] == "continue"

        row = (
            await db.execute(select(SessionTaskState).where(SessionTaskState.session_id == session_id))
        ).scalar_one()
        assert row.goal == "Updated goal"
        assert row.current_step == 1
