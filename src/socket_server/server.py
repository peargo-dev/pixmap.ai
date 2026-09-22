import asyncio
from src import place
import traceback
from .packets import *
import src.socket_server.router as router
import time
from src.cooldowns import get_cooldown
from src.middleware import attach_account_to_websocket
from src.proxy import check_proxy
from src.sql.db import AsyncSessionLocal
from src.socket_server.clients import Client, clients_by_user, clients_by_ip, clients
from src.sql.ip import get_client_ip_info, log_ip_and_id, log_session_and_id
from src.sql.ban import propagate_ban_if_alt
import uuid

from ..captcha import verify_captcha


def get_clients_from_ip(ip):
    return clients_by_ip.get(ip, set())

async def loop():
    while True:
        for client in list(clients):
            if time.time() - client.last_ping > 30:
                asyncio.create_task(client.socket.close(code=1000)) #asyncio runs this after the loop, so no skipping connections

        await asyncio.sleep(20)

async def setup_proxy(client):
    client.is_proxy = await check_proxy(client.ip)
    if client.is_proxy:
        await client.safe_send_bytes(serialize_alert("Security: VPN/Proxy detected. Placements may be restricted."))

async def on_new_connection(socket):
    user = await attach_account_to_websocket(socket)
    #get session id cookie
    headers = []

    raw = socket.cookies.get("bid", "")
    try:
        session_id = str(uuid.UUID(raw))  # validates and normalizes
    except ValueError:
        session_id = str(uuid.uuid4())
        headers.append((b"set-cookie", f"bid={session_id}; HttpOnly; SameSite=Lax".encode()))
        #and set the new session id in set-cookie when socket is upgraded

    #get ip from socket_server
    await socket.accept(headers=headers)

    # if amount of connections per real IP > 50, deny the connection
    if len(get_clients_from_ip(socket.client.host)) >= 50:
        return await socket.close()

    client = Client(socket, user, session_id)

    async with AsyncSessionLocal() as session:
        await get_client_ip_info(session, client)
        if client.user: #log alts
            await log_ip_and_id(session, client.ip, client.user.id)
            await log_session_and_id(session, client.user.id, client.session_id)
            
            # Propagation also returns the final state, avoiding a duplicate
            # active-ban query on every authenticated connection.
            client.banned = await propagate_ban_if_alt(
                session, client.user, client.ip, client.session_id
            )

        await session.commit()

    client.on_open()

    #proxy check
    asyncio.create_task(setup_proxy(client)) #if this errors, proxy=False

    #send setup info
    asyncio.create_task( client.safe_send_bytes(serialize_online(len(clients_by_user))) )
    asyncio.create_task( client.safe_send_bytes(serialize_cooldown(await get_cooldown(client))) )

    try:
        while True:
            message = await socket.receive()

            if message["type"] == "websocket.disconnect":
                break

            if "bytes" in message:
                await on_binary_message(client, message["bytes"])
            elif "text" in message:
                await on_text_message(client, message["text"])
    except RuntimeError as e:
        if str(e) != 'Cannot call "send" once a close message has been sent.': #just hide this error, it's not a problem
            print(traceback.format_exc())
    except Exception as e:
        print(traceback.format_exc())
    finally:
        client.on_close()
    return None

async def on_text_message(client, text):
    client.last_ping = time.time()

    op, payload = deserialize_text(text)
    await router.call_event(op, client, payload)

async def on_binary_message(client, message):
    message = bytearray(message)
    client.last_ping = time.time()

    op, payload = deserialize(message)

    await router.call_event(op, client, *payload)

#might as well put server events here, for now
@router.on(opcode.PING)
async def on_ping(client):
    #send online info
    await client.safe_send_bytes(serialize_online(len(clients_by_user)))

@router.on(opcode.ADD_TWO_NUMBERS_DEMO)
async def on_add_two_numbers_demo(client, n1, n2):
    print(n1, n2, n1+n2)
    await client.safe_send_bytes(serialize_add(n1 + n2))

@router.on(opcode.PLACE)
async def on_place(client, pixels: list[Pixel]):
    if len(pixels) == 0:
        return

    #limit pixels to avoid any potential crashes
    pixels = pixels[:500]

    cx = pixels[0].cx
    cy = pixels[0].cy
    try:
        code, successful, ranked, new_cd, max_cd = await place.place(client, pixels)
    except Exception:
        print(traceback.format_exc())
        code, successful, ranked, new_cd, max_cd = 7, None, None, None, None

    # Send status back to the placing user
    await client.safe_send_bytes(serialize_place_return(cx, cy, code, successful, ranked, new_cd, max_cd))

@router.on(opcode.CAPTCHA)
async def on_captcha(client, obj):
    success = await verify_captcha(client.ip, obj[0])
    return await client.socket.send_text(serialize_text(opcode.CAPTCHA, [success]))