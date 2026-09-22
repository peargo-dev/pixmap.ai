"""
Admin + Mod routes
  POST /admin/paste  — mod + admin: paste image to canvas
  GET  /admin/users  — admin only: list users
  PATCH /admin/users/{id} — admin only: set role / ban
  GET  /users/{id}   — public: profile info
  GET  /admin/watch  — mod+: snapshot query of pixel log for a bounding box
  GET  /admin/watch/stream — mod+: SSE live feed of new placements in zone
"""
from src.tiles import add_pixels_to_chunks
import json
import os
from pathlib import Path
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_, and_, func
from sqlalchemy.orm import selectinload
from src.sql.db import get_db
from src.sql.models import User, Ban, BanEntry
from src.sql.ban import ban_user, unban_user
from src.auth import require_mod, require_admin, require_owner, ADMIN_IDS, OWNER_IDS
from src.canvases import canvases, CHUNK_PX, save_canvases
from src.classes import Pixel, Role
from src.socket_server.clients import clients_by_user
from src.redis_client.keys import RedisKeys
from src.redis_client.leaderboards import get_pixel_count
from src.redis_client.client import client as redis_client
from src.socket_server.chunks import queue_pixels
from src.mod_log import log_mod_action
from src.cache.user_registry import invalidate_user

router = APIRouter()

# ── Public user profile ──────────────────────────────────────────────────────

@router.get("/users/{user_id}")
async def public_profile(user_id: int, db: AsyncSession = Depends(get_db)):
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")

    try:
        online = user_id in clients_by_user
    except Exception:
        online = False

    px = await get_pixel_count(user_id=user_id)
    return {
        "id":            user.id,
        "username":      user.username,
        "avatar":        user.avatar,
        "discord_id":    user.discord_id,
        "discord_username": getattr(user, "discord_username", None),
        "role":          user.role.value,
        "bio":           user.bio or "",
        "country":       user.country or "",
        "pixels_placed": px or 0,
        "created_at":    user.created_at.isoformat(),
        "online":        online,
    }

# ── Admin: user management ────────────────────────────────────────────────────

@router.get("/admin/users")
async def list_users(q: str = None, limit: int = 50, offset: int = 0, 
                     db: AsyncSession = Depends(get_db),
                     mod: User = Depends(require_mod)):
    stmt = select(User).options(selectinload(User.bans).selectinload(BanEntry.ban))
    if q:
        # Search by username, discord_id, or internal ID
        search_filter = or_(
            User.username.ilike(f"%{q}%"),
            User.discord_id == q,
        )
        if q.isdigit():
            search_filter = or_(search_filter, User.id == int(q))
        stmt = stmt.where(search_filter)
    
    # Get total count for pagination
    count_stmt = select(func.count(User.id))
    if q:
        count_stmt = count_stmt.where(search_filter)
    total_result = await db.execute(count_stmt)
    total = total_result.scalar()
    
    # Apply pagination
    result = await db.execute(stmt.order_by(User.id).limit(limit).offset(offset))
    users = result.scalars().all()
    try:
        online_ids = set(clients_by_user.keys())
    except Exception:
        online_ids = set()

    # Batch-fetch pixel counts from Redis concurrently
    pixel_counts = await asyncio.gather(*(get_pixel_count(user_id=u.id) for u in users))

    return {
        "users": [
            {
                "id":            u.id,
                "username":      u.username,
                "discord_id":    u.discord_id,
                "discord_username": getattr(u, "discord_username", None),
                "avatar":        u.avatar,
                "role":          u.role.value,
                "banned":        u.is_banned,
                "pixels_placed": px or 0,
                "country":       u.country or "",
                "online":        u.id in online_ids,
                "created_at":    u.created_at.isoformat(),
                "is_proxy":      any(c.is_proxy for c in clients_by_user.get(u.id, set())),
            }
            for u, px in zip(users, pixel_counts)
        ],
        "total": total,
        "limit": limit,
        "offset": offset
    }

@router.patch("/admin/users/{user_id}")
async def update_user(user_id: int, request: Request,
                      db: AsyncSession = Depends(get_db),
                      caller: User = Depends(require_mod)):
    target = await db.scalar(
        select(User)
        .where(User.id == user_id)
        .options(selectinload(User.bans).selectinload(BanEntry.ban))
    )
    if not target:
        raise HTTPException(404, "User not found")
    caller_id = int(caller.id)
    target_id = int(target.id)

    body = await request.json()
    caller_is_superadmin = caller.role >= Role.OWNER or caller.id in OWNER_IDS

    if "role" in body:
        if target_id == caller_id:
            raise HTTPException(400, "Cannot modify your own role")
        # Only admins can change roles
        is_caller_admin = caller.is_admin or caller.id in ADMIN_IDS
        if not is_caller_admin:
            raise HTTPException(403, "Only admins can change roles")
        role_str = str(body["role"])
        role_map = {
            "user":      Role.PLAYER,
            "trial_mod": Role.TRIAL_MOD,
            "moderator": Role.MOD,
            "admin":     Role.ADMIN,
        }
        if role_str not in role_map:
            raise HTTPException(400, "Invalid role")
        
        target_role = role_map[role_str]
        if (target.role >= Role.ADMIN or target_role >= Role.ADMIN) and not caller_is_superadmin:
            raise HTTPException(403, "Only superadmins can promote or demote admins")

        target.role = target_role
        await log_mod_action(
            user_id=caller.id,
            username=caller.username,
            action="update_role",
            details=f"Updated role of user {target.username} (ID: {target_id}) to {role_str}"
        )

    if "banned" in body:
        new_ban_state = bool(body["banned"])
        if target.is_banned != new_ban_state:
            
            expires_at = None
            if new_ban_state and "duration" in body:
                try:
                    duration = int(body["duration"])
                    if duration > 0:
                        expires_at = datetime.now(timezone.utc) + timedelta(seconds=duration)
                except ValueError:
                    pass

            if new_ban_state:
                ban_alts = bool(body.get("ban_alts", False))
                await ban_user(
                    session=db,
                    user_id=target_id,
                    mod_id=caller_id,
                    reason=body.get("reason", "No reason provided"),
                    expires_at=expires_at,
                    ban_alts=ban_alts
                )

                await log_mod_action(
                    user_id=caller.id,
                    username=caller.username,
                    action="ban_user",
                    details=f"Banned user {target.username} (ID: {target_id}). Reason: {body.get('reason', 'No reason provided')}. Duration: {body.get('duration', 'Permanent')}"
                )
               
            else:
                # Unbanning an original target also releases that ban's alts.
                # This helper updates live clients and uses batched SQL.
                await unban_user(db, target_id)
                
                await log_mod_action(
                    user_id=caller.id,
                    username=caller.username,
                    action="unban_user",
                    details=f"Unbanned user {target.username} (ID: {target_id})"
                )

    await db.commit()
    # Evict from the in-process cache so the next request re-fetches the updated role.
    invalidate_user(target_id)
    return {"ok": True}

@router.get("/admin/users/{user_id}/profile")
async def get_user_profile(user_id: int, db: AsyncSession = Depends(get_db),
                           mod: User = Depends(require_mod)):
    """Deep profile lookup — returns full user info including discord_id. Trial mod+."""
    from src.sql.models import IPUserPair, IPInfo
    user = await db.scalar(
        select(User)
        .where(User.id == user_id)
        .options(selectinload(User.bans).selectinload(BanEntry.ban))
    )
    if not user:
        raise HTTPException(404, "User not found")

    is_admin = mod.role >= Role.ADMIN or mod.id in ADMIN_IDS

    try:
        online = user_id in clients_by_user
    except Exception:
        online = False

    px = await get_pixel_count(user_id=user_id)

    # Build ban history list
    ban_history = []
    for entry in (user.bans or []):
        ban_history.append({
            "id":         entry.ban.id,
            "active":     entry.active,
            "is_alt":     entry.is_alt,
            "reason":     entry.ban.reason,
            "expires_at": entry.ban.expires_at.isoformat() if entry.ban.expires_at else None,
            "created_at": entry.ban.created_at.isoformat() if entry.ban.created_at else None,
            "moderator_id": entry.ban.moderator_id,
        })

    # Inline IP history (last 20) with outerjoin
    ip_rows = await db.execute(
        select(
            IPUserPair.ip,
            IPInfo.country_code,
            IPInfo.cidr,
            IPInfo.hash,
            IPUserPair.first_seen,
            IPUserPair.last_seen,
        )
        .outerjoin(IPInfo, IPInfo.ip == IPUserPair.ip)
        .where(IPUserPair.user_id == user_id)
        .order_by(IPUserPair.last_seen.desc())
        .limit(20)
    )
    ip_list = []
    user_iids_set = set()
    for r in ip_rows:
        h = r[3]
        formatted_hash = f"iid_{h}" if (h and not h.startswith("iid_")) else h
        if formatted_hash:
            user_iids_set.add(formatted_hash)
        ip_list.append({
            "ip":         r[0] if is_admin else (r[2] or r[0]),
            "raw_ip":     r[0] if is_admin else None,
            "country":    r[1] or "??",
            "cidr":       r[2],
            "iid_hash":   formatted_hash,
            "first_seen": r[4].isoformat() if r[4] else None,
            "last_seen":  r[5].isoformat() if r[5] else None,
        })

    # Also query any additional IIDs if not already caught
    extra_iid_rows = await db.execute(
        select(IPInfo.hash)
        .outerjoin(IPUserPair, IPUserPair.ip == IPInfo.ip)
        .where(IPUserPair.user_id == user_id)
        .distinct()
    )
    for er in extra_iid_rows:
        if er[0]:
            eh = er[0]
            user_iids_set.add(f"iid_{eh}" if not eh.startswith("iid_") else eh)

    return {
        "id":            user.id,
        "username":      user.username,
        "discord_id":    user.discord_id,
        "discord_username": getattr(user, "discord_username", None),
        "google_id":     getattr(user, "google_id", None),
        "avatar":        user.avatar,
        "role":          user.role.value,
        "bio":           user.bio or "",
        "country":       user.country or "",
        "pixels_placed": px or 0,
        "created_at":    user.created_at.isoformat(),
        "last_login":    user.last_login.isoformat() if user.last_login else None,
        "online":        online,
        "is_banned":     user.is_banned,
        "email":         user.email if is_admin else None,
        "ban_history":   ban_history,
        "ip_history":    ip_list,
        "iids":          sorted(list(user_iids_set)),
    }


