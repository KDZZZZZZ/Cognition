"""
Search-related agent tools.
"""
from typing import Dict, Any, List
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.tools.base import (
    BaseTool,
    ToolContext,
    ToolResult,
    PermissionLevel,
    ToolValidationError
)
from app.models import File
from app.services.tools.middleware import permission_middleware


class SearchDocumentsTool(BaseTool):
    """
    Search for content across documents using vector similarity.

    Requires: READ permission
    Filters: Only searches in files with READ or WRITE permission
    """

    @property
    def name(self) -> str:
        return "search_documents"

    @property
    def description(self) -> str:
        return "Search for relevant content across documents using semantic search. Returns the most relevant passages with their locations (file name, page number)."

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
                    "description": "The search query - what you're looking for in the documents"
                },
                "file_ids": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional list of file IDs to search in. If not provided, searches all accessible files."
                },
                "n_results": {
                    "type": "integer",
                    "description": "Maximum number of results to return",
                    "default": 5,
                    "minimum": 1,
                    "maximum": 20
                }
            },
            "required": ["query"]
        }

    def validate_arguments(self, arguments: Dict[str, Any]) -> None:
        super().validate_arguments(arguments)

        query = arguments.get("query", "")
        if len(query.strip()) == 0:
            raise ToolValidationError(
                self.name, "query", "Query cannot be empty"
            )

        if len(query) > 1000:
            raise ToolValidationError(
                self.name, "query", "Query too long (max 1000 characters)"
            )

        n_results = arguments.get("n_results", 5)
        if not isinstance(n_results, int) or not 1 <= n_results <= 20:
            raise ToolValidationError(
                self.name, "n_results", "n_results must be between 1 and 20"
            )

    async def execute(self, arguments: Dict[str, Any], context: ToolContext) -> ToolResult:
        query = arguments["query"]
        file_ids = arguments.get("file_ids")
        n_results = arguments.get("n_results", 5)

        # Import here to avoid circular dependency
        from app.services.llm_service import llm_service
        from app.services.vector_store import vector_store

        try:
            # Get query embedding
            query_embedding = await llm_service.get_embedding(query)

            # Determine which files to search
            if file_ids:
                # Filter by permissions
                searchable_files = permission_middleware.filter_readable_files(
                    file_ids, context
                )

                if not searchable_files:
                    return ToolResult(
                        success=False,
                        error="No readable files found in the specified file list",
                        error_code="NO_ACCESSIBLE_FILES"
                    )
            else:
                # Search all readable files
                searchable_files = [
                    fid for fid, perm in context.permissions.items()
                    if perm in (PermissionLevel.READ, PermissionLevel.WRITE)
                ]

            # Perform vector search
            results = []

            if searchable_files:
                # Search in each file separately to respect permissions
                for file_id in searchable_files:
                    search_results = await vector_store.search(
                        query_embedding=query_embedding,
                        n_results=n_results,
                        file_id=file_id
                    )

                    if search_results and search_results.get("documents"):
                        # Get file info for better display
                        file_result = await context.db.execute(
                            select(File).where(File.id == file_id)
                        )
                        file = file_result.scalar_one_or_none()
                        file_name = file.name if file else "Unknown"

                        for i, doc in enumerate(search_results["documents"][0]):
                            metadata = search_results["metadatas"][0][i]

                            results.append({
                                "file_id": metadata["file_id"],
                                "file_name": file_name,
                                "page": metadata.get("page"),
                                "chunk_index": metadata.get("chunk_index"),
                                "content": doc,
                                "score": search_results.get("distances", [[0]])[0][i] if search_results.get("distances") else None
                            })

            # Sort by score and limit results
            if results:
                results.sort(key=lambda r: r.get("score", 1))
                results = results[:n_results]

            return ToolResult(
                success=True,
                data={
                    "query": query,
                    "results": results,
                    "count": len(results),
                    "searched_files": searchable_files
                }
            )

        except Exception as e:
            return ToolResult(
                success=False,
                error=f"Search failed: {str(e)}",
                error_code="SEARCH_ERROR"
            )
