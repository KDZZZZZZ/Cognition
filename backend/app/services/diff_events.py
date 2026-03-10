from __future__ import annotations

import difflib
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import DiffEvent, DiffEventStatus, DiffLineSnapshot, LineDecision

LINE_REPLACE_MATCH_THRESHOLD = 0.55


def _line_similarity(left: str, right: str) -> float:
    if not left and not right:
        return 1.0
    if not left or not right:
        return 0.0
    return difflib.SequenceMatcher(a=left, b=right, autojunk=False).ratio()


def _choose_alignment_candidate(left: tuple[float, int], right: tuple[float, int]) -> tuple[float, int]:
    if left[0] != right[0]:
        return left if left[0] > right[0] else right
    return left if left[1] >= right[1] else right


def _align_replace_region(old_lines: list[str], new_lines: list[str]) -> list[tuple[int, int]]:
    old_count = len(old_lines)
    new_count = len(new_lines)
    if old_count == 0 or new_count == 0:
        return []

    similarity = [
        [_line_similarity(old_lines[old_index], new_lines[new_index]) for new_index in range(new_count)]
        for old_index in range(old_count)
    ]
    dp: list[list[tuple[float, int]]] = [
        [(0.0, 0) for _ in range(new_count + 1)]
        for _ in range(old_count + 1)
    ]

    for old_index in range(old_count - 1, -1, -1):
        for new_index in range(new_count - 1, -1, -1):
            best = _choose_alignment_candidate(dp[old_index + 1][new_index], dp[old_index][new_index + 1])
            score = similarity[old_index][new_index]
            if score >= LINE_REPLACE_MATCH_THRESHOLD:
                paired = (dp[old_index + 1][new_index + 1][0] + score, dp[old_index + 1][new_index + 1][1] + 1)
                best = _choose_alignment_candidate(best, paired)
            dp[old_index][new_index] = best

    if dp[0][0][1] == 0:
        return []

    pairs: list[tuple[int, int]] = []
    old_index = 0
    new_index = 0
    while old_index < old_count and new_index < new_count:
        score = similarity[old_index][new_index]
        current = dp[old_index][new_index]
        if score >= LINE_REPLACE_MATCH_THRESHOLD:
            paired = (dp[old_index + 1][new_index + 1][0] + score, dp[old_index + 1][new_index + 1][1] + 1)
            if current == paired:
                pairs.append((old_index, new_index))
                old_index += 1
                new_index += 1
                continue

        if current == dp[old_index][new_index + 1]:
            new_index += 1
            continue
        old_index += 1

    return pairs


def _append_replace_snapshots(
    snapshots: list[dict[str, Any]],
    *,
    old_lines: list[str],
    new_lines: list[str],
    line_no: int,
) -> int:
    aligned_pairs = _align_replace_region(old_lines, new_lines)
    if not aligned_pairs:
        shared = min(len(old_lines), len(new_lines))
        for offset in range(shared):
            snapshots.append(
                {
                    "line_no": line_no,
                    "old_line": old_lines[offset],
                    "new_line": new_lines[offset],
                    "decision": LineDecision.PENDING,
                }
            )
            line_no += 1

        for old_line in old_lines[shared:]:
            snapshots.append(
                {
                    "line_no": line_no,
                    "old_line": old_line,
                    "new_line": None,
                    "decision": LineDecision.PENDING,
                }
            )
            line_no += 1

        for new_line in new_lines[shared:]:
            snapshots.append(
                {
                    "line_no": line_no,
                    "old_line": None,
                    "new_line": new_line,
                    "decision": LineDecision.PENDING,
                }
            )
            line_no += 1

        return line_no

    old_cursor = 0
    new_cursor = 0
    for old_index, new_index in aligned_pairs:
        for inserted_line in new_lines[new_cursor:new_index]:
            snapshots.append(
                {
                    "line_no": line_no,
                    "old_line": None,
                    "new_line": inserted_line,
                    "decision": LineDecision.PENDING,
                }
            )
            line_no += 1

        for removed_line in old_lines[old_cursor:old_index]:
            snapshots.append(
                {
                    "line_no": line_no,
                    "old_line": removed_line,
                    "new_line": None,
                    "decision": LineDecision.PENDING,
                }
            )
            line_no += 1

        snapshots.append(
            {
                "line_no": line_no,
                "old_line": old_lines[old_index],
                "new_line": new_lines[new_index],
                "decision": LineDecision.PENDING,
            }
        )
        line_no += 1
        old_cursor = old_index + 1
        new_cursor = new_index + 1

    for removed_line in old_lines[old_cursor:]:
        snapshots.append(
            {
                "line_no": line_no,
                "old_line": removed_line,
                "new_line": None,
                "decision": LineDecision.PENDING,
            }
        )
        line_no += 1

    for inserted_line in new_lines[new_cursor:]:
        snapshots.append(
            {
                "line_no": line_no,
                "old_line": None,
                "new_line": inserted_line,
                "decision": LineDecision.PENDING,
            }
        )
        line_no += 1

    return line_no


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
            line_no = _append_replace_snapshots(
                snapshots,
                old_lines=old_lines[i1:i2],
                new_lines=new_lines[j1:j2],
                line_no=line_no,
            )
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
