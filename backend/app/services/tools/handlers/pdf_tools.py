import re
from collections import Counter
from typing import Any, Dict, List, Optional

from sqlalchemy import and_, select

from app.api.viewport import get_viewport_context
from app.models import DocumentChunk, File
from app.services.tools.base import BaseTool, PermissionLevel, ToolContext, ToolResult, ToolValidationError


def _tokens(text: str) -> List[str]:
    return [t for t in re.split(r"\W+", text.lower()) if t]


def _lexical_score(query: str, text: str) -> float:
    q = _tokens(query)
    if not q:
        return 0.0
    c = Counter(_tokens(text))
    return float(sum(c.get(t, 0) for t in q))


async def _load_pdf_file(context: ToolContext, file_id: str) -> Optional[File]:
    result = await context.db.execute(
        select(File).where(File.id == file_id, File.file_type == "pdf")
    )
    return result.scalar_one_or_none()


class GetPdfMetadataTool(BaseTool):
    @property
    def name(self) -> str:
        return "get_pdf_metadata"

    @property
    def description(self) -> str:
        return "Get PDF metadata including page count and basic file info."

    @property
    def required_permission(self) -> PermissionLevel:
        return PermissionLevel.READ

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "file_id": {"type": "string", "description": "PDF file ID"},
            },
            "required": ["file_id"],
        }

    async def execute(self, arguments: Dict[str, Any], context: ToolContext) -> ToolResult:
        file_id = arguments["file_id"]
        file = await _load_pdf_file(context, file_id)
        if not file:
            return ToolResult(success=False, error="PDF file not found", error_code="FILE_NOT_FOUND")

        return ToolResult(
            success=True,
            data={
                "file_id": file.id,
                "file_name": file.name,
                "page_count": file.page_count or 0,
                "size": file.size,
                "metadata": file.meta or {},
            },
        )


