"""
Enhanced FastAPI server with DeepSeek integration and real file storage.
"""
from fastapi import FastAPI, UploadFile, File, HTTPException, WebSocket, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from typing import List, Dict, Optional
import uuid
import json
import io
import os
import aiofiles
from pathlib import Path
from datetime import datetime
from openai import AsyncOpenAI
import shutil

# ============ Configuration ============
UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# DeepSeek API Configuration
DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = "https://api.deepseek.com"

# ============ In-Memory Storage ============
files_db: Dict[str, dict] = {}
sessions_db: Dict[str, dict] = {}
messages_db: Dict[str, List[dict]] = {}
chunks_db: Dict[str, List[dict]] = {}
versions_db: Dict[str, List[dict]] = {}  # File version history

# ============ LLM Client ============
llm_client = None
if DEEPSEEK_API_KEY:
    llm_client = AsyncOpenAI(
        api_key=DEEPSEEK_API_KEY,
        base_url=DEEPSEEK_BASE_URL
    )

app = FastAPI(title="Knowledge IDE API")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============ HEALTH ENDPOINTS ============

@app.get("/")
async def root():
    return {
        "name": "Knowledge IDE API",
        "version": "0.2.0",
        "deepseek_enabled": bool(DEEPSEEK_API_KEY),
        "status": "running"
    }


@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "storage": str(UPLOAD_DIR.absolute()),
        "deepseek_configured": bool(DEEPSEEK_API_KEY)
    }


# ============ FILE ENDPOINTS ============

@app.post("/api/v1/files/upload")
async def upload_file(file: UploadFile = File(...)):
    """Upload a file and save to disk."""
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
        ".jpeg": "image",
    }
    file_type = file_type_map.get(file_ext, "txt")

    # Save file to disk
    file_path = UPLOAD_DIR / f"{file_id}{file_ext}"
    async with aiofiles.open(file_path, "wb") as f:
        await f.write(content)

    # Parse content based on file type
    text_content = ""
    chunks = []
    page_count = 1

    if file_type == "pdf":
        # For PDF, we'll store minimal text and page count
        # The frontend will handle PDF rendering
        try:
            import PyPDF2
            pdf_reader = PyPDF2.PdfReader(io.BytesIO(content))
            page_count = len(pdf_reader.pages)
            text_content = ""

            # Extract text from each page
            for page_num, page in enumerate(pdf_reader.pages):
                page_text = page.extract_text()
                if page_text:
                    text_content += f"\n--- Page {page_num + 1} ---\n{page_text}\n"

                    # Create chunks for each page
                    if page_text.strip():
                        chunks.append({
                            "id": str(uuid.uuid4()),
                            "file_id": file_id,
                            "page": page_num + 1,
                            "chunk_index": 0,
                            "content": page_text.strip(),
                            "bbox": None
                        })
        except ImportError:
            # PyPDF2 not available, store as binary
            text_content = f"[PDF file: {file.filename}]"
    elif file_type in ["md", "txt"]:
        text_content = content.decode("utf-8", errors="ignore")
        paragraphs = text_content.split("\n\n")
        for i, para in enumerate(paragraphs[:100]):
            if para.strip():
                chunks.append({
                    "id": str(uuid.uuid4()),
                    "file_id": file_id,
                    "page": 1,
                    "chunk_index": i,
                    "content": para.strip(),
                    "bbox": None
                })
    else:
        text_content = f"[{file_type.upper()} file: {file.filename}]"

    # Store in memory
    now = datetime.utcnow().isoformat()
    files_db[file_id] = {
        "id": file_id,
        "name": file.filename,
        "type": file_type,
        "size": len(content),
        "path": str(file_path),
        "url": f"/api/v1/files/{file_id}/download",
        "page_count": page_count,
        "created_at": now,
        "updated_at": now,
        "content": text_content
    }
    chunks_db[file_id] = chunks
    versions_db[file_id] = [{
        "version": 1,
        "timestamp": now,
        "author": "human",
        "summary": "Initial upload"
    }]

    return {
        "success": True,
        "data": {
            "file_id": file_id,
            "name": file.filename,
            "type": file_type,
            "size": len(content),
            "url": files_db[file_id]["url"],
            "page_count": page_count,
            "chunks_count": len(chunks)
        }
    }


