import { isGameSnapshot } from '../game/state';
import type {
  AiAnalysisRequestEvent, AiAnalysisResultEvent,
  ChallengeInvite, ChallengePlayer, ChallengeResult, ChallengeSent, GamePresence, GameSnapshot,
  LobbyPlayer, LobbyRoster, LobbyStatus, OpeningResult, PhraseEvent, PresenceEvent, RingEvent, SessionUser,
} from '../game/types';
import { createRequestId } from '../utils/id';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

interface SocketCallbacks {
  onSession: (user: SessionUser | null, games: GameSnapshot[]) => void;
  onSnapshot: (snapshot: GameSnapshot) => void;
  onUndoRequested: (gameId: string, fromName: string) => void;
  onRestartRequested: (gameId: string, fromName: string) => void;
  onPresence: (event: PresenceEvent) => void;
  onRing: (event: RingEvent) => void;
  onPhrase: (event: PhraseEvent) => void;
  onAiAnalysisRequested: (event: AiAnalysisRequestEvent) => void;
  onAiAnalysisResult: (event: AiAnalysisResultEvent) => void;
  onOpeningResult: (result: OpeningResult) => void;
  onLobby: (roster: LobbyRoster) => void;
  onChallengeInvite: (invite: ChallengeInvite) => void;
  onChallengeSent: (sent: ChallengeSent) => void;
  onChallengeResult: (result: ChallengeResult) => void;
  onError: (code: string, message: string, requestId?: string) => void;
  onStatus: (status: ConnectionStatus) => void;
}

interface ErrorPayload {
  code?: unknown;
  message?: unknown;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function challengePlayer(value: unknown): ChallengePlayer | null {
  const raw = objectValue(value);
  const id = text(raw?.id);
  const name = text(raw?.name);
  if (!raw || !id || !name) return null;
  return { id, name, guest: raw.guest === true };
}

function presenceState(value: unknown): GamePresence | null {
  const raw = objectValue(value);
  if (!raw) return null;
  const black = raw.black;
  const white = raw.white;
  if (typeof black !== 'number' || typeof white !== 'number') return null;
  return { black, white };
}

/** 把可选的观战 / 在线状态字段补进快照（协议里缺省就当作没有）。 */
function snapshotPayload(value: unknown): GameSnapshot | null {
  if (!isGameSnapshot(value)) return null;
  const raw = value as unknown as Record<string, unknown>;
  const snapshot: GameSnapshot = { ...(value as GameSnapshot) };
  if (raw.spectating === true) snapshot.spectating = true;
  if (typeof raw.spectatorCount === 'number' && raw.spectatorCount > 0) {
    snapshot.spectatorCount = Math.floor(raw.spectatorCount);
  }
  // 观战者名单：只收「有 id 有名字」的项，其余忽略。
  if (Array.isArray(raw.spectators)) {
    const spectators = raw.spectators
      .map((item) => objectValue(item))
      .map((item) => ({ id: text(item?.id) ?? '', name: text(item?.name) ?? '' }))
      .filter((item) => item.id && item.name);
    if (spectators.length > 0) snapshot.spectators = spectators;
  }
  const presence = presenceState(raw.presence);
  if (presence) snapshot.presence = presence;
  return snapshot;
}

function roster(value: unknown): LobbyRoster | null {
  const raw = objectValue(value);
  if (!raw || !Array.isArray(raw.players)) return null;
  const players: LobbyPlayer[] = [];
  for (const item of raw.players) {
    const row = objectValue(item);
    const id = text(row?.id);
    const name = text(row?.name);
    if (!row || !id || !name) continue;
    const status: LobbyStatus = row.status === 'playing' || row.status === 'waiting' || row.status === 'watching'
      ? row.status
      : 'idle';
    players.push({ id, name, guest: row.guest === true, status, gameId: text(row.gameId) });
  }
  const counts = objectValue(raw.counts);
  return {
    players,
    counts: {
      online: typeof counts?.online === 'number' ? counts.online : players.length,
      idle: typeof counts?.idle === 'number' ? counts.idle : players.filter((p) => p.status === 'idle').length,
    },
  };
}

/** 可选字段按需拼装：`exactOptionalPropertyTypes` 下不能写 undefined。 */
function challengeResult(value: unknown): ChallengeResult | null {
  const raw = objectValue(value);
  const challengeId = text(raw?.challengeId);
  const status = text(raw?.status);
  if (!raw || !challengeId) return null;
  if (status !== 'accepted' && status !== 'declined' && status !== 'expired' && status !== 'cancelled') return null;
  const result: ChallengeResult = { challengeId, status };
  const gameId = text(raw.gameId);
  if (gameId) result.gameId = gameId;
  const byName = text(raw.byName);
  if (byName) result.byName = byName;
  const reason = text(raw.reason);
  if (reason) result.reason = reason;
  if (raw.byMe === true) result.byMe = true;
  return result;
}

export class GameSocket {
  private socket: WebSocket | null = null;
  private intentionalClose = false;
  private retryCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly callbacks: SocketCallbacks) {}

