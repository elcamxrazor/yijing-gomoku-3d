"""复盘的 HTTP 入口。

走 REST 而不是 WebSocket，是因为复盘完全是「读一次、不再变」的数据：
棋盘不会因为对手落子而更新，也就没有订阅的必要。为它开一套 WS 消息类型
只会把 `dispatch` 那张表撑得更长。

鉴权沿用同一张 Cookie：`websocket_endpoint` 与这里都从
`settings.cookie_name` 取 token，浏览器自动带上，前端不用额外处理凭据。
"""

from fastapi import APIRouter, HTTPException, Query, Request

from .replay import ReplayError

router = APIRouter(prefix="/api/games", tags=["replay"])

_UNAUTHENTICATED = "请先登录或创建游客会话"


def _require_user(request: Request):
    settings = request.app.state.settings
    user = request.app.state.auth.user_for_token(request.cookies.get(settings.cookie_name))
    if user is None:
        raise HTTPException(401, _UNAUTHENTICATED)
    return user


@router.post("/replays/{game_id}/keep")
def keep_replay(game_id: str, request: Request) -> dict:
    """把一局棋谱标记为「永久储存」，豁免 30 天清理。

    只有参与者本人能标记；重复标记幂等。成功后 `keepForever` 恒为 True。
    """
    user = _require_user(request)
    try:
        kept = request.app.state.replay.keep_forever(user.id, game_id)
    except ReplayError as exc:
        raise HTTPException(404, exc.message) from exc
    return {"gameId": game_id, "keepForever": kept}


@router.get("/replays")
def list_replays(
    request: Request,
    limit: int = Query(20, ge=1, le=50),
    offset: int = Query(0, ge=0),
    # `ai` = 与 AI 的对局，`online` = 与好友的对局；不给就是不分类。
    mode: str | None = Query(None, pattern="^(ai|online)$"),
) -> dict:
    user = _require_user(request)
    return request.app.state.replay.list_for_user(user.id, limit=limit, offset=offset, mode=mode)


@router.get("/replays/{game_id}")
def get_replay(game_id: str, request: Request) -> dict:
    user = _require_user(request)
    try:
        return request.app.state.replay.get(user.id, game_id)
    except ReplayError as exc:
        status = 404 if exc.code == "GAME_NOT_FOUND" else 400
        raise HTTPException(status, exc.message) from exc
