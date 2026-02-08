from typing import Dict, Any, Optional
import os
from sqlalchemy import select
from app.services.tools.base import BaseTool, ToolContext, ToolResult, PermissionLevel, ToolValidationError
from app.models import File, FileType, Version, ChangeType

class UpdateFileTool(BaseTool):
    """
    Tool to update the entire content of a file.
    """
    name = "update_file"
    description = "Update the entire content of a file. Use this when you want to rewrite a file completely or apply significant changes."
    parameters_schema = {
        "type": "object",
        "properties": {
            "file_id": {
                "type": "string",
                "description": "The ID of the file to update"
            },
            "content": {
                "type": "string",
                "description": "The new full content of the file"
            },
            "summary": {
                "type": "string",
                "description": "A short summary of the changes made (for version history)"
            }
        },
        "required": ["file_id", "content", "summary"]
    }
    required_permission = PermissionLevel.WRITE
    writable_only = True

    async def execute(self, context: ToolContext, **kwargs) -> ToolResult:
        file_id = kwargs.get("file_id")
        content = kwargs.get("content")
        summary = kwargs.get("summary")

        # 1. Get file from DB
        stmt = select(File).where(File.id == file_id)
        result = await context.db.execute(stmt)
        file_record = result.scalar_one_or_none()

        if not file_record:
            return ToolResult(success=False, error=f"File {file_id} not found")

        # 2. Check if file is writable (text based)
        if file_record.file_type not in [FileType.MD, FileType.TXT, FileType.CODE]:
             return ToolResult(success=False, error=f"Cannot edit file type: {file_record.file_type}")

        # 3. Read old content for diff (simple version)
        old_content = ""
        try:
            if os.path.exists(file_record.path):
                with open(file_record.path, "r", encoding="utf-8") as f:
                    old_content = f.read()
        except Exception:
            pass # File might be new or unreadable

        # 4. Write new content
        try:
            with open(file_record.path, "w", encoding="utf-8") as f:
                f.write(content)
        except Exception as e:
             return ToolResult(success=False, error=f"Failed to write to file: {str(e)}")

        # 5. Create Version record
        # Note: In a real implementation, we would generate a proper diff here
        # For now, we'll store a simple record
        version = Version(
            file_id=file_id,
            author="agent",
            change_type=ChangeType.EDIT,
            summary=summary,
            diff_patch="Diff generation not implemented in tool yet", # Placeholder
            # context_snapshot=... # Could capture viewport here if available
        )
        context.db.add(version)
        await context.db.commit()

        # Broadcast file update event
        from app.websocket import manager
        await manager.broadcast_to_session(
            context.session_id,
            {
                "type": "file_update",
                "data": {
                    "file_id": file_id,
                    "version_id": version.id,
                    "content": content,
                    "summary": summary,
                    "author": "agent"
                }
            }
        )

        return ToolResult(
            success=True,
            data={
                "file_id": file_id,
                "version_id": version.id,
                "message": f"File updated successfully. Version {version.id} created."
            }
        )

