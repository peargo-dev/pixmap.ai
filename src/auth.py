import os
import re
import secrets
import httpx
import json
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode
from fastapi import APIRouter, Request, Response, Depends, HTTPException
from src.redis_client.leaderboards import get_pixel_count, get_user_rank
from src.sql.models import User, Session
from src.classes import Role
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from src.sql.db import get_db
from src.middleware import COOKIE_NAME, _resolve_session
from src.socket_server.clients import clients_by_user
from src.avatar import discord_avatar_url, resolve_avatar_url

_discord_avatar_url = discord_avatar_url

router = APIRouter()

DISCORD_CLIENT_ID     = os.getenv("DISCORD_CLIENT_ID", "")
DISCORD_CLIENT_SECRET = os.getenv("DISCORD_CLIENT_SECRET", "")
DISCORD_REDIRECT_URI  = os.getenv("DISCORD_REDIRECT_URI", "https://dev.pixmap.fun/auth/discord/callback")
SESSION_DAYS          = 30

GOOGLE_CLIENT_ID      = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET  = os.getenv("GOOGLE_CLIENT_SECRET", "")
GOOGLE_REDIRECT_URI   = os.getenv("GOOGLE_REDIRECT_URI", "https://dev.pixmap.fun/api/auth/google/callback")

ADMIN_IDS: set[int] = {int(s.strip()) for s in os.getenv("ADMIN_IDS", "").split(",") if s.strip().isdigit()}
OWNER_IDS: set[int] = {int(s.strip()) for s in os.getenv("OWNER_IDS", "").split(",") if s.strip().isdigit()}

api_auth_router = APIRouter()

USERNAME_RE = re.compile(r'^[A-Za-z0-9]{3,20}$')

async def enforce_session_limit(db: AsyncSession, user_id: int):
    stmt = (
        select(Session)
        .where(Session.user_id == user_id)
        .order_by(Session.created_at.desc())
    )
    res = await db.execute(stmt)
    user_sessions = res.scalars().all()
    if len(user_sessions) > 2:
        for s in user_sessions[2:]:
            await db.delete(s)
        await db.commit()

def _discord_auth_url(state: str = "login"):
    params = urlencode({
        "client_id":     DISCORD_CLIENT_ID,
        "response_type": "code",
        "redirect_uri":  DISCORD_REDIRECT_URI,
        "scope":         "identify email",
        "state":         state,
    })
    return f"https://discord.com/api/oauth2/authorize?{params}"

def _sanitize_username_base(raw: str) -> str:
    """Strip non-alphanumeric chars from a display name to use as a username base."""
    cleaned = re.sub(r'[^A-Za-z0-9]', '', raw or "")
    if len(cleaned) < 3:
        cleaned = (cleaned + "user")[:3] if cleaned else "user"
    return cleaned[:16]  # leave room for a uniqueness suffix

async def _generate_unique_username(raw: str, db: AsyncSession) -> str:
    """Generate an alphanumeric, unique, length-bounded username from a raw display name."""
    base = _sanitize_username_base(raw)
    candidate = base
    for _ in range(5):
        stmt = select(User).where(func.lower(User.username) == candidate.lower())
        existing = await db.execute(stmt)
        if not existing.scalar_one_or_none():
            return candidate
        candidate = f"{base[:13]}{secrets.token_hex(3)}"  # stays alphanumeric, <=20 chars
    return secrets.token_hex(8)  # last resort, fully random

# ── FastAPI dependencies ────────────────────────────────────────────────────

async def require_session(request: Request, db: AsyncSession = Depends(get_db)) -> User:
    account = getattr(request.state, "account", None)
    if account:
        return account

    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(401, "Not logged in")
    user = await _resolve_session(token, db)
    if not user:
        raise HTTPException(401, "Session expired")
    return user

async def require_mod(user: User = Depends(require_session)) -> User:
    if user.id in ADMIN_IDS or user.id in OWNER_IDS:
        return user  # ADMIN_IDS and OWNER_IDS always bypass role checks
    if not user.is_moderator:
        raise HTTPException(403, "Moderator access required")
    return user

