import pytest

from app.services.tools.base import ToolContext, ToolValidationError
from app.services.tools.handlers.control_tools import PauseForUserChoiceTool
from app.services.tools.handlers.task_tools import DeliverTaskTool, RegisterTaskTool


def _context() -> ToolContext:
    return ToolContext(session_id="s1", db=None, permissions={})  # type: ignore[arg-type]


def test_pause_for_user_choice_validation_errors():
    tool = PauseForUserChoiceTool()
    with pytest.raises(ToolValidationError):
        tool.validate_arguments({"question": "", "options": [{"label": "A"}, {"label": "B"}]})
    with pytest.raises(ToolValidationError):
        tool.validate_arguments({"question": "Q", "options": [{"label": "Only one"}]})


@pytest.mark.asyncio
async def test_pause_for_user_choice_execute():
    tool = PauseForUserChoiceTool()
    args = {
        "question": "Choose",
        "options": [{"id": "a", "label": "A"}, {"id": "b", "label": "B"}],
        "recommended_option_id": "b",
        "allow_other": False,
    }
    res = await tool.execute(args, _context())
    assert res.success is True
    prompt = res.data["prompt"]
    assert prompt["recommended_option_id"] == "b"
    assert prompt["allow_other"] is False
    assert len(prompt["options"]) == 2


@pytest.mark.asyncio
async def test_task_tools_register_and_deliver():
    register_tool = RegisterTaskTool()
    deliver_tool = DeliverTaskTool()

    ok = await register_tool.execute({"task_name": "Write tests", "task_description": "more"}, _context())
    assert ok.success is True
    assert ok.data["status"] == "waiting"

    invalid_register = await register_tool.execute({"task_name": "   "}, _context())
    assert invalid_register.success is False
    assert invalid_register.error_code == "INVALID_TASK_NAME"

    deliver_ok = await deliver_tool.execute(
        {"task_name": "Write tests", "completion_summary": "done", "task_item_id": "task-1"},
        _context(),
    )
    assert deliver_ok.success is True
    assert deliver_ok.data["status"] == "completed"

    invalid_deliver = await deliver_tool.execute({"task_name": "", "completion_summary": ""}, _context())
    assert invalid_deliver.success is False
    assert invalid_deliver.error_code == "INVALID_TASK_DELIVERY"
