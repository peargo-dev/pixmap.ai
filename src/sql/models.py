from datetime import datetime, timezone
from typing import Optional
from sqlalchemy import (Boolean, Text, Column, BigInteger,
                        Integer, SmallInteger, String, DateTime, Index, ForeignKey, func, PrimaryKeyConstraint)
from sqlalchemy.dialects.mysql import SMALLINT, TINYINT
from src.classes import Role
from sqlalchemy.orm import Mapped, mapped_column, relationship, DeclarativeBase
from sqlalchemy.ext.hybrid import hybrid_property
from sqlalchemy.types import TypeDecorator
import uuid
import hashlib

class Base(DeclarativeBase):
    pass

class RoleType(TypeDecorator):
    """Stores Role as an unsigned tinyint, reads it back as a Role enum."""
    impl = TINYINT(unsigned=True)
    cache_ok = True

    def process_bind_param(self, role, dialect):
        if role is None:
            return None
        if isinstance(role, Role):
            return int(role)
        try:
            return int(Role(int(role)))
        except (TypeError, ValueError):
            return int(Role.PLAYER)

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        try:
            return Role(value)
        except ValueError:
            return Role.PLAYER

def gen_uuid() -> str:
    return str(uuid.uuid4())

class IPInfo(Base):
    __tablename__ = "ip_info"
    ip           = Column(String(45), primary_key=True)
    hash         = Column(String(36), unique=True, nullable=False, default=gen_uuid)
    cidr         = Column(String(45), nullable=False)
    country_code = Column(String(2), nullable=False)

    placements = relationship("PixelPlacement", back_populates="ip_info")

class IPUserPair(Base):
    __tablename__ = "ip_pair"
    ip         = Column(String(45), ForeignKey("ip_info.ip"), nullable=False)
    user_id    = Column(Integer, ForeignKey("users.id"), nullable=False)
    first_seen = Column(DateTime, nullable=False, server_default=func.now())
    last_seen  = Column(DateTime, nullable=False, server_default=func.now())

    __table_args__ = (
        PrimaryKeyConstraint("ip", "user_id"),
        Index("idx_ip_pair_user_last_seen", "user_id", "last_seen"),
    )

class SessionUserPair(Base):
    __tablename__ = "session_pair"
    session_id = Column(String(36), nullable=False, index=True)
    user_id    = Column(Integer, ForeignKey("users.id"), nullable=False)

    __table_args__ = (
        PrimaryKeyConstraint("session_id", "user_id"),
    )


class PixelPlacement(Base):
    __tablename__ = "pixel_log"

    id        = Column(BigInteger, primary_key=True, autoincrement=True)
    user_id   = Column(Integer, nullable=True)
    x         = Column(SMALLINT(unsigned=True), nullable=False)
    y         = Column(SMALLINT(unsigned=True), nullable=False)
    canvas_id = Column(TINYINT(unsigned=True), nullable=False)
    color     = Column(SmallInteger, nullable=False)
    placed_at = Column(DateTime, server_default=func.now(), nullable=False)
    ip        = Column(String(45), ForeignKey("ip_info.ip"), nullable=False)

    ip_info = relationship("IPInfo", back_populates="placements")

    __table_args__ = (
        Index('idx_coords_time', 'x', 'y', 'placed_at'),
        Index('idx_user_time', 'user_id', 'placed_at'),
    )

