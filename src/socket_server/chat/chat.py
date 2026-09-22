from src.redis_client.client import client as redis
from src.redis_client.keys import RedisKeys
from src.sql.chat import *
from src.sql.db import AsyncSessionLocal
from src.socket_server.router import on
from src.socket_server.packets import opcode, serialize_text, serialize_delete_messages, serialize_chat_error
from src.socket_server.clients import clients
from src.classes import Role
from safetext import SafeText
from src.flair import get_compact_flair_cached
from src.avatar import resolve_avatar_url
from src.mod_log import log_mod_action
import asyncio
import time as _time

def _get_client_host(client) -> str:
    try:
        headers = getattr(client.socket, "headers", {})
        host = headers.get("x-forwarded-host") or headers.get("host") or ""
        host = host.split(":")[0].strip().lower()
        if not host or "127.0.0.1" in host or "localhost" in host:
            ref = headers.get("referer") or headers.get("origin") or ""
            if "pixmap.fun" in ref:
                host = "dev.pixmap.fun" if "dev." in ref else "pixmap.fun"
        return host
    except Exception:
        return ""

CHAT_RATE_LIMIT_SECS = 1
MAX_MSG_LEN          = 200
DEFAULT_CHAT_MIN_PIXELS = 5000
RATE_LIMIT_KEY       = "chat_rl:{uid}"
MUTE_KEY             = "chat_mute:{uid}"
SYSTEM_USER_ID       = 0
SERVER_USER_ID       = 1

# ── Helpers ───────────────────────────────────────────────────────────────────

async def get_chat_min_pixels() -> int:
    """Pixels required to chat (admin-configurable; 0 disables the gate)."""
    raw = await redis.get(RedisKeys.CHAT_MIN_PIXELS.value)
    if raw is None:
        return DEFAULT_CHAT_MIN_PIXELS
    try:
        return max(0, int(raw))
    except (TypeError, ValueError):
        return DEFAULT_CHAT_MIN_PIXELS

async def set_chat_min_pixels(value: int) -> int:
    value = max(0, int(value))
    await redis.set(RedisKeys.CHAT_MIN_PIXELS.value, str(value))
    return value

async def is_muted(user_id: int) -> bool:
    return bool(await redis.exists(MUTE_KEY.format(uid=user_id)))

async def filter_message(client, msg: str):
    if not client.user:
        return False, 0
    if client.banned:
        return False, 3  # muted/banned handle similarly for now or generic error
    if not msg or len(msg) > MAX_MSG_LEN:
        return False, 1

    if await is_muted(client.user.id):
        return False, 3  # muted

    # Staff can always chat; everyone else must meet the admin-configured pixel gate.
    if client.user.role < Role.TRIAL_MOD:
        min_pixels = await get_chat_min_pixels()
        if min_pixels > 0:
            from src.redis_client.leaderboards import get_pixel_count
            pixels = await get_pixel_count(user_id=client.user.id)
            if pixels < min_pixels:
                return False, 4

    rate_limited = await redis.exists(RATE_LIMIT_KEY.format(uid=client.user.id))
    if rate_limited and client.user.role < Role.TRIAL_MOD:
        return False, 2

    #filter text, unless the player is a mod
    #if client.user.role < Role.TRIAL_MOD:
        #msg = st.censor_profanity(text=msg)
    return True, msg

ALLOWED_CHANNELS = {"ENG", "INT", "TUR", "ESP", "GER", "FRA", "UKR", "RUS"}

def format_packet(message: ChatMessage, user=None, flair: dict = None):
    avatar_url = resolve_avatar_url(user.avatar, getattr(user, "discord_id", None)) if user else ""
    payload = [
        message.user_id,
        [user.username, avatar_url, user.role, flair or {}] if user else [],
        message.content,
        message.id,
        message.created_at.timestamp() if getattr(message, 'created_at', None) else _time.time(),
        getattr(message, "channel", "ENG") or "ENG"
    ]
    return payload

async def broadcast_chat(message: ChatMessage, user=None, flair: dict = None):
    pkt = serialize_text(opcode.CHAT, format_packet(message, user, flair))
    for c in list(clients):
        asyncio.create_task(c.safe_send_text(pkt))

async def send_system_message(text: str, channel: str = "ENG"):
    """Broadcast a system message to all connected clients (not stored in DB)."""
    pkt = serialize_text(opcode.CHAT, [SYSTEM_USER_ID, ["System", "", 0], text, 0, _time.time(), channel])
    for c in list(clients):
        asyncio.create_task(c.safe_send_text(pkt))

