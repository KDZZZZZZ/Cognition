import json
from typing import Any, Awaitable, Callable, Dict, List, Optional

from anthropic import AsyncAnthropic
import httpx
from openai import AsyncOpenAI

from app.config import settings


class LLMService:
    """
    LLM service with OpenAI-compatible default routing.

    Default chat/embedding path:
    - OPENAI_API_KEY + OPENAI_BASE_URL (DashScope-compatible by default)
    """

    def __init__(self):
        self.openai_compatible_client: Optional[AsyncOpenAI] = None
        self.openai_client: Optional[AsyncOpenAI] = None
        self.deepseek_client: Optional[AsyncOpenAI] = None
        self.anthropic_client: Optional[AsyncAnthropic] = None

        primary_api_key = settings.MOONSHOT_API_KEY or settings.OPENAI_API_KEY
        primary_base_url = settings.OPENAI_BASE_URL or settings.MOONSHOT_BASE_URL

        if primary_api_key:
            # Default chain: OpenAI-compatible API endpoint (Kimi by default).
            self.openai_compatible_client = self._create_openai_client(
                api_key=primary_api_key,
                base_url=primary_base_url,
            )

        if settings.OPENAI_API_KEY:
            # Optional plain OpenAI endpoint for gpt-* models when OpenAI key is present.
            self.openai_client = self._create_openai_client(api_key=settings.OPENAI_API_KEY)

        if settings.DEEPSEEK_API_KEY:
            self.deepseek_client = self._create_openai_client(
                api_key=settings.DEEPSEEK_API_KEY,
                base_url=settings.DEEPSEEK_BASE_URL,
            )

        if settings.ANTHROPIC_API_KEY:
            self.anthropic_client = AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)

    def _create_openai_client(self, api_key: str, base_url: Optional[str] = None) -> AsyncOpenAI:
        kwargs: Dict[str, Any] = {
            "api_key": api_key,
            "http_client": httpx.AsyncClient(trust_env=settings.LLM_TRUST_ENV_PROXY),
        }
        if base_url:
            kwargs["base_url"] = base_url
        return AsyncOpenAI(**kwargs)

    def supports_embeddings(self, model: Optional[str] = None) -> bool:
        """Whether current env can safely call embedding APIs."""
        if not (self.openai_compatible_client or self.openai_client):
            return False

        selected_model = (model or settings.EMBEDDING_MODEL or "").strip().lower()
        if not selected_model:
            return False

        selected_base = (settings.OPENAI_BASE_URL or settings.MOONSHOT_BASE_URL or "").strip().lower()

        # DeepSeek public docs expose chat/completions-compatible APIs;
        # generic OpenAI embedding models (e.g. text-embedding-v3) are not guaranteed there.
        if "api.deepseek.com" in selected_base and selected_model.startswith("text-embedding"):
            return False
        if "api.moonshot.cn" in selected_base and selected_model.startswith("text-embedding"):
            return False
        return True

    def supports_vision(self, model: Optional[str] = None) -> bool:
        """Best-effort capability check for multimodal image input."""
        if not (self.openai_compatible_client or self.openai_client or self.deepseek_client):
            return False

        selected_model = (model or settings.DEFAULT_MODEL or "").strip().lower()
        if not selected_model:
            return False
        if selected_model.startswith("text-embedding"):
            return False
        return True

    async def get_embedding(self, text: str, model: Optional[str] = None) -> List[float]:
        if not self.supports_embeddings(model):
            raise ValueError("Embedding endpoint is not configured for current provider/model")

        client = self.openai_compatible_client or self.openai_client
        if not client:
            raise ValueError("OpenAI-compatible client not configured")

        response = await client.embeddings.create(
            model=model or settings.EMBEDDING_MODEL,
            input=text,
        )
        return response.data[0].embedding

    async def get_embeddings_batch(
        self,
        texts: List[str],
        model: Optional[str] = None,
    ) -> List[List[float]]:
        if not self.supports_embeddings(model):
            raise ValueError("Embedding endpoint is not configured for current provider/model")

        client = self.openai_compatible_client or self.openai_client
        if not client:
            raise ValueError("OpenAI-compatible client not configured")

        response = await client.embeddings.create(
            model=model or settings.EMBEDDING_MODEL,
            input=texts,
        )
        return [item.embedding for item in response.data]

    async def chat_completion(
        self,
        messages: List[Dict[str, Any]],
        model: Optional[str] = None,
        stream: bool = False,
        tools: Optional[List[Dict]] = None,
        system_prompt: Optional[str] = None,
        on_stream_delta: Optional[Callable[[str], Awaitable[None]]] = None,
    ) -> Dict[str, Any]:
        selected_model = model or settings.DEFAULT_MODEL

        if selected_model.startswith("claude-"):
            return await self._anthropic_chat(
                messages=messages,
                model=selected_model,
                tools=tools,
                system_prompt=system_prompt,
            )

        if selected_model.startswith("deepseek-") and self.deepseek_client:
            return await self._openai_compatible_chat(
                client=self.deepseek_client,
                messages=messages,
                model=selected_model,
                stream=stream,
                tools=tools,
                system_prompt=system_prompt,
                on_stream_delta=on_stream_delta,
            )

        client: Optional[AsyncOpenAI]
        if selected_model.startswith("gpt-"):
            client = self.openai_client or self.openai_compatible_client
        else:
            client = self.openai_compatible_client or self.openai_client

        if not client:
            raise ValueError("OpenAI-compatible client not configured")

        return await self._openai_compatible_chat(
            client=client,
            messages=messages,
            model=selected_model,
            stream=stream,
            tools=tools,
            system_prompt=system_prompt,
            on_stream_delta=on_stream_delta,
        )

    async def _openai_compatible_chat(
        self,
        client: AsyncOpenAI,
        messages: List[Dict[str, Any]],
        model: str,
        stream: bool,
        tools: Optional[List[Dict]],
        system_prompt: Optional[str],
        on_stream_delta: Optional[Callable[[str], Awaitable[None]]],
    ) -> Dict[str, Any]:
        request_messages = messages
        if system_prompt:
            request_messages = [{"role": "system", "content": system_prompt}, *messages]

        kwargs: Dict[str, Any] = {
            "model": model,
            "messages": request_messages,
            "stream": stream,
        }
        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"

        if stream:
            return await self._stream_openai_compatible_chat(
                client=client,
                kwargs=kwargs,
                fallback_model=model,
                on_stream_delta=on_stream_delta,
            )

        response = await client.chat.completions.create(**kwargs)
        message = response.choices[0].message
        tool_calls = None
        if message.tool_calls:
            tool_calls = [tool_call.model_dump() for tool_call in message.tool_calls]

        return {
            "content": message.content or "",
            "tool_calls": tool_calls,
            "model": response.model,
            "usage": {
                "prompt_tokens": response.usage.prompt_tokens if response.usage else 0,
                "completion_tokens": response.usage.completion_tokens if response.usage else 0,
                "total_tokens": response.usage.total_tokens if response.usage else 0,
            },
            "reasoning_content": getattr(message, "reasoning_content", None),
        }

    @staticmethod
    def _coerce_delta_text(value: Any) -> str:
        if value is None:
            return ""
        if isinstance(value, str):
            return value
        if isinstance(value, list):
            parts: List[str] = []
            for item in value:
                if isinstance(item, dict):
                    text_value = item.get("text")
                    if isinstance(text_value, str):
                        parts.append(text_value)
                    continue
                text_value = getattr(item, "text", None)
                if isinstance(text_value, str):
                    parts.append(text_value)
            return "".join(parts)
        return str(value)

    async def _stream_openai_compatible_chat(
        self,
        *,
        client: AsyncOpenAI,
        kwargs: Dict[str, Any],
        fallback_model: str,
        on_stream_delta: Optional[Callable[[str], Awaitable[None]]],
    ) -> Dict[str, Any]:
        response_stream = await client.chat.completions.create(**kwargs)
        response_model = fallback_model
        prompt_tokens = 0
        completion_tokens = 0
        total_tokens = 0
        reasoning_parts: List[str] = []
        content_parts: List[str] = []
        tool_call_builders: Dict[int, Dict[str, Any]] = {}

        async for chunk in response_stream:
            response_model = getattr(chunk, "model", None) or response_model
            usage = getattr(chunk, "usage", None)
            if usage is not None:
                prompt_tokens = getattr(usage, "prompt_tokens", prompt_tokens) or prompt_tokens
                completion_tokens = getattr(usage, "completion_tokens", completion_tokens) or completion_tokens
                total_tokens = getattr(usage, "total_tokens", total_tokens) or total_tokens

            for choice in getattr(chunk, "choices", []) or []:
                delta = getattr(choice, "delta", None)
                if delta is None:
                    continue

                delta_text = self._coerce_delta_text(getattr(delta, "content", None))
                if delta_text:
                    content_parts.append(delta_text)
                    if on_stream_delta is not None:
                        await on_stream_delta(delta_text)

                reasoning_text = self._coerce_delta_text(getattr(delta, "reasoning_content", None))
                if reasoning_text:
                    reasoning_parts.append(reasoning_text)

                delta_tool_calls = getattr(delta, "tool_calls", None) or []
                for tool_call in delta_tool_calls:
                    index = int(getattr(tool_call, "index", 0) or 0)
                    builder = tool_call_builders.setdefault(
                        index,
                        {
                            "id": None,
                            "type": "function",
                            "function": {"name": "", "arguments": ""},
                        },
                    )
                    tool_call_id = getattr(tool_call, "id", None)
                    if tool_call_id:
                        builder["id"] = tool_call_id
                    tool_type = getattr(tool_call, "type", None)
                    if tool_type:
                        builder["type"] = tool_type

                    function_delta = getattr(tool_call, "function", None)
                    if function_delta is None:
                        continue
                    function_name = getattr(function_delta, "name", None)
                    function_arguments = getattr(function_delta, "arguments", None)
                    if function_name:
                        builder["function"]["name"] += function_name
                    if function_arguments:
                        builder["function"]["arguments"] += function_arguments

        tool_calls = None
        if tool_call_builders:
            tool_calls = []
            for index in sorted(tool_call_builders.keys()):
                built = tool_call_builders[index]
                tool_calls.append(
                    {
                        "id": built.get("id"),
                        "type": built.get("type", "function"),
                        "function": {
                            "name": built["function"].get("name", ""),
                            "arguments": built["function"].get("arguments", ""),
                        },
                    }
                )

        return {
            "content": "".join(content_parts),
            "tool_calls": tool_calls,
            "model": response_model,
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": total_tokens,
            },
            "reasoning_content": "".join(reasoning_parts) or None,
        }

    async def _anthropic_chat(
        self,
        messages: List[Dict[str, Any]],
        model: str,
        tools: Optional[List[Dict]],
        system_prompt: Optional[str],
    ) -> Dict[str, Any]:
        if not self.anthropic_client:
            raise ValueError("Anthropic API key not configured")

        system_messages: List[str] = []
        chat_messages: List[Dict[str, str]] = []

        for msg in messages:
            if msg["role"] == "system":
                content = msg.get("content", "")
                if isinstance(content, str):
                    system_messages.append(content)
                else:
                    system_messages.append(json.dumps(content, ensure_ascii=False))
            else:
                role = "user" if msg["role"] == "user" else "assistant"
                content = msg.get("content", "")
                if isinstance(content, str):
                    chat_messages.append({"role": role, "content": content})
                else:
                    chat_messages.append({"role": role, "content": json.dumps(content, ensure_ascii=False)})

        if system_prompt:
            system_messages.append(system_prompt)

        kwargs: Dict[str, Any] = {
            "model": model,
            "messages": chat_messages,
            "max_tokens": 4096,
        }
        if system_messages:
            kwargs["system"] = "\n\n".join(system_messages)
        if tools:
            kwargs["tools"] = tools

        response = await self.anthropic_client.messages.create(**kwargs)
        content = response.content[0].text if response.content else ""
        tool_calls = None
        if response.stop_reason == "tool_use":
            tool_calls = [
                {"id": block.id, "name": block.name, "input": block.input}
                for block in response.content
                if block.type == "tool_use"
            ]

        return {
            "content": content,
            "tool_calls": tool_calls,
            "model": response.model,
            "usage": {
                "prompt_tokens": response.usage.input_tokens,
                "completion_tokens": response.usage.output_tokens,
                "total_tokens": response.usage.input_tokens + response.usage.output_tokens,
            },
        }


llm_service = LLMService()
