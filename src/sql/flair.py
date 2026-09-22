from typing import Optional
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from .models import UserFlair, UserIcon


async def get_flair(db: AsyncSession, user_id: int) -> Optional[UserFlair]:
    return await db.get(UserFlair, user_id)


async def upsert_flair(db: AsyncSession, user_id: int, **fields) -> UserFlair:
    flair = await db.get(UserFlair, user_id)
    if flair is None:
        flair = UserFlair(user_id=user_id)
        db.add(flair)
    for k, v in fields.items():
        setattr(flair, k, v)
    await db.commit()
    await db.refresh(flair)
    return flair


async def get_all_icons(db: AsyncSession) -> list[UserIcon]:
    result = await db.execute(select(UserIcon).order_by(UserIcon.id))
    return result.scalars().all()


async def get_icon(db: AsyncSession, icon_id: int) -> Optional[UserIcon]:
    return await db.get(UserIcon, icon_id)


async def create_icon(db: AsyncSession, name: str, image_b64: str, created_by: int) -> UserIcon:
    icon = UserIcon(name=name, image_b64=image_b64, created_by=created_by)
    db.add(icon)
    await db.commit()
    await db.refresh(icon)
    return icon


async def delete_icon(db: AsyncSession, icon_id: int) -> bool:
    icon = await db.get(UserIcon, icon_id)
    if not icon:
        return False
    await db.delete(icon)
    await db.commit()
    return True
