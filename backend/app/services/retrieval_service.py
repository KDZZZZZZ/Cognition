import re
from typing import Any, Dict, List, Optional

from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.viewport import get_viewport_context
from app.config import settings
from app.models import DocumentChunk, File as FileModel
from app.services.llm_service import llm_service
from app.services.tools.base import PermissionLevel
from app.services.token_budget_service import estimate_tokens, short_text
from app.services.vector_store import vector_store


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
    if file_row.file_type.value == "pdf":
        chunks_result = await db.execute(
            select(DocumentChunk)
            .where(and_(DocumentChunk.file_id == file_id, DocumentChunk.page == page))
            .order_by(DocumentChunk.chunk_index)
        )
        chunks = chunks_result.scalars().all()
        text = "\n".join(chunk.content for chunk in chunks)
        if text:
            excerpt = text[: settings.VIEWPORT_EXCERPT_MAX_CHARS]
    elif file_row.file_type.value in ("md", "txt", "code"):
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
            "file_type": file_row.file_type.value,
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
        return {"context_parts": [], "citations": [], "retrieval_refs": []}

    candidates: List[Dict[str, Any]] = []
    query_tokens = _tokenize_lexical(query)
    semantic_failed = False

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
        context_parts.append(f"[Document: {file_id}, Page {page}]:\n{item.get('content', '')}")
        citations.append(
            {
                "file_id": file_id,
                "page": page,
                "chunk_index": item.get("chunk_index"),
                "content": short_text(item.get("content", ""), 200),
            }
        )
        retrieval_refs.append(
            {
                "file_id": file_id,
                "file_name": (permitted_files_info.get(file_id) or {}).get("name", "Unknown"),
                "page": page,
                "score": round(float(item.get("score", 0.0)), 4),
            }
        )

    return {
        "context_parts": context_parts,
        "citations": citations,
        "retrieval_refs": retrieval_refs,
        "semantic_failed": semantic_failed,
        "used_tokens": used_tokens,
    }
