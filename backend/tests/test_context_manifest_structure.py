from app.services.context_manifest_service import build_context_manifest


def test_context_manifest_includes_structured_memory_and_compat_fields():
    manifest = build_context_manifest(
        session_id="s-1",
        task_id="t-1",
        permissions={
            "f-read": "read",
            "f-write": "write",
            "f-none": "none",
        },
        permitted_files_info={
            "f-read": {"name": "book.pdf", "type": "pdf"},
            "f-write": {"name": "notes.md", "type": "md"},
            "f-none": {"name": "hidden.md", "type": "md"},
        },
        viewport={"file_id": "f-read", "page": 3},
        active_excerpt="excerpt",
        retrieval_refs=[{"id": "r1"}],
        compact_summary="compact summary",
        task_state={"state": "executing"},
        system_prompt={
            "soul": None,
            "role": "role",
            "workflow": "workflow",
            "rule": "rule",
            "note_struct": {
                "paper_template": "paper",
                "textbook_template": "textbook",
                "section_template": "section",
            },
            "tool_introduction_and_help": "tools",
        },
        memory={
            "lifecycle": "session",
            "compact": {"lifecycle": "session", "latest": {"summary": "s"}, "history_tail": []},
            "epoch": {
                "lifecycle": "epoch",
                "epoch_id": "t-1",
                "state": "executing",
                "dialogue": {"lifecycle": "epoch", "recent_turns": []},
                "tool_history": {"lifecycle": "epoch", "calls": [], "stats": {"total": 0, "failed": 0, "write_ops": 0}},
                "task_list": {"lifecycle": "epoch", "items": [], "counts": {"total": 0, "running": 0, "waiting": 0, "completed": 0}},
            },
        },
    )

    ctx = manifest["context_input"]
    sys_prompt = ctx["system_prompt"]
    memory = ctx["memory"]

    assert sys_prompt["role"] == "role"
    assert "file_permissions_and_user_view_list" in sys_prompt
    assert sys_prompt["file_permissions_and_user_view_list"]["total"] == 3
    assert len(sys_prompt["file_permissions_and_user_view_list"]["read"]) == 1
    assert len(sys_prompt["file_permissions_and_user_view_list"]["write"]) == 1
    assert len(sys_prompt["file_permissions_and_user_view_list"]["none"]) == 1

    assert memory["lifecycle"] == "session"
    assert memory["epoch"]["epoch_id"] == "t-1"
    assert memory["epoch"]["tool_history"]["calls"] == []

    # Backward compatibility keys
    assert manifest["retrieval_refs"] == manifest["retrieved_context_refs"]
    assert manifest["task_state"] == manifest["task_state_snapshot"]
    assert manifest["memory"] == manifest["context_input"]["memory"]


def test_context_manifest_default_memory_shape_is_complete():
    manifest = build_context_manifest(
        session_id="s-2",
        task_id="t-2",
        permissions={},
        permitted_files_info={},
        viewport=None,
        active_excerpt=None,
        retrieval_refs=[],
        compact_summary=None,
        task_state=None,
        system_prompt={"role": "role"},
        memory=None,
    )

    memory = manifest["context_input"]["memory"]
    assert memory["lifecycle"] == "session"
    assert memory["compact"]["lifecycle"] == "session"
    assert memory["compact"]["latest"]["compaction_id"] is None
    assert memory["compact"]["latest"]["key_state"]["current_goal"] is None
    assert memory["epoch"]["lifecycle"] == "epoch"
    assert "tool_history" in memory["epoch"]
