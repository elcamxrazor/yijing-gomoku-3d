"""复盘「一键续弈」：把人机局从棋谱的任意一手重新开始。

产品语义（与规格对齐）：
- 前 N 手是**载入的残局**，不是玩家下的 → `startPly` = N，重开清回这里；
- 轮到谁由手数奇偶决定，不看谁执黑；
- 悔棋退不到起点之前；
- 与 AI 的对局一律不计入战绩（胜率只算联机局）。
"""

import pytest
from fastapi.testclient import TestClient

from conftest import receive_request, receive_until, register, send_ai_move

# 一个四手残局（黑 7,7 / 白 7,8 / 黑 8,8 / 白 8,9）：轮黑，且没有任何五连。
FOUR_PLY = [
    {"row": 7, "col": 7},
    {"row": 7, "col": 8},
    {"row": 8, "col": 8},
    {"row": 8, "col": 9},
]
# 五手：轮到白方。
FIVE_PLY = FOUR_PLY + [{"row": 6, "col": 6}]


def _create(websocket, request_id: str, payload: dict) -> dict:
    websocket.send_json({"type": "ai.create", "requestId": request_id, "payload": payload})
    return receive_request(websocket, request_id)["payload"]


def test_preset_is_loaded_as_the_opening_position(client):
    register(client)
    with client.websocket_connect("/ws") as web:
        web.receive_json()
        snapshot = _create(web, "create", {"color": "black", "preset": FOUR_PLY})

        assert snapshot["mode"] == "ai"
        assert snapshot["moveCount"] == 4
        assert snapshot["startPly"] == 4
        assert snapshot["board"][7][7] == 1
        assert snapshot["board"][7][8] == 2
        assert snapshot["board"][8][8] == 1
        assert snapshot["board"][8][9] == 2
        # 偶数手 → 轮到黑方；玩家执黑，所以不是 AI 在想。
        assert snapshot["currentPlayer"] == 1
        assert snapshot["aiThinking"] is False
        assert snapshot["lastMove"] == {"row": 8, "col": 9, "color": 2}


def test_player_finishing_the_preset_hands_the_turn_to_the_ai(client):
    register(client)
    with client.websocket_connect("/ws") as web:
        web.receive_json()
        game_id = _create(web, "create", {"color": "black", "preset": FOUR_PLY})["id"]

        web.send_json({
            "type": "game.move", "requestId": "m",
            "payload": {"gameId": game_id, "row": 5, "col": 5},
        })
        ack = receive_request(web, "m")["payload"]
        assert ack["moveCount"] == 5
        assert ack["aiThinking"] is True

        final = send_ai_move(web, "ai", game_id, 0, 0)["payload"]
        assert final["moveCount"] == 6


def test_odd_preset_lets_the_ai_move_first(client):
    """奇数手的残局轮到白方：玩家执黑时，AI 一开局就得想。"""
    register(client)
    with client.websocket_connect("/ws") as web:
        web.receive_json()
        snapshot = _create(web, "create", {"color": "black", "preset": FIVE_PLY})
        assert snapshot["moveCount"] == 5
        assert snapshot["currentPlayer"] == 2
        assert snapshot["aiThinking"] is True


def test_restart_returns_to_the_preset_not_to_an_empty_board(client):
    register(client)
    with client.websocket_connect("/ws") as web:
        web.receive_json()
        game_id = _create(web, "create", {"color": "black", "preset": FOUR_PLY})["id"]
        web.send_json({
            "type": "game.move", "requestId": "m",
            "payload": {"gameId": game_id, "row": 5, "col": 5},
        })
        receive_request(web, "m")
        send_ai_move(web, "ai", game_id, 0, 0)

        web.send_json({"type": "game.restart", "requestId": "restart", "payload": {"gameId": game_id}})
        restarted = receive_until(
            web, lambda message: message.get("requestId") == "restart" and "payload" in message
        )["payload"]
        # 「再来一次同一个残局」，而不是退成空盘——空盘就没有练习的意义了。
        assert restarted["moveCount"] == 4
        assert restarted["startPly"] == 4
        assert restarted["board"][7][7] == 1
        assert restarted["board"][8][9] == 2
        assert restarted["status"] == "playing"
        assert restarted["winner"] == 0


