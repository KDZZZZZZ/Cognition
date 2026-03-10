from sqlalchemy import create_engine, text

from app.database import _ensure_runtime_schema


def test_runtime_schema_normalizes_legacy_version_enum_storage():
    engine = create_engine("sqlite:///:memory:")
    with engine.begin() as conn:
        conn.execute(
            text(
                """
                CREATE TABLE versions (
                    id TEXT PRIMARY KEY,
                    file_id TEXT NOT NULL,
                    author TEXT NOT NULL,
                    change_type TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    diff_patch TEXT,
                    context_snapshot TEXT,
                    timestamp DATETIME NOT NULL
                )
                """
            )
        )
        conn.execute(
            text(
                """
                INSERT INTO versions (
                    id, file_id, author, change_type, summary, diff_patch, context_snapshot, timestamp
                ) VALUES (
                    'v1', 'f1', 'agent', 'edit', 'repair', '', '', '2026-03-07 00:00:00'
                )
                """
            )
        )

        _ensure_runtime_schema(conn)

        row = conn.execute(
            text("SELECT author, change_type, result_snapshot FROM versions WHERE id = 'v1'")
        ).mappings().one()

    assert row["author"] == "AGENT"
    assert row["change_type"] == "EDIT"
    assert row["result_snapshot"] is None
