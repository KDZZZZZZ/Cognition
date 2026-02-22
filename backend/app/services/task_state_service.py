import json
import re
from datetime import datetime
from typing import Any, Dict, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import SessionTaskState

TASK_STATES = {"planning", "executing", "blocked", "done"}


def default_task_state_snapshot(task_id: str) -> Dict[str, Any]:
    return {
        "task_id": task_id,
        "state": "planning",
        "current_step": 0,
        "total_steps": 0,
    }


def parse_task_update(text: str) -> Dict[str, Any]:
    """
    Parse optional task update JSON from model output.

    Supported payload shapes:
    - {"task_update": {...}}
    - {"state":"executing","current_step":1,"total_steps":3}
    """
    if not text:
        return {"parsed": False, "warning": "empty_response"}

    def _extract_json_objects(raw: str) -> list[str]:
        objects: list[str] = []
        depth = 0
        start = -1
        for idx, ch in enumerate(raw):
            if ch == "{":
                if depth == 0:
                    start = idx
                depth += 1
            elif ch == "}":
                if depth > 0:
                    depth -= 1
                    if depth == 0 and start >= 0:
                        objects.append(raw[start : idx + 1])
                        start = -1
        return objects

    candidates = []
    for match in re.finditer(r"```json\s*(\{.*?\})\s*```", text, flags=re.DOTALL):
        candidates.append(match.group(1))
    for snippet in _extract_json_objects(text):
        if snippet not in candidates:
            candidates.append(snippet)

    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except Exception:
            continue

        payload = parsed.get("task_update") if isinstance(parsed, dict) else None
        if not isinstance(payload, dict):
            payload = parsed if isinstance(parsed, dict) else None
        if not payload:
            continue

        state = payload.get("state")
        if state not in TASK_STATES:
            continue

        current_step = payload.get("current_step", 0)
        total_steps = payload.get("total_steps", 0)
        try:
            current_step = max(0, int(current_step))
            total_steps = max(current_step, int(total_steps))
        except Exception:
            current_step = 0
            total_steps = 0

        next_action = payload.get("next_action")
        blocked_reason = payload.get("blocked_reason")
        if blocked_reason is not None:
            blocked_reason = str(blocked_reason)

        return {
            "parsed": True,
            "state": state,
            "current_step": current_step,
            "total_steps": total_steps,
            "next_action": next_action,
            "blocked_reason": blocked_reason,
            "raw": payload,
        }

    return {"parsed": False, "warning": "task_update_parse_failed"}


async def upsert_task_state(
    *,
    db: AsyncSession,
    session_id: str,
    task_id: str,
    state: str,
    goal: str,
    current_step: int,
    total_steps: int,
    next_action: Optional[str] = None,
    blocked_reason: Optional[str] = None,
    last_message_id: Optional[str] = None,
    plan_json: Optional[Dict[str, Any]] = None,
    artifacts_json: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    if not settings.TASK_STATE_MACHINE_ENABLED:
        return {
            "task_id": task_id,
            "state": state,
            "current_step": current_step,
            "total_steps": total_steps,
            "next_action": next_action if next_action is not None else ("retry" if state == "blocked" else None),
        }

    result = await db.execute(select(SessionTaskState).where(SessionTaskState.session_id == session_id))
    row = result.scalar_one_or_none()
    if not row:
        row = SessionTaskState(
            session_id=session_id,
            task_id=task_id,
            state=state,
            goal=goal,
            plan_json=plan_json or {},
            current_step=current_step,
            total_steps=total_steps,
            artifacts_json=artifacts_json or {},
            blocked_reason=blocked_reason,
            last_message_id=last_message_id,
        )
        db.add(row)
    else:
        row.task_id = task_id
        row.state = state
        row.goal = goal
        row.plan_json = plan_json or row.plan_json
        row.current_step = current_step
        row.total_steps = total_steps
        row.artifacts_json = artifacts_json or row.artifacts_json
        row.blocked_reason = blocked_reason
        row.last_message_id = last_message_id
        row.updated_at = datetime.utcnow()

    return {
        "task_id": row.task_id,
        "state": row.state,
        "current_step": row.current_step,
        "total_steps": row.total_steps,
        "next_action": next_action if next_action is not None else ("retry" if row.state == "blocked" else None),
    }
