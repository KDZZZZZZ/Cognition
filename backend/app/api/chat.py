import json
import uuid
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from app.api.viewport import get_viewport_context
from app.database import get_db
from app.models import ChatMessage, File as FileModel, Session
from app.prompts.system_prompts import SystemPrompts
from app.schemas import APIResponse, ChatRequest, Permission
from app.services.llm_service import llm_service
from app.services.tools.base import PermissionLevel
from app.services.tools.executor import tool_executor
from app.services.tools.middleware import permission_middleware
from app.services.vector_store import vector_store

router = APIRouter(prefix="/chat", tags=["chat"])


def get_available_tools_for_session(session: Session, context) -> List[dict]:
    return tool_executor.get_available_tools(context)


@router.post("/completions", response_model=APIResponse)
async def chat_completion(request: ChatRequest, db: AsyncSession = Depends(get_db)):
    # Get or create session
    result = await db.execute(select(Session).where(Session.id == request.session_id))
    session = result.scalar_one_or_none()

    if not session:
        initial_permissions = request.permissions or {}
        session = Session(
            id=request.session_id,
            name=f"Session {request.session_id[:8]}",
            permissions=initial_permissions,
        )
        db.add(session)
        await db.commit()
        await db.refresh(session)
        permission_middleware.invalidate_cache(request.session_id)
    elif request.permissions is not None:
        session.permissions = request.permissions
        flag_modified(session, "permissions")
        await db.commit()
        permission_middleware.invalidate_cache(request.session_id)

    # Visible files: explicit context files + permitted files from session map.
    visible_file_ids = set(request.context_files or [])
    if session.permissions:
        for fid, perm in session.permissions.items():
            if fid.startswith("_"):
                continue
            if perm in ("read", "write"):
                visible_file_ids.add(fid)
            elif perm == "none" and fid in visible_file_ids:
                visible_file_ids.remove(fid)

    permitted_files_info = {}
    if visible_file_ids:
        files_result = await db.execute(
            select(FileModel)
            .where(FileModel.id.in_(list(visible_file_ids)))
            .where(FileModel.file_type != "folder")
        )
        files = files_result.scalars().all()
        permitted_files_info = {
            f.id: {"name": f.name, "type": f.file_type.value}
            for f in files
        }

    context = await permission_middleware.create_context(
        session_id=request.session_id,
        db=db,
    )

    context_parts = []
    citations = []

    if request.viewport_context:
        context_parts.append(f"[Current Viewport Context]:\n{request.viewport_context}")
    else:
        viewport_ctx = get_viewport_context(request.session_id)
        if viewport_ctx:
            viewport_text = SystemPrompts.format_viewport_context(
                file_name=viewport_ctx.get("file_name", "Unknown"),
                file_type=viewport_ctx.get("file_type", "Unknown"),
                page=viewport_ctx.get("page"),
            )
            context_parts.append(viewport_text)

    if request.context_files:
        explicit_none = {
            fid for fid, perm in context.permissions.items() if perm == PermissionLevel.NONE
        }
        readable_files = [fid for fid in request.context_files if fid not in explicit_none]

        if readable_files:
            try:
                query_embedding = await llm_service.get_embedding(request.message)
                for file_id in readable_files:
                    search_results = await vector_store.search(
                        query_embedding=query_embedding,
                        n_results=3,
                        file_id=file_id,
                    )
                    if search_results and search_results.get("documents"):
                        docs = search_results["documents"][0]
                        metadatas = search_results.get("metadatas", [[]])[0]
                        for i, doc in enumerate(docs):
                            metadata = metadatas[i] if i < len(metadatas) else {}
                            context_parts.append(
                                f"[Document: {metadata.get('file_id')}, Page {metadata.get('page')}]:\n{doc}"
                            )
                            citations.append(
                                {
                                    "file_id": metadata.get("file_id"),
                                    "page": metadata.get("page"),
                                    "chunk_index": metadata.get("chunk_index"),
                                    "content": doc[:200] + "..." if len(doc) > 200 else doc,
                                }
                            )
            except Exception as e:
                print(f"Warning: Could not perform vector search: {e}")

    history_result = await db.execute(
        select(ChatMessage)
        .where(ChatMessage.session_id == request.session_id)
        .order_by(ChatMessage.timestamp)
        .limit(20)
    )
    history_messages = history_result.scalars().all()

    messages = [{"role": "system", "content": _build_system_prompt(session.permissions, permitted_files_info)}]

    for msg in history_messages[-10:]:
        messages.append({"role": msg.role, "content": msg.content})

    messages.append({"role": "user", "content": request.message})

    if context_parts:
        messages.append(
            {
                "role": "system",
                "content": (
                    "[Relevant Context from Documents]:\n"
                    + "\n\n".join(context_parts)
                    + "\n\nUse this context to answer the user's question. Cite your sources."
                ),
            }
        )

    available_tools = get_available_tools_for_session(session, context) if request.use_tools else None

    try:
        response = await llm_service.chat_completion(
            messages=messages,
            model=request.model,
            tools=available_tools,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get LLM response: {e}")

    tool_results = []
    final_content = response.get("content", "")

    if request.use_tools and response.get("tool_calls"):
        for tool_call in response.get("tool_calls", []):
            if "function" in tool_call:
                tool_name = tool_call["function"]["name"]
                tool_args = tool_call["function"].get("arguments", {})
                if isinstance(tool_args, str):
                    try:
                        tool_args = json.loads(tool_args)
                    except json.JSONDecodeError:
                        tool_args = {}
            else:
                tool_name = tool_call.get("name")
                tool_args = tool_call.get("arguments", {})

            result = await tool_executor.execute(
                tool_name=tool_name,
                arguments=tool_args,
                context=context,
            )
            tool_results.append({"tool": tool_name, "result": result.to_dict()})

            if result.success:
                summary = f"\n\n[Tool {tool_name} executed successfully"
                if result.data:
                    if "file_name" in result.data:
                        summary += f" on {result.data['file_name']}"
                    if "version_id" in result.data:
                        summary += f" (version: {result.data['version_id']})"
                summary += "]"
                final_content += summary
            else:
                final_content += f"\n\n[Tool Error: {result.error}]"

        if tool_results:
            messages.append({"role": "assistant", "content": response.get("content", "")})
            for tool_result in tool_results:
                tool_payload = tool_result["result"]
                if tool_payload.get("success"):
                    tool_content = f"Tool executed successfully: {tool_payload.get('data', {})}"
                else:
                    tool_content = f"Tool failed: {tool_payload.get('error', 'Unknown error')}"
                messages.append(
                    {
                        "role": "tool",
                        "name": tool_result["tool"],
                        "content": tool_content,
                    }
                )
            try:
                followup = await llm_service.chat_completion(
                    messages=messages,
                    model=request.model,
                    tools=available_tools,
                )
                final_content = followup.get("content", final_content)
                if followup.get("model"):
                    response["model"] = followup["model"]
            except Exception:
                pass

    user_message = ChatMessage(
        id=str(uuid.uuid4()),
        session_id=request.session_id,
        role="user",
        content=request.message,
    )
    db.add(user_message)

    assistant_message = ChatMessage(
        id=str(uuid.uuid4()),
        session_id=request.session_id,
        role="assistant",
        content=final_content,
        tool_calls=response.get("tool_calls"),
        tool_results=tool_results,
        citations=citations,
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
            "usage": response.get("usage", {}),
            "model": response.get("model"),
        },
    )


