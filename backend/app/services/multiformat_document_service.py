from __future__ import annotations

import asyncio
import json
import re
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import httpx
from sqlalchemy import and_, delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import (
    DocumentAsset,
    DocumentChunk,
    DocumentPageAsset,
    DocumentSegment,
    File as FileModel,
    FileIndexStatus,
    FileType,
    SegmentEmbedding,
)
from app.services.document_parser import parser
from app.services.embedding_windowing import build_page_window_texts
from app.services.llm_service import llm_service
from app.services.token_budget_service import estimate_tokens, short_text
from app.services.vector_store import vector_store
from app.services.visual_retrieval_service import visual_retrieval_service


@dataclass
class SourceArtifact:
    source_type: str
    file_path: Optional[str] = None
    text: Optional[str] = None
    html: Optional[str] = None
    url: Optional[str] = None
    title: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ParseSegmentData:
    page: Optional[int]
    section: Optional[str]
    chunk_index: int
    text: str
    bbox: Optional[tuple] = None
    segment_type: str = "paragraph"
    confidence: float = 1.0
    source: str = "local"
    meta: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ParseAssetData:
    page_or_section: Optional[str]
    asset_type: str
    path: Optional[str]
    url: Optional[str]
    meta: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ParseResult:
    segments: List[ParseSegmentData]
    assets: List[ParseAssetData]
    quality: float
    provider: str


@dataclass
class RetrievalHit:
    segment_id: str
    file_id: str
    page: Optional[int]
    section: Optional[str]
    source_type: str
    score: float
    source_mode: str
    reason: Optional[str]
    text: str
    segment_type: Optional[str] = None


def _file_type_to_str(value: object) -> str:
    return value.value if hasattr(value, "value") else str(value)


class DocumentSourceAdapter(ABC):
    @abstractmethod
    async def ingest(self, **kwargs) -> SourceArtifact:
        raise NotImplementedError


class DocumentParserProvider(ABC):
    @abstractmethod
    async def parse(self, artifact: SourceArtifact, **kwargs) -> ParseResult:
        raise NotImplementedError


class EmbeddingProvider(ABC):
    @abstractmethod
    def is_enabled(self) -> bool:
        raise NotImplementedError

    def supports_image_inputs(self) -> bool:
        return False

    def supports_fused_inputs(self) -> bool:
        return False

    @abstractmethod
    async def embed_text(self, texts: List[str]) -> List[List[float]]:
        raise NotImplementedError

    @abstractmethod
    async def embed_image(self, image_urls: List[str]) -> List[List[float]]:
        raise NotImplementedError

    @abstractmethod
    async def embed_fused(self, items: List[Dict[str, str]]) -> List[List[float]]:
        raise NotImplementedError


class RetrievalProvider(ABC):
    @abstractmethod
    async def search(self, **kwargs) -> List[RetrievalHit]:
        raise NotImplementedError


def _sanitize_filename(name: str) -> str:
    cleaned = re.sub(r"[^\w\-\.]+", "_", name.strip())
    return cleaned or "document"


def _tokenize(text: str) -> List[str]:
    return [token for token in re.split(r"\W+", (text or "").lower()) if token]


def _lexical_score(query_tokens: List[str], text: str) -> float:
    if not query_tokens:
        return 0.0
    content_tokens = _tokenize(text)
    if not content_tokens:
        return 0.0
    content_set = set(content_tokens)
    return float(sum(1 for token in query_tokens if token in content_set))


_FIGURE_CAPTION_RE = re.compile(
    r"^\s*(figure|fig\.?|table|chart|graph|diagram|plot|图|表)\s*[\.:：\-]?\s*(\d+[a-zA-Z\-]*)?",
    re.IGNORECASE,
)
_VISUAL_QUERY_TOKENS = {
    "figure",
    "fig",
    "table",
    "chart",
    "graph",
    "diagram",
    "plot",
    "image",
    "图",
    "表",
}


def _classify_pdf_chunk(text: str) -> tuple[str, Dict[str, Any]]:
    normalized = " ".join((text or "").split())
    lowered = normalized.lower()
    meta: Dict[str, Any] = {}

    match = _FIGURE_CAPTION_RE.match(normalized)
    if match:
        label = (match.group(1) or "").lower()
        number = (match.group(2) or "").strip() or None
        visual_kind = "table" if label in {"table", "表"} else "figure"
        meta["visual_kind"] = visual_kind
        meta["visual_anchor"] = True
        if number:
            meta["visual_label"] = number
        return (f"{visual_kind}_caption", meta)

    if "|" in normalized and len(normalized) <= 1200:
        meta["visual_kind"] = "table"
        return ("table", meta)

    if any(token in lowered for token in ("accuracy", "psnr", "fid", "ablation", "benchmark")) and any(
        token in lowered for token in ("table", "chart", "figure", "graph")
    ):
        meta["visual_anchor"] = True
        return ("figure_context", meta)

    return ("paragraph", meta)


def _looks_like_visual_query(query: str) -> bool:
    lowered_tokens = set(_tokenize(query))
    return bool(lowered_tokens & _VISUAL_QUERY_TOKENS)


def _chunk_to_parse_segment(chunk: DocumentChunk, *, source_type: str) -> ParseSegmentData:
    segment_type = "paragraph"
    meta: Dict[str, Any] = {}
    section = f"p.{chunk.page}"
    if source_type == "pdf":
        segment_type, meta = _classify_pdf_chunk(chunk.content)
        if segment_type in {"figure_caption", "table_caption"}:
            section = short_text(chunk.content, 120)

    return ParseSegmentData(
        page=chunk.page,
        section=section,
        chunk_index=chunk.chunk_index,
        text=chunk.content,
        bbox=chunk.bbox,
        segment_type=segment_type,
        confidence=0.9,
        source="local",
        meta=meta,
    )


