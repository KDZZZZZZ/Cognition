import json
import re
from typing import Any, Dict, List, Optional

from app.prompts.system_prompts import SystemPrompts
from app.services.llm_service import llm_service
from app.services.step_catalog_service import (
    StepCatalogError,
    catalog_summary_for_orchestrator,
    fallback_recipe,
    get_catalog_version,
    get_step_definition,
    sanitize_step_sequence,
)
from app.services.token_budget_service import short_text


TEXTBOOK_HINTS = {"教材", "theorem", "definition", "chapter", "section", "lemma"}
PAPER_HINTS = {"paper", "论文", "abstract", "experiment", "method", "baseline", "arxiv"}
SEARCH_HINTS = {"survey", "搜集", "检索", "related work", "literature", "candidate"}
WRITE_HINTS = {"note", "笔记", "write", "写入", "整理", "append", "update"}
QA_HINTS = {"为什么", "证明", "推导", "对不对", "check", "validate", "证明思路"}
REPRO_HINTS = {"reproduce", "复现", "implementation", "训练", "评测"}
NOTE_FOLLOWUP_HINTS = {
    "当前正在看的 note",
    "当前 note",
    "当前note",
    "最新内容",
    "继续补一句",
    "补一句",
    "续写",
    "继续写",
    "继续补",
    "复述第二条要点",
}
NEGATIVE_WRITE_HINTS = {"不要写", "别写", "不写笔记", "不要修改", "不要写入"}
TOOL_EXECUTION_HINTS = {
    "调用工具",
    "用工具",
    "tool call",
    "call tool",
    "use tools",
    "按顺序调用",
    "依次调用",
    "工具审计",
    "tool audit",
}
TEXTBOOK_NOTE_FOLLOWUP_STEPS = ["TB_WRITE_NOTES", "QUALITY_REVIEW", "CONTEXT_COMPACT"]


class OrchestratorError(RuntimeError):
    pass


def _extract_first_json_object(text: str) -> Optional[Dict[str, Any]]:
    if not text:
        return None

    code_block_match = re.search(r"```json\s*(\{.*\})\s*```", text, flags=re.DOTALL)
    if code_block_match:
        try:
            parsed = json.loads(code_block_match.group(1))
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            pass

    depth = 0
    start = -1
    for idx, ch in enumerate(text):
        if ch == "{":
            if depth == 0:
                start = idx
            depth += 1
        elif ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start >= 0:
                    try:
                        parsed = json.loads(text[start : idx + 1])
                    except Exception:
                        start = -1
                        continue
                    if isinstance(parsed, dict):
                        return parsed
                    start = -1
    return None


def _contains_any(message: str, candidates: set[str]) -> bool:
    lowered = (message or "").lower()
    return any(token.lower() in lowered for token in candidates)


def _message_explicitly_requests_tool_execution(message: str) -> bool:
    lowered = (message or "").lower()
    if any(token.lower() in lowered for token in TOOL_EXECUTION_HINTS):
        return True
    has_tool_token = ("工具" in lowered) or ("tool" in lowered)
    has_action_token = any(token in lowered for token in ("调用", "先调用", "先用", "先使用", "call", "use"))
    return has_tool_token and has_action_token


def fallback_task_registry(message: str, *, permitted_files_info: Dict[str, Dict[str, str]]) -> Dict[str, Any]:
    goal = short_text(message or "Handle current request", 280)
    steps: List[str]

    if _contains_any(message, PAPER_HINTS):
        if _contains_any(message, SEARCH_HINTS):
            steps = fallback_recipe("paper_search")
        else:
            steps = fallback_recipe("paper_accumulation")
            if _contains_any(message, REPRO_HINTS) and "P_REPRO_PLAN" not in steps:
                insert_at = len(steps) - 2 if len(steps) >= 2 else len(steps)
                steps.insert(insert_at, "P_REPRO_PLAN")
    elif _contains_any(message, TEXTBOOK_HINTS):
        steps = fallback_recipe("textbook_qa" if _contains_any(message, QA_HINTS) else "textbook_long_scope")
    else:
        steps = fallback_recipe("general_problem")

    if _contains_any(message, WRITE_HINTS) and "P_SUMMARY_CARD" in steps and permitted_files_info:
        # Keep write-capable paper accumulation as a single task; note writing remains in the step itself.
        pass

    return {
        "tasks": [
            {
                "goal": goal,
                "steps": steps,
            }
        ]
    }


def sanitize_task_registry_payload(raw: Optional[Dict[str, Any]], *, message: str, permitted_files_info: Dict[str, Dict[str, str]]) -> Dict[str, Any]:
    payload = raw if isinstance(raw, dict) else {}
    raw_tasks = payload.get("tasks") if isinstance(payload.get("tasks"), list) else []
    tasks: List[Dict[str, Any]] = []

    for index, item in enumerate(raw_tasks):
        if not isinstance(item, dict):
            continue
        goal = short_text(str(item.get("goal") or "").strip(), 280)
        steps = sanitize_step_sequence(item.get("steps"))
        if not goal or not steps:
            continue
        if _step_requires_prior_outputs(steps[0]):
            steps = fallback_task_registry(message, permitted_files_info=permitted_files_info)["tasks"][0]["steps"]
        tasks.append({
            "goal": goal,
            "steps": steps,
        })
        if index >= 5:
            break

    if not tasks:
        return fallback_task_registry(message, permitted_files_info=permitted_files_info)

    return {"tasks": tasks}


