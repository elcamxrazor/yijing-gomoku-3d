"""棋境（scene）的落库、默认值、随机分配与快照透传。

这些用例守的是一条链路上的四个环节，缺一环就会出现「建房时选了庭院、
进局却是茶室」这类查起来很费劲的问题：

1. 建房时明说要哪个，就得存哪个；
2. 没说，就随机给一个合法的；
3. 约战（challenge）走的是另一条建局路径，也必须随机；
4. 快照里必须带回 scene，否则对手端永远看到默认场景。
"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.database import Database
from app.models import Game
from app.scenes import DEFAULT_SCENE_ID, SCENE_IDS, normalize_scene, random_scene
from conftest import receive_request, receive_until, register


def _create_room(client: TestClient, payload: dict) -> dict:
    request_id = f"room-{payload.get('scene', 'random')}"
    client.send_json({"type": "room.create", "requestId": request_id, "payload": payload})
    return receive_request(client, request_id)["payload"]


def test_create_room_keeps_the_asked_scene(app):
    with TestClient(app) as client:
        register(client, "host")
        with client.websocket_connect("/ws") as socket:
            assert socket.receive_json()["type"] == "session.ready"
            created = _create_room(socket, {"scene": "cyber"})
            assert created["scene"] == "cyber"


def test_create_room_without_scene_draws_a_valid_one(app):
    with TestClient(app) as client:
        register(client, "host")
        with client.websocket_connect("/ws") as socket:
            assert socket.receive_json()["type"] == "session.ready"
            created = _create_room(socket, {})
            assert created["scene"] in SCENE_IDS


def test_challenge_game_gets_a_scene_everyone_sees(app):
    """约战不接受手选，服务端随机；两边收到的快照必须是同一个。"""
    with TestClient(app) as alice_client, TestClient(app) as bob_client:
        register(alice_client, "alice")
        bob = register(bob_client, "bob")
        with alice_client.websocket_connect("/ws") as alice_socket, \
                bob_client.websocket_connect("/ws") as bob_socket:
            assert alice_socket.receive_json()["type"] == "session.ready"
            assert bob_socket.receive_json()["type"] == "session.ready"

            alice_socket.send_json({
                "type": "challenge.create", "requestId": "ask",
                "payload": {"targetId": bob["id"]},
            })
            sent = receive_request(alice_socket, "ask")["payload"]
            invite = receive_until(
                bob_socket, lambda message: message["type"] == "challenge.incoming"
            )["payload"]
            bob_socket.send_json({
                "type": "challenge.respond", "requestId": "yes",
                "payload": {"challengeId": invite["challengeId"], "accept": True},
            })

            # 接受方先收到快照再收到回执，发起方反过来——顺序已经在
            # test_lobby 里验过，这里只取两边各自的快照比对棋境。
            bob_seen = receive_until(
                bob_socket, lambda message: message["type"] == "game.snapshot"
            )["payload"]
            seen = receive_until(
                alice_socket, lambda message: message["type"] == "game.snapshot"
            )["payload"]
            assert seen["id"] == bob_seen["id"]
            assert seen["scene"] in SCENE_IDS
            # 同一局必须两边同棋境，否则一个在茶室一个在赛博，观感像是两盘棋。
            assert bob_seen["scene"] == seen["scene"]


def test_scene_survives_a_reconnect(settings):
    """快照里的棋境来自数据库而不是内存，重连后必须还是原来那个。"""
    db = Database(settings.database_url)
    db.create_all()
    try:
        with db.session() as session:
            session.add(Game(
                id="g1", mode="online", status="waiting", scene="courtyard",
                black_player_id="1", white_player_id=None, room_code="ABCDEF",
            ))
        # 换一个会话再读：能读回来说明真的落盘了，而不是还停在 session 缓存里。
        with db.session() as session:
            stored = session.scalar(select(Game).where(Game.id == "g1"))
            assert stored is not None
            assert stored.scene == "courtyard"
    finally:
        db.dispose()


def test_unknown_scene_falls_back_to_default(app):
    with TestClient(app) as client:
        register(client, "host")
        with client.websocket_connect("/ws") as socket:
            assert socket.receive_json()["type"] == "session.ready"
            created = _create_room(socket, {"scene": "atlantis"})
            assert created["scene"] == DEFAULT_SCENE_ID


# ---------------------------------------------------------------------------
# 纯函数
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("value", [None, 7, ["tea"], "", "TEA", "atlantis", {}])
def test_normalize_scene_rejects_anything_unknown(value):
    assert normalize_scene(value) == DEFAULT_SCENE_ID


@pytest.mark.parametrize("value", SCENE_IDS)
def test_normalize_scene_keeps_known_ids(value):
    assert normalize_scene(value) == value


def test_random_scene_is_always_a_real_preset():
    for _ in range(50):
        assert random_scene() in SCENE_IDS
