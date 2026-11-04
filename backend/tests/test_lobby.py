import time

from fastapi.testclient import TestClient

from app.main import create_app
from conftest import receive_request, receive_until, register


def watch(websocket) -> dict:
    websocket.send_json({"type": "lobby.watch", "payload": {"on": True}})
    return receive_until(websocket, lambda message: message["type"] == "lobby.players")


def focus(websocket, game_id: str | None) -> None:
    websocket.send_json({"type": "game.focus", "payload": {"gameId": game_id}})


def test_lobby_roster_lists_presence_and_seat(app):
    with TestClient(app) as alice_client, TestClient(app) as bob_client:
        alice = register(alice_client, "alice")
        bob = register(bob_client, "bob")
        with alice_client.websocket_connect("/ws") as alice_ws, bob_client.websocket_connect("/ws") as bob_ws:
            alice_ws.receive_json()
            bob_ws.receive_json()

            payload = watch(alice_ws)["payload"]
            players = {player["id"]: player for player in payload["players"]}
            assert set(players) == {alice["id"], bob["id"]}
            assert all(player["status"] == "idle" for player in players.values())
            assert payload["counts"] == {"online": 2, "idle": 2}

            # 坐上棋盘（报告 focus）之后，名单立刻从「空闲」变成「房间等待」。
            alice_ws.send_json({"type": "room.create", "requestId": "create", "payload": {}})
            created = receive_request(alice_ws, "create")["payload"]
            assert created["status"] == "waiting"
            focus(alice_ws, created["id"])
            seated = receive_until(
                alice_ws,
                lambda message: message["type"] == "lobby.players"
                and any(player["status"] == "waiting" for player in message["payload"]["players"]),
            )["payload"]
            assert next(p for p in seated["players"] if p["id"] == alice["id"])["status"] == "waiting"
            assert seated["counts"] == {"online": 2, "idle": 1}

            # 离开棋盘就回到空闲：一盘没下完的棋不会把人永久钉在「对弈中」。
            focus(alice_ws, None)
            idle = receive_until(
                alice_ws,
                lambda message: message["type"] == "lobby.players"
                and all(player["status"] == "idle" for player in message["payload"]["players"]),
            )["payload"]
            assert idle["counts"] == {"online": 2, "idle": 2}

            # 订阅是可以关掉的：关掉之后不再收到名单推送。
            alice_ws.send_json({"type": "lobby.watch", "payload": {"on": False}})
            alice_ws.send_json({"type": "ping"})
            assert alice_ws.receive_json() == {"type": "pong"}


def test_challenge_accept_starts_a_game_for_both_players(app):
    with TestClient(app) as alice_client, TestClient(app) as bob_client:
        alice = register(alice_client, "alice")
        bob = register(bob_client, "bob")
        with alice_client.websocket_connect("/ws") as alice_ws, bob_client.websocket_connect("/ws") as bob_ws:
            alice_ws.receive_json()
            bob_ws.receive_json()

            alice_ws.send_json({"type": "challenge.create", "requestId": "ch", "payload": {"targetId": bob["id"]}})
            sent = receive_request(alice_ws, "ch")["payload"]
            assert sent["target"]["name"] == "bob"
            assert sent["expiresInMs"] > 0

            invite = receive_until(bob_ws, lambda message: message["type"] == "challenge.incoming")["payload"]
            assert invite["from"] == {"id": alice["id"], "name": "alice", "guest": False}
            assert invite["challengeId"] == sent["challengeId"]

            bob_ws.send_json({
                "type": "challenge.respond", "requestId": "resp",
                "payload": {"challengeId": invite["challengeId"], "accept": True},
            })
            # 接受方先收到棋局快照，再收到自己的回执。
            bob_snapshot = bob_ws.receive_json()
            assert bob_snapshot["type"] == "game.snapshot"
            ack = bob_ws.receive_json()
            assert ack["type"] == "challenge.result" and ack["payload"]["status"] == "accepted"

            # 发起方先收到回执，再收到棋局快照。
            accepted = receive_until(alice_ws, lambda message: message["type"] == "challenge.result")["payload"]
            assert accepted["status"] == "accepted"
            game = receive_until(alice_ws, lambda message: message["type"] == "game.snapshot")["payload"]

            assert game["id"] == accepted["gameId"] == ack["payload"]["gameId"] == bob_snapshot["payload"]["id"]
            assert game["mode"] == "online"
            assert game["status"] == "playing"
            assert game["roomCode"] is None
            assert {bob_snapshot["payload"]["yourColor"], game["yourColor"]} == {1, 2}
            assert {game["players"]["black"]["name"], game["players"]["white"]["name"]} == {"alice", "bob"}


