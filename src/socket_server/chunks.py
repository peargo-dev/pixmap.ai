from src.socket_server.router import on
from src.socket_server.packets import opcode, serialize_place
from src.classes import Pixel
import asyncio

chunk_subscriptions: dict[str, set] = {}
_queue: dict[str, dict[int, Pixel]] = {}  # chunk_key -> {offset: Pixel}

UPDATE_FPS = 30

def key(canvas_id, cx, cy):
    return f"{canvas_id}|{cx}|{cy}"

def remove_client_from_chunk(client, chunk):
    chunk_key = key(client.canvas, chunk[0], chunk[1])
    subs = chunk_subscriptions.get(chunk_key)
    if not subs:
        return
    subs.discard(client)
    if not subs:
        del chunk_subscriptions[chunk_key]

def add_client_to_chunk(client, chunk):
    chunk_key = key(client.canvas, chunk[0], chunk[1])
    if chunk_key not in chunk_subscriptions:
        chunk_subscriptions[chunk_key] = set()
    chunk_subscriptions[chunk_key].add(client)  # was adding chunk tuple instead of client

def unsubscribe_from_all_chunks(client):
    for chunk in client.subscribed_chunks:
        remove_client_from_chunk(client, chunk)
    client.subscribed_chunks.clear()

@on(opcode.SET_CANVAS)
async def on_set_canvas(client, canvas):
    client.canvas = canvas
    unsubscribe_from_all_chunks(client)

@on(opcode.CHUNK_SUBSCRIBE)
async def on_chunk_subscribe(client, chunks: list[tuple[int, int]]):
    client.subscribed_chunks |= set(chunks)  # |= requires a set
    for chunk in chunks:
        add_client_to_chunk(client, chunk)

@on(opcode.CHUNK_UNSUBSCRIBE)
async def on_chunk_unsubscribe(client, chunks: list[tuple[int, int]]):
    client.subscribed_chunks -= set(chunks)
    for chunk in chunks:
        remove_client_from_chunk(client, chunk)

'''
async def queue_loop():
    while True:
        await asyncio.sleep(1 / UPDATE_FPS)

        if not _queue:
            continue

        # claude is weird but clever
        current, _queue = _queue, {}

        for chunk_key, pixels in current.items():
            subscribers = chunk_subscriptions.get(chunk_key)
            if not subscribers:
                continue

            payload = serialize_place(list(pixels.values()))
            await asyncio.gather(
                *(conn.socket.send_bytes(payload) for conn in subscribers),
                return_exceptions=True  #if one errors or is disconnected, everyone wont be affected
            )

def queue_pixels(canvas_id: int, cx: int, cy: int, pixels: list[Pixel]):
    chunk_key = key(canvas_id, cx, cy)
    if chunk_key not in _queue:
        _queue[chunk_key] = {}
    for pixel in pixels:
        _queue[chunk_key][pixel.offset] = pixel  # last write wins within a frame
'''

# i like this better
async def queue_pixels(canvas_id: int, cx: int, cy: int, pixels: list[Pixel], exclude_client=None):
    chunk_key = key(canvas_id, cx, cy)
    subscribers = chunk_subscriptions.get(chunk_key)
    if not subscribers:
        return

    payload = serialize_place(pixels)
    # Don't exclude the client so they get confirmation
    targets = list(subscribers)
    await asyncio.gather(
        *(conn.safe_send_bytes(payload) for conn in targets),
        return_exceptions=True  # if one errors or is disconnected, everyone wont be affected
    )