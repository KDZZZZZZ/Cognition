import asyncio
import re
from typing import Any, Dict, List, Optional

from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.viewport import get_viewport_context
from app.config import settings
from app.models import DocumentChunk, File as FileModel
from app.services.llm_service import llm_service
from app.services.multiformat_document_service import reader_orchestrator
from app.services.tools.base import PermissionLevel
from app.services.token_budget_service import estimate_tokens, short_text
from app.services.vector_store import vector_store
from app.services.visual_retrieval_service import visual_retrieval_service


def _to_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return str(value)


def _tokenize_lexical(text: str) -> List[str]:
    return [token for token in re.split(r"\W+", text.lower()) if token]


def _lexical_score(query_tokens: List[str], content: str) -> float:
    if not query_tokens:
        return 0.0
    content_tokens = _tokenize_lexical(content)
    if not content_tokens:
        return 0.0
    content_set = set(content_tokens)
    return float(sum(1 for token in query_tokens if token in content_set))


def _file_type_to_str(file_type: Any) -> str:
    return file_type.value if hasattr(file_type, "value") else str(file_type)


def _format_segment_prefix(segment_type: Any) -> str:
    normalized = str(segment_type or "").strip().lower()
    mapping = {
        "figure_caption": "Figure Caption",
        "table_caption": "Table Caption",
        "figure_context": "Figure Context",
        "heading": "Heading",
        "table": "Table",
    }
    return mapping.get(normalized, "")


async def _await_with_timeout_retry(
    *,
    operation,
    timeout_seconds: float,
    retries: int,
):
    last_error: Optional[TimeoutError] = None
    for attempt in range(max(0, int(retries)) + 1):
        try:
            return await asyncio.wait_for(operation(), timeout=max(0.1, float(timeout_seconds)))
        except TimeoutError as exc:
            last_error = exc
            if attempt >= max(0, int(retries)):
                raise
    if last_error is not None:
        raise last_error
    raise TimeoutError("operation timed out")


async def _build_local_deep_read_context(
    *,
    db: AsyncSession,
    file_id: str,
    anchor_page: int,
    query_tokens: List[str],
) -> str:
    page_window = max(0, int(settings.VISUAL_DEEP_READ_PAGE_WINDOW))
    page_start = max(1, anchor_page - page_window)
    page_end = anchor_page + page_window

    chunks_result = await db.execute(
        select(DocumentChunk)
        .where(
            and_(
                DocumentChunk.file_id == file_id,
                DocumentChunk.page >= page_start,
                DocumentChunk.page <= page_end,
            )
        )
        .order_by(DocumentChunk.page, DocumentChunk.chunk_index)
    )
    chunks = chunks_result.scalars().all()
    if not chunks:
        return ""

    ranked_chunks: List[DocumentChunk] = []
    if query_tokens:
        scored = []
        for chunk in chunks:
            score = _lexical_score(query_tokens, chunk.content)
            scored.append((score, chunk.page, chunk.chunk_index, chunk))
        scored.sort(key=lambda item: item[0], reverse=True)
        positives = [item[3] for item in scored if item[0] > 0]
        ranked_chunks = positives[:10] if positives else [item[3] for item in scored[:8]]
    else:
        ranked_chunks = chunks[:8]

    parts: List[str] = []
    consumed = 0
    max_chars = max(600, int(settings.VISUAL_DEEP_READ_MAX_CHARS))
    for chunk in ranked_chunks:
        piece = f"[p.{chunk.page}] {chunk.content.strip()}"
        piece_len = len(piece)
        if consumed + piece_len > max_chars:
            remain = max_chars - consumed
            if remain > 80:
                parts.append(piece[:remain] + "...")
            break
        parts.append(piece)
        consumed += piece_len

    return "\n".join(parts)


