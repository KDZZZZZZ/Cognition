from app.services.step_executor_service import filter_tools_for_step


def _tool(name: str) -> dict:
    return {
        "type": "function",
        "function": {
            "name": name,
        },
    }


def test_optional_write_step_hides_editor_tools_for_negative_write_prompt():
    tools = [
        _tool("read_document_segments"),
        _tool("update_file"),
        _tool("add_file_charts_to_note"),
        _tool("deliver_task"),
    ]

    filtered = filter_tools_for_step(
        step_type="P_SUMMARY_CARD",
        tools=tools,
        user_message="请总结这篇论文，但不要写笔记。",
        permissions={"paper": "read", "note": "write"},
        permitted_files_info={
            "paper": {"name": "paper.pdf", "type": "pdf"},
            "note": {"name": "note.md", "type": "md"},
        },
    )

    filtered_names = [tool["function"]["name"] for tool in filtered]
    assert "read_document_segments" in filtered_names
    assert "deliver_task" in filtered_names
    assert "update_file" not in filtered_names
    assert "add_file_charts_to_note" not in filtered_names