@router.get("/admin/users/by-discord/{discord_id}")
async def users_by_discord(discord_id: str, db: AsyncSession = Depends(get_db),
                           mod: User = Depends(require_mod)):
    is_admin = mod.role >= Role.ADMIN or mod.id in ADMIN_IDS
    rows = await db.execute(
        select(User)
        .where(User.discord_id == discord_id)
        .options(selectinload(User.bans).selectinload(BanEntry.ban))
        .order_by(User.last_login.desc())
    )
    users = rows.scalars().all()
    result = []
    for u in users:
        px = await get_pixel_count(user_id=u.id)
        ban_history = []
        for entry in (u.bans or []):
            ban_history.append({
                "id":           entry.ban.id,
                "active":       entry.active,
                "is_alt":       entry.is_alt,
                "reason":       entry.ban.reason,
                "expires_at":   entry.ban.expires_at.isoformat() if entry.ban.expires_at else None,
                "created_at":   entry.ban.created_at.isoformat() if entry.ban.created_at else None,
                "moderator_id": entry.ban.moderator_id,
            })
        result.append({
            "id":            u.id,
            "username":      u.username,
            "discord_id":    u.discord_id,
            "avatar":        u.avatar,
            "role":          u.role.value,
            "bio":           u.bio or "",
            "country":       u.country or "",
            "pixels_placed": px or 0,
            "created_at":    u.created_at.isoformat(),
            "last_login":    u.last_login.isoformat() if u.last_login else None,
            "online":        u.id in clients_by_user,
            "is_banned":     u.is_banned,
            "email":         u.email if is_admin else None,
            "ban_history":   ban_history,
        })
    return {"discord_id": discord_id, "users": result}


@router.get("/admin/users/{user_id}/bans")
async def get_user_bans(user_id: int, db: AsyncSession = Depends(get_db),
                       mod: User = Depends(require_mod)):
    stmt = select(BanEntry, Ban).join(Ban, Ban.id == BanEntry.ban_id).where(BanEntry.user_id == user_id).order_by(Ban.created_at.desc())
    results = await db.execute(stmt)
    
    logs = []
    for entry, ban in results:
        logs.append({
            "id": ban.id,
            "user_id": entry.user_id,
            "admin_id": ban.moderator_id,
            "is_ban": True,
            "reason": ban.reason,
            "expires_at": ban.expires_at,
            "created_at": ban.created_at,
            "active": entry.active,
            "is_alt": entry.is_alt
        })
    return {"logs": logs}

# ── Mod+Admin: image paste ────────────────────────────────────────────────────

import asyncio
import io
import collections
import numpy as np
from PIL import Image
from fastapi import Form, File, UploadFile, HTTPException, Depends


def _process_image_sync(raw_bytes: bytes, start_x: int, start_y: int, palette: list, total_px: int, protected: bool,
                        chunk_px: int) -> dict:
    """
    Synchronous CPU-bound worker function to process the image, calculate nearest colors
    using numpy, and group pixels by chunk.
    """
    try:
        img = Image.open(io.BytesIO(raw_bytes)).convert("RGBA")
    except Exception:
        raise ValueError("Invalid image file")

    arr = np.array(img, dtype=np.uint8)
    del img  # Free RAM

    # 1. Mask valid pixels (Alpha >= 128)
    valid_mask = arr[:, :, 3] >= 128

    # Get local X/Y coordinates for the valid pixels
    local_y, local_x = np.where(valid_mask)

    # 2. Extract RGB for valid pixels only and cast for math
    rgb = arr[:, :, :3].astype(np.int32)[valid_mask]
    del arr  # Free the main RGBA array

    if rgb.size == 0:
        return {}

    # 3. Compute nearest colors using numpy broadcasting
    palette_arr = np.array(palette, dtype=np.int32)
    # Compute differences: Shape (N, P, 3) where N=pixels, P=palette colors
    diff = rgb[:, None, :] - palette_arr[None, :, :]
    del rgb

    # Calculate sum of squared distances and find the index of the minimum
    color_indices = (diff ** 2).sum(axis=2).argmin(axis=1).astype(np.uint8)

    # 4. Apply protected flag to the color index if needed
    if protected:
        color_indices = color_indices | 0x80

    # 5. Calculate global coordinates
    global_x = local_x + start_x
    global_y = local_y + start_y

    # 6. Filter out out-of-bounds pixels
    in_bounds_mask = (global_x >= 0) & (global_x < total_px) & \
                     (global_y >= 0) & (global_y < total_px)

    global_x = global_x[in_bounds_mask]
    global_y = global_y[in_bounds_mask]
    color_indices = color_indices[in_bounds_mask]

    if global_x.size == 0:
        return {}

    # 7. Calculate chunks and offsets globally using vectorized math
    cx = global_x // chunk_px
    cy = global_y // chunk_px
    offsets = (global_y - cy * chunk_px) * chunk_px + (global_x - cx * chunk_px)

    # 8. Group into dictionary by chunk coordinate
    placed_by_chunk = collections.defaultdict(list)

    # .tolist() converts numpy types back to standard Python ints rapidly for zip iteration
    for c_x, c_y, off, col in zip(cx.tolist(), cy.tolist(), offsets.tolist(), color_indices.tolist()):
        placed_by_chunk[(c_x, c_y)].append((off, col))

    return dict(placed_by_chunk)


@router.post("/admin/paste")
async def paste_image(
        canvas_id: int = Form(0),
        x: int = Form(...),
        y: int = Form(...),
        file: UploadFile = File(...),
        protected: bool = Form(False),
        mod: User = Depends(require_mod),
):
    canvas = canvases.get(canvas_id)
    if canvas is None:
        raise HTTPException(404, "Canvas not found")

    raw = await file.read()
    palette = canvas.colors
    total_px = canvas.size * CHUNK_PX

    # Offload the heavy numpy computation to a worker thread
    try:
        placed_by_chunk = await asyncio.to_thread(
            _process_image_sync,
            raw, x, y, palette, total_px, protected, CHUNK_PX
        )
    except ValueError as e:
        raise HTTPException(400, str(e))

    # Write to Redis and broadcast
    total_placed = 0
    for (cx, cy), pixels in placed_by_chunk.items():
        chunk_key = RedisKeys.CHUNK.value.format(cx=cx, cy=cy, canvas_id=canvas_id)
        args = ["bitfield", chunk_key]
        for offset, color in pixels:
            args += ["set", "u8", str(offset * 8), str(color)]

        asyncio.create_task(redis_client.execute_command(*args))

        pixel_objs = [Pixel(cx, cy, offset, color) for offset, color in pixels]
        #asyncio.create_task(queue_pixels(canvas_id, cx, cy, pixel_objs)) commented out due to extreme client lag.
        #would be ideal to have a packet that tells the client to refresh any loaded chunks in the paste area.

        total_placed += len(pixels)

        # Update zoom tiles tracking
        add_pixels_to_chunks(canvas_id, cx, cy, len(pixels))

    if total_placed > 0:
        # No-op: history worker determines changed chunks from Redis diffs
        # and writes difference PNGs itself; app does not write marker files.
        pass

    await log_mod_action(
        user_id=mod.id,
        username=mod.username,
        action="paste_image",
        details=f"Pasted image '{file.filename}' to canvas {canvas_id} at ({x}, {y}) (protected: {protected}). Placed {total_placed} pixels."
    )

    return {"placed": total_placed}

# ── Admin: canvas management ──────────────────────────────────────────────────

def _canvas_to_dict(cid: int, c):
    return {
        "id":                cid,
        "name":              c.name,
        "indent":            c.indent,
        "size":              c.size,
        "description":       c.description,
        "unset_cooldown":    c.unset_cooldown,
        "set_cooldown":      c.set_cooldown,
        "pixel_requirement": c.pixel_requirement,
        "stack":             c.stack,
        "ranked":            c.ranked,
        "unset_pixels_below": c.unset_pixels_below,
        "hotkey":            getattr(c, "hotkey", "") or "",
        "colors":            [list(col) for col in c.colors],
    }

@router.get("/admin/canvases")
async def list_canvases(admin: User = Depends(require_admin)):
    return {"canvases": [_canvas_to_dict(cid, c) for cid, c in sorted(canvases.items())]}


@router.post("/admin/canvases")
async def create_canvas(request: Request, admin: User = Depends(require_admin)):
    from src.canvases import Canvas
    body = await request.json()

    raw_id = body.get("id")
    new_id = int(raw_id) if raw_id is not None else (max(canvases.keys(), default=-1) + 1)
    if new_id in canvases:
        raise HTTPException(400, "Canvas ID already exists")

    canvases[new_id] = Canvas(
        name               = str(body.get("name", "New Canvas")),
        indent             = str(body.get("indent", "c")),
        size               = int(body.get("size", 256)),
        description        = str(body.get("description", "")),
        unset_cooldown     = int(body.get("unset_cooldown", 750)),
        set_cooldown       = int(body.get("set_cooldown", 750)),
        pixel_requirement  = int(body.get("pixel_requirement", 0)),
        stack              = int(body.get("stack", 120000)),
        ranked             = bool(body.get("ranked", True)),
        unset_pixels_below = int(body.get("unset_pixels_below", 2)),
        hotkey             = str(body.get("hotkey", "")).strip(),
        **({"colors": [tuple(c[:3]) for c in body["colors"] if len(c) >= 3]}
           if "colors" in body and isinstance(body["colors"], list) else {})
    )
    await log_mod_action(
        user_id=admin.id,
        username=admin.username,
        action="create_canvas",
        details=f"Created canvas '{canvases[new_id].name}' (ID: {new_id}, size: {canvases[new_id].size})"
    )
    await save_canvases()
    return {"ok": True, "id": new_id}


@router.patch("/admin/canvases/{canvas_id}")
async def update_canvas(canvas_id: int, request: Request,
                        admin: User = Depends(require_admin)):
    canvas = canvases.get(canvas_id)
    if canvas is None:
        raise HTTPException(404, "Canvas not found")

    body = await request.json()
    for f in ("name", "indent", "description", "hotkey"):
        if f in body:
            setattr(canvas, f, str(body[f]).strip())
    for f in ("size", "unset_cooldown", "set_cooldown", "pixel_requirement", "stack", "unset_pixels_below"):
        if f in body:
            setattr(canvas, f, int(body[f]))
    if "ranked" in body:
        canvas.ranked = bool(body["ranked"])
    if "colors" in body and isinstance(body["colors"], list):
        canvas.colors = [tuple(c[:3]) for c in body["colors"] if isinstance(c, list) and len(c) >= 3]

    await log_mod_action(
        user_id=admin.id,
        username=admin.username,
        action="update_canvas",
        details=f"Updated canvas {canvas_id} configs: {json.dumps(body)}"
    )
    await save_canvases()
    return {"ok": True}


@router.delete("/admin/canvases/{canvas_id}")
async def delete_canvas(canvas_id: int, admin: User = Depends(require_admin)):
    if canvas_id not in canvases:
        raise HTTPException(404, "Canvas not found")
    name = canvases[canvas_id].name
    del canvases[canvas_id]
    await log_mod_action(
        user_id=admin.id,
        username=admin.username,
        action="delete_canvas",
        details=f"Deleted canvas '{name}' (ID: {canvas_id})"
    )
    await save_canvases()
    return {"ok": True}
# ── Mod tools: extended user inspection ───────────────────────────────────────

from src.sql.models import IPUserPair, IPInfo, PixelPlacement

