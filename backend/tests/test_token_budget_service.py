from app.services.token_budget_service import estimate_messages_tokens, estimate_tokens, short_text


def test_estimate_tokens_and_messages():
    assert estimate_tokens("") == 0
    assert estimate_tokens("abcd") == 1
    assert estimate_tokens("a" * 40) == 10

    total = estimate_messages_tokens(
        [
            {"role": "user", "content": "hello world"},
            {"role": "assistant", "content": "done"},
        ]
    )
    assert total > 0


def test_short_text_limits():
    assert short_text("abc", limit=10) == "abc"
    assert short_text("1234567890", limit=6) == "123..."
