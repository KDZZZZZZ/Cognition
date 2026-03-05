from typing import Any, Dict, List, Optional, TypedDict


class QueryBundleItem(TypedDict):
    text: str
    lang: str
    weight: float
    source: str


class RetrievalMeta(TypedDict, total=False):
    query_bundle: List[QueryBundleItem]
    candidate_count: int
    reranked_count: int
    evidence_count: int
    stop_reason: str


class LangGraphTurnState(TypedDict, total=False):
    session_id: str
    user_message: str
    readable_files: List[str]
    permitted_files_info: Dict[str, Dict[str, str]]
    active_file_id: Optional[str]
    active_page: Optional[int]
    retrieval_meta: RetrievalMeta
    retrieval_result: Dict[str, Any]
