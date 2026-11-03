import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture
def settings() -> Settings:
    return Settings(
        database_url="sqlite://",
        reconnect_grace_seconds=30,
    )


@pytest.fixture
def app(settings):
    # 引擎（Rapfi WASM）跑在浏览器端：后端测试里「AI 的着法」由测试自己
    # 通过 `game.ai_move` 模拟客户端提交，不再需要引擎桩。
    return create_app(settings)


def send_ai_move(websocket, request_id: str, game_id: str, row: int, col: int) -> dict:
    """以客户端身份提交 AI 着法（服务端会校验轮次与合法性）。"""
    websocket.send_json({
        "type": "game.ai_move",
        "requestId": request_id,
        "payload": {"gameId": game_id, "row": row, "col": col},
    })
    return receive_request(websocket, request_id)


@pytest.fixture
def client(app):
    with TestClient(app) as test_client:
        yield test_client


def register(client: TestClient, username: str = "player", password: str = "correct-horse") -> dict:
    response = client.post("/api/auth/register", json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    return response.json()["user"]


def receive_until(websocket, predicate, limit: int = 20) -> dict:
    seen = []
    for _ in range(limit):
        message = websocket.receive_json()
        seen.append(message)
        if predicate(message):
            return message
    raise AssertionError(f"expected message not received: {seen}")


def receive_request(websocket, request_id: str) -> dict:
    return receive_until(websocket, lambda message: message.get("requestId") == request_id)


def receive_state(websocket, request_id: str, predicate, limit: int = 30):
    """Wait for both the tagged acknowledgement and a state matching predicate.

    AI replies are asynchronous, so the tagged response may already contain the
    final state or may arrive before the AI broadcast.
    """
    acknowledgement = None
    state = None
    for _ in range(limit):
        message = websocket.receive_json()
        if message.get("requestId") == request_id:
            acknowledgement = message
        if message.get("type") == "game.snapshot" and predicate(message["payload"]):
            state = message["payload"]
        if acknowledgement is not None:
            if predicate(acknowledgement["payload"]):
                state = acknowledgement["payload"]
            if state is not None:
                return acknowledgement, state
    raise AssertionError(f"expected state not received for request {request_id}")
