"""快照里的 `moves`：客户端标手数唯一依据。

这一条要单独守住：手数是「看起来有没有错」的功能，字段一丢，界面不会报错，
只会安静地少标几手——所以这里既验证它存在，也验证它和棋盘对得上。
"""

from conftest import receive_request, receive_state, register, send_ai_move


def test_snapshot_carries_full_move_sequence(client):
    register(client, "historian")
    with client.websocket_connect("/ws") as web:
        assert web.receive_json()["type"] == "session.ready"
        web.send_json({"type": "ai.create", "requestId": "create", "payload": {"color": "black"}})
        created = receive_request(web, "create")["payload"]
        game_id = created["id"]
        assert created["moves"] == []

        web.send_json({
            "type": "game.move",
            "requestId": "m1",
            "payload": {"gameId": game_id, "row": 7, "col": 7},
        })
        receive_state(web, "m1", lambda payload: payload["moveCount"] == 1 and payload["aiThinking"])
        state = send_ai_move(web, "ai-1", game_id, 0, 0)["payload"]
        assert state["moveCount"] == 2 and not state["aiThinking"]

        moves = state["moves"]
        assert len(moves) == state["moveCount"]
        # 第一手必须是我们下的那颗黑子，之后每一手都要和盘面一致。
        assert moves[0] == {"row": 7, "col": 7, "color": 1}
        for move in moves:
            assert state["board"][move["row"]][move["col"]] == move["color"]
        # 黑白交替，没有空洞
        assert [move["color"] for move in moves] == [1 if index % 2 == 0 else 2 for index in range(len(moves))]

        # 悔棋之后序列必须跟着缩短，否则界面会给已经不存在的棋子标号
        web.send_json({"type": "game.undo", "requestId": "undo", "payload": {"gameId": game_id}})
        undone = receive_request(web, "undo")["payload"]
        assert undone["moves"] == []
        assert undone["board"][7][7] == 0