def test_challenge_declined_leaves_no_game(app):
    with TestClient(app) as alice_client, TestClient(app) as bob_client:
        register(alice_client, "alice")
        bob = register(bob_client, "bob")
        with alice_client.websocket_connect("/ws") as alice_ws, bob_client.websocket_connect("/ws") as bob_ws:
            alice_ws.receive_json()
            bob_ws.receive_json()
            alice_ws.send_json({"type": "challenge.create", "requestId": "ch", "payload": {"targetId": bob["id"]}})
            invite = receive_until(bob_ws, lambda message: message["type"] == "challenge.incoming")["payload"]

            bob_ws.send_json({
                "type": "challenge.respond", "requestId": "resp",
                "payload": {"challengeId": invite["challengeId"], "accept": False},
            })
            assert bob_ws.receive_json()["payload"]["status"] == "declined"

            seen = receive_until(alice_ws, lambda message: message["type"] == "challenge.result")["payload"]
            assert seen["status"] == "declined"
            assert seen["byName"] == "bob"

        with bob_client.websocket_connect("/ws") as bob_ws:
            assert bob_ws.receive_json()["payload"]["games"] == []


def test_challenge_target_must_be_online(app):
    with TestClient(app) as alice_client, TestClient(app) as bob_client:
        register(alice_client, "alice")
        bob = register(bob_client, "bob")
        with alice_client.websocket_connect("/ws") as alice_ws:
            alice_ws.receive_json()
            alice_ws.send_json({"type": "challenge.create", "requestId": "ch", "payload": {"targetId": bob["id"]}})
            error = receive_request(alice_ws, "ch")
            assert error["type"] == "error"
            assert error["error"]["code"] == "PLAYER_OFFLINE"


def test_challenge_rejects_self_pending_and_busy_players(app):
    with TestClient(app) as alice_client, TestClient(app) as bob_client:
        alice = register(alice_client, "alice")
        bob = register(bob_client, "bob")
        with alice_client.websocket_connect("/ws") as alice_ws, bob_client.websocket_connect("/ws") as bob_ws:
            alice_ws.receive_json()
            bob_ws.receive_json()

            alice_ws.send_json({"type": "challenge.create", "requestId": "self", "payload": {"targetId": alice["id"]}})
            assert receive_request(alice_ws, "self")["error"]["code"] == "CHALLENGE_SELF"

            alice_ws.send_json({"type": "challenge.create", "requestId": "first", "payload": {"targetId": bob["id"]}})
            first = receive_request(alice_ws, "first")["payload"]
            assert first["target"]["name"] == "bob"
            invite = receive_until(bob_ws, lambda message: message["type"] == "challenge.incoming")["payload"]
            assert invite["challengeId"] == first["challengeId"]

            # 同一目标重复发起是幂等的：不会再排一个弹窗给对方。
            alice_ws.send_json({"type": "challenge.create", "requestId": "again", "payload": {"targetId": bob["id"]}})
            assert receive_request(alice_ws, "again")["payload"]["challengeId"] == first["challengeId"]

            # bob 手上已经有一条待回应的邀请，此时他不该再向外约战。
            bob_ws.send_json({"type": "challenge.create", "requestId": "bob-out", "payload": {"targetId": alice["id"]}})
            assert receive_request(bob_ws, "bob-out")["error"]["code"] == "CHALLENGE_INCOMING"

        # 进入人机对局的人不接受约战：他正忙着下另一盘棋。
        with alice_client.websocket_connect("/ws") as alice_ws:
            alice_ws.receive_json()
            alice_ws.send_json({"type": "ai.create", "requestId": "ai", "payload": {"color": "black"}})
            ai_game = receive_request(alice_ws, "ai")["payload"]
            focus(alice_ws, ai_game["id"])
            with bob_client.websocket_connect("/ws") as bob_ws:
                bob_ws.receive_json()
                bob_ws.send_json({"type": "challenge.create", "requestId": "busy", "payload": {"targetId": alice["id"]}})
                assert receive_request(bob_ws, "busy")["error"]["code"] == "PLAYER_BUSY"


