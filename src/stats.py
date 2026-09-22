"""
Stats & Leaderboard public API
  GET /stats/all — all stats + leaderboard in one request
"""
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, Query
import asyncio

from src.sql.users import get_all_user_ids_for_public
from src.redis_client.leaderboards import get_top_users, get_stats_overview
from src.redis_client.keys import RedisKeys
from src.redis_client.client import client as r
from src.canvases import canvases

router = APIRouter(prefix="/stats", tags=["stats"])

@router.get("/all")
async def stats_all():
    base = await get_stats_overview()

    today_str     = datetime.now(timezone.utc).date().isoformat()
    yesterday_str = (datetime.now(timezone.utc).date() - timedelta(days=1)).isoformat()

    today_key   = RedisKeys.DAILY_PIXELS.value.format(day=today_str)
    country_key = RedisKeys.DAILY_COUNTRY_PIXELS.value.format(day=today_str)

    canvas_ids = list(canvases.keys()) + [-1]

    # Build all leaderboard tasks
    lb_tasks = {
        (cid, daily): get_top_users(cid, daily, 100)
        for cid in canvas_ids
        for daily in (True, False)
    }

    results = await asyncio.gather(
        r.zcard(today_key),
        r.get(f"daily_total:{yesterday_str}"),
        r.zrange(country_key, 0, -1, withscores=True),
        *lb_tasks.values(),
    )

    active_today, yesterday_val, countries = results[0], results[1], results[2]
    lb_results = dict(zip(lb_tasks.keys(), results[3:]))

    all_user_ids = {uid for entries in lb_results.values() for uid, _ in entries}
    user_map = await get_all_user_ids_for_public(all_user_ids)

    yesterday_pixels = int(yesterday_val or 0)
    today_pixels     = base["today_pixels"]
    change_pct       = (
        round(((today_pixels - yesterday_pixels) / yesterday_pixels) * 100, 1)
        if yesterday_pixels > 0 else None
    )
    history = base["daily_history"]
    peak    = max(history, key=lambda d: d["pixels"]) if history else None

    def fmt_entries(entries):
        return [
            {"rank": rank, "user_id": uid, "score": score}
            for rank, (uid, score) in enumerate(entries, 1)
        ]

    leaderboards = {}
    for cid in canvas_ids:
        canvas_key = "all" if cid == -1 else str(cid)
        leaderboards[canvas_key] = {
            "alltime": fmt_entries(lb_results[(cid, False)]),
            "daily":   fmt_entries(lb_results[(cid, True)]),
        }

    return {
        **base,
        "active_today":     int(active_today),
        "yesterday_pixels": yesterday_pixels,
        "today_change_pct": change_pct,
        "peak_day":         peak["date"]   if peak else None,
        "peak_pixels":      peak["pixels"] if peak else 0,
        "leaderboards":     leaderboards,
        "countries":        countries,
        "users":            {str(uid): u for uid, u in user_map.items()},
    }