@router.get("/admin/users/{user_id}/ips")
async def get_user_ips(user_id: int, db: AsyncSession = Depends(get_db),
                       mod: User = Depends(require_mod)):
    """IP history for a user (with country + CIDR)."""
    rows = await db.execute(
        select(
            IPUserPair.ip,
            IPInfo.country_code,
            IPInfo.cidr,
            IPInfo.hash,
            IPUserPair.first_seen,
            IPUserPair.last_seen,
        )
        .join(IPInfo, IPInfo.ip == IPUserPair.ip)
        .where(IPUserPair.user_id == user_id)
        .order_by(IPUserPair.last_seen.desc())
    )
    is_admin = mod.role >= 200 or mod.id in ADMIN_IDS
    return {"ips": [
        {
            "ip":      r[0] if is_admin else r[2],
            "country": r[1],
            "cidr":    r[2],
            "first_seen": (
                r[4].isoformat() + ("Z" if r[4].tzinfo is None else "")
                if r[4] else None
            ),
            "last_seen": (
                r[5].isoformat() + ("Z" if r[5].tzinfo is None else "")
                if r[5] else None
            ),
        }
        for r in rows
    ]}


@router.get("/admin/users/{user_id}/alts")
async def get_user_alts(user_id: int, db: AsyncSession = Depends(get_db),
                        mod: User = Depends(require_mod)):
    """Accounts that share at least one IP with this user (potential alts)."""
    ip_rows = await db.execute(
        select(IPUserPair.ip, IPInfo.hash, IPInfo.cidr)
        .join(IPInfo, IPInfo.ip == IPUserPair.ip)
        .where(IPUserPair.user_id == user_id)
    )
    ip_info_map = {r[0]: (r[1], r[2]) for r in ip_rows}
    ips = list(ip_info_map.keys())
    if not ips:
        return {"alts": [], "user_ips": []}

    alt_rows = await db.execute(
        select(IPUserPair.user_id, IPUserPair.ip)
        .where(IPUserPair.ip.in_(ips))
        .where(IPUserPair.user_id != user_id)
    )
    alt_map: dict[int, list[str]] = {}
    for uid, ip in alt_rows:
        alt_map.setdefault(uid, []).append(ip)

    is_admin = mod.role >= 200 or mod.id in ADMIN_IDS

    alts = []
    for uid, shared_ips in alt_map.items():
        u = await db.get(User, uid)
        if u:
            mapped_shared = [
                ip if is_admin else ip_info_map[ip][1]
                for ip in shared_ips
                if ip in ip_info_map
            ]
            alts.append({
                "id":         u.id,
                "username":   u.username,
                "avatar":     u.avatar,
                "discord_id": u.discord_id,
                "role":       u.role.value,
                "banned":     u.banned,
                "shared_ips": mapped_shared,
            })
    mapped_user_ips = [
        ip if is_admin else ip_info_map[ip][1]
        for ip in ips
    ]
    return {"alts": alts, "user_ips": mapped_user_ips}


@router.get("/admin/users/{user_id}/pixels")
async def get_user_pixels(user_id: int, limit: int = 200, order: str = "desc",
                          canvas_id: int | None = None, hours: float | None = None,
                          db: AsyncSession = Depends(get_db),
                          mod: User = Depends(require_mod)):
    """Recent pixel placements by a user with timeline playback and filter support."""
    effective_limit = max(1, min(limit, 5000))
    query = select(PixelPlacement).where(PixelPlacement.user_id == user_id)
    if canvas_id is not None:
        query = query.where(PixelPlacement.canvas_id == canvas_id)
    if hours is not None and hours > 0:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
        query = query.where(PixelPlacement.placed_at >= cutoff)

    if order.lower() == "asc":
        query = query.order_by(PixelPlacement.placed_at.asc())
    else:
        query = query.order_by(PixelPlacement.placed_at.desc())

    query = query.limit(effective_limit)
    rows = await db.execute(query)
    px = rows.scalars().all()
    is_admin = mod.role >= 200 or mod.id in ADMIN_IDS

    ips_to_query = list({p.ip for p in px})
    ip_hash_map = {}
    if ips_to_query and not is_admin:
        hashes = await db.execute(
            select(IPInfo.ip, IPInfo.cidr).where(IPInfo.ip.in_(ips_to_query))
        )
        ip_hash_map = {r[0]: r[1] for r in hashes}

    return {"pixels": [
        {"id": p.id, "x": p.x, "y": p.y, "color": p.color,
         "canvas_id": p.canvas_id, "ip": p.ip if is_admin else ip_hash_map.get(p.ip, "HIDDEN"),
         "placed_at": p.placed_at.isoformat()}
        for p in px
    ]}



@router.get("/admin/users/{user_id}/connections")
async def get_user_connections(user_id: int, mod: User = Depends(require_mod), db: AsyncSession = Depends(get_db)):
    """Live WebSocket connections for a specific user."""
    conns = list(clients_by_user.get(user_id, set()))
    is_admin = mod.role >= 200 or mod.id in ADMIN_IDS

    ips = list({c.ip for c in conns})
    ip_hash_map = {}
    if ips and not is_admin:
        hashes = await db.execute(
            select(IPInfo.ip, IPInfo.cidr).where(IPInfo.ip.in_(ips))
        )
        ip_hash_map = {r[0]: r[1] for r in hashes}

    return {"connections": [
        {"ip": c.ip if is_admin else ip_hash_map.get(c.ip, "HIDDEN"), "canvas": c.canvas, "is_proxy": c.is_proxy,
         "country": c.country_code}
        for c in conns
    ]}


@router.post("/admin/users/{user_id}/kick")
async def kick_user(user_id: int, mod: User = Depends(require_mod), db: AsyncSession = Depends(get_db)):
    """Disconnect all live connections for a user."""
    from src.socket_server.server import clients_by_user
    conns = list(clients_by_user.get(user_id, set()))
    for c in conns:
        try:
            asyncio.create_task(c.socket.close(code=4001))
        except Exception:
            pass
    target = await db.get(User, user_id)
    target_username = target.username if target else f"ID: {user_id}"
    await log_mod_action(
        user_id=mod.id,
        username=mod.username,
        action="kick_user",
        details=f"Kicked user {target_username} (ID: {user_id}). Disconnected {len(conns)} connections."
    )
    return {"kicked": len(conns)}


@router.post("/admin/users/{user_id}/cooldown")
async def change_user_cooldown(
    user_id: int,
    request: Request,
    owner: User = Depends(require_owner),
    db: AsyncSession = Depends(get_db)
):
    body = await request.json()
    canvas_val = body.get("canvas")  # can be "all" or integer ID
    seconds = float(body.get("seconds", 0))

    if seconds < 0:
        raise HTTPException(400, "Cooldown seconds cannot be negative")

    # Resolve target canvas IDs
    target_canvas_ids = []
    if canvas_val == "all":
        target_canvas_ids = list(canvases.keys())
    else:
        try:
            cid = int(canvas_val)
            if cid not in canvases:
                raise ValueError()
            target_canvas_ids = [cid]
        except (ValueError, TypeError):
            raise HTTPException(400, "Invalid canvas ID")

    # Get online clients and their IPs
    from src.socket_server.clients import clients_by_user
    online_clients = clients_by_user.get(user_id, set())
    client_ips = [c.ip for c in online_clients if getattr(c, "ip", None)]

    # Update Redis keys
    for canvas_id in target_canvas_ids:
        user_key = f"uid:{canvas_id}:{user_id}"
        if seconds == 0:
            await redis_client.delete(user_key)
            for ip in client_ips:
                await redis_client.delete(f"ip:{canvas_id}:{ip}")
        else:
            ms = int(seconds * 1000)
            await redis_client.set(user_key, "", px=ms)
            for ip in client_ips:
                await redis_client.set(f"ip:{canvas_id}:{ip}", "", px=ms)

    # Push updated cooldown state to all online clients for this user
    from src.cooldowns import get_cooldown
    from src.socket_server.packets import serialize_cooldown
    for c in online_clients:
        try:
            cooldowns_data = await get_cooldown(c)
            await c.socket.send_bytes(serialize_cooldown(cooldowns_data))
        except Exception:
            pass

    # Log action
    target_user = await db.get(User, user_id)
    target_username = target_user.username if target_user else f"ID: {user_id}"
    await log_mod_action(
        user_id=owner.id,
        username=owner.username,
        action="change_user_cooldown",
        details=f"Changed cooldown for user {target_username} (ID: {user_id}) on canvas {canvas_val} to {seconds}s."
    )

    return {"ok": True, "message": f"Cooldown set to {seconds}s on canvas {canvas_val}."}


@router.post("/admin/users/{user_id}/cd-rate")
async def set_user_cd_rate(
    user_id: int,
    request: Request,
    owner: User = Depends(require_owner),
    db: AsyncSession = Depends(get_db),
):
    body = await request.json()
    rate = body.get("rate", -1)

    try:
        rate = float(rate)
    except (TypeError, ValueError):
        raise HTTPException(400, "rate must be a number (0.0 = zero cd, -1 = reset to default)")

    target_user = await db.get(User, user_id)
    target_username = target_user.username if target_user else f"ID: {user_id}"
    key = RedisKeys.UID_CD_RATE.value.format(user_id=user_id)

    if rate < 0:
        await redis_client.delete(key)
        msg = f"CD rate reset to default for user {target_username}"
    else:
        await redis_client.set(key, str(rate))
        msg = f"CD rate set to {rate} for user {target_username}"

    await log_mod_action(
        user_id=owner.id,
        username=owner.username,
        action="set_user_cd_rate",
        details=msg,
    )
    return {"ok": True, "message": msg}



# ── Owner Tools: Advanced User Management ─────────────────────────────────────

@router.post("/admin/owner/pixels/add")
async def owner_add_pixels(
    request: Request,
    owner: User = Depends(require_owner),
    db: AsyncSession = Depends(get_db)
):
    """Add pixels to a user's leaderboard count."""
    body = await request.json()
    user_id = int(body.get("user_id"))
    amount = int(body.get("amount", 0))
    canvas_id = body.get("canvas_id", -1)  # -1 = all/global
    
    if amount <= 0:
        raise HTTPException(400, "Amount must be positive")
    
    target = await db.get(User, user_id)
    if not target:
        raise HTTPException(404, "User not found")
    
    # Add to Redis leaderboards
    if canvas_id == -1 or canvas_id == "all":
        # Add to global total
        await redis_client.zincrby(RedisKeys.TOTAL_PIXELS.value, amount, user_id)
        # Add to today's daily
        today = datetime.now(timezone.utc).date().isoformat()
        await redis_client.zincrby(RedisKeys.DAILY_PIXELS.value.format(day=today), amount, user_id)
    else:
        canvas_id = int(canvas_id)
        if canvas_id not in canvases:
            raise HTTPException(404, "Canvas not found")
        # Add to canvas-specific
        await redis_client.zincrby(RedisKeys.CANVAS_PIXELS.value.format(canvas_id=canvas_id), amount, user_id)
        # Add to today's daily for that canvas
        today = datetime.now(timezone.utc).date().isoformat()
        await redis_client.zincrby(
            RedisKeys.DAILY_CANVAS_PIXELS.value.format(canvas_id=canvas_id, day=today),
            amount,
            user_id
        )
    
    await log_mod_action(
        user_id=owner.id,
        username=owner.username,
        action="add_pixels",
        details=f"Added {amount} pixels to user {target.username} (ID: {user_id}) on canvas {canvas_id}"
    )
    
    return {"ok": True, "message": f"Added {amount} pixels"}


