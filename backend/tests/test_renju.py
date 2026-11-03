"""禁手规则（RenjuRules）与规则变体贯穿的测试。"""

from __future__ import annotations

import pytest

from app.rules import (
    BLACK,
    EMPTY,
    WHITE,
    RenjuRules,
    RuleMove,
    RuleViolation,
    board_from_moves,
    normalize_variant,
    rules_for,
)


def _board(cells: dict[tuple[int, int], int]):
    rules = RenjuRules()
    board = rules.empty_board()
    for (row, col), color in cells.items():
        board[row][col] = color
    return rules, board


class TestForbiddenDetection:
    def test_double_three_forbidden(self):
        rules, board = _board({
            (7, 5): BLACK, (7, 6): BLACK,      # 横向活二
            (5, 7): BLACK, (6, 7): BLACK,      # 纵向活二
            (9, 9): WHITE, (10, 10): WHITE, (3, 3): WHITE, (11, 11): WHITE, (8, 8): WHITE,
        })
        assert rules.is_forbidden(board, 7, 7) is True

    def test_double_four_forbidden(self):
        rules, board = _board({
            (7, 4): BLACK, (7, 5): BLACK, (7, 6): BLACK,   # 横向三
            (4, 7): BLACK, (5, 7): BLACK, (6, 7): BLACK,   # 纵向三
            (9, 9): WHITE, (10, 10): WHITE, (3, 3): WHITE, (11, 11): WHITE,
        })
        # 落 (7,7) 横竖同时成四 → 四四禁手
        assert rules.is_forbidden(board, 7, 7) is True

    def test_exactly_five_is_winning_not_forbidden(self):
        rules, board = _board({
            (7, 4): BLACK, (7, 5): BLACK, (7, 6): BLACK, (7, 8): BLACK,
            (9, 9): WHITE, (10, 10): WHITE, (3, 3): WHITE, (11, 11): WHITE,
        })
        # 落 (7,7) 恰好五连：即使带着别的形状也合法。
        assert rules.is_forbidden(board, 7, 7) is False

    def test_overline_forbidden_for_black(self):
        rules, board = _board({
            (7, 3): BLACK, (7, 4): BLACK, (7, 5): BLACK, (7, 6): BLACK, (7, 8): BLACK,
            (9, 9): WHITE, (10, 10): WHITE, (3, 3): WHITE, (11, 11): WHITE,
        })
        assert rules.is_forbidden(board, 7, 7) is True

    def test_four_three_is_legal(self):
        rules, board = _board({
            (7, 4): BLACK, (7, 5): BLACK, (7, 6): BLACK,   # 横向三（成四）
            (5, 8): BLACK, (6, 8): BLACK,                   # 纵向二（成三）
            (9, 9): WHITE, (10, 10): WHITE, (3, 3): WHITE, (11, 11): WHITE,
        })
        # 4-3 是连珠最常见的取胜形状，绝不能误判为禁手。
        assert rules.is_forbidden(board, 7, 8) is False

    def test_normal_move_not_forbidden(self):
        rules, board = _board({(7, 7): BLACK, (7, 8): WHITE})
        assert rules.is_forbidden(board, 6, 6) is False


class TestWinConditions:
    def test_black_overline_is_not_win(self):
        rules, board = _board({
            (7, c): BLACK for c in range(3, 9)   # 六连
        } | {(9, 9): WHITE, (10, 10): WHITE})
        assert rules.has_five(board, 7, 5, BLACK) is False

    def test_black_exact_five_wins(self):
        rules, board = _board({
            (7, c): BLACK for c in range(3, 8)   # 恰好五连
        } | {(9, 9): WHITE, (10, 10): WHITE})
        assert rules.has_five(board, 7, 5, BLACK) is True

    def test_white_overline_wins(self):
        rules, board = _board({
            (7, c): WHITE for c in range(3, 9)
        } | {(9, 9): BLACK, (10, 10): BLACK})
        assert rules.has_five(board, 7, 5, WHITE) is True


class TestVariantWiring:
    def test_normalize_variant(self):
        assert normalize_variant(None) == "freestyle"
        assert normalize_variant("freestyle") == "freestyle"
        assert normalize_variant("renju") == "renju"
        assert normalize_variant("FORBIDDEN") == "renju"

    def test_rules_for(self):
        assert type(rules_for("freestyle")).__name__ == "FreestyleRules"
        assert type(rules_for("renju")).__name__ == "RenjuRules"

    def test_renju_replay_rejects_forbidden_history(self):
        # 三三局面里黑棋落禁手点 → 重建棋盘时直接拒绝。
        history = [
            RuleMove(row=7, col=5, color=BLACK), RuleMove(row=9, col=9, color=WHITE),
            RuleMove(row=7, col=6, color=BLACK), RuleMove(row=10, col=10, color=WHITE),
            RuleMove(row=5, col=7, color=BLACK), RuleMove(row=3, col=3, color=WHITE),
            RuleMove(row=6, col=7, color=BLACK), RuleMove(row=11, col=11, color=WHITE),
        ]
        forbidden = RuleMove(row=7, col=7, color=BLACK)  # 双活三点
        with pytest.raises(RuleViolation):
            board_from_moves([*history, forbidden], "renju")
        # 无禁手规则下同一串着法合法。
        board, _ = board_from_moves([*history, forbidden], "freestyle")
        assert board[7][7] == BLACK
