from src.redis_client.keys import RedisKeys
from datetime import datetime, timezone, timedelta
from .client import client as r
from src.canvases import canvases
from src.socket_server.clients import clients_by_user
from apscheduler.schedulers.asyncio import AsyncIOScheduler

LEADERBOARD_CACHE: dict[str, list] = {}

def _leaderboard_key(canvas_id: int, daily: bool) -> str:
    if canvas_id not in canvases:
        key = RedisKeys.DAILY_PIXELS if daily else RedisKeys.TOTAL_PIXELS
    else:
        key = RedisKeys.DAILY_CANVAS_PIXELS if daily else RedisKeys.CANVAS_PIXELS

    return key.value.format(canvas_id=canvas_id, day=datetime.now(timezone.utc).date().isoformat())

async def _refresh_cache():
    keys_to_cache = []

    for canvas_id in list(canvases.keys()) + [-1]:
        for daily in (True, False):
            keys_to_cache.append((canvas_id, daily, _leaderboard_key(canvas_id, daily)))

    for canvas_id, daily, key in keys_to_cache:
        data = await r.zrange(key, 0, -1, withscores=True)
        cache_key = f"{canvas_id}:{daily}"
        LEADERBOARD_CACHE[cache_key] = data

async def expire_old_daily_leaderboards(keep_days: int = 1):
    cutoff = datetime.now(timezone.utc).date() - timedelta(days=keep_days)

    patterns = [
        RedisKeys.DAILY_PIXELS.value.format(day="*"),
        RedisKeys.DAILY_CANVAS_PIXELS.value.format(day="*", canvas_id="*"),
    ]

    for pattern in patterns:
        async for key in r.scan_iter(pattern):
            key = key.decode("utf-8") if isinstance(key, bytes) else key
            for part in key.split(":"):
                try:
                    key_date = datetime.strptime(part, "%Y-%m-%d").date()
                    if key_date < cutoff:
                        await r.delete(key)
                    break  # found the date segment, stop checking parts
                except ValueError:
                    continue

async def get_leaderboard(canvas_id: int = -1, start: int = 0, end: int = 50, daily: bool = False):
    if len(LEADERBOARD_CACHE) == 0:
        await _refresh_cache()
    cache_key = f"{canvas_id}:{daily}"
    data = LEADERBOARD_CACHE.get(cache_key, [])
    return data[start:end]

async def get_top_users(canvas_id: int = -1, daily: bool = False, limit: int = 50):
    """Return top N (user_id, score) in descending order directly from Redis."""
    key = _leaderboard_key(canvas_id, daily)
    data = await r.zrange(key, 0, limit - 1, desc=True, withscores=True)
    return [(int(uid), int(score)) for uid, score in data]

async def get_user_rank(user_id: int, canvas_id: int = -1, daily: bool = False) -> int | None:
    """1-based leaderboard rank, or None if the user has no ranked pixels."""
    key = _leaderboard_key(canvas_id, daily)
    rank = await r.zrevrank(key, user_id)
    if rank is None:
        return None
    return int(rank) + 1

async def get_pixel_count(user_id: int, canvas_id: int = -1, daily: bool = False):
    key = _leaderboard_key(canvas_id, daily)
    score = await r.zscore(key, user_id)
    return int(score or 0)

# ── Daily snapshot for 30-day history chart ───────────────────────────────────

async def _save_daily_snapshot():
    """Snapshot yesterday's total pixel count for historical chart data (31-day TTL)."""
    yesterday = (datetime.now(timezone.utc).date() - timedelta(days=1)).isoformat()
    yesterday_key = RedisKeys.DAILY_PIXELS.value.format(day=yesterday)
    data = await r.zrange(yesterday_key, 0, -1, withscores=True)
    total = int(sum(score for _, score in data))
    if total > 0:
        await r.set(f"daily_total:{yesterday}", total, ex=32 * 24 * 3600)

async def get_daily_history(days: int = 30) -> list[dict]:
    """Return list of {date, pixels} for the last N days."""
    today = datetime.now(timezone.utc).date()
    history = []
    for i in range(days - 1, -1, -1):
        day = today - timedelta(days=i)
        day_str = day.isoformat()
        if i == 0:
            key = RedisKeys.DAILY_PIXELS.value.format(day=day_str)
            raw = await r.zrange(key, 0, -1, withscores=True)
            pixels = int(sum(s for _, s in raw))
        else:
            val = await r.get(f"daily_total:{day_str}")
            pixels = int(val or 0)
        history.append({"date": day_str, "pixels": pixels})
    return history

async def get_stats_overview() -> dict:
    all_data = await r.zrange("pxls", 0, -1, withscores=True)
    total_pixels = int(sum(s for _, s in all_data))
    total_users  = len(all_data)

    try:
        online_users = len(clients_by_user)
    except Exception:
        online_users = 0

    canvas_stats = {}
    for cid, canvas in canvases.items():
        cd = await r.zrange(f"pxls:{cid}", 0, -1, withscores=True)
        canvas_stats[str(cid)] = {
            "name":         canvas.name,
            "total_pixels": int(sum(s for _, s in cd)),
            "description":  canvas.description,
            "size":         canvas.size,
        }

    today_str    = datetime.now(timezone.utc).date().isoformat()
    today_key    = RedisKeys.DAILY_PIXELS.value.format(day=today_str)
    today_data   = await r.zrange(today_key, 0, -1, withscores=True)
    today_pixels = int(sum(s for _, s in today_data))

    daily_history = await get_daily_history(30)

    return {
        "total_pixels":  total_pixels,
        "total_users":   total_users,
        "online_users":  online_users,
        "today_pixels":  today_pixels,
        "canvases":      canvas_stats,
        "daily_history": daily_history,
    }

async def _daily_reset():
    await _save_daily_snapshot()
    await expire_old_daily_leaderboards()
    await _refresh_cache()

inited = False
async def _init_loop():
    global inited
    if inited:
        return
    inited = True

    scheduler = AsyncIOScheduler(timezone=timezone.utc)
    scheduler.add_job(_daily_reset, "cron", hour=0, minute=0)  # expire + refresh at midnight

    scheduler.add_job(_refresh_cache, "cron", minute="*/10")  # cache every 10 min
    await _refresh_cache() #but set cache now too

    scheduler.start()