import os
import asyncio
import io
from typing import Optional
from fastapi import APIRouter, Request, Depends, HTTPException, UploadFile, File, Form, Response
from sqlalchemy import select, func, or_, and_, desc
from sqlalchemy.orm import selectinload
from datetime import datetime, timezone
from PIL import Image

from src.auth import require_session, require_mod
from src.sql.db import AsyncSessionLocal
from src.sql.models import (
    User, Faction, FactionMember, FactionInvite, FactionAnnouncement,
    UnlockedFactionCanvas
)
from src.redis_client.leaderboards import get_pixel_count
from src.socket_server.clients import clients_by_user
from src.socket_server.packets import opcode, serialize_text

router = APIRouter(prefix="/factions", tags=["factions"])

CREATION_PIXEL_REQUIREMENT = 200000
MAX_TEMPLATE_FILE_SIZE = 10 * 1024 * 1024  # 10 MB
MAX_LOGO_FILE_SIZE = 2 * 1024 * 1024  # 2 MB
LOGO_SIZE = 50


async def get_user_pixel_count(session, user_id: int) -> int:
    return await get_pixel_count(user_id=user_id, canvas_id=-1, daily=False)


async def get_user_daily_pixel_count(session, user_id: int) -> int:
    return await get_pixel_count(user_id=user_id, canvas_id=-1, daily=True)


def _process_faction_logo(contents: bytes, filename_stem: str) -> str:
    """Validate and save a logo. Client resizes to LOGO_SIZE×LOGO_SIZE; reject oversized uploads."""
    if len(contents) > MAX_LOGO_FILE_SIZE:
        raise HTTPException(status_code=400, detail="Logo image must be smaller than 2MB")
    try:
        img = Image.open(io.BytesIO(contents))
        if img.width > LOGO_SIZE or img.height > LOGO_SIZE:
            raise HTTPException(
                status_code=400,
                detail=f"Logo must be at most {LOGO_SIZE}×{LOGO_SIZE} pixels",
            )
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGBA")

        upload_dir = os.path.join(os.getcwd(), "uploads", "factions", "logos")
        os.makedirs(upload_dir, exist_ok=True)
        filename = f"{filename_stem}.png"
        filepath = os.path.join(upload_dir, filename)
        img.save(filepath, format="PNG")
        return f"/uploads/factions/logos/{filename}"
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid image file for logo: {e}")



async def notify_online_user(user_id: int, packet_opcode, data: dict):
    clients = clients_by_user.get(user_id, set())
    if clients:
        pkt = serialize_text(packet_opcode, data)
        for c in list(clients):
            asyncio.create_task(c.safe_send_text(pkt))


async def notify_faction_members(session, faction_id: int, packet_opcode, data: dict, exclude_user_id: int = None):
    members = await session.scalars(
        select(FactionMember.user_id).where(FactionMember.faction_id == faction_id)
    )
    for uid in members:
        if exclude_user_id and uid == exclude_user_id:
            continue
        await notify_online_user(uid, packet_opcode, data)





@router.get("/users/search")
async def search_invite_users(query: Optional[str] = None, user: User = Depends(require_session)):
    async with AsyncSessionLocal() as session:
        existing_uids = (await session.scalars(select(FactionMember.user_id))).all()

        stmt = select(User).where(
            User.allow_faction_invites == True,
            User.show_in_invite_search == True,
            User.id != user.id
        )
        if existing_uids:
            stmt = stmt.where(User.id.not_in(existing_uids))

        if query and query.strip():
            stmt = stmt.where(User.username.ilike(f"%{query.strip()}%"))

        stmt = stmt.limit(10)
        users = (await session.scalars(stmt)).all()

        return {"users": [{"id": u.id, "username": u.username, "avatar": u.avatar, "discord_id": u.discord_id} for u in users]}


