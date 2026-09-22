import os
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase

MARIADB_USER = os.getenv("MARIADB_USER", "root")
MARIADB_PASSWORD = os.getenv("MARIADB_PASSWORD", "root")
MARIADB_HOST = os.getenv("MARIADB_HOST", "mariadb")
MARIADB_PORT = os.getenv("MARIADB_PORT", "3306")
MARIADB_DATABASE = os.getenv("MARIADB_DATABASE", "pixmap")

DATABASE_URL = (
    f"mysql+aiomysql://{MARIADB_USER}:{MARIADB_PASSWORD}"
    f"@{MARIADB_HOST}:{MARIADB_PORT}/{MARIADB_DATABASE}"
)
SERVER_DATABASE_URL = (
    f"mysql+aiomysql://{MARIADB_USER}:{MARIADB_PASSWORD}"
    f"@{MARIADB_HOST}:{MARIADB_PORT}/"
)

engine = create_async_engine(DATABASE_URL, pool_pre_ping=False, pool_recycle=3600)
AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


def _quote_identifier(name: str) -> str:
    # Keep identifier safe when interpolating into DDL.
    return f"`{name.replace('`', '``')}`"


async def ensure_database_exists():
    bootstrap_engine = create_async_engine(SERVER_DATABASE_URL, pool_pre_ping=False)
    try:
        async with bootstrap_engine.begin() as conn:
            await conn.execute(
                text(
                    "CREATE DATABASE IF NOT EXISTS "
                    f"{_quote_identifier(MARIADB_DATABASE)} "
                    "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
                )
            )
    finally:
        await bootstrap_engine.dispose()


class Base(DeclarativeBase):
    pass


async def get_db():
    async with AsyncSessionLocal() as session:
        yield session