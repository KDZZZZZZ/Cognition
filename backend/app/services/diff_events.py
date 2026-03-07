from __future__ import annotations

import difflib
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import DiffEvent, DiffEventStatus, DiffLineSnapshot, LineDecision


def build_diff_line_snapshots(old_content: str, new_content: str) -> list[dict[str, Any]]:
    old_lines = old_content.splitlines()
    new_lines = new_content.splitlines()
    matcher = difflib.SequenceMatcher(a=old_lines, b=new_lines, autojunk=False)

    snapshots: list[dict[str, Any]] = []
    line_no = 1

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for old_line, new_line in zip(old_lines[i1:i2], new_lines[j1:j2]):
                snapshots.append(
                    {
                        "line_no": line_no,
                        "old_line": old_line,
                        "new_line": new_line,
                        "decision": LineDecision.ACCEPTED,
                    }
                )
                line_no += 1
            continue

        if tag == "replace":
            shared = min(i2 - i1, j2 - j1)
            for offset in range(shared):
                snapshots.append(
                    {
                        "line_no": line_no,
                        "old_line": old_lines[i1 + offset],
                        "new_line": new_lines[j1 + offset],
                        "decision": LineDecision.PENDING,
                    }
                )
                line_no += 1

            for old_line in old_lines[i1 + shared:i2]:
                snapshots.append(
                    {
                        "line_no": line_no,
                        "old_line": old_line,
                        "new_line": None,
                        "decision": LineDecision.PENDING,
                    }
                )
                line_no += 1

            for new_line in new_lines[j1 + shared:j2]:
                snapshots.append(
                    {
                        "line_no": line_no,
                        "old_line": None,
                        "new_line": new_line,
                        "decision": LineDecision.PENDING,
                    }
                )
                line_no += 1
            continue

        if tag == "delete":
            for old_line in old_lines[i1:i2]:
                snapshots.append(
                    {
                        "line_no": line_no,
                        "old_line": old_line,
                        "new_line": None,
                        "decision": LineDecision.PENDING,
                    }
                )
                line_no += 1
            continue

        if tag == "insert":
            for new_line in new_lines[j1:j2]:
                snapshots.append(
                    {
                        "line_no": line_no,
                        "old_line": None,
                        "new_line": new_line,
                        "decision": LineDecision.PENDING,
                    }
                )
                line_no += 1

    return snapshots


def compose_content_from_line_snapshots(snapshots: list[DiffLineSnapshot]) -> str:
    ordered = sorted(snapshots, key=lambda line: line.line_no)
    final_lines: list[str] = []
    for line in ordered:
        chosen = line.old_line if line.decision == LineDecision.REJECTED else line.new_line
        if chosen is not None:
            final_lines.append(chosen)
    return "\n".join(final_lines)


async def get_pending_diff_events(db: AsyncSession, file_id: str) -> list[DiffEvent]:
    result = await db.execute(
        select(DiffEvent)
        .where(DiffEvent.file_id == file_id, DiffEvent.status == DiffEventStatus.PENDING)
        .order_by(DiffEvent.created_at, DiffEvent.id)
    )
    return list(result.scalars().all())


async def get_latest_pending_diff_event(db: AsyncSession, file_id: str) -> Optional[DiffEvent]:
    pending_events = await get_pending_diff_events(db, file_id)
    return pending_events[-1] if pending_events else None


async def get_diff_event_lines(db: AsyncSession, event_id: str) -> list[DiffLineSnapshot]:
    result = await db.execute(
        select(DiffLineSnapshot)
        .where(DiffLineSnapshot.event_id == event_id)
        .order_by(DiffLineSnapshot.line_no)
    )
    return list(result.scalars().all())


async def resolve_pending_diff_event(
    db: AsyncSession,
    event: DiffEvent,
    *,
    replacement_content: Optional[str] = None,
) -> str:
    if replacement_content is None:
        lines = await get_diff_event_lines(db, event.id)
        replacement_content = compose_content_from_line_snapshots(lines)
    event.status = DiffEventStatus.RESOLVED
    event.resolved_at = datetime.utcnow()
    event.new_content = replacement_content
    return replacement_content


async def resolve_all_pending_diff_events(
    db: AsyncSession,
    file_id: str,
    *,
    replacement_content: Optional[str] = None,
    exclude_event_id: Optional[str] = None,
) -> list[DiffEvent]:
    pending_events = await get_pending_diff_events(db, file_id)
    resolved: list[DiffEvent] = []
    for event in pending_events:
        if exclude_event_id and event.id == exclude_event_id:
            continue
        await resolve_pending_diff_event(db, event, replacement_content=replacement_content)
        resolved.append(event)
    return resolved


async def get_effective_diff_base(
    db: AsyncSession,
    file_id: str,
    persisted_content: str,
) -> tuple[str, str, list[DiffEvent]]:
    pending_events = await get_pending_diff_events(db, file_id)
    if not pending_events:
        return persisted_content, persisted_content, []

    latest_event = pending_events[-1]
    latest_lines = await get_diff_event_lines(db, latest_event.id)
    effective_content = compose_content_from_line_snapshots(latest_lines)
    base_content = pending_events[0].old_content if pending_events[0].old_content is not None else persisted_content
    return base_content, effective_content, pending_events
