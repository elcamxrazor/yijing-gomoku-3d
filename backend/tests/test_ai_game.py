from conftest import receive_request, receive_until, register, send_ai_move


def test_ai_move_undo_restart_resign_and_duplicate_request(client):
    register(client)
    with client.websocket_connect("/ws") as websocket:
        ready = websocket.receive_json()
        assert ready["type"] == "session.ready"
        websocket.send_json({"type": "ai.create", "requestId": "create", "payload": {"color": "black"}})
        created = receive_request(websocket, "create")["payload"]
        assert created["mode"] == "ai"
        assert created["yourColor"] == 1
        game_id = created["id"]

        # 人类落子后进入 aiThinking，等待客户端提交 AI 着法。
        websocket.send_json({"type": "game.move", "requestId": "move-1", "payload": {"gameId": game_id, "row": 7, "col": 7}})
        ack = receive_request(websocket, "move-1")["payload"]
        assert ack["moveCount"] == 1
        assert ack["aiThinking"] is True

        move = {"type": "game.move", "requestId": "move-1", "payload": {"gameId": game_id, "row": 7, "col": 7}}
        # ai_move 的 ack 就是终态快照（broadcast 可能先到但已被 receive_request 跳过）
        final = send_ai_move(websocket, "ai-1", game_id, 0, 0)["payload"]
        assert final["moveCount"] == 2 and not final["aiThinking"]
        assert final["board"][7][7] == 1
        assert final["board"][0][0] == 2
        assert final["lastMove"]["color"] == 2

        # Replaying the same request id must be idempotent and return the cached
        # acknowledgement instead of placing another stone. 缓存的是「落子瞬间」
        # 的快照（moveCount 1）——AI 着法是之后单独提交的，不会再改变这条缓存。
        websocket.send_json(move)
        duplicate = receive_request(websocket, "move-1")["payload"]
        assert duplicate["moveCount"] == 1
        assert duplicate["aiThinking"] is True

        websocket.send_json({"type": "game.undo", "requestId": "undo", "payload": {"gameId": game_id}})
        undone = receive_request(websocket, "undo")["payload"]
        assert undone["moveCount"] == 0
        assert undone["lastMove"] is None
        assert undone["currentPlayer"] == 1

        websocket.send_json({"type": "game.move", "requestId": "move-2", "payload": {"gameId": game_id, "row": 6, "col": 6}})
        receive_request(websocket, "move-2")
        send_ai_move(websocket, "ai-2", game_id, 0, 1)
        websocket.send_json({"type": "game.restart", "requestId": "restart", "payload": {"gameId": game_id}})
        restarted = receive_request(websocket, "restart")["payload"]
        assert restarted["moveCount"] == 0
        assert restarted["status"] == "playing"

        websocket.send_json({"type": "game.resign", "requestId": "resign", "payload": {"gameId": game_id}})
        resigned = receive_request(websocket, "resign")["payload"]
        assert resigned["status"] == "finished"
        assert resigned["winner"] == 2
        assert resigned["winReason"] == "resign"
        assert not resigned["canUndo"]


def test_ai_move_validation(client):
    """AI 着法也要过完整校验：非 AI 回合、非法坐标都会被拒。"""
    register(client, "guard")
    with client.websocket_connect("/ws") as websocket:
        websocket.receive_json()
        websocket.send_json({"type": "ai.create", "requestId": "create", "payload": {"color": "black"}})
        game_id = receive_request(websocket, "create")["payload"]["id"]

        # 开局是人类先手，此时提交 AI 着法直接被拒。
        response = send_ai_move(websocket, "stray", game_id, 7, 7)
        assert response["error"]["code"] == "NOT_AI_TURN"

        # 人类落子后，AI 着法落在已占点被拒。
        websocket.send_json({"type": "game.move", "requestId": "move-1", "payload": {"gameId": game_id, "row": 7, "col": 7}})
        receive_request(websocket, "move-1")
        response = send_ai_move(websocket, "occupied", game_id, 7, 7)
        assert response["error"]["code"] == "INVALID_MOVE"

        # 合法着法通过。
        final = send_ai_move(websocket, "ok", game_id, 0, 0)["payload"]
        assert final["moveCount"] == 2 and not final["aiThinking"]
        assert final["board"][0][0] == 2


