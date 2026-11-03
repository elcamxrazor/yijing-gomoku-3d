from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


BASE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    """Runtime settings loaded from environment variables."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # 引擎（Rapfi WASM）已迁到前端：服务端不再有任何引擎进程或相关配置。
    # ai_idle_release_seconds 一并退役——没有需要释放的引擎会话了。
    database_url: str = f"sqlite:///{(BASE_DIR / 'data' / 'gomoku.db').as_posix()}"
    session_ttl_hours: int = Field(default=168, ge=1, le=8760)
    reconnect_grace_seconds: int = Field(default=120, ge=1, le=86400)
    # 铜铃冷却（秒）。0 = 不限制，允许连按（含连点器）连续催铃。
    ring_cooldown_seconds: float = Field(default=0, ge=0, le=60)
    challenge_ttl_seconds: float = Field(default=30.0, ge=1, le=600)
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    cookie_secure: bool = False
    port: int = Field(default=25562, ge=1, le=65535)
    cookie_name: str = "zen_session"
    frontend_dist: str = ""
    trust_proxy: bool = False
    # 网络电台的音乐目录。留空则用仓库根下的 radio/；目录不存在或没有音频文件时
    # 电台自动关闭，前端不显示入口。
    radio_dir: str = ""

    @property
    def cors_origin_list(self) -> list[str]:
        return [item.strip() for item in self.cors_origins.split(",") if item.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
