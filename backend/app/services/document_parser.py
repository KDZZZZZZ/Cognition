import os
import uuid
import asyncio
from typing import Optional, List
from pathlib import Path
from unstructured.partition.auto import partition
from unstructured.partition.pdf import partition_pdf
from unstructured.partition.docx import partition_docx
from unstructured.partition.md import partition_md
from unstructured.partition.text import partition_text
import pdfplumber
from docx import Document as DocxDocument

from app.config import settings
from app.models import File, DocumentChunk


class DocumentParser:
    """Parse various document formats and extract structured content."""

    def __init__(self):
        self.upload_dir = Path(settings.UPLOAD_DIR)
        self.upload_dir.mkdir(parents=True, exist_ok=True)

    async def parse_file(
        self,
        file_path: str,
        file_id: str,
        file_type: str
    ) -> tuple[List[DocumentChunk], dict]:
        """
        Parse a file and return chunks with metadata.

        Returns:
            (chunks, metadata) - List of DocumentChunk objects and file metadata
        """
        path = Path(file_path)

        if file_type == "pdf":
            return await self._parse_pdf(path, file_id)
        elif file_type in ["docx", "doc"]:
            return await self._parse_docx(path, file_id)
        elif file_type == "md":
            return await self._parse_markdown(path, file_id)
        elif file_type == "txt":
            return await self._parse_text(path, file_id)
        else:
            return [], {}

    async def _parse_pdf(self, path: Path, file_id: str) -> tuple[List[DocumentChunk], dict]:
        """Parse PDF file with page layout information."""
        chunks = []
        metadata = {"page_count": 0}

        # Use pdfplumber for accurate layout and coordinates
        with pdfplumber.open(path) as pdf:
            metadata["page_count"] = len(pdf.pages)

            for page_num, page in enumerate(pdf.pages):
                page_text = page.extract_text()
                if not page_text:
                    continue

                # Extract words with their positions
                words = page.extract_words(extra_attrs=["fontname", "size"])

                # Group into paragraphs based on vertical proximity
                paragraphs = self._group_words_to_paragraphs(words)

                for idx, para in enumerate(paragraphs):
                    chunk = DocumentChunk(
                        id=str(uuid.uuid4()),
                        file_id=file_id,
                        page=page_num + 1,
                        chunk_index=idx,
                        content=para["text"],
                        bbox=para.get("bbox")
                    )
                    chunks.append(chunk)

        return chunks, metadata

    async def _parse_docx(self, path: Path, file_id: str) -> tuple[List[DocumentChunk], dict]:
        """Parse DOCX file."""
        chunks = []
        doc = DocxDocument(path)

        for idx, para in enumerate(doc.paragraphs):
            if para.text.strip():
                chunk = DocumentChunk(
                    id=str(uuid.uuid4()),
                    file_id=file_id,
                    page=1,
                    chunk_index=idx,
                    content=para.text,
                    bbox=None
                )
                chunks.append(chunk)

        metadata = {
            "page_count": 1,
            "paragraph_count": len(doc.paragraphs)
        }

        return chunks, metadata

    async def _parse_markdown(self, path: Path, file_id: str) -> tuple[List[DocumentChunk], dict]:
        """Parse Markdown file."""
        content = path.read_text(encoding="utf-8")
        chunks = []

        # Split by headers to create chunks
        lines = content.split("\n")
        current_chunk = []
        chunk_idx = 0

        for line in lines:
            if line.startswith("#"):
                # Save previous chunk
                if current_chunk:
                    chunk = DocumentChunk(
                        id=str(uuid.uuid4()),
                        file_id=file_id,
                        page=1,
                        chunk_index=chunk_idx,
                        content="\n".join(current_chunk),
                        bbox=None
                    )
                    chunks.append(chunk)
                    chunk_idx += 1
                    current_chunk = [line]
                else:
                    current_chunk.append(line)
            else:
                current_chunk.append(line)

        # Don't forget the last chunk
        if current_chunk:
            chunk = DocumentChunk(
                id=str(uuid.uuid4()),
                file_id=file_id,
                page=1,
                chunk_index=chunk_idx,
                content="\n".join(current_chunk),
                bbox=None
            )
            chunks.append(chunk)

        metadata = {"page_count": 1, "chunk_count": len(chunks)}
        return chunks, metadata

    async def _parse_text(self, path: Path, file_id: str) -> tuple[List[DocumentChunk], dict]:
        """Parse plain text file."""
        content = path.read_text(encoding="utf-8")

        # Split into paragraphs
        paragraphs = content.split("\n\n")
        chunks = []

        for idx, para in enumerate(paragraphs):
            if para.strip():
                chunk = DocumentChunk(
                    id=str(uuid.uuid4()),
                    file_id=file_id,
                    page=1,
                    chunk_index=idx,
                    content=para.strip(),
                    bbox=None
                )
                chunks.append(chunk)

        metadata = {"page_count": 1, "chunk_count": len(chunks)}
        return chunks, metadata

    def _group_words_to_paragraphs(self, words: List[dict]) -> List[dict]:
        """Group words into paragraphs based on vertical proximity."""
        if not words:
            return []

        paragraphs = []
        current_para = []
        last_y = None
        y_tolerance = 5  # pixels

        for word in words:
            x0, top, x1, bottom = word.get("x0"), word.get("top"), word.get("x1"), word.get("bottom")

            if last_y is not None and abs(top - last_y) > y_tolerance:
                # New paragraph
                if current_para:
                    # Sort words by x position and join
                    sorted_words = sorted(current_para, key=lambda w: w["x0"])
                    text = " ".join(w["text"] for w in sorted_words)

                    # Calculate bounding box
                    all_x0 = [w["x0"] for w in current_para]
                    all_y0 = [w["top"] for w in current_para]
                    all_x1 = [w["x1"] for w in current_para]
                    all_y1 = [w["bottom"] for w in current_para]

                    paragraphs.append({
                        "text": text,
                        "bbox": (min(all_x0), min(all_y0), max(all_x1), max(all_y1))
                    })
                    current_para = []

            current_para.append(word)
            last_y = top

        # Handle remaining words
        if current_para:
            sorted_words = sorted(current_para, key=lambda w: w["x0"])
            text = " ".join(w["text"] for w in sorted_words)

            all_x0 = [w["x0"] for w in current_para]
            all_y0 = [w["top"] for w in current_para]
            all_x1 = [w["x1"] for w in current_para]
            all_y1 = [w["bottom"] for w in current_para]

            paragraphs.append({
                "text": text,
                "bbox": (min(all_x0), min(all_y0), max(all_x1), max(all_y1))
            })

        return paragraphs


parser = DocumentParser()
