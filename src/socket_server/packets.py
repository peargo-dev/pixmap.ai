import struct
from enum import Enum
from src.classes import Pixel
import json

class opcode(Enum):
    PING = 0x00
    PLACE = 0x10
    SET_CANVAS = 0x11
    CHUNK_SUBSCRIBE = 0x12
    CHUNK_UNSUBSCRIBE = 0x13
    PLACE_RETURN = 0x14
    COOLDOWN = 0x15
    REFRESH_CHUNKS = 0x16
    ALERT = 0x40
    ONLINE = 0xB1
    DELETE_MESSAGES = 0xC1
    CHAT_ERROR = 0xC2
    ADD_TWO_NUMBERS_DEMO = 0xF1
    CHAT = "c"
    CAPTCHA = "s"
    VOID_STATE = "v"   # text JSON: void event state broadcast
    TRANSLATE = "t"
    ANNOUNCEMENT = "a"
    FACTION_INVITE = "fi"
    FACTION_ANNOUNCEMENT = "fa"
    FACTION_TEMPLATE = "ft"
    FACTION_VIEW = "fv"
    FACTION_WARN = "fw"

class number_types(Enum):
    BYTE = "B"
    UINT = "I"
    U16 = "H"

def pack(op: opcode, *args):
    type_str = ">B"
    v = [op.value]
    for arg in args:
        value, type = arg
        type_str += type.value
        v.append(value)
    return struct.pack(type_str, *v)

#serialize
def serialize_online(online: int):
    return pack(
        opcode.ONLINE,
        (online, number_types.U16)
    )

def serialize_add(result: int):
    return pack(
        opcode.ADD_TWO_NUMBERS_DEMO,
        (result, number_types.UINT)
    )

def serialize_delete_messages(message_ids: list[int]):
    args = []
    for id in message_ids:
        args.append((id, number_types.UINT))

    return pack(
        opcode.DELETE_MESSAGES,
        *args
    )

def serialize_chat_error(error: int):
    return pack(
        opcode.CHAT_ERROR,
        (error, number_types.BYTE)
    )

def serialize_place(pixels: list[Pixel]):
    # precondition: assume pixels are in the same chunk
    if len(pixels) == 0:
        return b"" #avoid future error

    pixel_args = []
    for pixel in pixels:
        pixel_args.append((pixel.offset, number_types.U16))
        pixel_args.append((pixel.color, number_types.BYTE))

    return pack(
        opcode.PLACE,
        (pixels[0].cx, number_types.BYTE),
        (pixels[0].cy, number_types.BYTE),
        *pixel_args,
    )

def serialize_place_return(
    cx: int,
    cy: int,
    code: int,
    placed_pixels: int,
    ranked_pixels: int,
    new_cooldown_ms: int,
    max_cooldown_ms: int,
):
    #pixels are passed, don't really need them though
    pargs = [opcode.PLACE_RETURN,
        (cx, number_types.BYTE),
        (cy, number_types.BYTE),
        (code, number_types.BYTE)]
    if code == 0:
        pargs.append((len(placed_pixels), number_types.U16))
        pargs.append((ranked_pixels, number_types.U16))
        pargs.append((new_cooldown_ms, number_types.UINT))
        pargs.append((max_cooldown_ms, number_types.UINT))

    return pack(
        *pargs
    )

def serialize_cooldown(cooldowns: list[tuple[int, int]]):
    cdargs = []
    for (id, cd) in cooldowns:
        cdargs.append((id, number_types.BYTE))
        cdargs.append((cd, number_types.UINT))

    return pack(
        opcode.COOLDOWN,
        *cdargs
    )

def serialize_alert(message: str):
    msg_bytes = message.encode("utf-8")
    return struct.pack(">BH", opcode.ALERT.value, len(msg_bytes)) + msg_bytes

# refresh chunks
def serialize_refresh_chunks(canvas_id: int, *chunks):
    args = []
    for chunk in chunks:
        args.append((chunk[0], number_types.BYTE))
        args.append((chunk[1], number_types.BYTE))

    return pack(
        opcode.REFRESH_CHUNKS,
        (canvas_id, number_types.BYTE), #to prevent race conditions
        *args
    )

#deserialize
def deserialize_add(data: bytearray):
    return struct.unpack(">HH", data)

def deserialize_place(data: bytearray):
    pixels = []

    #initial chunk headers
    cx, cy = struct.unpack(">BB", data[:2])

    #now parse each pixel
    for i in range(2, len(data), 3):
        offset, color = struct.unpack(">HB", data[i:i+3])
        pixels.append( Pixel(cx, cy, offset, color) )

    return [pixels]

def deserialize_delete_messages(data: bytearray):
    message_ids = []
    for i in range(0, len(data), 4):
        id = struct.unpack(">I", data[i:i+4])
        message_ids.append(id)

    return [message_ids]

def deserialize_chunk(data: bytearray):
    out = []
    for i in range(0, len(data), 2):
        out.append((data[i], data[i+1]))
    return [out]

def deserialize_set_canvas(data: bytearray):
    return struct.unpack(">B", data)

def deserialize_text(text: str):
    op = opcode(text[0])

    return op, json.loads(text[1:])

def serialize_text(opcode: opcode, obj):
    return opcode.value + json.dumps(obj)

def serialize_void_state(state: dict) -> str:
    """Serialize a void state dict as a VOID_STATE text packet."""
    return serialize_text(opcode.VOID_STATE, state)




def deserialize(data: bytearray) -> tuple[opcode, list]:
    op = opcode(data.pop(0))
    payload = []

    match op:
        case opcode.ADD_TWO_NUMBERS_DEMO:
            payload = deserialize_add(data)
        case opcode.PLACE:
            payload = deserialize_place(data)
        case opcode.SET_CANVAS:
            payload = deserialize_set_canvas(data)
        case opcode.CHUNK_SUBSCRIBE | opcode.CHUNK_UNSUBSCRIBE:
            payload = deserialize_chunk(data)
        case opcode.DELETE_MESSAGES:
            payload = deserialize_delete_messages(data)

    return op, payload