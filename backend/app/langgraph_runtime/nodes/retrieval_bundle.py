from typing import Any, Dict

from app.services.retrieval_service import build_query_bundle


async def retrieval_bundle_node(state: Dict[str, Any]) -> Dict[str, Any]:
    updated = dict(state)
    query_bundle = build_query_bundle(str(state.get("user_message") or ""))
    updated["retrieval_meta"] = {
        "query_bundle": query_bundle,
        "candidate_count": 0,
        "reranked_count": 0,
        "evidence_count": 0,
        "stop_reason": "not_executed",
    }
    return updated
