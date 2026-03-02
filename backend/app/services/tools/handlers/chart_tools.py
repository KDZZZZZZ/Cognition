import re
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from sqlalchemy import select

from app.config import settings
from app.models import DocumentAsset, DocumentPageAsset, DocumentSegment, File as FileModel, FileType
from app.services.multiformat_document_service import reader_orchestrator
from app.services.tools.base import BaseTool, PermissionLevel, ToolContext, ToolResult, ToolValidationError
from app.services.tools.handlers.editor_ops import _create_pending_diff_event, _read_effective_text


def _tokenize(text: str) -> List[str]:
    return [token for token in re.split(r"\W+", (text or "").lower()) if token]


def _lexical_score(query_tokens: List[str], text: str) -> float:
    if not query_tokens:
        return 0.0
    tokens = set(_tokenize(text))
    if not tokens:
        return 0.0
    return float(sum(1 for token in query_tokens if token in tokens))


def _looks_like_visual_anchor(text: str) -> bool:
    lowered = (text or "").lower()
    return any(
        keyword in lowered
        for keyword in ("figure", "fig.", "chart", "graph", "table", "diagram", "plot", "图", "表")
    )


def _extract_visual_references(text: str) -> List[tuple[Optional[str], str]]:
    lowered = (text or "").lower()
    refs: List[tuple[Optional[str], str]] = []
    patterns = [
        (r"\bfigure\s*([0-9]+)\b", "figure"),
        (r"\bfig\.?\s*([0-9]+)\b", "figure"),
        (r"\btable\s*([0-9]+)\b", "table"),
        (r"图\s*([0-9]+)", "figure"),
        (r"表\s*([0-9]+)", "table"),
    ]
    for pattern, kind in patterns:
        for match in re.finditer(pattern, lowered):
            number = str(match.group(1) or "").strip()
            if number:
                refs.append((kind, number))
    return refs


async def _load_segment_by_id(db, segment_id: Optional[str]) -> Optional[DocumentSegment]:
    if not segment_id:
        return None
    result = await db.execute(select(DocumentSegment).where(DocumentSegment.id == segment_id))
    return result.scalar_one_or_none()


async def _find_best_page_segment(
    *,
    db,
    file_id: str,
    page: int,
    query_tokens: List[str],
) -> Optional[DocumentSegment]:
    result = await db.execute(
        select(DocumentSegment)
        .where(DocumentSegment.file_id == file_id, DocumentSegment.page == int(page))
        .order_by(DocumentSegment.chunk_index)
    )
    rows = result.scalars().all()
    if not rows:
        return None

    scored: List[tuple[float, DocumentSegment]] = []
    for row in rows:
        score = _lexical_score(query_tokens, row.text)
        if row.segment_type in {"figure_caption", "table_caption", "figure_context"}:
            score += 2.5
        if _looks_like_visual_anchor(row.text):
            score += 2.0
        if row.bbox:
            score += 0.25
        scored.append((score, row))

    scored.sort(key=lambda item: item[0], reverse=True)
    best_score, best_row = scored[0]
    if best_score <= 0:
        return None
    return best_row


def _chart_crop_output_path(file_id: str, page: int, segment_id: str) -> Path:
    safe_segment = re.sub(r"[^a-zA-Z0-9_-]+", "", segment_id)[:16] or "segment"
    return (
        Path(settings.UPLOAD_DIR)
        / "chart-crops"
        / file_id
        / f"page-{int(page):04d}-{safe_segment}.jpg"
    )


_VISUAL_HANDLE_PREFIX = "visual_asset:"
_CHART_CROP_VERSION = 3


def _build_visual_handle(asset_id: str) -> str:
    return f"{_VISUAL_HANDLE_PREFIX}{asset_id}"


def _parse_visual_handle(handle: Optional[str]) -> Optional[str]:
    raw = str(handle or "").strip()
    if not raw:
        return None
    if raw.startswith(_VISUAL_HANDLE_PREFIX):
        raw = raw[len(_VISUAL_HANDLE_PREFIX) :].strip()
    return raw or None


