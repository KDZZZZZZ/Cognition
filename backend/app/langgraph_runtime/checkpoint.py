from typing import Any, Dict


def merge_graph_checkpoint(artifacts: Dict[str, Any], checkpoint: Dict[str, Any]) -> Dict[str, Any]:
    merged = dict(artifacts or {})
    merged["graph_checkpoint"] = checkpoint
    return merged
