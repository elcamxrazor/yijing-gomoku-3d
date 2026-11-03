import { BOARD_SIZE } from './types';
import type { Board, Cell, MoveValidation, PlayerColor, RuleResult } from './types';

export interface RuleEngine {
  readonly size: number;
  createBoard(): Board;
  validateMove(board: Board, row: number, col: number): MoveValidation;
  applyMove(board: Board, row: number, col: number, color: PlayerColor): RuleResult;
  findWinningLine(board: Board, row: number, col: number, color: PlayerColor): Array<{ row: number; col: number }>;
}

const DIRECTIONS = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
] as const;

/** 标准无禁手规则。禁手可通过实现 RuleEngine 在未来替换。 */
export class GomokuRuleEngine implements RuleEngine {
  readonly size = BOARD_SIZE;

  createBoard(): Board {
    return Array.from({ length: this.size }, () => Array<Cell>(this.size).fill(0));
  }

  isInside(row: number, col: number): boolean {
    return Number.isInteger(row) && Number.isInteger(col)
      && row >= 0 && row < this.size && col >= 0 && col < this.size;
  }

  validateMove(board: Board, row: number, col: number): MoveValidation {
    if (!this.isInside(row, col)) return { valid: false, reason: 'out-of-bounds' };
    if (board[row]?.[col] !== 0) return { valid: false, reason: 'occupied' };
    return { valid: true, reason: null };
  }

  applyMove(board: Board, row: number, col: number, color: PlayerColor): RuleResult {
    const validation = this.validateMove(board, row, col);
    if (!validation.valid) throw new Error(validation.reason === 'occupied' ? '此位置已有棋子' : '落子超出棋盘');

    const nextBoard = board.map((line) => [...line]);
    const target = nextBoard[row];
    if (!target) throw new Error('落子超出棋盘');
    target[col] = color;

    const winningLine = this.findWinningLine(nextBoard, row, col, color);
    const isFull = nextBoard.every((line) => line.every((cell) => cell !== 0));
    return {
      board: nextBoard,
      winner: winningLine.length >= 5 ? color : isFull ? 0 : 0,
      winReason: winningLine.length >= 5 ? 'five' : isFull ? 'draw' : null,
      winningLine,
    };
  }

  findWinningLine(board: Board, row: number, col: number, color: PlayerColor): Array<{ row: number; col: number }> {
    for (const [rowStep, colStep] of DIRECTIONS) {
      const line = [{ row, col }];
      for (const sign of [-1, 1] as const) {
        let nextRow = row + rowStep * sign;
        let nextCol = col + colStep * sign;
        while (this.isInside(nextRow, nextCol) && board[nextRow]?.[nextCol] === color) {
          if (sign === -1) line.unshift({ row: nextRow, col: nextCol });
          else line.push({ row: nextRow, col: nextCol });
          nextRow += rowStep * sign;
          nextCol += colStep * sign;
        }
      }
      if (line.length >= 5) return line;
    }
    return [];
  }
}

export const rules = new GomokuRuleEngine();

/** 规则变体：无禁手（自由） / 有禁手（连珠，黑方禁三三·四四·长连）。 */
export type RuleVariant = 'freestyle' | 'renju';

/**
 * 连珠规则：黑方禁三三 / 四四 / 长连，黑棋恰好五连才算胜；
 * 白方无禁手，五连及以上（含长连）均获胜。判定逻辑与后端 `RenjuRules`
 * 一一对应（同一套递归定义的实用简化），保证两端裁决一致。
 */
export class RenjuRuleEngine extends GomokuRuleEngine {
  private readonly directions = DIRECTIONS;

  override applyMove(board: Board, row: number, col: number, color: PlayerColor): RuleResult {
    const validation = this.validateMove(board, row, col);
    if (!validation.valid) throw new Error(validation.reason === 'occupied' ? '此位置已有棋子' : '落子超出棋盘');
    if (color === 1 && this.isForbidden(board, row, col)) {
      throw new Error('禁手点：黑棋不可形成三三、四四或长连');
    }
    const nextBoard = board.map((line) => [...line]);
    const target = nextBoard[row];
    if (!target) throw new Error('落子超出棋盘');
    target[col] = color;

    const winningLine = this.findWinningLine(nextBoard, row, col, color);
    const isFull = nextBoard.every((line) => line.every((cell) => cell !== 0));
    return {
      board: nextBoard,
      winner: winningLine.length >= 5 ? color : isFull ? 0 : 0,
      winReason: winningLine.length >= 5 ? 'five' : isFull ? 'draw' : null,
      winningLine,
    };
  }

