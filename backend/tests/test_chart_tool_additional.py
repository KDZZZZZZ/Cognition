from __future__ import annotations

import uuid
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select

from app.models import DiffEvent, DocumentAsset, DocumentPageAsset, DocumentSegment, File as FileModel, FileType
from app.services.multiformat_document_service import RetrievalHit
from app.services.tools.base import PermissionLevel, ToolContext, ToolValidationError
from app.services.tools.handlers.chart_tools import (
    AddFileChartsToNoteTool,
    _build_chart_crop_box,
    _insert_markdown_block,
)


def test_insert_markdown_block_modes():
    block = "## Charts\n![x](img)"
    assert _insert_markdown_block(content="", block=block, insert_mode="append", target_heading="").startswith("## Charts")
    assert "## Charts" in _insert_markdown_block(
        content="# A\nBody\n",
        block=block,
        insert_mode="after_heading",
        target_heading="A",
    )
    # Missing heading falls back to append mode.
    appended = _insert_markdown_block(
        content="# B\nBody\n",
        block=block,
        insert_mode="after_heading",
        target_heading="A",
    )
    assert appended.rstrip().endswith("![x](img)")


def test_chart_tool_validate_arguments():
    tool = AddFileChartsToNoteTool()
    with pytest.raises(ToolValidationError):
        tool.validate_arguments({"file_id": "f1", "source_file_id": "f2", "max_charts": 99})
    with pytest.raises(ToolValidationError):
        tool.validate_arguments({"file_id": "f1", "source_file_id": "f2", "insert_mode": "middle"})
    with pytest.raises(ToolValidationError):
        tool.validate_arguments({"file_id": "f1"})


def test_build_chart_crop_box_keeps_figure_context_compact():
    segment = DocumentSegment(
        id="seg-box",
        file_id="src-1",
        source_type="pdf",
        page=2,
        section="p.2",
        chunk_index=0,
        bbox=(107.53, 78.95, 505.74, 528.83),
        text="Figure 1 benchmark context",
        segment_type="figure_context",
        confidence=0.9,
        source="local",
        meta={"visual_anchor": True},
    )

    crop_box = _build_chart_crop_box(localized_segment=segment, pdf_width=612.0, pdf_height=792.0)

    assert crop_box is not None
    left, top, right, bottom = crop_box
    assert top > 0
    assert bottom < 320
    assert right - left < 470
    assert bottom - top < 250


