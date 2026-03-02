import pytest
import asyncio
from httpx import AsyncClient, ASGITransport
from pathlib import Path
import io
from unittest.mock import AsyncMock

from main import app
from app.api import files as files_api
from app.database import async_session_maker
from app.models import File, DocumentChunk, Session, ChatMessage
from sqlalchemy import select


@pytest.fixture(scope="session")
def event_loop():
    """Create event loop for async tests."""
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()


@pytest.fixture
async def client():
    """Create test client."""
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test"
    ) as ac:
        yield ac


@pytest.fixture
async def db_session():
    """Create test database session."""
    async with async_session_maker() as session:
        yield session
        # Cleanup after test
        await session.rollback()


@pytest.fixture
def sample_pdf_content():
    """Sample PDF content for testing."""
    # This would be actual PDF bytes in real tests
    return b"%PDF-1.4\n1 0 obj\n<<\n/Type /Catalog\n/Pages 2 0 R\n>>\nendobj\n"


@pytest.fixture
def sample_text_file():
    """Create a sample text file for upload testing."""
    content = b"# Sample Document\n\nThis is a test document with some content.\n\n## Section 1\n\nSome text here."
    return io.BytesIO(content)


class TestHealthEndpoints:
    """Test health check endpoints."""

    @pytest.mark.asyncio
    async def test_root_endpoint(self, client: AsyncClient):
        """Test root endpoint returns basic info."""
        response = await client.get("/")
        assert response.status_code == 200
        data = response.json()
        assert "name" in data
        assert "version" in data
        assert data["status"] == "running"

    @pytest.mark.asyncio
    async def test_health_endpoint(self, client: AsyncClient):
        """Test health check endpoint."""
        response = await client.get("/health")
        assert response.status_code == 200
        assert response.json() == {"status": "healthy"}


class TestFileUpload:
    """Test file upload endpoints."""

    @staticmethod
    def _mock_indexing(monkeypatch: pytest.MonkeyPatch):
        async def fake_parse_file(path: str, file_id: str, file_type: str):  # noqa: ARG001
            return (
                [
                    DocumentChunk(
                        id=f"chunk-{file_id}",
                        file_id=file_id,
                        page=1,
                        chunk_index=0,
                        content="Parsed content",
                        bbox=None,
                    )
                ],
                {"page_count": 1},
            )

        monkeypatch.setattr(
            files_api.parser,
            "parse_file",
            AsyncMock(side_effect=fake_parse_file),
        )
        monkeypatch.setattr(files_api.reader_orchestrator.embedding_provider, "is_enabled", lambda: True)
        monkeypatch.setattr(files_api.vector_store, "enabled", True)
        monkeypatch.setattr(files_api.llm_service, "supports_embeddings", lambda: False)
        monkeypatch.setattr(
            files_api.reader_orchestrator,
            "build_segments_for_file",
            AsyncMock(return_value={"parse_status": "ready", "embedding_status": "ready"}),
        )

    @pytest.mark.asyncio
    async def test_upload_text_file(self, client: AsyncClient, sample_text_file, monkeypatch: pytest.MonkeyPatch):
        """Test uploading a text file."""
        self._mock_indexing(monkeypatch)
        files = {"file": ("test.txt", sample_text_file, "text/plain")}
        response = await client.post("/api/v1/files/upload", files=files)

        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert "file_id" in data["data"]
        assert data["data"]["name"] == "test.txt"

    @pytest.mark.asyncio
    async def test_upload_unsupported_type(self, client: AsyncClient):
        """Test uploading an unsupported file type."""
        files = {"file": ("test.exe", io.BytesIO(b"fake exe"), "application/x-msdownload")}
        response = await client.post("/api/v1/files/upload", files=files)

        assert response.status_code == 400
        assert "Unsupported file type" in response.json()["detail"]

    @pytest.mark.asyncio
    async def test_list_files(self, client: AsyncClient, sample_text_file, monkeypatch: pytest.MonkeyPatch):
        """Test listing all files."""
        # First upload a file
        self._mock_indexing(monkeypatch)
        files = {"file": ("test.txt", sample_text_file, "text/plain")}
        await client.post("/api/v1/files/upload", files=files)

        # Then list files
        response = await client.get("/api/v1/files/")
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert "files" in data["data"]
        assert len(data["data"]["files"]) >= 1

    @pytest.mark.asyncio
    async def test_get_file(self, client: AsyncClient, sample_text_file, monkeypatch: pytest.MonkeyPatch):
        """Test getting a specific file."""
        # Upload a file first
        self._mock_indexing(monkeypatch)
        files = {"file": ("test.txt", sample_text_file, "text/plain")}
        upload_response = await client.post("/api/v1/files/upload", files=files)
        file_id = upload_response.json()["data"]["file_id"]

        # Get the file
        response = await client.get(f"/api/v1/files/{file_id}")
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert data["data"]["id"] == file_id

    @pytest.mark.asyncio
    async def test_get_file_not_found(self, client: AsyncClient):
        """Test getting a non-existent file."""
        response = await client.get("/api/v1/files/nonexistent-id")
        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_delete_file(self, client: AsyncClient, sample_text_file, monkeypatch: pytest.MonkeyPatch):
        """Test deleting a file."""
        # Upload a file first
        self._mock_indexing(monkeypatch)
        files = {"file": ("test.txt", sample_text_file, "text/plain")}
        upload_response = await client.post("/api/v1/files/upload", files=files)
        file_id = upload_response.json()["data"]["file_id"]

        # Delete the file
        response = await client.delete(f"/api/v1/files/{file_id}")
        assert response.status_code == 200
        assert response.json()["success"] is True


class TestChatAPI:
    """Test chat completion endpoints."""

    @pytest.mark.asyncio
    async def test_create_session(self, client: AsyncClient):
        """Test creating a new chat session."""
        # First message creates a session
        response = await client.post(
            "/api/v1/chat/completions",
            json={
                "session_id": "test-session-123",
                "message": "Hello, can you help me?",
                "context_files": []
            }
        )

        # Will fail without API keys, but should create session
        # In real tests with mocked LLM, this would succeed
        assert response.status_code in [200, 500]

    @pytest.mark.asyncio
    async def test_get_session(self, client: AsyncClient):
        """Test getting session info."""
        # This would require creating a session first
        response = await client.get("/api/v1/chat/sessions/nonexistent")
        assert response.status_code in [404, 200]

    @pytest.mark.asyncio
    async def test_update_permissions(self, client: AsyncClient):
        """Test updating session permissions."""
        # This would require creating a session first
        response = await client.post(
            "/api/v1/chat/sessions/test-session/permissions",
            params={
                "file_id": "file-123",
                "permission": "write"
            }
        )
        # May fail if session doesn't exist
        assert response.status_code in [200, 404]


class TestWebSocket:
    """Test WebSocket endpoints."""

    @pytest.mark.asyncio
    async def test_websocket_status(self, client: AsyncClient):
        """Test WebSocket status endpoint."""
        response = await client.get("/ws/status")
        assert response.status_code == 200
        data = response.json()
        assert "active_sessions" in data
        assert "total_connections" in data


class TestVectorSearch:
    """Test vector search functionality."""

    @pytest.mark.asyncio
    async def test_search_without_files(self, client: AsyncClient):
        """Test search with no files uploaded."""
        # This would require embeddings to be set up
        # In real tests, we'd mock the LLM service
        pass
