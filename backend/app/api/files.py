import difflib
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, List, Optional

import aiofiles
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import delete, desc, select

from app.database import get_db
from app.models import (
    Author,
    ChangeType,
    DocumentAsset,
    DiffEvent,
    DiffEventStatus,
    DiffLineSnapshot,
    DocumentPageAsset,
    DocumentSegment,
    FileIndexStatus,
    DocumentChunk,
    File as FileModel,
    LineDecision,
    Version,
)
from app.schemas import (
    APIResponse,
    DiffEventContentUpdateRequest,
    DiffEventCreateRequest,
    DiffEventFinalizeRequest,
    DiffLineUpdateRequest,
    FileMetadata,
    FileUpdate,
    FolderCreateRequest,
    MoveFileRequest,
    ReindexRequest,
    WebImportRequest,
)
from app.services.document_parser import parser
from app.services.diff_events import (
    build_diff_line_snapshots,
    compose_content_from_line_snapshots,
    get_effective_diff_base,
    resolve_all_pending_diff_events,
)
from app.services.multiformat_document_service import reader_orchestrator
from app.services.visual_retrieval_service import visual_retrieval_service
from app.services.vector_store import vector_store
from app.config import settings

router = APIRouter(prefix="/files", tags=["files"])

INDEX_REQUIRED_FILE_TYPES = {"pdf", "md", "txt", "docx", "web"}


def _to_public_upload_url(file_path: Path) -> Optional[str]:
    if not file_path.exists():
        return None

    try:
        uploads_root = Path(settings.UPLOAD_DIR).resolve()
        resolved = file_path.resolve()
        relative_path = resolved.relative_to(uploads_root).as_posix()
        return f"/uploads/{relative_path}"
    except Exception:
        # Fallback: best effort for legacy paths.
        return f"/uploads/{file_path.name}"


def _parse_bbox_filter(raw_bbox: Optional[str]) -> Optional[tuple[float, float, float, float]]:
    if not raw_bbox:
        return None
    try:
        parts = [float(item.strip()) for item in str(raw_bbox).split(",")]
    except Exception:
        return None
    if len(parts) != 4:
        return None
    return parts[0], parts[1], parts[2], parts[3]


def _normalize_bbox(value: object) -> Optional[tuple[float, float, float, float]]:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    try:
        return float(value[0]), float(value[1]), float(value[2]), float(value[3])
    except Exception:
        return None