def _step_requires_prior_outputs(step_type: str) -> bool:
    try:
        step_def = get_step_definition(step_type)
    except Exception:
        return False
    required_inputs = step_def.get("required_inputs") if isinstance(step_def, dict) else []
    return isinstance(required_inputs, list) and "prior_outputs" in required_inputs


def _should_override_to_textbook_note_followup(
    *,
    message: str,
    viewport: Optional[Dict[str, Any]],
    permissions: Dict[str, str],
    permitted_files_info: Dict[str, Dict[str, str]],
    orchestrator_result: Dict[str, Any],
) -> bool:
    tasks = orchestrator_result.get("tasks") if isinstance(orchestrator_result.get("tasks"), list) else []
    if not tasks or not isinstance(tasks[0], dict):
        return False

    first_steps = [str(item) for item in tasks[0].get("steps") or []]
    if not first_steps or any(not step.startswith("GEN_") for step in first_steps):
        return False

    viewport_file_id = str((viewport or {}).get("file_id") or "").strip()
    if not viewport_file_id:
        return False
    if str((permissions or {}).get(viewport_file_id) or "") != "write":
        return False
    if str((permitted_files_info.get(viewport_file_id) or {}).get("type") or "") != "md":
        return False

    lowered = (message or "").lower()
    if any(token in lowered for token in NEGATIVE_WRITE_HINTS):
        return False
    if not _contains_any(message, {"note", "笔记"}):
        return False
    if not _contains_any(message, NOTE_FOLLOWUP_HINTS):
        return False

    readable_support_files = [
        file_id
        for file_id, info in (permitted_files_info or {}).items()
        if file_id != viewport_file_id
        and str((permissions or {}).get(file_id) or "") in {"read", "write"}
        and str((info or {}).get("type") or "") in {"pdf", "docx", "txt", "web"}
    ]
    return bool(readable_support_files)


def _apply_task_registry_overrides(
    *,
    orchestrator_result: Dict[str, Any],
    message: str,
    viewport: Optional[Dict[str, Any]],
    permissions: Dict[str, str],
    permitted_files_info: Dict[str, Dict[str, str]],
) -> Dict[str, Any]:
    if _message_explicitly_requests_tool_execution(message):
        return {
            "tasks": [
                {
                    "goal": short_text(message or "Execute requested tool workflow", 280),
                    "steps": ["GEN_ANSWER", "GEN_VERIFY", "GEN_FOLLOWUP"],
                }
            ]
        }

    if _should_override_to_textbook_note_followup(
        message=message,
        viewport=viewport,
        permissions=permissions,
        permitted_files_info=permitted_files_info,
        orchestrator_result=orchestrator_result,
    ):
        tasks = list(orchestrator_result.get("tasks") or [])
        first_task = dict(tasks[0])
        first_task["goal"] = short_text(message or first_task.get("goal") or "", 280)
        first_task["steps"] = list(TEXTBOOK_NOTE_FOLLOWUP_STEPS)
        tasks[0] = first_task
        return {"tasks": tasks}
    return orchestrator_result


async def orchestrate_request(
    *,
    message: str,
    permitted_files_info: Dict[str, Dict[str, str]],
    permissions: Dict[str, str],
    viewport: Optional[Dict[str, Any]],
    active_registry: Optional[Dict[str, Any]],
    model: Optional[str] = None,
) -> Dict[str, Any]:
    visible_files = [
        {
            "file_id": file_id,
            "name": info.get("name"),
            "type": info.get("type"),
            "permission": permissions.get(file_id, "read"),
        }
        for file_id, info in permitted_files_info.items()
    ]

    prompt = {
        "catalog": catalog_summary_for_orchestrator(),
        "visible_files": visible_files[:24],
        "viewport": viewport,
        "active_registry": active_registry,
        "user_request": message,
    }

    fallback = fallback_task_registry(message, permitted_files_info=permitted_files_info)
    parsed: Optional[Dict[str, Any]] = None
    warning: Optional[str] = None

    try:
        response = await llm_service.chat_completion(
            messages=[{"role": "user", "content": json.dumps(prompt, ensure_ascii=False, indent=2)}],
            model=model,
            tools=None,
            system_prompt=SystemPrompts.ORCHESTRATOR_SYSTEM_PROMPT,
        )
        parsed = _extract_first_json_object(str(response.get("content") or ""))
    except StepCatalogError:
        raise
    except Exception as exc:
        warning = f"orchestrator_failed:{exc}"

    orchestrator_result = sanitize_task_registry_payload(
        parsed or fallback,
        message=message,
        permitted_files_info=permitted_files_info,
    )
    orchestrator_result = _apply_task_registry_overrides(
        orchestrator_result=orchestrator_result,
        message=message,
        viewport=viewport,
        permissions=permissions,
        permitted_files_info=permitted_files_info,
    )

    return {
        "orchestrator_result": orchestrator_result,
        "catalog_version": get_catalog_version(),
        "warning": warning,
        "fallback_used": parsed is None,
    }