@router.get("")
async def list_factions(search: Optional[str] = None, public_only: bool = False):
    async with AsyncSessionLocal() as session:
        query = select(Faction).options(selectinload(Faction.owner), selectinload(Faction.members))
        if search:
            query = query.where(Faction.name.ilike(f"%{search}%"))
        if public_only:
            query = query.where(Faction.is_public == True)

        factions = (await session.scalars(query)).all()

        res = []
        for f in factions:
            member_ids = [m.user_id for m in f.members]
            total_px = 0
            daily_px = 0
            for uid in member_ids:
                total_px += await get_pixel_count(uid, canvas_id=-1, daily=False)
                daily_px += await get_pixel_count(uid, canvas_id=-1, daily=True)

            res.append({
                "id": f.id,
                "name": f.name,
                "description": f.description,
                "logo_url": f.logo_url,
                "color": f.color,
                "canvas_id": f.canvas_id,
                "owner_id": f.owner_id,
                "owner_username": f.owner.username if f.owner else "Unknown",
                "is_public": f.is_public,
                "min_join_px": f.min_join_px,
                "member_count": len(f.members),
                "total_pixels": total_px,
                "daily_pixels": daily_px,
                "created_at": f.created_at.isoformat()
            })

        res.sort(key=lambda x: x["total_pixels"], reverse=True)
        return {"factions": res}


@router.get("/my")
async def get_my_faction(user: User = Depends(require_session)):
    async with AsyncSessionLocal() as session:
        membership = await session.scalar(
            select(FactionMember).where(FactionMember.user_id == user.id)
        )
        if not membership:
            invites = (await session.scalars(
                select(FactionInvite)
                .options(selectinload(FactionInvite.faction), selectinload(FactionInvite.invited_by))
                .where(FactionInvite.user_id == user.id)
            )).all()
            return {
                "faction": None,
                "role": 0,
                "invites": [{
                    "id": inv.id,
                    "faction_id": inv.faction_id,
                    "faction_name": inv.faction.name if inv.faction else "Unknown",
                    "faction_logo": inv.faction.logo_url if inv.faction else None,
                    "invited_by": inv.invited_by.username if inv.invited_by else "Unknown",
                    "created_at": inv.created_at.isoformat()
                } for inv in invites]
            }

        return await get_faction_details(membership.faction_id, user=user)


@router.get("/{faction_id}")
async def get_faction_details(faction_id: int, user: User = Depends(require_session)):
    async with AsyncSessionLocal() as session:
        faction = await session.scalar(
            select(Faction)
            .options(
                selectinload(Faction.owner),
                selectinload(Faction.members).selectinload(FactionMember.user)
            )
            .where(Faction.id == faction_id)
        )
        if not faction:
            raise HTTPException(status_code=404, detail="Faction not found")

        current_membership = await session.scalar(
            select(FactionMember).where(FactionMember.faction_id == faction_id, FactionMember.user_id == user.id)
        )

        roster = []
        member_ids = []
        for m in faction.members:
            if m.user:
                member_ids.append(m.user_id)

        px_map = {}
        daily_px_map = {}
        for uid in member_ids:
            px_map[uid] = await get_pixel_count(uid, canvas_id=-1, daily=False)
            daily_px_map[uid] = await get_pixel_count(uid, canvas_id=-1, daily=True)

        for m in faction.members:
            if m.user:
                roster.append({
                    "user_id": m.user.id,
                    "username": m.user.username,
                    "avatar": m.user.avatar,
                    "discord_id": m.user.discord_id,
                    "role": m.role,
                    "joined_at": m.joined_at.isoformat(),
                    "total_pixels": px_map.get(m.user_id, 0),
                    "daily_pixels": daily_px_map.get(m.user_id, 0)
                })

        roster.sort(key=lambda x: (x["role"], x["total_pixels"]), reverse=True)

        announcements = (await session.scalars(
            select(FactionAnnouncement)
            .options(selectinload(FactionAnnouncement.author))
            .where(FactionAnnouncement.faction_id == faction_id)
            .order_by(desc(FactionAnnouncement.created_at))
            .limit(20)
        )).all()

        total_pixels = sum(px_map.values())
        daily_pixels = sum(daily_px_map.values())

        return {
            "faction": {
                "id": faction.id,
                "name": faction.name,
                "description": faction.description,
                "logo_url": faction.logo_url,
                "color": faction.color,
                "canvas_id": faction.canvas_id,
                "owner_id": faction.owner_id,
                "owner_username": faction.owner.username if faction.owner else "Unknown",
                "is_public": faction.is_public,
                "min_join_px": faction.min_join_px,
                "template_url": faction.template_url,
                "template_canvas_id": faction.template_canvas_id,
                "template_x": faction.template_x,
                "template_y": faction.template_y,
                "total_pixels": total_pixels,
                "daily_pixels": daily_pixels,
                "member_count": len(roster),
                "created_at": faction.created_at.isoformat()
            },
            "my_role": current_membership.role if current_membership else 0,
            "roster": roster,
            "announcements": [{
                "id": a.id,
                "author_username": a.author.username if a.author else "Unknown",
                "message": a.message,
                "canvas_id": a.canvas_id,
                "x": a.x,
                "y": a.y,
                "created_at": a.created_at.isoformat()
            } for a in announcements]
        }