async def require_admin(user: User = Depends(require_session)) -> User:
    if user.id in ADMIN_IDS or user.id in OWNER_IDS:
        return user  # ADMIN_IDS and OWNER_IDS always bypass role checks
    if not user.is_admin:
        raise HTTPException(403, "Admin access required")
    return user

async def require_owner(user: User = Depends(require_session)) -> User:
    if user.id in OWNER_IDS or user.role == Role.OWNER:
        return user
    raise HTTPException(403, "Owner access required")


# ── Discord auth routes ─────────────────────────────────────────────────────

@router.get("/discord")
async def discord_login(mode: str = "login"):
    """
    mode="login": start a normal Discord login/signup flow (default).
    mode="link":  start a flow that links Discord to the CURRENTLY logged-in account.
    The intent is carried through the OAuth `state` param rather than inferred
    from cookie presence, so a stale session cookie can't hijack a login attempt
    into a link attempt (or vice versa).
    """
    state = "link" if mode == "link" else "login"
    return Response(status_code=302, headers={"Location": _discord_auth_url(state)})

@router.get("/discord/callback")
async def discord_callback(code: str, request: Request, response: Response,
                            state: str = "login", db: AsyncSession = Depends(get_db)):
    async with httpx.AsyncClient() as http:
        token_r = await http.post(
            "https://discord.com/api/oauth2/token",
            data={
                "client_id":     DISCORD_CLIENT_ID,
                "client_secret": DISCORD_CLIENT_SECRET,
                "grant_type":    "authorization_code",
                "code":          code,
                "redirect_uri":  DISCORD_REDIRECT_URI,
            },
        )
        if token_r.status_code != 200:
            raise HTTPException(400, f"Discord token exchange failed: {token_r.text}")

        access_token = token_r.json().get("access_token")

        user_r = await http.get(
            "https://discord.com/api/users/@me",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        if user_r.status_code != 200:
            raise HTTPException(400, "Failed to fetch Discord user")

        profile = user_r.json()

    discord_id = str(profile["id"])
    username   = profile.get("username", "unknown")
    avatar     = _discord_avatar_url(discord_id, profile.get("avatar", ""))
    email      = profile.get("email", "")
    verified   = profile.get("verified", False)

    if not verified or not email:
        raise HTTPException(400, "Discord account must have a verified email to login.")

    country = await _resolve_country(request)

    from fastapi.responses import RedirectResponse
    is_secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"

    # ── LINKING FLOW ─────────────────────────────────────────────────────────
    # Only entered when explicitly requested via mode=link; requires an
    # existing session. Never inferred from cookie presence alone.
    if state == "link":
        token = request.cookies.get(COOKIE_NAME)
        current_user = await _resolve_session(token, db) if token else None
        if not current_user:
            raise HTTPException(401, "You must be logged in to link a Discord account.")

        if current_user.discord_id == discord_id:
            return RedirectResponse(url="/", status_code=302)

        # Don't silently swap out an already-linked Discord account
        if current_user.discord_id and current_user.discord_id != discord_id:
            raise HTTPException(400, "Your account already has a different Discord account linked. Unlink it first.")

        # Count how many user accounts already have this Discord ID
        stmt = select(func.count(User.id)).where(User.discord_id == discord_id)
        existing_count = await db.scalar(stmt) or 0

        if existing_count >= 2:
            raise HTTPException(400, "This Discord account is already linked to 2 user accounts. Maximum reached.")

        user_row = await db.get(User, current_user.id)
        if not user_row:
            raise HTTPException(400, "User not found.")
        user_row.discord_id = discord_id
        if avatar:
            user_row.avatar = avatar
        await db.commit()

        from src.cache.user_registry import get_user
        cached = get_user(current_user.id)
        if cached is not None:
            cached.discord_id = discord_id
            if avatar:
                cached.avatar = avatar

        return RedirectResponse(url="/", status_code=302)

    # ── LOGIN / SIGNUP FLOW ──────────────────────────────────────────────────
    stmt = select(User).where(User.discord_id == discord_id).order_by(User.last_login.desc())
    result = await db.execute(stmt)
    users_with_discord = result.scalars().all()

    if not users_with_discord:
        # ── SIGNUP: no account is linked to this Discord ID yet ──

        new_username = await _generate_unique_username(username, db)
        user = User(discord_id=discord_id, google_id=None, username=new_username, email=email, avatar=avatar)
        if country:
            user.country = country
        db.add(user)
        await db.commit()
        await db.refresh(user)

    elif len(users_with_discord) > 1:
        # Multiple accounts share this Discord ID (legacy linking allowed up to 2) —
        # let the user pick which one to log in as.
        from src.redis_client.client import client as redis_client
        select_token = secrets.token_urlsafe(32)

        accounts_data = [
            {
                "id": u.id,
                "username": u.username,
                "avatar": u.avatar,
                "pixels_placed": await get_pixel_count(user_id=u.id),
                "last_login": u.last_login.isoformat() if u.last_login else None
            }
            for u in users_with_discord
        ]

        await redis_client.setex(
            f"discord_account_select:{select_token}",
            300,  # 5 minute TTL
            json.dumps({
                "discord_id": discord_id,
                "avatar": avatar,
                "country": country,
                "accounts": accounts_data
            })
        )

        return RedirectResponse(url=f"/select-account?token={select_token}", status_code=302)

    else:
        user = users_with_discord[0]

    # Single resolved account (fresh signup or single existing match) — log in.
    # NOTE: username is intentionally NOT synced from Discord — it would silently
    # overwrite a username the user has since chosen via /username.
    if avatar:
        user.avatar = avatar  # always prefer Discord avatar
    user.last_login = datetime.now(timezone.utc)

    # Enforce admin/owner role from ADMIN_IDS/OWNER_IDS env vars (game user IDs)
    if user.id in OWNER_IDS:
        user.role = Role.OWNER
    elif user.id in ADMIN_IDS:
        user.role = Role.ADMIN

    # Always refresh country from CF-IPCountry / IP detection
    if country:
        user.country = country

    await db.commit()
    await db.refresh(user)

    if user.role >= Role.TRIAL_MOD:
        from src.mod_log import log_mod_action
        ip = request.client.host if request.client else "unknown"
        country_display = country if country else "Unknown"
        await log_mod_action(
            user_id=user.id,
            username=user.username,
            action="login",
            details=f"Logged in from IP: {ip} (Country: {country_display})"
        )

    token = secrets.token_urlsafe(48)
    session = Session(
        token      = token,
        user_id    = user.id,
        expires_at = datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS),
    )
    db.add(session)
    await db.commit()

    await enforce_session_limit(db, user.id)

    resp = RedirectResponse(url="/", status_code=302)
    resp.set_cookie(COOKIE_NAME, token, max_age=SESSION_DAYS * 86400,
                    httponly=True, samesite="lax", secure=is_secure)
    print("successfully logged in via Discord")
    return resp

