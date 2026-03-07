from typing import AsyncGenerator
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy import event, inspect, text
from app.config import settings
from app.models import Base


# Configure engine based on database type
engine_args = {
    "echo": settings.DATABASE_ECHO,
    "pool_pre_ping": True,
}

if "sqlite" in settings.DATABASE_URL:
    engine_args["connect_args"] = {
        "check_same_thread": False,
        "timeout": 30,
    }
else:
    engine_args["pool_size"] = 10
    engine_args["max_overflow"] = 20

engine = create_async_engine(
    settings.DATABASE_URL,
    **engine_args
)


# Enable foreign key constraints for SQLite (CRITICAL FIX for cascade delete)
# SQLite disables FK constraints by default for backward compatibility
@event.listens_for(engine.sync_engine, "connect")
def enable_sqlite_foreign_keys(dbapi_conn, connection_record):
    """Enable foreign key support on SQLite connections."""
    if "sqlite" in settings.DATABASE_URL:
        try:
            dbapi_conn.execute("PRAGMA journal_mode = WAL")
            dbapi_conn.execute("PRAGMA busy_timeout = 30000")
            dbapi_conn.execute("PRAGMA foreign_keys = ON")
        except Exception as e:
            print(f"Warning: Could not enable foreign key constraints: {e}")

async_session_maker = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_maker() as session:
        try:
            yield session
        finally:
            await session.close()


async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.run_sync(_ensure_runtime_schema)


def _ensure_runtime_schema(sync_conn):
    inspector = inspect(sync_conn)
    if not inspector.has_table("versions"):
        return

    version_columns = {column["name"] for column in inspector.get_columns("versions")}
    if "result_snapshot" not in version_columns:
        sync_conn.execute(text("ALTER TABLE versions ADD COLUMN result_snapshot TEXT"))
