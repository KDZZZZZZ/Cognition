from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from app.models import DocumentChunk, File, FileType
from app.services import retrieval_service
from app.services.multiformat_document_service import RetrievalHit
from app.services.tools.base import PermissionLevel


@pytest.mark.asyncio
async def test_retrieve_context_blocks_semantic_and_visual_paths(db_session, monkeypatch: pytest.MonkeyPatch):
    db_session.add(
        File(
            id="f-pdf",
            name="report.pdf",
            file_type=FileType.PDF,
            path="/tmp/report.pdf",
            size=12,
            page_count=3,
            meta={},
        )
    )
    db_session.add(
        File(
            id="f-md",
            name="note.md",
            file_type=FileType.MD,
            path="/tmp/note.md",
            size=8,
            page_count=1,
            meta={},
        )
    )
    db_session.add_all(
        [
            DocumentChunk(
                id="c1",
                file_id="f-pdf",
                page=2,
                chunk_index=0,
                content="Revenue and margin table data.",
                bbox=None,
            ),
            DocumentChunk(
                id="c2",
                file_id="f-md",
                page=1,
                chunk_index=0,
                content="Executive summary with key metrics.",
                bbox=None,
            ),
        ]
    )
    await db_session.commit()

    monkeypatch.setattr(retrieval_service.llm_service, "supports_embeddings", lambda: True)
    monkeypatch.setattr(retrieval_service.llm_service, "get_embedding", AsyncMock(return_value=[0.1, 0.2]))
    monkeypatch.setattr(
        retrieval_service.vector_store,
        "search",
        AsyncMock(
            return_value={
                "documents": [["vector hit"]],
                "metadatas": [[{"file_id": "f-pdf", "page": 2, "chunk_index": 0}]],
                "distances": [[0.2]],
            }
        ),
    )
    monkeypatch.setattr(
        retrieval_service.visual_retrieval_service,
        "retrieve_visual_page_hits",
        AsyncMock(
            return_value=[
                {
                    "file_id": "f-pdf",
                    "page": 2,
                    "score": 3.5,
                    "source_mode": "vision_rerank",
                    "vision_reason": "chart table",
                    "image_url": "/uploads/p2.jpg",
                }
            ]
        ),
    )
    monkeypatch.setattr(
        retrieval_service.reader_orchestrator,
        "locate_relevant_segments",
        AsyncMock(
            return_value={
                "diagnostics": {"fused_hits": 1, "text_hits": 1, "image_hits": 1, "fallback_flags": []},
                "hits": [
                    RetrievalHit(
                        segment_id="seg-1",
                        file_id="f-md",
                        page=1,
                        section="Intro",
                        source_type="md",
                        score=1.2,
                        source_mode="fusion",
                        reason=None,
                        text="Segment text",
                    )
                ],
            }
        ),
    )
    monkeypatch.setattr(
        retrieval_service.reader_orchestrator,
        "build_deep_read_context",
        AsyncMock(
            return_value=[
                {
                    "segment_id": "seg-1",
                    "file_id": "f-md",
                    "page": 1,
                    "section": "Intro",
                    "text": "Deep read segment context",
                    "source_mode": "fusion",
                    "reason": None,
                }
            ]
        ),
    )

    result = await retrieval_service.retrieve_context_blocks(
        db=db_session,
        query="revenue margin",
        readable_files=["f-pdf", "f-md"],
        permitted_files_info={
            "f-pdf": {"name": "report.pdf"},
            "f-md": {"name": "note.md"},
        },
        active_file_id="f-pdf",
        active_page=2,
    )
    assert result["context_parts"]
    assert result["citations"]
    assert result["visual_hits_count"] == 1
    assert result["retrieval_diagnostics"]["fused_hits"] == 1


