from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
import sys
import types

import pytest
from sqlalchemy import select

from app.models import DocumentAsset, DocumentChunk, DocumentSegment, File, FileType, SegmentEmbedding
from app.services.multiformat_document_service import (
    FusionRetriever,
    LocalParserProvider,
    ParseResult,
    ParseSegmentData,
    Qwen3VLEmbeddingProvider,
    ReaderOrchestrator,
    RetrievalHit,
    TextRetrievalProvider,
    WebUrlAdapter,
    _lexical_score,
    _sanitize_filename,
    _tokenize,
)


def test_multiformat_helper_functions():
    assert _sanitize_filename(" A/B:C ") == "A_B_C"
    assert _tokenize("Revenue growth, growth!") == ["revenue", "growth", "growth"]
    assert _lexical_score(["revenue", "gross"], "gross margin and revenue") == 2.0
    assert _lexical_score([], "anything") == 0.0


@pytest.mark.asyncio
async def test_web_adapter_ingest(monkeypatch: pytest.MonkeyPatch):
    adapter = WebUrlAdapter()

    class Response:
        text = "<html><h1>Title</h1></html>"

        @staticmethod
        def raise_for_status():
            return None

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def get(self, url, headers):
            assert "User-Agent" in headers
            assert url == "https://example.com/doc"
            return Response()

    monkeypatch.setattr("app.services.multiformat_document_service.httpx.AsyncClient", lambda **kwargs: FakeClient())

    artifact = await adapter.ingest(url="https://example.com/doc", title=None, tags=["a"], fetch_options={"lang": "en"})
    assert artifact.source_type == "web"
    assert artifact.url == "https://example.com/doc"
    assert artifact.metadata["tags"] == ["a"]

    with pytest.raises(ValueError):
        await adapter.ingest(url="  ")


@pytest.mark.asyncio
async def test_local_parser_provider_paths(monkeypatch: pytest.MonkeyPatch):
    provider = LocalParserProvider()

    web_result = await provider.parse(
        SimpleNamespace(source_type="web", html="<h1>H</h1><p>Body text content.</p>", url="https://x", file_path=None),
        file_id="f1",
    )
    assert web_result.provider == "local_web"
    assert web_result.segments

    empty_result = await provider.parse(
        SimpleNamespace(source_type="pdf", file_path=None),
        file_id="f2",
    )
    assert empty_result.quality == 0.0

    chunk = SimpleNamespace(page=1, chunk_index=0, content="chunk-text", bbox=None)
    monkeypatch.setattr(
        "app.services.multiformat_document_service.parser.parse_file",
        AsyncMock(return_value=([chunk], {"page_count": 1})),
    )
    file_result = await provider.parse(
        SimpleNamespace(source_type="pdf", file_path="/tmp/a.pdf"),
        file_id="f3",
    )
    assert file_result.quality > 0
    assert file_result.segments[0].text == "chunk-text"

    chart_chunks = [
        SimpleNamespace(page=2, chunk_index=0, content="Figure 3. Model architecture overview", bbox=(10, 20, 120, 140)),
        SimpleNamespace(page=2, chunk_index=1, content="Table 1: Benchmark comparison", bbox=(10, 160, 120, 220)),
    ]
    monkeypatch.setattr(
        "app.services.multiformat_document_service.parser.parse_file",
        AsyncMock(return_value=(chart_chunks, {"page_count": 2})),
    )
    chart_result = await provider.parse(
        SimpleNamespace(source_type="pdf", file_path="/tmp/chart.pdf"),
        file_id="f4",
    )
    assert [seg.segment_type for seg in chart_result.segments] == ["figure_caption", "table_caption"]
    assert chart_result.segments[0].meta["visual_kind"] == "figure"
    assert chart_result.segments[1].meta["visual_kind"] == "table"


@pytest.mark.asyncio
async def test_qwen_embedding_provider_batches_and_fused(monkeypatch: pytest.MonkeyPatch):
    provider = Qwen3VLEmbeddingProvider()
    provider.api_key = "k"
    provider.model = "m"
    provider.batch_size = 2

    async def fake_request(contents):
        return [[float(i + 1)] for i in range(len(contents))]

    monkeypatch.setattr(provider, "_request_embeddings", fake_request)

    text_vectors = await provider.embed_text(["a", "b", "c"])
    assert text_vectors == [[1.0], [2.0], [1.0]]

    fused_vectors = await provider.embed_fused(
        [{"text": "hello", "image": "img://1"}, {"image_url": "img://2"}, {}]
    )
    assert len(fused_vectors) == 3


