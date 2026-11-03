"""对局内 AI 分析（请求 → 对方同意 → 请求方本地引擎建议一手）与 AI 局观战。

 FakeEngine 的 board(history, color) 恒返回从天元向外扫到的第一个空点，
 因此「同意后拿到的建议落点」必然是一个合法空位，可以直接断言。
"""
from fastapi.testclient import TestClient

from conftest import receive_request, receive_until, register, send_ai_move
from test_spectate import start_online_game


def test_ai_analysis_requires_opponent_consent(app):
    with TestClient(app) as alice_client, TestClient(app) as bob_client:
        register(alice_client, "alice")
        register(bob_client, "bob")
        with alice_client.websocket_connect("/ws") as alice, bob_client.websocket_connect("/ws") as bob:
            for socket in (alice, bob):
                assert socket.receive_json()["type"] == "session.ready"
            game = start_online_game(alice, bob)

            # 先各走一手再请求分析（贴近真实用法；空盘也允许，但这里测常规路径）。
            alice.send_json({"type": "game.move", "requestId": "m-a", "payload": {"gameId": game["id"], "row": 7, "col": 7}})
            receive_request(alice, "m-a")
            bob.send_json({"type": "game.move", "requestId": "m-b", "payload": {"gameId": game["id"], "row": 7, "col": 8}})
            receive_request(bob, "m-b")
            receive_until(alice, lambda m: m["type"] == "game.snapshot" and m["payload"]["moveCount"] == 2)

            # 婉拒链路：请求送达对手，对手回绝后双方都收到结果。
            alice.send_json({"type": "game.ai_request", "requestId": "req-1", "payload": {"gameId": game["id"]}})
            assert receive_request(alice, "req-1")["payload"]["accepted"] is True
            invite = receive_until(bob, lambda m: m["type"] == "game.ai_analysis_requested")["payload"]
            assert invite["gameId"] == game["id"]
            assert invite["fromName"] == "alice"
            bob.send_json({"type": "game.ai_respond", "requestId": "decline", "payload": {"gameId": game["id"], "accept": False}})
            receive_request(bob, "decline")
            declined = receive_until(alice, lambda m: m["type"] == "game.ai_analysis_result")["payload"]
            assert declined["accepted"] is False
            assert declined["byName"] == "alice"

            # 同意链路：建议落点必须是盘上的合法空位。
            alice.send_json({"type": "game.ai_request", "requestId": "req-2", "payload": {"gameId": game["id"]}})
            receive_request(alice, "req-2")
            receive_until(bob, lambda m: m["type"] == "game.ai_analysis_requested")
            bob.send_json({"type": "game.ai_respond", "requestId": "accept", "payload": {"gameId": game["id"], "accept": True}})
            # 结果事件在服务端 dispatch 期间就发出，早于带 requestId 的 ack，
            # 所以要先收结果、再收 ack，否则 ack 的等待会把结果顺手丢掉。
            mirrored = receive_until(
                bob,
                lambda m: m["type"] == "game.ai_analysis_result" and m["payload"]["accepted"],
            )["payload"]
            receive_request(bob, "accept")
            result = receive_until(
                alice,
                lambda m: m["type"] == "game.ai_analysis_result" and m["payload"]["accepted"],
            )["payload"]
            # 推荐点不再由服务端计算（引擎已迁到客户端），双方只收到「同意」事件；
            # 请求方前端拿到该事件后自行用本地引擎计算建议点。
            assert "row" not in result and "col" not in result
            assert "row" not in mirrored and "col" not in mirrored


def test_ai_analysis_response_validation(app):
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

            # 没有请求时的回应直接被拒。
            bob.send_json({"type": "game.ai_respond", "requestId": "stray", "payload": {"gameId": game["id"], "accept": True}})
            assert receive_request(bob, "stray")["error"]["code"] == "ANALYSIS_NOT_FOUND"

            # 非参与者（路人 / 观战者）连回应资格都没有：先撞参与者校验。
            alice.send_json({"type": "game.ai_request", "requestId": "req", "payload": {"gameId": game["id"]}})
            receive_request(alice, "req")
            cara.send_json({"type": "game.ai_respond", "requestId": "intrude", "payload": {"gameId": game["id"], "accept": True}})
            assert receive_request(cara, "intrude")["error"]["code"] == "FORBIDDEN"

            # 观战者不能发起请求。
            cara.send_json({"type": "spectate.join", "requestId": "watch", "payload": {"gameId": game["id"]}})
            receive_request(cara, "watch")
            cara.send_json({"type": "game.ai_request", "requestId": "spectate-req", "payload": {"gameId": game["id"]}})
            assert receive_request(cara, "spectate-req")["error"]["code"] == "FORBIDDEN"


