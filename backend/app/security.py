import hashlib
import re
import secrets
import time
from collections import defaultdict, deque
from datetime import timedelta, timezone

from argon2 import PasswordHasher
from argon2.exceptions import Argon2Error, VerificationError, VerifyMismatchError
from argon2.low_level import Type
from fastapi import HTTPException, status
from sqlalchemy import select

from .config import Settings
from .database import Database
from .models import AuthSession, User, utcnow


USERNAME_RE = re.compile(r"^[\w.-]{3,24}$", re.UNICODE)
password_hasher = PasswordHasher(type=Type.ID)


def validate_username(username: str) -> tuple[str, str]:
    name = username.strip()
    if not USERNAME_RE.fullmatch(name):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "用户名须为 3-24 位字母、数字、汉字、下划线、点或连字符")
    return name, name.casefold()


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("ascii")).hexdigest()


class RateLimiter:
    def __init__(self, attempts: int = 10, window_seconds: int = 300):
        self.attempts = attempts
        self.window = window_seconds
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def check(self, key: str) -> None:
        now = time.monotonic()
        hits = self._hits[key]
        while hits and hits[0] <= now - self.window:
            hits.popleft()
        if len(hits) >= self.attempts:
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "尝试过于频繁，请稍后再试")
        hits.append(now)


class AuthService:
    def __init__(self, db: Database, settings: Settings):
        self.db = db
        self.settings = settings
        self.limiter = RateLimiter()
        self.guest_limiter = RateLimiter(attempts=30, window_seconds=300)

    def _create_session(self, user: User) -> str:
        token = secrets.token_urlsafe(32)
        expires = utcnow() + timedelta(hours=self.settings.session_ttl_hours)
        with self.db.session() as session:
            session.add(AuthSession(token_hash=hash_token(token), user_id=user.id, expires_at=expires))
        return token

    def register(self, username: str, password: str) -> tuple[User, str]:
        name, key = validate_username(username)
        if not 8 <= len(password) <= 128:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "密码长度须为 8-128 位")
        with self.db.session() as session:
            if session.scalar(select(User).where(User.username_key == key)):
                raise HTTPException(status.HTTP_409_CONFLICT, "用户名已存在")
            user = User(name=name, username_key=key, password_hash=password_hasher.hash(password), guest=False)
            session.add(user)
            session.commit()
            session.refresh(user)
        return user, self._create_session(user)

    def login(self, username: str, password: str) -> tuple[User, str]:
        name, key = validate_username(username)
        with self.db.session() as session:
            user = session.scalar(select(User).where(User.username_key == key))
            valid = False
            if user and not user.guest and user.password_hash:
                try:
                    valid = password_hasher.verify(user.password_hash, password)
                except (VerifyMismatchError, VerificationError, Argon2Error):
                    valid = False
            if not valid:
                # A real hash verification above keeps the common path timing comparable.
                raise HTTPException(status.HTTP_401_UNAUTHORIZED, "用户名或密码错误")
            if password_hasher.check_needs_rehash(user.password_hash):
                user.password_hash = password_hasher.hash(password)
            session.expunge(user)
        return user, self._create_session(user)

    def guest(self) -> tuple[User, str]:
        with self.db.session() as session:
            while True:
                suffix = secrets.token_hex(4).upper()
                name = f"游客-{suffix}"
                if not session.scalar(select(User).where(User.username_key == name.casefold())):
                    break
            user = User(name=name, username_key=name.casefold(), password_hash=None, guest=True)
            session.add(user)
            session.commit()
            session.refresh(user)
        return user, self._create_session(user)

    def user_for_token(self, token: str | None) -> User | None:
        if not token:
            return None
        with self.db.session() as session:
            auth = session.scalar(
                select(AuthSession).where(AuthSession.token_hash == hash_token(token))
            )
            expires_at = auth.expires_at if auth else None
            if expires_at and expires_at.tzinfo is None:
                expires_at = expires_at.replace(tzinfo=timezone.utc)
            if not auth or not expires_at or expires_at <= utcnow():
                if auth:
                    session.delete(auth)
                return None
            user = auth.user
            session.expunge(user)
            return user

    def logout(self, token: str | None) -> None:
        if not token:
            return
        with self.db.session() as session:
            auth = session.scalar(select(AuthSession).where(AuthSession.token_hash == hash_token(token)))
            if auth:
                session.delete(auth)