  connect(): void {
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    this.intentionalClose = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.callbacks.onStatus('connecting');

    const configured = import.meta.env.VITE_WS_URL;
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = configured || `${protocol}://${window.location.host}/ws`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.retryCount = 0;
      this.callbacks.onStatus('connected');
      this.startHeartbeat(socket);
    });
    socket.addEventListener('message', (event) => this.handleMessage(event.data));
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopHeartbeat();
      this.callbacks.onStatus('disconnected');
      this.scheduleReconnect();
    });
    socket.addEventListener('error', () => {
      // close 事件统一驱动重连，避免重复提示。
    });
  }

  send(type: string, payload: Record<string, unknown> = {}): string {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('与服务器的连接尚未就绪，请稍后重试');
    }
    const requestId = createRequestId();
    this.socket.send(JSON.stringify({ type, requestId, payload }));
    return requestId;
  }

  /**
   * 提交客户端引擎代算的 AI 着法。
   * ack（game.snapshot）与广播都会携带新状态，这里只负责发，不等待回包。
   */
  aiMove(gameId: string, row: number, col: number): void {
    this.send('game.ai_move', { gameId, row, col });
  }

  /** 切换人机局的执子权（观赏 / 编辑模式）。 */
  aiConfig(gameId: string, aiBlack: boolean, aiWhite: boolean): void {
    this.send('game.ai_config', { gameId, aiBlack, aiWhite });
  }

  close(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();
    this.socket?.close();
    this.socket = null;
    this.callbacks.onStatus('disconnected');
  }

  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat();
    // Keep idle games alive through proxies with short WebSocket timeouts.
    this.heartbeatTimer = setInterval(() => {
      if (this.socket === socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'ping' }));
      }
    }, 25_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose || this.reconnectTimer) return;
    const delay = Math.min(10_000, 700 * 2 ** this.retryCount);
    this.retryCount += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object' || !('type' in message) || typeof message.type !== 'string') return;
    const type = message.type;
    const requestId = 'requestId' in message && typeof message.requestId === 'string' ? message.requestId : undefined;
    const payload = 'payload' in message && message.payload && typeof message.payload === 'object' ? message.payload : null;

    if (type === 'session.ready') {
      const user = payload && 'user' in payload ? this.parseUser(payload.user) : null;
      const games = payload && 'games' in payload && Array.isArray(payload.games)
        ? payload.games.map(snapshotPayload).filter((game): game is GameSnapshot => game !== null)
        : [];
      this.callbacks.onSession(user, games);
      return;
    }
    if (type === 'game.snapshot') {
      const snapshot = snapshotPayload(payload);
      if (snapshot) this.callbacks.onSnapshot(snapshot);
      return;
    }
    if (type === 'game.presence') {
      const raw = objectValue(payload);
      const gameId = text(raw?.gameId);
      const userId = text(raw?.userId);
      const name = text(raw?.name);
      if (!gameId || !userId || !name) return;
      this.callbacks.onPresence({
        gameId,
        userId,
        name,
        color: raw?.color === 'white' ? 2 : 1,
        online: raw?.online === true,
        reconnectInMs: typeof raw?.reconnectInMs === 'number' ? raw.reconnectInMs : 0,
      });
      return;
    }
    if (type === 'game.ring') {
      const raw = objectValue(payload);
      const gameId = text(raw?.gameId);
      const fromName = text(raw?.fromName);
      if (!gameId || !fromName) return;
      this.callbacks.onRing({ gameId, fromName, color: raw?.color === 2 ? 2 : 1 });
      return;
    }
    if (type === 'game.phrase') {
      const raw = objectValue(payload);
      const gameId = text(raw?.gameId);
      const senderId = text(raw?.senderId);
      const senderName = text(raw?.senderName);
      const phraseId = text(raw?.phraseId);
      const phraseTextValue = text(raw?.text);
      // 缺少任一关键字段就丢弃：宁可漏一条短语，也不渲染半截气泡。
      if (!gameId || !senderId || !senderName || !phraseId || phraseTextValue == null) return;
      this.callbacks.onPhrase({
        gameId,
        senderId,
        senderName,
        color: raw?.color === 2 ? 2 : 1,
        phraseId,
        // 文案以服务端下发的规范文本为准（服务端已校验 phraseId），这里只原样投递。
        text: phraseTextValue,
        timestamp: typeof raw?.timestamp === 'number' ? raw.timestamp : 0,
      });
      return;
    }
    if (type === 'game.opening_result') {
      const raw = objectValue(payload);
      const gameId = text(raw?.gameId);
      const firstSeat = raw?.firstSeat === 'a' || raw?.firstSeat === 'b' ? raw.firstSeat : null;
      const method = raw?.method === 'agreement' || raw?.method === 'coin' ? raw.method : null;
      const seats = raw?.seats as OpeningResult['seats'] | undefined;
      if (!gameId || !firstSeat || !method || !seats?.a || !seats?.b) return;
      this.callbacks.onOpeningResult({ gameId, firstSeat, method, seats });
      return;
    }
    if (type === 'game.undo_requested') {
      if (payload && 'gameId' in payload && typeof payload.gameId === 'string') {
        const fromName = 'fromName' in payload && typeof payload.fromName === 'string' ? payload.fromName : '对手';
        this.callbacks.onUndoRequested(payload.gameId, fromName);
      }
      return;
    }
    if (type === 'game.restart_requested') {
      if (payload && 'gameId' in payload && typeof payload.gameId === 'string') {
        const fromName = 'fromName' in payload && typeof payload.fromName === 'string' ? payload.fromName : '对手';
        this.callbacks.onRestartRequested(payload.gameId, fromName);
      }
      return;
    }
    if (type === 'lobby.players') {
      const data = roster(payload);
      if (data) this.callbacks.onLobby(data);
      return;
    }
    if (type === 'challenge.incoming') {
      const raw = objectValue(payload);
      const challengeId = text(raw?.challengeId);
      const from = challengePlayer(raw?.from);
      if (!challengeId || !from) return;
      this.callbacks.onChallengeInvite({
        challengeId,
        from,
        expiresInMs: typeof raw?.expiresInMs === 'number' ? raw.expiresInMs : 30_000,
      });
      return;
    }
    if (type === 'challenge.sent') {
      const raw = objectValue(payload);
      const challengeId = text(raw?.challengeId);
      const target = challengePlayer(raw?.target);
      if (!challengeId || !target) return;
      this.callbacks.onChallengeSent({
        challengeId,
        target,
        expiresInMs: typeof raw?.expiresInMs === 'number' ? raw.expiresInMs : 30_000,
      });
      return;
    }
    if (type === 'challenge.result') {
      const data = challengeResult(payload);
      if (data) this.callbacks.onChallengeResult(data);
      return;
    }
    if (type === 'game.ai_analysis_requested') {
      const raw = objectValue(payload);
      const gameId = text(raw?.gameId);
      const fromName = text(raw?.fromName);
      if (!gameId || !fromName) return;
      this.callbacks.onAiAnalysisRequested({ gameId, fromName });
      return;
    }
    if (type === 'game.ai_analysis_result') {
      const raw = objectValue(payload);
      const gameId = text(raw?.gameId);
      const byName = text(raw?.byName);
      if (!gameId || !byName) return;
      const accepted = raw?.accepted === true;
      const row = typeof raw?.row === 'number' ? raw.row : null;
      const col = typeof raw?.col === 'number' ? raw.col : null;
      // 引擎已迁到客户端：同意后不再有服务端算好的落点（row/col 缺省），
      // 请求方前端收到事件后自行用本地引擎计算。
      this.callbacks.onAiAnalysisResult(
        accepted
          ? row !== null && col !== null
            ? { gameId, accepted: true, row, col, byName }
            : { gameId, accepted: true, byName }
          : { gameId, accepted: false, byName },
      );
      return;
    }
    if (type === 'error' || type === 'game.error') {
      const error = 'error' in message && message.error && typeof message.error === 'object' ? message.error as ErrorPayload : null;
      const payloadMessage = payload && 'message' in payload && typeof payload.message === 'string' ? payload.message : null;
      this.callbacks.onError(
        typeof error?.code === 'string' ? error.code : 'GAME_ERROR',
        (typeof error?.message === 'string' ? error.message : payloadMessage) ?? '操作未能完成，请重试',
        requestId,
      );
    }
  }

  private parseUser(value: unknown): SessionUser | null {
    if (!value || typeof value !== 'object') return null;
    if (!('id' in value) || typeof value.id !== 'string' || !('name' in value) || typeof value.name !== 'string') return null;
    return { id: value.id, name: value.name, guest: 'guest' in value && value.guest === true };
  }
}
