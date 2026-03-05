from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import DocumentChunk, File as FileModel, SessionViewport
from app.services.diff_events import get_effective_diff_base, get_latest_pending_diff_event
from app.services.tools.base import PermissionLevel
from app.services.token_budget_service import estimate_tokens, short_text


VIEWPORT_TEXT_BUFFER_LINES = 24


async def persist_viewport(
    *,
    db: AsyncSession,
    session_id: str,
    file_id: str,
    file_name: Optional[str],
    file_type: Optional[str],
    page: Optional[int],
    visible_unit: Optional[str],
    visible_start: Optional[int],
    visible_end: Optional[int],
    anchor_block_id: Optional[str],
    pending_diff_event_id: Optional[str],
    scroll_y: Optional[float],
) -> SessionViewport:
    values: Dict[str, Any] = {
        "session_id": session_id,
        "file_id": file_id,
        "file_name": file_name,
        "file_type": file_type,
        "page": page,
        "visible_unit": visible_unit,
        "visible_start": visible_start,
        "visible_end": visible_end,
        "anchor_block_id": anchor_block_id,
        "pending_diff_event_id": pending_diff_event_id,
        "scroll_y": scroll_y,
        "updated_at": datetime.utcnow(),
    }
    update_values = {k: v for k, v in values.items() if k not in {"session_id", "file_id"}}

    stmt = sqlite_insert(SessionViewport).values(**values)
    stmt = stmt.on_conflict_do_update(
        index_elements=[SessionViewport.session_id, SessionViewport.file_id],
        set_=update_values,
    )
    await db.execute(stmt)
    await db.flush()
    row = await db.get(SessionViewport, {"session_id": session_id, "file_id": file_id})
    if not row:
        raise RuntimeError(
            f"Failed to persist viewport for session_id={session_id}, file_id={file_id}"
        )
    return row


async def list_session_viewports(db: AsyncSession, session_id: str) -> List[SessionViewport]:
    result = await db.execute(
        select(SessionViewport)
        .where(SessionViewport.session_id == session_id)
        .order_by(SessionViewport.updated_at.desc())
    )
    return list(result.scalars().all())


async def get_latest_viewport(
    db: AsyncSession,
    *,
    session_id: str,
    file_id: Optional[str] = None,
) -> Optional[SessionViewport]:
    query = select(SessionViewport).where(SessionViewport.session_id == session_id)
    if file_id:
        query = query.where(SessionViewport.file_id == file_id)
    query = query.order_by(SessionViewport.updated_at.desc()).limit(1)
    result = await db.execute(query)
    return result.scalar_one_or_none()


async def normalize_active_viewport(
    *,
    db: AsyncSession,
    session_id: str,
    active_file_id: Optional[str],
    active_page: Optional[int],
    active_visible_unit: Optional[str],
    active_visible_start: Optional[int],
    active_visible_end: Optional[int],
    active_anchor_block_id: Optional[str],
) -> Optional[Dict[str, Any]]:
    row = await get_latest_viewport(db, session_id=session_id, file_id=active_file_id)
    if not row and not active_file_id:
        row = await get_latest_viewport(db, session_id=session_id)

    file_id = active_file_id or (row.file_id if row else None)
    if not file_id:
        return None

    visible_unit = active_visible_unit or (row.visible_unit if row else None)
    visible_start = active_visible_start if active_visible_start is not None else (row.visible_start if row else None)
    visible_end = active_visible_end if active_visible_end is not None else (row.visible_end if row else None)
    anchor_block_id = active_anchor_block_id or (row.anchor_block_id if row else None)

    page = active_page if active_page is not None else (row.page if row else None)
    file_name = row.file_name if row else None
    file_type = row.file_type if row else None
    pending_diff_event_id = row.pending_diff_event_id if row else None
    scroll_y = row.scroll_y if row else None

    if not file_name or not file_type:
        file_result = await db.execute(select(FileModel).where(FileModel.id == file_id))
        file_row = file_result.scalar_one_or_none()
        if file_row:
            file_name = file_row.name
            raw_type = file_row.file_type.value if hasattr(file_row.file_type, "value") else file_row.file_type
            file_type = str(raw_type)

    return {
        "file_id": file_id,
        "file_name": file_name,
        "file_type": file_type,
        "page": page,
        "visible_unit": visible_unit,
        "visible_start": visible_start,
        "visible_end": visible_end,
        "anchor_block_id": anchor_block_id,
        "pending_diff_event_id": pending_diff_event_id,
        "scroll_y": scroll_y,
    }


async def _read_persisted_text(file: FileModel) -> str:
    path = Path(file.path)
    if not path.exists():
        return ""
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return path.read_text(encoding="utf-8", errors="ignore")


async def _read_effective_text(file: FileModel, db: AsyncSession) -> tuple[str, str]:
    persisted = await _read_persisted_text(file)
    _, effective, pending_events = await get_effective_diff_base(db, file.id, persisted)
    if pending_events:
        latest = pending_events[-1]
        return effective, f"pending_diff:{latest.id}"
    return effective, "persisted"


