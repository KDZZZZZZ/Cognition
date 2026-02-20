import re
from collections import Counter
from typing import Any, Dict, List

from sqlalchemy import select

from app.models import DocumentChunk, File
from app.services.tools.base import BaseTool, PermissionLevel, ToolContext, ToolResult, ToolValidationError
from app.services.tools.middleware import permission_middleware


def _tokenize(text: str) -> List[str]:
    return [token for token in re.split(r"\W+", text.lower()) if token]


def _lexical_score(query_tokens: List[str], content: str) -> float:
    if not query_tokens:
        return 0.0
    content_tokens = _tokenize(content)
    counts = Counter(content_tokens)
    score = 0.0
    for token in query_tokens:
        score += counts.get(token, 0)
    return score


class SearchDocumentsTool(BaseTool):
    @property
    def name(self) -> str:
        return "search_documents"

    @property
    def description(self) -> str:
        return (
            "Search relevant passages across accessible documents. "
            "Uses semantic search first and falls back to lexical search when embeddings are unavailable."
        )

    @property
    def required_permission(self) -> PermissionLevel:
        return PermissionLevel.READ

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query text",
                },
                "file_ids": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional file IDs to search in",
                },
                "n_results": {
                    "type": "integer",
                    "description": "Max number of results",
                    "default": 5,
                    "minimum": 1,
                    "maximum": 20,
                },
            },
            "required": ["query"],
        }

    def validate_arguments(self, arguments: Dict[str, Any]) -> None:
        super().validate_arguments(arguments)
        query = arguments.get("query", "")
        if not query.strip():
            raise ToolValidationError(self.name, "query", "Query cannot be empty")
        if len(query) > 1000:
            raise ToolValidationError(self.name, "query", "Query too long (max 1000 chars)")

        n_results = arguments.get("n_results", 5)
        if not isinstance(n_results, int) or not (1 <= n_results <= 20):
            raise ToolValidationError(self.name, "n_results", "n_results must be between 1 and 20")

    async def _resolve_searchable_files(self, arguments: Dict[str, Any], context: ToolContext) -> List[str]:
        file_ids = arguments.get("file_ids")
        if file_ids:
            readable = permission_middleware.filter_readable_files(file_ids, context)
            if not readable:
                raise ValueError("No readable files found in specified file_ids")
            return readable

        return [
            fid
            for fid, perm in context.permissions.items()
            if perm in (PermissionLevel.READ, PermissionLevel.WRITE)
        ]

    async def _semantic_search(
        self,
        query: str,
        searchable_files: List[str],
        n_results: int,
        context: ToolContext,
    ) -> List[Dict[str, Any]]:
        from app.services.llm_service import llm_service
        from app.services.vector_store import vector_store

        query_embedding = await llm_service.get_embedding(query)
        rows: List[Dict[str, Any]] = []
        for file_id in searchable_files:
            file_result = await context.db.execute(select(File).where(File.id == file_id))
            file = file_result.scalar_one_or_none()
            file_name = file.name if file else "Unknown"

            search_results = await vector_store.search(
                query_embedding=query_embedding,
                n_results=n_results,
                file_id=file_id,
            )
            if not search_results or not search_results.get("documents"):
                continue

            docs = search_results["documents"][0]
            metadatas = search_results.get("metadatas", [[]])[0]
            distances = search_results.get("distances", [[]])[0]
            for i, doc in enumerate(docs):
                metadata = metadatas[i] if i < len(metadatas) else {}
                score = distances[i] if i < len(distances) else None
                rows.append(
                    {
                        "file_id": metadata.get("file_id", file_id),
                        "file_name": file_name,
                        "page": metadata.get("page"),
                        "chunk_index": metadata.get("chunk_index"),
                        "content": doc,
                        "score": score,
                        "source_mode": "embedding",
                    }
                )

        rows.sort(key=lambda item: item.get("score", 999999) if item.get("score") is not None else 999999)
        return rows[:n_results]

    async def _lexical_search(
        self,
        query: str,
        searchable_files: List[str],
        n_results: int,
        context: ToolContext,
    ) -> List[Dict[str, Any]]:
        query_tokens = _tokenize(query)
        if not query_tokens:
            return []

        rows: List[Dict[str, Any]] = []
        for file_id in searchable_files:
            file_result = await context.db.execute(select(File).where(File.id == file_id))
            file = file_result.scalar_one_or_none()
            file_name = file.name if file else "Unknown"

            chunks_result = await context.db.execute(
                select(DocumentChunk)
                .where(DocumentChunk.file_id == file_id)
                .order_by(DocumentChunk.page, DocumentChunk.chunk_index)
            )
            chunks = chunks_result.scalars().all()

            for chunk in chunks:
                score = _lexical_score(query_tokens, chunk.content)
                if score <= 0:
                    continue
                rows.append(
                    {
                        "file_id": file_id,
                        "file_name": file_name,
                        "page": chunk.page,
                        "chunk_index": chunk.chunk_index,
                        "content": chunk.content,
                        "score": score,
                        "source_mode": "lexical",
                    }
                )

        rows.sort(key=lambda item: item.get("score", 0), reverse=True)
        return rows[:n_results]

    async def execute(self, arguments: Dict[str, Any], context: ToolContext) -> ToolResult:
        query = arguments["query"]
        n_results = arguments.get("n_results", 5)

        try:
            searchable_files = await self._resolve_searchable_files(arguments, context)
        except ValueError as e:
            return ToolResult(success=False, error=str(e), error_code="NO_ACCESSIBLE_FILES")

        if not searchable_files:
            return ToolResult(
                success=True,
                data={
                    "query": query,
                    "results": [],
                    "count": 0,
                    "searched_files": [],
                    "fallback_used": False,
                },
            )

        fallback_used = False
        try:
            results = await self._semantic_search(query, searchable_files, n_results, context)
        except Exception as semantic_error:
            print(f"Warning: semantic search failed, fallback to lexical search: {semantic_error}")
            results = []
            fallback_used = True

        if not results:
            lexical_results = await self._lexical_search(query, searchable_files, n_results, context)
            if lexical_results:
                results = lexical_results
                fallback_used = True

        return ToolResult(
            success=True,
            data={
                "query": query,
                "results": results,
                "count": len(results),
                "searched_files": searchable_files,
                "fallback_used": fallback_used,
            },
        )
