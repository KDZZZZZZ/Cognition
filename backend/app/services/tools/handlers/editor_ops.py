import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from sqlalchemy import select

from app.models import Author, DiffEvent, DiffEventStatus, DiffLineSnapshot, File, FileType, LineDecision
from app.services.diff_events import (
    build_diff_line_snapshots,
    get_effective_diff_base,
    resolve_all_pending_diff_events,
)
from app.services.tools.base import BaseTool, PermissionLevel, ToolContext, ToolResult, ToolValidationError
from app.websocket import manager


def _build_line_snapshots(old_content: str, new_content: str) -> List[Dict[str, Any]]:
    return build_diff_line_snapshots(old_content, new_content)


async def _create_pending_diff_event(
    context: ToolContext,
    file: File,
    old_content: str,
    new_content: str,
    summary: str,
) -> ToolResult:
    base_content, current_content, pending_events = await get_effective_diff_base(
        context.db,
        file.id,
        old_content,
    )

    if current_content == new_content:
        return ToolResult(
            success=True,
            data={
                "file_id": file.id,
                "file_name": file.name,
                "event_id": None,
                "status": "noop",
                "message": "No content changes detected",
            },
        )

    if base_content == new_content:
        if pending_events:
            await resolve_all_pending_diff_events(
                context.db,
                file.id,
                replacement_content=base_content,
            )
            await context.db.commit()
        return ToolResult(
            success=True,
            data={
                "file_id": file.id,
                "file_name": file.name,
                "event_id": None,
                "status": "noop",
                "message": "No net content changes detected",
            },
        )

    if pending_events:
        await resolve_all_pending_diff_events(
            context.db,
            file.id,
            replacement_content=current_content,
        )

    event = DiffEvent(
        id=str(uuid.uuid4()),
        file_id=file.id,
        author=Author.AGENT,
        old_content=base_content,
        new_content=new_content,
        summary=summary,
        status=DiffEventStatus.PENDING,
    )
    context.db.add(event)
    await context.db.flush()

    for snapshot in _build_line_snapshots(base_content, new_content):
        context.db.add(
            DiffLineSnapshot(
                id=str(uuid.uuid4()),
                event_id=event.id,
                line_no=snapshot["line_no"],
                old_line=snapshot["old_line"],
                new_line=snapshot["new_line"],
                decision=snapshot["decision"],
            )
        )

    await context.db.commit()

    await manager.broadcast_to_session(
        context.session_id,
        {
            "type": "diff_event_created",
            "data": {
                "file_id": file.id,
                "event_id": event.id,
                "summary": summary,
            },
        },
    )

    return ToolResult(
        success=True,
        data={
            "file_id": file.id,
            "file_name": file.name,
            "event_id": event.id,
            "status": "pending",
            "summary": summary,
        },
    )


async def _load_file(context: ToolContext, file_id: str) -> Optional[File]:
    result = await context.db.execute(select(File).where(File.id == file_id))
    return result.scalar_one_or_none()


def _read_text(path: str) -> str:
    file_path = Path(path)
    if not file_path.exists():
        return ""
    return file_path.read_text(encoding="utf-8")


async def _read_effective_text(db, file: File) -> str:
    persisted = _read_text(file.path)
    _, effective, _ = await get_effective_diff_base(db, file.id, persisted)
    return effective


class UpdateFileTool(BaseTool):
    @property
    def name(self) -> str:
        return "update_file"

    @property
    def description(self) -> str:
        return "Propose a full-file rewrite for markdown/text files. This creates a pending diff event for user approval."

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "file_id": {"type": "string", "description": "Target file ID"},
                "content": {"type": "string", "description": "Proposed full file content"},
                "summary": {"type": "string", "description": "Short change summary"},
            },
            "required": ["file_id", "content", "summary"],
        }

    @property
    def required_permission(self) -> PermissionLevel:
        return PermissionLevel.WRITE

    @property
    def writable_only(self) -> bool:
        return True

    async def execute(self, arguments: Dict[str, Any], context: ToolContext) -> ToolResult:
        file_id = arguments["file_id"]
        new_content = arguments["content"]
        summary = arguments["summary"]

        file = await _load_file(context, file_id)
        if not file:
            return ToolResult(success=False, error=f"File {file_id} not found", error_code="FILE_NOT_FOUND")

        if file.file_type != FileType.MD:
            return ToolResult(
                success=False,
                error=f"Cannot edit file type: {file.file_type}",
                error_code="FILE_NOT_WRITABLE",
            )

        old_content = await _read_effective_text(context.db, file)
        return await _create_pending_diff_event(context, file, old_content, new_content, summary)


