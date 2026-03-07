from app.services.executor_prompt_service import build_step_executor_sections
from app.services.step_catalog_service import get_step_definition


def _tool(name: str) -> dict:
    return {
        "type": "function",
        "function": {
            "name": name,
        },
    }


def test_step_sections_add_writeback_contract_for_write_intent():
    step_definition = get_step_definition("P_SUMMARY_CARD")

    sections = build_step_executor_sections(
        global_rules_text="global rules",
        step_definition=step_definition,
        current_user_message="请把这篇 paper 的 1-6 卡片写入当前 note，并把关键图表补进去。",
        registry_snapshot={"registry_id": "r1", "status": "running", "tasks": []},
        active_task={"goal": "write paper note", "task_id": "t1", "total_steps": 4},
        active_step={"type": "P_SUMMARY_CARD", "index": 1},
        permissions={"paper": "read", "note": "write"},
        permitted_files_info={
            "paper": {"name": "paper.pdf", "type": "pdf"},
            "note": {"name": "paper-note.md", "type": "md"},
        },
        viewport_memory_summary=None,
        compact_summary=None,
        tools=[_tool("read_document_segments"), _tool("update_file"), _tool("add_file_charts_to_note")],
        previous_step_outputs_text=None,
        router_tool_hints=None,
        retrieval_summary_text=None,
    )

    contract_section = next(section for section in sections if section["key"] == "writeback_contract")
    assert contract_section["required"] is True
    assert "pending diff" in contract_section["text"]
    assert "paper-note.md" in contract_section["text"]
    assert "chart insertion as a follow-up improvement" in contract_section["text"]

    tool_policy_section = next(section for section in sections if section["key"] == "tool_policy")
    assert "Runtime Writeback Requirement: pending_diff_required" in tool_policy_section["text"]


def test_step_sections_skip_writeback_contract_without_write_intent():
    step_definition = get_step_definition("P_SUMMARY_CARD")

    sections = build_step_executor_sections(
        global_rules_text="global rules",
        step_definition=step_definition,
        current_user_message="请总结这篇 paper 的核心方法，不要写笔记。",
        registry_snapshot={"registry_id": "r1", "status": "running", "tasks": []},
        active_task={"goal": "answer paper question", "task_id": "t1", "total_steps": 4},
        active_step={"type": "P_SUMMARY_CARD", "index": 1},
        permissions={"paper": "read", "note": "write"},
        permitted_files_info={
            "paper": {"name": "paper.pdf", "type": "pdf"},
            "note": {"name": "paper-note.md", "type": "md"},
        },
        viewport_memory_summary=None,
        compact_summary=None,
        tools=[_tool("read_document_segments"), _tool("update_file")],
        previous_step_outputs_text=None,
        router_tool_hints=None,
        retrieval_summary_text=None,
    )

    contract_section = next(section for section in sections if section["key"] == "writeback_contract")
    assert contract_section["required"] is False
    assert contract_section["text"] == ""

    tool_policy_section = next(section for section in sections if section["key"] == "tool_policy")
    assert "Runtime Writeback Requirement: writeback_optional" in tool_policy_section["text"]
