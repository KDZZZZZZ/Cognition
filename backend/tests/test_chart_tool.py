import uuid
from pathlib import Path

import pytest
from sqlalchemy import select

from app.database import async_session_maker
from app.models import DiffEvent, File as FileModel, FileType, Session
from app.services.multiformat_document_service import reader_orchestrator
from app.services.tools.base import PermissionLevel, ToolContext
from app.services.tools.handlers.chart_tools import AddFileChartsToNoteTool


@pytest.mark.asyncio
async def test_add_file_charts_to_note_rejects_non_md_target(tmp_path: Path):
    async with async_session_maker() as db:
        target_path = tmp_path / "target.txt"
        target_path.write_text("hello", encoding="utf-8")
        source_path = tmp_path / "source.pdf"
        source_path.write_text("placeholder", encoding="utf-8")

        target_file = FileModel(
            id=str(uuid.uuid4()),
            name="target.txt",
            file_type=FileType.TXT,
            path=str(target_path),
            size=5,
        )
        source_file = FileModel(
            id=str(uuid.uuid4()),
            name="source.pdf",
            file_type=FileType.PDF,
            path=str(source_path),
            size=10,
        )
        session = Session(
            id=f"chart-tool-session-{uuid.uuid4()}",
            name="chart-tool-session-1",
            permissions={
                target_file.id: "write",
                source_file.id: "read",
            },
        )
        db.add_all([target_file, source_file, session])
        await db.commit()

        context = ToolContext(
            session_id=session.id,
            db=db,
            permissions={
                target_file.id: PermissionLevel.WRITE,
                source_file.id: PermissionLevel.READ,
            },
        )
        tool = AddFileChartsToNoteTool()
        result = await tool.execute(
            {
                "file_id": target_file.id,
                "source_file_id": source_file.id,
            },
            context,
        )
        assert result.success is False
        assert result.error_code == "FILE_NOT_WRITABLE"


@pytest.mark.asyncio
async def test_add_file_charts_to_note_creates_pending_diff(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    async def _fake_locate(*args, **kwargs):
        return {"hits": [], "diagnostics": {}}

    monkeypatch.setattr(reader_orchestrator, "locate_relevant_segments", _fake_locate)

    async with async_session_maker() as db:
        target_path = tmp_path / "note.md"
        target_path.write_text("# Note\n", encoding="utf-8")
        source_path = tmp_path / "source.txt"
        source_path.write_text("This is a document that mentions chart and figure.", encoding="utf-8")

        target_file = FileModel(
            id=str(uuid.uuid4()),
            name="note.md",
            file_type=FileType.MD,
            path=str(target_path),
            size=7,
        )
        source_file = FileModel(
            id=str(uuid.uuid4()),
            name="source.txt",
            file_type=FileType.TXT,
            path=str(source_path),
            size=48,
        )
        session = Session(
            id=f"chart-tool-session-{uuid.uuid4()}",
            name="chart-tool-session-2",
            permissions={
                target_file.id: "write",
                source_file.id: "read",
            },
        )
        db.add_all([target_file, source_file, session])
        await db.commit()

        context = ToolContext(
            session_id=session.id,
            db=db,
            permissions={
                target_file.id: PermissionLevel.WRITE,
                source_file.id: PermissionLevel.READ,
            },
        )
        tool = AddFileChartsToNoteTool()
        result = await tool.execute(
            {
                "file_id": target_file.id,
                "source_file_id": source_file.id,
                "max_charts": 2,
                "insert_mode": "append",
            },
            context,
        )
        assert result.success is True
        data = result.data or {}
        assert data.get("event_id")

        diff_result = await db.execute(
            select(DiffEvent).where(DiffEvent.file_id == target_file.id)
        )
        diff = diff_result.scalar_one_or_none()
        assert diff is not None
        assert "Chart clues from" in diff.new_content
