from __future__ import annotations

import io
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException, UploadFile
from sqlalchemy.exc import OperationalError
from sqlalchemy import select

from app.api import files as files_api
from app.config import settings
from app.models import (
    ChangeType,
    DiffEvent,
    DiffEventStatus,
    DocumentChunk,
    DocumentPageAsset,
    DocumentSegment,
    File,
    FileIndexStatus,
    FileType,
    LineDecision,
    Version,
)
from app.schemas import (
    DiffEventCreateRequest,
    DiffEventFinalizeRequest,
    DiffLineUpdateRequest,
    FileUpdate,
    FolderCreateRequest,
    MoveFileRequest,
    ReindexRequest,
    WebImportRequest,
)


def test_files_helpers(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path), raising=False)

    nested = tmp_path / "a" / "b.txt"
    nested.parent.mkdir(parents=True, exist_ok=True)
    nested.write_text("x", encoding="utf-8")
    assert files_api._to_public_upload_url(nested) == "/uploads/a/b.txt"
    assert files_api._to_public_upload_url(tmp_path / "missing.txt") is None

    assert files_api._parse_bbox_filter("1,2,3,4") == (1.0, 2.0, 3.0, 4.0)
    assert files_api._parse_bbox_filter("1,2,3") is None
    assert files_api._normalize_bbox([1, 2, 3, 4]) == (1.0, 2.0, 3.0, 4.0)
    assert files_api._normalize_bbox("bad") is None
    assert files_api._bbox_intersects((0, 0, 5, 5), (4, 4, 8, 8)) is True
    assert files_api._bbox_intersects((0, 0, 1, 1), (2, 2, 3, 3)) is False

    snapshots = files_api._build_diff_line_snapshots("a\nb", "a\nc\nd")
    assert snapshots[0]["decision"] == LineDecision.ACCEPTED
    assert snapshots[1]["decision"] == LineDecision.PENDING
    assert snapshots[1]["old_line"] == "b"
    assert snapshots[1]["new_line"] == "c"
    assert snapshots[2]["old_line"] is None
    assert snapshots[2]["new_line"] == "d"

    line_rows = [
        type("Line", (), {"line_no": 2, "old_line": "B-old", "new_line": "B-new", "decision": LineDecision.REJECTED}),
        type("Line", (), {"line_no": 1, "old_line": "A-old", "new_line": "A-new", "decision": LineDecision.ACCEPTED}),
    ]
    assert files_api._compose_content_from_line_snapshots(line_rows) == "A-new\nB-old"
    assert "@@" in files_api._build_unified_diff("a\nb\n", "a\nc\n")


@pytest.mark.asyncio
async def test_upload_file_and_listing(
    db_session,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path), raising=False)
    monkeypatch.setattr(settings, "MAX_FILE_SIZE", 10_000_000, raising=False)
    monkeypatch.setattr(settings, "ALLOWED_EXTENSIONS", {".md", ".txt", ".pdf"}, raising=False)

    async def fake_parse_file(path: str, file_id: str, file_type: str):  # noqa: ARG001
        return (
            [
                DocumentChunk(
                    id="chunk-1",
                    file_id=file_id,
                    page=1,
                    chunk_index=0,
                    content="Parsed content",
                    bbox=None,
                )
            ],
            {"page_count": 1},
        )

    monkeypatch.setattr(
        files_api.parser,
        "parse_file",
        AsyncMock(side_effect=fake_parse_file),
    )
    monkeypatch.setattr(files_api.reader_orchestrator.embedding_provider, "is_enabled", lambda: True)
    monkeypatch.setattr(files_api.vector_store, "enabled", True)
    add_chunks = AsyncMock(return_value=None)
    monkeypatch.setattr(files_api.vector_store, "add_chunks", add_chunks)
    monkeypatch.setattr(files_api.visual_retrieval_service, "ensure_page_assets", AsyncMock(return_value=[]))
    monkeypatch.setattr(
        files_api.reader_orchestrator,
        "build_segments_for_file",
        AsyncMock(return_value={"parse_status": "ready", "embedding_status": "ready"}),
    )

    upload = UploadFile(filename="sample.md", file=io.BytesIO(b"# Title\n\nBody"))
    response = await files_api.upload_file(file=upload, parent_id=None, db=db_session)
    assert response.success is True
    file_id = response.data["file_id"]
    assert response.data["type"] == "md"
    add_chunks.assert_not_called()

    listing = await files_api.list_files(tree=False, parent_id=None, db=db_session)
    assert listing.data["count"] >= 1
    assert any(item["id"] == file_id for item in listing.data["files"])

    listing_tree = await files_api.list_files(tree=True, parent_id=None, db=db_session)
    assert listing_tree.data["files"]


