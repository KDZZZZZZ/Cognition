import uuid
from typing import Any, Dict, List

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import ChatMessage, ConversationCompaction
from app.services.token_budget_service import estimate_messages_tokens, short_text


async def maybe_compact_history(
    *,
    db: AsyncSession,
    session_id: str,
    history_messages: List[ChatMessage],
    pre_compact_messages: List[Dict[str, str]],
    compact_mode: str,
) -> Dict[str, Any]:
    latest_compaction_result = await db.execute(
        select(ConversationCompaction)
        .where(ConversationCompaction.session_id == session_id)
        .order_by(ConversationCompaction.sequence.desc())
        .limit(1)
    )
    latest_compaction = latest_compaction_result.scalar_one_or_none()
    latest_summary = latest_compaction.summary_text if latest_compaction else None

    normalized_mode = (compact_mode or "auto").lower()
    force_mode = normalized_mode == "force"

    if normalized_mode == "off" or not settings.AUTO_COMPACT_ENABLED:
        return {
            "messages": pre_compact_messages,
            "compact_meta": {"triggered": False},
            "latest_summary": latest_summary,
        }

    before_tokens = estimate_messages_tokens(pre_compact_messages)
    if before_tokens < settings.COMPACT_TRIGGER_TOKENS and not force_mode:
        return {
            "messages": pre_compact_messages,
            "compact_meta": {"triggered": False, "before_tokens": before_tokens},
            "latest_summary": latest_summary,
        }

    conversational = [msg for msg in history_messages if msg.role in ("user", "assistant")]
    if len(conversational) <= 6:
        return {
            "messages": pre_compact_messages,
            "compact_meta": {"triggered": False, "before_tokens": before_tokens},
            "latest_summary": latest_summary,
        }

    older = conversational[:-6]
    recent = conversational[-6:]

    summary_lines: List[str] = []
    for msg in older[-30:]:
        prefix = "USER" if msg.role == "user" else "ASSISTANT"
        summary_lines.append(f"{prefix}: {short_text(msg.content, 300)}")
    summary_text = (
        "Compacted conversation history:\n" + "\n".join(summary_lines)
        if summary_lines
        else "Compacted conversation history: (empty)"
    )

    open_loops: List[str] = []
    user_messages = [msg.content for msg in older if msg.role == "user"]
    if user_messages:
        open_loops = [short_text(content, 180) for content in user_messages[-5:]]

    seq_result = await db.execute(
        select(ConversationCompaction.sequence)
        .where(ConversationCompaction.session_id == session_id)
        .order_by(ConversationCompaction.sequence.desc())
        .limit(1)
    )
    last_seq = seq_result.scalar_one_or_none() or 0
    compaction_id = str(uuid.uuid4())

    compacted_messages: List[Dict[str, str]] = []
    for msg in pre_compact_messages:
        if msg.get("role") == "system":
            compacted_messages.append(msg)
        else:
            break

    compaction_block = f"[Compaction Block #{last_seq + 1}]\n{summary_text}"
    if open_loops:
        compaction_block += "\n\nOpen loops:\n- " + "\n- ".join(open_loops)
    compacted_messages.append(
        {
            "role": "system",
            "content": compaction_block,
        }
    )
    compacted_messages.extend([{"role": msg.role, "content": msg.content} for msg in recent])

    after_tokens = estimate_messages_tokens(compacted_messages)
    reason = "force_mode" if force_mode else "trigger_threshold"
    if before_tokens >= settings.COMPACT_FORCE_TOKENS:
        reason = "force_threshold"

    if force_mode or before_tokens >= settings.COMPACT_FORCE_TOKENS or after_tokens > settings.COMPACT_TARGET_TOKENS:
        target_tokens = max(1, settings.COMPACT_TARGET_TOKENS)
        system_messages = [msg for msg in compacted_messages if msg.get("role") == "system"]
        recent_tail = recent[-4:] if len(recent) > 4 else recent[:]
        compacted_messages = system_messages + [{"role": msg.role, "content": msg.content} for msg in recent_tail]
        after_tokens = estimate_messages_tokens(compacted_messages)
        while after_tokens > target_tokens and len(recent_tail) > 2:
            recent_tail = recent_tail[1:]
            compacted_messages = system_messages + [{"role": msg.role, "content": msg.content} for msg in recent_tail]
            after_tokens = estimate_messages_tokens(compacted_messages)

    db.add(
        ConversationCompaction(
            id=compaction_id,
            session_id=session_id,
            sequence=last_seq + 1,
            trigger_reason=reason,
            before_tokens=before_tokens,
            after_tokens=after_tokens,
            summary_text=summary_text,
            key_facts_json={"message_count": len(older)},
            open_loops_json={"items": open_loops},
            source_from_ts=older[0].timestamp if older else None,
            source_to_ts=older[-1].timestamp if older else None,
        )
    )

    return {
        "messages": compacted_messages,
        "compact_meta": {
            "triggered": True,
            "reason": reason,
            "before_tokens": before_tokens,
            "after_tokens": after_tokens,
            "compaction_id": compaction_id,
        },
        "latest_summary": summary_text,
    }
