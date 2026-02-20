"""
Tool handlers initialization.

This module initializes and registers all agent tools.
"""
from app.services.tools.handlers.document_tool import (
    ReadDocumentTool,
)
from app.services.tools.handlers.editor_ops import (
    UpdateFileTool,
    UpdateBlockTool,
    InsertBlockTool,
    DeleteBlockTool
)
from app.services.tools.handlers.pdf_tools import (
    GetPdfMetadataTool,
    ReadPdfPagesTool,
    SearchPdfPassagesTool,
    ReadVisiblePdfContextTool,
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

        # Editor Block Operations
        UpdateFileTool(),
        UpdateBlockTool(),
        InsertBlockTool(),
        DeleteBlockTool(),

        # PDF-specialized tools
        GetPdfMetadataTool(),
        ReadPdfPagesTool(),
        SearchPdfPassagesTool(),
        ReadVisiblePdfContextTool(),

        # Search tools
        SearchDocumentsTool(),
    )


__all__ = [
    "ReadDocumentTool",
    "SearchDocumentsTool",
    "initialize_tools"
]
