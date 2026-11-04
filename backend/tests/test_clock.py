"""读秒（每步限时）的对局权威测试。

设计取舍：所有「到点」都不真的等——把 `turn_started_at` 往过去拨，
或直接调 `_declare_timeout`，比 `asyncio.sleep(30)` 快且不引入抖动。
"""

import asyncio
import time

from fastapi.testclient import TestClient

from app.game import ALLOWED_PER_MOVE_MS, GameError
from app.main import create_app
from app.models import Game, User
from conftest import receive_request, receive_until, register


class RecordingHub:
    """只记录发送内容的最小 hub，用于不起 websocket 时驱动服务端逻辑。"""

    def __init__(self, online: set[int]):
        self.online = set(online)
        self.directed: list[tuple[int, dict]] = []
        self.broadcasts: list[str] = []

    def is_online(self, user_id: int) -> bool:
        return user_id in self.online

    async def broadcast_game(self, game_id: str) -> None:
        self.broadcasts.append(game_id)

    async def send_to_user(self, user_id: int, message: dict) -> None:
        self.directed.append((user_id, message))

    async def send_to_spectators(self, game_id: str, message: dict) -> None:
        pass

    async def send_restart_requested(self, game_id: str, from_user_id: int) -> None:
        self.directed.append((from_user_id, {"type": "game.restart_requested"}))

    async def send_undo_requested(self, game_id: str, from_user_id: int) -> None:
        self.directed.append((from_user_id, {"type": "game.undo_requested"}))


def make_clock_game(app, per_move_ms: int = 30_000, started: float | None = None):
    """建一盘「两位真人、已在计时」的联机棋。

    `started` 是回合起点的偏移秒数：负数表示「已经过去这么久」，
    用它模拟「这一手已经想了 31 秒」而不必真的等。
    """
    db = app.state.db
    db.create_all()
    now = time.time() + (started or 0.0)
    with db.session() as session:
        alice = User(name="alice", username_key="alice-key", guest=False)
        bob = User(name="bob", username_key="bob-key", guest=False)
        session.add_all([alice, bob])
        session.flush()
        game = Game(
            id="game-clock", mode="online", status="playing",
            black_player_id=str(alice.id), white_player_id=str(bob.id),
            time_mode="perMove", per_move_ms=per_move_ms,
            turn_started_at=now, turn_side="black",
        )
        session.add(game)
        return alice.id, bob.id


def load_user(app, user_id: int) -> User:
    with app.state.db.session() as session:
        return session.get(User, user_id)


# ---------------------------------------------------------------------------
# 档位与载荷
# ---------------------------------------------------------------------------


def test_time_control_is_none_by_default(app):
    """老客户端不带 timeControl：这一局就是不限时，且快照里说清楚。"""
    with TestClient(app) as client:
        register(client, "alice")
        with client.websocket_connect("/ws") as ws:
            ws.receive_json()
            ws.send_json({"type": "room.create", "requestId": "create", "payload": {}})
            snapshot = receive_request(ws, "create")["payload"]
            assert snapshot["timeControl"] == {"mode": "none", "perMoveMs": None}
            assert snapshot["clock"] is None


def test_invalid_per_move_is_rejected(app):
    with TestClient(app) as client:
        register(client, "alice")
        with client.websocket_connect("/ws") as ws:
            ws.receive_json()
            for bad in (1_000, 600_000, "abc", None):
                ws.send_json({
                    "type": "room.create",
                    "requestId": f"create-{bad}",
                    "payload": {"timeControl": {"mode": "perMove", "perMoveMs": bad}},
                })
                error = receive_request(ws, f"create-{bad}")["error"]
                assert error["code"] == "VALIDATION_ERROR"


def test_allowed_budgets_are_the_three_published_options(app):
    for budget in ALLOWED_PER_MOVE_MS:
        # requestId 每次都不同：内存库在 TestClient 退出时被 dispose，
        # 新会话里用户 id 会回到 1，而 hub 的响应缓存跨会话存活，
        # 复用同一个 requestId 就会读到上一轮的缓存快照。
        rid = f"create-{budget}"
        with TestClient(app) as client:
            register(client, f"player{budget}")
            with client.websocket_connect("/ws") as ws:
                ws.receive_json()
                ws.send_json({
                    "type": "room.create",
                    "requestId": rid,
                    "payload": {"timeControl": {"mode": "perMove", "perMoveMs": budget}},
                })
                snapshot = receive_request(ws, rid)["payload"]
                assert snapshot["timeControl"] == {"mode": "perMove", "perMoveMs": budget}
                # 房间里还在等人：表不起，否则等待对手的时间会白白扣掉。
                assert snapshot["clock"] is None