def _extract_web_blocks_from_html(html: str, *, source_url: str) -> List[ParseSegmentData]:
    # Keep dependency optional for runtime flexibility.
    try:
        from bs4 import BeautifulSoup
    except Exception:
        # Minimal fallback when BeautifulSoup is unavailable.
        text = re.sub(r"<[^>]+>", " ", html or "")
        text = re.sub(r"\s+", " ", text).strip()
        if not text:
            return []
        return [
            ParseSegmentData(
                page=1,
                section="Web",
                chunk_index=0,
                text=short_text(text, 12000),
                segment_type="paragraph",
                confidence=0.55,
                source="local",
                meta={"source_url": source_url, "dom_path": "fallback"},
            )
        ]

    soup = BeautifulSoup(html or "", "html.parser")
    blocks: List[ParseSegmentData] = []
    current_section = "Intro"
    block_index = 0

    candidates = soup.select(
        "h1, h2, h3, h4, p, li, pre, code, blockquote, table, article, section"
    )

    for node in candidates:
        name = (node.name or "").lower()
        text = " ".join(node.get_text(" ", strip=True).split())
        if not text:
            continue
        if len(text) < 12 and name not in ("h1", "h2", "h3", "h4"):
            continue

        if name in ("h1", "h2", "h3", "h4"):
            current_section = short_text(text, 120)
            segment_type = "heading"
            confidence = 0.95
        elif name == "table":
            segment_type = "table"
            confidence = 0.8
        elif name in ("pre", "code"):
            segment_type = "code"
            confidence = 0.82
        elif name == "blockquote":
            segment_type = "quote"
            confidence = 0.78
        elif name == "li":
            segment_type = "list_item"
            confidence = 0.75
        else:
            segment_type = "paragraph"
            confidence = 0.88

        blocks.append(
            ParseSegmentData(
                page=1,
                section=current_section,
                chunk_index=block_index,
                text=text,
                segment_type=segment_type,
                confidence=confidence,
                source="local",
                meta={"source_url": source_url, "dom_path": name},
            )
        )
        block_index += 1

    return blocks


class FileUploadAdapter(DocumentSourceAdapter):
    async def ingest(self, **kwargs) -> SourceArtifact:
        return SourceArtifact(
            source_type=str(kwargs.get("source_type") or "txt"),
            file_path=kwargs.get("file_path"),
            title=kwargs.get("title"),
            metadata=kwargs.get("metadata") or {},
        )


class WebUrlAdapter(DocumentSourceAdapter):
    async def ingest(self, **kwargs) -> SourceArtifact:
        url = str(kwargs.get("url") or "").strip()
        if not url:
            raise ValueError("url is required")

        headers = {"User-Agent": settings.WEB_FETCH_USER_AGENT}
        timeout = max(5, int(settings.WEB_FETCH_TIMEOUT_SECONDS))
        async with httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=True,
            trust_env=settings.LLM_TRUST_ENV_PROXY,
        ) as client:
            response = await client.get(url, headers=headers)
            response.raise_for_status()
            html = response.text

        title = kwargs.get("title")
        if not title:
            parsed = urlparse(url)
            title = parsed.netloc or "webpage"

        return SourceArtifact(
            source_type="web",
            html=html,
            url=url,
            title=title,
            metadata={
                "source_url": url,
                "fetch_options": kwargs.get("fetch_options") or {},
                "tags": kwargs.get("tags") or [],
            },
        )


class LocalParserProvider(DocumentParserProvider):
    async def parse(self, artifact: SourceArtifact, **kwargs) -> ParseResult:
        source_type = artifact.source_type
        segments: List[ParseSegmentData] = []

        if source_type == "web":
            segments = _extract_web_blocks_from_html(artifact.html or "", source_url=artifact.url or "")
            quality = 0.85 if segments else 0.2
            return ParseResult(segments=segments, assets=[], quality=quality, provider="local_web")

        if not artifact.file_path:
            return ParseResult(segments=[], assets=[], quality=0.0, provider="local")

        file_id = str(kwargs.get("file_id") or "")
        chunks, _ = await parser.parse_file(artifact.file_path, file_id, source_type)
        for chunk in chunks:
            segments.append(_chunk_to_parse_segment(chunk, source_type=source_type))

        quality = 0.8 if segments else 0.2
        return ParseResult(segments=segments, assets=[], quality=quality, provider="local")


class QwenDocParserFallback(DocumentParserProvider):
    async def parse(self, artifact: SourceArtifact, **kwargs) -> ParseResult:
        if not settings.QWEN_DOC_FALLBACK_ENABLED:
            return ParseResult(segments=[], assets=[], quality=0.0, provider="disabled_fallback")

        elements: List[Any] = []
        try:
            if artifact.source_type == "web":
                from unstructured.partition.html import partition_html

                elements = partition_html(text=artifact.html or "")
            elif artifact.source_type == "pdf":
                from unstructured.partition.pdf import partition_pdf

                elements = partition_pdf(
                    filename=artifact.file_path,
                    strategy="hi_res",
                    infer_table_structure=True,
                )
            else:
                from unstructured.partition.auto import partition

                elements = partition(filename=artifact.file_path)
        except Exception as exc:
            return ParseResult(
                segments=[],
                assets=[],
                quality=0.0,
                provider=f"unstructured_error:{short_text(str(exc), 120)}",
            )

        segments: List[ParseSegmentData] = []
        for idx, element in enumerate(elements):
            raw_text = getattr(element, "text", None)
            text = " ".join((raw_text if isinstance(raw_text, str) else str(element)).split())
            if not text:
                continue

            metadata = getattr(element, "metadata", None)
            page = getattr(metadata, "page_number", None) if metadata is not None else None
            try:
                page = int(page) if page is not None else None
            except Exception:
                page = None

            category = str(getattr(element, "category", "") or "paragraph").lower()
            if "title" in category or "header" in category:
                segment_type = "heading"
                confidence = 0.84
            elif "table" in category:
                segment_type = "table"
                confidence = 0.8
            elif "list" in category:
                segment_type = "list_item"
                confidence = 0.76
            elif "code" in category:
                segment_type = "code"
                confidence = 0.78
            else:
                segment_type = "paragraph"
                confidence = 0.74

            dom_path = getattr(metadata, "xpath", None) if metadata is not None else None
            section = short_text(text, 120) if segment_type == "heading" else (f"p.{page}" if page else "Fallback")
            segments.append(
                ParseSegmentData(
                    page=page,
                    section=section,
                    chunk_index=idx,
                    text=text,
                    segment_type=segment_type,
                    confidence=confidence,
                    source="fallback",
                    meta={"dom_path": dom_path} if dom_path else {},
                )
            )

        quality = 0.78 if segments else 0.1
        return ParseResult(segments=segments, assets=[], quality=quality, provider="unstructured_fallback")


