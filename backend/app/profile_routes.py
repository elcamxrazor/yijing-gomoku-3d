"""个人名片的数据端点。

名片是「读一次、渲染一张卡」的纯只读数据，走 REST。字段刻意保持扁平：
`totalGames / wins / losses / draws / winrate` 是第一版展示面，
后续要加（连续胜场、常用棋境、段位……）直接往响应里追加新键即可，
旧字段永不改名——这就是给名片留的拓展接口。
"""

import json

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select

from .game import AI_ID, POINTS_PER_GAME
from .models import Game, User

router = APIRouter(prefix="/api/users", tags=["profile"])
# 商城购买挂在自己的前缀下（POST /api/shop/purchase）。
shop_router = APIRouter(prefix="/api/shop", tags=["shop"])

# 商城目录（与前端 SHOP_ITEMS 保持同一套 id / 价格；服务端是扣费的唯一权威）。
SHOP_CATALOG: dict[str, dict[str, object]] = {
    "mat-frosted-black": {"name": "墨玉", "price": 30, "target": "frosted-black"},
    "mat-frosted-cyan": {"name": "鸿璐", "price": 30, "target": "frosted-cyan"},
    "mat-translucent-white": {"name": "凝脂", "price": 30, "target": "translucent-white"},
}


class PurchaseBody(BaseModel):
    item_id: str


def _compute_stats(session, player: str) -> dict:
    """按玩家 id 统计已结束对局：总场次、胜 / 负 / 和、胜率。

    只统计**已结束**的棋局；认输 / 掉线判负都按 winner 归属计算，与复盘列表的口径一致。
    重开时归档的旧局（excluded_from_stats）不计入。胜率为 0~1，没有对局时为 null。
    """
    total = wins = draws = 0
    games = session.scalars(select(Game).where(
        Game.status == "finished",
        # 重开时归档的旧局不计入胜率：点「重开」即视为放弃该局胜负归属。
        Game.excluded_from_stats == False,
        (Game.black_player_id == player) | (Game.white_player_id == player),
    ))
    for game in games:
        total += 1
        if game.winner == 0:
            draws += 1
        elif game.winner == (1 if game.black_player_id == player else 2):
            wins += 1
    losses = total - wins - draws
    return {
        "totalGames": total,
        "wins": wins,
        "losses": losses,
        "draws": draws,
        "winrate": round(wins / total, 4) if total else None,
    }


@router.get("/me/stats")
def my_stats(request: Request) -> dict:
    """当前用户的对局统计（名片用）。"""
    settings = request.app.state.settings
    user = request.app.state.auth.user_for_token(request.cookies.get(settings.cookie_name))
    if user is None:
        raise HTTPException(401, "请先登录或创建游客会话")
    with request.app.state.db.session() as session:
        return _compute_stats(session, str(user.id))


@router.get("/{user_id}/stats")
def user_stats(request: Request, user_id: int) -> dict:
    """查看任意玩家的公开资料（大厅 / 对局中看别人名片用）。

    回身份、战绩与**积分**（积分是公开分数，和战绩一起展示，便于互看段位）；
    **不回钱包的私人部分**（已解锁商品 / 装备皮肤）——那些才是私人信息。
    需要先登录（游客会话也可），避免被匿名枚举。
    """
    settings = request.app.state.settings
    viewer = request.app.state.auth.user_for_token(request.cookies.get(settings.cookie_name))
    if viewer is None:
        raise HTTPException(401, "请先登录或创建游客会话")
    with request.app.state.db.session() as session:
        target = session.get(User, user_id)
        if target is None:
            raise HTTPException(404, "玩家不存在")
        return {
            "id": str(target.id),
            "name": target.name,
            "guest": bool(target.guest),
            "points": target.points or 0,
            **_compute_stats(session, str(target.id)),
        }


def _equipped(user: User) -> dict:
    """装备的皮肤；缺省回退到默认实体棋子。"""
    try:
        data = json.loads(user.equipped or "{}")
    except ValueError:
        data = {}
    if not isinstance(data, dict):
        data = {}
    return {
        "materialBlack": data.get("materialBlack") or "solid-black",
        "materialWhite": data.get("materialWhite") or "solid-white",
    }


def _wallet(user: User) -> dict:
    return {
        "points": user.points or 0,
        "unlocked": json.loads(user.unlocked or "[]"),
        "pointsPerGame": POINTS_PER_GAME,
        "equipped": _equipped(user),
    }