async def send_server_to_client(client, text: str, channel: str = "ENG"):
    """Reply as the Server account (user id 1). Not stored in DB."""
    user = await find_user_by_id_or_username(str(SERVER_USER_ID))
    if user:
        async with AsyncSessionLocal() as db:
            flair = await get_compact_flair_cached(user.id, db)
        info = [user.username, user.avatar or "", user.role, flair or {}]
        uid = user.id
    else:
        info = ["Server", "", 0, {}]
        uid = SERVER_USER_ID
    pkt = serialize_text(opcode.CHAT, [uid, info, text, 0, _time.time(), channel])
    try:
        await client.socket.send_text(pkt)
    except Exception:
        pass

def _mins_secs(seconds) -> tuple[int, int]:
    seconds = max(0, int(seconds))
    return seconds // 60, seconds % 60

def _void_chat_reply() -> str:
    from src.void_event import get_void, IDLE, ACTIVE, DYING_WIN, DYING_LOSE, LOCKDOWN
    from src.canvases import canvases, CHUNK_PX

    v = get_void()
    now = _time.time()

    if v.phase == ACTIVE:
        x, y = v.center_x, v.center_y
        canvas = canvases.get(v.canvas_id)
        if canvas:
            total = canvas.size * CHUNK_PX
            x = v.center_x - total // 2
            y = v.center_y - total // 2
        left = 0 if v.phase_end_ts == float("inf") else max(0, v.phase_end_ts - now)
        m, s = _mins_secs(left)
        return f"Void now at ({x}, {y}) | {m}m{s}s remaining"

    cd_left = max(0.0, v.cd_mod_until - now)
    cd_mult = v.get_cd_multiplier()

    if v.phase == DYING_WIN or (v.phase == IDLE and cd_mult < 1.0):
        if cd_left <= 0:
            cd_left = v.cfg.get("win_cooldown_halve_secs", 1800)
        m, s = _mins_secs(cd_left)
        return f"Void won, reduced cooldown for {m} minutes {s} seconds"

    if v.phase in (DYING_LOSE, LOCKDOWN) or (v.phase == IDLE and cd_mult > 1.0):
        if cd_left <= 0:
            cd_left = v.cfg.get("loss_cooldown_double_secs", 600)
        m, s = _mins_secs(cd_left)
        return f"Void lost, increased cooldown for {m} minutes {s} seconds"

    m, s = _mins_secs(max(0, v.next_void_ts - now))
    return f"Next void in {m} minutes {s} seconds"

def _fmt_duration(seconds: int) -> str:
    if seconds == 0:
        return "permanently"
    if seconds < 60:
        return f"for {seconds}s"
    if seconds < 3600:
        return f"for {seconds // 60}m"
    return f"for {seconds // 3600}h"

# ── Chat event handler ────────────────────────────────────────────────────────