@router.post("/admin/owner/pixels/remove")
async def owner_remove_pixels(
    request: Request,
    owner: User = Depends(require_owner),
    db: AsyncSession = Depends(get_db)
):
    """Remove pixels from a user's leaderboard count."""
    body = await request.json()
    user_id = int(body.get("user_id"))
    amount = int(body.get("amount", 0))
    canvas_id = body.get("canvas_id", -1)
    
    if amount <= 0:
        raise HTTPException(400, "Amount must be positive")
    
    target = await db.get(User, user_id)
    if not target:
        raise HTTPException(404, "User not found")
    
    # Remove from Redis leaderboards (negative increment)
    if canvas_id == -1 or canvas_id == "all":
        await redis_client.zincrby(RedisKeys.TOTAL_PIXELS.value, -amount, user_id)
        today = datetime.now(timezone.utc).date().isoformat()
        await redis_client.zincrby(RedisKeys.DAILY_PIXELS.value.format(day=today), -amount, user_id)
    else:
        canvas_id = int(canvas_id)
        if canvas_id not in canvases:
            raise HTTPException(404, "Canvas not found")
        await redis_client.zincrby(RedisKeys.CANVAS_PIXELS.value.format(canvas_id=canvas_id), -amount, user_id)
        today = datetime.now(timezone.utc).date().isoformat()
        await redis_client.zincrby(
            RedisKeys.DAILY_CANVAS_PIXELS.value.format(canvas_id=canvas_id, day=today),
            -amount,
            user_id
        )
    
    await log_mod_action(
        user_id=owner.id,
        username=owner.username,
        action="remove_pixels",
        details=f"Removed {amount} pixels from user {target.username} (ID: {user_id}) on canvas {canvas_id}"
    )
    
    return {"ok": True, "message": f"Removed {amount} pixels"}


@router.post("/admin/owner/pixels/set")
async def owner_set_pixels(
    request: Request,
    owner: User = Depends(require_owner),
    db: AsyncSession = Depends(get_db)
):
    """Set a user's pixel count to an exact value."""
    body = await request.json()
    user_id = int(body.get("user_id"))
    amount = int(body.get("amount", 0))
    canvas_id = body.get("canvas_id", -1)
    
    if amount < 0:
        raise HTTPException(400, "Amount cannot be negative")
    
    target = await db.get(User, user_id)
    if not target:
        raise HTTPException(404, "User not found")
    
    # Set exact value in Redis leaderboards
    if canvas_id == -1 or canvas_id == "all":
        await redis_client.zadd(RedisKeys.TOTAL_PIXELS.value, {user_id: amount})
        today = datetime.now(timezone.utc).date().isoformat()
        await redis_client.zadd(RedisKeys.DAILY_PIXELS.value.format(day=today), {user_id: amount})
    else:
        canvas_id = int(canvas_id)
        if canvas_id not in canvases:
            raise HTTPException(404, "Canvas not found")
        await redis_client.zadd(RedisKeys.CANVAS_PIXELS.value.format(canvas_id=canvas_id), {user_id: amount})
        today = datetime.now(timezone.utc).date().isoformat()
        await redis_client.zadd(
            RedisKeys.DAILY_CANVAS_PIXELS.value.format(canvas_id=canvas_id, day=today),
            {user_id: amount}
        )
    
    await log_mod_action(
        user_id=owner.id,
        username=owner.username,
        action="set_pixels",
        details=f"Set pixel count for user {target.username} (ID: {user_id}) to {amount} on canvas {canvas_id}"
    )
    
    return {"ok": True, "message": f"Set pixel count to {amount}"}


@router.post("/admin/owner/link-discord")
async def owner_link_discord(
    request: Request,
    owner: User = Depends(require_owner),
    db: AsyncSession = Depends(get_db)
):
    """Manually link a Discord ID to a user account (allows up to 2 accounts per Discord ID)."""
    body = await request.json()
    user_id = int(body.get("user_id"))
    discord_id = str(body.get("discord_id", "")).strip()
    
    if not discord_id:
        raise HTTPException(400, "Discord ID is required")
    
    target = await db.get(User, user_id)
    if not target:
        raise HTTPException(404, "User not found")
    
    # Check how many accounts already have this Discord ID (allow up to 2)
    existing = await db.execute(
        select(User).where(User.discord_id == discord_id, User.id != user_id)
    )
    existing_users = existing.scalars().all()
    
    if len(existing_users) >= 2:
        usernames = ', '.join([f"{u.username} (ID: {u.id})" for u in existing_users])
        raise HTTPException(400, f"Discord ID already linked to 2 accounts: {usernames}. Maximum limit reached.")
    
    if len(existing_users) == 1:
        print(f"[owner_link_discord] Linking Discord ID {discord_id} as 2nd account. Existing: {existing_users[0].username} (ID: {existing_users[0].id})")
    
    old_discord_id = target.discord_id
    target.discord_id = discord_id
    await db.commit()
    
    await log_mod_action(
        user_id=owner.id,
        username=owner.username,
        action="link_discord",
        details=f"Linked Discord ID {discord_id} to user {target.username} (ID: {user_id}). Previous: {old_discord_id or 'None'}. Total accounts with this Discord ID: {len(existing_users) + 1}"
    )
    
    invalidate_user(user_id)
    
    if len(existing_users) == 1:
        return {"ok": True, "message": f"Discord ID linked successfully as 2nd account (1st account: {existing_users[0].username})"}
    else:
        return {"ok": True, "message": "Discord ID linked successfully"}


@router.post("/admin/owner/unlink-discord")
async def owner_unlink_discord(
    request: Request,
    owner: User = Depends(require_owner),
    db: AsyncSession = Depends(get_db)
):
    """Manually unlink Discord from a user account."""
    body = await request.json()
    user_id = int(body.get("user_id"))
    
    target = await db.get(User, user_id)
    if not target:
        raise HTTPException(404, "User not found")
    
    if not target.discord_id:
        raise HTTPException(400, "User has no Discord account linked")
    
    old_discord_id = target.discord_id
    target.discord_id = None
    await db.commit()
    
    await log_mod_action(
        user_id=owner.id,
        username=owner.username,
        action="unlink_discord",
        details=f"Unlinked Discord ID {old_discord_id} from user {target.username} (ID: {user_id})"
    )
    
    invalidate_user(user_id)
    return {"ok": True, "message": "Discord ID unlinked successfully"}


@router.post("/admin/owner/link-google")
async def owner_link_google(
    request: Request,
    owner: User = Depends(require_owner),
    db: AsyncSession = Depends(get_db)
):
    """Manually link a Google account to a user account (by Google ID and optionally email)."""
    body = await request.json()
    user_id = int(body.get("user_id"))
    google_input = str(body.get("google_id", "")).strip()
    
    if not google_input:
        raise HTTPException(400, "Google ID or email is required")
    
    target = await db.get(User, user_id)
    if not target:
        raise HTTPException(404, "User not found")
    
    # Parse input: if it contains @, extract email and use a placeholder google_id
    # Otherwise treat as numeric Google ID
    if "@" in google_input:
        # Email provided - we need to also get/create a google_id
        email = google_input.lower()
        
        # Check if this email is already used by another user
        email_check = await db.execute(
            select(User).where(User.email == email, User.id != user_id)
        )
        existing_email_user = email_check.scalar_one_or_none()
        if existing_email_user:
            raise HTTPException(400, f"Email {email} is already used by user {existing_email_user.username} (ID: {existing_email_user.id})")
        
        # For manual linking via email, we don't have the actual Google ID yet
        # The user needs to log in with Google to get their actual google_id
        # For now, just update the email and leave google_id as None
        # When they log in with Google, it will link via email match
        old_email = target.email
        old_google_id = target.google_id
        target.email = email
        target.google_id = None  # Will be linked on first Google OAuth login
        await db.commit()
        
        await log_mod_action(
            user_id=owner.id,
            username=owner.username,
            action="link_google_email",
            details=f"Updated email to {email} for user {target.username} (ID: {user_id}). Previous email: {old_email}, Previous google_id: {old_google_id or 'None'}. User must log in with Google to complete linking."
        )
        
        invalidate_user(user_id)
        return {"ok": True, "message": f"Email updated to {email}. User must log in with Google to complete linking."}
    else:
        # Direct Google ID provided (numeric)
        google_id = google_input
        
        # Check if this Google ID is already linked to a different user
        existing = await db.execute(
            select(User).where(User.google_id == google_id, User.id != user_id)
        )
        existing_user = existing.scalar_one_or_none()
        if existing_user:
            raise HTTPException(400, f"Google ID already linked to user {existing_user.username} (ID: {existing_user.id})")
        
        old_google_id = target.google_id
        target.google_id = google_id
        await db.commit()
        
        await log_mod_action(
            user_id=owner.id,
            username=owner.username,
            action="link_google",
            details=f"Linked Google ID {google_id} to user {target.username} (ID: {user_id}). Previous: {old_google_id or 'None'}"
        )
        
        invalidate_user(user_id)
        return {"ok": True, "message": "Google ID linked successfully"}


@router.post("/admin/owner/unlink-google")
async def owner_unlink_google(
    request: Request,
    owner: User = Depends(require_owner),
    db: AsyncSession = Depends(get_db)
):
    """Manually unlink Google from a user account."""
    body = await request.json()
    user_id = int(body.get("user_id"))
    
    target = await db.get(User, user_id)
    if not target:
        raise HTTPException(404, "User not found")
    
    if not target.google_id:
        raise HTTPException(400, "User has no Google account linked")
    
    old_google_id = target.google_id
    target.google_id = None
    await db.commit()
    
    await log_mod_action(
        user_id=owner.id,
        username=owner.username,
        action="unlink_google",
        details=f"Unlinked Google ID {old_google_id} from user {target.username} (ID: {user_id})"
    )
    
    invalidate_user(user_id)
    return {"ok": True, "message": "Google ID unlinked successfully"}