@pytest.mark.asyncio
async def test_text_retrieval_provider_maps_results(monkeypatch: pytest.MonkeyPatch):
    provider = TextRetrievalProvider()
    monkeypatch.setattr(
        "app.services.multiformat_document_service.vector_store.search_segment_embeddings",
        AsyncMock(
            return_value={
                "documents": [["Segment A", "Segment B"]],
                "metadatas": [[
                    {"segment_id": "s1", "file_id": "f1", "page": 1, "section": "A", "source_type": "pdf", "modality": "text"},
                    {"segment_id": "s2", "file_id": "f2", "page": 2, "section": "B", "source_type": "md", "modality": "fused", "segment_type": "figure_caption"},
                ]],
                "distances": [[0.2, 0.8]],
            }
        ),
    )

    hits = await provider.search(query_embedding=[0.1, 0.2], file_ids=["f1", "f2"], top_k=2)
    assert len(hits) == 2
    assert hits[0].segment_id == "s1"
    assert hits[0].score > hits[1].score
    assert hits[1].segment_type == "figure_caption"


@pytest.mark.asyncio
async def test_fusion_retriever_combines_visual_hint(monkeypatch: pytest.MonkeyPatch):
    text_retrieval = TextRetrievalProvider()
    text_retrieval.search = AsyncMock(
        return_value=[
            RetrievalHit(
                segment_id="s1",
                file_id="f1",
                page=3,
                section="A",
                source_type="pdf",
                score=0.6,
                source_mode="segment_text",
                reason=None,
                text="segment",
            )
        ]
    )
    retriever = FusionRetriever(text_retrieval=text_retrieval, visual_retrieval_enabled=True)
    monkeypatch.setattr(
        "app.services.multiformat_document_service.visual_retrieval_service.retrieve_visual_page_hits",
        AsyncMock(
            return_value=[
                {
                    "file_id": "f1",
                    "page": 3,
                    "vision_reason": "table match",
                    "score": 5.0,
                }
            ]
        ),
    )

    hits = await retriever.search(
        db=object(),
        query="margin",
        query_embedding=[0.1],
        file_ids=["f1"],
        top_k=3,
        active_file_id="f1",
        active_page=3,
    )
    assert hits
    assert hits[0].source_mode == "fusion"
    assert hits[0].reason == "table match"


@pytest.mark.asyncio
async def test_reader_orchestrator_embed_retry_and_meta(monkeypatch: pytest.MonkeyPatch):
    orchestrator = ReaderOrchestrator()

    attempts = {"count": 0}

    async def flaky_embed(items):
        attempts["count"] += 1
        if len(items) > 1:
            raise RuntimeError("batch fail")
        if items[0] == "bad":
            raise RuntimeError("single fail")
        return [[0.5]]

    vectors, errors = await orchestrator._embed_items_resilient(
        items=["ok", "bad"],
        embed_fn=flaky_embed,
    )
    assert vectors[0] == [0.5]
    assert vectors[1] is None
    assert 1 in errors
    assert attempts["count"] >= 2

    segment = DocumentSegment(
        id="seg-1",
        file_id="f1",
        source_type="md",
        page=1,
        section="s",
        chunk_index=0,
        bbox=None,
        text="t",
        segment_type="paragraph",
        confidence=1.0,
        source="local",
        meta={},
    )
    orchestrator._mark_segment_embedding_error(segment=segment, modality="text", message="embedding failed")
    assert segment.meta["embedding_errors"]["text"] == "embedding failed"


