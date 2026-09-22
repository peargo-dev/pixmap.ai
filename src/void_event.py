"""
src/void_event.py — The Void Event system
==========================================
A hostile growing black blob spawns periodically on a configured canvas
(default: Earth, canvas 0). Players fight it off by placing non-black pixels.

Phases:
  idle       → waiting; timer counts down to next void
  active     → blob grows; players damage it
  dying_win  → HP hit 0; blob shrinks / canvas rolled back
  dying_lose → time expired; blob stabilises
  lockdown   → gray wall placed; no placements in zone for N minutes
"""
from __future__ import annotations

import asyncio
import json
import math
import random
import time
from typing import Optional

from src.redis_client.client import client as redis
from src.redis_client.keys import RedisKeys
from src.canvases import canvases, CHUNK_PX
from src.classes import Pixel

# ─── Public singleton (set after first call to get_void()) ──────────────────
_void: Optional["VoidEvent"] = None

def get_void() -> "VoidEvent":
    global _void
    if _void is None:
        _void = VoidEvent()
    return _void


# ─── Config ──────────────────────────────────────────────────────────────────

DEFAULT_CONFIG = {
    "enabled":                      True,
    "canvas_id":                    0,
    "interval_hours":               1.0,       # hours between voids (from end of last)
    "grow_duration_mins":           8.0,       # how long players have to defeat it
    "lockdown_duration_mins":       5.0,       # how long the gray wall stays after loss
    "win_cooldown_halve_secs":      1800,      # 30 min — halved cooldown after a win
    "loss_cooldown_double_secs":    600,       # 10 min — doubled cooldown after a loss
    "win_cd_multiplier":            0.5,
    "loss_cd_multiplier":           2.0,
    "max_hp":                       300.0,     # Increased from 100 to make it significantly stronger
    "hp_regen_per_sec":             0.3,       # Faster regeneration (18 HP / minute)
    "damage_inside":                0.5,       # Placing inside blob does less damage (0.5 instead of 2.5)
    "damage_border":                0.2,       # Placing on border does less damage (0.2 instead of 1.0)
    "damage_root_cut":              1.5,       # Cutting roots does less damage (1.5 instead of 5.0)
    "min_spawn_radius":             3,
    "max_spawn_radius":             7,
    "growth_interval_secs":         1.0,       # Fast real-time growth ticks every 1.0s instead of 2.5s
    "root_interval_secs":           8.0,       # Fast real-time root growth ticks every 8.0s instead of 18.0s
    "black_color_idx":              7,         # palette index for void black
    "gray_color_idx":               4,         # palette index for lockdown wall gray
    "auto_repair":                  True,      # auto-repair canvas on void defeat or collapse
}


# ─── State ────────────────────────────────────────────────────────────────────

IDLE        = "idle"
ACTIVE      = "active"
DYING_WIN   = "dying_win"
DYING_LOSE  = "dying_lose"
LOCKDOWN    = "lockdown"

