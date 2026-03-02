from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.config import settings
from app.services.llm_service import LLMService


def _make_service() -> LLMService:
    service = LLMService.__new__(LLMService)
    service.openai_compatible_client = None
    service.openai_client = None
    service.deepseek_client = None
    service.anthropic_client = None
    return service


def test_supports_embeddings_and_vision(monkeypatch: pytest.MonkeyPatch):
    service = _make_service()

    monkeypatch.setattr(settings, "EMBEDDING_MODEL", "text-embedding-v3", raising=False)
    monkeypatch.setattr(settings, "OPENAI_BASE_URL", "https://api.deepseek.com", raising=False)
    monkeypatch.setattr(settings, "MOONSHOT_BASE_URL", "", raising=False)
    monkeypatch.setattr(settings, "DEFAULT_MODEL", "kimi-latest", raising=False)

    assert service.supports_embeddings() is False
    assert service.supports_vision() is False

    service.openai_compatible_client = object()
    assert service.supports_embeddings() is False

    assert service.supports_embeddings("text-embedding-v3") is False

    monkeypatch.setattr(settings, "OPENAI_BASE_URL", "https://api.openai.com/v1", raising=False)
    assert service.supports_embeddings("text-embedding-v3") is True

    assert service.supports_vision("text-embedding-v3") is False
    assert service.supports_vision("gpt-4o-mini") is True


@pytest.mark.asyncio
async def test_get_embedding_and_batch(monkeypatch: pytest.MonkeyPatch):
    service = _make_service()
    service.supports_embeddings = lambda model=None: True

    async def create_single(**kwargs):
        assert kwargs["input"] == "query"
        return SimpleNamespace(data=[SimpleNamespace(embedding=[0.1, 0.2, 0.3])])

    async def create_batch(**kwargs):
        assert kwargs["input"] == ["a", "b"]
        return SimpleNamespace(
            data=[SimpleNamespace(embedding=[1.0]), SimpleNamespace(embedding=[2.0])]
        )

    service.openai_compatible_client = SimpleNamespace(
        embeddings=SimpleNamespace(create=create_single)
    )

    monkeypatch.setattr(settings, "EMBEDDING_MODEL", "mock-embedding", raising=False)
    assert await service.get_embedding("query") == [0.1, 0.2, 0.3]

    service.openai_compatible_client = SimpleNamespace(
        embeddings=SimpleNamespace(create=create_batch)
    )
    assert await service.get_embeddings_batch(["a", "b"]) == [[1.0], [2.0]]


@pytest.mark.asyncio
async def test_chat_completion_routes_by_model(monkeypatch: pytest.MonkeyPatch):
    service = _make_service()
    service.openai_compatible_client = object()
    service.openai_client = object()
    service.deepseek_client = object()
    service.anthropic_client = object()

    anthropic_mock = AsyncMock(return_value={"content": "anthropic"})
    openai_mock = AsyncMock(return_value={"content": "openai"})
    monkeypatch.setattr(service, "_anthropic_chat", anthropic_mock)
    monkeypatch.setattr(service, "_openai_compatible_chat", openai_mock)

    await service.chat_completion(messages=[{"role": "user", "content": "hi"}], model="claude-3-5-sonnet")
    assert anthropic_mock.await_count == 1

    await service.chat_completion(messages=[{"role": "user", "content": "hi"}], model="deepseek-chat")
    assert openai_mock.await_count == 1

    await service.chat_completion(messages=[{"role": "user", "content": "hi"}], model="gpt-4o-mini")
    assert openai_mock.await_count == 2

    await service.chat_completion(messages=[{"role": "user", "content": "hi"}], model="kimi-latest")
    assert openai_mock.await_count == 3


@pytest.mark.asyncio
async def test_openai_compatible_chat_formats_response():
    service = _make_service()

    class FakeToolCall:
        def model_dump(self):
            return {"id": "tool-1", "type": "function"}

    captured = {}

    async def create(**kwargs):
        captured.update(kwargs)
        message = SimpleNamespace(content="answer", tool_calls=[FakeToolCall()], reasoning_content="trace")
        usage = SimpleNamespace(prompt_tokens=5, completion_tokens=7, total_tokens=12)
        return SimpleNamespace(
            choices=[SimpleNamespace(message=message)],
            model="mock-model",
            usage=usage,
        )

    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    result = await service._openai_compatible_chat(
        client=client,
        messages=[{"role": "user", "content": "hello"}],
        model="gpt-4o-mini",
        stream=False,
        tools=[{"type": "function"}],
        system_prompt="system prompt",
        on_stream_delta=None,
    )

    assert captured["messages"][0]["role"] == "system"
    assert captured["tool_choice"] == "auto"
    assert result["content"] == "answer"
    assert result["tool_calls"] == [{"id": "tool-1", "type": "function"}]
    assert result["usage"]["total_tokens"] == 12
    assert result["reasoning_content"] == "trace"


