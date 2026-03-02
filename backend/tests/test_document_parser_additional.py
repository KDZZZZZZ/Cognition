from pathlib import Path

import pytest

from app.services.document_parser import DocumentParser


@pytest.mark.asyncio
async def test_parse_markdown_text_and_unknown(tmp_path: Path):
    parser = DocumentParser()
    md_path = tmp_path / "note.md"
    md_path.write_text("# H1\nbody\n\n## H2\nnext", encoding="utf-8")

    chunks, meta = await parser.parse_file(str(md_path), "file-1", "md")
    assert len(chunks) >= 1
    assert meta["chunk_count"] >= 1

    txt_path = tmp_path / "a.txt"
    txt_path.write_text("p1\n\np2", encoding="utf-8")
    text_chunks, text_meta = await parser.parse_file(str(txt_path), "file-2", "txt")
    assert len(text_chunks) == 2
    assert text_meta["page_count"] == 1

    none_chunks, none_meta = await parser.parse_file(str(txt_path), "file-3", "bin")
    assert none_chunks == []
    assert none_meta == {}


@pytest.mark.asyncio
async def test_parse_web_html_with_and_without_bs4(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    parser = DocumentParser()
    html_path = tmp_path / "page.html"
    html_path.write_text("<h1>Title</h1><p>Hello world</p>", encoding="utf-8")

    chunks, meta = await parser.parse_file(str(html_path), "web-1", "web")
    assert len(chunks) >= 1
    assert meta["source_type"] == "web"

    original_import = __import__

    def fake_import(name, *args, **kwargs):
        if name == "bs4":
            raise ImportError("bs4 unavailable")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", fake_import)
    fallback_chunks, fallback_meta = await parser._parse_web_html(html_path, "web-2")
    assert len(fallback_chunks) >= 1
    assert fallback_meta["chunk_count"] >= 1


def test_group_words_to_paragraphs():
    parser = DocumentParser()
    words = [
        {"text": "Hello", "x0": 10, "x1": 20, "top": 10, "bottom": 15},
        {"text": "World", "x0": 25, "x1": 40, "top": 10, "bottom": 15},
        {"text": "Next", "x0": 10, "x1": 22, "top": 30, "bottom": 35},
    ]
    paras = parser._group_words_to_paragraphs(words)
    assert len(paras) == 2
    assert "Hello World" in paras[0]["text"]


def test_merge_pdf_paragraphs_reduces_tiny_chunks():
    parser = DocumentParser()
    paragraphs = [
        {"text": "A" * 450, "bbox": (0, 0, 10, 10)},
        {"text": "B" * 430, "bbox": (0, 11, 10, 20)},
        {"text": "C" * 420, "bbox": (0, 21, 10, 30)},
        {"text": "D" * 1700, "bbox": (0, 31, 10, 40)},
    ]

    merged = parser._merge_pdf_paragraphs(paragraphs)

    assert len(merged) == 2
    assert merged[0]["text"].count("\n") == 2
    assert len(merged[0]["text"]) > 1200
    assert len(merged[1]["text"]) == 1700
