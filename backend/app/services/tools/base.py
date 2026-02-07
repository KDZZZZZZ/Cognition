"""
Base tool interface and common types for the Agent tool system.
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
from typing import Any, Optional, Dict, List
from sqlalchemy.ext.asyncio import AsyncSession


class PermissionLevel(str, Enum):
    """File permission levels for a session."""
    READ = "read"
    WRITE = "write"
    NONE = "none"


class FileType(str, Enum):
    """Supported file types."""
    MD = "md"
    PDF = "pdf"
    DOCX = "docx"
    TXT = "txt"


@dataclass
class ToolContext:
    """Context passed to all tool handlers."""
    session_id: str
    db: AsyncSession
    permissions: Dict[str, PermissionLevel]

    # Optional caching layer
    cache: Optional[Dict[str, Any]] = None


@dataclass
class ToolResult:
    """Standardized result from tool execution."""
    success: bool
    data: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    error_code: Optional[str] = None  # For i18n friendly error codes

    def to_dict(self) -> Dict[str, Any]:
        """Convert to API response format."""
        result = {
            "success": self.success
        }
        if self.data is not None:
            result["data"] = self.data
        if self.error:
            result["error"] = self.error
        if self.error_code:
            result["error_code"] = self.error_code
        return result


class ToolPermissionError(Exception):
    """Raised when a tool operation lacks required permissions."""

    def __init__(self, tool_name: str, file_id: str, required: PermissionLevel):
        self.tool_name = tool_name
        self.file_id = file_id
        self.required = required
        super().__init__(
            f"Tool '{tool_name}' requires {required.value} permission on file {file_id}"
        )


class ToolValidationError(Exception):
    """Raised when tool input validation fails."""

    def __init__(self, tool_name: str, field: str, message: str):
        self.tool_name = tool_name
        self.field = field
        self.message = message
        super().__init__(f"Validation error in {tool_name}.{field}: {message}")


class BaseTool(ABC):
    """
    Abstract base class for all Agent tools.

    All tools must inherit from this class and implement the required methods.
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """The unique name of the tool (used for LLM function calling)."""
        pass

    @property
    @abstractmethod
    def description(self) -> str:
        """Human-readable description of what the tool does."""
        pass

    @property
    def required_permission(self) -> Optional[PermissionLevel]:
        """
        The minimum permission level required for this tool.
        None means no permission check needed.
        """
        return None

    @property
    def writable_only(self) -> bool:
        """
        If True, this tool can only operate on files that support writing.
        Currently only .md files support write operations.
        """
        return False

    @property
    @abstractmethod
    def parameters_schema(self) -> Dict[str, Any]:
        """
        JSON Schema for the tool's parameters.
        This will be sent to the LLM.
        """
        pass

    @abstractmethod
    async def execute(
        self,
        arguments: Dict[str, Any],
        context: ToolContext
    ) -> ToolResult:
        """
        Execute the tool with the given arguments.

        Args:
            arguments: Validated arguments from the LLM
            context: Execution context including session and DB

        Returns:
            ToolResult with success status and data/error
        """
        pass

    def validate_arguments(self, arguments: Dict[str, Any]) -> None:
        """
        Validate arguments before execution.
        Raises ToolValidationError if invalid.

        Default implementation checks required fields.
        Override for custom validation.
        """
        required = self.parameters_schema.get("required", [])
        properties = self.parameters_schema.get("properties", {})

        for field in required:
            if field not in arguments:
                raise ToolValidationError(
                    self.name,
                    field,
                    f"Required field '{field}' is missing"
                )

        # Type validation for basic types
        for field, value in arguments.items():
            if field not in properties:
                continue
            prop_type = properties[field].get("type")
            if prop_type == "string" and not isinstance(value, str):
                raise ToolValidationError(
                    self.name,
                    field,
                    f"Expected string, got {type(value).__name__}"
                )
            elif prop_type == "integer" and not isinstance(value, int):
                raise ToolValidationError(
                    self.name,
                    field,
                    f"Expected integer, got {type(value).__name__}"
                )
            elif prop_type == "array" and not isinstance(value, list):
                raise ToolValidationError(
                    self.name,
                    field,
                    f"Expected array, got {type(value).__name__}"
                )
            elif prop_type == "boolean" and not isinstance(value, bool):
                raise ToolValidationError(
                    self.name,
                    field,
                    f"Expected boolean, got {type(value).__name__}"
                )

    def to_openai_format(self) -> Dict[str, Any]:
        """Convert tool to OpenAI function calling format."""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters_schema
            }
        }
