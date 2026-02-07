from fastapi import APIRouter, UploadFile, File, HTTPException, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
import uuid
import aiofiles
from pathlib import Path
from datetime import datetime
from typing import List, Optional

from app.database import get_db
from app.models import File as FileModel, DocumentChunk, Version, Author, ChangeType
from app.schemas import APIResponse, FileMetadata, FileUpdate
from app.services.document_parser import parser
from app.services.vector_store import vector_store
from app.services.llm_service import llm_service
from app.config import settings

router = APIRouter(prefix="/files", tags=["files"])


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

    # Create file record
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

    # Calculate public URL
    public_url = f"/uploads/{upload_path.name}"

    # Save chunks and generate embeddings
    if chunks:
        # Save chunks to database
        for chunk in chunks:
            db.add(chunk)

        await db.flush()

        # Generate embeddings for chunks
        try:
            chunk_texts = [chunk.content for chunk in chunks]
            embeddings = await llm_service.get_embeddings_batch(chunk_texts)

            # Add to vector store
            await vector_store.add_chunks(chunks, embeddings)
        except Exception as e:
            # Continue without embeddings if AI service is not configured
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
    name: str,
    parent_id: Optional[str] = None,
    db: AsyncSession = Depends(get_db)
):
    """
    Create a virtual folder in the file tree.

    Folders are stored in the database and support hierarchical organization.
    """
    # Validate parent_id if provided
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
    from sqlalchemy import desc
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


@router.post("/{file_id}/move", response_model=APIResponse)
async def move_file(
    file_id: str,
    new_parent_id: Optional[str] = None,
    db: AsyncSession = Depends(get_db)
):
    """
    Move a file or folder to a new parent directory.

    Args:
        file_id: The ID of the file/folder to move
        new_parent_id: The ID of the new parent folder. Use null/root for root level.
    """
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
