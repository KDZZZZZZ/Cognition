from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query
from typing import Optional
import json

from app.websocket import manager
from app.schemas import ViewportUpdate

router = APIRouter(prefix="/ws", tags=["websocket"])


@router.websocket("/connect")
async def websocket_endpoint(
    websocket: WebSocket,
    session_id: str = Query(...),
):
    """
    WebSocket endpoint for real-time communication.

    Connected clients can:
    - Receive viewport updates from other clients
    - Send viewport updates
    - Receive real-time AI responses
    """
    client_id = await manager.connect(websocket, session_id)

    try:
        while True:
            # Receive message from client
            data = await websocket.receive_text()
            message = json.loads(data)

            # Handle different message types
            if message.get("type") == "viewport_update":
                # Update viewport state
                viewport = ViewportUpdate(**message["data"])
                await manager.update_viewport(client_id, viewport)

            elif message.get("type") == "chat_message":
                # Broadcast chat message to other clients
                await manager.broadcast_to_session(session_id, {
                    "type": "chat_message",
                    "client_id": client_id,
                    "data": message["data"]
                }, exclude_client=client_id)

            elif message.get("type") == "ping":
                # Respond with pong
                await websocket.send_json({"type": "pong"})

    except WebSocketDisconnect:
        manager.disconnect(client_id)
    except Exception as e:
        print(f"WebSocket error: {e}")
        manager.disconnect(client_id)


@router.get("/status")
async def websocket_status():
    """Get WebSocket connection status."""
    return {
        "active_sessions": len(manager.sessions),
        "total_connections": sum(len(s) for s in manager.sessions.values()),
        "sessions": {
            session_id: {
                "client_count": len(clients),
                "viewport_state": manager.viewport_states.get(session_id)
            }
            for session_id, clients in manager.sessions.items()
        }
    }
