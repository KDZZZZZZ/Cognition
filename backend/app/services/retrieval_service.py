import asyncio
import inspect
import re
from collections import defaultdict
from typing import Any, Dict, List, Optional

from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import DocumentChunk, File as FileModel
from app.services.llm_service import llm_service
from app.services.multiformat_document_service import reader_orchestrator
from app.services.tools.base import PermissionLevel
from app.services.token_budget_service import estimate_tokens, short_text
from app.services.vector_store import vector_store
from app.services.viewport_memory_service import build_viewport_memory, normalize_active_viewport
from app.services.visual_retrieval_service import visual_retrieval_service

try:
    from langdetect import detect as _langdetect_detect
except Exception:  # pragma: no cover - optional runtime dependency
    _langdetect_detect = None


def _to_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return str(value)


def _tokenize_lexical(text: str) -> List[str]:
    return [token for token in re.split(r"\W+", text.lower()) if token]


_CJK_RE = re.compile(r"[\u4e00-\u9fff]")
_ZH_EN_QUERY_HINT_MAP = {
    "论文": "paper",
    "方法": "method",
    "实验": "experiment",
    "结果": "results",
    "图": "figure",
    "表": "table",
    "结论": "conclusion",
    "推导": "derivation",
    "证明": "proof",
    "定理": "theorem",
    "定义": "definition",
    "损失": "loss",
    "模型": "model",
    "数据集": "dataset",
    "基线": "baseline",
    "对比": "comparison",
}
_EN_ZH_QUERY_HINT_MAP = {
    "paper": "论文",
    "method": "方法",
    "experiment": "实验",
    "results": "结果",
    "figure": "图",
    "table": "表",
    "conclusion": "结论",
    "proof": "证明",
    "theorem": "定理",
    "definition": "定义",
    "loss": "损失",
    "model": "模型",
    "dataset": "数据集",
    "baseline": "基线",
    "comparison": "对比",
}


def detect_query_language(query: str) -> str:
    text = str(query or "").strip()
    if not text:
        return "unknown"
    if _CJK_RE.search(text):
        return "zh"
    if _langdetect_detect:
        try:
            detected = str(_langdetect_detect(text) or "").lower().strip()
            if detected.startswith("zh"):
                return "zh"
            if detected.startswith("en"):
                return "en"
        except Exception:
            pass
    return "en"


def _rewrite_query_by_dictionary(query: str, *, source_lang: str) -> str:
    text = str(query or "").strip()
    if not text:
        return ""
    mapping = _ZH_EN_QUERY_HINT_MAP if source_lang == "zh" else _EN_ZH_QUERY_HINT_MAP
    enriched_tokens: List[str] = []
    lowered = text.lower()
    for token, translated in mapping.items():
        if token in text or token in lowered:
            enriched_tokens.append(translated)
    if not enriched_tokens:
        return ""
    deduped = []
    seen = set()
    for token in enriched_tokens:
        key = token.lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(token)
    return " ".join(deduped)


def _keyword_query(query: str) -> str:
    tokens = _tokenize_lexical(query)
    out: List[str] = []
    seen = set()
    for token in tokens:
        if len(token) < 2 or token.isdigit():
            continue
        if token in seen:
            continue
        seen.add(token)
        out.append(token)
        if len(out) >= 12:
            break
    return " ".join(out)


