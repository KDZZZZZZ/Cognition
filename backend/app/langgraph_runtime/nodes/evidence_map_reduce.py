from typing import Any, Dict


async def evidence_map_reduce_node(state: Dict[str, Any]) -> Dict[str, Any]:
    # Evidence cards are generated during retrieval in step execution.
    updated = dict(state)
    retrieval_meta = dict(updated.get("retrieval_meta") or {})
    if retrieval_meta and not retrieval_meta.get("stop_reason"):
        retrieval_meta["stop_reason"] = "deferred_to_step_executor"
        updated["retrieval_meta"] = retrieval_meta
    return updated
