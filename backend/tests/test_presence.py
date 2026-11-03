import asyncio
import time

from fastapi.testclient import TestClient

from app.main import create_app
from app.models import Game, User
from conftest import receive_request, receive_until, register


class RecordingHub:
    """只记录发送内容的最小 hub：用来在不起 websocket 的情况下驱动服务端逻辑。"""

    def __init__(self, online: set[int]):
        self.online = set(online)
        self.directed: list[tuple[int, dict]] = []
        self.watched: list[tuple[str, dict]] = []
        self.broadcasts: list[str] = []

    def is_online(self, user_id: int) -> bool:
        return user_id in self.online

    async def broadcast_game(self, game_id: str) -> None:
        self.broadcasts.append(game_id)

    async def send_to_user(self, user_id: int, message: dict) -> None:
        self.directed.append((user_id, message))

    async def send_to_spectators(self, game_id: str, message: dict) -> None:
        self.watched.append((game_id, message))


def make_game(app, grace: int = 30):
    db = app.state.db
    db.create_all()
    with db.session() as session:
        alice = User(name="alice", username_key="alice-key", guest=False)
        bob = User(name="bob", username_key="bob-key", guest=False)
        session.add_all([alice, bob])
        session.flush()
        game = Game(
            id="game-1", mode="online", status="playing",
            black_player_id=str(alice.id), white_player_id=str(bob.id),
        )
        session.add(game)
        return alice.id, bob.id


def test_presence_is_announced_to_the_opponent_over_websocket(app):
    with TestClient(app) as alice_client, TestClient(app) as bob_client:
        register(alice_client, "alice")
        register(bob_client, "bob")
        with alice_client.websocket_connect("/ws") as alice:
            alice.receive_json()
            with bob_client.websocket_connect("/ws") as bob:
                bob.receive_json()
                alice.send_json({"type": "room.create", "requestId": "create", "payload": {}})
                created = receive_request(alice, "create")["payload"]
                bob.send_json({"type": "room.join", "requestId": "join", "payload": {"code": created["roomCode"]}})
                receive_request(bob, "join")
                receive_until(alice, lambda m: m["type"] == "game.snapshot" and m["payload"]["status"] == "playing")

            # bob 的页面关掉了：alice 立刻收到「对手断线 + 还有多久判负」。
            gone = receive_until(alice, lambda m: m["type"] == "game.presence")["payload"]
            assert gone["online"] is False
            assert gone["color"] == "white"
            assert gone["name"] == "bob"
            assert gone["reconnectInMs"] == app.state.settings.reconnect_grace_seconds * 1000

            # 断线期间它仍然是一盘活棋，而且快照里带着同一个倒计时。
            state = receive_until(alice, lambda m: m["type"] == "game.snapshot")["payload"]
            assert state["status"] == "playing"
            assert state["presence"]["white"] > 0
            assert state["presence"]["black"] == 0

            with bob_client.websocket_connect("/ws") as bob:
                bob.receive_json()
                back = receive_until(alice, lambda m: m["type"] == "game.presence")["payload"]
                assert back["online"] is True
                assert back["color"] == "white"


def test_reconnect_grace_expiry_forfeits_the_absent_player(settings):
    tuned = settings.model_copy(update={"reconnect_grace_seconds": 1})
    app = create_app(tuned)
    alice_id, bob_id = make_game(app)
    games = app.state.games
    hub = RecordingHub(online={alice_id})
    games.hub = hub

    asyncio.run(games.player_presence(bob_id, False))
    event = hub.directed[-1][1]
    assert event["type"] == "game.presence" and event["payload"]["online"] is False

    # 把起点往前拨两秒，等价于「已经断线超过宽限」，不必真的等。
    games._offline_since[("game-1", str(bob_id))] -= 2
    asyncio.run(games._check_disconnects())

    assert hub.broadcasts[-1] == "game-1"
    snapshot = games.snapshot("game-1", alice_id)
    assert snapshot["status"] == "finished"
    assert snapshot["winner"] == 1
    assert snapshot["winReason"] == "offline"
    # 终局之后不该再有「对方断线中」的横幅。
    assert snapshot["presence"] is None

    # 断线的人回来看到的是结果，而不是一盘还能接着下的棋。
    restored = games.snapshot("game-1", bob_id)
    assert restored["status"] == "finished" and restored["winReason"] == "offline"


