from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.services.compaction_service import compact_dialogue_bucket
from app.services.executor_prompt_service import (
    build_executor_sections,
    build_step_executor_sections,
    render_executor_system_prompt,
)
from app.services.router_agent_service import filter_tool_definitions
from app.services.token_budget_service import estimate_messages_tokens, estimate_tokens
from app.services.token_ledger_service import (
    build_bucket_caps,
    estimate_tool_schema_tokens,
    finalize_budget_meta,
    fit_sections_to_budget,
    pack_recent_messages,
    trim_text_to_token_budget,
)


def _tool_name(tool: Dict[str, Any]) -> str:
    function = tool.get("function") if isinstance(tool, dict) else None
    return str((function or {}).get("name") or "").strip()


def _shrink_tools_to_cap(
    tools: Sequence[Dict[str, Any]],
    *,
    preferred_tools: Sequence[str],
    runtime_cap: int,
) -> tuple[List[Dict[str, Any]], int]:
    kept = list(tools or [])
    if not kept or runtime_cap <= 0:
        return [], 0

    preferred = {str(item or "").strip() for item in preferred_tools if str(item or "").strip()}
    used = estimate_tool_schema_tokens(kept)
    while kept and used > runtime_cap:
        removal_index = next(
            (idx for idx in range(len(kept) - 1, -1, -1) if _tool_name(kept[idx]) not in preferred),
            len(kept) - 1,
        )
        kept.pop(removal_index)
        used = estimate_tool_schema_tokens(kept)
    return kept, used


