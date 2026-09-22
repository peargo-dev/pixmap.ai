from dataclasses import dataclass, field

CHUNK_PX = 256 #size of chunk, best for socket packets

@dataclass
class Canvas:
    name: str
    indent: str
    size: int = 256
    unset_cooldown: int = 750
    set_cooldown: int = 750
    description: str = ""
    pixel_requirement: int = 0
    stack: int = 300_000
    colors: list[tuple[int, int, int]] = field(default_factory=lambda: [
            (202, 227, 255),
            (255, 255, 255),
            (255, 255, 255),
            (228, 228, 228),
            (196, 196, 196),
            (136, 136, 136),
            (78, 78, 78),
            (0, 0, 0),
            (244, 179, 174),
            (255, 167, 209),
            (255, 84, 178),
            (255, 101, 101),
            (229, 0, 0),
            (154, 0, 0),
            (254, 164, 96),
            (229, 149, 0),
            (160, 106, 66),
            (96, 64, 40),
            (245, 223, 176),
            (255, 248, 137),
            (229, 217, 0),
            (148, 224, 68),
            (2, 190, 1),
            (104, 131, 56),
            (0, 101, 19),
            (202, 227, 255),
            (0, 211, 221),
            (0, 131, 199),
            (0, 0, 234),
            (25, 25, 115),
            (207, 110, 228),
            (130, 0, 128),
            (83, 39, 68),
            (125, 46, 78),
            (193, 55, 71),
            (214, 113, 55),
            (252, 154, 41),
            (68, 33, 57),
            (131, 51, 33),
            (163, 61, 24),
            (223, 96, 22),
            (31, 37, 127),
            (10, 79, 175),
            (10, 126, 230),
            (88, 237, 240),
            (37, 20, 51),
            (53, 33, 67),
            (66, 21, 100),
            (74, 27, 144),
            (110, 75, 237),
            (16, 58, 47),
            (16, 74, 31),
            (16, 142, 47),
            (16, 180, 47),
            (117, 215, 87),
            (192, 0, 0),
            (212, 0, 0)
    ])
    unset_pixels_below: int = 2
    ranked: bool = True
    hotkey: str = ""

moon_palette = [
    (49, 46, 47),
    (99, 92, 90),
    (49, 46, 47),
    (99, 92, 90),
    (129, 119, 107),
    (198, 181, 165),
    (255, 237, 212),
    (150, 86, 122),
    (202, 112, 145),
    (96, 67, 79),
    (136, 79, 94),
    (175, 101, 103),
    (195, 124, 107),
    (221, 153, 126),
    (233, 181, 140),
    (198, 139, 91),
    (140, 89, 74),
    (94, 68, 63),
    (225, 173, 86),
    (248, 207, 142),
    (239, 220, 118),
    (206, 190, 85),
    (157, 159, 55),
    (114, 121, 43),
    (81, 94, 46),
    (69, 100, 79),
    (80, 134, 87),
    (187, 209, 138),
    (91, 84, 108),
    (106, 113, 137),
    (122, 148, 156),
    (174, 215, 185)
]

earth_extended_palette = [
    (202, 227, 255),
    (255, 255, 255),
    (255, 255, 255),
    (228, 228, 228),
    (196, 196, 196),
    (136, 136, 136),
    (78, 78, 78),
    (0, 0, 0),
    (244, 179, 174),
    (255, 167, 209),
    (255, 84, 178),
    (255, 101, 101),
    (229, 0, 0),
    (154, 0, 0),
    (254, 164, 96),
    (229, 149, 0),
    (160, 106, 66),
    (96, 64, 40),
    (245, 223, 176),
    (255, 248, 137),
    (229, 217, 0),
    (148, 224, 68),
    (2, 190, 1),
    (104, 131, 56),
    (0, 101, 19),
    (202, 227, 255),
    (0, 211, 221),
    (0, 131, 199),
    (0, 0, 234),
    (25, 25, 115),
    (207, 110, 228),
    (130, 0, 128),
    (83, 39, 68),
    (125, 46, 78),
    (193, 55, 71),
    (214, 113, 55),
    (252, 154, 41),
    (68, 33, 57),
    (131, 51, 33),
    (163, 61, 24),
    (223, 96, 22),
    (31, 37, 127),
    (10, 79, 175),
    (10, 126, 230),
    (88, 237, 240),
    (37, 20, 51),
    (53, 33, 67),
    (66, 21, 100),
    (74, 27, 144),
    (110, 75, 237),
    (16, 58, 47),
    (16, 74, 31),
    (16, 142, 47),
    (16, 180, 47),
    (117, 215, 87),
    (192, 0, 0),
    (212, 0, 0)
]

