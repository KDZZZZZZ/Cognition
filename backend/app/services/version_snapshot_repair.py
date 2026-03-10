from __future__ import annotations

import difflib
import re
from dataclasses import dataclass


FRONTMATTER_HEADING_PATTERN = re.compile(r"^---\s*\n\s*\n##\s+\w+:", re.MULTILINE)
MATH_SPAN_PATTERN = re.compile(
    r"<span\b([^>]*\bdata-type=(['\"])inlineMath\2[^>]*)>([\s\S]*?)</span>",
    re.IGNORECASE,
)
INLINE_IMAGE_FOLLOWED_TEXT_PATTERN = re.compile(r"!\[[^\]]*\]\([^)]+\)(?=\S)")


@dataclass(frozen=True)
class SnapshotRepairCandidate:
    replacement_result_snapshot: str
    reason: str


def _normalize_math_spans(value: str) -> str:
    def repl(match: re.Match[str]) -> str:
        attrs = match.group(1)
        inner = match.group(3)
        display = re.search(r'data-display=(["\'])(true|yes|1)\1', attrs, re.IGNORECASE)
        latex = re.search(r'data-latex=(["\'])([\s\S]*?)\1', attrs, re.IGNORECASE)
        formula = latex.group(2) if latex else inner
        formula = (
            formula.replace("&quot;", '"')
            .replace("&#39;", "'")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&amp;", "&")
            .strip()
        )
        return f"$${formula}$$" if display else f"${formula}$"

    return MATH_SPAN_PATTERN.sub(repl, value)


def _semantic_plain_text(value: str) -> str:
    normalized = _normalize_math_spans(value)
    normalized = re.sub(r"!\[([^\]]*)\]\([^)]+\)", r" \1 ", normalized)
    normalized = re.sub(r"\[([^\]]+)\]\([^)]+\)", r" \1 ", normalized)
    normalized = re.sub(r"`{1,3}", " ", normalized)
    normalized = re.sub(r"</?[^>]+>", " ", normalized)
    normalized = normalized.replace("\\[", "[").replace("\\]", "]")
    normalized = normalized.replace("\\(", "(").replace("\\)", ")")
    normalized = re.sub(r"^[#>\-\+\*\s]+", " ", normalized, flags=re.MULTILINE)
    normalized = normalized.replace("|", " ")
    normalized = normalized.replace("---", " ")
    normalized = normalized.replace("$$", " ")
    normalized = normalized.replace("$", " ")
    normalized = re.sub(r"\s+", " ", normalized)
    return normalized.strip().lower()


def _similarity_ratio(left: str, right: str) -> float:
    if not left and not right:
        return 1.0
    return difflib.SequenceMatcher(a=left, b=right, autojunk=False).ratio()


def _has_suspicious_markdown_damage(context_snapshot: str, result_snapshot: str) -> bool:
    if "<span data-latex=" in result_snapshot:
        return True
    if FRONTMATTER_HEADING_PATTERN.search(result_snapshot):
        return True
    if INLINE_IMAGE_FOLLOWED_TEXT_PATTERN.search(result_snapshot):
        return True
    if "| Metric | Value |" in context_snapshot and "MetricValue" in result_snapshot:
        return True
    if "[ ]" in context_snapshot and "\\[ \\]" in result_snapshot:
        return True
    if "[x]" in context_snapshot and "\\[x\\]" in result_snapshot:
        return True
    return False


def detect_mangled_snapshot_repair(
    context_snapshot: str | None,
    result_snapshot: str | None,
) -> SnapshotRepairCandidate | None:
    if not context_snapshot or not result_snapshot:
        return None

    if context_snapshot == result_snapshot:
        return None

    if not _has_suspicious_markdown_damage(context_snapshot, result_snapshot):
        return None

    semantic_context = _semantic_plain_text(context_snapshot)
    semantic_result = _semantic_plain_text(result_snapshot)
    ratio = _similarity_ratio(semantic_context, semantic_result)
    if ratio < 0.92:
        return None

    return SnapshotRepairCandidate(
        replacement_result_snapshot=context_snapshot,
        reason=f"semantic-match:{ratio:.3f}",
    )


def build_unified_diff(old_content: str, new_content: str) -> str:
    if old_content == new_content:
        return ""
    return "".join(
        difflib.unified_diff(
            old_content.splitlines(keepends=True),
            new_content.splitlines(keepends=True),
            fromfile="old",
            tofile="new",
            lineterm="",
        )
    )
