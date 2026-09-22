"""
History mode — metadata + static chunk serving.

Pixel data is served directly from disk via a StaticFiles mount:
  GET /history/chunk/{canvas_id}/{YYYYMMDD}/{HHMM}/{cx}_{cy}.png
A 404 means the chunk is blank (root) or unchanged (diff) at that slot —
the worker simply never wrote a file in that case, so this is correct
behavior, not a missing-data error.

GET /history/enabled
GET /history/snapshots/{canvas_id}        → available days
GET /history/snapshots/{canvas_id}?day=X  → available hour slots for a day
GET /history/layers/{canvas_id}/{ts}      → ordered (day, hhmm) slots to
                                             composite for a given timestamp
"""
import os
from bisect import bisect_right
from datetime import datetime, timezone
from pathlib import Path
from PIL import Image

from fastapi import APIRouter, HTTPException
from starlette.staticfiles import StaticFiles

HISTORY_ENABLED  = os.environ.get("HISTORY_ENABLED",  "false").lower() == "true"
HISTORY_DIR      = Path(os.environ.get("HISTORY_DIR", "/var/www/history"))
HISTORY_DIR.mkdir(parents=True, exist_ok=True)

# Snapshot PNGs are immutable once written — safe to cache for days at CF/nginx.
HISTORY_CACHE_MAX_AGE = int(os.environ.get("HISTORY_CACHE_MAX_AGE", str(7 * 86400)))
HISTORY_404_CACHE_MAX_AGE = int(os.environ.get("HISTORY_404_CACHE_MAX_AGE", "300"))


class CachedHistoryFiles(StaticFiles):
    """StaticFiles with Cache-Control for immutable history snapshot PNGs."""

    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            response.headers["Cache-Control"] = (
                f"public, max-age={HISTORY_CACHE_MAX_AGE}, immutable"
            )
        elif response.status_code == 404:
            response.headers["Cache-Control"] = (
                f"public, max-age={HISTORY_404_CACHE_MAX_AGE}"
            )
        return response

# get tile from date and time
def get_tile(cid: int, cx: int, cy: int, date: str, time: str = "0000"):
    '''returns a pillow image if exists, none if not'''
    path = "{HISTORY_DIR}/{canvas_id}/{YYYYMMDD}/{HHMM}/{cx}_{cy}.png".format(
        HISTORY_DIR=HISTORY_DIR,
        canvas_id=cid,
        YYYYMMDD=date,
        HHMM=time,
        cx=cx,
        cy=cy,
    )

    if os.path.exists(path):
        return Image.open(path)
    else:
        return None

def get_snapshots_in_day(canvas_id: int, date: str) -> list[str]:
    '''get list of snapshots in a day, in HHMM notation'''
    day_dir = HISTORY_DIR / str(canvas_id) / date
    if not day_dir.exists():
        return []

    hours = []
    for hour_dir in sorted(h for h in day_dir.iterdir() if h.is_dir()):
        hours.append(hour_dir.name)
    return hours


def day_exists(canvas_id: int, date: str) -> bool:
    """True if any history exists for this canvas/day (not tied to chunk 0,0)."""
    return (HISTORY_DIR / str(canvas_id) / date).is_dir()

# ── Snapshot name / ts helpers ────────────────────────────────────────────────

def _snap_ts(day_name: str, hour_name: str | None = None) -> int | None:
    try:
        if hour_name is None:
            return int(datetime.strptime(day_name, "%Y%m%d").replace(tzinfo=timezone.utc).timestamp())
        return int(datetime.strptime(f"{day_name}_{hour_name}", "%Y%m%d_%H%M").replace(tzinfo=timezone.utc).timestamp())
    except ValueError:
        return None

# ── Snapshot list cache ───────────────────────────────────────────────────────
# canvas_id → sorted list of (unix_ts, day_name, hhmm_name)

_snapshot_cache: dict[int, list[tuple[int, str, str]]] = {}

def invalidate_snapshot_cache(canvas_id: int):
    """Called by history_worker after writing a snapshot."""
    _snapshot_cache.pop(canvas_id, None)

def _get_snapshot_list(canvas_id: int) -> list[tuple[int, str, str]]:
    if canvas_id in _snapshot_cache:
        return _snapshot_cache[canvas_id]

    canvas_dir = HISTORY_DIR / str(canvas_id)
    result: list[tuple[int, str, str]] = []
    if canvas_dir.exists():
        for day_dir in canvas_dir.iterdir():
            if not day_dir.is_dir():
                continue
            for hour_dir in day_dir.iterdir():
                if not hour_dir.is_dir():
                    continue
                ts = _snap_ts(day_dir.name, hour_dir.name)
                if ts is None:
                    continue
                result.append((ts, day_dir.name, hour_dir.name))
    result.sort(key=lambda x: x[0])
    _snapshot_cache[canvas_id] = result
    return result

# ── API ───────────────────────────────────────────────────────────────────────

router = APIRouter()

@router.get("/history/enabled")
async def history_enabled_route():
    return {"enabled": HISTORY_ENABLED}

