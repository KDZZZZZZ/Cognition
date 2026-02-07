"""
Tool registry for managing available agent tools.
"""
from typing import Dict, List, Optional
import logging

from app.services.tools.base import BaseTool

logger = logging.getLogger(__name__)


class ToolRegistry:
    """
    Registry for all available tools.

    Tools are registered by name and can be retrieved for execution
    or for generating the tool list for LLM function calling.
    """

    def __init__(self):
        self._tools: Dict[str, BaseTool] = {}

    def register(self, tool: BaseTool) -> None:
        """
        Register a tool.

        Args:
            tool: The tool instance to register
        """
        if tool.name in self._tools:
            logger.warning(f"Tool '{tool.name}' already registered, overwriting")

        self._tools[tool.name] = tool
        logger.info(f"Registered tool: {tool.name}")

    def unregister(self, tool_name: str) -> None:
        """Unregister a tool by name."""
        if tool_name in self._tools:
            del self._tools[tool_name]
            logger.info(f"Unregistered tool: {tool_name}")

    def get(self, tool_name: str) -> Optional[BaseTool]:
        """Get a tool by name."""
        return self._tools.get(tool_name)

    def get_all(self) -> List[BaseTool]:
        """Get all registered tools."""
        return list(self._tools.values())

    def get_openai_tools(self) -> List[Dict]:
        """
        Get all tools in OpenAI function calling format.

        Returns:
            List of tool dictionaries for LLM API
        """
        return [tool.to_openai_format() for tool in self._tools.values()]

    def has_tool(self, tool_name: str) -> bool:
        """Check if a tool is registered."""
        return tool_name in self._tools

    def filter_by_permission(
        self,
        permission_level: Optional[str] = None
    ) -> List[BaseTool]:
        """
        Filter tools by required permission level.

        Args:
            permission_level: Minimum permission required ('read', 'write', or None)

        Returns:
            List of tools matching the permission criteria
        """
        if permission_level is None:
            return self.get_all()

        from app.services.tools.base import PermissionLevel

        required = PermissionLevel(permission_level)

        return [
            tool for tool in self._tools.values()
            if tool.required_permission is None
            or tool.required_permission == required
        ]

    def get_tool_names(self) -> List[str]:
        """Get list of all registered tool names."""
        return list(self._tools.keys())


# Global registry instance
tool_registry = ToolRegistry()


def register_tools(*tools: BaseTool) -> None:
    """
    Register multiple tools at once.

    Usage:
        register_tools(
            ReadDocumentTool(),
            UpdateDocumentTool(),
            SearchDocumentsTool()
        )
    """
    for tool in tools:
        tool_registry.register(tool)
