from fastapi.testclient import TestClient

from conftest import receive_request, receive_until, register


def test_online_room_sync_undo_reject_accept_restart_and_resume(app):
    with TestClient(app) as black_client, TestClient(app) as white_client:
        register(black_client, "black")
        register(white_client, "white")
        with black_client.websocket_connect("/ws") as black, white_client.websocket_connect("/ws") as white:
            assert black.receive_json()["type"] == "session.ready"
            assert white.receive_json()["type"] == "session.ready"
            black.send_json({"type": "room.create", "requestId": "create", "payload": {}})
            created = receive_request(black, "create")["payload"]
            assert created["status"] == "waiting"
            assert len(created["roomCode"]) == 6
            code = created["roomCode"]
            game_id = created["id"]

            white.send_json({"type": "room.join", "requestId": "join", "payload": {"code": code}})
            joined = receive_request(white, "join")["payload"]
            assert joined["status"] == "playing"
            assert joined["yourColor"] == 2
            receive_until(black, lambda m: m["type"] == "game.snapshot" and m["payload"]["status"] == "playing")

            # 开局「决定先后手」：双方各自表态后由服务端揭晓，揭晓前落子会被拒（OPENING_PENDING）。
            # 这里让两人都指向黑座（黑选 self、白选 opponent），达成一致 → 黑先手，落子闸门随即打开。
            black.send_json({"type": "game.first_move_choice", "requestId": "ob-black", "payload": {"gameId": game_id, "choice": "self"}})
            white.send_json({"type": "game.first_move_choice", "requestId": "ob-white", "payload": {"gameId": game_id, "choice": "opponent"}})
            # 先收双方各自的揭晓结果（揭晓结果可能先于 / 后于各自 ack 到达，而 receive_until 会
            # 顺带消费掉 ack，所以不能先收 ack 再等揭晓结果，否则会卡死）。
            receive_until(black, lambda m: m["type"] == "game.opening_result")
            receive_until(white, lambda m: m["type"] == "game.opening_result")
            receive_until(black, lambda m: m["type"] == "game.snapshot" and not m["payload"].get("opening"))

            black_move = {"type": "game.move", "requestId": "b1", "payload": {"gameId": game_id, "row": 7, "col": 7}}
            black.send_json(black_move)
            assert receive_request(black, "b1")["payload"]["moveCount"] == 1
            receive_until(white, lambda m: m["type"] == "game.snapshot" and m["payload"]["moveCount"] == 1)

            black.send_json({"type": "game.undo", "requestId": "undo-request", "payload": {"gameId": game_id}})
            receive_request(black, "undo-request")
            requested = receive_until(white, lambda m: m["type"] == "game.undo_requested")
            assert requested["payload"]["fromName"] == "black"
            white.send_json({
                "type": "game.undo_response", "requestId": "undo-accept",
                "payload": {"gameId": game_id, "accept": True},
            })
            assert receive_request(white, "undo-accept")["payload"]["moveCount"] == 0
            receive_until(black, lambda m: m["type"] == "game.snapshot" and m["payload"]["moveCount"] == 0)

            black.send_json({
                "type": "game.move", "requestId": "b2",
                "payload": {"gameId": game_id, "row": 7, "col": 7},
            })
            receive_request(black, "b2")
            white.send_json({"type": "game.move", "requestId": "w1", "payload": {"gameId": game_id, "row": 0, "col": 0}})
            receive_request(white, "w1")
            white.send_json({"type": "game.resign", "requestId": "resign", "payload": {"gameId": game_id}})
            resigned = receive_request(white, "resign")["payload"]
            assert resigned["winner"] == 1 and resigned["winReason"] == "resign"

            # 联机重开需对方同意：黑发起请求，白同意后才真正清盘。
            black.send_json({"type": "game.restart", "requestId": "restart-req", "payload": {"gameId": game_id}})
            receive_request(black, "restart-req")
            # 白作为被请求方收到重开请求事件。
            requested = receive_until(white, lambda m: m["type"] == "game.restart_requested")
            assert requested["payload"]["fromName"] == "black"
            # 白同意重开。
            white.send_json({"type": "game.restart_response", "requestId": "restart-accept", "payload": {"gameId": game_id, "accept": True}})
            receive_request(white, "restart-accept")
            # 黑收到重开后的快照：清盘 + 先后手轮换（上一盘黑座这盘执白）。
            restarted = receive_until(black, lambda m: m["type"] == "game.snapshot" and m["payload"]["moveCount"] == 0 and not m["payload"].get("restartPending"))["payload"]
            assert restarted["status"] == "playing" and restarted["moveCount"] == 0
            # 再来一局：先后手轮换（上一盘黑座这盘执白），不再进入协商。
            assert restarted["yourColor"] == 2

        # Closing a socket does not resign. The same cookie can resume explicitly.
        with white_client.websocket_connect("/ws") as white:
            ready = white.receive_json()
            assert ready["payload"]["games"][0]["status"] == "playing"
            white.send_json({"type": "room.resume", "requestId": "resume", "payload": {"code": code}})
            resumed = receive_request(white, "resume")["payload"]
            assert resumed["id"] == game_id
            # 轮换后原白座玩家执黑。
            assert resumed["yourColor"] == 1


