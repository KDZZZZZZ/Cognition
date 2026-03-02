from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.models import File, FileType, Session
from app.services.tools.base import (
    BaseTool,
    PermissionLevel,
    ToolContext,
    ToolPermissionError,
    ToolResult,
    ToolValidationError,
)
from app.services.tools.executor import ToolExecutor
from app.services.tools.middleware import PermissionMiddleware
from app.services.tools.registry import ToolRegistry


class DummyTool(BaseTool):
    def __init__(
        self,
        *,
        tool_name: str = "dummy",
        required: PermissionLevel | None = None,
        writable_only: bool = False,
        execute_error: Exception | None = None,
    ):
        self._name = tool_name
        self._required = required
        self._writable_only = writable_only
        self._execute_error = execute_error

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return "dummy tool"

    @property
    def required_permission(self) -> PermissionLevel | None:
        return self._required

    @property
    def writable_only(self) -> bool:
        return self._writable_only

    @property
    def parameters_schema(self):
        return {
            "type": "object",
            "properties": {
                "file_id": {"type": "string"},
                "n": {"type": "integer"},
            },
            "required": ["file_id"],
        }

    async def execute(self, arguments, context):
        if self._execute_error:
            raise self._execute_error
        return ToolResult(success=True, data={"echo": arguments.get("file_id")})


def test_base_tool_validation_and_openai_format():
    tool = DummyTool(required=PermissionLevel.READ)
    with pytest.raises(ToolValidationError):
        tool.validate_arguments({})

    with pytest.raises(ToolValidationError):
        tool.validate_arguments({"file_id": "f1", "n": "bad"})

    tool.validate_arguments({"file_id": "f1", "n": 1})
    payload = tool.to_openai_format()
    assert payload["type"] == "function"
    assert payload["function"]["name"] == "dummy"


@pytest.mark.asyncio
async def test_permission_middleware_paths(db_session):
    middleware = PermissionMiddleware()
    db_session.add(
        Session(
            id="s1",
            name="Session",
            permissions={"f-md": "write", "f-none": "none", "bad": "invalid"},
        )
    )
    db_session.add(
        File(
            id="f-md",
            name="doc.md",
            file_type=FileType.MD,
            path="/tmp/doc.md",
            size=1,
            page_count=1,
            meta={},
        )
    )
    db_session.add(
        File(
            id="f-pdf",
            name="doc.pdf",
            file_type=FileType.PDF,
            path="/tmp/doc.pdf",
            size=1,
            page_count=1,
            meta={},
        )
    )
    await db_session.commit()

    context = await middleware.create_context("s1", db_session, cache={"x": 1})
    assert context.permissions["f-md"] == PermissionLevel.WRITE
    assert "bad" not in context.permissions

    write_tool = DummyTool(required=PermissionLevel.WRITE, writable_only=True)
    await middleware.check_permission(write_tool, {"file_id": "f-md"}, context)

    with pytest.raises(ToolPermissionError):
        await middleware.check_permission(write_tool, {"file_id": "f-none"}, context)

    ctx_pdf = ToolContext(
        session_id="s1",
        db=db_session,
        permissions={"f-pdf": PermissionLevel.WRITE},
    )
    with pytest.raises(ToolPermissionError):
        await middleware.check_permission(write_tool, {"file_id": "f-pdf"}, ctx_pdf)

    read_tool = DummyTool(required=PermissionLevel.READ)
    await middleware.check_permission(read_tool, {"file_id": "f-md"}, context)

    assert middleware.filter_visible_files(["f-md", "f-none"], context) == ["f-md"]
    assert middleware.filter_readable_files(["f-md", "f-none"], context) == ["f-md"]
    assert middleware.filter_writable_files(["f-md", "f-none"], context) == ["f-md"]

    middleware.invalidate_cache("s1")
    assert "s1" not in middleware._session_cache
    middleware.invalidate_cache()
    assert middleware._session_cache == {}


@pytest.mark.asyncio
async def test_tool_executor_paths(monkeypatch: pytest.MonkeyPatch, db_session):
    registry = ToolRegistry()
    ok_tool = DummyTool(tool_name="ok", required=PermissionLevel.READ)
    bad_tool = DummyTool(tool_name="boom", required=PermissionLevel.READ, execute_error=RuntimeError("boom"))
    registry.register(ok_tool)
    registry.register(bad_tool)

    executor = ToolExecutor(registry=registry)
    context = ToolContext(
        session_id="s1",
        db=db_session,
        permissions={"f1": PermissionLevel.READ},
    )

    unknown = await executor.execute("missing", {"file_id": "f1"}, context)
    assert unknown.error_code == "TOOL_NOT_FOUND"

    invalid = await executor.execute("ok", {"n": 1}, context)
    assert invalid.error_code == "VALIDATION_ERROR"

    monkeypatch.setattr(
        "app.services.tools.executor.permission_middleware.check_permission",
        AsyncMock(side_effect=ToolPermissionError("ok", "f1", PermissionLevel.READ)),
    )
    denied = await executor.execute("ok", {"file_id": "f1"}, context)
    assert denied.error_code == "PERMISSION_DENIED"

    monkeypatch.setattr(
        "app.services.tools.executor.permission_middleware.check_permission",
        AsyncMock(return_value=None),
    )
    exploded = await executor.execute("boom", {"file_id": "f1"}, context)
    assert exploded.error_code == "EXECUTION_ERROR"

    succeeded = await executor.execute("ok", {"file_id": "f1"}, context)
    assert succeeded.success is True
    assert succeeded.data["echo"] == "f1"

    batch = await executor.execute_batch(
        [{"name": "ok", "arguments": {"file_id": "f1"}}, {"arguments": {}}],
        context,
    )
    assert len(batch) == 2
    assert batch[1].error_code == "INVALID_CALL"

    tools_no_ctx = executor.get_available_tools()
    assert any(item["function"]["name"] == "ok" for item in tools_no_ctx)

    write_only = DummyTool(tool_name="write_only", required=PermissionLevel.WRITE, writable_only=True)
    registry.register(write_only)
    filtered = executor.get_available_tools(
        ToolContext(session_id="s1", db=db_session, permissions={"f1": PermissionLevel.READ})
    )
    assert all(item["function"]["name"] != "write_only" for item in filtered)
