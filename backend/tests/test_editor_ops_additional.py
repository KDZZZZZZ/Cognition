import uuid
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select

from app.database import async_session_maker
from app.models import DiffEvent, DiffEventStatus, File, FileType
from app.services.tools.base import PermissionLevel, ToolContext, ToolValidationError
from app.services.tools.handlers import editor_ops
from app.services.tools.handlers.editor_ops import (
    DeleteBlockTool,
    InsertBlockTool,
    UpdateBlockTool,
    UpdateFileTool,
    _build_line_snapshots,
)


@pytest.fixture
async def db():
    async with async_session_maker() as session:
        yield session
        await session.rollback()


def _write_file(tmp_path: Path, name: str, content: str) -> str:
    path = tmp_path / name
    path.write_text(content, encoding="utf-8")
    return str(path)


@pytest.mark.asyncio
async def test_build_line_snapshots():
    snaps = _build_line_snapshots("a\nb", "a\nc\nd")
    assert len(snaps) == 3
    assert snaps[0]["decision"].value == "accepted"
    assert any(item["decision"].value == "pending" for item in snaps)


@pytest.mark.asyncio
async def test_update_file_tool_and_noop(db, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(editor_ops.manager, "broadcast_to_session", AsyncMock())
    file_id = str(uuid.uuid4())
    path = _write_file(tmp_path, "doc.md", "hello")

    db.add(
        File(
            id=file_id,
            name="doc.md",
            file_type=FileType.MD,
            path=path,
            size=5,
            page_count=1,
            meta={},
        )
    )
    await db.commit()

    context = ToolContext(
        session_id="s1",
        db=db,
        permissions={file_id: PermissionLevel.WRITE},
    )

    tool = UpdateFileTool()
    changed = await tool.execute({"file_id": file_id, "content": "updated", "summary": "change"}, context)
    assert changed.success is True
    assert changed.data["status"] == "pending"

    noop = await tool.execute({"file_id": file_id, "content": "hello", "summary": "same"}, context)
    assert noop.success is True
    assert noop.data["status"] == "noop"

    rows = (await db.execute(select(DiffEvent).where(DiffEvent.file_id == file_id))).scalars().all()
    assert len(rows) >= 1


@pytest.mark.asyncio
async def test_block_tools(db, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(editor_ops.manager, "broadcast_to_session", AsyncMock())
    md_id = str(uuid.uuid4())
    pdf_id = str(uuid.uuid4())
    md_path = _write_file(tmp_path, "a.md", "first\n\nsecond")
    pdf_path = _write_file(tmp_path, "a.pdf", "binary")

    db.add(
        File(
            id=md_id,
            name="a.md",
            file_type=FileType.MD,
            path=md_path,
            size=20,
            page_count=1,
            meta={},
        )
    )
    db.add(
        File(
            id=pdf_id,
            name="a.pdf",
            file_type=FileType.PDF,
            path=pdf_path,
            size=10,
            page_count=1,
            meta={},
        )
    )
    await db.commit()

    context = ToolContext(session_id="s1", db=db, permissions={md_id: PermissionLevel.WRITE, pdf_id: PermissionLevel.WRITE})

    update_block = UpdateBlockTool()
    with pytest.raises(ToolValidationError):
        await update_block.execute(
            {"file_id": md_id, "block_index": -1, "content": "x", "summary": "bad"},
            context,
        )
    ok_update = await update_block.execute(
        {"file_id": md_id, "block_index": 1, "content": "changed", "summary": "update"},
        context,
    )
    assert ok_update.success is True

    invalid_range = await update_block.execute(
        {"file_id": md_id, "block_index": 99, "content": "x", "summary": "bad"},
        context,
    )
    assert invalid_range.success is False
    assert invalid_range.error_code == "INVALID_BLOCK_INDEX"

    non_md = await update_block.execute(
        {"file_id": pdf_id, "block_index": 0, "content": "x", "summary": "bad"},
        context,
    )
    assert non_md.success is False
    assert non_md.error_code == "FILE_NOT_WRITABLE"

    insert_block = InsertBlockTool()
    inserted = await insert_block.execute(
        {"file_id": md_id, "after_block_index": 0, "content": "new block", "summary": "insert"},
        context,
    )
    assert inserted.success is True

    bad_insert = await insert_block.execute(
        {"file_id": md_id, "after_block_index": 999, "content": "new block", "summary": "insert"},
        context,
    )
    assert bad_insert.success is False
    assert bad_insert.error_code == "INVALID_BLOCK_INDEX"

    delete_block = DeleteBlockTool()
    with pytest.raises(ToolValidationError):
        await delete_block.execute({"file_id": md_id, "block_index": -1, "summary": "bad"}, context)

    deleted = await delete_block.execute(
        {"file_id": md_id, "block_index": 0, "summary": "delete"},
        context,
    )
    assert deleted.success is True


@pytest.mark.asyncio
async def test_insert_block_supersedes_existing_pending_and_uses_effective_content(
    db,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(editor_ops.manager, "broadcast_to_session", AsyncMock())
    md_id = str(uuid.uuid4())
    md_path = _write_file(tmp_path, "stacked.md", "first\n\nsecond")

    db.add(
        File(
            id=md_id,
            name="stacked.md",
            file_type=FileType.MD,
            path=md_path,
            size=13,
            page_count=1,
            meta={},
        )
    )
    await db.commit()

    context = ToolContext(session_id="s-stacked", db=db, permissions={md_id: PermissionLevel.WRITE})
    tool = InsertBlockTool()

    first = await tool.execute(
        {"file_id": md_id, "after_block_index": 0, "content": "pending one", "summary": "insert one"},
        context,
    )
    assert first.success is True

    second = await tool.execute(
        {"file_id": md_id, "after_block_index": 1, "content": "pending two", "summary": "insert two"},
        context,
    )
    assert second.success is True

    events = (
        await db.execute(select(DiffEvent).where(DiffEvent.file_id == md_id).order_by(DiffEvent.created_at, DiffEvent.id))
    ).scalars().all()
    assert len(events) == 2
    assert events[0].status == DiffEventStatus.RESOLVED
    assert events[1].status == DiffEventStatus.PENDING
    assert events[1].old_content == "first\n\nsecond"
    assert events[1].new_content == "first\n\npending one\n\npending two\n\nsecond"