async def build_context_pack(
    *,
    db: AsyncSession,
    session_id: str,
    current_user_message: str,
    history_messages: Sequence[Dict[str, Any]],
    router_result: Dict[str, Any],
    selection: Dict[str, Any],
    permissions: Dict[str, str],
    permitted_files_info: Dict[str, Dict[str, str]],
    task_state: Optional[Dict[str, Any]],
    viewport_memory: Optional[Dict[str, Any]],
    available_tools: Sequence[Dict[str, Any]],
    previous_tool_results: Optional[Sequence[Dict[str, Any]]] = None,
    memory_epoch: Optional[Dict[str, Any]] = None,
    model: Optional[str] = None,
    compact_mode: Optional[str] = "auto",
) -> Dict[str, Any]:
    context_window_tokens = max(1, int(settings.MODEL_CONTEXT_WINDOW_TOKENS or 256000))
    caps = build_bucket_caps(context_window_tokens)
    bucket_caps = caps["buckets"]

    tool_cfg = router_result.get("tool") if isinstance(router_result.get("tool"), dict) else {}
    filtered_tools = filter_tool_definitions(
        list(available_tools or []),
        allowed_groups=tool_cfg.get("allowed_groups") or [],
        forbidden_tools=tool_cfg.get("forbidden_tools") or [],
    )
    filtered_tools, tool_schema_tokens = _shrink_tools_to_cap(
        filtered_tools,
        preferred_tools=tool_cfg.get("preferred_tools") or [],
        runtime_cap=int(bucket_caps["runtime_bucket"]["cap"]),
    )

    viewport_memory_summary = (viewport_memory or {}).get("memory_summary")
    viewport_memory_text = (viewport_memory or {}).get("memory_text")
    viewport_bucket_cap = int(bucket_caps["viewport_doc_memory_bucket"]["cap"])
    viewport_used = estimate_tokens(viewport_memory_text or "")
    if viewport_used > viewport_bucket_cap and viewport_memory_text:
        viewport_memory_text = trim_text_to_token_budget(viewport_memory_text, viewport_bucket_cap)
        viewport_memory_summary = (
            trim_text_to_token_budget(viewport_memory_summary, viewport_bucket_cap)
            if viewport_memory_summary
            else viewport_memory_text
        )
        viewport_used = estimate_tokens(viewport_memory_text)

    history_pairs = []
    for message in history_messages:
        role = str(message.get("role") or "")
        if role not in {"user", "assistant"}:
            continue
        history_pairs.append({
            "id": message.get("id"),
            "role": role,
            "content": str(message.get("content") or ""),
        })

    compact_mode_normalized = str(compact_mode or "auto").strip().lower()
    raw_budget = int(bucket_caps["raw_dialogue_bucket"]["cap"])
    raw_messages, overflow_messages, raw_used = pack_recent_messages(history_pairs, raw_budget)
    if compact_mode_normalized == "force" and not overflow_messages and raw_messages:
        keep_recent = min(2, len(raw_messages))
        if keep_recent < len(raw_messages):
            overflow_messages = [*raw_messages[:-keep_recent], *overflow_messages]
            raw_messages = raw_messages[-keep_recent:]
            raw_used = estimate_messages_tokens(raw_messages)

    compact_budget = int(bucket_caps["compact_dialogue_bucket"]["cap"])
    if compact_mode_normalized == "off":
        compact_result = {
            "block_text": None,
            "used_tokens": 0,
            "latest_summary": None,
            "snapshot": None,
            "triggered": False,
        }
    else:
        compact_result = await compact_dialogue_bucket(
            db=db,
            session_id=session_id,
            older_messages=overflow_messages,
            budget_tokens=compact_budget,
            memory_epoch=memory_epoch,
            model=model,
        )
    compact_summary = compact_result.get("block_text")
    compact_used = int(compact_result.get("used_tokens") or 0)

    sections = build_executor_sections(
        router_result=router_result,
        workflows=selection.get("workflows") or [],
        templates=selection.get("templates") or [],
        permissions=permissions,
        permitted_files_info=permitted_files_info,
        task_state=task_state,
        viewport_memory_summary=viewport_memory_summary,
        compact_summary=compact_summary,
        tools=filtered_tools,
    )

    runtime_budget = max(1, int(bucket_caps["runtime_bucket"]["cap"]) - tool_schema_tokens)
    runtime_sections, runtime_used, runtime_trimmed = fit_sections_to_budget(
        sorted(sections, key=lambda item: int(item.get("priority") or 0), reverse=True),
        runtime_budget,
    )
    system_prompt = render_executor_system_prompt(runtime_sections)

    messages: List[Dict[str, Any]] = [{"role": "system", "content": system_prompt}]
    messages.extend(raw_messages)
    messages.append({"role": "user", "content": current_user_message})

    previous_results = list(previous_tool_results or [])[-4:]
    tool_result_tokens = estimate_tokens(str(previous_results)) if previous_results else 0
    total_input_tokens = estimate_messages_tokens(messages) + tool_schema_tokens + tool_result_tokens
    forced_compaction = compact_mode_normalized == "force" and bool(compact_result.get("triggered"))
    triggered = total_input_tokens > caps["input_target_tokens"] or bool(overflow_messages) or runtime_trimmed or forced_compaction
    reason = "within_budget"
    if forced_compaction:
        reason = "force_compact"
    elif total_input_tokens > caps["input_target_tokens"]:
        reason = "over_target_budget"
    elif overflow_messages:
        reason = "history_rebalanced"
    elif runtime_trimmed:
        reason = "runtime_trimmed"

    budget_meta = finalize_budget_meta(
        caps=caps,
        runtime_used=runtime_used + tool_schema_tokens,
        raw_used=raw_used,
        compact_used=compact_used,
        viewport_used=viewport_used,
        tool_schema_tokens=tool_schema_tokens,
        total_input_tokens=total_input_tokens,
        triggered=triggered,
        reason=reason,
    )

    return {
        "messages": messages,
        "tools": filtered_tools,
        "budget_meta": budget_meta,
        "compact_summary": compact_summary,
        "compact_snapshot": compact_result.get("snapshot"),
        "compact_triggered": bool(compact_result.get("triggered")),
        "compact_compaction_id": compact_result.get("compaction_id"),
        "compact_before_tokens": compact_result.get("before_tokens"),
        "compact_after_tokens": compact_result.get("after_tokens"),
        "raw_history_count": len(raw_messages),
        "overflow_history_count": len(overflow_messages),
        "viewport_memory": {
            "summary": viewport_memory_summary,
            "text": viewport_memory_text,
            "refs": (viewport_memory or {}).get("refs") or [],
        "source_revision": (viewport_memory or {}).get("source_revision"),
        },
    }