def test_clock_starts_only_after_the_opening_is_resolved(app):
    with TestClient(app) as alice_client, TestClient(app) as bob_client:
        register(alice_client, "alice")
        register(bob_client, "bob")
        with alice_client.websocket_connect("/ws") as alice, bob_client.websocket_connect("/ws") as bob:
            alice.receive_json()
            bob.receive_json()
            alice.send_json({
                "type": "room.create",
                "requestId": "create",
                "payload": {"timeControl": {"mode": "perMove", "perMoveMs": 60_000}},
            })
            created = receive_request(alice, "create")["payload"]
            bob.send_json({"type": "room.join", "requestId": "join", "payload": {"code": created["roomCode"]}})
            joined = receive_request(bob, "join")["payload"]
            # 两人到位，进入「决定先后手」：此时表还没起。
            assert joined["opening"] is not None
            assert joined["clock"] is None

            grant = "game.first_move_choice"
            alice.send_json({"type": grant, "requestId": "a1", "payload": {"gameId": created["id"], "choice": "self"}})
            receive_request(alice, "a1")
            bob.send_json({"type": grant, "requestId": "b1", "payload": {"gameId": created["id"], "choice": "opponent"}})
            snapshot = receive_until(
                bob, lambda m: m["type"] == "game.snapshot" and (m["payload"].get("clock") or {}).get("side")
            )["payload"]
            # 一致同意 alice 先手 → alice 落为黑方，表走在黑方身上。
            assert snapshot["opening"] is None
            assert snapshot["clock"]["side"] == "black"
            assert snapshot["clock"]["paused"] is False
            assert 55_000 < snapshot["clock"]["remainingMs"] <= 60_000


# ---------------------------------------------------------------------------
# 裁决
# ---------------------------------------------------------------------------


def test_expired_turn_loses_on_time(settings):
    app = create_app(settings)
    alice_id, bob_id = make_clock_game(app, started=-31)  # 30 秒的档位，已经想了 31 秒
    games = app.state.games
    hub = RecordingHub(online={alice_id, bob_id})
    games.hub = hub

    asyncio.run(games._declare_timeout("game-clock"))

    snapshot = games.snapshot("game-clock", alice_id)
    assert snapshot["status"] == "finished"
    assert snapshot["winReason"] == "timeout"
    # 该走的是黑方 alice，超时即黑负白胜。
    assert snapshot["winner"] == 2
    # 终局之后不该还挂着一只表。
    assert snapshot["clock"] is None
    assert hub.broadcasts == ["game-clock"]


def test_timeout_is_declared_only_once(settings):
    app = create_app(settings)
    alice_id, bob_id = make_clock_game(app, started=-31)
    games = app.state.games
    hub = RecordingHub(online={alice_id, bob_id})
    games.hub = hub

    asyncio.run(games._declare_timeout("game-clock"))
    asyncio.run(games._declare_timeout("game-clock"))

    assert hub.broadcasts == ["game-clock"]  # 第二次是空操作，不重复裁决


def test_a_move_that_arrives_too_late_is_rejected_and_loses(app):
    """「最后一刻落子」与「超时裁决」撞车：只能产生一个终局。"""
    alice_id, bob_id = make_clock_game(app, started=-31)
    games = app.state.games
    games.hub = RecordingHub(online={alice_id, bob_id})
    alice = load_user(app, alice_id)

    with __import__("pytest").raises(GameError) as info:
        asyncio.run(games.move(alice, "game-clock", 7, 7))
    assert info.value.code == "CLOCK_EXPIRED"

    snapshot = games.snapshot("game-clock", alice_id)
    assert snapshot["status"] == "finished"
    assert snapshot["winReason"] == "timeout"
    # 迟到的这一手不能真的落到盘上。
    assert snapshot["moveCount"] == 0


def test_not_yet_expired_move_is_accepted_and_hands_the_clock_over(app):
    alice_id, bob_id = make_clock_game(app, started=-5)  # 只用了 5 秒
    games = app.state.games
    games.hub = RecordingHub(online={alice_id, bob_id})
    alice = load_user(app, alice_id)

    asyncio.run(games.move(alice, "game-clock", 7, 7))

    snapshot = games.snapshot("game-clock", alice_id)
    assert snapshot["status"] == "playing"
    assert snapshot["moveCount"] == 1
    # 己方停、对方起，而且是完整的一份新预算。
    assert snapshot["clock"]["side"] == "white"
    assert snapshot["clock"]["remainingMs"] > 29_000


def test_no_clock_for_games_without_time_control(app):
    alice_id, bob_id = make_clock_game(app)
    games = app.state.games
    with app.state.db.session() as session:
        game = session.get(Game, "game-clock")
        game.time_mode = "none"
        game.per_move_ms = None
        game.turn_started_at = None
    games.hub = RecordingHub(online={alice_id, bob_id})

    asyncio.run(games._declare_timeout("game-clock"))
    snapshot = games.snapshot("game-clock", alice_id)
    # 不限时的局完全不受影响：200 秒的「过期」也不会判负。
    assert snapshot["status"] == "playing"
    assert snapshot["clock"] is None


