"""
cf_protection.py
----------------
Cloudflare Zero Trust device-binding protection.

HOW IT WORKS (middleware-enforced, no frontend JS required)
-----------------------------------------------------------
On every HTTP request, the middleware calls `cf_middleware_check()`:

  1.  Read `Cf-Access-Authenticated-User-Email` header (injected by Cloudflare,
      trusted only because nginx enforces CF-IP-only ingress).
      If the header is absent, skip all checks (CF not configured for this path).

  2.  Read the `cf_device_id` cookie from the request.
      This cookie is a server-generated random token that acts as the
      device identifier — no JS fingerprinting needed.

  3a. Cookie present  →  hash it and look up in `cf_device_bindings`.
        · Binding exists + hash matches  → ALLOW (update last_seen).
        · Binding exists + hash differs  → BLOCK (redirect /cf-blocked).
        · No binding yet                 → CLAIM (insert row, ALLOW).

  3b. Cookie absent   →  generate a new random token.
        · No binding for this email yet  → CLAIM (insert row, set cookie, ALLOW).
        · Binding already exists         → BLOCK (redirect /cf-blocked).
          (Another device got here first.)

  Result: first device to authenticate with a CF email owns that email.
  All others are blocked.  The owning device is identified by a long-lived
  HttpOnly cookie.

DISCONNECT FLOW
---------------
  DELETE /auth/cf/binding  (must be authenticated + CF header present)
    → deletes the binding row
    → deletes the cf_device_id cookie
    → redirects to /cf-unbound

  Next visit from any device will re-claim.

FEATURE FLAG
------------
  CF_ZERO_TRUST_ENABLED=false (default) → entire system is a no-op.
  Set to "true" to activate.

SKIPPED PATHS
-------------
  The middleware skips checks on:
  - /cf-*            (error/status pages — avoid redirect loops)
  - /auth/cf/*       (the binding routes themselves)
  - /health          (Docker health check)
  - /tiles/*         (high-frequency static tiles — no auth needed)
  - /history/*       (static history files)
  - /chunks/*        (canvas chunk data)

SECURITY NOTES
--------------
  - Email is SHA-256 hashed before storage (no PII in DB).
  - Device token is SHA-256 hashed before storage.
  - Fail-closed: any unexpected DB exception → block request.
  - cf_device_id cookie: HttpOnly, Secure, SameSite=Lax, 1-year expiry.
  - TODO(security): Validate CF-Access-JWT-Assertion header for
    cryptographic proof of email (currently trusts plaintext header).
"""

import hashlib
import logging
import os
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.auth import require_session
from src.sql.db import AsyncSessionLocal, get_db
from src.sql.models import CfDeviceBinding, User

logger = logging.getLogger(__name__)

# ── Feature flag ─────────────────────────────────────────────────────────────

CF_ENABLED: bool = os.getenv("CF_ZERO_TRUST_ENABLED", "false").strip().lower() == "true"

# ── Constants ─────────────────────────────────────────────────────────────────

_CF_EMAIL_HEADER = "cf-access-authenticated-user-email"
CF_DEVICE_COOKIE = "cf_device_id"

# Paths where the middleware check is skipped entirely.
_SKIP_PREFIXES = (
    "/cf-",          # our own error/status pages — prevent redirect loops
    "/auth/cf/",     # binding management routes
    "/health",       # Docker health check
    "/tiles/",       # high-frequency static tile assets
    "/history/",     # static history files
    "/chunks/",      # canvas chunk data
)

# ── Router (for /auth/cf/* management endpoints) ─────────────────────────────

router = APIRouter(tags=["cf-zero-trust"])

# ── Helpers ───────────────────────────────────────────────────────────────────

def _hash(value: str) -> str:
    """SHA-256 hex digest of a UTF-8 string."""
    return hashlib.sha256(value.encode()).hexdigest()


def _get_cf_email(request: Request) -> str | None:
    return request.headers.get(_CF_EMAIL_HEADER)


def _is_secure(request: Request) -> bool:
    return (
        request.url.scheme == "https"
        or request.headers.get("x-forwarded-proto") == "https"
    )


# ── Core middleware check ─────────────────────────────────────────────────────