@router.get("/me")
async def me(request: Request, user: User = Depends(require_session),
             db: AsyncSession = Depends(get_db)):

    # Check online status from WebSocket connections
    try:
        online = user.id in clients_by_user
    except Exception:
        online = False

    # Apply admin/owner role from ADMIN_IDS/OWNER_IDS env vars immediately (no logout needed)
    # OWNER_IDS takes precedence over ADMIN_IDS
    effective_role = user.role
    if user.id in OWNER_IDS and effective_role != Role.OWNER:
        effective_role = Role.OWNER
        user.role = Role.OWNER
        db.add(user)
        await db.commit()
    elif user.id in ADMIN_IDS and user.id not in OWNER_IDS and effective_role != Role.ADMIN:
        effective_role = Role.ADMIN
        user.role = Role.ADMIN  # also persist it so DB stays in sync
        db.add(user)
        await db.commit()

    # Build google_accounts list from the user's own google_id field
    google_list = []
    if user.google_id:
        google_list = [{"google_id": user.google_id, "email": user.email}]

    from src.socket_server.chat.chat import get_chat_min_pixels

    return {
        "id":            user.id,
        "username":      user.username,
        "email":         user.email,
        "avatar":        user.avatar,
        "role":          effective_role.value,
        "discord_id":    user.discord_id,
        "google_id":     user.google_id,
        "bio":           user.bio or "",
        "country":       user.country or "",
        "pixels_placed": await get_pixel_count(user_id=user.id),  # Total across all canvases (canvas_id=-1 = global)
        "pixels_placed_daily": await get_pixel_count(user_id=user.id, daily=True), #
        "rank_alltime": await get_user_rank(user.id, daily=False),
        "rank_daily": await get_user_rank(user.id, daily=True),
        "chat_min_pixels": await get_chat_min_pixels(),
        "created_at":    user.created_at.isoformat(),
        "last_login":    user.last_login.isoformat() if user.last_login else None,
        "online":        online,
        "google_accounts": google_list,
        "allow_faction_invites": getattr(user, "allow_faction_invites", True),
        "show_in_invite_search": getattr(user, "show_in_invite_search", True),
    }