def test_disconnect_is_not_counted_while_the_opponent_is_also_away(settings):
    tuned = settings.model_copy(update={"reconnect_grace_seconds": 1})
    app = create_app(tuned)
    alice_id, bob_id = make_game(app)
    games = app.state.games
    games.hub = RecordingHub(online=set())

    asyncio.run(games.player_presence(bob_id, False))
    assert games._offline_since == {}
    asyncio.run(games._check_disconnects())
    assert games.snapshot("game-1", alice_id)["status"] == "playing"


def test_ring_forwarded_to_opponent_and_rate_limited(app):
    # 默认冷却为 0（可连按）。这里显式开启冷却，专门验证限流分支仍然有效。
    app.state.games.settings.ring_cooldown_seconds = 2.5
    with TestClient(app) as alice_client, TestClient(app) as bob_client, TestClient(app) as cara_client:
        register(alice_client, "alice")
        register(bob_client, "bob")
        register(cara_client, "cara")
        with (
            alice_client.websocket_connect("/ws") as alice,
            bob_client.websocket_connect("/ws") as bob,
            cara_client.websocket_connect("/ws") as cara,
        ):
            for socket in (alice, bob, cara):
                socket.receive_json()
            alice.send_json({"type": "room.create", "requestId": "create", "payload": {}})
            created = receive_request(alice, "create")["payload"]
            bob.send_json({"type": "room.join", "requestId": "join", "payload": {"code": created["roomCode"]}})
            receive_request(bob, "join")
            cara.send_json({"type": "spectate.join", "requestId": "watch", "payload": {"gameId": created["id"]}})
            receive_request(cara, "watch")

            alice.send_json({"type": "game.ring", "requestId": "ring1", "payload": {"gameId": created["id"]}})
            assert receive_request(alice, "ring1")["payload"]["accepted"] is True
            rung = receive_until(bob, lambda m: m["type"] == "game.ring")["payload"]
            assert rung["fromName"] == "alice"
            assert rung["color"] == 1
            # 旁观者也听得见铃声：那不是私聊，是房间里的声音。
            assert receive_until(cara, lambda m: m["type"] == "game.ring")["payload"]["gameId"] == created["id"]

            # 冷却内再按一次：本地照响，但不会打扰对手。
            alice.send_json({"type": "game.ring", "requestId": "ring2", "payload": {"gameId": created["id"]}})
            assert receive_request(alice, "ring2")["payload"]["accepted"] is False

            app.state.games._ring_at[created["id"]] = time.monotonic() - 10
            bob.send_json({"type": "game.ring", "requestId": "ring3", "payload": {"gameId": created["id"]}})
            assert receive_request(bob, "ring3")["payload"]["accepted"] is True
            back = receive_until(alice, lambda m: m["type"] == "game.ring")["payload"]
            assert back["fromName"] == "bob" and back["color"] == 2


def test_ring_cooldown_defaults_to_zero(settings):
    """默认不限制催铃频率：连按（含连点器）每次都会转发给对手。"""
    assert settings.ring_cooldown_seconds == 0


def test_ring_rejected_outside_a_live_online_game(app):
    with TestClient(app) as alice_client:
        register(alice_client, "alice")
        with alice_client.websocket_connect("/ws") as alice:
            alice.receive_json()
            alice.send_json({"type": "room.create", "requestId": "create", "payload": {}})
            created = receive_request(alice, "create")["payload"]
            # 房间还在等人：铃响了也没人听。
            alice.send_json({"type": "game.ring", "requestId": "ring", "payload": {"gameId": created["id"]}})
            assert receive_request(alice, "ring")["error"]["code"] == "RING_NOT_ALLOWED"
