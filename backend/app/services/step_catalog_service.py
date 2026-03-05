import json
from copy import deepcopy
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List


CATALOG_ROOT = Path(__file__).resolve().parent.parent / "step_catalog"
INDEX_PATH = CATALOG_ROOT / "index.json"
GLOBAL_RULES_PATH = CATALOG_ROOT / "global_rules.md"
GEN_QA_ALIAS_EXPANSION = ["GEN_PARSE", "GEN_ANSWER", "GEN_VERIFY", "GEN_FOLLOWUP"]


class StepCatalogError(RuntimeError):
    pass


@lru_cache(maxsize=128)
def _load_text(path: Path) -> str:
    return path.read_text(encoding="utf-8").strip()


@lru_cache(maxsize=1)
def load_step_catalog() -> Dict[str, Any]:
    if not INDEX_PATH.exists():
        raise StepCatalogError(f"step catalog index missing: {INDEX_PATH}")
    raw = json.loads(INDEX_PATH.read_text(encoding="utf-8"))
    steps = raw.get("steps") or {}
    if not isinstance(steps, dict) or not steps:
        raise StepCatalogError("step catalog contains no steps")

    loaded_steps: Dict[str, Dict[str, Any]] = {}
    alias_map: Dict[str, str] = {}
    for step_type, metadata in steps.items():
        step_dir = CATALOG_ROOT / "steps" / step_type
        required_paths = {
            "rules_text": step_dir / "rules.md",
            "method_text": step_dir / "method.md",
            "template_text": step_dir / "template.md",
            "self_check_text": step_dir / "self_check.md",
        }
        missing = [str(path) for path in required_paths.values() if not path.exists()]
        if missing:
            raise StepCatalogError(f"step {step_type} missing files: {', '.join(missing)}")

        merged = dict(metadata or {})
        merged["type"] = step_type
        for key, path in required_paths.items():
            merged[key] = _load_text(path)
        merged.setdefault("aliases", [])
        merged.setdefault("required_inputs", [])
        merged.setdefault("minimum_substitutes", {})
        merged.setdefault("allowed_tool_groups", [])
        merged.setdefault("writeback_policy", "never")
        merged.setdefault("result_kind", "answer")
        loaded_steps[step_type] = merged
        for alias in merged.get("aliases") or []:
            alias_text = str(alias or "").strip()
            if alias_text:
                alias_map[alias_text] = step_type

    recipes = raw.get("recipes") or {}
    for recipe_name, step_list in recipes.items():
        if not isinstance(step_list, list) or not step_list:
            raise StepCatalogError(f"recipe {recipe_name} is empty")
        for item in step_list:
            if str(item) not in loaded_steps:
                raise StepCatalogError(f"recipe {recipe_name} references unknown step {item}")

    return {
        "version": int(raw.get("version") or 1),
        "recipes": recipes,
        "steps": loaded_steps,
        "global_rules_text": _load_text(GLOBAL_RULES_PATH),
        "aliases": alias_map,
    }


def catalog_summary_for_orchestrator() -> Dict[str, Any]:
    catalog = load_step_catalog()
    return {
        "version": catalog["version"],
        "recipes": catalog["recipes"],
        "steps": {
            step_type: {
                "summary": spec.get("summary"),
                "category": spec.get("category"),
                "required_inputs": spec.get("required_inputs") or [],
                "writeback_policy": spec.get("writeback_policy"),
            }
            for step_type, spec in (catalog.get("steps") or {}).items()
        },
    }


def get_catalog_version() -> int:
    return int(load_step_catalog().get("version") or 1)


def get_global_rules_text() -> str:
    return str(load_step_catalog().get("global_rules_text") or "")


def get_step_definition(step_type: str) -> Dict[str, Any]:
    catalog = load_step_catalog()
    resolved = resolve_step_alias(step_type)
    spec = (catalog.get("steps") or {}).get(resolved)
    if not spec:
        raise StepCatalogError(f"unknown step type: {step_type}")
    return deepcopy(spec)


def resolve_step_alias(step_type: str) -> str:
    normalized = str(step_type or "").strip()
    if normalized == "GEN_QA":
        return normalized
    catalog = load_step_catalog()
    return str((catalog.get("aliases") or {}).get(normalized) or normalized)


def sanitize_step_sequence(raw_steps: Any) -> List[str]:
    catalog = load_step_catalog()
    known_steps = set((catalog.get("steps") or {}).keys())
    out: List[str] = []
    if not isinstance(raw_steps, list):
        return out
    for item in raw_steps:
        step_type = resolve_step_alias(str(item or "").strip())
        if step_type == "GEN_QA":
            for expanded in GEN_QA_ALIAS_EXPANSION:
                if expanded not in out:
                    out.append(expanded)
            continue
        if step_type in known_steps and step_type not in out:
            out.append(step_type)
    return out


def fallback_recipe(recipe_name: str) -> List[str]:
    catalog = load_step_catalog()
    steps = (catalog.get("recipes") or {}).get(recipe_name) or []
    return [str(item) for item in steps if str(item) in (catalog.get("steps") or {})]