class User(Base):
    __tablename__ = "users"

    id:         Mapped[int]      = mapped_column(Integer, primary_key=True, autoincrement=True)
    discord_id: Mapped[Optional[str]] = mapped_column(String(32), nullable=True, index=True)
    discord_username: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    google_id:  Mapped[Optional[str]] = mapped_column(String(255), unique=True, nullable=True, index=True)
    username:   Mapped[str]      = mapped_column(String(32), unique=True, nullable=False)
    email:      Mapped[str]      = mapped_column(String(255), nullable=False)
    avatar:     Mapped[str]      = mapped_column(String(255), nullable=True, default="")
    _role:      Mapped[Role]     = mapped_column("role", RoleType(), nullable=False, default=Role.PLAYER)

    @hybrid_property
    def role(self) -> Role:
        if not isinstance(self, User):
            return self._role
        from src.auth import OWNER_IDS, ADMIN_IDS
        uid = getattr(self, "id", None)
        if uid is not None:
            if uid in OWNER_IDS:
                return Role.OWNER
            elif uid in ADMIN_IDS:
                return Role.ADMIN
        return self._role

    @role.setter
    def role(self, value: Role):
        self._role = value
    bio:        Mapped[str]      = mapped_column(Text, nullable=False, default="")
    country:    Mapped[str]      = mapped_column(String(2), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    last_login: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    banned:     Mapped[int]      = mapped_column(TINYINT, server_default='0', nullable=False)
    allow_faction_invites: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    show_in_invite_search: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)



    @property
    def is_moderator(self) -> bool:
        return self.role >= Role.TRIAL_MOD

    @property
    def is_admin(self) -> bool:
        return self.role >= Role.ADMIN

    @property
    def is_banned(self) -> bool:
        if not self.bans:
            return False
        now = datetime.now(timezone.utc)
        for entry in self.bans:
            # Skip inactive entries
            if not entry.active:
                continue
            
            # No expiration = permanent ban
            if not entry.ban.expires_at:
                return True
            
            # Make sure both datetimes are timezone-aware for comparison
            expires = entry.ban.expires_at
            if expires.tzinfo is None:
                expires = expires.replace(tzinfo=timezone.utc)
            
            # Only consider it a ban if it hasn't expired yet
            # If expires_at is in the past, ignore this entry even if active=True
            if expires > now:
                return True
        return False

    sessions: Mapped[list["Session"]]     = relationship("Session", back_populates="user", cascade="all, delete-orphan")
    messages: Mapped[list["ChatMessage"]] = relationship("ChatMessage", back_populates="user", cascade="all, delete-orphan", primaryjoin="User.id == ChatMessage.user_id")
    bans:     Mapped[list["BanEntry"]]    = relationship("BanEntry", foreign_keys="[BanEntry.user_id]", back_populates="user", cascade="all, delete-orphan")

class Session(Base):
    __tablename__ = "sessions"

    id:         Mapped[int]      = mapped_column(Integer, primary_key=True, autoincrement=True)
    token:      Mapped[str]      = mapped_column(String(96), unique=True, nullable=False, index=True)
    user_id:    Mapped[int]      = mapped_column(Integer, ForeignKey("users.id"), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))

    user: Mapped["User"] = relationship("User", back_populates="sessions")


class Ban(Base):
    """One ban event — shared across all alts it affects."""
    __tablename__ = "bans"

    id           = Column(String(36), primary_key=True, default=gen_uuid)
    moderator_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    reason       = Column(String(255), nullable=True)
    expires_at   = Column(DateTime, nullable=True)  # None = permanent
    created_at   = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    moderator: Mapped[Optional["User"]] = relationship("User", foreign_keys=[moderator_id])
    entries:   Mapped[list["BanEntry"]] = relationship("BanEntry", back_populates="ban", cascade="all, delete-orphan")
    scope:     Mapped[list["BanScope"]] = relationship("BanScope", back_populates="ban", cascade="all, delete-orphan")


class BanEntry(Base):
    """One row per user affected by a ban. Use id as the appeal token."""
    __tablename__ = "ban_entries"

    id         = Column(String(36), primary_key=True, default=gen_uuid)  # appeal token
    ban_id     = Column(String(36), ForeignKey("bans.id"), nullable=False, index=True)
    user_id    = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    active     = Column(Boolean, nullable=False, default=True)   # False = individually pardoned
    is_alt     = Column(Boolean, nullable=False, default=False)  # False = original ban target
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    ban:  Mapped["Ban"]  = relationship("Ban", back_populates="entries")
    user: Mapped["User"] = relationship("User", foreign_keys=[user_id], back_populates="bans")


