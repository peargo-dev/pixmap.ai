from sqlalchemy import select, or_, update
from sqlalchemy.ext.asyncio import AsyncSession
from src.sql.models import Ban, BanEntry, BanScope, User
from datetime import datetime, timezone
from src.sql.ip import ips_by_ids, ids_by_ip, ids_by_session, sessions_by_ids
from src.socket_server.clients import clients_by_user

async def ban_user(
        session: AsyncSession,
        user_id: int,
        mod_id: int | None,
        reason: str | None,
        expires_at: datetime | None = None,
        ban_alts: bool = True,
) -> Ban:
    """
    Ban a user (and optionally all known alts).
    Snapshots every IP and session ID involved into BanScope so future
    alt detection is a simple indexed lookup rather than a graph traversal.
    Returns the created Ban.
    """
    ban = Ban(moderator_id=mod_id, reason=reason, expires_at=expires_at)
    session.add(ban)
    await session.flush()  # populate ban.id before recursing

    visited_users: set[int] = {user_id}
    frontier: set[int] = {user_id}
    all_ips: set[str] = set()
    all_sids: set[str] = set()

    # Traverse the alt graph one level at a time. The old recursive version did
    # four SQL round trips for every account, which made large shared-IP chains
    # tie up a request for a long time.
    while frontier:
        user_ids = list(frontier)
        ips = set(await ips_by_ids(session, user_ids))
        sids = set(await sessions_by_ids(session, user_ids))
        all_ips.update(ips)
        all_sids.update(sids)

        if not ban_alts:
            break

        next_users: set[int] = set()
        if ips:
            next_users.update(await ids_by_ip(session, list(ips)))
        if sids:
            next_users.update(await ids_by_session(session, list(sids)))
        frontier = next_users - visited_users
        visited_users.update(frontier)

    session.add_all([
        BanEntry(ban_id=ban.id, user_id=uid, is_alt=(uid != user_id))
        for uid in visited_users
    ])

    for ip in all_ips:
        session.add(BanScope(ban_id=ban.id, type="ip", value=ip))
    for sid in all_sids:
        session.add(BanScope(ban_id=ban.id, type="sid", value=sid))

    for uid in visited_users:
        for client in clients_by_user.get(uid, set()):
            client.banned = True

    await session.flush()
    return ban


async def unban_user(session: AsyncSession, user_id: int) -> None:
    """
    Pardon a user from every active ban entry. If the user is the original
    target of a ban, pardon every alt attached to that ban as well.
    Caller is responsible for committing.
    """
    entries = (await session.execute(
        select(BanEntry.ban_id, BanEntry.is_alt).where(
            BanEntry.user_id == user_id,
            BanEntry.active == True,
        )
    )).all()
    if not entries:
        return

    main_ban_ids = {ban_id for ban_id, is_alt in entries if not is_alt}
    affected_filter = BanEntry.user_id == user_id
    if main_ban_ids:
        affected_filter = or_(
            affected_filter,
            BanEntry.ban_id.in_(main_ban_ids),
        )

    affected = set((await session.scalars(
        select(BanEntry.user_id)
        .where(BanEntry.active == True, affected_filter)
        .distinct()
    )).all())

    await session.execute(
        update(BanEntry)
        .where(BanEntry.active == True, affected_filter)
        .values(active=False)
    )

    still_banned = await _actively_banned_users(session, affected)
    for uid in affected:
        for client in clients_by_user.get(uid, set()):
            client.banned = uid in still_banned

async def unban_entry(session: AsyncSession, entry_id: str) -> None:
    """Pardon one user from a single ban entry (individual appeal)."""
    entry = await session.get(BanEntry, entry_id)
    if not entry or not entry.active:
        return

    entry.active = False

    other_active = await session.scalar(
        select(BanEntry)
        .join(Ban, Ban.id == BanEntry.ban_id)
        .where(
            BanEntry.user_id == entry.user_id,
            BanEntry.active == True,
            BanEntry.id != entry_id,
            or_(Ban.expires_at == None, Ban.expires_at > datetime.now(timezone.utc)),
        )
        .limit(1)
    )
    if not other_active:
        for c in clients_by_user.get(entry.user_id, set()):
            c.banned = False

    await session.commit()


