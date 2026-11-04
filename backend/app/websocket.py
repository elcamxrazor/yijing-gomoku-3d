from typing import Any
from urllib.parse import urlsplit

import asyncio

from fastapi import WebSocket, WebSocketDisconnect

from .game import GameError
from .schemas import user_dict


def _payload(message: dict) -> dict:
    payload = message.get("payload", {})
    if payload is None:
        return {}
    if not isinstance(payload, dict):
        raise GameError("VALIDATION_ERROR", "payload 必须是对象")
    return payload


def _required(payload: dict, key: str, kind: type) -> Any:
    value = payload.get(key)
    if not isinstance(value, kind) or isinstance(value, bool) and kind is int:
        raise GameError("VALIDATION_ERROR", f"payload.{key} 类型不正确")
    return value


def _rule_of(payload: dict) -> str | None:
    """取出规则变体（"freestyle" / "renju"）；没写则 None（服务端默认无禁手）。"""
    value = payload.get("rule")
    return value if isinstance(value, str) else None


def _scene_of(payload: dict) -> str | None:
    """取出棋境；没有或不是字符串时返回 None，交由服务端随机。

    不问类型、不做大小写归一化：``normalize_scene`` 会把不认识的取值退回默认，
    所以这里只需要把「没写」和「写了个别的」区分开——前者要随机，后者用默认值。
    """
    value = payload.get("scene")
    return value if isinstance(value, str) else None


def _time_control_of(payload: dict) -> dict | None:
    """取出读秒配置。没写就原样返回 None —— 老客户端的「不限时」由此得到保证。

    合法性交给 `GameService.parse_time_control` 判：档位白名单只该有一处真源。
    """
    value = payload.get("timeControl")
    return value if isinstance(value, dict) else None


def _preset_of(payload: dict) -> list | None:
    """取出残局前缀（复盘「一键续弈」用）。

    只做「是不是数组」这一层判断；坐标、重复、终局这些真正要紧的校验
    交给 `GameService.parse_preset`——那是落库前的最后一道闸。
    """
    value = payload.get("preset")
    return value if isinstance(value, list) else None


def _tagged(message: dict, response: dict) -> dict:
    if "requestId" in message:
        response["requestId"] = message["requestId"]
    return response


