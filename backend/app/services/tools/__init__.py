"""
Agent tools system.

This package provides a comprehensive tool system for AI agents to interact
 with documents in the Knowledge IDE.

Main components:
- base: Base tool interface and common types
- middleware: Permission checking and context creation
- registry: Tool registration and discovery
- executor: Tool execution with error handling
- handlers: Concrete tool implementations
"""

from app.services.tools.base import (
    PermissionLevel,
    FileType,
    ToolContext,
    ToolResult,
    ToolPermissionError,
    ToolValidationError,
    BaseTool
)

from app.services.tools.middleware import permission_middleware, PermissionMiddleware
from app.services.tools.registry import tool_registry, ToolRegistry, register_tools
from app.services.tools.executor import tool_executor, ToolExecutor

__all__ = [
    # Base types
    "PermissionLevel",
    "FileType",
    "ToolContext",
    "ToolResult",
    "ToolPermissionError",
    "ToolValidationError",
    "BaseTool",

    # Middleware
    "permission_middleware",
    "PermissionMiddleware",

    # Registry
    "tool_registry",
    "ToolRegistry",
    "register_tools",

    # Executor
    "tool_executor",
    "ToolExecutor",
]
