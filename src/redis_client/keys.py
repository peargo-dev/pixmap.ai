from enum import Enum

class RedisKeys(Enum):
    COOLDOWN_IP = "ip:{canvas_id}:{addr}"
    COOLDOWN_USER = "uid:{canvas_id}:{user_id}"
    CHUNK = "ch:{canvas_id}:{cx}:{cy}"
    CAPTCHA = "capt:{ip}"
    PROXYCHECK = "proxy:{ip}"

    # rankings
    TOTAL_PIXELS = "pxls"
    CANVAS_PIXELS = "pxls:{canvas_id}"
    DAILY_PIXELS = "dpxls:{day}"
    DAILY_CANVAS_PIXELS = "dpxls:{canvas_id}:{day}"
    DAILY_COUNTRY_PIXELS = "dpxls:c:{day}"

    # void event
    VOID_STATE      = "void:state"        # JSON: full runtime state
    VOID_CONFIG     = "void:config"        # JSON: admin-configurable settings
    VOID_PIXELS     = "void:pixels"        # Redis SET: "x:y" of blob pixels
    VOID_ROOTS      = "void:roots"         # Redis SET: "x:y" of root pixels
    VOID_SNAPSHOT   = "void:snap:{cx}:{cy}" # raw chunk bytes before attack
    VOID_CD_MOD     = "void:cd_mod"        # float: cooldown multiplier

    # per-user cooldown rate override (owner/admin tool)
    # float stored as string: 0.0 = zero cd, absent/-1 = default
    UID_CD_RATE = "uid_cd_rate:{user_id}"

    # chat
    CHAT_MIN_PIXELS = "chat:min_pixels"    # int: pixels required to send chat
    TRANSLATION_LIMIT_KEY = "translation_rl:{uid}"
    TRANSLATION_BLOCK_KEY = "translation_b:{uid}:{mid}"

    def __str__(self):
        return self.value