def test_online_opening_coin_resolves_and_first_player_moves(app):
    with TestClient(app) as black_client, TestClient(app) as white_client:
        register(black_client, "black")
        register(white_client, "white")
        with black_client.websocket_connect("/ws") as black, white_client.websocket_connect("/ws") as white:
            assert black.receive_json()["type"] == "session.ready"
            assert white.receive_json()["type"] == "session.ready"
            black.send_json({"type": "room.create", "requestId": "create", "payload": {}})
            created = receive_request(black, "create")["payload"]
            game_id = created["id"]
            code = created["roomCode"]
            white.send_json({"type": "room.join", "requestId": "join", "payload": {"code": code}})
            receive_request(white, "join")
            receive_until(black, lambda m: m["type"] == "game.snapshot" and m["payload"]["status"] == "playing")

            # 两人均选「我执先手」→ 指向不同座位，不一致 → 抛硬币随机定先后。
            black.send_json({"type": "game.first_move_choice", "requestId": "ob-black", "payload": {"gameId": game_id, "choice": "self"}})
            white.send_json({"type": "game.first_move_choice", "requestId": "ob-white", "payload": {"gameId": game_id, "choice": "self"}})
            # 先收揭晓结果：opening_result 可能先于各自 ack 到达，而 receive_request 会顺带消费掉
            # 它，所以不要在它之前先收 ack，否则 receive_until(opening_result) 会永远阻塞。
            result = receive_until(black, lambda m: m["type"] == "game.opening_result")
            assert result["payload"]["method"] == "coin"
            receive_until(white, lambda m: m["type"] == "game.opening_result")

            # 揭晓后，黑方（先手）落第一手，白方落第二手，均须被接受。
            black_snap = receive_until(black, lambda m: m["type"] == "game.snapshot" and not m["payload"].get("opening"))
            first_is_black_client = black_snap["payload"]["yourColor"] == 1
            first_ws = black if first_is_black_client else white
            second_ws = white if first_is_black_client else black
            first_ws.send_json({"type": "game.move", "requestId": "first", "payload": {"gameId": game_id, "row": 7, "col": 7}})
            assert receive_request(first_ws, "first")["payload"]["moveCount"] == 1
            second_ws.send_json({"type": "game.move", "requestId": "second", "payload": {"gameId": game_id, "row": 0, "col": 0}})
            assert receive_request(second_ws, "second")["payload"]["moveCount"] == 2


def test_online_phrase_relays_canonical_text_and_rejects_unknown(app):
    with TestClient(app) as black_client, TestClient(app) as white_client:
        register(black_client, "black")
        register(white_client, "white")
        with black_client.websocket_connect("/ws") as black, white_client.websocket_connect("/ws") as white:
            assert black.receive_json()["type"] == "session.ready"
            assert white.receive_json()["type"] == "session.ready"
            black.send_json({"type": "room.create", "requestId": "create", "payload": {}})
            created = receive_request(black, "create")["payload"]
            game_id = created["id"]
            code = created["roomCode"]

            white.send_json({"type": "room.join", "requestId": "join", "payload": {"code": code}})
            receive_request(white, "join")
            receive_until(black, lambda m: m["type"] == "game.snapshot" and m["payload"]["status"] == "playing")

            # 已知短语：服务端回 ack，并只把规范文案转发给对手。
            black.send_json({
                "type": "game.phrase", "requestId": "p1",
                "payload": {"gameId": game_id, "phraseId": "cai"},
            })
            ack = receive_request(black, "p1")
            assert ack["payload"]["accepted"] is True
            phrase = receive_until(white, lambda m: m["type"] == "game.phrase")
            payload = phrase["payload"]
            assert payload["phraseId"] == "cai"
            assert payload["text"] == "菜"
            assert payload["senderName"] == "black"
            assert payload["color"] == 1

            # 未知短语（含伪造的任意文本）必须被拒绝，绝不转发。
            black.send_json({
                "type": "game.phrase", "requestId": "p2",
                "payload": {"gameId": game_id, "phraseId": "<script>alert(1)</script>"},
            })
            rejected = receive_request(black, "p2")
            assert rejected["type"] == "error"
            assert rejected["error"]["code"] == "VALIDATION_ERROR"
