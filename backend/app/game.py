import json
import asyncio
import secrets
import time
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from .config import Settings
from .database import Database
from .models import Game, GameMove, User, utcnow
from .rules import BLACK, BOARD_SIZE, EMPTY, WHITE, RuleMove, RuleViolation, board_from_moves, normalize_variant
from .scenes import normalize_scene, random_scene


AI_ID = "yixin"

# 每局结束发放的积分（与前端展示口径一致，服务端为唯一权威）。
POINTS_PER_GAME = 10

# 每局结束发放的积分（与前端展示口径一致，服务端为唯一权威）。
POINTS_PER_GAME = 10
ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

# 开局「决定先后手」协商的超时（秒）：双方各自独立选择希望谁先手，若一方迟迟不选，
# 用现有选择（缺失一方随机补一个）兜底揭晓，避免棋局永久卡在「先后手未定」无法落子。
OPENING_TIMEOUT_SECONDS = 120

# ---- 读秒（每步限时）------------------------------------------------------
# 只有联机 PVP 用得上：人机局的 AI 跑在浏览器里，耗时受用户设备与 10MB 权重加载
# 影响，用秒数判负不公平；本地同屏没有第二个网络端，也没有意义。
TIME_MODE_NONE = "none"
TIME_MODE_PER_MOVE = "perMove"
# 允许的档位。白名单而不是范围校验：宽严随意的数字会让「30/60/120」这套产品
# 语言失效，也让将来做排位赛时没法按档位统计。
ALLOWED_PER_MOVE_MS = (30_000, 60_000, 120_000)


