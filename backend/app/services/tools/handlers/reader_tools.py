from typing import Any, Dict, List, Optional

from sqlalchemy import and_, select

from app.models import DocumentSegment, FileIndexStatus, File as FileModel
from app.services.multiformat_document_service import reader_orchestrator
from app.services.tools.base import (
    BaseTool,
    PermissionLevel,
    ToolContext,
    ToolResult,
    ToolValidationError,
)
from app.services.tools.middleware import permission_middleware


class GetDocumentOutlineTool(BaseTool):
    @property
    def name(self) -> str:
        return "get_document_outline"

    @property
    def description(self) -> str:
        return "Get document outline (sections/pages) to plan reading path."

    @property
    def required_permission(self) -> PermissionLevel:
        return PermissionLevel.READ

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "file_id": {"type": "string", "description": "Target file ID"},
            },
            "required": ["file_id"],
        }

    async def execute(self, arguments: Dict[str, Any], context: ToolContext) -> ToolResult:
        file_id = arguments["file_id"]
        outline = await reader_orchestrator.get_outline(db=context.db, file_id=file_id)
        return ToolResult(success=True, data={"file_id": file_id, "outline": outline, "count": len(outline)})


class LocateRelevantSegmentsTool(BaseTool):
    @property
    def name(self) -> str:
        return "locate_relevant_segments"

    @property
    def description(self) -> str:
        return "Locate relevant segments across md/pdf/web documents using fused retrieval."

    @property
    def required_permission(self) -> PermissionLevel:
        return PermissionLevel.READ

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
                "file_id": {"type": "string", "description": "Optional target file ID"},
                "page_start": {
                    "type": "integer",
                    "description": "Optional page start (inclusive), useful for PDF scoped retrieval",
                },
                "page_end": {
                    "type": "integer",
                    "description": "Optional page end (inclusive), useful for PDF scoped retrieval",
                },
                "source_types": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional source types filter: md/pdf/web",
                },
                "top_k": {"type": "integer", "default": 8, "minimum": 1, "maximum": 30},
            },
            "required": ["query"],
        }

    def validate_arguments(self, arguments: Dict[str, Any]) -> None:
        super().validate_arguments(arguments)
        query = str(arguments.get("query") or "").strip()
        if not query:
            raise ToolValidationError(self.name, "query", "query cannot be empty")
        top_k = int(arguments.get("top_k", 8))
        if top_k < 1 or top_k > 30:
            raise ToolValidationError(self.name, "top_k", "top_k must be in [1,30]")
        page_start = arguments.get("page_start")
        page_end = arguments.get("page_end")
        if page_start is not None and int(page_start) < 1:
            raise ToolValidationError(self.name, "page_start", "page_start must be >= 1")
        if page_end is not None and int(page_end) < 1:
            raise ToolValidationError(self.name, "page_end", "page_end must be >= 1")
        if page_start is not None and page_end is not None and int(page_start) > int(page_end):
            raise ToolValidationError(self.name, "page_start/page_end", "page_start must be <= page_end")

    async def execute(self, arguments: Dict[str, Any], context: ToolContext) -> ToolResult:
        query = arguments["query"]
        file_id = arguments.get("file_id")
        page_start = arguments.get("page_start")
        page_end = arguments.get("page_end")
        source_types = arguments.get("source_types")
        top_k = int(arguments.get("top_k", 8))

        if file_id:
            file_ids = permission_middleware.filter_readable_files([file_id], context)
        else:
            file_ids = [
                fid for fid, perm in context.permissions.items()
                if perm in (PermissionLevel.READ, PermissionLevel.WRITE)
            ]

        result = await reader_orchestrator.locate_relevant_segments(
            db=context.db,
            query=query,
            file_ids=file_ids,
            source_types=source_types,
            top_k=top_k,
            page_start=int(page_start) if page_start is not None else None,
            page_end=int(page_end) if page_end is not None else None,
        )
        hits = result.get("hits", [])
        diagnostics = result.get("diagnostics", {})

        payload = [
            {
                "segment_id": hit.segment_id,
                "file_id": hit.file_id,
                "page": hit.page,
                "section": hit.section,
                "source_type": hit.source_type,
                "segment_type": getattr(hit, "segment_type", None),
                "score": round(float(hit.score), 5),
                "source_mode": hit.source_mode,
                "reason": hit.reason,
                "text": hit.text[:300],
            }
            for hit in hits
        ]
        return ToolResult(
            success=True,
            data={
                "query": query,
                "page_start": int(page_start) if page_start is not None else None,
                "page_end": int(page_end) if page_end is not None else None,
                "hits": payload,
                "count": len(payload),
                "diagnostics": diagnostics,
            },
        )