@pytest.mark.asyncio
async def test_openai_compatible_chat_streams_chunks_and_tool_calls():
    service = _make_service()
    streamed_chunks: list[str] = []

    class FakeToolCallDelta:
        def __init__(self, index: int, tool_id: str | None = None, name: str | None = None, arguments: str | None = None):
            self.index = index
            self.id = tool_id
            self.type = "function"
            self.function = SimpleNamespace(name=name, arguments=arguments)

    class FakeDelta:
        def __init__(self, content=None, tool_calls=None):
            self.content = content
            self.tool_calls = tool_calls or []
            self.reasoning_content = None

    class FakeChunk:
        def __init__(self, delta, usage=None):
            self.model = "stream-model"
            self.choices = [SimpleNamespace(delta=delta)]
            self.usage = usage

    class FakeAsyncStream:
        def __init__(self, chunks):
            self._chunks = chunks

        def __aiter__(self):
            self._iter = iter(self._chunks)
            return self

        async def __anext__(self):
            try:
                return next(self._iter)
            except StopIteration as exc:
                raise StopAsyncIteration from exc

    async def create(**kwargs):
        assert kwargs["stream"] is True
        return FakeAsyncStream(
            [
                FakeChunk(FakeDelta(content="Hel")),
                FakeChunk(FakeDelta(content="lo", tool_calls=[FakeToolCallDelta(index=0, tool_id="tc1", name="read_document_segments", arguments='{"file_id":"f1"')])),
                FakeChunk(FakeDelta(tool_calls=[FakeToolCallDelta(index=0, arguments='}')]), usage=SimpleNamespace(prompt_tokens=3, completion_tokens=5, total_tokens=8)),
            ]
        )

    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    result = await service._openai_compatible_chat(
        client=client,
        messages=[{"role": "user", "content": "hello"}],
        model="gpt-4o-mini",
        stream=True,
        tools=[{"type": "function"}],
        system_prompt=None,
        on_stream_delta=AsyncMock(side_effect=lambda chunk: streamed_chunks.append(chunk)),
    )

    assert "".join(streamed_chunks) == "Hello"
    assert result["content"] == "Hello"
    assert result["tool_calls"] == [
        {
            "id": "tc1",
            "type": "function",
            "function": {
                "name": "read_document_segments",
                "arguments": '{"file_id":"f1"}',
            },
        }
    ]
    assert result["usage"]["total_tokens"] == 8


@pytest.mark.asyncio
async def test_anthropic_chat_handles_system_messages_and_tool_use():
    service = _make_service()

    async def create(**kwargs):
        assert kwargs["system"] == "global system\n\noverride system"
        tool_block = SimpleNamespace(type="tool_use", id="tc1", name="search", input={"q": "k"})
        text_block = SimpleNamespace(type="text", text="final")
        usage = SimpleNamespace(input_tokens=3, output_tokens=4)
        return SimpleNamespace(
            content=[text_block, tool_block],
            stop_reason="tool_use",
            model="claude-3-opus",
            usage=usage,
        )

    service.anthropic_client = SimpleNamespace(messages=SimpleNamespace(create=create))
    response = await service._anthropic_chat(
        messages=[
            {"role": "system", "content": "global system"},
            {"role": "user", "content": {"k": "v"}},
        ],
        model="claude-3-opus",
        tools=[{"name": "search"}],
        system_prompt="override system",
    )

    assert response["model"] == "claude-3-opus"
    assert response["usage"]["total_tokens"] == 7
    assert response["tool_calls"] == [{"id": "tc1", "name": "search", "input": {"q": "k"}}]


@pytest.mark.asyncio
async def test_chat_completion_requires_client():
    service = _make_service()
    with pytest.raises(ValueError):
        await service.chat_completion(messages=[{"role": "user", "content": "hi"}], model="kimi-latest")
