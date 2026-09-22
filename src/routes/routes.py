from fastapi import APIRouter, Response
from fastapi.exceptions import HTTPException
from fastapi.websockets import WebSocket
from src.routes.api.routes import router as api_router

from src.canvases import canvases
from src.redis_client.client import client
from src.socket_server.server import on_new_connection

router = APIRouter()

@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await on_new_connection(websocket)

@router.websocket("/nsws")
async def nsws_endpoint(websocket: WebSocket, secret: str = ""):
    from src.socket_server.nsws import on_nsws_connection
    await on_nsws_connection(websocket, secret)

@router.websocket("/mcws")
async def mcws_endpoint(websocket: WebSocket, secret: str = ""):
    from src.socket_server.mcws import on_mcws_connection
    await on_mcws_connection(websocket, secret)

# for docker
@router.get("/health")
async def health_route():
    return {"status": "healthy"}

@router.get("/chunks/{canvas_id}/{x}/{y}")
@router.get("/chunks/{canvas_id}/{x}/{y}.bmp")
async def chunks_route(canvas_id: int, x: int, y: int):
    canvas = canvases.get(canvas_id)
    if canvas is None:
        raise HTTPException(status_code=404)

    if x < 0 or y < 0 or x >= canvas.size or y >= canvas.size:
        raise HTTPException(status_code=404)

    chunk_bytes = await client.get(f"ch:{canvas_id}:{x}:{y}") or b""
    return Response(
        content=chunk_bytes,
        media_type="application/octet-stream",
        headers={"Cache-Control": "public, max-age=30"},
    )

router.include_router(api_router, prefix="/api")