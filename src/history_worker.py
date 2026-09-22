"""
History worker — snapshots canvas chunks to disk as PNG files.

Path layout:
  {HISTORY_DIR}/{canvas_id}/{YYYYMMDD}/0000/{cx}_{cy}.png   ← daily root
  {HISTORY_DIR}/{canvas_id}/{YYYYMMDD}/{HHMM}/{cx}_{cy}.png ← incremental diff

Root (0000):
  Indexed-colour (palette) PNG written once per canvas per UTC day.
  Every chunk in the canvas grid is written, including blank ones.

Diff (HHMM):
  Indexed PNG with tRNS: transparent index = unchanged, opaque palette
  indices = changed. (Decodes to RGBA with alpha in browsers / Pillow.)
  Only written when at least one pixel differs from the root snapshot
  held in backup Redis.

Backup Redis:
  Populated during the daily backup and kept in sync across restarts.
  Never flushed except at the start of a new day.

Schedule: runs at :00 and :30 of every hour.
"""

import asyncio
import os
import shutil
import signal
from datetime import datetime, timezone
from pathlib import Path

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from PIL import Image
from redis.asyncio import Redis

from src.canvases import canvases, CHUNK_PX
from src.redis_client.keys import RedisKeys

# Reserved palette index for "unchanged" in diff PNGs (tRNS alpha=0).
# Canvas palettes are far smaller than 256, so 255 is always free.
_DIFF_TRANSPARENT_IDX = 255

# ── Config ────────────────────────────────────────────────────────────────────

REDIS_URL        = os.environ.get("REDIS_URL",        "redis://redis:6379")
BACKUP_REDIS_URL = os.environ.get("BACKUP_REDIS_URL", "redis://redis_backup:6379")
HISTORY_DIR      = Path(os.environ.get("HISTORY_DIR", "/var/www/history"))
HISTORY_ENABLED  = os.environ.get("HISTORY_ENABLED",  "false").lower() == "true"

# Minimum free disk space required (in GB) before allowing history operations
MIN_FREE_DISK_GB = float(os.environ.get("MIN_FREE_DISK_GB", "5.0"))

BATCH = 200

canvas_redis: Redis = None
backup_redis: Redis = None
_disk_space_paused = False


# disk space check

def _check_disk_space() -> tuple[bool, str]:
    global _disk_space_paused
    
    try:
        stat = shutil.disk_usage(HISTORY_DIR)
        free_gb = stat.free / (1024 ** 3)
        total_gb = stat.total / (1024 ** 3)
        used_gb = stat.used / (1024 ** 3)
        
        if free_gb < MIN_FREE_DISK_GB:
            _disk_space_paused = True
            msg = (f"[history] PAUSED - Insufficient disk space! "
                   f"Free: {free_gb:.2f}GB / Total: {total_gb:.2f}GB / Used: {used_gb:.2f}GB. "
                   f"Need at least {MIN_FREE_DISK_GB}GB free.")
            print(msg)
            return False, msg
        
        if _disk_space_paused:
            msg = (f"[history] RESUMED - Disk space available: {free_gb:.2f}GB free "
                   f"(threshold: {MIN_FREE_DISK_GB}GB)")
            print(msg)
            _disk_space_paused = False
        
        return True, f"Disk space OK: {free_gb:.2f}GB free"
    
    except Exception as e:
        print(f"[history] Warning: could not check disk space: {e}")
        return True, "Could not check disk space"


# ── Tiny helpers ──────────────────────────────────────────────────────────────

def _utc_date() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d")

def _utc_time() -> str:
    return datetime.now(timezone.utc).strftime("%H%M")

def _is_blank(data: bytes | None) -> bool:
    if not data:
        return True
    return not any(b & 0x7F for b in data)

def _write_root_png(raw: bytes, cx: str, cy: str,
                    canvas_id: int, palette: list[int]) -> bool:
    if _is_blank(raw):
        return False
    path = _chunk_dir(canvas_id, "0000") / f"{cx}_{cy}.png"
    if path.exists():
        return False
    expected = CHUNK_PX * CHUNK_PX
    if not raw or len(raw) != expected:
        raw = bytes(expected)
    _save_indexed_png(path, bytes(b & 0x7F for b in raw), palette)
    return True

