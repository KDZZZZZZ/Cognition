import uuid
import asyncio
from unittest.mock import AsyncMock

import pytest

from app.database import async_session_maker
from app.models import DocumentChunk, File, FileType
from app.services import retrieval_service
from app.services.retrieval_service import (
    _lexical_score,
    _to_text,
    _tokenize_lexical,
    load_active_viewport_and_excerpt,
    retrieve_context_blocks,
)
from app.services.tools.base import PermissionLevel


@pytest.fixture
async def db():
    async with async_session_maker() as session:
        yield session
        await session.rollback()


def test_retrieval_helper_functions():
    assert _to_text(None) == ""
    assert _to_text(123) == "123"
    assert _tokenize_lexical("Hello, world! hello") == ["hello", "world", "hello"]
    assert _lexical_score(["hello", "missing"], "hello there") == 1.0
    assert _lexical_score([], "anything") == 0.0


@pytest.mark.asyncio
async def test_load_active_viewport_and_excerpt(db, monkeypatch: pytest.MonkeyPatch):
    file_id = str(uuid.uuid4())
    db.add(
        File(
            id=file_id,
            name="note.md",
            file_type=FileType.MD,
            path="/tmp/note.md",
            size=10,
            page_count=1,
            meta={},
        )
    )
    await db.commit()

    db.add(
        DocumentChunk(
            id=str(uuid.uuid4()),
            file_id=file_id,
            page=1,
            chunk_index=0,
            content="visible text",
            bbox=None,
        )
    )
    await db.commit()

    monkeypatch.setattr(
        retrieval_service,
        "get_viewport_context",
        lambda session_id, file_id=None: {"file_id": file_id or "none", "page": 1, "visible_range": [0, 100]},
    )

    payload = await load_active_viewport_and_excerpt(
        db=db,
        session_id="s1",
        context_permissions={file_id: PermissionLevel.READ},
        active_file_id=file_id,
        active_page=1,
    )
    assert payload["viewport"]["file_id"] == file_id
    assert "visible text" in (payload["excerpt"] or "")

    hidden = await load_active_viewport_and_excerpt(
        db=db,
        session_id="s1",
        context_permissions={file_id: PermissionLevel.NONE},
        active_file_id=file_id,
        active_page=1,
    )
    assert hidden["excerpt"] is None


@pytest.mark.asyncio
async def test_retrieve_context_blocks_paths(db, monkeypatch: pytest.MonkeyPatch):
    empty = await retrieve_context_blocks(
        db=db,
        query="q",
        readable_files=[],
        permitted_files_info={},
        active_file_id=None,
        active_page=None,
    )
    assert empty["retrieval_diagnostics"]["fallback_flags"] == ["no_readable_files"]

    file_id = str(uuid.uuid4())
    db.add(
        File(
            id=file_id,
            name="doc.md",
            file_type=FileType.MD,
            path="/tmp/doc.md",
            size=10,
            page_count=1,
            meta={},
        )
    )
    await db.commit()

    db.add(
        DocumentChunk(
            id=str(uuid.uuid4()),
            file_id=file_id,
            page=1,
            chunk_index=0,
            content="knowledge graph retrieval query",
            bbox=None,
        )
    )
    await db.commit()

    monkeypatch.setattr(retrieval_service.llm_service, "supports_embeddings", lambda: False)
    monkeypatch.setattr(
        retrieval_service.visual_retrieval_service,
        "retrieve_visual_page_hits",
        AsyncMock(return_value=[]),
    )
    monkeypatch.setattr(
        retrieval_service.reader_orchestrator,
        "locate_relevant_segments",
        AsyncMock(return_value={"diagnostics": {"mode": "none"}, "hits": []}),
    )
    monkeypatch.setattr(
        retrieval_service.reader_orchestrator,
        "build_deep_read_context",
        AsyncMock(return_value=[]),
    )

    result = await retrieve_context_blocks(
        db=db,
        query="knowledge query",
        readable_files=[file_id],
        permitted_files_info={file_id: {"name": "doc.md"}},
        active_file_id=file_id,
        active_page=1,
    )
    assert result["context_parts"]
    assert result["citations"]


@pytest.mark.asyncio
async def test_retrieve_context_blocks_skips_query_embedding_when_vector_store_disabled(db, monkeypatch: pytest.MonkeyPatch):
    file_id = str(uuid.uuid4())
    db.add(
        File(
            id=file_id,
            name="doc.md",
            file_type=FileType.MD,
            path="/tmp/doc.md",
            size=10,
            page_count=1,
            meta={},
        )
    )
    await db.commit()

    db.add(
        DocumentChunk(
            id=str(uuid.uuid4()),
            file_id=file_id,
            page=1,
            chunk_index=0,
            content="diffusion language model overview",
            bbox=None,
        )
    )
    await db.commit()

    get_embedding = AsyncMock(side_effect=AssertionError("query embedding should not run when vector store is disabled"))
    monkeypatch.setattr(retrieval_service.llm_service, "supports_embeddings", lambda: True)
    monkeypatch.setattr(retrieval_service.llm_service, "get_embedding", get_embedding)
    monkeypatch.setattr(retrieval_service.vector_store, "enabled", False)
    monkeypatch.setattr(
        retrieval_service.visual_retrieval_service,
        "retrieve_visual_page_hits",
        AsyncMock(return_value=[]),
    )
    monkeypatch.setattr(
        retrieval_service.reader_orchestrator,
        "locate_relevant_segments",
        AsyncMock(return_value={"diagnostics": {"mode": "none"}, "hits": []}),
    )
    monkeypatch.setattr(
        retrieval_service.reader_orchestrator,
        "build_deep_read_context",
        AsyncMock(return_value=[]),
    )

    result = await retrieve_context_blocks(
        db=db,
        query="diffusion overview",
        readable_files=[file_id],
        permitted_files_info={file_id: {"name": "doc.md"}},
        active_file_id=file_id,
        active_page=1,
    )

    assert result["context_parts"]
    assert "vector_store_disabled" in result["retrieval_diagnostics"]["fallback_flags"]
    get_embedding.assert_not_called()


