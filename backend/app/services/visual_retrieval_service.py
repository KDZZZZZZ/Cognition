import asyncio
import base64
import json
import re
import uuid
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import DocumentChunk, DocumentPageAsset, File as FileModel, FileType
from app.services.llm_service import llm_service
from app.services.token_budget_service import short_text


def _tokenize(text: str) -> List[str]:
    return [token for token in re.split(r"\W+", (text or "").lower()) if token]


def _lexical_score(query_tokens: List[str], content: str) -> float:
    if not query_tokens or not content:
        return 0.0
    counts = Counter(_tokenize(content))
    return float(sum(counts.get(token, 0) for token in query_tokens))


async def _await_with_timeout_retry(
    *,
    operation,
    timeout_seconds: float,
    retries: int,
):
    last_error: Optional[TimeoutError] = None
    for attempt in range(max(0, int(retries)) + 1):
        try:
            return await asyncio.wait_for(operation(), timeout=max(0.1, float(timeout_seconds)))
        except TimeoutError as exc:
            last_error = exc
            if attempt >= max(0, int(retries)):
                raise
    if last_error is not None:
        raise last_error
    raise TimeoutError("operation timed out")


class VisualRetrievalService:
    """
    Multimodal page-localization pipeline for long PDF reading:
    page image -> visual rerank -> page anchor -> local deep-read.
    """

    def __init__(self) -> None:
        self.upload_root = Path(settings.UPLOAD_DIR)

    def _public_upload_url(self, path: Optional[Path]) -> Optional[str]:
        if path is None or not path.exists():
            return None
        try:
            uploads_root = self.upload_root.resolve()
            relative = path.resolve().relative_to(uploads_root).as_posix()
            return f"/uploads/{relative}"
        except Exception:
            return f"/uploads/{path.name}"

    def _page_asset_dir(self, file_id: str) -> Path:
        return self.upload_root / settings.VISUAL_PAGE_ASSET_SUBDIR / file_id

    def _normalize_image(self, image):
        # PIL import is kept local to avoid hard runtime dependency for non-PDF flows.
        from PIL import Image

        if image.mode != "RGB":
            image = image.convert("RGB")

        max_edge = max(256, int(settings.VISUAL_PAGE_IMAGE_MAX_EDGE))
        width, height = image.size
        longest = max(width, height)
        if longest > max_edge:
            ratio = max_edge / float(longest)
            target = (max(1, int(width * ratio)), max(1, int(height * ratio)))
            image = image.resize(target, Image.Resampling.LANCZOS)
        return image

    def _render_pdf_images_pdfium(
        self,
        *,
        pdf_path: Path,
        output_dir: Path,
        target_pages: List[int],
    ) -> Dict[int, Path]:
        import pypdfium2 as pdfium  # type: ignore

        if not target_pages:
            return {}

        output_dir.mkdir(parents=True, exist_ok=True)
        rendered: Dict[int, Path] = {}
        page_set = set(target_pages)

        document = pdfium.PdfDocument(str(pdf_path))
        scale = max(float(settings.VISUAL_PAGE_IMAGE_DPI) / 72.0, 1.0)

        try:
            for page_zero_based in range(len(document)):
                page_no = page_zero_based + 1
                if page_no not in page_set:
                    continue

                page = document[page_zero_based]
                bitmap = page.render(scale=scale)
                pil_image = bitmap.to_pil()
                pil_image = self._normalize_image(pil_image)

                image_path = output_dir / f"page-{page_no:04d}.jpg"
                pil_image.save(
                    image_path,
                    format="JPEG",
                    quality=max(30, min(95, int(settings.VISUAL_PAGE_IMAGE_QUALITY))),
                    optimize=True,
                )
                rendered[page_no] = image_path

                page.close()
                bitmap.close()
        finally:
            document.close()

        return rendered

    def _render_pdf_images_pdfplumber(
        self,
        *,
        pdf_path: Path,
        output_dir: Path,
        target_pages: List[int],
    ) -> Dict[int, Path]:
        import pdfplumber  # type: ignore

        if not target_pages:
            return {}

        output_dir.mkdir(parents=True, exist_ok=True)
        rendered: Dict[int, Path] = {}
        page_set = set(target_pages)

        with pdfplumber.open(pdf_path) as pdf:
            for page_no in sorted(page_set):
                if page_no < 1 or page_no > len(pdf.pages):
                    continue
                page = pdf.pages[page_no - 1]
                page_img = page.to_image(resolution=max(72, int(settings.VISUAL_PAGE_IMAGE_DPI)))
                pil_image = self._normalize_image(page_img.original)

                image_path = output_dir / f"page-{page_no:04d}.jpg"
                pil_image.save(
                    image_path,
                    format="JPEG",
                    quality=max(30, min(95, int(settings.VISUAL_PAGE_IMAGE_QUALITY))),
                    optimize=True,
                )
                rendered[page_no] = image_path

        return rendered

    def _render_pdf_images_sync(
        self,
        *,
        pdf_path: Path,
        output_dir: Path,
        target_pages: List[int],
    ) -> Dict[int, Path]:
        if not target_pages:
            return {}

        try:
            return self._render_pdf_images_pdfium(
                pdf_path=pdf_path,
                output_dir=output_dir,
                target_pages=target_pages,
            )
        except Exception:
            # Fallback path for environments without pypdfium2.
            try:
                return self._render_pdf_images_pdfplumber(
                    pdf_path=pdf_path,
                    output_dir=output_dir,
                    target_pages=target_pages,
                )
            except Exception:
                return {}

    def _to_data_url(self, image_path: Path) -> Optional[str]:
        if not image_path.exists():
            return None
        try:
            raw = image_path.read_bytes()
            encoded = base64.b64encode(raw).decode("ascii")
            suffix = image_path.suffix.lower()
            mime = "image/png" if suffix == ".png" else "image/jpeg"
            return f"data:{mime};base64,{encoded}"
        except Exception:
            return None

    def _extract_json(self, raw: str) -> Optional[Dict[str, Any]]:
        if not raw:
            return None

        text = raw.strip()
        if text.startswith("```"):
            text = re.sub(r"^```(?:json)?\s*", "", text)
            text = re.sub(r"\s*```$", "", text)

        try:
            parsed = json.loads(text)
            return parsed if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            pass

        match = re.search(r"\{[\s\S]*\}", text)
        if not match:
            return None

        try:
            parsed = json.loads(match.group(0))
            return parsed if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            return None

    async def _vision_rerank(
        self,
        *,
        query: str,
        candidates: List[Dict[str, Any]],
    ) -> Dict[str, Dict[str, Any]]:
        if not candidates:
            return {}
        if not llm_service.supports_vision(settings.VISUAL_RETRIEVAL_MODEL):
            return {}

        content_items: List[Dict[str, Any]] = [
            {
                "type": "text",
                "text": (
                    "You are a multimodal retriever for long documents.\n"
                    "Given candidate page images and a query, rank relevance.\n"
                    "Return JSON only in this schema:\n"
                    '{"ranked":[{"candidate_id":"c1","score":0.0,"reason":"..."}]}\n'
                    f"Query: {query}\n"
                    "Rules: score in [0,1], keep at most 6 items, higher=more relevant."
                ),
            }
        ]

        candidate_lookup: Dict[str, Dict[str, Any]] = {}
        for idx, candidate in enumerate(candidates):
            image_path_raw = candidate.get("image_path")
            if not image_path_raw:
                continue
            image_path = Path(image_path_raw)
            image_url = self._to_data_url(image_path)
            if not image_url:
                continue

            cid = f"c{idx + 1}"
            candidate_lookup[cid] = candidate

            content_items.append(
                {
                    "type": "text",
                    "text": (
                        f"[{cid}] file={candidate.get('file_name', 'Unknown')} "
                        f"page={candidate.get('page')}\n"
                        f"Anchor: {short_text(candidate.get('text_anchor') or '', 280)}"
                    ),
                }
            )
            content_items.append(
                {
                    "type": "image_url",
                    "image_url": {"url": image_url},
                }
            )

        if not candidate_lookup:
            return {}

        try:
            response = await llm_service.chat_completion(
                messages=[{"role": "user", "content": content_items}],
                model=settings.VISUAL_RETRIEVAL_MODEL,
            )
        except Exception:
            return {}

        payload = self._extract_json(response.get("content", ""))
        ranked = payload.get("ranked") if isinstance(payload, dict) else None
        if not isinstance(ranked, list):
            return {}

        parsed: Dict[str, Dict[str, Any]] = {}
        for item in ranked:
            if not isinstance(item, dict):
                continue
            cid = str(item.get("candidate_id") or "").strip()
            if cid not in candidate_lookup:
                continue
            try:
                score = float(item.get("score", 0.0))
            except (TypeError, ValueError):
                score = 0.0
            score = max(0.0, min(1.0, score))
            parsed[cid] = {
                "score": score,
                "reason": short_text(str(item.get("reason") or "").strip(), 180),
            }

        return parsed

    async def ensure_page_assets(
        self,
        *,
        db: AsyncSession,
        file_id: str,
        page_count_hint: Optional[int] = None,
        file_path_hint: Optional[str] = None,
        chunks_hint: Optional[List[DocumentChunk]] = None,
    ) -> List[DocumentPageAsset]:
        if not settings.VISUAL_RETRIEVAL_ENABLED:
            return []

        existing_result = await db.execute(
            select(DocumentPageAsset)
            .where(DocumentPageAsset.file_id == file_id)
            .order_by(DocumentPageAsset.page)
        )
        existing_assets = existing_result.scalars().all()
        if existing_assets:
            return existing_assets

        file_row: Optional[FileModel] = None
        if file_path_hint is None or page_count_hint is None:
            file_result = await db.execute(select(FileModel).where(FileModel.id == file_id))
            file_row = file_result.scalar_one_or_none()
            if not file_row:
                return []
            if file_row.file_type != FileType.PDF:
                return []
            if file_path_hint is None:
                file_path_hint = file_row.path
            if page_count_hint is None:
                page_count_hint = file_row.page_count or 0

        pdf_path = Path(file_path_hint or "")
        if not pdf_path.exists():
            return []

        if chunks_hint is None:
            chunks_result = await db.execute(
                select(DocumentChunk)
                .where(DocumentChunk.file_id == file_id)
                .order_by(DocumentChunk.page, DocumentChunk.chunk_index)
            )
            chunks_hint = chunks_result.scalars().all()

        page_to_text: Dict[int, str] = {}
        for chunk in chunks_hint:
            page_to_text.setdefault(int(chunk.page), "")
            if len(page_to_text[chunk.page]) >= settings.VISUAL_TEXT_ANCHOR_MAX_CHARS:
                continue
            if page_to_text[chunk.page]:
                page_to_text[chunk.page] += "\n"
            page_to_text[chunk.page] += chunk.content

        max_seen_page = max(page_to_text.keys(), default=0)
        page_count = max(int(page_count_hint or 0), max_seen_page)
        if page_count <= 0:
            return []

        render_limit = min(page_count, max(1, int(settings.VISUAL_RETRIEVAL_MAX_PAGES_PER_FILE)))
        target_pages = list(range(1, render_limit + 1))
        output_dir = self._page_asset_dir(file_id)

        rendered_images = await asyncio.to_thread(
            self._render_pdf_images_sync,
            pdf_path=pdf_path,
            output_dir=output_dir,
            target_pages=target_pages,
        )

        new_assets: List[DocumentPageAsset] = []
        for page_no in range(1, page_count + 1):
            text_anchor = short_text(page_to_text.get(page_no, ""), settings.VISUAL_TEXT_ANCHOR_MAX_CHARS)
            image_path = rendered_images.get(page_no)
            image_url = self._public_upload_url(image_path)

            if not text_anchor and not image_url:
                continue

            asset = DocumentPageAsset(
                id=str(uuid.uuid4()),
                file_id=file_id,
                page=page_no,
                image_path=str(image_path) if image_path else None,
                image_url=image_url,
                text_anchor=text_anchor if text_anchor else None,
            )
            db.add(asset)
            new_assets.append(asset)

        if new_assets:
            await db.flush()

        return new_assets

    async def retrieve_visual_page_hits(
        self,
        *,
        db: AsyncSession,
        query: str,
        readable_files: List[str],
        permitted_files_info: Dict[str, Dict[str, str]],
        active_file_id: Optional[str],
        active_page: Optional[int],
    ) -> List[Dict[str, Any]]:
        if not settings.VISUAL_RETRIEVAL_ENABLED:
            return []

        pdf_file_ids = [
            file_id
            for file_id in readable_files
            if (permitted_files_info.get(file_id) or {}).get("type") == "pdf"
        ]
        if not pdf_file_ids:
            return []

        # Lazy index build for previously uploaded files.
        for file_id in pdf_file_ids:
            try:
                await self.ensure_page_assets(db=db, file_id=file_id)
            except Exception:
                continue

        assets_result = await db.execute(
            select(DocumentPageAsset)
            .where(DocumentPageAsset.file_id.in_(pdf_file_ids))
            .order_by(DocumentPageAsset.file_id, DocumentPageAsset.page)
        )
        assets = assets_result.scalars().all()
        if not assets:
            return []

        query_tokens = _tokenize(query)
        coarse: List[Dict[str, Any]] = []
        for asset in assets:
            file_id = asset.file_id
            file_name = (permitted_files_info.get(file_id) or {}).get("name", "Unknown")
            anchor = asset.text_anchor or ""
            score = _lexical_score(query_tokens, anchor)

            if active_file_id and file_id == active_file_id:
                score += 0.9
            if active_file_id and active_page is not None and file_id == active_file_id and asset.page == active_page:
                score += 2.0
            if not query_tokens and active_file_id and file_id == active_file_id:
                score += 1.0
            if asset.image_url:
                score += 0.05

            if score <= 0:
                continue

            coarse.append(
                {
                    "file_id": file_id,
                    "file_name": file_name,
                    "page": asset.page,
                    "image_path": asset.image_path,
                    "image_url": asset.image_url,
                    "text_anchor": anchor,
                    "coarse_score": float(score),
                }
            )

        if not coarse:
            return []

        coarse.sort(key=lambda item: item.get("coarse_score", 0.0), reverse=True)
        coarse = coarse[: max(1, int(settings.VISUAL_RETRIEVAL_CANDIDATES))]

        vision_candidates = [
            item for item in coarse if item.get("image_path")
        ][: max(1, int(settings.VISUAL_RETRIEVAL_VISION_RERANK_CANDIDATES))]
        vision_map: Dict[str, Dict[str, Any]] = {}
        if vision_candidates:
            timeout_seconds = float(settings.VISUAL_RERANK_TIMEOUT_SECONDS)
            try:
                vision_map = await _await_with_timeout_retry(
                    operation=lambda: self._vision_rerank(query=query, candidates=vision_candidates),
                    timeout_seconds=timeout_seconds,
                    retries=int(settings.VISUAL_RERANK_TIMEOUT_RETRIES),
                )
            except TimeoutError:
                vision_map = {}

        for idx, item in enumerate(vision_candidates):
            item["candidate_id"] = f"c{idx + 1}"

        for item in coarse:
            item["vision_score"] = None
            item["vision_reason"] = None

        candidate_by_id = {
            item.get("candidate_id"): item
            for item in vision_candidates
            if item.get("candidate_id")
        }
        for cid, payload in vision_map.items():
            matched = candidate_by_id.get(cid)
            if not matched:
                continue
            matched["vision_score"] = payload.get("score")
            matched["vision_reason"] = payload.get("reason")

        for item in coarse:
            coarse_score = float(item.get("coarse_score", 0.0))
            vision_score = item.get("vision_score")
            if isinstance(vision_score, (int, float)):
                # Make visual signal dominant while keeping lexical/file-prior context.
                item["score"] = 0.35 * coarse_score + 4.0 * float(vision_score)
                item["source_mode"] = "vision_rerank"
            else:
                item["score"] = coarse_score
                item["source_mode"] = "visual_lexical"

        coarse.sort(key=lambda item: item.get("score", 0.0), reverse=True)
        top_k = max(1, int(settings.VISUAL_RETRIEVAL_TOP_K))
        return coarse[:top_k]


visual_retrieval_service = VisualRetrievalService()
