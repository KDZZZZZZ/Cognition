from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from main import app


@pytest.mark.asyncio
async def test_import_web_url_endpoint_success():
    fake_result = {
        "file_id": "fake-web-id",
        "type": "web",
        "ingest_status": "ready",
        "segment_count": 2,
        "index_status": {"parse_status": "ready", "embedding_status": "disabled"},
    }
    with patch("app.api.files.reader_orchestrator.import_web_url", new=AsyncMock(return_value=fake_result)):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post(
                "/api/v1/files/import/web-url",
                json={"url": "https://example.com"},
            )

    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["data"]["type"] == "web"
