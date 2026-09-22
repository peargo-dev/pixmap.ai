import os
from src.classes import Pixel
from src.canvases import *
from src.redis_client.client import scripts, client as redis_client
from src.redis_client.keys import RedisKeys
from src.socket_server.chunks import queue_pixels
from src.sql.pixel_log import log_pixels
from src.captcha import is_verified
from src.tiles import add_pixels_to_chunks
from datetime import datetime, timezone
from src.admin import notify_watch_streams
from src.void_event import get_void
import asyncio

DO_CAPTCHA      = os.environ.get("CAPTCHA",         "true").lower()  == "true"
HISTORY_ENABLED = os.environ.get("HISTORY_ENABLED", "false").lower() == "true"
ROLE_MOD        = 100  # IntEnum threshold for moderator+

def reject(code: int):
    return code, None, None, None, None

async def place_by_offsets(client, cx: int, cy: int, offsets: list[tuple[int, int]]):
    pixels = [Pixel(cx, cy, offset, color) for offset, color in offsets]
    return await place(client, pixels)


async def place(client, pixels: list[Pixel]):
    ip = client.ip
    canvas_id = client.canvas
    void = get_void() #for void event

    user_key = "null"
    if client.user:
        user_key = RedisKeys.COOLDOWN_USER.value.format(user_id=client.user.id, canvas_id=canvas_id)
    else:
        return reject(3)
    
    if hasattr(client, 'is_nsws') and client.is_nsws:
        user_key = "nsws_bypass"

    if client.banned:
        return reject(2)

    captcha_verified = await is_verified(ip)
    if not captcha_verified and DO_CAPTCHA and not (hasattr(client, 'is_nsws') and client.is_nsws):
        return reject(5)

    if client.is_proxy and not (hasattr(client, 'is_nsws') and client.is_nsws):
        return reject(1)

    is_mod = bool(client.user and client.user.role >= ROLE_MOD)

    # Users without a linked Discord account get 2x cooldown
    discord_penalty = (
        not is_mod
        and client.user is not None
        and not client.user.discord_id
    )

    chunks = {}
    canvas = canvases.get(canvas_id)
    if canvas is None:
        return reject(4)

    virgin_threshold = canvas.unset_pixels_below
    filtered_pixels = []
    for pixel in pixels:
        if pixel.color < virgin_threshold and not is_mod:
            continue
        filtered_pixels.append(pixel)

    if not filtered_pixels:
        return reject(6)
    pixels = filtered_pixels

    for pixel in pixels:
        if pixel.cx < 0 or pixel.cy < 0 or pixel.cx >= canvas.size or pixel.cy >= canvas.size:
            continue
        if pixel.color < 0 or pixel.color >= len(canvas.colors):
            continue
        if void.is_pixel_blocked(canvas_id, pixel.x(), pixel.y()):
            continue
        key = (pixel.cx, pixel.cy)
        if key not in chunks:
            chunks[key] = {"args": [], "pixels": []}
        chunks[key]["args"].append(pixel.offset)
        chunks[key]["args"].append(pixel.color)
        chunks[key]["pixels"].append(pixel)

    all_placed_pixels = []
    ranked_pixels = 0
    new_cooldown_ms = 0
    max_cooldown_ms = 0

    user_cd_rate = -1.0
    if client.user:
        raw_rate = await redis_client.get(RedisKeys.UID_CD_RATE.value.format(user_id=client.user.id))
        if raw_rate is not None:
            try:
                user_cd_rate = float(raw_rate)
            except (ValueError, TypeError):
                user_cd_rate = -1.0

    rank_uid = -1
    if client.user and canvas.ranked:
        rank_uid = client.user.id

    day = datetime.now(timezone.utc).date().isoformat()

    for key, queued_pixels in chunks.items():
        cx, cy = key
        cd_multiplier = 2 if discord_penalty else 1
        cd_multiplier *= void.get_cd_multiplier() #this is the void cooldown TODO refactor this so void just writes to a global factor variable
        
        output = await scripts["place"](
            keys=[
                RedisKeys.CHUNK.value.format(canvas_id=canvas_id, cx=cx, cy=cy),
                RedisKeys.COOLDOWN_IP.value.format(addr=ip, canvas_id=canvas_id),
                user_key,
                RedisKeys.TOTAL_PIXELS.value,
                RedisKeys.DAILY_PIXELS.value.format(day=day),
                RedisKeys.CANVAS_PIXELS.value.format(canvas_id=canvas_id),
                RedisKeys.DAILY_CANVAS_PIXELS.value.format(day=day, canvas_id=canvas_id),
                RedisKeys.DAILY_COUNTRY_PIXELS.value.format(day=day),
            ],
            args=[
                canvas.unset_cooldown * cd_multiplier,
                canvas.set_cooldown * cd_multiplier,
                canvas.unset_pixels_below,
                canvas.stack,
                1000,
                rank_uid,
                1 if is_mod else 0,
                client.country_code,
                void.get_blocked_index(canvas_id, cx, cy),
                user_cd_rate,
                *queued_pixels["args"],
            ],
        )

        placed_lookup = set(output[0])
        ranked_pixels  += output[1]
        new_cooldown_ms = output[2]
        max_cooldown_ms = max(max_cooldown_ms, output[3])

        placed_pixels = [
            pixel for pixel in queued_pixels["pixels"]
            if pixel.offset in placed_lookup
        ]

        if placed_pixels:
            all_placed_pixels.extend(placed_pixels)
            await queue_pixels(canvas_id, cx, cy, placed_pixels, exclude_client=client)
            add_pixels_to_chunks(canvas_id, cx, cy, len(placed_pixels))
            log_pixels(client, placed_pixels)

            # Push to any open WatchZone SSE streams
            try:
                #client.user will always be defined here but ok
                uid = client.user.id if client.user else None
                username = client.user.username if client.user else None
                avatar = client.user.avatar if client.user else None
                discord_id = client.user.discord_id if client.user else None
                role = client.user.role if client.user else 0
                for pixel in placed_pixels:
                    notify_watch_streams(
                        canvas_id, pixel.x(), pixel.y(), uid, ip, pixel.color,
                        username=username, avatar=avatar, discord_id=discord_id, role=role
                    )
            except Exception:
                pass

    # ── Process void damage from successful placements ─────────────────────────
    if all_placed_pixels:
        # dem please move this to void_event
        try:
            if void.phase == "active" and void.is_void_chunk(canvas_id, pixel.cx, pixel.cy):
                total_dmg = 0.0
                root_cuts = 0
                for pixel in all_placed_pixels:
                    wx = pixel.cx * CHUNK_PX + (pixel.offset % CHUNK_PX)
                    wy = pixel.cy * CHUNK_PX + (pixel.offset // CHUNK_PX)
                    dmg, etype = void.process_player_pixel(wx, wy, pixel.color)
                    if etype == "root":
                        root_cuts += 1
                    total_dmg += dmg

                if total_dmg > 0.0:
                    asyncio.create_task(void._broadcast())
        except Exception:
            pass

    return 0, all_placed_pixels, ranked_pixels, new_cooldown_ms, max_cooldown_ms