def build_query_bundle(query: str) -> List[Dict[str, Any]]:
    text = str(query or "").strip()
    if not text:
        return []

    language = detect_query_language(text)
    bundle: List[Dict[str, Any]] = [
        {"text": text, "lang": language, "weight": 1.0, "source": "original"},
    ]

    if settings.RAG_BILINGUAL_PARALLEL_ENABLED:
        rewritten = _rewrite_query_by_dictionary(text, source_lang=language)
        if rewritten and rewritten.lower() != text.lower():
            bundle.append(
                {
                    "text": rewritten,
                    "lang": "en" if language == "zh" else "zh",
                    "weight": 0.72,
                    "source": "rewrite",
                }
            )

    keyword_text = _keyword_query(text)
    if keyword_text and keyword_text.lower() != text.lower():
        bundle.append({"text": keyword_text, "lang": language, "weight": 0.45, "source": "rewrite"})

    normalized: List[Dict[str, Any]] = []
    seen_text = set()
    for item in bundle:
        key = str(item.get("text") or "").strip().lower()
        if not key or key in seen_text:
            continue
        seen_text.add(key)
        normalized.append(item)
    return normalized


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
    active_visible_unit: Optional[str] = None,
    active_visible_start: Optional[int] = None,
    active_visible_end: Optional[int] = None,
    active_anchor_block_id: Optional[str] = None,
) -> Dict[str, Any]:
    viewport_hint = get_viewport_context(session_id, active_file_id)
    if inspect.isawaitable(viewport_hint):
        viewport_hint = await viewport_hint

    viewport_ctx = await normalize_active_viewport(
        db=db,
        session_id=session_id,
        active_file_id=active_file_id,
        active_page=active_page,
        active_visible_unit=active_visible_unit,
        active_visible_start=active_visible_start,
        active_visible_end=active_visible_end,
        active_anchor_block_id=active_anchor_block_id,
    )
    if not viewport_ctx and isinstance(viewport_hint, dict):
        viewport_ctx = dict(viewport_hint)
    if not viewport_ctx:
        return {"viewport": None, "excerpt": None}

    effective_file_id = str(viewport_ctx.get("file_id") or active_file_id or "").strip() or None
    effective_page = active_page
    if effective_page is None:
        try:
            page_raw = viewport_ctx.get("page")
            effective_page = int(page_raw) if page_raw is not None else None
        except Exception:
            effective_page = None

    visible_range = viewport_ctx.get("visible_range")
    visible_start = active_visible_start
    visible_end = active_visible_end
    if (
        visible_start is None
        and visible_end is None
        and isinstance(visible_range, list)
        and len(visible_range) >= 2
    ):
        try:
            visible_start = int(visible_range[0])
            visible_end = int(visible_range[1])
        except Exception:
            visible_start = None
            visible_end = None

    viewport_memory = await build_viewport_memory(
        db=db,
        session_id=session_id,
        context_permissions=context_permissions,
        active_file_id=effective_file_id,
        active_page=effective_page,
        active_visible_unit=active_visible_unit or viewport_ctx.get("visible_unit"),
        active_visible_start=visible_start,
        active_visible_end=visible_end,
        active_anchor_block_id=active_anchor_block_id,
        require_effective_note_view=True,
    )
    excerpt = viewport_memory.get("memory_text")
    if not excerpt and effective_file_id:
        permission = context_permissions.get(effective_file_id, PermissionLevel.READ)
        if permission != PermissionLevel.NONE:
            chunk_query = select(DocumentChunk).where(DocumentChunk.file_id == effective_file_id)
            if effective_page is not None:
                chunk_query = chunk_query.where(DocumentChunk.page == effective_page)
            chunk_query = chunk_query.order_by(DocumentChunk.page, DocumentChunk.chunk_index).limit(6)
            chunk_rows = (await db.execute(chunk_query)).scalars().all()
            merged = "\n".join(str(row.content or "").strip() for row in chunk_rows if str(row.content or "").strip())
            excerpt = merged.strip() or None

    return {
        "viewport": viewport_memory.get("viewport") or viewport_ctx,
        "excerpt": excerpt,
    }


