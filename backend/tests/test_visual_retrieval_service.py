from app.services.visual_retrieval_service import VisualRetrievalService, _lexical_score, _tokenize


def test_extract_json_from_code_fence():
    service = VisualRetrievalService()
    raw = """```json
{"ranked":[{"candidate_id":"c1","score":0.92,"reason":"table of metrics"}]}
```"""
    parsed = service._extract_json(raw)
    assert isinstance(parsed, dict)
    assert parsed["ranked"][0]["candidate_id"] == "c1"


def test_extract_json_from_wrapped_text():
    service = VisualRetrievalService()
    raw = (
        "best pages => "
        '{"ranked":[{"candidate_id":"c3","score":0.66,"reason":"heading match"}]}'
    )
    parsed = service._extract_json(raw)
    assert isinstance(parsed, dict)
    assert parsed["ranked"][0]["candidate_id"] == "c3"


def test_lexical_helpers_basic():
    tokens = _tokenize("Revenue growth and gross margin")
    score = _lexical_score(tokens, "The gross margin improved while revenue growth accelerated.")
    assert score > 0