class BanScope(Base):
    """Snapshot of IPs and session IDs associated with a ban at time of banning.
    Also grows as new alts are caught on connect.
    """
    __tablename__ = "ban_scope"

    id     = Column(Integer, primary_key=True, autoincrement=True)
    ban_id = Column(String(36), ForeignKey("bans.id"), nullable=False, index=True)
    type   = Column(String(3), nullable=False)   # "ip" or "sid"
    value  = Column(String(45), nullable=False)  # the IP or session_id

    ban: Mapped["Ban"] = relationship("Ban", back_populates="scope")

    __table_args__ = (
        Index("idx_ban_scope_lookup", "type", "value"),
    )


class BanLog(Base):
    __tablename__ = "ban_logs"

    id:         Mapped[int]      = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id:    Mapped[int]      = mapped_column(Integer, ForeignKey("users.id"), nullable=False)
    admin_id:   Mapped[int]      = mapped_column(Integer, ForeignKey("users.id"), nullable=True)
    reason:     Mapped[str]      = mapped_column(String(255), nullable=True)
    is_ban:     Mapped[bool]     = mapped_column(Boolean, default=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))

    target_user: Mapped["User"] = relationship("User", foreign_keys=[user_id])
    admin_user:  Mapped["User"] = relationship("User", foreign_keys=[admin_id])


class UserIcon(Base):
    """Staff-uploaded 16×16 custom chat/profile icons (stored as base64 PNG)."""
    __tablename__ = "user_icons"

    id:         Mapped[int]      = mapped_column(Integer, primary_key=True, autoincrement=True)
    name:       Mapped[str]      = mapped_column(String(64), nullable=False)
    image_b64:  Mapped[str]      = mapped_column(Text, nullable=False)
    created_by: Mapped[int]      = mapped_column(Integer, ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))

    creator: Mapped["User"] = relationship("User", foreign_keys=[created_by])


class UserFlair(Base):
    """Per-user cosmetic settings — unlocked by pixel milestones or admin grant."""
    __tablename__ = "user_flair"

    user_id:          Mapped[int]           = mapped_column(Integer, ForeignKey("users.id"), primary_key=True)
    custom_icon_id:   Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("user_icons.id"), nullable=True)
    granted_tier:     Mapped[int]           = mapped_column(TINYINT(unsigned=True), nullable=False, default=0)
    profile_pic_b64:  Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    banner_color:     Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    username_style:   Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    msg_style:        Mapped[Optional[str]] = mapped_column(String(32), nullable=True)

    user:        Mapped["User"]              = relationship("User", foreign_keys=[user_id])
    custom_icon: Mapped[Optional["UserIcon"]] = relationship("UserIcon", foreign_keys=[custom_icon_id])

class CfDeviceBinding(Base):
    """Cloudflare Zero Trust device-binding.

    One row per CF email (SHA-256 hashed for privacy).  The first browser
    fingerprint that calls POST /auth/cf/bind for an email claims it;
    subsequent calls must present the same fingerprint hash or are rejected.

    Only active when CF_ZERO_TRUST_ENABLED=true.  Bindings are removed via
    DELETE /auth/cf/binding (user self-service) which allows re-claiming on
    the next login.
    """
    __tablename__ = "cf_device_bindings"

    id:         Mapped[int]      = mapped_column(Integer, primary_key=True, autoincrement=True)
    # SHA-256(lowercase email) — no PII stored
    email_hash: Mapped[str]      = mapped_column(String(64), unique=True, nullable=False, index=True)
    # SHA-256(fingerprint string submitted by the browser)
    fp_hash:    Mapped[str]      = mapped_column(String(64), nullable=False)
    claimed_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))
    last_seen:  Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))


