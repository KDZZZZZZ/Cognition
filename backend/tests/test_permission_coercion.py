import io
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient

from app.api import files as files_api
from app.models import DocumentChunk
from main import app


@pytest.fixture
async def client():
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as ac:
        yield ac


def _mock_upload_indexing(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_parse_file(path: str, file_id: str, file_type: str):  # noqa: ARG001
        return (
            [
                DocumentChunk(
                    id=f"chunk-{file_id}",
                    file_id=file_id,
                    page=1,
                    chunk_index=0,
                    content="parsed content",
                    bbox=None,
                )
            ],
            {"page_count": 1},
        )

    monkeypatch.setattr(files_api.parser, "parse_file", AsyncMock(side_effect=fake_parse_file))
    monkeypatch.setattr(files_api.reader_orchestrator.embedding_provider, "is_enabled", lambda: True)
    monkeypatch.setattr(files_api.vector_store, "enabled", True)
    monkeypatch.setattr(files_api.llm_service, "supports_embeddings", lambda: False)
    monkeypatch.setattr(
        files_api.reader_orchestrator,
        "build_segments_for_file",
        AsyncMock(return_value={"parse_status": "ready", "embedding_status": "ready"}),
    )


@pytest.mark.asyncio
async def test_create_session_coerces_non_md_write(client: AsyncClient, monkeypatch: pytest.MonkeyPatch):
    _mock_upload_indexing(monkeypatch)
    md_file = await client.post(
        "/api/v1/files/upload",
        files={"file": ("note.md", io.BytesIO(b"# note\n"), "text/markdown")},
    )
    txt_file = await client.post(
        "/api/v1/files/upload",
        files={"file": ("readme.txt", io.BytesIO(b"hello"), "text/plain")},
    )
    assert md_file.status_code == 200
    assert txt_file.status_code == 200

    md_id = md_file.json()["data"]["file_id"]
    txt_id = txt_file.json()["data"]["file_id"]

    response = await client.post(
        "/api/v1/chat/sessions",
        json={
            "name": "permission-test",
            "permissions": {
                md_id: "write",
                txt_id: "write",
            },
        },
    )
    assert response.status_code == 200
    payload = response.json()["data"]
    assert payload["permissions"][md_id] == "write"
    assert payload["permissions"][txt_id] == "read"


@pytest.mark.asyncio
async def test_update_permission_returns_coerced_flag(client: AsyncClient, monkeypatch: pytest.MonkeyPatch):
    _mock_upload_indexing(monkeypatch)
    txt_file = await client.post(
        "/api/v1/files/upload",
        files={"file": ("plain.txt", io.BytesIO(b"hello"), "text/plain")},
    )
    assert txt_file.status_code == 200
    txt_id = txt_file.json()["data"]["file_id"]

    session = await client.post(
        "/api/v1/chat/sessions",
        json={"name": "permission-single-update"},
    )
    assert session.status_code == 200
    session_id = session.json()["data"]["id"]

    response = await client.post(
        f"/api/v1/chat/sessions/{session_id}/permissions",
        params={"file_id": txt_id, "permission": "write"},
    )
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["requested_permission"] == "write"
    assert data["permission"] == "read"
    assert data["coerced"] is True
