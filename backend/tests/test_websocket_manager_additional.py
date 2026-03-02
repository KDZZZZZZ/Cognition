from __future__ import annotations

import pytest

from app.schemas import ViewportUpdate
from app.websocket import ConnectionManager


class FakeWebSocket:
    def __init__(self, fail_on_send: bool = False):
        self.accepted = False
        self.messages = []
        self.fail_on_send = fail_on_send

    async def accept(self):
        self.accepted = True

    async def send_json(self, payload):
        if self.fail_on_send:
            raise RuntimeError("send failed")
        self.messages.append(payload)


@pytest.mark.asyncio
async def test_connection_manager_lifecycle():
    manager = ConnectionManager()
    ws1 = FakeWebSocket()
    ws2 = FakeWebSocket()

    client1 = await manager.connect(ws1, "s1")
    client2 = await manager.connect(ws2, "s1")
    assert ws1.accepted is True
    assert ws2.accepted is True
    assert client1 in manager.get_session_clients("s1")

    ok = await manager.send_to_client(client1, {"type": "ping"})
    assert ok is True
    assert ws1.messages[-1]["type"] == "ping"

    await manager.broadcast_to_session("s1", {"type": "broadcast"}, exclude_client=client1)
    assert ws2.messages[-1]["type"] == "broadcast"

    viewport = ViewportUpdate(file_id="f1", page=1, scroll_y=10, visible_range=(0, 20))
    await manager.update_viewport(client1, viewport)
    assert manager.get_viewport_state("s1").file_id == "f1"

    manager.disconnect(client1)
    manager.disconnect(client2)
    assert manager.get_session_clients("s1") == set()


@pytest.mark.asyncio
async def test_connection_manager_handles_send_errors():
    manager = ConnectionManager()
    failing_ws = FakeWebSocket()
    client = await manager.connect(failing_ws, "s-error")
    failing_ws.fail_on_send = True

    ok = await manager.send_to_client(client, {"type": "x"})
    assert ok is False
    assert client not in manager.client_to_session
