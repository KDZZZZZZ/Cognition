from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.orm.attributes import flag_modified
import uuid
from typing import List, Optional

from app.database import get_db
from app.models import Session, ChatMessage, File as FileModel
from app.schemas import (
    APIResponse, ChatRequest, ChatResponse, SessionInfo,
    Permission
)
from app.services.llm_service import llm_service
from app.services.vector_store import vector_store
from app.services.tools.executor import tool_executor
from app.services.tools.middleware import permission_middleware
from app.services.tools.base import PermissionLevel
from app.api.viewport import get_viewport_context
from app.websocket import manager

router = APIRouter(prefix="/chat", tags=["chat"])


def get_available_tools_for_session(session: Session, context) -> List[dict]:
    """
    Get tools available for a session based on permissions.

    Filters out write tools if no writable files are accessible.
    """
    # Get all tools with permission filtering
    return tool_executor.get_available_tools(context)


@router.post("/completions", response_model=APIResponse)
async def chat_completion(request: ChatRequest, db: AsyncSession = Depends(get_db)):
    """
    Get chat completion with context from documents.

    The AI will:
    1. Use viewport context if available (what user is currently looking at)
    2. Search relevant documents based on the query
    3. Generate a response with citations
    4. Can call tools to read or modify documents if permitted
    """
    # Get or create session
    result = await db.execute(select(Session).where(Session.id == request.session_id))
    session = result.scalar_one_or_none()

    if not session:
        # Create new session with permissions from request if provided
        initial_permissions = request.permissions if hasattr(request, 'permissions') else {}
        session = Session(
            id=request.session_id,
            name=f"Session {request.session_id[:8]}",
            permissions=initial_permissions
        )
        db.add(session)
        await db.commit()
        await db.refresh(session)

        # Invalidate any cached permissions for this session
        permission_middleware.invalidate_cache(request.session_id)
    elif request.permissions and hasattr(request, 'permissions'):
        # Session exists but permissions were provided - update them
        # This ensures frontend permissions are synced to backend
        session.permissions = request.permissions
        flag_modified(session, "permissions")
        await db.commit()
        permission_middleware.invalidate_cache(request.session_id)

    # Fetch only files the agent has permission to access (Issue 6 fix)
    # Agent should ONLY see files with read or write permission, not all files
    permitted_files_info = {}
    if session.permissions:
        # Filter to only files with read or write permission
        permitted_file_ids = [
            fid for fid, perm in session.permissions.items()
            if perm in ("read", "write")
        ]
        if permitted_file_ids:
            result = await db.execute(
                select(FileModel)
                .where(FileModel.id.in_(permitted_file_ids))
                .where(FileModel.file_type != "folder")
            )
            files = result.scalars().all()
            permitted_files_info = {
                f.id: {"name": f.name, "type": f.file_type.value}
                for f in files
            }

    # Create tool context with permissions
    context = await permission_middleware.create_context(
        session_id=request.session_id,
        db=db
    )

    # Build context for the LLM
    context_parts = []
    citations = []

    # 1. Add viewport context if available
    if request.viewport_context:
        context_parts.append(f"[Current Viewport Context]:\n{request.viewport_context}")
    else:
        # Check for viewport context from viewport tracking endpoint
        viewport_ctx = get_viewport_context(request.session_id)
        if viewport_ctx:
            viewport_text = f"User is currently viewing: {viewport_ctx['file_name']} ({viewport_ctx['file_type']})"
            if viewport_ctx.get('page'):
                viewport_text += f", Page {viewport_ctx['page']}"
            context_parts.append(f"[Current Viewport Context]:\n{viewport_text}")

    # 2. Search for relevant document chunks
    if request.context_files:
        # Filter to only readable files
        readable_files = permission_middleware.filter_readable_files(
            request.context_files, context
        )

        if readable_files:
            try:
                query_embedding = await llm_service.get_embedding(request.message)

                # Search in vector store
                for file_id in readable_files:
                    search_results = await vector_store.search(
                        query_embedding=query_embedding,
                        n_results=3,
                        file_id=file_id
                    )

                    if search_results and search_results.get("documents"):
                        for i, doc in enumerate(search_results["documents"][0]):
                            metadata = search_results["metadatas"][0][i]
                            context_parts.append(
                                f"[Document: {metadata.get('file_id')}, Page {metadata.get('page')}]:\n{doc}"
                            )
                            citations.append({
                                "file_id": metadata.get("file_id"),
                                "page": metadata.get("page"),
                                "chunk_index": metadata.get("chunk_index"),
                                "content": doc[:200] + "..." if len(doc) > 200 else doc
                            })
            except Exception as e:
                print(f"Warning: Could not perform vector search: {e}")

    # 3. Get conversation history
    history_result = await db.execute(
        select(ChatMessage)
        .where(ChatMessage.session_id == request.session_id)
        .order_by(ChatMessage.timestamp)
        .limit(20)
    )
    history_messages = history_result.scalars().all()

    # 4. Build messages for LLM
    messages = [
        {"role": "system", "content": _build_system_prompt(session.permissions, permitted_files_info)}
    ]

    # Add conversation history
    for msg in history_messages[-10:]:
        messages.append({
            "role": msg.role,
            "content": msg.content
        })

    # Add current message
    messages.append({"role": "user", "content": request.message})

    # 5. Add context if available
    if context_parts:
        context_text = "\n\n".join(context_parts)
        messages.append({
            "role": "system",
            "content": f"[Relevant Context from Documents]:\n{context_text}\n\nUse this context to answer the user's question. Cite your sources."
        })

    # 6. Get available tools for this session
    available_tools = get_available_tools_for_session(session, context)

    # 7. Get completion from LLM
    try:
        response = await llm_service.chat_completion(
            messages=messages,
            tools=available_tools
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to get LLM response: {str(e)}"
        )

    # 8. Handle tool calls if any
    tool_results = []
    final_content = response.get("content", "")

    if response.get("tool_calls"):
        for tool_call in response.get("tool_calls", []):
            # Handle both OpenAI format (function.name) and direct format (name)
            if "function" in tool_call:
                tool_name = tool_call["function"]["name"]
                # Arguments may be a JSON string or dict
                tool_args = tool_call["function"].get("arguments", {})
                if isinstance(tool_args, str):
                    import json
                    try:
                        tool_args = json.loads(tool_args)
                    except json.JSONDecodeError:
                        tool_args = {}
            else:
                tool_name = tool_call.get("name")
                tool_args = tool_call.get("arguments", {})

            # Execute tool with permission checking
            result = await tool_executor.execute(
                tool_name=tool_name,
                arguments=tool_args,
                context=context
            )
            tool_results.append({
                "tool": tool_name,
                "result": result.to_dict()
            })

            # If tool succeeded, add result to response
            if result.success:
                result_summary = f"\n\n[Tool {tool_name} executed successfully"
                if result.data:
                    if "file_name" in result.data:
                        result_summary += f" on {result.data['file_name']}"
                    if "version_id" in result.data:
                        result_summary += f" (version: {result.data['version_id']})"
                result_summary += "]"
                final_content += result_summary
            else:
                final_content += f"\n\n[Tool Error: {result.error}]"

        # Get a follow-up response from LLM after tool execution
        if tool_results:
            # Add tool results to conversation
            messages.append({"role": "assistant", "content": response.get("content", "")})

            for tool_result in tool_results:
                if tool_result["result"]["success"]:
                    messages.append({
                        "role": "tool",
                        "name": tool_result["tool"],
                        "content": f"Tool executed successfully: {tool_result['result'].get('data', {})}"
                    })
                else:
                    messages.append({
                        "role": "tool",
                        "name": tool_result["tool"],
                        "content": f"Tool failed: {tool_result['result'].get('error', 'Unknown error')}"
                    })

            try:
                followup = await llm_service.chat_completion(
                    messages=messages,
                    tools=available_tools
                )
                final_content = followup.get("content", final_content)
            except Exception:
                pass  # Keep original content if followup fails

    # 9. Save user message to database
    user_message = ChatMessage(
        id=str(uuid.uuid4()),
        session_id=request.session_id,
        role="user",
        content=request.message
    )
    db.add(user_message)

    # 10. Save assistant response to database
    assistant_message = ChatMessage(
        id=str(uuid.uuid4()),
        session_id=request.session_id,
        role="assistant",
        content=final_content,
        tool_calls=response.get("tool_calls"),
        tool_results=tool_results,
        citations=citations
    )
    db.add(assistant_message)

    await db.commit()

    return APIResponse(
        success=True,
        data={
            "message_id": assistant_message.id,
            "content": final_content,
            "role": "assistant",
            "timestamp": assistant_message.timestamp.isoformat(),
            "tool_calls": response.get("tool_calls"),
            "tool_results": tool_results,
            "citations": citations,
            "usage": response.get("usage", {})
        }
    )