def _bbox_intersects(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> bool:
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    overlap_x = max(0.0, min(ax1, bx1) - max(ax0, bx0))
    overlap_y = max(0.0, min(ay1, by1) - max(ay0, by0))
    return overlap_x > 0 and overlap_y > 0


def _file_type_to_str(file_type: object) -> str:
    return file_type.value if hasattr(file_type, "value") else str(file_type)


def _requires_index_ready(file_type: str) -> bool:
    return str(file_type or "").lower() in INDEX_REQUIRED_FILE_TYPES


def _is_index_ready(index_status: dict[str, Any]) -> bool:
    parse_status = str(index_status.get("parse_status") or "").lower()
    embedding_status = str(index_status.get("embedding_status") or "").lower()
    return parse_status == "ready" and embedding_status in {"ready", "ready_with_errors"}


def _format_index_failure(index_status: dict[str, Any]) -> str:
    parse_status = str(index_status.get("parse_status") or "unknown")
    embedding_status = str(index_status.get("embedding_status") or "unknown")
    last_error = str(index_status.get("last_error") or "").strip()
    message = f"Index build did not finish (parse={parse_status}, embedding={embedding_status})"
    if last_error:
        message = f"{message}: {last_error}"
    return message


async def _cleanup_partial_upload(
    *,
    db: AsyncSession,
    file_id: Optional[str],
    upload_path: Optional[Path],
) -> None:
    try:
        await db.rollback()
    except Exception:
        pass

    if file_id:
        try:
            await vector_store.delete_by_file(file_id)
        except Exception:
            pass
        try:
            await vector_store.delete_segment_embeddings_by_file(file_id)
        except Exception:
            pass

    if upload_path:
        try:
            upload_path.unlink(missing_ok=True)
        except Exception:
            pass


def _build_diff_line_snapshots(old_content: str, new_content: str) -> list[dict]:
    """
    Build line-level snapshots from a before/after string pair.

    Rows follow line diff order so inserts and deletes can be reviewed independently.
    """
    return build_diff_line_snapshots(old_content, new_content)


def _compose_content_from_line_snapshots(snapshots: list[DiffLineSnapshot]) -> str:
    """
    Compose finalized content from line decisions.

    accepted -> new_line
    rejected -> old_line
    pending  -> new_line (finalize should normally resolve pending first)
    """
    return compose_content_from_line_snapshots(snapshots)


async def _get_latest_pending_diff_event(db: AsyncSession, file_id: str) -> Optional[DiffEvent]:
    result = await db.execute(
        select(DiffEvent)
        .where(DiffEvent.file_id == file_id, DiffEvent.status == DiffEventStatus.PENDING)
        .order_by(desc(DiffEvent.created_at))
        .limit(1)
    )
    return result.scalar_one_or_none()


async def _get_diff_event_lines(db: AsyncSession, event_id: str) -> list[DiffLineSnapshot]:
    result = await db.execute(
        select(DiffLineSnapshot)
        .where(DiffLineSnapshot.event_id == event_id)
        .order_by(DiffLineSnapshot.line_no)
    )
    return list(result.scalars().all())


async def _resolve_pending_diff_as_superseded(
    db: AsyncSession,
    event: DiffEvent,
) -> str:
    lines = await _get_diff_event_lines(db, event.id)
    composed_content = _compose_content_from_line_snapshots(lines)
    event.status = DiffEventStatus.RESOLVED
    event.resolved_at = datetime.utcnow()
    event.new_content = composed_content
    return composed_content


async def _replace_diff_event_lines(
    db: AsyncSession,
    event_id: str,
    snapshots: list[dict[str, Any]],
) -> list[DiffLineSnapshot]:
    await db.execute(delete(DiffLineSnapshot).where(DiffLineSnapshot.event_id == event_id))

    created: list[DiffLineSnapshot] = []
    for item in snapshots:
        line = DiffLineSnapshot(
            id=str(uuid.uuid4()),
            event_id=event_id,
            line_no=item["line_no"],
            old_line=item["old_line"],
            new_line=item["new_line"],
            decision=item["decision"],
        )
        db.add(line)
        created.append(line)

    await db.flush()
    return created


async def _finalize_diff_event_record(
    db: AsyncSession,
    file: FileModel,
    event: DiffEvent,
    lines: list[DiffLineSnapshot],
    final_content: str,
    summary: Optional[str],
    author: Author,
) -> Version:
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
        file_id=file.id,
        author=author,
        change_type=ChangeType.EDIT,
        summary=summary or "Finalize diff event",
        diff_patch=_build_unified_diff(event.old_content, final_content),
        context_snapshot=event.old_content,
        result_snapshot=final_content,
    )
    db.add(version)

    event.status = DiffEventStatus.RESOLVED
    event.resolved_at = datetime.utcnow()
    event.new_content = final_content

    await db.commit()
    return version


