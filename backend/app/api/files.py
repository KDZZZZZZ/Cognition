import difflib
import uuid
from datetime import datetime
from pathlib import Path
from typing import List, Optional

import aiofiles
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import desc, select

from app.database import get_db
from app.models import (
    Author,
    ChangeType,
    DiffEvent,
    DiffEventStatus,
    DiffLineSnapshot,
    DocumentChunk,
    File as FileModel,
    LineDecision,
    Version,
)
from app.schemas import (
    APIResponse,
    DiffEventCreateRequest,
    DiffEventFinalizeRequest,
    DiffLineUpdateRequest,
    FileMetadata,
    FileUpdate,
    FolderCreateRequest,
    MoveFileRequest,
)
from app.services.document_parser import parser
from app.services.llm_service import llm_service
from app.services.vector_store import vector_store
from app.config import settings

router = APIRouter(prefix="/files", tags=["files"])


def _build_diff_line_snapshots(old_content: str, new_content: str) -> list[dict]:
    """
    Build line-level snapshots from a before/after string pair.

    We keep one row per line index to support deterministic line approval.
    """
    old_lines = old_content.splitlines()
    new_lines = new_content.splitlines()
    max_len = max(len(old_lines), len(new_lines))

    snapshots: list[dict] = []
    for idx in range(max_len):
        old_line = old_lines[idx] if idx < len(old_lines) else None
        new_line = new_lines[idx] if idx < len(new_lines) else None
        decision = LineDecision.PENDING if old_line != new_line else LineDecision.ACCEPTED
        snapshots.append(
            {
                "line_no": idx + 1,
                "old_line": old_line,
                "new_line": new_line,
                "decision": decision,
            }
        )
    return snapshots


def _compose_content_from_line_snapshots(snapshots: list[DiffLineSnapshot]) -> str:
    """
    Compose finalized content from line decisions.

    accepted -> new_line
    rejected -> old_line
    pending  -> new_line (finalize should normally resolve pending first)
    """
    ordered = sorted(snapshots, key=lambda line: line.line_no)
    final_lines: list[str] = []
    for line in ordered:
        if line.decision == LineDecision.REJECTED:
            chosen = line.old_line
        else:
            chosen = line.new_line
        if chosen is not None:
            final_lines.append(chosen)
    return "\n".join(final_lines)


def _build_unified_diff(old_content: str, new_content: str) -> str:
    if old_content == new_content:
        return ""
    old_lines = old_content.splitlines(keepends=True)
    new_lines = new_content.splitlines(keepends=True)
    return "".join(
        difflib.unified_diff(
            old_lines,
            new_lines,
            fromfile="old",
            tofile="new",
            lineterm="",
        )
    )