@router.get("/history/snapshots/{canvas_id}")
async def list_snapshots(canvas_id: int, day: str | None = None):
    if not HISTORY_ENABLED:
        raise HTTPException(403, "History mode is not enabled")

    canvas_dir = HISTORY_DIR / str(canvas_id)
    if not canvas_dir.exists():
        return {"snapshots": []}

    if day is None:
        days = sorted(
            d.name for d in canvas_dir.iterdir()
            if d.is_dir() and _snap_ts(d.name) is not None
        )
        return {"days": days}

    day_dir = canvas_dir / day
    if not day_dir.exists():
        raise HTTPException(404, "No snapshots for that day")

    hours = []
    for hour_dir in sorted(h for h in day_dir.iterdir() if h.is_dir()):
        ts = _snap_ts(day, hour_dir.name)
        if ts is None:
            continue
        hours.append({"ts": ts, "hhmm": hour_dir.name})

    return {"snapshots": hours}

# Static chunk files, mounted under the router so it travels with
# `app.include_router(router)` instead of needing a separate app.mount
# call in main.py. Preserves the original /history/chunk/... path shape.
router.mount(
    "/history/chunk",
    CachedHistoryFiles(directory=str(HISTORY_DIR)),
    name="history_chunks",
)

def _best_chunk(canvas_id: int, cx: int, cy: int, ts: int) -> bytes | None:
    """
    Reconstruct the raw bytes (indexed colors) of a chunk at a given timestamp
    by compositing the base (0000) and diff (HHMM) PNGs.

    Base PNG  — written in "P" (palette-indexed) mode; getdata() gives raw
                palette indices directly.
    Diff PNG  — written as indexed PNG with tRNS (transparent = unchanged);
                also accepts legacy RGBA. Opaque pixels = changed. We
                reverse-map RGB colours back to indices using the palette
                EMBEDDED in the base PNG, not canvases.colors —
                this guarantees the same palette used at write-time is used
                at read-time regardless of any subsequent palette changes.
    """
    from PIL import Image
    from src.canvases import CHUNK_PX

    snaps = _get_snapshot_list(canvas_id)
    if not snaps:
        return None

    ts_list = [s[0] for s in snaps]
    idx = bisect_right(ts_list, ts)
    if idx == 0:
        return None

    snap_ts, day, hhmm = snaps[idx - 1]

    expected = CHUNK_PX * CHUNK_PX
    base_path = HISTORY_DIR / str(canvas_id) / day / "0000" / f"{cx}_{cy}.png"
    diff_path = (
        HISTORY_DIR / str(canvas_id) / day / hhmm / f"{cx}_{cy}.png"
        if hhmm != "0000" else None
    )

    # ── Load base PNG ─────────────────────────────────────────────────────────
    pixels: list[int] = [0] * expected
    # rgb_to_idx is built from the embedded palette of the base PNG so it
    # always matches the palette that was used when the diff was written.
    rgb_to_idx: dict[tuple, int] = {}

    if base_path.exists():
        try:
            with Image.open(base_path) as img:
                if img.mode == "P":
                    # Raw palette indices — no conversion needed.
                    raw = list(img.getdata())
                    # Extract embedded palette for diff reverse-mapping.
                    # PIL always returns 768 bytes (256 × 3) even if the canvas
                    # only has N < 256 colors — entries N..255 are all (0,0,0).
                    # Use "first occurrence wins" so the correct index 0 for
                    # sea-color (0,0,0) is not overwritten by the garbage zeros.
                    pal = img.getpalette()  # flat [r0,g0,b0, r1,g1,b1, …]
                    if pal:
                        for i in range(0, len(pal), 3):
                            rgb = (pal[i], pal[i + 1], pal[i + 2])
                            if rgb not in rgb_to_idx:   # first occurrence wins
                                rgb_to_idx[rgb] = i // 3
                else:
                    # Rare: base saved as RGB/RGBA (shouldn't happen normally)
                    img_rgb = img.convert("RGB")
                    raw_rgb = list(img_rgb.getdata())
                    # Fall back to building rgb_to_idx from live canvas palette
                    try:
                        from src.canvases import canvases
                        c = canvases.get(canvas_id)
                        if c and getattr(c, "colors", None):
                            for c_idx, color in enumerate(c.colors):
                                rgb_to_idx[tuple(color[:3])] = c_idx
                    except Exception:
                        pass
                    raw = [rgb_to_idx.get(tuple(px), 0) for px in raw_rgb]

                # Clamp / pad to exactly expected length
                if len(raw) >= expected:
                    pixels = list(raw[:expected])
                else:
                    pixels = list(raw) + [0] * (expected - len(raw))

        except Exception as e:
            print(f"[history] _best_chunk base error canvas={canvas_id} "
                  f"cx={cx} cy={cy}: {e}")
            pixels = [0] * expected

    # ── Fallback: build rgb_to_idx from live palette if base had no "P" data ─
    if not rgb_to_idx:
        try:
            from src.canvases import canvases
            c = canvases.get(canvas_id)
            if c and getattr(c, "colors", None):
                for c_idx, color in enumerate(c.colors):
                    rgb = tuple(color[:3])
                    if rgb not in rgb_to_idx:   # first occurrence wins
                        rgb_to_idx[rgb] = c_idx
        except Exception:
            pass

    # ── Overlay diff PNG ──────────────────────────────────────────────────────
    if diff_path and diff_path.exists():
        try:
            with Image.open(diff_path) as img:
                img = img.convert("RGBA")
                for i, (r, g, b, a) in enumerate(img.getdata()):
                    if a >= 128:  # opaque = pixel changed since midnight base
                        pixels[i] = rgb_to_idx.get((r, g, b), 0)
        except Exception as e:
            print(f"[history] _best_chunk diff error canvas={canvas_id} "
                  f"cx={cx} cy={cy} day={day} hhmm={hhmm}: {e}")

    return bytes(pixels)