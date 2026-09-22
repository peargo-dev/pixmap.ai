from src.redis_client.client import client
from src.redis_client.keys import RedisKeys
from src.canvases import canvases, CHUNK_PX
from PIL import Image
import os
import asyncio
import time
import pickle
import threading
import numpy as np
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BASE_TILE_DIR = os.path.join(PROJECT_ROOT, "tiles")
CACHE_PATH = os.path.join(PROJECT_ROOT, "tile_cache.pkl")
_CHUNK_BYTES = CHUNK_PX * CHUNK_PX

ZOOM_SCHEDULE = {
    1: 5 * 60,
    2: 15 * 60,
    3: 30 * 60,
    4: 60 * 60,
    5: 2 * 60 * 60,
    6: 4 * 60 * 60,
    7: 6 * 60 * 60,
    8: 12 * 60 * 60,
}
MAX_LEVEL = max(ZOOM_SCHEDULE)

# Lossy WebP for heavily downscaled overview tiles — much smaller on disk.
_LOSSY_FROM_LEVEL = 5
_LOSSY_QUALITY = 88

# 8 caches, one per level.
#   _caches[1]   -> {(canvas, cx, cy): pixel_count}      raw chunk coords,
#                   fed directly by add_pixels_to_chunks()
#   _caches[i>1] -> {(canvas, cx, cy): mark_count}        level-(i-1) TILE
#                   coords, fed only when level i-1's loop writes that tile
#                   (see _mark_dirty, called from _process_level)
_caches: dict[int, dict[tuple[int, int, int], int]] = {level: {} for level in ZOOM_SCHEDULE}
_caches_lock = threading.Lock()  # guards all _caches mutation + pickling
_last_cache_save = 0.0
_CACHE_SAVE_INTERVAL = 120.0  # seconds between pickle writes

# Shared thread-pool for all blocking disk I/O (WebP read/write, PIL ops)
_executor = ThreadPoolExecutor(max_workers=min(32, (os.cpu_count() or 4) * 2))


def _load_caches():
    global _caches
    if os.path.exists(CACHE_PATH):
        try:
            with open(CACHE_PATH, "rb") as f:
                loaded = pickle.load(f)
            with _caches_lock:
                _caches = loaded
            print(f"[tiles] loaded cache from {CACHE_PATH}")
        except Exception as e:
            print(f"[tiles] cache load failed, starting fresh: {e}")
            with _caches_lock:
                _caches = {level: {} for level in ZOOM_SCHEDULE}


def _save_caches(force: bool = False) -> None:
    global _last_cache_save
    now = time.monotonic()
    if not force and now - _last_cache_save < _CACHE_SAVE_INTERVAL:
        return
    with _caches_lock:
        snapshot = {level: dict(d) for level, d in _caches.items()}
    tmp = CACHE_PATH + ".tmp"
    with open(tmp, "wb") as f:
        pickle.dump(snapshot, f)
    os.replace(tmp, CACHE_PATH)
    _last_cache_save = now


def _is_blank(data: bytes | None) -> bool:
    if not data:
        return True
    return not any(data)


def add_pixels_to_chunks(canvas, cx, cy, pixels=1):
    """Called on real pixel placement. Only ever touches level 1's cache —
    everything above is fed by the cascade, not by raw pixel events."""
    key = (canvas, cx, cy)
    with _caches_lock:
        _caches[1][key] = _caches[1].get(key, 0) + pixels


def _mark_dirty(level: int, canvas_id: int, cx: int, cy: int, amount: int = 1):
    """Mark a level-`level` tile coordinate dirty in `_caches[level]`, so that
    level `level`'s loop knows to process it next time it wakes up. Called
    after a lower level finishes writing a tile."""
    if level > MAX_LEVEL:
        return
    key = (canvas_id, cx, cy)
    with _caches_lock:
        _caches[level][key] = _caches[level].get(key, 0) + amount

def generate_tiles_for_chunks(canvas: int, changed_chunks: tuple[int, int]):
    for chunk in changed_chunks:
        _mark_dirty(1, canvas, chunk[0], chunk[1], 9999)