@router.post("/admin/owner/delete-user")
async def owner_delete_user(
    request: Request,
    owner: User = Depends(require_owner),
    db: AsyncSession = Depends(get_db)
):
    """
    Permanently delete a user account (owner-only).
    This removes:
    - User record from SQL (cascades to sessions, messages, bans, flair)
    - Pixel counts from all Redis leaderboards
    - Anonymizes pixel placement history (sets user_id to NULL)
    - All IP and session associations
    
    This action is irreversible.
    """
    from src.sql.models import PixelPlacement, IPUserPair, SessionUserPair, UserFlair, Session
    from src.redis_client.client import client as redis_client
    from src.redis_client.keys import RedisKeys
    from src.canvases import canvases
    from datetime import datetime, timezone
    from sqlalchemy import update
    
    body = await request.json()
    user_id = int(body.get("user_id"))
    
    target = await db.get(User, user_id)
    if not target:
        raise HTTPException(404, "User not found")
    
    # Prevent owner from deleting themselves
    if target.id == owner.id:
        raise HTTPException(400, "Cannot delete your own account via owner tools")
    
    # Prevent deleting other owners/admins
    if target.role >= Role.ADMIN or target.id in OWNER_IDS or target.id in ADMIN_IDS:
        raise HTTPException(403, "Cannot delete admin or owner accounts")
    
    target_username = target.username
    
    # 1. Remove user from all Redis leaderboards
    redis_keys = [
        RedisKeys.TOTAL_PIXELS.value,  # Global total
    ]
    
    # Add canvas-specific leaderboards
    for canvas_id in canvases.keys():
        redis_keys.append(RedisKeys.CANVAS_PIXELS.value.format(canvas_id=canvas_id))
    
    # Add daily leaderboards (current day only - old days will expire naturally)
    today = datetime.now(timezone.utc).date().isoformat()
    redis_keys.append(RedisKeys.DAILY_PIXELS.value.format(day=today))
    for canvas_id in canvases.keys():
        redis_keys.append(RedisKeys.DAILY_CANVAS_PIXELS.value.format(canvas_id=canvas_id, day=today))
    
    # Remove user from all leaderboard sets
    for key in redis_keys:
        await redis_client.zrem(key, user_id)
    
    # 2. Anonymize pixel placement history (preserve history but remove user association)
    await db.execute(
        update(PixelPlacement)
        .where(PixelPlacement.user_id == user_id)
        .values(user_id=None)
    )
    
    # 3. Delete IP and session associations
    await db.execute(
        IPUserPair.__table__.delete().where(IPUserPair.user_id == user_id)
    )
    await db.execute(
        SessionUserPair.__table__.delete().where(SessionUserPair.user_id == user_id)
    )
    
    # 4. Delete user flair
    await db.execute(
        UserFlair.__table__.delete().where(UserFlair.user_id == user_id)
    )
    
    # 5. Delete all sessions (logout everywhere)
    await db.execute(
        Session.__table__.delete().where(Session.user_id == user_id)
    )
    
    # 6. Delete the user record (CASCADE will handle: sessions, messages, bans)
    await db.delete(target)
    
    await db.commit()
    
    # 8. Disconnect any active WebSocket connections for this user
    try:
        if user_id in clients_by_user:
            for client in list(clients_by_user[user_id]):
                await client.socket.close(code=1000, reason="Account deleted by owner")
    except Exception as e:
        # Non-critical - just log and continue
        print(f"[owner_delete_user] Failed to close WebSocket connections: {e}")
    
    await log_mod_action(
        user_id=owner.id,
        username=owner.username,
        action="delete_user",
        details=f"Permanently deleted user {target_username} (ID: {user_id})"
    )
    
    invalidate_user(user_id)
    return {"ok": True, "message": f"User {target_username} (ID: {user_id}) permanently deleted"}


@router.get("/admin/live")
async def live_connections(mod: User = Depends(require_mod), db: AsyncSession = Depends(get_db)):
    """All currently connected users with tab/device counts."""
    from src.socket_server.server import clients_by_user
    is_admin = mod.role >= 200 or mod.id in ADMIN_IDS

    all_ips = set()
    for conns in clients_by_user.values():
        for c in conns:
            all_ips.add(c.ip)

    ip_hash_map = {}
    if all_ips and not is_admin:
        hashes = await db.execute(
            select(IPInfo.ip, IPInfo.cidr).where(IPInfo.ip.in_(list(all_ips)))
        )
        ip_hash_map = {r[0]: r[1] for r in hashes}

    result = []
    for uid, conns in clients_by_user.items():
        conns = list(conns)
        if not conns:
            continue
        first = conns[0]
        ips = list({c.ip for c in conns})
        result.append({
            "user_id":   uid,
            "username":  first.user.username  if first.user else "?",
            "avatar":    first.user.avatar    if first.user else "",
            "discord_id":first.user.discord_id if first.user else "",
            "role":      first.user.role.value if first.user else "user",
            "tabs":      len(conns),
            "ips":       [ip if is_admin else ip_hash_map.get(ip, "HIDDEN") for ip in ips],
            "devices":   len(ips),
            "canvas":    first.canvas,
            "is_proxy":  any(c.is_proxy for c in conns),
        })
    result.sort(key=lambda x: x["tabs"], reverse=True)
    return {"connections": result, "total": len(result)}


@router.get("/admin/ip/{ip}/users")
async def ip_lookup(ip: str, db: AsyncSession = Depends(get_db),
                    mod: User = Depends(require_mod)):
    """All users who have ever connected from this IP, CIDR, or Hash/iid."""
    is_admin = mod.role >= 200 or mod.id in ADMIN_IDS

    if "/" in ip:
        stmt = select(IPUserPair.user_id).join(IPInfo, IPInfo.ip == IPUserPair.ip).where(IPInfo.cidr == ip)
        display_ip = ip
    elif len(ip) >= 4 and all(c in "0123456789abcdefABCDEF-" for c in ip) and not all(c in "0123456789." for c in ip):
        search_term = ip[4:] if ip.startswith("iid_") else ip
        stmt = select(IPUserPair.user_id).join(IPInfo, IPInfo.ip == IPUserPair.ip).where(IPInfo.hash.like(f"{search_term}%"))
        display_ip = ip
    else:
        if not is_admin:
            raise HTTPException(403, "Moderators can only lookup by CIDR or Hash/iid.")
        stmt = select(IPUserPair.user_id).where(IPUserPair.ip == ip)
        display_ip = ip

    rows = await db.execute(stmt)
    user_ids = [r[0] for r in rows]
    users = []
    for uid in user_ids:
        u = await db.get(User, uid)
        if u:
            px = await get_pixel_count(user_id=uid)
            users.append({
                "id":            u.id,
                "username":      u.username,
                "avatar":        u.avatar,
                "discord_id":    u.discord_id,
                "role":          u.role.value,
                "banned":        u.banned,
                "pixels_placed": px or 0,
                "created_at":    u.created_at.isoformat(),
            })
    return {"ip": display_ip, "users": users}


@router.get("/admin/users/{user_id}/iids")
async def get_user_iids(user_id: int, db: AsyncSession = Depends(get_db),
                        admin: User = Depends(require_admin)):
    """All distinct IIDs (IPInfo.hash) ever used by this user."""
    rows = await db.execute(
        select(IPInfo.hash)
        .join(IPUserPair, IPUserPair.ip == IPInfo.ip)
        .where(IPUserPair.user_id == user_id)
        .distinct()
    )
    return {"iids": [r[0] for r in rows if r[0]]}


@router.get("/admin/iid/{iid}/users")
async def get_users_by_iid(iid: str, db: AsyncSession = Depends(get_db),
                          admin: User = Depends(require_admin)):
    """User IDs that have used this IID (full UUID or prefix)."""
    term = iid[4:] if iid.startswith("iid_") else iid
    if not term:
        raise HTTPException(400, "IID required")
    rows = await db.execute(
        select(IPUserPair.user_id)
        .join(IPInfo, IPInfo.ip == IPUserPair.ip)
        .where(IPInfo.hash.like(f"{term}%"))
        .distinct()
    )
    user_ids = sorted({r[0] for r in rows})
    users = []
    for uid in user_ids:
        u = await db.get(User, uid)
        if u:
            users.append({
                "id": u.id,
                "username": u.username,
                "role": u.role.value,
                "banned": u.banned,
            })
    return {"iid": iid, "user_ids": user_ids, "users": users}


@router.get("/admin/iid/{iid}/ip")
async def get_ip_by_iid(iid: str, db: AsyncSession = Depends(get_db),
                        admin: User = Depends(require_admin)):
    """Resolve IID (full UUID or prefix) to raw IP addresses."""
    term = iid[4:] if iid.startswith("iid_") else iid
    if not term:
        raise HTTPException(400, "IID required")
    rows = await db.execute(
        select(IPInfo.ip, IPInfo.hash, IPInfo.country_code, IPInfo.cidr)
        .where(IPInfo.hash.like(f"{term}%"))
    )
    return {
        "iid": iid,
        "ips": [
            {"ip": r[0], "iid": r[1], "country": r[2], "cidr": r[3]}
            for r in rows
        ],
    }


@router.post("/admin/history/snapshot")
async def force_history_snapshot(admin: User = Depends(require_admin)):
    # Write a request file the history worker can observe and act on.
    try:
        history_dir = os.environ.get("HISTORY_DIR", "/var/www/history")
        req = Path(history_dir) / ".take_snapshot"
        Path(history_dir).mkdir(parents=True, exist_ok=True)
        req.write_text(datetime.now(timezone.utc).isoformat())
    except Exception:
        pass
    return {"ok": True}


# ── WatchZone ─────────────────────────────────────────────────────────────────

def _clamp_watch_coords(x1, y1, x2, y2, canvas_id: int):
    """Normalise so x1<=x2, y1<=y2 and clamp to canvas bounds."""
    from src.canvases import canvases, CHUNK_PX
    c = canvases.get(canvas_id)
    total = (c.size * CHUNK_PX) if c else 65536
    x1, x2 = sorted([max(0, x1), min(total - 1, x2)])
    y1, y2 = sorted([max(0, y1), min(total - 1, y2)])
    return x1, y1, x2, y2


async def _watch_query(db: AsyncSession, canvas_id: int,
                       x1: int, y1: int, x2: int, y2: int,
                       since: datetime, limit: int = 2000):
    """Return placements + enriched user info for the given zone/window."""
    from src.sql.models import PixelPlacement, IPInfo
    stmt = (
        select(PixelPlacement, User, IPInfo)
        .outerjoin(User,    User.id    == PixelPlacement.user_id)
        .outerjoin(IPInfo,  IPInfo.ip  == PixelPlacement.ip)
        .where(and_(
            PixelPlacement.canvas_id == canvas_id,
            PixelPlacement.x >= x1, PixelPlacement.x <= x2,
            PixelPlacement.y >= y1, PixelPlacement.y <= y2,
            PixelPlacement.placed_at >= since,
        ))
        .order_by(PixelPlacement.placed_at.desc())
        .limit(limit)
    )
    rows = await db.execute(stmt)
    return rows.all()


def _placement_dict(pp, user, ip_info, online_ids: set, is_admin: bool):
    """Serialise one placement row to a JSON-safe dict."""
    return {
        "id":         pp.id,
        "user_id":    pp.user_id,
        "username":   user.username  if user else None,
        "avatar":     user.avatar    if user else None,
        "discord_id": user.discord_id if user else None,
        "role":       user.role.value if user else 0,
        "x":          pp.x,
        "y":          pp.y,
        "color":      pp.color,
        "placed_at":  pp.placed_at.isoformat(),
        "ip":         pp.ip if is_admin else (ip_info.cidr if ip_info else "HIDDEN"),
        "country":    ip_info.country_code if ip_info else None,
        "is_online":  (pp.user_id in online_ids) if pp.user_id else False,
    }