@pytest.mark.asyncio
async def test_upload_file_rolls_back_when_indexing_fails(
    db_session,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path), raising=False)
    monkeypatch.setattr(settings, "MAX_FILE_SIZE", 10_000_000, raising=False)
    monkeypatch.setattr(settings, "ALLOWED_EXTENSIONS", {".md"}, raising=False)

    async def fake_parse_file(path: str, file_id: str, file_type: str):  # noqa: ARG001
        return (
            [
                DocumentChunk(
                    id="chunk-fail-1",
                    file_id=file_id,
                    page=1,
                    chunk_index=0,
                    content="Parsed content",
                    bbox=None,
                )
            ],
            {"page_count": 1},
        )

    monkeypatch.setattr(
        files_api.parser,
        "parse_file",
        AsyncMock(side_effect=fake_parse_file),
    )
    monkeypatch.setattr(files_api.reader_orchestrator.embedding_provider, "is_enabled", lambda: True)
    monkeypatch.setattr(files_api.vector_store, "enabled", True)
    delete_by_file = AsyncMock(return_value=None)
    delete_segment_embeddings = AsyncMock(return_value=None)
    monkeypatch.setattr(files_api.vector_store, "delete_by_file", delete_by_file)
    monkeypatch.setattr(files_api.vector_store, "delete_segment_embeddings_by_file", delete_segment_embeddings)
    monkeypatch.setattr(
        files_api.reader_orchestrator,
        "build_segments_for_file",
        AsyncMock(return_value={"parse_status": "ready", "embedding_status": "failed", "last_error": "dashscope timeout"}),
    )

    upload = UploadFile(filename="broken.md", file=io.BytesIO(b"# Title\n\nBody"))
    with pytest.raises(HTTPException) as excinfo:
        await files_api.upload_file(file=upload, parent_id=None, db=db_session)

    assert excinfo.value.status_code == 503
    assert "indexing completed" in excinfo.value.detail.lower()

    stored = (await db_session.execute(select(File).where(File.name == "broken.md"))).scalar_one_or_none()
    assert stored is None
    assert not (tmp_path / "broken.md").exists()
    delete_by_file.assert_called_once()
    delete_segment_embeddings.assert_called_once()