class Qwen3VLEmbeddingProvider(EmbeddingProvider):
    MAX_CONTENTS_PER_REQUEST = 20
    MAX_IMAGES_PER_REQUEST = 5

    def __init__(self):
        self.api_key = settings.SILICONFLOW_API_KEY or settings.OPENAI_API_KEY or settings.MOONSHOT_API_KEY
        self.base_url = (
            settings.SILICONFLOW_BASE_URL
            if settings.SILICONFLOW_API_KEY
            else (settings.OPENAI_BASE_URL or settings.MOONSHOT_BASE_URL or "")
        ).rstrip("/")
        self.model = settings.EMBEDDING_MODEL
        self.dimension = int(settings.EMBEDDING_DIMENSIONS or 0)
        self.batch_size = max(1, min(int(settings.QWEN_VL_EMBEDDING_BATCH or 20), self.MAX_CONTENTS_PER_REQUEST))
        self.provider_name = "siliconflow-qwen3-embedding-8b"
        self._ocr_cache: Dict[str, str] = {}

    def is_enabled(self) -> bool:
        return bool(self.api_key and self.model)

    def supports_image_inputs(self) -> bool:
        return False

    def supports_fused_inputs(self) -> bool:
        return False

    def _image_count_for_content(self, item: Dict[str, str]) -> int:
        if str(item.get("image") or "").strip():
            return 1
        return 0

    def _split_contents_for_requests(self, contents: List[Dict[str, str]]) -> List[List[Dict[str, str]]]:
        if not contents:
            return []

        max_contents = max(1, min(self.batch_size, self.MAX_CONTENTS_PER_REQUEST))
        batches: List[List[Dict[str, str]]] = []
        current: List[Dict[str, str]] = []
        current_images = 0

        for item in contents:
            item_images = self._image_count_for_content(item)
            would_exceed_contents = len(current) >= max_contents
            would_exceed_images = current and (current_images + item_images > self.MAX_IMAGES_PER_REQUEST)
            if would_exceed_contents or would_exceed_images:
                batches.append(current)
                current = []
                current_images = 0

            current.append(item)
            current_images += item_images

        if current:
            batches.append(current)
        return batches

    async def _content_to_text(self, item: Dict[str, str]) -> str:
        text = str(item.get("text") or "").strip()
        image_url = str(item.get("image") or item.get("image_url") or "").strip()
        if not image_url:
            return text

        cached = self._ocr_cache.get(image_url)
        if cached is None:
            cached = await llm_service.ocr_image(
                image_url,
                prompt=(
                    "Extract all visible text from this image. "
                    "Return plain text only. Keep labels, formulas, and table cells when visible."
                ),
            )
            self._ocr_cache[image_url] = cached

        combined = "\n\n".join(part for part in [text, cached] if part).strip()
        return combined or text

    async def _request_embeddings(self, contents: List[Dict[str, str]]) -> List[List[float]]:
        if not contents:
            return []
        if not self.is_enabled():
            raise ValueError("SiliconFlow embedding key/model not configured")

        normalized_inputs = [await self._content_to_text(item) for item in contents]
        payload: Dict[str, Any] = {
            "model": self.model,
            "input": normalized_inputs,
        }
        if self.dimension > 0:
            payload["dimensions"] = self.dimension
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        last_error: Optional[Exception] = None
        for attempt in range(3):
            try:
                async with httpx.AsyncClient(
                    timeout=max(30.0, float(settings.QWEN_VL_EMBEDDING_TIMEOUT_SECONDS or 120.0)),
                    trust_env=settings.LLM_TRUST_ENV_PROXY,
                ) as client:
                    resp = await client.post(f"{self.base_url}/embeddings", headers=headers, json=payload)
                    resp.raise_for_status()
                    body = resp.json()
                break
            except Exception as exc:
                last_error = exc
                if attempt >= 2:
                    raise
                await asyncio.sleep(min(0.25 * (2 ** attempt), 1.0))
        else:
            raise ValueError(f"SiliconFlow embedding request failed: {last_error}")

        embeddings = (body or {}).get("data") or ((body or {}).get("output") or {}).get("embeddings") or []
        vectors: List[List[float]] = []
        for item in embeddings:
            vector = item.get("embedding")
            if isinstance(vector, list) and vector:
                vectors.append(vector)
        if len(vectors) != len(contents):
            raise ValueError(
                f"SiliconFlow embeddings returned {len(vectors)} vectors for {len(contents)} inputs"
            )
        return vectors

    async def _embed_in_batches(self, contents: List[Dict[str, str]]) -> List[List[float]]:
        outputs: List[List[float]] = []
        for batch in self._split_contents_for_requests(contents):
            vectors = await self._request_embeddings(batch)
            outputs.extend(vectors)
        return outputs

    async def embed_text(self, texts: List[str]) -> List[List[float]]:
        contents = [{"text": text} for text in texts]
        return await self._embed_in_batches(contents)

    async def embed_image(self, image_urls: List[str]) -> List[List[float]]:
        contents = [{"image": image_url} for image_url in image_urls]
        return await self._embed_in_batches(contents)

    async def embed_fused(self, items: List[Dict[str, str]]) -> List[List[float]]:
        contents: List[Dict[str, str]] = []
        for item in items:
            entry: Dict[str, str] = {}
            text = str(item.get("text") or "").strip()
            image_url = str(item.get("image") or item.get("image_url") or "").strip()
            if text:
                entry["text"] = text
            if image_url:
                entry["image"] = image_url
            if not entry:
                entry["text"] = ""
            contents.append(entry)
        return await self._embed_in_batches(contents)


class TextRetrievalProvider(RetrievalProvider):
    async def search(self, **kwargs) -> List[RetrievalHit]:
        query_embedding = kwargs.get("query_embedding")
        if not query_embedding:
            return []

        file_ids = kwargs.get("file_ids") or None
        source_types = kwargs.get("source_types") or None
        top_k = int(kwargs.get("top_k") or 8)
        modalities = kwargs.get("modalities") or ["text"]

        results = await vector_store.search_segment_embeddings(
            query_embedding=query_embedding,
            n_results=max(top_k * 4, 24),
            file_ids=file_ids,
            modalities=modalities,
            source_types=source_types,
        )

        docs = (results or {}).get("documents", [[]])[0]
        metadatas = (results or {}).get("metadatas", [[]])[0]
        distances = (results or {}).get("distances", [[]])[0]
        hits: List[RetrievalHit] = []
        for i, doc in enumerate(docs):
            metadata = metadatas[i] if i < len(metadatas) else {}
            dist = distances[i] if i < len(distances) else 1.0
            seg_id = str(metadata.get("segment_id") or "")
            if not seg_id:
                continue
            score = 1.0 / (1.0 + float(dist))
            hits.append(
                RetrievalHit(
                    segment_id=seg_id,
                    file_id=str(metadata.get("file_id") or ""),
                    page=metadata.get("page"),
                    section=metadata.get("section"),
                    source_type=str(metadata.get("source_type") or ""),
                    score=score,
                    source_mode=f"segment_{metadata.get('modality') or 'text'}",
                    reason=None,
                    text=str(doc or ""),
                    segment_type=str(metadata.get("segment_type") or "") or None,
                )
            )
        return hits[: max(top_k * 3, top_k)]


