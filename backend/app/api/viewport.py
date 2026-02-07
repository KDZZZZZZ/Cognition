"""
Viewport Tracking API

Tracks user viewing position across documents to enable AI context awareness.
This implements the "Gaze/Viewport Tracking" feature from the PRD.
"""

from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import Optional
from datetime import datetime

from app.database import get_db
from app.models import Session, File as FileModel
from app.schemas import APIResponse
from app.services.tools.middleware import permission_middleware

router = APIRouter(prefix="/viewport", tags=["viewport"])


# In-memory store for viewport state (can be moved to Redis for production)
# Structure: {session_id: {file_id: {...viewport_data...}}}
_viewport_store: dict = {}


@router.post("/update", response_model=APIResponse)
async def update_viewport(
    session_id: str,
    file_id: str,
    page: int = 1,
    scroll_y: float = 0,
    visible_range_start: int = 0,
    visible_range_end: int = 0,
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
    result = await db.execute(select(Session).where(Session.id == session_id))
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Validate file exists
    result = await db.execute(select(FileModel).where(FileModel.id == file_id))
    file = result.scalar_one_or_none()

    if not file:
        raise HTTPException(status_code=404, detail="File not found")

    # Store viewport state
    if session_id not in _viewport_store:
        _viewport_store[session_id] = {}

    _viewport_store[session_id][file_id] = {
        "file_id": file_id,
        "file_name": file.name,
        "file_type": file.file_type.value,
        "page": page,
        "scroll_y": scroll_y,
        "visible_range": [visible_range_start, visible_range_end],
        "timestamp": datetime.utcnow().isoformat()
    }

    # Update session's active viewport context
    # This will be used when building LLM context
    session.permissions = session.permissions or {}
    session.permissions["_active_viewport"] = {
        "file_id": file_id,
        "page": page,
        "visible_range": [visible_range_start, visible_range_end]
    }

    return APIResponse(
        success=True,
        data={
            "session_id": session_id,
            "file_id": file_id,
            "viewport": _viewport_store[session_id][file_id]
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

    session_viewports = _viewport_store.get(session_id, {})

    if file_id:
        viewport = session_viewports.get(file_id)
        if not viewport:
            raise HTTPException(status_code=404, detail="No viewport data for this file")
        return APIResponse(
            success=True,
            data={"viewport": viewport}
        )

    # Return all viewports for session
    return APIResponse(
        success=True,
        data={
            "session_id": session_id,
            "viewports": list(session_viewports.values()),
            "active_count": len(session_viewports)
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
    if session_id not in _viewport_store:
        return APIResponse(
            success=True,
            data={"message": "No viewport data to clear"}
        )

    if file_id:
        if file_id in _viewport_store[session_id]:
            del _viewport_store[session_id][file_id]
        return APIResponse(
            success=True,
            data={"message": f"Viewport cleared for file {file_id}"}
        )
    else:
        del _viewport_store[session_id]
        return APIResponse(
            success=True,
            data={"message": "All viewport data cleared for session"}
        )


def get_viewport_context(session_id: str, file_id: Optional[str] = None) -> Optional[dict]:
    """
    Get viewport context for LLM injection.

    This function is called by the chat service to include
    viewport context in the system prompt.

    Args:
        session_id: The chat session ID
        file_id: Optional file to get context for

    Returns:
        Viewport context dict or None if not found
    """
    session_viewports = _viewport_store.get(session_id, {})

    if file_id:
        return session_viewports.get(file_id)

    # Return most recent viewport if no file specified
    if session_viewports:
        # Sort by timestamp and return most recent
        viewports = sorted(
            session_viewports.values(),
            key=lambda x: x.get("timestamp", ""),
            reverse=True
        )
        return viewports[0] if viewports else None

    return None
