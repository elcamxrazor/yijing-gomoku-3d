from datetime import datetime

from conftest import receive_request, receive_state, register


def _start_ai_game(client, web, color: str = "black") -> str:
    web.send_json({
        "type": "ai.create",
        "requestId": "create",
        "payload": {"color": color, "scene": "courtyard"},
    })
    return receive_request(web, "create")["payload"]["id"]


def _finish_by_resign(client, web, game_id: str, moves: int = 1) -> None:
    """落几手再认输：棋谱里既要有真正的着法，也要有结果。

    AI 着法由测试冒充客户端提交（引擎已迁前端）：黑走 (index, 0)，
    白（AI）走 (index, 1)，与黑子同列不同行、绝不重叠。
    """
    from conftest import send_ai_move
    for index in range(moves):
        request_id = f"move-{index}"
        web.send_json({
            "type": "game.move",
            "requestId": request_id,
            "payload": {"gameId": game_id, "row": index, "col": 0},
        })
        receive_state(web, request_id, lambda state: state["moveCount"] >= 2 * index + 1 and state["aiThinking"])
        # ai_move 的 ack 即为 AI 落子后的终态快照，无需再等 broadcast。
        done = send_ai_move(web, f"ai-{index}", game_id, index, 1)["payload"]
        assert done["moveCount"] == 2 * (index + 1) and not done["aiThinking"]
    web.send_json({"type": "game.resign", "requestId": "resign", "payload": {"gameId": game_id}})
    assert receive_request(web, "resign")["payload"]["status"] == "finished"


def test_replay_lists_finished_games_with_full_move_list(client):
    register(client, "replayer")
    with client.websocket_connect("/ws") as web:
        assert web.receive_json()["type"] == "session.ready"
        game_id = _start_ai_game(client, web)
        _finish_by_resign(client, web, game_id, moves=2)

    listing = client.get("/api/games/replays")
    assert listing.status_code == 200, listing.text
    body = listing.json()
    assert body["replays"], "刚下完的一局应该出现在复盘列表里"
    summary = body["replays"][0]
    assert summary["id"] == game_id
    assert summary["mode"] == "ai"
    assert summary["scene"] == "courtyard"
    assert summary["status"] == "finished"
    assert summary["winner"] == 2
    assert summary["winReason"] == "resign"
    assert summary["yourColor"] == 1
    assert summary["players"]["black"]["name"] == "replayer"
    assert summary["players"]["white"]["name"] == "Rapfi"
    assert summary["moveCount"] >= 4
    assert summary["finishedAt"]

    detail = client.get(f"/api/games/replays/{game_id}")
    assert detail.status_code == 200, detail.text
    record = detail.json()
    assert record["id"] == game_id
    assert len(record["moves"]) == record["moveCount"]
    first = record["moves"][0]
    assert (first["row"], first["col"], first["color"]) == (0, 0, 1)
    assert [move["index"] for move in record["moves"]] == list(range(record["moveCount"]))
    # 黑白交替：偶数手黑、奇数手白
    assert all(move["color"] == (1 if index % 2 == 0 else 2) for index, move in enumerate(record["moves"]))


def test_replay_timestamps_carry_a_utc_offset(client):
    """时间戳必须带时区。

    SQLite 不保留 `DateTime(timezone=True)` 的偏移量，读回来是 naive 值；
    直接 isoformat 会给客户端一串没有偏移的字符串，浏览器把它按本地时间
    解析，显示的时间就整体偏了一个时区（UTC+8 下差 8 小时）。
    """
    register(client, "timestamps")
    with client.websocket_connect("/ws") as web:
        assert web.receive_json()["type"] == "session.ready"
        game_id = _start_ai_game(client, web)
        _finish_by_resign(client, web, game_id, moves=1)

    summary = client.get("/api/games/replays").json()["replays"][0]
    for field in ("createdAt", "finishedAt"):
        value = summary[field]
        assert value, f"{field} 不该为空"
        parsed = datetime.fromisoformat(value)
        assert parsed.tzinfo is not None, f"{field} 缺少时区：{value}"
        assert parsed.utcoffset().total_seconds() == 0, f"{field} 应该是 UTC：{value}"

    detail = client.get(f"/api/games/replays/{game_id}").json()
    assert datetime.fromisoformat(detail["createdAt"]).tzinfo is not None


def test_replay_skips_unfinished_games(client):
    register(client, "unfinished")
    with client.websocket_connect("/ws") as web:
        assert web.receive_json()["type"] == "session.ready"
        game_id = _start_ai_game(client, web)

    listing = client.get("/api/games/replays").json()
    assert all(item["id"] != game_id for item in listing["replays"]), "没下完的棋不该进复盘"

    # 但直接按 id 取仍然拿得到棋谱：以后可能要做「对局中回看」。
    detail = client.get(f"/api/games/replays/{game_id}")
    assert detail.status_code == 200
    assert detail.json()["status"] == "playing"


def test_replay_is_private_to_participants(client, settings):
    register(client, "owner")
    with client.websocket_connect("/ws") as web:
        assert web.receive_json()["type"] == "session.ready"
        game_id = _start_ai_game(client, web)
        _finish_by_resign(client, web, game_id, moves=1)
    owner_token = client.cookies.get(settings.cookie_name)
    assert owner_token

    # 换一个人登录：列表里不该有别人的棋，直接取也应当拿不到。
    client.cookies.clear()
    register(client, "intruder")
    assert client.get("/api/games/replays").json()["replays"] == []
    assert client.get(f"/api/games/replays/{game_id}").status_code == 404

    # 换回来仍然能看
    client.cookies.set(settings.cookie_name, owner_token)
    assert client.get(f"/api/games/replays/{game_id}").status_code == 200


def test_replay_requires_session(client):
    client.cookies.clear()
    assert client.get("/api/games/replays").status_code == 401
    assert client.get("/api/games/replays/whatever").status_code == 401
