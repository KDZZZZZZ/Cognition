"""
Task lifecycle tools for agent-visible task registration and delivery.
"""
import uuid
from typing import Any, Dict

from app.services.tools.base import BaseTool, ToolContext, ToolResult


def _normalize_text(value: str, *, field: str) -> str:
    normalized = (value or "").strip()
    if not normalized:
        raise ValueError(f"{field} cannot be empty")
    return normalized


class RegisterTaskTool(BaseTool):
    @property
    def name(self) -> str:
        return "register_task"

    @property
    def description(self) -> str:
        return "Register a work item before executing tools. Requires a concrete task_name."

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "task_name": {
                    "type": "string",
                    "description": "Short concrete task name",
                },
                "task_description": {
                    "type": "string",
                    "description": "Optional details about the task objective",
                },
            },
            "required": ["task_name"],
        }

    async def execute(self, arguments: Dict[str, Any], context: ToolContext) -> ToolResult:
        try:
            task_name = _normalize_text(arguments.get("task_name", ""), field="task_name")
        except ValueError as exc:
            return ToolResult(success=False, error=str(exc), error_code="INVALID_TASK_NAME")

        task_description = str(arguments.get("task_description") or "").strip() or None
        task_item_id = str(uuid.uuid4())

        return ToolResult(
            success=True,
            data={
                "task_item_id": task_item_id,
                "task_name": task_name,
                "task_description": task_description,
                "status": "waiting",
            },
        )


class DeliverTaskTool(BaseTool):
    @property
    def name(self) -> str:
        return "deliver_task"

    @property
    def description(self) -> str:
        return "Mark a previously registered task as delivered. Must include completion_summary."

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "task_name": {
                    "type": "string",
                    "description": "Task name that matches a registered task",
                },
                "completion_summary": {
                    "type": "string",
                    "description": "Required description of what was completed",
                },
                "task_item_id": {
                    "type": "string",
                    "description": "Optional registered task ID when available",
                },
            },
            "required": ["task_name", "completion_summary"],
        }

    async def execute(self, arguments: Dict[str, Any], context: ToolContext) -> ToolResult:
        try:
            task_name = _normalize_text(arguments.get("task_name", ""), field="task_name")
            completion_summary = _normalize_text(
                arguments.get("completion_summary", ""), field="completion_summary"
            )
        except ValueError as exc:
            return ToolResult(success=False, error=str(exc), error_code="INVALID_TASK_DELIVERY")

        task_item_id = str(arguments.get("task_item_id") or "").strip() or None

        return ToolResult(
            success=True,
            data={
                "task_item_id": task_item_id,
                "task_name": task_name,
                "completion_summary": completion_summary,
                "status": "completed",
            },
        )
