def resolve_avatar_url(avatar: str | None, discord_id: str | None = None) -> str:
    if not avatar and not discord_id:
        return "https://cdn.discordapp.com/embed/avatars/0.png"

    if avatar and ("googleusercontent.com" in avatar or "google" in avatar.lower()):
        avatar = None

    if avatar and (avatar.startswith("http://") or avatar.startswith("https://") or avatar.startswith("avatar-") or avatar.startswith("/")):
        if avatar.startswith("avatar-"):
            return f"/uploads/avatars/{avatar}"
        return avatar
    if discord_id and avatar and str(avatar).strip():
        clean_hash = str(avatar).strip()
        ext = "gif" if clean_hash.startswith("a_") else "png"
        return f"https://cdn.discordapp.com/avatars/{discord_id}/{clean_hash}.{ext}"

    if discord_id:
        try:
            idx = (int(discord_id) >> 22) % 6
            return f"https://cdn.discordapp.com/embed/avatars/{idx}.png"
        except Exception:
            return "https://cdn.discordapp.com/embed/avatars/0.png"
    return "https://cdn.discordapp.com/embed/avatars/0.png"


def discord_avatar_url(discord_id: str | None, avatar_hash: str | None) -> str:
    return resolve_avatar_url(avatar_hash, discord_id)
