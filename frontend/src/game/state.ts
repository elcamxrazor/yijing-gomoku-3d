import { GomokuRuleEngine, rulesFor } from './rules';
import type { RuleEngine, RuleVariant } from './rules';

import { DEFAULT_SCENE_ID, randomSceneId } from './scenes';
import type { ScenePresetId } from './scenes';
import type { AnyGameSnapshot, GameSnapshot, LocalSnapshot, Move, PlayerColor, SessionUser } from './types';

const LOCAL_PLAYERS = {
  black: { id: 'local-black', name: '黑方' },
  white: { id: 'local-white', name: '白方' },
};

export class LocalGameState {
  private board: LocalSnapshot['board'];
  private history: Move[] = [];
  private currentPlayer: PlayerColor = 1;
  private winner: 0 | 1 | 2 = 0;
  private winReason: LocalSnapshot['winReason'] = null;
  private sequence = 0;
  /** 本地对弈没有服务端帮忙抽，开局在这里自己抽一个棋境。 */
  private scene: ScenePresetId = DEFAULT_SCENE_ID;

  /** 本局规则变体（开局选定，整局不变；默认无禁手）。 */
  private rule: RuleVariant = 'freestyle';

  constructor(private engine: RuleEngine = new GomokuRuleEngine()) {
    this.board = this.engine.createBoard();
  }

  /** @param scene 想指定棋境时传入；不给就随机抽一个。 */
  start(scene?: ScenePresetId, rule?: RuleVariant): LocalSnapshot {
    this.sequence += 1;
    this.rule = rule ?? 'freestyle';
    this.engine = rulesFor(this.rule);
    this.board = this.engine.createBoard();
    this.history = [];
    this.currentPlayer = 1;
    this.winner = 0;
    this.winReason = null;
    this.scene = scene ?? randomSceneId();
    return this.snapshot();
  }

  /** 上一局用的规则；「再来一局」沿用它。 */
  get currentRule(): RuleVariant {
    return this.rule;
  }

  /** 上一局用的棋境；「再来一局」沿用它，而不是再抽一次签。 */
  get currentScene(): ScenePresetId {
    return this.scene;
  }

  move(row: number, col: number): LocalSnapshot {
    if (this.winner !== 0 || this.winReason !== null) throw new Error('本局已结束，请重新开始');
    const result = this.engine.applyMove(this.board, row, col, this.currentPlayer);
    this.board = result.board;
    this.history.push({ row, col, color: this.currentPlayer });
    this.winner = result.winner;
    this.winReason = result.winReason;
    if (this.winReason === null) this.currentPlayer = this.currentPlayer === 1 ? 2 : 1;
    return this.snapshot();
  }

  undo(): LocalSnapshot {
    const last = this.history.pop();
    if (!last) throw new Error('还没有可以撤回的落子');
    this.board = this.engine.createBoard();
    for (const move of this.history) {
      const row = this.board[move.row];
      if (!row) throw new Error('历史记录无效');
      row[move.col] = move.color;
    }
    this.currentPlayer = last.color;
    this.winner = 0;
    this.winReason = null;
    return this.snapshot();
  }

  resign(): LocalSnapshot {
    if (this.winReason !== null) throw new Error('本局已结束');
    this.winner = this.currentPlayer === 1 ? 2 : 1;
    this.winReason = 'resign';
    return this.snapshot();
  }

  private snapshot(): LocalSnapshot {
    return {
      rule: this.rule,
      id: `local-${this.sequence}`,
      mode: 'local',
      status: this.winReason === null ? 'playing' : 'finished',
      scene: this.scene,
      board: this.board.map((row) => [...row]),
      currentPlayer: this.currentPlayer,
      players: { black: { ...LOCAL_PLAYERS.black }, white: { ...LOCAL_PLAYERS.white } },
      yourColor: null,
      roomCode: null,
      lastMove: this.history.at(-1) ?? null,
      moves: this.history.map((move) => ({ ...move })),
      winner: this.winner,
      winReason: this.winReason,
      moveCount: this.history.length,
      canUndo: this.history.length > 0,
      aiThinking: false,
      undoRequest: null,
    };
  }
}

export function isGameSnapshot(value: unknown): value is GameSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<GameSnapshot>;
  return typeof candidate.id === 'string'
    && (candidate.mode === 'ai' || candidate.mode === 'online')
    && (candidate.status === 'waiting' || candidate.status === 'playing' || candidate.status === 'finished')
    && Array.isArray(candidate.board)
    && candidate.board.length === 15
    && (candidate.currentPlayer === 1 || candidate.currentPlayer === 2)
    && typeof candidate.moveCount === 'number'
    && typeof candidate.aiThinking === 'boolean';
}

export function userPlayerName(user: SessionUser | null): string {
  return user?.name ?? '游客';
}

export function canLocalMove(snapshot: AnyGameSnapshot | null): snapshot is LocalSnapshot {
  return snapshot?.mode === 'local' && snapshot.status === 'playing';
}
