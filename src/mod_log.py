import asyncio
import json
import os
import re
import time
from datetime import datetime, timezone
import httpx
from src.redis_client.client import client as redis_client
from src.canvases import canvases


def _get_action_color(action: str) -> int:
    act = (action or "").lower()
    if "ban" in act or "kick" in act:
        return 0xE74C3C  # Red
    if "unban" in act or "pardon" in act or "unmute" in act:
        return 0x2ECC71  # Green
    if "rollback" in act or "replace" in act:
        return 0x9B59B6  # Purple
    if "protect" in act:
        return 0x1ABC9C  # Turquoise
    if "announce" in act:
        return 0xF1C40F  # Gold
    if "purge" in act:
        return 0xE67E22  # Burnt Orange
    if "void" in act:
        return 0x34495E  # Dark slate
    if "chat" in act or "mute" in act or "warn" in act:
        return 0xF39C12  # Orange
    return 0x3498DB      # Blue


def _get_site_info(request=None, host: str | None = None) -> tuple[str, str, str, str, bool]:
    """
    Returns (domain, site_label, site_badge, site_key, is_main).
    Clarifies whether the action took place on pixmap.fun (main site) or dev.pixmap.fun (test site).
    """
    if not host and request:
        try:
            host = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
            host = host.split(":")[0].strip().lower()
            if not host or "127.0.0.1" in host or "localhost" in host:
                ref = request.headers.get("referer") or request.headers.get("origin") or ""
                if "pixmap.fun" in ref:
                    host = "dev.pixmap.fun" if "dev." in ref else "pixmap.fun"
        except Exception:
            host = ""

    if not host or "127.0.0.1" in host or "localhost" in host:
        redirect_uri = os.getenv("DISCORD_REDIRECT_URI", "")
        if "dev.pixmap.fun" in redirect_uri:
            host = "dev.pixmap.fun"
        elif "pixmap.fun" in redirect_uri:
            host = "pixmap.fun"
        else:
            host = "pixmap.fun"

    is_main = host == "pixmap.fun" or (not host.startswith("dev.") and "pixmap.fun" in host)
    if is_main:
        domain = "pixmap.fun"
        site_label = "pixmap.fun (Main Site)"
        site_badge = "🟢 **pixmap.fun** *(Main Site)*"
        site_key = "main"
    else:
        domain = "dev.pixmap.fun"
        site_label = "dev.pixmap.fun (Test Site)"
        site_badge = "🟡 **dev.pixmap.fun** *(Test Site)*"
        site_key = "dev"

    return domain, site_label, site_badge, site_key, is_main


def _resolve_location(
    domain: str,
    canvas_id: int | None = None,
    x1: int | None = None,
    y1: int | None = None,
    x2: int | None = None,
    y2: int | None = None,
    zoom: int | None = None,
    details: str = "",
) -> tuple[str | None, str | None, int | None, int | None, int | None]:
    """
    Converts canvas + coordinates into a direct HUD navigation URL:
    https://{domain}/#{indent},{hud_x},{hud_y},{zoom}
    """
    # Auto-extract from details string if not provided directly
    if canvas_id is None:
        c_match = re.search(r"canvas\s+(\d+)", details, re.IGNORECASE)
        if c_match:
            canvas_id = int(c_match.group(1))

    if x1 is None or y1 is None:
        # Match "(x1, y1) to (x2, y2)" or "(x1, y1)-(x2, y2)"
        box_match = re.search(r"\((-?\d+),\s*(-?\d+)\)\s*(?:to|-)\s*\((-?\d+),\s*(-?\d+)\)", details)
        if box_match:
            x1 = int(box_match.group(1))
            y1 = int(box_match.group(2))
            x2 = int(box_match.group(3))
            y2 = int(box_match.group(4))
        else:
            pt_match = re.search(r"\((-?\d+),\s*(-?\d+)\)", details)
            if pt_match:
                x1 = int(pt_match.group(1))
                y1 = int(pt_match.group(2))

    if canvas_id is None or x1 is None or y1 is None:
        return None, None, None, None, None

    c = canvases.get(canvas_id)
    indent = c.indent if c else "d"
    canvas_name = c.name if c else f"Canvas {canvas_id}"
    size = c.size if c else 256
    center = (size * 256) // 2

    if x2 is not None and y2 is not None:
        mid_x = (x1 + x2) // 2
        mid_y = (y1 + y2) // 2
        span = max(abs(x2 - x1), abs(y2 - y1))
        if zoom is None:
            zoom = 35 if span < 50 else (28 if span < 150 else (20 if span < 500 else 12))
    else:
        mid_x = x1
        mid_y = y1
        if zoom is None:
            zoom = 35

    hud_x = int(mid_x - center)
    hud_y = int(mid_y - center)
    url = f"https://{domain}/#{indent},{hud_x},{hud_y},{zoom}"
    return url, canvas_name, hud_x, hud_y, zoom


