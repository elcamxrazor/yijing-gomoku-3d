from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from .models import Base


class Database:
    def __init__(self, url: str):
        self.url = url
        kwargs: dict = {"pool_pre_ping": True}
        if url.startswith("sqlite"):
            kwargs["connect_args"] = {"check_same_thread": False}
            if url in {"sqlite://", "sqlite:///:memory:"}:
                kwargs["poolclass"] = StaticPool
            else:
                raw_path = url.removeprefix("sqlite:///").split("?", 1)[0]
                if raw_path and raw_path != ":memory:":
                    Path(raw_path).parent.mkdir(parents=True, exist_ok=True)
        self.engine = create_engine(url, **kwargs)
        if url.startswith("sqlite"):
            @event.listens_for(self.engine, "connect")
            def _sqlite_pragmas(dbapi_connection, _connection_record):
                cursor = dbapi_connection.cursor()
                cursor.execute("PRAGMA foreign_keys=ON")
                cursor.execute("PRAGMA busy_timeout=5000")
                if ":memory:" not in url:
                    cursor.execute("PRAGMA journal_mode=WAL")
                cursor.close()

        self.sessions = sessionmaker(bind=self.engine, expire_on_commit=False)

    def create_all(self) -> None:
        Base.metadata.create_all(self.engine)
        if self.engine.dialect.name == "sqlite":
            self._ensure_column("games", "scene", "VARCHAR(12) NOT NULL DEFAULT 'tea'")
            # 开局协商状态：SQLite 的 ADD COLUMN 不支持 JSON 类型别名，落 TEXT 即可，
            # SQLAlchemy 的 JSON 列在 SQLite 上本来也映射为 TEXT，读写一致。
            self._ensure_column("games", "opening", "TEXT")
            # 积分系统后端化：老库存量用户一次性按初始积分 10000 补列。
            self._ensure_column("users", "points", "INTEGER NOT NULL DEFAULT 10000")
            self._ensure_column("users", "unlocked", "VARCHAR(512) NOT NULL DEFAULT '[]'")
            self._ensure_column("games", "rule", "VARCHAR(8) NOT NULL DEFAULT 'freestyle'")
            self._ensure_column("games", "ai_black", "BOOLEAN NOT NULL DEFAULT 0")
            self._ensure_column("games", "ai_white", "BOOLEAN NOT NULL DEFAULT 0")
            self._ensure_column("users", "equipped", "VARCHAR(256) NOT NULL DEFAULT '{}'")
            self._ensure_column("users", "preferences", "VARCHAR(4096) NOT NULL DEFAULT '{}'")
            self._ensure_column("games", "keep_forever", "BOOLEAN NOT NULL DEFAULT 0")
            self._ensure_column("games", "restart_from", "VARCHAR(32)")
            self._ensure_column("games", "excluded_from_stats", "BOOLEAN NOT NULL DEFAULT 0")

    def _ensure_column(self, table: str, column: str, ddl: str) -> None:
        """给早版本的库补列。

        `create_all` 只建不存在的表，不会给已存在的表加新列——本机跑着的老
        ``games`` 表没有 scene，一查就报 "no such column"。SQLite 的 ADD COLUMN
        支持常量默认值，正好够用；幂等性由 `PRAGMA table_info` 的列名判断保证，
        所以每次启动跑一遍是安全的。
        """
        with self.engine.connect() as connection:
            existing = {row[1] for row in connection.exec_driver_sql(f"PRAGMA table_info({table})")}
            if column in existing:
                return
            connection.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
            connection.commit()

    @contextmanager
    def session(self) -> Iterator[Session]:
        with self.sessions() as session:
            try:
                yield session
                session.commit()
            except Exception:
                session.rollback()
                raise

    def dispose(self) -> None:
        self.engine.dispose()
