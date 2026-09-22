from sqlalchemy import select, func
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.ext.asyncio import AsyncSession
from src.sql.db import AsyncSessionLocal
from src.sql.models import IPInfo, IPUserPair, SessionUserPair
import ipaddress

def get_cidr(ip: str) -> str:
    """Get /24 subnet for IPv4, /48 for IPv6."""
    if ipaddress.ip_address(ip).version == 4:
        return str(ipaddress.ip_network(f"{ip}/24", strict=False))
    return str(ipaddress.ip_network(f"{ip}/48", strict=False))

async def get_client_ip_info(session: AsyncSession, client) -> IPInfo:
    info = await session.get(IPInfo, client.ip)
    if not info:
        info = IPInfo(ip=client.ip, cidr=get_cidr(client.ip), country_code=client.country_code)
        session.add(info)

    return info

async def get_ip_info(ip: str) -> IPInfo | None:
    async with AsyncSessionLocal() as session:
        return await session.get(IPInfo, ip)

async def log_session_and_id(session: AsyncSession, user_id: int, session_id: str) -> None:
    """Record a browser/user association without a select-before-insert."""
    await session.execute(
        mysql_insert(SessionUserPair)
        .values(user_id=user_id, session_id=session_id)
        .prefix_with("IGNORE")
    )

async def log_ip_and_id(session: AsyncSession, ip: str, user_id: int) -> None:
    """Record this use of an IP, refreshing its per-user last-seen time."""
    stmt = mysql_insert(IPUserPair).values(ip=ip, user_id=user_id)
    await session.execute(
        stmt.on_duplicate_key_update(last_seen=func.now())
    )

async def ids_by_ip(session: AsyncSession, ips: list[str]) -> list[int]:
    result = await session.scalars(
        select(IPUserPair.user_id).where(IPUserPair.ip.in_(ips)).distinct()
    )
    return list(result.all())

async def ips_by_ids(session: AsyncSession, user_ids: list[int]) -> list[str]:
    result = await session.scalars(
        select(IPUserPair.ip).where(IPUserPair.user_id.in_(user_ids)).distinct()
    )
    return list(result.all())

async def ids_by_session(session: AsyncSession, session_ids: list[str]) -> list[int]:
    result = await session.scalars(
        select(SessionUserPair.user_id).where(SessionUserPair.session_id.in_(session_ids)).distinct()
    )
    return list(result.all())

async def sessions_by_ids(session: AsyncSession, user_ids: list[int]) -> list[str]:
    result = await session.scalars(
        select(SessionUserPair.session_id).where(SessionUserPair.user_id.in_(user_ids)).distinct()
    )
    return list(result.all())