@router.post("")
async def create_faction(
    name: str = Form(...),
    description: str = Form(""),
    color: str = Form("#ff4444"),
    is_public: bool = Form(False),
    min_join_px: int = Form(10000),
    canvas_id: int = Form(0),
    logo: Optional[UploadFile] = File(None),
    user: User = Depends(require_session)
):
    name = name.strip()
    if len(name) < 3 or len(name) > 32:
        raise HTTPException(status_code=400, detail="Faction name must be between 3 and 32 characters")

    min_join_px = max(10000, min(min_join_px, 1000000))

    async with AsyncSessionLocal() as session:
        # 1. Check user total pixels threshold (>= 200,000)
        px_count = await get_user_pixel_count(session, user.id)
        if px_count < CREATION_PIXEL_REQUIREMENT:
            raise HTTPException(
                status_code=400,
                detail=f"You need at least {CREATION_PIXEL_REQUIREMENT:,} placed pixels to create a faction. You currently have {px_count:,}."
            )

        # 2. Check caller isn't already in a faction
        existing_mem = await session.scalar(
            select(FactionMember).where(FactionMember.user_id == user.id)
        )
        if existing_mem:
            raise HTTPException(status_code=400, detail="You are already a member of a faction.")

        # 3. Check canvas availability (Earth 0 or unlocked)
        if canvas_id != 0:
            unlocked = await session.scalar(
                select(UnlockedFactionCanvas).where(UnlockedFactionCanvas.canvas_id == canvas_id)
            )
            if not unlocked:
                raise HTTPException(status_code=400, detail="This canvas is not unlocked for Faction territory conquest.")

        # 4. Check name uniqueness
        existing_name = await session.scalar(
            select(Faction).where(Faction.name.ilike(name))
        )
        if existing_name:
            raise HTTPException(status_code=400, detail="A faction with this name already exists.")

        # Handle Logo upload — resize to 50×50 on server; reject oversized files
        logo_url = None
        if logo:
            contents = await logo.read()
            logo_url = _process_faction_logo(
                contents,
                f"logo_{user.id}_{int(datetime.now(timezone.utc).timestamp())}",
            )

        # Create Faction & Owner Membership
        faction = Faction(
            name=name,
            description=description,
            logo_url=logo_url,
            color=color,
            canvas_id=canvas_id,
            owner_id=user.id,
            is_public=is_public,
            min_join_px=min_join_px
        )
        session.add(faction)
        await session.flush()

        member = FactionMember(
            faction_id=faction.id,
            user_id=user.id,
            role=4  # Owner
        )
        session.add(member)
        await session.commit()

        return {"status": "ok", "faction_id": faction.id}