@app.get("/api/v1/files/")
async def list_files():
    """List all files."""
    return {
        "success": True,
        "data": {
            "files": [
                {
                    "id": f["id"],
                    "name": f["name"],
                    "type": f["type"],
                    "size": f["size"],
                    "created_at": f["created_at"],
                    "updated_at": f["updated_at"]
                }
                for f in files_db.values()
            ]
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


@app.get("/api/v1/files/{file_id}/download")
async def download_file(file_id: str):
    """Download a file."""
    if file_id not in files_db:
        raise HTTPException(status_code=404, detail="File not found")

    file_path = Path(files_db[file_id]["path"])
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found on disk")

    return FileResponse(
        path=file_path,
        filename=files_db[file_id]["name"],
        media_type='application/octet-stream'
    )


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


@app.put("/api/v1/files/{file_id}/content")
async def update_file_content(file_id: str, request: dict):
    """Update file content."""
    if file_id not in files_db:
        raise HTTPException(status_code=404, detail="File not found")

    new_content = request.get("content", "")
    author = request.get("author", "human")
    summary = request.get("summary", "Content updated")

    # Update file on disk
    file_path = Path(files_db[file_id]["path"])
    async with aiofiles.open(file_path, "w", encoding="utf-8") as f:
        await f.write(new_content)

    # Update in memory
    now = datetime.utcnow().isoformat()
    old_content = files_db[file_id]["content"]
    files_db[file_id]["content"] = new_content
    files_db[file_id]["updated_at"] = now

    # Add version
    versions_db[file_id].append({
        "version": len(versions_db[file_id]) + 1,
        "timestamp": now,
        "author": author,
        "summary": summary
    })

    # Update chunks
    paragraphs = new_content.split("\n\n")
    chunks = []
    for i, para in enumerate(paragraphs[:50]):
        if para.strip():
            chunks.append({
                "id": str(uuid.uuid4()),
                "file_id": file_id,
                "page": 1,
                "chunk_index": i,
                "content": para.strip(),
                "bbox": None
            })
    chunks_db[file_id] = chunks

    return {
        "success": True,
        "data": {
            "file_id": file_id,
            "version": len(versions_db[file_id]),
            "updated_at": now
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


@app.get("/api/v1/files/{file_id}/versions")
async def get_file_versions(file_id: str):
    """Get file version history."""
    if file_id not in files_db:
        raise HTTPException(status_code=404, detail="File not found")

    return {
        "success": True,
        "data": {
            "file_id": file_id,
            "versions": versions_db.get(file_id, [])
        }
    }


@app.delete("/api/v1/files/{file_id}")
async def delete_file(file_id: str):
    """Delete a file."""
    if file_id not in files_db:
        raise HTTPException(status_code=404, detail="File not found")

    # Delete from disk
    file_path = Path(files_db[file_id]["path"])
    if file_path.exists():
        file_path.unlink()

    # Delete from memory
    del files_db[file_id]
    if file_id in chunks_db:
        del chunks_db[file_id]
    if file_id in versions_db:
        del versions_db[file_id]

    return {
        "success": True,
        "data": {"message": "File deleted successfully"}
    }


# ============ AGENT TOOLS ============

async def tool_search_documents(query: str, file_ids: List[str] = None, n_results: int = 5):
    """Search for relevant content in documents."""
    results = []

    for file_id, file_data in files_db.items():
        if file_ids and file_id not in file_ids:
            continue

        chunks = chunks_db.get(file_id, [])
        for chunk in chunks:
            if query.lower() in chunk["content"].lower():
                results.append({
                    "file_id": file_id,
                    "file_name": file_data["name"],
                    "chunk": chunk["content"],
                    "page": chunk["page"]
                })
                if len(results) >= n_results:
                    break
        if len(results) >= n_results:
            break

    return results


async def tool_update_block(file_id: str, block_id: str, new_content: str):
    """Update a specific block in a document."""
    if file_id not in files_db:
        return {"error": "File not found"}

    chunks = chunks_db.get(file_id, [])
    for chunk in chunks:
        if chunk["id"] == block_id:
            old_content = chunk["content"]
            chunk["content"] = new_content

            # Reconstruct file content
            all_content = "\n\n".join([c["content"] for c in chunks])

            # Update file
            files_db[file_id]["content"] = all_content
            file_path = Path(files_db[file_id]["path"])
            async with aiofiles.open(file_path, "w", encoding="utf-8") as f:
                await f.write(all_content)

            # Add version
            versions_db[file_id].append({
                "version": len(versions_db[file_id]) + 1,
                "timestamp": datetime.utcnow().isoformat(),
                "author": "agent",
                "summary": f"Updated block: {old_content[:50]}..."
            })

            return {"success": True, "block_id": block_id}

    return {"error": "Block not found"}


async def tool_insert_block(file_id: str, after_block_id: str, content: str):
    """Insert a new block into a document."""
    if file_id not in files_db:
        return {"error": "File not found"}

    chunks = chunks_db.get(file_id, [])

    new_block = {
        "id": str(uuid.uuid4()),
        "file_id": file_id,
        "page": 1,
        "chunk_index": len(chunks),
        "content": content,
        "bbox": None
    }

    if after_block_id:
        # Find position
        for i, chunk in enumerate(chunks):
            if chunk["id"] == after_block_id:
                chunks.insert(i + 1, new_block)
                break
    else:
        chunks.append(new_block)

    # Reconstruct file content
    all_content = "\n\n".join([c["content"] for c in chunks])

    # Update file
    files_db[file_id]["content"] = all_content
    file_path = Path(files_db[file_id]["path"])
    async with aiofiles.open(file_path, "w", encoding="utf-8") as f:
        await f.write(all_content)

    return {"success": True, "block_id": new_block["id"]}


# Available tools for the agent
AVAILABLE_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_documents",
            "description": "Search for relevant content in uploaded documents",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query"
                    },
                    "file_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional: list of file IDs to search in"
                    },
                    "n_results": {
                        "type": "integer",
                        "description": "Number of results to return"
                    }
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "update_block",
            "description": "Update a specific block of text in a document",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_id": {
                        "type": "string",
                        "description": "The ID of the file to update"
                    },
                    "block_id": {
                        "type": "string",
                        "description": "The ID of the block/chunk to update"
                    },
                    "new_content": {
                        "type": "string",
                        "description": "The new content for the block"
                    }
                },
                "required": ["file_id", "block_id", "new_content"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "insert_block",
            "description": "Insert a new block of text into a document",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_id": {
                        "type": "string",
                        "description": "The ID of the file"
                    },
                    "after_block_id": {
                        "type": "string",
                        "description": "Insert after this block ID (empty to append)"
                    },
                    "content": {
                        "type": "string",
                        "description": "The content to insert"
                    }
                },
                "required": ["file_id", "content"]
            }
        }
    }
]