@router.get("/sessions/{session_id}", response_model=APIResponse)
async def get_session(session_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Session).where(Session.id == session_id))
    session = result.scalar_one_or_none()
    if not session:
        session = Session(
            id=session_id,
            name=f"Session {session_id[:8]}",
            permissions={},
        )
        db.add(session)
        try:
            await db.commit()
            await db.refresh(session)
        except IntegrityError:
            await db.rollback()
            retry = await db.execute(select(Session).where(Session.id == session_id))
            session = retry.scalar_one_or_none()
            if not session:
                raise

    permissions_dict = session.permissions or {}
    context_files = [fid for fid in permissions_dict.keys() if not fid.startswith("_")]
    return APIResponse(
        success=True,
        data={
            "id": session.id,
            "name": session.name,
            "created_at": session.created_at.isoformat(),
            "permissions": permissions_dict,
            "context_files": context_files,
        },
    )


@router.get("/sessions/{session_id}/messages", response_model=APIResponse)
async def get_session_messages(
    session_id: str,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
):
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
                    "timestamp": msg.timestamp.isoformat(),
                }
                for msg in reversed(messages)
            ]
        },
    )


@router.post("/sessions/{session_id}/permissions", response_model=APIResponse)
async def update_session_permissions(
    session_id: str,
    file_id: str,
    permission: Permission,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Session).where(Session.id == session_id))
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if not session.permissions:
        session.permissions = {}
    session.permissions[file_id] = permission.value
    flag_modified(session, "permissions")
    await db.commit()
    permission_middleware.invalidate_cache(session_id)

    return APIResponse(
        success=True,
        data={"session_id": session_id, "file_id": file_id, "permission": permission.value},
    )


