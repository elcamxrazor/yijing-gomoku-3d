import { describe, expect, it } from 'vitest';
import { GomokuRuleEngine } from './rules';
import type { Board, PlayerColor } from './types';

function boardWith(moves: Array<[number, number, PlayerColor]>): Board {
  const engine = new GomokuRuleEngine();
  const board = engine.createBoard();
  for (const [row, col, color] of moves) {
    const line = board[row];
    if (!line) throw new Error('invalid test fixture');
    line[col] = color;
  }
  return board;
}

describe('GomokuRuleEngine', () => {
  it('创建 15×15 空棋盘且每行独立', () => {
    const engine = new GomokuRuleEngine();
    const board = engine.createBoard();
    expect(board).toHaveLength(15);
    expect(board.every((row) => row.length === 15 && row.every((cell) => cell === 0))).toBe(true);
    board[0]![0] = 1;
    expect(board[1]![0]).toBe(0);
  });

  it('拒绝越界、非整数和重复落子', () => {
    const engine = new GomokuRuleEngine();
    const board = boardWith([[7, 7, 1]]);
    expect(engine.validateMove(board, -1, 0).reason).toBe('out-of-bounds');
    expect(engine.validateMove(board, 15, 0).reason).toBe('out-of-bounds');
    expect(engine.validateMove(board, 1.5, 0).reason).toBe('out-of-bounds');
    expect(engine.validateMove(board, 7, 7).reason).toBe('occupied');
    expect(engine.validateMove(board, 7, 8).valid).toBe(true);
  });

  it.each([
    { name: '横向', moves: [[7, 3, 1], [7, 4, 1], [7, 5, 1], [7, 6, 1]] as Array<[number, number, PlayerColor]>, row: 7, col: 7 },
    { name: '纵向', moves: [[3, 7, 1], [4, 7, 1], [5, 7, 1], [6, 7, 1]] as Array<[number, number, PlayerColor]>, row: 7, col: 7 },
    { name: '主对角线', moves: [[3, 3, 1], [4, 4, 1], [5, 5, 1], [6, 6, 1]] as Array<[number, number, PlayerColor]>, row: 7, col: 7 },
    { name: '副对角线', moves: [[3, 11, 1], [4, 10, 1], [5, 9, 1], [6, 8, 1]] as Array<[number, number, PlayerColor]>, row: 7, col: 7 },
  ])('识别$name五连', ({ moves, row, col }) => {
    const engine = new GomokuRuleEngine();
    const result = engine.applyMove(boardWith(moves), row, col, 1);
    expect(result.winner).toBe(1);
    expect(result.winReason).toBe('five');
    expect(result.winningLine).toHaveLength(5);
  });

  it('支持中间补子与六连长连，无禁手', () => {
    const engine = new GomokuRuleEngine();
    const board = boardWith([[7, 2, 1], [7, 3, 1], [7, 5, 1], [7, 6, 1], [7, 7, 1]]);
    const result = engine.applyMove(board, 7, 4, 1);
    expect(result.winner).toBe(1);
    expect(result.winningLine).toHaveLength(6);
  });

  it('棋盘边缘五连有效，对手棋子和空格会阻断连线', () => {
    const engine = new GomokuRuleEngine();
    const edge = engine.applyMove(boardWith([[0, 0, 2], [0, 1, 2], [0, 2, 2], [0, 3, 2]]), 0, 4, 2);
    expect(edge.winner).toBe(2);
    const blocked = engine.applyMove(boardWith([[4, 0, 1], [4, 1, 1], [4, 2, 2], [4, 3, 1]]), 4, 4, 1);
    expect(blocked.winner).toBe(0);
    expect(blocked.winReason).toBe(null);
  });

  it('applyMove 不修改原棋盘', () => {
    const engine = new GomokuRuleEngine();
    const board = engine.createBoard();
    const next = engine.applyMove(board, 7, 7, 1);
    expect(board[7]![7]).toBe(0);
    expect(next.board[7]![7]).toBe(1);
  });

  it('最后一格未五连时判定平局', () => {
    const engine = new GomokuRuleEngine();
    const board = engine.createBoard();
    // 3 格循环图案避免任意方向出现五连。
    for (let row = 0; row < 15; row += 1) {
      for (let col = 0; col < 15; col += 1) {
        board[row]![col] = ((row + Math.floor(col / 3)) % 2 === 0 ? 1 : 2);
      }
    }
    board[14]![14] = 0;
    const result = engine.applyMove(board, 14, 14, board[14]![13] === 1 ? 2 : 1);
    expect(result.winner).toBe(0);
    expect(result.winReason).toBe('draw');
  });
});