def test_challenge_accept_fails_when_responder_sat_down_meanwhile(app):
    with TestClient(app) as alice_client, TestClient(app) as bob_client:
        register(alice_client, "alice")
        bob = register(bob_client, "bob")
        with alice_client.websocket_connect("/ws") as alice_ws, bob_client.websocket_connect("/ws") as bob_ws:
            alice_ws.receive_json()
            bob_ws.receive_json()
            alice_ws.send_json({"type": "challenge.create", "requestId": "ch", "payload": {"targetId": bob["id"]}})
            invite = receive_until(bob_ws, lambda message: message["type"] == "challenge.incoming")["payload"]

            # 弹窗还开着的时候，bob 另开一局人机：接受必须失败。
            bob_ws.send_json({"type": "ai.create", "requestId": "ai", "payload": {"color": "black"}})
            ai_game = receive_request(bob_ws, "ai")["payload"]
            focus(bob_ws, ai_game["id"])

            bob_ws.send_json({
                "type": "challenge.respond", "requestId": "resp",
                "payload": {"challengeId": invite["challengeId"], "accept": True},
            })
            assert receive_request(bob_ws, "resp")["error"]["code"] == "ALREADY_PLAYING"

            # 发起方立刻知道这局没成，不用干等 30 秒超时。
            cancelled = receive_until(alice_ws, lambda message: message["type"] == "challenge.result")["payload"]
            assert cancelled["status"] == "cancelled"
            assert cancelled["byMe"] is False
            assert "对方正在对局中" in cancelled["reason"]


def test_challenge_expires_and_clears_both_sides(settings):
    tuned = settings.model_copy(update={"challenge_ttl_seconds": 1})
    app = create_app(tuned)
    with TestClient(app) as alice_client, TestClient(app) as bob_client:
        register(alice_client, "alice")
        bob = register(bob_client, "bob")
        with alice_client.websocket_connect("/ws") as alice_ws, bob_client.websocket_connect("/ws") as bob_ws:
            alice_ws.receive_json()
            bob_ws.receive_json()
            alice_ws.send_json({"type": "challenge.create", "requestId": "ch", "payload": {"targetId": bob["id"]}})
            receive_request(alice_ws, "ch")
            receive_until(bob_ws, lambda message: message["type"] == "challenge.incoming")

            time.sleep(1.6)
            assert app.state.lobby._challenges == {}
            assert receive_until(bob_ws, lambda m: m["type"] == "challenge.result")["payload"]["status"] == "expired"
            assert receive_until(alice_ws, lambda m: m["type"] == "challenge.result")["payload"]["status"] == "expired"


def test_challenge_cancel_and_disconnect_notify_the_other_side(app):
    with TestClient(app) as alice_client, TestClient(app) as bob_client:
        register(alice_client, "alice")
        bob = register(bob_client, "bob")
        with bob_client.websocket_connect("/ws") as bob_ws:
            bob_ws.receive_json()
            with alice_client.websocket_connect("/ws") as alice_ws:
                alice_ws.receive_json()
                alice_ws.send_json({"type": "challenge.create", "requestId": "ch", "payload": {"targetId": bob["id"]}})
                first = receive_request(alice_ws, "ch")["payload"]["challengeId"]
                receive_until(bob_ws, lambda message: message["type"] == "challenge.incoming")

                alice_ws.send_json({"type": "challenge.cancel", "requestId": "cancel", "payload": {"challengeId": first}})
                assert receive_request(alice_ws, "cancel")["payload"]["status"] == "cancelled"
                assert receive_until(bob_ws, lambda m: m["type"] == "challenge.result")["payload"]["status"] == "cancelled"

                alice_ws.send_json({"type": "challenge.create", "requestId": "ch2", "payload": {"targetId": bob["id"]}})
                receive_request(alice_ws, "ch2")
                receive_until(bob_ws, lambda message: message["type"] == "challenge.incoming")

            # alice 断开后，bob 手上的邀请立刻作废，而不是等 30 秒超时。
            dropped = receive_until(bob_ws, lambda message: message["type"] == "challenge.result")["payload"]
            assert dropped["status"] == "cancelled"
            assert dropped["reason"] == "对方已离开大厅"


