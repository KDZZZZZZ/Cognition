import json
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List


REGISTRY_ROOT = Path(__file__).resolve().parent.parent / "agent_registry"
REGISTRY_INDEX_PATH = REGISTRY_ROOT / "index.json"


@lru_cache(maxsize=1)
def load_agent_registry() -> Dict[str, Any]:
    with REGISTRY_INDEX_PATH.open("r", encoding="utf-8") as fh:
        return json.load(fh)


@lru_cache(maxsize=64)
def load_registry_text(relative_path: str) -> str:
    path = REGISTRY_ROOT / relative_path
    with path.open("r", encoding="utf-8") as fh:
        return fh.read().strip()


def registry_summary_for_router(registry: Dict[str, Any]) -> Dict[str, Any]:
    modes = {}
    for mode_id, item in (registry.get("modes") or {}).items():
        modes[mode_id] = {
            "workflow_ids": item.get("workflow_ids") or [],
            "template_ids": item.get("template_ids") or [],
            "default_tool_groups": item.get("default_tool_groups") or [],
        }

    return {
        "version": registry.get("version", 1),
        "modes": modes,
        "workflows": sorted((registry.get("workflows") or {}).keys()),
        "templates": sorted((registry.get("templates") or {}).keys()),
    }


def _normalize_id_list(raw: Any) -> List[str]:
    if not isinstance(raw, list):
        return []
    out: List[str] = []
    for item in raw:
        text = str(item or "").strip()
        if text and text not in out:
            out.append(text)
    return out


def sanitize_router_mode(router_result: Dict[str, Any], registry: Dict[str, Any]) -> Dict[str, Any]:
    modes = registry.get("modes") or {}
    mode_payload = router_result.get("mode") if isinstance(router_result.get("mode"), dict) else {}
    primary = str(mode_payload.get("primary") or "").strip()
    if primary not in modes:
        primary = "general_assistant"

    mixed = [item for item in _normalize_id_list(mode_payload.get("mixed")) if item in modes and item != primary]
    raw_weights = mode_payload.get("weights") if isinstance(mode_payload.get("weights"), dict) else {}
    weights: Dict[str, float] = {}
    for key, value in raw_weights.items():
        if key not in modes:
            continue
        try:
            weights[key] = max(0.0, min(1.0, float(value)))
        except Exception:
            continue
    weights.setdefault(primary, 1.0)
    for item in mixed:
        weights.setdefault(item, 0.5)
    return {"primary": primary, "mixed": mixed, "weights": weights}


def resolve_registry_selection(router_result: Dict[str, Any], registry: Dict[str, Any]) -> Dict[str, Any]:
    modes = registry.get("modes") or {}
    workflows = registry.get("workflows") or {}
    templates = registry.get("templates") or {}
    mode_payload = sanitize_router_mode(router_result, registry)

    ordered_modes: List[str] = []
    primary = mode_payload["primary"]
    if primary:
        ordered_modes.append(primary)
    mixed = sorted(
        mode_payload.get("mixed") or [],
        key=lambda item: float((mode_payload.get("weights") or {}).get(item, 0.0)),
        reverse=True,
    )
    for item in mixed:
        if item not in ordered_modes:
            ordered_modes.append(item)

    workflow_ids: List[str] = []
    template_ids: List[str] = []

    if "general" in workflows:
        workflow_ids.append("general")

    requested_output = router_result.get("output") if isinstance(router_result.get("output"), dict) else {}
    requested_workflows = _normalize_id_list(requested_output.get("workflow_ids"))
    requested_templates = _normalize_id_list(requested_output.get("template_ids"))

    for mode_id in ordered_modes:
        mode_def = modes.get(mode_id) or {}
        for workflow_id in mode_def.get("workflow_ids") or []:
            if workflow_id in workflows and workflow_id not in workflow_ids:
                workflow_ids.append(workflow_id)
        for template_id in mode_def.get("template_ids") or []:
            if template_id in templates and template_id not in template_ids:
                template_ids.append(template_id)

    for workflow_id in requested_workflows:
        if workflow_id in workflows and workflow_id not in workflow_ids:
            workflow_ids.append(workflow_id)
    for template_id in requested_templates:
        if template_id in templates and template_id not in template_ids:
            template_ids.append(template_id)

    for workflow_id, item in workflows.items():
        if item.get("required") and workflow_id not in workflow_ids:
            workflow_ids.insert(0, workflow_id)

    resolved_workflows = [
        {
            "id": workflow_id,
            "priority": int((workflows.get(workflow_id) or {}).get("priority") or 0),
            "text": load_registry_text((workflows.get(workflow_id) or {}).get("path")),
        }
        for workflow_id in workflow_ids
        if workflow_id in workflows
    ]
    resolved_workflows.sort(key=lambda item: item["priority"], reverse=True)

    resolved_templates = [
        {
            "id": template_id,
            "priority": int((templates.get(template_id) or {}).get("priority") or 0),
            "text": load_registry_text((templates.get(template_id) or {}).get("path")),
        }
        for template_id in template_ids
        if template_id in templates
    ]
    resolved_templates.sort(key=lambda item: item["priority"], reverse=True)

    return {
        "mode": mode_payload,
        "workflow_ids": [item["id"] for item in resolved_workflows],
        "template_ids": [item["id"] for item in resolved_templates],
        "workflows": resolved_workflows,
        "templates": resolved_templates,
    }
