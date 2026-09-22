import asyncio
from PIL import Image
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import uvicorn

from fastapi import FastAPI
from src.canvases import load_canvases
from src.routes.routes import router as core_router
from starlette.middleware.gzip import GZipMiddleware
from src.middleware import AccountHTTPMiddleware
from src.redis_client.leaderboards import _init_loop as lb_cache_schedulers
from src.socket_server.server import loop as ws_loop
from src.sql.pixel_log import pixel_log_loop
from src.sql.db import engine, ensure_database_exists
from src.sql.models import Base, Ban, BanEntry
from src.tiles import tile_scheduler
from src.void_event import void_loop, get_void
from sqlalchemy import select


async def _cleanup_expired_bans_startup():
    """
    Background task that runs on startup to deactivate expired bans
    that are still marked as active. This prevents users from appearing
    banned after server restart when their bans have already expired.
    """
    try:
        from src.sql.db import AsyncSessionLocal
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(BanEntry, Ban)
                .join(Ban, Ban.id == BanEntry.ban_id)
                .where(
                    BanEntry.active == True,
                    Ban.expires_at.isnot(None),
                    Ban.expires_at < datetime.now(timezone.utc)
                )
            )
            
            expired_entries = []
            for entry, ban in result:
                expired_entries.append(entry)
            
            if expired_entries:
                print(f"[STARTUP] Found {len(expired_entries)} expired bans still marked as active. Cleaning up...")
                for entry in expired_entries:
                    entry.active = False
                await session.commit()
                print(f"[STARTUP] ✅ Cleaned up {len(expired_entries)} expired ban entries")
            else:
                print("[STARTUP] ✅ No expired bans to clean up")
    except Exception as e:
        print(f"[STARTUP] ⚠️ Failed to cleanup expired bans: {e}")
        import traceback
        traceback.print_exc()

#app startup i think
@asynccontextmanager
async def lifespan(app: FastAPI):
    await ensure_database_exists()
    from src.auth import ADMIN_IDS, OWNER_IDS
    print(f"[STARTUP DEBUG] ADMIN_IDS={ADMIN_IDS}, OWNER_IDS={OWNER_IDS}")

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        try:
            await conn.execute(__import__("sqlalchemy").text("ALTER TABLE chat_messages ADD COLUMN channel VARCHAR(20) NOT NULL DEFAULT 'ENG';"))
        except Exception:
            pass
        try:
            await conn.execute(__import__("sqlalchemy").text("ALTER TABLE ip_pair ADD COLUMN first_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;"))
        except Exception:
            pass
        try:
            await conn.execute(__import__("sqlalchemy").text("ALTER TABLE ip_pair ADD COLUMN last_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;"))
        except Exception:
            pass
        try:
            await conn.execute(__import__("sqlalchemy").text("ALTER TABLE users ADD COLUMN discord_username VARCHAR(64) NULL;"))
        except Exception:
            pass
        # One-shot schema migrations — leave commented once applied; MODIFY is
        # not a no-op on matching columns and locks `users` on every restart.
        # await conn.execute(__import__("sqlalchemy").text("ALTER TABLE users MODIFY discord_id VARCHAR(32) NULL;"))
        # await conn.execute(__import__("sqlalchemy").text("ALTER TABLE users MODIFY avatar VARCHAR(255) NULL;"))
        # try:
        #     await conn.execute(__import__("sqlalchemy").text("ALTER TABLE users DROP INDEX discord_id;"))
        # except Exception:
        #     pass
        # try:
        #     await conn.execute(__import__("sqlalchemy").text("CREATE INDEX idx_users_discord_id ON users (discord_id);"))
        # except Exception:
        #     pass
        # try:
        #     await conn.execute(__import__("sqlalchemy").text("ALTER TABLE users ADD COLUMN google_id VARCHAR(255) NULL UNIQUE;"))
        # except Exception:
        #     pass
        # try:
        #     await conn.execute(__import__("sqlalchemy").text("ALTER TABLE users MODIFY google_id VARCHAR(255) NULL;"))
        # except Exception:
        #     pass

    # Load canvas configs persisted by the admin API
    await load_canvases()

    # Cleanup expired bans that are still marked as active (data hygiene)
    asyncio.create_task(_cleanup_expired_bans_startup())

    #loops, cancel later
    pixel_task = asyncio.create_task(pixel_log_loop())
    ws_task = asyncio.create_task(ws_loop())
    
    from src.socket_server.nsws import nsws_loop
    nsws_task = asyncio.create_task(nsws_loop())
    
    from src.socket_server.mcws import mcws_loop
    mcws_task = asyncio.create_task(mcws_loop())

    asyncio.create_task(lb_cache_schedulers())
    asyncio.create_task(tile_scheduler())

    # ── Void event ────────────────────────────────────────────────
    async def _void_broadcast(state: dict):
        """Send void state to all connected WS clients."""
        from src.socket_server.server import clients
        from src.socket_server.packets import serialize_void_state
        pkt = serialize_void_state(state)
        for c in clients:
            asyncio.create_task(c.socket.send_text(pkt))

    get_void()._broadcast_void_state_cb = _void_broadcast
    asyncio.create_task(void_loop())

    #asyncio.create_task(preview_loop())

    try:
        yield
    finally:
        for task in (pixel_task, ws_task, nsws_task, mcws_task):
            task.cancel()