@pytest.mark.asyncio
async def test_reader_orchestrator_marks_embedding_disabled_when_vector_store_is_off(db_session, monkeypatch: pytest.MonkeyPatch):
    orchestrator = ReaderOrchestrator()
    file_row = File(
        id="file-embed-disabled",
        name="doc.md",
        file_type=FileType.MD,
        path="/tmp/doc.md",
        size=20,
        page_count=1,
        meta={},
    )
    db_session.add(file_row)
    await db_session.commit()

    monkeypatch.setattr(
        orchestrator.file_adapter,
        "ingest",
        AsyncMock(return_value=SimpleNamespace(source_type="md", file_path="/tmp/doc.md", title="doc.md", metadata={})),
    )
    monkeypatch.setattr(
        orchestrator.local_parser,
        "parse",
        AsyncMock(
            return_value=ParseResult(
                segments=[
                    ParseSegmentData(
                        page=1,
                        section="Intro",
                        chunk_index=0,
                        text="warmup text",
                    )
                ],
                assets=[],
                quality=0.9,
                provider="local",
            )
        ),
    )
    monkeypatch.setattr(orchestrator.embedding_provider, "is_enabled", lambda: True)
    monkeypatch.setattr("app.services.multiformat_document_service.vector_store.enabled", False)
    monkeypatch.setattr(orchestrator.embedding_provider, "embed_text", AsyncMock(side_effect=AssertionError("embed_text should not run")))

    result = await orchestrator.build_segments_for_file(db=db_session, file=file_row, mode="all")

    assert result["segment_count"] == 1
    status_row = await orchestrator._ensure_index_status(db_session, file_row.id)
    assert status_row.embedding_status == "disabled"


@pytest.mark.asyncio
async def test_reader_orchestrator_outline_locate_and_read(db_session, monkeypatch: pytest.MonkeyPatch):
    orchestrator = ReaderOrchestrator()
    monkeypatch.setattr(orchestrator.embedding_provider, "is_enabled", lambda: False)

    db_session.add(
        File(
            id="file-1",
            name="doc.md",
            file_type=FileType.MD,
            path="/tmp/doc.md",
            size=100,
            page_count=2,
            meta={},
        )
    )
    db_session.add_all(
        [
            DocumentSegment(
                id="seg-h1",
                file_id="file-1",
                source_type="md",
                page=1,
                section="Intro",
                chunk_index=0,
                bbox=None,
                text="Revenue Growth",
                segment_type="heading",
                confidence=0.9,
                source="local",
                meta={},
            ),
            DocumentSegment(
                id="seg-1",
                file_id="file-1",
                source_type="md",
                page=1,
                section="Intro",
                chunk_index=1,
                bbox=None,
                text="Revenue grew 20 percent year over year.",
                segment_type="paragraph",
                confidence=0.9,
                source="local",
                meta={},
            ),
            DocumentSegment(
                id="seg-2",
                file_id="file-1",
                source_type="md",
                page=2,
                section="Margins",
                chunk_index=2,
                bbox=None,
                text="Gross margin improved significantly.",
                segment_type="paragraph",
                confidence=0.9,
                source="local",
                meta={},
            ),
        ]
    )
    await db_session.commit()

    outline = await orchestrator.get_outline(db=db_session, file_id="file-1")
    assert outline[0]["segment_id"] == "seg-h1"

    located = await orchestrator.locate_relevant_segments(
        db=db_session,
        query="gross margin",
        file_ids=["file-1"],
        top_k=2,
        active_file_id="file-1",
        active_page=2,
    )
    assert located["hits"]
    assert "embedding_disabled" in located["diagnostics"]["fallback_flags"]

    context = await orchestrator.build_deep_read_context(
        db=db_session,
        hits=located["hits"],
        max_chars=120,
        page_window=1,
    )
    assert context

    read_by_ids = await orchestrator.read_segments(
        db=db_session,
        file_id="file-1",
        segment_ids=["seg-1", "seg-2"],
        max_chars=80,
    )
    assert read_by_ids["count"] >= 1

    read_by_window = await orchestrator.read_segments(
        db=db_session,
        file_id="file-1",
        anchor_page=2,
        page_window=0,
        max_chars=80,
    )
    assert read_by_window["count"] >= 1


