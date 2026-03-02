import uuid
from typing import Any, Dict, List

from app.services.tools.base import BaseTool, ToolResult, ToolValidationError, ToolContext


class PauseForUserChoiceTool(BaseTool):
    @property
    def name(self) -> str:
        return "pause_for_user_choice"

    @property
    def description(self) -> str:
        return (
            "Pause current task and request user input with selectable options. "
            "Use when a choice must be confirmed before continuing."
        )

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "question": {"type": "string", "description": "Question shown to user"},
                "options": {
                    "type": "array",
                    "description": "Selectable options (2-5 items)",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string"},
                            "label": {"type": "string"},
                            "description": {"type": "string"},
                        },
                        "required": ["label"],
                    },
                },
                "recommended_option_id": {
                    "type": "string",
                    "description": "Optional recommended option id",
                },
                "allow_other": {
                    "type": "boolean",
                    "description": "Whether user can provide free-form alternative",
                    "default": True,
                },
                "other_placeholder": {
                    "type": "string",
                    "description": "Placeholder text for free-form alternative",
                    "default": "Input another option",
                },
            },
            "required": ["question", "options"],
        }

    def validate_arguments(self, arguments: Dict[str, Any]) -> None:
        super().validate_arguments(arguments)
        question = str(arguments.get("question") or "").strip()
        if not question:
            raise ToolValidationError(self.name, "question", "question cannot be empty")

        options = arguments.get("options")
        if not isinstance(options, list) or len(options) < 2 or len(options) > 5:
            raise ToolValidationError(self.name, "options", "options must be an array with 2-5 items")

        for idx, raw in enumerate(options):
            if not isinstance(raw, dict):
                raise ToolValidationError(self.name, "options", f"options[{idx}] must be an object")
            label = str(raw.get("label") or "").strip()
            if not label:
                raise ToolValidationError(self.name, "options", f"options[{idx}].label cannot be empty")

    async def execute(self, arguments: Dict[str, Any], context: ToolContext) -> ToolResult:
        question = str(arguments.get("question") or "").strip()
        allow_other = bool(arguments.get("allow_other", True))
        other_placeholder = str(arguments.get("other_placeholder") or "Input another option").strip()

        normalized_options: List[Dict[str, Any]] = []
        for idx, raw in enumerate(arguments.get("options") or []):
            option_id = str(raw.get("id") or f"opt_{idx + 1}").strip()
            label = str(raw.get("label") or "").strip()
            desc = str(raw.get("description") or "").strip()
            normalized_options.append(
                {
                    "id": option_id,
                    "label": label,
                    "description": desc or None,
                }
            )

        requested_recommended_id = str(arguments.get("recommended_option_id") or "").strip()
        normalized_ids = {item["id"] for item in normalized_options}
        if requested_recommended_id and requested_recommended_id in normalized_ids:
            recommended_option_id = requested_recommended_id
        else:
            recommended_option_id = normalized_options[0]["id"]

        for item in normalized_options:
            item["recommended"] = item["id"] == recommended_option_id

        prompt = {
            "prompt_id": str(uuid.uuid4()),
            "question": question,
            "options": normalized_options,
            "recommended_option_id": recommended_option_id,
            "allow_other": allow_other,
            "other_placeholder": other_placeholder,
        }

        return ToolResult(
            success=True,
            data={
                "pause_requested": True,
                "prompt": prompt,
            },
        )