def _build_chart_crop_box(
    *,
    localized_segment: DocumentSegment,
    pdf_width: float,
    pdf_height: float,
) -> Optional[Tuple[float, float, float, float]]:
    if not localized_segment.bbox:
        return None

    x0, top, x1, bottom = [float(v) for v in localized_segment.bbox]
    if x1 <= x0 or bottom <= top:
        return None

    width = max(1.0, x1 - x0)
    height = max(1.0, bottom - top)
    segment_type = str(getattr(localized_segment, "segment_type", "") or "").strip().lower()

    if segment_type == "figure_context":
        pad_x = max(12.0, min(pdf_width * 0.03, width * 0.10))
        pad_top = max(10.0, min(pdf_height * 0.02, height * 0.05))
        pad_bottom = max(14.0, min(pdf_height * 0.03, height * 0.08))

        crop_left = max(0.0, x0 - pad_x)
        crop_right = min(pdf_width, x1 + pad_x)
        crop_top = max(0.0, top - pad_top)
        crop_bottom = min(pdf_height, bottom + pad_bottom)

        # `figure_context` chunks can cover the figure plus the first body paragraphs.
        # Keep the upper visual block dominant instead of expanding toward the full page.
        if height > pdf_height * 0.42:
            crop_bottom = min(crop_bottom, top + max(pdf_height * 0.22, height * 0.46))
    elif segment_type in {"figure_caption", "table_caption"}:
        pad_x = max(20.0, min(pdf_width * 0.07, width * 0.30))
        pad_top = max(64.0, min(pdf_height * 0.20, height * 4.0))
        pad_bottom = max(16.0, min(pdf_height * 0.05, height * 1.5))

        crop_left = max(0.0, x0 - pad_x)
        crop_right = min(pdf_width, x1 + pad_x)
        crop_top = max(0.0, top - pad_top)
        crop_bottom = min(pdf_height, bottom + pad_bottom)
    else:
        pad_x = max(16.0, min(pdf_width * 0.05, width * 0.16))
        pad_top = max(18.0, min(pdf_height * 0.05, height * 0.16))
        pad_bottom = max(18.0, min(pdf_height * 0.06, height * 0.18))

        crop_left = max(0.0, x0 - pad_x)
        crop_right = min(pdf_width, x1 + pad_x)
        crop_top = max(0.0, top - pad_top)
        crop_bottom = min(pdf_height, bottom + pad_bottom)

    if crop_right <= crop_left or crop_bottom <= crop_top:
        return None

    return (crop_left, crop_top, crop_right, crop_bottom)


def _build_visual_asset_ref(
    *,
    asset: DocumentAsset,
    source_file: FileModel,
    page_asset: Optional[DocumentPageAsset],
    segment: Optional[DocumentSegment],
) -> Dict[str, Any]:
    meta = asset.meta or {}
    page = int(meta.get("page") or getattr(page_asset, "page", 0) or 0)
    anchor = str(
        meta.get("anchor")
        or (segment.text if segment and segment.text else "")
        or (getattr(page_asset, "text_anchor", "") if page_asset else "")
        or ""
    ).strip()
    segment_id = str(meta.get("segment_id") or getattr(segment, "id", "") or "").strip() or None
    segment_type = str(meta.get("segment_type") or getattr(segment, "segment_type", "") or "").strip() or None

    return {
        "handle": _build_visual_handle(asset.id),
        "asset_id": asset.id,
        "file_id": source_file.id,
        "file_name": source_file.name,
        "page": page or None,
        "segment_id": segment_id,
        "segment_type": segment_type,
        "asset_type": asset.asset_type,
        "image_url": asset.url,
        "source": str(meta.get("source") or asset.asset_type or "chart_crop"),
        "anchor": anchor[:360] or None,
    }


