"""复盘的两个行为：重开不能吃掉上一盘；列表要能按「与好友 / 与 AI」分开。

第一个是用户实测出来的 bug：赢了一盘、立刻「再来一局」，结果复盘里只剩下第二盘。
根因是 `restart` 直接在同一个 `Game` 行上清空了 `moves`。
"""

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.models import Game
from conftest import receive_request, receive_state, receive_until, register, send_ai_move
from test_spectate import agree_first_player



def _play_ai_game(client, web, moves: int, resign: bool = True) -> str:
    web.send_json({"type": "ai.create", "requestId": "create", "payload": {"color": "black"}})
    game_id = receive_request(web, "create")["payload"]["id"]
    for index in range(moves):
        request_id = f"move-{index}"
        web.send_json({
            "type": "game.move",
            "requestId": request_id,
            "payload": {"gameId": game_id, "row": index, "col": 0},
        })
        receive_state(web, request_id, lambda state: state["moveCount"] >= 2 * index + 1 and state["aiThinking"])
        done = send_ai_move(web, f"ai-{index}", game_id, index, 1)["payload"]
        assert done["moveCount"] == 2 * (index + 1) and not done["aiThinking"]
    if resign:
        web.send_json({"type": "game.resign", "requestId": "resign", "payload": {"gameId": game_id}})
        assert receive_request(web, "resign")["payload"]["status"] == "finished"
    return game_id


def test_restart_archives_the_previous_finished_game(client):
    register(client, "rematcher")
    with client.websocket_connect("/ws") as web:
        assert web.receive_json()["type"] == "session.ready"
        game_id = _play_ai_game(client, web, moves=1)

        first = client.get("/api/games/replays").json()["replays"]
        assert len(first) == 1 and first[0]["moveCount"] == 2

        # 再来一局：局号不变，但上一盘应当被归档而不是被抹掉
        web.send_json({"type": "game.restart", "requestId": "restart", "payload": {"gameId": game_id}})
        restarted = receive_request(web, "restart")["payload"]
        assert restarted["id"] == game_id
        assert restarted["moveCount"] == 0

        _play_ai_game_continue(web, game_id, moves=2)

    replays = client.get("/api/games/replays").json()["replays"]
    assert len(replays) == 2, "重开不应该吃掉上一盘的棋谱"
    assert len({item["id"] for item in replays}) == 2
    assert game_id in {item["id"] for item in replays}
    assert sorted(item["moveCount"] for item in replays) == [2, 4]


def _play_ai_game_continue(web, game_id: str, moves: int) -> None:
    """在一盘已经存在的对局里继续下（重开之后接着用同一个 game_id）。"""
    for index in range(moves):
        request_id = f"again-{index}"
        web.send_json({
            "type": "game.move",
            "requestId": request_id,
            "payload": {"gameId": game_id, "row": 5 + index, "col": 3},
        })
        receive_state(web, request_id, lambda state: state["aiThinking"] and state["moveCount"] >= 2 * index + 1)
        send_ai_move(web, f"again-ai-{index}", game_id, index, 6)
    web.send_json({"type": "game.resign", "requestId": "resign-again", "payload": {"gameId": game_id}})
    assert receive_request(web, "resign-again")["payload"]["status"] == "finished"