@router.patch("/profile")
async def update_profile(request: Request, db: AsyncSession = Depends(get_db),
                         user: User = Depends(require_session)):
    body = await request.json()
    if "bio" in body:
        user.bio = str(body["bio"])[:500]

    db.add(user)  # re-attaches the detached object to the current session
    await db.commit()
    return {"ok": True}

@router.post("/username")
async def set_username(request: Request, db: AsyncSession = Depends(get_db),
                        user: User = Depends(require_session)):
    """
    Set/change the authenticated user's username.
    Rules: alphanumeric only, 3-20 characters, case-insensitively unique.
    """
    body = await request.json()
    new_username = str(body.get("username", "")).strip()

    if not USERNAME_RE.match(new_username):
        raise HTTPException(400, "Username must be 3-20 characters, letters and numbers only.")

    stmt = select(User).where(
        func.lower(User.username) == new_username.lower(),
        User.id != user.id,
    )
    existing = await db.execute(stmt)
    if existing.scalar_one_or_none():
        raise HTTPException(400, "Username is already taken.")

    user.username = new_username
    db.add(user)
    await db.commit()
    return {"ok": True, "username": user.username}

@router.post("/logout")
async def logout(request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    token = request.cookies.get(COOKIE_NAME)
    if token:
        result = await db.execute(select(Session).where(Session.token == token))
        session = result.scalar_one_or_none()
        if session:
            await db.delete(session)
            await db.commit()
    is_secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    response.delete_cookie(COOKIE_NAME, httponly=True, samesite="lax", secure=is_secure)
    return {"ok": True}

# ── Helpers ─────────────────────────────────────────────────────────────────

def _normalize_country_code(value: str | None) -> str:
    """users.country is VARCHAR(2); only accept ISO country codes."""
    if not value:
        return ""
    code = str(value).strip().upper()
    if len(code) != 2 or not code.isalpha() or code == "XX":
        return ""
    return code

async def _detect_country(ip: str) -> str:
    if not ip or ip in ("127.0.0.1", "::1"):
        return ""
    try:
        async with httpx.AsyncClient(timeout=2) as http:
            # countryCode is the 2-letter ISO code; `country` is the full name
            # and overflows users.country (VARCHAR(2)), which caused 500s on login.
            r = await http.get(f"http://ip-api.com/json/{ip}?fields=countryCode")
            if r.status_code == 200:
                return _normalize_country_code(r.json().get("countryCode", ""))
    except Exception:
        pass
    return ""

async def _resolve_country(request: Request) -> str:
    cf = _normalize_country_code(request.headers.get("CF-IPCountry"))
    if cf:
        return cf
    client_ip = request.client.host if request.client else ""
    return await _detect_country(client_ip)

# ── Google Authentication routes ─────────────────────────────────────────────

def _google_auth_url(state: str = "login"):
    params = urlencode({
        "client_id":     GOOGLE_CLIENT_ID,
        "response_type": "code",
        "redirect_uri":  GOOGLE_REDIRECT_URI,
        "scope":         "openid email profile",
        "prompt":        "select_account",
        "state":         state,
    })
    return f"https://accounts.google.com/o/oauth2/v2/auth?{params}"

@router.get("/google")
async def google_login(mode: str = "login"):
    """
    mode="login": start a normal Google login/signup flow (default).
    mode="link":  start a flow that links Google to the CURRENTLY logged-in account.
    Same state-based intent pattern as Discord, so a stale session cookie can't
    misroute a signup attempt into a link attempt.
    """
    state = "link" if mode == "link" else "login"
    return Response(status_code=302, headers={"Location": _google_auth_url(state)})

@api_auth_router.get("/api/auth/google/callback")
async def google_callback(code: str, request: Request, response: Response,
                           state: str = "login", db: AsyncSession = Depends(get_db)):
    async with httpx.AsyncClient() as http:
        token_r = await http.post(
            "https://oauth2.googleapis.com/token",
            data={
                "client_id":     GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "grant_type":    "authorization_code",
                "code":          code,
                "redirect_uri":  GOOGLE_REDIRECT_URI,
            },
        )
        if token_r.status_code != 200:
            raise HTTPException(400, f"Google token exchange failed: {token_r.text}")

        tokens = token_r.json()
        access_token = tokens.get("access_token")

        user_r = await http.get(
            "https://www.googleapis.com/oauth2/v3/userinfo",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        if user_r.status_code != 200:
            raise HTTPException(400, "Failed to fetch Google user info")

        profile = user_r.json()

    google_id = str(profile["sub"])
    email = profile.get("email", "")
    email_verified = profile.get("email_verified", False)
    username = profile.get("name", "unknown")
    avatar = profile.get("picture", "")

    if not email_verified or not email:
        raise HTTPException(400, "Google account must have a verified email to login.")

    country = await _resolve_country(request)

    from fastapi.responses import RedirectResponse
    is_secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"

    # ── LINKING FLOW ─────────────────────────────────────────────────────────
    # Only entered when explicitly requested via mode=link; requires an
    # existing session. Never inferred from cookie presence alone.
    if state == "link":
        token = request.cookies.get(COOKIE_NAME)
        current_user = await _resolve_session(token, db) if token else None
        if not current_user:
            raise HTTPException(401, "You must be logged in to link a Google account.")

        # Check if this google_id is already tied to a DIFFERENT user
        stmt_existing = select(User).where(User.google_id == google_id)
        res_existing = await db.execute(stmt_existing)
        owner = res_existing.scalar_one_or_none()

        if owner and owner.id != current_user.id:
            raise HTTPException(400, "This Google account is already linked to another user.")

        # Don't silently swap out an already-linked Google account
        if current_user.google_id and current_user.google_id != google_id:
            raise HTTPException(400, "Your account already has a different Google account linked. Unlink it first.")

        # Set / update the google_id on the current user
        current_user.google_id = google_id
        current_user.email = email        # keep email in sync
        # Google avatar is never used as pfp
        await db.commit()
        return RedirectResponse(url="/", status_code=302)

    # ── LOGIN / SIGNUP FLOW ──────────────────────────────────────────────────
    # Look for existing user with this google_id
    stmt = select(User).where(User.google_id == google_id)
    res = await db.execute(stmt)
    user = res.scalar_one_or_none()

    # If no google_id match, check for email match (for migrated accounts)
    if not user:
        stmt_email = select(User).where(User.email == email, User.google_id == None)
        res_email = await db.execute(stmt_email)
        user = res_email.scalar_one_or_none()

        if user:
            # Found a migrated account with matching email - link it
            user.google_id = google_id
            # Google avatar is never used as pfp
            user.last_login = datetime.now(timezone.utc)
            if country:
                user.country = country
            await db.commit()
            await db.refresh(user)
            print(f"[Google Login] Linked google_id {google_id} to existing user {user.id} ({user.username}) via email match")

    if not user:
        # Hard safety net: block creating a duplicate account if this email is
        # already bound to ANY account (e.g. one already linked to a different
        # Google ID, or signed up via Discord-with-this-email previously).
        stmt_email_conflict = select(User).where(User.email == email)
        conflict = (await db.execute(stmt_email_conflict)).scalar_one_or_none()
        if conflict:
            raise HTTPException(
                400,
                "An account with this email already exists. Log in with Discord and link this Google account from your profile instead."
            )

        # New registration (Google avatar is never used as pfp)
        new_username = await _generate_unique_username(username, db)
        user = User(discord_id=None, google_id=google_id, username=new_username, email=email, avatar=None)
        if country:
            user.country = country
        db.add(user)
        await db.commit()
        await db.refresh(user)
    else:
        # Existing user — update info (never touch username here)
        user.last_login = datetime.now(timezone.utc)
        # Google avatar is never used as pfp
        if country:
            user.country = country
        await db.commit()

    token = secrets.token_urlsafe(48)
    session = Session(
        token      = token,
        user_id    = user.id,
        expires_at = datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS),
    )
    db.add(session)
    await db.commit()

    await enforce_session_limit(db, user.id)

    resp = RedirectResponse(url="/", status_code=302)
    resp.set_cookie(COOKIE_NAME, token, max_age=SESSION_DAYS * 86400,
                    httponly=True, samesite="lax", secure=is_secure)
    print("successfully logged in via Google")
    return resp

@router.post("/discord/unlink")
async def discord_unlink(request: Request, db: AsyncSession = Depends(get_db), user: User = Depends(require_session)):
    """Unlink Discord account from the current user.
    Requires Google to be linked first, otherwise the user would have no login method
    (since Discord-only signup is now allowed, this guard is now necessary).
    """
    if not user.discord_id:
        raise HTTPException(400, "No Discord account linked")

    if not user.google_id:
        raise HTTPException(400, "Cannot unlink Discord while Google is not linked, you would lose access to your account.")

    user.discord_id = None
    await db.commit()
    return {"ok": True}


@router.get("/select-account/data")
async def get_account_selection_data(token: str):
    """Get account selection data for Discord login with multiple accounts."""
    from src.redis_client.client import client as redis_client

    key = f"discord_account_select:{token}"
    data = await redis_client.get(key)

    if not data:
        raise HTTPException(400, "Invalid or expired token. Please log in again.")

    return json.loads(data)


@router.post("/select-account/choose")
async def choose_account(request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    """Complete Discord login by choosing an account."""
    from src.redis_client.client import client as redis_client

    body = await request.json()
    token = body.get("token")
    user_id = int(body.get("user_id"))

    key = f"discord_account_select:{token}"
    data = await redis_client.get(key)

    if not data:
        raise HTTPException(400, "Invalid or expired token. Please log in again.")

    selection_data = json.loads(data)

    # Verify the user_id is in the allowed accounts
    allowed_ids = [acc["id"] for acc in selection_data["accounts"]]
    if user_id not in allowed_ids:
        raise HTTPException(403, "Invalid account selection")

    # Get the user
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")

    # Update avatar/login metadata from Discord — username is intentionally
    # left untouched so the account keeps whatever name its owner chose.
    raw_sel_avatar = selection_data.get("avatar", "")
    if raw_sel_avatar:
        user.avatar = raw_sel_avatar  # already a CDN URL (converted before redis store)
    user.last_login = datetime.now(timezone.utc)

    # Enforce admin/owner role from ADMIN_IDS/OWNER_IDS env vars
    if user.id in OWNER_IDS:
        user.role = Role.OWNER
    elif user.id in ADMIN_IDS:
        user.role = Role.ADMIN

    # Update country
    country = _normalize_country_code(selection_data.get("country"))
    if country:
        user.country = country

    await db.commit()
    await db.refresh(user)

    # Create session
    session_token = secrets.token_urlsafe(48)
    session = Session(
        token=session_token,
        user_id=user.id,
        expires_at=datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS),
    )
    db.add(session)
    await db.commit()

    await enforce_session_limit(db, user.id)

    # Delete the selection token
    await redis_client.delete(key)

    # Set cookie
    is_secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    response.set_cookie(COOKIE_NAME, session_token, max_age=SESSION_DAYS * 86400,
                       httponly=True, samesite="lax", secure=is_secure)

    return {"ok": True}


@router.post("/google/unlink")
async def google_unlink(request: Request, db: AsyncSession = Depends(get_db), user: User = Depends(require_session)):
    """Unlink / clear Google account from the current user.
    Requires Discord to be linked first, otherwise the user would have no login method.
    """
    if not user.google_id:
        raise HTTPException(400, "No Google account linked")

    if not user.discord_id:
        raise HTTPException(400, "Cannot unlink Google while Discord is not linked, you would lose access to your account.")

    user.google_id = None
    await db.commit()
    return {"ok": True}

@router.post("/delete-account")
async def delete_account(request: Request, response: Response, db: AsyncSession = Depends(get_db), user: User = Depends(require_session)):
    """
    Permanently delete the authenticated user's account.
    This removes:
    - User record from SQL (cascades to sessions, messages, bans, flair)
    - Pixel counts from all Redis leaderboards
    - Anonymizes pixel placement history (sets user_id to NULL)
    - All IP and session associations

    This action is irreversible.
    Banned or muted accounts cannot self-delete.
    """
    from src.sql.models import PixelPlacement, IPUserPair, SessionUserPair, UserFlair, Session
    from src.redis_client.client import client as redis_client
    from src.redis_client.keys import RedisKeys
    from src.canvases import canvases
    from datetime import datetime, timezone
    from sqlalchemy import update
    from src.sql.ban import is_banned
    from src.socket_server.chat.chat import is_muted

    user_id = user.id

    if await is_banned(db, user_id):
        raise HTTPException(403, "Banned accounts cannot be deleted")
    if await is_muted(user_id):
        raise HTTPException(403, "Muted accounts cannot be deleted")

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

    # 5.5 Handle Faction ownership / membership cleanly before user deletion
    try:
        from src.sql.models import Faction, FactionMember, FactionInvite, FactionAnnouncement
        from sqlalchemy import select, desc

        # Check if user owns a faction
        owned_factions = (await db.scalars(select(Faction).where(Faction.owner_id == user_id))).all()
        for f in owned_factions:
            other_members = (await db.scalars(
                select(FactionMember)
                .where(FactionMember.faction_id == f.id, FactionMember.user_id != user_id)
                .order_by(desc(FactionMember.role), FactionMember.joined_at)
            )).all()

            if other_members:
                new_owner = other_members[0]
                new_owner.role = 4
                f.owner_id = new_owner.user_id
            else:
                await db.delete(f)

        # Delete any pending invites sent by or sent to this user
        await db.execute(
            FactionInvite.__table__.delete().where(
                (FactionInvite.user_id == user_id) | (FactionInvite.invited_by_id == user_id)
            )
        )
        # Delete user membership
        await db.execute(
            FactionMember.__table__.delete().where(FactionMember.user_id == user_id)
        )
    except Exception as e:
        print(f"[delete_account] Faction cleanup note: {e}")

    # 6. Delete the user record (CASCADE will handle: sessions, messages, bans)
    await db.delete(user)

    await db.commit()

    # 8. Clear the session cookie
    is_secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    response.delete_cookie(COOKIE_NAME, httponly=True, samesite="lax", secure=is_secure)

    # 9. Disconnect any active WebSocket connections for this user
    try:
        if user_id in clients_by_user:
            for client in list(clients_by_user[user_id]):
                await client.socket.close(code=1000, reason="Account deleted")
    except Exception as e:
        # Non-critical - just log and continue
        print(f"[delete_account] Failed to close WebSocket connections: {e}")

    return {"ok": True, "message": "Account permanently deleted"}