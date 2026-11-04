import type { PlayerColor } from './types';
import type { ReplayRecord } from './replay';

/**
 * 复盘「一键续弈」的纯逻辑。
 *
 * 界面只负责把这里算出来的东西画出来：能不能接手、从第几手接、接手之后轮到
 * 谁。这些判断一旦散进事件处理里，就只能靠手点验证了。
 */

/** 服务端 `preset` 的形状：只有坐标，颜色由服务端按手数推导。 */
export interface PresetPoint {
  row: number;
  col: number;
}

/** 残局轮到谁：黑先交替，偶数手轮到黑方。 */
export function sideToMove(ply: number): PlayerColor {
  return ply % 2 === 0 ? 1 : 2;
}

/** 某一方执子的颜色（`black` / `white` → 1 / 2）。 */
export function colorOf(side: 'black' | 'white'): PlayerColor {
  return side === 'black' ? 1 : 2;
}

/**
 * 从棋谱取「第 `index` 手之后的局面」作为残局前缀。
 *
 * 空盘（index 0）也返回空数组：服务端对空 preset 的处理就是正常开局，
 * 两种语义天然对齐，不需要前端另开一条路。
 */
export function presetFrom(record: ReplayRecord, index: number): PresetPoint[] {
  const count = Math.max(0, Math.min(index, record.moves.length));
  return record.moves.slice(0, count).map((move) => ({ row: move.row, col: move.col }));
}

/**
 * 这一手能不能作为残局的起点。
 *
 * - 第 0 手是空盘，和「开一局新人机」没有区别，绕到这里来只会让人困惑；
 * - 走到棋谱末尾时要看终局原因：**认输 / 掉线 / 超时之后盘面还是能下的**，
 *   而五连和满盘已经下无可下——服务端也会拒掉那种 preset。
 */
export function canContinueFrom(record: ReplayRecord, index: number): boolean {
  if (index <= 0) return false;
  if (index > record.moves.length) return false;
  if (index < record.moves.length) return true;
  return record.winReason !== 'five' && record.winReason !== 'draw';
}

/** 接手之后谁先走：给弹窗那两个按钮写小字用。 */
export function firstMoverNote(ply: number, aiSide: 'black' | 'white'): string {
  return sideToMove(ply) === colorOf(aiSide) ? '轮到计算机先行' : '轮到你先行';
}

/** 「从第 N 手接手」里那个 N；空棋谱时返回 0。 */
export function continuePly(record: ReplayRecord, index: number): number {
  return Math.max(0, Math.min(index, record.moves.length));
}
