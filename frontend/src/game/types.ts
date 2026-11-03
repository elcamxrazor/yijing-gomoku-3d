import type { ScenePresetId } from './scenes';

export const BOARD_SIZE = 15 as const;

export type Cell = 0 | 1 | 2;
export type PlayerColor = 1 | 2;
export type Board = Cell[][];
export type GameMode = 'local' | 'ai' | 'online';
export type GameStatus = 'waiting' | 'playing' | 'finished';
/** `offline` 是断线超时判负：和主动认输是两回事，结算时要写清原因。 */
export type WinReason = 'five' | 'resign' | 'draw' | 'offline' | null;

/**
 * 两位棋手的连接状态：值是「还剩多少毫秒的重连宽限」，0 表示在线。
 * 只对进行中的联机对局有意义，其它情况是 null。
 */
export interface GamePresence {
  black: number;
  white: number;
}

export interface Move {
  row: number;
  col: number;
  color: PlayerColor;
}

export interface PlayerInfo {
  id: string;
  name: string;
  /** 该玩家为自己执子颜色装备的皮肤材质 id（皮肤跟人走）。 */
  skin?: string;
}

export interface GameSnapshot {
  id: string;
  mode: 'ai' | 'online';
  status: GameStatus;
  /**
   * 棋境：这一局在哪个房间里下。后端建房时存库、快照里回传，
   * 本地对弈由前端自己抽；同一局两边必须一致。
   */
  scene: ScenePresetId;
  /** 规则变体：freestyle 无禁手（默认）/ renju 黑方禁手。 */
  rule?: 'freestyle' | 'renju';
  /** 人机局执子权：该方是否由 AI 执子（对局中可切换）。 */
  aiBlack?: boolean;
  aiWhite?: boolean;
  board: Board;
  currentPlayer: PlayerColor;
  players: {
    black: PlayerInfo;
    white: PlayerInfo | null;
  };
  yourColor: PlayerColor | null;
  roomCode: string | null;
  lastMove: Move | null;
  /**
   * 全盘着法序列（按时间顺序，含颜色）。
   *
   * 有了它，「手数编号」才能在刷新页面、断线重连、悔棋之后依然正确——
   * 光靠 `board` 只知道「这一格是什么颜色」，无从知道它是第几手。
   * 上限 225 条，随快照一起发。
   */
  moves?: Move[];
  winner: Cell;
  winReason: WinReason;
  moveCount: number;
  canUndo: boolean;
  aiThinking: boolean;
  undoRequest?: { fromName: string } | null;
  /** 对方发来的「请求重开」握手（PVP 重开需对方同意）；只有被请求方会收到。 */
  restartRequest?: { fromName: string } | null;
  /** 自己已发起重开请求、等待对方回应时为 true（发起人视角）。 */
  restartPending?: boolean;
  /** 开局「决定先后手」协商状态；揭晓后为 null（结果改由 `game.opening_result` 下发）。 */
  opening?: OpeningState | null;
  /** 我是来看棋的：没有颜色，也不能落子。 */
  spectating?: boolean;
  /** 含自己在内的旁观人数。 */
  spectatorCount?: number;
  /** 旁观者名单（服务端只回 id 与昵称）；人数为 0 时缺省。 */
  spectators?: Array<{ id: string; name: string }>;
  presence?: GamePresence | null;
}

/** 服务端推送的「某人上线 / 断线了」。 */
export interface PresenceEvent {
  gameId: string;
  userId: string;
  name: string;
  color: PlayerColor;
  online: boolean;
  reconnectInMs: number;
}

/** 服务端转发的铃声。 */
export interface RingEvent {
  gameId: string;
  fromName: string;
  color: PlayerColor;
}

/** 服务端转发的快捷短语（对局内聊天）。 */
export interface PhraseEvent {
  gameId: string;
  senderId: string;
  senderName: string;
  color: PlayerColor;
  phraseId: string;
  text: string;
  timestamp: number;
}

/** 对方发来的「请求 AI 分析」握手（是否同意由被请求方决定）。 */
export interface AiAnalysisRequestEvent {
  gameId: string;
  fromName: string;
}

/** AI 分析的最终结果：同意后由请求方前端引擎计算建议点，婉拒时只有结论。 */
export interface AiAnalysisResultEvent {
  gameId: string;
  accepted: boolean;
  row?: number;
  col?: number;
  /** 发起请求的一方（提示语主语）。 */
  byName: string;
}

/** 开局「决定先后手」协商中的一个座位玩家（稳定，不随最终黑白交换而变）。 */
export interface OpeningSeat {
  id: string;
  name: string;
}

/**
 * 开局协商状态：两位棋手各自选择希望谁先手。
 *
 * `seats` 的键 `a` / `b` 是开局时黑座 / 白座玩家的稳定标识，最终谁先手由
 * `firstSeat` 决定（揭晓后交换黑白座位使先手者为黑）。`youSeat` 是「我」所在的座位，
 * 用于前端渲染选择面板时区分「我」与「对方」的选项。
 */
export interface OpeningState {
  phase: 'choosing';
  seats: { a: OpeningSeat; b: OpeningSeat };
  youSeat: 'a' | 'b' | null;
  youChose: 'self' | 'opponent' | null;
  opponentChose: 'self' | 'opponent' | null;
}

/** 服务端揭晓先后手的结果（触发 3D 硬币动画 / 直接开局）。 */
export interface OpeningResult {
  gameId: string;
  /** 先手所在的座位：'a' 或 'b'。 */
  firstSeat: 'a' | 'b';
  /** 一致则 'agreement'（直接开局，不抛硬币），不一致则 'coin'（抛硬币）。 */
  method: 'agreement' | 'coin';
  seats: { a: OpeningSeat; b: OpeningSeat };
}

export interface LocalSnapshot extends Omit<GameSnapshot, 'mode'> {
  mode: 'local';
}

export type AnyGameSnapshot = GameSnapshot | LocalSnapshot;

export interface SessionUser {
  id: string;
  name: string;
  guest: boolean;
}

/** 大厅里一行人的状态：空闲可约战、房间等待中、对弈中、观战中。 */
export type LobbyStatus = 'idle' | 'waiting' | 'playing' | 'watching';

export interface LobbyPlayer {
  id: string;
  name: string;
  guest: boolean;
  status: LobbyStatus;
  gameId: string | null;
}

export interface LobbyRoster {
  players: LobbyPlayer[];
  counts: { online: number; idle: number };
}

export interface ChallengePlayer {
  id: string;
  name: string;
  guest: boolean;
}

export interface ChallengeInvite {
  challengeId: string;
  from: ChallengePlayer;
  expiresInMs: number;
}

export interface ChallengeSent {
  challengeId: string;
  target: ChallengePlayer;
  expiresInMs: number;
}

export type ChallengeOutcome = 'accepted' | 'declined' | 'expired' | 'cancelled';

export interface ChallengeResult {
  challengeId: string;
  status: ChallengeOutcome;
  gameId?: string;
  byName?: string;
  reason?: string;
  /** 结果由自己的操作触发时为 true，用来避免「自己撤回自己」的提示。 */
  byMe?: boolean;
}

export interface RuleResult {
  board: Board;
  winner: Cell;
  winReason: Exclude<WinReason, 'resign'>;
  winningLine: Array<{ row: number; col: number }>;
}

export interface MoveValidation {
  valid: boolean;
  reason: 'occupied' | 'out-of-bounds' | null;
}
