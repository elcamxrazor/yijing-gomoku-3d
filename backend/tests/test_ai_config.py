"""对局中切换执子权（观赏 / 编辑模式）的测试。"""

from __future__ import annotations

from conftest import receive_request, register, send_ai_move


def _create(websocket, color: str = "black") -> str:
    websocket.send_json({"type": "ai.create", "requestId": "c", "payload": {"color": color}})
    return receive_request(websocket, "c")["payload"]["id"]


def test_edit_mode_lets_human_play_both_sides(client):
    register(client, "editor")
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        game_id = _create(ws)
        # 切到编辑模式：双方都不是 AI。
        ws.send_json({"type": "game.ai_config", "requestId": "cfg", "payload": {
            "gameId": game_id, "aiBlack": False, "aiWhite": False,
        }})
        ack = receive_request(ws, "cfg")
        assert ack["payload"]["aiBlack"] is False and ack["payload"]["aiWhite"] is False

        # 玩家连下黑白两方（座位是黑，但编辑模式不看座位）。
        ws.send_json({"type": "game.move", "requestId": "b", "payload": {"gameId": game_id, "row": 7, "col": 7}})
        assert receive_request(ws, "b")["payload"]["moveCount"] == 1
        ws.send_json({"type": "game.move", "requestId": "w", "payload": {"gameId": game_id, "row": 8, "col": 8}})
        assert receive_request(ws, "w")["payload"]["moveCount"] == 2


def test_spectator_mode_loops_ai_moves(client):
    register(client, "watcher")
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        game_id = _create(ws, "white")  # 人执白座，AI 黑——初始就是 AI 先手
        ws.send_json({"type": "game.ai_config", "requestId": "cfg", "payload": {
            "gameId": game_id, "aiBlack": True, "aiWhite": True,
        }})
        ack = receive_request(ws, "cfg")
        assert ack["payload"]["aiThinking"] is True

        # 客户端引擎轮番代算：黑一手、白一手都通过 ai_move 提交。
        first = send_ai_move(ws, "b", game_id, 7, 7)["payload"]
        assert first["moveCount"] == 1 and first["aiThinking"] is True
        second = send_ai_move(ws, "w", game_id, 8, 8)["payload"]
        assert second["moveCount"] == 2 and second["aiThinking"] is True


def test_mixed_mode_blocks_human_move_on_ai_side(client):
    register(client, "mixed")
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        game_id = _create(ws, "black")  # AI 执白
        ws.send_json({"type": "game.move", "requestId": "b", "payload": {"gameId": game_id, "row": 7, "col": 7}})
        receive_request(ws, "b")
        # 轮到白（AI 执子）时人类落子被拒。
        ws.send_json({"type": "game.move", "requestId": "w", "payload": {"gameId": game_id, "row": 8, "col": 8}})
        assert receive_request(ws, "w")["error"]["code"] in {"NOT_YOUR_TURN", "AI_THINKING"}
        # 但 AI 着法正常提交。
        done = send_ai_move(ws, "ai", game_id, 8, 8)["payload"]
        assert done["moveCount"] == 2 and done["aiThinking"] is False
