from fastapi.testclient import TestClient

from conftest import receive_request, receive_until, register


def start_online_game(alice_ws, bob_ws) -> dict:
    alice_ws.send_json({"type": "room.create", "requestId": "create", "payload": {}})
    created = receive_request(alice_ws, "create")["payload"]
    bob_ws.send_json({"type": "room.join", "requestId": "join", "payload": {"code": created["roomCode"]}})
    receive_request(bob_ws, "join")
    receive_until(alice_ws, lambda m: m["type"] == "game.snapshot" and m["payload"]["status"] == "playing")
    agree_first_player(alice_ws, bob_ws, created["id"])
    return created


def agree_first_player(black_ws, white_ws, game_id: str, rid_black: str = "ob-black", rid_white: str = "ob-white") -> None:
    """开局「决定先后手」握手：黑选自己、白选对手 → 双方一致指向黑座，黑先手。

    揭晓结果可能先于 ack 到达，所以要先收双方的 game.opening_result（收 ack 会把
    揭晓结果一起消费掉，之后的 receive_until 就永远等不到了）。
    requestId 默认固定；同一局里要握手多次时必须换成不同的 id（服务端按
    (用户, requestId) 幂等缓存，重复 id 会直接回缓存而不再提交选择）。
    """
    black_ws.send_json({"type": "game.first_move_choice", "requestId": rid_black, "payload": {"gameId": game_id, "choice": "self"}})
    white_ws.send_json({"type": "game.first_move_choice", "requestId": rid_white, "payload": {"gameId": game_id, "choice": "opponent"}})
    receive_until(black_ws, lambda m: m["type"] == "game.opening_result")
    receive_until(white_ws, lambda m: m["type"] == "game.opening_result")
    receive_until(black_ws, lambda m: m["type"] == "game.snapshot" and not m["payload"].get("opening"))


def test_spectator_watches_the_same_board_but_has_no_seat(app):
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
                assert socket.receive_json()["type"] == "session.ready"
            game = start_online_game(alice, bob)

            cara.send_json({"type": "spectate.join", "requestId": "watch", "payload": {"gameId": game["id"]}})
            view = receive_request(cara, "watch")["payload"]
            assert view["spectating"] is True
            # 观战者没有颜色：服务端所有写操作的权限判据都是「你是不是参与者」。
            assert view["yourColor"] is None
            assert view["canUndo"] is False
            assert view["spectatorCount"] == 1
            assert view["id"] == game["id"]

            # 局内人立刻看到「有人来看棋」。
            seen = receive_until(
                alice,
                lambda m: m["type"] == "game.snapshot" and m["payload"]["spectatorCount"] == 1,
            )["payload"]
            assert seen["spectating"] is False

            # 落子会同步给观战者，棋盘与棋手完全一致。
            alice.send_json({
                "type": "game.move", "requestId": "a1",
                "payload": {"gameId": game["id"], "row": 7, "col": 7},
            })
            receive_request(alice, "a1")
            watched = receive_until(
                cara,
                lambda m: m["type"] == "game.snapshot"
                and m["payload"]["moveCount"] == 1
                and m["payload"]["spectating"] is True,
            )["payload"]
            assert watched["board"][7][7] == 1
            assert watched["lastMove"] == {"row": 7, "col": 7, "color": 1}

            # 观战者不能落子，也不能悔棋 / 重开。
            cara.send_json({
                "type": "game.move", "requestId": "c1",
                "payload": {"gameId": game["id"], "row": 0, "col": 0},
            })
            assert receive_request(cara, "c1")["error"]["code"] == "FORBIDDEN"
            cara.send_json({"type": "game.restart", "requestId": "c2", "payload": {"gameId": game["id"]}})
            assert receive_request(cara, "c2")["error"]["code"] == "FORBIDDEN"

            # 离开观战：不再收快照，局内人的人数也跟着减回去。
            cara.send_json({"type": "spectate.leave", "requestId": "leave", "payload": {}})
            assert receive_request(cara, "leave")["type"] == "spectate.left"
            assert app.state.spectate.count(game["id"]) == 0
            left = receive_until(
                alice,
                lambda m: m["type"] == "game.snapshot" and m["payload"]["spectatorCount"] == 0,
            )["payload"]
            assert left["status"] == "playing"


def test_spectator_cannot_join_own_or_finished_games(app):
    with (
        TestClient(app) as alice_client,
        TestClient(app) as bob_client,
        TestClient(app) as cara_client,
    ):
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
            game = start_online_game(alice, bob)

            alice.send_json({"type": "spectate.join", "requestId": "own", "payload": {"gameId": game["id"]}})
            assert receive_request(alice, "own")["error"]["code"] == "ALREADY_PLAYER"

            bob.send_json({"type": "spectate.join", "requestId": "nope", "payload": {"gameId": "missing"}})
            assert receive_request(bob, "nope")["error"]["code"] == "GAME_NOT_FOUND"

            bob.send_json({"type": "game.resign", "requestId": "resign", "payload": {"gameId": game["id"]}})
            receive_request(bob, "resign")
            cara.send_json({"type": "spectate.join", "requestId": "late", "payload": {"gameId": game["id"]}})
            assert receive_request(cara, "late")["error"]["code"] == "GAME_NOT_LIVE"


def test_spectator_sees_the_result_and_disconnect_releases_the_seat(app):
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
            game = start_online_game(alice, bob)
            cara.send_json({"type": "spectate.join", "requestId": "watch", "payload": {"gameId": game["id"]}})
            receive_request(cara, "watch")

            bob.send_json({"type": "game.resign", "requestId": "resign", "payload": {"gameId": game["id"]}})
            receive_request(bob, "resign")
            # 棋局结束，观战者留在原地看结果，而不是被踢回首页。
            final = receive_until(
                cara,
                lambda m: m["type"] == "game.snapshot" and m["payload"]["status"] == "finished",
            )["payload"]
            assert final["spectating"] is True
            assert final["winner"] == 1 and final["winReason"] == "resign"

            # 观战者断开连接后席位立刻收回，不会让别人的人数一直虚高。
            assert app.state.spectate.count(game["id"]) == 1
        assert app.state.spectate.count(game["id"]) == 0
