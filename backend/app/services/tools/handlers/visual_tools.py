from pathlib import Path
from typing import Any, Dict, List, Optional

from sqlalchemy import select

from app.config import settings
from app.models import DocumentPageAsset, File as FileModel, FileType
from app.services.llm_service import llm_service
from app.services.token_budget_service import short_text
from app.services.tools.base import BaseTool, PermissionLevel, ToolContext, ToolResult, ToolValidationError
from app.services.tools.handlers.chart_tools import (
    _build_visual_asset_ref,
    _get_or_create_chart_crop_asset,
    _resolve_pdf_targets,
)
from app.services.visual_retrieval_service import visual_retrieval_service


def _upload_url_to_path(url: Optional[str]) -> Optional[Path]:
    normalized = str(url or "").strip()
    if not normalized.startswith("/uploads/"):
        return None
    relative = normalized[len("/uploads/") :].lstrip("/")
    return Path(settings.UPLOAD_DIR) / relative


class InspectDocumentVisualTool(BaseTool):
    @property
    def name(self) -> str:
        return "inspect_document_visual"

    @property
    def description(self) -> str:
        return (
            "Inspect a localized PDF page/chart/table with a multimodal model and return a grounded visual description. "
            "Use after locate_relevant_segments when the answer depends on figure/table content."
        )

    @property
    def required_permission(self) -> PermissionLevel:
        return PermissionLevel.READ

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "file_id": {"type": "string", "description": "Target PDF file ID"},
                "query": {"type": "string", "description": "Question about the figure/table or visual content"},
                "page": {
                    "type": "integer",
                    "description": "Optional exact page number when already known",
                },
                "segment_id": {
                    "type": "string",
                    "description": "Optional exact anchor segment ID from locate_relevant_segments",
                },
                "max_images": {
                    "type": "integer",
                    "default": 1,
                    "description": "Maximum number of localized images/crops to inspect",
                },
            },
            "required": ["file_id", "query"],
        }

    def validate_arguments(self, arguments: Dict[str, Any]) -> None:
        super().validate_arguments(arguments)
        query = str(arguments.get("query") or "").strip()
        if not query:
            raise ToolValidationError(self.name, "query", "query cannot be empty")
        page = arguments.get("page")
        if page is not None and int(page) < 1:
            raise ToolValidationError(self.name, "page", "page must be >= 1")
        max_images = int(arguments.get("max_images", 1))
        if max_images < 1 or max_images > 4:
            raise ToolValidationError(self.name, "max_images", "max_images must be in [1,4]")

    async def execute(self, arguments: Dict[str, Any], context: ToolContext) -> ToolResult:
        if not llm_service.supports_vision(settings.VISUAL_RETRIEVAL_MODEL):
            return ToolResult(
                success=False,
                error="Vision-capable model is not configured",
                error_code="VISION_NOT_CONFIGURED",
            )

        file_id = str(arguments["file_id"]).strip()
        query = str(arguments["query"]).strip()
        explicit_page = int(arguments["page"]) if arguments.get("page") is not None else None
        explicit_segment_id = str(arguments.get("segment_id") or "").strip() or None
        max_images = max(1, min(4, int(arguments.get("max_images", 1))))

        file_result = await context.db.execute(select(FileModel).where(FileModel.id == file_id))
        source_file = file_result.scalar_one_or_none()
        if not source_file:
            return ToolResult(success=False, error="Source file not found", error_code="FILE_NOT_FOUND")

        source_type = str(source_file.file_type.value if hasattr(source_file.file_type, "value") else source_file.file_type)
        if source_type != FileType.PDF.value:
            return ToolResult(
                success=False,
                error="inspect_document_visual currently supports PDF files only",
                error_code="FILE_NOT_SUPPORTED",
            )

        await visual_retrieval_service.ensure_page_assets(db=context.db, file_id=file_id)
        asset_result = await context.db.execute(
            select(DocumentPageAsset).where(DocumentPageAsset.file_id == file_id)
        )
        all_assets = asset_result.scalars().all()
        page_to_asset = {int(asset.page): asset for asset in all_assets if asset.image_path or asset.image_url}
        if not page_to_asset:
            return ToolResult(
                success=False,
                error="No rendered page assets are available for this PDF yet",
                error_code="VISUAL_ASSET_NOT_READY",
            )

        targets = await _resolve_pdf_targets(
            context=context,
            source_file=source_file,
            page_to_asset=page_to_asset,
            query=query,
            max_charts=max_images,
            explicit_page=explicit_page,
            explicit_segment_id=explicit_segment_id,
        )
        if not targets:
            return ToolResult(
                success=False,
                error="Could not localize a relevant visual region in this PDF",
                error_code="VISUAL_NOT_LOCALIZED",
            )

        content: List[Dict[str, Any]] = [
            {
                "type": "text",
                "text": (
                    "You are inspecting a PDF figure/table for grounded question answering.\n"
                    "Answer in Chinese using only visible evidence from the provided images and short anchors.\n"
                    "If the image is unclear or the requested detail is not visible, say exactly what is visible and what remains uncertain.\n"
                    "Do not invent labels, values, or conclusions.\n"
                    f"User question: {query}"
                ),
            }
        ]
        inspected: List[Dict[str, Any]] = []
        visual_assets: List[Dict[str, Any]] = []

        for idx, target in enumerate(targets[:max_images], start=1):
            asset = target["asset"]
            segment = target.get("segment")
            crop_asset = await _get_or_create_chart_crop_asset(
                db=context.db,
                source_file=source_file,
                page_asset=asset,
                segment=segment,
            )
            image_url = crop_asset.url if crop_asset and crop_asset.url else None
            data_path = _upload_url_to_path(image_url) if image_url else None
            data_url = visual_retrieval_service._to_data_url(data_path) if data_path else None
            source_kind = "crop" if data_url else "page_image"

            if not data_url and asset.image_path:
                data_url = visual_retrieval_service._to_data_url(Path(asset.image_path))
            if not data_url:
                continue

            anchor_text = short_text(
                (segment.text if segment and segment.text else asset.text_anchor) or "",
                360,
            )
            segment_type = getattr(segment, "segment_type", None)
            content.append(
                {
                    "type": "text",
                    "text": (
                        f"Candidate {idx}: file={source_file.name}, page={asset.page}, "
                        f"segment_type={segment_type or 'page_anchor'}, anchor={anchor_text or 'n/a'}"
                    ),
                }
            )
            content.append({"type": "image_url", "image_url": {"url": data_url}})
            inspected.append(
                {
                    "page": int(asset.page),
                    "segment_id": getattr(segment, "id", None),
                    "segment_type": segment_type,
                    "anchor": anchor_text or None,
                    "source": source_kind,
                }
            )
            if crop_asset:
                visual_assets.append(
                    _build_visual_asset_ref(
                        asset=crop_asset,
                        source_file=source_file,
                        page_asset=asset,
                        segment=segment,
                    )
                )

        if not inspected:
            return ToolResult(
                success=False,
                error="Could not prepare visual payload for model inspection",
                error_code="VISUAL_PAYLOAD_UNAVAILABLE",
            )

        content.append(
            {
                "type": "text",
                "text": "Provide a concise grounded answer first, then optionally note the key visible cues in one short sentence.",
            }
        )
        response = await llm_service.chat_completion(
            messages=[{"role": "user", "content": content}],
            model=settings.VISUAL_RETRIEVAL_MODEL,
            stream=False,
        )

        return ToolResult(
            success=True,
            data={
                "file_id": file_id,
                "file_name": source_file.name,
                "query": query,
                "answer": str(response.get("content") or "").strip(),
                "model": response.get("model"),
                "inspected": inspected,
                "visual_assets": visual_assets,
                "recommended_visual_handle": visual_assets[0]["handle"] if visual_assets else None,
                "count": len(inspected),
            },
        )