@on(opcode.CHAT)
async def handle_chat_message(client, obj):
    global CHAT_RATE_LIMIT_SECS
    msg = str(obj[0])
    channel = "ENG"
    if len(obj) > 1 and obj[1]:
        channel = str(obj[1]).strip().upper()

    # ── Public info commands (not stored) ─────────────────────────────────────
    if msg.strip().lower() == "!void":
        await send_server_to_client(client, _void_chat_reply(), channel)
        return

    # ── Mod / admin chat commands ─────────────────────────────────────────────
    if msg.startswith('/') and client.user and client.user.role >= Role.TRIAL_MOD:
        parts = msg.split()
        cmd   = parts[0].lower()

        # /mute <user_id_or_username> <seconds>  (0 = permanent)
        if cmd == '/mute' and len(parts) >= 3:
            try:
                duration = int(parts[2])
            except ValueError:
                await client.socket.send_bytes(serialize_chat_error(1))
                return
            target = await find_user_by_id_or_username(parts[1])
            if not target:
                await client.socket.send_bytes(serialize_chat_error(1))
                return
            key = MUTE_KEY.format(uid=target.id)
            if duration == 0:
                await redis.set(key, "1")          # permanent — no expiry
            else:
                await redis.setex(key, duration, "1")
            dur_str = _fmt_duration(duration)
            await send_system_message(
                f"🔇 {target.username} was muted {dur_str} by {client.user.username}.",
                channel=channel
            )
            asyncio.create_task(log_mod_action(
                user_id=client.user.id,
                username=client.user.username,
                action="mute",
                details=f"Muted {target.username} (#{target.id}) {dur_str} in channel '{channel}'",
                host=_get_client_host(client),
            ))
            return

        # /unmute <user_id_or_username>
        if cmd == '/unmute' and len(parts) >= 2:
            target = await find_user_by_id_or_username(parts[1])
            if not target:
                await client.socket.send_bytes(serialize_chat_error(1))
                return
            await redis.delete(MUTE_KEY.format(uid=target.id))
            await send_system_message(
                f"🔈 {target.username} was unmuted by {client.user.username}.",
                channel=channel
            )
            asyncio.create_task(log_mod_action(
                user_id=client.user.id,
                username=client.user.username,
                action="unmute",
                details=f"Unmuted {target.username} (#{target.id}) in channel '{channel}'",
                host=_get_client_host(client),
            ))
            return

        # /chatcd <seconds>
        if cmd == "/chatcd" and len(parts) >= 2:
            try:
                seconds = int(parts[1])
            except ValueError:
                await client.socket.send_bytes(serialize_chat_error(1))
                return
            if seconds > 0:
                CHAT_RATE_LIMIT_SECS = seconds
                await send_system_message(
                    f"Chat cooldown set to {seconds}s by {client.user.username}.",
                    channel=channel
                )
                asyncio.create_task(log_mod_action(
                    user_id=client.user.id,
                    username=client.user.username,
                    action="chat_cooldown",
                    details=f"Set chat cooldown to {seconds}s in channel '{channel}'",
                    host=_get_client_host(client),
                ))
            return

        # /purge <user_id_or_username> <amount>
        if cmd == '/purge' and len(parts) >= 3:
            try:
                amount = max(1, min(int(parts[2]), 100))
            except ValueError:
                await client.socket.send_bytes(serialize_chat_error(1))
                return
            target = await find_user_by_id_or_username(parts[1])
            if not target:
                await client.socket.send_bytes(serialize_chat_error(1))
                return
            ids = await get_last_messages_by_user(target.id, amount)
            if ids:
                deleted = await try_delete_messages(ids)
                pkt = serialize_delete_messages(list(deleted))
                for c in list(clients):
                    asyncio.create_task(c.safe_send_bytes(pkt))
            await send_system_message(
                f"🗑 {len(ids)} message(s) from {target.username} were purged by {client.user.username}.",
                channel=channel
            )
            asyncio.create_task(log_mod_action(
                user_id=client.user.id,
                username=client.user.username,
                action="chat_purge",
                details=f"Purged {len(ids)} message(s) from {target.username} (#{target.id}) in channel '{channel}'",
                host=_get_client_host(client),
            ))
            return

        # /announce <message> (Admins+ only)
        if cmd == '/announce':
            if client.user.role < Role.ADMIN:
                await client.socket.send_bytes(serialize_chat_error(1))
                return
            announcement_text = msg[len(parts[0]):].strip()
            if not announcement_text:
                await client.socket.send_bytes(serialize_chat_error(1))
                return
            announcement_data = {
                "userId": client.user.id,
                "username": client.user.username,
                "avatar": getattr(client.user, "avatar", "") or "",
                "discord_id": getattr(client.user, "discord_id", "") or "",
                "role": int(client.user.role),
                "message": announcement_text
            }
            pkt = serialize_text(opcode.ANNOUNCEMENT, announcement_data)
            for c in list(clients):
                asyncio.create_task(c.safe_send_text(pkt))
            asyncio.create_task(log_mod_action(
                user_id=client.user.id,
                username=client.user.username,
                action="announcement",
                details=f"Global announcement: {announcement_text[:300]}",
                host=_get_client_host(client),
            ))
            return

        # Unknown command
        await client.socket.send_bytes(serialize_chat_error(1))
        return

    # ── Regular message ───────────────────────────────────────────────────────
    can_send, msg = await filter_message(client, msg)
    if not can_send:
        await client.socket.send_bytes(serialize_chat_error(msg))
        return

    # ── Channel permissions check ─────────────────────────────────────────────
    if channel not in ALLOWED_CHANNELS:
        await client.socket.send_bytes(serialize_chat_error(1))
        return

    await redis.setex(RATE_LIMIT_KEY.format(uid=client.user.id), CHAT_RATE_LIMIT_SECS, "1")
    new_message = await add_message(client.user.id, msg, channel=channel)
    # Fetch compact flair (Redis-cached; no extra DB hit on most messages)
    async with AsyncSessionLocal() as db:
        flair = await get_compact_flair_cached(client.user.id, db)
    await broadcast_chat(new_message, client.user, flair)

@on(opcode.DELETE_MESSAGES)
async def handle_delete_messages(client, message_ids: list[int]):
    if not client.user or client.user.role < Role.TRIAL_MOD:
        return
    if not message_ids:
        return
    deleted = await try_delete_messages(message_ids)
    pkt = serialize_delete_messages(list(deleted))
    for c in list(clients):
        asyncio.create_task(c.safe_send_bytes(pkt))
    if deleted:
        asyncio.create_task(log_mod_action(
            user_id=client.user.id,
            username=client.user.username,
            action="chat_delete",
            details=f"Deleted {len(deleted)} message(s) (IDs: {list(deleted)[:10]})",
            host=_get_client_host(client),
        ))