async def dispatch(user, message: dict, app) -> dict:
    message_type = message.get("type")
    payload = _payload(message)
    games = app.state.games
    lobby = app.state.lobby
    spectate = app.state.spectate
    if not isinstance(message_type, str):
        raise GameError("INVALID_MESSAGE", "消息缺少有效 type")

    if message_type == "spectate.join":
        snapshot = await spectate.join(user, _required(payload, "gameId", str))
        return _tagged(message, {"type": "game.snapshot", "payload": snapshot})
    if message_type == "spectate.leave":
        await spectate.leave(user)
        return _tagged(message, {"type": "spectate.left", "payload": {"gameId": None}})
    if message_type == "game.ring":
        result = await games.ring(user, _required(payload, "gameId", str))
        return _tagged(message, {"type": "game.ring_ack", "payload": result})
    if message_type == "game.phrase":
        result = await games.phrase(
            user,
            _required(payload, "gameId", str),
            _required(payload, "phraseId", str),
        )
        return _tagged(message, {"type": "game.phrase_ack", "payload": result})
    if message_type == "game.ai_request":
        result = await games.ai_analysis_request(user, _required(payload, "gameId", str))
        return _tagged(message, {"type": "game.ai_request_ack", "payload": result})
    if message_type == "game.ai_respond":
        result = await games.ai_analysis_response(
            user,
            _required(payload, "gameId", str),
            _required(payload, "accept", bool),
        )
        return _tagged(message, {"type": "game.ai_response_ack", "payload": result})
    if message_type == "game.ai_result":
        result = await games.ai_analysis_submit(
            user,
            _required(payload, "gameId", str),
            _required(payload, "row", int),
            _required(payload, "col", int),
        )
        return _tagged(message, {"type": "game.ai_result_ack", "payload": result})
    if message_type == "game.first_move_choice":
        result = await games.submit_first_move_choice(
            user,
            _required(payload, "gameId", str),
            _required(payload, "choice", str),
        )
        return _tagged(message, {"type": "game.first_move_choice_ack", "payload": result})

    if message_type == "challenge.create":
        try:
            target_id = int(_required(payload, "targetId", str))
        except ValueError as exc:
            raise GameError("VALIDATION_ERROR", "payload.targetId 不是有效的玩家编号") from exc
        view = await lobby.create(
            user,
            target_id,
            time_control=_time_control_of(payload),
            scene=_scene_of(payload),
        )
        return _tagged(message, {"type": "challenge.sent", "payload": view})
    if message_type == "challenge.respond":
        challenge_id = _required(payload, "challengeId", str)
        accept = _required(payload, "accept", bool)
        result = await lobby.respond(user, challenge_id, accept)
        return _tagged(message, {"type": "challenge.result", "payload": result})
    if message_type == "challenge.cancel":
        result = await lobby.cancel(user, _required(payload, "challengeId", str))
        return _tagged(message, {"type": "challenge.result", "payload": result})

    if message_type == "ai.create":
        color = _required(payload, "color", str)
        # scene / rule 都是可选的：不带就让服务端随机 / 默认无禁手。
        # preset（残局前缀）同理：不带就是空盘开局，老客户端完全不受影响。
        snapshot = await games.create_ai(
            user, color, _scene_of(payload), _rule_of(payload), _preset_of(payload)
        )
    elif message_type == "room.create":
        snapshot = await games.create_room(
            user, _scene_of(payload), _rule_of(payload), _time_control_of(payload)
        )
    elif message_type == "room.join":
        snapshot = await games.join_room(user, _required(payload, "code", str))
    elif message_type == "room.resume":
        snapshot = await games.resume_room(user, _required(payload, "code", str))
    elif message_type == "room.leave":
        game_id = _required(payload, "gameId", str)
        await games.leave(user, game_id)
        snapshot = games.snapshot(game_id, user.id)
    elif message_type == "game.move":
        game_id = _required(payload, "gameId", str)
        row = _required(payload, "row", int)
        col = _required(payload, "col", int)
        await games.move(user, game_id, row, col)
        snapshot = games.snapshot(game_id, user.id)
    elif message_type == "game.ai_config":
        game_id = _required(payload, "gameId", str)
        ai_black = bool(payload.get("aiBlack"))
        ai_white = bool(payload.get("aiWhite"))
        await games.ai_config(user, game_id, ai_black, ai_white)
        snapshot = games.snapshot(game_id, user.id)
    elif message_type == "game.ai_move":
        # 人机局：AI 着法由客户端前端引擎计算后提交，服务端重新校验合法性。
        game_id = _required(payload, "gameId", str)
        row = _required(payload, "row", int)
        col = _required(payload, "col", int)
        await games.submit_ai_move(user, game_id, row, col)
        snapshot = games.snapshot(game_id, user.id)
    elif message_type == "game.undo":
        game_id = _required(payload, "gameId", str)
        await games.undo(user, game_id)
        snapshot = games.snapshot(game_id, user.id)
    elif message_type == "game.undo_response":
        game_id = _required(payload, "gameId", str)
        accept = _required(payload, "accept", bool)
        await games.undo_response(user, game_id, accept)
        snapshot = games.snapshot(game_id, user.id)
    elif message_type == "game.restart_response":
        game_id = _required(payload, "gameId", str)
        accept = _required(payload, "accept", bool)
        await games.restart_response(user, game_id, accept)
        snapshot = games.snapshot(game_id, user.id)
    elif message_type == "game.restart":
        game_id = _required(payload, "gameId", str)
        await games.restart(user, game_id)
        snapshot = games.snapshot(game_id, user.id)
    elif message_type == "game.resign":
        game_id = _required(payload, "gameId", str)
        await games.resign(user, game_id)
        snapshot = games.snapshot(game_id, user.id)
    else:
        raise GameError("UNKNOWN_TYPE", "不支持的消息类型")
    return _tagged(message, {"type": "game.snapshot", "payload": snapshot})


def _origin_allowed(websocket: WebSocket, allowed_origins: list[str]) -> bool:
    origin = websocket.headers.get("origin")
    if not origin:
        # Non-browser clients may omit Origin; Cookie authentication still applies.
        return True
    if origin in allowed_origins:
        return True
    host = websocket.headers.get("host")
    if not host:
        return False
    parsed = urlsplit(origin)
    return parsed.netloc == host and parsed.scheme in {"http", "https"}


