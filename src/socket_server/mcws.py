import asyncio
import time
import os
import traceback
from fastapi import WebSocket
from src.socket_server.clients import Client, clients
from src.socket_server.packets import serialize_online, serialize_cooldown, serialize_place_return, opcode, deserialize
from src.classes import Pixel
from src.sql.db import AsyncSessionLocal
from src.sql.ip import get_client_ip_info
from src.canvases import canvases
from src.socket_server.chunks import queue_pixels
from src.sql.pixel_log import log_pixels
from src.tiles import add_pixels_to_chunks
from src.admin import notify_watch_streams
from src.void_event import get_void
from datetime import datetime, timezone
import uuid

MCWS_SECRET = os.environ.get("MCWS_SECRET_KEY", "")

mcws_clients = set()

async def mcws_loop():
    """Cleanup loop for MCWS clients"""
    while True:
        for client in list(mcws_clients):
            if time.time() - client.last_ping > 60:
                try:
                    await client.socket.close(code=1000)
                except Exception:
                    pass
                if client in mcws_clients:
                    mcws_clients.discard(client)
        await asyncio.sleep(30)

async def on_mcws_connection(socket: WebSocket, secret: str):
    """Handle MCWS WebSocket connection with no cooldown, no account required"""
    print(f"[MCWS] Connection attempt with secret: {secret[:10]}...")
    
    if secret != MCWS_SECRET:
        print(f"[MCWS] Invalid secret, closing")
        await socket.close(code=4001)
        return
    
    print(f"[MCWS] Secret validated")
    
    try:
        # Generate session ID from cookie or create new one
        raw = socket.cookies.get("bid", "")
        try:
            session_id = str(uuid.UUID(raw))
        except ValueError:
            session_id = str(uuid.uuid4())
        
        print(f"[MCWS] Session ID: {session_id}")
        
        headers = []
        headers.append((b"set-cookie", f"bid={session_id}; HttpOnly; SameSite=Lax".encode()))
        
        await socket.accept(headers=headers)
        print(f"[MCWS] Socket accepted")
        
        # Create client without user (no account required for MCWS)
        client = Client(socket, None, session_id)
        print(f"[MCWS] Client object created, IP: {client.ip}")
        
        client.is_mcws = True
        client.is_proxy = False
        client.banned = False
        client.canvas = 0  # Default canvas
        
        async with AsyncSessionLocal() as session:
            await get_client_ip_info(session, client)
            await session.commit()
        
        print(f"[MCWS] IP info retrieved")
        
        client.on_open()
        mcws_clients.add(client)
        
        print(f"[MCWS] Client registered, sending initial messages")
        
        # Send initial messages (binary protocol)
        await client.socket.send_bytes(serialize_online(len(clients) + len(mcws_clients)))
        print(f"[MCWS] Sent online count")
        
        await client.socket.send_bytes(serialize_cooldown([]))
        print(f"[MCWS] Sent cooldown, entering message loop")
        
        try:
            while True:
                message = await socket.receive()
                
                if message["type"] == "websocket.disconnect":
                    print(f"[MCWS] Client disconnected normally")
                    break
                
                if "bytes" in message:
                    await on_mcws_binary(client, message["bytes"])
                elif "text" in message:
                    client.last_ping = time.time()
        except RuntimeError as e:
            if str(e) != 'Cannot call "send" once a close message has been sent.':
                print(f"[MCWS] RuntimeError: {e}")
                print(traceback.format_exc())
        except Exception as e:
            print(f"[MCWS] Exception in message loop: {e}")
            print(traceback.format_exc())
        finally:
            print(f"[MCWS] Cleaning up client")
            client.on_close()
            mcws_clients.discard(client)
    except Exception as e:
        print(f"[MCWS] Connection error: {e}")
        print(traceback.format_exc())
        try:
            await socket.close(code=1011)
        except:
            pass
    
    return None