class GameError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class GameService:
    def __init__(self, db: Database, settings: Settings):
        self.db = db
        self.settings = settings
        self.hub = None
        self.lobby = None
        self.spectate = None
        self._locks: dict[str, asyncio.Lock] = {}
        self._offline_since: dict[tuple[str, str], float] = {}
        # 按铃冷却：以对局为单位，双方共用同一条冷却，免得两个人对着按。
        self._ring_at: dict[str, float] = {}
        # 待回应的 AI 分析请求：game_id -> (请求方 id, 发起时刻)。
        # 与按铃一样不落库；超时后下一次请求会自然覆盖。
        self._ai_requests: dict[str, tuple[str, float]] = {}
        self._presence_tasks: dict[asyncio.AbstractEventLoop, asyncio.Task] = {}
        # 读秒：每局最多一个「睡到截止时刻」的任务。不用轮询——一个 5 秒一轮的
        # 循环去比对 deadline，既判不准最后一秒，也随对局数线性上涨。
        self._clock_tasks: dict[str, asyncio.Task] = {}
        # 因对手断线而暂停的表：game_id -> 暂停那一刻（wall clock）。
        # 只存内存：进程重启后按「表在走」处理，与 presence 宽限重启后的处理一致。
        self._clock_pause: dict[str, float] = {}

    # ------------------------------------------------------------------
    # 读秒：时基与状态
    # ------------------------------------------------------------------

    @staticmethod
    def parse_time_control(raw) -> tuple[str, int | None]:
        """把客户端送来的 ``timeControl`` 规整成 ``(mode, per_move_ms)``。

        缺省（None / 非字典）一律当「不限时」——老客户端不带这个字段，
        不能因此报错。给了就必须合法：只认白名单里的三档。
        """
        if raw is None:
            return TIME_MODE_NONE, None
        if not isinstance(raw, dict):
            raise GameError("VALIDATION_ERROR", "timeControl 必须是对象")
        mode = raw.get("mode", TIME_MODE_NONE)
        if mode in (None, TIME_MODE_NONE):
            return TIME_MODE_NONE, None
        if mode != TIME_MODE_PER_MOVE:
            raise GameError("VALIDATION_ERROR", "timeControl.mode 只支持 none / perMove")
        try:
            per_move_ms = int(raw.get("perMoveMs"))
        except (TypeError, ValueError) as exc:
            raise GameError("VALIDATION_ERROR", "timeControl.perMoveMs 必须是整数毫秒") from exc
        if per_move_ms not in ALLOWED_PER_MOVE_MS:
            raise GameError("VALIDATION_ERROR", "每步限时只支持 30 / 60 / 120 秒")
        return TIME_MODE_PER_MOVE, per_move_ms

    def time_control_payload(self, game: Game) -> dict:
        """快照里的 ``timeControl``：这一局用的是什么档位。"""
        mode = getattr(game, "time_mode", None) or TIME_MODE_NONE
        per_move = getattr(game, "per_move_ms", None)
        if mode != TIME_MODE_PER_MOVE or not per_move:
            return {"mode": TIME_MODE_NONE, "perMoveMs": None}
        return {"mode": TIME_MODE_PER_MOVE, "perMoveMs": int(per_move)}

    @staticmethod
    def parse_preset(raw, rule: str | None = None) -> list[tuple[int, int]]:
        """把客户端送来的残局前缀（``preset``）校验成 ``[(row, col), ...]``。

        **颜色不由客户端指定**，一律按手数奇偶推导（黑先）：这是棋盘上唯一
        的事实，让客户端自报颜色只会多出一个能与棋谱对不上的输入。

        校验放得很严（坐标、重复、容量、终局），因为它决定的是「这一局从哪儿
        开始」——放过一个坏前缀，换来的是一盘摆得出来却下不下去的棋。
        """
        if raw is None:
            return []
        if not isinstance(raw, list):
            raise GameError("VALIDATION_ERROR", "preset 必须是着法数组")
        capacity = BOARD_SIZE * BOARD_SIZE
        if len(raw) >= capacity:
            # 满盘即终局，没有「接着下」的余地。
            raise GameError("VALIDATION_ERROR", "残局手数过多，棋盘容不下再落子")
        seen: set[tuple[int, int]] = set()
        points: list[tuple[int, int]] = []
        for item in raw:
            if not isinstance(item, dict):
                raise GameError("VALIDATION_ERROR", "preset 的每一项必须是 {row, col}")
            row, col = item.get("row"), item.get("col")
            # bool 是 int 的子类，`True` 会被当成 1，得单独挡掉。
            if isinstance(row, bool) or isinstance(col, bool) or not isinstance(row, int) or not isinstance(col, int):
                raise GameError("VALIDATION_ERROR", "preset 的 row / col 必须是整数")
            if not (0 <= row < BOARD_SIZE and 0 <= col < BOARD_SIZE):
                raise GameError("VALIDATION_ERROR", "preset 的坐标超出棋盘")
            if (row, col) in seen:
                raise GameError("VALIDATION_ERROR", "preset 里有重复落点")
            seen.add((row, col))
            points.append((row, col))

        board, rules = board_from_moves([], rule or "freestyle")
        for index, (row, col) in enumerate(points):
            color = BLACK if index % 2 == 0 else WHITE
            board[row][col] = color
            # 逐手查五连：棋谱里只要有一处连五，这一局早在那里就结束了，
            # 后面多出来的着法不属于这盘棋。
            if rules.has_five(board, row, col, color):
                raise GameError("VALIDATION_ERROR", "残局里已经有五连，无法从中途接手")
        return points

    @staticmethod
    def _turn_side_of(game: Game) -> str:
        """当前该走的一方。手数为偶数轮到黑方，奇数轮到白方（黑先）。"""
        return "black" if len(game.moves) % 2 == 0 else "white"

    @staticmethod
    def _clock_eligible(game: Game) -> bool:
        """这一局此刻该不该跑表。

        四个条件缺一不可：联机、进行中、白座有人、选了每步限时。
        另外 `turn_started_at` 为 NULL 表示「还没起表」——先后手协商期间就是这样，
        此时扣时会冤枉还没分到黑白的人。
        """
        return (
            game.mode == "online"
            and game.status == "playing"
            and bool(game.white_player_id)
            # 先后手没揭晓就扣时会冤枉还没分到黑白的人——闸门没开，表就不能走。
            and game.opening is None
            and (getattr(game, "time_mode", None) or TIME_MODE_NONE) == TIME_MODE_PER_MOVE
            and bool(getattr(game, "per_move_ms", None))
        )

    def _deadline_of(self, game: Game) -> float | None:
        """本回合的截止时刻（epoch 秒）；不该跑表时返回 None。"""
        if not self._clock_eligible(game):
            return None
        started = getattr(game, "turn_started_at", None)
        if started is None:
            return None
        return float(started) + float(game.per_move_ms) / 1000.0

    def _start_turn_clock(self, game: Game) -> None:
        """把表重置成「当前该走的人，拿满一份新预算」。落子 / 悔棋 / 重开后调用。"""
        if not self._clock_eligible(game):
            game.turn_started_at = None
            game.turn_side = None
            return
        game.turn_started_at = time.time()
        game.turn_side = self._turn_side_of(game)

    @staticmethod
    def _stop_turn_clock(game: Game) -> None:
        game.turn_started_at = None
        game.turn_side = None

    def _clock_expired(self, game: Game, now: float | None = None) -> bool:
        """这一刻是否已经超时。暂停中的表永远不算超时。"""
        deadline = self._deadline_of(game)
        if deadline is None or game.id in self._clock_pause:
            return False
        return (now if now is not None else time.time()) >= deadline

    def _finish_timeout(self, session, game: Game) -> None:
        """判超时负。幂等由调用方在锁内二次校验保证。"""
        loser = game.turn_side or self._turn_side_of(game)
        game.status = "finished"
        game.winner = WHITE if loser == "black" else BLACK
        game.win_reason = "timeout"
        game.generation += 1
        game.ai_thinking = False
        game.undo_from = None
        game.restart_from = None
        self._stop_turn_clock(game)
        self._settle(session, game)

    def _cancel_clock(self, game_id: str) -> None:
        task = self._clock_tasks.pop(game_id, None)
        if task is not None and not task.done():
            task.cancel()

    def _schedule_clock(self, game_id: str, deadline: float | None) -> None:
        """按截止时刻排一个定时任务；deadline 为 None 就是撤表。"""
        self._cancel_clock(game_id)
        if deadline is None or game_id in self._clock_pause:
            return
        delay = max(0.05, deadline - time.time())
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # 没有事件循环（例如同步上下文里调用）就不排表，等下次状态变化再补。
            return
        self._clock_tasks[game_id] = loop.create_task(self._clock_sleep(game_id, delay))

    async def _arm_clock_from_db(self, game_id: str) -> None:
        """按库里最新状态重新排表。所有改动棋局的入口在解锁后调它。"""
        with self.db.session() as session:
            game = self._load(session, game_id)
            deadline = self._deadline_of(game)
        self._schedule_clock(game_id, deadline)

    async def _clock_sleep(self, game_id: str, delay: float) -> None:
        try:
            await asyncio.sleep(delay)
        except asyncio.CancelledError:
            return
        await self._declare_timeout(game_id)

    async def _declare_timeout(self, game_id: str) -> None:
        """到点了：在既有的对局锁里二次确认，然后判负。

        二次确认是必需的——定时任务可能在「这一手已经落下」之后才醒过来，
        那它看到的就是一个轮次已经变了（或已经终局）的棋局，此时不能判任何人超时。
        """
        fired = False
        async with self._lock(game_id):
            with self.db.session() as session:
                game = self._load(session, game_id)
                if not self._clock_eligible(game) or game.id in self._clock_pause:
                    self._cancel_clock(game_id)
                    return
                deadline = self._deadline_of(game)
                if deadline is None or time.time() < deadline:
                    self._cancel_clock(game_id)
                    return
                self._finish_timeout(session, game)
                fired = True
        self._cancel_clock(game_id)
        if fired:
            await self.broadcast(game_id)

    async def recover_clocks(self) -> None:
        """启动时把进行中的限时局接回来。

        与规格的一处有意偏离：如果停机期间本回合已经过期，这里**补满一份新预算**，
        而不是立刻判负。停机是服务端的事（部署、崩溃、重启机器），不该由棋手买单；
        真按「过期即判负」做，每次部署都会顺手判掉一批在下的棋。
        """
        with self.db.session() as session:
            games = list(session.scalars(
                select(Game).where(Game.mode == "online", Game.status == "playing")
            ))
            pending: list[tuple[str, float | None]] = []
            now = time.time()
            for game in games:
                if not self._clock_eligible(game):
                    continue
                deadline = self._deadline_of(game)
                if deadline is None or deadline <= now:
                    game.turn_started_at = now
                    game.turn_side = self._turn_side_of(game)
                    deadline = game.turn_started_at + float(game.per_move_ms) / 1000.0
                pending.append((game.id, deadline))
        for game_id, deadline in pending:
            self._schedule_clock(game_id, deadline)

    def _pause_clock(self, game: Game, now: float) -> None:
        """对手断线 → 停表。记下暂停那一刻，重连时按停掉的时长往后平移。"""
        if not self._clock_eligible(game):
            return
        if game.turn_started_at is None or game.id in self._clock_pause:
            return
        self._clock_pause[game.id] = now
        self._cancel_clock(game.id)

    def _resume_clock(self, game: Game, now: float) -> bool:
        """对手回来了 → 从剩余时间继续（把暂停时长补到起点上，而不是从头开始）。"""
        paused_at = self._clock_pause.pop(game.id, None)
        if paused_at is None:
            return False
        if game.turn_started_at is None:
            return False
        game.turn_started_at += max(0.0, now - paused_at)
        return True

    def clock_payload(self, game: Game) -> dict | None:
        """快照里的 ``clock``：谁在走、何时截止、还剩多少。

        剩余时间按「暂停时刻」或「此刻」重算，绝不做累减——进程被阻塞、GC、
        重连、甚至服务端重启都不会累积漂移。
        """
        deadline = self._deadline_of(game)
        if deadline is None:
            return None
        paused_at = self._clock_pause.get(game.id)
        now = paused_at if paused_at is not None else time.time()
        return {
            "side": game.turn_side or self._turn_side_of(game),
            "deadlineAt": int(deadline * 1000),
            "remainingMs": int(max(0.0, deadline - now) * 1000),
            "paused": paused_at is not None,
        }

    def _lock(self, game_id: str) -> asyncio.Lock:
        return self._locks.setdefault(game_id, asyncio.Lock())

    @staticmethod
    def _history(game: Game) -> list[RuleMove]:
        return [RuleMove(m.row, m.col, m.color) for m in sorted(game.moves, key=lambda m: m.move_index)]

    @staticmethod
    def _start_ply(game: Game) -> int:
        """残局起点手数（正常开局为 0）。

        `getattr` 兜老库/老对象：迁移补列之前实例化的行没有这个属性，
        读成 0 就是改动前的行为。
        """
        return int(getattr(game, "start_ply", 0) or 0)

    @staticmethod
    def _color(game: Game, user_id: int) -> int | None:
        player = str(user_id)
        if game.black_player_id == player:
            return BLACK
        if game.white_player_id == player:
            return WHITE
        return None

    @staticmethod
    def _settle(session, game: Game) -> None:
        """一局真正结束时给**人类**参与者发放积分。

        只在状态从 playing 翻转为 finished 的那一刻调用一次（各终局路径内），
        历史归档复制（restart 存档）不再结算，天然幂等。AI 座位不发。

        **口径分工**：人机局照发积分（那是商城积分的唯一来源），但不进战绩
        —— `profile_routes._compute_stats` 里把 `mode == "ai"` 的局整个排除了。
        赢一盘 AI 拿不到胜率，输一盘也不会掉，只有联机局才计入胜负。
        """
        if game.status != "finished":
            return
        for seat in (game.black_player_id, game.white_player_id):
            if not seat or seat == AI_ID:
                continue
            player = session.get(User, int(seat))
            if player is not None:
                player.points = (player.points or 0) + POINTS_PER_GAME

    @staticmethod
    def _ai_flag(game: Game, color: int) -> bool:
        """某颜色当前是否由 AI 执子（对局中可切换）。"""
        return bool(game.ai_black) if color == BLACK else bool(game.ai_white)

    @staticmethod
    def _participants(game: Game) -> list[str]:
        return [p for p in (game.black_player_id, game.white_player_id) if p and p != AI_ID]

    def _load(self, session, game_id: str) -> Game:
        game = session.get(Game, game_id)
        if not game:
            raise GameError("GAME_NOT_FOUND", "棋局不存在")
        _ = game.moves
        return game

    def _player_dict(self, session, player_id: str | None) -> dict | None:
        if player_id is None:
            return None
        if player_id == AI_ID:
            return {"id": AI_ID, "name": "Rapfi"}
        user = session.get(User, int(player_id))
        if not user:
            return {"id": str(player_id), "name": "已离开用户"}
        result = {"id": str(user.id), "name": user.name}
        # 皮肤跟人走：该玩家为「自己执子颜色」选的材质。颜色由调用方补
        # （黑座取 materialBlack，白座取 materialWhite）。
        try:
            equipped = json.loads(user.equipped or "{}")
        except ValueError:
            equipped = {}
        if isinstance(equipped, dict):
            result["skin"] = equipped
        return result

    @staticmethod
    def _with_skin(player: dict | None, key: str) -> dict | None:
        """把玩家装备里对应颜色的材质提到 player.skin（字符串 id）。"""
        if not player:
            return player
        skin = (player.pop("skin", None) or {}).get(key)
        if isinstance(skin, str) and skin:
            player["skin"] = skin
        return player

    def _snapshot(self, session, game: Game, user_id: int, spectating: bool = False) -> dict:
        history = self._history(game)
        board, _ = board_from_moves(history, getattr(game, "rule", None) or "freestyle")
        your_color = None if spectating else self._color(game, user_id)
        current = BLACK if len(history) % 2 == 0 else WHITE
        last = history[-1] if history else None
        can_undo = False
        if game.status == "playing" and your_color and not game.undo_from:
            if game.mode == "ai":
                # 观赏/编辑模式（双方同为 AI 或都非 AI）每次只撤一手，门槛放宽。
                steps = 2 if bool(game.ai_black) != bool(game.ai_white) else 1
                # 残局起点之前的手是「载入的棋谱」，不是本局下的，撤不得。
                can_undo = not game.ai_thinking and len(history) - steps >= self._start_ply(game)
            elif last:
                can_undo = last.color == your_color
        undo_request = None
        # 悔棋是两个人之间的私事，旁观者不该看到那条确认框。
        if game.undo_from and not spectating and game.undo_from != str(user_id):
            undo_request = {"fromName": self._player_dict(session, game.undo_from)["name"]}

        # 重开请求同悔棋：只告诉「被请求方」，发起方看到的是「等待对方同意」状态。
        restart_request = None
        restart_pending = False
        if game.restart_from:
            if game.restart_from != str(user_id):
                if not spectating:
                    restart_request = {"fromName": self._player_dict(session, game.restart_from)["name"]}
            else:
                restart_pending = not spectating

        # 开局协商状态：未揭晓时告诉客户端显示选择面板（含两位座位玩家与各自选择）。
        opening_payload: dict | None = None
        opening = game.opening
        if opening and isinstance(opening, dict) and not opening.get("resolved"):
            a_id, b_id = opening["a_id"], opening["b_id"]
            seats = {
                "a": self._player_dict(session, a_id) or {"id": a_id, "name": a_id},
                "b": self._player_dict(session, b_id) or {"id": b_id, "name": b_id},
            }
            your_seat = (
                "a" if game.black_player_id == str(user_id)
                else "b" if game.white_player_id == str(user_id)
                else None
            )
            opponent_seat = (
                "b" if your_seat == "a" else "a" if your_seat == "b" else None
            )
            your_seat_id = game.black_player_id if your_seat == "a" else game.white_player_id if your_seat == "b" else None
            opponent_seat_id = game.white_player_id if opponent_seat == "b" else game.black_player_id if opponent_seat == "a" else None
            opening_payload = {
                "phase": "choosing",
                "seats": seats,
                "youSeat": your_seat,
                "youChose": opening["choices"].get(your_seat_id) if your_seat_id else None,
                "opponentChose": opening["choices"].get(opponent_seat_id) if opponent_seat_id else None,
            }
        return {
            "id": game.id,
            "mode": game.mode,
            "status": game.status,
            # 旧的自建 sqlite 库里可能存在没有 scene 的行（迁移前建的局），
            # 用 getattr 兜住：宁可默认进茶室，也不要让快照整个 500。
            "scene": normalize_scene(getattr(game, "scene", None)),
            "rule": getattr(game, "rule", None) or "freestyle",
            "aiBlack": bool(getattr(game, "ai_black", False)),
            "aiWhite": bool(getattr(game, "ai_white", False)),
            "board": board,
            "currentPlayer": current,
            "players": {
                "black": self._with_skin(self._player_dict(session, game.black_player_id), "materialBlack"),
                "white": self._with_skin(self._player_dict(session, game.white_player_id), "materialWhite"),
            },
            "yourColor": your_color,
            "spectating": spectating,
            "spectatorCount": self.spectate.count(game.id) if self.spectate else 0,
            # 观战者名单：对局内的人能直接看到谁在看棋。只有 id 与昵称，
            # 不暴露任何其它信息；名单为空时省掉这个字段。
            "spectators": self._spectator_dicts(session, game.id),
            "presence": self._presence(game),
            "roomCode": game.room_code,
            "lastMove": ({"row": last.row, "col": last.col, "color": last.color} if last else None),
            # 全盘着法：客户端靠它给棋子标手数。只有 225 条上限，随快照发不心疼；
            # 少了它，刷新页面之后就只能退化成「不显示」或标错号。
            "moves": [{"row": move.row, "col": move.col, "color": move.color} for move in history],
            "winner": game.winner,
            "winReason": game.win_reason,
            "moveCount": len(history),
            # 残局起点手数：前端据此把「载入的棋谱」和「本局下的棋」分开——
            # 计数从起点算、悔棋停在起点、终局文案也能说清这局是从哪儿接手的。
            "startPly": self._start_ply(game),
            "canUndo": can_undo,
            "aiThinking": bool(game.ai_thinking),
            "undoRequest": undo_request,
            "restartRequest": restart_request,
            "restartPending": restart_pending,
            "opening": opening_payload,
            # 读秒：timeControl 是「本局的规则」，clock 是「此刻的表」。
            # 后者不要每秒重推快照——前端拿 deadlineAt 自己倒计时。
            "timeControl": self.time_control_payload(game),
            "clock": self.clock_payload(game),
        }

    def _spectator_dicts(self, session, game_id: str) -> list[dict]:
        """旁观者名单（id + 昵称）。服务没装配或没人看时返回空列表。"""
        if not self.spectate:
            return []
        watcher_ids = self.spectate.watchers(game_id)
        if not watcher_ids:
            return []
        users = list(session.scalars(select(User).where(User.id.in_(watcher_ids))))
        return [{"id": str(user.id), "name": user.name} for user in users]

    def _presence(self, game: Game) -> dict | None:
        """两位棋手各自还剩多久的重连宽限（毫秒），0 表示在线。客户端靠它画那条「对方已断线，
        01:32 后判负」的横幅；也靠它在刷新页面后重新对上同一条倒计时。
        """
        if game.mode != "online" or game.status != "playing" or not game.white_player_id:
            return None
        if not self.hub:
            return None
        grace = self.settings.reconnect_grace_seconds
        now = time.monotonic()
        result: dict[str, int] = {}
        for color, player_id in (("black", game.black_player_id), ("white", game.white_player_id)):
            if not player_id or not player_id.isdigit() or self.hub.is_online(int(player_id)):
                result[color] = 0
                continue
            since = self._offline_since.get((game.id, player_id))
            # 还没记过起点（例如后端刚重启）时先按完整宽限报，下一次心跳会校正。
            remaining = grace if since is None else max(0.0, grace - (now - since))
            result[color] = int(remaining * 1000)
        return result

    def snapshot(self, game_id: str, user_id: int) -> dict:
        with self.db.session() as session:
            game = self._load(session, game_id)
            if str(user_id) not in self._participants(game):
                raise GameError("FORBIDDEN", "你不是该棋局玩家")
            return self._snapshot(session, game, user_id)

    def spectator_snapshot(self, game_id: str, user_id: int) -> dict:
        """旁观者视角：棋盘与棋手一样，但没有颜色、没有可执行的操作。"""
        with self.db.session() as session:
            game = self._load(session, game_id)
            if str(user_id) in self._participants(game):
                raise GameError("ALREADY_PLAYER", "你就在这盘棋里")
            return self._snapshot(session, game, user_id, spectating=True)

    def snapshots_for_user(self, user_id: int) -> list[dict]:
        with self.db.session() as session:
            games = list(session.scalars(
                select(Game).where(
                    (Game.black_player_id == str(user_id)) | (Game.white_player_id == str(user_id))
                ).order_by(Game.updated_at.desc()).limit(50)
            ).unique())
            return [self._snapshot(session, game, user_id) for game in games]

    async def create_ai(
        self,
        user: User,
        color: str,
        scene: str | None = None,
        rule: str | None = None,
        preset: list[dict] | None = None,
    ) -> dict:
        if color not in {"black", "white"}:
            raise GameError("VALIDATION_ERROR", "color 必须为 black 或 white")
        variant = normalize_variant(rule)
        # 残局前缀（复盘「一键续弈」用）：先在这里校验干净再落库，别建出
        # 一盘摆得出来却下不下去的棋。
        openings = self.parse_preset(preset, variant)
        game_id = str(uuid.uuid4())
        human = str(user.id)
        # 人类选的是「座位」（执黑还是执白），但谁先手仍由开局协商决定。
        # 人类执黑 → 黑座是人类、白座是 AI；人类执白则相反。
        black, white = (human, AI_ID) if color == "black" else (AI_ID, human)
        game = Game(
            id=game_id,
            mode="ai",
            status="playing",
            scene=normalize_scene(scene),
            rule=variant,
            black_player_id=black,
            white_player_id=white,
            ai_black=black == AI_ID,
            ai_white=white == AI_ID,
            generation=0,
            # 残局起点：重开回到这里，悔棋也退不过这一线。
            start_ply=len(openings),
        )
        with self.db.session() as session:
            session.add(game)
            for index, (row, col) in enumerate(openings):
                game.moves.append(
                    GameMove(
                        move_index=index,
                        row=row,
                        col=col,
                        color=BLACK if index % 2 == 0 else WHITE,
                    )
                )
            # 轮到谁由**手数奇偶**决定，不看「谁执黑」：从残局的中盘接手时，
            # 先手早就走过了。轮到 AI 就置位等待标记，实际着法由客户端引擎
            # 算完通过 `game.ai_move` 提交（与空盘开局同一条路径）。
            ai_to_move = self._ai_flag(game, BLACK if len(openings) % 2 == 0 else WHITE)
        await self._lobby_changed()
        if ai_to_move:
            async with self._lock(game_id):
                with self.db.session() as session:
                    game = self._load(session, game_id)
                    game.ai_thinking = True
                    game.generation += 1
        return self.snapshot(game_id, user.id)

    # ------------------------------------------------------------------
    # 开局「决定先后手」协商
    # ------------------------------------------------------------------
    # 流程：两位棋手各自独立选择「希望谁先手」——可以选自己，也可以选对方。
    # - 两人选择指向同一位玩家：该玩家先手，直接开局，不抛硬币。
    # - 两人选择指向不同玩家（含都选自己、都选对方）：抛硬币随机决定。
    # 多局对战每局结束交换先后手，下一局仍走上述流程（restart 会重新进入协商）。
    # 结果以「座位」表达：a = 开局时黑座玩家，b = 白座玩家；先手者最终落为黑方。

    def _begin_opening_in_session(self, session, game: Game, ai_seat: str | None = None) -> None:
        """在数据库会话内初始化一局的开局协商状态。"""
        a_id = game.black_player_id
        b_id = game.white_player_id
        choices: dict[str, str | None] = {a_id: None, b_id: None}
        if ai_seat is not None:
            # AI 自动选一边，让人类来决定最终的先后手。
            choices[ai_seat] = "self" if secrets.randbelow(2) else "opponent"
        game.opening = {
            "a_id": a_id,
            "b_id": b_id,
            "choices": choices,
            "resolved": False,
            "first_seat": None,
            "method": None,
            "opened_at": time.time(),
        }

    async def submit_first_move_choice(self, user: User, game_id: str, preference: str) -> dict:
        """棋手提交「希望谁先手」的选择：'self' 或 'opponent'。"""
        if preference not in {"self", "opponent"}:
            raise GameError("VALIDATION_ERROR", "preference 必须为 self 或 opponent")
        resolved: dict | None = None
        async with self._lock(game_id):
            with self.db.session() as session:
                game = self._load(session, game_id)
                if not self._color(game, user.id):
                    raise GameError("FORBIDDEN", "你不是该棋局玩家")
                if game.opening is None or game.opening.get("resolved"):
                    raise GameError("OPENING_CLOSED", "先后手已经决定，无需再选")
                # 落子的「座位」键是用户 id（与 opening 里 a_id / b_id 一致），不是字母 a / b。
                seat = game.black_player_id if game.black_player_id == str(user.id) else game.white_player_id
                opening = dict(game.opening)
                opening["choices"] = {**opening["choices"], seat: preference}
                game.opening = opening
                resolved = self._maybe_resolve_in_session(session, game)
        if resolved:
            await self._after_opening_resolved(game_id, resolved)
            await self._arm_clock_from_db(game_id)
            await self.broadcast(game_id)
        return {"accepted": True}

    def _maybe_resolve_in_session(self, session, game: Game) -> dict | None:
        """若双方都已表态，则揭晓并交换黑白座位；否则返回 None。"""
        opening = game.opening
        if not opening or opening.get("resolved"):
            return None
        a_id, b_id = opening["a_id"], opening["b_id"]
        choices = opening["choices"]
        present = [s for s in (a_id, b_id) if choices.get(s)]
        if len(present) < 2:
            return None
        return self._resolve_opening_in_session(session, game)

    def _resolve_opening_in_session(self, session, game: Game) -> dict:
        """裁定先后手：一致则直接定，不一致则抛硬币；交换黑白座位使先手者为黑。"""
        opening = game.opening
        a_id, b_id = opening["a_id"], opening["b_id"]
        ca, cb = opening["choices"].get(a_id), opening["choices"].get(b_id)

        def desired(seat_id: str, choice: str | None) -> str | None:
            if choice == "self":
                return seat_id
            if choice == "opponent":
                return b_id if seat_id == a_id else a_id
            return None

        da, db = desired(a_id, ca), desired(b_id, cb)
        if da and db and da == db:
            first_seat, method = da, "agreement"
        else:
            first_seat, method = secrets.choice([a_id, b_id]), "coin"

        if first_seat == a_id:
            game.black_player_id, game.white_player_id = a_id, b_id
        else:
            game.black_player_id, game.white_player_id = b_id, a_id
        # 揭晓即清掉协商状态：落子闸门随之打开，结果改由事件下发、快照颜色反映。
        game.opening = None
        # 闸门一开，读秒就起表——顺序不能反：协商期间扣时会冤枉还没分到黑白的人。
        self._start_turn_clock(game)

        seats = {
            "a": self._player_dict(session, a_id) or {"id": a_id, "name": a_id},
            "b": self._player_dict(session, b_id) or {"id": b_id, "name": b_id},
        }
        return {
            "game_id": game.id,
            "first_seat": "a" if first_seat == a_id else "b",
            "method": method,
            "seats": seats,
        }

    async def _after_opening_resolved(self, game_id: str, result: dict | None) -> None:
        """揭晓后：通知双方与观战者播放硬币动画；若 AI 执先手则开局即轮到它。"""
        if not result:
            return
        if self.hub:
            message = {
                "type": "game.opening_result",
                "payload": {
                    "gameId": result["game_id"],
                    "firstSeat": result["first_seat"],
                    "method": result["method"],
                    "seats": result["seats"],
                },
            }
            await self.hub.send_to_game(game_id, message)
        # AI 执先手时，协商揭晓即轮到 AI 落子（客户端引擎负责计算并提交）。
        async with self._lock(game_id):
            with self.db.session() as session:
                game = self._load(session, game_id)
                if game.mode == "ai" and game.black_player_id == AI_ID:
                    game.ai_thinking = True
                    game.generation += 1

    async def create_room(
        self,
        user: User,
        scene: str | None = None,
        rule: str | None = None,
        time_control: dict | None = None,
    ) -> dict:
        # 读秒是「建局时定下、整局不变」的规则，和棋境/规则同一层级。
        time_mode, per_move_ms = self.parse_time_control(time_control)
        with self.db.session() as session:
            code = None
            for _ in range(20):
                candidate = "".join(secrets.choice(ROOM_ALPHABET) for _ in range(6))
                if not session.scalar(select(Game.id).where(Game.room_code == candidate)):
                    code = candidate
                    break
            if not code:
                raise GameError("ROOM_CREATE_FAILED", "暂时无法分配房间码")
            game = Game(
                id=str(uuid.uuid4()), mode="online", status="waiting",
                black_player_id=str(user.id), white_player_id=None, room_code=code,
                # 房主没选就随机——「随机棋境」本来就是产品的一部分。
                scene=normalize_scene(scene) if scene else random_scene(),
                rule=normalize_variant(rule),
                time_mode=time_mode,
                per_move_ms=per_move_ms,
            )
            session.add(game)
            session.flush()
            snapshot = self._snapshot(session, game, user.id)
        await self._lobby_changed()
        return snapshot

    async def create_challenge(
        self,
        first_id: int,
        second_id: int,
        scene: str | None = None,
        rule: str | None = None,
        time_control: dict | None = None,
    ) -> str:
        """Create an online game between two players matched in the lobby.

        黑白座位的归属先按约战双方暂时落定（邀请方坐黑座、接受方坐白座），
        但谁真正先手由「开局决定先后手」流程裁定——两位棋手各自选择希望谁先手，
        一致则直接开局，不一致则抛硬币。所以这里**不**随机抽黑白。

        The scene is drawn at random too when neither side named one — a
        challenge is over in seconds, asking players to pick a backdrop would
        cost more than it is worth.
        """
        black, white = str(first_id), str(second_id)
        game_id = str(uuid.uuid4())
        time_mode, per_move_ms = self.parse_time_control(time_control)
        with self.db.session() as session:
            game = Game(
                id=game_id, mode="online", status="playing",
                black_player_id=black, white_player_id=white,
                scene=normalize_scene(scene) if scene else random_scene(),
                rule=normalize_variant(rule),
                time_mode=time_mode,
                per_move_ms=per_move_ms,
            )
            session.add(game)
            # 进入开局协商：双方到位即可各自选择希望谁先手。
            self._begin_opening_in_session(session, game)
        return game_id

    async def join_room(self, user: User, code: str) -> dict:
        normalized = code.strip().upper()
        async with self._lock(f"room:{normalized}"):
            with self.db.session() as session:
                game = session.scalar(select(Game).where(Game.room_code == normalized))
                if not game:
                    raise GameError("ROOM_NOT_FOUND", "房间不存在")
                if str(user.id) in self._participants(game):
                    return self._snapshot(session, game, user.id)
                if game.status != "waiting" or game.white_player_id:
                    raise GameError("ROOM_FULL", "房间已满或已开始")
                game.white_player_id = str(user.id)
                game.status = "playing"
                game_id = game.id
                # 两人到齐，进入「决定先后手」的开局协商。
                self._begin_opening_in_session(session, game)
        await self.broadcast(game_id)
        return self.snapshot(game_id, user.id)

    async def resume_room(self, user: User, code: str) -> dict:
        with self.db.session() as session:
            game = session.scalar(select(Game).where(Game.room_code == code.strip().upper()))
            if not game or str(user.id) not in self._participants(game):
                raise GameError("ROOM_NOT_FOUND", "没有可恢复的该房间棋局")
            return self._snapshot(session, game, user.id)

    async def move(self, user: User, game_id: str, row: int, col: int) -> None:
        timed_out = False
        async with self._lock(game_id):
            with self.db.session() as session:
                game = self._load(session, game_id)
                color = self._color(game, user.id)
                if not color:
                    raise GameError("FORBIDDEN", "你不是该棋局玩家")
                # 先后手还没定：落子闸门不开，先去把开局决定好。
                if game.opening is not None:
                    raise GameError("OPENING_PENDING", "先后手尚未决定，还不能落子")
                if game.status != "playing":
                    raise GameError("GAME_NOT_PLAYING", "棋局当前不可落子")
                # 「最后一刻落子」与「超时裁决」必然打一架。这里在同一把锁里先判表：
                # 过了截止时刻就当场判负并拒收这一手，不会出现既判超时又落了子。
                if self._clock_expired(game):
                    self._finish_timeout(session, game)
                    timed_out = True
                else:
                    await self._apply_move(session, game, color, row, col)
        # 表要在会话提交之后再排：定时任务读的是库里的状态。
        await self._arm_clock_from_db(game_id)
        if timed_out:
            await self.broadcast(game_id)
            raise GameError("CLOCK_EXPIRED", "本回合已超时")
        await self.broadcast(game_id)

    async def _apply_move(self, session, game: Game, color: int, row: int, col: int) -> None:
        """落子本体（不含读秒判定）。调用方已持有对局锁并校验过轮次之外的前置条件。"""
        if game.ai_thinking:
            raise GameError("AI_THINKING", "AI 正在思考")
        history = self._history(game)
        current = BLACK if len(history) % 2 == 0 else WHITE
        if game.mode == "ai":
            # 人机局：落子权跟「当前轮次方」走，不跟座位走——编辑模式
            # （双方都不是 AI）下玩家可以替任意一方落子。
            if self._ai_flag(game, current):
                raise GameError("NOT_YOUR_TURN", "当前这一手由 AI 执子")
            color = current
        elif color != current:
            raise GameError("NOT_YOUR_TURN", "尚未轮到你")
        board, rules = board_from_moves(history, getattr(game, "rule", None) or "freestyle")
        try:
            rules.validate_move(board, row, col, color, history)
        except RuleViolation as exc:
            raise GameError("INVALID_MOVE", str(exc)) from exc
        move = GameMove(game_id=game.id, move_index=len(history), row=row, col=col, color=color)
        session.add(move)
        game.moves.append(move)
        board[row][col] = color
        game.undo_from = None
        if rules.has_five(board, row, col, color):
            game.status, game.winner, game.win_reason = "finished", color, "five"
            game.ai_thinking = False
            game.generation += 1
            self._stop_turn_clock(game)
            self._settle(session, game)
        elif len(history) + 1 == 15 * 15:
            game.status, game.winner, game.win_reason = "finished", 0, "draw"
            game.ai_thinking = False
            game.generation += 1
            self._stop_turn_clock(game)
            self._settle(session, game)
        elif game.mode == "ai":
            # 下一手是否由 AI 执子，看该方的执子权标志（可被 ai_config 切换）。
            next_color = BLACK if (len(history) + 1) % 2 == 0 else WHITE
            game.ai_thinking = self._ai_flag(game, next_color)
            game.generation += 1
        else:
            # 己方停、对方起，各拿一份完整的新预算。
            self._start_turn_clock(game)

    async def submit_ai_move(self, user: User, game_id: str, row: int, col: int) -> None:
        """接收客户端引擎代算的 AI 着法。

        信任模型的取舍：人机局的 AI 本来就跑在玩家自己的浏览器里，
        服务端无法也不必验证它用的是哪个引擎；但**合法性、轮次、终局判定**
        仍然全部在服务端重新校验——伪造就不了非法棋。
        """
        async with self._lock(game_id):
            with self.db.session() as session:
                game = self._load(session, game_id)
                if game.mode != "ai" or not self._color(game, user.id):
                    raise GameError("FORBIDDEN", "你不是该棋局玩家")
                if game.status != "playing" or not game.ai_thinking:
                    raise GameError("NOT_AI_TURN", "当前不在等待 AI 落子")
                history = self._history(game)
                # 待提交的着法永远属于「当前轮次方」——执子权标志决定哪一方
                # 由 AI 代算，而 ai_thinking 已经保证了当前轮次方正是 AI 方。
                ai_color = BLACK if len(history) % 2 == 0 else WHITE
                board, rules = board_from_moves(history, getattr(game, "rule", None) or "freestyle")
                try:
                    rules.validate_move(board, row, col, ai_color, history)
                except RuleViolation as exc:
                    raise GameError("INVALID_MOVE", str(exc)) from exc
                move = GameMove(
                    game_id=game.id, move_index=len(history), row=row, col=col, color=ai_color,
                )
                session.add(move)
                game.moves.append(move)
                board[row][col] = ai_color
                if rules.has_five(board, row, col, ai_color):
                    game.status, game.winner, game.win_reason = "finished", ai_color, "five"
                    self._settle(session, game)
                    # 终局即「不再等待 AI」：必须把执子权标志翻掉，否则广播给前端的
                    # 快照会带着 aiThinking=True 的「finished」——前端引擎据此以为还要
                    # 替 AI 落子，晚到的那一步被服务端以 NOT_AI_TURN 拒收并弹红字报错。
                    game.ai_thinking = False
                    game.generation += 1
                elif len(history) + 1 == 15 * 15:
                    game.status, game.winner, game.win_reason = "finished", 0, "draw"
                    self._settle(session, game)
                    game.ai_thinking = False
                    game.generation += 1
                else:
                    next_color = BLACK if (len(history) + 1) % 2 == 0 else WHITE
                    game.ai_thinking = self._ai_flag(game, next_color)
                    game.generation += 1
        await self.broadcast(game_id)

    async def ai_config(self, user: User, game_id: str, ai_black: bool, ai_white: bool) -> dict:
        """切换人机局的执子权（对局中可随时改）。

        - 单选：常规人机（AI 执其中一边）。
        - 双选：观赏模式，AI 黑白轮番自弈。
        - 全不选：编辑模式，AI 不参与，玩家自由落任意一方的棋。
        """
        async with self._lock(game_id):
            with self.db.session() as session:
                game = self._load(session, game_id)
                if game.mode != "ai" or not self._color(game, user.id):
                    raise GameError("FORBIDDEN", "你不是该棋局玩家")
                if game.status != "playing":
                    raise GameError("GAME_NOT_PLAYING", "棋局已结束或尚未开始")
                game.ai_black = ai_black
                game.ai_white = ai_white
                history = self._history(game)
                current = BLACK if len(history) % 2 == 0 else WHITE
                game.ai_thinking = self._ai_flag(game, current)
                game.generation += 1
                snapshot = self._snapshot(session, game, user.id)
        await self.broadcast(game_id)
        return snapshot

    async def undo(self, user: User, game_id: str) -> None:
        notify_undo = False
        async with self._lock(game_id):
            with self.db.session() as session:
                game = self._load(session, game_id)
                color = self._color(game, user.id)
                if not color or game.status != "playing":
                    raise GameError("UNDO_NOT_ALLOWED", "当前不可悔棋")
                history = self._history(game)
                if game.mode == "ai":
                    current = BLACK if len(history) % 2 == 0 else WHITE
                    if game.ai_thinking or len(history) < 1:
                        raise GameError("UNDO_NOT_ALLOWED", "需等待落子完成后才能悔棋")
                    # 常规人机（AI 执一边）撤「人+AI」两手；观赏/编辑模式每次撤一手。
                    steps = 2 if bool(game.ai_black) != bool(game.ai_white) else 1
                    # 退到残局起点为止：再往回就退到别人下过的棋谱里了。
                    if len(history) - steps < self._start_ply(game):
                        raise GameError("UNDO_NOT_ALLOWED", "已经退到残局起点，不能再悔")
                    for move in list(game.moves)[-steps:]:
                        session.delete(move)
                    game.generation += 1
                else:
                    if game.undo_from:
                        raise GameError("UNDO_NOT_ALLOWED", "已有待确认的悔棋请求")
                    if not history or history[-1].color != color:
                        raise GameError("UNDO_NOT_ALLOWED", "只能请求撤回自己的最后一手")
                    game.undo_from = str(user.id)
                    notify_undo = True
        if notify_undo:
            await self.broadcast(game_id)
            if self.hub:
                await self.hub.send_undo_requested(game_id, user.id)
            return
        await self.broadcast(game_id)

    async def undo_response(self, user: User, game_id: str, accept: bool) -> None:
        async with self._lock(game_id):
            with self.db.session() as session:
                game = self._load(session, game_id)
                color = self._color(game, user.id)
                if not color or not game.undo_from or game.undo_from == str(user.id):
                    raise GameError("NO_UNDO_REQUEST", "没有可确认的对方悔棋请求")
                if game.status != "playing":
                    raise GameError("UNDO_NOT_ALLOWED", "终局不可悔棋")
                if accept:
                    moves = sorted(game.moves, key=lambda item: item.move_index)
                    if len(moves) <= self._start_ply(game):
                        raise GameError("NO_UNDO_REQUEST", "没有可撤回落子")
                    last = moves[-1]
                    session.delete(last)
                    # 同步把内存里的着法列表也撤掉：读秒要靠手数奇偶判断轮到谁，
                    # 只删库不删列表会让「该谁走」算错一位，表就起在错的人身上。
                    if last in game.moves:
                        game.moves.remove(last)
                    game.generation += 1
                    # 悔棋不退还之前消耗的时间：重置成「现在该走的那个人，拿满一份」。
                    self._start_turn_clock(game)
                game.undo_from = None
        await self._arm_clock_from_db(game_id)
        await self.broadcast(game_id)

    @staticmethod
    def _archive(session, game: Game) -> None:
        """把「这一盘」另存成一局已结束的棋，原局稍后会被清空重用。

        为什么不是「重开时新建一个 Game 行」：联机房间的 `room_code` 有唯一约束，
        新行拿不到同一个房间号，客户端手里的 gameId 也会失效。反过来，
        **原地重开**又必须先把旧棋保住——`game.moves.clear()` 一执行，
        上一盘的棋谱就没了，复盘里只会剩最后一盘（用户实测到的问题）。

        所以折中是：旧棋复制成一条独立的历史记录（房间号置空，避开唯一约束），
        原行继续承载下一盘。棋谱的主键是 `game.id`，这也不影响复盘接口。
        """
        archive = Game(
            id=str(uuid.uuid4()),
            mode=game.mode,
            scene=game.scene,
            status="finished",
            black_player_id=game.black_player_id,
            white_player_id=game.white_player_id,
            room_code=None,
            winner=game.winner,
            win_reason=game.win_reason,
            generation=0,
            ai_thinking=False,
            # 残局起点跟着棋谱一起留档：复盘时才说得清「前 N 手是载入的」，
            # 而不是把别人下过的棋算成这一盘的战绩。
            start_ply=GameService._start_ply(game),
            undo_from=None,
            # 重开归档的旧局不参与胜率统计：玩家点「重开」即表示放弃这一局的胜负归属。
            excluded_from_stats=True,
            # 读秒参数也一并留档，复盘时才说得清「这局是 60 秒一步还是不限时」。
            time_mode=getattr(game, "time_mode", None) or TIME_MODE_NONE,
            per_move_ms=getattr(game, "per_move_ms", None),
            # 时间也一并搬过去：复盘里的「用时」是按这一盘的起止算的，
            # 若延用房间的创建时间，第二盘会把第一盘的时长也算进去。
            created_at=game.created_at,
            updated_at=game.updated_at,
        )
        session.add(archive)
        for move in sorted(game.moves, key=lambda item: item.move_index):
            archive.moves.append(
                GameMove(
                    move_index=move.move_index,
                    row=move.row,
                    col=move.col,
                    color=move.color,
                    created_at=move.created_at,
                )
            )

    @staticmethod
    def _is_pvp(game: Game) -> bool:
        """联机且白座坐着一个真实人类（非 AI、非空）：即玩家对玩家，重开需对方同意。"""
        white = game.white_player_id
        return game.mode == "online" and bool(white) and white != AI_ID

    def _do_restart(self, session, game: Game) -> None:
        """真正清空并重置一盘（归档旧局 + 清盘 + 轮换座位）。

        重开请求被同意、或单机/人机无需对方同意时都会走到这里；幂等于调用方。
        重开归档的旧局会被 `_archive` 标记 excluded_from_stats，不计入胜率。
        """
        # 只有下完的棋才值得归档：中途重开一盘没下几步的棋，留档反而是噪音。
        if game.status == "finished" and game.moves:
            GameService._archive(session, game)
            # 归档之后这一刻就是新一盘的起点，时长重新计。
            game.created_at = utcnow()
        # 清回**残局起点**而不是空盘：从棋谱载入的练习局，重开的语义是
        # 「再来一次同一个残局」，清成空盘等于把练习的题目也擦了。
        start_ply = self._start_ply(game)
        game.moves = [move for move in game.moves if move.move_index < start_ply]
        game.winner = 0
        game.win_reason = None
        game.undo_from = None
        game.restart_from = None
        game.generation += 1
        game.ai_thinking = False
        game.status = "waiting" if game.mode == "online" and not game.white_player_id else "playing"
        # 联机再来一局：黑白座位直接轮换（第一局已协商过先后手），
        # 不再重新协商——用户要求「先后手轮换，无需再选」。
        # AI 单人局沿用人类所选颜色，黑先。
        if game.status == "playing" and game.mode == "online":
            game.black_player_id, game.white_player_id = game.white_player_id, game.black_player_id
        # 新一盘的起点，读秒重新给满：上一盘剩得再少也不带过来。
        self._start_turn_clock(game)

    async def restart(self, user: User, game_id: str) -> None:
        """重开本局。

        - 单机/人机（无对方需协商）：立即重置，行为同前。
        - 联机 PVP：重开需要对方同意。这里只发起「请求」，把发起人记在
          `restart_from` 并广播；真正的清盘发生在对方 `restart_response(accept=True)`。
        - 已是自己发起的待确认请求：再点一次视为取消（toggle）。
        """
        notify = False
        rearm_ai = False
        async with self._lock(game_id):
            with self.db.session() as session:
                game = self._load(session, game_id)
                color = self._color(game, user.id)
                if not color:
                    raise GameError("FORBIDDEN", "你不是该棋局玩家")
                if game.restart_from == str(user.id):
                    # 自己已发起过，再点一次取消。
                    game.restart_from = None
                elif self._is_pvp(game):
                    game.restart_from = str(user.id)
                    notify = True
                else:
                    self._do_restart(session, game)
                    rearm_ai = game.mode == "ai"
        if notify:
            await self.broadcast(game_id)
            if self.hub:
                await self.hub.send_restart_requested(game_id, user.id)
            return
        # 新一盘的第一手轮到谁：残局重开时由起点手数的奇偶决定，从空盘开始才
        # 是黑先。若该方由 AI 执子则置位等待标志，着法由客户端引擎提交。
        if rearm_ai:
            async with self._lock(game_id):
                with self.db.session() as session:
                    game = self._load(session, game_id)
                    first = BLACK if self._start_ply(game) % 2 == 0 else WHITE
                    game.ai_thinking = self._ai_flag(game, first)
                    game.generation += 1
        await self._arm_clock_from_db(game_id)
        await self.broadcast(game_id)

    async def restart_response(self, user: User, game_id: str, accept: bool) -> None:
        """PVP 重开请求的回应：同意则清盘重置，婉拒则撤销请求。"""
        async with self._lock(game_id):
            with self.db.session() as session:
                game = self._load(session, game_id)
                color = self._color(game, user.id)
                if not color or not game.restart_from or game.restart_from == str(user.id):
                    raise GameError("NO_RESTART_REQUEST", "没有可确认的重开请求")
                if accept:
                    self._do_restart(session, game)
                else:
                    game.restart_from = None
        await self._arm_clock_from_db(game_id)
        await self.broadcast(game_id)

    async def ring(self, user, game_id: str) -> dict:
        """按铃催促。

        桌面上那口铜铃唯一的用处：提醒对方「该你了」。它不改变任何棋局状态，
        所以不需要加锁，也不需要落库——一次响铃就是一个转瞬即逝的事件。
        冷却按对局算而不是按人算；`ring_cooldown_seconds` 设为 0 时不做限制，
        连按 / 连点器都会逐次转发给对手。
        """
        with self.db.session() as session:
            game = self._load(session, game_id)
            color = self._color(game, user.id)
            if not color:
                raise GameError("FORBIDDEN", "你不是该棋局玩家")
            if game.mode != "online" or game.status != "playing":
                raise GameError("RING_NOT_ALLOWED", "只有在进行的联机对局里才需要按铃")
            opponent = next((p for p in self._participants(game) if p != str(user.id)), None)
            if opponent is None:
                raise GameError("RING_NOT_ALLOWED", "对面还没有人坐下")
            name = user.name

        now = time.monotonic()
        cooldown = float(self.settings.ring_cooldown_seconds)
        last = self._ring_at.get(game_id, 0.0)
        if now - last < cooldown:
            # 不抛错：按铃本来就是性急的动作，回一句「太急了」只会更吵。
            return {"accepted": False, "cooldownMs": int((cooldown - (now - last)) * 1000)}
        self._ring_at[game_id] = now

        message = {
            "type": "game.ring",
            "payload": {"gameId": game_id, "fromName": name, "color": color},
        }
        if self.hub:
            await self.hub.send_to_user(int(opponent), message)
            await self.hub.send_to_spectators(game_id, message)
        return {"accepted": True, "cooldownMs": int(cooldown * 1000)}

    # 快捷短语的「合法词表」：服务端只转发已知 id 对应的规范文案，
    # 根本不接受客户端任意文本，从源头杜绝 chat 注入与 XSS。
    PHRASE_TEXT: dict[str, str] = {
        "lead": "局势对我很有利！",
        "persist": "坚持下去，胜利就是我的了。",
        "hurry": "如果再不尽快采取行动，你就要失败了！",
        "cai": "菜",
        "rou": "肉",
        "jue": "撅",
        "shale": "傻了吧",
    }

    async def phrase(self, user, game_id: str, phrase_id: str) -> dict:
        """对局内快捷短语。

        与按铃一样不改变棋局状态，只是把一句话转给对手与观战者。
        关键安全点：``phrase_id`` 必须是上面的已知词表之一，否则直接拒绝；
        下发的是服务端保存的规范文案，绝不采用客户端传来的任何字符串，
        因此即便有人伪造报文也只能播放预设的几句话，无法注入脚本或任意文本。
        """
        if phrase_id not in self.PHRASE_TEXT:
            raise GameError("VALIDATION_ERROR", "不支持的短语")
        with self.db.session() as session:
            game = self._load(session, game_id)
            color = self._color(game, user.id)
            if not color:
                raise GameError("FORBIDDEN", "你不是该棋局玩家")
            if game.mode != "online" or game.status != "playing":
                raise GameError("PHRASE_NOT_ALLOWED", "只有在进行的联机对局里才能发送短语")
            opponent = next((p for p in self._participants(game) if p != str(user.id)), None)
            if opponent is None:
                raise GameError("PHRASE_NOT_ALLOWED", "对面还没有人坐下")
            name = user.name

        message = {
            "type": "game.phrase",
            "payload": {
                "gameId": game_id,
                "senderId": str(user.id),
                "senderName": name,
                "color": color,
                "phraseId": phrase_id,
                "text": self.PHRASE_TEXT[phrase_id],
                "timestamp": time.time(),
            },
        }
        if self.hub:
            if opponent.isdigit():
                await self.hub.send_to_user(int(opponent), message)
            await self.hub.send_to_spectators(game_id, message)
        return {"accepted": True}

    # AI 分析请求的有效期（秒）：超时后对方还没回应就视为已失效，
    # 新请求可以直接覆盖，不必让人对着一个永远等不到的弹窗。
    AI_REQUEST_TTL_SECONDS = 60.0

    async def ai_analysis_request(self, user, game_id: str) -> dict:
        """发起「请 AI 分析当前局面」的联机请求，等对方同意后才由请求方前端引擎计算。

        与按铃、短语一样不改变棋局状态，也不落库：请求只活在内存里，
        超时或对局结束就自然消失。同一盘棋同时只允许一个在途请求，
        重复点击会收到「已有请求等待回应」的错误。
        """
        with self.db.session() as session:
            game = self._load(session, game_id)
            color = self._color(game, user.id)
            if not color:
                raise GameError("FORBIDDEN", "你不是该棋局玩家")
            if game.mode != "online" or game.status != "playing":
                raise GameError("ANALYSIS_NOT_ALLOWED", "只有在进行的好友对局里才能请求 AI 分析")
            opponent = next((p for p in self._participants(game) if p != str(user.id)), None)
            if opponent is None:
                raise GameError("ANALYSIS_NOT_ALLOWED", "对面还没有人坐下")

        pending = self._ai_requests.get(game_id)
        if pending and time.monotonic() - pending[1] < self.AI_REQUEST_TTL_SECONDS:
            raise GameError("ANALYSIS_PENDING", "已有一个分析请求等待回应，稍候再试")
        self._ai_requests[game_id] = (str(user.id), time.monotonic())

        if self.hub and opponent and opponent.isdigit():
            await self.hub.send_to_user(int(opponent), {
                "type": "game.ai_analysis_requested",
                "payload": {"gameId": game_id, "fromName": user.name},
            })
        return {"accepted": True}

    async def ai_analysis_response(self, user, game_id: str, accept: bool) -> dict:
        """被请求方表态：同意后广播结果，由请求方的浏览器端 Rapfi 引擎计算建议点。

        分析不改变任何棋盘状态，因此与落子互不干扰；最坏情况只是建议过时。
        """
        # 先验参与者身份再动请求表：路人的乱回应不该把在途请求吃掉。
        with self.db.session() as session:
            game = self._load(session, game_id)
            if str(user.id) not in self._participants(game):
                raise GameError("FORBIDDEN", "你不是该棋局玩家")
            if game.status != "playing":
                raise GameError("GAME_NOT_PLAYING", "棋局已经结束，无需分析")
            if game.mode != "online":
                raise GameError("ANALYSIS_NOT_ALLOWED", "只有在好友对局里才能请求 AI 分析")
            history = self._history(game)
            current = BLACK if len(history) % 2 == 0 else WHITE

        requester_id, requested_at = self._ai_requests.pop(game_id, ("", 0.0))
        # 只有被请求的对手有权回应；请求者自己（或无关路人）的回应一律拒绝。
        if requester_id == str(user.id) or not requester_id:
            raise GameError("ANALYSIS_NOT_FOUND", "没有等待你回应的分析请求")
        if time.monotonic() - requested_at >= self.AI_REQUEST_TTL_SECONDS:
            raise GameError("ANALYSIS_EXPIRED", "分析请求已超时失效")

        with self.db.session() as session:
            game = self._load(session, game_id)
            requester = self._player_dict(session, requester_id)

        payload: dict = {
            "gameId": game_id,
            "accepted": accept,
            "byName": requester["name"] if requester else "对手",
        }
        # 推荐点不再由服务端计算（引擎已迁到客户端）：同意后请求方在自己的
        # 浏览器里用前端引擎算，`row/col` 为空即「需本地计算」的约定。

        message = {"type": "game.ai_analysis_result", "payload": payload}
        if self.hub:
            # 结果要同时给双方与观战者：建议一手本身就是公开信息，
            # 观战者看到弹窗提示却看不到落点会很困惑。
            for participant_id in {requester_id, str(user.id)}:
                if participant_id.isdigit():
                    await self.hub.send_to_user(int(participant_id), message)
            await self.hub.send_to_spectators(game_id, message)
        return payload

    async def ai_analysis_submit(self, user, game_id: str, row: int, col: int) -> dict:
        """请求方本地算出建议点后回传，由服务端转播给对手与观战者。

        引擎已迁到客户端：同意分析后落点由请求方浏览器本地算，但结果必须让
        对局双方（含观战者）都看到同一个绿色推荐环，因此请求方算完要把落点
        发回来，服务端再广播。不改变棋局状态、不落库。
        """
        if not (isinstance(row, int) and isinstance(col, int)
                and 0 <= row < BOARD_SIZE and 0 <= col < BOARD_SIZE):
            raise GameError("VALIDATION_ERROR", "落点坐标超出棋盘范围")
        with self.db.session() as session:
            game = self._load(session, game_id)
            if str(user.id) not in self._participants(game):
                raise GameError("FORBIDDEN", "你不是该棋局玩家")
            if game.mode != "online" or game.status != "playing":
                raise GameError("ANALYSIS_NOT_ALLOWED", "对局已无法进行 AI 分析")
            participants = list(self._participants(game))

        payload = {
            "gameId": game_id,
            "accepted": True,
            "row": row,
            "col": col,
            "byName": user.name,
        }
        message = {"type": "game.ai_analysis_result", "payload": payload}
        if self.hub:
            for participant_id in participants:
                if participant_id.isdigit():
                    await self.hub.send_to_user(int(participant_id), message)
            await self.hub.send_to_spectators(game_id, message)
        return payload

    async def resign(self, user: User, game_id: str) -> None:
        async with self._lock(game_id):
            with self.db.session() as session:
                game = self._load(session, game_id)
                color = self._color(game, user.id)
                if not color:
                    raise GameError("FORBIDDEN", "你不是该棋局玩家")
                if game.status != "playing":
                    raise GameError("GAME_NOT_PLAYING", "棋局已结束或尚未开始")
                game.status = "finished"
                game.winner = WHITE if color == BLACK else BLACK
                game.win_reason = "resign"
                game.generation += 1
                game.ai_thinking = False
                game.undo_from = None
                # 认输不是超时：停表，别让定时任务稍后再判一次。
                self._stop_turn_clock(game)
                self._settle(session, game)
        await self._arm_clock_from_db(game_id)
        await self.broadcast(game_id)

    async def leave(self, user: User, game_id: str) -> None:
        async with self._lock(game_id):
            with self.db.session() as session:
                game = self._load(session, game_id)
                color = self._color(game, user.id)
                if not color:
                    raise GameError("FORBIDDEN", "你不是该棋局玩家")
                if game.status == "playing":
                    game.status = "finished"
                    game.winner = WHITE if color == BLACK else BLACK
                    game.win_reason = "resign"
                    game.generation += 1
                    self._settle(session, game)
                elif game.status == "waiting" and color == WHITE:
                    game.white_player_id = None
                elif game.status == "waiting":
                    game.status = "finished"
                    game.room_code = None
                game.ai_thinking = False
                game.undo_from = None
                game.restart_from = None
                self._stop_turn_clock(game)
        await self._arm_clock_from_db(game_id)
        await self.broadcast(game_id)

    async def broadcast(self, game_id: str) -> None:
        if self.hub:
            await self.hub.broadcast_game(game_id)
        if self.lobby:
            await self.lobby.game_changed(game_id)

    async def _lobby_changed(self) -> None:
        """Refresh the lobby roster for state changes that never broadcast a snapshot.

        Creating a room or an AI game seats a player but pushes nothing to anyone,
        so the lobby would keep showing them as free until their next move.
        """
        if self.lobby:
            await self.lobby.broadcast()

    async def recover_ai_games(self) -> None:
        with self.db.session() as session:
            games = list(session.scalars(select(Game).where(Game.mode == "ai", Game.status == "playing")))
            for game in games:
                current = BLACK if len(game.moves) % 2 == 0 else WHITE
                # 轮到 AI 方（按执子权标志）才等待；编辑模式下谁都不等。
                game.ai_thinking = self._ai_flag(game, current)

    def start_retention_monitor(self) -> None:
        """棋谱保留期清理循环：每 6 小时清一次超过 30 天且未永久保存的棋谱。"""
        loop = asyncio.get_running_loop()
        if getattr(self, "_retention_task", None) is None or self._retention_task.done():
            self._retention_task = asyncio.create_task(self._retention_loop())

    async def _retention_loop(self) -> None:
        while True:
            try:
                await asyncio.to_thread(self._purge_expired_replays)
            except Exception:
                pass  # 清理失败不致命，下一轮再试
            await asyncio.sleep(6 * 3600)

    def _purge_expired_replays(self) -> int:
        """删除超过保留期（30 天）且未被永久保存的已结束棋局。"""
        cutoff = datetime.now(timezone.utc) - timedelta(days=30)
        with self.db.session() as session:
            expired = session.scalars(
                select(Game.id).where(
                    Game.status == "finished",
                    Game.keep_forever.is_(False),
                    Game.updated_at < cutoff,
                )
            ).all()
            if not expired:
                return 0
            for game_id in expired:
                game = session.get(Game, game_id)
                if game is not None:
                    session.delete(game)  # moves 级联删除（FK ondelete=CASCADE）
            return len(expired)

    async def player_presence(self, user_id: int, online: bool) -> None:
        """把某人的上线 / 断线告诉对面的人，以及正在看这盘棋的人。

        这条消息的重点不是「状态变了」，而是**倒计时从哪一刻开始**：断线两分钟
        判负，客户端要能把这两分钟画出来，而判负本身仍由心跳循环裁定。
        提示与裁决共用 ``_offline_since`` 这一个起点，两边才不会各说各话。
        """
        if not self.hub:
            return
        if not online and self.hub.is_online(user_id):
            # 掉线通知刚排上队，人已经重连回来了：这条提示已经过时。
            return
        now = time.monotonic()
        # 读秒要的是 wall clock：它的起点存在库里（turn_started_at），
        # 而 monotonic 的零点每次开机都重置，两者不能混用。
        wall = time.time()
        grace_ms = int(self.settings.reconnect_grace_seconds * 1000)
        events: list[tuple[int, dict]] = []
        games_changed: list[str] = []
        with self.db.session() as session:
            games = list(session.scalars(
                select(Game).where(
                    Game.mode == "online",
                    Game.status == "playing",
                    (Game.black_player_id == str(user_id)) | (Game.white_player_id == str(user_id)),
                )
            ))
            if not games:
                return
            user = session.get(User, user_id)
            name = user.name if user else "对手"
            for game in games:
                opponent = next((p for p in self._participants(game) if p != str(user_id)), None)
                if opponent is None or not opponent.isdigit():
                    continue
                key = (game.id, str(user_id))
                if online:
                    self._offline_since.pop(key, None)
                    # 人回来了：把暂停的读秒从剩余时间接着走（不是从头开始）。
                    self._resume_clock(game, wall)
                else:
                    if not self.hub.is_online(int(opponent)):
                        # 对面也不在，这条提示没人看；计时留到他回来时再重新开始，
                        # 否则「两个人都掉线十分钟」会变成一回来就判负。
                        self._offline_since.pop(key, None)
                        continue
                    self._offline_since[key] = now
                    # 对手断线必须停表：否则断线判负和超时判负会同时裁决，
                    # 同一局会收到两个互相矛盾的终局快照。
                    self._pause_clock(game, wall)
                games_changed.append(game.id)
                events.append((int(opponent), {
                    "type": "game.presence",
                    "payload": {
                        "gameId": game.id,
                        "userId": str(user_id),
                        "name": name,
                        "color": "black" if game.black_player_id == str(user_id) else "white",
                        "online": online,
                        "reconnectInMs": 0 if online else grace_ms,
                    },
                }))
        for opponent_id, message in events:
            await self.hub.send_to_user(opponent_id, message)
        # 快照里也带着 presence：事件负责「现在发生了什么」，
        # 快照负责「现在是什么状态」，两者都发一遍，断线重连时才不会各说各话。
        for game_id in games_changed:
            await self._arm_clock_from_db(game_id)
            await self.hub.broadcast_game(game_id)

    def start_presence_monitor(self) -> None:
        # One monitor per event loop. This keeps tests that host several
        # TestClient lifespans on the same app from sharing a cross-loop task.
        loop = asyncio.get_running_loop()
        existing = self._presence_tasks.get(loop)
        if existing is None or existing.done():
            self._presence_tasks[loop] = asyncio.create_task(self._presence_loop())

    async def _presence_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(5)
                try:
                    await self._check_disconnects()
                    await self._resolve_stale_openings()
                    await self._release_idle_ai_sessions()
                except Exception:
                    # A transient database or socket error must not kill the loop.
                    pass
        except asyncio.CancelledError:
            return

    async def _resolve_stale_openings(self) -> None:
        """超时兜底：一方迟迟不选先后手时，用现有选择（缺失方随机补）揭晓，避免卡死。"""
        if not self.hub:
            return
        now = time.time()
        stale: list[str] = []
        with self.db.session() as session:
            games = list(session.scalars(
                select(Game).where(Game.mode.in_(("online", "ai")), Game.status == "playing")
            ))
            for game in games:
                opening = game.opening
                if not opening or opening.get("resolved"):
                    continue
                if now - opening.get("opened_at", 0) < OPENING_TIMEOUT_SECONDS:
                    continue
                stale.append(game.id)
        for game_id in stale:
            resolved: dict | None = None
            async with self._lock(game_id):
                with self.db.session() as session:
                    game = self._load(session, game_id)
                    if game.opening and not game.opening.get("resolved"):
                        opening = dict(game.opening)
                        for seat in (opening["a_id"], opening["b_id"]):
                            if not opening["choices"].get(seat):
                                opening["choices"] = {
                                    **opening["choices"],
                                    seat: "self" if secrets.randbelow(2) else "opponent",
                                }
                        game.opening = opening
                        resolved = self._resolve_opening_in_session(session, game)
            if resolved:
                await self._after_opening_resolved(game_id, resolved)
                await self._arm_clock_from_db(game_id)
                await self.broadcast(game_id)

    async def _check_disconnects(self) -> None:
        """Forfeit an absent online player once the grace period expires.

        Only applies when the opponent is still connected; a room where both
        players left is kept for a later resume instead of awarding a random win.
        """
        if not self.hub:
            return
        now = time.monotonic()
        expired: list[str] = []
        with self.db.session() as session:
            games = list(session.scalars(
                select(Game).where(Game.mode == "online", Game.status == "playing")
            ))
            for game in games:
                participants = self._participants(game)
                online = {p for p in participants if self.hub.is_online(int(p))}
                for player in participants:
                    key = (game.id, player)
                    if player in online:
                        self._offline_since.pop(key, None)
                        continue
                    opponent = next((p for p in participants if p != player), None)
                    if opponent is None or opponent not in online:
                        continue
                    since = self._offline_since.setdefault(key, now)
                    if now - since < self.settings.reconnect_grace_seconds:
                        continue
                    game.status = "finished"
                    game.winner = WHITE if game.black_player_id == player else BLACK
                    # 断线判负和主动认输是两回事：结算卡上要写清原因。
                    game.win_reason = "offline"
                    self._settle(session, game)
                    game.undo_from = None
                    game.generation += 1
                    game.ai_thinking = False
                    # 已经由断线判负收场，读秒必须彻底退出这盘棋。
                    self._stop_turn_clock(game)
                    self._clock_pause.pop(game.id, None)
                    expired.append(game.id)
                    for existing in [k for k in self._offline_since if k[0] == game.id]:
                        self._offline_since.pop(existing, None)
                    break
        for game_id in expired:
            self._cancel_clock(game_id)
            await self.broadcast(game_id)

    _retention_task: asyncio.Task | None = None

    async def shutdown(self) -> None:
        # 读秒任务不取消的话，关停时会有一批「到点判负」的回调打在已经释放的库上。
        for game_id in list(self._clock_tasks):
            self._cancel_clock(game_id)
        self._clock_pause.clear()
        task = self._presence_tasks.pop(asyncio.get_running_loop(), None)
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