class ReadDocumentSegmentsTool(BaseTool):
    @property
    def name(self) -> str:
        return "read_document_segments"

    @property
    def description(self) -> str:
        return "Read local deep-dive segment blocks by segment IDs or anchors."

    @property
    def required_permission(self) -> PermissionLevel:
        return PermissionLevel.READ

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "file_id": {"type": "string", "description": "Target file ID"},
                "segment_ids": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional segment IDs",
                },
                "anchors": {
                    "type": "array",
                    "items": {"type": "object"},
                    "description": "Optional anchors returned by locate_relevant_segments",
                },
                "page_start": {
                    "type": "integer",
                    "description": "Optional page start (inclusive) when segment IDs are not provided",
                },
                "page_end": {
                    "type": "integer",
                    "description": "Optional page end (inclusive) when segment IDs are not provided",
                },
                "anchor_page": {
                    "type": "integer",
                    "description": "Optional anchor page for local windowed read when segment IDs are not provided",
                },
                "page_window": {
                    "type": "integer",
                    "default": 1,
                    "description": "Window around anchor_page (inclusive), used when anchor_page is provided",
                },
                "max_chars": {"type": "integer", "default": 6000},
            },
            "required": ["file_id"],
        }

    def validate_arguments(self, arguments: Dict[str, Any]) -> None:
        super().validate_arguments(arguments)
        page_start = arguments.get("page_start")
        page_end = arguments.get("page_end")
        anchor_page = arguments.get("anchor_page")
        page_window = arguments.get("page_window")
        if page_start is not None and int(page_start) < 1:
            raise ToolValidationError(self.name, "page_start", "page_start must be >= 1")
        if page_end is not None and int(page_end) < 1:
            raise ToolValidationError(self.name, "page_end", "page_end must be >= 1")
        if page_start is not None and page_end is not None and int(page_start) > int(page_end):
            raise ToolValidationError(self.name, "page_start/page_end", "page_start must be <= page_end")
        if anchor_page is not None and int(anchor_page) < 1:
            raise ToolValidationError(self.name, "anchor_page", "anchor_page must be >= 1")
        if page_window is not None and int(page_window) < 0:
            raise ToolValidationError(self.name, "page_window", "page_window must be >= 0")

    async def execute(self, arguments: Dict[str, Any], context: ToolContext) -> ToolResult:
        file_id = arguments["file_id"]
        segment_ids = arguments.get("segment_ids")
        anchors = arguments.get("anchors")
        page_start = arguments.get("page_start")
        page_end = arguments.get("page_end")
        anchor_page = arguments.get("anchor_page")
        page_window = arguments.get("page_window")
        max_chars = int(arguments.get("max_chars", 6000))

        data = await reader_orchestrator.read_segments(
            db=context.db,
            file_id=file_id,
            segment_ids=segment_ids,
            anchors=anchors,
            page_start=int(page_start) if page_start is not None else None,
            page_end=int(page_end) if page_end is not None else None,
            anchor_page=int(anchor_page) if anchor_page is not None else None,
            page_window=int(page_window) if page_window is not None else None,
            max_chars=max_chars,
        )
        return ToolResult(success=True, data=data)