class Faction(Base):
    __tablename__ = "factions"

    id:            Mapped[int]           = mapped_column(Integer, primary_key=True, autoincrement=True)
    name:          Mapped[str]           = mapped_column(String(64), unique=True, nullable=False, index=True)
    description:   Mapped[str]           = mapped_column(Text, nullable=False, default="")
    logo_url:      Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    color:         Mapped[str]           = mapped_column(String(7), nullable=False, default="#ff4444")
    canvas_id:     Mapped[int]           = mapped_column(TINYINT(unsigned=True), nullable=False, default=0)
    owner_id:      Mapped[int]           = mapped_column(Integer, ForeignKey("users.id"), nullable=False)
    is_public:     Mapped[bool]          = mapped_column(Boolean, nullable=False, default=False)
    min_join_px:   Mapped[int]           = mapped_column(Integer, nullable=False, default=10000)
    template_url:  Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    template_canvas_id: Mapped[int]      = mapped_column(TINYINT(unsigned=True), nullable=False, default=0)
    template_x:    Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    template_y:    Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at:    Mapped[datetime]      = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

    owner:         Mapped["User"]        = relationship("User", foreign_keys=[owner_id])
    members:       Mapped[list["FactionMember"]] = relationship("FactionMember", back_populates="faction", cascade="all, delete-orphan")


class FactionMember(Base):
    __tablename__ = "faction_members"

    id:         Mapped[int]      = mapped_column(Integer, primary_key=True, autoincrement=True)
    faction_id: Mapped[int]      = mapped_column(Integer, ForeignKey("factions.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id:    Mapped[int]      = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, unique=True)
    role:       Mapped[int]      = mapped_column(SmallInteger, nullable=False, default=1) # 4=Owner, 3=Admin, 2=General, 1=Soldier
    joined_at:  Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

    faction:    Mapped["Faction"] = relationship("Faction", back_populates="members")
    user:       Mapped["User"]    = relationship("User", foreign_keys=[user_id])


class FactionInvite(Base):
    __tablename__ = "faction_invites"

    id:            Mapped[int]      = mapped_column(Integer, primary_key=True, autoincrement=True)
    faction_id:    Mapped[int]      = mapped_column(Integer, ForeignKey("factions.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id:       Mapped[int]      = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    invited_by_id: Mapped[int]      = mapped_column(Integer, ForeignKey("users.id"), nullable=False)
    created_at:    Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

    faction:       Mapped["Faction"] = relationship("Faction")
    user:          Mapped["User"]    = relationship("User", foreign_keys=[user_id])
    invited_by:    Mapped["User"]    = relationship("User", foreign_keys=[invited_by_id])


class FactionAnnouncement(Base):
    __tablename__ = "faction_announcements"

    id:         Mapped[int]           = mapped_column(Integer, primary_key=True, autoincrement=True)
    faction_id: Mapped[int]           = mapped_column(Integer, ForeignKey("factions.id", ondelete="CASCADE"), nullable=False, index=True)
    author_id:  Mapped[int]           = mapped_column(Integer, ForeignKey("users.id"), nullable=False)
    message:    Mapped[str]           = mapped_column(Text, nullable=False)
    canvas_id:  Mapped[Optional[int]] = mapped_column(TINYINT(unsigned=True), nullable=True)
    x:          Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    y:          Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime]      = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

    author:     Mapped["User"]        = relationship("User", foreign_keys=[author_id])


class UnlockedFactionCanvas(Base):
    """Canvases unlocked by Admins+ for land conquering by Factions."""
    __tablename__ = "unlocked_faction_canvases"

    canvas_id:   Mapped[int]      = mapped_column(TINYINT(unsigned=True), primary_key=True)
    unlocked_by: Mapped[int]      = mapped_column(Integer, ForeignKey("users.id"), nullable=False)
    unlocked_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

