"""
Flair / cosmetics API routes.

Public:
  GET  /flair/{user_id}            – full flair object for a user
  GET  /icons                      – list all custom icons (id, name, image_b64)

Logged-in users:
  PATCH /users/me/flair            – update own flair (server validates tier)

Mod+:
  POST  /admin/icons               – upload a new 16×16 custom icon

Admin+:
  DELETE /admin/icons/{id}         – remove an icon
  PATCH  /admin/users/{id}/flair   – force-assign icon + grant cosmetic tier
"""
import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from src.sql.db import get_db
from src.sql.models import User
from src.sql.flair import (
    get_flair, upsert_flair,
    get_all_icons, get_icon, create_icon, delete_icon,
)
from src.auth import require_mod, require_admin, require_session
from src.redis_client.client import client as redis
from src.redis_client.leaderboards import get_pixel_count
from src.mod_log import log_mod_action

router = APIRouter()

# ── Tier thresholds ───────────────────────────────────────────────────────────

EARTH_CANVAS_ID = 0
TIER_MILESTONES = [10_000, 100_000, 1_000_000]   # → tier 1, 2, 3
FLAIR_CACHE_TTL = 3600                            # 1 h

# Which minimum tier each username-style preset requires
USERNAME_STYLE_TIERS: dict[str, int] = {
    "gold":    2,
    "fire":    2,
    "ice":     2,
    "rainbow": 3,
    "void":    3,
}

MSG_STYLE_TIERS: dict[str, int] = {
    "glow":      2,
    "highlight": 2,
    "minimal":   2,
}

# ── Internal helpers ──────────────────────────────────────────────────────────

def _tier_from_pixels(px: int) -> int:
    if px >= TIER_MILESTONES[2]: return 3
    if px >= TIER_MILESTONES[1]: return 2
    if px >= TIER_MILESTONES[0]: return 1
    return 0


async def _resolve_tier(user_id: int, db: AsyncSession) -> tuple[int, int, int]:
    """Returns (effective_tier, pixel_count, granted_tier)."""
    px    = await get_pixel_count(user_id=user_id) #, canvas_id=EARTH_CANVAS_ID)
    flair = await get_flair(db, user_id)
    granted = flair.granted_tier if flair else 0
    return max(_tier_from_pixels(px), granted), px, granted


def _compact_flair(flair: Optional[object], tier: int) -> dict:
    """Tiny dict embedded in every chat packet — single-letter keys save bandwidth."""
    return {
        "t":  tier,
        "ic": flair.custom_icon_id if flair else None,
        "us": flair.username_style  if flair else None,
        "ms": flair.msg_style       if flair else None,
    }


async def get_compact_flair_cached(user_id: int, db: AsyncSession) -> dict:
    """Compact flair dict with 1-hour Redis cache (invalidated on flair update)."""
    cache_key = f"flair:{user_id}"
    cached = await redis.get(cache_key)
    if cached:
        return json.loads(cached)
    flair   = await get_flair(db, user_id)
    px      = await get_pixel_count(user_id=user_id) #, canvas_id=EARTH_CANVAS_ID)
    granted = flair.granted_tier if flair else 0
    tier    = max(_tier_from_pixels(px), granted)
    data    = _compact_flair(flair, tier)
    await redis.setex(cache_key, FLAIR_CACHE_TTL, json.dumps(data))
    return data


async def invalidate_flair_cache(user_id: int):
    await redis.delete(f"flair:{user_id}")


# ── Public routes ─────────────────────────────────────────────────────────────

@router.get("/flair/{user_id}")
async def get_user_flair(user_id: int, db: AsyncSession = Depends(get_db)):
    flair          = await get_flair(db, user_id)
    tier, px, granted = await _resolve_tier(user_id, db)

    icon_obj = None
    if flair and flair.custom_icon_id:
        icon = await get_icon(db, flair.custom_icon_id)
        if icon:
            icon_obj = {"id": icon.id, "name": icon.name, "image_b64": icon.image_b64}

    return {
        "effective_tier":   tier,
        "granted_tier":     granted,
        "pixels_placed":    px,
        "milestones":       TIER_MILESTONES,
        "custom_icon":      icon_obj,
        "profile_pic_b64":  flair.profile_pic_b64  if flair else None,
        "banner_color":     flair.banner_color      if flair else None,
        "username_style":   flair.username_style    if flair else None,
        "msg_style":        flair.msg_style         if flair else None,
    }


@router.get("/icons")
async def list_icons(db: AsyncSession = Depends(get_db)):
    icons = await get_all_icons(db)
    return {"icons": [
        {"id": i.id, "name": i.name, "image_b64": i.image_b64}
        for i in icons
    ]}


# ── Self-management ───────────────────────────────────────────────────────────

