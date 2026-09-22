import asyncio
import time
import os
import traceback
from fastapi import WebSocket
from src.socket_server.clients import Client, clients
from src.socket_server.packets import serialize_online, serialize_cooldown, serialize_place_return, opcode, deserialize
from src.place import place
from src.classes import Pixel
from src.middleware import attach_account_to_websocket
from src.sql.db import AsyncSessionLocal
from src.sql.ip import get_client_ip_info
import uuid

NSWS_SECRET = os.environ.get("NSWS_SECRET_KEY", "")

nsws_clients = set()

async def nsws_loop():
    while True:
        for client in list(nsws_clients):
            if time.time() - client.last_ping > 60:
                try:
                    await client.socket.close(code=1000)
                except Exception:
                    pass
                if client in nsws_clients:
                    nsws_clients.discard(client)
        await asyncio.sleep(30)

async def on_nsws_connection(socket: WebSocket, secret: str):
    if secret != NSWS_SECRET:
        await socket.close(code=4001)
        return
    
    user = await attach_account_to_websocket(socket)
    
    raw = socket.cookies.get("bid", "")
    try:
        session_id = str(uuid.UUID(raw))
    except ValueError:
        session_id = str(uuid.uuid4())
    
    headers = []
    headers.append((b"set-cookie", f"bid={session_id}; HttpOnly; SameSite=Lax".encode()))
    
    await socket.accept(headers=headers)
    
    client = Client(socket, user, session_id)
    client.is_nsws = True
    client.is_proxy = False
    client.banned = False
    
    async with AsyncSessionLocal() as session:
        await get_client_ip_info(session, client)
        await session.commit()
    
    client.on_open()
    nsws_clients.add(client)
    
    asyncio.create_task(client.socket.send_bytes(serialize_online(len(clients) + len(nsws_clients))))
    asyncio.create_task(client.socket.send_bytes(serialize_cooldown(0)))
    
    try:
        while True:
            message = await socket.receive()
            
            if message["type"] == "websocket.disconnect":
                break
            
            if "bytes" in message:
                await on_nsws_binary(client, message["bytes"])
            elif "text" in message:
                client.last_ping = time.time()
    except RuntimeError as e:
        if str(e) != 'Cannot call "send" once a close message has been sent.':
            print(traceback.format_exc())
    except Exception:
        print(traceback.format_exc())
    finally:
        client.on_close()
        nsws_clients.discard(client)
    
    return None

async def on_nsws_binary(client, message):
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
            code, successful, ranked, new_cd, max_cd = await place(client, pixels)
        except Exception:
            print(traceback.format_exc())
            code, successful, ranked, new_cd, max_cd = 7, None, None, None, None
        
        await client.socket.send_bytes(serialize_place_return(cx, cy, code, successful, ranked, 0, 0))
