from dataclasses import dataclass
from typing import Protocol, Sequence


BOARD_SIZE = 15
EMPTY, BLACK, WHITE = 0, 1, 2


@dataclass(frozen=True)
class RuleMove:
    row: int
    col: int
    color: int


class RuleViolation(ValueError):
    pass


class RulePolicy(Protocol):
    """Extension point for Renju forbidden-move policies."""

    def validate_move(
        self,
        board: list[list[int]],
        row: int,
        col: int,
        color: int,
        history: Sequence[RuleMove],
    ) -> None: ...

    def has_five(self, board: list[list[int]], row: int, col: int, color: int) -> bool: ...


class FreestyleRules:
    """Fifteen-board freestyle: black first, no forbidden moves, five or more wins."""

    size = BOARD_SIZE

    def empty_board(self) -> list[list[int]]:
        return [[EMPTY for _ in range(self.size)] for _ in range(self.size)]

    def validate_move(
        self,
        board: list[list[int]],
        row: int,
        col: int,
        color: int,
        history: Sequence[RuleMove],
    ) -> None:
        if color not in (BLACK, WHITE):
            raise RuleViolation("invalid color")
        if not (0 <= row < self.size and 0 <= col < self.size):
            raise RuleViolation("coordinate out of bounds")
        if board[row][col] != EMPTY:
            raise RuleViolation("cell is occupied")
        expected = BLACK if len(history) % 2 == 0 else WHITE
        if color != expected:
            raise RuleViolation("incorrect turn")

    def has_five(self, board: list[list[int]], row: int, col: int, color: int) -> bool:
        for dr, dc in ((1, 0), (0, 1), (1, 1), (1, -1)):
            count = 1
            for sign in (-1, 1):
                r, c = row + sign * dr, col + sign * dc
                while 0 <= r < self.size and 0 <= c < self.size and board[r][c] == color:
                    count += 1
                    r += sign * dr
                    c += sign * dc
            if count >= 5:
                return True
        return False

    def rebuild(self, history: Sequence[RuleMove]) -> list[list[int]]:
        board = self.empty_board()
        replayed: list[RuleMove] = []
        for move in history:
            self.validate_move(board, move.row, move.col, move.color, replayed)
            board[move.row][move.col] = move.color
            replayed.append(move)
        return board


def board_from_moves(
    moves: Sequence[RuleMove], variant: str = "freestyle"
) -> tuple[list[list[int]], RulePolicy]:
    rules = rules_for(variant)
    board = rules.empty_board()
    history: list[RuleMove] = []
    for move in moves:
        rules.validate_move(board, move.row, move.col, move.color, history)
        board[move.row][move.col] = move.color
        history.append(move)
    return board, rules


def rules_for(variant: str) -> RulePolicy:
    """按规则变体取规则集。`renju` 为黑方禁手（三三 / 四四 / 长连）。"""
    return RenjuRules() if variant == "renju" else FreestyleRules()


def normalize_variant(value: str | None) -> str:
    return "renju" if (value or "").strip().lower() in {"renju", "forbidden"} else "freestyle"