@router.patch("/users/me/flair")
async def update_own_flair(
    request: Request,
    db:      AsyncSession = Depends(get_db),
    me:      User         = Depends(require_session),
):
    body = await request.json()
    tier, _, _ = await _resolve_tier(me.id, db)
    updates: dict = {}

    # profile_pic_b64 — tier 1+
    if "profile_pic_b64" in body:
        if tier < 1 and body["profile_pic_b64"] is not None:
            raise HTTPException(403, "Requires 10k pixels (Tier 1)")
        pic = body["profile_pic_b64"]
        if pic and len(pic) > 300_000:          # ~225 KB raw ≈ 300k base64
            raise HTTPException(400, "Image too large (max ~225 KB)")
        updates["profile_pic_b64"] = pic

    # banner_color — tier 2+
    if "banner_color" in body:
        color = body["banner_color"]
        if color is not None:
            if tier < 2:
                raise HTTPException(403, "Requires 100k pixels (Tier 2)")
            if not (color.startswith("#") and len(color) in (4, 7)):
                raise HTTPException(400, "Invalid colour — use #rgb or #rrggbb")
        updates["banner_color"] = color

    # username_style — tier 2/3 depending on preset
    if "username_style" in body:
        style = body["username_style"]
        if style is not None:
            req = USERNAME_STYLE_TIERS.get(style)
            if req is None:
                raise HTTPException(400, f"Unknown style '{style}'")
            if tier < req:
                raise HTTPException(403, f"Style '{style}' requires Tier {req}")
        updates["username_style"] = style

    # msg_style — tier 2+
    if "msg_style" in body:
        style = body["msg_style"]
        if style is not None:
            req = MSG_STYLE_TIERS.get(style)
            if req is None:
                raise HTTPException(400, f"Unknown message style '{style}'")
            if tier < req:
                raise HTTPException(403, f"Message style requires Tier {req}")
        updates["msg_style"] = style

    if updates:
        await upsert_flair(db, me.id, **updates)
        await invalidate_flair_cache(me.id)

    return {"ok": True, "tier": tier}


# ── Mod+ routes ───────────────────────────────────────────────────────────────

@router.post("/admin/icons")
async def upload_icon(
    request: Request,
    db:      AsyncSession = Depends(get_db),
    mod:     User         = Depends(require_mod),
):
    body = await request.json()
    name      = str(body.get("name", "")).strip()[:64]
    image_b64 = str(body.get("image_b64", ""))
    if not name or not image_b64:
        raise HTTPException(400, "name and image_b64 required")
    if len(image_b64) > 20_000:
        raise HTTPException(400, "Icon data too large — must be a 16×16 PNG")
    icon = await create_icon(db, name, image_b64, mod.id)
    await log_mod_action(
        user_id=mod.id,
        username=mod.username,
        action="upload_icon",
        details=f"Uploaded custom icon '{name}' (ID: {icon.id})"
    )
    return {"id": icon.id, "name": icon.name, "image_b64": icon.image_b64}


# ── Admin+ routes ─────────────────────────────────────────────────────────────

@router.delete("/admin/icons/{icon_id}")
async def remove_icon(
    icon_id: int,
    db:      AsyncSession = Depends(get_db),
    admin:   User         = Depends(require_admin),
):
    ok = await delete_icon(db, icon_id)
    if not ok:
        raise HTTPException(404, "Icon not found")
    await log_mod_action(
        user_id=admin.id,
        username=admin.username,
        action="delete_icon",
        details=f"Deleted custom icon ID: {icon_id}"
    )
    return {"ok": True}


@router.patch("/admin/users/{user_id}/flair")
async def admin_set_flair(
    user_id: int,
    request: Request,
    db:      AsyncSession = Depends(get_db),
    admin:   User         = Depends(require_admin),
):
    target = await db.get(User, user_id)
    if not target:
        raise HTTPException(404, "User not found")

    body    = await request.json()
    updates = {}

    if "granted_tier" in body:
        t = int(body["granted_tier"])
        if t not in (0, 1, 2, 3):
            raise HTTPException(400, "granted_tier must be 0–3")
        updates["granted_tier"] = t

    if "custom_icon_id" in body:
        icon_id = body["custom_icon_id"]
        if icon_id is not None:
            if not await get_icon(db, int(icon_id)):
                raise HTTPException(404, "Icon not found")
        updates["custom_icon_id"] = icon_id

    if "username_style" in body:
        style = body["username_style"]
        if style and style not in USERNAME_STYLE_TIERS:
            raise HTTPException(400, f"Unknown style '{style}'")
        updates["username_style"] = style

    if "msg_style" in body:
        style = body["msg_style"]
        if style and style not in MSG_STYLE_TIERS:
            raise HTTPException(400, f"Unknown message style '{style}'")
        updates["msg_style"] = style

    if updates:
        await upsert_flair(db, user_id, **updates)
        await invalidate_flair_cache(user_id)
        await log_mod_action(
            user_id=admin.id,
            username=admin.username,
            action="set_user_flair",
            details=f"Set flair for user {target.username} (ID: {user_id}): {json.dumps(updates)}"
        )

    return {"ok": True}
