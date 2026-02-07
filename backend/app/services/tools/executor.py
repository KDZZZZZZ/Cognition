"""
Tool executor for running agent tools with proper error handling.
"""
import logging
from typing import Dict, Any, List, Optional
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.tools.base import (
    BaseTool,
    ToolContext,
    ToolResult,
    ToolValidationError,
    ToolPermissionError
)
from app.services.tools.registry import tool_registry
from app.services.tools.middleware import permission_middleware

logger = logging.getLogger(__name__)


class ToolExecutionError(Exception):
    """Raised when tool execution fails."""

    def __init__(self, tool_name: str, original_error: Exception):
        self.tool_name = tool_name
        self.original_error = original_error
        super().__init__(f"Tool '{tool_name}' execution failed: {original_error}")


class ToolExecutor:
    """
    Executes agent tools with permission checking and error handling.

    Features:
    - Automatic permission validation
    - Input validation
    - Transaction rollback on error
    - Detailed logging
    - Standardized error responses
    """

    def __init__(self, registry: Optional[Any] = None):
        self._registry = registry or tool_registry

    async def execute(
        self,
        tool_name: str,
        arguments: Dict[str, Any],
        context: ToolContext,
        validate_permissions: bool = True
    ) -> ToolResult:
        """
        Execute a tool with the given arguments.

        Args:
            tool_name: Name of the tool to execute
            arguments: Arguments from the LLM
            context: Execution context
            validate_permissions: Whether to check permissions

        Returns:
            ToolResult with success status and data

        Raises:
            ToolExecutionError: If tool not found or execution fails
        """
        # Get tool from registry
        tool = self._registry.get(tool_name)
        if not tool:
            logger.warning(f"Unknown tool requested: {tool_name}")
            return ToolResult(
                success=False,
                error=f"Unknown tool: {tool_name}",
                error_code="TOOL_NOT_FOUND"
            )

        # Validate arguments
        try:
            tool.validate_arguments(arguments)
        except ToolValidationError as e:
            logger.warning(f"Validation error for {tool_name}: {e}")
            return ToolResult(
                success=False,
                error=str(e),
                error_code="VALIDATION_ERROR"
            )

        # Check permissions
        if validate_permissions:
            try:
                await permission_middleware.check_permission(
                    tool, arguments, context
                )
            except ToolPermissionError as e:
                logger.warning(f"Permission denied for {tool_name}: {e}")
                return ToolResult(
                    success=False,
                    error=str(e),
                    error_code="PERMISSION_DENIED"
                )

        # Execute tool
        try:
            result = await tool.execute(arguments, context)
            logger.info(f"Tool {tool_name} executed: success={result.success}")
            return result
        except Exception as e:
            logger.error(f"Error executing tool {tool_name}: {e}", exc_info=True)
            return ToolResult(
                success=False,
                error=f"Tool execution failed: {str(e)}",
                error_code="EXECUTION_ERROR"
            )

    async def execute_batch(
        self,
        tool_calls: List[Dict[str, Any]],
        context: ToolContext
    ) -> List[ToolResult]:
        """
        Execute multiple tools in sequence.

        Args:
            tool_calls: List of tool call dicts with 'name' and 'arguments'
            context: Execution context

        Returns:
            List of ToolResults in the same order
        """
        results = []

        for call in tool_calls:
            tool_name = call.get("name")
            arguments = call.get("arguments", {})

            if not tool_name:
                results.append(ToolResult(
                    success=False,
                    error="Tool call missing 'name' field",
                    error_code="INVALID_CALL"
                ))
                continue

            result = await self.execute(tool_name, arguments, context)
            results.append(result)

        return results

    def get_available_tools(self, context: Optional[ToolContext] = None) -> List[Dict]:
        """
        Get list of available tools for LLM function calling.

        Args:
            context: Optional context for permission-based filtering

        Returns:
            List of tool definitions in OpenAI format
        """
        tools = self._registry.get_all()

        # Filter by permissions if context provided
        if context:
            from app.services.tools.base import PermissionLevel
            writable_files = [
                fid for fid, perm in context.permissions.items()
                if perm == PermissionLevel.WRITE
            ]

            # Only include write tools if there are writable files
            if not writable_files:
                tools = [
                    t for t in tools
                    if not t.writable_only
                ]

        return [tool.to_openai_format() for tool in tools]


# Global executor instance
tool_executor = ToolExecutor()
