"""
Tool handlers initialization.

This module initializes and registers all agent tools.
"""
from app.services.tools.handlers.editor_ops import (
    UpdateFileTool,
    UpdateBlockTool,
    InsertBlockTool,
    DeleteBlockTool
)
from app.services.tools.handlers.task_tools import DeliverTaskTool, RegisterTaskTool
from app.services.tools.handlers.control_tools import PauseForUserChoiceTool
from app.services.tools.handlers.chart_tools import AddFileChartsToNoteTool
from app.services.tools.handlers.visual_tools import InspectDocumentVisualTool
from app.services.tools.handlers.reader_tools import (
    ExplainRetrievalTool,
    GetDocumentOutlineTool,
    GetIndexStatusTool,
    LocateRelevantSegmentsTool,
    ReadDocumentSegmentsTool,
    ReadWebpageBlocksTool,
)
from app.services.tools.registry import register_tools


def initialize_tools() -> None:
    """
    Initialize and register all agent tools.

    This function is called on application startup to register
    all available tools for the agent to use.
    """
    register_tools(
        # Editor Block Operations
        UpdateFileTool(),
        UpdateBlockTool(),
        InsertBlockTool(),
        DeleteBlockTool(),

        # Unified retrieval + deep-read tools
        LocateRelevantSegmentsTool(),
        ReadDocumentSegmentsTool(),
        ReadWebpageBlocksTool(),
        GetDocumentOutlineTool(),
        ExplainRetrievalTool(),
        GetIndexStatusTool(),
        InspectDocumentVisualTool(),

        # Task lifecycle tools
        RegisterTaskTool(),
        DeliverTaskTool(),

        # Control / utility tools
        PauseForUserChoiceTool(),
        AddFileChartsToNoteTool(),
    )


__all__ = [
    "initialize_tools"
]