@router.get("/admin/watch")
async def watch_zone(
    canvas_id: int = 0,
    x1: int = 0, y1: int = 0, x2: int = 0, y2: int = 0,
    hours: float = 24,
    limit: int = 500000,
    db: AsyncSession = Depends(get_db),
    mod: User = Depends(require_mod),
):
    """Snapshot query: all placements in a bounding box within the last N hours."""
    limit = min(max(1, limit), 500000)
    hours = min(max(0.016, hours), 24 * 30)  # 1 min … 30 days
    x1, y1, x2, y2 = _clamp_watch_coords(x1, y1, x2, y2, canvas_id)

    MAX_AREA = 25_000_000  # 5000×5000 px
    if abs(x2 - x1) * abs(y2 - y1) > MAX_AREA:
        raise HTTPException(400, f"Selection too large (max {MAX_AREA:,} pixels). Reduce the bounding box.")

    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    rows  = await _watch_query(db, canvas_id, x1, y1, x2, y2, since, limit)

    try:
        online_ids = set(clients_by_user.keys())
    except Exception:
        online_ids = set()

    is_admin = mod.role >= 200 or mod.id in ADMIN_IDS
    placements = [_placement_dict(pp, u, ip, online_ids, is_admin) for pp, u, ip in rows]

    # Build summary
    from collections import Counter
    user_counter: Counter = Counter()
    for p in placements:
        if p["user_id"] is not None:
            user_counter[(p["user_id"], p["username"] or f"#{p['user_id']}")] += 1
    top_users = [
        {
            "user_id":  uid,
            "username": uname,
            "count":    cnt,
            "is_proxy": any(c.is_proxy for c in clients_by_user.get(uid, set())),
        }
        for (uid, uname), cnt in user_counter.most_common(10)
    ]

    return {
        "placements": placements,
        "summary": {
            "total":        len(placements),
            "unique_users": len(user_counter),
            "top_users":    top_users,
            "truncated":    len(placements) >= limit,
        },
        "zone": {"canvas_id": canvas_id, "x1": x1, "y1": y1, "x2": x2, "y2": y2, "hours": hours},
    }


# ── SSE live stream registry ──────────────────────────────────────────────────
# Maps stream_id → {"canvas_id", "x1","y1","x2","y2", queue: asyncio.Queue}
_watch_streams: dict[str, dict] = {}

def notify_watch_streams(canvas_id: int, x: int, y: int, user_id, ip: str, color: int,
                         username: str = None, avatar: str = None, discord_id: str = None, role = 0):
    """Called by the pixel placement path to push events to open SSE streams."""
    from src.sql.ip import get_cidr
    
    role_val = role.value if hasattr(role, "value") else role
    cidr_val = get_cidr(ip) if ip else "HIDDEN"
    
    admin_payload = json.dumps({
        "x": x, "y": y, "color": color,
        "user_id": user_id, "ip": ip,
        "placed_at": datetime.now(timezone.utc).isoformat(),
        "username": username,
        "avatar": avatar,
        "discord_id": discord_id,
        "role": role_val,
        "is_online": True,
    })
    
    mod_payload = json.dumps({
        "x": x, "y": y, "color": color,
        "user_id": user_id, "ip": cidr_val,
        "placed_at": datetime.now(timezone.utc).isoformat(),
        "username": username,
        "avatar": avatar,
        "discord_id": discord_id,
        "role": role_val,
        "is_online": True,
    })
    
    dead = []
    for sid, s in _watch_streams.items():
        if s["canvas_id"] != canvas_id:
            continue
        if s["x1"] <= x <= s["x2"] and s["y1"] <= y <= s["y2"]:
            try:
                active_payload = admin_payload if s.get("is_admin", False) else mod_payload
                s["queue"].put_nowait(active_payload)
            except asyncio.QueueFull:
                dead.append(sid)
    for sid in dead:
        _watch_streams.pop(sid, None)


@router.get("/admin/watch/stream")
async def watch_stream(
    canvas_id: int = 0,
    x1: int = 0, y1: int = 0, x2: int = 0, y2: int = 0,
    mod: User = Depends(require_mod),
):
    """SSE endpoint: pushes new placements in the zone as they happen."""
    import uuid
    x1, y1, x2, y2 = _clamp_watch_coords(x1, y1, x2, y2, canvas_id)
    sid   = str(uuid.uuid4())
    queue: asyncio.Queue = asyncio.Queue(maxsize=500)
    is_admin = mod.role >= 200 or mod.id in ADMIN_IDS
    _watch_streams[sid] = {
        "canvas_id": canvas_id,
        "x1": x1, "y1": y1, "x2": x2, "y2": y2,
        "queue": queue,
        "is_admin": is_admin,
    }

    async def event_generator():
        try:
            # Send initial heartbeat
            yield f"data: {{\"type\":\"connected\",\"sid\":\"{sid}\"}}\n\n"
            while True:
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=25)
                    yield f"data: {payload}\n\n"
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"  # SSE comment keeps connection alive
        except asyncio.CancelledError:
            pass
        finally:
            _watch_streams.pop(sid, None)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disable nginx buffering
        },
    )


from pydantic import BaseModel
from typing import Optional

class WatchActionRequest(BaseModel):
    canvas_id: int
    x1: int
    y1: int
    x2: int
    y2: int
    action: str  # "rollback", "replace_all", "replace_specific", "protect_area", "unprotect_area"
    timestamp: Optional[float] = None
    target_color: Optional[int] = None
    source_color: Optional[int] = None

@router.post("/admin/watch/action")
async def watch_action(
    req: WatchActionRequest,
    request: Request,
    mod: User = Depends(require_mod),
    db: AsyncSession = Depends(get_db),
):
    """Admin/mod action inside WatchZone."""
    canvas_id = req.canvas_id
    action = req.action
    allowed_actions = {"rollback", "replace_all", "replace_specific", "protect_area", "unprotect_area"}
    if action not in allowed_actions:
        raise HTTPException(400, "Invalid action")
    
    print(f"[admin] watch_action received: action={action}, canvas={canvas_id}, raw_coords=({req.x1},{req.y1})-({req.x2},{req.y2})")
    
    # 1. Clamp bounding box
    x1, y1, x2, y2 = _clamp_watch_coords(req.x1, req.y1, req.x2, req.y2, canvas_id)
    print(f"[admin] After clamping: ({x1},{y1})-({x2},{y2})")
    c = canvases.get(canvas_id)
    if not c:
        raise HTTPException(400, "Invalid canvas ID")

    # Validate coordinates are sane
    if x1 < 0 or y1 < 0 or x2 < 0 or y2 < 0:
        raise HTTPException(400, f"Invalid coordinates: ({x1},{y1})-({x2},{y2})")
    if x1 > x2 or y1 > y2:
        raise HTTPException(400, f"Invalid coordinate order: x1={x1} > x2={x2} or y1={y1} > y2={y2}")

    # 2. Calculate area size
    area_width = x2 - x1 + 1
    area_height = y2 - y1 + 1
    total_pixels = area_width * area_height
    
    # 3. Check if area is too large for synchronous processing
    # Cloudflare has a 100-second timeout, so we need to handle large areas differently
    MAX_SYNC_PIXELS = 1_000_000  # ~1000x1000 area (roughly 10-20 seconds)

    # ── Area rollback uses src.tools.rollback (history paste + REFRESH_CHUNKS) ──
    if action == "rollback":
        if req.timestamp is None:
            raise HTTPException(400, "Timestamp required for rollback")
        ts = int(req.timestamp)
        from src.tools.rollback import rollback as area_rollback

        if total_pixels > MAX_SYNC_PIXELS:
            from src.auth import OWNER_IDS
            if mod.id not in OWNER_IDS:
                raise HTTPException(
                    403,
                    f"Area too large ({total_pixels:,} pixels). Only owners can rollback areas larger than {MAX_SYNC_PIXELS:,} pixels."
                )

            async def _bg():
                try:
                    print(f"[admin] Starting area rollback: canvas={canvas_id}, area=({x1},{y1})-({x2},{y2}), ts={ts}, mod={mod.username}")
                    await area_rollback(c, (x1, y1), (x2, y2), ts)
                    await log_mod_action(
                        user_id=mod.id,
                        username=mod.username,
                        action="watch_rollback",
                        details=(
                            f"Performed watch action 'rollback' on canvas {canvas_id} "
                            f"in bounding box ({x1}, {y1}) to ({x2}, {y2}). (timestamp: {ts}, async)"
                        ),
                        canvas_id=canvas_id,
                        x1=x1, y1=y1, x2=x2, y2=y2,
                    )
                    print(f"[admin] Area rollback completed: canvas={canvas_id}")
                except Exception as e:
                    print(f"[admin] Area rollback failed: {e}")
                    import traceback
                    traceback.print_exc()

            asyncio.create_task(_bg())
            return {
                "ok": True,
                "async": True,
                "message": f"Large rollback ({total_pixels:,} pixels) queued for background processing.",
            }

        try:
            await area_rollback(c, (x1, y1), (x2, y2), ts)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e

        await log_mod_action(
            user_id=mod.id,
            username=mod.username,
            action="watch_rollback",
            details=(
                f"Performed watch action 'rollback' on canvas {canvas_id} "
                f"in bounding box ({x1}, {y1}) to ({x2}, {y2}). (timestamp: {ts})"
            ),
            canvas_id=canvas_id,
            x1=x1, y1=y1, x2=x2, y2=y2,
            request=request,
        )
        return {"ok": True}

    if total_pixels > MAX_SYNC_PIXELS:
        # Only owners can do large non-rollback area actions
        from src.auth import OWNER_IDS
        if mod.id not in OWNER_IDS:
            raise HTTPException(
                403, 
                f"Area too large ({total_pixels:,} pixels). Only owners can act on areas larger than {MAX_SYNC_PIXELS:,} pixels."
            )
        # For non-rollback actions on large areas, still allow synchronous (they're usually faster)
        # but only for owners
    
    # Continue with synchronous processing for normal-sized areas
    return await _watch_action_sync(req, mod, request.client.host, db, canvas_id, x1, y1, x2, y2, request=request)


