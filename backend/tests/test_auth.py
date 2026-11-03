from sqlalchemy import select

from conftest import register
from app.models import AuthSession, User


def test_register_me_logout_login_and_token_storage(client, app):
    user = register = client.post(
        "/api/auth/register", json={"username": "Alice", "password": "password123"}
    )
    assert user.status_code == 200
    assert user.json()["user"]["guest"] is False
    cookie = client.cookies.get("zen_session")
    assert cookie
    with app.state.db.session() as session:
        stored_user = session.scalar(select(User).where(User.username_key == "alice"))
        stored_session = session.scalar(select(AuthSession))
        assert stored_user.password_hash.startswith("$argon2id$")
        assert stored_user.password_hash != "password123"
        assert stored_session.token_hash != cookie
        assert len(stored_session.token_hash) == 64

    assert client.get("/api/auth/me").json()["user"]["name"] == "Alice"
    assert client.post("/api/auth/logout").status_code == 200
    assert client.get("/api/auth/me").json() == {"user": None}
    assert client.post(
        "/api/auth/login", json={"username": "alice", "password": "password123"}
    ).status_code == 200
    assert client.post(
        "/api/auth/login", json={"username": "alice", "password": "wrong-password"}
    ).status_code == 401


def test_guest_validation_and_health_do_not_leak_engine_path(client):
    me = client.get("/api/auth/me")
    assert me.json() == {"user": None}
    guest = client.post("/api/auth/guest")
    assert guest.status_code == 200
    assert guest.json()["user"]["guest"] is True
    assert client.post(
        "/api/auth/register", json={"username": "x", "password": "short"}
    ).status_code == 422
    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.json()["status"] == "ok"
    assert "path" not in health.text.lower()


def test_websocket_rejects_anonymous_connection(client):
    with client.websocket_connect("/ws") as websocket:
        message = websocket.receive_json()
        assert message["type"] == "error"
        assert message["error"]["code"] == "UNAUTHENTICATED"


def test_websocket_heartbeat(client):
    register(client, "heartbeat")
    with client.websocket_connect("/ws") as websocket:
        assert websocket.receive_json()["type"] == "session.ready"
        websocket.send_json({"type": "ping"})
        assert websocket.receive_json() == {"type": "pong"}
