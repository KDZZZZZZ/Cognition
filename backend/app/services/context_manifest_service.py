from typing import Any, Dict, List, Optional


def build_context_manifest(
    *,
    session_id: str,
    task_id: str,
    permissions: Dict[str, str],
    permitted_files_info: Dict[str, Dict[str, str]],
    viewport: Optional[Dict[str, Any]],
    active_excerpt: Optional[str],
    retrieval_refs: List[Dict[str, Any]],
    compact_summary: Optional[str],
    task_state: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    read_files = []
    write_files = []

    for file_id, info in permitted_files_info.items():
        permission = permissions.get(file_id, "read") if permissions else "read"
        item = {
            "file_id": file_id,
            "name": info.get("name"),
            "type": info.get("type"),
            "permission": permission,
        }
        if permission == "write":
            write_files.append(item)
        else:
            read_files.append(item)

    manifest = {
        "session_id": session_id,
        "task_id": task_id,
        "permitted_files": {
            "read": read_files,
            "write": write_files,
            "total": len(permitted_files_info),
        },
        "active_viewport": viewport,
        "active_page_excerpt": active_excerpt,
        "retrieved_context_refs": retrieval_refs[:20],
        "latest_compaction_summary": compact_summary,
        "task_state_snapshot": task_state,
    }
    # Backward compatibility for any existing consumer of previous keys.
    manifest["retrieval_refs"] = manifest["retrieved_context_refs"]
    manifest["task_state"] = manifest["task_state_snapshot"]
    return manifest