async def _get_or_create_chart_crop_asset(
    *,
    db,
    source_file: FileModel,
    page_asset: DocumentPageAsset,
    segment: Optional[DocumentSegment],
) -> Optional[DocumentAsset]:
    if not page_asset.image_path:
        return None

    localized_segment = segment
    if not localized_segment or not localized_segment.bbox:
        result = await db.execute(
            select(DocumentSegment)
            .where(
                DocumentSegment.file_id == source_file.id,
                DocumentSegment.page == int(page_asset.page),
            )
            .order_by(DocumentSegment.chunk_index)
        )
        rows = result.scalars().all()
        if not rows:
            return None

        anchor_tokens = _tokenize(
            " ".join(
                value
                for value in [
                    getattr(segment, "text", "") if segment else "",
                    getattr(page_asset, "text_anchor", "") or "",
                ]
                if value
            )
        )
        scored: List[tuple[float, DocumentSegment]] = []
        for row in rows:
            if not row.bbox:
                continue
            score = _lexical_score(anchor_tokens, row.text)
            if row.segment_type == "figure_context":
                score += 4.0
            elif row.segment_type in {"figure_caption", "table_caption"}:
                score += 3.0
            if _looks_like_visual_anchor(row.text):
                score += 2.0
            scored.append((score, row))
        if not scored:
            return None
        scored.sort(key=lambda item: item[0], reverse=True)
        localized_segment = scored[0][1]

    if not localized_segment or not localized_segment.bbox:
        return None

    asset_key = f"page:{int(page_asset.page)}:segment:{localized_segment.id}"
    existing_result = await db.execute(
        select(DocumentAsset).where(
            DocumentAsset.file_id == source_file.id,
            DocumentAsset.asset_type == "chart_crop",
            DocumentAsset.page_or_section == asset_key,
        )
    )
    existing = existing_result.scalar_one_or_none()
    existing_meta = (existing.meta or {}) if existing else {}
    if (
        existing
        and existing.url
        and existing.path
        and Path(existing.path).exists()
        and int(existing_meta.get("crop_version") or 0) == _CHART_CROP_VERSION
    ):
        return existing

    image_path = Path(page_asset.image_path)
    source_pdf_path = Path(source_file.path)
    if not image_path.exists() or not source_pdf_path.exists():
        return None

    try:
        import pdfplumber  # type: ignore
        from PIL import Image
    except Exception:
        return None

    try:
        with pdfplumber.open(source_pdf_path) as pdf:
            if int(page_asset.page) < 1 or int(page_asset.page) > len(pdf.pages):
                return None
            pdf_page = pdf.pages[int(page_asset.page) - 1]
            pdf_width = float(pdf_page.width or 0)
            pdf_height = float(pdf_page.height or 0)
            if pdf_width <= 0 or pdf_height <= 0:
                return None

        crop_box = _build_chart_crop_box(
            localized_segment=localized_segment,
            pdf_width=pdf_width,
            pdf_height=pdf_height,
        )
        if crop_box is None:
            return None

        with Image.open(image_path) as page_image:
            page_width, page_height = page_image.size
            if page_width <= 0 or page_height <= 0:
                return None

            crop_left, crop_top, crop_right, crop_bottom = crop_box
            scale_x = page_width / pdf_width
            scale_y = page_height / pdf_height
            pixel_box = (
                max(0, int(crop_left * scale_x)),
                max(0, int(crop_top * scale_y)),
                min(page_width, int(crop_right * scale_x)),
                min(page_height, int(crop_bottom * scale_y)),
            )
            if pixel_box[2] - pixel_box[0] < 24 or pixel_box[3] - pixel_box[1] < 24:
                return None

            crop_path = _chart_crop_output_path(source_file.id, int(page_asset.page), localized_segment.id)
            crop_path.parent.mkdir(parents=True, exist_ok=True)
            page_image.crop(pixel_box).save(crop_path, format="JPEG", quality=90, optimize=True)
    except Exception:
        return None

    relative = crop_path.resolve().relative_to(Path(settings.UPLOAD_DIR).resolve()).as_posix()
    crop_url = f"/uploads/{relative}"
    asset_meta = {
        "page": int(page_asset.page),
        "segment_id": localized_segment.id,
        "segment_type": getattr(localized_segment, "segment_type", None),
        "anchor": (getattr(localized_segment, "text", "") or "")[:360],
        "source": "chart_crop",
        "crop_version": _CHART_CROP_VERSION,
    }

    if existing:
        existing.path = str(crop_path)
        existing.url = crop_url
        existing.meta = asset_meta
        await db.flush()
        return existing

    asset = DocumentAsset(
        id=str(uuid.uuid4()),
        file_id=source_file.id,
        page_or_section=asset_key,
        asset_type="chart_crop",
        path=str(crop_path),
        url=crop_url,
        meta=asset_meta,
    )
    db.add(asset)
    await db.flush()
    return asset