@router.post("/upload", response_model=APIResponse)
async def upload_file(
    file: UploadFile = File(...),
    parent_id: Optional[str] = None,
    db: AsyncSession = Depends(get_db)
):
    """
    Upload and parse a document file.

    Supports: PDF, DOCX, MD, TXT
    """
    # Validate file extension
    file_ext = Path(file.filename).suffix.lower()
    if file_ext not in settings.ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type. Allowed: {settings.ALLOWED_EXTENSIONS}"
        )

    # Validate file size
    content = await file.read()
    if len(content) > settings.MAX_FILE_SIZE:
        raise HTTPException(
            status_code=400,
            detail=f"File too large. Max size: {settings.MAX_FILE_SIZE / 1024 / 1024}MB"
        )

    # Validate parent_id if provided
    if parent_id:
        parent_result = await db.execute(
            select(FileModel).where(FileModel.id == parent_id, FileModel.file_type == "folder")
        )
        if not parent_result.scalar_one_or_none():
            raise HTTPException(status_code=400, detail="Parent folder not found or is not a folder")

    # Create file record
    file_id = str(uuid.uuid4())

    # Try to use original filename if possible, otherwise use UUID
    safe_filename = Path(file.filename).name

    # Build upload path based on parent folder if provided
    if parent_id:
        # Store files in parent folder subdirectory
        upload_dir = Path(settings.UPLOAD_DIR) / parent_id
    else:
        upload_dir = Path(settings.UPLOAD_DIR)

    upload_path = upload_dir / safe_filename

    # If file exists, append partial UUID to avoid overwrite
    if upload_path.exists():
        upload_path = upload_dir / f"{upload_path.stem}_{file_id[:8]}{upload_path.suffix}"

    # Save file
    upload_path.parent.mkdir(parents=True, exist_ok=True)
    async with aiofiles.open(upload_path, "wb") as f:
        await f.write(content)

    # Determine file type
    file_type_map = {
        ".pdf": "pdf",
        ".docx": "docx",
        ".doc": "docx",
        ".md": "md",
        ".txt": "txt",
        ".png": "image",
        ".jpg": "image",
        ".jpeg": "image",
    }
    file_type = file_type_map.get(file_ext, "txt")

    # Parse document
    chunks, metadata = await parser.parse_file(str(upload_path), file_id, file_type)

    # Create file record first and flush to avoid FK ordering issues on chunks insert.
    db_file = FileModel(
        id=file_id,
        name=file.filename,
        file_type=file_type,
        path=str(upload_path),
        size=len(content),
        page_count=metadata.get("page_count"),
        meta=metadata,
        parent_id=parent_id
    )
    db.add(db_file)
    await db.flush()

    # Calculate public URL
    public_url = f"/uploads/{upload_path.name}"

    # Save chunks and generate embeddings
    if chunks:
        for chunk in chunks:
            db.add(chunk)
        await db.flush()

        # Best effort embedding build; hard-fail is not allowed.
        try:
            chunk_texts = [chunk.content for chunk in chunks]
            embeddings = await llm_service.get_embeddings_batch(chunk_texts)
            await vector_store.add_chunks(chunks, embeddings)
        except Exception as e:
            print(f"Warning: Could not generate embeddings: {e}")

    await db.commit()

    return APIResponse(
        success=True,
        data={
            "file_id": file_id,
            "name": file.filename,
            "type": file_type,
            "size": len(content),
            "chunks_count": len(chunks),
            "metadata": metadata,
            "url": public_url,
            "parent_id": parent_id
        }
    )