@router.get("/me/wallet")
def my_wallet(request: Request) -> dict:
    """当前用户的积分钱包：余额 + 已解锁商品。前端本地档案只是它的缓存。"""
    settings = request.app.state.settings
    user = request.app.state.auth.user_for_token(request.cookies.get(settings.cookie_name))
    if user is None:
        raise HTTPException(401, "请先登录或创建游客会话")
    return _wallet(user)


@shop_router.post("/purchase")
def purchase(request: Request, body: PurchaseBody) -> dict:
    """购买商城商品：扣积分 + 记录解锁。服务端权威校验，防本地篡改。"""
    settings = request.app.state.settings
    user = request.app.state.auth.user_for_token(request.cookies.get(settings.cookie_name))
    if user is None:
        raise HTTPException(401, "请先登录或创建游客会话")
    item = SHOP_CATALOG.get(body.item_id)
    if item is None:
        raise HTTPException(404, "商品不存在")
    unlocked: list[str] = json.loads(user.unlocked or "[]")
    if body.item_id in unlocked:
        return _wallet(user)  # 已拥有：幂等，不重复扣费
    price = int(item["price"])  # type: ignore[arg-type]
    if (user.points or 0) < price:
        raise HTTPException(409, "积分不足")
    user.points = (user.points or 0) - price
    unlocked.append(body.item_id)
    user.unlocked = json.dumps(unlocked, ensure_ascii=False)
    with request.app.state.db.session() as session:
        merged = session.merge(user)
        session.commit()
        return _wallet(merged)


class EquipBody(BaseModel):
    """装备皮肤请求：两个颜色各一个材质 id（服务端校验已解锁）。"""

    material_black: str
    material_white: str


# 与前端 stoneMaterials 的默认 id 对齐；服务端只认这两个默认值。
_DEFAULT_SKINS = {"material_black": "solid-black", "material_white": "solid-white"}


@shop_router.post("/equip")
def equip(request: Request, body: EquipBody) -> dict:
    """保存皮肤装备：必须在已解锁列表里（默认实体棋子豁免）。"""
    settings = request.app.state.settings
    user = request.app.state.auth.user_for_token(request.cookies.get(settings.cookie_name))
    if user is None:
        raise HTTPException(401, "请先登录或创建游客会话")
    unlocked: list[str] = json.loads(user.unlocked or "[]")
    # 解锁表存的是**商品 id**（mat-*），请求里是**材质 id**（frosted-black 等），
    # 需经目录换算后再比对。
    target_to_item = {str(item["target"]): item_id for item_id, item in SHOP_CATALOG.items()}
    for side, material in (("material_black", body.material_black), ("material_white", body.material_white)):
        default = _DEFAULT_SKINS[side]
        if material == default:
            continue
        item_id = target_to_item.get(material)
        if item_id is None or item_id not in unlocked:
            raise HTTPException(403, "该皮肤尚未解锁")
    user.equipped = json.dumps({
        "materialBlack": body.material_black,
        "materialWhite": body.material_white,
    }, ensure_ascii=False)
    with request.app.state.db.session() as session:
        merged = session.merge(user)
        session.commit()
        return {"equipped": _equipped(merged)}


class PreferencesBody(BaseModel):
    """显示设置快照：前端 settings 的 JSON 原样上服（限 4KB）。"""

    preferences: dict


@router.get("/me/preferences")
def get_preferences(request: Request) -> dict:
    settings = request.app.state.settings
    user = request.app.state.auth.user_for_token(request.cookies.get(settings.cookie_name))
    if user is None:
        raise HTTPException(401, "请先登录或创建游客会话")
    try:
        data = json.loads(user.preferences or "{}")
    except ValueError:
        data = {}
    return {"preferences": data if isinstance(data, dict) else {}}


@router.put("/me/preferences")
def put_preferences(request: Request, body: PreferencesBody) -> dict:
    settings = request.app.state.settings
    user = request.app.state.auth.user_for_token(request.cookies.get(settings.cookie_name))
    if user is None:
        raise HTTPException(401, "请先登录或创建游客会话")
    payload = json.dumps(body.preferences, ensure_ascii=False)
    if len(payload.encode("utf-8")) > 4000:
        raise HTTPException(413, "设置数据过大")
    user.preferences = payload
    with request.app.state.db.session() as session:
        session.merge(user)
        session.commit()
    return {"preferences": body.preferences}