def test_ai_games_never_run_a_clock(app):
    with TestClient(app) as client:
        register(client, "alice")
        with client.websocket_connect("/ws") as ws:
            ws.receive_json()
            ws.send_json({
                "type": "ai.create",
                "requestId": "ai",
                "payload": {"color": "black", "timeControl": {"mode": "perMove", "perMoveMs": 30_000}},
            })
            snapshot = receive_request(ws, "ai")["payload"]
            assert snapshot["mode"] == "ai"
            # 人机局不开放读秒：AI 的用时受用户设备影响，拿秒数判负不公平。
            assert snapshot["timeControl"] == {"mode": "none", "perMoveMs": None}
            assert snapshot["clock"] is None


# ---------------------------------------------------------------------------
# 断线暂停 / 恢复
# ---------------------------------------------------------------------------


def test_disconnect_pauses_the_clock_and_reconnect_resumes_it(settings):
    app = create_app(settings)
    alice_id, bob_id = make_clock_game(app, started=-10)  # 已经用了 10 秒
    games = app.state.games
    games.hub = RecordingHub(online={alice_id})

    asyncio.run(games.player_presence(bob_id, False))
    paused = games.snapshot("game-clock", alice_id)
    assert paused["status"] == "playing"
    assert paused["clock"]["paused"] is True
    # 停表时剩余时间冻结：白方的断线不会替黑方把时间走完。
    assert 19_000 < paused["clock"]["remainingMs"] <= 20_000

    # 断线期间过了 8 秒：表不该少一格。这里把「暂停起点」和「回合起点」
    # 一起前移 8 秒，等价于「这 8 秒本来就不在思考」。
    games._clock_pause["game-clock"] -= 8
    with app.state.db.session() as session:
        session.get(Game, "game-clock").turn_started_at -= 8
    still = games.snapshot("game-clock", alice_id)
    assert still["clock"]["remainingMs"] == paused["clock"]["remainingMs"]

    asyncio.run(games.player_presence(bob_id, True))
    resumed = games.snapshot("game-clock", alice_id)
    assert resumed["clock"]["paused"] is False
    # 从剩余的 20 秒继续：既没有白白少 8 秒，也没有重置成 30 秒。
    assert 19_000 < resumed["clock"]["remainingMs"] <= 20_500


def test_a_paused_clock_never_declares_a_timeout(settings):
    app = create_app(settings)
    alice_id, bob_id = make_clock_game(app, started=-999)
    games = app.state.games
    games.hub = RecordingHub(online={alice_id, bob_id})
    games._clock_pause["game-clock"] = time.time()

    asyncio.run(games._declare_timeout("game-clock"))
    assert games.snapshot("game-clock", alice_id)["status"] == "playing"


def test_offline_forfeit_stops_the_clock(settings):
    """断线判负之后，读秒必须彻底退出这盘棋，不能再判一次。"""
    tuned = settings.model_copy(update={"reconnect_grace_seconds": 1})
    app = create_app(tuned)
    alice_id, bob_id = make_clock_game(app, started=-5)
    games = app.state.games
    hub = RecordingHub(online={alice_id})
    games.hub = hub

    asyncio.run(games.player_presence(bob_id, False))
    games._offline_since[("game-clock", str(bob_id))] -= 2
    asyncio.run(games._check_disconnects())

    snapshot = games.snapshot("game-clock", alice_id)
    assert snapshot["status"] == "finished"
    assert snapshot["winReason"] == "offline"
    assert snapshot["clock"] is None


# ---------------------------------------------------------------------------
# 重开 / 恢复
# ---------------------------------------------------------------------------


def test_restart_gives_both_sides_a_fresh_budget(settings):
    app = create_app(settings)
    alice_id, bob_id = make_clock_game(app, started=-25)  # 只剩 5 秒
    games = app.state.games
    games.hub = RecordingHub(online={alice_id, bob_id})
    alice = load_user(app, alice_id)
    bob = load_user(app, bob_id)

    # 联机 PVP 重开要走一次「请求 → 同意」的握手。
    asyncio.run(games.restart(alice, "game-clock"))
    asyncio.run(games.restart_response(bob, "game-clock", True))

    snapshot = games.snapshot("game-clock", alice_id)
    assert snapshot["status"] == "playing"
    assert snapshot["clock"]["remainingMs"] > 29_000