# ----------------------------------------------------------------------
# 约战条件：棋境
#
# 棋境是「纯展示」属性，但它是被约战方唯一一次反悔的机会——等棋盘铺开才
# 发现对面把背景选成了赛博朋克，就只能认了。所以条件必须随邀请一起到。
# ----------------------------------------------------------------------


def test_challenge_carries_the_chosen_scene_to_the_accepted_game(app):
    with TestClient(app) as alice_client, TestClient(app) as bob_client:
        register(alice_client, "alice")
        bob = register(bob_client, "bob")
        with alice_client.websocket_connect("/ws") as alice_ws, bob_client.websocket_connect("/ws") as bob_ws:
            alice_ws.receive_json()
            bob_ws.receive_json()

            alice_ws.send_json({
                "type": "challenge.create", "requestId": "ch-scene",
                "payload": {"targetId": bob["id"], "scene": "courtyard"},
            })
            receive_request(alice_ws, "ch-scene")
            invite = receive_until(bob_ws, lambda message: message["type"] == "challenge.incoming")["payload"]
            assert invite["scene"] == "courtyard"

            bob_ws.send_json({
                "type": "challenge.respond", "requestId": "resp",
                "payload": {"challengeId": invite["challengeId"], "accept": True},
            })
            snapshot = receive_until(bob_ws, lambda message: message["type"] == "game.snapshot")["payload"]
            assert snapshot["scene"] == "courtyard"


def test_challenge_without_scene_reports_none_and_still_opens_a_real_backdrop(app):
    """没选棋境时邀请里必须是 null，而不是被填成默认茶室。

    前端拿 null 才显示「随机」。服务端要是提前归一化，界面会一口咬定是茶室，
    而实际开局抽到的可能是庭院——条件和事实对不上。
    """
    from app.scenes import SCENE_IDS

    with TestClient(app) as alice_client, TestClient(app) as bob_client:
        register(alice_client, "alice")
        bob = register(bob_client, "bob")
        with alice_client.websocket_connect("/ws") as alice_ws, bob_client.websocket_connect("/ws") as bob_ws:
            alice_ws.receive_json()
            bob_ws.receive_json()

            alice_ws.send_json({"type": "challenge.create", "requestId": "ch-noscene", "payload": {"targetId": bob["id"]}})
            receive_request(alice_ws, "ch-noscene")
            invite = receive_until(bob_ws, lambda message: message["type"] == "challenge.incoming")["payload"]
            assert invite["scene"] is None

            bob_ws.send_json({
                "type": "challenge.respond", "requestId": "resp",
                "payload": {"challengeId": invite["challengeId"], "accept": True},
            })
            snapshot = receive_until(bob_ws, lambda message: message["type"] == "game.snapshot")["payload"]
            assert snapshot["scene"] in SCENE_IDS


def test_unknown_scene_does_not_break_the_challenge(app):
    """手搓协议包塞个不存在的棋境：约战照常成立，落库时退回默认场景。

    入口只负责区分「有没有写」，不认识的取值交给 `normalize_scene` 收敛——
    为背景不同把一场约战打成 500 是没有道理的。
    """
    with TestClient(app) as alice_client, TestClient(app) as bob_client:
        register(alice_client, "alice")
        bob = register(bob_client, "bob")
        with alice_client.websocket_connect("/ws") as alice_ws, bob_client.websocket_connect("/ws") as bob_ws:
            alice_ws.receive_json()
            bob_ws.receive_json()

            alice_ws.send_json({
                "type": "challenge.create", "requestId": "ch-weird",
                "payload": {"targetId": bob["id"], "scene": "moonbase"},
            })
            receive_request(alice_ws, "ch-weird")
            invite = receive_until(bob_ws, lambda message: message["type"] == "challenge.incoming")["payload"]

            bob_ws.send_json({
                "type": "challenge.respond", "requestId": "resp",
                "payload": {"challengeId": invite["challengeId"], "accept": True},
            })
            snapshot = receive_until(bob_ws, lambda message: message["type"] == "game.snapshot")["payload"]
            assert snapshot["scene"] == "tea"
