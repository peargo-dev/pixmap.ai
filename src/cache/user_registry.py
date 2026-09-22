# src/cache/user_registry.py

from weakref import WeakValueDictionary
from src.sql.models import User

# Holds one live User ORM object per user_id.
# WeakValueDictionary means if nothing else holds a reference, it's GC'd automatically.
_registry: WeakValueDictionary[int, User] = WeakValueDictionary()

def register_user(user: User) -> User:
    existing = _registry.get(user.id)
    if existing is not None:
        return existing  # return the canonical instance
    _registry[user.id] = user
    return user

def get_user(user_id: int) -> User | None:
    return _registry.get(user_id)

def invalidate_user(user_id: int):
    _registry.pop(user_id, None)