@pytest.mark.asyncio
async def test_chart_tool_pdf_asset_flow(db_session, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    note_path = tmp_path / "note.md"
    note_path.write_text("# Report\n\nExisting text.\n", encoding="utf-8")
    source_path = tmp_path / "source.pdf"
    source_path.write_bytes(b"%PDF")

    note_file = FileModel(
        id="note-1",
        name="note.md",
        file_type=FileType.MD,
        path=str(note_path),
        size=20,
    )
    source_file = FileModel(
        id="src-1",
        name="source.pdf",
        file_type=FileType.PDF,
        path=str(source_path),
        size=20,
    )
    db_session.add_all([note_file, source_file])
    db_session.add_all(
        [
            DocumentPageAsset(
                id="asset-1",
                file_id="src-1",
                page=3,
                image_path="/tmp/p3.jpg",
                image_url="/uploads/p3.jpg",
                text_anchor="chart 3",
            ),
            DocumentPageAsset(
                id="asset-2",
                file_id="src-1",
                page=5,
                image_path="/tmp/p5.jpg",
                image_url="/uploads/p5.jpg",
                text_anchor="chart 5",
            ),
            DocumentSegment(
                id="seg-1",
                file_id="src-1",
                source_type="pdf",
                page=5,
                section="p.5",
                chunk_index=0,
                bbox=(60, 80, 420, 380),
                text="Chart 5 benchmark results",
                segment_type="figure_context",
                confidence=0.9,
                source="local",
                meta={"visual_anchor": True},
            ),
        ]
    )
    await db_session.commit()

    monkeypatch.setattr(
        "app.services.tools.handlers.chart_tools.reader_orchestrator.locate_relevant_segments",
        AsyncMock(
            return_value={
                "hits": [
                    RetrievalHit(
                        segment_id="seg-1",
                        file_id="src-1",
                        page=5,
                        section="A",
                        source_type="pdf",
                        score=3.0,
                        source_mode="fusion",
                        reason=None,
                        text="chart page 5",
                    )
                ]
            }
        ),
    )
    monkeypatch.setattr(
        "app.services.tools.handlers.chart_tools._get_or_create_chart_crop_asset",
        AsyncMock(
            return_value=DocumentAsset(
                id="crop-asset-1",
                file_id="src-1",
                page_or_section="page:5:segment:seg-1",
                asset_type="chart_crop",
                path=str(tmp_path / "crop-1.jpg"),
                url="/uploads/chart-crops/src-1/page-0005-seg-1.jpg",
                meta={"page": 5, "segment_id": "seg-1", "segment_type": "figure_context", "anchor": "Chart 5 benchmark results"},
            )
        ),
    )

    tool = AddFileChartsToNoteTool()
    context = ToolContext(
        session_id="s1",
        db=db_session,
        permissions={
            "note-1": PermissionLevel.WRITE,
            "src-1": PermissionLevel.READ,
        },
    )
    result = await tool.execute(
        {
            "file_id": "note-1",
            "source_file_id": "src-1",
            "max_charts": 2,
            "insert_mode": "after_heading",
            "target_heading": "Report",
        },
        context,
    )

    assert result.success is True
    assert result.data["used_asset_count"] >= 1
    assert result.data["fallback_used"] is False

    diff_result = await db_session.execute(select(DiffEvent).where(DiffEvent.file_id == "note-1"))
    diff = diff_result.scalar_one_or_none()
    assert diff is not None
    assert "![Chart p.5](/uploads/chart-crops/src-1/page-0005-seg-1.jpg)" in diff.new_content


@pytest.mark.asyncio
async def test_chart_tool_uses_localized_crop_when_visual_ref_matches_page_anchor(
    db_session,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    note_path = tmp_path / "note.md"
    note_path.write_text("# Report\n", encoding="utf-8")
    source_path = tmp_path / "source.pdf"
    source_path.write_bytes(b"%PDF")

    note_file = FileModel(
        id="note-crop",
        name="note.md",
        file_type=FileType.MD,
        path=str(note_path),
        size=10,
    )
    source_file = FileModel(
        id="src-crop",
        name="source.pdf",
        file_type=FileType.PDF,
        path=str(source_path),
        size=10,
    )
    db_session.add_all([note_file, source_file])
    db_session.add(
        DocumentPageAsset(
            id="asset-crop",
            file_id="src-crop",
            page=2,
            image_path="/tmp/p2.jpg",
            image_url="/uploads/p2.jpg",
            text_anchor="Figure1: Zero/Few-Shot Benchmarks.",
        )
    )
    db_session.add(
        DocumentSegment(
            id="seg-crop",
            file_id="src-crop",
            source_type="pdf",
            page=2,
            section="p.2",
            chunk_index=0,
            bbox=(100, 80, 500, 520),
            text="ARC-C GSM8K MMLU HumanEval Figure 1 zero-shot few-shot benchmarks",
            segment_type="figure_context",
            confidence=0.9,
            source="local",
            meta={"visual_anchor": True},
        )
    )
    await db_session.commit()

    monkeypatch.setattr(
        "app.services.tools.handlers.chart_tools._get_or_create_chart_crop_asset",
        AsyncMock(
            return_value=DocumentAsset(
                id="crop-asset-2",
                file_id="src-crop",
                page_or_section="page:2:segment:seg-crop",
                asset_type="chart_crop",
                path=str(tmp_path / "crop-2.jpg"),
                url="/uploads/chart-crops/src-crop/page-0002-seg-crop.jpg",
                meta={"page": 2, "segment_id": "seg-crop", "segment_type": "figure_context", "anchor": "Figure 1 benchmark context"},
            )
        ),
    )

    tool = AddFileChartsToNoteTool()
    context = ToolContext(
        session_id="s-crop",
        db=db_session,
        permissions={
            "note-crop": PermissionLevel.WRITE,
            "src-crop": PermissionLevel.READ,
        },
    )
    result = await tool.execute(
        {
            "file_id": "note-crop",
            "source_file_id": "src-crop",
            "query": "请把 Figure 1 贴到笔记里",
            "max_charts": 1,
        },
        context,
    )

    assert result.success is True
    diff = (
        await db_session.execute(select(DiffEvent).where(DiffEvent.file_id == "note-crop"))
    ).scalar_one()
    assert "![Chart p.2](/uploads/chart-crops/src-crop/page-0002-seg-crop.jpg)" in diff.new_content


@pytest.mark.asyncio
async def test_chart_tool_fails_when_localized_crop_cannot_be_produced(
    db_session,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    note_path = tmp_path / "note.md"
    note_path.write_text("# Report\n", encoding="utf-8")
    source_path = tmp_path / "source.pdf"
    source_path.write_bytes(b"%PDF")

    note_file = FileModel(
        id="note-no-crop",
        name="note.md",
        file_type=FileType.MD,
        path=str(note_path),
        size=10,
    )
    source_file = FileModel(
        id="src-no-crop",
        name="source.pdf",
        file_type=FileType.PDF,
        path=str(source_path),
        size=10,
    )
    db_session.add_all([note_file, source_file])
    db_session.add(
        DocumentPageAsset(
            id="asset-no-crop",
            file_id="src-no-crop",
            page=2,
            image_path="/tmp/p2.jpg",
            image_url="/uploads/p2.jpg",
            text_anchor="Figure1: Zero/Few-Shot Benchmarks.",
        )
    )
    db_session.add(
        DocumentSegment(
            id="seg-no-crop",
            file_id="src-no-crop",
            source_type="pdf",
            page=2,
            section="p.2",
            chunk_index=0,
            bbox=(100, 80, 500, 520),
            text="Figure 1 benchmark context",
            segment_type="figure_context",
            confidence=0.9,
            source="local",
            meta={"visual_anchor": True},
        )
    )
    await db_session.commit()

    monkeypatch.setattr(
        "app.services.tools.handlers.chart_tools._get_or_create_chart_crop_asset",
        AsyncMock(return_value=None),
    )

    tool = AddFileChartsToNoteTool()
    context = ToolContext(
        session_id="s-no-crop",
        db=db_session,
        permissions={
            "note-no-crop": PermissionLevel.WRITE,
            "src-no-crop": PermissionLevel.READ,
        },
    )
    result = await tool.execute(
        {
            "file_id": "note-no-crop",
            "source_file_id": "src-no-crop",
            "query": "请把 Figure 1 贴到笔记里",
            "max_charts": 1,
        },
        context,
    )

    assert result.success is False
    assert result.error_code == "VISUAL_NOT_LOCALIZED"


@pytest.mark.asyncio
async def test_chart_tool_source_permission_denied(db_session, tmp_path: Path):
    note_path = tmp_path / "note.md"
    note_path.write_text("hello", encoding="utf-8")
    source_path = tmp_path / "source.txt"
    source_path.write_text("source", encoding="utf-8")

    note_file = FileModel(id="n1", name="note.md", file_type=FileType.MD, path=str(note_path), size=5)
    src_file = FileModel(id="s1", name="source.txt", file_type=FileType.TXT, path=str(source_path), size=6)
    db_session.add_all([note_file, src_file])
    await db_session.commit()

    tool = AddFileChartsToNoteTool()
    context = ToolContext(
        session_id=str(uuid.uuid4()),
        db=db_session,
        permissions={"n1": PermissionLevel.WRITE, "s1": PermissionLevel.NONE},
    )
    result = await tool.execute({"file_id": "n1", "source_file_id": "s1"}, context)
    assert result.success is False
    assert result.error_code == "PERMISSION_DENIED"


@pytest.mark.asyncio
async def test_chart_tool_inserts_exact_visual_handle_without_relocalizing(
    db_session,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    note_path = tmp_path / "note.md"
    note_path.write_text("# Report\n", encoding="utf-8")
    source_path = tmp_path / "source.pdf"
    source_path.write_bytes(b"%PDF")

    note_file = FileModel(
        id="note-handle",
        name="note.md",
        file_type=FileType.MD,
        path=str(note_path),
        size=10,
    )
    source_file = FileModel(
        id="src-handle",
        name="source.pdf",
        file_type=FileType.PDF,
        path=str(source_path),
        size=10,
    )
    crop_asset = DocumentAsset(
        id="asset-handle",
        file_id="src-handle",
        page_or_section="page:2:segment:seg-handle",
        asset_type="chart_crop",
        path=str(tmp_path / "crop.jpg"),
        url="/uploads/chart-crops/src-handle/page-0002-seg-handle.jpg",
        meta={
            "page": 2,
            "segment_id": "seg-handle",
            "segment_type": "figure_context",
            "anchor": "Figure 1 benchmark comparison",
            "source": "chart_crop",
        },
    )
    db_session.add_all([note_file, source_file, crop_asset])
    await db_session.commit()

    monkeypatch.setattr(
        "app.services.tools.handlers.chart_tools.reader_orchestrator.locate_relevant_segments",
        AsyncMock(side_effect=AssertionError("should not re-localize when visual_handle is present")),
    )

    tool = AddFileChartsToNoteTool()
    context = ToolContext(
        session_id="s-handle",
        db=db_session,
        permissions={
            "note-handle": PermissionLevel.WRITE,
            "src-handle": PermissionLevel.READ,
        },
    )
    result = await tool.execute(
        {
            "file_id": "note-handle",
            "visual_handle": "visual_asset:asset-handle",
        },
        context,
    )

    assert result.success is True
    assert result.data["inserted_visual_handles"] == ["visual_asset:asset-handle"]
    diff = (
        await db_session.execute(select(DiffEvent).where(DiffEvent.file_id == "note-handle"))
    ).scalar_one()
    assert "![Chart p.2](/uploads/chart-crops/src-handle/page-0002-seg-handle.jpg)" in diff.new_content
    assert "Figure 1 benchmark comparison" in diff.new_content