@router.get("/sessions/{session_id}", response_model=APIResponse)
async def get_session(session_id: str, db: AsyncSession = Depends(get_db)):
    """Get session information including permissions."""
    result = await db.execute(select(Session).where(Session.id == session_id))
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Convert permissions to ensure string values (not enum)
    permissions_dict = session.permissions or {}

    return APIResponse(
        success=True,
        data={
            "id": session.id,
            "name": session.name,
            "created_at": session.created_at.isoformat(),
            "permissions": permissions_dict,  # Already stored as JSON strings in DB
            "context_files": list(permissions_dict.keys())  # List of all file IDs with permissions
        }
    )


@router.get("/sessions/{session_id}/messages", response_model=APIResponse)
async def get_session_messages(
    session_id: str,
    limit: int = 50,
    db: AsyncSession = Depends(get_db)
):
    """Get chat history for a session."""
    result = await db.execute(
        select(ChatMessage)
        .where(ChatMessage.session_id == session_id)
        .order_by(ChatMessage.timestamp.desc())
        .limit(limit)
    )
    messages = result.scalars().all()

    return APIResponse(
        success=True,
        data={
            "messages": [
                {
                    "id": msg.id,
                    "role": msg.role,
                    "content": msg.content,
                    "tool_calls": msg.tool_calls,
                    "tool_results": msg.tool_results,
                    "citations": msg.citations,
                    "timestamp": msg.timestamp.isoformat()
                }
                for msg in reversed(messages)
            ]
        }
    )