def test_recovery_after_restart_does_not_forfeit_a_live_game(settings):
    """服务端重启时若这一回合已经过期，补满一份新预算，而不是当场判负。

    停机是服务端的事（部署、崩溃），不该由棋手买单。
    """
    app = create_app(settings)
    alice_id, bob_id = make_clock_game(app, started=-999)
    games = app.state.games
    games.hub = RecordingHub(online={alice_id, bob_id})

    asyncio.run(games.recover_clocks())

    snapshot = games.snapshot("game-clock", alice_id)
    assert snapshot["status"] == "playing"
    assert snapshot["winReason"] is None
    assert snapshot["clock"]["remainingMs"] > 29_000


def test_recovery_keeps_the_remaining_time_when_still_running(settings):
    app = create_app(settings)
    alice_id, bob_id = make_clock_game(app, started=-10)
    games = app.state.games
    games.hub = RecordingHub(online={alice_id, bob_id})

    asyncio.run(games.recover_clocks())

    snapshot = games.snapshot("game-clock", alice_id)
    assert 19_000 < snapshot["clock"]["remainingMs"] <= 20_000


# ----------------------------------------------------------------------
# 协议层：读秒必须能从客户端报文一路走到对局
# ----------------------------------------------------------------------


def test_room_create_accepts_time_control_over_the_wire(app):
    """`room.create` 带的 timeControl 要真的落到这一局的快照里。

    上面的用例都直接调服务方法，绕过了 `websocket.dispatch`；这条专门盯
    「客户端字段名拼错了 / 忘了往下传」这类只在协议层才暴露的问题。
    """
    with TestClient(app) as alice_client:
        register(alice_client, "alice")
        with alice_client.websocket_connect("/ws") as ws:
            ws.receive_json()
            ws.send_json({
                "type": "room.create", "requestId": "room-clock",
                "payload": {"timeControl": {"mode": "perMove", "perMoveMs": 60_000}},
            })
            snapshot = receive_request(ws, "room-clock")["payload"]
            assert snapshot["timeControl"] == {"mode": "perMove", "perMoveMs": 60_000}
            # 还在等人，没有对手也没有表。
            assert snapshot["status"] == "waiting"
            assert snapshot["clock"] is None


def test_room_create_without_time_control_defaults_to_untimed(app):
    """老客户端不带这个字段：必须还是不读秒，不能因为新字段报错。"""
    with TestClient(app) as alice_client:
        register(alice_client, "alice")
        with alice_client.websocket_connect("/ws") as ws:
            ws.receive_json()
            ws.send_json({"type": "room.create", "requestId": "room-plain", "payload": {}})
            snapshot = receive_request(ws, "room-plain")["payload"]
            assert snapshot["timeControl"] == {"mode": "none", "perMoveMs": None}
            assert snapshot["clock"] is None


def test_invalid_time_control_is_rejected_over_the_wire(app):
    """白名单只在服务端判：客户端送 1 秒要被当场拒掉，而不是建出一盘 1 秒的棋。"""
    with TestClient(app) as alice_client:
        register(alice_client, "alice")
        with alice_client.websocket_connect("/ws") as ws:
            ws.receive_json()
            ws.send_json({
                "type": "room.create", "requestId": "room-bad",
                "payload": {"timeControl": {"mode": "perMove", "perMoveMs": 1_000}},
            })
            response = receive_request(ws, "room-bad")
            assert response["error"]["code"] == "VALIDATION_ERROR"


def test_challenge_carries_time_control_to_the_accepted_game(app):
    """约战条件：发起方定，被约方在弹窗里就能看到，接受即沿用。"""
    with TestClient(app) as alice_client, TestClient(app) as bob_client:
        register(alice_client, "alice")
        bob = register(bob_client, "bob")
        with alice_client.websocket_connect("/ws") as alice_ws, bob_client.websocket_connect("/ws") as bob_ws:
            alice_ws.receive_json()
            bob_ws.receive_json()

            alice_ws.send_json({
                "type": "challenge.create", "requestId": "ch-clock",
                "payload": {"targetId": bob["id"], "timeControl": {"mode": "perMove", "perMoveMs": 30_000}},
            })
            receive_request(alice_ws, "ch-clock")
            invite = receive_until(bob_ws, lambda message: message["type"] == "challenge.incoming")["payload"]
            assert invite["timeControl"] == {"mode": "perMove", "perMoveMs": 30_000}

            bob_ws.send_json({
                "type": "challenge.respond", "requestId": "resp",
                "payload": {"challengeId": invite["challengeId"], "accept": True},
            })
            game = receive_until(bob_ws, lambda message: message["type"] == "game.snapshot")["payload"]
            assert game["timeControl"] == {"mode": "perMove", "perMoveMs": 30_000}
            # 发起方收到的是**同一盘**棋，条件当然也一样。
            accepted = receive_until(alice_ws, lambda message: message["type"] == "game.snapshot")["payload"]
            assert accepted["id"] == game["id"]
            assert accepted["timeControl"] == game["timeControl"]