@pytest.mark.asyncio
async def test_file_content_and_segments_routes(
    db_session,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    md_path = tmp_path / "doc.md"
    md_path.write_text("hello\nworld", encoding="utf-8")
    web_path = tmp_path / "page.html"
    web_path.write_text("<h1>web</h1>", encoding="utf-8")
    pdf_path = tmp_path / "doc.pdf"
    pdf_path.write_bytes(b"%PDF")

    db_session.add_all(
        [
            File(id="md-1", name="doc.md", file_type=FileType.MD, path=str(md_path), size=10, page_count=1, meta={}),
            File(id="web-1", name="web.html", file_type=FileType.WEB, path=str(web_path), size=8, page_count=1, meta={}),
            File(id="pdf-1", name="doc.pdf", file_type=FileType.PDF, path=str(pdf_path), size=4, page_count=2, meta={}),
        ]
    )
    db_session.add(
        DocumentSegment(
            id="seg-web",
            file_id="web-1",
            source_type="web",
            page=1,
            section="s",
            chunk_index=0,
            bbox=(0, 0, 20, 20),
            text="web text",
            segment_type="paragraph",
            confidence=0.8,
            source="local",
            meta={},
        )
    )
    db_session.add(
        DocumentChunk(
            id="chunk-pdf",
            file_id="pdf-1",
            page=2,
            chunk_index=1,
            content="pdf chunk",
            bbox=(1, 1, 5, 5),
        )
    )
    db_session.add(
        FileIndexStatus(file_id="md-1", parse_status="ready", embedding_status="pending", last_error=None)
    )
    db_session.add(
        DocumentPageAsset(
            id="asset-1",
            file_id="pdf-1",
            page=2,
            image_path="/tmp/p.jpg",
            image_url="/uploads/p.jpg",
            text_anchor="anchor",
        )
    )
    await db_session.commit()

    md_content = await files_api.get_file_content("md-1", db=db_session)
    assert "hello" in md_content.data["content"]

    web_content = await files_api.get_file_content("web-1", db=db_session)
    assert "web text" in web_content.data["content"]

    pdf_content = await files_api.get_file_content("pdf-1", db=db_session)
    assert "pdf chunk" in pdf_content.data["content"]

    segments = await files_api.get_file_segments(
        "web-1",
        bbox="0,0,10,10",
        page=None,
        section=None,
        segment_type=None,
        source=None,
        db=db_session,
    )
    assert segments.data["count"] == 1

    status = await files_api.get_index_status("md-1", db=db_session)
    assert status.data["parse_status"] == "ready"

    pending_path = tmp_path / "pending.pdf"
    pending_path.write_bytes(b"%PDF pending")
    db_session.add(
        File(
            id="pdf-pending",
            name="pending.pdf",
            file_type=FileType.PDF,
            path=str(pending_path),
            size=12,
            page_count=1,
            meta={},
        )
    )
    db_session.add(
        DocumentChunk(
            id="chunk-pending",
            file_id="pdf-pending",
            page=1,
            chunk_index=0,
            content="pending chunk",
            bbox=None,
        )
    )
    db_session.add(
        FileIndexStatus(
            file_id="pdf-pending",
            parse_status="pending",
            embedding_status="pending",
            last_error=None,
        )
    )
    await db_session.commit()

    monkeypatch.setattr(files_api.vector_store, "enabled", False)
    synthesized = await files_api.get_index_status("pdf-pending", db=db_session)
    assert synthesized.data["parse_status"] == "ready"
    assert synthesized.data["embedding_status"] == "disabled"

    page_assets = await files_api.get_file_page_assets("pdf-1", page=2, db=db_session)
    assert page_assets.data["count"] == 1


@pytest.mark.asyncio
async def test_update_content_and_diff_event_lifecycle(
    db_session,
    tmp_path: Path,
):
    file_path = tmp_path / "note.md"
    file_path.write_text("line1\nline2", encoding="utf-8")

    db_session.add(
        File(
            id="file-diff",
            name="note.md",
            file_type=FileType.MD,
            path=str(file_path),
            size=12,
            page_count=1,
            meta={},
        )
    )
    await db_session.commit()

    update_resp = await files_api.update_file_content(
        "file-diff",
        FileUpdate(content="line1\nline2\nline3", summary="append line", change_type=ChangeType.EDIT),
        db=db_session,
    )
    assert update_resp.success is True

    create_resp = await files_api.create_diff_event(
        "file-diff",
        DiffEventCreateRequest(new_content="line1\nlineX\nline3", summary="agent edit"),
        db=db_session,
    )
    assert create_resp.data["status"] == DiffEventStatus.PENDING.value
    event_id = create_resp.data["event_id"]
    line_id = create_resp.data["lines"][1]["id"]

    pending = await files_api.get_pending_diff_event("file-diff", db=db_session)
    assert pending.data["event"]["id"] == event_id

    line_update = await files_api.update_diff_line_decision(
        "file-diff",
        event_id,
        line_id,
        DiffLineUpdateRequest(decision=LineDecision.REJECTED),
        db=db_session,
    )
    assert line_update.data["decision"] == LineDecision.REJECTED.value

    finalize = await files_api.finalize_diff_event(
        "file-diff",
        event_id,
        DiffEventFinalizeRequest(final_content="line1\nline2\nline3", summary="finalize"),
        db=db_session,
    )
    assert finalize.data["status"] == DiffEventStatus.RESOLVED.value

    versions = await files_api.get_file_versions("file-diff", db=db_session, limit=20, offset=0)
    assert versions.data["total"] >= 1
    assert versions.data["versions"][0]["result_snapshot"] == "line1\nline2\nline3"

    version_rows = (
        await db_session.execute(select(Version).where(Version.file_id == "file-diff").order_by(Version.timestamp.desc()))
    ).scalars().all()
    assert version_rows[0].result_snapshot == "line1\nline2\nline3"


@pytest.mark.asyncio
async def test_create_diff_event_supersedes_previous_pending_and_finalize_clears_older_pending(
    db_session,
    tmp_path: Path,
):
    file_path = tmp_path / "note-stacked.md"
    file_path.write_text("line1\nline2", encoding="utf-8")

    db_session.add(
        File(
            id="file-stacked",
            name="note-stacked.md",
            file_type=FileType.MD,
            path=str(file_path),
            size=11,
            page_count=1,
            meta={},
        )
    )
    await db_session.commit()

    first = await files_api.create_diff_event(
        "file-stacked",
        DiffEventCreateRequest(new_content="line1\nline-x", summary="first"),
        db=db_session,
    )
    second = await files_api.create_diff_event(
        "file-stacked",
        DiffEventCreateRequest(new_content="line1\nline-y\nline-z", summary="second"),
        db=db_session,
    )

    assert first.data["status"] == DiffEventStatus.PENDING.value
    assert second.data["status"] == DiffEventStatus.PENDING.value

    pending = await files_api.get_pending_diff_event("file-stacked", db=db_session)
    assert pending.data["event"]["id"] == second.data["event_id"]
    assert pending.data["event"]["old_content"] == "line1\nline2"
    assert pending.data["event"]["new_content"] == "line1\nline-y\nline-z"

    events = (
        await db_session.execute(select(DiffEvent).where(DiffEvent.file_id == "file-stacked").order_by(DiffEvent.created_at, DiffEvent.id))
    ).scalars().all()
    assert [event.status for event in events] == [DiffEventStatus.RESOLVED, DiffEventStatus.PENDING]

    finalize = await files_api.finalize_diff_event(
        "file-stacked",
        second.data["event_id"],
        DiffEventFinalizeRequest(final_content="line1\nline-y\nline-z", summary="accept stacked"),
        db=db_session,
    )
    assert finalize.data["status"] == DiffEventStatus.RESOLVED.value
    assert file_path.read_text(encoding="utf-8") == "line1\nline-y\nline-z"

    pending_after = await files_api.get_pending_diff_event("file-stacked", db=db_session)
    assert pending_after.data["event"] is None


@pytest.mark.asyncio
async def test_move_reindex_delete_and_folder_errors(
    db_session,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path), raising=False)
    (tmp_path / "root.md").write_text("root", encoding="utf-8")

    folder = File(
        id="folder-1",
        name="docs",
        file_type=FileType.FOLDER,
        path=str(tmp_path / "docs"),
        size=0,
        page_count=None,
        meta={},
    )
    file_row = File(
        id="md-1",
        name="root.md",
        file_type=FileType.MD,
        path=str(tmp_path / "root.md"),
        size=4,
        page_count=1,
        meta={},
    )
    db_session.add_all([folder, file_row])
    await db_session.commit()

    with pytest.raises(HTTPException):
        await files_api.create_folder(FolderCreateRequest(name=" "), db=db_session)

    created = await files_api.create_folder(FolderCreateRequest(name="new-folder", parent_id="folder-1"), db=db_session)
    assert created.success is True

    moved = await files_api.move_file("md-1", MoveFileRequest(new_parent_id="folder-1"), db=db_session)
    assert moved.data["new_parent_id"] == "folder-1"

    monkeypatch.setattr(
        files_api.reader_orchestrator,
        "build_segments_for_file",
        AsyncMock(return_value={"segment_count": 1, "embedding_status": "ready"}),
    )
    reindex = await files_api.reindex_file("md-1", ReindexRequest(mode="all"), db=db_session)
    assert reindex.data["mode"] == "all"

    monkeypatch.setattr(
        files_api.reader_orchestrator,
        "build_segments_for_file",
        AsyncMock(side_effect=OperationalError("stmt", {}, Exception("database is locked"))),
    )
    deferred = await files_api.reindex_file("md-1", ReindexRequest(mode="all"), db=db_session)
    assert deferred.success is False
    assert deferred.data["busy"] is True

    monkeypatch.setattr(files_api.vector_store, "delete_by_file", AsyncMock(return_value=None))
    deleted = await files_api.delete_file("md-1", db=db_session)
    assert deleted.success is True

    with pytest.raises(HTTPException):
        await files_api.get_file("md-1", db=db_session)