@router.post("/sessions/{session_id}/permissions", response_model=APIResponse)
async def update_session_permissions(
    session_id: str,
    file_id: str,
    permission: Permission,
    db: AsyncSession = Depends(get_db)
):
    """Update file permissions for a session."""
    result = await db.execute(select(Session).where(Session.id == session_id))
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Update permissions
    if not session.permissions:
        session.permissions = {}

    session.permissions[file_id] = permission.value
    flag_modified(session, "permissions")  # Ensure SQLAlchemy detects JSON change
    await db.commit()

    # Invalidate permission cache for this session
    permission_middleware.invalidate_cache(session_id)

    return APIResponse(
        success=True,
        data={
            "session_id": session_id,
            "file_id": file_id,
            "permission": permission.value
        }
    )


@router.put("/sessions/{session_id}/permissions", response_model=APIResponse)
async def bulk_update_permissions(
    session_id: str,
    permissions: dict[str, Permission],
    db: AsyncSession = Depends(get_db)
):
    """
    Bulk update permissions for a session.

    This endpoint allows syncing all permissions from frontend to backend
    in a single request. Ensures frontend and backend permission states
    are fully aligned.
    """
    result = await db.execute(select(Session).where(Session.id == session_id))
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Convert Permission enums to string values
    permissions_dict = {
        file_id: perm.value if isinstance(perm, Permission) else perm
        for file_id, perm in permissions.items()
    }

    # Update all permissions at once
    session.permissions = permissions_dict
    flag_modified(session, "permissions")
    await db.commit()

    # Invalidate permission cache for this session
    permission_middleware.invalidate_cache(session_id)

    return APIResponse(
        success=True,
        data={
            "session_id": session_id,
            "permissions": permissions_dict,
            "updated_count": len(permissions_dict)
        }
    )