async def websocket_endpoint(websocket: WebSocket):
    app = websocket.app
    settings = app.state.settings
    user = app.state.auth.user_for_token(websocket.cookies.get(settings.cookie_name))
    await websocket.accept()
    if not _origin_allowed(websocket, settings.cors_origin_list):
        await websocket.send_json({
            "type": "error",
            "error": {"code": "ORIGIN_REJECTED", "message": "WebSocket 来源不被允许"},
        })
        await websocket.close(code=4403)
        return
    if not user:
        await websocket.send_json({
            "type": "error",
            "error": {"code": "UNAUTHENTICATED", "message": "请先登录或创建游客会话"},
        })
        await websocket.close(code=4401)
        return

    connection = await app.state.hub.register(websocket, user.id)
    try:
        await connection.send({
            "type": "session.ready",
            "payload": {"user": user_dict(user), "games": app.state.games.snapshots_for_user(user.id)},
        })
        # 名单在所有连接上重算并广播，而不是只发给新来的人：
        # 别人也要知道「有人刚进大厅」，否则大厅永远停在上一帧。
        await app.state.lobby.broadcast()
        # 上线也要告诉对手：他可能正盯着「对方已断线 01:12 后判负」的横幅。
        await app.state.games.player_presence(user.id, True)
        while True:
            try:
                message = await websocket.receive_json()
                if not isinstance(message, dict):
                    raise GameError("INVALID_MESSAGE", "消息必须是 JSON 对象")
                if message.get("type") == "ping":
                    await connection.send({"type": "pong"})
                    continue
                if message.get("type") == "lobby.watch":
                    # 订阅式拉取：打开面板时连上，关掉面板时断开。
                    # 重复收到 on=true 等价于「再给我一份最新的」，客户端靠它做兜底刷新。
                    watch = _payload(message).get("on")
                    connection.watching_lobby = watch is not False
                    if connection.watching_lobby:
                        await app.state.lobby.push(connection)
                    continue
                if message.get("type") == "game.focus":
                    # 客户端报告「我此刻在看哪盘棋」。大厅的座位状态以此为准，
                    # 这样一盘被遗弃的棋不会让人永远挂在「对弈中」。
                    focus = _payload(message).get("gameId")
                    await app.state.lobby.set_focus(user.id, focus if isinstance(focus, str) else None)
                    continue
                request_id = message.get("requestId")
                cache_key = str(request_id) if request_id is not None else None
                if cache_key is not None:
                    cached = app.state.hub.cached_response(user.id, cache_key)
                    if cached:
                        await connection.send(cached)
                        continue
                    async with app.state.hub.request_lock(user.id, cache_key):
                        cached = app.state.hub.cached_response(user.id, cache_key)
                        if cached:
                            await connection.send(cached)
                            continue
                        response = await dispatch(user, message, app)
                        app.state.hub.cache_response(user.id, cache_key, response)
                else:
                    response = await dispatch(user, message, app)
                await connection.send(response)
            except WebSocketDisconnect:
                raise
            except GameError as exc:
                await connection.send({
                    "type": "error",
                    "requestId": message.get("requestId") if isinstance(message, dict) else None,
                    "error": {"code": exc.code, "message": exc.message},
                })
            except (ValueError, TypeError) as exc:
                await connection.send({
                    "type": "error",
                    "requestId": message.get("requestId") if isinstance(message, dict) else None,
                    "error": {"code": "INVALID_MESSAGE", "message": str(exc)},
                })
            except Exception:
                await connection.send({
                    "type": "error",
                    "requestId": message.get("requestId") if isinstance(message, dict) else None,
                    "error": {"code": "INTERNAL_ERROR", "message": "服务器处理消息失败"},
                })
    except WebSocketDisconnect:
        pass
    finally:
        app.state.hub.unregister(connection)
        # 只有最后一个连接断开才算真的离开：同一账号开两个标签页时，
        # 关掉其中一个不该把他的约战全部撤掉。
        if not app.state.hub.is_online(user.id):
            await app.state.lobby.drop_user(user.id)
            # 观战席位不算「在看棋」，断线即收回；对手的横幅则从这一刻开始计时。
            await app.state.spectate.drop_user(user.id)
            # 这里**不能**直接 await：socket 关掉之后 Starlette 会取消这个任务，
            # 任何带 checkpoint 的 await（比如往别人的连接写一帧）都可能被就地掐断，
            # 表现就是「对手明明掉线了，我这边却什么都没收到」。交出去自己跑。
            asyncio.create_task(app.state.games.player_presence(user.id, False))
        await app.state.lobby.broadcast()
