"""
Document-related agent tools.
"""
import uuid
from pathlib import Path
from typing import Dict, Any
from datetime import datetime
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.tools.base import (
    BaseTool,
    ToolContext,
    ToolResult,
    PermissionLevel
)
from app.models import File, Version, Author, ChangeType


class ReadDocumentTool(BaseTool):
    """
    Read the content of a document.

    Supports: .md, .pdf, .docx, .txt files
    Requires: READ permission
    """

    @property
    def name(self) -> str:
        return "read_document"

    @property
    def description(self) -> str:
        return "Read the full content of a document. Supports markdown (.md), PDF (.pdf), Word (.docx), and text (.txt) files."

    @property
    def required_permission(self) -> PermissionLevel:
        return PermissionLevel.READ

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "file_id": {
                    "type": "string",
                    "description": "The ID of the file to read"
                }
            },
            "required": ["file_id"]
        }

    async def execute(self, arguments: Dict[str, Any], context: ToolContext) -> ToolResult:
        file_id = arguments["file_id"]

        # Get file from database
        result = await context.db.execute(
            select(File).where(File.id == file_id)
        )
        file = result.scalar_one_or_none()

        if not file:
            return ToolResult(
                success=False,
                error=f"File not found: {file_id}",
                error_code="FILE_NOT_FOUND"
            )

        # Read file content
        try:
            file_path = Path(file.path)

            if not file_path.exists():
                return ToolResult(
                    success=False,
                    error=f"File not found on disk: {file.name}",
                    error_code="FILE_NOT_FOUND_ON_DISK"
                )

            # Read based on file type
            if file.file_type in ("md", "txt"):
                content = file_path.read_text(encoding="utf-8")
            elif file.file_type == "pdf":
                from app.models import DocumentChunk
                chunk_rows = await context.db.execute(
                    select(DocumentChunk)
                    .where(DocumentChunk.file_id == file_id)
                    .order_by(DocumentChunk.page, DocumentChunk.chunk_index)
                )
                chunks = chunk_rows.scalars().all()
                content = "\n".join(chunk.content for chunk in chunks) if chunks else "[PDF content not available]"
            elif file.file_type == "docx":
                content = file.meta.get("text_content", "[DOCX content not available]") if file.meta else "[DOCX content not available]"
            else:
                content = f"[Unsupported file type: {file.file_type}]"

            return ToolResult(
                success=True,
                data={
                    "file_id": file_id,
                    "file_name": file.name,
                    "file_type": file.file_type.value if hasattr(file.file_type, "value") else file.file_type,
                    "content": content,
                    "size": file.size
                }
            )

        except Exception as e:
            return ToolResult(
                success=False,
                error=f"Failed to read file: {str(e)}",
                error_code="READ_ERROR"
            )


class UpdateDocumentTool(BaseTool):
    """
    Update a markdown document's content.

    Supports: Only .md files
    Requires: WRITE permission
    """

    @property
    def name(self) -> str:
        return "update_document"

    @property
    def description(self) -> str:
        return "Update the entire content of a markdown file. Only works with .md files. The full content will be replaced with the new content provided."

    @property
    def required_permission(self) -> PermissionLevel:
        return PermissionLevel.WRITE

    @property
    def writable_only(self) -> bool:
        return True

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "file_id": {
                    "type": "string",
                    "description": "The ID of the markdown file to update"
                },
                "content": {
                    "type": "string",
                    "description": "The new full content for the file"
                },
                "summary": {
                    "type": "string",
                    "description": "A brief description of the changes made (for version history)",
                    "default": "Content updated by agent"
                }
            },
            "required": ["file_id", "content"]
        }

    def validate_arguments(self, arguments: Dict[str, Any]) -> None:
        super().validate_arguments(arguments)

        content = arguments.get("content", "")
        if len(content) > 1_000_000:  # 1MB limit
            raise ToolValidationError(
                self.name, "content", "Content too large (max 1MB)"
            )

    async def execute(self, arguments: Dict[str, Any], context: ToolContext) -> ToolResult:
        file_id = arguments["file_id"]
        new_content = arguments["content"]
        summary = arguments.get("summary", "Content updated by agent")

        # Get file from database
        result = await context.db.execute(
            select(File).where(File.id == file_id)
        )
        file = result.scalar_one_or_none()

        if not file:
            return ToolResult(
                success=False,
                error=f"File not found: {file_id}",
                error_code="FILE_NOT_FOUND"
            )

        # Check if file is writable (only .md files)
        if file.file_type != "md":
            return ToolResult(
                success=False,
                error=f"Only markdown (.md) files can be edited. This is a .{file.file_type} file.",
                error_code="FILE_NOT_WRITABLE"
            )

        try:
            file_path = Path(file.path)

            # Read old content for diff
            old_content = ""
            if file_path.exists():
                old_content = file_path.read_text(encoding="utf-8")

            # Write new content
            file_path.write_text(new_content, encoding="utf-8")

            # Update file metadata
            file.size = len(new_content.encode("utf-8"))
            file.updated_at = datetime.utcnow()

            # Create version record
            version = Version(
                id=str(uuid.uuid4()),
                file_id=file_id,
                author=Author.AGENT,
                change_type=ChangeType.EDIT,
                summary=summary,
                diff_patch=None,  # Can be computed with diff library
                context_snapshot=old_content  # Save full old content for diff
            )
            context.db.add(version)

            await context.db.commit()

            return ToolResult(
                success=True,
                data={
                    "file_id": file_id,
                    "file_name": file.name,
                    "size": file.size,
                    "updated_at": file.updated_at.isoformat(),
                    "summary": summary,
                    "version_id": version.id
                }
            )

        except Exception as e:
            await context.db.rollback()
            return ToolResult(
                success=False,
                error=f"Failed to update file: {str(e)}",
                error_code="UPDATE_ERROR"
            )