async def _watch_action_async(
    req: WatchActionRequest,
    mod_id: int,
    mod_username: str,
    client_ip: str,
    canvas_id: int,
    x1: int, y1: int, x2: int, y2: int
):
    """
    Asynchronous watch action for large areas.
    Processes in batches to avoid timeouts and memory issues.
    """
    print(f"[admin] Starting async rollback: canvas={canvas_id}, area=({x1},{y1})-({x2},{y2}), mod={mod_username}")
    
    try:
        from src.sql.db import AsyncSessionLocal
        
        # Calculate batch size based on area
        area_width = x2 - x1 + 1
        area_height = y2 - y1 + 1
        total_pixels = area_width * area_height
        
        # Process in batches of ~10M pixels each to avoid memory issues
        BATCH_PIXELS = 10_000_000
        CHUNK_SIZE = 256  # CHUNK_PX
        
        # Calculate how many chunks wide/tall
        chunks_wide = (area_width + CHUNK_SIZE - 1) // CHUNK_SIZE
        chunks_tall = (area_height + CHUNK_SIZE - 1) // CHUNK_SIZE
        total_chunks = chunks_wide * chunks_tall
        
        # Process in horizontal strips
        pixels_per_strip = area_width * CHUNK_SIZE
        strips_per_batch = max(1, BATCH_PIXELS // pixels_per_strip)
        
        print(f"[admin] Processing {total_chunks} chunks in batches (strips of {strips_per_batch} rows)")
        
        total_changed = 0
        batch_num = 0
        
        # Process in strips
        for strip_start_y in range(y1, y2 + 1, strips_per_batch * CHUNK_SIZE):
            strip_end_y = min(y2, strip_start_y + strips_per_batch * CHUNK_SIZE - 1)
            batch_num += 1
            
            print(f"[admin] Batch {batch_num}: Processing rows {strip_start_y}-{strip_end_y}")
            
            async with AsyncSessionLocal() as db:
                # Create a minimal User object for logging
                from src.sql.models import User
                mod = User(id=mod_id, username=mod_username)
                
                # Create a sub-request for this batch
                batch_req = WatchActionRequest(
                    canvas_id=canvas_id,
                    x1=x1,
                    y1=strip_start_y,
                    x2=x2,
                    y2=strip_end_y,
                    action=req.action,
                    timestamp=req.timestamp,
                    target_color=req.target_color,
                    source_color=req.source_color
                )
                
                result = await _watch_action_sync(batch_req, mod, client_ip, db, canvas_id, x1, strip_start_y, x2, strip_end_y)
                batch_changed = result.get('count', 0)
                total_changed += batch_changed
                
                print(f"[admin] Batch {batch_num} complete: {batch_changed} pixels changed (total: {total_changed})")
                
                # Small delay between batches to avoid overwhelming Redis
                await asyncio.sleep(0.5)
        
        print(f"[admin] Async rollback completed: {total_changed} pixels changed across {batch_num} batches")
    except Exception as e:
        print(f"[admin] Async rollback failed: {e}")
        import traceback
        traceback.print_exc()


async def _watch_action_sync(
    req: WatchActionRequest,
    mod: User,
    client_ip: str,
    db: AsyncSession,
    canvas_id: int,
    x1: int, y1: int, x2: int, y2: int,
    request: Request | None = None,
) -> dict:
    """Synchronous watch action execution (original implementation)."""
    action = req.action
    c = canvases.get(canvas_id)
    
    print(f"[admin] watch_action_sync: action={action}, canvas={canvas_id}, area=({x1},{y1})-({x2},{y2}), mod={mod.username}")
    
    # Extract ranges and coordinates
    cx_min = x1 // CHUNK_PX
    cx_max = x2 // CHUNK_PX
    cy_min = y1 // CHUNK_PX
    cy_max = y2 // CHUNK_PX

    total_changed = 0
    # Use _best_chunk to retrieve raw snapshot bytes for rollback.
    # _best_chunk returns the raw bytes of the snapshot or None if unavailable.
    from src.history import _best_chunk
    from src.tiles import generate_tiles_for_chunks
    from src.sql.pixel_log import log_pixels
    import numpy as np

    # Validate action-specific params upfront
    if action == "rollback" and req.timestamp is None:
        raise HTTPException(400, "Timestamp required for rollback")
    if action == "replace_all" and req.target_color is None:
        raise HTTPException(400, "Target color required for replace_all")
    if action == "replace_specific" and (req.source_color is None or req.target_color is None):
        raise HTTPException(400, "Source and target colors required for replace_specific")

    CHUNK_SIZE = CHUNK_PX * CHUNK_PX  # 65 536

    # Mock client wrapper for log_pixels
    class MockClient:
        def __init__(self, user, ip, canvas):
            self.user = user
            self.ip = ip
            self.canvas = canvas

    mock_client = MockClient(mod, client_ip, canvas_id)

    # ── Build the list of (cx, cy) chunks we need to touch ──────────────────
    chunk_coords = [
        (cx, cy)
        for cx in range(cx_min, cx_max + 1)
        for cy in range(cy_min, cy_max + 1)
    ]

    # ── Fetch all live chunk data in ONE pipeline round-trip ─────────────────
    pipe = redis_client.pipeline(transaction=False)
    for cx, cy in chunk_coords:
        pipe.get(RedisKeys.CHUNK.value.format(canvas_id=canvas_id, cx=cx, cy=cy))
    live_blobs = await pipe.execute()

    # ── For rollback: fetch snapshot bytes (blocking disk I/O, but fast) ────
    snap_map: dict[tuple, bytes | None] = {}
    if action == "rollback":
        ts = int(req.timestamp)
        print(f"[admin] Fetching snapshots for timestamp {ts}")
        loop = asyncio.get_running_loop()
        from concurrent.futures import ThreadPoolExecutor
        # Run all disk reads concurrently in thread pool
        with ThreadPoolExecutor(max_workers=min(32, len(chunk_coords) + 1)) as pool:
            futs = {
                (cx, cy): loop.run_in_executor(pool, _best_chunk, canvas_id, cx, cy, ts)
                for cx, cy in chunk_coords
            }
            for (cx, cy), fut in futs.items():
                snap_map[(cx, cy)] = await fut
        
        found_snaps = sum(1 for v in snap_map.values() if v is not None)
        print(f"[admin] Found {found_snaps}/{len(chunk_coords)} snapshots")
        
        if found_snaps == 0:
            print(f"[admin] WARNING: No snapshots found for timestamp {ts}. Rollback will have no effect.")
            # Return early instead of processing
            return {"ok": True, "count": 0, "warning": "No snapshots found for the selected time"}

    # ── Process each chunk with numpy (vectorized, no Python pixel loops) ────
    total_changed = 0
    changed_chunks: list[tuple[int, int]] = []

    # Build write pipeline
    write_pipe = redis_client.pipeline(transaction=False)
    writes_pending: list[tuple[int, int, bytes, list]] = []  # (cx, cy, new_bytes, changed_pixels)

    for (cx, cy), live_blob in zip(chunk_coords, live_blobs):
        # Decode live bytes → numpy array (clamped to CHUNK_SIZE to handle oversized Redis strings)
        if live_blob and len(live_blob) >= CHUNK_SIZE:
            live = np.frombuffer(live_blob, dtype=np.uint8)[:CHUNK_SIZE].copy()
        else:
            live = np.zeros(CHUNK_SIZE, dtype=np.uint8)

        # Compute mask of which offsets are within our bounding box inside this chunk
        chk_x_min = max(x1, cx * CHUNK_PX) - cx * CHUNK_PX
        chk_x_max = min(x2, (cx + 1) * CHUNK_PX - 1) - cx * CHUNK_PX
        chk_y_min = max(y1, cy * CHUNK_PX) - cy * CHUNK_PX
        chk_y_max = min(y2, (cy + 1) * CHUNK_PX - 1) - cy * CHUNK_PX

        # Create 2D boolean mask for the bounding box region
        mask2d = np.zeros((CHUNK_PX, CHUNK_PX), dtype=bool)
        mask2d[chk_y_min:chk_y_max + 1, chk_x_min:chk_x_max + 1] = True
        mask = mask2d.ravel()   # flat offset mask

        new_live = live.copy()

        if action == "rollback":
            snap_raw = snap_map.get((cx, cy))
            if snap_raw is None or len(snap_raw) < CHUNK_SIZE:
                continue
            snap = np.frombuffer(snap_raw, dtype=np.uint8)
            diff_mask = mask & (live != snap)
            if not diff_mask.any():
                continue
            new_live[diff_mask] = snap[diff_mask]

        elif action == "replace_all":
            target = np.uint8(req.target_color)
            diff_mask = mask & (live != target)
            if not diff_mask.any():
                continue
            new_live[diff_mask] = target

        elif action == "replace_specific":
            src = np.uint8(req.source_color)
            tgt = np.uint8(req.target_color)
            diff_mask = mask & (live == src)
            if not diff_mask.any():
                continue
            new_live[diff_mask] = tgt

        elif action == "protect_area":
            diff_mask = mask & ((live & 0x80) == 0)
            if not diff_mask.any():
                continue
            new_live[diff_mask] = live[diff_mask] | np.uint8(0x80)

        elif action == "unprotect_area":
            diff_mask = mask & ((live & 0x80) != 0)
            if not diff_mask.any():
                continue
            new_live[diff_mask] = live[diff_mask] & np.uint8(0x7F)

        changed_offsets = np.where(diff_mask)[0]
        changed_pixels = [Pixel(cx, cy, int(off), int(new_live[off])) for off in changed_offsets]
        n = len(changed_pixels)
        if n == 0:
            continue

        chunk_key = RedisKeys.CHUNK.value.format(canvas_id=canvas_id, cx=cx, cy=cy)
        write_pipe.set(chunk_key, new_live.tobytes())
        writes_pending.append((cx, cy, new_live.tobytes(), changed_pixels))
        total_changed += n

    # ── Flush all Redis writes in one pipeline ───────────────────────────────
    if writes_pending:
        await write_pipe.execute()

        # Broadcast to WS subscribers and log to DB per chunk
        for cx, cy, _, changed_pixels in writes_pending:
            await queue_pixels(canvas_id, cx, cy, changed_pixels)
            log_pixels(mock_client, changed_pixels)
            changed_chunks.append((cx, cy))

        # Schedule tile regeneration (non-async function, call directly)
        # Only regenerate tiles for chunks that actually changed
        if changed_chunks:
            generate_tiles_for_chunks(canvas_id, changed_chunks)

    details = f"Performed watch action '{action}' on canvas {canvas_id} in bounding box ({x1}, {y1}) to ({x2}, {y2}). Modified {total_changed} pixels."
    if action == "replace_all":
        details += f" (target_color: {req.target_color})"
    elif action == "replace_specific":
        details += f" (source_color: {req.source_color} -> target_color: {req.target_color})"
    elif action == "rollback":
        details += f" (timestamp: {req.timestamp})"
    await log_mod_action(
        user_id=mod.id,
        username=mod.username,
        action=f"watch_{action}",
        details=details,
        canvas_id=canvas_id,
        x1=x1, y1=y1, x2=x2, y2=y2,
        request=request,
    )

    print(f"[admin] watch_action_sync completed: {total_changed} pixels changed")
    return {"ok": True, "count": total_changed}


# ── Void Event admin routes ────────────────────────────────────────────────────

@router.get("/admin/void/state")
async def void_get_state(mod: User = Depends(require_mod)):
    """Return current void event state + config."""
    from src.void_event import get_void
    v = get_void()
    return {
        "state":  v.get_state_dict(),
        "config": v.cfg,
    }


@router.patch("/admin/void/config")
async def void_set_config(request: Request, admin: User = Depends(require_admin)):
    """Update void event configuration."""
    from src.void_event import get_void
    body = await request.json()
    v = get_void()
    await v.admin_set_config(body)
    await log_mod_action(
        user_id=admin.id,
        username=admin.username,
        action="void_set_config",
        details=f"Updated void config: {json.dumps(body)}"
    )
    return {"ok": True, "config": v.cfg}


@router.post("/admin/void/control")
async def void_control(request: Request, admin: User = Depends(require_admin)):
    """Control the void event: start, stop, pause, resume, reset_cooldown, set_cooldown, set_hp."""
    from src.void_event import get_void
    body = await request.json()
    action = str(body.get("action", ""))
    value  = body.get("value")
    v = get_void()
    result = await v.admin_control(action, value)
    if result.get("ok"):
        await log_mod_action(
            user_id=admin.id,
            username=admin.username,
            action="void_control",
            details=f"Admin void control: action='{action}'" + (f" value={value}" if value is not None else "")
        )
    return result


@router.post("/admin/users/mass-ban")
async def mass_ban_users(
    request: Request,
    db: AsyncSession = Depends(get_db),
    mod: User = Depends(require_mod),
):
    """Mass ban users from a list of IDs."""
    body = await request.json()
    raw_ids = body.get("user_ids", [])
    if isinstance(raw_ids, str):
        import re
        parsed_ids = [int(x) for x in re.findall(r"\d+", raw_ids)]
    elif isinstance(raw_ids, list):
        parsed_ids = []
        for x in raw_ids:
            try:
                parsed_ids.append(int(x))
            except (ValueError, TypeError):
                pass
    else:
        parsed_ids = []

    if not parsed_ids:
        raise HTTPException(400, "No valid user IDs provided")

    reason = str(body.get("reason", "Mass banned by staff")).strip() or "Mass banned by staff"
    duration = 0
    try:
        duration = int(body.get("duration", 0) or 0)
    except (ValueError, TypeError):
        pass

    expires_at = None
    if duration > 0:
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=duration)

    ban_alts = bool(body.get("ban_alts", False))
    banned_ids = []
    failed_ids = []

    for uid in set(parsed_ids):
        user = await db.get(User, uid)
        if not user:
            failed_ids.append(uid)
            continue
        # Protect owners and admins from non-owners
        if user.role >= 200 and mod.role < 254:
            failed_ids.append(uid)
            continue
        try:
            await ban_user(
                session=db,
                user_id=uid,
                mod_id=mod.id,
                reason=reason,
                expires_at=expires_at,
                ban_alts=ban_alts,
            )
            invalidate_user(uid)
            banned_ids.append(uid)
        except Exception as e:
            print(f"[Admin] Failed to ban user {uid}: {e}")
            failed_ids.append(uid)

    await db.commit()

    if banned_ids:
        await log_mod_action(
            user_id=mod.id,
            username=mod.username,
            action="mass_ban",
            details=f"Mass banned {len(banned_ids)} users: {banned_ids}. Reason: {reason}. Duration: {duration or 'Permanent'}. Ban alts: {ban_alts}."
        )

    return {"ok": True, "banned": banned_ids, "failed": failed_ids}