async def build_viewport_memory(
    *,
    db: AsyncSession,
    session_id: str,
    context_permissions: Dict[str, PermissionLevel],
    active_file_id: Optional[str],
    active_page: Optional[int],
    active_visible_unit: Optional[str] = None,
    active_visible_start: Optional[int] = None,
    active_visible_end: Optional[int] = None,
    active_anchor_block_id: Optional[str] = None,
    require_effective_note_view: bool = True,
) -> Dict[str, Any]:
    viewport = await normalize_active_viewport(
        db=db,
        session_id=session_id,
        active_file_id=active_file_id,
        active_page=active_page,
        active_visible_unit=active_visible_unit,
        active_visible_start=active_visible_start,
        active_visible_end=active_visible_end,
        active_anchor_block_id=active_anchor_block_id,
    )
    if not viewport:
        return {"viewport": None, "memory_text": None, "memory_summary": None, "refs": [], "source_revision": None}

    file_id = str(viewport.get("file_id") or "")
    if not file_id:
        return {"viewport": viewport, "memory_text": None, "memory_summary": None, "refs": [], "source_revision": None}

    permission = context_permissions.get(file_id, PermissionLevel.READ)
    if permission == PermissionLevel.NONE:
        return {"viewport": viewport, "memory_text": None, "memory_summary": None, "refs": [], "source_revision": None}

    file_result = await db.execute(select(FileModel).where(FileModel.id == file_id))
    file_row = file_result.scalar_one_or_none()
    if not file_row:
        return {"viewport": viewport, "memory_text": None, "memory_summary": None, "refs": [], "source_revision": None}

    raw_type = file_row.file_type.value if hasattr(file_row.file_type, "value") else file_row.file_type
    file_type = str(raw_type)
    viewport["file_type"] = file_type
    viewport["file_name"] = file_row.name

    memory_text: Optional[str] = None
    source_revision = "persisted"
    refs: List[Dict[str, Any]] = []

    if file_type == "pdf":
        page = int(viewport.get("page") or 1)
        result = await db.execute(
            select(DocumentChunk)
            .where(DocumentChunk.file_id == file_id, DocumentChunk.page == page)
            .order_by(DocumentChunk.chunk_index)
        )
        chunks = list(result.scalars().all())
        combined = "\n".join(chunk.content for chunk in chunks if chunk.content)
        memory_text = short_text(combined, settings.VIEWPORT_EXCERPT_MAX_CHARS) if combined else None
        if memory_text:
            refs.append({"file_id": file_id, "page": page, "source_revision": source_revision})
    elif file_type in {"md", "txt", "code"}:
        if require_effective_note_view and file_type == "md":
            text, source_revision = await _read_effective_text(file_row, db)
        else:
            text = await _read_persisted_text(file_row)
            if file_type == "md":
                latest_event = await get_latest_pending_diff_event(db, file_id)
                if latest_event:
                    source_revision = f"pending_diff:{latest_event.id}"

        lines = text.splitlines()
        visible_unit = str(viewport.get("visible_unit") or "").strip().lower()
        start = viewport.get("visible_start")
        end = viewport.get("visible_end")
        if visible_unit == "line" and isinstance(start, int) and isinstance(end, int):
            start_idx = max(0, start - VIEWPORT_TEXT_BUFFER_LINES)
            end_idx = min(len(lines), end + VIEWPORT_TEXT_BUFFER_LINES)
        else:
            start_idx = 0
            end_idx = min(len(lines), 80)
        excerpt = "\n".join(lines[start_idx:end_idx]).strip()
        memory_text = short_text(excerpt, settings.VIEWPORT_EXCERPT_MAX_CHARS) if excerpt else None
        refs.append(
            {
                "file_id": file_id,
                "visible_unit": visible_unit or "pixel",
                "visible_start": start,
                "visible_end": end,
                "source_revision": source_revision,
            }
        )
    else:
        page = int(viewport.get("page") or 1)
        result = await db.execute(
            select(DocumentChunk)
            .where(DocumentChunk.file_id == file_id)
            .order_by(DocumentChunk.page, DocumentChunk.chunk_index)
            .limit(6)
        )
        chunks = list(result.scalars().all())
        combined = "\n".join(chunk.content for chunk in chunks if chunk.content)
        memory_text = short_text(combined, settings.VIEWPORT_EXCERPT_MAX_CHARS) if combined else None
        if memory_text:
            refs.append({"file_id": file_id, "page": page, "source_revision": source_revision})

    summary = None
    if memory_text:
        summary = (
            f"Active viewport: {viewport.get('file_name') or file_id}"
            f" [{file_type}]"
            + (f" p.{viewport.get('page')}" if viewport.get('page') is not None else "")
            + (f" lines {viewport.get('visible_start')}-{viewport.get('visible_end')}" if viewport.get('visible_unit') == 'line' else "")
            + f"\nSource revision: {source_revision}\n{memory_text}"
        )

    return {
        "viewport": viewport,
        "memory_text": memory_text,
        "memory_summary": summary,
        "refs": refs,
        "source_revision": source_revision,
        "used_tokens": estimate_tokens(memory_text or ""),
    }
