from app.services.multiformat_document_service import (
    Qwen3VLEmbeddingProvider,
    _extract_web_blocks_from_html,
)
from unittest.mock import AsyncMock

import pytest


def test_extract_web_blocks_from_html_basic():
    html = """
    <html><body>
      <h1>Title</h1>
      <p>This is a paragraph with enough content to be retained.</p>
      <ul><li>First bullet item with content.</li></ul>
    </body></html>
    """
    blocks = _extract_web_blocks_from_html(html, source_url="https://example.com")
    assert len(blocks) >= 2
    assert any(block.segment_type == "heading" for block in blocks)
    assert any("source_url" in block.meta for block in blocks)


def test_qwen_embedding_provider_disabled_without_key():
    provider = Qwen3VLEmbeddingProvider()
    # Repo default has empty key; provider should be disabled in tests by default.
    if provider.api_key:
        # In environments where key is injected, just assert model is configured.
        assert provider.model
    else:
        assert provider.is_enabled() is False


def test_qwen_embedding_provider_splits_image_batches():
    provider = Qwen3VLEmbeddingProvider()
    provider.batch_size = 20

    batches = provider._split_contents_for_requests([{"image": f"data://{idx}"} for idx in range(23)])

    assert [len(batch) for batch in batches] == [5, 5, 5, 5, 3]


@pytest.mark.asyncio
async def test_qwen_embedding_provider_keeps_text_batch_size():
    provider = Qwen3VLEmbeddingProvider()
    provider.batch_size = 20
    provider._request_embeddings = AsyncMock(side_effect=lambda batch: [[float(len(batch))]] * len(batch))

    vectors = await provider.embed_text([f"text-{idx}" for idx in range(23)])

    assert len(vectors) == 23
    assert [len(call.args[0]) for call in provider._request_embeddings.await_args_list] == [20, 3]