@router.patch("/{faction_id}")
async def update_faction_settings(
    faction_id: int,
    description: Optional[str] = Form(None),
    color: Optional[str] = Form(None),
    is_public: Optional[bool] = Form(None),
    min_join_px: Optional[int] = Form(None),
    logo: Optional[UploadFile] = File(None),
    user: User = Depends(require_session)
):
    async with AsyncSessionLocal() as session:
        membership = await session.scalar(
            select(FactionMember).where(
                FactionMember.faction_id == faction_id,
                FactionMember.user_id == user.id
            )
        )
        if not membership or membership.role < 3: # Must be Owner (4) or Admin (3)
            raise HTTPException(status_code=403, detail="Only Faction Owner or Admins can modify settings")

        faction = await session.scalar(select(Faction).where(Faction.id == faction_id))
        if not faction:
            raise HTTPException(status_code=404, detail="Faction not found")

        if description is not None:
            faction.description = description
        if color is not None:
            faction.color = color
        if is_public is not None:
            faction.is_public = is_public
        if min_join_px is not None:
            faction.min_join_px = max(10000, min(min_join_px, 1000000))

        if logo:
            contents = await logo.read()
            faction.logo_url = _process_faction_logo(
                contents,
                f"logo_{faction_id}_{int(datetime.now(timezone.utc).timestamp())}",
            )

        await session.commit()
        return {"status": "ok", "logo_url": faction.logo_url}


@router.delete("/{faction_id}")
async def disband_faction(faction_id: int, user: User = Depends(require_session)):
    async with AsyncSessionLocal() as session:
        faction = await session.scalar(select(Faction).where(Faction.id == faction_id))
        if not faction:
            raise HTTPException(status_code=404, detail="Faction not found")

        is_owner = (faction.owner_id == user.id)
        is_mod = (user.role >= 100)
        if not is_owner and not is_mod:
            raise HTTPException(status_code=403, detail="Only the Faction Owner or Platform Moderators can disband a faction")

        await session.delete(faction)
        await session.commit()

        return {"status": "ok", "message": "Faction disbanded"}


@router.post("/{faction_id}/invite")
async def invite_user(faction_id: int, target_user_id: int = Form(...), user: User = Depends(require_session)):
    async with AsyncSessionLocal() as session:
        membership = await session.scalar(
            select(FactionMember).where(
                FactionMember.faction_id == faction_id,
                FactionMember.user_id == user.id
            )
        )
        if not membership or membership.role < 3:
            raise HTTPException(status_code=403, detail="Only Faction Owner or Admins can send invites")

        faction = await session.scalar(select(Faction).where(Faction.id == faction_id))
        target_user = await session.scalar(select(User).where(User.id == target_user_id))
        if not target_user:
            raise HTTPException(status_code=404, detail="Target user not found")

        if not target_user.allow_faction_invites:
            raise HTTPException(status_code=400, detail="This user has disabled faction invites in their settings.")

        target_mem = await session.scalar(select(FactionMember).where(FactionMember.user_id == target_user_id))
        if target_mem:
            raise HTTPException(status_code=400, detail="User is already in a faction.")

        existing_inv = await session.scalar(
            select(FactionInvite).where(
                FactionInvite.faction_id == faction_id,
                FactionInvite.user_id == target_user_id
            )
        )
        if existing_inv:
            raise HTTPException(status_code=400, detail="Invite already pending for this user.")

        invite = FactionInvite(
            faction_id=faction_id,
            user_id=target_user_id,
            invited_by_id=user.id
        )
        session.add(invite)
        await session.commit()

        # Send real-time WS notification to target user
        await notify_online_user(
            target_user_id,
            opcode.FACTION_INVITE,
            {
                "invite_id": invite.id,
                "faction_id": faction.id,
                "faction_name": faction.name,
                "invited_by": user.username
            }
        )

        return {"status": "ok", "message": f"Invite sent to {target_user.username}"}


@router.post("/invites/{invite_id}/accept")
async def accept_invite(invite_id: int, user: User = Depends(require_session)):
    async with AsyncSessionLocal() as session:
        invite = await session.scalar(
            select(FactionInvite).where(FactionInvite.id == invite_id, FactionInvite.user_id == user.id)
        )
        if not invite:
            raise HTTPException(status_code=404, detail="Invite not found")

        existing_mem = await session.scalar(select(FactionMember).where(FactionMember.user_id == user.id))
        if existing_mem:
            raise HTTPException(status_code=400, detail="You are already in a faction.")

        # Create member
        member = FactionMember(
            faction_id=invite.faction_id,
            user_id=user.id,
            role=1  # Soldier
        )
        session.add(member)

        # Clear all pending invites for user
        await session.execute(select(FactionInvite).where(FactionInvite.user_id == user.id))
        all_invites = (await session.scalars(select(FactionInvite).where(FactionInvite.user_id == user.id))).all()
        for inv in all_invites:
            await session.delete(inv)

        await session.commit()
        return {"status": "ok", "faction_id": invite.faction_id}


