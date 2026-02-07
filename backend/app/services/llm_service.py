from typing import List, Optional, Dict, Any
from openai import AsyncOpenAI
from anthropic import AsyncAnthropic

from app.config import settings
from app.models import DocumentChunk


class LLMService:
    """Service for interacting with LLM providers (DeepSeek, OpenAI, Anthropic)."""

    def __init__(self):
        self.openai_client = None
        self.anthropic_client = None
        self.deepseek_client = None

        if settings.OPENAI_API_KEY:
            self.openai_client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)

        if settings.ANTHROPIC_API_KEY:
            self.anthropic_client = AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)

        if settings.DEEPSEEK_API_KEY:
            # DeepSeek uses OpenAI-compatible API
            self.deepseek_client = AsyncOpenAI(
                api_key=settings.DEEPSEEK_API_KEY,
                base_url=settings.DEEPSEEK_BASE_URL
            )

    def get_client_for_model(self, model: str):
        """Get the appropriate client for a given model."""
        model_info = settings.AVAILABLE_MODELS.get(model, {})
        provider = model_info.get("provider", "openai")

        if provider == "deepseek":
            if not self.deepseek_client:
                raise ValueError("DeepSeek API key not configured")
            return self.deepseek_client
        elif provider == "openai":
            if not self.openai_client:
                raise ValueError("OpenAI API key not configured")
            return self.openai_client
        elif provider == "anthropic":
            if not self.anthropic_client:
                raise ValueError("Anthropic API key not configured")
            return self.anthropic_client

        raise ValueError(f"Unknown provider for model: {model}")

    async def get_embedding(self, text: str, model: Optional[str] = None) -> List[float]:
        """
        Get embedding for a text string.

        Args:
            text: The text to embed
            model: The embedding model to use (defaults to settings.EMBEDDING_MODEL)

        Returns:
            List of floats representing the embedding
        """
        if not self.openai_client:
            raise ValueError("OpenAI API key not configured")

        model = model or settings.EMBEDDING_MODEL

        response = await self.openai_client.embeddings.create(
            model=model,
            input=text
        )

        return response.data[0].embedding

    async def get_embeddings_batch(self, texts: List[str]) -> List[List[float]]:
        """Get embeddings for multiple texts in batch."""
        if not self.openai_client:
            raise ValueError("OpenAI API key not configured")

        response = await self.openai_client.embeddings.create(
            model=settings.EMBEDDING_MODEL,
            input=texts
        )

        return [item.embedding for item in response.data]

    async def chat_completion(
        self,
        messages: List[Dict[str, str]],
        model: Optional[str] = None,
        stream: bool = False,
        tools: Optional[List[Dict]] = None,
        system_prompt: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Get chat completion from LLM.

        Args:
            messages: List of message dicts with 'role' and 'content'
            model: The model to use (defaults to settings.DEFAULT_MODEL)
            stream: Whether to stream the response
            tools: List of available tools for the LLM
            system_prompt: Optional system prompt

        Returns:
            Response dictionary with content, tool_calls, etc.
        """
        model = model or settings.DEFAULT_MODEL

        # Determine which client to use based on model name
        if model.startswith("deepseek-"):
            return await self._openai_compatible_chat(messages, model, stream, tools, system_prompt, self.deepseek_client)
        elif model.startswith("gpt-") and self.openai_client:
            return await self._openai_compatible_chat(messages, model, stream, tools, system_prompt, self.openai_client)
        elif model.startswith("claude-") and self.anthropic_client:
            return await self._anthropic_chat(messages, model, stream, tools, system_prompt)
        else:
            raise ValueError(f"Unsupported model or API not configured: {model}")

    async def _openai_compatible_chat(
        self,
        messages: List[Dict[str, str]],
        model: str,
        stream: bool,
        tools: Optional[List[Dict]],
        system_prompt: Optional[str],
        client: AsyncOpenAI
    ) -> Dict[str, Any]:
        """OpenAI-compatible chat completion (works for DeepSeek too)."""
        kwargs = {
            "model": model,
            "messages": messages,
            "stream": stream
        }

        if system_prompt:
            kwargs["messages"] = [{"role": "system", "content": system_prompt}] + messages

        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"

        response = await client.chat.completions.create(**kwargs)

        message = response.choices[0].message

        return {
            "content": message.content or "",
            "tool_calls": [tc.model_dump() for tc in message.tool_calls] if message.tool_calls else None,
            "model": response.model,
            "usage": {
                "prompt_tokens": response.usage.prompt_tokens if response.usage else 0,
                "completion_tokens": response.usage.completion_tokens if response.usage else 0,
                "total_tokens": response.usage.total_tokens if response.usage else 0,
            },
            "reasoning_content": getattr(message, 'reasoning_content', None)  # DeepSeek thinking mode
        }

    async def _openai_chat(
        self,
        messages: List[Dict[str, str]],
        model: str,
        stream: bool,
        tools: Optional[List[Dict]],
        system_prompt: Optional[str]
    ) -> Dict[str, Any]:
        """OpenAI chat completion."""
        kwargs = {
            "model": model,
            "messages": messages,
            "stream": stream
        }

        if system_prompt:
            kwargs["messages"] = [{"role": "system", "content": system_prompt}] + messages

        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"

        response = await self.openai_client.chat.completions.create(**kwargs)

        message = response.choices[0].message

        return {
            "content": message.content or "",
            "tool_calls": [tc.model_dump() for tc in message.tool_calls] if message.tool_calls else None,
            "model": response.model,
            "usage": {
                "prompt_tokens": response.usage.prompt_tokens if response.usage else 0,
                "completion_tokens": response.usage.completion_tokens if response.usage else 0,
                "total_tokens": response.usage.total_tokens if response.usage else 0,
            }
        }

    async def _anthropic_chat(
        self,
        messages: List[Dict[str, str]],
        model: str,
        stream: bool,
        tools: Optional[List[Dict]],
        system_prompt: Optional[str]
    ) -> Dict[str, Any]:
        """Anthropic chat completion."""
        # Convert OpenAI-style messages to Anthropic format
        system_messages = []
        chat_messages = []

        for msg in messages:
            if msg["role"] == "system":
                system_messages.append(msg["content"])
            else:
                # Anthropic uses "user" and "assistant" roles
                role = "user" if msg["role"] == "user" else "assistant"
                chat_messages.append({"role": role, "content": msg["content"]})

        if system_prompt:
            system_messages.append(system_prompt)

        kwargs = {
            "model": model,
            "messages": chat_messages,
            "max_tokens": 4096
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
                {
                    "id": block.id,
                    "name": block.name,
                    "input": block.input
                }
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
            }
        }


llm_service = LLMService()
