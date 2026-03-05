import uuid
from collections import defaultdict
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import SessionTask, SessionTaskRegistry, SessionTaskStep


REGISTRY_ACTIVE_STATUSES = {"running", "blocked"}
TASK_ACTIVE_STATUSES = {"pending", "running", "blocked"}
STEP_ACTIVE_STATUSES = {"pending", "running", "blocked"}


def _now() -> datetime:
    return datetime.utcnow()


async def get_registry_row(db: AsyncSession, registry_id: str) -> Optional[SessionTaskRegistry]:
    return await db.get(SessionTaskRegistry, registry_id)


async def get_active_registry_row(db: AsyncSession, session_id: str) -> Optional[SessionTaskRegistry]:
    result = await db.execute(
        select(SessionTaskRegistry)
        .where(SessionTaskRegistry.session_id == session_id)
        .where(SessionTaskRegistry.status.in_(tuple(REGISTRY_ACTIVE_STATUSES)))
        .order_by(SessionTaskRegistry.updated_at.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def list_registry_tasks(db: AsyncSession, registry_id: str) -> List[SessionTask]:
    result = await db.execute(
        select(SessionTask)
        .where(SessionTask.registry_id == registry_id)
        .order_by(SessionTask.task_order.asc(), SessionTask.created_at.asc())
    )
    return list(result.scalars().all())


async def list_task_steps(db: AsyncSession, task_ids: List[str]) -> List[SessionTaskStep]:
    if not task_ids:
        return []
    result = await db.execute(
        select(SessionTaskStep)
        .where(SessionTaskStep.task_id.in_(task_ids))
        .order_by(SessionTaskStep.step_index.asc(), SessionTaskStep.updated_at.asc())
    )
    return list(result.scalars().all())


async def get_registry_snapshot(db: AsyncSession, registry_id: str) -> Optional[Dict[str, Any]]:
    registry = await get_registry_row(db, registry_id)
    if not registry:
        return None
    tasks = await list_registry_tasks(db, registry_id)
    steps = await list_task_steps(db, [item.id for item in tasks])
    return build_task_registry_snapshot(registry, tasks, steps)


async def get_active_registry_snapshot(db: AsyncSession, session_id: str) -> Optional[Dict[str, Any]]:
    registry = await get_active_registry_row(db, session_id)
    if not registry:
        return None
    return await get_registry_snapshot(db, registry.id)


async def find_registry_by_task_id(db: AsyncSession, session_id: str, task_id: str) -> Optional[SessionTaskRegistry]:
    task_result = await db.execute(
        select(SessionTask)
        .where(SessionTask.session_id == session_id)
        .where(SessionTask.id == task_id)
        .limit(1)
    )
    task = task_result.scalar_one_or_none()
    if not task:
        return None
    return await get_registry_row(db, task.registry_id)


async def create_task_registry(
    *,
    db: AsyncSession,
    session_id: str,
    registry_id: str,
    source_message_id: Optional[str],
    tasks: List[Dict[str, Any]],
    catalog_version: int,
) -> Dict[str, Any]:
    registry = SessionTaskRegistry(
        id=registry_id,
        session_id=session_id,
        source_message_id=source_message_id,
        status="running",
        goal_summary="; ".join(str(item.get("goal") or "").strip() for item in tasks[:3]),
        catalog_version=catalog_version,
    )
    db.add(registry)
    await db.flush()

    created_tasks: List[SessionTask] = []
    created_steps: List[SessionTaskStep] = []
    for task_order, task_payload in enumerate(tasks):
        task_id = f"{registry_id}:task:{task_order + 1}"
        step_types = [str(item) for item in task_payload.get("steps") or []]
        task_row = SessionTask(
            id=task_id,
            registry_id=registry_id,
            session_id=session_id,
            task_order=task_order,
            goal=str(task_payload.get("goal") or "").strip(),
            status="running" if task_order == 0 else "pending",
            current_step_index=0,
            total_steps=len(step_types),
            artifacts_json={},
        )
        created_tasks.append(task_row)
        db.add(task_row)
        for step_index, step_type in enumerate(step_types):
            step_id = f"{task_id}:step:{step_index}"
            step_row = SessionTaskStep(
                id=step_id,
                task_id=task_id,
                step_index=step_index,
                step_type=step_type,
                status="pending",
                output_json={},
            )
            created_steps.append(step_row)
            db.add(step_row)

    registry.active_task_id = created_tasks[0].id if created_tasks else None
    await db.flush()
    return build_task_registry_snapshot(registry, created_tasks, created_steps)


async def ensure_registry_cursor(
    *,
    db: AsyncSession,
    registry_id: str,
) -> Tuple[Optional[SessionTaskRegistry], Optional[SessionTask], Optional[SessionTaskStep]]:
    registry = await get_registry_row(db, registry_id)
    if not registry:
        return None, None, None

    tasks = await list_registry_tasks(db, registry_id)
    task_map = {task.id: task for task in tasks}
    active_task = task_map.get(registry.active_task_id) if registry.active_task_id else None

    if not active_task or active_task.status not in TASK_ACTIVE_STATUSES:
        active_task = next((task for task in tasks if task.status in TASK_ACTIVE_STATUSES), None)
        if not active_task:
            pending_task = next((task for task in tasks if task.status == "pending"), None)
            if pending_task:
                pending_task.status = "running"
                pending_task.updated_at = _now()
                active_task = pending_task
        if active_task:
            registry.active_task_id = active_task.id
            registry.updated_at = _now()

    if not active_task:
        return registry, None, None

    steps = await list_task_steps(db, [active_task.id])
    active_step = next((step for step in steps if step.status in {"running", "blocked"}), None)
    if not active_step:
        active_step = next((step for step in steps if step.status == "pending"), None)
    if not active_step:
        return registry, active_task, None

    return registry, active_task, active_step


async def mark_step_running(
    *,
    db: AsyncSession,
    registry: SessionTaskRegistry,
    task: SessionTask,
    step: SessionTaskStep,
) -> None:
    now = _now()
    registry.status = "running"
    registry.active_task_id = task.id
    registry.updated_at = now
    task.status = "running"
    task.blocked_reason = None
    task.missing_inputs_json = None
    task.current_step_index = step.step_index
    task.updated_at = now
    step.status = "running"
    if step.started_at is None:
        step.started_at = now
    step.updated_at = now
    await db.flush()


async def mark_step_blocked(
    *,
    db: AsyncSession,
    registry: SessionTaskRegistry,
    task: SessionTask,
    step: SessionTaskStep,
    reason: str,
    missing_inputs: List[Dict[str, Any]],
    output_markdown: Optional[str] = None,
    output_json: Optional[Dict[str, Any]] = None,
) -> None:
    now = _now()
    registry.status = "blocked"
    registry.active_task_id = task.id
    registry.updated_at = now
    task.status = "blocked"
    task.blocked_reason = reason
    task.missing_inputs_json = {"items": missing_inputs}
    task.current_step_index = step.step_index
    task.updated_at = now
    step.status = "blocked"
    step.missing_inputs_json = {"items": missing_inputs}
    step.output_markdown = output_markdown
    step.output_json = output_json or {}
    step.updated_at = now
    await db.flush()


async def resume_blocked_step(
    *,
    db: AsyncSession,
    registry_id: str,
) -> Tuple[Optional[SessionTaskRegistry], Optional[SessionTask], Optional[SessionTaskStep]]:
    registry, task, step = await ensure_registry_cursor(db=db, registry_id=registry_id)
    if not registry or not task or not step:
        return registry, task, step
    if task.status == "blocked":
        task.status = "running"
        task.blocked_reason = None
        task.missing_inputs_json = None
    if step.status == "blocked":
        step.status = "running"
        step.missing_inputs_json = None
    registry.status = "running"
    registry.active_task_id = task.id
    now = _now()
    task.updated_at = now
    step.updated_at = now
    registry.updated_at = now
    await db.flush()
    return registry, task, step


async def complete_step(
    *,
    db: AsyncSession,
    registry: SessionTaskRegistry,
    task: SessionTask,
    step: SessionTaskStep,
    output_markdown: Optional[str],
    output_json: Optional[Dict[str, Any]],
    citations: Optional[List[Dict[str, Any]]],
    compact_anchor: Optional[Dict[str, Any]] = None,
    task_artifacts: Optional[Dict[str, Any]] = None,
    last_message_id: Optional[str] = None,
) -> Tuple[SessionTaskRegistry, Optional[SessionTask], Optional[SessionTaskStep]]:
    now = _now()
    step.status = "completed"
    step.completed_at = now
    step.output_markdown = output_markdown
    step.output_json = output_json or {}
    step.citations_json = {"items": citations or []}
    step.compact_anchor_json = compact_anchor
    step.missing_inputs_json = None
    step.updated_at = now

    task.current_step_index = step.step_index + 1
    task.updated_at = now
    if task_artifacts is not None:
        task.artifacts_json = task_artifacts
    if last_message_id:
        task.last_message_id = last_message_id

    task_steps = await list_task_steps(db, [task.id])
    next_step = next((item for item in task_steps if item.status == "pending"), None)
    if next_step:
        task.status = "running"
        registry.status = "running"
        registry.active_task_id = task.id
        registry.updated_at = now
        await db.flush()
        return registry, task, next_step

    task.status = "completed"
    task.current_step_index = task.total_steps

    registry_tasks = await list_registry_tasks(db, registry.id)
    next_task = next((item for item in registry_tasks if item.status == "pending"), None)
    if next_task:
        next_task.status = "running"
        next_task.current_step_index = 0
        next_task.updated_at = now
        registry.status = "running"
        registry.active_task_id = next_task.id
        registry.updated_at = now
        next_task_steps = await list_task_steps(db, [next_task.id])
        first_step = next((item for item in next_task_steps if item.status == "pending"), None)
        await db.flush()
        return registry, next_task, first_step

    registry.status = "completed"
    registry.active_task_id = None
    registry.updated_at = now
    await db.flush()
    return registry, None, None


async def mark_registry_cancelled(db: AsyncSession, registry_id: str) -> None:
    registry = await get_registry_row(db, registry_id)
    if not registry:
        return
    registry.status = "cancelled"
    registry.updated_at = _now()
    tasks = await list_registry_tasks(db, registry_id)
    for task in tasks:
        if task.status not in {"completed", "cancelled"}:
            task.status = "cancelled"
            task.updated_at = registry.updated_at
        steps = await list_task_steps(db, [task.id])
        for step in steps:
            if step.status not in {"completed", "skipped", "cancelled"}:
                step.status = "skipped"
                step.updated_at = registry.updated_at
    await db.flush()


def build_task_registry_snapshot(
    registry: SessionTaskRegistry,
    tasks: List[SessionTask],
    steps: List[SessionTaskStep],
) -> Dict[str, Any]:
    steps_by_task: Dict[str, List[SessionTaskStep]] = defaultdict(list)
    for step in steps:
        steps_by_task[step.task_id].append(step)

    task_items: List[Dict[str, Any]] = []
    for task in tasks:
        task_steps = sorted(steps_by_task.get(task.id) or [], key=lambda item: item.step_index)
        task_items.append(
            {
                "task_id": task.id,
                "goal": task.goal,
                "status": task.status,
                "task_order": task.task_order,
                "current_step_index": task.current_step_index,
                "total_steps": task.total_steps,
                "blocked_reason": task.blocked_reason,
                "missing_inputs": ((task.missing_inputs_json or {}).get("items") or []),
                "artifacts": task.artifacts_json or {},
                "steps": [
                    {
                        "index": step.step_index,
                        "type": step.step_type,
                        "status": step.status,
                        "missing_inputs": ((step.missing_inputs_json or {}).get("items") or []),
                        "output_preview": (step.output_markdown or "")[:400],
                        "compact_anchor": step.compact_anchor_json,
                    }
                    for step in task_steps
                ],
            }
        )

    return {
        "registry_id": registry.id,
        "session_id": registry.session_id,
        "status": registry.status,
        "active_task_id": registry.active_task_id,
        "goal_summary": registry.goal_summary,
        "catalog_version": registry.catalog_version,
        "tasks": task_items,
    }