@router.post("/admin/rollback/pixels")
async def rollback_user_pixels(
    request: Request,
    db: AsyncSession = Depends(get_db),
    mod: User = Depends(require_mod),
):
    """
    Rollback the last N pixels placed by a target user ID or IP (e.g. if player used proxy).
    """
    body = await request.json()
    canvas_id = int(body.get("canvas_id", 0))
    count = int(body.get("count", 0))
    if count <= 0:
        raise HTTPException(400, "Count must be greater than 0")
    count = min(count, 50000)

    user_id = body.get("user_id")
    if user_id is not None:
        try:
            user_id = int(user_id)
        except (ValueError, TypeError):
            user_id = None

    ip = body.get("ip")
    if ip is not None:
        ip = str(ip).strip()
        if not ip:
            ip = None

    if user_id is None and not ip:
        raise HTTPException(400, "Either user_id or ip must be provided")

    query = select(PixelPlacement).where(PixelPlacement.canvas_id == canvas_id)
    if user_id is not None:
        query = query.where(PixelPlacement.user_id == user_id)
    elif ip:
        if "/" in ip:
            from src.sql.models import IPInfo
            subquery = select(IPInfo.ip).where(IPInfo.cidr == ip)
            query = query.where(PixelPlacement.ip.in_(subquery))
        else:
            query = query.where(PixelPlacement.ip == ip)

    query = query.order_by(PixelPlacement.id.desc()).limit(count)
    res = await db.execute(query)
    placements = res.scalars().all()

    if not placements:
        return {"ok": True, "count": 0, "message": "No matching pixel placements found"}

    from sqlalchemy import tuple_

    coord_earliest_id = {}
    for p in placements:
        coord = (p.x, p.y)
        if coord not in coord_earliest_id or p.id < coord_earliest_id[coord]:
            coord_earliest_id[coord] = p.id

    coords = list(coord_earliest_id.keys())
    prior_colors = {}

    # Query prior placements in efficient batches of 200
    for i in range(0, len(coords), 200):
        batch_coords = coords[i:i + 200]
        max_earliest = max(coord_earliest_id[c] for c in batch_coords)
        prior_res = await db.execute(
            select(PixelPlacement.x, PixelPlacement.y, PixelPlacement.color, PixelPlacement.id)
            .where(
                PixelPlacement.canvas_id == canvas_id,
                tuple_(PixelPlacement.x, PixelPlacement.y).in_(batch_coords),
                PixelPlacement.id < max_earliest,
            )
            .order_by(PixelPlacement.id.asc())
        )
        for px, py, pcol, pid in prior_res.all():
            if pid < coord_earliest_id.get((px, py), 0):
                prior_colors[(px, py)] = pcol

    from src.sql.pixel_log import log_pixels
    from src.tiles import generate_tiles_for_chunks

    by_chunk = {}
    for (x, y) in coords:
        color = prior_colors.get((x, y), 0)
        cx = x // 256
        cy = y // 256
        offset = (y % 256) * 256 + (x % 256)
        by_chunk.setdefault((cx, cy), []).append((offset, color))

    pipe = redis_client.pipeline()
    chunk_coords = list(by_chunk.keys())
    for cx, cy in chunk_coords:
        key = RedisKeys.CHUNK.value.format(canvas_id=canvas_id, cx=cx, cy=cy)
        pipe.get(key)
    raw_chunks = await pipe.execute()

    write_pipe = redis_client.pipeline()
    writes_pending = []
    total_reverted = 0
    changed_chunks = []

    for i, (cx, cy) in enumerate(chunk_coords):
        raw = raw_chunks[i]
        if raw:
            live = bytearray(raw)
            if len(live) < 65536:
                live.extend(b"\x00" * (65536 - len(live)))
        else:
            live = bytearray(65536)

        changed_in_chunk = []
        for offset, color in by_chunk[(cx, cy)]:
            current = live[offset] & 0x7F
            new_color = color & 0x7F
            if current != new_color:
                live[offset] = (live[offset] & 0x80) | new_color
                changed_in_chunk.append(Pixel(cx, cy, offset, new_color))

        if changed_in_chunk:
            chunk_key = RedisKeys.CHUNK.value.format(canvas_id=canvas_id, cx=cx, cy=cy)
            write_pipe.set(chunk_key, bytes(live))
            writes_pending.append((cx, cy, changed_in_chunk))
            total_reverted += len(changed_in_chunk)
            changed_chunks.append((cx, cy))

    if writes_pending:
        await write_pipe.execute()

        placer_ip = placements[0].ip if (placements and placements[0].ip) else "127.0.0.1"
        class MockClient:
            user = mod
            ip = placer_ip
            canvas = canvas_id

        mock_client = MockClient()
        for cx, cy, changed_pixels in writes_pending:
            await queue_pixels(canvas_id, cx, cy, changed_pixels)
            log_pixels(mock_client, changed_pixels)

        if changed_chunks:
            try:
                generate_tiles_for_chunks(canvas_id, changed_chunks)
            except Exception as e:
                print(f"[Admin] Error generating tiles after rollback: {e}")

    px_coords_x = [p.x for p in placements] if placements else []
    px_coords_y = [p.y for p in placements] if placements else []
    x1 = min(px_coords_x) if px_coords_x else None
    y1 = min(px_coords_y) if px_coords_y else None
    x2 = max(px_coords_x) if px_coords_x else None
    y2 = max(px_coords_y) if px_coords_y else None

    target_str = f"User #{user_id}" if user_id is not None else f"IP {ip}"
    await log_mod_action(
        user_id=mod.id,
        username=mod.username,
        action="rollback_pixels_count",
        details=f"Rolled back {total_reverted} pixels for {target_str} on canvas {canvas_id} (requested {count}).",
        canvas_id=canvas_id,
        x1=x1, y1=y1, x2=x2, y2=y2,
        request=request,
    )

    return {"ok": True, "count": total_reverted, "target": target_str}


@router.get("/admin/logs")
async def get_mod_logs(q: str | None = None, limit: int = 1000, admin: User = Depends(require_admin)):
    """Retrieve mod/admin action logs (admin-only) with search support across all fields."""
    raw_logs = await redis_client.lrange("mod_logs", 0, -1)
    logs = []
    q_clean = q.strip().lower() if q else None
    for raw in raw_logs:
        try:
            entry = json.loads(raw)
            if q_clean:
                search_str = f"{entry.get('user_id', '')} {entry.get('username', '')} {entry.get('action', '')} {entry.get('details', '')} {datetime.fromtimestamp(entry.get('timestamp', 0), tz=timezone.utc).isoformat()}".lower()
                if q_clean not in search_str:
                    continue
            logs.append(entry)
            if len(logs) >= limit:
                break
        except Exception:
            pass
    return {"logs": logs}



@router.get("/admin/chat/config")
async def get_chat_config(admin: User = Depends(require_admin)):
    from src.socket_server.chat.chat import get_chat_min_pixels
    return {"min_pixels": await get_chat_min_pixels()}


@router.patch("/admin/chat/config")
async def set_chat_config(request: Request, admin: User = Depends(require_admin)):
    from src.socket_server.chat.chat import set_chat_min_pixels
    body = await request.json()
    if "min_pixels" not in body:
        raise HTTPException(400, "min_pixels is required")
    try:
        min_pixels = int(body["min_pixels"])
    except (TypeError, ValueError):
        raise HTTPException(400, "min_pixels must be an integer")
    if min_pixels < 0:
        raise HTTPException(400, "min_pixels cannot be negative")

    value = await set_chat_min_pixels(min_pixels)
    await log_mod_action(
        user_id=admin.id,
        username=admin.username,
        action="chat_set_config",
        details=f"Set chat min_pixels to {value}",
    )
    return {"ok": True, "min_pixels": value}
