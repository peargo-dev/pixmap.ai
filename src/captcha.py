from src.redis_client.client import client
from src.redis_client.keys import RedisKeys
import httpx
import os

TURNSTILE_SECRET = os.getenv("CF_TURNSTILE_SECRET_KEY")
VERIFY_TIME = 30  # minutes

async def is_verified(ip: str) -> bool:
    #if the key exists, user is verified
    return await client.exists(RedisKeys.CAPTCHA.value.format(ip=ip)) == 1


async def verify_captcha(ip: str, answer: str) -> bool:
    """Validate a Turnstile token with Cloudflare and cache the result."""
    if not answer:
        return False

    async with httpx.AsyncClient() as session:
        resp = await session.post(
            "https://challenges.cloudflare.com/turnstile/v0/siteverify",
            json={
                "secret": TURNSTILE_SECRET,
                "response": answer,
            },
            timeout=10.0,
        )
        resp.raise_for_status()
        data = resp.json()

    if not data.get("success"):
        print(f"[captcha] siteverify failed: error-codes={data.get('error-codes')} hostname={data.get('hostname')}")
        return False

    await client.setex(RedisKeys.CAPTCHA.value.format(ip=ip), VERIFY_TIME * 60, "1")
    return True