@pytest.mark.asyncio
async def test_reader_orchestrator_import_web_url(db_session, monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    orchestrator = ReaderOrchestrator()
    monkeypatch.setattr(
        orchestrator.web_adapter,
        "ingest",
        AsyncMock(
            return_value=SimpleNamespace(
                source_type="web",
                html="<h1>Title</h1><p>Body content for import.</p>",
                url="https://example.com",
                title="Example Site",
                metadata={},
            )
        ),
    )
    monkeypatch.setattr(
        orchestrator.local_parser,
        "parse",
        AsyncMock(
            return_value=ParseResult(
                segments=[
                    ParseSegmentData(
                        page=1,
                        section="Intro",
                        chunk_index=0,
                        text="Body content for import.",
                    )
                ],
                assets=[],
                quality=0.9,
                provider="local_web",
            )
        ),
    )
    monkeypatch.setattr(orchestrator, "_replace_segments", AsyncMock(return_value=[]))
    monkeypatch.setattr(
        orchestrator,
        "build_segments_for_file",
        AsyncMock(return_value={"embedding_status": "ready"}),
    )

    monkeypatch.setattr("app.services.multiformat_document_service.settings.UPLOAD_DIR", str(tmp_path), raising=False)

    result = await orchestrator.import_web_url(
        db=db_session,
        url="https://example.com",
        title=None,
        tags=["news"],
        fetch_options={"lang": "en"},
        parent_id=None,
    )
    assert result["type"] == "web"
    assert result["segment_count"] == 1


@pytest.mark.asyncio
async def test_reader_orchestrator_sync_pdf_assets(db_session, monkeypatch: pytest.MonkeyPatch):
    orchestrator = ReaderOrchestrator()
    monkeypatch.setattr(
        "app.services.multiformat_document_service.visual_retrieval_service._to_data_url",
        lambda path: f"data://{Path(path).name}",
    )
    page_assets = [
        SimpleNamespace(page=1, image_path="/tmp/p1.jpg", image_url="/uploads/p1.jpg"),
        SimpleNamespace(page=2, image_path="/tmp/p2.jpg", image_url="/uploads/p2.jpg"),
    ]
    monkeypatch.setattr(
        "app.services.multiformat_document_service.visual_retrieval_service.ensure_page_assets",
        AsyncMock(return_value=page_assets),
    )

    mapping = await orchestrator._sync_pdf_assets(
        db=db_session,
        file_id="file-pdf",
        file_path="/tmp/doc.pdf",
        page_count_hint=2,
        chunks=None,
    )
    assert mapping[1] == "data://p1.jpg"
    assert mapping[2] == "data://p2.jpg"

    asset_rows = (await db_session.execute(select(DocumentAsset))).scalars().all()
    assert len(asset_rows) == 2
    assert asset_rows[0].url == "/uploads/p1.jpg"


@pytest.mark.asyncio
async def test_reader_orchestrator_index_segment_embeddings(db_session, monkeypatch: pytest.MonkeyPatch):
    orchestrator = ReaderOrchestrator()
    db_session.add(
        File(
            id="file-emb",
            name="doc.md",
            file_type=FileType.MD,
            path="/tmp/doc.md",
            size=1,
            page_count=1,
            meta={},
        )
    )
    segments = [
        DocumentSegment(
            id="seg-a",
            file_id="file-emb",
            source_type="md",
            page=1,
            section="A",
            chunk_index=0,
            bbox=None,
            text="alpha text",
            segment_type="paragraph",
            confidence=0.9,
            source="local",
            meta={},
        ),
        DocumentSegment(
            id="seg-b",
            file_id="file-emb",
            source_type="md",
            page=1,
            section="B",
            chunk_index=1,
            bbox=None,
            text="beta text",
            segment_type="paragraph",
            confidence=0.9,
            source="local",
            meta={},
        ),
    ]
    db_session.add_all(segments)
    await db_session.commit()

    class FakeEmbeddingProvider:
        provider_name = "fake-embedder"

        @staticmethod
        def is_enabled():
            return True

        @staticmethod
        async def embed_text(items):
            return [[1.0] for _ in items]

        @staticmethod
        async def embed_fused(items):
            return [[2.0] for _ in items]

        embed_image = AsyncMock(side_effect=lambda items: [[3.0] for _ in items])

    orchestrator.embedding_provider = FakeEmbeddingProvider()
    monkeypatch.setattr("app.services.multiformat_document_service.vector_store.enabled", True)
    monkeypatch.setattr(
        "app.services.multiformat_document_service.vector_store.add_segment_embeddings",
        AsyncMock(return_value=None),
    )

    counts = await orchestrator._index_segment_embeddings(
        db=db_session,
        file_id="file-emb",
        source_type="md",
        segments=segments,
        page_image_map={1: "/uploads/p1.jpg"},
    )
    assert counts["text"] == 2
    assert counts["fused"] == 2
    assert counts["image"] == 2
    assert orchestrator.embedding_provider.embed_image.await_count == 1
    assert orchestrator.embedding_provider.embed_image.await_args.args[0] == ["/uploads/p1.jpg"]

    emb_rows = (await db_session.execute(select(SegmentEmbedding))).scalars().all()
    assert len(emb_rows) == 6


@pytest.mark.asyncio
async def test_reader_orchestrator_build_segments_for_file_modes(db_session, monkeypatch: pytest.MonkeyPatch):
    orchestrator = ReaderOrchestrator()
    file_row = File(
        id="f-build",
        name="doc.md",
        file_type=FileType.MD,
        path="/tmp/doc.md",
        size=10,
        page_count=1,
        meta={},
    )
    db_session.add(file_row)
    await db_session.commit()

    fallback_segment = ParseSegmentData(
        page=1,
        section="Fallback",
        chunk_index=0,
        text="fallback text",
    )
    monkeypatch.setattr(orchestrator.file_adapter, "ingest", AsyncMock(return_value=SimpleNamespace(source_type="md", file_path="/tmp/doc.md", title="doc", metadata={})))
    monkeypatch.setattr(
        orchestrator.local_parser,
        "parse",
        AsyncMock(return_value=ParseResult(segments=[], assets=[], quality=0.1, provider="local")),
    )
    monkeypatch.setattr(
        orchestrator.fallback_parser,
        "parse",
        AsyncMock(return_value=ParseResult(segments=[fallback_segment], assets=[], quality=0.9, provider="fallback")),
    )

    seg_row = DocumentSegment(
        id="seg-only",
        file_id="f-build",
        source_type="md",
        page=1,
        section="Fallback",
        chunk_index=0,
        bbox=None,
        text="fallback text",
        segment_type="paragraph",
        confidence=0.9,
        source="fallback",
        meta={},
    )
    monkeypatch.setattr(orchestrator, "_replace_segments", AsyncMock(return_value=[seg_row]))
    monkeypatch.setattr(
        orchestrator,
        "_index_segment_embeddings",
        AsyncMock(return_value={"text": 1, "fused": 1, "image": 0, "error_count": 0}),
    )
    monkeypatch.setattr(orchestrator.embedding_provider, "is_enabled", lambda: True)
    monkeypatch.setattr("app.services.multiformat_document_service.vector_store.enabled", True)
    monkeypatch.setattr(
        "app.services.multiformat_document_service.vector_store.delete_segment_embeddings_by_file",
        AsyncMock(return_value=None),
    )

    result = await orchestrator.build_segments_for_file(db=db_session, file=file_row, mode="all")
    assert result["parse_status"] == "ready"
    assert result["embedding_status"] == "ready"

    monkeypatch.setattr(
        orchestrator,
        "_index_segment_embeddings",
        AsyncMock(side_effect=RuntimeError("embedding failed")),
    )
    failed = await orchestrator.build_segments_for_file(db=db_session, file=file_row, mode="embed_only")
    assert failed["embedding_status"] == "failed"


@pytest.mark.asyncio
async def test_reader_orchestrator_preserves_pdf_visual_metadata_with_chunks_hint(db_session, monkeypatch: pytest.MonkeyPatch):
    orchestrator = ReaderOrchestrator()
    file_row = File(
        id="f-build-pdf",
        name="paper.pdf",
        file_type=FileType.PDF,
        path="/tmp/paper.pdf",
        size=10,
        page_count=2,
        meta={},
    )
    db_session.add(file_row)
    await db_session.commit()

    chunk = DocumentChunk(
        id="chunk-figure-1",
        file_id="f-build-pdf",
        page=2,
        chunk_index=0,
        content="Figure 1. Model architecture overview",
        bbox=(10, 20, 120, 140),
    )
    local_segment = ParseSegmentData(
        page=2,
        section="Figure 1. Model architecture overview",
        chunk_index=0,
        text=chunk.content,
        bbox=chunk.bbox,
        segment_type="figure_caption",
        confidence=0.9,
        source="local",
        meta={"visual_kind": "figure", "visual_label": "1", "visual_anchor": True},
    )
    monkeypatch.setattr(
        orchestrator.file_adapter,
        "ingest",
        AsyncMock(return_value=SimpleNamespace(source_type="pdf", file_path="/tmp/paper.pdf", title="paper", metadata={})),
    )
    monkeypatch.setattr(
        orchestrator.local_parser,
        "parse",
        AsyncMock(return_value=ParseResult(segments=[local_segment], assets=[], quality=0.9, provider="local")),
    )
    monkeypatch.setattr(orchestrator.fallback_parser, "parse", AsyncMock())
    replace_segments = AsyncMock(return_value=[])
    monkeypatch.setattr(orchestrator, "_replace_segments", replace_segments)
    monkeypatch.setattr(orchestrator, "_sync_pdf_assets", AsyncMock(return_value={2: "/uploads/p2.jpg"}))
    monkeypatch.setattr(
        orchestrator,
        "_index_segment_embeddings",
        AsyncMock(return_value={"text": 1, "fused": 1, "image": 1, "error_count": 0}),
    )
    monkeypatch.setattr(orchestrator.embedding_provider, "is_enabled", lambda: True)
    monkeypatch.setattr("app.services.multiformat_document_service.vector_store.enabled", True)
    monkeypatch.setattr(
        "app.services.multiformat_document_service.vector_store.delete_segment_embeddings_by_file",
        AsyncMock(return_value=None),
    )

    result = await orchestrator.build_segments_for_file(
        db=db_session,
        file=file_row,
        chunks_hint=[chunk],
        mode="all",
    )

    segments_arg = replace_segments.await_args.kwargs["segments"]
    assert len(segments_arg) == 1
    assert segments_arg[0].segment_type == "figure_caption"
    assert segments_arg[0].meta["visual_label"] == "1"
    assert result["parse_status"] == "ready"
    assert result["embedding_status"] == "ready"


@pytest.mark.asyncio
async def test_reader_orchestrator_build_segments_accepts_string_file_type(db_session, monkeypatch: pytest.MonkeyPatch):
    orchestrator = ReaderOrchestrator()
    file_row = File(
        id="f-build-str",
        name="doc.md",
        file_type="md",
        path="/tmp/doc.md",
        size=10,
        page_count=1,
        meta={},
    )
    db_session.add(file_row)
    await db_session.commit()

    monkeypatch.setattr(
        orchestrator.file_adapter,
        "ingest",
        AsyncMock(return_value=SimpleNamespace(source_type="md", file_path="/tmp/doc.md", title="doc", metadata={})),
    )
    monkeypatch.setattr(
        orchestrator.local_parser,
        "parse",
        AsyncMock(return_value=ParseResult(segments=[], assets=[], quality=0.9, provider="local")),
    )
    monkeypatch.setattr(orchestrator.fallback_parser, "parse", AsyncMock())
    monkeypatch.setattr(orchestrator, "_replace_segments", AsyncMock(return_value=[]))
    monkeypatch.setattr(
        orchestrator,
        "_index_segment_embeddings",
        AsyncMock(return_value={"text": 0, "fused": 0, "image": 0, "error_count": 0}),
    )
    monkeypatch.setattr(orchestrator.embedding_provider, "is_enabled", lambda: True)
    monkeypatch.setattr("app.services.multiformat_document_service.vector_store.enabled", True)
    monkeypatch.setattr(
        "app.services.multiformat_document_service.vector_store.delete_segment_embeddings_by_file",
        AsyncMock(return_value=None),
    )

    result = await orchestrator.build_segments_for_file(db=db_session, file=file_row, mode="all")

    assert result["parse_status"] == "ready"
    assert result["embedding_status"] == "ready"


@pytest.mark.asyncio
async def test_qwen_fallback_parser_with_fake_unstructured(monkeypatch: pytest.MonkeyPatch):
    from app.services.multiformat_document_service import QwenDocParserFallback, SourceArtifact

    fallback = QwenDocParserFallback()
    monkeypatch.setattr("app.services.multiformat_document_service.settings.QWEN_DOC_FALLBACK_ENABLED", True, raising=False)

    class Meta:
        def __init__(self, page_number=None, xpath=None):
            self.page_number = page_number
            self.xpath = xpath

    class Element:
        def __init__(self, text, category, page):
            self.text = text
            self.category = category
            self.metadata = Meta(page_number=page, xpath=f"/{category}")

    fake_html_module = types.ModuleType("unstructured.partition.html")
    fake_html_module.partition_html = lambda text: [
        Element("Main Title", "Title", 1),
        Element("Item one", "ListItem", 1),
        Element("SELECT * FROM t", "CodeSnippet", 2),
        Element("A | B", "Table", 2),
    ]
    monkeypatch.setitem(sys.modules, "unstructured.partition.html", fake_html_module)

    result = await fallback.parse(
        SourceArtifact(source_type="web", html="<h1>Main Title</h1>"),
        file_id="f1",
    )
    assert result.quality > 0.7
    assert any(seg.segment_type == "heading" for seg in result.segments)
    assert any(seg.segment_type == "table" for seg in result.segments)


@pytest.mark.asyncio
async def test_qwen_embedding_provider_request_paths(monkeypatch: pytest.MonkeyPatch):
    provider = Qwen3VLEmbeddingProvider()
    provider.api_key = "key"
    provider.model = "model"

    class Resp:
        def __init__(self, body):
            self._body = body

        def raise_for_status(self):
            return None

        def json(self):
            return self._body

    class FakeClient:
        def __init__(self):
            self.calls = 0

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, headers, json):
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("transient")
            return Resp({"output": {"embeddings": [{"embedding": [0.1]}, {"embedding": [0.2]}]}})

    client = FakeClient()
    monkeypatch.setattr("app.services.multiformat_document_service.httpx.AsyncClient", lambda **kwargs: client)
    vectors = await provider._request_embeddings([{"text": "a"}, {"text": "b"}])
    assert vectors == [[0.1], [0.2]]

    class BadClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, headers, json):
            return Resp({"output": {"embeddings": [{"embedding": [0.1]}]}})

    monkeypatch.setattr("app.services.multiformat_document_service.httpx.AsyncClient", lambda **kwargs: BadClient())
    with pytest.raises(ValueError):
        await provider._request_embeddings([{"text": "x"}, {"text": "y"}])