@router.post("/folders", response_model=APIResponse)
async def create_folder(
    request: FolderCreateRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    Create a virtual folder in the file tree.

    Folders are stored in the database and support hierarchical organization.
    """
    # Validate parent_id if provided
    name = request.name.strip()
    parent_id = request.parent_id

    if not name:
        raise HTTPException(status_code=400, detail="Folder name cannot be empty")

    if parent_id:
        parent_result = await db.execute(
            select(FileModel).where(FileModel.id == parent_id, FileModel.file_type == "folder")
        )
        if not parent_result.scalar_one_or_none():
            raise HTTPException(status_code=400, detail="Parent folder not found or is not a folder")

    # Create folder record
    folder_id = str(uuid.uuid4())

    # Build folder path (for physical storage reference)
    if parent_id:
        folder_path = Path(settings.UPLOAD_DIR) / parent_id / name
    else:
        folder_path = Path(settings.UPLOAD_DIR) / name

    # Create the physical directory
    folder_path.mkdir(parents=True, exist_ok=True)

    db_folder = FileModel(
        id=folder_id,
        name=name,
        file_type="folder",
        path=str(folder_path),
        size=0,
        parent_id=parent_id,
        meta={}
    )
    db.add(db_folder)
    await db.commit()

    return APIResponse(
        success=True,
        data={
            "folder_id": folder_id,
            "name": name,
            "type": "folder",
            "parent_id": parent_id,
            "path": str(folder_path)
        }
    )


@router.get("/{file_id}", response_model=APIResponse)
async def get_file(file_id: str, db: AsyncSession = Depends(get_db)):
    """Get file metadata and content."""
    result = await db.execute(select(FileModel).where(FileModel.id == file_id))
    file = result.scalar_one_or_none()

    if not file:
        raise HTTPException(status_code=404, detail="File not found")

    file_path = Path(file.path)
    url = f"/uploads/{file_path.name}" if file_path.exists() else None

    return APIResponse(
        success=True,
        data={
            "id": file.id,
            "name": file.name,
            "type": file.file_type.value,
            "size": file.size,
            "page_count": file.page_count,
            "created_at": file.created_at.isoformat(),
            "updated_at": file.updated_at.isoformat(),
            "metadata": file.meta,
            "url": url,
            "parent_id": file.parent_id
        }
    )


@router.get("/{file_id}/content", response_model=APIResponse)
async def get_file_content(file_id: str, db: AsyncSession = Depends(get_db)):
    """Get file content as text."""
    result = await db.execute(select(FileModel).where(FileModel.id == file_id))
    file = result.scalar_one_or_none()

    if not file:
        raise HTTPException(status_code=404, detail="File not found")

    # Read file content
    from pathlib import Path
    file_path = Path(file.path)

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found on disk")

    if file.file_type.value in ["md", "txt"]:
        content = file_path.read_text(encoding="utf-8")
    else:
        # For PDF/DOCX, return chunks
        result = await db.execute(
            select(DocumentChunk)
            .where(DocumentChunk.file_id == file_id)
            .order_by(DocumentChunk.page, DocumentChunk.chunk_index)
        )
        chunks = result.scalars().all()
        content = "\n\n".join([chunk.content for chunk in chunks])

    return APIResponse(
        success=True,
        data={
            "file_id": file_id,
            "content": content
        }
    )


@router.put("/{file_id}/content", response_model=APIResponse)
async def update_file_content(
    file_id: str,
    update: FileUpdate,
    db: AsyncSession = Depends(get_db)
):
    """Update file content and create a version record."""
    result = await db.execute(select(FileModel).where(FileModel.id == file_id))
    file = result.scalar_one_or_none()

    if not file:
        raise HTTPException(status_code=404, detail="File not found")

    # Only support updating text-based files
    if file.file_type.value not in ["md", "txt", "code"]:
        raise HTTPException(
            status_code=400,
            detail="Only text-based files can be edited"
        )

    # Read old content for diff
    file_path = Path(file.path)
    old_content = ""
    if file_path.exists():
        try:
            old_content = file_path.read_text(encoding="utf-8")
        except Exception:
            pass  # If can't read, use empty string

    # Update file on disk
    if not file_path.exists():
        # Recreate file if missing
        file_path.parent.mkdir(parents=True, exist_ok=True)

    async with aiofiles.open(file_path, "w", encoding="utf-8") as f:
        await f.write(update.content)

    # Update metadata
    old_size = file.size
    file.size = len(update.content.encode("utf-8"))
    file.updated_at = datetime.utcnow()

    # Create version record for timeline (CRITICAL FIX for Issue 4)
    version_id = str(uuid.uuid4())

    # Generate simple diff patch
    diff_lines = []
    old_lines = old_content.splitlines(keepends=True) if old_content else []
    new_lines = update.content.splitlines(keepends=True) if update.content else []

    # Simple diff: track added/removed lines
    # This is a basic implementation - could be enhanced with proper diff library
    if old_content != update.content:
        if not old_content:
            diff_lines.append("+++ Entire file is new")
        else:
            diff_lines.append(f"--- Old content ({len(old_lines)} lines)")
            diff_lines.append(f"+++ New content ({len(new_lines)} lines)")

    diff_patch = "\n".join(diff_lines) if diff_lines else None

    # Use provided context_snapshot, or default to old_content if not provided
    context_snapshot = update.context_snapshot if update.context_snapshot is not None else old_content

    version = Version(
        id=version_id,
        file_id=file_id,
        author=update.author,
        change_type=update.change_type,
        summary=update.summary,
        diff_patch=diff_patch,
        context_snapshot=context_snapshot
    )
    db.add(version)

    # Update DB
    await db.commit()

    return APIResponse(
        success=True,
        data={
            "file_id": file_id,
            "size": file.size,
            "updated_at": file.updated_at.isoformat(),
            "version_id": version_id,
            "version_created": True
        }
    )


@router.get("/{file_id}/chunks", response_model=APIResponse)
async def get_file_chunks(
    file_id: str,
    page: int = None,
    db: AsyncSession = Depends(get_db)
):
    """Get document chunks for a file."""
    # Verify file exists
    result = await db.execute(select(FileModel).where(FileModel.id == file_id))
    file = result.scalar_one_or_none()

    if not file:
        raise HTTPException(status_code=404, detail="File not found")

    # Get chunks
    query = select(DocumentChunk).where(DocumentChunk.file_id == file_id)
    if page is not None:
        query = query.where(DocumentChunk.page == page)

    query = query.order_by(DocumentChunk.page, DocumentChunk.chunk_index)

    result = await db.execute(query)
    chunks = result.scalars().all()

    return APIResponse(
        success=True,
        data={
            "chunks": [
                {
                    "id": chunk.id,
                    "page": chunk.page,
                    "chunk_index": chunk.chunk_index,
                    "content": chunk.content,
                    "bbox": chunk.bbox
                }
                for chunk in chunks
            ]
        }
    )


@router.get("/{file_id}/versions", response_model=APIResponse)
async def get_file_versions(
    file_id: str,
    limit: int = 50,
    offset: int = 0,
    db: AsyncSession = Depends(get_db)
):
    """Get version history (timeline) for a file."""
    # Verify file exists
    result = await db.execute(select(FileModel).where(FileModel.id == file_id))
    file = result.scalar_one_or_none()

    if not file:
        raise HTTPException(status_code=404, detail="File not found")

    # Get versions
    query = (
        select(Version)
        .where(Version.file_id == file_id)
        .order_by(desc(Version.timestamp))
        .limit(limit)
        .offset(offset)
    )

    result = await db.execute(query)
    versions = result.scalars().all()

    version_list = [
        {
            "id": v.id,
            "file_id": v.file_id,
            "author": v.author.value,
            "change_type": v.change_type.value,
            "summary": v.summary,
            "diff_patch": v.diff_patch,
            "context_snapshot": v.context_snapshot,
            "timestamp": v.timestamp.isoformat()
        }
        for v in versions
    ]

    return APIResponse(
        success=True,
        data={
            "file_id": file_id,
            "versions": version_list,
            "total": len(version_list)
        }
    )


@router.post("/{file_id}/diff-events", response_model=APIResponse)
async def create_diff_event(
    file_id: str,
    request: DiffEventCreateRequest,
    db: AsyncSession = Depends(get_db),
):
    """Create a pending diff event (agent/user proposal) without mutating file content."""
    result = await db.execute(select(FileModel).where(FileModel.id == file_id))
    file = result.scalar_one_or_none()
    if not file:
        raise HTTPException(status_code=404, detail="File not found")

    if file.file_type.value not in ["md", "txt", "code"]:
        raise HTTPException(status_code=400, detail="Diff events are only supported for text files")

    file_path = Path(file.path)
    old_content = ""
    if file_path.exists():
        try:
            old_content = file_path.read_text(encoding="utf-8")
        except Exception:
            old_content = ""

    if old_content == request.new_content:
        return APIResponse(
            success=True,
            data={
                "event_id": None,
                "file_id": file_id,
                "status": "noop",
                "message": "No content change detected",
            },
        )

    event = DiffEvent(
        id=str(uuid.uuid4()),
        file_id=file_id,
        author=request.author,
        old_content=old_content,
        new_content=request.new_content,
        summary=request.summary,
        status=DiffEventStatus.PENDING,
    )
    db.add(event)
    await db.flush()

    snapshots = _build_diff_line_snapshots(old_content, request.new_content)
    created_lines: list[dict] = []
    for item in snapshots:
        line = DiffLineSnapshot(
            id=str(uuid.uuid4()),
            event_id=event.id,
            line_no=item["line_no"],
            old_line=item["old_line"],
            new_line=item["new_line"],
            decision=item["decision"],
        )
        db.add(line)
        created_lines.append(
            {
                "id": line.id,
                "line_no": line.line_no,
                "old_line": line.old_line,
                "new_line": line.new_line,
                "decision": line.decision.value,
            }
        )

    await db.commit()

    return APIResponse(
        success=True,
        data={
            "event_id": event.id,
            "file_id": file_id,
            "status": event.status.value,
            "summary": event.summary,
            "created_at": event.created_at.isoformat(),
            "lines": created_lines,
        },
    )


@router.get("/{file_id}/diff-events/pending", response_model=APIResponse)
async def get_pending_diff_event(
    file_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Get the latest pending diff event for a file."""
    result = await db.execute(
        select(DiffEvent)
        .where(DiffEvent.file_id == file_id, DiffEvent.status == DiffEventStatus.PENDING)
        .order_by(desc(DiffEvent.created_at))
        .limit(1)
    )
    event = result.scalar_one_or_none()
    if not event:
        return APIResponse(success=True, data={"event": None})

    lines_result = await db.execute(
        select(DiffLineSnapshot)
        .where(DiffLineSnapshot.event_id == event.id)
        .order_by(DiffLineSnapshot.line_no)
    )
    lines = lines_result.scalars().all()

    return APIResponse(
        success=True,
        data={
            "event": {
                "id": event.id,
                "file_id": event.file_id,
                "author": event.author.value,
                "summary": event.summary,
                "status": event.status.value,
                "old_content": event.old_content,
                "new_content": event.new_content,
                "created_at": event.created_at.isoformat(),
                "resolved_at": event.resolved_at.isoformat() if event.resolved_at else None,
                "lines": [
                    {
                        "id": line.id,
                        "line_no": line.line_no,
                        "old_line": line.old_line,
                        "new_line": line.new_line,
                        "decision": line.decision.value,
                    }
                    for line in lines
                ],
            }
        },
    )


@router.patch("/{file_id}/diff-events/{event_id}/lines/{line_id}", response_model=APIResponse)
async def update_diff_line_decision(
    file_id: str,
    event_id: str,
    line_id: str,
    request: DiffLineUpdateRequest,
    db: AsyncSession = Depends(get_db),
):
    """Update decision for one line inside a pending diff event."""
    event_result = await db.execute(
        select(DiffEvent).where(
            DiffEvent.id == event_id,
            DiffEvent.file_id == file_id,
            DiffEvent.status == DiffEventStatus.PENDING,
        )
    )
    event = event_result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Pending diff event not found")

    line_result = await db.execute(
        select(DiffLineSnapshot).where(
            DiffLineSnapshot.id == line_id,
            DiffLineSnapshot.event_id == event_id,
        )
    )
    line = line_result.scalar_one_or_none()
    if not line:
        raise HTTPException(status_code=404, detail="Diff line not found")

    line.decision = request.decision
    line.resolved_at = datetime.utcnow() if request.decision != LineDecision.PENDING else None
    await db.commit()

    return APIResponse(
        success=True,
        data={
            "event_id": event_id,
            "line_id": line_id,
            "decision": line.decision.value,
        },
    )


@router.post("/{file_id}/diff-events/{event_id}/finalize", response_model=APIResponse)
async def finalize_diff_event(
    file_id: str,
    event_id: str,
    request: DiffEventFinalizeRequest,
    db: AsyncSession = Depends(get_db),
):
    """Finalize pending diff event, write file content, and create a formal version record."""
    file_result = await db.execute(select(FileModel).where(FileModel.id == file_id))
    file = file_result.scalar_one_or_none()
    if not file:
        raise HTTPException(status_code=404, detail="File not found")

    event_result = await db.execute(
        select(DiffEvent).where(
            DiffEvent.id == event_id,
            DiffEvent.file_id == file_id,
            DiffEvent.status == DiffEventStatus.PENDING,
        )
    )
    event = event_result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Pending diff event not found")

    lines_result = await db.execute(
        select(DiffLineSnapshot)
        .where(DiffLineSnapshot.event_id == event_id)
        .order_by(DiffLineSnapshot.line_no)
    )
    lines = lines_result.scalars().all()

    final_content = request.final_content
    if final_content is None:
        final_content = _compose_content_from_line_snapshots(lines)

    file_path = Path(file.path)
    if not file_path.exists():
        file_path.parent.mkdir(parents=True, exist_ok=True)

    async with aiofiles.open(file_path, "w", encoding="utf-8") as f:
        await f.write(final_content)

    file.size = len(final_content.encode("utf-8"))
    file.updated_at = datetime.utcnow()

    for line in lines:
        if line.decision == LineDecision.PENDING:
            line.decision = LineDecision.ACCEPTED
            line.resolved_at = datetime.utcnow()

    version = Version(
        id=str(uuid.uuid4()),
        file_id=file_id,
        author=request.author,
        change_type=ChangeType.EDIT,
        summary=request.summary or "Finalize diff event",
        diff_patch=_build_unified_diff(event.old_content, final_content),
        context_snapshot=event.old_content,
    )
    db.add(version)

    event.status = DiffEventStatus.RESOLVED
    event.resolved_at = datetime.utcnow()
    event.new_content = final_content

    await db.commit()

    return APIResponse(
        success=True,
        data={
            "event_id": event.id,
            "file_id": file_id,
            "status": event.status.value,
            "version_id": version.id,
            "final_content": final_content,
            "resolved_at": event.resolved_at.isoformat() if event.resolved_at else None,
        },
    )


@router.post("/{file_id}/move", response_model=APIResponse)
async def move_file(
    file_id: str,
    request: MoveFileRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    Move a file or folder to a new parent directory.

    Args:
        file_id: The ID of the file/folder to move
        new_parent_id: The ID of the new parent folder. Use null/root for root level.
    """
    new_parent_id = request.new_parent_id

    result = await db.execute(select(FileModel).where(FileModel.id == file_id))
    file = result.scalar_one_or_none()

    if not file:
        raise HTTPException(status_code=404, detail="File not found")

    # Validate new parent if specified
    if new_parent_id:
        parent_result = await db.execute(
            select(FileModel).where(FileModel.id == new_parent_id, FileModel.file_type == "folder")
        )
        if not parent_result.scalar_one_or_none():
            raise HTTPException(status_code=400, detail="New parent folder not found or is not a folder")

        # Prevent moving a folder into itself or its descendants
        if file.file_type.value == "folder":
            # Check if new_parent is a descendant of file
            current_id = new_parent_id
            visited = set()
            while current_id:
                if current_id == file_id:
                    raise HTTPException(status_code=400, detail="Cannot move a folder into itself or its descendants")
                if current_id in visited:
                    break  # Cycle detected
                visited.add(current_id)

                parent_result = await db.execute(
                    select(FileModel).where(FileModel.id == current_id)
                )
                parent = parent_result.scalar_one_or_none()
                if not parent:
                    break
                current_id = parent.parent_id

    # Update parent_id
    old_parent_id = file.parent_id
    file.parent_id = new_parent_id if new_parent_id else None
    file.updated_at = datetime.utcnow()

    await db.commit()

    return APIResponse(
        success=True,
        data={
            "file_id": file_id,
            "old_parent_id": old_parent_id,
            "new_parent_id": new_parent_id,
            "message": "File moved successfully"
        }
    )


@router.delete("/{file_id}", response_model=APIResponse)
async def delete_file(file_id: str, db: AsyncSession = Depends(get_db)):
    """Delete a file and all associated data."""
    result = await db.execute(select(FileModel).where(FileModel.id == file_id))
    file = result.scalar_one_or_none()

    if not file:
        raise HTTPException(status_code=404, detail="File not found")

    # Delete from vector store
    await vector_store.delete_by_file(file_id)

    # Delete file from disk
    from pathlib import Path
    file_path = Path(file.path)
    if file_path.exists():
        file_path.unlink()

    # Delete from database (cascade will handle chunks)
    await db.delete(file)
    await db.commit()

    return APIResponse(
        success=True,
        data={"message": "File deleted successfully"}
    )


def build_file_tree(files: list) -> list:
    """Build nested tree structure from flat file list."""
    # Create a map of all files by id
    file_map = {}
    for f in files:
        file_path = Path(f.path)
        url = f"/uploads/{file_path.name}" if file_path.exists() else None

        file_map[f.id] = {
            "id": f.id,
            "name": f.name,
            "type": f.file_type.value,
            "size": f.size,
            "page_count": f.page_count,
            "created_at": f.created_at.isoformat(),
            "updated_at": f.updated_at.isoformat(),
            "url": url,
            "parent_id": f.parent_id,
            "children": []
        }

    # Build tree by linking children to parents
    root_files = []
    for f in files:
        file_node = file_map[f.id]
        if f.parent_id and f.parent_id in file_map:
            # Add to parent's children
            file_map[f.parent_id]["children"].append(file_node)
        else:
            # Root level file/folder
            root_files.append(file_node)

    return root_files


@router.get("/", response_model=APIResponse)
async def list_files(
    tree: bool = False,
    parent_id: Optional[str] = None,
    db: AsyncSession = Depends(get_db)
):
    """
    List all files.

    Args:
        tree: If True, return nested tree structure. If False, return flat list.
        parent_id: Filter by parent folder ID. Use "null" or "root" for root items.
    """
    query = select(FileModel)

    # Filter by parent_id if specified
    if parent_id is not None:
        if parent_id.lower() in ("null", "root", ""):
            query = query.where(FileModel.parent_id.is_(None))
        else:
            query = query.where(FileModel.parent_id == parent_id)

    query = query.order_by(FileModel.file_type == "folder", FileModel.updated_at.desc())

    result = await db.execute(query)
    files = result.scalars().all()

    if tree:
        # Get all files to build complete tree
        all_result = await db.execute(select(FileModel))
        all_files = all_result.scalars().all()
        file_list = build_file_tree(all_files)
    else:
        file_list = []
        for f in files:
            file_path = Path(f.path)
            url = f"/uploads/{file_path.name}" if file_path.exists() else None

            file_list.append({
                "id": f.id,
                "name": f.name,
                "type": f.file_type.value,
                "size": f.size,
                "page_count": f.page_count,
                "created_at": f.created_at.isoformat(),
                "updated_at": f.updated_at.isoformat(),
                "url": url,
                "parent_id": f.parent_id
            })

    return APIResponse(
        success=True,
        data={
            "files": file_list,
            "count": len(file_list)
        }
    )
