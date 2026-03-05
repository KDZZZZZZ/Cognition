import json
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import ChatMessage, ConversationCompaction
from app.services.token_budget_service import estimate_messages_tokens, estimate_tokens, short_text


COMPACT_RULE_TEXT = (
    "1) 会改变后续行为的状态：当前目标、正在处理哪本书/哪一节、下一步要干啥。\n"
    "2) 不可轻易再取回的关键信息：用户刚刚给的口头约束、临时决定、未写入笔记的结论。"
)

REQUIRED_COMPACTION_FIELDS = {
    "summary",
    "key_state",
    "hard_constraints",
    "temporary_decisions",
    "unwritten_conclusions",
    "open_loops",
}

REQUIRED_KEY_STATE_FIELDS = {
    "current_goal",
    "current_material",
    "current_section",
    "next_step",
}


def _safe_json(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, indent=2)
    except Exception:
        return "{}"


def _safe_json_compact(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except Exception:
        return "{}"


def _extract_first_json_object(text: str) -> Optional[Dict[str, Any]]:
    if not text:
        return None

    candidates: List[str] = []
    if "```json" in text:
        for chunk in text.split("```json")[1:]:
            body = chunk.split("```", 1)[0].strip()
            if body:
                candidates.append(body)

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
                    candidates.append(text[start : idx + 1])
                    start = -1

    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except Exception:
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def _normalize_string_list(raw: Any, *, limit: int = 12) -> List[str]:
    if not isinstance(raw, list):
        return []
    out: List[str] = []
    for item in raw:
        text = str(item or "").strip()
        if text:
            out.append(short_text(text, 300))
        if len(out) >= limit:
            break
    return out


def _default_key_state(memory_epoch: Optional[Dict[str, Any]]) -> Dict[str, Optional[str]]:
    dialogue = (memory_epoch or {}).get("dialogue") if isinstance(memory_epoch, dict) else {}
    current_focus = dialogue.get("current_focus") if isinstance(dialogue, dict) else {}
    return {
        "current_goal": short_text(str(dialogue.get("latest_user_goal") or ""), 240) if isinstance(dialogue, dict) else None,
        "current_material": short_text(str((current_focus or {}).get("book") or ""), 180) if isinstance(current_focus, dict) else None,
        "current_section": short_text(str((current_focus or {}).get("section") or ""), 180) if isinstance(current_focus, dict) else None,
        "next_step": short_text(str(dialogue.get("next_action") or ""), 240) if isinstance(dialogue, dict) else None,
    }


def _normalize_latest_snapshot(
    raw: Optional[Dict[str, Any]],
    *,
    compaction_id: Optional[str],
    sequence: int,
    fallback_summary: Optional[str],
    memory_epoch: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    key_state_default = _default_key_state(memory_epoch)
    raw = raw if isinstance(raw, dict) else {}

    key_state_raw = raw.get("key_state") if isinstance(raw.get("key_state"), dict) else {}
    key_state = {
        "current_goal": short_text(str(key_state_raw.get("current_goal") or key_state_default.get("current_goal") or ""), 240) or None,
        "current_material": short_text(str(key_state_raw.get("current_material") or key_state_default.get("current_material") or ""), 180) or None,
        "current_section": short_text(str(key_state_raw.get("current_section") or key_state_default.get("current_section") or ""), 180) or None,
        "next_step": short_text(str(key_state_raw.get("next_step") or key_state_default.get("next_step") or ""), 240) or None,
    }

    summary = short_text(str(raw.get("summary") or fallback_summary or "Compacted memory snapshot"), 2000)
    updated_at = str(raw.get("updated_at") or datetime.utcnow().isoformat())
    resolved_compaction_id = raw.get("compaction_id")
    if not resolved_compaction_id:
        resolved_compaction_id = compaction_id
    return {
        "compaction_id": str(resolved_compaction_id) if resolved_compaction_id else None,
        "sequence": int(raw.get("sequence") or sequence or 0),
        "summary": summary,
        "key_state": key_state,
        "hard_constraints": _normalize_string_list(raw.get("hard_constraints")),
        "temporary_decisions": _normalize_string_list(raw.get("temporary_decisions")),
        "unwritten_conclusions": _normalize_string_list(raw.get("unwritten_conclusions")),
        "open_loops": _normalize_string_list(raw.get("open_loops")),
        "updated_at": updated_at,
    }


def _latest_from_row(row: Optional[ConversationCompaction], *, memory_epoch: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not row:
        return None
    key_facts = row.key_facts_json or {}
    raw_snapshot = key_facts.get("memory_snapshot")
    return _normalize_latest_snapshot(
        raw_snapshot if isinstance(raw_snapshot, dict) else {},
        compaction_id=row.id,
        sequence=row.sequence,
        fallback_summary=row.summary_text,
        memory_epoch=memory_epoch,
    )


def _history_tail_from_rows(rows: List[ConversationCompaction], *, memory_epoch: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    for row in rows:
        latest = _latest_from_row(row, memory_epoch=memory_epoch)
        if latest:
            items.append(latest)
        if len(items) >= 3:
            break
    return items


def _build_compact_memory(
    *,
    trigger_tokens: int,
    trigger_ratio: float,
    latest: Optional[Dict[str, Any]],
    history_tail: List[Dict[str, Any]],
    memory_epoch: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    fallback_latest = _normalize_latest_snapshot(
        {},
        compaction_id=None,
        sequence=0,
        fallback_summary="No compaction yet.",
        memory_epoch=memory_epoch,
    )
    latest_snapshot = latest or fallback_latest
    deduped_tail: List[Dict[str, Any]] = []
    seen: set[Tuple[str, int]] = set()
    for item in [latest_snapshot, *history_tail]:
        key = (str(item.get("compaction_id") or ""), int(item.get("sequence") or 0))
        if key in seen:
            continue
        seen.add(key)
        deduped_tail.append(item)
        if len(deduped_tail) >= 3:
            break
    return {
        "lifecycle": "session",
        "trigger": {
            "context_window_tokens": trigger_tokens,
            "trigger_ratio": trigger_ratio,
        },
        "latest": latest_snapshot,
        "history_tail": deduped_tail,
    }


def _build_heuristic_snapshot(
    *,
    older: List[ChatMessage],
    sequence: int,
    compaction_id: str,
    memory_epoch: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    summary_lines: List[str] = []
    for msg in older[-30:]:
        prefix = "USER" if msg.role == "user" else "ASSISTANT"
        summary_lines.append(f"{prefix}: {short_text(msg.content, 300)}")
    summary_text = (
        "Compacted conversation history:\n" + "\n".join(summary_lines)
        if summary_lines
        else "Compacted conversation history: (empty)"
    )
    open_loops = [
        short_text(msg.content, 180)
        for msg in older
        if msg.role == "user" and str(msg.content or "").strip()
    ][-5:]
    return _normalize_latest_snapshot(
        {
            "summary": summary_text,
            "key_state": _default_key_state(memory_epoch),
            "hard_constraints": [],
            "temporary_decisions": [],
            "unwritten_conclusions": [],
            "open_loops": open_loops,
        },
        compaction_id=compaction_id,
        sequence=sequence,
        fallback_summary=summary_text,
        memory_epoch=memory_epoch,
    )


def _epoch_hint_for_compaction(memory_epoch: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not isinstance(memory_epoch, dict):
        return {}

    tool_calls = ((memory_epoch.get("tool_history") or {}).get("calls") or [])[-8:]
    tool_hints = []
    for call in tool_calls:
        if not isinstance(call, dict):
            continue
        tool_hints.append(
            {
                "tool": call.get("tool"),
                "success": call.get("success"),
                "error_code": call.get("error_code"),
                "arguments_digest": call.get("arguments_digest"),
                "result_digest": call.get("result_digest"),
            }
        )

    dialogue = memory_epoch.get("dialogue") if isinstance(memory_epoch.get("dialogue"), dict) else {}
    task_list = memory_epoch.get("task_list") if isinstance(memory_epoch.get("task_list"), dict) else {}
    return {
        "state": memory_epoch.get("state"),
        "dialogue": {
            "latest_user_goal": dialogue.get("latest_user_goal"),
            "current_focus": dialogue.get("current_focus"),
            "next_action": dialogue.get("next_action"),
        },
        "task_list": {
            "counts": task_list.get("counts"),
            "items": (task_list.get("items") or [])[:10],
        },
        "tool_history_digest": tool_hints,
    }


def _build_memory_for_token_accounting(
    *,
    compact_memory: Dict[str, Any],
    memory_epoch: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    return {
        "lifecycle": "session",
        "compact": compact_memory,
        "epoch": _epoch_hint_for_compaction(memory_epoch),
    }


def _message_token_parts(pre_compact_messages: List[Dict[str, str]]) -> Dict[str, int]:
    system_tokens = 0
    dialogue_tokens = 0
    other_tokens = 0

    for msg in pre_compact_messages:
        role = str(msg.get("role") or "")
        content = str(msg.get("content") or "")
        item_tokens = estimate_tokens(role) + estimate_tokens(content)
        if role == "system":
            system_tokens += item_tokens
        elif role in ("user", "assistant"):
            dialogue_tokens += item_tokens
        else:
            other_tokens += item_tokens

    return {
        "system_tokens": system_tokens,
        "dialogue_tokens": dialogue_tokens,
        "other_tokens": other_tokens,
        "messages_total_tokens": system_tokens + dialogue_tokens + other_tokens,
    }


def _token_window_stats(
    *,
    context_window_tokens: int,
    trigger_ratio: float,
    trigger_tokens: int,
    system_tokens: int,
    dialogue_tokens: int,
    other_tokens: int,
    memory_tokens: int,
    before_messages_tokens: int,
    before_total_input_tokens: int,
    after_messages_tokens: Optional[int] = None,
    after_total_input_tokens: Optional[int] = None,
) -> Dict[str, Any]:
    safe_window = max(1, int(context_window_tokens))

    def _ratio(value: int) -> float:
        return round(float(value) / float(safe_window), 6)

    stats: Dict[str, Any] = {
        "context_window_tokens": safe_window,
        "trigger_ratio": float(trigger_ratio),
        "trigger_tokens": int(trigger_tokens),
        "before_total_input_tokens": int(before_total_input_tokens),
        "before_messages_tokens": int(before_messages_tokens),
        "before_occupancy_ratio": _ratio(int(before_total_input_tokens)),
        "components": {
            "system_tokens": int(system_tokens),
            "dialogue_tokens": int(dialogue_tokens),
            "memory_tokens": int(memory_tokens),
            "other_tokens": int(other_tokens),
            "system_ratio": _ratio(int(system_tokens)),
            "dialogue_ratio": _ratio(int(dialogue_tokens)),
            "memory_ratio": _ratio(int(memory_tokens)),
            "other_ratio": _ratio(int(other_tokens)),
        },
    }

    if after_messages_tokens is not None and after_total_input_tokens is not None:
        stats["after_total_input_tokens"] = int(after_total_input_tokens)
        stats["after_messages_tokens"] = int(after_messages_tokens)
        stats["after_occupancy_ratio"] = _ratio(int(after_total_input_tokens))

    return stats


def _validate_compaction_payload(payload: Dict[str, Any]) -> None:
    missing = REQUIRED_COMPACTION_FIELDS - set(payload.keys())
    if missing:
        raise ValueError(f"model_compaction_missing_fields:{','.join(sorted(missing))}")

    key_state = payload.get("key_state")
    if not isinstance(key_state, dict):
        raise ValueError("model_compaction_invalid_key_state")
    key_state_missing = REQUIRED_KEY_STATE_FIELDS - set(key_state.keys())
    if key_state_missing:
        raise ValueError(
            f"model_compaction_missing_key_state:{','.join(sorted(key_state_missing))}"
        )

    for list_field in (
        "hard_constraints",
        "temporary_decisions",
        "unwritten_conclusions",
        "open_loops",
    ):
        raw_value = payload.get(list_field)
        if raw_value is not None and not isinstance(raw_value, list):
            raise ValueError(f"model_compaction_invalid_list_field:{list_field}")


async def _compact_with_main_model(
    *,
    older: List[ChatMessage],
    latest_snapshot: Optional[Dict[str, Any]],
    memory_epoch: Optional[Dict[str, Any]],
    model: Optional[str],
    compaction_id: str,
    sequence: int,
) -> Dict[str, Any]:
    from app.services.llm_service import llm_service

    older_payload = [
        {
            "role": msg.role,
            "content": short_text(msg.content or "", 900),
            "timestamp": msg.timestamp.isoformat() if msg.timestamp else None,
        }
        for msg in older[-40:]
    ]
    system_prompt = (
        "你是会话压缩器。只输出一个JSON对象，不要输出任何额外文本。"
        "JSON字段必须包含：summary,key_state,hard_constraints,temporary_decisions,unwritten_conclusions,open_loops。"
        "key_state必须包含：current_goal,current_material,current_section,next_step。"
    )
    user_prompt = (
        "Compact rule:\n"
        f"{COMPACT_RULE_TEXT}\n\n"
        "Previous compact latest:\n"
        f"{_safe_json(latest_snapshot or {})}\n\n"
        "Current epoch hints:\n"
        f"{_safe_json(_epoch_hint_for_compaction(memory_epoch))}\n\n"
        "Older dialogue to compact:\n"
        f"{_safe_json(older_payload)}"
    )
    response = await llm_service.chat_completion(
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        model=model,
        tools=None,
    )
    parsed = _extract_first_json_object(str(response.get("content") or ""))
    if not parsed:
        raise ValueError("model_compaction_invalid_json")
    _validate_compaction_payload(parsed)

    return _normalize_latest_snapshot(
        parsed,
        compaction_id=compaction_id,
        sequence=sequence,
        fallback_summary="Compacted conversation history.",
        memory_epoch=memory_epoch,
    )


def _build_compaction_block(sequence: int, latest_snapshot: Dict[str, Any]) -> str:
    block = f"[Compaction Block #{sequence}]\n{latest_snapshot.get('summary') or ''}"
    open_loops = latest_snapshot.get("open_loops") or []
    if open_loops:
        block += "\n\nOpen loops:\n- " + "\n- ".join(open_loops)
    return block


def _build_compacted_messages(
    *,
    pre_compact_messages: List[Dict[str, str]],
    recent: List[ChatMessage],
    block: str,
) -> List[Dict[str, str]]:
    compacted_messages: List[Dict[str, str]] = []
    for msg in pre_compact_messages:
        if msg.get("role") == "system":
            compacted_messages.append(msg)
        else:
            break
    compacted_messages.append({"role": "system", "content": block})
    compacted_messages.extend([{"role": msg.role, "content": msg.content} for msg in recent])
    return compacted_messages


async def maybe_compact_history(
    *,
    db: AsyncSession,
    session_id: str,
    history_messages: List[ChatMessage],
    pre_compact_messages: List[Dict[str, str]],
    compact_mode: str,
    memory_epoch: Optional[Dict[str, Any]] = None,
    model: Optional[str] = None,
) -> Dict[str, Any]:
    latest_compaction_result = await db.execute(
        select(ConversationCompaction)
        .where(ConversationCompaction.session_id == session_id)
        .order_by(ConversationCompaction.sequence.desc())
        .limit(1)
    )
    latest_compaction = latest_compaction_result.scalar_one_or_none()

    tail_result = await db.execute(
        select(ConversationCompaction)
        .where(ConversationCompaction.session_id == session_id)
        .order_by(ConversationCompaction.sequence.desc())
        .limit(3)
    )
    tail_rows = tail_result.scalars().all()

    context_window_tokens = max(1, int(settings.MODEL_CONTEXT_WINDOW_TOKENS or 256000))
    trigger_ratio = float(settings.COMPACT_TRIGGER_RATIO or 0.8)
    if trigger_ratio <= 0 or trigger_ratio > 1:
        trigger_ratio = 0.8
    trigger_tokens = max(1, int(context_window_tokens * trigger_ratio))

    latest_snapshot = _latest_from_row(latest_compaction, memory_epoch=memory_epoch)
    history_tail = _history_tail_from_rows(tail_rows, memory_epoch=memory_epoch)
    compact_memory = _build_compact_memory(
        trigger_tokens=context_window_tokens,
        trigger_ratio=trigger_ratio,
        latest=latest_snapshot,
        history_tail=history_tail,
        memory_epoch=memory_epoch,
    )
    latest_summary = (compact_memory.get("latest") or {}).get("summary")
    memory_for_token_accounting = _build_memory_for_token_accounting(
        compact_memory=compact_memory,
        memory_epoch=memory_epoch,
    )
    memory_tokens = estimate_tokens(_safe_json_compact(memory_for_token_accounting))
    message_parts = _message_token_parts(pre_compact_messages)
    before_messages_tokens = message_parts["messages_total_tokens"]
    before_tokens = before_messages_tokens + memory_tokens
    token_window = _token_window_stats(
        context_window_tokens=context_window_tokens,
        trigger_ratio=trigger_ratio,
        trigger_tokens=trigger_tokens,
        system_tokens=message_parts["system_tokens"],
        dialogue_tokens=message_parts["dialogue_tokens"],
        other_tokens=message_parts["other_tokens"],
        memory_tokens=memory_tokens,
        before_messages_tokens=before_messages_tokens,
        before_total_input_tokens=before_tokens,
    )

    normalized_mode = (compact_mode or "auto").lower()
    force_mode = normalized_mode == "force"
    if normalized_mode == "off" or not settings.AUTO_COMPACT_ENABLED:
        return {
            "messages": pre_compact_messages,
            "compact_meta": {
                "triggered": False,
                "reason": "disabled",
                "memory_snapshot": compact_memory,
                "model_compaction_used": False,
                "before_tokens": before_tokens,
                "before_messages_tokens": before_messages_tokens,
                "memory_tokens": memory_tokens,
                "token_window": token_window,
                "context_window_tokens": context_window_tokens,
                "trigger_ratio": trigger_ratio,
            },
            "latest_summary": latest_summary,
        }

    if before_tokens < trigger_tokens and not force_mode:
        return {
            "messages": pre_compact_messages,
            "compact_meta": {
                "triggered": False,
                "before_tokens": before_tokens,
                "before_messages_tokens": before_messages_tokens,
                "memory_tokens": memory_tokens,
                "reason": "below_trigger_ratio",
                "memory_snapshot": compact_memory,
                "model_compaction_used": False,
                "token_window": token_window,
                "context_window_tokens": context_window_tokens,
                "trigger_ratio": trigger_ratio,
            },
            "latest_summary": latest_summary,
        }

    conversational = [msg for msg in history_messages if msg.role in ("user", "assistant")]
    if len(conversational) <= 6:
        return {
            "messages": pre_compact_messages,
            "compact_meta": {
                "triggered": False,
                "before_tokens": before_tokens,
                "before_messages_tokens": before_messages_tokens,
                "memory_tokens": memory_tokens,
                "reason": "insufficient_history",
                "memory_snapshot": compact_memory,
                "model_compaction_used": False,
                "token_window": token_window,
                "context_window_tokens": context_window_tokens,
                "trigger_ratio": trigger_ratio,
            },
            "latest_summary": latest_summary,
        }

    older = conversational[:-6]
    recent = conversational[-6:]
    seq_result = await db.execute(
        select(ConversationCompaction.sequence)
        .where(ConversationCompaction.session_id == session_id)
        .order_by(ConversationCompaction.sequence.desc())
        .limit(1)
    )
    last_seq = seq_result.scalar_one_or_none() or 0
    sequence = last_seq + 1
    compaction_id = str(uuid.uuid4())

    model_compaction_used = False
    try:
        latest_for_new = await _compact_with_main_model(
            older=older,
            latest_snapshot=compact_memory.get("latest"),
            memory_epoch=memory_epoch,
            model=model,
            compaction_id=compaction_id,
            sequence=sequence,
        )
        model_compaction_used = True
    except Exception:
        latest_for_new = _build_heuristic_snapshot(
            older=older,
            sequence=sequence,
            compaction_id=compaction_id,
            memory_epoch=memory_epoch,
        )

    block = _build_compaction_block(sequence=sequence, latest_snapshot=latest_for_new)
    compacted_messages = _build_compacted_messages(
        pre_compact_messages=pre_compact_messages,
        recent=recent,
        block=block,
    )

    after_messages_tokens = estimate_messages_tokens(compacted_messages)
    after_tokens = after_messages_tokens + memory_tokens
    target_tokens = max(1, int(settings.COMPACT_TARGET_TOKENS or (trigger_tokens * 0.7)))
    if force_mode or after_tokens > target_tokens:
        system_messages = [msg for msg in compacted_messages if msg.get("role") == "system"]
        recent_tail = recent[-4:] if len(recent) > 4 else recent[:]
        compacted_messages = system_messages + [{"role": msg.role, "content": msg.content} for msg in recent_tail]
        after_messages_tokens = estimate_messages_tokens(compacted_messages)
        after_tokens = after_messages_tokens + memory_tokens
        while after_tokens > target_tokens and len(recent_tail) > 2:
            recent_tail = recent_tail[1:]
            compacted_messages = system_messages + [{"role": msg.role, "content": msg.content} for msg in recent_tail]
            after_messages_tokens = estimate_messages_tokens(compacted_messages)
            after_tokens = after_messages_tokens + memory_tokens

    new_history_tail = [latest_for_new, *compact_memory.get("history_tail", [])][:3]
    compact_memory = {
        "lifecycle": "session",
        "trigger": {
            "context_window_tokens": context_window_tokens,
            "trigger_ratio": trigger_ratio,
        },
        "latest": latest_for_new,
        "history_tail": new_history_tail,
    }
    memory_for_token_accounting = _build_memory_for_token_accounting(
        compact_memory=compact_memory,
        memory_epoch=memory_epoch,
    )
    memory_tokens = estimate_tokens(_safe_json_compact(memory_for_token_accounting))
    after_tokens = after_messages_tokens + memory_tokens
    token_window = _token_window_stats(
        context_window_tokens=context_window_tokens,
        trigger_ratio=trigger_ratio,
        trigger_tokens=trigger_tokens,
        system_tokens=message_parts["system_tokens"],
        dialogue_tokens=message_parts["dialogue_tokens"],
        other_tokens=message_parts["other_tokens"],
        memory_tokens=memory_tokens,
        before_messages_tokens=before_messages_tokens,
        before_total_input_tokens=before_tokens,
        after_messages_tokens=after_messages_tokens,
        after_total_input_tokens=after_tokens,
    )

    trigger_reason = "force_mode" if force_mode else "trigger_ratio"
    if before_tokens >= int(settings.COMPACT_FORCE_TOKENS or 0):
        trigger_reason = "force_threshold"
    if model_compaction_used:
        trigger_reason += "_model"
    else:
        trigger_reason += "_fallback"

    db.add(
        ConversationCompaction(
            id=compaction_id,
            session_id=session_id,
            sequence=sequence,
            trigger_reason=trigger_reason,
            before_tokens=before_tokens,
            after_tokens=after_tokens,
            summary_text=latest_for_new.get("summary") or "",
            key_facts_json={
                "message_count": len(older),
                "memory_snapshot": latest_for_new,
                "model_compaction_used": model_compaction_used,
                "token_window": token_window,
                "before_messages_tokens": before_messages_tokens,
                "after_messages_tokens": after_messages_tokens,
                "memory_tokens": memory_tokens,
            },
            open_loops_json={"items": latest_for_new.get("open_loops") or []},
            source_from_ts=older[0].timestamp if older else None,
            source_to_ts=older[-1].timestamp if older else None,
        )
    )

    return {
        "messages": compacted_messages,
        "compact_meta": {
            "triggered": True,
            "reason": trigger_reason,
            "before_tokens": before_tokens,
            "before_messages_tokens": before_messages_tokens,
            "after_tokens": after_tokens,
            "after_messages_tokens": after_messages_tokens,
            "memory_tokens": memory_tokens,
            "compaction_id": compaction_id,
            "memory_snapshot": compact_memory,
            "model_compaction_used": model_compaction_used,
            "context_window_tokens": context_window_tokens,
            "trigger_ratio": trigger_ratio,
            "token_window": token_window,
        },
        "latest_summary": latest_for_new.get("summary"),
        "compact_rule": COMPACT_RULE_TEXT,
    }


def format_compact_snapshot(latest_snapshot: Optional[Dict[str, Any]]) -> Optional[str]:
    if not isinstance(latest_snapshot, dict):
        return None
    summary = str(latest_snapshot.get("summary") or "").strip()
    if not summary:
        return None
    parts = [summary]
    key_state = latest_snapshot.get("key_state") if isinstance(latest_snapshot.get("key_state"), dict) else {}
    current_goal = str(key_state.get("current_goal") or "").strip()
    next_step = str(key_state.get("next_step") or "").strip()
    if current_goal:
        parts.append(f"Current goal: {current_goal}")
    if next_step:
        parts.append(f"Next step: {next_step}")
    open_loops = latest_snapshot.get("open_loops") or []
    if open_loops:
        parts.append("Open loops:\n- " + "\n- ".join([str(item) for item in open_loops]))
    return "\n\n".join(parts)


async def compact_dialogue_bucket(
    *,
    db: AsyncSession,
    session_id: str,
    older_messages: List[Dict[str, Any]],
    budget_tokens: int,
    memory_epoch: Optional[Dict[str, Any]] = None,
    model: Optional[str] = None,
    task_registry_snapshot: Optional[Dict[str, Any]] = None,
    active_task: Optional[Dict[str, Any]] = None,
    active_step: Optional[Dict[str, Any]] = None,
    trigger_reason: Optional[str] = None,
) -> Dict[str, Any]:
    if not older_messages or budget_tokens <= 0:
        return {
            "block_text": None,
            "used_tokens": 0,
            "latest_summary": None,
            "snapshot": None,
            "triggered": False,
            "compaction_id": None,
            "before_tokens": None,
            "after_tokens": None,
        }

    latest_compaction_result = await db.execute(
        select(ConversationCompaction)
        .where(ConversationCompaction.session_id == session_id)
        .order_by(ConversationCompaction.sequence.desc())
        .limit(1)
    )
    latest_compaction = latest_compaction_result.scalar_one_or_none()
    latest_snapshot = _latest_from_row(latest_compaction, memory_epoch=memory_epoch)

    materialized_messages: List[ChatMessage] = []
    for index, item in enumerate(older_messages):
        role = str(item.get("role") or "")
        content = str(item.get("content") or "")
        if role not in {"user", "assistant"} or not content:
            continue
        materialized_messages.append(
            ChatMessage(
                id=str(index),
                session_id=session_id,
                role=role,
                content=content,
            )
        )

    if not materialized_messages:
        return {
            "block_text": None,
            "used_tokens": 0,
            "latest_summary": None,
            "snapshot": None,
            "triggered": False,
            "compaction_id": None,
            "before_tokens": None,
            "after_tokens": None,
        }

    seq_result = await db.execute(
        select(ConversationCompaction.sequence)
        .where(ConversationCompaction.session_id == session_id)
        .order_by(ConversationCompaction.sequence.desc())
        .limit(1)
    )
    last_seq = seq_result.scalar_one_or_none() or 0
    sequence = last_seq + 1
    compaction_id = str(uuid.uuid4())

    model_compaction_used = False
    try:
        latest_for_new = await _compact_with_main_model(
            older=materialized_messages,
            latest_snapshot=latest_snapshot,
            memory_epoch=memory_epoch,
            model=model,
            compaction_id=compaction_id,
            sequence=sequence,
        )
        model_compaction_used = True
    except Exception:
        latest_for_new = _build_heuristic_snapshot(
            older=materialized_messages,
            sequence=sequence,
            compaction_id=compaction_id,
            memory_epoch=memory_epoch,
        )

    block_text = format_compact_snapshot(latest_for_new)
    registry_id = str((task_registry_snapshot or {}).get("registry_id") or "").strip()
    task_goal = str((active_task or {}).get("goal") or "").strip()
    step_type = str((active_step or {}).get("type") or "").strip()
    if block_text and (registry_id or task_goal or step_type):
        header_lines = ["[Task/Step Compact Anchor]"]
        if registry_id:
            header_lines.append(f"Registry: {registry_id}")
        if task_goal:
            header_lines.append(f"Task Goal: {task_goal}")
        if step_type:
            header_lines.append(f"Next Step: {step_type}")
        block_text = "\n".join(header_lines) + "\n\n" + block_text
    if block_text:
        block_text = short_text(block_text, max(240, budget_tokens * 4))
    used_tokens = estimate_tokens(block_text or "")
    if used_tokens > budget_tokens and block_text:
        block_text = short_text(block_text, max(120, budget_tokens * 4))
        used_tokens = estimate_tokens(block_text)

    key_facts_json = {
        "bucket_name": "compact_dialogue_bucket",
        "source_message_ids": [str(item.get("id") or "") for item in older_messages if item.get("id")],
        "source_token_count": sum(estimate_tokens(str(item.get("content") or "")) for item in older_messages),
        "compacted_token_count": used_tokens,
        "task_registry_id": registry_id or None,
        "task_goal": task_goal or None,
        "step_type": step_type or None,
        "memory_snapshot": latest_for_new,
        "model_compaction_used": model_compaction_used,
    }
    db.add(
        ConversationCompaction(
            id=compaction_id,
            session_id=session_id,
            sequence=sequence,
            trigger_reason=(
                str(trigger_reason)
                if str(trigger_reason or "").strip()
                else ("bucket_rebalance_model" if model_compaction_used else "bucket_rebalance_fallback")
            ),
            before_tokens=key_facts_json["source_token_count"],
            after_tokens=used_tokens,
            summary_text=latest_for_new.get("summary") or "",
            key_facts_json=key_facts_json,
            open_loops_json={"items": latest_for_new.get("open_loops") or []},
        )
    )

    return {
        "block_text": block_text,
        "used_tokens": used_tokens,
        "latest_summary": latest_for_new.get("summary"),
        "snapshot": latest_for_new,
        "triggered": True,
        "compaction_id": compaction_id,
        "before_tokens": key_facts_json["source_token_count"],
        "after_tokens": used_tokens,
    }