async def load_active_viewport_and_excerpt(
    *,
    db: AsyncSession,
    session_id: str,
    context_permissions: Dict[str, PermissionLevel],
    active_file_id: Optional[str],
    active_page: Optional[int],
) -> Dict[str, Any]:
    viewport_ctx = (
        get_viewport_context(session_id, file_id=active_file_id)
        if active_file_id
        else get_viewport_context(session_id)
    )

    if active_file_id and active_page is not None:
        viewport_ctx = {
            **(viewport_ctx or {}),
            "file_id": active_file_id,
            "page": active_page,
        }

    if not viewport_ctx:
        return {"viewport": None, "excerpt": None}

    file_id = viewport_ctx.get("file_id")
    page = int(viewport_ctx.get("page") or 1)
    if not file_id:
        return {"viewport": viewport_ctx, "excerpt": None}

    permission = context_permissions.get(file_id, PermissionLevel.READ)
    if permission == PermissionLevel.NONE:
        return {"viewport": viewport_ctx, "excerpt": None}

    file_result = await db.execute(select(FileModel).where(FileModel.id == file_id))
    file_row = file_result.scalar_one_or_none()
    if not file_row:
        return {"viewport": viewport_ctx, "excerpt": None}

    excerpt = None
    file_type = _file_type_to_str(file_row.file_type)
    if file_type == "pdf":
        chunks_result = await db.execute(
            select(DocumentChunk)
            .where(and_(DocumentChunk.file_id == file_id, DocumentChunk.page == page))
            .order_by(DocumentChunk.chunk_index)
        )
        chunks = chunks_result.scalars().all()
        text = "\n".join(chunk.content for chunk in chunks)
        if text:
            excerpt = text[: settings.VIEWPORT_EXCERPT_MAX_CHARS]
    elif file_type in ("md", "txt", "code"):
        content_result = await db.execute(
            select(DocumentChunk)
            .where(DocumentChunk.file_id == file_id)
            .order_by(DocumentChunk.page, DocumentChunk.chunk_index)
            .limit(3)
        )
        chunks = content_result.scalars().all()
        text = "\n".join(chunk.content for chunk in chunks)
        if text:
            excerpt = text[: settings.VIEWPORT_EXCERPT_MAX_CHARS]

    return {
        "viewport": {
            "file_id": file_id,
            "file_name": file_row.name,
            "file_type": file_type,
            "page": page,
            "visible_range": viewport_ctx.get("visible_range"),
        },
        "excerpt": excerpt,
    }