async def _get_or_create_chart_crop(
    *,
    db,
    source_file: FileModel,
    page_asset: DocumentPageAsset,
    segment: Optional[DocumentSegment],
) -> Optional[str]:
    asset = await _get_or_create_chart_crop_asset(
        db=db,
        source_file=source_file,
        page_asset=page_asset,
        segment=segment,
    )
    return asset.url if asset and asset.url else None


async def _resolve_pdf_targets(
    *,
    context: ToolContext,
    source_file: FileModel,
    page_to_asset: Dict[int, DocumentPageAsset],
    query: str,
    max_charts: int,
    explicit_page: Optional[int],
    explicit_segment_id: Optional[str],
) -> List[Dict[str, Any]]:
    query_tokens = _tokenize(query)
    visual_refs = _extract_visual_references(query)
    page_targets: Dict[int, Dict[str, Any]] = {}

    if explicit_segment_id:
        segment = await _load_segment_by_id(context.db, explicit_segment_id)
        if segment and segment.file_id == source_file.id and segment.page is not None:
            asset = page_to_asset.get(int(segment.page))
            if asset:
                page_targets[int(segment.page)] = {
                    "page": int(segment.page),
                    "segment": segment,
                    "asset": asset,
                    "score": 100.0,
                }

    if explicit_page is not None and explicit_page not in page_targets:
        asset = page_to_asset.get(int(explicit_page))
        if asset:
            segment = await _find_best_page_segment(
                db=context.db,
                file_id=source_file.id,
                page=int(explicit_page),
                query_tokens=query_tokens,
            )
            page_targets[int(explicit_page)] = {
                "page": int(explicit_page),
                "segment": segment,
                "asset": asset,
                "score": 80.0,
            }

    if not page_targets and visual_refs:
        result = await context.db.execute(
            select(DocumentSegment)
            .where(
                DocumentSegment.file_id == source_file.id,
                DocumentSegment.page.is_not(None),
                DocumentSegment.segment_type.in_(["figure_caption", "table_caption"]),
            )
            .order_by(DocumentSegment.page, DocumentSegment.chunk_index)
        )
        rows = result.scalars().all()
        for row in rows:
            meta = row.meta or {}
            row_label = str(meta.get("visual_label") or "").strip().lower()
            row_kind = str(meta.get("visual_kind") or "").strip().lower()
            page_no = int(row.page) if row.page is not None else None
            if not row_label or page_no is None:
                continue
            asset = page_to_asset.get(page_no)
            if not asset:
                continue
            if any(ref_number == row_label and (ref_kind is None or ref_kind == row_kind) for ref_kind, ref_number in visual_refs):
                page_targets[page_no] = {
                    "page": page_no,
                    "segment": row,
                    "asset": asset,
                    "score": 160.0 + _lexical_score(query_tokens, row.text),
                }

    if not page_targets and visual_refs:
        for page_no, asset in page_to_asset.items():
            anchor_text = str(getattr(asset, "text_anchor", "") or "")
            if not anchor_text:
                continue
            normalized_anchor = anchor_text.lower().replace(" ", "")
            for ref_kind, ref_number in visual_refs:
                label_patterns = []
                if ref_kind == "figure":
                    label_patterns.extend([f"figure{ref_number}", f"fig.{ref_number}", f"fig{ref_number}", f"图{ref_number}"])
                elif ref_kind == "table":
                    label_patterns.extend([f"table{ref_number}", f"表{ref_number}"])
                else:
                    label_patterns.extend([f"figure{ref_number}", f"table{ref_number}", f"图{ref_number}", f"表{ref_number}"])
                if any(pattern in normalized_anchor for pattern in label_patterns):
                    segment = await _find_best_page_segment(
                        db=context.db,
                        file_id=source_file.id,
                        page=page_no,
                        query_tokens=query_tokens,
                    )
                    page_targets[page_no] = {
                        "page": page_no,
                        "segment": segment,
                        "asset": asset,
                        "score": 150.0 + _lexical_score(query_tokens, anchor_text),
                    }
                    break

    if not page_targets:
        hit_result = await reader_orchestrator.locate_relevant_segments(
            db=context.db,
            query=query,
            file_ids=[source_file.id],
            source_types=["pdf"],
            top_k=max(8, max_charts * 4),
        )
        hits = hit_result.get("hits", [])
        segment_ids = [hit.segment_id for hit in hits if getattr(hit, "segment_id", None)]
        segment_rows: Dict[str, DocumentSegment] = {}
        if segment_ids:
            result = await context.db.execute(
                select(DocumentSegment).where(DocumentSegment.id.in_(segment_ids))
            )
            segment_rows = {row.id: row for row in result.scalars().all()}

        for hit in hits:
            page = getattr(hit, "page", None)
            if page is None:
                continue
            page_no = int(page)
            asset = page_to_asset.get(page_no)
            if not asset:
                continue
            segment = segment_rows.get(hit.segment_id)
            score = float(getattr(hit, "score", 0.0) or 0.0)
            if segment is not None:
                if segment.segment_type in {"figure_caption", "table_caption", "figure_context"}:
                    score += 2.5
                score += _lexical_score(query_tokens, segment.text)
                if _looks_like_visual_anchor(segment.text):
                    score += 2.0
                if segment.bbox:
                    score += 0.25
            current = page_targets.get(page_no)
            if current is None or score > float(current.get("score", 0.0)):
                page_targets[page_no] = {
                    "page": page_no,
                    "segment": segment,
                    "asset": asset,
                    "score": score,
                }

    ordered = sorted(page_targets.values(), key=lambda item: float(item.get("score", 0.0)), reverse=True)
    return ordered[:max_charts]


