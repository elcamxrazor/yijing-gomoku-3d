"""个人名片的对局统计端点（GET /api/users/me/stats）。"""
from fastapi.testclient import TestClient

from conftest import receive_request, receive_until, register, send_ai_move


def test_profile_stats_counts_wins_losses_draws(app):
    with TestClient(app) as client:
        me = register(client, "statistician")
        assert client.get("/api/users/me/stats").json() == {
            "totalGames": 0, "wins": 0, "losses": 0, "draws": 0, "winrate": None,
        }

        with client.websocket_connect("/ws") as web:
            assert web.receive_json()["type"] == "session.ready"

            def play_online(opponent_ws: TestClient, opponent_name: str, i_resign: bool) -> None:
                """开一局好友房：我执黑下一手；i_resign 时我认输，否则对手认输。"""
                web.send_json({"type": "room.create", "requestId": f"create-{opponent_name}", "payload": {}})
                created = receive_request(web, f"create-{opponent_name}")["payload"]
                game_id = created["id"]
                code = created["roomCode"]
                opponent_ws.send_json({"type": "room.join", "requestId": f"join-{opponent_name}", "payload": {"code": code}})
                receive_request(opponent_ws, f"join-{opponent_name}")
                receive_until(web, lambda m: m["type"] == "game.snapshot" and m["payload"]["status"] == "playing")

                # 先后手协商：我选 self、对手选 opponent → 一致指向我 → 我执黑先手。
                web.send_json({"type": "game.first_move_choice", "requestId": f"ob-me-{opponent_name}", "payload": {"gameId": game_id, "choice": "self"}})
                opponent_ws.send_json({"type": "game.first_move_choice", "requestId": f"ob-op-{opponent_name}", "payload": {"gameId": game_id, "choice": "opponent"}})
                receive_until(web, lambda m: m["type"] == "game.opening_result")
                receive_until(opponent_ws, lambda m: m["type"] == "game.opening_result")

                web.send_json({"type": "game.move", "requestId": f"m-{opponent_name}", "payload": {"gameId": game_id, "row": 7, "col": 7}})
                receive_request(web, f"m-{opponent_name}")
                loser = web if i_resign else opponent_ws
                loser.send_json({"type": "game.resign", "requestId": f"r-{opponent_name}", "payload": {"gameId": game_id}})
                receive_request(loser, f"r-{opponent_name}")

            # 对手客户端们
            with TestClient(app) as a_client, TestClient(app) as b_client, TestClient(app) as c_client:
                register(a_client, "alice")
                register(b_client, "bob")
                register(c_client, "cara")
                with a_client.websocket_connect("/ws") as a, b_client.websocket_connect("/ws") as b, c_client.websocket_connect("/ws") as c:
                    for socket in (a, b, c):
                        socket.receive_json()
                    play_online(a, "alice", i_resign=False)   # 对手认输 → 胜
                    play_online(b, "bob", i_resign=True)      # 我认输 → 负
                    play_online(c, "cara", i_resign=False)    # 胜

                    # 内存库的连接随 TestClient 退出而被 dispose，
                    # 统计查询必须发生在所有客户端仍存活的时候。
                    stats = client.get("/api/users/me/stats").json()
        assert stats["totalGames"] == 3
        assert stats["wins"] == 2
        assert stats["losses"] == 1
        assert stats["draws"] == 0
        assert stats["winrate"] == round(2 / 3, 4)


def test_profile_stats_requires_auth(app):
    fresh = TestClient(app)
    assert fresh.get("/api/users/me/stats").status_code == 401


def test_public_profile_reports_identity_but_not_wallet(app):
    """大厅 / 对局里看别人名片：能拿到身份、战绩与积分（与他人名片布局一致），但钱包解锁列表仍属私人。"""
    with TestClient(app) as alice_client, TestClient(app) as bob_client:
        alice = register(alice_client, "alice")
        register(bob_client, "bob")  # bob 已登录，去看 alice 的名片

        resp = bob_client.get(f"/api/users/{alice['id']}/stats")
        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == str(alice["id"])
        assert data["name"] == "alice"
        assert data["guest"] is False
        assert data["totalGames"] == 0
        assert data["wins"] == data["losses"] == data["draws"] == 0
        assert data["winrate"] is None
        # 积分按产品需求在公开名片展示（与他人名片一致）；但钱包解锁列表仍是私人，
        # 公开资料绝不能出现 unlocked。
        assert "points" in data and isinstance(data["points"], int)
        assert "unlocked" not in data


def test_public_profile_unknown_user_is_404(app):
    with TestClient(app) as client:
        register(client, "alice")
        assert client.get("/api/users/999999/stats").status_code == 404


def test_public_profile_requires_auth(app):
    fresh = TestClient(app)
    assert fresh.get("/api/users/1/stats").status_code == 401
