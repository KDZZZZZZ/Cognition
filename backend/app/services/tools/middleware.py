"""
Permission middleware for tool execution.
"""
from typing import Dict, List, Optional, Set, Any
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import File, Session
from app.services.tools.base import (
    ToolContext,
    PermissionLevel,
    ToolPermissionError,
    BaseTool
)


class PermissionMiddleware:
    """
    Middleware for checking permissions before tool execution.

    Rules:
    1. READ permission: Can view file content
    2. WRITE permission: Can modify file content (only for .md files)
    3. NONE permission: File is completely hidden from agent
    """

    # File types that support write operations
    WRITABLE_TYPES: Set[str] = {"md", "txt"}

    # File types that support read operations
    READABLE_TYPES: Set[str] = {"md", "pdf", "docx", "txt"}

    def __init__(self):
        self._session_cache: Dict[str, Dict[str, PermissionLevel]] = {}

    async def create_context(
        self,
        session_id: str,
        db: AsyncSession,
        cache: Optional[Dict] = None
    ) -> ToolContext:
        """
        Create a ToolContext with loaded permissions.

        Args:
            session_id: The session identifier
            db: Database session
            cache: Optional cache dictionary

        Returns:
            ToolContext with permissions loaded
        """
        permissions = await self._load_permissions(session_id, db)

        return ToolContext(
            session_id=session_id,
            db=db,
            permissions=permissions,
            cache=cache
        )

    async def _load_permissions(
        self,
        session_id: str,
        db: AsyncSession
    ) -> Dict[str, PermissionLevel]:
        """Load permissions for a session from database."""
        # Check cache first
        if session_id in self._session_cache:
            return self._session_cache[session_id]

        result = await db.execute(
            select(Session).where(Session.id == session_id)
        )
        session = result.scalar_one_or_none()

        if not session:
            # Return empty permissions for new session
            return {}

        permissions = {}
        if session.permissions:
            for file_id, perm_level in session.permissions.items():
                try:
                    permissions[file_id] = PermissionLevel(perm_level)
                except ValueError:
                    # Invalid permission level, skip
                    continue

        # Cache for future use
        self._session_cache[session_id] = permissions
        return permissions

    def invalidate_cache(self, session_id: Optional[str] = None) -> None:
        """
        Invalidate cached permissions.

        Args:
            session_id: Specific session to invalidate, or None for all
        """
        if session_id:
            self._session_cache.pop(session_id, None)
        else:
            self._session_cache.clear()

    async def check_permission(
        self,
        tool: BaseTool,
        arguments: Dict[str, Any],
        context: ToolContext
    ) -> None:
        """
        Check if the tool execution is allowed based on permissions.

        Raises:
            ToolPermissionError: If permission check fails
        """
        # Get file_id from arguments (common parameter name)
        file_id = arguments.get("file_id")

        # Some tools may have different parameter names (search uses file_ids array)
        if not file_id:
            file_ids = arguments.get("file_ids", [])
            if file_ids and len(file_ids) == 1:
                file_id = file_ids[0]

        # If no file_id, no permission check needed
        if not file_id:
            return

        # Default visibility is READ unless explicitly hidden.
        permission = context.permissions.get(file_id, PermissionLevel.READ)

        # Check NONE permission first
        if permission == PermissionLevel.NONE:
            raise ToolPermissionError(
                tool.name,
                file_id,
                tool.required_permission or PermissionLevel.READ
            )

        # Check if tool requires specific permission
        required = tool.required_permission

        if required == PermissionLevel.READ:
            # Both READ and WRITE permissions allow reading
            if permission not in (PermissionLevel.READ, PermissionLevel.WRITE):
                raise ToolPermissionError(
                    tool.name,
                    file_id,
                    PermissionLevel.READ
                )

        elif required == PermissionLevel.WRITE:
            # Check if file has write permission
            if permission != PermissionLevel.WRITE:
                raise ToolPermissionError(
                    tool.name,
                    file_id,
                    PermissionLevel.WRITE
                )

            # Check if file type supports writing
            if tool.writable_only:
                file = await self._get_file(file_id, context.db)
                if file and file.file_type not in self.WRITABLE_TYPES:
                    raise ToolPermissionError(
                        tool.name,
                        file_id,
                        PermissionLevel.WRITE
                    )

    async def _get_file(
        self,
        file_id: str,
        db: AsyncSession
    ) -> Optional[File]:
        """Get file from database."""
        result = await db.execute(
            select(File).where(File.id == file_id)
        )
        return result.scalar_one_or_none()

    def filter_visible_files(
        self,
        file_ids: List[str],
        context: ToolContext
    ) -> List[str]:
        """
        Filter out files that the agent cannot see (NONE permission).

        Returns:
            List of visible file IDs
        """
        return [
            file_id for file_id in file_ids
            if context.permissions.get(file_id, PermissionLevel.READ) != PermissionLevel.NONE
        ]

    def filter_readable_files(
        self,
        file_ids: List[str],
        context: ToolContext
    ) -> List[str]:
        """
        Filter files that the agent can read.

        Returns:
            List of readable file IDs
        """
        return [
            file_id for file_id in file_ids
            if context.permissions.get(file_id, PermissionLevel.READ) in (
                PermissionLevel.READ, PermissionLevel.WRITE
            )
        ]

    def filter_writable_files(
        self,
        file_ids: List[str],
        context: ToolContext
    ) -> List[str]:
        """
        Filter files that the agent can write.

        Returns:
            List of writable file IDs
        """
        return [
            file_id for file_id in file_ids
            if context.permissions.get(file_id, PermissionLevel.NONE) == PermissionLevel.WRITE
        ]


# Singleton instance
permission_middleware = PermissionMiddleware()