def test_ai_black_waits_for_client_move_and_reconnect_returns_games(client):
    """人执白时 AI 执黑：创建即 aiThinking，着法由客户端提交。"""
    register(client, "whiteplayer")
    with client.websocket_connect("/ws") as websocket:
        websocket.receive_json()
        websocket.send_json({"type": "ai.create", "requestId": "create-white", "payload": {"color": "white"}})
        created = receive_request(websocket, "create-white")["payload"]
        assert created["players"]["black"]["id"] == "yixin"
        assert created["yourColor"] == 2
        assert created["aiThinking"] is True
        assert created["moveCount"] == 0

        result = send_ai_move(websocket, "ai-first", created["id"], 7, 7)["payload"]
        assert result["moveCount"] == 1 and not result["aiThinking"]
        assert result["board"][7][7] == 1

    with client.websocket_connect("/ws") as websocket:
        restored = websocket.receive_json()
        assert restored["type"] == "session.ready"
        assert len(restored["payload"]["games"]) == 1
        assert restored["payload"]["games"][0]["moveCount"] == 1


def test_ai_winning_move_ends_game_and_clears_ai_thinking(client):
    """AI 落出五连后：对局结束，且不再「等待 AI」（aiThinking 翻 False）。

    回归点：此前 `submit_ai_move` 的获胜分支漏掉把 `ai_thinking` 置 False，
    导致终局快照仍带 `aiThinking=True`。前端引擎据此以为还要替 AI 落子，
    晚到的那一步被服务端以 NOT_AI_TURN 拒收并弹红字「当前不在等待 AI 落子」。
    修复后终局快照必须 `aiThinking is False`，任何晚到的 AI 提交都该被拒。
    """
    register(client)
    with client.websocket_connect("/ws") as websocket:
        websocket.receive_json()
        websocket.send_json({"type": "ai.create", "requestId": "create", "payload": {"color": "black"}})
        game_id = receive_request(websocket, "create")["payload"]["id"]

        # 白（AI）在第七行横连五；人类（黑）的落子选在右下角且彼此隔开两格，
        # 既不成连珠、也不挡 AI 的横线，确保是 AI 而非人类先成五。
        white_wins = [(7, 0), (7, 1), (7, 2), (7, 3), (7, 4)]
        human_holes = [(14, 14), (14, 12), (14, 10), (14, 8), (14, 6)]
        for i, (wr, wc) in enumerate(white_wins):
            # 人类（黑）落子，把回合交给 AI。
            hr, hc = human_holes[i]
            websocket.send_json({"type": "game.move", "requestId": f"h-{i}", "payload": {"gameId": game_id, "row": hr, "col": hc}})
            human_ack = receive_request(websocket, f"h-{i}")["payload"]
            # 人类落子后轮到 AI：aiThinking 必须为真。
            assert human_ack["aiThinking"] is True
            # AI（白）落子；最后一手成五连。
            final = send_ai_move(websocket, f"ai-{i}", game_id, wr, wc)["payload"]
            if i < len(white_wins) - 1:
                assert final["status"] == "playing"
            else:
                assert final["status"] == "finished"
                assert final["winner"] == 2
                assert final["winReason"] == "five"
                # 终局即不再等待 AI——本修复的核心断言。
                assert final["aiThinking"] is False

        # 终局后任何 AI 提交都应被拒为 NOT_AI_TURN（而不是被当成「还在等 AI」）。
        stray = send_ai_move(websocket, "stray", game_id, 5, 5)
        assert stray["error"]["code"] == "NOT_AI_TURN"
