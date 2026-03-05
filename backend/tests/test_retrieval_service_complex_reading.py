from unittest.mock import AsyncMock

import pytest

from app.models import DocumentChunk, File, FileType
from app.services import retrieval_service


@pytest.mark.asyncio
async def test_bilingual_query_bundle_retrieves_english_chunks_with_chinese_query(
    db_session,
    monkeypatch: pytest.MonkeyPatch,
):
    db_session.add(
        File(
            id="f-en",
            name="paper.txt",
            file_type=FileType.TXT,
            path="/tmp/paper.txt",
            size=1,
            page_count=1,
            meta={},
        )
    )
    db_session.add_all(
        [
            DocumentChunk(
                id=f"chunk-{idx}",
                file_id="f-en",
                page=1,
                chunk_index=idx,
                content=text,
                bbox=None,
            )
            for idx, text in enumerate(
                [
                    "This paper introduces a method for representation learning.",
                    "Experiments show consistent gains across benchmarks.",
                    "Ablation results highlight where the method fails.",
                ]
            )
        ]
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
        AsyncMock(return_value={"diagnostics": {"fallback_flags": []}, "hits": []}),
    )
    monkeypatch.setattr(
        retrieval_service.reader_orchestrator,
        "build_deep_read_context",
        AsyncMock(return_value=[]),
    )

    result = await retrieval_service.retrieve_context_blocks(
        db=db_session,
        query="这篇论文的方法和实验结果是什么",
        readable_files=["f-en"],
        permitted_files_info={"f-en": {"name": "paper.txt"}},
        active_file_id="f-en",
        active_page=1,
    )

    query_bundle = result.get("retrieval_meta", {}).get("query_bundle") or []
    assert any(str(item.get("lang")) == "zh" for item in query_bundle)
    assert any(str(item.get("lang")) == "en" for item in query_bundle)
    assert result.get("citations")
    assert result.get("retrieval_meta", {}).get("candidate_count", 0) >= len(result.get("retrieval_refs") or [])

    joined = " ".join(str(item.get("content") or "") for item in (result.get("citations") or [])).lower()
    assert "method" in joined or "experiment" in joined


@pytest.mark.asyncio
async def test_complex_reading_many_chunks_stops_with_budget_or_convergence(
    db_session,
    monkeypatch: pytest.MonkeyPatch,
):
    db_session.add(
        File(
            id="f-long",
            name="long.txt",
            file_type=FileType.TXT,
            path="/tmp/long.txt",
            size=1,
            page_count=200,
            meta={},
        )
    )
    long_text = "stability bound analysis " * 12
    db_session.add_all(
        [
            DocumentChunk(
                id=f"long-{idx}",
                file_id="f-long",
                page=(idx // 3) + 1,
                chunk_index=idx,
                content=f"{long_text} segment-{idx}",
                bbox=None,
            )
            for idx in range(180)
        ]
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
        AsyncMock(return_value={"diagnostics": {"fallback_flags": []}, "hits": []}),
    )
    monkeypatch.setattr(
        retrieval_service.reader_orchestrator,
        "build_deep_read_context",
        AsyncMock(return_value=[]),
    )
    monkeypatch.setattr(retrieval_service.settings, "DOC_CONTEXT_BUDGET_TOKENS", 220, raising=False)
    monkeypatch.setattr(retrieval_service.settings, "RAG_RERANK_TOPN", 60, raising=False)

    result = await retrieval_service.retrieve_context_blocks(
        db=db_session,
        query="这份材料里的 stability bound 结论是什么",
        readable_files=["f-long"],
        permitted_files_info={"f-long": {"name": "long.txt"}},
        active_file_id="f-long",
        active_page=3,
    )

    meta = result.get("retrieval_meta") or {}
    assert meta.get("candidate_count", 0) > 0
    assert meta.get("evidence_count", 0) > 0
    assert meta.get("stop_reason") in {"budget_limit", "marginal_gain_stop", "exhausted_candidates", "single_query"}
    assert result.get("context_parts")