class VoidEvent:
    def __init__(self):
        self.phase: str = IDLE
        self.canvas_id: int = 0
        self.chunk_x: int = 0
        self.chunk_y: int = 0
        self.center_x: int = 0
        self.center_y: int = 0
        self.radius: int = 0
        self.hp: float = 100.0
        self.start_ts: float = 0.0
        self.phase_end_ts: float = 0.0
        self.next_void_ts: float = 0.0

        # In-memory pixel sets for fast lookup
        self.void_pixels:  set[tuple[int, int]] = set()
        self.root_pixels:  set[tuple[int, int]] = set()
        self.wall_pixels:  set[tuple[int, int]] = set()  # lockdown gray-wall footprint

        # Snapshot of chunks affected, before void starts
        # { (cx, cy): bytes(65536) }
        self.snapshot: dict[tuple[int, int], bytes] = {}

        # Growth slowdown tracking: set of coords recently defended
        self.defended_pixels: set[tuple[int, int]] = set()
        self.defended_until: float = 0.0

        self._pixels_dirty: bool = True

        # Player placement cooldown modifier (applied on void canvas after win/loss)
        self.cd_mod: float = 1.0
        self.cd_mod_until: float = 0.0

        # Config (loaded from Redis or defaults)
        self.cfg: dict = dict(DEFAULT_CONFIG)

        # Broadcast callback (injected from server.py)
        self._broadcast_void_state_cb = None

        self._lock = asyncio.Lock()

    # ── Config ────────────────────────────────────────────────────────────────

    async def load_config(self):
        raw = await redis.get(RedisKeys.VOID_CONFIG.value)
        if raw:
            try:
                stored = json.loads(raw)
                self.cfg = {**DEFAULT_CONFIG, **stored}
            except Exception:
                self.cfg = dict(DEFAULT_CONFIG)
        else:
            self.cfg = dict(DEFAULT_CONFIG)
        self.canvas_id = int(self.cfg.get("canvas_id", 0))

    async def save_config(self):
        await redis.set(RedisKeys.VOID_CONFIG.value, json.dumps(self.cfg))

    # ── Player cooldown modifier ─────────────────────────────────────────────

    def get_cd_multiplier(self) -> float:
        """Return active placement cooldown multiplier for the void canvas (1.0 = normal)."""
        if self.cd_mod_until > time.time():
            return self.cd_mod
        return 1.0

    async def _save_cd_mod(self):
        payload = {"mod": self.cd_mod, "until": self.cd_mod_until}
        await redis.set(RedisKeys.VOID_CD_MOD.value, json.dumps(payload))

    async def _load_cd_mod(self):
        raw = await redis.get(RedisKeys.VOID_CD_MOD.value)
        if not raw:
            self.cd_mod = 1.0
            self.cd_mod_until = 0.0
            return
        try:
            data = json.loads(raw)
            self.cd_mod = float(data.get("mod", 1.0))
            self.cd_mod_until = float(data.get("until", 0.0))
            if self.cd_mod_until <= time.time():
                self.cd_mod = 1.0
                self.cd_mod_until = 0.0
        except Exception:
            self.cd_mod = 1.0
            self.cd_mod_until = 0.0

    async def _apply_player_cd_mod(self, multiplier: float, duration_secs: float):
        """Temporarily scale placement cooldown on the void canvas."""
        if duration_secs <= 0 or multiplier == 1.0:
            return
        self.cd_mod = multiplier
        self.cd_mod_until = time.time() + duration_secs
        await self._save_cd_mod()

    async def admin_get_config(self) -> dict:
        await self.load_config()
        return dict(self.cfg)

    async def admin_set_config(self, data: dict):
        await self.load_config()
        # Merge with defaults, type-coerce numeric fields safely
        for k, v in data.items():
            if k in DEFAULT_CONFIG and v is not None and v != "":
                orig = DEFAULT_CONFIG[k]
                try:
                    if isinstance(orig, bool):
                        self.cfg[k] = bool(v)
                    elif isinstance(orig, int):
                        self.cfg[k] = int(v)
                    elif isinstance(orig, float):
                        self.cfg[k] = float(v)
                    else:
                        self.cfg[k] = v
                except (ValueError, TypeError):
                    pass
        self.canvas_id = int(self.cfg.get("canvas_id", 0))
        await self.save_config()

        # If interval_hours was modified or in idle phase, update timer
        new_interval = self.cfg.get("interval_hours", 1.0)
        if self.phase == IDLE:
            now = time.time()
            if "interval_hours" in data or self.next_void_ts <= now or self.next_void_ts > now + new_interval * 3600:
                self.next_void_ts = now + new_interval * 3600
                await self.save_state()
                await self._broadcast()

    # ── State persistence ─────────────────────────────────────────────────────

    async def save_state(self, force_pixels=False):
        """Persist current void state, pixels, roots, walls, and snapshots to Redis."""
        # Fetch old metadata to clean up old snapshot keys in Redis
        old_raw = await redis.get(RedisKeys.VOID_STATE.value)
        old_snap_keys = set()
        if old_raw:
            try:
                old_meta = json.loads(old_raw)
                old_snap_keys = set(old_meta.get("snapshot_keys", []))
            except Exception:
                pass

        meta = {
            "phase":           self.phase,
            "canvas_id":       self.canvas_id,
            "chunk_x":         self.chunk_x,
            "chunk_y":         self.chunk_y,
            "center_x":        self.center_x,
            "center_y":        self.center_y,
            "radius":          self.radius,
            "hp":              self.hp,
            "start_ts":        self.start_ts,
            "phase_end_ts":    self.phase_end_ts,
            "next_void_ts":    self.next_void_ts,
            "snapshot_keys":   [f"{cx}:{cy}" for (cx, cy) in self.snapshot.keys()]
        }
        await redis.set(RedisKeys.VOID_STATE.value, json.dumps(meta))

        # Delete old snapshot keys that are no longer in the current snapshot
        new_snap_keys = set(meta["snapshot_keys"])
        keys_to_delete = old_snap_keys - new_snap_keys
        for k_str in keys_to_delete:
            parts = k_str.split(":")
            if len(parts) == 2:
                snap_key = RedisKeys.VOID_SNAPSHOT.value.format(cx=int(parts[0]), cy=int(parts[1]))
                await redis.delete(snap_key)

        if force_pixels or getattr(self, "_pixels_dirty", True):
            # Save void_pixels set
            await redis.delete(RedisKeys.VOID_PIXELS.value)
            if self.void_pixels:
                await redis.sadd(RedisKeys.VOID_PIXELS.value, *[f"{x}:{y}" for x, y in self.void_pixels])

            # Save root_pixels set
            await redis.delete(RedisKeys.VOID_ROOTS.value)
            if self.root_pixels:
                await redis.sadd(RedisKeys.VOID_ROOTS.value, *[f"{x}:{y}" for x, y in self.root_pixels])

            # Save wall_pixels set
            await redis.delete("void:wall_pixels")
            if self.wall_pixels:
                await redis.sadd("void:wall_pixels", *[f"{x}:{y}" for x, y in self.wall_pixels])

            self._pixels_dirty = False

    async def load_state(self):
        """Restore void state from Redis."""
        raw = await redis.get(RedisKeys.VOID_STATE.value)
        if not raw:
            return
        
        try:
            meta = json.loads(raw)
            self.phase = meta.get("phase", IDLE)
            self.canvas_id = meta.get("canvas_id", 0)
            self.center_x = meta.get("center_x", 0)
            self.center_y = meta.get("center_y", 0)
            self.chunk_x = meta.get("chunk_x", self.center_x // CHUNK_PX)
            self.chunk_y = meta.get("chunk_y", self.center_y // CHUNK_PX)
            self.radius = meta.get("radius", 0)
            self.hp = meta.get("hp", 100.0)
            self.start_ts = meta.get("start_ts", 0.0)
            self.phase_end_ts = meta.get("phase_end_ts", 0.0)
            self.next_void_ts = meta.get("next_void_ts", 0.0)
            
            # Load void_pixels
            px_raw = await redis.smembers(RedisKeys.VOID_PIXELS.value)
            self.void_pixels = set()
            for p in px_raw:
                p_str = p.decode() if isinstance(p, bytes) else p
                parts = p_str.split(":")
                if len(parts) == 2:
                    self.void_pixels.add((int(parts[0]), int(parts[1])))
                    
            # Load root_pixels
            root_raw = await redis.smembers(RedisKeys.VOID_ROOTS.value)
            self.root_pixels = set()
            for r in root_raw:
                r_str = r.decode() if isinstance(r, bytes) else r
                parts = r_str.split(":")
                if len(parts) == 2:
                    self.root_pixels.add((int(parts[0]), int(parts[1])))
                    
            # Load wall_pixels
            wall_raw = await redis.smembers("void:wall_pixels")
            self.wall_pixels = set()
            for w in wall_raw:
                w_str = w.decode() if isinstance(w, bytes) else w
                parts = w_str.split(":")
                if len(parts) == 2:
                    self.wall_pixels.add((int(parts[0]), int(parts[1])))
                    
            # Load snapshots
            self.snapshot = {}
            for k_str in meta.get("snapshot_keys", []):
                parts = k_str.split(":")
                if len(parts) == 2:
                    cx, cy = int(parts[0]), int(parts[1])
                    snap_key = RedisKeys.VOID_SNAPSHOT.value.format(cx=cx, cy=cy)
                    snap_bytes = await redis.get(snap_key)
                    if snap_bytes:
                        self.snapshot[(cx, cy)] = snap_bytes
            print(f"[VoidEvent] Restored state from Redis. Phase={self.phase}, HP={self.hp}, Snapshot chunks={len(self.snapshot)}")
            self._pixels_dirty = True
        except Exception as e:
            print(f"[VoidEvent] Error loading state from Redis: {e}")


    # ── State snapshot to Redis ───────────────────────────────────────────────

    def get_state_dict(self) -> dict:
        now = time.time()
        cd_remaining = max(0.0, self.next_void_ts - now) if self.phase == IDLE else 0.0
        phase_remaining = max(0.0, self.phase_end_ts - now) if self.phase_end_ts else 0.0
        cd_mod_left = max(0.0, self.cd_mod_until - now) if self.cd_mod_until > now else 0.0
        cd_mod = self.cd_mod if cd_mod_left > 0 else 1.0
        return {
            "phase":           self.phase,
            "canvas_id":       self.canvas_id,
            "chunk_x":         self.chunk_x,
            "chunk_y":         self.chunk_y,
            "center_x":        self.center_x,
            "center_y":        self.center_y,
            "radius":          self.radius,
            "hp":              round(self.hp, 1),
            "max_hp":          round(float(self.cfg["max_hp"]), 1),
            "blob_size":       len(self.void_pixels),
            "root_count":      len(self.root_pixels),
            "time_left":       round(phase_remaining),
            "cooldown_left":   round(cd_remaining),
            "cd_mod":          cd_mod,
            "cd_mod_left":     round(cd_mod_left),
            "next_void_ts":    self.next_void_ts,
            "start_ts":        self.start_ts,
        }

    async def _broadcast(self):
        if self._broadcast_void_state_cb:
            try:
                await self._broadcast_void_state_cb(self.get_state_dict())
            except Exception:
                pass
        try:
            await self.save_state()
        except Exception as e:
            print(f"[VoidEvent] Error saving state during broadcast: {e}")

    # ── Canvas snapshot ───────────────────────────────────────────────────────

    def _is_in_void_chunk(self, wx: int, wy: int) -> bool:
        return wx // CHUNK_PX == self.chunk_x and wy // CHUNK_PX == self.chunk_y

    def is_void_chunk(self, canvas_id: int, cx: int, cy: int) -> bool:
        """True if this chunk hosts the current void event."""
        return (
            canvas_id == self.canvas_id
            and self.phase in (ACTIVE, LOCKDOWN, DYING_WIN, DYING_LOSE)
            and cx == self.chunk_x
            and cy == self.chunk_y
        )

    def _affected_chunks(self) -> list[tuple[int, int]]:
        """Return the single chunk hosting the void."""
        return [(self.chunk_x, self.chunk_y)]

    async def _take_snapshot(self):
        """Save current chunk data for all affected chunks."""
        self.snapshot = {}
        for cx, cy in self._affected_chunks():
            key = RedisKeys.CHUNK.value.format(canvas_id=self.canvas_id, cx=cx, cy=cy)
            raw = await redis.get(key)
            if raw and len(raw) >= CHUNK_PX * CHUNK_PX:
                self.snapshot[(cx, cy)] = bytes(raw)
            else:
                self.snapshot[(cx, cy)] = bytes(CHUNK_PX * CHUNK_PX)

    async def _restore_snapshot(self):
        """Write snapshot bytes back to Redis and broadcast all changed pixels."""
        from src.socket_server.chunks import queue_pixels
        from src.tiles import add_pixels_to_chunks, generate_tiles_for_chunks

        tasks = []
        changed_chunks = []
        for (cx, cy), snap_bytes in self.snapshot.items():
            key = RedisKeys.CHUNK.value.format(canvas_id=self.canvas_id, cx=cx, cy=cy)
            live_raw = await redis.get(key)
            live_bytes = bytearray(live_raw) if live_raw and len(live_raw) >= CHUNK_PX * CHUNK_PX else bytearray(CHUNK_PX * CHUNK_PX)

            changed = []
            for offset in range(CHUNK_PX * CHUNK_PX):
                want = snap_bytes[offset]
                if live_bytes[offset] != want:
                    live_bytes[offset] = want
                    changed.append(Pixel(cx, cy, offset, want))

            if changed:
                await redis.set(key, bytes(live_bytes))
                tasks.append(queue_pixels(self.canvas_id, cx, cy, changed))
                add_pixels_to_chunks(self.canvas_id, cx, cy, len(changed))
                changed_chunks.append((cx, cy))

        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

        if changed_chunks:
            try:
                generate_tiles_for_chunks(self.canvas_id, changed_chunks)
            except Exception as e:
                print(f"[VoidEvent] Error generating tiles after restore: {e}")

        # Save state to cleanup the snapshot keys in Redis
        try:
            await self.save_state()
        except Exception as e:
            print(f"[VoidEvent] Error saving state after restore: {e}")

    # ── Pixel placement (canvas write) ───────────────────────────────────────

    async def _place_pixels(self, pixels: list[tuple[int, int]], color: int):
        """Write pixels to Redis chunks and broadcast to WS subscribers."""
        from src.socket_server.chunks import queue_pixels
        from src.tiles import add_pixels_to_chunks, generate_tiles_for_chunks

        by_chunk: dict[tuple[int, int], list[Pixel]] = {}
        for (wx, wy) in pixels:
            if not self._is_in_void_chunk(wx, wy):
                continue
            cx, cy = self.chunk_x, self.chunk_y
            offset = (wy - cy * CHUNK_PX) * CHUNK_PX + (wx - cx * CHUNK_PX)
            by_chunk.setdefault((cx, cy), []).append(Pixel(cx, cy, offset, color))

        tasks = []
        changed_chunks = []
        for (cx, cy), px_list in by_chunk.items():
            chunk_key = RedisKeys.CHUNK.value.format(canvas_id=self.canvas_id, cx=cx, cy=cy)
            raw = await redis.get(chunk_key)
            buf = bytearray(raw) if raw and len(raw) >= CHUNK_PX * CHUNK_PX else bytearray(CHUNK_PX * CHUNK_PX)
            
            # Dynamic snapshotting: save chunk state before modifying
            if (cx, cy) not in self.snapshot:
                self.snapshot[(cx, cy)] = bytes(buf)
                try:
                    snap_key = RedisKeys.VOID_SNAPSHOT.value.format(cx=cx, cy=cy)
                    await redis.set(snap_key, bytes(buf))
                except Exception as e:
                    print(f"[VoidEvent] Error saving snapshot chunk: {e}")

            for px in px_list:
                buf[px.offset] = color
            await redis.set(chunk_key, bytes(buf))
            tasks.append(queue_pixels(self.canvas_id, cx, cy, px_list))
            add_pixels_to_chunks(self.canvas_id, cx, cy, len(px_list))
            changed_chunks.append((cx, cy))

        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

        if changed_chunks:
            try:
                generate_tiles_for_chunks(self.canvas_id, changed_chunks)
            except Exception as e:
                print(f"[VoidEvent] Error generating tiles in _place_pixels: {e}")

        # Save state to update void_pixels and snapshot keys in Redis
        try:
            await self.save_state()
        except Exception as e:
            print(f"[VoidEvent] Error saving state in _place_pixels: {e}")


    # ── Blob seeding ─────────────────────────────────────────────────────────

    async def _seed_blob(self):
        """Place initial circular blob at center."""
        canvas = canvases.get(self.canvas_id)
        if not canvas:
            return
        r = self.radius
        new_pixels = []
        self.void_pixels = set()
        self._pixels_dirty = True
        for dy in range(-r, r + 1):
            for dx in range(-r, r + 1):
                if dx * dx + dy * dy <= r * r:
                    wx = self.center_x + dx
                    wy = self.center_y + dy
                    if self._is_in_void_chunk(wx, wy):
                        self.void_pixels.add((wx, wy))
                        new_pixels.append((wx, wy))
        if new_pixels:
            await self._place_pixels(new_pixels, self.cfg["black_color_idx"])

    # ── Growth tick ──────────────────────────────────────────────────────────

    async def _growth_tick(self):
        """Expand the blob by one step, prioritizing repairing damaged nodes/pixels first."""
        if not self.void_pixels:
            return

        canvas = canvases.get(self.canvas_id)
        if not canvas:
            return
        black = self.cfg["black_color_idx"]
        slowed = time.time() < self.defended_until

        # Limit expansion/repair per tick — scales slightly with blob size
        max_expand = max(3, min(12, len(self.void_pixels) // 20 + 3))
        if slowed:
            max_expand = max(1, max_expand // 3)

        # ── 1. PRIORITIZE REPAIRING DAMAGED VOID NODES & OLDER PIXELS ─────────
        # When older pixels/nodes are damaged by players, the void must
        # prioritize repairing them with black before continuing to expand!
        damaged_repair = []
        if self.defended_pixels:
            for (wx, wy) in list(self.defended_pixels):
                if (wx, wy) in self.void_pixels:
                    cx2, cy2 = wx // CHUNK_PX, wy // CHUNK_PX
                    offset = (wy - cy2 * CHUNK_PX) * CHUNK_PX + (wx - cx2 * CHUNK_PX)
                    chunk_key = RedisKeys.CHUNK.value.format(canvas_id=self.canvas_id, cx=cx2, cy=cy2)
                    raw = await redis.getrange(chunk_key, offset, offset)
                    cur = raw[0] if raw else 0
                    if cur != black:
                        damaged_repair.append((wx, wy))
                        if len(damaged_repair) >= max_expand:
                            break
                    else:
                        self.defended_pixels.discard((wx, wy))
                elif not self._is_in_void_chunk(wx, wy):
                    self.defended_pixels.discard((wx, wy))

        # Also periodic check sample of existing void pixels for overwritten nodes
        if not damaged_repair and self.void_pixels and random.random() < 0.4:
            sample_candidates = random.sample(list(self.void_pixels), min(30, len(self.void_pixels)))
            for (wx, wy) in sample_candidates:
                cx2, cy2 = wx // CHUNK_PX, wy // CHUNK_PX
                offset = (wy - cy2 * CHUNK_PX) * CHUNK_PX + (wx - cx2 * CHUNK_PX)
                chunk_key = RedisKeys.CHUNK.value.format(canvas_id=self.canvas_id, cx=cx2, cy=cy2)
                raw = await redis.getrange(chunk_key, offset, offset)
                cur = raw[0] if raw else 0
                if cur != black:
                    damaged_repair.append((wx, wy))
                    if len(damaged_repair) >= max_expand:
                        break

        if damaged_repair:
            await self._place_pixels(damaged_repair, black)
            for p in damaged_repair:
                self.defended_pixels.discard(p)
            # Prioritized repair of damaged nodes — do NOT expand outward while repairing!
            return

        # Find border pixels (adjacent to non-void, within void chunk)
        border = []
        for (wx, wy) in self.void_pixels:
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = wx + dx, wy + dy
                if self._is_in_void_chunk(nx, ny) and (nx, ny) not in self.void_pixels:
                    border.append((wx, wy, nx, ny))

        random.shuffle(border)


        new_pixels = []
        checked_targets = set()
        for (_, _, nx, ny) in border:
            if len(new_pixels) >= max_expand:
                break
            if (nx, ny) in checked_targets:
                continue
            checked_targets.add((nx, ny))

            # Read current pixel to determine if it's virgin
            cx2, cy2 = nx // CHUNK_PX, ny // CHUNK_PX
            offset = (ny - cy2 * CHUNK_PX) * CHUNK_PX + (nx - cx2 * CHUNK_PX)
            chunk_key = RedisKeys.CHUNK.value.format(canvas_id=self.canvas_id, cx=cx2, cy=cy2)
            raw = await redis.getrange(chunk_key, offset, offset)
            cur = raw[0] if raw else 0

            virgin_threshold = canvas.unset_pixels_below
            is_virgin = cur < virgin_threshold

            # Growth probability
            if is_virgin:
                prob = 0.8 if not slowed else 0.4
            else:
                # Already painted — harder to eat
                if (nx, ny) in self.defended_pixels:
                    prob = 0.05
                else:
                    prob = 0.25 if not slowed else 0.1

            if random.random() < prob:
                self.void_pixels.add((nx, ny))
                # Remove from roots if present
                self.root_pixels.discard((nx, ny))
                self._pixels_dirty = True
                new_pixels.append((nx, ny))

        # Update radius estimate
        if new_pixels:
            await self._place_pixels(new_pixels, black)
            max_r = max(
                math.isqrt((wx - self.center_x) ** 2 + (wy - self.center_y) ** 2)
                for (wx, wy) in self.void_pixels
            )
            self.radius = max_r

    # ── Root growth ──────────────────────────────────────────────────────────

    async def _root_tick(self):
        """Grow root tendrils from the blob edge into virgin space."""
        if not self.void_pixels:
            return

        canvas = canvases.get(self.canvas_id)
        if not canvas:
            return
        virgin_threshold = canvas.unset_pixels_below
        black = self.cfg["black_color_idx"]

        # Pick a random direction
        angle = random.uniform(0, 2 * math.pi)
        dx_base = math.cos(angle)
        dy_base = math.sin(angle)

        # Start from a border pixel in roughly that direction
        start_x, start_y = self.center_x, self.center_y
        best_dist = -1
        for (wx, wy) in random.sample(list(self.void_pixels), min(20, len(self.void_pixels))):
            # Project onto direction
            dot = (wx - self.center_x) * dx_base + (wy - self.center_y) * dy_base
            if dot > best_dist:
                best_dist = dot
                start_x, start_y = wx, wy

        root_len = random.randint(5, 14)
        root_pixels = []
        rx, ry = float(start_x), float(start_y)
        # Wiggle factor
        wiggle_dx = dy_base * random.uniform(-0.3, 0.3)
        wiggle_dy = -dx_base * random.uniform(-0.3, 0.3)

        for _ in range(root_len):
            # Step with slight wiggle
            rx += dx_base + wiggle_dx * random.uniform(-1, 1)
            ry += dy_base + wiggle_dy * random.uniform(-1, 1)
            nx, ny = int(rx), int(ry)

            if not self._is_in_void_chunk(nx, ny):
                break
            if (nx, ny) in self.void_pixels:
                continue

            # Only grow into virgin space
            cx2, cy2 = nx // CHUNK_PX, ny // CHUNK_PX
            offset = (ny - cy2 * CHUNK_PX) * CHUNK_PX + (nx - cx2 * CHUNK_PX)
            chunk_key = RedisKeys.CHUNK.value.format(canvas_id=self.canvas_id, cx=cx2, cy=cy2)
            raw = await redis.getrange(chunk_key, offset, offset)
            cur = raw[0] if raw else 0

            if cur < virgin_threshold:
                self.root_pixels.add((nx, ny))
                self._pixels_dirty = True
                root_pixels.append((nx, ny))
            else:
                break  # hit painted area — stop root

        if root_pixels:
            await self._place_pixels(root_pixels, black)

    # ── Lockdown wall ────────────────────────────────────────────────────────

    async def _place_lockdown_wall(self):
        """Place a ring of gray pixels around the void blob on loss."""
        canvas = canvases.get(self.canvas_id)
        if not canvas:
            return
        gray = self.cfg["gray_color_idx"]

        wall_pixels = set()
        for (wx, wy) in self.void_pixels:
            for dx in range(-2, 3):
                for dy in range(-2, 3):
                    nx, ny = wx + dx, wy + dy
                    if self._is_in_void_chunk(nx, ny) and (nx, ny) not in self.void_pixels:
                        wall_pixels.add((nx, ny))

        self.wall_pixels = wall_pixels  # track for placement blocking
        self._pixels_dirty = True
        if wall_pixels:
            await self._place_pixels(list(wall_pixels), gray)

    async def _clear_lockdown_wall(self):
        """Restore snapshot area (removes the gray wall + void pixels)."""
        await self._restore_snapshot()

    # ── Player pixel interaction ──────────────────────────────────────────────

    def process_player_pixel(self, wx: int, wy: int, color: int) -> tuple[float, str]:
        """
        Called when a player places a pixel during an active void.
        Returns (damage_dealt, event_type).
        event_type: 'inside' | 'border' | 'root' | 'none' | 'blocked'
        """
        if self.phase != ACTIVE:
            return 0.0, "none"

        if not self._is_in_void_chunk(wx, wy):
            return 0.0, "none"

        black = self.cfg["black_color_idx"]
        if color == black:
            return 0.0, "blocked"  # can't place black

        if (wx, wy) in self.root_pixels:
            self.root_pixels.discard((wx, wy))
            self._pixels_dirty = True
            self.hp -= self.cfg["damage_root_cut"]
            return self.cfg["damage_root_cut"], "root"

        if (wx, wy) in self.void_pixels:
            # Placing inside void — damages void, but blob will try to reclaim
            self.hp -= self.cfg["damage_inside"]
            self.defended_pixels.add((wx, wy))
            return self.cfg["damage_inside"], "inside"

        # Check if adjacent to void (border placement)
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1)):
            if (wx + dx, wy + dy) in self.void_pixels:
                self.hp -= self.cfg["damage_border"]
                self.defended_pixels.add((wx, wy))
                self.defended_until = max(self.defended_until, time.time() + 8.0)
                return self.cfg["damage_border"], "border"

        return 0.0, "none"

    def get_blocked_index(self, canvas_id: int, cx: int, cy: int) -> int:
        """Return palette index that cannot be placed (void black), or -1."""
        if self.phase != ACTIVE or not self.is_void_chunk(canvas_id, cx, cy):
            return -1
        return self.cfg.get("black_color_idx", 7)

    def is_pixel_blocked(self, canvas_id: int, wx: int, wy: int) -> bool:
        """True if placements are forbidden at this world pixel (lockdown zone)."""
        if self.phase != LOCKDOWN or canvas_id != self.canvas_id:
            return False
        if not self._is_in_void_chunk(wx, wy):
            return False
        return (wx, wy) in self.void_pixels or (wx, wy) in self.wall_pixels

    # ── Admin controls ────────────────────────────────────────────────────────

    async def admin_control(self, action: str, value=None) -> dict:
        async with self._lock:
            if action == "start":
                if self.phase != IDLE:
                    return {"ok": False, "error": "Not idle"}
                await self._begin_void()
                return {"ok": True}

            elif action == "stop":
                if self.phase == IDLE:
                    return {"ok": False, "error": "Already idle"}
                await self._abort_void()
                return {"ok": True}

            elif action == "pause":
                if self.phase == ACTIVE:
                    self._paused_remaining = self.phase_end_ts - time.time()
                    self.phase_end_ts = float("inf")
                    return {"ok": True}
                return {"ok": False, "error": "Not active"}

            elif action == "resume":
                if self.phase == ACTIVE and self.phase_end_ts == float("inf"):
                    self.phase_end_ts = time.time() + getattr(self, "_paused_remaining", 300)
                    return {"ok": True}
                return {"ok": False, "error": "Not paused"}

            elif action == "reset_cooldown":
                self.next_void_ts = time.time()
                await self.save_state()
                await self._broadcast()
                return {"ok": True}

            elif action == "set_cooldown":
                # value = seconds from now
                try:
                    secs = float(value)
                    self.next_void_ts = time.time() + secs
                    await self.save_state()
                    await self._broadcast()
                    return {"ok": True}
                except Exception:
                    return {"ok": False, "error": "Invalid value"}

            elif action == "set_hp":
                try:
                    self.hp = max(0.0, float(value))  # No max cap for admin override
                    await self.save_state()  # Persist HP change to Redis
                    return {"ok": True}
                except Exception:
                    return {"ok": False, "error": "Invalid value"}

            elif action == "auto_repair":
                if self.snapshot:
                    try:
                        await self._restore_snapshot()
                    except Exception as e:
                        print(f"[VoidEvent] Error in auto_repair restore: {e}")
                self.void_pixels.clear()
                self.root_pixels.clear()
                self.wall_pixels.clear()
                self.snapshot = {}
                self.defended_pixels.clear()
                self._pixels_dirty = True
                self.phase = IDLE
                self.next_void_ts = time.time() + self.cfg.get("interval_hours", 1.0) * 3600
                await self.save_state()
                await self._broadcast()
                from src.socket_server.chat.chat import send_system_message
                try:
                    await send_system_message("✨ The Void area has been automatically repaired and restored to original state!")
                except Exception:
                    pass
                return {"ok": True}


        return {"ok": False, "error": "Unknown action"}

    async def _abort_void(self):
        """Cancel current void, restore snapshot, go idle."""
        old_phase = self.phase
        self.phase = IDLE
        self.next_void_ts = time.time() + self.cfg["interval_hours"] * 3600

        if self.snapshot:
            try:
                await self._restore_snapshot()
            except Exception:
                pass

        self.void_pixels.clear()
        self.root_pixels.clear()
        self.wall_pixels.clear()
        self.snapshot = {}
        self.defended_pixels.clear()
        self._pixels_dirty = True

        if old_phase != IDLE:
            from src.socket_server.chat.chat import send_system_message
            try:
                await send_system_message("🌑 The Void has been forcefully stopped by administrators.")
            except Exception:
                pass
        await self._broadcast()

    # ── Phase: begin void ────────────────────────────────────────────────────

    async def _begin_void(self):
        """Transition from idle → active. Pick spawn point, snapshot, seed."""
        from src.socket_server.chat.chat import send_system_message

        await self.load_config()

        if not self.cfg.get("enabled", True):
            return

        canvas = canvases.get(self.canvas_id)
        if not canvas:
            return

        total_px = canvas.size * CHUNK_PX
        self.chunk_x = random.randint(0, canvas.size - 1)
        self.chunk_y = random.randint(0, canvas.size - 1)
        self.center_x = self.chunk_x * CHUNK_PX + CHUNK_PX // 2
        self.center_y = self.chunk_y * CHUNK_PX + CHUNK_PX // 2
        self.radius = random.randint(self.cfg["min_spawn_radius"], self.cfg["max_spawn_radius"])
        self.hp = float(self.cfg["max_hp"])
        self.start_ts = time.time()
        self.phase_end_ts = self.start_ts + self.cfg["grow_duration_mins"] * 60
        self.defended_pixels.clear()
        self.defended_until = 0.0
        self.wall_pixels.clear()

        # Take snapshot before modifying canvas
        await self._take_snapshot()

        # Seed initial blob
        await self._seed_blob()

        self.phase = ACTIVE

        cx_coord = self.center_x - total_px // 2
        cy_coord = self.center_y - total_px // 2
        await send_system_message(
            f"🌑 THE VOID AWAKENS at ({cx_coord}, {cy_coord})! "
            f"Fight it off! Place non-black pixels to damage it! You have {self.cfg['grow_duration_mins']:.0f} minutes!"
        )
        await self._broadcast()

    # ── Phase: winning ───────────────────────────────────────────────────────

    async def _begin_dying_win(self):
        from src.socket_server.chat.chat import send_system_message
        self.phase = DYING_WIN
        self.phase_end_ts = time.time() + 10  # 10s shrink animation window

        await send_system_message(
            "✅ THE VOID HAS BEEN DEFEATED! The canvas is being restored..."
        )
        await self._broadcast()

        # Restore the canvas
        await self._restore_snapshot()
        self.void_pixels.clear()
        self.root_pixels.clear()
        self.wall_pixels.clear()
        self._pixels_dirty = True

        # Player placement cooldown modification on canvas (halved cooldown)
        win_halve_secs = self.cfg.get("win_cooldown_halve_secs", 1800)
        self.next_void_ts = time.time() + (self.cfg["interval_hours"] * 3600)
        await self._apply_player_cd_mod(self.cfg["win_cd_multiplier"], win_halve_secs)

        self.phase = IDLE
        self.snapshot = {}
        await self.save_state()
        await self._broadcast()
        await send_system_message(
            f"🎉 Canvas restored! Next void in {self.cfg['interval_hours']:.1f}h. "
            f"Placement cooldown halved for {win_halve_secs // 60} minutes — great job!"
        )

    # ── Phase: losing ────────────────────────────────────────────────────────

    async def _begin_dying_lose(self):
        from src.socket_server.chat.chat import send_system_message
        self.phase = DYING_LOSE

        if self.cfg.get("auto_repair", True):
            await send_system_message(
                "✨ The Void collapsed and auto-repair is active! Restoring canvas pixels..."
            )
            await self._broadcast()
            try:
                await self._restore_snapshot()
            except Exception as e:
                print(f"[VoidEvent] Auto-repair restore failed: {e}")
            self.void_pixels.clear()
            self.root_pixels.clear()
            self.wall_pixels.clear()
            self.snapshot = {}
            self._pixels_dirty = True
            self.phase = IDLE
            self.next_void_ts = time.time() + (self.cfg.get("interval_hours", 1.0) * 3600)
            await self.save_state()
            await self._broadcast()
            await send_system_message("🎉 Canvas auto-repaired! Normal placement restored.")
            return

        await send_system_message(
            "💀 THE VOID HAS WON! The area is now in lockdown for "
            f"{self.cfg['lockdown_duration_mins']:.0f} minutes. Cooldown has been increased."
        )
        await self._broadcast()


        # Place gray stabilisation wall
        await self._place_lockdown_wall()

        self.phase = LOCKDOWN
        self.phase_end_ts = time.time() + self.cfg["lockdown_duration_mins"] * 60
        # Player placement cooldown modification on canvas (doubled cooldown)
        loss_double_secs = self.cfg.get("loss_cooldown_double_secs", 600)
        self.next_void_ts = time.time() + (self.cfg["interval_hours"] * 3600)
        await self._apply_player_cd_mod(self.cfg["loss_cd_multiplier"], loss_double_secs)
        await self.save_state()
        await self._broadcast()

    # ── Main loop ────────────────────────────────────────────────────────────

    async def run(self):
        """Main void event loop — runs forever as a background task."""
        await self.load_config()
        await self.load_state()
        await self._load_cd_mod()

        # Set initial cooldown if not set or clamp if exceeding interval
        now = time.time()
        interval_secs = self.cfg.get("interval_hours", 1.0) * 3600
        if self.next_void_ts == 0 or (self.phase == IDLE and self.next_void_ts > now + interval_secs):
            self.next_void_ts = now + interval_secs
            await self.save_state()

        last_growth = 0.0
        last_root = 0.0
        last_broadcast = 0.0
        chat_warned_5min = False
        chat_warned_2min = False
        chat_warned_1min = False

        while True:
            try:
                now = time.time()

                # ── IDLE: check if it's time to spawn ─────────────────────
                if self.phase == IDLE:
                    await self.load_config()
                    if self.cfg.get("enabled", True) and now >= self.next_void_ts:
                        async with self._lock:
                            await self._begin_void()
                        chat_warned_5min = False
                        chat_warned_2min = False
                        chat_warned_1min = False
                        last_growth = now
                        last_root = now

                # ── ACTIVE: growth, root, HP regen, expiry ─────────────────
                elif self.phase == ACTIVE:
                    time_left = self.phase_end_ts - now

                    # Chat warnings
                    if not chat_warned_5min and time_left <= 300:
                        chat_warned_5min = True
                        from src.socket_server.chat.chat import send_system_message
                        try:
                            await send_system_message(
                                f"⚠️ THE VOID: 5 minutes remaining! HP: {self.hp:.0f}% — Keep fighting!"
                            )
                        except Exception:
                            pass

                    if not chat_warned_2min and time_left <= 120:
                        chat_warned_2min = True
                        from src.socket_server.chat.chat import send_system_message
                        try:
                            await send_system_message(
                                f"🚨 THE VOID: 2 minutes left! HP: {self.hp:.0f}%"
                            )
                        except Exception:
                            pass

                    if not chat_warned_1min and time_left <= 60:
                        chat_warned_1min = True
                        from src.socket_server.chat.chat import send_system_message
                        try:
                            await send_system_message(
                                f"💀 THE VOID: 1 minute left! HP: {self.hp:.0f}% — FINAL PUSH!"
                            )
                        except Exception:
                            pass

                    # HP regen
                    self.hp = min(self.cfg["max_hp"], self.hp + self.cfg["hp_regen_per_sec"] * 1.0)

                    # Check win condition
                    if self.hp <= 0:
                        self.hp = 0
                        async with self._lock:
                            await self._begin_dying_win()

                    # Check lose condition (time expired)
                    elif now >= self.phase_end_ts and self.phase_end_ts != float("inf"):
                        async with self._lock:
                            await self._begin_dying_lose()

                    else:
                        # Growth tick
                        if now - last_growth >= self.cfg["growth_interval_secs"]:
                            last_growth = now
                            async with self._lock:
                                await self._growth_tick()

                        # Root tick
                        if now - last_root >= self.cfg["root_interval_secs"]:
                            last_root = now
                            async with self._lock:
                                await self._root_tick()

                # ── LOCKDOWN: wait for expiry ──────────────────────────────
                elif self.phase == LOCKDOWN:
                    if now >= self.phase_end_ts:
                        from src.socket_server.chat.chat import send_system_message
                        self.phase = IDLE
                        # Clear the gray wall + void pixels
                        try:
                            await self._clear_lockdown_wall()
                        except Exception:
                            pass
                        self.void_pixels.clear()
                        self.root_pixels.clear()
                        self.wall_pixels.clear()
                        self.snapshot = {}
                        self._pixels_dirty = True
                        if self.next_void_ts <= now:
                            self.next_void_ts = now + self.cfg.get("interval_hours", 1.0) * 3600
                        await self.save_state()
                        await self._broadcast()
                        try:
                            await send_system_message("🌅 Void lockdown lifted. The canvas is free again.")
                        except Exception:
                            pass

                # ── Periodic broadcast ─────────────────────────────────────
                if now - last_broadcast >= 1.0:
                    last_broadcast = now
                    await self._broadcast()

            except Exception as e:
                import traceback
                print(f"[VoidEvent] Error in loop: {e}")
                traceback.print_exc()

            await asyncio.sleep(1.0)


# ─── Module-level loop entry point ───────────────────────────────────────────

async def void_loop():
    """Entry point called from main.py lifespan."""
    await get_void().run()