def test_undo_stops_at_the_preset(client):
    register(client)
    with client.websocket_connect("/ws") as web:
        web.receive_json()
        game_id = _create(web, "create", {"color": "black", "preset": FOUR_PLY})["id"]
        web.send_json({
            "type": "game.move", "requestId": "m",
            "payload": {"gameId": game_id, "row": 5, "col": 5},
        })
        receive_request(web, "m")
        send_ai_move(web, "ai", game_id, 0, 0)

        web.send_json({"type": "game.undo", "requestId": "undo-1", "payload": {"gameId": game_id}})
        back = receive_request(web, "undo-1")["payload"]
        assert back["moveCount"] == 4

        # 再悔一次就退到载入的棋谱里了：必须被挡住。
        web.send_json({"type": "game.undo", "requestId": "undo-2", "payload": {"gameId": game_id}})
        refused = receive_request(web, "undo-2")
        assert refused["error"]["code"] == "UNDO_NOT_ALLOWED"


def test_can_undo_is_false_right_after_loading_a_preset(client):
    """残局刚载入时没有「本局」的着法可撤，但盘上又有棋——按钮不能据此亮起来。"""
    register(client)
    with client.websocket_connect("/ws") as web:
        web.receive_json()
        snapshot = _create(web, "create", {"color": "white", "preset": FIVE_PLY})
        # 玩家执白、轮白：轮到玩家走，但没有可悔的着法。
        assert snapshot["canUndo"] is False


def test_without_preset_behaves_like_before(client):
    register(client)
    with client.websocket_connect("/ws") as web:
        web.receive_json()
        snapshot = _create(web, "create", {"color": "black"})
        assert snapshot["moveCount"] == 0
        assert snapshot["startPly"] == 0


@pytest.mark.parametrize(
    "preset",
    [
        [{"row": 0, "col": 0}, {"row": 0, "col": 0}],            # 重复落点
        [{"row": 15, "col": 0}],                                  # 越界
        [{"row": -1, "col": 3}],                                  # 负数
        [{"row": "7", "col": 7}],                                 # 字符串坐标
        [{"row": True, "col": 1}],                                # bool 冒充 int
        [{"row": 7}],                                             # 缺列
        [7, 7],                                                   # 不是对象
        [{"row": 7, "col": 7}, {"row": 7, "col": 8}] * 120,       # 超出棋盘容量
    ],
)
def test_broken_preset_is_rejected(client, preset):
    register(client)
    with client.websocket_connect("/ws") as web:
        web.receive_json()
        web.send_json({"type": "ai.create", "requestId": "create", "payload": {"color": "black", "preset": preset}})
        response = receive_request(web, "create")
        assert response["error"]["code"] == "VALIDATION_ERROR"


def test_preset_that_already_ends_the_game_is_rejected(client):
    """五连已经出现：这盘棋早在那里结束了，没有「接着下」这回事。"""
    register(client)
    winning = [{"row": 7, "col": 3}, {"row": 8, "col": 3}] * 2 + [
        {"row": 7, "col": 4}, {"row": 8, "col": 4},
        {"row": 7, "col": 5}, {"row": 8, "col": 5},
        {"row": 7, "col": 6}, {"row": 8, "col": 6},
        {"row": 7, "col": 7},
    ]
    with client.websocket_connect("/ws") as web:
        web.receive_json()
        web.send_json({"type": "ai.create", "requestId": "create", "payload": {"color": "black", "preset": winning}})
        response = receive_request(web, "create")
        assert response["error"]["code"] == "VALIDATION_ERROR"


def test_ai_games_do_not_count_towards_the_win_rate(app):
    """与 AI 对局不进战绩：AI 的强弱是玩家自己选的，拿它算胜率没有可比性。"""
    with TestClient(app) as client:
        register(client, "ai-only")
        with client.websocket_connect("/ws") as web:
            web.receive_json()
            game_id = _create(web, "create", {"color": "black", "preset": FOUR_PLY})["id"]
            web.send_json({"type": "game.resign", "requestId": "resign", "payload": {"gameId": game_id}})
            assert receive_request(web, "resign")["payload"]["status"] == "finished"

        stats = client.get("/api/users/me/stats").json()
    assert stats["totalGames"] == 0
    assert stats["wins"] == 0 and stats["losses"] == 0
    assert stats["winrate"] is None
