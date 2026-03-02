import json
from typing import Any, Dict, List

import pytest
from fastapi import WebSocketDisconnect

from app.api import websocket as websocket_api


class FakeManager:
    def __init__(self):
        self.sessions = {"s1": {"c1": object()}}
        self.viewport_states = {"s1": {"file_id": "f1"}}
        self.connected: List[tuple[Any, str]] = []
        self.updated: List[tuple[str, Any]] = []
        self.broadcasted: List[tuple[str, Dict[str, Any], str | None]] = []
        self.disconnected: List[str] = []

    async def connect(self, websocket: Any, session_id: str) -> str:
        self.connected.append((websocket, session_id))
        return "client-1"

    async def update_viewport(self, client_id: str, viewport: Any):
        self.updated.append((client_id, viewport))

    async def broadcast_to_session(self, session_id: str, message: Dict[str, Any], exclude_client: str | None = None):
        self.broadcasted.append((session_id, message, exclude_client))

    def disconnect(self, client_id: str):
        self.disconnected.append(client_id)


class FakeWebSocket:
    def __init__(self, messages: List[Dict[str, Any]]):
        self.messages = [json.dumps(msg) for msg in messages]
        self.sent_json: List[Dict[str, Any]] = []

    async def receive_text(self) -> str:
        if self.messages:
            return self.messages.pop(0)
        raise WebSocketDisconnect()

    async def send_json(self, payload: Dict[str, Any]):
        self.sent_json.append(payload)


@pytest.mark.asyncio
async def test_websocket_endpoint_handles_messages(monkeypatch: pytest.MonkeyPatch):
    manager = FakeManager()
    monkeypatch.setattr(websocket_api, "manager", manager)
    ws = FakeWebSocket(
        [
            {
                "type": "viewport_update",
                "data": {"file_id": "f1", "page": 1, "scroll_y": 10, "visible_range": [0, 100]},
            },
            {"type": "chat_message", "data": {"content": "hello"}},
            {"type": "ping"},
        ]
    )

    await websocket_api.websocket_endpoint(ws, session_id="s1")

    assert manager.connected
    assert len(manager.updated) == 1
    assert any(msg[1]["type"] == "chat_message" for msg in manager.broadcasted)
    assert ws.sent_json == [{"type": "pong"}]
    assert manager.disconnected == ["client-1"]


@pytest.mark.asyncio
async def test_websocket_status_payload(monkeypatch: pytest.MonkeyPatch):
    manager = FakeManager()
    manager.sessions = {"a": {"1": object(), "2": object()}, "b": {"3": object()}}
    manager.viewport_states = {"a": {"page": 3}}
    monkeypatch.setattr(websocket_api, "manager", manager)

    payload = await websocket_api.websocket_status()
    assert payload["active_sessions"] == 2
    assert payload["total_connections"] == 3
    assert payload["sessions"]["a"]["client_count"] == 2