class UpdateBlockTool(BaseTool):
    """
    Tool to update a specific block of text in a Markdown file.
    Blocks are currently defined as paragraphs separated by double newlines.
    """
    name = "update_block"
    description = "Update a specific block (paragraph) in a Markdown file. Blocks are 0-indexed."
    parameters_schema = {
        "type": "object",
        "properties": {
            "file_id": {
                "type": "string",
                "description": "The ID of the file to update"
            },
            "block_index": {
                "type": "integer",
                "description": "The index of the block to update (0-based)"
            },
            "content": {
                "type": "string",
                "description": "The new content for the block"
            },
            "summary": {
                "type": "string",
                "description": "A short summary of the changes"
            }
        },
        "required": ["file_id", "block_index", "content", "summary"]
    }
    required_permission = PermissionLevel.WRITE
    writable_only = True

    async def execute(self, context: ToolContext, **kwargs) -> ToolResult:
        file_id = kwargs.get("file_id")
        block_index = kwargs.get("block_index")
        content = kwargs.get("content")
        summary = kwargs.get("summary")

        # 1. Get file
        stmt = select(File).where(File.id == file_id)
        result = await context.db.execute(stmt)
        file_record = result.scalar_one_or_none()

        if not file_record:
            return ToolResult(success=False, error=f"File {file_id} not found")

        if file_record.file_type != FileType.MD:
             return ToolResult(success=False, error="Block updates only supported for Markdown files")

        # 2. Read and split content
        try:
            with open(file_record.path, "r", encoding="utf-8") as f:
                full_content = f.read()
        except Exception as e:
            return ToolResult(success=False, error=f"Failed to read file: {str(e)}")

        # Simple block splitting by double newlines
        # This is a naive implementation; a real AST parser would be better
        blocks = full_content.split("\n\n")

        if block_index < 0 or block_index >= len(blocks):
            return ToolResult(success=False, error=f"Block index {block_index} out of range (0-{len(blocks)-1})")

        # 3. Update block
        blocks[block_index] = content
        new_full_content = "\n\n".join(blocks)

        # 4. Write back
        try:
            with open(file_record.path, "w", encoding="utf-8") as f:
                f.write(new_full_content)
        except Exception as e:
            return ToolResult(success=False, error=f"Failed to write to file: {str(e)}")

        # 5. Versioning
        version = Version(
            file_id=file_id,
            author="agent",
            change_type=ChangeType.EDIT,
            summary=summary,
            diff_patch=f"Updated block {block_index}",
        )
        context.db.add(version)
        await context.db.commit()

        # Broadcast file update event
        from app.websocket import manager
        await manager.broadcast_to_session(
            context.session_id,
            {
                "type": "file_update",
                "data": {
                    "file_id": file_id,
                    "version_id": version.id,
                    "content": new_full_content,
                    "summary": summary,
                    "author": "agent"
                }
            }
        )

        return ToolResult(
            success=True,
            data={
                "file_id": file_id,
                "block_index": block_index,
                "version_id": version.id,
                "message": "Block updated successfully"
            }
        )

class InsertBlockTool(BaseTool):
    """
    Tool to insert a new block of text in a Markdown file.
    """
    name = "insert_block"
    description = "Insert a new block (paragraph) in a Markdown file after a specific index."
    parameters_schema = {
        "type": "object",
        "properties": {
            "file_id": {
                "type": "string",
                "description": "The ID of the file to update"
            },
            "after_block_index": {
                "type": "integer",
                "description": "The index of the block after which to insert. Use -1 to insert at the beginning."
            },
            "content": {
                "type": "string",
                "description": "The content of the new block"
            },
            "summary": {
                "type": "string",
                "description": "A short summary of the insertion"
            }
        },
        "required": ["file_id", "after_block_index", "content", "summary"]
    }
    required_permission = PermissionLevel.WRITE
    writable_only = True

    async def execute(self, context: ToolContext, **kwargs) -> ToolResult:
        file_id = kwargs.get("file_id")
        after_block_index = kwargs.get("after_block_index")
        content = kwargs.get("content")
        summary = kwargs.get("summary")

        # 1. Get file
        stmt = select(File).where(File.id == file_id)
        result = await context.db.execute(stmt)
        file_record = result.scalar_one_or_none()

        if not file_record:
            return ToolResult(success=False, error=f"File {file_id} not found")

        if file_record.file_type != FileType.MD:
             return ToolResult(success=False, error="Block insertion only supported for Markdown files")

        # 2. Read and split content
        try:
            with open(file_record.path, "r", encoding="utf-8") as f:
                full_content = f.read()
        except Exception as e:
            return ToolResult(success=False, error=f"Failed to read file: {str(e)}")

        blocks = full_content.split("\\n\\n")

        # 3. Insert block
        if after_block_index < -1 or after_block_index >= len(blocks):
             return ToolResult(success=False, error=f"Index {after_block_index} out of range")

        blocks.insert(after_block_index + 1, content)
        new_full_content = "\\n\\n".join(blocks)

        # 4. Write back
        try:
            with open(file_record.path, "w", encoding="utf-8") as f:
                f.write(new_full_content)
        except Exception as e:
            return ToolResult(success=False, error=f"Failed to write to file: {str(e)}")

        # 5. Versioning
        version = Version(
            file_id=file_id,
            author="agent",
            change_type=ChangeType.EDIT,
            summary=summary,
            diff_patch=f"Inserted block after {after_block_index}",
        )
        context.db.add(version)
        await context.db.commit()

        # Broadcast file update event
        from app.websocket import manager
        await manager.broadcast_to_session(
            context.session_id,
            {
                "type": "file_update",
                "data": {
                    "file_id": file_id,
                    "version_id": version.id,
                    "content": new_full_content,
                    "summary": summary,
                    "author": "agent"
                }
            }
        )

        return ToolResult(success=True, data={"message": "Block inserted successfully"})

