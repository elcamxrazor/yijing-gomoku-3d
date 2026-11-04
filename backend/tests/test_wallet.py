"""积分钱包（服务端权威）的端点与结算测试。"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from conftest import receive_request, register, send_ai_move


def test_wallet_defaults_and_purchase(app, client: TestClient):
    register(client, "buyer")
    wallet = client.get("/api/users/me/wallet").json()
    assert wallet["points"] == 10000
    assert wallet["unlocked"] == []
    assert wallet["pointsPerGame"] == 10

    # 购买成功：扣 30、解锁记录落库。
    bought = client.post("/api/shop/purchase", json={"item_id": "mat-frosted-black"})
    assert bought.status_code == 200, bought.text
    assert bought.json()["points"] == 9970
    assert bought.json()["unlocked"] == ["mat-frosted-black"]

    # 重复购买幂等：不重复扣费。
    again = client.post("/api/shop/purchase", json={"item_id": "mat-frosted-black"}).json()
    assert again["points"] == 9970

    # 未知商品 404。
    assert client.post("/api/shop/purchase", json={"item_id": "nope"}).status_code == 404

    # 未登录 401。
    anonymous = TestClient(app)
    assert anonymous.get("/api/users/me/wallet").status_code == 401


def test_finish_awards_points_to_humans(app, client: TestClient):
    register(client, "earner")
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": "ai.create", "requestId": "c", "payload": {"color": "black"}})
        created = receive_request(ws, "c")["payload"]
        game_id = created["id"]
        ws.send_json({"type": "game.move", "requestId": "m1", "payload": {"gameId": game_id, "row": 7, "col": 7}})
        receive_request(ws, "m1")
        # AI 应手后认输 → 终局结算 +10。
        send_ai_move(ws, "ai1", game_id, 0, 0)
        ws.send_json({"type": "game.resign", "requestId": "resign", "payload": {"gameId": game_id}})
        assert receive_request(ws, "resign")["payload"]["status"] == "finished"

    wallet = client.get("/api/users/me/wallet").json()
    assert wallet["points"] == 10000 + wallet["pointsPerGame"]


def test_physical_goods_redeem_and_cannot_be_equipped(client: TestClient):
    """实物商品（小米SU7，10 积分）能兑换，但不能被当成棋子材质装备。"""
    register(client, "redeemer")
    bought = client.post("/api/shop/purchase", json={"item_id": "goods-xiaomi-su7"})
    assert bought.status_code == 200, bought.text
    assert bought.json()["points"] == 10000 - 10
    assert "goods-xiaomi-su7" in bought.json()["unlocked"]

    # 实物没有可装备目标：空材质 id 必须被拒，不能借目录里的空 target 蒙混过关。
    denied = client.post("/api/shop/equip", json={"material_black": "", "material_white": "solid-white"})
    assert denied.status_code == 403


def test_wallet_unlock_persists_into_profile_cache(client: TestClient):
    """前端把 unlocked 缓存进档案：这里只验证服务端列表可被原样读回。"""
    register(client, "keeper")
    client.post("/api/shop/purchase", json={"item_id": "mat-translucent-white"})
    wallet = client.get("/api/users/me/wallet").json()
    assert isinstance(wallet["unlocked"], list) and "mat-translucent-white" in wallet["unlocked"]
    # unlocked 存的是 JSON 文本列，读取必须是干净的数组而不是字符串。
    assert not isinstance(wallet["unlocked"], str)
    json.dumps(wallet["unlocked"])  # 可序列化
