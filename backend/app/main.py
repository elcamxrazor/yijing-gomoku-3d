import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from .auth_routes import router as auth_router
from .config import BASE_DIR, Settings, get_settings
from .database import Database
from .game import GameService
from .hub import ConnectionHub
from .lobby import LobbyService
from .radio import RadioLibrary
from .radio_routes import router as radio_router
from .profile_routes import router as profile_router, shop_router as shop_router
from .replay import ReplayService
from .replay_routes import router as replay_router
from .security import AuthService
from .spectate import SpectatorService
from .websocket import websocket_endpoint


class SPAStaticFiles(StaticFiles):
    """Serve built assets and fall back to index.html for client-side routes."""

    async def get_response(self, path: str, scope):
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if (
                exc.status_code == 404
                and scope["method"] == "GET"
                and not path.startswith(("api/", "assets/"))
                and "." not in path.rsplit("/", 1)[-1]
            ):
                return await super().get_response("index.html", scope)
            raise


# 复用 uvicorn 已配置好的 handler：应用自己不做 logging 配置，
# 用这个名字能保证 INFO/WARNING 都进 _restart.log，而不是被 lastResort 吞掉。
logger = logging.getLogger("uvicorn.error")

FRONTEND_MISSING = (
    "前端产物未生成（frontend/dist/index.html 不存在），当前只提供 API。\n"
    "请执行 npm run build 或 tools/deploy.cmd；产物就位后无需重启，本服务会自动接管。\n"
)


class SPAFrontend:
    """前端产物的挂载点，按需解析目录。

    产物目录在**每次请求时**才解析，而不是启动时判定一次：先起后端、后跑
    `npm run build` 是常见顺序，旧实现遇到这种情况会永久只服务 API（页面全 404），
    日志里却看不出任何异常。现在启动缺失会告警，产物后到也能自动接管。
    """

    def __init__(self, candidates: list[Path]) -> None:
        self._candidates = candidates
        self._static: SPAStaticFiles | None = None
        self._dist: Path | None = None
        self._warned = False

    @property
    def mounted(self) -> bool:
        return self._static is not None

    @property
    def dist(self) -> Path | None:
        return self._dist

    def resolve(self) -> Path | None:
        for candidate in self._candidates:
            if (candidate / "index.html").is_file():
                return candidate.resolve()
        return None

    def ensure(self) -> bool:
        """首次解析成功后挂上 StaticFiles；后续调用只是读缓存。"""
        if self._static is not None:
            return True
        dist = self.resolve()
        if dist is None:
            return False
        self._static = SPAStaticFiles(directory=dist, html=True)
        self._dist = dist
        logger.info("前端静态目录已挂载：%s", dist)
        return True

    async def __call__(self, scope, receive, send) -> None:
        if self.ensure():
            await self._static(scope, receive, send)
            return

        # 产物还没到位：API 保持 404 语义，页面给 503 + 明确原因，别让人对着空白 404 猜。
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1011})
            return
        if scope["type"] != "http":
            return

        is_api = scope.get("path", "").startswith("/api/")
        status = 404 if is_api else 503
        body = b"Not Found" if is_api else FRONTEND_MISSING.encode("utf-8")
        if not is_api and not self._warned:
            self._warned = True
            logger.warning(FRONTEND_MISSING.strip())
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [
                    (b"content-type", b"text/plain; charset=utf-8"),
                    (b"cache-control", b"no-store"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    db = Database(settings.database_url)
    games = GameService(db, settings)
    hub = ConnectionHub(games)
    lobby = LobbyService(games, settings)
    spectate = SpectatorService(games)
    # 复盘只读，不依赖对局服务：它直接查库，也就不受「这盘棋在不在内存里」影响。
    replay = ReplayService(db)
    radio = RadioLibrary(
        Path(settings.radio_dir).expanduser() if settings.radio_dir else BASE_DIR.parent / "radio"
    )
    games.hub = hub
    games.lobby = lobby
    games.spectate = spectate
    lobby.hub = hub
    spectate.hub = hub
    hub.spectate = spectate

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        db.create_all()
        await games.recover_ai_games()
        # 进行中的限时局：按库里的回合起点重算剩余时间并重新排表。
        await games.recover_clocks()
        games.start_presence_monitor()
        games.start_retention_monitor()
        lobby.start()
        try:
            yield
        finally:
            await lobby.shutdown()
            await games.shutdown()
            db.dispose()

    app = FastAPI(title="Zen Gomoku API", lifespan=lifespan)

    # 跨域隔离：前端 Rapfi WASM 引擎的多线程构建需要 SharedArrayBuffer，
    # 浏览器要求全站带这两个头才放行。本站素材全部自托管，COEP 无副作用。
    @app.middleware("http")
    async def cross_origin_isolation(request, call_next):
        response = await call_next(request)
        response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        response.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
        return response

    app.state.settings = settings
    app.state.db = db
    app.state.games = games
    app.state.hub = hub
    app.state.lobby = lobby
    app.state.spectate = spectate
    app.state.replay = replay
    app.state.radio = radio
    app.state.auth = AuthService(db, settings)

    if settings.cors_origin_list:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origin_list,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    candidates: list[Path] = []
    if settings.frontend_dist:
        candidates.append(Path(settings.frontend_dist))
    candidates.extend([
        BASE_DIR.parent / "frontend" / "dist",  # local repository layout
        BASE_DIR / "frontend" / "dist",          # container image layout
    ])
    frontend = SPAFrontend(candidates)
    if not frontend.ensure():
        logger.warning(
            "未找到前端产物，页面请求将返回 503（仅 API 可用）。候选目录：%s",
            "、".join(str(path) for path in candidates),
        )

    @app.get("/api/health")
    def health() -> dict:
        return {
            "status": "ok",
            "service": "zen-gomoku-backend",
            # tracks 为 0 通常就是「电台没出现」的全部原因：目录里没有音频文件。
            "radio": {"enabled": radio.count > 0, "tracks": radio.count},
            "engine": {"provider": "rapfi-wasm", "location": "client"},
            # mounted 为 false = 只有 API 能用、页面全 503，一眼就能看出来。
            "frontend": {"mounted": frontend.mounted},
        }

    app.include_router(auth_router)
    app.include_router(radio_router)
    app.include_router(replay_router)
    app.include_router(profile_router)
    app.include_router(shop_router)
    app.add_api_websocket_route("/ws", websocket_endpoint)

    # 挂在最后：/api 与 /ws 先匹配，其余路径（含前端路由）落到这里。
    app.mount("/", frontend, name="frontend")
    return app


app = create_app()


def _port_available(port: int, host: str = "0.0.0.0") -> bool:
    """Return True when the TCP port can be bound (best-effort preflight)."""
    import socket

    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    try:
        probe.bind((host, port))
        return True
    except OSError:
        return False
    finally:
        probe.close()


if __name__ == "__main__":
    import sys

    import uvicorn

    settings = get_settings()
    if not _port_available(settings.port):
        print(
            f"\n[zen-gomoku] 端口 {settings.port} 已被其他程序占用，无法启动。\n"
            f"  1) 查看占用进程：Windows `netstat -ano | findstr :{settings.port}`，"
            f"macOS/Linux `lsof -iTCP:{settings.port} -sTCP:LISTEN`\n"
            f"  2) 停止占用进程，或换一个端口启动，例如：PORT=8080 python -m app.main\n"
            f"  3) 换端口时请同步修改 frontend/vite.config.ts 的 dev 端口或反向代理配置。\n",
            file=sys.stderr,
        )
        raise SystemExit(1)
    uvicorn.run("app.main:app", host="0.0.0.0", port=settings.port)