async def _resolve_visual_handle_targets(
    *,
    db,
    visual_handles: List[str],
) -> List[Dict[str, Any]]:
    asset_ids: List[str] = []
    for handle in visual_handles:
        asset_id = _parse_visual_handle(handle)
        if asset_id:
            asset_ids.append(asset_id)
    if not asset_ids:
        return []

    asset_result = await db.execute(select(DocumentAsset).where(DocumentAsset.id.in_(asset_ids)))
    asset_rows = {row.id: row for row in asset_result.scalars().all()}

    ordered_assets: List[DocumentAsset] = []
    for asset_id in asset_ids:
        asset = asset_rows.get(asset_id)
        if asset and asset.url:
            ordered_assets.append(asset)
    if not ordered_assets:
        return []

    file_ids = sorted({asset.file_id for asset in ordered_assets})
    file_result = await db.execute(select(FileModel).where(FileModel.id.in_(file_ids)))
    file_rows = {row.id: row for row in file_result.scalars().all()}

    segment_ids = sorted(
        {
            str((asset.meta or {}).get("segment_id") or "").strip()
            for asset in ordered_assets
            if str((asset.meta or {}).get("segment_id") or "").strip()
        }
    )
    segment_rows: Dict[str, DocumentSegment] = {}
    if segment_ids:
        segment_result = await db.execute(select(DocumentSegment).where(DocumentSegment.id.in_(segment_ids)))
        segment_rows = {row.id: row for row in segment_result.scalars().all()}

    page_pairs = sorted(
        {
            (asset.file_id, int((asset.meta or {}).get("page") or 0))
            for asset in ordered_assets
            if int((asset.meta or {}).get("page") or 0) > 0
        }
    )
    page_assets: Dict[tuple[str, int], DocumentPageAsset] = {}
    if page_pairs:
        page_result = await db.execute(
            select(DocumentPageAsset).where(
                DocumentPageAsset.file_id.in_([file_id for file_id, _ in page_pairs])
            )
        )
        for row in page_result.scalars().all():
            key = (row.file_id, int(row.page))
            if key in page_pairs:
                page_assets[key] = row

    resolved: List[Dict[str, Any]] = []
    for asset in ordered_assets:
        source_file = file_rows.get(asset.file_id)
        if not source_file:
            continue
        meta = asset.meta or {}
        page = int(meta.get("page") or 0)
        segment_id = str(meta.get("segment_id") or "").strip()
        page_asset = page_assets.get((asset.file_id, page))
        segment = segment_rows.get(segment_id) if segment_id else None
        resolved.append(
            {
                "asset_record": asset,
                "source_file": source_file,
                "page": page,
                "page_asset": page_asset,
                "segment": segment,
                "visual_ref": _build_visual_asset_ref(
                    asset=asset,
                    source_file=source_file,
                    page_asset=page_asset,
                    segment=segment,
                ),
            }
        )
    return resolved