@pytest.mark.asyncio
async def test_retrieve_context_blocks_times_out_visual_stage_and_falls_back(db, monkeypatch: pytest.MonkeyPatch):
    file_id = str(uuid.uuid4())
    db.add(
        File(
            id=file_id,
            name="doc.md",
            file_type=FileType.MD,
            path="/tmp/doc.md",
            size=10,
            page_count=1,
            meta={},
        )
    )
    await db.commit()

    db.add(
        DocumentChunk(
            id=str(uuid.uuid4()),
            file_id=file_id,
            page=1,
            chunk_index=0,
            content="diffusion paper summary and contributions",
            bbox=None,
        )
    )
    await db.commit()

    async def slow_visual_hits(**kwargs):
        await asyncio.sleep(0.2)
        return []

    monkeypatch.setattr(retrieval_service.llm_service, "supports_embeddings", lambda: False)
    monkeypatch.setattr(retrieval_service.vector_store, "enabled", False)
    monkeypatch.setattr(retrieval_service.settings, "VISUAL_RETRIEVAL_TIMEOUT_SECONDS", 0.01, raising=False)
    monkeypatch.setattr(retrieval_service.settings, "VISUAL_RETRIEVAL_TIMEOUT_RETRIES", 0, raising=False)
    monkeypatch.setattr(
        retrieval_service.visual_retrieval_service,
        "retrieve_visual_page_hits",
        slow_visual_hits,
    )
    monkeypatch.setattr(
        retrieval_service.reader_orchestrator,
        "locate_relevant_segments",
        AsyncMock(return_value={"diagnostics": {"mode": "none"}, "hits": []}),
    )
    monkeypatch.setattr(
        retrieval_service.reader_orchestrator,
        "build_deep_read_context",
        AsyncMock(return_value=[]),
    )

    result = await retrieve_context_blocks(
        db=db,
        query="diffusion summary",
        readable_files=[file_id],
        permitted_files_info={file_id: {"name": "doc.md"}},
        active_file_id=file_id,
        active_page=1,
    )

    assert result["context_parts"]
    assert "visual_timeout" in result["retrieval_diagnostics"]["fallback_flags"]


@pytest.mark.asyncio
async def test_retrieve_context_blocks_retries_visual_stage_before_fallback(db, monkeypatch: pytest.MonkeyPatch):
    file_id = str(uuid.uuid4())
    db.add(
        File(
            id=file_id,
            name="doc.md",
            file_type=FileType.MD,
            path="/tmp/doc.md",
            size=10,
            page_count=1,
            meta={},
        )
    )
    await db.commit()

    db.add(
        DocumentChunk(
            id=str(uuid.uuid4()),
            file_id=file_id,
            page=1,
            chunk_index=0,
            content="diffusion paper summary and contributions",
            bbox=None,
        )
    )
    await db.commit()

    calls = {"count": 0}

    async def flaky_visual_hits(**kwargs):
        calls["count"] += 1
        if calls["count"] == 1:
            await asyncio.sleep(0.2)
            return []
        return []

    monkeypatch.setattr(retrieval_service.llm_service, "supports_embeddings", lambda: False)
    monkeypatch.setattr(retrieval_service.vector_store, "enabled", False)
    monkeypatch.setattr(retrieval_service.settings, "VISUAL_RETRIEVAL_TIMEOUT_SECONDS", 0.01, raising=False)
    monkeypatch.setattr(retrieval_service.settings, "VISUAL_RETRIEVAL_TIMEOUT_RETRIES", 1, raising=False)
    monkeypatch.setattr(
        retrieval_service.visual_retrieval_service,
        "retrieve_visual_page_hits",
        flaky_visual_hits,
    )
    monkeypatch.setattr(
        retrieval_service.reader_orchestrator,
        "locate_relevant_segments",
        AsyncMock(return_value={"diagnostics": {"mode": "none"}, "hits": []}),
    )
    monkeypatch.setattr(
        retrieval_service.reader_orchestrator,
        "build_deep_read_context",
        AsyncMock(return_value=[]),
    )

    result = await retrieve_context_blocks(
        db=db,
        query="diffusion summary",
        readable_files=[file_id],
        permitted_files_info={file_id: {"name": "doc.md"}},
        active_file_id=file_id,
        active_page=1,
    )

    assert result["context_parts"]
    assert calls["count"] == 2
    assert "visual_timeout" not in result["retrieval_diagnostics"]["fallback_flags"]
