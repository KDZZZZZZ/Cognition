from typing import Any, Dict


async def normalize_input_node(state: Dict[str, Any]) -> Dict[str, Any]:
    normalized = dict(state)
    normalized["session_id"] = str(state.get("session_id") or "").strip()
    normalized["user_message"] = str(state.get("user_message") or "").strip()
    readable_files = state.get("readable_files")
    if not isinstance(readable_files, list):
        readable_files = []
    normalized["readable_files"] = [str(item) for item in readable_files if str(item or "").strip()]
    if not isinstance(state.get("permitted_files_info"), dict):
        normalized["permitted_files_info"] = {}
    return normalized