async def on_mcws_binary(client, message):
    """Handle binary messages from MCWS client"""
    message = bytearray(message)
    client.last_ping = time.time()
    
    op, payload = deserialize(message)
    
    if op == opcode.PLACE:
        pixels = payload[0]
        if len(pixels) == 0:
            return
        
        pixels = pixels[:500]
        
        cx = pixels[0].cx
        cy = pixels[0].cy
        
        try:
            code, successful, ranked, new_cd, max_cd = await mcws_place(client, pixels)
        except Exception:
            print(traceback.format_exc())
            code, successful, ranked, new_cd, max_cd = 7, None, None, None, None
        
        await client.socket.send_bytes(serialize_place_return(cx, cy, code, successful, ranked, 0, 0))

async def mcws_place(client, pixels: list[Pixel]):
    """
    Place pixels without cooldown restrictions using mcws_place.lua script.
    Uses same BITFIELD format as normal place.lua for compatibility.
    """
    ip = client.ip
    canvas_id = client.canvas
    void = get_void()

    # No cooldown checks, no captcha, no proxy checks
    if client.banned:
        return 2, None, None, None, None

    chunks = {}
    canvas = canvases.get(canvas_id)
    if canvas is None:
        return 4, None, None, None, None

    # Group pixels by chunk
    for pixel in pixels:
        if pixel.cx < 0 or pixel.cy < 0 or pixel.cx >= canvas.size or pixel.cy >= canvas.size:
            continue
        if pixel.color < 0 or pixel.color >= len(canvas.colors):
            continue
        if void.is_pixel_blocked(canvas_id, pixel.x(), pixel.y()):
            continue
        key = (pixel.cx, pixel.cy)
        if key not in chunks:
            chunks[key] = {"pixels": []}
        chunks[key]["pixels"].append(pixel)

    all_placed_pixels = []

    # Use mcws_place.lua script (same BITFIELD format as place.lua)
    from src.redis_client.keys import RedisKeys
    from src.redis_client.client import scripts
    
    blocked_index = void.get_blocked_index(canvas_id) if void.phase == "active" else -1
    
    for key, queued_pixels in chunks.items():
        cx, cy = key
        chunk_key = RedisKeys.CHUNK.value.format(canvas_id=canvas_id, cx=cx, cy=cy)
        
        # Build script arguments: blocked_index, then (offset, color) pairs
        script_args = [blocked_index]
        for pixel in queued_pixels["pixels"]:
            script_args.append(pixel.offset)
            script_args.append(pixel.color)
        
        # Execute via Lua script (compatible with place.lua chunks)
        try:
            successful_offsets = await scripts["mcws_place"](keys=[chunk_key], args=script_args)
            
            # Filter to only successfully placed pixels
            offset_set = set(successful_offsets) if successful_offsets else set()
            placed = [p for p in queued_pixels["pixels"] if p.offset in offset_set]
            all_placed_pixels.extend(placed)
            
            if placed:
                await queue_pixels(canvas_id, cx, cy, placed, exclude_client=client)
                add_pixels_to_chunks(canvas_id, cx, cy, len(placed))
                log_pixels(client, placed)

                # Push to watch streams (no user info)
                try:
                    for pixel in placed:
                        notify_watch_streams(
                            canvas_id, pixel.x(), pixel.y(), None, ip, pixel.color,
                            username=None, avatar=None, discord_id=None, role=0
                        )
                except Exception:
                    pass
        except Exception as e:
            print(f"[MCWS] Error placing chunk ({cx},{cy}): {e}")
            print(traceback.format_exc())

    # Void damage processing
    if all_placed_pixels:
        try:
            if void.phase == "active":
                for pixel in all_placed_pixels:
                    if void.is_void_chunk(canvas_id, pixel.cx, pixel.cy):
                        from src.canvases import CHUNK_PX
                        wx = pixel.cx * CHUNK_PX + (pixel.offset % CHUNK_PX)
                        wy = pixel.cy * CHUNK_PX + (pixel.offset // CHUNK_PX)
                        void.process_player_pixel(wx, wy, pixel.color)
                asyncio.create_task(void._broadcast())
        except Exception:
            pass

    return 0, all_placed_pixels, 0, 0, 0


    return 0, all_placed_pixels, 0, 0, 0
