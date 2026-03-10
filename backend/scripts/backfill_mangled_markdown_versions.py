from __future__ import annotations

import argparse
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

from app.services.version_snapshot_repair import build_unified_diff, detect_mangled_snapshot_repair


def utc_now_sqlite() -> str:
    return datetime.now(timezone.utc).replace(tzinfo=None).isoformat(sep=" ")


def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill mangled markdown version snapshots.")
    parser.add_argument("--db", default="backend/knowledge_ide.db")
    parser.add_argument("--file-prefix", default="md-visual-")
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--repair-live-files", action="store_true")
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        raise SystemExit(f"Database not found: {db_path}")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    rows = conn.execute(
        """
        select
          v.id as version_id,
          v.file_id as file_id,
          v.timestamp as timestamp,
          v.summary as summary,
          v.context_snapshot as context_snapshot,
          v.result_snapshot as result_snapshot,
          f.name as file_name,
          f.path as file_path
        from versions v
        join files f on f.id = v.file_id
        where f.name like ?
        order by v.timestamp asc
        """,
        (f"{args.file_prefix}%",),
    ).fetchall()

    candidate_ids: list[str] = []
    per_file_versions: dict[str, list[sqlite3.Row]] = {}
    for row in rows:
        per_file_versions.setdefault(row["file_id"], []).append(row)

    for row in rows:
        repair = detect_mangled_snapshot_repair(row["context_snapshot"], row["result_snapshot"])
        if not repair:
            continue
        candidate_ids.append(row["version_id"])
        print(f"CANDIDATE {row['file_name']} {row['version_id']} {repair.reason}")
        if not args.write:
            continue
        conn.execute(
            """
            update versions
            set result_snapshot = ?, diff_patch = ?
            where id = ?
            """,
            (
                repair.replacement_result_snapshot,
                build_unified_diff(row["context_snapshot"], repair.replacement_result_snapshot),
                row["version_id"],
            ),
        )

    if args.write and args.repair_live_files:
        for file_id, version_rows in per_file_versions.items():
            latest_version = version_rows[-1]
            file_path = Path(latest_version["file_path"])
            if not file_path.is_absolute():
                file_path = (db_path.parent / file_path).resolve()
            if not file_path.exists():
                continue

            current_content = file_path.read_text(encoding="utf-8")
            clean_target = latest_version["result_snapshot"] or latest_version["context_snapshot"]
            if not clean_target or current_content == clean_target:
                continue

            repair = detect_mangled_snapshot_repair(clean_target, current_content)
            if not repair or repair.replacement_result_snapshot != clean_target:
                continue

            repaired_content = clean_target
            file_path.write_text(repaired_content, encoding="utf-8")
            timestamp = utc_now_sqlite()
            conn.execute(
                """
                update files
                set size = ?, updated_at = ?
                where id = ?
                """,
                (len(repaired_content.encode("utf-8")), timestamp, file_id),
            )
            conn.execute(
                """
                insert into versions (
                  id, file_id, author, change_type, summary, diff_patch,
                  context_snapshot, timestamp, result_snapshot
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(uuid.uuid4()),
                    file_id,
                    "AGENT",
                    "EDIT",
                    "Repair mangled markdown structure",
                    build_unified_diff(current_content, repaired_content),
                    current_content,
                    timestamp,
                    repaired_content,
                ),
            )
            print(f"LIVE-REPAIR {latest_version['file_name']}")

    if args.write:
        conn.commit()
        print(f"Repaired {len(candidate_ids)} version snapshot(s).")
    else:
        print(f"Would repair {len(candidate_ids)} version snapshot(s).")

    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