class ReadPdfPagesTool(BaseTool):
    @property
    def name(self) -> str:
        return "read_pdf_pages"

    @property
    def description(self) -> str:
        return "Read page content from a PDF by page range."

    @property
    def required_permission(self) -> PermissionLevel:
        return PermissionLevel.READ

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "file_id": {"type": "string", "description": "PDF file ID"},
                "page_start": {"type": "integer", "description": "Start page (1-based)"},
                "page_end": {"type": "integer", "description": "End page (1-based)"},
                "max_chars_per_page": {
                    "type": "integer",
                    "description": "Optional char cap per page",
                    "default": 4000,
                },
            },
            "required": ["file_id", "page_start", "page_end"],
        }

    def validate_arguments(self, arguments: Dict[str, Any]) -> None:
        super().validate_arguments(arguments)
        page_start = arguments.get("page_start", 1)
        page_end = arguments.get("page_end", 1)
        if page_start < 1 or page_end < 1:
            raise ToolValidationError(self.name, "page_start/page_end", "Page numbers must be >= 1")
        if page_start > page_end:
            raise ToolValidationError(self.name, "page_start/page_end", "page_start must be <= page_end")

    async def execute(self, arguments: Dict[str, Any], context: ToolContext) -> ToolResult:
        file_id = arguments["file_id"]
        page_start = arguments["page_start"]
        page_end = arguments["page_end"]
        max_chars_per_page = arguments.get("max_chars_per_page", 4000)

        file = await _load_pdf_file(context, file_id)
        if not file:
            return ToolResult(success=False, error="PDF file not found", error_code="FILE_NOT_FOUND")

        page_count = file.page_count or 0
        if page_count > 0 and (page_start > page_count or page_end > page_count):
            return ToolResult(
                success=False,
                error=f"Page out of range. page_count={page_count}",
                error_code="PAGE_OUT_OF_RANGE",
            )

        chunks_result = await context.db.execute(
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

        page_map: Dict[int, List[str]] = {}
        for chunk in chunks:
            page_map.setdefault(chunk.page, []).append(chunk.content)

        pages = []
        for page_no in range(page_start, page_end + 1):
            text = "\n".join(page_map.get(page_no, []))
            if max_chars_per_page and len(text) > max_chars_per_page:
                text = text[:max_chars_per_page]
            pages.append({"page": page_no, "content": text})

        return ToolResult(
            success=True,
            data={
                "file_id": file.id,
                "file_name": file.name,
                "page_start": page_start,
                "page_end": page_end,
                "pages": pages,
            },
        )


class SearchPdfPassagesTool(BaseTool):
    @property
    def name(self) -> str:
        return "search_pdf_passages"

    @property
    def description(self) -> str:
        return (
            "Search passages in a PDF. Uses embeddings first; when unavailable, "
            "falls back to lexical search."
        )

    @property
    def required_permission(self) -> PermissionLevel:
        return PermissionLevel.READ

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "file_id": {"type": "string", "description": "PDF file ID"},
                "query": {"type": "string", "description": "Search query"},
                "top_k": {"type": "integer", "description": "Max results", "default": 5},
                "page_start": {"type": "integer", "description": "Optional start page"},
                "page_end": {"type": "integer", "description": "Optional end page"},
            },
            "required": ["file_id", "query"],
        }

    async def execute(self, arguments: Dict[str, Any], context: ToolContext) -> ToolResult:
        from app.services.llm_service import llm_service
        from app.services.vector_store import vector_store

        file_id = arguments["file_id"]
        query = arguments["query"]
        top_k = arguments.get("top_k", 5)
        page_start = arguments.get("page_start")
        page_end = arguments.get("page_end")

        file = await _load_pdf_file(context, file_id)
        if not file:
            return ToolResult(success=False, error="PDF file not found", error_code="FILE_NOT_FOUND")

        results: List[Dict[str, Any]] = []
        fallback_used = False

        try:
            embedding = await llm_service.get_embedding(query)
            semantic = await vector_store.search(
                query_embedding=embedding,
                n_results=top_k,
                file_id=file_id,
            )
            if semantic and semantic.get("documents"):
                docs = semantic["documents"][0]
                metadatas = semantic.get("metadatas", [[]])[0]
                distances = semantic.get("distances", [[]])[0]
                for i, doc in enumerate(docs):
                    metadata = metadatas[i] if i < len(metadatas) else {}
                    page = metadata.get("page")
                    if page_start and page and page < page_start:
                        continue
                    if page_end and page and page > page_end:
                        continue
                    results.append(
                        {
                            "file_id": file_id,
                            "file_name": file.name,
                            "page": page,
                            "chunk_index": metadata.get("chunk_index"),
                            "content": doc,
                            "score": distances[i] if i < len(distances) else None,
                            "source_mode": "embedding",
                        }
                    )
        except Exception as e:
            print(f"Warning: PDF semantic search failed, fallback lexical: {e}")
            fallback_used = True

        if not results:
            chunks_query = select(DocumentChunk).where(DocumentChunk.file_id == file_id)
            if page_start is not None:
                chunks_query = chunks_query.where(DocumentChunk.page >= page_start)
            if page_end is not None:
                chunks_query = chunks_query.where(DocumentChunk.page <= page_end)
            chunks_query = chunks_query.order_by(DocumentChunk.page, DocumentChunk.chunk_index)

            chunks_result = await context.db.execute(chunks_query)
            chunks = chunks_result.scalars().all()

            lexical = []
            for chunk in chunks:
                score = _lexical_score(query, chunk.content)
                if score <= 0:
                    continue
                lexical.append(
                    {
                        "file_id": file_id,
                        "file_name": file.name,
                        "page": chunk.page,
                        "chunk_index": chunk.chunk_index,
                        "content": chunk.content,
                        "score": score,
                        "source_mode": "lexical",
                    }
                )
            lexical.sort(key=lambda item: item.get("score", 0), reverse=True)
            results = lexical[:top_k]
            fallback_used = True

        return ToolResult(
            success=True,
            data={
                "file_id": file_id,
                "file_name": file.name,
                "query": query,
                "results": results[:top_k],
                "count": len(results[:top_k]),
                "fallback_used": fallback_used,
            },
        )


class ReadVisiblePdfContextTool(BaseTool):
    @property
    def name(self) -> str:
        return "read_visible_pdf_context"

    @property
    def description(self) -> str:
        return "Read content from the PDF page currently visible in the user's viewport."

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {"type": "object", "properties": {}}

    async def execute(self, arguments: Dict[str, Any], context: ToolContext) -> ToolResult:
        viewport = get_viewport_context(context.session_id)
        if not viewport:
            return ToolResult(
                success=False,
                error="No viewport context available",
                error_code="NO_VIEWPORT_CONTEXT",
            )

        file_id = viewport.get("file_id")
        page = int(viewport.get("page") or 1)
        if not file_id:
            return ToolResult(success=False, error="Viewport missing file_id", error_code="INVALID_VIEWPORT")

        permission = context.permissions.get(file_id, PermissionLevel.READ)
        if permission == PermissionLevel.NONE:
            return ToolResult(
                success=False,
                error="No permission to read current visible PDF",
                error_code="PERMISSION_DENIED",
            )

        file = await _load_pdf_file(context, file_id)
        if not file:
            return ToolResult(success=False, error="Visible file is not a PDF", error_code="FILE_NOT_FOUND")

        chunks_result = await context.db.execute(
            select(DocumentChunk)
            .where(DocumentChunk.file_id == file_id, DocumentChunk.page == page)
            .order_by(DocumentChunk.chunk_index)
        )
        chunks = chunks_result.scalars().all()
        text = "\n".join(chunk.content for chunk in chunks)

        return ToolResult(
            success=True,
            data={
                "file_id": file_id,
                "file_name": file.name,
                "page": page,
                "content": text,
            },
        )