def test_restart_in_a_room_keeps_both_games(app):
    with TestClient(app) as black_client, TestClient(app) as white_client:
        register(black_client, "first")
        register(white_client, "second")
        with black_client.websocket_connect("/ws") as black, white_client.websocket_connect("/ws") as white:
            assert black.receive_json()["type"] == "session.ready"
            assert white.receive_json()["type"] == "session.ready"

            black.send_json({"type": "room.create", "requestId": "create", "payload": {}})
            created = receive_request(black, "create")["payload"]
            game_id = created["id"]
            white.send_json({"type": "room.join", "requestId": "join", "payload": {"code": created["roomCode"]}})
            receive_request(white, "join")
            receive_until(black, lambda m: m["type"] == "game.snapshot" and m["payload"]["status"] == "playing")

            # 开局「决定先后手」：双方一致指向黑座 → 黑先手，落子闸门打开。
            agree_first_player(black, white, game_id)

            # 第一盘：黑落一手，黑认输 → 白胜
            black.send_json({"type": "game.move", "requestId": "b1", "payload": {"gameId": game_id, "row": 7, "col": 7}})
            receive_request(black, "b1")
            black.send_json({"type": "game.resign", "requestId": "r1", "payload": {"gameId": game_id}})
            assert receive_request(black, "r1")["payload"]["winner"] == 2

            # 立刻再来一局：联机重开需对方同意—黑发起、白同意后才清盘，并自动轮换先后手。
            black.send_json({"type": "game.restart", "requestId": "restart-req", "payload": {"gameId": game_id}})
            receive_request(black, "restart-req")
            receive_until(white, lambda m: m["type"] == "game.restart_requested")
            white.send_json({"type": "game.restart_response", "requestId": "restart-accept", "payload": {"gameId": game_id, "accept": True}})
            receive_request(white, "restart-accept")
            restarted = receive_until(black, lambda m: m["type"] == "game.snapshot" and m["payload"]["moveCount"] == 0 and not m["payload"].get("restartPending"))["payload"]
            assert restarted["id"] == game_id and restarted["moveCount"] == 0
            assert restarted["yourColor"] == 2, "上一盘的黑座这一盘应执白"

            # 第二盘：座位已轮换——原白方（white 客户端）现执黑先手。
            # 各下一手后白认输 → 黑胜（黑座现在是 white 客户端）。
            white.send_json({"type": "game.move", "requestId": "b2", "payload": {"gameId": game_id, "row": 6, "col": 6}})
            assert receive_request(white, "b2")["payload"]["moveCount"] == 1
            black.send_json({"type": "game.move", "requestId": "w1", "payload": {"gameId": game_id, "row": 0, "col": 0}})
            receive_request(black, "w1")
            black.send_json({"type": "game.resign", "requestId": "r2", "payload": {"gameId": game_id}})
            assert receive_request(black, "r2")["payload"]["winner"] == 1

        # 两个人都要能看到这两盘（归档行同样带双方 id）
        for client in (black_client, white_client):
            replays = client.get("/api/games/replays").json()["replays"]
            assert len(replays) == 2, "两盘棋都应该留在复盘里"
            assert game_id in {item["id"] for item in replays}, "当前这一局必须在"
            # 一盘白胜（先）、一盘黑胜（后），手数分别是 1 和 2
            assert sorted((item["winner"], item["moveCount"]) for item in replays) == [(1, 2), (2, 1)]


def test_restart_in_a_room_excluded_from_win_rate(app):
    """点重开产生的归档旧局不计入胜率：黑认输本是负局，被重开归档后统计里应消失。"""
    with TestClient(app) as black_client, TestClient(app) as white_client:
        me = register(black_client, "ratelord")
        register(white_client, "ratefoe")
        with black_client.websocket_connect("/ws") as black, white_client.websocket_connect("/ws") as white:
            assert black.receive_json()["type"] == "session.ready"
            assert white.receive_json()["type"] == "session.ready"
            black.send_json({"type": "room.create", "requestId": "create", "payload": {}})
            created = receive_request(black, "create")["payload"]
            game_id = created["id"]
            white.send_json({"type": "room.join", "requestId": "join", "payload": {"code": created["roomCode"]}})
            receive_request(white, "join")
            receive_until(black, lambda m: m["type"] == "game.snapshot" and m["payload"]["status"] == "playing")
            agree_first_player(black, white, game_id)

            # 黑落一手后认输 → 白胜（黑记为负局）。
            black.send_json({"type": "game.move", "requestId": "b1", "payload": {"gameId": game_id, "row": 7, "col": 7}})
            receive_request(black, "b1")
            black.send_json({"type": "game.resign", "requestId": "r", "payload": {"gameId": game_id}})
            assert receive_request(black, "r")["payload"]["winner"] == 2

            # 重开（需白同意）：归档旧局但不计入胜率。
            black.send_json({"type": "game.restart", "requestId": "restart-req", "payload": {"gameId": game_id}})
            receive_request(black, "restart-req")
            receive_until(white, lambda m: m["type"] == "game.restart_requested")
            white.send_json({"type": "game.restart_response", "requestId": "restart-accept", "payload": {"gameId": game_id, "accept": True}})
            receive_request(white, "restart-accept")
            receive_until(black, lambda m: m["type"] == "game.snapshot" and m["payload"]["moveCount"] == 0 and not m["payload"].get("restartPending"))

            with app.state.db.session() as session:
                archived = list(session.scalars(
                    select(Game).where(Game.status == "finished", Game.black_player_id == str(me["id"]))
                ))
                assert archived, "应有一盘已结束的归档局"
                assert all(g.excluded_from_stats for g in archived), "重开归档局必须标记 excluded_from_stats"

        # 黑认输本是负局，但被重开归档 → 不计入胜率。
        stats = black_client.get("/api/users/me/stats").json()
        assert stats["totalGames"] == 0, stats


