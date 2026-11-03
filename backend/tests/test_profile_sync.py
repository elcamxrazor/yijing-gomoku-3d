"""皮肤装备同步、显示设置持久化与棋谱保留策略的测试。"""

from __future__ import annotations

from conftest import receive_request, register, send_ai_move


def test_equip_requires_unlock_and_persists(client):
    register(client, "skinner")
    # 未解锁皮肤被拒。
    denied = client.post("/api/shop/equip", json={
        "material_black": "frosted-black", "material_white": "solid-white",
    })
    assert denied.status_code == 403

    # 购买后可装备并持久化。
    client.post("/api/shop/purchase", json={"item_id": "mat-frosted-black"})
    ok = client.post("/api/shop/equip", json={
        "material_black": "frosted-black", "material_white": "solid-white",
    })
    assert ok.status_code == 200
    assert ok.json()["equipped"]["materialBlack"] == "frosted-black"

    # 钱包里也带 equipped（登录即同步的数据源）。
    wallet = client.get("/api/users/me/wallet").json()
    assert wallet["equipped"]["materialBlack"] == "frosted-black"

    # 快照透传：AI 局里玩家（黑座）的 skin 应出现。
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": "ai.create", "requestId": "c", "payload": {"color": "black"}})
        created = receive_request(ws, "c")["payload"]
    assert created["players"]["black"]["skin"] == "frosted-black"
    assert "skin" not in created["players"]["white"]  # AI 没有皮肤


def test_preferences_roundtrip(client):
    register(client, "prefs")
    empty = client.get("/api/users/me/preferences").json()
    assert empty == {"preferences": {}}

    saved = client.put("/api/users/me/preferences", json={
        "preferences": {"moveNumbers": "all", "showOpponentSkin": False},
    })
    assert saved.status_code == 200
    again = client.get("/api/users/me/preferences").json()["preferences"]
    assert again["moveNumbers"] == "all"
    assert again["showOpponentSkin"] is False

    # 未登录 401。
    from fastapi.testclient import TestClient
    anonymous = TestClient(app := client.app)
    assert anonymous.get("/api/users/me/preferences").status_code == 401


def test_replay_keep_forever(client):
    register(client, "keeper")
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": "ai.create", "requestId": "c", "payload": {"color": "black"}})
        game_id = receive_request(ws, "c")["payload"]["id"]
        ws.send_json({"type": "game.move", "requestId": "m", "payload": {"gameId": game_id, "row": 7, "col": 7}})
        receive_request(ws, "m")
        send_ai_move(ws, "ai", game_id, 0, 0)
        ws.send_json({"type": "game.resign", "requestId": "r", "payload": {"gameId": game_id}})
        receive_request(ws, "r")

    detail = client.get(f"/api/games/replays/{game_id}").json()
    assert detail["keepForever"] is False

    kept = client.post(f"/api/games/replays/{game_id}/keep")
    assert kept.status_code == 200 and kept.json()["keepForever"] is True

    # 幂等：再标一次仍成功。
    assert client.post(f"/api/games/replays/{game_id}/keep").status_code == 200
    assert client.get(f"/api/games/replays/{game_id}").json()["keepForever"] is True

    # 路人的棋谱按不存在处理。
    register(client, "stranger")
    assert client.post(f"/api/games/replays/{game_id}/keep").status_code == 404
