from datetime import datetime, timedelta, timezone

from sqlalchemy import delete
from sqlalchemy.dialects.mysql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from src.classes import Pixel
from src.sql.db import AsyncSessionLocal
from src.sql.models import PixelPlacement
import asyncio

async def delete_old_logs(session: AsyncSession, days: int = 7) -> int:
    """Delete pixel placement logs older than N days."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    result = await session.execute(
        delete(PixelPlacement).where(PixelPlacement.placed_at < cutoff)
    )
    await session.commit()
    return int(result.rowcount or 0)

# --- Pixel log queue ---
# Plain dicts (not ORM instances) so place() stays cheap and flush can
# bulk-INSERT without building thousands of objects on the event loop.

_queue: list[dict] = []
_FLUSH_CHUNK = 5_000

def log_pixels(client, pixels: list[Pixel]) -> None:
    uid = client.user.id if client.user else None
    now = datetime.now(timezone.utc)
    for pixel in pixels:
        _queue.append({
            "ip": client.ip,
            "user_id": uid,
            "x": pixel.x(),
            "y": pixel.y(),
            "canvas_id": client.canvas,
            "color": pixel.color,
            "placed_at": now,
        })

async def flush_queue(session: AsyncSession) -> int:
    """Flush queued placements to DB via chunked bulk INSERT."""
    global _queue
    if not _queue:
        return 0

    batch, _queue = _queue, []
    stmt = insert(PixelPlacement)
    try:
        # Chunk so each await yields the event loop between inserts.
        for i in range(0, len(batch), _FLUSH_CHUNK):
            await session.execute(stmt, batch[i:i + _FLUSH_CHUNK])
        await session.commit()
    except Exception:
        await session.rollback()
        # Put unflushed rows back so the next tick can retry.
        _queue = batch + _queue
        raise

    return len(batch)

async def pixel_log_loop(interval: int = 10) -> None:
    """
    Background loop that flushes the pixel queue every N seconds.
    Start with asyncio.create_task(pixel_log_loop()).
    """
    while True:
        await asyncio.sleep(interval)
        async with AsyncSessionLocal() as session:
            try:
                await flush_queue(session)
            except Exception as e:
                print(f"pixel log flush failed: {e}")
