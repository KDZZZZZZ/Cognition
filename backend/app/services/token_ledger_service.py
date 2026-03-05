import json
from typing import Any, Dict, Iterable, List, Sequence, Tuple

from app.config import settings
from app.services.token_budget_service import estimate_messages_tokens, estimate_tokens, short_text


def estimate_object_tokens(value: Any) -> int:
    try:
        text = json.dumps(value, ensure_ascii=False)
    except Exception:
        text = str(value)
    return estimate_tokens(text)


def build_bucket_caps(context_window_tokens: int) -> Dict[str, Any]:
    target_ratio = float(settings.COMPACT_TRIGGER_RATIO or 0.8)
    target_tokens = max(1, int(context_window_tokens * target_ratio))
    runtime_cap = max(1, int(target_tokens * float(settings.RUNTIME_BUCKET_RATIO or 0.3)))
    raw_cap = max(1, int(target_tokens * float(settings.RAW_DIALOGUE_BUCKET_RATIO or 0.3)))
    compact_cap = max(1, int(target_tokens * float(settings.COMPACT_DIALOGUE_BUCKET_RATIO or 0.3)))
    viewport_cap = max(1, int(target_tokens * float(settings.VIEWPORT_MEMORY_BUCKET_RATIO or 0.1)))
    return {
        "context_window_tokens": context_window_tokens,
        "input_target_ratio": target_ratio,
        "input_target_tokens": target_tokens,
        "buckets": {
            "runtime_bucket": {"cap": runtime_cap},
            "raw_dialogue_bucket": {"cap": raw_cap},
            "compact_dialogue_bucket": {"cap": compact_cap},
            "viewport_doc_memory_bucket": {"cap": viewport_cap},
        },
    }


def estimate_tool_schema_tokens(tools: Sequence[Dict[str, Any]]) -> int:
    if not tools:
        return 0
    return estimate_object_tokens(list(tools))


def trim_text_to_token_budget(text: str, budget_tokens: int) -> str:
    text = str(text or "").strip()
    if not text or budget_tokens <= 0:
        return ""

    if estimate_tokens(text) <= budget_tokens:
        return text

    lo = 1
    hi = len(text)
    best = ""
    while lo <= hi:
        mid = (lo + hi) // 2
        candidate = short_text(text, mid)
        candidate_tokens = estimate_tokens(candidate)
        if candidate_tokens <= budget_tokens:
            best = candidate
            lo = mid + 1
        else:
            hi = mid - 1

    if best:
        return best

    candidate = short_text(text, min(len(text), max(8, budget_tokens * 2)))
    while candidate and estimate_tokens(candidate) > budget_tokens:
        candidate = short_text(candidate, max(1, len(candidate) // 2))
    return candidate


def fit_sections_to_budget(sections: Iterable[Dict[str, Any]], budget_tokens: int) -> Tuple[List[Dict[str, Any]], int, bool]:
    selected: List[Dict[str, Any]] = []
    used = 0
    trimmed = False
    for section in sections:
        text = str(section.get("text") or "").strip()
        if not text:
            continue
        tokens = estimate_tokens(text)
        remaining_tokens = budget_tokens - used
        if remaining_tokens <= 0:
            trimmed = True
            continue

        if tokens <= remaining_tokens:
            selected.append({**section, "text": text, "tokens": tokens})
            used += tokens
            continue

        reduced = trim_text_to_token_budget(text, remaining_tokens)
        reduced_tokens = estimate_tokens(reduced)
        if reduced and reduced_tokens <= remaining_tokens:
            selected.append({**section, "text": reduced, "tokens": reduced_tokens})
            used += reduced_tokens
        trimmed = True
    return selected, used, trimmed


def pack_recent_messages(messages: Sequence[Dict[str, Any]], budget_tokens: int) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], int]:
    selected: List[Dict[str, Any]] = []
    used = 0
    overflow: List[Dict[str, Any]] = []
    for message in reversed(list(messages)):
        item = {"role": str(message.get("role") or ""), "content": str(message.get("content") or "")}
        tokens = estimate_messages_tokens([item])
        if used + tokens <= budget_tokens:
            selected.append(item)
            used += tokens
        else:
            overflow.append(item)
    selected.reverse()
    overflow.reverse()
    return selected, overflow, used


def finalize_budget_meta(
    *,
    caps: Dict[str, Any],
    runtime_used: int,
    raw_used: int,
    compact_used: int,
    viewport_used: int,
    tool_schema_tokens: int,
    total_input_tokens: int,
    triggered: bool,
    reason: str,
) -> Dict[str, Any]:
    context_window_tokens = max(1, int(caps.get("context_window_tokens") or 1))
    input_target_tokens = max(1, int(caps.get("input_target_tokens") or 1))

    def _ratio(numerator: int, denominator: int) -> float:
        return round(float(numerator) / float(max(1, denominator)), 6)

    def _level(window_ratio: float) -> str:
        if window_ratio >= 0.95:
            return "critical"
        if window_ratio >= 0.8:
            return "high"
        if window_ratio >= 0.6:
            return "warn"
        return "safe"

    bucket_meta = dict(caps.get("buckets") or {})
    bucket_meta["runtime_bucket"]["used"] = runtime_used
    bucket_meta["raw_dialogue_bucket"]["used"] = raw_used
    bucket_meta["compact_dialogue_bucket"]["used"] = compact_used
    bucket_meta["viewport_doc_memory_bucket"]["used"] = viewport_used
    bucket_usage = {
        name: {
            "ratio": _ratio(int(info.get("used") or 0), int(info.get("cap") or 1)),
        }
        for name, info in bucket_meta.items()
    }
    window_usage_ratio = _ratio(total_input_tokens, context_window_tokens)
    target_usage_ratio = _ratio(total_input_tokens, input_target_tokens)
    return {
        "triggered": triggered,
        "reason": reason,
        "input_target_ratio": caps.get("input_target_ratio"),
        "input_target_tokens": input_target_tokens,
        "context_window_tokens": context_window_tokens,
        "total_input_tokens": total_input_tokens,
        "tool_schema_tokens": tool_schema_tokens,
        "buckets": bucket_meta,
        "bucket_usage": bucket_usage,
        "window_usage": {
            "ratio": window_usage_ratio,
            "target_ratio": target_usage_ratio,
            "status": _level(window_usage_ratio),
        },
    }
