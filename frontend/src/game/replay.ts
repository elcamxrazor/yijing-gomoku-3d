import { BOARD_SIZE, type Board, type Cell, type GameMode, type Move, type PlayerColor, type WinReason } from './types';
import type { ScenePresetId } from './scenes';

/**
 * 复盘的数据模型与纯函数。
 *
 * 这里刻意不碰 DOM、不碰三维场景：所有「第 n 手之后棋盘长什么样」的判断都在
 * 这一层完成，界面层只负责把结果摆上去。棋盘重建是复盘的唯一真正的逻辑，
 * 它必须是可测的、脱机的——一旦混进渲染代码，就只能靠肉眼验证了。
 */

/** 服务端返回的棋局摘要（列表项）。 */
export interface ReplaySummary {
  id: string;
  mode: GameMode;
  scene: ScenePresetId;
  status: 'waiting' | 'playing' | 'finished';
  winner: Cell;
  winReason: WinReason;
  moveCount: number;
  players: {
    black: { id: string; name: string } | null;
    white: { id: string; name: string } | null;
  };
  yourColor: PlayerColor | null;
  createdAt: string | null;
  finishedAt: string | null;
  /** 永久保存（豁免 30 天清理）。 */
  keepForever?: boolean;
}

/** 一手棋。`index` 是从 0 开始的序号，与服务端 `move_index` 一致。 */
export interface ReplayMove {
  index: number;
  row: number;
  col: number;
  color: PlayerColor;
}

/** 单局棋谱：摘要 + 完整着法。 */
export interface ReplayRecord extends ReplaySummary {
  moves: ReplayMove[];
}

/** 空棋盘。每次重建都新建一份，避免多处复用同一组数组互相污染。 */
export function emptyBoard(): Board {
  return Array.from({ length: BOARD_SIZE }, () =>
    Array.from({ length: BOARD_SIZE }, () => 0 as Cell),
  );
}

/**
 * 摆到第 `count` 手为止的棋盘（`count` = 0 表示空盘）。
 *
 * 复盘是「反复重建」而不是「增量落子」：拖动进度条时可能一下跳几十手，
 * 也可能往回退。从头重放 `count` 手是 O(count)，比维护撤销栈简单得多，
 * 而且天然没有「退到一半状态对不上」的风险。
 */
export function boardAt(moves: readonly ReplayMove[], count: number): Board {
  const board = emptyBoard();
  const limit = Math.max(0, Math.min(count, moves.length));
  for (let index = 0; index < limit; index += 1) {
    const move = moves[index];
    if (!move) continue;
    if (move.row < 0 || move.row >= BOARD_SIZE || move.col < 0 || move.col >= BOARD_SIZE) continue;
    const line = board[move.row];
    if (!line) continue;
    line[move.col] = move.color;
  }
  return board;
}

/** 第 `count` 手之后的「最后一手」——用来摆那枚落子标记。 */
export function lastMoveAt(moves: readonly ReplayMove[], count: number): Move | null {
  const limit = Math.max(0, Math.min(count, moves.length));
  if (limit === 0) return null;
  const move = moves[limit - 1];
  return move ? { row: move.row, col: move.col, color: move.color } : null;
}

/** 把任意输入夹到 `[0, total]`，进度条和按钮都用它，省掉到处写边界判断。 */
export function clampIndex(index: number, total: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(Math.round(index), Math.max(0, total)));
}

/** 结果的一句话：黑胜 / 白胜 / 和棋。 */
export function resultLabel(record: Pick<ReplaySummary, 'winner' | 'winReason'>): string {
  // 和棋要先判：它的 winner 是 0，直接按 winner 走会落到「未分胜负」那一条。
  if (record.winReason === 'draw') return '和棋';
  if (record.winner === 0) return '未分胜负';
  const side = record.winner === 1 ? '黑' : '白';
  if (record.winReason === 'resign') return `${side}胜 · 对方认输`;
  if (record.winReason === 'offline') return `${side}胜 · 对方掉线`;
  return `${side}胜 · 五子连珠`;
}

/** 对局用时：`12 分 30 秒` / `58 秒`。时间戳缺失时返回空串，界面上直接不显示。 */
export function formatDuration(createdAt: string | null, finishedAt: string | null): string {
  if (!createdAt || !finishedAt) return '';
  const start = Date.parse(createdAt);
  const end = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return '';
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
}

/**
 * 这一局是什么时候下的。
 *
 * 复盘里必须给出来：同一天可能连下好几盘，光看「12 手」根本分不清哪盘是哪盘，
 * 而复盘列表又是按时间倒序排的，没有时间戳就只能靠猜。
 *
 * 用**本地时区**格式化（`getHours` 一系），不用 `toISOString`——后者是 UTC，
 * 晚上 11 点下的棋会显示成「前一天的 15 点」，比不显示还容易误导。
 */
export function formatDateTime(iso: string | null): string {
  const date = parseDate(iso);
  if (!date) return '';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** 列表行用的短格式：`11-01 22:30`。年份在最近对局里没有信息量。 */
export function formatDateTimeShort(iso: string | null): string {
  const date = parseDate(iso);
  if (!date) return '';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseDate(iso: string | null): Date | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  return new Date(time);
}

/** 列表里那行副标题：模式 · 手数 · 用时。 */
export function summarizeMode(summary: Pick<ReplaySummary, 'mode'>): string {
  if (summary.mode === 'ai') return 'AI 对弈';
  if (summary.mode === 'online') return '好友联机';
  return '本地对弈';
}