class ReadWebpageBlocksTool(BaseTool):
    @property
    def name(self) -> str:
        return "read_webpage_blocks"

    @property
    def description(self) -> str:
        return "Read block range from imported webpage segments."

    @property
    def required_permission(self) -> PermissionLevel:
        return PermissionLevel.READ

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "file_id": {"type": "string", "description": "Imported webpage file ID"},
                "block_start": {"type": "integer", "default": 0},
                "block_end": {"type": "integer", "default": 20},
            },
            "required": ["file_id"],
        }

    async def execute(self, arguments: Dict[str, Any], context: ToolContext) -> ToolResult:
        file_id = arguments["file_id"]
        block_start = max(0, int(arguments.get("block_start", 0)))
        block_end = max(block_start, int(arguments.get("block_end", 20)))

        file_result = await context.db.execute(select(FileModel).where(FileModel.id == file_id))
        file_row = file_result.scalar_one_or_none()
        if not file_row:
            return ToolResult(success=False, error="File not found", error_code="FILE_NOT_FOUND")
        if str(file_row.file_type.value if hasattr(file_row.file_type, "value") else file_row.file_type) != "web":
            return ToolResult(success=False, error="File is not web source", error_code="INVALID_FILE_TYPE")

        query = (
            select(DocumentSegment)
            .where(and_(DocumentSegment.file_id == file_id, DocumentSegment.source_type == "web"))
            .order_by(DocumentSegment.chunk_index)
            .offset(block_start)
            .limit(max(0, block_end - block_start + 1))
        )
        result = await context.db.execute(query)
        rows = result.scalars().all()
        return ToolResult(
            success=True,
            data={
                "file_id": file_id,
                "block_start": block_start,
                "block_end": block_end,
                "count": len(rows),
                "blocks": [
                    {
                        "segment_id": row.id,
                        "index": row.chunk_index,
                        "section": row.section,
                        "segment_type": row.segment_type,
                        "text": row.text,
                    }
                    for row in rows
                ],
            },
        )


class ExplainRetrievalTool(BaseTool):
    @property
    def name(self) -> str:
        return "explain_retrieval"

    @property
    def description(self) -> str:
        return "Explain retrieval hits and diagnostics for a query."

    @property
    def required_permission(self) -> PermissionLevel:
        return PermissionLevel.READ

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Query text"},
                "file_id": {"type": "string", "description": "Optional file ID"},
            },
            "required": ["query"],
        }

    async def execute(self, arguments: Dict[str, Any], context: ToolContext) -> ToolResult:
        query = arguments["query"]
        file_id = arguments.get("file_id")

        if file_id:
            file_ids = permission_middleware.filter_readable_files([file_id], context)
        else:
            file_ids = [
                fid for fid, perm in context.permissions.items()
                if perm in (PermissionLevel.READ, PermissionLevel.WRITE)
            ]

        result = await reader_orchestrator.locate_relevant_segments(
            db=context.db,
            query=query,
            file_ids=file_ids,
            top_k=8,
        )
        return ToolResult(
            success=True,
            data={
                "query": query,
                "diagnostics": result.get("diagnostics", {}),
                "hits": [
                    {
                        "segment_id": hit.segment_id,
                        "file_id": hit.file_id,
                        "page": hit.page,
                        "section": hit.section,
                        "score": round(float(hit.score), 5),
                        "source_mode": hit.source_mode,
                        "reason": hit.reason,
                    }
                    for hit in result.get("hits", [])
                ],
            },
        )


class GetIndexStatusTool(BaseTool):
    @property
    def name(self) -> str:
        return "get_index_status"

    @property
    def description(self) -> str:
        return "Get parse/embedding index status for a file."

    @property
    def required_permission(self) -> PermissionLevel:
        return PermissionLevel.READ

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "file_id": {"type": "string", "description": "Target file ID"},
            },
            "required": ["file_id"],
        }

    async def execute(self, arguments: Dict[str, Any], context: ToolContext) -> ToolResult:
        file_id = arguments["file_id"]
        result = await context.db.execute(select(FileIndexStatus).where(FileIndexStatus.file_id == file_id))
        row = result.scalar_one_or_none()
        if not row:
            return ToolResult(
                success=True,
                data={
                    "file_id": file_id,
                    "parse_status": "pending",
                    "embedding_status": "pending",
                    "last_error": None,
                },
            )
        return ToolResult(
            success=True,
            data={
                "file_id": row.file_id,
                "parse_status": row.parse_status,
                "embedding_status": row.embedding_status,
                "last_error": row.last_error,
                "updated_at": row.updated_at.isoformat() if row.updated_at else None,
            },
        )
