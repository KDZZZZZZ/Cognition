import time
from typing import Any, Awaitable, Callable, Dict, Optional

from app.langgraph_runtime.nodes import (
    evidence_map_reduce_node,
    normalize_input_node,
    retrieval_bundle_node,
    retrieve_rerank_node,
)
from app.langgraph_runtime.state import LangGraphTurnState

GRAPH_VERSION = 1


async def _run_node(
    state: Dict[str, Any],
    *,
    node_name: str,
    node_fn: Callable[[Dict[str, Any]], Awaitable[Dict[str, Any]]],
    timings: Dict[str, int],
) -> Dict[str, Any]:
    started = time.perf_counter()
    updated = await node_fn(state)
    timings[node_name] = int((time.perf_counter() - started) * 1000)
    return updated


async def run_task_registry_turn(
    *,
    initial_state: LangGraphTurnState,
    execute_turn: Callable[..., Awaitable[Dict[str, Any]]],
    execute_kwargs: Dict[str, Any],
) -> Dict[str, Any]:
    timings: Dict[str, int] = {}
    state: Dict[str, Any] = dict(initial_state or {})

    state = await _run_node(state, node_name="normalize_input_node", node_fn=normalize_input_node, timings=timings)
    state = await _run_node(state, node_name="retrieval_bundle_node", node_fn=retrieval_bundle_node, timings=timings)
    state = await _run_node(state, node_name="retrieve_rerank_node", node_fn=retrieve_rerank_node, timings=timings)
    state = await _run_node(state, node_name="evidence_map_reduce_node", node_fn=evidence_map_reduce_node, timings=timings)

    exec_started = time.perf_counter()
    execution = await execute_turn(**execute_kwargs)
    timings["step_executor_node"] = int((time.perf_counter() - exec_started) * 1000)

    existing_execution_meta = execution.get("execution_meta")
    if isinstance(existing_execution_meta, dict):
        node_timings_ms = dict(existing_execution_meta.get("node_timings_ms") or {})
        node_timings_ms.update(timings)
        execution_meta = {
            **existing_execution_meta,
            "runtime": "langgraph",
            "graph_version": GRAPH_VERSION,
            "node_timings_ms": node_timings_ms,
        }
    else:
        execution_meta = {
            "runtime": "langgraph",
            "graph_version": GRAPH_VERSION,
            "node_timings_ms": timings,
            "compact_phase": execution.get("compact_phase") or "deferred",
        }
    execution["execution_meta"] = execution_meta

    if not isinstance(execution.get("retrieval_meta"), dict):
        if isinstance(state.get("retrieval_meta"), dict):
            execution["retrieval_meta"] = state.get("retrieval_meta")

    return execution
