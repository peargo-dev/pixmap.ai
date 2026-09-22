from dataclasses import dataclass
from enum import IntEnum

class Role(IntEnum):
    PLAYER = 0
    TRIAL_MOD = 100
    MOD = 150
    ADMIN = 200
    OWNER = 254
    SYSTEM = 255

    def __int__(self):
        return self.value

@dataclass
class Pixel:
    cx: int
    cy: int
    offset: int
    color: int

    def x(self):
        return (self.cx * 256) + (self.offset % 256)

    def y(self):
        return (self.cy * 256) + (self.offset // 256)

@dataclass
class User:
    uid: int
    username: str
    role: Role = Role.PLAYER

#no argument spam
@dataclass
class Point:
    x: int
    y: int

    def __eq__(self, other): #could make work with tuples, but eh it's a mess
        return self.x == other.x and self.y == other.y