class AddFileChartsToNoteTool(BaseTool):
    @property
    def name(self) -> str:
        return "add_file_charts_to_note"

    @property
    def description(self) -> str:
        return (
            "Add chart blocks from a source document into a target markdown note. "
            "PDF-first: prefers page images when available."
        )

    @property
    def required_permission(self) -> PermissionLevel:
        return PermissionLevel.WRITE

    @property
    def writable_only(self) -> bool:
        return True

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "file_id": {"type": "string", "description": "Target markdown note file ID"},
                "source_file_id": {
                    "type": "string",
                    "description": "Source document file ID. Optional when visual_handle(s) come from inspect_document_visual.",
                },
                "visual_handle": {
                    "type": "string",
                    "description": "Exact visual handle returned by inspect_document_visual. Prefer this over query/page/segment when inserting the same visual.",
                },
                "visual_handles": {
                    "type": "array",
                    "description": "Optional list of exact visual handles returned by inspect_document_visual.",
                    "items": {"type": "string"},
                },
                "query": {
                    "type": "string",
                    "description": "Optional hint query for chart/figure localization",
                },
                "page": {
                    "type": "integer",
                    "description": "Optional exact page number. Prefer passing this after locate_relevant_segments.",
                },
                "segment_id": {
                    "type": "string",
                    "description": "Optional exact anchor segment ID. Prefer passing this after locate_relevant_segments for localized crops.",
                },
                "max_charts": {
                    "type": "integer",
                    "description": "Maximum number of chart blocks to add",
                    "default": 3,
                },
                "insert_mode": {
                    "type": "string",
                    "description": "Insert mode: append|after_heading",
                    "default": "append",
                },
                "target_heading": {
                    "type": "string",
                    "description": "Heading text used when insert_mode=after_heading",
                },
            },
            "required": ["file_id"],
        }

    def validate_arguments(self, arguments: Dict[str, Any]) -> None:
        super().validate_arguments(arguments)
        visual_handle = str(arguments.get("visual_handle") or "").strip()
        visual_handles = [
            str(item or "").strip()
            for item in (arguments.get("visual_handles") or [])
            if str(item or "").strip()
        ]
        source_file_id = str(arguments.get("source_file_id") or "").strip()
        if not source_file_id and not visual_handle and not visual_handles:
            raise ToolValidationError(
                self.name,
                "source_file_id",
                "Provide source_file_id or at least one visual_handle",
            )
        max_charts = int(arguments.get("max_charts", 3))
        if max_charts < 1 or max_charts > 8:
            raise ToolValidationError(self.name, "max_charts", "max_charts must be in [1,8]")

        insert_mode = str(arguments.get("insert_mode") or "append").strip().lower()
        if insert_mode not in {"append", "after_heading"}:
            raise ToolValidationError(self.name, "insert_mode", "insert_mode must be append|after_heading")

    async def execute(self, arguments: Dict[str, Any], context: ToolContext) -> ToolResult:
        note_file_id = str(arguments["file_id"]).strip()
        source_file_id = str(arguments.get("source_file_id") or "").strip()
        visual_handles = [
            str(arguments.get("visual_handle") or "").strip(),
            *[
                str(item or "").strip()
                for item in (arguments.get("visual_handles") or [])
                if str(item or "").strip()
            ],
        ]
        visual_handles = [item for item in visual_handles if item]
        query = str(arguments.get("query") or "").strip() or "chart figure graph table"
        page = arguments.get("page")
        explicit_page = int(page) if page is not None else None
        explicit_segment_id = str(arguments.get("segment_id") or "").strip() or None
        max_charts = max(1, min(8, int(arguments.get("max_charts", 3))))
        insert_mode = str(arguments.get("insert_mode") or "append").strip().lower()
        target_heading = str(arguments.get("target_heading") or "").strip()

        note_result = await context.db.execute(select(FileModel).where(FileModel.id == note_file_id))
        note_file = note_result.scalar_one_or_none()
        if not note_file:
            return ToolResult(success=False, error="Target note file not found", error_code="FILE_NOT_FOUND")
        if note_file.file_type != FileType.MD:
            return ToolResult(
                success=False,
                error="Target file must be markdown (.md)",
                error_code="FILE_NOT_WRITABLE",
            )

        markdown_blocks: List[str] = []
        used_asset_count = 0
        fallback_used = False
        inserted_visual_refs: List[Dict[str, Any]] = []
        source_file: Optional[FileModel] = None
        source_type = ""

        if visual_handles:
            resolved_assets = await _resolve_visual_handle_targets(
                db=context.db,
                visual_handles=visual_handles[:max_charts],
            )
            if not resolved_assets:
                return ToolResult(
                    success=False,
                    error="Visual handle is invalid or no longer available",
                    error_code="VISUAL_HANDLE_INVALID",
                )

            source_file_ids = {entry["source_file"].id for entry in resolved_assets}
            if source_file_id and source_file_id not in source_file_ids:
                return ToolResult(
                    success=False,
                    error="visual_handle does not belong to the provided source_file_id",
                    error_code="VISUAL_HANDLE_MISMATCH",
                )
            if len(source_file_ids) > 1:
                return ToolResult(
                    success=False,
                    error="All visual handles must come from the same source file",
                    error_code="VISUAL_HANDLE_MIXED_SOURCE",
                )

            source_file = resolved_assets[0]["source_file"]
            source_file_id = source_file.id
            source_perm = context.permissions.get(source_file_id, PermissionLevel.READ)
            if source_perm not in (PermissionLevel.READ, PermissionLevel.WRITE):
                return ToolResult(
                    success=False,
                    error="Source file requires read permission",
                    error_code="PERMISSION_DENIED",
                )

            markdown_blocks.append(f"## Charts from {source_file.name}")
            for idx, entry in enumerate(resolved_assets, start=1):
                visual_ref = entry["visual_ref"]
                image_url = visual_ref.get("image_url")
                if not image_url:
                    continue
                used_asset_count += 1
                page_no = visual_ref.get("page")
                markdown_blocks.append(f"### Chart {idx} (p.{page_no})" if page_no else f"### Chart {idx}")
                markdown_blocks.append(f"![Chart p.{page_no}]({image_url})" if page_no else f"![Chart {idx}]({image_url})")
                if visual_ref.get("anchor"):
                    markdown_blocks.append(f"> Anchor: {str(visual_ref['anchor'])[:220]}")
                if page_no:
                    markdown_blocks.append(f"Source: [{source_file.name} p.{page_no}]")
                else:
                    markdown_blocks.append(f"Source: [{source_file.name}]")
                inserted_visual_refs.append(visual_ref)

            if used_asset_count == 0:
                return ToolResult(
                    success=False,
                    error="Resolved visual handle did not contain a usable image asset",
                    error_code="VISUAL_HANDLE_INVALID",
                )
        else:
            source_result = await context.db.execute(select(FileModel).where(FileModel.id == source_file_id))
            source_file = source_result.scalar_one_or_none()
            if not source_file:
                return ToolResult(success=False, error="Source file not found", error_code="FILE_NOT_FOUND")

            source_perm = context.permissions.get(source_file_id, PermissionLevel.READ)
            if source_perm not in (PermissionLevel.READ, PermissionLevel.WRITE):
                return ToolResult(
                    success=False,
                    error="Source file requires read permission",
                    error_code="PERMISSION_DENIED",
                )

            source_type = str(source_file.file_type.value if hasattr(source_file.file_type, "value") else source_file.file_type)

        if not visual_handles and source_type == "pdf":
            asset_query = select(DocumentPageAsset).where(DocumentPageAsset.file_id == source_file_id)
            asset_result = await context.db.execute(asset_query)
            all_assets = asset_result.scalars().all()
            page_to_asset = {int(asset.page): asset for asset in all_assets if asset.image_path}
            selected_targets = await _resolve_pdf_targets(
                context=context,
                source_file=source_file,
                page_to_asset=page_to_asset,
                query=query,
                max_charts=max_charts,
                explicit_page=explicit_page,
                explicit_segment_id=explicit_segment_id,
            )

            if selected_targets:
                markdown_blocks.append(f"## Charts from {source_file.name}")
                for idx, target in enumerate(selected_targets, start=1):
                    asset = target["asset"]
                    segment = target.get("segment")
                    crop_asset = await _get_or_create_chart_crop_asset(
                        db=context.db,
                        source_file=source_file,
                        page_asset=asset,
                        segment=segment,
                    )
                    image_url = crop_asset.url if crop_asset and crop_asset.url else None
                    if not image_url:
                        continue
                    used_asset_count += 1
                    markdown_blocks.append(f"### Chart {idx} (p.{asset.page})")
                    markdown_blocks.append(f"![Chart p.{asset.page}]({image_url})")
                    if segment and segment.text:
                        markdown_blocks.append(f"> Anchor: {segment.text[:220]}")
                    markdown_blocks.append(f"Source: [{source_file.name} p.{asset.page}]")
                    if crop_asset:
                        inserted_visual_refs.append(
                            _build_visual_asset_ref(
                                asset=crop_asset,
                                source_file=source_file,
                                page_asset=asset,
                                segment=segment,
                            )
                        )
                if used_asset_count == 0:
                    return ToolResult(
                        success=False,
                        error="Could not produce a localized chart crop for this PDF request. Inspect the visual target first, then retry with page or segment_id.",
                        error_code="VISUAL_NOT_LOCALIZED",
                    )
            else:
                return ToolResult(
                    success=False,
                    error="Could not localize the requested chart/figure in this PDF. Use locate_relevant_segments first or provide page/segment_id.",
                    error_code="VISUAL_NOT_LOCALIZED",
                )

        if not markdown_blocks:
            fallback_used = True
            hit_result = await reader_orchestrator.locate_relevant_segments(
                db=context.db,
                query=query,
                file_ids=[source_file_id],
                top_k=max_charts,
            )
            hits = hit_result.get("hits", [])
            markdown_blocks.append(f"## Chart clues from {source_file.name}")
            if hits:
                for idx, hit in enumerate(hits[:max_charts], start=1):
                    location = f"p.{hit.page}" if hit.page is not None else (hit.section or "section")
                    text = (hit.text or "").strip()
                    markdown_blocks.append(f"### Candidate {idx} ({location})")
                    markdown_blocks.append(text[:600] + ("..." if len(text) > 600 else ""))
                    markdown_blocks.append(f"Source: [{source_file.name} {location}]")
            else:
                markdown_blocks.append("No chart-like snippets were found from source document.")

        appendix = "\n\n".join(markdown_blocks).strip()
        old_content = await _read_effective_text(context.db, note_file)
        new_content = _insert_markdown_block(
            content=old_content,
            block=appendix,
            insert_mode=insert_mode,
            target_heading=target_heading,
        )

        summary = f"Add {max_charts} chart blocks from {source_file.name}"
        diff_result = await _create_pending_diff_event(
            context=context,
            file=note_file,
            old_content=old_content,
            new_content=new_content,
            summary=summary,
        )
        if not diff_result.success:
            return diff_result

        payload = diff_result.data or {}
        payload.update(
            {
                "source_file_id": source_file_id,
                "source_file_name": source_file.name,
                "inserted_chart_count": used_asset_count,
                "used_asset_count": used_asset_count,
                "fallback_used": fallback_used,
                "insert_mode": insert_mode,
                "target_heading": target_heading or None,
                "inserted_visuals": inserted_visual_refs,
                "inserted_visual_handles": [item.get("handle") for item in inserted_visual_refs if item.get("handle")],
            }
        )
        return ToolResult(success=True, data=payload)


def _insert_markdown_block(
    *,
    content: str,
    block: str,
    insert_mode: str,
    target_heading: str,
) -> str:
    safe_content = content or ""
    safe_block = (block or "").strip()
    if not safe_block:
        return safe_content

    if insert_mode != "after_heading" or not target_heading:
        if not safe_content.strip():
            return safe_block + "\n"
        if safe_content.endswith("\n\n"):
            return safe_content + safe_block + "\n"
        if safe_content.endswith("\n"):
            return safe_content + "\n" + safe_block + "\n"
        return safe_content + "\n\n" + safe_block + "\n"

    lines = safe_content.splitlines()
    heading_index: Optional[int] = None
    heading_norm = target_heading.strip().lower()
    for idx, line in enumerate(lines):
        stripped = line.strip()
        if not stripped.startswith("#"):
            continue
        title = stripped.lstrip("#").strip().lower()
        if title == heading_norm:
            heading_index = idx
            break

    if heading_index is None:
        return _insert_markdown_block(content=safe_content, block=safe_block, insert_mode="append", target_heading="")

    insert_at = heading_index + 1
    new_lines = lines[:insert_at] + ["", safe_block, ""] + lines[insert_at:]
    return "\n".join(new_lines).rstrip() + "\n"