canvases = {
    0: Canvas("Earth", "d", size=256, description="The main canvas, a giant map of the world!", hotkey="1"),
    1: Canvas("New Earth", "ne", size=256, description="A new world awaits!", unset_cooldown=500, set_cooldown=1000, colors=earth_extended_palette, hotkey="2"),
    2: Canvas("Moon", "m", size=64, description="Safe place for art. No griefing allowed!", ranked=False, unset_cooldown=5000, set_cooldown=5000, stack=900000, pixel_requirement=20000, colors=moon_palette, hotkey="3"),
    17: Canvas("Minimap", "b", size=16, description="A mini version of the world", pixel_requirement=10000, hotkey="4"),
    23: Canvas("Refugee Minimap", "rm", size=32, description="Earth, but 4x smaller", hotkey="5"),
}

# ── Redis persistence ─────────────────────────────────────────────────────────
# Canvas configs are stored in Redis so that changes made via the admin API
# persist across restarts and are visible to external processes like upload_image.py.

CANVAS_CONFIG_KEY = "canvas_configs"

def get_canvas_id(canvas: Canvas) -> int | None:
    """return the id(int) of a canvas, or None if not found"""
    for k, v in canvases.items():
        if v is canvas:
            return k
    return None

def _canvas_to_dict(canvas_id: int, c: "Canvas") -> dict:
    return {
        "id": canvas_id,
        "name": c.name,
        "indent": c.indent,
        "size": c.size,
        "description": c.description,
        "unset_cooldown": c.unset_cooldown,
        "set_cooldown": c.set_cooldown,
        "pixel_requirement": c.pixel_requirement,
        "stack": c.stack,
        "ranked": c.ranked,
        "unset_pixels_below": c.unset_pixels_below,
        "hotkey": getattr(c, "hotkey", "") or "",
        "colors": [list(col) for col in c.colors],
    }

def _dict_to_canvas(d: dict) -> "Canvas":
    return Canvas(
        name               = d["name"],
        indent             = d["indent"],
        size               = int(d.get("size", 256)),
        description        = d.get("description", ""),
        unset_cooldown     = int(d.get("unset_cooldown", 750)),
        set_cooldown       = int(d.get("set_cooldown", 750)),
        pixel_requirement  = int(d.get("pixel_requirement", 0)),
        stack              = int(d.get("stack", 120000)),
        ranked             = bool(d.get("ranked", True)),
        unset_pixels_below = int(d.get("unset_pixels_below", 2)),
        hotkey             = str(d.get("hotkey", "")),
        colors             = [tuple(c[:3]) for c in d.get("colors", [])],
    )

async def save_canvases() -> None:
    """Persist the current canvases dict to Redis."""
    import json
    from src.redis_client.client import client as redis
    data = {str(k): _canvas_to_dict(k, v) for k, v in canvases.items()}
    await redis.set(CANVAS_CONFIG_KEY, json.dumps(data))

async def load_canvases() -> None:
    """Load canvas configs from Redis, updating the in-memory dict in-place.
    Falls back to the hardcoded defaults if Redis has nothing."""
    import json
    import asyncio
    import redis.exceptions
    from src.redis_client.client import client as redis

    raw = None
    for attempt in range(60):
        try:
            raw = await redis.get(CANVAS_CONFIG_KEY)
            break
        except redis.exceptions.BusyLoadingError:
            print(f"[canvases] Redis is loading the dataset... waiting 2s (attempt {attempt+1}/60)")
            await asyncio.sleep(2)
    else:
        raw = await redis.get(CANVAS_CONFIG_KEY)

    if not raw:
        return  # keep hardcoded defaults
    try:
        data: dict = json.loads(raw)
        canvases.clear()
        for k, v in data.items():
            canvases[int(k)] = _dict_to_canvas(v)
    except Exception as e:
        print(f"[canvases] Failed to load from Redis: {e} — using defaults")

# build canvas.json