def get_viewport_context(session_id: str, file_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    # Compatibility hook kept for tests and legacy monkeypatching.
    if not str(session_id or "").strip():
        return None
    if file_id:
        return {"file_id": file_id}
    return None


async def _retrieve_context_blocks_single(
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
                "chunk_index": item.get("chunk_index"),
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


def build_evidence_cards(
    citations: List[Dict[str, Any]],
    *,
    map_batch_size: Optional[int] = None,
) -> Dict[str, Any]:
    if not citations:
        return {"cards": [], "stop_reason": "no_candidates"}

    batch_size = max(1, int(map_batch_size or settings.RAG_MAP_BATCH_SIZE or 10))
    cards: List[Dict[str, Any]] = []
    added = 0
    low_gain_batches = 0
    i = 0
    while i < len(citations):
        batch = citations[i : i + batch_size]
        batch_new = 0
        for item in batch:
            content = short_text(str(item.get("content") or ""), 220)
            if not content:
                continue
            page = item.get("page")
            section = item.get("section")
            cards.append(
                {
                    "claim": content,
                    "condition": f"page={page}" if page is not None else f"section={section or 'N/A'}",
                    "source": {
                        "file_id": item.get("file_id"),
                        "page": page,
                        "section": section,
                        "segment_type": item.get("segment_type"),
                        "source_mode": item.get("source_mode"),
                    },
                }
            )
            batch_new += 1
            added += 1

        if batch_new < 2:
            low_gain_batches += 1
        else:
            low_gain_batches = 0

        if low_gain_batches >= 2:
            return {"cards": cards, "stop_reason": "marginal_gain_stop"}
        i += batch_size

    return {"cards": cards, "stop_reason": "exhausted_candidates"}


def _merge_query_results(
    *,
    per_query_results: List[Dict[str, Any]],
    query_bundle: List[Dict[str, Any]],
) -> Dict[str, Any]:
    if not per_query_results:
        return {
            "context_parts": [],
            "citations": [],
            "retrieval_refs": [],
            "semantic_failed": True,
            "visual_hits_count": 0,
            "retrieval_diagnostics": {
                "text_hits": 0,
                "image_hits": 0,
                "fused_hits": 0,
                "fallback_flags": ["no_query_results"],
            },
            "used_tokens": 0,
            "retrieval_meta": {
                "query_bundle": query_bundle,
                "candidate_count": 0,
                "reranked_count": 0,
                "evidence_count": 0,
                "stop_reason": "no_candidates",
            },
            "evidence_cards": [],
        }

    weighted_refs: Dict[str, Dict[str, Any]] = {}
    candidate_count = 0
    merged_diagnostics = defaultdict(int)
    merged_fallback_flags: List[str] = []
    visual_hits_count = 0
    semantic_failed = False

    for idx, result in enumerate(per_query_results):
        query_weight = 1.0
        if idx < len(query_bundle):
            try:
                query_weight = float(query_bundle[idx].get("weight") or 1.0)
            except Exception:
                query_weight = 1.0
        refs = result.get("retrieval_refs") or []
        candidate_count += len(refs)
        diagnostics = result.get("retrieval_diagnostics") or {}
        for key in ("text_hits", "image_hits", "fused_hits"):
            merged_diagnostics[key] += int(diagnostics.get(key) or 0)
        merged_fallback_flags.extend(diagnostics.get("fallback_flags") or [])
        visual_hits_count += int(result.get("visual_hits_count") or 0)
        semantic_failed = semantic_failed or bool(result.get("semantic_failed"))

        citation_lookup: Dict[str, Dict[str, Any]] = {}
        for citation in result.get("citations") or []:
            key = f"{citation.get('file_id')}:{citation.get('page')}:{citation.get('chunk_index')}"
            citation_lookup[key] = citation

        for ref in refs:
            key = f"{ref.get('file_id')}:{ref.get('page')}:{ref.get('chunk_index')}"
            score = float(ref.get("score") or 0.0) * query_weight
            existing = weighted_refs.get(key)
            if not existing or score > float(existing.get("score") or 0.0):
                citation = citation_lookup.get(key) or {}
                weighted_refs[key] = {
                    "file_id": ref.get("file_id"),
                    "file_name": ref.get("file_name"),
                    "page": ref.get("page"),
                    "section": ref.get("section"),
                    "chunk_index": ref.get("chunk_index"),
                    "score": score,
                    "segment_type": ref.get("segment_type"),
                    "source_mode": ref.get("source_mode"),
                    "image_url": ref.get("image_url"),
                    "reason": ref.get("reason"),
                    "content": citation.get("content") or "",
                }

    sorted_refs = sorted(weighted_refs.values(), key=lambda item: float(item.get("score") or 0.0), reverse=True)
    top_refs = sorted_refs[: max(1, int(settings.RAG_RERANK_TOPN or 60))]

    context_parts: List[str] = []
    citations: List[Dict[str, Any]] = []
    retrieval_refs: List[Dict[str, Any]] = []
    used_tokens = 0
    stop_reason = "exhausted_candidates"
    for ref in top_refs:
        content = str(ref.get("content") or "").strip()
        if not content:
            continue
        block_tokens = estimate_tokens(content)
        if used_tokens + block_tokens > int(settings.DOC_CONTEXT_BUDGET_TOKENS):
            stop_reason = "budget_limit"
            break
        used_tokens += block_tokens

        page = ref.get("page")
        section = ref.get("section")
        segment_prefix = _format_segment_prefix(ref.get("segment_type"))
        location_label = f"Page {page}" if page is not None else f"Section {section or 'N/A'}"
        block_header = f"{segment_prefix} · {location_label}" if segment_prefix else location_label
        source_mode = ref.get("source_mode", "text_retrieval")
        if str(source_mode).startswith("vision") or str(source_mode).startswith("visual"):
            context_parts.append(f"[Visual-Focus Document: {ref.get('file_id')}, Anchor {block_header}]:\n{content}")
        else:
            context_parts.append(f"[Document: {ref.get('file_id')}, {block_header}]:\n{content}")
        citations.append(
            {
                "file_id": ref.get("file_id"),
                "page": page,
                "section": section,
                "chunk_index": ref.get("chunk_index"),
                "segment_type": ref.get("segment_type"),
                "content": short_text(content, 200),
                "source_mode": source_mode,
                "image_url": ref.get("image_url"),
                "reason": ref.get("reason"),
            }
        )
        retrieval_refs.append(
            {
                "file_id": ref.get("file_id"),
                "file_name": ref.get("file_name"),
                "page": page,
                "section": section,
                "score": round(float(ref.get("score") or 0.0), 4),
                "segment_type": ref.get("segment_type"),
                "source_mode": source_mode,
                "image_url": ref.get("image_url"),
                "reason": ref.get("reason"),
            }
        )

    evidence = build_evidence_cards(citations, map_batch_size=settings.RAG_MAP_BATCH_SIZE)
    if stop_reason == "exhausted_candidates" and evidence.get("stop_reason"):
        stop_reason = str(evidence.get("stop_reason"))

    return {
        "context_parts": context_parts,
        "citations": citations,
        "retrieval_refs": retrieval_refs,
        "semantic_failed": semantic_failed,
        "visual_hits_count": visual_hits_count,
        "retrieval_diagnostics": {
            "text_hits": merged_diagnostics["text_hits"],
            "image_hits": merged_diagnostics["image_hits"],
            "fused_hits": merged_diagnostics["fused_hits"],
            "fallback_flags": merged_fallback_flags,
        },
        "used_tokens": used_tokens,
        "retrieval_meta": {
            "query_bundle": query_bundle,
            "candidate_count": candidate_count,
            "reranked_count": len(top_refs),
            "evidence_count": len(evidence.get("cards") or []),
            "stop_reason": stop_reason,
        },
        "evidence_cards": evidence.get("cards") or [],
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
    query_bundle = build_query_bundle(query)
    if not query_bundle:
        query_bundle = [{"text": str(query or ""), "lang": "unknown", "weight": 1.0, "source": "original"}]

    if not settings.RAG_BILINGUAL_PARALLEL_ENABLED or len(query_bundle) <= 1:
        single = await _retrieve_context_blocks_single(
            db=db,
            query=query,
            readable_files=readable_files,
            permitted_files_info=permitted_files_info,
            active_file_id=active_file_id,
            active_page=active_page,
        )
        evidence = build_evidence_cards(single.get("citations") or [], map_batch_size=settings.RAG_MAP_BATCH_SIZE)
        single["retrieval_meta"] = {
            "query_bundle": query_bundle,
            "candidate_count": len(single.get("retrieval_refs") or []),
            "reranked_count": len(single.get("retrieval_refs") or []),
            "evidence_count": len(evidence.get("cards") or []),
            "stop_reason": str(evidence.get("stop_reason") or "single_query"),
        }
        single["evidence_cards"] = evidence.get("cards") or []
        return single

    # AsyncSession is not safe for concurrent query execution on the same session.
    # Run bundle retrievals sequentially and fuse afterwards.
    results: List[Dict[str, Any]] = []
    for item in query_bundle:
        result = await _retrieve_context_blocks_single(
            db=db,
            query=str(item.get("text") or query),
            readable_files=readable_files,
            permitted_files_info=permitted_files_info,
            active_file_id=active_file_id,
            active_page=active_page,
        )
        results.append(result)
    return _merge_query_results(per_query_results=results, query_bundle=query_bundle)