@router.delete("/sessions/{session_id}", response_model=APIResponse)
async def delete_session(session_id: str, db: AsyncSession = Depends(get_db)):
    """
    Delete a session and all its associated chat history.

    SQLite Note: Foreign key constraints must be enabled via PRAGMA for CASCADE
    to work automatically. We manually delete messages first as a fallback.
    """
    result = await db.execute(select(Session).where(Session.id == session_id))
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # CRITICAL FIX: Manually delete all chat messages first
    # SQLite doesn't enable FK constraints by default, so CASCADE may not work
    await db.execute(
        select(ChatMessage).where(ChatMessage.session_id == session_id)
    )
    await db.execute(
        ChatMessage.__table__.delete().where(ChatMessage.session_id == session_id)
    )

    # Delete session (CASCADE would handle this if FK constraints were enabled)
    await db.delete(session)
    await db.commit()

    # Invalidate permission cache for this session
    permission_middleware.invalidate_cache(session_id)

    return APIResponse(
        success=True,
        data={
            "session_id": session_id,
            "message": "Session and all associated history deleted successfully"
        }
    )


def _build_system_prompt(permissions: dict = None, permitted_files_info: dict = None) -> str:
    """
    Build system prompt based on session permissions.

    Args:
        permissions: Dict of file_id -> permission level
        permitted_files_info: Info about files the agent has permission to access
    """
    base_prompt = """You are an AI assistant for the Knowledge IDE. You help users:

1. Understand and summarize documents they are reading
2. Answer questions based on document content
3. Help edit and improve their markdown notes
4. Search and find relevant information across documents

When responding:
- Be concise and direct
- Cite specific documents and page numbers when referencing content
- If you need to read a document, use the read_document tool
- If you need to search for information, use the search_documents tool
- If you need to modify a markdown file, use update_document or append_document
- Always ask for confirmation before making significant changes

Available tools:
- read_document: Read the full content of any accessible document (md, pdf, docx, txt)
- search_documents: Search for relevant content using semantic search
- update_document: Replace the entire content of a markdown file (.md only)
- append_document: Add content to the end of a markdown file (.md only)

Important: Only .md files can be modified. PDF and DOCX files are read-only."""

    # Only show files the agent has permission to access (Issue 6 fix)
    if permitted_files_info:
        base_prompt += f"\n\n=== Files You Can Access ({len(permitted_files_info)} total) ==="

        # Group by permission level
        read_files = []
        write_files = []

        for fid, info in permitted_files_info.items():
            perm = permissions.get(fid) if permissions else None
            if perm == "write":
                write_files.append((fid, info))
            elif perm == "read":
                read_files.append((fid, info))

        # Show files with write permission
        if write_files:
            base_prompt += f"\n\n[Files with Write Access]:"
            for fid, info in write_files:
                base_prompt += f"\n- {info['name']} ({fid}) [{info['type']}] - ✓ write"

        # Show files with read permission
        if read_files:
            base_prompt += f"\n\n[Files with Read Access]:"
            for fid, info in read_files:
                base_prompt += f"\n- {info['name']} ({fid}) [{info['type']}] - ✓ read"

        base_prompt += "\n\nYou can only access the files listed above. If the user asks about other files, let them know you don't have access and ask them to grant permission through the file permission controls."
    else:
        base_prompt += "\n\n=== No Files Accessible ==="
        base_prompt += "\nYou don't currently have access to any files. The user can grant you access through the file permission controls."

    return base_prompt
