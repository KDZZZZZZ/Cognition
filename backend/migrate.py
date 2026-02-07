"""
Database Migration Script

This script migrates the database schema to support:
1. File hierarchy (parent_id column)
2. Version tracking improvements

Usage:
    python migrate.py

For SQLite databases, this will:
- Add parent_id column to files table
- Add foreign key constraint
- Create index on parent_id
"""

import asyncio
import os
import sys
from pathlib import Path

# Add backend to path
sys.path.insert(0, str(Path(__file__).parent))

from sqlalchemy import text, inspect, create_engine, MetaData, Table, Column, String, ForeignKey
from sqlalchemy.ext.asyncio import create_async_engine
from app.config import settings


async def migrate_sqlite():
    """Handle SQLite migration (which has limited ALTER TABLE support)."""
    print("Detected SQLite database - running migration...")

    # Convert async sqlite URL to sync for migration
    sync_url = settings.DATABASE_URL.replace("sqlite+aiosqlite://", "sqlite://")
    engine = create_engine(sync_url)

    with engine.connect() as conn:
        # Check if parent_id column exists
        result = conn.execute(text("PRAGMA table_info(files)"))
        columns = [row[1] for row in result]

        if "parent_id" in columns:
            print("[OK] parent_id column already exists in files table")
        else:
            print("Adding parent_id column to files table...")
            conn.execute(text("ALTER TABLE files ADD COLUMN parent_id VARCHAR(36)"))
            conn.execute(text("CREATE INDEX idx_files_parent_id ON files(parent_id)"))
            conn.commit()
            print("[OK] Added parent_id column and index")

        # Verify versions table exists
        result = conn.execute(text("SELECT name FROM sqlite_master WHERE type='table' AND name='versions'"))
        if result.fetchone():
            print("[OK] versions table exists")
        else:
            print("Creating versions table...")
            conn.execute(text("""
                CREATE TABLE versions (
                    id VARCHAR(36) PRIMARY KEY,
                    file_id VARCHAR(36) NOT NULL,
                    author VARCHAR(10) NOT NULL,
                    change_type VARCHAR(20) NOT NULL,
                    summary VARCHAR(500) NOT NULL,
                    diff_patch TEXT,
                    context_snapshot TEXT,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
                )
            """))
            conn.execute(text("CREATE INDEX idx_versions_file_id ON versions(file_id)"))
            conn.execute(text("CREATE INDEX idx_versions_timestamp ON versions(timestamp)"))
            conn.commit()
            print("[OK] Created versions table")

    print("SQLite migration complete!")


async def migrate_postgres():
    """Handle PostgreSQL migration."""
    print("Detected PostgreSQL database - running migration...")

    from app.database import engine

    async with engine.begin() as conn:
        # Check if parent_id column exists
        result = await conn.execute(text("""
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'files' AND column_name = 'parent_id'
        """))

        if result.fetchone():
            print("[OK] parent_id column already exists in files table")
        else:
            print("Adding parent_id column to files table...")
            await conn.execute(text("""
                ALTER TABLE files
                ADD COLUMN parent_id VARCHAR(36),
                ADD CONSTRAINT fk_files_parent
                    FOREIGN KEY (parent_id) REFERENCES files(id) ON DELETE CASCADE
            """))
            await conn.execute(text("CREATE INDEX idx_files_parent_id ON files(parent_id)"))
            print("[OK] Added parent_id column, foreign key, and index")

        # Check if versions table exists
        result = await conn.execute(text("""
            SELECT table_name
            FROM information_schema.tables
            WHERE table_name = 'versions'
        """))

        if result.fetchone():
            print("[OK] versions table exists")
        else:
            print("Creating versions table...")
            await conn.execute(text("""
                CREATE TABLE versions (
                    id VARCHAR(36) PRIMARY KEY,
                    file_id VARCHAR(36) NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                    author VARCHAR(10) NOT NULL,
                    change_type VARCHAR(20) NOT NULL,
                    summary VARCHAR(500) NOT NULL,
                    diff_patch TEXT,
                    context_snapshot TEXT,
                    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """))
            await conn.execute(text("CREATE INDEX idx_versions_file_id ON versions(file_id)"))
            await conn.execute(text("CREATE INDEX idx_versions_timestamp ON versions(timestamp)"))
            print("[OK] Created versions table")

    print("PostgreSQL migration complete!")


async def main():
    """Main migration entry point."""
    print(f"Database Migration Tool")
    print(f"Database URL: {settings.DATABASE_URL.replace('://', '://***:***@') if '://' in settings.DATABASE_URL else settings.DATABASE_URL}")
    print("-" * 50)

    try:
        if "sqlite" in settings.DATABASE_URL.lower():
            await migrate_sqlite()
        elif "postgres" in settings.DATABASE_URL.lower():
            await migrate_postgres()
        else:
            print(f"Warning: Unknown database type. Attempting generic migration...")
            await migrate_postgres()

        print("-" * 50)
        print("[SUCCESS] Migration completed successfully!")
        print("\nNew features available:")
        print("  - File/folder hierarchy with parent_id")
        print("  - Version tracking for file edits")
        print("  - Move files between folders")
        print("  - Tree structure API endpoint")

    except Exception as e:
        print(f"\n[ERROR] Migration failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