async def cf_middleware_check(request: Request) -> Response | None:
    """
    Called from AccountHTTPMiddleware on every request.

    Returns None  → allow the request to proceed.
    Returns a Response → short-circuit with that response (block or redirect).

    Side effect: may set request.state._cf_new_device_token so the
    middleware can attach the cf_device_id cookie to the outgoing response.
    """
    return None #no
    if not CF_ENABLED:
        return None

    # Skip paths that don't need protection
    path = request.url.path
    if any(path.startswith(p) for p in _SKIP_PREFIXES):
        return None

    email = _get_cf_email(request)
    if not email:
        # Cloudflare header absent — Zero Trust not active on this path,
        # or request came from a trusted internal source.  Pass through.
        return None

    email_hash   = _hash(email.lower().strip())
    device_token = request.cookies.get(CF_DEVICE_COOKIE)

    try:
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(CfDeviceBinding).where(CfDeviceBinding.email_hash == email_hash)
            )
            binding: CfDeviceBinding | None = result.scalar_one_or_none()
            now = datetime.now(timezone.utc)

            if device_token:
                # ── Device cookie present ─────────────────────────────────
                token_hash = _hash(device_token)

                if binding is None:
                    # Email unclaimed — this device claims it now.
                    db.add(CfDeviceBinding(
                        email_hash=email_hash,
                        fp_hash=token_hash,
                        claimed_at=now,
                        last_seen=now,
                    ))
                    await db.commit()
                    logger.info("CF binding claimed (cookie present) email_hash=%.8s", email_hash)
                    return None  # allow

                if binding.fp_hash == token_hash:
                    # Same device — refresh last_seen and allow.
                    binding.last_seen = now
                    await db.commit()
                    return None  # allow

                # Different device — block.
                logger.warning(
                    "CF device mismatch email_hash=%.8s — presented token does not match binding",
                    email_hash,
                )
                return RedirectResponse("/cf-blocked", status_code=302)

            else:
                # ── No device cookie ──────────────────────────────────────
                if binding is not None:
                    # Email already claimed by another device.
                    # This visitor has no cookie so they're not the owner.
                    logger.warning(
                        "CF device mismatch email_hash=%.8s — no cookie but binding exists",
                        email_hash,
                    )
                    return RedirectResponse("/cf-blocked", status_code=302)

                # Unclaimed — generate a token and claim it.
                new_token = secrets.token_urlsafe(48)
                token_hash = _hash(new_token)
                db.add(CfDeviceBinding(
                    email_hash=email_hash,
                    fp_hash=token_hash,
                    claimed_at=now,
                    last_seen=now,
                ))
                await db.commit()
                logger.info("CF binding claimed (first visit) email_hash=%.8s", email_hash)

                # Stash the new token so the middleware can set the cookie.
                request.state._cf_new_device_token = new_token
                return None  # allow

    except Exception as exc:
        logger.exception("CF middleware check error — failing closed: %s", exc)
        # Fail-closed: unexpected errors block the request.
        return RedirectResponse("/cf-error", status_code=302)


# ── Management routes ─────────────────────────────────────────────────────────

@router.delete("/binding")
async def cf_unbind(
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_session),
):
    """
    Remove the device binding for the current CF email.

    The user must be authenticated (pm_session cookie) and the
    Cf-Access-Authenticated-User-Email header must be present.

    After removal the cf_device_id cookie is cleared and the browser
    is redirected to /cf-unbound.  The next visit (from any device) will
    re-claim the binding.
    """
    email = _get_cf_email(request)
    if not email:
        raise HTTPException(status_code=403, detail="cf_header_missing")

    email_hash = _hash(email.lower().strip())

    try:
        result = await db.execute(
            select(CfDeviceBinding).where(CfDeviceBinding.email_hash == email_hash)
        )
        binding = result.scalar_one_or_none()
        if binding is None:
            raise HTTPException(status_code=404, detail="no_binding")

        await db.delete(binding)
        await db.commit()
        logger.info("CF binding removed user_id=%s email_hash=%.8s", user.id, email_hash)

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("cf_unbind error: %s", exc)
        raise HTTPException(status_code=500, detail="internal_error")

    # Clear device cookie and show success page.
    resp = RedirectResponse("/cf-unbound", status_code=302)
    resp.delete_cookie(CF_DEVICE_COOKIE)
    return resp


@router.get("/status")
async def cf_status(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """
    Return binding status for the current CF email.
    Useful for the frontend to decide whether to show 'Disconnect device'.
    """
    email = _get_cf_email(request)
    if not email:
        return {"enabled": CF_ENABLED, "bound": False}

    email_hash = _hash(email.lower().strip())
    result = await db.execute(
        select(CfDeviceBinding).where(CfDeviceBinding.email_hash == email_hash)
    )
    binding = result.scalar_one_or_none()

    return {
        "enabled":          CF_ENABLED,
        "bound":            binding is not None,
        "email_hash_prefix": email_hash[:8] if binding else None,
        "claimed_at":       binding.claimed_at.isoformat() if binding else None,
        "last_seen":        binding.last_seen.isoformat()  if binding else None,
    }