async def build_task_registry_context_pack(
    *,
    db: AsyncSession,
    session_id: str,
    current_user_message: str,
    history_messages: Sequence[Dict[str, Any]],
    registry_snapshot: Dict[str, Any],
    active_task: Dict[str, Any],
    active_step: Dict[str, Any],
    step_definition: Dict[str, Any],
    global_rules_text: str,
    permissions: Dict[str, str],
    permitted_files_info: Dict[str, Dict[str, str]],
    viewport_memory: Optional[Dict[str, Any]],
    available_tools: Sequence[Dict[str, Any]],
    router_tool_hints: Optional[Dict[str, Any]] = None,
    previous_tool_results: Optional[Sequence[Dict[str, Any]]] = None,
    previous_step_outputs_text: Optional[str] = None,
    retrieval_summary_text: Optional[str] = None,
    model: Optional[str] = None,
    compact_mode: Optional[str] = "auto",
    defer_compaction: bool = False,
) -> Dict[str, Any]:
    context_window_tokens = max(1, int(settings.MODEL_CONTEXT_WINDOW_TOKENS or 256000))
    caps = build_bucket_caps(context_window_tokens)
    bucket_caps = caps["buckets"]

    filtered_tools = [
        tool
        for tool in list(available_tools or [])
        if _tool_name(tool) not in {"register_task"}
    ]
    # Task-registry executor keeps full step-level tool schemas; router hints are advisory only.
    tool_schema_tokens = estimate_tool_schema_tokens(filtered_tools)

    viewport_memory_summary = (viewport_memory or {}).get("memory_summary")
    viewport_memory_text = (viewport_memory or {}).get("memory_text")
    viewport_bucket_cap = int(bucket_caps["viewport_doc_memory_bucket"]["cap"])
    viewport_used = estimate_tokens(viewport_memory_text or "")
    if viewport_used > viewport_bucket_cap and viewport_memory_text:
        viewport_memory_text = trim_text_to_token_budget(viewport_memory_text, viewport_bucket_cap)
        viewport_memory_summary = (
            trim_text_to_token_budget(viewport_memory_summary, viewport_bucket_cap)
            if viewport_memory_summary
            else viewport_memory_text
        )
        viewport_used = estimate_tokens(viewport_memory_text)

    history_pairs = []
    for message in history_messages:
        role = str(message.get("role") or "")
        if role not in {"user", "assistant"}:
            continue
        history_pairs.append({
            "id": message.get("id"),
            "role": role,
            "content": str(message.get("content") or ""),
        })

    compact_mode_normalized = str(compact_mode or "auto").strip().lower()
    effective_compact_mode = compact_mode_normalized
    compact_phase = "none"
    if defer_compaction and compact_mode_normalized != "off":
        effective_compact_mode = "off"
        compact_phase = "deferred"
    raw_budget = int(bucket_caps["raw_dialogue_bucket"]["cap"])
    raw_messages, overflow_messages, raw_used = pack_recent_messages(history_pairs, raw_budget)
    if effective_compact_mode == "force" and not overflow_messages and raw_messages:
        keep_recent = min(2, len(raw_messages))
        if keep_recent < len(raw_messages):
            overflow_messages = [*raw_messages[:-keep_recent], *overflow_messages]
            raw_messages = raw_messages[-keep_recent:]
            raw_used = estimate_messages_tokens(raw_messages)

    compact_budget = int(bucket_caps["compact_dialogue_bucket"]["cap"])
    if effective_compact_mode == "off":
        compact_result = {
            "block_text": None,
            "used_tokens": 0,
            "latest_summary": None,
            "snapshot": None,
            "triggered": False,
            "compaction_id": None,
            "before_tokens": None,
            "after_tokens": None,
        }
    else:
        compact_result = await compact_dialogue_bucket(
            db=db,
            session_id=session_id,
            older_messages=overflow_messages,
            budget_tokens=compact_budget,
            model=model,
            task_registry_snapshot=registry_snapshot,
            active_task=active_task,
            active_step=active_step,
        )
    compact_summary = compact_result.get("block_text")
    compact_used = int(compact_result.get("used_tokens") or 0)

    sections = build_step_executor_sections(
        global_rules_text=global_rules_text,
        step_definition=step_definition,
        registry_snapshot=registry_snapshot,
        active_task=active_task,
        active_step=active_step,
        permissions=permissions,
        permitted_files_info=permitted_files_info,
        viewport_memory_summary=viewport_memory_summary,
        compact_summary=compact_summary,
        tools=filtered_tools,
        previous_step_outputs_text=previous_step_outputs_text,
        router_tool_hints=router_tool_hints,
        retrieval_summary_text=retrieval_summary_text,
    )

    runtime_budget = max(1, int(bucket_caps["runtime_bucket"]["cap"]) - tool_schema_tokens)
    runtime_sections, runtime_used, runtime_trimmed = fit_sections_to_budget(
        sorted(sections, key=lambda item: int(item.get("priority") or 0), reverse=True),
        runtime_budget,
    )
    system_prompt = render_executor_system_prompt(runtime_sections)

    messages: List[Dict[str, Any]] = [{"role": "system", "content": system_prompt}]
    messages.extend(raw_messages)
    messages.append({"role": "user", "content": current_user_message})

    previous_results = list(previous_tool_results or [])[-4:]
    tool_result_tokens = estimate_tokens(str(previous_results)) if previous_results else 0
    total_input_tokens = estimate_messages_tokens(messages) + tool_schema_tokens + tool_result_tokens
    forced_compaction = effective_compact_mode == "force" and bool(compact_result.get("triggered"))
    triggered = total_input_tokens > caps["input_target_tokens"] or bool(overflow_messages) or runtime_trimmed or forced_compaction
    reason = "within_budget"
    if forced_compaction:
        reason = "force_compact"
    elif total_input_tokens > caps["input_target_tokens"]:
        reason = "over_target_budget"
    elif overflow_messages:
        reason = "history_rebalanced"
    elif runtime_trimmed:
        reason = "runtime_trimmed"

    budget_meta = finalize_budget_meta(
        caps=caps,
        runtime_used=runtime_used + tool_schema_tokens,
        raw_used=raw_used,
        compact_used=compact_used,
        viewport_used=viewport_used,
        tool_schema_tokens=tool_schema_tokens,
        total_input_tokens=total_input_tokens,
        triggered=triggered,
        reason=reason,
    )

    # Defer normal compaction during execution rounds; only emergency compact when token
    # usage exceeds hard limit.
    if defer_compaction and compact_mode_normalized != "off":
        try:
            hard_ratio = float(settings.COMPACT_HARD_EMERGENCY_RATIO or 0.95)
        except Exception:
            hard_ratio = 0.95
        if hard_ratio <= 0:
            hard_ratio = 0.95
        emergency_hit = (float(total_input_tokens) / float(max(1, context_window_tokens))) >= hard_ratio
        if emergency_hit:
            emergency_overflow = list(overflow_messages)
            emergency_raw = list(raw_messages)
            emergency_raw_used = int(raw_used)
            if not emergency_overflow and emergency_raw:
                keep_recent = min(2, len(emergency_raw))
                if keep_recent < len(emergency_raw):
                    emergency_overflow = [*emergency_raw[:-keep_recent]]
                    emergency_raw = emergency_raw[-keep_recent:]
                    emergency_raw_used = estimate_messages_tokens(emergency_raw)

            emergency_compact_result = {
                "block_text": None,
                "used_tokens": 0,
                "latest_summary": None,
                "snapshot": None,
                "triggered": False,
                "compaction_id": None,
                "before_tokens": None,
                "after_tokens": None,
            }
            if emergency_overflow:
                emergency_compact_result = await compact_dialogue_bucket(
                    db=db,
                    session_id=session_id,
                    older_messages=emergency_overflow,
                    budget_tokens=compact_budget,
                    model=model,
                    task_registry_snapshot=registry_snapshot,
                    active_task=active_task,
                    active_step=active_step,
                    trigger_reason="hard_emergency_limit",
                )
            emergency_compact_summary = emergency_compact_result.get("block_text")
            emergency_compact_used = int(emergency_compact_result.get("used_tokens") or 0)
            emergency_sections = build_step_executor_sections(
                global_rules_text=global_rules_text,
                step_definition=step_definition,
                registry_snapshot=registry_snapshot,
                active_task=active_task,
                active_step=active_step,
                permissions=permissions,
                permitted_files_info=permitted_files_info,
                viewport_memory_summary=viewport_memory_summary,
                compact_summary=emergency_compact_summary,
                tools=filtered_tools,
                previous_step_outputs_text=previous_step_outputs_text,
                router_tool_hints=router_tool_hints,
                retrieval_summary_text=retrieval_summary_text,
            )
            emergency_runtime_sections, emergency_runtime_used, emergency_runtime_trimmed = fit_sections_to_budget(
                sorted(emergency_sections, key=lambda item: int(item.get("priority") or 0), reverse=True),
                runtime_budget,
            )
            emergency_system_prompt = render_executor_system_prompt(emergency_runtime_sections)
            emergency_messages: List[Dict[str, Any]] = [{"role": "system", "content": emergency_system_prompt}]
            emergency_messages.extend(emergency_raw)
            emergency_messages.append({"role": "user", "content": current_user_message})
            emergency_total_input_tokens = estimate_messages_tokens(emergency_messages) + tool_schema_tokens + tool_result_tokens
            compact_result = emergency_compact_result
            compact_summary = emergency_compact_summary
            compact_used = emergency_compact_used
            messages = emergency_messages
            raw_messages = emergency_raw
            overflow_messages = emergency_overflow
            raw_used = emergency_raw_used
            runtime_used = emergency_runtime_used
            total_input_tokens = emergency_total_input_tokens
            compact_phase = "hard_emergency"
            budget_meta = finalize_budget_meta(
                caps=caps,
                runtime_used=runtime_used + tool_schema_tokens,
                raw_used=raw_used,
                compact_used=compact_used,
                viewport_used=viewport_used,
                tool_schema_tokens=tool_schema_tokens,
                total_input_tokens=total_input_tokens,
                triggered=True,
                reason="hard_emergency_limit",
            )
            runtime_trimmed = emergency_runtime_trimmed

    return {
        "messages": messages,
        "tools": filtered_tools,
        "budget_meta": budget_meta,
        "compact_summary": compact_summary,
        "compact_snapshot": compact_result.get("snapshot"),
        "compact_triggered": bool(compact_result.get("triggered")),
        "compact_compaction_id": compact_result.get("compaction_id"),
        "compact_before_tokens": compact_result.get("before_tokens"),
        "compact_after_tokens": compact_result.get("after_tokens"),
        "compact_phase": compact_phase,
        "raw_history_count": len(raw_messages),
        "overflow_history_count": len(overflow_messages),
        "viewport_memory": {
            "summary": viewport_memory_summary,
            "text": viewport_memory_text,
            "refs": (viewport_memory or {}).get("refs") or [],
            "source_revision": (viewport_memory or {}).get("source_revision"),
        },
    }
