from typing import AsyncGenerator
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy import event
from app.config import settings
from app.models import Base


# Configure engine based on database type
engine_args = {
    "echo": settings.DATABASE_ECHO,
    "pool_pre_ping": True,
}

if "sqlite" in settings.DATABASE_URL:
    engine_args["connect_args"] = {"check_same_thread": False}
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
        # For async connections, we need to handle the coroutine properly
        # Just execute the PRAGMA - errors will show in logs if it fails
        try:
            # Try synchronous execution first
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
