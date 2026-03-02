from typing import Any, Dict, List, Optional


def _default_memory_payload() -> Dict[str, Any]:
    return {
        "lifecycle": "session",
        "compact": {
            "lifecycle": "session",
            "trigger": {
                "context_window_tokens": 256000,
                "trigger_ratio": 0.8,
            },
            "latest": {
                "compaction_id": None,
                "sequence": 0,
                "summary": "No compaction yet.",
                "key_state": {
                    "current_goal": None,
                    "current_material": None,
                    "current_section": None,
                    "next_step": None,
                },
                "hard_constraints": [],
                "temporary_decisions": [],
                "unwritten_conclusions": [],
                "open_loops": [],
                "updated_at": None,
            },
            "history_tail": [],
        },
        "epoch": {
            "lifecycle": "epoch",
            "epoch_id": "",
            "state": "planning",
            "started_at": "",
            "updated_at": "",
            "dialogue": {
                "lifecycle": "epoch",
                "latest_user_goal": None,
                "current_focus": {"book": None, "section": None},
                "next_action": None,
                "recent_turns": [],
            },
            "tool_history": {
                "lifecycle": "epoch",
                "calls": [],
                "stats": {
                    "total": 0,
                    "failed": 0,
                    "write_ops": 0,
                },
            },
            "task_list": {
                "lifecycle": "epoch",
                "items": [],
                "counts": {
                    "total": 0,
                    "running": 0,
                    "waiting": 0,
                    "completed": 0,
                },
            },
        },
    }


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
    system_prompt: Optional[Dict[str, Any]] = None,
    memory: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    read_files: List[Dict[str, Any]] = []
    write_files: List[Dict[str, Any]] = []
    hidden_files: List[Dict[str, Any]] = []

    hidden_ids: set[str] = set()

    for file_id, info in permitted_files_info.items():
        permission = permissions.get(file_id, "read") if permissions else "read"
        item = {
            "file_id": file_id,
            "name": info.get("name"),
            "type": info.get("type"),
            "permission": permission,
        }
        if permission == "none":
            hidden_files.append({**item, "permission": "none"})
            hidden_ids.add(file_id)
        elif permission == "write":
            write_files.append(item)
        else:
            read_files.append(item)

    for file_id, permission in (permissions or {}).items():
        if permission != "none":
            continue
        if file_id in hidden_ids:
            continue
        info = permitted_files_info.get(file_id) or {}
        hidden_files.append(
            {
                "file_id": file_id,
                "name": info.get("name"),
                "type": info.get("type"),
                "permission": "none",
            }
        )

    file_permissions_and_user_view_list = {
        "read": read_files,
        "write": write_files,
        "none": hidden_files,
        "total": len(read_files) + len(write_files) + len(hidden_files),
    }

    system_prompt_block = dict(system_prompt or {})
    system_prompt_block["file_permissions_and_user_view_list"] = file_permissions_and_user_view_list

    manifest = {
        "session_id": session_id,
        "task_id": task_id,
        "context_input": {
            "system_prompt": system_prompt_block,
            "memory": memory or _default_memory_payload(),
        },
        "permitted_files": file_permissions_and_user_view_list,
        "active_viewport": viewport,
        "active_page_excerpt": active_excerpt,
        "retrieved_context_refs": retrieval_refs[:20],
        "latest_compaction_summary": compact_summary,
        "task_state_snapshot": task_state,
    }

    # Backward compatibility for existing consumers.
    manifest["retrieval_refs"] = manifest["retrieved_context_refs"]
    manifest["task_state"] = manifest["task_state_snapshot"]
    manifest["memory"] = manifest["context_input"]["memory"]
    return manifest
