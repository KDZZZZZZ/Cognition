import uuid
from dataclasses import dataclass

import pytest

from app.database import async_session_maker
from app.models import DocumentSegment, File, FileIndexStatus, FileType
from app.services.tools.base import PermissionLevel, ToolContext, ToolValidationError
from app.services.tools.handlers.reader_tools import (
    ExplainRetrievalTool,
    GetDocumentOutlineTool,
    GetIndexStatusTool,
    LocateRelevantSegmentsTool,
    ReadDocumentSegmentsTool,
    ReadWebpageBlocksTool,
    reader_orchestrator,
)


@dataclass
class _Hit:
    segment_id: str
    file_id: str
    page: int | None
    section: str | None
    source_type: str
    score: float
    source_mode: str
    reason: str
    text: str


@pytest.fixture
async def db():
    async with async_session_maker() as session:
        yield session
        await session.rollback()


@pytest.mark.asyncio
async def test_get_document_outline_and_locate_segments(db, monkeypatch: pytest.MonkeyPatch):
    async def fake_outline(*, db, file_id):  # noqa: ARG001
        return [{"title": "A"}]

    async def fake_locate(**kwargs):  # noqa: ARG001
        return {
            "hits": [_Hit("seg-1", "file-1", 1, "sec", "md", 0.91, "text", "lexical", "content")],
            "diagnostics": {"mode": "test"},
        }

    monkeypatch.setattr(reader_orchestrator, "get_outline", fake_outline)
    monkeypatch.setattr(reader_orchestrator, "locate_relevant_segments", fake_locate)

    context = ToolContext(session_id="s1", db=db, permissions={"file-1": PermissionLevel.READ})

    outline_tool = GetDocumentOutlineTool()
    outline = await outline_tool.execute({"file_id": "file-1"}, context)
    assert outline.success is True
    assert outline.data["count"] == 1

    locate_tool = LocateRelevantSegmentsTool()
    with pytest.raises(ToolValidationError):
        locate_tool.validate_arguments({"query": "", "top_k": 8})
    with pytest.raises(ToolValidationError):
        locate_tool.validate_arguments({"query": "ok", "top_k": 31})

    result = await locate_tool.execute({"query": "hello", "file_id": "file-1", "top_k": 3}, context)
    assert result.success is True
    assert result.data["count"] == 1
    assert result.data["hits"][0]["segment_id"] == "seg-1"


@pytest.mark.asyncio
async def test_read_document_segments_and_explain(db, monkeypatch: pytest.MonkeyPatch):
    async def fake_read_segments(**kwargs):  # noqa: ARG001
        return {"file_id": "file-1", "content": "deep read"}

    async def fake_locate(**kwargs):  # noqa: ARG001
        return {
            "diagnostics": {"fused": True},
            "hits": [_Hit("seg-2", "file-1", 2, "sec2", "pdf", 0.8, "vision", "rerank", "chunk")],
        }

    monkeypatch.setattr(reader_orchestrator, "read_segments", fake_read_segments)
    monkeypatch.setattr(reader_orchestrator, "locate_relevant_segments", fake_locate)

    context = ToolContext(session_id="s1", db=db, permissions={"file-1": PermissionLevel.READ})

    read_tool = ReadDocumentSegmentsTool()
    with pytest.raises(ToolValidationError):
        read_tool.validate_arguments({"file_id": "file-1", "anchor_page": 0})
    ok = await read_tool.execute({"file_id": "file-1", "anchor_page": 2, "page_window": 1}, context)
    assert ok.success is True
    assert ok.data["content"] == "deep read"

    explain_tool = ExplainRetrievalTool()
    explained = await explain_tool.execute({"query": "test", "file_id": "file-1"}, context)
    assert explained.success is True
    assert explained.data["hits"][0]["segment_id"] == "seg-2"


@pytest.mark.asyncio
async def test_read_webpage_blocks_and_index_status(db):
    file_web_id = str(uuid.uuid4())
    file_md_id = str(uuid.uuid4())

    db.add(
        File(
            id=file_web_id,
            name="web",
            file_type=FileType.WEB,
            path="/tmp/web.html",
            size=10,
            page_count=1,
            meta={},
        )
    )
    await db.commit()

    db.add(
        File(
            id=file_md_id,
            name="doc",
            file_type=FileType.MD,
            path="/tmp/doc.md",
            size=10,
            page_count=1,
            meta={},
        )
    )
    await db.commit()

    db.add(
        DocumentSegment(
            id=str(uuid.uuid4()),
            file_id=file_web_id,
            source_type="web",
            page=1,
            section="intro",
            chunk_index=0,
            bbox=None,
            text="block-1",
            segment_type="paragraph",
            confidence=1.0,
            source="local",
            meta={},
        )
    )
    db.add(
        FileIndexStatus(
            file_id=file_web_id,
            parse_status="ready",
            embedding_status="ready",
            last_error=None,
        )
    )
    await db.commit()

    context = ToolContext(session_id="s1", db=db, permissions={file_web_id: PermissionLevel.READ})
    read_web_tool = ReadWebpageBlocksTool()
    blocks = await read_web_tool.execute({"file_id": file_web_id, "block_start": 0, "block_end": 1}, context)
    assert blocks.success is True
    assert blocks.data["count"] == 1

    invalid_type = await read_web_tool.execute({"file_id": file_md_id}, context)
    assert invalid_type.success is False
    assert invalid_type.error_code == "INVALID_FILE_TYPE"

    missing = await read_web_tool.execute({"file_id": "missing-id"}, context)
    assert missing.success is False
    assert missing.error_code == "FILE_NOT_FOUND"

    status_tool = GetIndexStatusTool()
    status = await status_tool.execute({"file_id": file_web_id}, context)
    assert status.success is True
    assert status.data["parse_status"] == "ready"

    pending = await status_tool.execute({"file_id": "unknown"}, context)
    assert pending.success is True
    assert pending.data["parse_status"] == "pending"