@router.post("/invites/{invite_id}/decline")
async def decline_invite(invite_id: int, user: User = Depends(require_session)):
    async with AsyncSessionLocal() as session:
        invite = await session.scalar(
            select(FactionInvite).where(FactionInvite.id == invite_id, FactionInvite.user_id == user.id)
        )
        if invite:
            await session.delete(invite)
            await session.commit()
        return {"status": "ok"}


@router.post("/{faction_id}/join")
async def join_public_faction(faction_id: int, user: User = Depends(require_session)):
    async with AsyncSessionLocal() as session:
        faction = await session.scalar(select(Faction).where(Faction.id == faction_id))
        if not faction:
            raise HTTPException(status_code=404, detail="Faction not found")

        if not faction.is_public:
            raise HTTPException(status_code=400, detail="This faction is invite only.")

        existing_mem = await session.scalar(select(FactionMember).where(FactionMember.user_id == user.id))
        if existing_mem:
            raise HTTPException(status_code=400, detail="You are already in a faction.")

        user_pixels = await get_user_pixel_count(session, user.id)
        if user_pixels < faction.min_join_px:
            raise HTTPException(
                status_code=400,
                detail=f"This faction requires at least {faction.min_join_px:,} pixels to join. You currently have {user_pixels:,}."
            )

        member = FactionMember(
            faction_id=faction_id,
            user_id=user.id,
            role=1  # Soldier
        )
        session.add(member)
        await session.commit()

        return {"status": "ok", "faction_id": faction_id}


@router.post("/{faction_id}/leave")
async def leave_faction(faction_id: int, user: User = Depends(require_session)):
    async with AsyncSessionLocal() as session:
        membership = await session.scalar(
            select(FactionMember).where(FactionMember.faction_id == faction_id, FactionMember.user_id == user.id)
        )
        if not membership:
            raise HTTPException(status_code=400, detail="You are not a member of this faction")

        if membership.role == 4: # Owner leaving
            other_members_count = await session.scalar(
                select(func.count(FactionMember.id))
                .where(FactionMember.faction_id == faction_id, FactionMember.user_id != user.id)
            ) or 0

            if other_members_count > 0:
                raise HTTPException(
                    status_code=400,
                    detail="Faction owners cannot leave while other members exist. You must transfer ownership to another member before leaving."
                )

            # Sole member leaving disbands the faction
            faction = await session.scalar(select(Faction).where(Faction.id == faction_id))
            if faction:
                await session.delete(faction)
            await session.commit()
            return {"status": "ok", "message": "Faction disbanded as you were the last member."}

        await session.delete(membership)
        await session.commit()
        return {"status": "ok"}


@router.delete("/{faction_id}/template")
async def delete_faction_template(faction_id: int, user: User = Depends(require_session)):
    async with AsyncSessionLocal() as session:
        faction = await session.scalar(select(Faction).where(Faction.id == faction_id))
        if not faction:
            raise HTTPException(status_code=404, detail="Faction not found")

        membership = await session.scalar(
            select(FactionMember).where(FactionMember.faction_id == faction_id, FactionMember.user_id == user.id)
        )
        is_owner_or_admin = membership and membership.role >= 3
        is_staff = user.role >= 100

        if not is_owner_or_admin and not is_staff:
            raise HTTPException(status_code=403, detail="Only Faction Leaders or Staff Moderators can delete faction templates")

        faction.template_url = None
        faction.template_canvas_id = 0
        faction.template_x = 0
        faction.template_y = 0
        await session.commit()

        await notify_faction_members(
            session,
            faction_id,
            opcode.FACTION_TEMPLATE,
            {
                "faction_id": faction_id,
                "template_url": None,
                "canvas_id": 0,
                "x": 0,
                "y": 0
            }
        )

        return {"status": "ok", "message": "Template deleted"}