def test_restart_request_can_be_declined(app):
    """PVP 重开请求可被对方婉拒：盘不被清、请求被撤销。"""
    with TestClient(app) as black_client, TestClient(app) as white_client:
        register(black_client, "asker")
        register(white_client, "decliner")
        with black_client.websocket_connect("/ws") as black, white_client.websocket_connect("/ws") as white:
            assert black.receive_json()["type"] == "session.ready"
            assert white.receive_json()["type"] == "session.ready"
            black.send_json({"type": "room.create", "requestId": "create", "payload": {}})
            created = receive_request(black, "create")["payload"]
            game_id = created["id"]
            white.send_json({"type": "room.join", "requestId": "join", "payload": {"code": created["roomCode"]}})
            receive_request(white, "join")
            receive_until(black, lambda m: m["type"] == "game.snapshot" and m["payload"]["status"] == "playing")
            agree_first_player(black, white, game_id)
            black.send_json({"type": "game.move", "requestId": "b1", "payload": {"gameId": game_id, "row": 7, "col": 7}})
            receive_request(black, "b1")

            black.send_json({"type": "game.restart", "requestId": "restart-req", "payload": {"gameId": game_id}})
            black_pending = receive_request(black, "restart-req")["payload"]
            assert black_pending.get("restartPending") is True, black_pending
            requested = receive_until(white, lambda m: m["type"] == "game.restart_requested")
            assert requested["payload"]["fromName"] == "asker"

            # 白婉拒。
            white.send_json({"type": "game.restart_response", "requestId": "restart-decline", "payload": {"gameId": game_id, "accept": False}})
            receive_request(white, "restart-decline")
            # 黑看到请求被撤销（restartPending 回到 False / 无 restartRequest）。
            cleared = receive_until(black, lambda m: m["type"] == "game.snapshot" and not m["payload"].get("restartPending"))
            assert cleared["payload"]["moveCount"] == 1, "婉拒后棋盘不应被清空"


def test_replays_can_be_filtered_by_opponent_kind(app):
    with TestClient(app) as single, TestClient(app) as friend:
        me = register(single, "solo")
        buddy = register(friend, "buddy")

        # 两个客户端各只开一条 WebSocket，先下完一盘 AI 局，再开一局好友房。
        # （反复进出 websocket_connect 会让大厅的下发与清理交错，容易卡住。）
        with single.websocket_connect("/ws") as mine, friend.websocket_connect("/ws") as theirs:
            assert mine.receive_json()["type"] == "session.ready"
            assert theirs.receive_json()["type"] == "session.ready"

            _play_ai_game(single, mine, moves=1)

            # requestId 必须换一个：服务端按 (用户, requestId) 缓存响应，
            # 复用 "create" 会直接把上一盘 AI 局的快照原样返回，房间根本没建。
            mine.send_json({"type": "room.create", "requestId": "create-room", "payload": {}})
            created = receive_request(mine, "create-room")["payload"]
            theirs.send_json({"type": "room.join", "requestId": "join", "payload": {"code": created["roomCode"]}})
            joined = receive_request(theirs, "join")
            assert "error" not in joined, joined
            receive_until(mine, lambda m: m["type"] == "game.snapshot" and m["payload"]["status"] == "playing")
            mine.send_json({"type": "game.resign", "requestId": "r", "payload": {"gameId": created["id"]}})
            receive_request(mine, "r")

        assert me["id"] != buddy["id"]
        everything = single.get("/api/games/replays").json()["replays"]
        assert len(everything) == 2

        only_ai = single.get("/api/games/replays", params={"mode": "ai"}).json()["replays"]
        only_online = single.get("/api/games/replays", params={"mode": "online"}).json()["replays"]
        assert [item["mode"] for item in only_ai] == ["ai"]
        assert [item["mode"] for item in only_online] == ["online"]
        assert len(only_ai) + len(only_online) == len(everything)

        # 脏参数不该把列表清空，也不该 500（由 Query 的 pattern 拦成 422）
        assert single.get("/api/games/replays", params={"mode": "weird"}).status_code == 422