class DeleteBlockTool(BaseTool):
    """
    Tool to delete a block of text in a Markdown file.
    """
    name = "delete_block"
    description = "Delete a specific block (paragraph) in a Markdown file."
    parameters_schema = {
        "type": "object",
        "properties": {
            "file_id": {
                "type": "string",
                "description": "The ID of the file to update"
            },
            "block_index": {
                "type": "integer",
                "description": "The index of the block to delete"
            },
            "summary": {
                "type": "string",
                "description": "A short summary of the deletion"
            }
        },
        "required": ["file_id", "block_index", "summary"]
    }
    required_permission = PermissionLevel.WRITE
    writable_only = True

    async def execute(self, context: ToolContext, **kwargs) -> ToolResult:
        file_id = kwargs.get("file_id")
        block_index = kwargs.get("block_index")
        summary = kwargs.get("summary")

        # 1. Get file
        stmt = select(File).where(File.id == file_id)
        result = await context.db.execute(stmt)
        file_record = result.scalar_one_or_none()

        if not file_record:
            return ToolResult(success=False, error=f"File {file_id} not found")

        if file_record.file_type != FileType.MD:
             return ToolResult(success=False, error="Block deletion only supported for Markdown files")

        # 2. Read and split content
        try:
            with open(file_record.path, "r", encoding="utf-8") as f:
                full_content = f.read()
        except Exception as e:
            return ToolResult(success=False, error=f"Failed to read file: {str(e)}")

        blocks = full_content.split("\\n\\n")

        # 3. Delete block
        if block_index < 0 or block_index >= len(blocks):
             return ToolResult(success=False, error=f"Index {block_index} out of range")

        deleted_content = blocks.pop(block_index)
        new_full_content = "\\n\\n".join(blocks)

        # 4. Write back
        try:
            with open(file_record.path, "w", encoding="utf-8") as f:
                f.write(new_full_content)
        except Exception as e:
            return ToolResult(success=False, error=f"Failed to write to file: {str(e)}")

        # 5. Versioning
        version = Version(
            file_id=file_id,
            author="agent",
            change_type=ChangeType.DELETE,
            summary=summary,
            diff_patch=f"Deleted block {block_index}: {deleted_content[:50]}...",
        )
        context.db.add(version)
        await context.db.commit()

        # Broadcast file update event
        from app.websocket import manager
        await manager.broadcast_to_session(
            context.session_id,
            {
                "type": "file_update",
                "data": {
                    "file_id": file_id,
                    "version_id": version.id,
                    "content": new_full_content,
                    "summary": summary,
                    "author": "agent"
                }
            }
        )

        return ToolResult(success=True, data={"message": "Block deleted successfully"})