async def retrieve_context_blocks(
    *,
    db: AsyncSession,
    query: str,
    readable_files: List[str],
    permitted_files_info: Dict[str, Dict[str, str]],
    active_file_id: Optional[str],
    active_page: Optional[int],
) -> Dict[str, Any]:
    if not readable_files:
        return {
            "context_parts": [],
            "citations": [],
            "retrieval_refs": [],
            "retrieval_diagnostics": {
                "text_hits": 0,
                "image_hits": 0,
                "fused_hits": 0,
                "fallback_flags": ["no_readable_files"],
            },
        }

    candidates: List[Dict[str, Any]] = []
    query_tokens = _tokenize_lexical(query)
    semantic_failed = False
    visual_hits_count = 0
    retrieval_diagnostics: Dict[str, Any] = {
        "text_hits": 0,
        "image_hits": 0,
        "fused_hits": 0,
        "fallback_flags": [],
    }

    semantic_search_enabled = llm_service.supports_embeddings() and vector_store.enabled
    if semantic_search_enabled:
        try:
            query_embedding = await llm_service.get_embedding(query)
            for file_id in readable_files:
                search_results = await vector_store.search(
                    query_embedding=query_embedding,
                    n_results=12,
                    file_id=file_id,
                )
                docs = (search_results or {}).get("documents", [[]])[0]
                metadatas = (search_results or {}).get("metadatas", [[]])[0]
                distances = (search_results or {}).get("distances", [[]])[0]
                for index, doc in enumerate(docs):
                    metadata = metadatas[index] if index < len(metadatas) else {}
                    distance = distances[index] if index < len(distances) else None
                    page = metadata.get("page")
                    score = 1.0 / (1.0 + float(distance)) if distance is not None else 0.5
                    if active_file_id and metadata.get("file_id") == active_file_id:
                        score += 0.2
                    if (
                        active_file_id
                        and active_page is not None
                        and metadata.get("file_id") == active_file_id
                        and page == active_page
                    ):
                        score += 0.4
                    candidates.append(
                        {
                            "file_id": metadata.get("file_id") or file_id,
                            "page": page,
                            "chunk_index": metadata.get("chunk_index"),
                            "content": _to_text(doc),
                            "score": score,
                        }
                    )
        except Exception as exc:
            print(f"Warning: Could not perform semantic vector search: {exc}")
            semantic_failed = True
    else:
        semantic_failed = True
        if llm_service.supports_embeddings() and not vector_store.enabled:
            retrieval_diagnostics["fallback_flags"].append("vector_store_disabled")

    if not candidates:
        semantic_failed = True
        for file_id in readable_files:
            chunks_result = await db.execute(
                select(DocumentChunk)
                .where(DocumentChunk.file_id == file_id)
                .order_by(DocumentChunk.page, DocumentChunk.chunk_index)
                .limit(300)
            )
            chunks = chunks_result.scalars().all()
            for chunk in chunks:
                score = _lexical_score(query_tokens, chunk.content)
                if score <= 0:
                    continue
                boosted = score
                if active_file_id and file_id == active_file_id:
                    boosted += 1.0
                if (
                    active_file_id
                    and active_page is not None
                    and file_id == active_file_id
                    and chunk.page == active_page
                ):
                    boosted += 2.0
                candidates.append(
                    {
                        "file_id": file_id,
                        "page": chunk.page,
                        "chunk_index": chunk.chunk_index,
                        "content": chunk.content,
                        "score": float(boosted),
                    }
                )

    # Last-resort context seeding:
    # if lexical/semantic miss (common for broad prompts like "summarize what I am reading"),
    # still inject chunks from active file/page and a tiny head slice from readable files.
    if not candidates and readable_files:
        prioritized_files: List[str] = []
        if active_file_id and active_file_id in readable_files:
            prioritized_files.append(active_file_id)
        prioritized_files.extend([fid for fid in readable_files if fid != active_file_id])

        for file_id in prioritized_files:
            if file_id == active_file_id and active_page is not None:
                seed_query = (
                    select(DocumentChunk)
                    .where(and_(DocumentChunk.file_id == file_id, DocumentChunk.page == active_page))
                    .order_by(DocumentChunk.chunk_index)
                    .limit(8)
                )
            else:
                seed_query = (
                    select(DocumentChunk)
                    .where(DocumentChunk.file_id == file_id)
                    .order_by(DocumentChunk.page, DocumentChunk.chunk_index)
                    .limit(4)
                )

            seed_result = await db.execute(seed_query)
            seed_chunks = seed_result.scalars().all()
            for chunk in seed_chunks:
                base_score = 0.2
                if file_id == active_file_id:
                    base_score += 0.6
                if file_id == active_file_id and active_page is not None and chunk.page == active_page:
                    base_score += 0.6
                candidates.append(
                    {
                        "file_id": file_id,
                        "page": chunk.page,
                        "chunk_index": chunk.chunk_index,
                        "content": chunk.content,
                        "score": float(base_score),
                    }
                )

    # Visual retrieval stage:
    # page screenshot/image -> visual page retrieval -> anchor page -> local deep read.
    try:
        visual_hits = await _await_with_timeout_retry(
            operation=lambda: visual_retrieval_service.retrieve_visual_page_hits(
                db=db,
                query=query,
                readable_files=readable_files,
                permitted_files_info=permitted_files_info,
                active_file_id=active_file_id,
                active_page=active_page,
            ),
            timeout_seconds=float(settings.VISUAL_RETRIEVAL_TIMEOUT_SECONDS),
            retries=int(settings.VISUAL_RETRIEVAL_TIMEOUT_RETRIES),
        )
    except TimeoutError:
        retrieval_diagnostics.setdefault("fallback_flags", [])
        retrieval_diagnostics["fallback_flags"].append("visual_timeout")
        visual_hits = []
    except Exception as exc:
        print(f"Warning: visual page retrieval failed, skip visual stage: {exc}")
        visual_hits = []

    visual_hits_count = len(visual_hits)
    for index, hit in enumerate(visual_hits):
        file_id = hit.get("file_id")
        page = hit.get("page")
        if not file_id or page is None:
            continue

        deep_read = await _build_local_deep_read_context(
            db=db,
            file_id=file_id,
            anchor_page=int(page),
            query_tokens=query_tokens,
        )
        if not deep_read:
            continue

        visual_score = float(hit.get("score", 0.0))
        boosted = visual_score + 2.5
        if hit.get("source_mode") == "vision_rerank":
            boosted += 1.2

        candidates.append(
            {
                "file_id": file_id,
                "page": int(page),
                "chunk_index": -(index + 1),
                "content": deep_read,
                "score": float(boosted),
                "source_mode": hit.get("source_mode", "visual_focus"),
                "visual_reason": hit.get("vision_reason"),
                "image_url": hit.get("image_url"),
            }
        )

    # Unified segment retrieval (md/pdf/web): locate -> local deep read.
    try:
        segment_retrieval = await reader_orchestrator.locate_relevant_segments(
            db=db,
            query=query,
            file_ids=readable_files,
            top_k=max(4, int(settings.MM_TOPK_RERANK)),
            active_file_id=active_file_id,
            active_page=active_page,
        )
        segment_diagnostics = segment_retrieval.get("diagnostics") or {}
        if segment_diagnostics:
            merged_fallback_flags = list(retrieval_diagnostics.get("fallback_flags") or [])
            merged_fallback_flags.extend(segment_diagnostics.get("fallback_flags") or [])
            retrieval_diagnostics = {
                **retrieval_diagnostics,
                **segment_diagnostics,
                "fallback_flags": merged_fallback_flags,
            }
        segment_hits = segment_retrieval.get("hits", [])
        deep_items = await reader_orchestrator.build_deep_read_context(
            db=db,
            hits=segment_hits,
            max_chars=max(1200, int(settings.DOC_CONTEXT_BUDGET_TOKENS * 2)),
            page_window=max(0, int(settings.VISUAL_DEEP_READ_PAGE_WINDOW)),
        )
        for index, item in enumerate(deep_items):
            content = str(item.get("text") or "").strip()
            if not content:
                continue
            candidates.append(
                {
                    "file_id": item.get("file_id"),
                    "page": item.get("page"),
                    "section": item.get("section"),
                    "chunk_index": -(1000 + index),
                    "content": content,
                    "score": float(2.2 + (0.08 * max(0, len(deep_items) - index))),
                    "segment_type": item.get("segment_type"),
                    "source_mode": item.get("source_mode", "segment"),
                    "visual_reason": item.get("reason"),
                }
            )
    except Exception as exc:
        retrieval_diagnostics.setdefault("fallback_flags", [])
        retrieval_diagnostics["fallback_flags"].append(f"segment_pipeline_error:{short_text(str(exc), 120)}")

    uniq: Dict[str, Dict[str, Any]] = {}
    for item in candidates:
        key = f"{item.get('file_id')}:{item.get('page')}:{item.get('chunk_index')}"
        prev = uniq.get(key)
        if not prev or item["score"] > prev["score"]:
            uniq[key] = item

    ranked = sorted(uniq.values(), key=lambda item: item.get("score", 0.0), reverse=True)

    context_parts: List[str] = []
    citations: List[Dict[str, Any]] = []
    retrieval_refs: List[Dict[str, Any]] = []
    used_tokens = 0

    for item in ranked:
        block_tokens = estimate_tokens(item.get("content", ""))
        if used_tokens + block_tokens > settings.DOC_CONTEXT_BUDGET_TOKENS:
            continue
        used_tokens += block_tokens

        file_id = item.get("file_id")
        page = item.get("page")
        section = item.get("section")
        segment_prefix = _format_segment_prefix(item.get("segment_type"))
        location_label = f"Page {page}" if page is not None else f"Section {section or 'N/A'}"
        block_header = f"{segment_prefix} · {location_label}" if segment_prefix else location_label
        source_mode = item.get("source_mode", "text_retrieval")
        if str(source_mode).startswith("vision") or str(source_mode).startswith("visual"):
            context_parts.append(
                f"[Visual-Focus Document: {file_id}, Anchor {block_header}]:\n{item.get('content', '')}"
            )
        else:
            context_parts.append(f"[Document: {file_id}, {block_header}]:\n{item.get('content', '')}")
        citations.append(
            {
                "file_id": file_id,
                "page": page,
                "section": section,
                "chunk_index": item.get("chunk_index"),
                "segment_type": item.get("segment_type"),
                "content": short_text(item.get("content", ""), 200),
                "source_mode": source_mode,
                "image_url": item.get("image_url"),
                "reason": item.get("visual_reason"),
            }
        )
        retrieval_refs.append(
            {
                "file_id": file_id,
                "file_name": (permitted_files_info.get(file_id) or {}).get("name", "Unknown"),
                "page": page,
                "section": section,
                "score": round(float(item.get("score", 0.0)), 4),
                "segment_type": item.get("segment_type"),
                "source_mode": source_mode,
                "image_url": item.get("image_url"),
                "reason": item.get("visual_reason"),
            }
        )

    return {
        "context_parts": context_parts,
        "citations": citations,
        "retrieval_refs": retrieval_refs,
        "semantic_failed": semantic_failed,
        "visual_hits_count": visual_hits_count,
        "retrieval_diagnostics": retrieval_diagnostics,
        "used_tokens": used_tokens,
    }