def test_build_file_tree_shape():
    f1 = type(
        "FileRow",
        (),
        {
            "id": "root",
            "name": "root",
            "file_type": type("FT", (), {"value": "folder"})(),
            "size": 0,
            "page_count": None,
            "created_at": type("D", (), {"isoformat": lambda self: "t1"})(),
            "updated_at": type("D", (), {"isoformat": lambda self: "t2"})(),
            "path": "/tmp/root",
            "parent_id": None,
        },
    )()
    f2 = type(
        "FileRow",
        (),
        {
            "id": "child",
            "name": "child.md",
            "file_type": type("FT", (), {"value": "md"})(),
            "size": 1,
            "page_count": 1,
            "created_at": type("D", (), {"isoformat": lambda self: "t1"})(),
            "updated_at": type("D", (), {"isoformat": lambda self: "t2"})(),
            "path": "/tmp/child.md",
            "parent_id": "root",
        },
    )()

    tree = files_api.build_file_tree([f1, f2])
    assert len(tree) == 1
    assert tree[0]["children"][0]["id"] == "child"


@pytest.mark.asyncio
async def test_upload_file_error_paths(db_session, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path), raising=False)
    monkeypatch.setattr(settings, "ALLOWED_EXTENSIONS", {".txt"}, raising=False)
    monkeypatch.setattr(settings, "MAX_FILE_SIZE", 4, raising=False)

    with pytest.raises(HTTPException):
        await files_api.upload_file(
            file=UploadFile(filename="a.md", file=io.BytesIO(b"content")),
            parent_id=None,
            db=db_session,
        )

    with pytest.raises(HTTPException):
        await files_api.upload_file(
            file=UploadFile(filename="a.txt", file=io.BytesIO(b"12345")),
            parent_id=None,
            db=db_session,
        )

    db_session.add(
        File(id="f1", name="x.txt", file_type=FileType.TXT, path="/tmp/x.txt", size=1, page_count=1, meta={})
    )
    await db_session.commit()
    monkeypatch.setattr(settings, "MAX_FILE_SIZE", 20, raising=False)
    with pytest.raises(HTTPException):
        await files_api.upload_file(
            file=UploadFile(filename="a.txt", file=io.BytesIO(b"ok")),
            parent_id="f1",  # not a folder
            db=db_session,
        )


