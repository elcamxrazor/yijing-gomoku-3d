"""前端产物挂载的回归测试。

背景：2026-11-05 线上出现过「后端启动正常、/api/health 200，但页面全 404」——
旧实现只在启动瞬间判定一次 dist 是否存在，找不到就不 mount，且日志里没有任何提示。
这里锁住三件事：缺失要报错且指得清、后到的产物要能自动接管、客户端路由仍回落到 index.html。
"""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.main import SPAFrontend


def mount_app(candidates) -> FastAPI:
    app = FastAPI()
    app.mount("/", SPAFrontend(candidates), name="frontend")
    return app


def test_missing_build_fails_loudly(tmp_path):
    frontend = SPAFrontend([tmp_path / "dist"])
    app = FastAPI()
    app.mount("/", frontend, name="frontend")

    with TestClient(app) as client:
        page = client.get("/")
        assert page.status_code == 503
        # 提示必须指向产物目录，否则运维只能对着空白 404 猜
        assert "frontend/dist" in page.text
        assert frontend.mounted is False

        # API 的 404 语义不能被这次降级改写
        assert client.get("/api/does-not-exist").status_code == 404


def test_build_landing_after_startup_is_served(tmp_path):
    dist = tmp_path / "dist"
    frontend = SPAFrontend([dist])
    app = FastAPI()
    app.mount("/", frontend, name="frontend")

    with TestClient(app) as client:
        assert client.get("/").status_code == 503
        assert frontend.mounted is False

        # 先起后端、后跑 npm run build：产物就位后应当自动接管，不必重启
        dist.mkdir()
        (dist / "index.html").write_text("<!doctype html><title>棋局</title>", encoding="utf-8")

        page = client.get("/")
        assert page.status_code == 200
        assert "棋局" in page.text
        assert frontend.mounted is True


def test_client_side_routes_fall_back_to_index(tmp_path):
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<!doctype html><title>棋局</title>", encoding="utf-8")

    with TestClient(mount_app([dist])) as client:
        lobby = client.get("/lobby")
        assert lobby.status_code == 200
        assert "棋局" in lobby.text


def test_unknown_api_path_stays_404(tmp_path):
    """未知的 /api/* 必须 404，不能回落成前端页面。

    Windows 上 StaticFiles 收到的路径是 `api\\x`（normpath 把 / 换成 \\），
    早先的 startswith("api/") 判不出来，接口 404 会被 index.html 200 吞掉。
    """
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<!doctype html><title>棋局</title>", encoding="utf-8")

    with TestClient(mount_app([dist])) as client:
        assert client.get("/api/does-not-exist").status_code == 404
        assert client.get("/api").status_code == 404
        assert client.get("/assets/missing.js").status_code == 404
        # 前端路由仍然回落到 index.html，别把 SPA 一起改坏
        assert client.get("/lobby").status_code == 200


def test_health_reports_frontend_state(client):
    payload = client.get("/api/health").json()
    assert payload["status"] == "ok"
    assert isinstance(payload["frontend"]["mounted"], bool)