@router.post("/{faction_id}/warn")
async def warn_faction(
    faction_id: int,
    reason: str = Form(...),
    user: User = Depends(require_mod)
):
    reason = reason.strip()
    if not reason:
        raise HTTPException(status_code=400, detail="Warning reason is required")

    async with AsyncSessionLocal() as session:
        faction = await session.scalar(
            select(Faction)
            .options(selectinload(Faction.owner), selectinload(Faction.members))
            .where(Faction.id == faction_id)
        )
        if not faction:
            raise HTTPException(status_code=404, detail="Faction not found")

        warn_data = {
            "faction_id": faction_id,
            "faction_name": faction.name,
            "reason": reason,
            "warned_by": user.username,
            "timestamp": datetime.now(timezone.utc).isoformat()
        }

        if faction.owner_id:
            await notify_online_user(faction.owner_id, opcode.FACTION_WARN, warn_data)

        await notify_faction_members(session, faction_id, opcode.FACTION_WARN, warn_data, exclude_user_id=faction.owner_id)

        return {"status": "ok", "message": f"Warning issued to faction {faction.name}"}


@router.post("/{faction_id}/members/{target_user_id}/role")
async def update_member_role(
    faction_id: int,
    target_user_id: int,
    new_role: int = Form(...),
    user: User = Depends(require_session)
):
    if new_role not in [1, 2, 3, 4]: # 4=Owner, 3=Admin, 2=General, 1=Soldier
        raise HTTPException(status_code=400, detail="Invalid role specified")

    async with AsyncSessionLocal() as session:
        my_membership = await session.scalar(
            select(FactionMember).where(FactionMember.faction_id == faction_id, FactionMember.user_id == user.id)
        )
        if not my_membership or my_membership.role < 3:
            raise HTTPException(status_code=403, detail="Only Faction Owner or Admins can promote/demote members")

        target_membership = await session.scalar(
            select(FactionMember).where(FactionMember.faction_id == faction_id, FactionMember.user_id == target_user_id)
        )
        if not target_membership:
            raise HTTPException(status_code=404, detail="Target member not found in faction")

        if target_membership.role == 4:
            raise HTTPException(status_code=400, detail="Cannot change current Owner role directly")

        # Owner transferring ownership
        if my_membership.role == 4 and new_role == 4:
            my_membership.role = 3  # Previous owner becomes Admin
            target_membership.role = 4  # Target becomes new Owner
            faction = await session.scalar(select(Faction).where(Faction.id == faction_id))
            if faction:
                faction.owner_id = target_user_id
            await session.commit()
            return {"status": "ok", "message": "Ownership transferred successfully"}

        if new_role == 4:
            raise HTTPException(status_code=403, detail="Only the Faction Owner can transfer ownership")

        # Admins can only assign General (2) or Soldier (1)
        if my_membership.role == 3 and new_role == 3:
            raise HTTPException(status_code=403, detail="Only Faction Owner can promote members to Admin")

        target_membership.role = new_role
        await session.commit()

        return {"status": "ok"}


@router.delete("/{faction_id}/members/{target_user_id}")
async def kick_member(faction_id: int, target_user_id: int, user: User = Depends(require_session)):
    async with AsyncSessionLocal() as session:
        my_membership = await session.scalar(
            select(FactionMember).where(FactionMember.faction_id == faction_id, FactionMember.user_id == user.id)
        )
        if not my_membership or my_membership.role < 3:
            raise HTTPException(status_code=403, detail="Only Faction Owner or Admins can kick members")

        target_membership = await session.scalar(
            select(FactionMember).where(FactionMember.faction_id == faction_id, FactionMember.user_id == target_user_id)
        )
        if not target_membership:
            raise HTTPException(status_code=404, detail="Target member not found")

        # Admin cannot kick another Admin or Owner
        if my_membership.role <= target_membership.role:
            raise HTTPException(status_code=403, detail="You cannot kick a member with equal or higher rank")

        await session.delete(target_membership)
        await session.commit()

        return {"status": "ok", "message": "Member kicked"}


