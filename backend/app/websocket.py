import asyncio
import json
from typing import Dict, Set
from fastapi import WebSocket, WebSocketDisconnect
from app.schemas import ViewportUpdate, ChatMessage
import uuid


class ConnectionManager:
    def __init__(self):
        # session_id -> {client_id -> WebSocket}
        self.sessions: Dict[str, Dict[str, WebSocket]] = {}
        # client_id -> session_id
        self.client_to_session: Dict[str, str] = {}
        # Track viewport state per session
        self.viewport_states: Dict[str, ViewportUpdate] = {}

    async def connect(self, websocket: WebSocket, session_id: str) -> str:
        await websocket.accept()
        client_id = str(uuid.uuid4())

        if session_id not in self.sessions:
            self.sessions[session_id] = {}

        self.sessions[session_id][client_id] = websocket
        self.client_to_session[client_id] = session_id

        # Send confirmation
        await websocket.send_json({
            "type": "connected",
            "client_id": client_id,
            "session_id": session_id
        })

        return client_id

    def disconnect(self, client_id: str):
        if client_id in self.client_to_session:
            session_id = self.client_to_session[client_id]
            if session_id in self.sessions and client_id in self.sessions[session_id]:
                del self.sessions[session_id][client_id]
            del self.client_to_session[client_id]

            # Clean up empty sessions
            if session_id in self.sessions and not self.sessions[session_id]:
                del self.sessions[session_id]
            if session_id in self.viewport_states:
                del self.viewport_states[session_id]

    async def send_to_client(self, client_id: str, message: dict) -> bool:
        session_id = self.client_to_session.get(client_id)
        if not session_id:
            return False

        websocket = self.sessions.get(session_id, {}).get(client_id)
        if websocket:
            try:
                await websocket.send_json(message)
                return True
            except Exception:
                self.disconnect(client_id)
        return False

    async def broadcast_to_session(self, session_id: str, message: dict, exclude_client: str = None):
        if session_id not in self.sessions:
            return

        for client_id, websocket in list(self.sessions[session_id].items()):
            if client_id == exclude_client:
                continue
            try:
                await websocket.send_json(message)
            except Exception:
                self.disconnect(client_id)

    async def update_viewport(self, client_id: str, viewport: ViewportUpdate):
        session_id = self.client_to_session.get(client_id)
        if not session_id:
            return

        self.viewport_states[session_id] = viewport

        # Broadcast to other clients in the session
        await self.broadcast_to_session(session_id, {
            "type": "viewport_update",
            "client_id": client_id,
            "data": viewport.model_dump()
        }, exclude_client=client_id)

    def get_viewport_state(self, session_id: str) -> ViewportUpdate | None:
        return self.viewport_states.get(session_id)

    def get_session_clients(self, session_id: str) -> Set[str]:
        return set(self.sessions.get(session_id, {}).keys())


manager = ConnectionManager()