app = FastAPI(lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=500)
app.add_middleware(AccountHTTPMiddleware)

#routers
from src.auth import router as auth_router, api_auth_router
from src.admin import router as admin_router
from src.flair import router as flair_router
from src.stats import router as stats_router
from src.history import router as history_router, CachedHistoryFiles, HISTORY_DIR
app.include_router(auth_router, prefix="/auth")
app.include_router(api_auth_router)
app.include_router(admin_router)
app.include_router(flair_router)
app.include_router(stats_router)
app.include_router(history_router)
app.include_router(core_router)

# ── Cloudflare Zero Trust device-binding (optional) ──────────────────────────
# Set CF_ZERO_TRUST_ENABLED=true in .env to activate.  When false (default)
# neither the protection routes nor the error pages are registered.
from src.cf_protection import CF_ENABLED as _CF_ENABLED
if _CF_ENABLED:
    from src.cf_protection import router as cf_router
    from src.cf_error_pages import router as cf_error_router
    app.include_router(cf_router,       prefix="/auth/cf")
    app.include_router(cf_error_router)   # serves /cf-blocked, /cf-verify, etc.
    import logging as _logging
    _logging.getLogger(__name__).info("Cloudflare Zero Trust device-binding ENABLED")


from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi import HTTPException
import os
import mimetypes

_upload_dir = os.path.join(os.getcwd(), "uploads")
os.makedirs(os.path.join(_upload_dir, "factions", "logos"), exist_ok=True)
os.makedirs(os.path.join(_upload_dir, "factions", "templates"), exist_ok=True)
os.makedirs(os.path.join(_upload_dir, "avatars"), exist_ok=True)

@app.get("/uploads/{file_path:path}")
async def serve_upload_file(file_path: str):
    search_paths = [
        os.path.join(os.getcwd(), "uploads", file_path),
        os.path.join(os.getcwd(), "uploads", "factions", file_path),
        os.path.join(os.getcwd(), "uploads", "factions", "logos", os.path.basename(file_path)),
        os.path.join(os.getcwd(), "uploads", "factions", "templates", os.path.basename(file_path)),
        os.path.join(os.getcwd(), "uploads", "avatars", os.path.basename(file_path)),
        os.path.join(os.getcwd(), "frontend", "dist", "uploads", file_path),
        os.path.join(os.getcwd(), "dist", "uploads", file_path),
    ]
    for path in search_paths:
        if os.path.exists(path) and os.path.isfile(path):
            media_type, _ = mimetypes.guess_type(path)
            return FileResponse(path, media_type=media_type or "application/octet-stream")
    raise HTTPException(status_code=404, detail="Upload file not found")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=5001)