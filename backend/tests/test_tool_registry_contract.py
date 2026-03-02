import pytest

from app.services.tools.base import ToolContext
from app.services.tools.executor import tool_executor
from app.services.tools.handlers import initialize_tools
from app.services.tools.registry import tool_registry


EXPECTED_TOOLS = {
    "locate_relevant_segments",
    "read_document_segments",
    "inspect_document_visual",
    "get_document_outline",
    "read_webpage_blocks",
    "explain_retrieval",
    "get_index_status",
    "update_file",
    "update_block",
    "insert_block",
    "delete_block",
    "register_task",
    "deliver_task",
    "pause_for_user_choice",
    "add_file_charts_to_note",
}

REMOVED_TOOLS = {
    "read_document",
    "search_documents",
    "search_pdf_passages",
    "read_pdf_pages",
    "locate_pdf_pages_visually",
    "read_visible_pdf_context",
    "get_pdf_metadata",
}


def _reset_registry() -> None:
    for tool_name in list(tool_registry.get_tool_names()):
        tool_registry.unregister(tool_name)


def test_tool_registry_contract():
    _reset_registry()
    initialize_tools()
    names = set(tool_registry.get_tool_names())
    assert names == EXPECTED_TOOLS


@pytest.mark.asyncio
async def test_removed_tools_return_tool_not_found():
    _reset_registry()
    initialize_tools()
    context = ToolContext(session_id="test", db=None, permissions={})

    for tool_name in REMOVED_TOOLS:
        result = await tool_executor.execute(
            tool_name=tool_name,
            arguments={},
            context=context,
            validate_permissions=False,
        )
        assert result.success is False
        assert result.error_code == "TOOL_NOT_FOUND"