def _parse_coords(key: bytes | str) -> tuple[str, str] | None:
    """Extract (cx, cy) from a Redis chunk key."""
    s = key.decode() if isinstance(key, bytes) else key
    parts = s.split(":")
    if len(parts) < 4:
        return None
    return parts[-2], parts[-1]

def _chunk_dir(canvas_id: int, time_suffix: str) -> Path:
    d = HISTORY_DIR / str(canvas_id) / _utc_date() / time_suffix
    d.mkdir(parents=True, exist_ok=True)
    return d

def _build_palette(canvas_id: int) -> list[int]:
    palette = []
    try:
        c = canvases.get(int(canvas_id))
        if c and getattr(c, "colors", None):
            for color in c.colors:
                palette.extend(color)
    except Exception:
        pass
    if len(palette) < 768:
        palette.extend([0] * (768 - len(palette)))
    return palette[:768]


# ── Root existence check ──────────────────────────────────────────────────────

def _root_exists(canvas_id: int) -> bool:
    """
    True only when today's daily root backup finished successfully.
    The 0000/ directory alone is not enough — a crashed mid-backup leaves
    partial PNGs there, and treating that as "done" skips the rest of the
    canvas forever (history view shows blank chunks for the missing roots).
    """
    root_dir = HISTORY_DIR / str(canvas_id) / _utc_date() / "0000"
    done = root_dir / ".done"
    exists = done.is_file()
    if root_dir.exists():
        file_count = sum(1 for _ in root_dir.glob("*.png"))
        print(f"[history] root check canvas {canvas_id}: "
              f"dir={root_dir}  done={exists}  pngs={file_count}")
    else:
        print(f"[history] root check canvas {canvas_id}: "
              f"dir={root_dir}  exists=False")
    return exists


def _mark_root_done(canvas_id: int) -> None:
    root_dir = HISTORY_DIR / str(canvas_id) / _utc_date() / "0000"
    root_dir.mkdir(parents=True, exist_ok=True)
    (root_dir / ".done").touch()


# ── Redis scanning ────────────────────────────────────────────────────────────

async def _scan_keys(canvas_id: int, redis: Redis) -> list[bytes]:
    pattern = RedisKeys.CHUNK.value.format(canvas_id=canvas_id, cx="*", cy="*")
    cursor, keys = 0, []
    while True:
        cursor, batch = await redis.scan(cursor, match=pattern, count=BATCH)
        keys.extend(batch)
        if cursor == 0:
            break
    return keys


# ── PNG writers (run in executor) ─────────────────────────────────────────────

def _save_indexed_png(
    path: Path,
    indices: bytes,
    palette: list[int],
    *,
    transparent_idx: int | None = None,
) -> None:
    """Save an 8-bit indexed PNG (optional tRNS). Uses Pillow's filter optimizer."""
    img = Image.new("P", (CHUNK_PX, CHUNK_PX))
    img.putdata(indices)
    img.putpalette(palette)
    save_kw: dict = {"optimize": True, "compress_level": 9}
    if transparent_idx is None:
        # Index 0 must stay opaque (unset / ocean colour).
        img.info.pop("transparency", None)
    else:
        save_kw["transparency"] = transparent_idx
    img.save(path, "PNG", **save_kw)


def _write_root_png(raw: bytes, cx: str, cy: str,
                    canvas_id: int, palette: list[int]) -> bool:
    """Write an indexed-colour root PNG (including blank). Skips if file already exists."""
    path = _chunk_dir(canvas_id, "0000") / f"{cx}_{cy}.png"
    if path.exists():
        return False
    expected = CHUNK_PX * CHUNK_PX
    if not raw or len(raw) != expected:
        raw = bytes(expected)
    # Strip protection bit; history PNGs store palette index only.
    _save_indexed_png(path, bytes(b & 0x7F for b in raw), palette)
    return True


