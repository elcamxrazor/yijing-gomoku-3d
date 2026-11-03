import pytest

from app.rules import BLACK, WHITE, FreestyleRules, RuleMove, RuleViolation, board_from_moves


def test_black_first_bounds_occupancy_and_turns():
    rules = FreestyleRules()
    board = rules.empty_board()
    with pytest.raises(RuleViolation):
        rules.validate_move(board, 0, 0, WHITE, [])
    with pytest.raises(RuleViolation):
        rules.validate_move(board, -1, 0, BLACK, [])
    history = [RuleMove(7, 7, BLACK)]
    board[7][7] = BLACK
    with pytest.raises(RuleViolation):
        rules.validate_move(board, 7, 7, WHITE, history)
    with pytest.raises(RuleViolation):
        rules.validate_move(board, 7, 8, BLACK, history)


@pytest.mark.parametrize(
    "moves,last",
    [
        ([(7, c, BLACK) for c in range(5)], (7, 4)),
        ([(r, 7, BLACK) for r in range(5)], (4, 7)),
        ([(r, r, BLACK) for r in range(5)], (4, 4)),
        ([(r, 8 - r, BLACK) for r in range(3, 8)], (7, 1)),
    ],
)
def test_all_five_directions(moves, last):
    board = FreestyleRules().empty_board()
    for row, col, color in moves:
        board[row][col] = color
    assert FreestyleRules().has_five(board, last[0], last[1], BLACK)


def test_six_in_a_row_is_a_freestyle_win():
    board = FreestyleRules().empty_board()
    for col in range(6):
        board[10][col] = BLACK
    assert FreestyleRules().has_five(board, 10, 3, BLACK)


def test_history_rebuild_is_authoritative():
    history = [RuleMove(7, 7, BLACK), RuleMove(0, 0, WHITE), RuleMove(8, 8, BLACK)]
    board, _ = board_from_moves(history)
    assert board[7][7] == BLACK
    assert board[0][0] == WHITE
    assert board[8][8] == BLACK
    with pytest.raises(RuleViolation):
        board_from_moves([RuleMove(7, 7, WHITE)])