def _serialize_diff_event(event: DiffEvent, lines: list[DiffLineSnapshot]) -> dict[str, Any]:
    return {
        "id": event.id,
        "file_id": event.file_id,
        "author": event.author.value,
        "summary": event.summary,
        "status": event.status.value,
        "old_content": event.old_content,
        "new_content": event.new_content,
        "effective_content": _compose_content_from_line_snapshots(lines),
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
        ".html": "web",
        ".htm": "web",
        ".png": "image",
        ".jpg": "image",
        ".jpeg": "image",
    }
    file_type = file_type_map.get(file_ext, "txt")

    if _requires_index_ready(file_type):
        embedding_backend_ready = reader_orchestrator.embedding_provider.is_enabled() and vector_store.enabled
        if not embedding_backend_ready:
            await _cleanup_partial_upload(db=db, file_id=None, upload_path=upload_path)
            raise HTTPException(
                status_code=503,
                detail="Embedding/index backend is unavailable. Verify the embedding model and vector store, then retry the upload.",
            )

    db_file: Optional[FileModel] = None
    chunks = []
    metadata: dict[str, Any] = {}
    visual_assets = []
    index_status: dict[str, Any] = {}
    public_url = _to_public_upload_url(upload_path)

    try:
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

        # Save chunks and legacy chunk vectors when configured.
        if chunks:
            for chunk in chunks:
                db.add(chunk)
            await db.flush()

        if file_type == "pdf":
            try:
                visual_assets = await visual_retrieval_service.ensure_page_assets(
                    db=db,
                    file_id=file_id,
                    page_count_hint=metadata.get("page_count"),
                    file_path_hint=str(upload_path),
                    chunks_hint=chunks,
                )
            except Exception as e:
                print(f"Warning: Could not build visual page assets: {e}")

        if _requires_index_ready(file_type):
            index_status = await reader_orchestrator.build_segments_for_file(
                db=db,
                file=db_file,
                chunks_hint=chunks if chunks else None,
                mode="all",
            )
            if not _is_index_ready(index_status):
                raise RuntimeError(_format_index_failure(index_status))

        await db.commit()
    except HTTPException:
        await _cleanup_partial_upload(db=db, file_id=file_id if db_file else None, upload_path=upload_path)
        raise
    except Exception as exc:
        await _cleanup_partial_upload(db=db, file_id=file_id if db_file else None, upload_path=upload_path)
        raise HTTPException(status_code=503, detail=f"Upload failed before indexing completed: {exc}")

    return APIResponse(
        success=True,
        data={
            "file_id": file_id,
            "name": file.filename,
            "type": file_type,
            "size": len(content),
            "chunks_count": len(chunks),
            "metadata": metadata,
            "visual_page_assets": {
                "count": len(visual_assets),
                "sample_pages": [
                    {"page": asset.page, "image_url": asset.image_url}
                    for asset in visual_assets[:3]
                ],
            } if file_type == "pdf" else None,
            "index_status": index_status or None,
            "url": public_url,
            "parent_id": parent_id
        }
    )