@pytest.mark.asyncio
async def test_retrieve_context_blocks_last_resort_seed(db_session, monkeypatch: pytest.MonkeyPatch):
    db_session.add(
        File(
            id="f1",
            name="doc.txt",
            file_type=FileType.TXT,
            path="/tmp/doc.txt",
            size=6,
            page_count=1,
            meta={},
        )
    )
    db_session.add(
        DocumentChunk(
            id="seed-1",
            file_id="f1",
            page=1,
            chunk_index=0,
            content="neutral chunk without query words",
            bbox=None,
        )
    )
    await db_session.commit()

    monkeypatch.setattr(retrieval_service.llm_service, "supports_embeddings", lambda: False)
    monkeypatch.setattr(
        retrieval_service.visual_retrieval_service,
        "retrieve_visual_page_hits",
        AsyncMock(return_value=[]),
    )
    monkeypatch.setattr(
        retrieval_service.reader_orchestrator,
        "locate_relevant_segments",
        AsyncMock(side_effect=RuntimeError("segment pipeline broken")),
    )

    out = await retrieval_service.retrieve_context_blocks(
        db=db_session,
        query="unmatched query",
        readable_files=["f1"],
        permitted_files_info={"f1": {"name": "doc.txt"}},
        active_file_id="f1",
        active_page=1,
    )
    assert out["context_parts"]
    assert out["retrieval_diagnostics"]["fallback_flags"]


@pytest.mark.asyncio
async def test_load_active_viewport_excerpt_pdf_and_text(db_session, monkeypatch: pytest.MonkeyPatch):
    db_session.add(
        File(
            id="pdf-1",
            name="p.pdf",
            file_type=FileType.PDF,
            path="/tmp/p.pdf",
            size=1,
            page_count=2,
            meta={},
        )
    )
    db_session.add(
        File(
            id="md-1",
            name="m.md",
            file_type=FileType.MD,
            path="/tmp/m.md",
            size=1,
            page_count=1,
            meta={},
        )
    )
    db_session.add_all(
        [
            DocumentChunk(id="p-c", file_id="pdf-1", page=2, chunk_index=0, content="pdf excerpt", bbox=None),
            DocumentChunk(id="m-c", file_id="md-1", page=1, chunk_index=0, content="md excerpt", bbox=None),
        ]
    )
    await db_session.commit()

    monkeypatch.setattr(
        retrieval_service,
        "get_viewport_context",
        lambda session_id, file_id=None: {"file_id": file_id or "pdf-1", "page": 2, "visible_range": [0, 10]},
    )
    visible = await retrieval_service.load_active_viewport_and_excerpt(
        db=db_session,
        session_id="s1",
        context_permissions={"pdf-1": PermissionLevel.READ},
        active_file_id="pdf-1",
        active_page=2,
    )
    assert "pdf excerpt" in (visible["excerpt"] or "")

    hidden = await retrieval_service.load_active_viewport_and_excerpt(
        db=db_session,
        session_id="s1",
        context_permissions={"pdf-1": PermissionLevel.NONE},
        active_file_id="pdf-1",
        active_page=2,
    )
    assert hidden["excerpt"] is None


@pytest.mark.asyncio
async def test_local_deep_read_helper_and_viewport_edge_cases(db_session, monkeypatch: pytest.MonkeyPatch):
    # lexical helper empty-content branch
    assert retrieval_service._lexical_score(["x"], "") == 0.0

    # no chunks branch
    empty = await retrieval_service._build_local_deep_read_context(
        db=db_session,
        file_id="none",
        anchor_page=1,
        query_tokens=["x"],
    )
    assert empty == ""

    db_session.add(
        DocumentChunk(
            id="long-chunk",
            file_id="file-long",
            page=1,
            chunk_index=0,
            content="A" * 1200,
            bbox=None,
        )
    )
    await db_session.commit()

    # query_tokens empty branch + truncation branch in helper.
    monkeypatch.setattr(retrieval_service.settings, "VISUAL_DEEP_READ_MAX_CHARS", 600, raising=False)
    deep = await retrieval_service._build_local_deep_read_context(
        db=db_session,
        file_id="file-long",
        anchor_page=1,
        query_tokens=[],
    )
    assert deep.endswith("...")

    monkeypatch.setattr(
        retrieval_service,
        "get_viewport_context",
        lambda session_id, file_id=None: {"page": 1},
    )
    no_file_id = await retrieval_service.load_active_viewport_and_excerpt(
        db=db_session,
        session_id="s2",
        context_permissions={},
        active_file_id=None,
        active_page=None,
    )
    assert no_file_id["excerpt"] is None

    monkeypatch.setattr(
        retrieval_service,
        "get_viewport_context",
        lambda session_id, file_id=None: {"file_id": "missing", "page": 1},
    )
    missing_file = await retrieval_service.load_active_viewport_and_excerpt(
        db=db_session,
        session_id="s2",
        context_permissions={"missing": PermissionLevel.READ},
        active_file_id=None,
        active_page=None,
    )
    assert missing_file["excerpt"] is None