TOOL_HANDLERS = {
    "search_documents": tool_search_documents,
    "update_block": tool_update_block,
    "insert_block": tool_insert_block,
}


# ============ CHAT ENDPOINTS ============

@app.post("/api/v1/chat/completions")
async def chat_completion(request: dict):
    """Get chat completion with DeepSeek agent."""
    session_id = request.get("session_id", str(uuid.uuid4()))
    message = request.get("message", "")
    context_files = request.get("context_files", [])
    model = request.get("model", "deepseek-chat")
    use_tools = request.get("use_tools", True)

    # Create session if needed
    if session_id not in sessions_db:
        sessions_db[session_id] = {
            "id": session_id,
            "name": f"Session {session_id[:8]}",
            "created_at": datetime.utcnow().isoformat(),
            "permissions": {}
        }
        messages_db[session_id] = []

    # Build context from files
    context_parts = []
    for file_id in context_files:
        if file_id in files_db:
            chunks = chunks_db.get(file_id, [])
            if chunks:
                context_parts.append(
                    f"[File: {files_db[file_id]['name']}]\n" +
                    "\n".join([c["content"] for c in chunks[:5]])
                )

    # Build messages
    messages = [
        {
            "role": "system",
            "content": """You are an AI assistant for the Knowledge IDE. You help users:
1. Understand and summarize documents
2. Answer questions based on document content
3. Help edit and improve their writing
4. Search and find relevant information across documents

When responding:
- Be concise and direct
- Cite specific documents when referencing content
- If you need to modify a document, use the available tools
- Always explain what you're doing before calling tools"""
        }
    ]

    # Add conversation history
    for msg in messages_db[session_id][-10:]:
        messages.append({
            "role": msg["role"],
            "content": msg["content"]
        })

    # Add context if available
    if context_parts:
        messages.append({
            "role": "system",
            "content": f"[Document Context]:\n" + "\n\n".join(context_parts[:3])
        })

    # Add current message
    messages.append({
        "role": "user",
        "content": message
    })

    # Save user message
    messages_db[session_id].append({
        "id": str(uuid.uuid4()),
        "role": "user",
        "content": message,
        "timestamp": datetime.utcnow().isoformat()
    })

    # Call LLM
    response_content = ""
    tool_calls = []

    if llm_client:
        try:
            kwargs = {
                "model": model,
                "messages": messages
            }

            if use_tools:
                kwargs["tools"] = AVAILABLE_TOOLS
                kwargs["tool_choice"] = "auto"

            response = await llm_client.chat.completions.create(**kwargs)

            assistant_message = response.choices[0].message
            response_content = assistant_message.content or ""

            if assistant_message.tool_calls:
                for tool_call in assistant_message.tool_calls:
                    function_name = tool_call.function.name
                    function_args = json.loads(tool_call.function.arguments)

                    # Execute tool
                    if function_name in TOOL_HANDLERS:
                        result = await TOOL_HANDLERS[function_name](**function_args)
                        tool_calls.append({
                            "id": tool_call.id,
                            "name": function_name,
                            "arguments": function_args,
                            "result": result
                        })

                        # Get follow-up response
                        messages.append({
                            "role": "assistant",
                            "content": response_content,
                            "tool_calls": [tc.model_dump() for tc in assistant_message.tool_calls]
                        })
                        messages.append({
                            "role": "tool",
                            "tool_call_id": tool_call.id,
                            "content": json.dumps(result)
                        })

                        followup = await llm_client.chat.completions.create(
                            model=model,
                            messages=messages
                        )
                        response_content = followup.choices[0].message.content or ""

        except Exception as e:
            response_content = f"Error calling LLM: {str(e)}"
    else:
        # Mock response when no API key
        response_content = "DeepSeek API not configured. Please set DEEPSEEK_API_KEY environment variable."

    # Save assistant response
    messages_db[session_id].append({
        "id": str(uuid.uuid4()),
        "role": "assistant",
        "content": response_content,
        "tool_calls": tool_calls if tool_calls else None,
        "timestamp": datetime.utcnow().isoformat()
    })

    return {
        "success": True,
        "data": {
            "message_id": str(uuid.uuid4()),
            "content": response_content,
            "role": "assistant",
            "model": model,
            "timestamp": datetime.utcnow().isoformat(),
            "tool_calls": tool_calls if tool_calls else None
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


# ============ VIEWPORT ENDPOINTS ============

# Store viewport state per session
viewport_states: Dict[str, Dict] = {}


@app.post("/api/v1/viewport/update")
async def update_viewport(request: dict):
    """Update viewport state for a session."""
    session_id = request.get("session_id", "default")
    file_id = request.get("file_id")
    page = request.get("page", 1)
    scroll_y = request.get("scroll_y", 0)
    scroll_height = request.get("scroll_height", 0)

    if file_id:
        viewport_states[session_id] = {
            "file_id": file_id,
            "page": page,
            "scroll_y": scroll_y,
            "scroll_height": scroll_height,
            "timestamp": datetime.utcnow().isoformat()
        }

    return {
        "success": True,
        "data": {
            "message": "Viewport updated",
            "state": viewport_states.get(session_id)
        }
    }


@app.get("/api/v1/viewport/{session_id}")
async def get_viewport(session_id: str):
    """Get current viewport state for a session."""
    state = viewport_states.get(session_id)
    if not state:
        return {"success": True, "data": None}
    return {"success": True, "data": state}


# ============ WEBSOCKET ENDPOINT ============

@app.websocket("/api/v1/ws/connect")
async def websocket_endpoint(websocket: WebSocket, session_id: str = Query(None)):
    """WebSocket for real-time updates."""
    await websocket.accept()
    client_id = str(uuid.uuid4())

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
