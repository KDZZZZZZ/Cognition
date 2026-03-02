from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.database import init_db
from app.models import Base


@pytest.fixture(scope="session", autouse=True)
async def initialize_app_database():
    await init_db()
    yield


@pytest.fixture
async def db_session(tmp_path):
    db_file = tmp_path / "unit-test.db"
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{db_file}",
        connect_args={"check_same_thread": False, "timeout": 30},
    )
    session_maker = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    try:
        async with session_maker() as session:
            yield session
            await session.rollback()
    finally:
        await engine.dispose()