@router.put("/sessions/{session_id}/permissions", response_model=APIResponse)
async def bulk_update_permissions(
    session_id: str,
    permissions: dict[str, Permission],
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Session).where(Session.id == session_id))
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    permissions_dict = {
        file_id: perm.value if isinstance(perm, Permission) else perm
        for file_id, perm in permissions.items()
    }
    session.permissions = permissions_dict
    flag_modified(session, "permissions")
    await db.commit()
    permission_middleware.invalidate_cache(session_id)

    return APIResponse(
        success=True,
        data={
            "session_id": session_id,
            "permissions": permissions_dict,
            "updated_count": len(permissions_dict),
        },
    )


@router.delete("/sessions/{session_id}", response_model=APIResponse)
async def delete_session(session_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Session).where(Session.id == session_id))
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    await db.execute(ChatMessage.__table__.delete().where(ChatMessage.session_id == session_id))
    await db.delete(session)
    await db.commit()
    permission_middleware.invalidate_cache(session_id)

    return APIResponse(
        success=True,
        data={"session_id": session_id, "message": "Session and all associated history deleted successfully"},
    )


def _build_system_prompt(permissions: dict = None, permitted_files_info: dict = None) -> str:
    base_prompt = SystemPrompts.MAIN_SYSTEM_PROMPT

    if not permitted_files_info:
        base_prompt += "\n\n=== No Files Accessible ==="
        base_prompt += "\nYou don't currently have access to any files. The user can grant access in the file permission controls."
        return base_prompt

    base_prompt += f"\n\n=== Files You Can Access ({len(permitted_files_info)} total) ==="
    read_files = []
    write_files = []

    for fid, info in permitted_files_info.items():
        perm = permissions.get(fid, "read") if permissions else "read"
        if perm == "write":
            write_files.append((fid, info))
        else:
            read_files.append((fid, info))

    if write_files:
        base_prompt += "\n\n[Files with Write Access]:"
        for fid, info in write_files:
            base_prompt += f"\n- {info['name']} ({fid}) [{info['type']}] - write"

    if read_files:
        base_prompt += "\n\n[Files with Read Access]:"
        for fid, info in read_files:
            base_prompt += f"\n- {info['name']} ({fid}) [{info['type']}] - read"

    base_prompt += (
        "\n\nYou can only access the files listed above. If the user asks about other files, "
        "explain that you do not have access and ask for permission changes."
    )
    return base_prompt
