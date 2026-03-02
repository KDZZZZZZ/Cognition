from __future__ import annotations

from pathlib import Path
from uuid import uuid4
from unittest.mock import AsyncMock

import pytest

from app.models import DocumentAsset, DocumentPageAsset, DocumentSegment, File, FileType
from app.services.llm_service import llm_service
from app.services.tools.base import PermissionLevel, ToolContext
from app.services.tools.handlers.visual_tools import InspectDocumentVisualTool


@pytest.mark.asyncio
async def test_inspect_document_visual_returns_grounded_answer(db_session, monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    pdf_path = tmp_path / "paper.pdf"
    pdf_path.write_bytes(b"%PDF-1.4")
    page_image = tmp_path / "page-0002.jpg"
    page_image.write_bytes(b"fake-jpeg-bytes")

    file_id = f"pdf-{uuid4()}"
    db_session.add(
        File(
            id=file_id,
            name="paper.pdf",
            file_type=FileType.PDF,
            path=str(pdf_path),
            size=pdf_path.stat().st_size,
            page_count=3,
            meta={},
        )
    )
    db_session.add(
        DocumentPageAsset(
            id=f"asset-{uuid4()}",
            file_id=file_id,
            page=2,
            image_path=str(page_image),
            image_url="/uploads/test/page-0002.jpg",
            text_anchor="Figure 1 compares zero-shot and few-shot benchmark performance.",
        )
    )
    db_session.add(
        DocumentSegment(
            id=f"seg-{uuid4()}",
            file_id=file_id,
            source_type="pdf",
            page=2,
            section="Figure 1",
            chunk_index=0,
            bbox=[10, 10, 100, 120],
            text="Figure 1: Zero/Few-Shot Benchmarks for LLaDA 8B and LLaMA baselines.",
            segment_type="figure_caption",
            confidence=1.0,
            source="local",
            meta={"visual_kind": "figure", "visual_label": "1", "visual_anchor": True},
        )
    )
    await db_session.commit()

    monkeypatch.setattr(llm_service, "supports_vision", lambda model=None: True)
    monkeypatch.setattr(
        llm_service,
        "chat_completion",
        AsyncMock(
            return_value={
                "content": "Figure 1 对比了多项 zero-shot / few-shot benchmark，展示 LLaDA 8B 与 LLaMA 系列在通用、数学、代码任务上的相对表现。",
                "model": "kimi-k2.5",
            }
        ),
    )

    tool = InspectDocumentVisualTool()
    result = await tool.execute(
        {"file_id": file_id, "query": "Figure 1 主要说明了什么？"},
        ToolContext(session_id="sess-1", db=db_session, permissions={file_id: PermissionLevel.READ}),
    )

    assert result.success is True
    assert "zero-shot / few-shot" in (result.data or {}).get("answer", "")
    assert (result.data or {}).get("model") == "kimi-k2.5"
    assert (result.data or {}).get("count") == 1
    assert (result.data or {}).get("inspected")[0]["page"] == 2


@pytest.mark.asyncio
async def test_inspect_document_visual_falls_back_to_page_asset_anchor_for_figure_number(
    db_session,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    pdf_path = tmp_path / "paper.pdf"
    pdf_path.write_bytes(b"%PDF-1.4")
    page_image = tmp_path / "page-0002.jpg"
    page_image.write_bytes(b"fake-jpeg-bytes")

    file_id = f"pdf-{uuid4()}"
    db_session.add(
        File(
            id=file_id,
            name="paper.pdf",
            file_type=FileType.PDF,
            path=str(pdf_path),
            size=pdf_path.stat().st_size,
            page_count=3,
            meta={},
        )
    )
    db_session.add(
        DocumentPageAsset(
            id=f"asset-{uuid4()}",
            file_id=file_id,
            page=2,
            image_path=str(page_image),
            image_url="/uploads/test/page-0002.jpg",
            text_anchor="Figure1: Zero/Few-Shot Benchmarks.",
        )
    )
    await db_session.commit()

    monkeypatch.setattr(llm_service, "supports_vision", lambda model=None: True)
    monkeypatch.setattr(
        llm_service,
        "chat_completion",
        AsyncMock(return_value={"content": "Figure 1 展示了零样本与少样本 benchmark 对比。", "model": "kimi-k2.5"}),
    )

    tool = InspectDocumentVisualTool()
    result = await tool.execute(
        {"file_id": file_id, "query": "Figure 1 主要说明了什么？"},
        ToolContext(session_id="sess-1", db=db_session, permissions={file_id: PermissionLevel.READ}),
    )

    assert result.success is True
    assert (result.data or {}).get("inspected")[0]["page"] == 2
    assert "benchmark" in (result.data or {}).get("answer", "").lower()


@pytest.mark.asyncio
async def test_inspect_document_visual_returns_visual_handle_for_localized_crop(
    db_session,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    pdf_path = tmp_path / "paper.pdf"
    pdf_path.write_bytes(b"%PDF-1.4")
    page_image = tmp_path / "page-0002.jpg"
    page_image.write_bytes(b"fake-jpeg-bytes")

    file_id = f"pdf-{uuid4()}"
    db_session.add(
        File(
            id=file_id,
            name="paper.pdf",
            file_type=FileType.PDF,
            path=str(pdf_path),
            size=pdf_path.stat().st_size,
            page_count=3,
            meta={},
        )
    )
    db_session.add(
        DocumentPageAsset(
            id=f"asset-{uuid4()}",
            file_id=file_id,
            page=2,
            image_path=str(page_image),
            image_url="/uploads/test/page-0002.jpg",
            text_anchor="Figure1: Zero/Few-Shot Benchmarks.",
        )
    )
    db_session.add(
        DocumentSegment(
            id="seg-handle",
            file_id=file_id,
            source_type="pdf",
            page=2,
            section="Figure 1",
            chunk_index=0,
            bbox=[10, 10, 100, 120],
            text="Figure 1: Zero/Few-Shot Benchmarks for LLaDA 8B and LLaMA baselines.",
            segment_type="figure_context",
            confidence=1.0,
            source="local",
            meta={"visual_kind": "figure", "visual_label": "1", "visual_anchor": True},
        )
    )
    await db_session.commit()

    monkeypatch.setattr(llm_service, "supports_vision", lambda model=None: True)
    monkeypatch.setattr(
        llm_service,
        "chat_completion",
        AsyncMock(return_value={"content": "Figure 1 对比了多项 benchmark。", "model": "kimi-k2.5"}),
    )
    monkeypatch.setattr(
        "app.services.tools.handlers.visual_tools._get_or_create_chart_crop_asset",
        AsyncMock(
            return_value=DocumentAsset(
                id="visual-asset-1",
                file_id=file_id,
                page_or_section="page:2:segment:seg-handle",
                asset_type="chart_crop",
                path=str(tmp_path / "crop.jpg"),
                url="/uploads/chart-crops/paper/page-0002-seg-handle.jpg",
                meta={
                    "page": 2,
                    "segment_id": "seg-handle",
                    "segment_type": "figure_context",
                    "anchor": "Figure 1: Zero/Few-Shot Benchmarks",
                    "source": "chart_crop",
                },
            )
        ),
    )

    tool = InspectDocumentVisualTool()
    result = await tool.execute(
        {"file_id": file_id, "query": "Figure 1 主要说明了什么？"},
        ToolContext(session_id="sess-1", db=db_session, permissions={file_id: PermissionLevel.READ}),
    )

    assert result.success is True
    assert (result.data or {}).get("recommended_visual_handle") == "visual_asset:visual-asset-1"
    assert (result.data or {}).get("visual_assets")[0]["image_url"] == "/uploads/chart-crops/paper/page-0002-seg-handle.jpg"


@pytest.mark.asyncio
async def test_inspect_document_visual_rejects_non_pdf(db_session, tmp_path: Path):
    md_path = tmp_path / "note.md"
    md_path.write_text("# Note\n", encoding="utf-8")
    file_id = f"md-{uuid4()}"
    db_session.add(
        File(
            id=file_id,
            name="note.md",
            file_type=FileType.MD,
            path=str(md_path),
            size=md_path.stat().st_size,
            page_count=1,
            meta={},
        )
    )
    await db_session.commit()

    tool = InspectDocumentVisualTool()
    result = await tool.execute(
        {"file_id": file_id, "query": "这张图说明了什么？"},
        ToolContext(session_id="sess-1", db=db_session, permissions={file_id: PermissionLevel.READ}),
    )

    assert result.success is False
    assert result.error_code == "FILE_NOT_SUPPORTED"