class FusionRetriever(RetrievalProvider):
    def __init__(
        self,
        *,
        text_retrieval: TextRetrievalProvider,
        visual_retrieval_enabled: bool = True,
    ):
        self.text_retrieval = text_retrieval
        self.visual_retrieval_enabled = visual_retrieval_enabled

    async def search(self, **kwargs) -> List[RetrievalHit]:
        query = str(kwargs.get("query") or "")
        query_embedding = kwargs.get("query_embedding")
        file_ids = kwargs.get("file_ids") or []
        top_k = int(kwargs.get("top_k") or 8)
        active_file_id = kwargs.get("active_file_id")
        active_page = kwargs.get("active_page")

        text_hits = await self.text_retrieval.search(
            query_embedding=query_embedding,
            file_ids=file_ids,
            top_k=top_k,
            source_types=kwargs.get("source_types"),
        )

        # Optional visual hint from existing page-level retriever.
        visual_hints: Dict[tuple[str, Optional[int]], Dict[str, Any]] = {}
        if self.visual_retrieval_enabled and query and file_ids:
            permitted = {fid: {"name": "", "type": "pdf"} for fid in file_ids}
            raw_hints = await visual_retrieval_service.retrieve_visual_page_hits(
                db=kwargs["db"],
                query=query,
                readable_files=file_ids,
                permitted_files_info=permitted,
                active_file_id=active_file_id,
                active_page=active_page,
            )
            for hint in raw_hints:
                key = (str(hint.get("file_id") or ""), hint.get("page"))
                visual_hints[key] = hint

        rrf_k = 60.0
        fused_by_segment: Dict[str, RetrievalHit] = {}
        for rank, hit in enumerate(text_hits, start=1):
            base = fused_by_segment.get(hit.segment_id)
            score = 1.0 / (rrf_k + rank)
            if base is None:
                fused_by_segment[hit.segment_id] = RetrievalHit(
                    segment_id=hit.segment_id,
                    file_id=hit.file_id,
                    page=hit.page,
                    section=hit.section,
                    source_type=hit.source_type,
                    score=score + hit.score,
                    source_mode=hit.source_mode,
                    reason=None,
                    text=hit.text,
                    segment_type=hit.segment_type,
                )
            else:
                base.score += score + hit.score

        for seg_id, hit in fused_by_segment.items():
            if active_file_id and hit.file_id == active_file_id:
                hit.score += 0.2
            if active_file_id and active_page is not None and hit.file_id == active_file_id and hit.page == active_page:
                hit.score += 0.6
            key = (hit.file_id, hit.page)
            visual = visual_hints.get(key)
            if visual:
                hit.score += 0.8
                hit.reason = str(visual.get("vision_reason") or "visual_hint")
                hit.source_mode = "fusion"
            if hit.segment_type in {"figure_caption", "table_caption", "figure_context"}:
                hit.score += 0.3
                if _looks_like_visual_query(query):
                    hit.score += 0.9

        fused_hits = sorted(fused_by_segment.values(), key=lambda item: item.score, reverse=True)
        return fused_hits[:top_k]