def _write_diff_png(current: bytes, root: bytes, cx: str, cy: str,
                    canvas_id: int, time_suffix: str, palette: list[int]) -> bool:
    """
    Write an indexed diff PNG with tRNS.
    Transparent index = unchanged; opaque palette index = changed.
    Far smaller than RGBA for the same pixel changes.
    Only writes if there is at least one difference from root.
    """
    if len(current) != len(root):
        return False

    out = bytearray(len(current))
    changed = False
    for i in range(len(current)):
        cur_idx = current[i] & 0x7F
        if cur_idx == (root[i] & 0x7F):
            out[i] = _DIFF_TRANSPARENT_IDX
        else:
            out[i] = cur_idx
            changed = True
    if not changed:
        return False

    path = _chunk_dir(canvas_id, time_suffix) / f"{cx}_{cy}.png"
    _save_indexed_png(
        path, bytes(out), palette, transparent_idx=_DIFF_TRANSPARENT_IDX
    )
    return True


def _write_blank_root_png(cx: str, cy: str, canvas_id: int) -> bool:
    """Write a blank root PNG when a chunk becomes non-blank later."""
    path = _chunk_dir(canvas_id, "0000") / f"{cx}_{cy}.png"
    if path.exists():
        return False

    _save_indexed_png(
        path,
        bytes(CHUNK_PX * CHUNK_PX),
        _build_palette(canvas_id),
    )
    return True


# ── Daily backup ──────────────────────────────────────────────────────────────

async def _daily_backup_canvas(canvas_id: int) -> None:
    ok, msg = _check_disk_space()
    if not ok:
        print(f"[history] Skipping daily backup for canvas {canvas_id} - {msg}")
        return

    canvas = canvases.get(canvas_id)
    if canvas is None:
        print(f"[history] canvas {canvas_id}: unknown canvas, skipping daily")
        return

    palette = _build_palette(canvas_id)
    loop = asyncio.get_event_loop()
    blank = bytes(CHUNK_PX * CHUNK_PX)
    size = canvas.size

    # Clear old backup data for this canvas
    old_keys = await _scan_keys(canvas_id, backup_redis)
    if old_keys:
        pipe = backup_redis.pipeline()
        for k in old_keys:
            pipe.delete(k)
        await pipe.execute()

    # Full grid — every chunk gets a 0000 root PNG, blank or not.
    coords = [(cx, cy) for cy in range(size) for cx in range(size)]
    written = 0

    for i in range(0, len(coords), BATCH):
        batch = coords[i:i + BATCH]
        keys = [
            RedisKeys.CHUNK.value.format(canvas_id=canvas_id, cx=cx, cy=cy)
            for cx, cy in batch
        ]
        pipe = canvas_redis.pipeline()
        for key in keys:
            pipe.get(key)
        vals = await pipe.execute()

        # Save non-blank chunks to backup redis (incremental diffs still use this)
        pipe2 = backup_redis.pipeline()
        for key, val in zip(keys, vals):
            if val is not None and not _is_blank(val):
                pipe2.set(key, val)
        await pipe2.execute()

        for (cx, cy), val in zip(batch, vals):
            raw = val if (val is not None and len(val) == len(blank)) else blank
            ok = await loop.run_in_executor(
                None, _write_root_png, raw, str(cx), str(cy), canvas_id, palette
            )
            if ok:
                written += 1

    _mark_root_done(canvas_id)
    print(f"[history] canvas {canvas_id}: daily root done — wrote {written}/{len(coords)} PNGs")


async def daily_backup() -> None:
    print("[history] daily backup starting")
    for canvas_id in canvases:
        try:
            await _daily_backup_canvas(canvas_id)
        except Exception as e:
            import traceback
            print(f"[history] canvas {canvas_id}: daily backup error: {e}")
            traceback.print_exc()
    print("[history] daily backup done")


# ── Incremental backup ────────────────────────────────────────────────────────