class AppendDocumentTool(BaseTool):
    """
    Append content to a markdown document.

    Supports: Only .md files
    Requires: WRITE permission
    """

    @property
    def name(self) -> str:
        return "append_document"

    @property
    def description(self) -> str:
        return "Append content to the end of a markdown file. Only works with .md files. A blank line will be added before the new content if needed."

    @property
    def required_permission(self) -> PermissionLevel:
        return PermissionLevel.WRITE

    @property
    def writable_only(self) -> bool:
        return True

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "file_id": {
                    "type": "string",
                    "description": "The ID of the markdown file to append to"
                },
                "content": {
                    "type": "string",
                    "description": "The content to append"
                },
                "summary": {
                    "type": "string",
                    "description": "A brief description of the changes (for version history)",
                    "default": "Content appended by agent"
                }
            },
            "required": ["file_id", "content"]
        }

    def validate_arguments(self, arguments: Dict[str, Any]) -> None:
        super().validate_arguments(arguments)

        content = arguments.get("content", "")
        if len(content) > 500_000:  # 500KB limit for append
            raise ToolValidationError(
                self.name, "content", "Content too large (max 500KB)"
            )

    async def execute(self, arguments: Dict[str, Any], context: ToolContext) -> ToolResult:
        from app.services.tools.base import ToolValidationError

        file_id = arguments["file_id"]
        content_to_append = arguments["content"]
        summary = arguments.get("summary", "Content appended by agent")

        # Get file from database
        result = await context.db.execute(
            select(File).where(File.id == file_id)
        )
        file = result.scalar_one_or_none()

        if not file:
            return ToolResult(
                success=False,
                error=f"File not found: {file_id}",
                error_code="FILE_NOT_FOUND"
            )

        # Check if file is writable (only .md files)
        if file.file_type != "md":
            return ToolResult(
                success=False,
                error=f"Only markdown (.md) files can be edited. This is a .{file.file_type} file.",
                error_code="FILE_NOT_WRITABLE"
            )

        try:
            file_path = Path(file.path)

            # Read existing content
            existing_content = ""
            if file_path.exists():
                existing_content = file_path.read_text(encoding="utf-8")

            # Build new content with proper separator
            if existing_content and not existing_content.endswith("\n"):
                separator = "\n\n"
            elif existing_content:
                separator = "\n"
            else:
                separator = ""

            new_content = existing_content + separator + content_to_append

            # Write to file
            file_path.write_text(new_content, encoding="utf-8")

            # Update file metadata
            file.size = len(new_content.encode("utf-8"))
            file.updated_at = datetime.utcnow()

            # Create version record with full old content for diff
            version = Version(
                id=str(uuid.uuid4()),
                file_id=file_id,
                author=Author.AGENT,
                change_type=ChangeType.EDIT,
                summary=summary,
                diff_patch=None,
                context_snapshot=existing_content  # Save full content before append for diff
            )
            context.db.add(version)

            await context.db.commit()

            return ToolResult(
                success=True,
                data={
                    "file_id": file_id,
                    "file_name": file.name,
                    "previous_size": len(existing_content.encode("utf-8")),
                    "new_size": file.size,
                    "appended_length": len(content_to_append.encode("utf-8")),
                    "updated_at": file.updated_at.isoformat(),
                    "version_id": version.id
                }
            )

        except Exception as e:
            await context.db.rollback()
            return ToolResult(
                success=False,
                error=f"Failed to append to file: {str(e)}",
                error_code="APPEND_ERROR"
            )
