from app.services.version_snapshot_repair import detect_mangled_snapshot_repair


def test_detect_mangled_snapshot_repair_restores_context_for_serialized_markdown():
    context = """---
title: Visual Diff Sandbox
tags: [alpha, beta]
summary: baseline metadata
---

| Metric | Value |
| --- | --- |
| MMLU | 54.1 |
| GSM8K | 77.1 |

Paragraph with footnote[^1].

[^1]: old footnote
"""
    result = """---

## title: Visual Diff Sandbox tags: \\[alpha, beta\\] summary: baseline metadata

MetricValueMMLU54.1GSM8K77.1

Paragraph with footnote\\[^1\\].

\\[^1\\]: old footnote
"""

    repair = detect_mangled_snapshot_repair(context, result)

    assert repair is not None
    assert repair.replacement_result_snapshot == context


def test_detect_mangled_snapshot_repair_ignores_real_content_changes():
    context = """# Notes

- apple
- banana
"""
    result = """# Notes

- apple
- pear
"""

    repair = detect_mangled_snapshot_repair(context, result)

    assert repair is None
