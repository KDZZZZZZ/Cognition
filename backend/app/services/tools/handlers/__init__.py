"""
Tool handlers initialization.

This module initializes and registers all agent tools.
"""
from app.services.tools.handlers.document_tool import (
    ReadDocumentTool,
    UpdateDocumentTool,
    AppendDocumentTool
)
from app.services.tools.handlers.search_tool import SearchDocumentsTool
from app.services.tools.registry import register_tools


def initialize_tools() -> None:
    """
    Initialize and register all agent tools.

    This function is called on application startup to register
    all available tools for the agent to use.
    """
    register_tools(
        # Document tools
        ReadDocumentTool(),
        UpdateDocumentTool(),
        AppendDocumentTool(),

        # Search tools
        SearchDocumentsTool(),
    )


__all__ = [
    "ReadDocumentTool",
    "UpdateDocumentTool",
    "AppendDocumentTool",
    "SearchDocumentsTool",
    "initialize_tools"
]
