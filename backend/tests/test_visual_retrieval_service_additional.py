from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
import sys
import types

import pytest

from app.config import settings
from app.models import DocumentChunk, DocumentPageAsset, File, FileType
from app.services.visual_retrieval_service import VisualRetrievalService, _lexical_score


def test_public_upload_url_and_data_url(tmp_path: Path):
    service = VisualRetrievalService()
    service.upload_root = tmp_path

    target = tmp_path / "file-id" / "page-0001.jpg"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"jpg-bytes")

    url = service._public_upload_url(target)
    assert url == "/uploads/file-id/page-0001.jpg"

    data_url = service._to_data_url(target)
    assert data_url is not None
    assert data_url.startswith("data:image/jpeg;base64,")

    assert service._to_data_url(tmp_path / "missing.jpg") is None


def test_extract_json_rejects_invalid_payload():
    service = VisualRetrievalService()
    assert service._extract_json("not-json") is None
    assert service._extract_json("") is None
    assert _lexical_score([], "anything") == 0.0


@pytest.mark.asyncio
async def test_vision_rerank_happy_path(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    service = VisualRetrievalService()
    image_path = tmp_path / "img.jpg"
    image_path.write_bytes(b"img")

    monkeypatch.setattr(service, "_to_data_url", lambda p: "data:image/jpeg;base64,abc")
    monkeypatch.setattr(
        "app.services.visual_retrieval_service.llm_service.supports_vision",
        lambda model: True,
    )
    monkeypatch.setattr(
        "app.services.visual_retrieval_service.llm_service.chat_completion",
        AsyncMock(
            return_value={
                "content": '{"ranked":[{"candidate_id":"c1","score":0.91,"reason":"diagram match"}]}'
            }
        ),
    )

    ranked = await service._vision_rerank(
        query="diagram",
        candidates=[{"image_path": str(image_path), "file_name": "A", "page": 2, "text_anchor": "diagram"}],
    )
    assert ranked["c1"]["score"] == pytest.approx(0.91)
    assert "diagram" in ranked["c1"]["reason"]


@pytest.mark.asyncio
async def test_ensure_page_assets_variants(
    db_session,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    service = VisualRetrievalService()
    service.upload_root = tmp_path

    monkeypatch.setattr(settings, "VISUAL_RETRIEVAL_ENABLED", False, raising=False)
    assert await service.ensure_page_assets(db=db_session, file_id="f-0") == []

    monkeypatch.setattr(settings, "VISUAL_RETRIEVAL_ENABLED", True, raising=False)
    existing = DocumentPageAsset(id="a-existing", file_id="f-existing", page=1, image_path=None, image_url="/uploads/x", text_anchor="a")
    db_session.add(existing)
    await db_session.commit()
    rows = await service.ensure_page_assets(db=db_session, file_id="f-existing")
    assert len(rows) == 1
    assert rows[0].id == "a-existing"

    db_session.add(
        File(
            id="f-nonpdf",
            name="note.md",
            file_type=FileType.MD,
            path=str(tmp_path / "note.md"),
            size=4,
            page_count=1,
            meta={},
        )
    )
    await db_session.commit()
    assert await service.ensure_page_assets(db=db_session, file_id="f-nonpdf") == []

    pdf_path = tmp_path / "doc.pdf"
    pdf_path.write_bytes(b"%PDF-mock")
    image_path = tmp_path / "_page_assets" / "f-pdf" / "page-0001.jpg"
    image_path.parent.mkdir(parents=True, exist_ok=True)
    image_path.write_bytes(b"img")

    db_session.add(
        File(
            id="f-pdf",
            name="doc.pdf",
            file_type=FileType.PDF,
            path=str(pdf_path),
            size=100,
            page_count=2,
            meta={},
        )
    )
    db_session.add(
        DocumentChunk(
            id="chunk-1",
            file_id="f-pdf",
            page=1,
            chunk_index=0,
            content="Page one anchor text",
            bbox=None,
        )
    )
    db_session.add(
        DocumentChunk(
            id="chunk-2",
            file_id="f-pdf",
            page=2,
            chunk_index=0,
            content="Page two anchor text",
            bbox=None,
        )
    )
    await db_session.commit()

    monkeypatch.setattr(
        service,
        "_render_pdf_images_sync",
        lambda **kwargs: {1: image_path},
    )

    built = await service.ensure_page_assets(db=db_session, file_id="f-pdf")
    assert len(built) == 2
    assert any(asset.page == 1 and asset.image_url for asset in built)
    assert any(asset.page == 2 and asset.text_anchor for asset in built)


@pytest.mark.asyncio
async def test_retrieve_visual_page_hits_merges_vision_signal(
    db_session,
    monkeypatch: pytest.MonkeyPatch,
):
    service = VisualRetrievalService()
    monkeypatch.setattr(settings, "VISUAL_RETRIEVAL_ENABLED", True, raising=False)
    monkeypatch.setattr(settings, "VISUAL_RETRIEVAL_TOP_K", 3, raising=False)

    db_session.add(
        DocumentPageAsset(
            id="asset-1",
            file_id="f1",
            page=3,
            image_path="/tmp/img-1.jpg",
            image_url="/uploads/img-1.jpg",
            text_anchor="revenue and margin growth",
        )
    )
    db_session.add(
        DocumentPageAsset(
            id="asset-2",
            file_id="f1",
            page=1,
            image_path="/tmp/img-2.jpg",
            image_url="/uploads/img-2.jpg",
            text_anchor="introduction",
        )
    )
    await db_session.commit()

    monkeypatch.setattr(service, "ensure_page_assets", AsyncMock(return_value=[]))
    monkeypatch.setattr(
        service,
        "_vision_rerank",
        AsyncMock(return_value={"c1": {"score": 0.95, "reason": "table match"}}),
    )

    hits = await service.retrieve_visual_page_hits(
        db=db_session,
        query="revenue margin",
        readable_files=["f1"],
        permitted_files_info={"f1": {"name": "Q1.pdf", "type": "pdf"}},
        active_file_id="f1",
        active_page=3,
    )

    assert hits
    assert hits[0]["file_id"] == "f1"
    assert hits[0]["source_mode"] in {"vision_rerank", "visual_lexical"}
    assert hits[0]["score"] >= hits[-1]["score"]


@pytest.mark.asyncio
async def test_retrieve_visual_page_hits_falls_back_when_vision_rerank_times_out(
    db_session,
    monkeypatch: pytest.MonkeyPatch,
):
    service = VisualRetrievalService()
    monkeypatch.setattr(settings, "VISUAL_RETRIEVAL_ENABLED", True, raising=False)
    monkeypatch.setattr(settings, "VISUAL_RERANK_TIMEOUT_SECONDS", 0.01, raising=False)
    monkeypatch.setattr(settings, "VISUAL_RERANK_TIMEOUT_RETRIES", 0, raising=False)

    db_session.add(
        DocumentPageAsset(
            id="asset-timeout-1",
            file_id="f1",
            page=2,
            image_path="/tmp/img-timeout-1.jpg",
            image_url="/uploads/img-timeout-1.jpg",
            text_anchor="diffusion model benchmark table",
        )
    )
    await db_session.commit()

    async def slow_rerank(**kwargs):
        await asyncio.sleep(0.2)
        return {"c1": {"score": 0.99, "reason": "too slow"}}

    monkeypatch.setattr(service, "ensure_page_assets", AsyncMock(return_value=[]))
    monkeypatch.setattr(service, "_vision_rerank", slow_rerank)

    hits = await service.retrieve_visual_page_hits(
        db=db_session,
        query="diffusion benchmark",
        readable_files=["f1"],
        permitted_files_info={"f1": {"name": "paper.pdf", "type": "pdf"}},
        active_file_id="f1",
        active_page=2,
    )

    assert hits
    assert hits[0]["source_mode"] == "visual_lexical"
    assert hits[0]["vision_score"] is None


@pytest.mark.asyncio
async def test_retrieve_visual_page_hits_retries_vision_rerank_once(
    db_session,
    monkeypatch: pytest.MonkeyPatch,
):
    service = VisualRetrievalService()
    monkeypatch.setattr(settings, "VISUAL_RETRIEVAL_ENABLED", True, raising=False)
    monkeypatch.setattr(settings, "VISUAL_RERANK_TIMEOUT_SECONDS", 0.01, raising=False)
    monkeypatch.setattr(settings, "VISUAL_RERANK_TIMEOUT_RETRIES", 1, raising=False)

    db_session.add(
        DocumentPageAsset(
            id="asset-retry-1",
            file_id="f1",
            page=2,
            image_path="/tmp/img-retry-1.jpg",
            image_url="/uploads/img-retry-1.jpg",
            text_anchor="diffusion model benchmark table",
        )
    )
    await db_session.commit()

    calls = {"count": 0}

    async def flaky_rerank(**kwargs):
        calls["count"] += 1
        if calls["count"] == 1:
            await asyncio.sleep(0.2)
        return {"c1": {"score": 0.88, "reason": "table match"}}

    monkeypatch.setattr(service, "ensure_page_assets", AsyncMock(return_value=[]))
    monkeypatch.setattr(service, "_vision_rerank", flaky_rerank)

    hits = await service.retrieve_visual_page_hits(
        db=db_session,
        query="diffusion benchmark",
        readable_files=["f1"],
        permitted_files_info={"f1": {"name": "paper.pdf", "type": "pdf"}},
        active_file_id="f1",
        active_page=2,
    )

    assert hits
    assert calls["count"] == 2
    assert hits[0]["source_mode"] == "vision_rerank"
    assert hits[0]["vision_score"] == pytest.approx(0.88)


@pytest.mark.asyncio
async def test_retrieve_visual_page_hits_short_circuit_when_disabled(db_session, monkeypatch: pytest.MonkeyPatch):
    service = VisualRetrievalService()
    monkeypatch.setattr(settings, "VISUAL_RETRIEVAL_ENABLED", False, raising=False)
    hits = await service.retrieve_visual_page_hits(
        db=db_session,
        query="any",
        readable_files=["f1"],
        permitted_files_info={"f1": {"name": "x", "type": "pdf"}},
        active_file_id=None,
        active_page=None,
    )
    assert hits == []


def test_public_upload_url_fallback_for_outside_path(tmp_path: Path):
    service = VisualRetrievalService()
    service.upload_root = tmp_path / "uploads"
    service.upload_root.mkdir(parents=True, exist_ok=True)

    outside = tmp_path / "outside.jpg"
    outside.write_bytes(b"x")
    url = service._public_upload_url(outside)
    assert url == "/uploads/outside.jpg"


def test_normalize_image_and_render_sync_fallbacks(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    service = VisualRetrievalService()

    # Real PIL image path to cover convert/resize branch.
    from PIL import Image

    raw = Image.new("RGBA", (2400, 1200), color=(255, 0, 0, 255))
    normalized = service._normalize_image(raw)
    assert normalized.mode == "RGB"
    assert max(normalized.size) <= 960

    monkeypatch.setattr(service, "_render_pdf_images_pdfium", lambda **kwargs: (_ for _ in ()).throw(RuntimeError("no pdfium")))
    monkeypatch.setattr(service, "_render_pdf_images_pdfplumber", lambda **kwargs: {1: tmp_path / "p1.jpg"})
    rendered = service._render_pdf_images_sync(
        pdf_path=tmp_path / "x.pdf",
        output_dir=tmp_path / "out",
        target_pages=[1],
    )
    assert 1 in rendered

    monkeypatch.setattr(service, "_render_pdf_images_pdfplumber", lambda **kwargs: (_ for _ in ()).throw(RuntimeError("no plumber")))
    rendered_none = service._render_pdf_images_sync(
        pdf_path=tmp_path / "x.pdf",
        output_dir=tmp_path / "out",
        target_pages=[1],
    )
    assert rendered_none == {}


def test_render_pdf_images_pdfium_and_pdfplumber_with_fake_modules(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    service = VisualRetrievalService()

    from PIL import Image

    class FakeBitmap:
        def to_pil(self):
            return Image.new("RGB", (200, 100), color="white")

        def close(self):
            return None

    class FakePage:
        def render(self, scale):
            assert scale >= 1.0
            return FakeBitmap()

        def close(self):
            return None

    class FakePdfDocument:
        def __init__(self, path):
            self._pages = [FakePage(), FakePage()]

        def __len__(self):
            return len(self._pages)

        def __getitem__(self, idx):
            return self._pages[idx]

        def close(self):
            return None

    fake_pdfium = types.SimpleNamespace(PdfDocument=FakePdfDocument)
    monkeypatch.setitem(sys.modules, "pypdfium2", fake_pdfium)

    rendered_pdfium = service._render_pdf_images_pdfium(
        pdf_path=tmp_path / "doc.pdf",
        output_dir=tmp_path / "pdfium-out",
        target_pages=[1],
    )
    assert 1 in rendered_pdfium
    assert rendered_pdfium[1].exists()

    class FakePageImage:
        def __init__(self):
            self.original = Image.new("RGB", (120, 120), color="blue")

    class FakePlumberPage:
        def to_image(self, resolution):
            assert resolution >= 72
            return FakePageImage()

    class FakePlumberPdf:
        def __init__(self):
            self.pages = [FakePlumberPage(), FakePlumberPage()]

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    fake_pdfplumber = types.SimpleNamespace(open=lambda _: FakePlumberPdf())
    monkeypatch.setitem(sys.modules, "pdfplumber", fake_pdfplumber)

    rendered_plumber = service._render_pdf_images_pdfplumber(
        pdf_path=tmp_path / "doc.pdf",
        output_dir=tmp_path / "plumber-out",
        target_pages=[1, 3],  # page 3 should be ignored
    )
    assert 1 in rendered_plumber
    assert 3 not in rendered_plumber
