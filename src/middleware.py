from fastapi import Request, WebSocket
from starlette.middleware.base import BaseHTTPMiddleware

from src.sql.db import AsyncSessionLocal
from src.sql.models import User, Session
from src.sql.db import AsyncSession
from datetime import datetime, timezone
from src.cache.user_registry import get_user, register_user
from sqlalchemy import select

COOKIE_NAME = "pm_session"

async def _resolve_session(token: str, db: AsyncSession) -> User | None:
    stmt = (
        select(Session)
        .where(Session.token == token)
        .where(Session.expires_at > datetime.now(timezone.utc))
    )
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()
    if not session:
        return None

    # Return the canonical shared instance if we have one
    cached = get_user(session.user_id)
    if cached is not None:
        return cached

    # Otherwise fetch from DB and register it
    u = await db.get(User, session.user_id)
    if u:
        await db.refresh(u)   # eagerly load everything now
        db.expunge(u)
        return register_user(u)
    return None

async def get_user_from_cookie(token: str, db: AsyncSession) -> User | None:
    return await _resolve_session(token, db)

async def resolve_account_from_token(token: str | None) -> User | None:
	if not token:
		return None

	try:
		async with AsyncSessionLocal() as db:
			return await get_user_from_cookie(token, db)
	except Exception:
		# Keep requests anonymous if account lookup fails.
		return None


class AccountHTTPMiddleware(BaseHTTPMiddleware):
	async def dispatch(self, request: Request, call_next):
		# Run Cloudflare Zero Trust device check if enabled.
		# Doing a local import to prevent circular import loops.
		from src.cf_protection import cf_middleware_check, CF_ENABLED
		if CF_ENABLED:
			cf_response = await cf_middleware_check(request)
			if cf_response is not None:
				cf_response.headers["X-Frame-Options"]           = "DENY"
				cf_response.headers["X-Content-Type-Options"]     = "nosniff"
				cf_response.headers["Referrer-Policy"]            = "strict-origin-when-cross-origin"
				cf_response.headers["X-XSS-Protection"]           = "1; mode=block"
				cf_response.headers["Permissions-Policy"]         = "geolocation=(), microphone=(), camera=()"
				return cf_response

		request.state.account = await resolve_account_from_token(
			request.cookies.get(COOKIE_NAME)
		)
		response = await call_next(request)

		# Attach new cf cookie if set by cf_middleware_check
		if CF_ENABLED:
			new_token = getattr(request.state, "_cf_new_device_token", None)
			if new_token:
				from src.cf_protection import CF_DEVICE_COOKIE, _is_secure
				response.set_cookie(
					CF_DEVICE_COOKIE,
					new_token,
					max_age=31536000,  # 1 year
					httponly=True,
					secure=_is_secure(request),
					samesite="lax",
				)

		# Security headers
		response.headers["X-Frame-Options"]           = "DENY"
		response.headers["X-Content-Type-Options"]     = "nosniff"
		response.headers["Referrer-Policy"]            = "strict-origin-when-cross-origin"
		response.headers["X-XSS-Protection"]           = "1; mode=block"
		response.headers["Permissions-Policy"]         = "geolocation=(), microphone=(), camera=()"
		return response


async def attach_account_to_websocket(websocket: WebSocket):
	websocket.state.account = await resolve_account_from_token(
		websocket.cookies.get(COOKIE_NAME)
	)
	return websocket.state.account