  override findWinningLine(board: Board, row: number, col: number, color: PlayerColor): Array<{ row: number; col: number }> {
    for (const [rowStep, colStep] of this.directions) {
      const line = [{ row, col }];
      for (const sign of [-1, 1] as const) {
        let nextRow = row + rowStep * sign;
        let nextCol = col + colStep * sign;
        while (this.isInside(nextRow, nextCol) && board[nextRow]?.[nextCol] === color) {
          if (sign === -1) line.unshift({ row: nextRow, col: nextCol });
          else line.push({ row: nextRow, col: nextCol });
          nextRow += rowStep * sign;
          nextCol += colStep * sign;
        }
      }
      // 黑棋恰好五连才胜；白棋五连及以上（含长连）都胜。
      if (line.length === 5 || (line.length > 5 && color === 2)) return line;
    }
    return [];
  }

  /** 假设黑棋落在 (row, col)（空点），是否禁手。 */
  isForbidden(board: Board, row: number, col: number): boolean {
    const work = board.map((line) => [...line]);
    work[row]![col] = 1;
    const counts = this.directions.map(([dr, dc]) => this.lineCount(work, row, col, dr, dc));
    // 恰好五连是制胜手，永不禁手（即便同时带了别的形状）。
    if (counts.some((count) => count === 5)) return false;
    // 长连（≥6）禁。
    if (counts.some((count) => count >= 6)) return true;
    const fours = this.directions.filter(([dr, dc], index) =>
      counts[index] === 4 && this.completesFive(work, row, col, dr, dc)).length;
    if (fours >= 2) return true; // 四四禁手
    const threes = this.directions.filter(([dr, dc], index) =>
      counts[index] === 3 && this.makesOpenFour(work, row, col, dr, dc)).length;
    return threes >= 2; // 三三禁手
  }

  private lineCount(board: Board, row: number, col: number, dr: number, dc: number): number {
    let count = 1;
    for (const sign of [-1, 1] as const) {
      let r = row + sign * dr;
      let c = col + sign * dc;
      while (this.isInside(r, c) && board[r]?.[c] === 1) {
        count += 1;
        r += sign * dr;
        c += sign * dc;
      }
    }
    return count;
  }

  /** 本方向是否存在一空点，填上后（含当前落点）恰好成五。 */
  private completesFive(board: Board, row: number, col: number, dr: number, dc: number): boolean {
    for (let sign = -4; sign <= 4; sign += 1) {
      const r = row + sign * dr;
      const c = col + sign * dc;
      if (!this.isInside(r, c) || board[r]?.[c] !== 0) continue;
      work_set(board, r, c, 1);
      try {
        if (this.lineCount(board, row, col, dr, dc) === 5) return true;
      } finally {
        work_set(board, r, c, 0);
      }
    }
    return false;
  }

  /** 本方向是否存在一空点，填上后出现 `.BBBB.`（活四，必胜形）。 */
  private makesOpenFour(board: Board, row: number, col: number, dr: number, dc: number): boolean {
    for (let sign = -3; sign <= 3; sign += 1) {
      const r = row + sign * dr;
      const c = col + sign * dc;
      if (!this.isInside(r, c) || board[r]?.[c] !== 0) continue;
      work_set(board, r, c, 1);
      try {
        if (this.hasOpenFour(board, row, col, dr, dc)) return true;
      } finally {
        work_set(board, r, c, 0);
      }
    }
    return false;
  }

  /** 经过 (row, col) 的方向线上是否存在 `.BBBB.` 且四子含该点。 */
  private hasOpenFour(board: Board, row: number, col: number, dr: number, dc: number): boolean {
    const cells: Array<[number, number]> = [];
    for (let k = -5; k <= 5; k += 1) cells.push([row + k * dr, col + k * dc]);
    for (let start = 0; start + 5 < cells.length; start += 1) {
      const window = cells.slice(start, start + 6);
      if (window.some(([r, c]) => !this.isInside(r, c))) continue;
      const values = window.map(([r, c]) => board[r]?.[c]);
      if (values.join(',') !== '0,1,1,1,1,0') continue;
      // 四子里必须包含当前落点（否则与本手无关）。
      if (window.slice(1, 5).some(([r, c]) => r === row && c === col)) return true;
    }
    return false;
  }
}

function work_set(board: Board, row: number, col: number, value: Cell): void {
  const line = board[row];
  if (line) line[col] = value;
}

/** 按规则变体取规则引擎。 */
export function rulesFor(variant: RuleVariant): RuleEngine {
  return variant === 'renju' ? new RenjuRuleEngine() : new GomokuRuleEngine();
}
