from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Index, Integer, JSON, String, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(24), nullable=False)
    username_key: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    password_hash: Mapped[str | None] = mapped_column(String(512), nullable=True)
    guest: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # 积分钱包：每局结束 +POINTS_PER_GAME，商城购买扣减。服务端权威。
    points: Mapped[int] = mapped_column(Integer, default=10000, nullable=False)
    # 已解锁的商城商品 id 列表（JSON 数组文本）。
    unlocked: Mapped[str] = mapped_column(String(512), default="[]", nullable=False)
    # 装备的棋子皮肤（JSON：{"materialBlack": id, "materialWhite": id}）。
    equipped: Mapped[str] = mapped_column(String(256), default="{}", nullable=False)
    # 全部显示设置的持久化副本（JSON，前端 settings 的服务端权威）。
    preferences: Mapped[str] = mapped_column(String(4096), default="{}", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AuthSession(Base):
    __tablename__ = "auth_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    user: Mapped[User] = relationship(lazy="joined")


class Game(Base):
    __tablename__ = "games"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    mode: Mapped[str] = mapped_column(String(8), nullable=False)
    # 棋境：局面所在的三维场景。字符串刻意与前端 `game/scenes.ts` 的 ScenePresetId
    # 保持同一套字面量（tea / courtyard / cyber），省掉一层映射表。
    # server_default 是给「建库早于本字段」的老库做迁移时用的默认值。
    # 规则变体：freestyle（无禁手）/ renju（黑方禁手）。开局选定后整局不变。
    rule: Mapped[str] = mapped_column(String(8), default="freestyle", nullable=False)
    # AI 局的执子权标志（对局中可切换）：True = 该方由客户端引擎代算。
    # 两个都 True 是观赏模式（AI 自弈），都 False 是编辑模式（玩家自由落子）。
    ai_black: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    ai_white: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # 棋谱保留：默认 30 天后清理，勾选「永久储存」后豁免。
    keep_forever: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    scene: Mapped[str] = mapped_column(
        String(12), default="tea", server_default="tea", nullable=False
    )
    status: Mapped[str] = mapped_column(String(12), default="playing", nullable=False)
    black_player_id: Mapped[str] = mapped_column(String(32), nullable=False)
    white_player_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    room_code: Mapped[str | None] = mapped_column(String(6), unique=True, nullable=True, index=True)
    winner: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    win_reason: Mapped[str | None] = mapped_column(String(8), nullable=True)
    generation: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    ai_thinking: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # 残局起点：本局前 `start_ply` 手是从棋谱载入的既定局面，不是玩家下的。
    # 重开时清回这里而不是清空棋盘（「再练一次同一个残局」才有意义），
    # 悔棋也不能越过它，否则一路退回去就退成了空盘。0 表示正常开局。
    start_ply: Mapped[int] = mapped_column(
        Integer, default=0, server_default="0", nullable=False
    )
    undo_from: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # 重开请求：联机（PVP）重开需对方同意，发起方 id 暂存于此，对方回应后清空。
    restart_from: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # 统计口径：重开时归档的旧局（game.restart 复制出的 finished 副本）不计入胜率。
    # 正常结束的局为 False；本列靠迁移补默认 0，老行也归零以保证口径一致。
    excluded_from_stats: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # 开局「决定先后手」的协商状态：两位棋手各自选择希望谁先手，
    # 一致则直接开局、不一致则抛硬币。未揭晓前落子闸门不开。
    # 结构见 GameService._begin_opening_in_session；揭晓后清空为 None。
    opening: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # 读秒（每步限时）：'none' 不限时（默认）/ 'perMove' 每步固定预算。
    # 只在联机 PVP 对局生效——人机局的 AI 在浏览器里算，拿秒数判负不公平。
    time_mode: Mapped[str] = mapped_column(
        String(8), default="none", server_default="none", nullable=False
    )
    # 每步预算毫秒（只允许 game.ALLOWED_PER_MOVE_MS 里的档位）。
    per_move_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # 当前回合的起点（wall clock，epoch 秒）。用浮点而不是 monotonic：
    # 进程重启后必须能从库里重算剩余时间，monotonic 重启即归零。
    # 未启表 / 已终局 / 先后手未揭晓时为 NULL。
    turn_started_at: Mapped[float | None] = mapped_column(Float, nullable=True)
    # 正在计时的一方：'black' | 'white'。只为可读性与排查，真值由手数奇偶推导。
    turn_side: Mapped[str | None] = mapped_column(String(8), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    moves: Mapped[list["GameMove"]] = relationship(
        back_populates="game", cascade="all, delete-orphan", order_by="GameMove.move_index"
    )


class GameMove(Base):
    __tablename__ = "game_moves"
    __table_args__ = (
        UniqueConstraint("game_id", "move_index", name="uq_game_move_index"),
        Index("ix_game_moves_game", "game_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    game_id: Mapped[str] = mapped_column(ForeignKey("games.id", ondelete="CASCADE"), nullable=False)
    move_index: Mapped[int] = mapped_column(Integer, nullable=False)
    row: Mapped[int] = mapped_column(Integer, nullable=False)
    col: Mapped[int] = mapped_column(Integer, nullable=False)
    color: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    game: Mapped[Game] = relationship(back_populates="moves")
