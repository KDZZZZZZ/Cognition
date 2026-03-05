from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.api import viewport as viewport_api
from app.models import File, FileType, Session
from app.schemas import ViewportUpdateRequest
from app.services.viewport_memory_service import get_latest_viewport


@pytest.mark.asyncio
async def test_viewport_update_get_and_clear_round_trip(db_session):
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
            visible_unit="page",
            visible_start=2,
            visible_end=2,
            anchor_block_id="page-anchor",
        ),
        db=db_session,
    )
    assert updated.success is True
    assert updated.data["viewport"]["page"] == 2
    assert updated.data["viewport"]["visible_unit"] == "page"
    assert updated.data["viewport"]["visible_start"] == 2
    assert updated.data["viewport"]["anchor_block_id"] == "page-anchor"

    single = await viewport_api.get_viewport("s1", file_id="f1", db=db_session)
    assert single.data["viewport"]["file_id"] == "f1"
    assert single.data["viewport"]["visible_range"] == [2, 2]

    all_viewports = await viewport_api.get_viewport("s1", file_id=None, db=db_session)
    assert all_viewports.data["active_count"] == 1
    assert all_viewports.data["viewports"][0]["file_id"] == "f1"

    latest_row = await get_latest_viewport(db_session, session_id="s1")
    assert latest_row is not None
    assert latest_row.file_id == "f1"
    assert latest_row.visible_unit == "page"

    cleared_one = await viewport_api.clear_viewport("s1", file_id="f1", db=db_session)
    assert "Viewport cleared" in cleared_one.data["message"]

    cleared_all = await viewport_api.clear_viewport("s1", file_id=None, db=db_session)
    assert "All viewport data cleared" in cleared_all.data["message"]


@pytest.mark.asyncio
async def test_viewport_error_paths(db_session):
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
        ViewportUpdateRequest(
            session_id="s-ok",
            file_id="f-ok",
            page=1,
            visible_range_start=0,
            visible_range_end=1,
            visible_unit="line",
            visible_start=1,
            visible_end=2,
        ),
        db=db_session,
    )

    with pytest.raises(HTTPException):
        await viewport_api.get_viewport("s-ok", file_id="missing-file", db=db_session)

    no_data = await viewport_api.clear_viewport("missing", file_id=None, db=db_session)
    assert "All viewport data cleared" in no_data.data["message"]