@pytest.mark.asyncio
async def test_retrieve_context_blocks_exception_and_skip_paths(db_session, monkeypatch: pytest.MonkeyPatch):
    db_session.add(
        File(
            id="f-err",
            name="err.txt",
            file_type=FileType.TXT,
            path="/tmp/err.txt",
            size=10,
            page_count=1,
            meta={},
        )
    )
    db_session.add(
        DocumentChunk(
            id="err-chunk",
            file_id="f-err",
            page=1,
            chunk_index=0,
            content="neutral words only",
            bbox=None,
        )
    )
    await db_session.commit()

    monkeypatch.setattr(retrieval_service.llm_service, "supports_embeddings", lambda: True)
    monkeypatch.setattr(retrieval_service.llm_service, "get_embedding", AsyncMock(return_value=[0.1]))
    monkeypatch.setattr(
        retrieval_service.vector_store,
        "search",
        AsyncMock(side_effect=RuntimeError("vector broken")),
    )
    monkeypatch.setattr(
        retrieval_service.visual_retrieval_service,
        "retrieve_visual_page_hits",
        AsyncMock(side_effect=RuntimeError("visual broken")),
    )
    monkeypatch.setattr(
        retrieval_service.reader_orchestrator,
        "locate_relevant_segments",
        AsyncMock(return_value={"diagnostics": {"fallback_flags": []}, "hits": []}),
    )
    monkeypatch.setattr(
        retrieval_service.reader_orchestrator,
        "build_deep_read_context",
        AsyncMock(return_value=[{"text": "", "file_id": "f-err", "page": 1, "section": "S"}]),
    )
    monkeypatch.setattr(retrieval_service, "estimate_tokens", lambda content: 999)
    monkeypatch.setattr(retrieval_service.settings, "DOC_CONTEXT_BUDGET_TOKENS", 10, raising=False)

    output = await retrieval_service.retrieve_context_blocks(
        db=db_session,
        query="unmatched-query",
        readable_files=["f-err"],
        permitted_files_info={"f-err": {"name": "err.txt"}},
        active_file_id=None,
        active_page=None,
    )
    assert output["semantic_failed"] is True
    assert output["visual_hits_count"] == 0
    assert output["context_parts"] == []


@pytest.mark.asyncio
async def test_retrieve_context_blocks_active_seed_and_visual_skip_lines(db_session, monkeypatch: pytest.MonkeyPatch):
    db_session.add(
        File(
            id="f-active",
            name="active.txt",
            file_type=FileType.TXT,
            path="/tmp/active.txt",
            size=10,
            page_count=1,
            meta={},
        )
    )
    db_session.add(
        DocumentChunk(
            id="seed-active",
            file_id="f-active",
            page=1,
            chunk_index=0,
            content="neutral seed chunk",
            bbox=None,
        )
    )
    await db_session.commit()

    monkeypatch.setattr(retrieval_service.llm_service, "supports_embeddings", lambda: False)
    monkeypatch.setattr(
        retrieval_service.visual_retrieval_service,
        "retrieve_visual_page_hits",
        AsyncMock(
            return_value=[
                {"file_id": None, "page": 1},
                {"file_id": "f-active", "page": 1, "score": 1.0, "source_mode": "visual_lexical"},
            ]
        ),
    )
    monkeypatch.setattr(retrieval_service, "_build_local_deep_read_context", AsyncMock(return_value=""))
    monkeypatch.setattr(
        retrieval_service.reader_orchestrator,
        "locate_relevant_segments",
        AsyncMock(return_value={"diagnostics": {"fallback_flags": []}, "hits": []}),
    )
    monkeypatch.setattr(
        retrieval_service.reader_orchestrator,
        "build_deep_read_context",
        AsyncMock(return_value=[]),
    )

    result = await retrieval_service.retrieve_context_blocks(
        db=db_session,
        query="does-not-match",
        readable_files=["f-active"],
        permitted_files_info={"f-active": {"name": "active.txt"}},
        active_file_id="f-active",
        active_page=1,
    )
    assert result["context_parts"]
