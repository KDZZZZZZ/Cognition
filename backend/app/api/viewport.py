"""
Viewport Tracking API

Tracks user viewing position across documents to enable AI context awareness.
This implements the "Gaze/Viewport Tracking" feature from the PRD.
"""

import asyncio

from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy import select
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional

from app.database import get_db
from app.models import Session, File as FileModel
from app.schemas import APIResponse, ViewportUpdateRequest
from app.services.viewport_memory_service import get_latest_viewport, list_session_viewports, persist_viewport

router = APIRouter(prefix="/viewport", tags=["viewport"])
VIEWPORT_WRITE_MAX_RETRIES = 4


@router.post("/update", response_model=APIResponse)
async def update_viewport(
    payload: ViewportUpdateRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    Update the user's current viewport position.

    This endpoint is called by the frontend when user scrolls or changes view.
    The viewport state is used to inject context into AI conversations.

    Args:
        session_id: The chat session ID
        file_id: The file being viewed
        page: Current page number (for PDFs)
        scroll_y: Vertical scroll position in pixels
        visible_range_start: Start line/paragraph index of visible content
        visible_range_end: End line/paragraph index of visible content
    """
    # Validate session exists
    session_id = payload.session_id
    file_id = payload.file_id
    page = payload.page
    scroll_y = payload.scroll_y
    visible_range_start = payload.visible_range_start
    visible_range_end = payload.visible_range_end

    result = await db.execute(select(Session).where(Session.id == session_id))
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Validate file exists
    result = await db.execute(select(FileModel).where(FileModel.id == file_id))
    file = result.scalar_one_or_none()

    if not file:
        raise HTTPException(status_code=404, detail="File not found")

    visible_unit = payload.visible_unit or "pixel"
    visible_start = payload.visible_start if payload.visible_start is not None else visible_range_start
    visible_end = payload.visible_end if payload.visible_end is not None else visible_range_end

    row = None
    for attempt in range(VIEWPORT_WRITE_MAX_RETRIES):
        try:
            row = await persist_viewport(
                db=db,
                session_id=session_id,
                file_id=file_id,
                file_name=file.name,
                file_type=file.file_type.value,
                page=page,
                visible_unit=visible_unit,
                visible_start=visible_start,
                visible_end=visible_end,
                anchor_block_id=payload.anchor_block_id,
                pending_diff_event_id=payload.pending_diff_event_id,
                scroll_y=scroll_y,
            )
            await db.commit()
            break
        except OperationalError as exc:
            await db.rollback()
            err_text = str(getattr(exc, "orig", exc) or "").lower()
            is_locked = "database is locked" in err_text or "locked" in err_text
            if is_locked and attempt < VIEWPORT_WRITE_MAX_RETRIES - 1:
                await asyncio.sleep(0.05 * (attempt + 1))
                continue
            if is_locked:
                raise HTTPException(status_code=503, detail="Viewport storage is busy, please retry.")
            raise

    if row is None:
        raise HTTPException(status_code=503, detail="Viewport update failed after retries.")

    return APIResponse(
        success=True,
        data={
            "session_id": session_id,
            "file_id": file_id,
            "viewport": {
                "file_id": row.file_id,
                "file_name": row.file_name,
                "file_type": row.file_type,
                "page": row.page,
                "scroll_y": row.scroll_y,
                "visible_unit": row.visible_unit,
                "visible_start": row.visible_start,
                "visible_end": row.visible_end,
                "visible_range": [row.visible_start or 0, row.visible_end or 0],
                "anchor_block_id": row.anchor_block_id,
                "pending_diff_event_id": row.pending_diff_event_id,
                "timestamp": row.updated_at.isoformat() if row.updated_at else None,
            }
        }
    )


@router.get("/{session_id}", response_model=APIResponse)
async def get_viewport(
    session_id: str,
    file_id: Optional[str] = None,
    db: AsyncSession = Depends(get_db)
):
    """
    Get the current viewport state for a session.

    Args:
        session_id: The chat session ID
        file_id: Optional specific file to get viewport for
    """
    # Validate session exists
    result = await db.execute(select(Session).where(Session.id == session_id))
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if file_id:
        row = await get_latest_viewport(db, session_id=session_id, file_id=file_id)
        viewport = (
            {
                "file_id": row.file_id,
                "file_name": row.file_name,
                "file_type": row.file_type,
                "page": row.page,
                "scroll_y": row.scroll_y,
                "visible_unit": row.visible_unit,
                "visible_start": row.visible_start,
                "visible_end": row.visible_end,
                "visible_range": [row.visible_start or 0, row.visible_end or 0],
                "anchor_block_id": row.anchor_block_id,
                "pending_diff_event_id": row.pending_diff_event_id,
                "timestamp": row.updated_at.isoformat() if row and row.updated_at else None,
            }
            if row
            else None
        )
        if not viewport:
            raise HTTPException(status_code=404, detail="No viewport data for this file")
        return APIResponse(
            success=True,
            data={"viewport": viewport}
        )

    # Return all viewports for session
    rows = await list_session_viewports(db, session_id)
    viewports = [
        {
            "file_id": row.file_id,
            "file_name": row.file_name,
            "file_type": row.file_type,
            "page": row.page,
            "scroll_y": row.scroll_y,
            "visible_unit": row.visible_unit,
            "visible_start": row.visible_start,
            "visible_end": row.visible_end,
            "visible_range": [row.visible_start or 0, row.visible_end or 0],
            "anchor_block_id": row.anchor_block_id,
            "pending_diff_event_id": row.pending_diff_event_id,
            "timestamp": row.updated_at.isoformat() if row.updated_at else None,
        }
        for row in rows
    ]
    return APIResponse(
        success=True,
        data={
            "session_id": session_id,
            "viewports": viewports,
            "active_count": len(viewports)
        }
    )


@router.delete("/{session_id}", response_model=APIResponse)
async def clear_viewport(
    session_id: str,
    file_id: Optional[str] = None,
    db: AsyncSession = Depends(get_db)
):
    """
    Clear viewport tracking data.

    Args:
        session_id: The chat session ID
        file_id: Optional specific file to clear, or all if not provided
    """
    if file_id:
        row = await get_latest_viewport(db, session_id=session_id, file_id=file_id)
        if row:
            await db.delete(row)
            await db.commit()
        return APIResponse(
            success=True,
            data={"message": f"Viewport cleared for file {file_id}"}
        )
    else:
        rows = await list_session_viewports(db, session_id)
        for row in rows:
            await db.delete(row)
        await db.commit()
        return APIResponse(
            success=True,
            data={"message": "All viewport data cleared for session"}
        )