def test_ai_analysis_result_broadcast_to_both(app):
    with TestClient(app) as alice_client, TestClient(app) as bob_client:
        register(alice_client, "alice")
        register(bob_client, "bob")
        with alice_client.websocket_connect("/ws") as alice, bob_client.websocket_connect("/ws") as bob:
            for socket in (alice, bob):
                assert socket.receive_json()["type"] == "session.ready"
            game = start_online_game(alice, bob)

            # 同意分析：双方各自收到「同意」事件（此时尚无落点，引擎在客户端）。
            alice.send_json({"type": "game.ai_request", "requestId": "req", "payload": {"gameId": game["id"]}})
            receive_request(alice, "req")
            receive_until(bob, lambda m: m["type"] == "game.ai_analysis_requested")
            bob.send_json({"type": "game.ai_respond", "requestId": "accept", "payload": {"gameId": game["id"], "accept": True}})
            # 先收「同意」事件再收带 requestId 的 ack：ack 会顺手把同意事件读过去，顺序反了会漏收。
            for socket in (alice, bob):
                accepted = receive_until(socket, lambda m: m["type"] == "game.ai_analysis_result" and m["payload"]["accepted"])["payload"]
                assert "row" not in accepted and "col" not in accepted
            receive_request(bob, "accept")

            # 请求方本地算出落点后回传，服务端应转播给双方——保证 PVP 双方看到同一个推荐环。
            alice.send_json({"type": "game.ai_result", "requestId": "point", "payload": {"gameId": game["id"], "row": 5, "col": 6}})
            # 先收带落点的结果事件（广播先于 requestId 为 point 的 ack 到达请求方），
            # 否则会被后面的 ack 等待把事件「吃掉」而再也收不到 row==5。
            point_alice = receive_until(
                alice, lambda m: m["type"] == "game.ai_analysis_result" and m["payload"].get("row") == 5,
            )["payload"]
            assert point_alice["row"] == 5
            assert point_alice["col"] == 6
            assert point_alice["byName"] == "alice"
            point_bob = receive_until(
                bob, lambda m: m["type"] == "game.ai_analysis_result" and m["payload"].get("row") == 5,
            )["payload"]
            assert point_bob["row"] == 5
            assert point_bob["col"] == 6
            assert point_bob["byName"] == "alice"
            # 请求方还应收到回传的 ack（无 error 即校验通过）。
            ack = receive_request(alice, "point")
            assert "error" not in ack


def test_ai_analysis_result_validation(app):
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

            # 非参与者不能回传落点。
            cara.send_json({"type": "game.ai_result", "requestId": "intrude", "payload": {"gameId": game["id"], "row": 1, "col": 1}})
            assert receive_request(cara, "intrude")["error"]["code"] == "FORBIDDEN"

            # 坐标越界被拒。
            alice.send_json({"type": "game.ai_result", "requestId": "oob", "payload": {"gameId": game["id"], "row": 99, "col": 5}})
            assert receive_request(alice, "oob")["error"]["code"] == "VALIDATION_ERROR"


def test_spectator_can_watch_an_ai_game(app):
    with TestClient(app) as alice_client, TestClient(app) as cara_client:
        register(alice_client, "alice")
        register(cara_client, "cara")
        with alice_client.websocket_connect("/ws") as alice, cara_client.websocket_connect("/ws") as cara:
            assert alice.receive_json()["type"] == "session.ready"
            assert cara.receive_json()["type"] == "session.ready"

            alice.send_json({"type": "ai.create", "requestId": "create", "payload": {"color": "black"}})
            created = receive_request(alice, "create")["payload"]

            cara.send_json({"type": "spectate.join", "requestId": "watch", "payload": {"gameId": created["id"]}})
            view = receive_request(cara, "watch")["payload"]
            assert view["spectating"] is True
            assert view["mode"] == "ai"
            assert view["yourColor"] is None
            assert view["players"]["black"]["name"] == "alice"
            assert view["players"]["white"]["id"] == "yixin"

            # 人机局的每一步都会推给观战者（AI 着法由客户端提交）。
            alice.send_json({"type": "game.move", "requestId": "m1", "payload": {"gameId": created["id"], "row": 7, "col": 7}})
            watched = receive_until(
                cara,
                lambda m: m["type"] == "game.snapshot"
                and m["payload"]["moveCount"] == 1
                and m["payload"]["spectating"] is True,
            )["payload"]
            assert watched["board"][7][7] == 1
            send_ai_move(alice, "ai-m1", created["id"], 0, 0)
            watched = receive_until(
                cara,
                lambda m: m["type"] == "game.snapshot"
                and m["payload"]["moveCount"] == 2
                and m["payload"]["spectating"] is True,
            )["payload"]
            assert watched["board"][0][0] == 2

            # 大厅里，观战者单独标成「观战中」，不再显示为「可约战」。
            # （alice 的座位状态来自客户端上报的 game.focus，本测试没有上报，
            #  所以只断言观战者的状态。）
            rows = {row["name"]: row for row in app.state.lobby.players()}
            assert rows["cara"]["status"] == "watching"
            assert rows["cara"]["gameId"] == created["id"]