class ReaderOrchestrator:
    def __init__(self):
        self.file_adapter = FileUploadAdapter()
        self.web_adapter = WebUrlAdapter()
        self.local_parser = LocalParserProvider()
        self.fallback_parser = QwenDocParserFallback()
        self.embedding_provider = Qwen3VLEmbeddingProvider()
        self.text_retriever = TextRetrievalProvider()
        self.fusion_retriever = FusionRetriever(
            text_retrieval=self.text_retriever,
            visual_retrieval_enabled=settings.VISUAL_RETRIEVAL_ENABLED,
        )

    async def _ensure_index_status(self, db: AsyncSession, file_id: str) -> FileIndexStatus:
        result = await db.execute(select(FileIndexStatus).where(FileIndexStatus.file_id == file_id))
        row = result.scalar_one_or_none()
        if row:
            return row
        row = FileIndexStatus(file_id=file_id, parse_status="pending", embedding_status="pending")
        db.add(row)
        await db.flush()
        return row

    async def _replace_segments(
        self,
        *,
        db: AsyncSession,
        file_id: str,
        source_type: str,
        segments: List[ParseSegmentData],
    ) -> List[DocumentSegment]:
        old_ids_result = await db.execute(select(DocumentSegment.id).where(DocumentSegment.file_id == file_id))
        old_ids = [row[0] for row in old_ids_result.all()]
        if old_ids:
            await db.execute(delete(SegmentEmbedding).where(SegmentEmbedding.segment_id.in_(old_ids)))
        await db.execute(delete(DocumentSegment).where(DocumentSegment.file_id == file_id))
        await db.execute(delete(DocumentAsset).where(DocumentAsset.file_id == file_id))
        await vector_store.delete_segment_embeddings_by_file(file_id)

        rows: List[DocumentSegment] = []
        for seg in segments:
            row = DocumentSegment(
                id=str(uuid.uuid4()),
                file_id=file_id,
                source_type=source_type,
                page=seg.page,
                section=seg.section,
                chunk_index=seg.chunk_index,
                bbox=seg.bbox,
                text=seg.text,
                segment_type=seg.segment_type,
                confidence=seg.confidence,
                source=seg.source,
                meta=seg.meta or {},
            )
            db.add(row)
            rows.append(row)
        await db.flush()
        return rows

    async def _sync_pdf_assets(
        self,
        *,
        db: AsyncSession,
        file_id: str,
        file_path: str,
        page_count_hint: Optional[int],
        chunks: Optional[List[DocumentChunk]],
    ) -> Dict[int, str]:
        assets_map: Dict[int, str] = {}
        await db.execute(
            delete(DocumentAsset).where(
                and_(DocumentAsset.file_id == file_id, DocumentAsset.asset_type == "image")
            )
        )
        visual_assets = await visual_retrieval_service.ensure_page_assets(
            db=db,
            file_id=file_id,
            page_count_hint=page_count_hint,
            file_path_hint=file_path,
            chunks_hint=chunks,
        )

        for page_asset in visual_assets:
            image_payload = None
            if page_asset.image_path:
                image_payload = visual_retrieval_service._to_data_url(Path(page_asset.image_path))
            if not image_payload and page_asset.image_url:
                image_payload = page_asset.image_url
            if image_payload:
                assets_map[int(page_asset.page)] = image_payload
            db.add(
                DocumentAsset(
                    id=str(uuid.uuid4()),
                    file_id=file_id,
                    page_or_section=f"p.{page_asset.page}",
                    asset_type="image",
                    path=page_asset.image_path,
                    url=page_asset.image_url,
                    meta={"source": "document_page_asset"},
                )
            )
        await db.flush()
        return assets_map

    async def _embed_items_resilient(
        self,
        *,
        items: List[Any],
        embed_fn: Any,
    ) -> tuple[List[Optional[List[float]]], Dict[int, str]]:
        vectors: List[Optional[List[float]]] = [None] * len(items)
        errors: Dict[int, str] = {}
        if not items:
            return vectors, errors

        try:
            batch_vectors = await embed_fn(items)
            if len(batch_vectors) != len(items):
                raise ValueError(f"mismatch vectors={len(batch_vectors)} items={len(items)}")
            return batch_vectors, errors
        except Exception:
            pass

        for idx, item in enumerate(items):
            last_error: Optional[Exception] = None
            for attempt in range(3):
                try:
                    result = await embed_fn([item])
                    if result and isinstance(result[0], list):
                        vectors[idx] = result[0]
                        last_error = None
                        break
                    raise ValueError("empty embedding result")
                except Exception as exc:
                    last_error = exc
                    if attempt < 2:
                        await asyncio.sleep(min(0.2 * (2 ** attempt), 0.8))
            if last_error is not None:
                errors[idx] = short_text(str(last_error), 180)

        return vectors, errors

    def _mark_segment_embedding_error(
        self,
        *,
        segment: DocumentSegment,
        modality: str,
        message: str,
    ) -> None:
        meta = dict(segment.meta or {})
        embedding_errors = dict(meta.get("embedding_errors") or {})
        embedding_errors[modality] = short_text(message, 180)
        meta["embedding_errors"] = embedding_errors
        segment.meta = meta

    def _build_segment_text_inputs(
        self,
        *,
        source_type: str,
        segments: List[DocumentSegment],
    ) -> tuple[List[str], List[tuple[int, int]]]:
        if source_type != "pdf":
            return [segment.text for segment in segments], [(int(segment.page or 1), int(segment.page or 1)) for segment in segments]

        window_texts, segment_keys = build_page_window_texts(
            segments,
            page_getter=lambda segment: segment.page,
            text_getter=lambda segment: segment.text,
            window_size=max(1, int(settings.EMBEDDING_PDF_PAGE_WINDOW or 5)),
            max_chars=max(2400, int(settings.OCR_MAX_OUTPUT_CHARS or 24000)),
        )
        return [window_texts.get(key) or segment.text for segment, key in zip(segments, segment_keys)], segment_keys

    async def _index_segment_embeddings(
        self,
        *,
        db: AsyncSession,
        file_id: str,
        source_type: str,
        segments: List[DocumentSegment],
        page_image_map: Optional[Dict[int, str]] = None,
    ) -> Dict[str, int]:
        if not segments:
            return {"text": 0, "fused": 0, "image": 0, "error_count": 0}
        if not self.embedding_provider.is_enabled() or not vector_store.enabled:
            return {"text": 0, "fused": 0, "image": 0, "error_count": 0}

        for segment in segments:
            meta = dict(segment.meta or {})
            if "embedding_errors" in meta:
                meta.pop("embedding_errors", None)
                segment.meta = meta

        texts, text_window_keys = self._build_segment_text_inputs(
            source_type=source_type,
            segments=segments,
        )
        text_vectors, text_errors = await self._embed_items_resilient(
            items=texts,
            embed_fn=self.embedding_provider.embed_text,
        )

        supports_fused = bool(getattr(self.embedding_provider, "supports_fused_inputs", lambda: True)())
        supports_image = bool(getattr(self.embedding_provider, "supports_image_inputs", lambda: True)())

        fused_vectors: List[Optional[List[float]]] = []
        fused_errors: Dict[int, str] = {}
        image_vectors: List[Optional[List[float]]] = []
        image_errors: Dict[int, str] = {}
        unique_image_inputs: List[str] = []
        image_input_index_by_page: Dict[int, int] = {}
        image_page_by_segment_index: Dict[int, int] = {}

        if supports_fused or supports_image:
            fused_inputs: List[Dict[str, str]] = []
            for index, segment in enumerate(segments):
                image_url = None
                if page_image_map and segment.page is not None:
                    image_url = page_image_map.get(int(segment.page))

                fused_item: Dict[str, str] = {"text": texts[index] if index < len(texts) else segment.text}
                if image_url:
                    fused_item["image"] = image_url
                    page_no = int(segment.page)
                    image_page_by_segment_index[index] = page_no
                    if page_no not in image_input_index_by_page:
                        image_input_index_by_page[page_no] = len(unique_image_inputs)
                        unique_image_inputs.append(image_url)
                fused_inputs.append(fused_item)

            if supports_fused:
                fused_vectors, fused_errors = await self._embed_items_resilient(
                    items=fused_inputs,
                    embed_fn=self.embedding_provider.embed_fused,
                )
            if supports_image and unique_image_inputs:
                image_vectors, image_errors = await self._embed_items_resilient(
                    items=unique_image_inputs,
                    embed_fn=self.embedding_provider.embed_image,
                )

        ids: List[str] = []
        embeddings: List[List[float]] = []
        documents: List[str] = []
        metadatas: List[Dict[str, Any]] = []

        text_count = 0
        fused_count = 0
        image_count = 0

        def add_item(
            *,
            segment: DocumentSegment,
            segment_index: int,
            modality: str,
            vector: List[float],
            vector_ref: str,
        ):
            db.add(
                SegmentEmbedding(
                    id=vector_ref,
                    segment_id=segment.id,
                    modality=modality,
                    dim=len(vector),
                    provider=self.embedding_provider.provider_name,
                    vector_ref=vector_ref,
                )
            )
            ids.append(vector_ref)
            embeddings.append(vector)
            documents.append(
                short_text(
                    segment.text,
                    max(600, int(settings.SEGMENT_VECTOR_DOCUMENT_MAX_CHARS or 2400)),
                )
            )
            metadatas.append(
                {
                    "segment_id": segment.id,
                    "file_id": segment.file_id,
                    "page": segment.page,
                    "section": segment.section,
                    "source_type": source_type,
                    "modality": modality,
                    "segment_type": segment.segment_type,
                    "visual_kind": (segment.meta or {}).get("visual_kind"),
                    "page_window_start": text_window_keys[segment_index][0] if segment_index < len(text_window_keys) else segment.page,
                    "page_window_end": text_window_keys[segment_index][1] if segment_index < len(text_window_keys) else segment.page,
                }
            )

        for idx, segment in enumerate(segments):
            vector = text_vectors[idx] if idx < len(text_vectors) else None
            if not vector:
                continue
            ref = str(uuid.uuid4())
            add_item(segment=segment, segment_index=idx, modality="text", vector=vector, vector_ref=ref)
            text_count += 1

        if supports_fused:
            for idx, segment in enumerate(segments):
                vector = fused_vectors[idx] if idx < len(fused_vectors) else None
                if not vector:
                    continue
                ref = str(uuid.uuid4())
                add_item(segment=segment, segment_index=idx, modality="fused", vector=vector, vector_ref=ref)
                fused_count += 1

        if supports_image:
            for seg_idx, segment in enumerate(segments):
                page_no = image_page_by_segment_index.get(seg_idx)
                if page_no is None:
                    continue
                image_idx = image_input_index_by_page.get(page_no)
                vector = image_vectors[image_idx] if image_idx is not None and image_idx < len(image_vectors) else None
                if not vector:
                    continue
                ref = str(uuid.uuid4())
                add_item(segment=segment, segment_index=seg_idx, modality="image", vector=vector, vector_ref=ref)
                image_count += 1

        error_messages: List[str] = []
        for idx, error_msg in text_errors.items():
            if idx < len(segments):
                self._mark_segment_embedding_error(
                    segment=segments[idx],
                    modality="text",
                    message=error_msg,
                )
                error_messages.append(f"text:{segments[idx].id}")

        if supports_fused:
            for idx, error_msg in fused_errors.items():
                if idx < len(segments):
                    self._mark_segment_embedding_error(
                        segment=segments[idx],
                        modality="fused",
                        message=error_msg,
                    )
                    error_messages.append(f"fused:{segments[idx].id}")

        if supports_image:
            for seg_idx, segment in enumerate(segments):
                page_no = image_page_by_segment_index.get(seg_idx)
                if page_no is None:
                    continue
                image_idx = image_input_index_by_page.get(page_no)
                error_msg = image_errors.get(image_idx) if image_idx is not None else None
                if error_msg:
                    self._mark_segment_embedding_error(
                        segment=segment,
                        modality="image",
                        message=error_msg,
                    )
                    error_messages.append(f"image:{segment.id}")

        await db.flush()
        if ids:
            await vector_store.add_segment_embeddings(
                ids=ids,
                embeddings=embeddings,
                documents=documents,
                metadatas=metadatas,
            )
        return {
            "text": text_count,
            "fused": fused_count,
            "image": image_count,
            "error_count": len(error_messages),
        }

    async def build_segments_for_file(
        self,
        *,
        db: AsyncSession,
        file: FileModel,
        chunks_hint: Optional[List[DocumentChunk]] = None,
        mode: str = "all",
    ) -> Dict[str, Any]:
        status = await self._ensure_index_status(db, file.id)
        source_type = _file_type_to_str(file.file_type).lower()

        if mode in ("all", "parse_only"):
            artifact = await self.file_adapter.ingest(
                source_type=source_type,
                file_path=file.path,
                title=file.name,
                metadata=file.meta or {},
            )
            if source_type == "web" and artifact.file_path and not artifact.html:
                try:
                    artifact.html = Path(artifact.file_path).read_text(encoding="utf-8", errors="ignore")
                except Exception:
                    artifact.html = ""
                artifact.url = str((file.meta or {}).get("source_url") or "")

            local_result = await self.local_parser.parse(artifact, file_id=file.id)
            parse_result = local_result
            if local_result.quality < settings.MM_PARSE_SCORE_THRESHOLD:
                fallback_result = await self.fallback_parser.parse(artifact, file_id=file.id)
                if fallback_result.quality > parse_result.quality:
                    parse_result = fallback_result

            if source_type in {"pdf", "md", "txt", "docx"} and chunks_hint:
                # Reuse parsed chunks from upload/reindex callers to avoid reparsing and
                # keep chunk alignment stable across retrieval + pending diff flows
                # without dropping figure/table classification metadata.
                parse_result = ParseResult(
                    segments=[_chunk_to_parse_segment(chunk, source_type=source_type) for chunk in chunks_hint],
                    assets=parse_result.assets,
                    quality=parse_result.quality,
                    provider=parse_result.provider,
                )

            segment_rows = await self._replace_segments(
                db=db,
                file_id=file.id,
                source_type=source_type,
                segments=parse_result.segments,
            )
            status.parse_status = "ready"
            status.last_error = None
        else:
            seg_result = await db.execute(
                select(DocumentSegment)
                .where(DocumentSegment.file_id == file.id)
                .order_by(DocumentSegment.page, DocumentSegment.chunk_index)
            )
            segment_rows = seg_result.scalars().all()

        page_image_map: Dict[int, str] = {}
        if source_type == "pdf":
            try:
                page_image_map = await self._sync_pdf_assets(
                    db=db,
                    file_id=file.id,
                    file_path=file.path,
                    page_count_hint=file.page_count,
                    chunks=chunks_hint,
                )
            except Exception as exc:
                status.last_error = short_text(str(exc), 500)

        modality_counts = {"text": 0, "fused": 0, "image": 0}
        if mode in ("all", "embed_only"):
            if not self.embedding_provider.is_enabled() or not vector_store.enabled:
                status.embedding_status = "disabled"
            else:
                try:
                    existing_seg_ids_result = await db.execute(
                        select(DocumentSegment.id).where(DocumentSegment.file_id == file.id)
                    )
                    existing_seg_ids = [row[0] for row in existing_seg_ids_result.all()]
                    if existing_seg_ids:
                        await db.execute(
                            delete(SegmentEmbedding).where(SegmentEmbedding.segment_id.in_(existing_seg_ids))
                        )
                    await vector_store.delete_segment_embeddings_by_file(file.id)

                    modality_counts = await self._index_segment_embeddings(
                        db=db,
                        file_id=file.id,
                        source_type=source_type,
                        segments=segment_rows,
                        page_image_map=page_image_map,
                    )
                    error_count = int(modality_counts.get("error_count") or 0)
                    status.embedding_status = "ready_with_errors" if error_count > 0 else "ready"
                    if error_count > 0:
                        embedding_error = f"Embedding completed with {error_count} segment-level failures"
                        if status.last_error and embedding_error not in status.last_error:
                            status.last_error = short_text(f"{status.last_error}; {embedding_error}", 500)
                        else:
                            status.last_error = embedding_error
                except Exception as exc:
                    status.embedding_status = "failed"
                    status.last_error = short_text(str(exc), 500)
        status.updated_at = datetime.utcnow()
        await db.flush()

        return {
            "segment_count": len(segment_rows),
            "modality_counts": modality_counts,
            "parse_status": status.parse_status,
            "embedding_status": status.embedding_status,
            "last_error": status.last_error,
        }

    async def import_web_url(
        self,
        *,
        db: AsyncSession,
        url: str,
        title: Optional[str],
        tags: Optional[List[str]],
        fetch_options: Optional[Dict[str, Any]],
        parent_id: Optional[str],
    ) -> Dict[str, Any]:
        artifact = await self.web_adapter.ingest(
            url=url,
            title=title,
            tags=tags or [],
            fetch_options=fetch_options or {},
        )

        file_id = str(uuid.uuid4())
        safe_title = _sanitize_filename(artifact.title or "webpage")
        file_name = f"{safe_title}.html"
        target_dir = Path(settings.UPLOAD_DIR) / (parent_id or "_web")
        target_dir.mkdir(parents=True, exist_ok=True)
        path = target_dir / f"{file_id}.html"
        path.write_text(artifact.html or "", encoding="utf-8")

        file_row = FileModel(
            id=file_id,
            name=file_name,
            file_type=FileType.WEB,
            path=str(path),
            size=len((artifact.html or "").encode("utf-8")),
            page_count=1,
            parent_id=parent_id,
            meta={
                "source_url": artifact.url,
                "import_mode": "web_url",
                "title": artifact.title,
                "tags": tags or [],
                "fetch_options": fetch_options or {},
            },
        )
        db.add(file_row)
        await db.flush()

        parse_result = await self.local_parser.parse(artifact, file_id=file_id)
        await self._replace_segments(
            db=db,
            file_id=file_id,
            source_type="web",
            segments=parse_result.segments,
        )

        status = await self._ensure_index_status(db, file_id)
        status.parse_status = "ready"
        status.embedding_status = "pending"
        await db.flush()

        build_result = await self.build_segments_for_file(db=db, file=file_row, mode="embed_only")
        return {
            "file_id": file_id,
            "type": "web",
            "ingest_status": "ready",
            "segment_count": len(parse_result.segments),
            "index_status": build_result,
        }

    async def get_outline(self, *, db: AsyncSession, file_id: str) -> List[Dict[str, Any]]:
        result = await db.execute(
            select(DocumentSegment)
            .where(DocumentSegment.file_id == file_id)
            .order_by(DocumentSegment.page, DocumentSegment.chunk_index)
        )
        rows = result.scalars().all()
        outline: List[Dict[str, Any]] = []
        for row in rows:
            if row.segment_type != "heading":
                continue
            outline.append(
                {
                    "segment_id": row.id,
                    "page": row.page,
                    "section": row.section,
                    "title": short_text(row.text, 160),
                }
            )
        if outline:
            return outline

        # Fallback outline: page-based markers.
        seen_pages: set[int] = set()
        for row in rows:
            if row.page is None or row.page in seen_pages:
                continue
            seen_pages.add(row.page)
            outline.append(
                {
                    "segment_id": row.id,
                    "page": row.page,
                    "section": row.section,
                    "title": f"Page {row.page}",
                }
            )
        return outline

    async def locate_relevant_segments(
        self,
        *,
        db: AsyncSession,
        query: str,
        file_ids: List[str],
        source_types: Optional[List[str]] = None,
        top_k: int = 8,
        page_start: Optional[int] = None,
        page_end: Optional[int] = None,
        active_file_id: Optional[str] = None,
        active_page: Optional[int] = None,
    ) -> Dict[str, Any]:
        if not file_ids:
            return {"hits": [], "diagnostics": {"text_hits": 0, "image_hits": 0, "fused_hits": 0, "fallback_flags": []}}

        diagnostics = {"text_hits": 0, "image_hits": 0, "fused_hits": 0, "fallback_flags": []}
        hits: List[RetrievalHit] = []

        if self.embedding_provider.is_enabled():
            try:
                query_vector = (await self.embedding_provider.embed_text([query]))[0]
                hits = await self.fusion_retriever.search(
                    db=db,
                    query=query,
                    query_embedding=query_vector,
                    file_ids=file_ids,
                    source_types=source_types,
                    top_k=top_k,
                    active_file_id=active_file_id,
                    active_page=active_page,
                )
                if page_start is not None or page_end is not None:
                    scoped_hits: List[RetrievalHit] = []
                    for hit in hits:
                        if hit.page is None:
                            continue
                        if page_start is not None and int(hit.page) < int(page_start):
                            continue
                        if page_end is not None and int(hit.page) > int(page_end):
                            continue
                        scoped_hits.append(hit)
                    hits = scoped_hits
                diagnostics["fused_hits"] = len(hits)
                diagnostics["text_hits"] = len([h for h in hits if "text" in h.source_mode or "fused" in h.source_mode])
                diagnostics["image_hits"] = len([h for h in hits if "image" in h.source_mode or h.reason])
            except Exception as exc:
                diagnostics["fallback_flags"].append(f"embedding_search_failed:{short_text(str(exc), 120)}")
                hits = []
        else:
            diagnostics["fallback_flags"].append("embedding_disabled")

        if not hits:
            query_tokens = _tokenize(query)
            q = (
                select(DocumentSegment)
                .where(DocumentSegment.file_id.in_(file_ids))
                .order_by(DocumentSegment.page, DocumentSegment.chunk_index)
            )
            if source_types:
                q = q.where(DocumentSegment.source_type.in_(source_types))
            if page_start is not None:
                q = q.where(DocumentSegment.page >= int(page_start))
            if page_end is not None:
                q = q.where(DocumentSegment.page <= int(page_end))
            result = await db.execute(q.limit(1200))
            rows = result.scalars().all()
            ranked = []
            for row in rows:
                score = _lexical_score(query_tokens, row.text)
                if score <= 0:
                    continue
                if row.segment_type in {"figure_caption", "table_caption", "figure_context"}:
                    score += 0.25
                    if _looks_like_visual_query(query):
                        score += 0.75
                if active_file_id and row.file_id == active_file_id:
                    score += 0.6
                if active_page is not None and row.page == active_page and row.file_id == active_file_id:
                    score += 1.2
                ranked.append((score, row))
            ranked.sort(key=lambda item: item[0], reverse=True)
            hits = [
                RetrievalHit(
                    segment_id=row.id,
                    file_id=row.file_id,
                    page=row.page,
                    section=row.section,
                    source_type=row.source_type,
                    score=float(score),
                    source_mode="lexical",
                    reason="lexical_fallback",
                    text=row.text,
                    segment_type=row.segment_type,
                )
                for score, row in ranked[:top_k]
            ]
            diagnostics["fallback_flags"].append("lexical")

        return {"hits": hits[:top_k], "diagnostics": diagnostics}

    async def build_deep_read_context(
        self,
        *,
        db: AsyncSession,
        hits: List[RetrievalHit],
        max_chars: int,
        page_window: int,
    ) -> List[Dict[str, Any]]:
        context_items: List[Dict[str, Any]] = []
        consumed = 0
        seen_segment_ids: set[str] = set()

        for hit in hits:
            if consumed >= max_chars:
                break
            anchor_result = await db.execute(
                select(DocumentSegment).where(DocumentSegment.id == hit.segment_id)
            )
            anchor = anchor_result.scalar_one_or_none()
            if not anchor:
                continue

            q = select(DocumentSegment).where(DocumentSegment.file_id == anchor.file_id)
            if anchor.source_type == "pdf" and anchor.page is not None:
                q = q.where(
                    and_(
                        DocumentSegment.page >= max(1, anchor.page - page_window),
                        DocumentSegment.page <= anchor.page + page_window,
                    )
                ).order_by(DocumentSegment.page, DocumentSegment.chunk_index)
            else:
                q = q.where(
                    and_(
                        DocumentSegment.chunk_index >= max(0, anchor.chunk_index - 2),
                        DocumentSegment.chunk_index <= anchor.chunk_index + 2,
                    )
                ).order_by(DocumentSegment.chunk_index)

            seg_result = await db.execute(q.limit(20))
            segs = seg_result.scalars().all()
            for seg in segs:
                if seg.id in seen_segment_ids:
                    continue
                seen_segment_ids.add(seg.id)
                snippet = seg.text.strip()
                if not snippet:
                    continue
                remain = max_chars - consumed
                if remain <= 0:
                    break
                if len(snippet) > remain:
                    snippet = snippet[:remain] + "..."
                consumed += len(snippet)
                context_items.append(
                    {
                        "segment_id": seg.id,
                        "file_id": seg.file_id,
                        "page": seg.page,
                        "section": seg.section,
                        "text": snippet,
                        "source_type": seg.source_type,
                        "segment_type": seg.segment_type,
                        "source_mode": hit.source_mode,
                        "reason": hit.reason,
                    }
                )
        return context_items

    async def read_segments(
        self,
        *,
        db: AsyncSession,
        file_id: str,
        segment_ids: Optional[List[str]] = None,
        anchors: Optional[List[Dict[str, Any]]] = None,
        page_start: Optional[int] = None,
        page_end: Optional[int] = None,
        anchor_page: Optional[int] = None,
        page_window: Optional[int] = None,
        max_chars: int = 6000,
    ) -> Dict[str, Any]:
        ids: List[str] = []
        if segment_ids:
            ids.extend(segment_ids)
        if anchors:
            ids.extend([str(anchor.get("segment_id") or "") for anchor in anchors if anchor.get("segment_id")])
        ids = [seg_id for seg_id in ids if seg_id]

        if ids:
            result = await db.execute(
                select(DocumentSegment)
                .where(and_(DocumentSegment.file_id == file_id, DocumentSegment.id.in_(ids)))
                .order_by(DocumentSegment.page, DocumentSegment.chunk_index)
            )
            rows = result.scalars().all()
        else:
            derived_page_start = page_start
            derived_page_end = page_end
            if anchor_page is not None:
                window = max(0, int(page_window if page_window is not None else 1))
                derived_page_start = max(1, int(anchor_page) - window) if derived_page_start is None else derived_page_start
                derived_page_end = int(anchor_page) + window if derived_page_end is None else derived_page_end

            query = (
                select(DocumentSegment)
                .where(DocumentSegment.file_id == file_id)
                .order_by(DocumentSegment.page, DocumentSegment.chunk_index)
            )
            if derived_page_start is not None:
                query = query.where(DocumentSegment.page >= int(derived_page_start))
            if derived_page_end is not None:
                query = query.where(DocumentSegment.page <= int(derived_page_end))

            result = await db.execute(
                query.limit(120)
            )
            rows = result.scalars().all()

        blocks = []
        consumed = 0
        for row in rows:
            text = row.text.strip()
            if not text:
                continue
            remain = max_chars - consumed
            if remain <= 0:
                break
            if len(text) > remain:
                text = text[:remain] + "..."
            consumed += len(text)
            blocks.append(
                {
                    "segment_id": row.id,
                    "page": row.page,
                    "section": row.section,
                    "segment_type": row.segment_type,
                    "text": text,
                    "bbox": row.bbox,
                }
            )

        return {"file_id": file_id, "count": len(blocks), "blocks": blocks}


reader_orchestrator = ReaderOrchestrator()