async def _incremental_backup_canvas(canvas_id: int, time_suffix: str) -> int:
    """Compare live vs root (backup_redis). Only create time folder if diffs exist."""
    all_keys = await _scan_keys(canvas_id, canvas_redis)
    written_count = 0
    loop = asyncio.get_event_loop()
    palette = _build_palette(canvas_id)

    # NOTE: Do NOT pre-create the time slot folder here.
    # We only create it lazily when we actually write the first diff PNG.
    # This prevents empty folders from appearing in the snapshot list.

    for i in range(0, len(all_keys), BATCH):
        batch = all_keys[i:i + BATCH]

        pipe_live = canvas_redis.pipeline()
        pipe_root = backup_redis.pipeline()
        for key in batch:
            pipe_live.get(key)
            pipe_root.get(key)

        live_vals, root_vals = await asyncio.gather(
            pipe_live.execute(),
            pipe_root.execute(),
        )

        for key, current, root in zip(batch, live_vals, root_vals):
            if current is None or _is_blank(current):
                continue

            coords = _parse_coords(key)
            if coords is None:
                continue
            cx, cy = coords

            # New chunk since daily root → write blank root first
            if root is None or _is_blank(root):
                root = bytes(CHUNK_PX * CHUNK_PX)
                await loop.run_in_executor(
                    None, _write_blank_root_png, cx, cy, canvas_id
                )

            # Only write diff if different from root
            if current != root:
                ok = await loop.run_in_executor(
                    None, _write_diff_png, current, root, cx, cy,
                    canvas_id, time_suffix, palette
                )
                if ok:
                    written_count += 1

    print(f"[history] canvas {canvas_id}: incremental ({time_suffix}) — "
          f"{written_count} diffs written")
    return written_count


async def incremental_backup() -> None:
# if disk space is not enough then skip
    ok, msg = _check_disk_space()
    if not ok:
        print(f"[history] Skipping incremental backup - {msg}")
        return
    
    print("[history] incremental backup starting")
    time_suffix = _utc_time()
    if time_suffix == "0000":
        print("[history] skipping incremental at 0000 (daily root slot)")
        return
    for canvas_id in canvases:
        try:
            await _incremental_backup_canvas(canvas_id, time_suffix)
        except Exception as e:
            import traceback
            print(f"[history] canvas {canvas_id}: incremental error: {e}")
            traceback.print_exc()
    print("[history] incremental backup done")


# ── Trigger ───────────────────────────────────────────────────────────────────

async def trigger() -> None:
    needs_daily = [cid for cid in canvases if not _root_exists(cid)]

    if needs_daily:
        print(f"[history] canvases needing daily backup: {needs_daily}")
        for canvas_id in needs_daily:
            try:
                await _daily_backup_canvas(canvas_id)
            except Exception as e:
                import traceback
                print(f"[history] canvas {canvas_id}: daily backup error: {e}")
                traceback.print_exc()

    # Always run incremental
    await incremental_backup()


# ── Shutdown ──────────────────────────────────────────────────────────────────

_shutdown_event = asyncio.Event()
_scheduler: AsyncIOScheduler | None = None


def _handle_signal() -> None:
    print("[history] shutdown signal received")
    _shutdown_event.set()


# ── Main ──────────────────────────────────────────────────────────────────────

async def main() -> None:
    global canvas_redis, backup_redis, _scheduler

    if not HISTORY_ENABLED:
        print("[history] HISTORY_ENABLED is false, exiting")
        return

    canvas_redis = Redis.from_url(REDIS_URL, decode_responses=False)
    backup_redis = Redis.from_url(BACKUP_REDIS_URL, decode_responses=False)

    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[history] started — schedule: :00 and :30  dir={HISTORY_DIR}")
    print(f"[history] canvas redis : {REDIS_URL}")
    print(f"[history] backup redis : {BACKUP_REDIS_URL}")

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _handle_signal)

    _scheduler = AsyncIOScheduler()
    _scheduler.add_job(trigger, "cron", minute="0,30", second=0,
                       timezone="UTC", id="history_backup")
    _scheduler.start()
    print("[history] scheduler started")

    await _shutdown_event.wait()

    print("[history] shutting down")
    if _scheduler:
        _scheduler.shutdown(wait=True)
    await canvas_redis.aclose()
    await backup_redis.aclose()


if __name__ == "__main__":
    asyncio.run(main())