def get_canvas_palette(canvas_id):
    c = canvases.get(canvas_id)
    if not c or not c.colors:
        return [0, 0, 0, 255, 255, 255] + [0] * 762
    pal = []
    for color in c.colors:
        pal.extend(color)
    if len(pal) < 768:
        pal.extend([0] * (768 - len(pal)))
    return pal[:768]


# ──────────────────────────────────────────────────────────────────────────────
# Synchronous (thread-pool) tile helpers
# ──────────────────────────────────────────────────────────────────────────────

def _chunk_to_rgb_image(chunk_data: bytes, palette: list[int]) -> Image.Image:
    """Convert raw Redis chunk bytes → RGB PIL Image (runs in thread)."""
    buf = np.frombuffer(chunk_data, dtype=np.uint8)
    if len(buf) < _CHUNK_BYTES:
        full = np.zeros(_CHUNK_BYTES, dtype=np.uint8)
        full[:len(buf)] = buf
        buf = full
    else:
        buf = buf[:_CHUNK_BYTES].copy()
    # Strip protection bit (0x80) from all pixels
    buf &= 0x7F
    img = Image.frombytes("P", (CHUNK_PX, CHUNK_PX), buf.tobytes())
    img.putpalette(palette)
    return img.convert("RGB")


def _composite_into_tile(
    contributions: list[tuple[int, int, Image.Image]],
    default_color: tuple,
) -> Image.Image:
    """Paste up to 4 quarter images into one tile. Each file written exactly once."""
    half = CHUNK_PX // 2
    tile = Image.new("RGB", (CHUNK_PX, CHUNK_PX), color=default_color)
    for lcx, lcy, img in contributions:
        tile.paste(img.resize((half, half), Image.LANCZOS), (lcx * half, lcy * half))
    return tile


def _tile_path(canvas_id: int, level: int, cx: int, cy: int) -> str:
    return os.path.join(BASE_TILE_DIR, str(canvas_id), str(level), f"{cx}_{cy}.webp")


def _save_tile_image(canvas_id: int, level: int, cx: int, cy: int, img: Image.Image) -> None:
    out_dir = os.path.join(BASE_TILE_DIR, str(canvas_id), str(level))
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{cx}_{cy}.webp")
    if level >= _LOSSY_FROM_LEVEL:
        img.save(out_path, format="WEBP", quality=_LOSSY_QUALITY, method=4)
    else:
        img.save(out_path, format="WEBP", lossless=True)


def _read_tile_image(canvas_id: int, level: int, cx: int, cy: int) -> Image.Image | None:
    path = _tile_path(canvas_id, level, cx, cy)
    if not os.path.exists(path):
        return None
    try:
        return Image.open(path).convert("RGB")
    except Exception:
        return None


def _build_level1_tile(
    canvas_id: int,
    parent_cx: int,
    parent_cy: int,
    chunk_entries: list[tuple[int, int, bytes]],
    palette: list[int],
    default_color: tuple,
) -> tuple[int, int] | None:
    contributions = []
    for cx, cy, blob in chunk_entries:
        if _is_blank(blob):
            continue
        contributions.append((cx % 2, cy % 2, _chunk_to_rgb_image(blob, palette)))
    if not contributions:
        return None
    tile = _composite_into_tile(contributions, default_color)
    _save_tile_image(canvas_id, 1, parent_cx, parent_cy, tile)
    return (parent_cx, parent_cy)


def _build_higher_tile(
    canvas_id: int,
    level: int,
    parent_cx: int,
    parent_cy: int,
    source_level: int,
    default_color: tuple,
) -> tuple[tuple[int, int] | None, list[tuple[int, int]]]:
    """Write one parent tile from all four child tiles at source_level."""
    contributions = []
    missing = []
    for dx in (0, 1):
        for dy in (0, 1):
            tile_cx = parent_cx * 2 + dx
            tile_cy = parent_cy * 2 + dy
            img = _read_tile_image(canvas_id, source_level, tile_cx, tile_cy)
            if img is None:
                missing.append((tile_cx, tile_cy))
                continue
            contributions.append((dx, dy, img))
    if not contributions:
        return None, missing
    tile = _composite_into_tile(contributions, default_color)
    _save_tile_image(canvas_id, level, parent_cx, parent_cy, tile)
    return (parent_cx, parent_cy), missing


