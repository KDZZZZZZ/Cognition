from app.services.token_ledger_service import build_bucket_caps, finalize_budget_meta


def test_finalize_budget_meta_includes_window_usage_and_bucket_ratios():
    caps = build_bucket_caps(1000)
    meta = finalize_budget_meta(
        caps=caps,
        runtime_used=180,
        raw_used=120,
        compact_used=90,
        viewport_used=30,
        tool_schema_tokens=40,
        total_input_tokens=500,
        triggered=False,
        reason="within_budget",
    )

    assert meta["window_usage"]["ratio"] == 0.5
    assert meta["window_usage"]["target_ratio"] == 0.625
    assert meta["window_usage"]["status"] == "safe"
    assert meta["bucket_usage"]["runtime_bucket"]["ratio"] == 0.75
    assert meta["bucket_usage"]["raw_dialogue_bucket"]["ratio"] == 0.5


def test_finalize_budget_meta_marks_critical_window_usage():
    caps = build_bucket_caps(1000)
    meta = finalize_budget_meta(
        caps=caps,
        runtime_used=240,
        raw_used=240,
        compact_used=240,
        viewport_used=80,
        tool_schema_tokens=10,
        total_input_tokens=980,
        triggered=True,
        reason="over_target_budget",
    )

    assert meta["window_usage"]["ratio"] == 0.98
    assert meta["window_usage"]["status"] == "critical"
