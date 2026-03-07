from __future__ import annotations

from collections import OrderedDict
from typing import Callable, Dict, List, Optional, Sequence, Tuple, TypeVar

T = TypeVar("T")
PageWindowKey = Tuple[int, int]


def page_window_bounds(page: Optional[int], window_size: int) -> PageWindowKey:
    normalized_page = max(1, int(page or 1))
    normalized_size = max(1, int(window_size or 1))
    start = ((normalized_page - 1) // normalized_size) * normalized_size + 1
    end = start + normalized_size - 1
    return start, end


def build_page_window_texts(
    items: Sequence[T],
    *,
    page_getter: Callable[[T], Optional[int]],
    text_getter: Callable[[T], str],
    window_size: int,
    max_chars: int,
) -> tuple[Dict[PageWindowKey, str], List[PageWindowKey]]:
    pieces_by_key: "OrderedDict[PageWindowKey, List[str]]" = OrderedDict()
    item_keys: List[PageWindowKey] = []

    for item in items:
        key = page_window_bounds(page_getter(item), window_size)
        item_keys.append(key)
        text = " ".join(str(text_getter(item) or "").split())
        if not text:
            continue
        pieces_by_key.setdefault(key, []).append(text)

    window_texts: Dict[PageWindowKey, str] = {}
    hard_limit = max(1200, int(max_chars or 12000))

    for key, pieces in pieces_by_key.items():
        deduped: List[str] = []
        seen = set()
        consumed = 0
        for piece in pieces:
            marker = piece[:240]
            if marker in seen:
                continue
            seen.add(marker)

            piece_len = len(piece)
            if consumed and consumed + piece_len + 2 > hard_limit:
                remain = hard_limit - consumed
                if remain > 120:
                    deduped.append(piece[:remain].rstrip())
                break

            deduped.append(piece)
            consumed += piece_len + (2 if consumed else 0)

        window_texts[key] = "\n\n".join(deduped).strip()

    return window_texts, item_keys