# ──────────────────────────────────────────────────────────────────────────────
# Core tile-building primitive — pure, no cache side effects.
# level == 1: input coords are raw chunks, fetched from Redis.
# level  > 1: input coords are level-(level-1) tile coords, read from disk.
# Returns the set of parent tile coords touched at level+1, and input coords that
# could not be processed yet (missing source tile on disk — re-queue for later).
async def _build_tiles_at_level(
    canvas_id: int,
    level: int,
    coords: list[tuple[int, int]],
    batch_size: int = 250,
) -> tuple[set[tuple[int, int]], list[tuple[int, int]]]:
    if not coords:
        return set(), []

    canvas = canvases.get(canvas_id)
    if canvas:
        import math
        cap = max(0, int(math.log2(canvas.size)))
        if level > cap:
            return set(), []

    default_color = canvas.colors[0] if canvas and canvas.colors else (0, 0, 0)
    palette = get_canvas_palette(canvas_id) if level == 1 else None
    loop = asyncio.get_running_loop()

    total = len(coords)
    t0 = time.perf_counter()
    touched: set[tuple[int, int]] = set()
    failed: list[tuple[int, int]] = []

    for i in range(0, total, batch_size):
        batch = coords[i : i + batch_size]

        if level == 1:
            keys = [
                RedisKeys.CHUNK.value.format(cx=cx, cy=cy, canvas_id=canvas_id)
                for cx, cy in batch
            ]
            pipe = client.pipeline(transaction=False)
            for k in keys:
                pipe.get(k)
            blobs = await pipe.execute()

            parents: set[tuple[int, int]] = set()
            blob_by_coord: dict[tuple[int, int], bytes] = {}
            for (cx, cy), blob in zip(batch, blobs):
                parents.add((cx // 2, cy // 2))
                if not _is_blank(blob):
                    blob_by_coord[(cx, cy)] = blob

            sibling_keys = []
            sibling_coords = []
            for pcx, pcy in parents:
                for dx in (0, 1):
                    for dy in (0, 1):
                        cx, cy = pcx * 2 + dx, pcy * 2 + dy
                        if (cx, cy) in blob_by_coord:
                            continue
                        sibling_coords.append((cx, cy))
                        sibling_keys.append(
                            RedisKeys.CHUNK.value.format(cx=cx, cy=cy, canvas_id=canvas_id)
                        )

            if sibling_keys:
                pipe = client.pipeline(transaction=False)
                for k in sibling_keys:
                    pipe.get(k)
                sibling_blobs = await pipe.execute()
                for (cx, cy), blob in zip(sibling_coords, sibling_blobs):
                    if not _is_blank(blob):
                        blob_by_coord[(cx, cy)] = blob

            futs = []
            for pcx, pcy in parents:
                entries = []
                for dx in (0, 1):
                    for dy in (0, 1):
                        cx, cy = pcx * 2 + dx, pcy * 2 + dy
                        if (cx, cy) in blob_by_coord:
                            entries.append((cx, cy, blob_by_coord[(cx, cy)]))
                if not entries:
                    continue
                futs.append(
                    loop.run_in_executor(
                        _executor, _build_level1_tile,
                        canvas_id, pcx, pcy, entries, palette, default_color,
                    )
                )
        else:
            parents = {(cx // 2, cy // 2) for cx, cy in batch}
            source_level = level - 1
            futs = [
                loop.run_in_executor(
                    _executor, _build_higher_tile,
                    canvas_id, level, pcx, pcy, source_level, default_color,
                )
                for pcx, pcy in parents
            ]

        if futs:
            results = await asyncio.gather(*futs)
            if level == 1:
                for result in results:
                    if result is not None:
                        touched.add(result)
            else:
                for result in results:
                    parent, missing = result
                    if parent is not None:
                        touched.add(parent)
                    failed.extend(missing)

    elapsed = time.perf_counter() - t0
    rate = total / elapsed if elapsed > 0 else 0
    print(f"[tiles] canvas {canvas_id} level {level}: {total:,} coords in {elapsed:.2f}s "
          f"({rate:.0f}/s) -> {len(touched):,} parents queued, {len(failed):,} deferred")

    return touched, failed


# ──────────────────────────────────────────────────────────────────────────────
# One-off bulk queue from Redis. All levels build on the scheduler.
# Used by generate_all_tiles / _test only.
# ──────────────────────────────────────────────────────────────────────────────

async def generate_all_tiles() -> None:
    """Queue non-blank Redis chunks into the level-1 cache for scheduled processing."""
    print("[tiles] Queuing non-blank chunks for scheduled tile generation…")
    pattern = "ch:*:*:*"
    cursor = 0
    keys = []
    while True:
        cursor, batch = await client.scan(cursor, match=pattern, count=10000)
        keys.extend(batch)
        if cursor == 0:
            break

    print(f"[tiles] Found {len(keys):,} chunk keys in Redis.")

    canvas_chunks: dict[int, list[tuple[int, int, str]]] = defaultdict(list)
    for key in keys:
        parts = (key.decode() if isinstance(key, bytes) else key).split(":")
        if len(parts) < 4:
            continue
        try:
            canvas_id = int(parts[1])
            cx, cy = int(parts[2]), int(parts[3])
            redis_key = RedisKeys.CHUNK.value.format(canvas_id=canvas_id, cx=cx, cy=cy)
            canvas_chunks[canvas_id].append((cx, cy, redis_key))
        except ValueError:
            continue

    threshold = 50  # level-1 scheduler threshold
    queued = 0
    for canvas_id, entries in canvas_chunks.items():
        print(f"[tiles] Canvas {canvas_id}: checking {len(entries):,} chunks")
        for i in range(0, len(entries), 250):
            batch = entries[i : i + 250]
            pipe = client.pipeline(transaction=False)
            for _, _, redis_key in batch:
                pipe.get(redis_key)
            blobs = await pipe.execute()
            for (cx, cy, _), blob in zip(batch, blobs):
                if _is_blank(blob):
                    continue
                add_pixels_to_chunks(canvas_id, cx, cy, threshold)
                queued += 1

    print(f"[tiles] Queued {queued:,} non-blank chunks. All levels will build on schedule.")


# ──────────────────────────────────────────────────────────────────────────────
# Scheduled background processor — 8 independent per-level loops.
# ──────────────────────────────────────────────────────────────────────────────

async def _process_level(level: int) -> None:
    threshold = 50 if level == 1 else 1

    with _caches_lock:
        cache = _caches[level]
        keys_to_process = [k for k, v in cache.items() if v >= threshold]
        for k in keys_to_process:
            cache.pop(k, None)

    if not keys_to_process:
        return

    from collections import defaultdict
    by_canvas: dict[int, list] = defaultdict(list)
    for cid, cx, cy in keys_to_process:
        by_canvas[cid].append((cx, cy))

    for cid, coord_list in by_canvas.items():
        touched, failed = await _build_tiles_at_level(cid, level, coord_list)
        for px, py in touched:
            _mark_dirty(level + 1, cid, px, py)
        for cx, cy in failed:
            _mark_dirty(level, cid, cx, cy)


async def _level_loop(level: int):
    interval = ZOOM_SCHEDULE[level]
    while True:
        await asyncio.sleep(interval)
        try:
            await _process_level(level)
        except Exception as e:
            print(f"[tiles] error processing level {level}: {e}")
        _save_caches()


async def tile_scheduler():
    """Run on the main asyncio event loop (see main.py)."""
    _load_caches()
    print(f"[tiles] writing to {BASE_TILE_DIR}")
    try:
        await asyncio.gather(*[_level_loop(level) for level in ZOOM_SCHEDULE])
    finally:
        _save_caches(force=True)


def start_tile_scheduler_thread() -> threading.Thread:
    """
    Optional: run all 8 per-level loops on a dedicated background thread.
    Only use this if you create a loop-local Redis client inside the thread —
    the shared module-level `client` is bound to whichever loop first used it.
    """
    def _run():
        asyncio.run(tile_scheduler())

    t = threading.Thread(target=_run, name="tile-scheduler", daemon=True)
    t.start()
    return t


# ──────────────────────────────────────────────────────────────────────────────
# Test entrypoint
# ──────────────────────────────────────────────────────────────────────────────

async def _test():
    await generate_all_tiles()
    print("Tiles written to:", BASE_TILE_DIR)

if __name__ == "__main__":
    asyncio.run(_test())