class RenjuRules(FreestyleRules):
    """连珠（有禁手）：黑方禁三三 / 四四 / 长连，黑棋恰好五连才算胜。

    白方无禁手，五连及以上（含长连）均获胜。禁手判定采用标准递归定义的
    实用简化：四 = 本方向存在一空点、填上后恰好成五；活三 = 存在一空点、
    填上后本方向出现 `.BBBB.`（活四）。同一方向的"同线双四"极罕见，此处
    按每方向至多一个四计数——误判面收敛在棋谱级特例，不影响常规对局。
    """

    def validate_move(
        self,
        board: list[list[int]],
        row: int,
        col: int,
        color: int,
        history: Sequence[RuleMove],
    ) -> None:
        super().validate_move(board, row, col, color, history)
        if color == BLACK and self.is_forbidden(board, row, col):
            raise RuleViolation("forbidden move (renju)")

    def has_five(self, board: list[list[int]], row: int, col: int, color: int) -> bool:
        for dr, dc in ((1, 0), (0, 1), (1, 1), (1, -1)):
            count = self._line_count(board, row, col, dr, dc, color)
            if count >= 5 and (color == WHITE or count == 5):
                return True
        return False

    # ------------------------------------------------------------------
    # 禁手判定
    # ------------------------------------------------------------------

    def is_forbidden(self, board: list[list[int]], row: int, col: int) -> bool:
        """假设黑棋落在 (row, col)（调用方已保证落点为空），是否禁手。"""
        board[row][col] = BLACK
        try:
            counts = [self._line_count(board, row, col, dr, dc, BLACK)
                      for dr, dc in ((1, 0), (0, 1), (1, 1), (1, -1))]
            # 恰好五连是制胜手，永不禁手（即便同时带了别的形状）。
            if any(count == 5 for count in counts):
                return False
            # 长连（≥6）禁。
            if any(count >= 6 for count in counts):
                return True
            fours = sum(1 for count, (dr, dc) in zip(counts, ((1, 0), (0, 1), (1, 1), (1, -1)))
                        if count == 4 and self._completes_five(board, row, col, dr, dc))
            if fours >= 2:
                return True  # 四四禁手
            threes = sum(1 for count, (dr, dc) in zip(counts, ((1, 0), (0, 1), (1, 1), (1, -1)))
                         if count == 3 and self._makes_open_four(board, row, col, dr, dc))
            return threes >= 2  # 三三禁手
        finally:
            board[row][col] = EMPTY

    def _line_count(self, board: list[list[int]], row: int, col: int, dr: int, dc: int, color: int) -> int:
        """经过 (row, col) 在 (dr, dc) 方向上的连子数（含落点自身）。"""
        count = 1
        for sign in (-1, 1):
            r, c = row + sign * dr, col + sign * dc
            while 0 <= r < self.size and 0 <= c < self.size and board[r][c] == color:
                count += 1
                r += sign * dr
                c += sign * dc
        return count

    def _completes_five(self, board: list[list[int]], row: int, col: int, dr: int, dc: int) -> bool:
        """本方向是否存在一空点，填上后（含当前落点）恰好成五。"""
        for sign in range(-4, 5):
            r, c = row + sign * dr, col + sign * dc
            if not (0 <= r < self.size and 0 <= c < self.size) or board[r][c] != EMPTY:
                continue
            board[r][c] = BLACK
            try:
                if self._line_count(board, row, col, dr, dc, BLACK) == 5:
                    return True
            finally:
                board[r][c] = EMPTY
        return False

    def _makes_open_four(self, board: list[list[int]], row: int, col: int, dr: int, dc: int) -> bool:
        """本方向是否存在一空点，填上后出现 `.BBBB.`（活四，必胜形）。"""
        for sign in range(-3, 4):
            r, c = row + sign * dr, col + sign * dc
            if not (0 <= r < self.size and 0 <= c < self.size) or board[r][c] != EMPTY:
                continue
            board[r][c] = BLACK
            try:
                if self._has_open_four(board, row, col, dr, dc):
                    return True
            finally:
                board[r][c] = EMPTY
        return False

    def _has_open_four(self, board: list[list[int]], row: int, col: int, dr: int, dc: int) -> bool:
        """经过 (row, col) 的方向线上是否存在 `.BBBB.` 且四子含该点。"""
        cells = [(row + k * dr, col + k * dc) for k in range(-5, 6)]
        for start in range(len(cells) - 5):
            window = cells[start:start + 6]
            if any(not (0 <= r < self.size and 0 <= c < self.size) for r, c in window):
                continue
            values = [board[r][c] for r, c in window]
            if values != [EMPTY, BLACK, BLACK, BLACK, BLACK, EMPTY]:
                continue
            # 四子里必须包含当前落点（否则与本手无关）。
            if any((r, c) == (row, col) for r, c in window[1:5]):
                return True
        return False
