from fastapi import APIRouter, Request, Depends
from sqlalchemy import select, or_
from sqlalchemy.orm import selectinload
from datetime import datetime, timezone
from typing import Optional

from .messages import messages_route
from .factions import router as factions_router
from src.canvases import canvases, _canvas_to_dict
from src.sql.ip import get_ip_info
from src.auth import require_session
from src.sql.models import User, Ban, BanEntry
from src.sql.db import AsyncSessionLocal

router = APIRouter()
router.include_router(factions_router)

router.get("/channels/{id}")(messages_route)

@router.get("/canvases")
async def canvases_route():
    return {"canvases": {str(k): _canvas_to_dict(k, v) for k, v in canvases.items()}, "default": 0}

@router.get("/iid")
async def iid_route(request: Request):
    info = await get_ip_info(request.client.host)
    if not info:
        return "No IID"
    return info.hash

@router.get("/bans")
async def bans_route(request: Request, user: User = Depends(require_session)):
    ip = request.client.host

@router.get("/me/ban")
async def me_ban_route(user: User = Depends(require_session)):
    now = datetime.now(timezone.utc)
    async with AsyncSessionLocal() as session:
        entry = await session.scalar(
            select(BanEntry)
            .join(Ban, Ban.id == BanEntry.ban_id)
            .where(
                BanEntry.user_id == user.id,
                BanEntry.active == True,
                or_(Ban.expires_at == None, Ban.expires_at > now),
            )
            .options(selectinload(BanEntry.ban).selectinload(Ban.moderator))
            .limit(1)
        )
    if not entry:
        return {"banned": False}
    ban = entry.ban
    mod_username = ban.moderator.username if ban.moderator else "System"
    
    # Ensure expires_at has timezone info before converting to ISO
    expires_iso = None
    if ban.expires_at:
        expires = ban.expires_at
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        expires_iso = expires.isoformat()
    
    # Same for created_at
    banned_at_iso = None
    if ban.created_at:
        created = ban.created_at
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        banned_at_iso = created.isoformat()
    
    return {
        "banned": True,
        "reason": ban.reason,
        "expires_at": expires_iso,
        "is_permanent": ban.expires_at is None,
        "mod_username": mod_username,
        "banned_at": banned_at_iso,
    }

@router.get("/version")
async def version_route():
    return {"version": "1.0.0"}

@router.patch("/me/privacy")
async def update_my_privacy(
    request: Request,
    user: User = Depends(require_session)
):
    allow_faction_invites = None
    show_in_invite_search = None

    try:
        data = await request.json()
        if isinstance(data, dict):
            if "allow_faction_invites" in data:
                allow_faction_invites = bool(data["allow_faction_invites"])
            if "show_in_invite_search" in data:
                show_in_invite_search = bool(data["show_in_invite_search"])
    except Exception:
        pass

    if allow_faction_invites is None and show_in_invite_search is None:
        try:
            form = await request.form()
            if "allow_faction_invites" in form:
                allow_faction_invites = str(form["allow_faction_invites"]).lower() in ("true", "1")
            if "show_in_invite_search" in form:
                show_in_invite_search = str(form["show_in_invite_search"]).lower() in ("true", "1")
        except Exception:
            pass

    async with AsyncSessionLocal() as session:
        u = await session.scalar(select(User).where(User.id == user.id))
        if not u:
            raise HTTPException(status_code=404, detail="User not found")
        if allow_faction_invites is not None:
            u.allow_faction_invites = allow_faction_invites
        if show_in_invite_search is not None:
            u.show_in_invite_search = show_in_invite_search
        await session.commit()
        return {
            "status": "ok",
            "allow_faction_invites": u.allow_faction_invites,
            "show_in_invite_search": u.show_in_invite_search
        }