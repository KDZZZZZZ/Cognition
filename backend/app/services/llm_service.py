from typing import Any, Dict, List, Optional

from anthropic import AsyncAnthropic
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

        if settings.OPENAI_API_KEY:
            # Default chain: OpenAI-compatible API endpoint.
            self.openai_compatible_client = AsyncOpenAI(
                api_key=settings.OPENAI_API_KEY,
                base_url=settings.OPENAI_BASE_URL,
            )
            # Optional plain OpenAI endpoint for gpt-* models when needed.
            self.openai_client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)

        if settings.DEEPSEEK_API_KEY:
            self.deepseek_client = AsyncOpenAI(
                api_key=settings.DEEPSEEK_API_KEY,
                base_url=settings.DEEPSEEK_BASE_URL,
            )

        if settings.ANTHROPIC_API_KEY:
            self.anthropic_client = AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)

    async def get_embedding(self, text: str, model: Optional[str] = None) -> List[float]:
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
        messages: List[Dict[str, str]],
        model: Optional[str] = None,
        stream: bool = False,
        tools: Optional[List[Dict]] = None,
        system_prompt: Optional[str] = None,
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
            )

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
        )

    async def _openai_compatible_chat(
        self,
        client: AsyncOpenAI,
        messages: List[Dict[str, str]],
        model: str,
        stream: bool,
        tools: Optional[List[Dict]],
        system_prompt: Optional[str],
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

    async def _anthropic_chat(
        self,
        messages: List[Dict[str, str]],
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
                system_messages.append(msg["content"])
            else:
                role = "user" if msg["role"] == "user" else "assistant"
                chat_messages.append({"role": role, "content": msg["content"]})

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
