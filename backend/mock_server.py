"""
Simplified FastAPI server for quick testing without database.

This server uses in-memory storage and mock AI responses for development.
"""
from fastapi import FastAPI, UploadFile, File, HTTPException, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from typing import List, Dict, Optional
import uuid
import json
import io
from pathlib import Path
from datetime import datetime

# Simple in-memory storage
files_db: Dict[str, dict] = {}
sessions_db: Dict[str, dict] = {}
messages_db: Dict[str, List[dict]] = {}
chunks_db: Dict[str, List[dict]] = {}


app = FastAPI(title="Knowledge IDE API (Mock)")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5174", "http://localhost:8000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============ HEALTH ENDPOINTS ============

@app.get("/")
async def root():
    return {
        "name": "Knowledge IDE API (Mock)",
        "version": "0.1.0-mock",
        "status": "running"
    }


@app.get("/health")
async def health():
    return {"status": "healthy", "database": "in-memory"}


# ============ FILE ENDPOINTS ============

@app.post("/api/v1/files/upload")
async def upload_file(file: UploadFile = File(...)):
    """Upload a file and parse its content."""
    file_id = str(uuid.uuid4())
    content = await file.read()

    # Determine file type
    file_ext = Path(file.filename).suffix.lower()
    file_type_map = {
        ".pdf": "pdf",
        ".docx": "docx",
        ".md": "md",
        ".txt": "txt",
        ".png": "image",
        ".jpg": "image",
    }
    file_type = file_type_map.get(file_ext, "txt")

    # Parse content (simplified)
    text_content = content.decode("utf-8", errors="ignore")

    # Create chunks
    chunks = []
    paragraphs = text_content.split("\n\n")
    for i, para in enumerate(paragraphs[:20]):  # Limit to 20 chunks
        if para.strip():
            chunks.append({
                "id": str(uuid.uuid4()),
                "file_id": file_id,
                "page": 1,
                "chunk_index": i,
                "content": para.strip(),
                "bbox": None
            })

    # Store
    files_db[file_id] = {
        "id": file_id,
        "name": file.filename,
        "type": file_type,
        "size": len(content),
        "page_count": 1,
        "created_at": datetime.utcnow().isoformat(),
        "updated_at": datetime.utcnow().isoformat(),
        "content": text_content
    }
    chunks_db[file_id] = chunks

    return {
        "success": True,
        "data": {
            "file_id": file_id,
            "name": file.filename,
            "type": file_type,
            "size": len(content),
            "chunks_count": len(chunks)
        }
    }


@app.get("/api/v1/files/")
async def list_files():
    """List all files."""
    return {
        "success": True,
        "data": {
            "files": list(files_db.values())
        }
    }


@app.get("/api/v1/files/{file_id}")
async def get_file(file_id: str):
    """Get file metadata."""
    if file_id not in files_db:
        raise HTTPException(status_code=404, detail="File not found")
    return {
        "success": True,
        "data": files_db[file_id]
    }


@app.get("/api/v1/files/{file_id}/content")
async def get_file_content(file_id: str):
    """Get file content."""
    if file_id not in files_db:
        raise HTTPException(status_code=404, detail="File not found")
    return {
        "success": True,
        "data": {
            "file_id": file_id,
            "content": files_db[file_id]["content"]
        }
    }


@app.get("/api/v1/files/{file_id}/chunks")
async def get_file_chunks(file_id: str, page: Optional[int] = None):
    """Get document chunks."""
    if file_id not in files_db:
        raise HTTPException(status_code=404, detail="File not found")

    chunks = chunks_db.get(file_id, [])
    if page is not None:
        chunks = [c for c in chunks if c["page"] == page]

    return {
        "success": True,
        "data": {"chunks": chunks}
    }


@app.delete("/api/v1/files/{file_id}")
async def delete_file(file_id: str):
    """Delete a file."""
    if file_id not in files_db:
        raise HTTPException(status_code=404, detail="File not found")
    del files_db[file_id]
    if file_id in chunks_db:
        del chunks_db[file_id]
    return {
        "success": True,
        "data": {"message": "File deleted successfully"}
    }


# ============ CHAT ENDPOINTS ============