class UpdateBlockTool(BaseTool):
    @property
    def name(self) -> str:
        return "update_block"

    @property
    def description(self) -> str:
        return "Propose updating one paragraph block in a markdown file (0-indexed blocks split by blank lines)."

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "file_id": {"type": "string", "description": "Target markdown file ID"},
                "block_index": {"type": "integer", "description": "0-based block index"},
                "content": {"type": "string", "description": "New block content"},
                "summary": {"type": "string", "description": "Short change summary"},
            },
            "required": ["file_id", "block_index", "content", "summary"],
        }

    @property
    def required_permission(self) -> PermissionLevel:
        return PermissionLevel.WRITE

    @property
    def writable_only(self) -> bool:
        return True

    async def execute(self, arguments: Dict[str, Any], context: ToolContext) -> ToolResult:
        file_id = arguments["file_id"]
        block_index = arguments["block_index"]
        content = arguments["content"]
        summary = arguments["summary"]

        if block_index < 0:
            raise ToolValidationError(self.name, "block_index", "Must be >= 0")

        file = await _load_file(context, file_id)
        if not file:
            return ToolResult(success=False, error=f"File {file_id} not found", error_code="FILE_NOT_FOUND")
        if file.file_type != FileType.MD:
            return ToolResult(
                success=False,
                error="Block updates are only supported for markdown files",
                error_code="FILE_NOT_WRITABLE",
            )

        old_content = await _read_effective_text(context.db, file)
        blocks = old_content.split("\n\n") if old_content else [""]
        if block_index >= len(blocks):
            return ToolResult(
                success=False,
                error=f"Block index {block_index} out of range (0-{len(blocks)-1})",
                error_code="INVALID_BLOCK_INDEX",
            )
        blocks[block_index] = content
        new_content = "\n\n".join(blocks)
        return await _create_pending_diff_event(context, file, old_content, new_content, summary)


class InsertBlockTool(BaseTool):
    @property
    def name(self) -> str:
        return "insert_block"

    @property
    def description(self) -> str:
        return "Propose inserting a new markdown block after a specified index (-1 inserts at top)."

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "file_id": {"type": "string", "description": "Target markdown file ID"},
                "after_block_index": {"type": "integer", "description": "Insert after this block index"},
                "content": {"type": "string", "description": "New block content"},
                "summary": {"type": "string", "description": "Short change summary"},
            },
            "required": ["file_id", "after_block_index", "content", "summary"],
        }

    @property
    def required_permission(self) -> PermissionLevel:
        return PermissionLevel.WRITE

    @property
    def writable_only(self) -> bool:
        return True

    async def execute(self, arguments: Dict[str, Any], context: ToolContext) -> ToolResult:
        file_id = arguments["file_id"]
        after_block_index = arguments["after_block_index"]
        content = arguments["content"]
        summary = arguments["summary"]

        file = await _load_file(context, file_id)
        if not file:
            return ToolResult(success=False, error=f"File {file_id} not found", error_code="FILE_NOT_FOUND")
        if file.file_type != FileType.MD:
            return ToolResult(
                success=False,
                error="Block insertion is only supported for markdown files",
                error_code="FILE_NOT_WRITABLE",
            )

        old_content = await _read_effective_text(context.db, file)
        blocks = old_content.split("\n\n") if old_content else []
        if after_block_index < -1 or after_block_index >= len(blocks):
            return ToolResult(
                success=False,
                error=f"Index {after_block_index} out of range",
                error_code="INVALID_BLOCK_INDEX",
            )

        insert_at = after_block_index + 1
        blocks.insert(insert_at, content)
        new_content = "\n\n".join(blocks)
        return await _create_pending_diff_event(context, file, old_content, new_content, summary)


class DeleteBlockTool(BaseTool):
    @property
    def name(self) -> str:
        return "delete_block"

    @property
    def description(self) -> str:
        return "Propose deleting one markdown block by index."

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "file_id": {"type": "string", "description": "Target markdown file ID"},
                "block_index": {"type": "integer", "description": "Block index to delete"},
                "summary": {"type": "string", "description": "Short change summary"},
            },
            "required": ["file_id", "block_index", "summary"],
        }

    @property
    def required_permission(self) -> PermissionLevel:
        return PermissionLevel.WRITE

    @property
    def writable_only(self) -> bool:
        return True

    async def execute(self, arguments: Dict[str, Any], context: ToolContext) -> ToolResult:
        file_id = arguments["file_id"]
        block_index = arguments["block_index"]
        summary = arguments["summary"]

        if block_index < 0:
            raise ToolValidationError(self.name, "block_index", "Must be >= 0")

        file = await _load_file(context, file_id)
        if not file:
            return ToolResult(success=False, error=f"File {file_id} not found", error_code="FILE_NOT_FOUND")
        if file.file_type != FileType.MD:
            return ToolResult(
                success=False,
                error="Block deletion is only supported for markdown files",
                error_code="FILE_NOT_WRITABLE",
            )

        old_content = await _read_effective_text(context.db, file)
        blocks = old_content.split("\n\n") if old_content else []
        if block_index >= len(blocks):
            return ToolResult(
                success=False,
                error=f"Index {block_index} out of range",
                error_code="INVALID_BLOCK_INDEX",
            )

        blocks.pop(block_index)
        new_content = "\n\n".join(blocks)
        return await _create_pending_diff_event(context, file, old_content, new_content, summary)