@router.post("/import/web-url", response_model=APIResponse)
async def import_web_url(
    request: WebImportRequest,
    db: AsyncSession = Depends(get_db),
):
    """Import a webpage by URL and index it as a readable document."""
    parent_id = request.parent_id
    if parent_id:
        parent_result = await db.execute(
            select(FileModel).where(FileModel.id == parent_id, FileModel.file_type == "folder")
        )
        if not parent_result.scalar_one_or_none():
            raise HTTPException(status_code=400, detail="Parent folder not found or is not a folder")

    try:
        result = await reader_orchestrator.import_web_url(
            db=db,
            url=request.url,
            title=request.title,
            tags=request.tags or [],
            fetch_options=request.fetch_options or {},
            parent_id=parent_id,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to import webpage: {exc}")

    await db.commit()
    return APIResponse(success=True, data=result)


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
    url = _to_public_upload_url(file_path)

    return APIResponse(
        success=True,
        data={
            "id": file.id,
            "name": file.name,
            "type": _file_type_to_str(file.file_type),
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

    file_type = _file_type_to_str(file.file_type)
    if file_type in ["md", "txt"]:
        content = file_path.read_text(encoding="utf-8")
    elif file_type == "web":
        segments_result = await db.execute(
            select(DocumentSegment)
            .where(DocumentSegment.file_id == file_id)
            .order_by(DocumentSegment.page, DocumentSegment.chunk_index)
            .limit(400)
        )
        segments = segments_result.scalars().all()
        if segments:
            content = "\n\n".join([seg.text for seg in segments])
        else:
            content = file_path.read_text(encoding="utf-8", errors="ignore")
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
    if _file_type_to_str(file.file_type) not in ["md", "txt", "code"]:
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
        context_snapshot=context_snapshot,
        result_snapshot=update.content,
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


@router.get("/{file_id}/segments", response_model=APIResponse)
async def get_file_segments(
    file_id: str,
    page: int = None,
    section: str = None,
    bbox: str = None,
    segment_type: str = None,
    source: str = None,
    db: AsyncSession = Depends(get_db),
):
    """Get normalized document segments (md/pdf/web)."""
    file_result = await db.execute(select(FileModel).where(FileModel.id == file_id))
    if not file_result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="File not found")

    query = select(DocumentSegment).where(DocumentSegment.file_id == file_id)
    if page is not None:
        query = query.where(DocumentSegment.page == page)
    if section:
        query = query.where(DocumentSegment.section == section)
    if segment_type:
        query = query.where(DocumentSegment.segment_type == segment_type)
    if source:
        query = query.where(DocumentSegment.source == source)
    query = query.order_by(DocumentSegment.page, DocumentSegment.chunk_index)

    result = await db.execute(query)
    rows = result.scalars().all()
    bbox_filter = _parse_bbox_filter(bbox)
    if bbox_filter:
        filtered_rows = []
        for row in rows:
            row_bbox = _normalize_bbox(row.bbox)
            if row_bbox and _bbox_intersects(row_bbox, bbox_filter):
                filtered_rows.append(row)
        rows = filtered_rows

    return APIResponse(
        success=True,
        data={
            "file_id": file_id,
            "count": len(rows),
            "segments": [
                {
                    "id": row.id,
                    "source_type": row.source_type,
                    "page": row.page,
                    "section": row.section,
                    "chunk_index": row.chunk_index,
                    "segment_type": row.segment_type,
                    "confidence": row.confidence,
                    "source": row.source,
                    "text": row.text,
                    "bbox": row.bbox,
                    "meta": row.meta,
                }
                for row in rows
            ],
        },
    )


@router.post("/{file_id}/reindex", response_model=APIResponse)
async def reindex_file(
    file_id: str,
    request: ReindexRequest,
    db: AsyncSession = Depends(get_db),
):
    """Rebuild parse/embedding index for a file."""
    file_result = await db.execute(select(FileModel).where(FileModel.id == file_id))
    file_row = file_result.scalar_one_or_none()
    if not file_row:
        raise HTTPException(status_code=404, detail="File not found")

    mode = request.mode
    try:
        result = await reader_orchestrator.build_segments_for_file(
            db=db,
            file=file_row,
            chunks_hint=None,
            mode=mode,
        )
        await db.commit()
    except OperationalError as exc:
        await db.rollback()
        if "database is locked" not in str(exc).lower():
            raise
        return APIResponse(
            success=False,
            error="Index warmup deferred while the workspace is busy. Retry shortly.",
            data={
                "file_id": file_id,
                "mode": mode,
                "busy": True,
            },
        )
    return APIResponse(
        success=True,
        data={
            "file_id": file_id,
            "mode": mode,
            "index_status": result,
        },
    )


@router.get("/{file_id}/index-status", response_model=APIResponse)
async def get_index_status(
    file_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Get parse/embedding index status for one file."""
    file_result = await db.execute(select(FileModel).where(FileModel.id == file_id))
    file_row = file_result.scalar_one_or_none()
    if not file_row:
        raise HTTPException(status_code=404, detail="File not found")

    status_result = await db.execute(select(FileIndexStatus).where(FileIndexStatus.file_id == file_id))
    row = status_result.scalar_one_or_none()
    parse_status = row.parse_status if row else "pending"
    embedding_status = row.embedding_status if row else "pending"
    last_error = row.last_error if row else None
    updated_at = row.updated_at.isoformat() if row and row.updated_at else None

    if parse_status == "pending":
        segment_exists = (
            await db.execute(select(DocumentSegment.id).where(DocumentSegment.file_id == file_id).limit(1))
        ).first() is not None
        chunk_exists = (
            await db.execute(select(DocumentChunk.id).where(DocumentChunk.file_id == file_id).limit(1))
        ).first() is not None
        if segment_exists or chunk_exists:
            parse_status = "ready"
            if not updated_at and file_row.updated_at:
                updated_at = file_row.updated_at.isoformat()

    if embedding_status == "pending" and not vector_store.enabled:
        embedding_status = "disabled"
        if not updated_at and file_row.updated_at:
            updated_at = file_row.updated_at.isoformat()

    return APIResponse(
        success=True,
        data={
            "file_id": file_id,
            "parse_status": parse_status,
            "embedding_status": embedding_status,
            "last_error": last_error,
            "updated_at": updated_at,
        },
    )


@router.get("/{file_id}/page-assets", response_model=APIResponse)
async def get_file_page_assets(
    file_id: str,
    page: int = None,
    db: AsyncSession = Depends(get_db),
):
    """Get visual page assets (page image + text anchor) for multimodal retrieval."""
    result = await db.execute(select(FileModel).where(FileModel.id == file_id))
    file = result.scalar_one_or_none()
    if not file:
        raise HTTPException(status_code=404, detail="File not found")

    file_type = _file_type_to_str(file.file_type).lower()
    if file_type == "pdf":
        try:
            await visual_retrieval_service.ensure_page_assets(
                db=db,
                file_id=file_id,
                page_count_hint=file.page_count,
                file_path_hint=file.path,
            )
            await db.commit()
        except Exception:
            await db.rollback()

    query = select(DocumentPageAsset).where(DocumentPageAsset.file_id == file_id)
    if page is not None:
        query = query.where(DocumentPageAsset.page == page)
    query = query.order_by(DocumentPageAsset.page)

    assets_result = await db.execute(query)
    assets = assets_result.scalars().all()

    return APIResponse(
        success=True,
        data={
            "file_id": file_id,
            "count": len(assets),
            "assets": [
                {
                    "id": asset.id,
                    "page": asset.page,
                    "image_url": asset.image_url,
                    "text_anchor": asset.text_anchor,
                }
                for asset in assets
            ],
        },
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
            "result_snapshot": v.result_snapshot,
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

    if _file_type_to_str(file.file_type) not in ["md", "txt", "code"]:
        raise HTTPException(status_code=400, detail="Diff events are only supported for text files")

    file_path = Path(file.path)
    old_content = ""
    if file_path.exists():
        try:
            old_content = file_path.read_text(encoding="utf-8")
        except Exception:
            old_content = ""

    base_content, current_content, _ = await get_effective_diff_base(db, file_id, old_content)

    if current_content == request.new_content:
        return APIResponse(
            success=True,
            data={
                "event_id": None,
                "file_id": file_id,
                "status": "noop",
                "message": "No content change detected",
            },
        )

    if base_content == request.new_content:
        await resolve_all_pending_diff_events(
            db,
            file_id,
            replacement_content=base_content,
        )
        await db.commit()
        return APIResponse(
            success=True,
            data={
                "event_id": None,
                "file_id": file_id,
                "status": "noop",
                "message": "No net content change detected",
            },
        )

    await resolve_all_pending_diff_events(
        db,
        file_id,
        replacement_content=current_content,
    )

    event = DiffEvent(
        id=str(uuid.uuid4()),
        file_id=file_id,
        author=request.author,
        old_content=base_content,
        new_content=request.new_content,
        summary=request.summary,
        status=DiffEventStatus.PENDING,
    )
    db.add(event)
    await db.flush()

    snapshots = _build_diff_line_snapshots(base_content, request.new_content)
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
            "event": _serialize_diff_event(event, lines),
        },
    )


@router.patch("/{file_id}/diff-events/{event_id}/content", response_model=APIResponse)
async def update_diff_event_content(
    file_id: str,
    event_id: str,
    request: DiffEventContentUpdateRequest,
    db: AsyncSession = Depends(get_db),
):
    """Update an existing pending diff event in place without finalizing it."""
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

    current_lines = await _get_diff_event_lines(db, event.id)
    current_effective_content = _compose_content_from_line_snapshots(current_lines)
    if current_effective_content == request.new_content:
        return APIResponse(success=True, data={"event": _serialize_diff_event(event, current_lines)})

    event.new_content = request.new_content
    if request.summary is not None:
        event.summary = request.summary
    event.author = request.author

    snapshots = _build_diff_line_snapshots(event.old_content, request.new_content)
    lines = await _replace_diff_event_lines(db, event.id, snapshots)
    await db.commit()
    await db.refresh(event)

    return APIResponse(
        success=True,
        data={
            "event": _serialize_diff_event(event, lines),
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
        result_snapshot=final_content,
    )
    db.add(version)

    event.status = DiffEventStatus.RESOLVED
    event.resolved_at = datetime.utcnow()
    event.new_content = final_content

    await resolve_all_pending_diff_events(
        db,
        file_id,
        replacement_content=final_content,
        exclude_event_id=event.id,
    )

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
        if _file_type_to_str(file.file_type) == "folder":
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
        url = _to_public_upload_url(file_path)

        file_map[f.id] = {
            "id": f.id,
            "name": f.name,
            "type": _file_type_to_str(f.file_type),
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
            url = _to_public_upload_url(file_path)

            file_list.append({
                "id": f.id,
                "name": f.name,
                "type": _file_type_to_str(f.file_type),
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