async def _send_discord_mod_log(
    user_id: int,
    username: str,
    action: str,
    details: str,
    ts: float,
    location_url: str | None = None,
    canvas_name: str | None = None,
    hud_x: int | None = None,
    hud_y: int | None = None,
    site_label: str = "pixmap.fun (Main Site)",
    site_badge: str = "🟢 **pixmap.fun** *(Main Site)*",
    is_main: bool = True,
):
    webhook_url = os.getenv("MOD_LOG_WEBHOOK_URL", "")
    if not webhook_url or not webhook_url.startswith("http"):
        return

    iso_time = datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
    color = _get_action_color(action)

    fields = [
        {
            "name": "Moderator",
            "value": f"**{username}** (`ID: {user_id}`)",
            "inline": True,
        },
        {
            "name": "Action",
            "value": f"`{action}`",
            "inline": True,
        },
        {
            "name": "Environment",
            "value": site_badge,
            "inline": True,
        },
    ]

    if location_url and canvas_name:
        fields.append({
            "name": "📍 Location",
            "value": f"[**Click to open on {site_label} →**]({location_url})\n`Canvas: {canvas_name}` · `HUD: ({hud_x}, {hud_y})`",
            "inline": False,
        })

    fields.append({
        "name": "Details",
        "value": str(details)[:1020] if details else "None",
        "inline": False,
    })

    embed = {
        "title": f"🛡️ Mod Action: `{action}`",
        "color": color,
        "fields": fields,
        "timestamp": iso_time,
        "footer": {
            "text": f"Pixmap Moderation Surveillance · {site_label}"
        },
    }

    if location_url:
        embed["url"] = location_url

    payload = {
        "username": "Pixmap Mod Logs",
        "embeds": [embed],
    }

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(webhook_url, json=payload)
            if resp.status_code not in (200, 204):
                print(f"[ModLog] Discord webhook returned {resp.status_code}: {resp.text}")
    except Exception as e:
        print(f"[ModLog] Discord webhook error: {e}")


async def log_mod_action(
    user_id: int,
    username: str,
    action: str,
    details: str,
    canvas_id: int | None = None,
    x1: int | None = None,
    y1: int | None = None,
    x2: int | None = None,
    y2: int | None = None,
    zoom: int | None = None,
    request=None,
    host: str | None = None,
    url: str | None = None,
):
    """Log mod/admin action in Redis list for auditing and forward to Discord with site info & clickable URL."""
    now = time.time()
    domain, site_label, site_badge, site_key, is_main = _get_site_info(request=request, host=host)

    if url:
        location_url = url
        canvas_name, hud_x, hud_y = None, None, None
    else:
        location_url, canvas_name, hud_x, hud_y, _ = _resolve_location(
            domain=domain,
            canvas_id=canvas_id,
            x1=x1,
            y1=y1,
            x2=x2,
            y2=y2,
            zoom=zoom,
            details=details,
        )

    log_entry = {
        "timestamp": now,
        "user_id": user_id,
        "username": username,
        "action": action,
        "details": details,
        "url": location_url,
        "site": site_key,
        "site_label": site_label,
        "canvas_id": canvas_id,
        "canvas_name": canvas_name,
        "hud_x": hud_x,
        "hud_y": hud_y,
    }
    try:
        await redis_client.lpush("mod_logs", json.dumps(log_entry))
        await redis_client.ltrim("mod_logs", 0, 999)
    except Exception as e:
        print(f"[ModLog] Error writing log: {e}")

    # Dispatch to Discord asynchronously without blocking
    try:
        asyncio.create_task(_send_discord_mod_log(
            user_id=user_id,
            username=username,
            action=action,
            details=details,
            ts=now,
            location_url=location_url,
            canvas_name=canvas_name,
            hud_x=hud_x,
            hud_y=hud_y,
            site_label=site_label,
            site_badge=site_badge,
            is_main=is_main,
        ))
    except Exception as e:
        print(f"[ModLog] Error scheduling discord log: {e}")