@app.post("/api/v1/chat/completions")
async def chat_completion(request: dict):
    """Get chat completion with mock AI response."""
    session_id = request.get("session_id", str(uuid.uuid4()))
    message = request.get("message", "")
    context_files = request.get("context_files", [])

    # Create session if needed
    if session_id not in sessions_db:
        sessions_db[session_id] = {
            "id": session_id,
            "name": f"Session {session_id[:8]}",
            "created_at": datetime.utcnow().isoformat(),
            "permissions": {}
        }
        messages_db[session_id] = []

    # Generate mock response
    mock_responses = [
        "I've analyzed the document. The key points are...",
        "Based on the content you're viewing, I can see that...",
        "That's an interesting question. Let me search the documents for relevant information.",
        "I've found several relevant sections in your documents that address this topic."
    ]

    import random
    response_content = random.choice(mock_responses)

    # Add context from files if available
    if context_files:
        response_content += f"\n\nI'm referencing {len(context_files)} document(s) in my analysis."

    # Save messages
    messages_db[session_id].append({
        "id": str(uuid.uuid4()),
        "role": "user",
        "content": message,
        "timestamp": datetime.utcnow().isoformat()
    })
    messages_db[session_id].append({
        "id": str(uuid.uuid4()),
        "role": "assistant",
        "content": response_content,
        "timestamp": datetime.utcnow().isoformat()
    })

    # Build citations from context files
    citations = []
    for file_id in context_files:
        if file_id in files_db:
            chunks = chunks_db.get(file_id, [])
            if chunks:
                citations.append({
                    "file_id": file_id,
                    "file_name": files_db[file_id]["name"],
                    "page": chunks[0]["page"],
                    "content": chunks[0]["content"][:100] + "..."
                })

    return {
        "success": True,
        "data": {
            "message_id": str(uuid.uuid4()),
            "content": response_content,
            "role": "assistant",
            "timestamp": datetime.utcnow().isoformat(),
            "citations": citations
        }
    }


@app.get("/api/v1/chat/sessions/{session_id}")
async def get_session(session_id: str):
    """Get session information."""
    if session_id not in sessions_db:
        raise HTTPException(status_code=404, detail="Session not found")
    return {
        "success": True,
        "data": sessions_db[session_id]
    }


@app.get("/api/v1/chat/sessions/{session_id}/messages")
async def get_session_messages(session_id: str, limit: int = 50):
    """Get chat history."""
    if session_id not in sessions_db:
        raise HTTPException(status_code=404, detail="Session not found")
    messages = messages_db.get(session_id, [])
    return {
        "success": True,
        "data": {
            "messages": messages[-limit:]
        }
    }


@app.post("/api/v1/chat/sessions/{session_id}/permissions")
async def update_permissions(session_id: str, file_id: str, permission: str):
    """Update file permissions for a session."""
    if session_id not in sessions_db:
        raise HTTPException(status_code=404, detail="Session not found")
    sessions_db[session_id]["permissions"][file_id] = permission
    return {
        "success": True,
        "data": {
            "session_id": session_id,
            "file_id": file_id,
            "permission": permission
        }
    }


# ============ WEBSOCKET ENDPOINT ============

@app.websocket("/api/v1/ws/connect")
async def websocket_endpoint(websocket: WebSocket, session_id: str = None):
    """WebSocket for real-time updates."""
    await websocket.accept()
    client_id = str(uuid.uuid4())

    # Send connection confirmation
    await websocket.send_json({
        "type": "connected",
        "client_id": client_id,
        "session_id": session_id or "default"
    })

    try:
        while True:
            data = await websocket.receive_json()

            if data.get("type") == "ping":
                await websocket.send_json({"type": "pong"})

            elif data.get("type") == "viewport_update":
                # Echo back the viewport update
                await websocket.send_json({
                    "type": "viewport_update",
                    "client_id": client_id,
                    "data": data.get("data")
                })

    except Exception as e:
        print(f"WebSocket error: {e}")


@app.get("/api/v1/ws/status")
async def websocket_status():
    """Get WebSocket status."""
    return {
        "active_sessions": 0,
        "total_connections": 0,
        "sessions": {}
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