@pytest.mark.asyncio
async def test_reader_orchestrator_index_segment_embeddings_error_branch(db_session, monkeypatch: pytest.MonkeyPatch):
    orchestrator = ReaderOrchestrator()
    db_session.add(
        File(
            id="file-err",
            name="doc.md",
            file_type=FileType.MD,
            path="/tmp/doc.md",
            size=1,
            page_count=1,
            meta={},
        )
    )
    segments = [
        DocumentSegment(
            id="seg-err-1",
            file_id="file-err",
            source_type="md",
            page=1,
            section="A",
            chunk_index=0,
            bbox=None,
            text="first",
            segment_type="paragraph",
            confidence=1.0,
            source="local",
            meta={},
        ),
        DocumentSegment(
            id="seg-err-2",
            file_id="file-err",
            source_type="md",
            page=1,
            section="B",
            chunk_index=1,
            bbox=None,
            text="second",
            segment_type="paragraph",
            confidence=1.0,
            source="local",
            meta={},
        ),
    ]
    db_session.add_all(segments)
    await db_session.commit()

    class ErrorEmbeddingProvider:
        provider_name = "fake"

        @staticmethod
        def is_enabled():
            return True

        @staticmethod
        async def embed_text(items):
            if len(items) > 1:
                raise RuntimeError("batch fail")
            if items[0] == "second":
                raise RuntimeError("single fail")
            return [[1.0]]

        @staticmethod
        async def embed_fused(items):
            return [[2.0] for _ in items]

        @staticmethod
        async def embed_image(items):
            raise RuntimeError("image fail")

    orchestrator.embedding_provider = ErrorEmbeddingProvider()
    monkeypatch.setattr("app.services.multiformat_document_service.vector_store.enabled", True)
    monkeypatch.setattr(
        "app.services.multiformat_document_service.vector_store.add_segment_embeddings",
        AsyncMock(return_value=None),
    )

    counts = await orchestrator._index_segment_embeddings(
        db=db_session,
        file_id="file-err",
        source_type="md",
        segments=segments,
        page_image_map={1: "/uploads/p1.jpg"},
    )
    assert counts["error_count"] >= 1
    assert "embedding_errors" in (segments[1].meta or {})