async def unban_chain(session: AsyncSession, ban_id: str) -> None:
    """Lift an entire ban, pardoning every user in the chain."""
    affected = set((await session.scalars(
        select(BanEntry.user_id)
        .where(BanEntry.ban_id == ban_id, BanEntry.active == True)
        .distinct()
    )).all())
    if not affected:
        return

    await session.execute(
        update(BanEntry)
        .where(BanEntry.ban_id == ban_id, BanEntry.active == True)
        .values(active=False)
    )

    still_banned = await _actively_banned_users(session, affected)
    for uid in affected:
        for client in clients_by_user.get(uid, set()):
            client.banned = uid in still_banned

    await session.commit()


async def _actively_banned_users(
        session: AsyncSession,
        user_ids: set[int],
) -> set[int]:
    """Return all IDs that still have an unexpired active ban in one query."""
    if not user_ids:
        return set()
    now = datetime.now(timezone.utc)
    return set((await session.scalars(
        select(BanEntry.user_id)
        .join(Ban, Ban.id == BanEntry.ban_id)
        .where(
            BanEntry.user_id.in_(user_ids),
            BanEntry.active == True,
            or_(Ban.expires_at == None, Ban.expires_at > now),
        )
        .distinct()
    )).all())


# ---------------------------------------------------------------------------
# Alt propagation on connect
# ---------------------------------------------------------------------------

async def propagate_ban_if_alt(
        session: AsyncSession,
        user: User,
        client_ip: str,
        session_id: str,
) -> bool:
    """
    Called on every authenticated connection.
    Checks whether the connecting IP or session ID (bid cookie) appears in any
    active ban's scope. If so, bans this account under the same Ban and extends
    the scope with the new IP/session for future catches.

    Respects individual pardons: a user with an inactive BanEntry for a given
    ban is never re-added to that same chain.
    """
    now = datetime.now(timezone.utc)
    already_banned = await session.scalar(
        select(BanEntry)
        .join(Ban, Ban.id == BanEntry.ban_id)
        .where(
            BanEntry.user_id == user.id,
            BanEntry.active == True,
            or_(Ban.expires_at == None, Ban.expires_at > now),
        )
        .limit(1)
    )

    if already_banned:
        return True

    candidate_ban_ids = set((await session.scalars(
        select(BanScope.ban_id)
        .join(Ban, Ban.id == BanScope.ban_id)
        .join(BanEntry, BanEntry.ban_id == Ban.id)
        .where(
            or_(
                (BanScope.type == "ip") & (BanScope.value == client_ip),
                (BanScope.type == "sid") & (BanScope.value == session_id),
            ),
            BanEntry.active == True,
            or_(Ban.expires_at == None, Ban.expires_at > now),
        )
        .distinct()
    )).all())

    if not candidate_ban_ids:
        return False

    # Try every matching chain; a pardon from one chain must not hide another.
    pardoned_ban_ids = set((await session.scalars(
        select(BanEntry.ban_id).where(
            BanEntry.ban_id.in_(candidate_ban_ids),
            BanEntry.user_id == user.id,
            BanEntry.active == False,
        )
    )).all())
    eligible_ban_ids = candidate_ban_ids - pardoned_ban_ids
    if not eligible_ban_ids:
        return False
    ban_id = next(iter(eligible_ban_ids))

    # Add this user to the existing ban chain
    session.add(BanEntry(ban_id=ban_id, user_id=user.id, is_alt=True))

    new_scope = {("ip", client_ip), ("sid", session_id)}
    existing_scope = set((await session.execute(
        select(BanScope.type, BanScope.value).where(
            BanScope.ban_id == ban_id,
            or_(
                (BanScope.type == "ip") & (BanScope.value == client_ip),
                (BanScope.type == "sid") & (BanScope.value == session_id),
            ),
        )
    )).all())
    session.add_all([
        BanScope(ban_id=ban_id, type=type_, value=value)
        for type_, value in new_scope - existing_scope
    ])

    await session.flush()
    print(f"[ban] auto-banned user {user.id} as alt via ban {ban_id}")
    return True

async def is_banned(session: AsyncSession, user_id: int) -> bool:
    """Check if a given user currently has an active ban."""
    now = datetime.now(timezone.utc)
    banned = await session.scalar(
        select(BanEntry)
        .join(Ban, Ban.id == BanEntry.ban_id)
        .where(
            BanEntry.user_id == user_id,
            BanEntry.active == True,
            or_(Ban.expires_at == None, Ban.expires_at > now),
        )
        .limit(1)
    )
    return bool(banned)

async def get_all_bans(uid: int = None, ip: str = None) -> list[BanEntry]:
    if uid is None and ip is None:
        return []

    #TODO implement
    return []