@pytest.mark.asyncio
async def test_import_web_url_and_move_cycle_errors(db_session, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    parent = File(
        id="folder-root",
        name="root",
        file_type=FileType.FOLDER,
        path=str(tmp_path / "root"),
        size=0,
        page_count=None,
        meta={},
    )
    child = File(
        id="folder-child",
        name="child",
        file_type=FileType.FOLDER,
        path=str(tmp_path / "child"),
        size=0,
        page_count=None,
        meta={},
        parent_id="folder-root",
    )
    db_session.add_all([parent, child])
    await db_session.commit()

    monkeypatch.setattr(
        files_api.reader_orchestrator,
        "import_web_url",
        AsyncMock(return_value={"file_id": "web-1"}),
    )
    imported = await files_api.import_web_url(
        WebImportRequest(url="https://example.com", parent_id="folder-root"),
        db=db_session,
    )
    assert imported.success is True

    monkeypatch.setattr(
        files_api.reader_orchestrator,
        "import_web_url",
        AsyncMock(side_effect=RuntimeError("fetch failed")),
    )
    with pytest.raises(HTTPException):
        await files_api.import_web_url(
            WebImportRequest(url="https://example.com", parent_id="folder-root"),
            db=db_session,
        )

    with pytest.raises(HTTPException):
        await files_api.move_file(
            "folder-root",
            MoveFileRequest(new_parent_id="folder-child"),
            db=db_session,
        )
