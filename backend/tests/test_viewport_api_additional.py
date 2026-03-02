from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.api import viewport as viewport_api
from app.models import File, FileType, Session
from app.schemas import ViewportUpdateRequest


@pytest.mark.asyncio
async def test_viewport_update_get_clear_and_context(db_session):
    viewport_api._viewport_store.clear()

    db_session.add(Session(id="s1", name="Session 1", permissions={}))
    db_session.add(
        File(
            id="f1",
            name="doc.pdf",
            file_type=FileType.PDF,
            path="/tmp/doc.pdf",
            size=100,
            page_count=2,
            meta={},
        )
    )
    await db_session.commit()

    updated = await viewport_api.update_viewport(
        ViewportUpdateRequest(
            session_id="s1",
            file_id="f1",
            page=2,
            scroll_y=120.5,
            visible_range_start=10,
            visible_range_end=50,
        ),
        db=db_session,
    )
    assert updated.success is True
    assert updated.data["viewport"]["page"] == 2

    single = await viewport_api.get_viewport("s1", file_id="f1", db=db_session)
    assert single.data["viewport"]["file_id"] == "f1"

    all_viewports = await viewport_api.get_viewport("s1", file_id=None, db=db_session)
    assert all_viewports.data["active_count"] == 1

    context = viewport_api.get_viewport_context("s1", "f1")
    assert context["page"] == 2
    context_latest = viewport_api.get_viewport_context("s1")
    assert context_latest["file_id"] == "f1"

    cleared_one = await viewport_api.clear_viewport("s1", file_id="f1", db=db_session)
    assert "Viewport cleared" in cleared_one.data["message"]
    cleared_all = await viewport_api.clear_viewport("s1", file_id=None, db=db_session)
    assert "All viewport data cleared" in cleared_all.data["message"]


@pytest.mark.asyncio
async def test_viewport_error_paths(db_session):
    viewport_api._viewport_store.clear()

    with pytest.raises(HTTPException):
        await viewport_api.update_viewport(
            ViewportUpdateRequest(session_id="missing", file_id="f1"),
            db=db_session,
        )

    db_session.add(Session(id="s-ok", name="S", permissions={}))
    await db_session.commit()

    with pytest.raises(HTTPException):
        await viewport_api.update_viewport(
            ViewportUpdateRequest(session_id="s-ok", file_id="missing-file"),
            db=db_session,
        )

    with pytest.raises(HTTPException):
        await viewport_api.get_viewport("missing", file_id=None, db=db_session)

    db_session.add(
        File(
            id="f-ok",
            name="ok.md",
            file_type=FileType.MD,
            path="/tmp/ok.md",
            size=1,
            page_count=1,
            meta={},
        )
    )
    await db_session.commit()

    await viewport_api.update_viewport(
        ViewportUpdateRequest(session_id="s-ok", file_id="f-ok", page=1, visible_range_start=0, visible_range_end=1),
        db=db_session,
    )
    with pytest.raises(HTTPException):
        await viewport_api.get_viewport("s-ok", file_id="missing-file", db=db_session)

    no_data = await viewport_api.clear_viewport("missing", file_id=None, db=db_session)
    assert "No viewport data" in no_data.data["message"]