@router.post("/{faction_id}/template")
async def upload_faction_template(
    faction_id: int,
    canvas_id: int = Form(0),
    x: int = Form(0),
    y: int = Form(0),
    file: UploadFile = File(...),
    user: User = Depends(require_session)
):
    contents = await file.read()
    if len(contents) > MAX_TEMPLATE_FILE_SIZE:
        raise HTTPException(
            status_code=400,
            detail=f"Template file exceeds maximum size limit of 10MB (file was {len(contents)/(1024*1024):.1f}MB)."
        )

    async with AsyncSessionLocal() as session:
        my_membership = await session.scalar(
            select(FactionMember).where(FactionMember.faction_id == faction_id, FactionMember.user_id == user.id)
        )
        if not my_membership or my_membership.role < 3:
            raise HTTPException(status_code=403, detail="Only Faction Owner or Admins can set faction templates")

        faction = await session.scalar(select(Faction).where(Faction.id == faction_id))
        if not faction:
            raise HTTPException(status_code=404, detail="Faction not found")

        upload_dir = os.path.join(os.getcwd(), "uploads", "factions", "templates")
        os.makedirs(upload_dir, exist_ok=True)
        filename = f"tpl_{faction_id}_{int(datetime.now(timezone.utc).timestamp())}.png"
        filepath = os.path.join(upload_dir, filename)
        with open(filepath, "wb") as f:
            f.write(contents)

        template_url = f"/uploads/factions/templates/{filename}"
        faction.template_url = template_url
        faction.template_canvas_id = canvas_id
        faction.template_x = x
        faction.template_y = y
        await session.commit()

        # Real-time WebSocket notification to all members
        await notify_faction_members(
            session,
            faction_id,
            opcode.FACTION_TEMPLATE,
            {
                "faction_id": faction_id,
                "template_url": template_url,
                "canvas_id": canvas_id,
                "x": x,
                "y": y
            }
        )

        return {
            "status": "ok",
            "template_url": template_url,
            "canvas_id": canvas_id,
            "x": x,
            "y": y
        }


@router.post("/{faction_id}/announcements")
async def post_announcement(
    faction_id: int,
    message: str = Form(...),
    canvas_id: Optional[int] = Form(None),
    x: Optional[int] = Form(None),
    y: Optional[int] = Form(None),
    user: User = Depends(require_session)
):
    message = message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="Announcement message cannot be empty")

    async with AsyncSessionLocal() as session:
        my_membership = await session.scalar(
            select(FactionMember).where(FactionMember.faction_id == faction_id, FactionMember.user_id == user.id)
        )
        if not my_membership or my_membership.role < 3:
            raise HTTPException(status_code=403, detail="Only Faction Owner or Admins can post announcements")

        announcement = FactionAnnouncement(
            faction_id=faction_id,
            author_id=user.id,
            message=message,
            canvas_id=canvas_id,
            x=x,
            y=y
        )
        session.add(announcement)
        await session.commit()

        # Real-time WS notification to members
        await notify_faction_members(
            session,
            faction_id,
            opcode.FACTION_ANNOUNCEMENT,
            {
                "faction_id": faction_id,
                "author": user.username,
                "message": message,
                "canvas_id": canvas_id,
                "x": x,
                "y": y,
                "created_at": announcement.created_at.isoformat()
            }
        )

        return {"status": "ok", "announcement_id": announcement.id}





# ── Admin Governance Endpoints (Mods+) ──────────────────────────────────────

@router.post("/admin/unlock-canvas")
async def admin_unlock_canvas(canvas_id: int = Form(...), user: User = Depends(require_mod)):
    async with AsyncSessionLocal() as session:
        existing = await session.scalar(
            select(UnlockedFactionCanvas).where(UnlockedFactionCanvas.canvas_id == canvas_id)
        )
        if not existing:
            unlock = UnlockedFactionCanvas(canvas_id=canvas_id, unlocked_by=user.id)
            session.add(unlock)
            await session.commit()
        return {"status": "ok", "canvas_id": canvas_id}


@router.get("/admin/unlocked-canvases")
async def admin_list_unlocked_canvases():
    async with AsyncSessionLocal() as session:
        unlocked = (await session.scalars(select(UnlockedFactionCanvas.canvas_id))).all()
        return {"unlocked": unlocked}
