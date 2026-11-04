import './styles/main.css';
import { AuthClient, type ProfileStats } from './auth/AuthClient';
import { Radio } from './audio/Radio';
import { SoundManager } from './audio/SoundManager';
import { LocalGameState } from './game/state';
import { clockLabel, clockOffset, clockVisible, isLowTime, remainingMs, timeControlLabel } from './game/clock';
import { offlineOpponent } from './game/presence';
import { coerceSceneId, sceneName } from './game/scenes';
import type {
  AiAnalysisRequestEvent, AiAnalysisResultEvent, AnyGameSnapshot, ChallengeInvite, ChallengeResult, ChallengeSent,
  GameSnapshot, LobbyPlayer, LobbyRoster, OpeningResult, OpeningState, PhraseEvent, PlayerColor, PresenceEvent, RingEvent, SessionUser,
  TimeControl,
} from './game/types';
import { GameSocket } from './network/GameSocket';
import type { ConnectionStatus } from './network/GameSocket';
import { ReplayClient, ReplayError, type ReplaySuggestion } from './network/ReplayClient';
import { getRapfiClient, type RapfiClient, type RapfiInfo } from './engine/rapfiClient';
import {
  loadSettings, saveSettings, mergeServerSettings, MOVE_NUMBER_OPTIONS, normalizeMoveNumberMode,
} from './game/settings';
import type { GameSettings, MoveNumberMode } from './game/settings';
import {
  boardAt, clampIndex, formatDateTime, formatDateTimeShort, formatDuration, lastMoveAt,
  resultLabel, summarizeMode,
} from './game/replay';
import type { ReplayRecord, ReplaySummary } from './game/replay';
import { canContinueFrom, continuePly, firstMoverNote, presetFrom } from './game/continue';
import { phraseText } from './shop/phrases';
import {
  type UserProfile, SHOP_ITEMS, POINTS_PER_GAME, loadProfile, applyWallet,
  saveProfile,
  equipMaterial, isUnlocked, isSceneUnlocked,
} from './shop/store';
import { STONE_MATERIALS } from './scene/stoneMaterials';
import { resolveStoneSkins } from './game/skins';
import { GomokuScene } from './scene/GomokuScene';
import { CoinScene } from './scene/CoinScene';
import { icon } from './ui/icons';
import { confirmAction, required, setBusy, toast } from './ui/feedback';
import { renderShell } from './ui/shell';
import { readRuleChoice, readSceneChoice } from './ui/scenePicker';
import { readTimeChoice } from './ui/timePicker';
import { copyText } from './utils/clipboard';

const LOBBY_POLL_MS = 5_000;

const STATUS_LABEL: Record<LobbyPlayer['status'], string> = {
  idle: '可约战',
  waiting: '房间等待中',
  playing: '对弈中',
  watching: '观战中',
};

/** 把用户可控文本放进 HTML 之前先转义：昵称是玩家自己起的。 */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
}

/** 秒数 → `mm:ss`，断线倒计时用。 */
function formatCountdown(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(total / 60);
  return `${String(minutes).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * 叙事行副标题里的读秒后缀。
 *
 * 「不限时」的局**不加任何字**：绝大多数对局都是不限时的，每局都挂一句
 * 「不限时」只会让这一行变成噪音。限时的局才值得说一句。
 */
function timeBudgetSuffix(control: TimeControl | null | undefined): string {
  return control && control.mode === 'perMove'
    ? ` · 每步 ${timeControlLabel(control)}`
    : '';
}

class YijingApp {
  private readonly auth = new AuthClient();
  private readonly sounds = new SoundManager();
  private readonly radio = new Radio();
  private readonly localGame = new LocalGameState();
  private readonly scene: GomokuScene;
  private readonly socket: GameSocket;
  private snapshot: AnyGameSnapshot | null = null;
  private user: SessionUser | null = null;
  private authTab: 'login' | 'register' = 'login';
  private connectionStatus: ConnectionStatus = 'disconnected';
  private sessionReady = false;
  private awaitingRemoteGame = false;
  private pendingAfterSession: (() => void) | null = null;
  private pendingUndoGameId: string | null = null;
  private dismissedUndoKey: string | null = null;

  // 对局内重开（PVP 需对方同意）
  /** 收到「对方请求重开」弹窗时所针对的对局；回应后清空。 */
  private pendingRestartGameId: string | null = null;
  private dismissedRestartKey: string | null = null;

  // 对局内 AI 分析（需对方同意）
  /** 我已发出、尚未收到回应的分析请求所属对局；null 表示没有在途请求。 */
  private aiAnalysisRequestedGame: string | null = null;
  /** 对方发来的分析请求；弹窗期间持有，回应后清空。 */
  private incomingAiAnalysis: AiAnalysisRequestEvent | null = null;
  // 人机模式「AI 分析」：本地引擎分析在途标记，防止与 AI 落子抢引擎会话。
  private aiEvaluationInFlight = false;

  // 大厅与约战
  private roster: LobbyRoster | null = null;
  private incoming: ChallengeInvite | null = null;
  private outgoing: string | null = null;
  private lobbyTab: 'hall' | 'room' = 'hall';
  private lobbyTimer: number | null = null;
  private incomingTicker: number | null = null;
  private incomingDeadline = 0;
  private incomingWindow = 30_000;
  private sentTicker: number | null = null;
  private sentDeadline = 0;
  private sentWindow = 30_000;
  private challengeJustAccepted = false;

  /** 对手断线横幅：宽限到哪一刻结束。null 表示对面都在。 */
  private presence: { color: PlayerColor; name: string; deadline: number } | null = null;
  private presenceTicker: number | null = null;

  /**
   * 读秒倒计时：这一局每步限时的状态。
   *
   * 只存「截止时刻」，**不存剩余秒数**。移动端切到后台时浏览器会把
   * `setInterval` 节流到每秒甚至停摆，自减会一路走偏；每次从 `deadlineAt`
   * 重算则回到前台瞬间自愈。
   */
  private clock: { deadlineAt: number; offset: number; paused: boolean } | null = null;
  private clockTicker: number | null = null;

  /** 本地用户档案（积分 / 已解锁 / 已装备）。仅影响外观，存于 localStorage。 */
  private readonly profile: UserProfile = loadProfile();
  /** 快捷短语气泡的自动移除计时器，退出对局时统一清理，避免泄漏。 */
  private readonly phraseTimers: number[] = [];
  /** 开局「决定先后手」协商的当前状态；揭晓后为 null。 */
  private opening: OpeningState | null = null;
  /** 3D 硬币场景实例，懒加载、离开开局流程时释放。 */
  private coin: CoinScene | null = null;
  /** 硬币动画是否正在播放（揭晓阶段），期间禁止落子。 */
  private coinActive = false;
  /** 揭晓结果（agreement / coin），渲染硬币区与「双方一致」提示时用。 */
  private openingResult: OpeningResult | null = null;
  /** 自增令牌：退出对局或重开时使进行中的揭晓动画作废，避免回调污染新局。 */
  private openingToken = 0;
  /** 是否偏好减少动态效果：硬币直接落定、不旋转。 */
  private readonly reducedMotion: boolean;

  /** 本地显示设置（目前只有手数编号）。不参与对局，只影响自己看到的画面。 */
  private settings: GameSettings = loadSettings();

  // ---- 复盘 ----
  private readonly replays = new ReplayClient();
  /** 复盘列表的分类页签：全部 / 与好友 / 与 AI。 */
  private replayTab: 'all' | 'favorite' | 'ai' | 'online' = 'all';
  /** 正在复盘的棋谱；null 表示不在复盘中。 */
  private replay: ReplayRecord | null = null;
  /** 当前摆到第几手（0 = 空盘）。 */
  private replayIndex = 0;
  private replayTimer: number | null = null;
  /**
   * 进入复盘前正在看的棋局。
   *
   * 「复盘本局」是从结算卡进来的，退出复盘时应当回到那张结算卡而不是首页；
   * 从首页进来的则是 null，退出就回首页。存一份原快照，比事后猜「该回哪儿」可靠。
   */
  private replayReturn: AnyGameSnapshot | null = null;
  /**
   * AI 评估：当前展示中的建议（只在 `ply === replayIndex` 时有效）与缓存。
   *
   * 缓存键是 `gameId:ply`——服务端也有一份，这里再存一层是为了
   * 「翻回去再翻回来」零延迟：不发请求、不转圈，直接重亮提示环。
   */
  private replaySuggestion: (ReplaySuggestion & { ply: number }) | null = null;
  private readonly replaySuggestionCache = new Map<string, ReplaySuggestion>();
  private replayAnalyzing = false;

  // ---- 本地 Rapfi 引擎（人机局 AI 落子 / 实时思考面板 / PVP 与复盘分析） ----
  private rapfi: RapfiClient | null = null;
  /** 引擎已 START 的对局上下文：换局（含重开与复盘换盘）时重新 START。 */
  private rapfiGameId: string | null = null;
  private aiMoveInFlight = false;
  private lastHintAt = 0;
  private engineInfo: RapfiInfo = {};
  /** 局终结算卡被玩家临时收起（点棋盘周围区域），再次点击同一区域恢复。 */
  private resultCardDismissed = false;

  constructor(private readonly root: HTMLElement) {
    this.root.innerHTML = renderShell();
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.reducedMotion = reducedMotion;
    this.scene = new GomokuScene(required('scene-container'), {
      reducedMotion,
      onMove: (row, col) => this.makeMove(row, col),
      onRing: () => this.ringBell(),
      onBackgroundClick: () => this.toggleResultCard(),
    });
    this.socket = new GameSocket({
      onSession: (user, games) => this.handleSession(user, games),
      onSnapshot: (snapshot) => this.handleRemoteSnapshot(snapshot),
      onUndoRequested: (gameId, fromName) => this.showUndoRequest(gameId, fromName),
      onRestartRequested: (gameId, fromName) => this.showRestartRequest(gameId, fromName),
      onPresence: (event) => this.handlePresence(event),
      onRing: (event) => this.handleRing(event),
      onPhrase: (event) => this.handlePhrase(event),
      onAiAnalysisRequested: (event) => this.handleAiAnalysisRequested(event),
      onAiAnalysisResult: (event) => this.handleAiAnalysisResult(event),
      onOpeningResult: (result) => this.handleOpeningResult(result),
      onLobby: (roster) => this.handleLobby(roster),
      onChallengeInvite: (invite) => this.handleChallengeInvite(invite),
      onChallengeSent: (sent) => this.handleChallengeSent(sent),
      onChallengeResult: (result) => this.handleChallengeResult(result),
      onError: (code, message) => this.handleSocketError(code, message),
      onStatus: (status) => this.handleConnectionStatus(status),
    });
    this.bindInterface();
    this.applyEquippedMaterials();
    this.applySettings();
    this.render();
    void this.bootstrap();
    void this.setupRadio();
  }

  private async bootstrap(): Promise<void> {
    try {
      this.user = await this.auth.me();
      if (this.user) this.socket.connect();
    } catch {
      // 本地模式不依赖服务器，认证失败时仍可正常使用。
    }
    this.renderAccount();
  }

  private bindInterface(): void {
    document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => {
      button.addEventListener('click', () => {
        const mode = button.dataset.mode;
        if (mode === 'local') this.openGameDialog('local');
        if (mode === 'ai') this.openGameDialog('ai');
        if (mode === 'online') this.openGameDialog('online');
      });
    });
    document.querySelectorAll<HTMLButtonElement>('[data-close]').forEach((button) => {
      button.addEventListener('click', () => required<HTMLDialogElement>(button.dataset.close ?? '').close());
    });
    document.querySelectorAll<HTMLButtonElement>('[data-auth-tab]').forEach((button) => {
      button.addEventListener('click', () => this.setAuthTab(button.dataset.authTab === 'register' ? 'register' : 'login'));
    });
    document.querySelectorAll<HTMLButtonElement>('[data-lobby-tab]').forEach((button) => {
      button.addEventListener('click', () => this.setLobbyTab(button.dataset.lobbyTab === 'room' ? 'room' : 'hall'));
    });

    required('account-button').addEventListener('click', () => void this.handleAccount());
    required('auth-form').addEventListener('submit', (event) => void this.submitAuth(event));
    required('guest-button').addEventListener('click', () => void this.enterAsGuest());
    required('start-ai').addEventListener('click', () => void this.startAi());
    required('start-local').addEventListener('click', () => this.startLocal());
    required('create-room').addEventListener('click', () => void this.createRoom());
    required('join-form').addEventListener('submit', (event) => void this.joinRoom(event));
    required<HTMLInputElement>('room-code-input').addEventListener('input', (event) => {
      const input = event.currentTarget as HTMLInputElement;
      input.value = input.value.toUpperCase().replace(/\s/g, '');
    });

    required('lobby-refresh').addEventListener('click', () => this.refreshLobby());
    required('lobby-enter').addEventListener('click', () => void this.enterLobby());
    required('challenge-accept').addEventListener('click', () => this.respondChallenge(true));
    required('challenge-decline').addEventListener('click', () => this.respondChallenge(false));
    required('challenge-cancel').addEventListener('click', () => this.cancelChallenge());
    required<HTMLDialogElement>('game-dialog').addEventListener('close', () => this.stopLobbyWatch());
    required<HTMLDialogElement>('challenge-dialog').addEventListener('cancel', (event) => {
      event.preventDefault();
      this.respondChallenge(false);
    });

    required('restart-button').addEventListener('click', () => void this.requestRestart());
    required('ai-side-black').addEventListener('change', () => this.handleAiSideChange());
    required('ai-side-white').addEventListener('change', () => this.handleAiSideChange());
    required('result-restart').addEventListener('click', () => void this.requestRestart(true));
    required('undo-button').addEventListener('click', () => this.requestUndo());
    required('resign-button').addEventListener('click', () => void this.requestResign());
    required('exit-button').addEventListener('click', () => void this.requestExit());
    required('result-home').addEventListener('click', () => this.exitGame());
    required('waiting-leave').addEventListener('click', () => this.exitGame());
    required('brand-home').addEventListener('click', () => void this.requestExit());
    required('room-info').addEventListener('click', () => void this.copyRoomCode());
    required('copy-room-code').addEventListener('click', () => void this.copyRoomCode());
    required('undo-accept').addEventListener('click', () => this.respondUndo(true));
    required('undo-decline').addEventListener('click', () => this.respondUndo(false));
    required('restart-accept').addEventListener('click', () => this.respondRestart(true));
    required('restart-decline').addEventListener('click', () => this.respondRestart(false));
    required<HTMLDialogElement>('undo-dialog').addEventListener('cancel', (event) => {
      event.preventDefault();
      this.respondUndo(false);
    });

    // 对局内 AI 分析：请求要对方同意，被请求方在弹窗里表态。
    required('ai-analysis-button').addEventListener('click', () => this.requestAiAnalysis());
    // 人机模式：本地引擎即时分析当前局面（手动触发、零服务端参与）。
    required('ai-evaluate-button').addEventListener('click', () => void this.requestAiSelfAnalysis());
    required('ai-analysis-accept').addEventListener('click', () => this.respondAiAnalysis(true));
    required('ai-analysis-decline').addEventListener('click', () => this.respondAiAnalysis(false));
    required<HTMLDialogElement>('ai-analysis-dialog').addEventListener('cancel', (event) => {
      event.preventDefault();
      this.respondAiAnalysis(false);
    });

    required('sound-button').addEventListener('click', () => {
      const muted = this.sounds.toggleMuted();
      this.renderSoundButton();
      toast(muted ? '音效已静音' : '柔和音效已开启');
    });
    required('camera-button').addEventListener('click', () => {
      this.scene.resetView();
      toast('已回到初始视角');
    });

    required('radio-button').addEventListener('click', (event) => {
      event.stopPropagation();
      const open = required('radio-card').hidden;
      // 起播只发生在这一个手势里：浏览器只认点击栈里的 play()。
      if (open) this.radio.begin();
      this.setRadioCard(open);
    });
    required('radio-card').addEventListener('click', () => this.radio.begin());
    required('radio-mute').addEventListener('click', () => this.radio.toggleMute());
    required<HTMLInputElement>('radio-volume').addEventListener('input', (event) => {
      this.radio.setVolume(Number((event.currentTarget as HTMLInputElement).value) / 100);
    });
    document.addEventListener('pointerdown', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      // 开局面板：点外部收起。
      if (!required('radio-card').hidden && !target?.closest('#radio-card, #radio-button')) {
        this.setRadioCard(false);
      }
      // 快捷短语菜单：点外部收起。
      if (!required('phrase-panel').hidden && !target?.closest('#phrase-zone')) {
        this.closePhrasePanel();
      }
    });

    required('shop-button').addEventListener('click', () => this.openShop());
    required('profile-button').addEventListener('click', () => void this.openProfileCard());
    required('lobby-profile').addEventListener('click', () => void this.openProfileCard());

    // 开局「决定先后手」：两位棋手各自选择希望谁先手。
    required('opening-self').addEventListener('click', () => this.sendOpeningChoice('self'));
    required('opening-opponent').addEventListener('click', () => this.sendOpeningChoice('opponent'));

    // 设置
    required('settings-button').addEventListener('click', () => this.openSettings());
    required('move-number-options').addEventListener('click', (event) => {
      const button = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>('[data-move-numbers]')
        : null;
      if (!button) return;
      this.setMoveNumberMode(normalizeMoveNumberMode(button.dataset.moveNumbers));
    });

    // 复盘：入口、列表、播放控制
    required('open-replays').addEventListener('click', () => void this.openReplayList());
    required('result-replay').addEventListener('click', () => void this.replayCurrentGame());
    required('replay-exit').addEventListener('click', () => this.exitReplay());
    required('replay-first').addEventListener('click', () => this.seekReplay(0));
    required('replay-prev').addEventListener('click', () => this.seekReplay(this.replayIndex - 1));
    required('replay-next').addEventListener('click', () => this.seekReplay(this.replayIndex + 1));
    required('replay-last').addEventListener('click', () => this.seekReplay(Number.MAX_SAFE_INTEGER));
    required('replay-toggle').addEventListener('click', () => this.toggleReplay());
    required('replay-ai').addEventListener('click', () => void this.requestReplaySuggestion());
    required('replay-keep').addEventListener('click', () => void this.toggleCurrentReplayFavorite());
    required('replay-continue').addEventListener('click', () => this.openContinueDialog());
    required('continue-sides').addEventListener('click', (event) => {
      const button = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>('[data-ai-color]')
        : null;
      const side = button?.dataset.aiColor;
      if (side === 'black' || side === 'white') void this.continueWithAi(side);
    });
    required('opponent-skin-options').addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-opponent-skin]');
      if (!button) return;
      this.setShowOpponentSkin(button.dataset.opponentSkin === 'on');
    });
    required('board-coords-options').addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-board-coords]');
      if (!button) return;
      this.setShowBoardCoordinates(button.dataset.boardCoords === 'on');
    });
    required<HTMLInputElement>('replay-slider').addEventListener('input', (event) => {
      this.stopReplayTimer();
      this.seekReplay(Number((event.currentTarget as HTMLInputElement).value));
    });
    // Esc 退出复盘：播放条不是 <dialog>，没有内建的关闭行为，得自己接一下。
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !this.replay) return;
      // 续弈弹窗开着时这一次 Esc 归弹窗：先关弹窗，别顺手把人踢出复盘。
      if (required<HTMLDialogElement>('continue-dialog').open) return;
      event.preventDefault();
      this.exitReplay();
    });
    required('replay-tabs').addEventListener('click', (event) => {
      const tab = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>('[data-replay-tab]')
        : null;
      const value = tab?.dataset.replayTab;
      if (value === 'all' || value === 'favorite' || value === 'ai' || value === 'online') {
        this.setReplayTab(value);
      }
    });
    required('replay-list').addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      // 收藏按钮在行内、但不在行按钮里（按钮不能嵌套按钮）：先处理它，再处理「打开」。
      const favButton = target?.closest<HTMLButtonElement>('[data-fav-id]');
      if (favButton) {
        const favId = favButton.dataset.favId;
        if (favId) void this.toggleReplayFavorite(favId, favButton);
        return;
      }
      const row = target?.closest<HTMLButtonElement>('[data-replay-id]');
      const gameId = row?.dataset.replayId;
      if (gameId) void this.startReplay(gameId);
    });
    // 快捷短语：收缩菜单。点触发按钮展开/收起；面板内用事件委托发送，
    // 发送后自动收起，点击面板外部也收起（见下方 document 监听），节省 UI 空间、不遮棋盘。
    const phraseToggle = required('phrase-toggle');
    phraseToggle.addEventListener('click', () => this.togglePhrasePanel());
    required('phrase-panel').addEventListener('click', (event) => {
      const chip = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.phrase-chip') : null;
      if (!chip) return;
      const phraseId = chip.dataset.phrase;
      if (phraseId) {
        this.sendPhrase(phraseId);
        this.closePhrasePanel();
      }
    });
  }

  private async setupRadio(): Promise<void> {
    const enabled = await this.radio.load();
    this.radio.observe(() => this.renderRadio());
    required('radio-button').hidden = !enabled;
    if (!enabled) return;
    const volume = required<HTMLInputElement>('radio-volume');
    volume.value = String(Math.round(this.radio.state().volume * 100));
    this.renderRadio();
  }

  private setRadioCard(open: boolean): void {
    required('radio-card').hidden = !open;
    required('radio-button').setAttribute('aria-expanded', String(open));
  }

  private renderRadio(): void {
    const state = this.radio.state();
    const button = required('radio-button');
    button.hidden = !state.enabled;
    button.classList.toggle('playing', state.playing && !state.muted);

    const track = required('radio-track');
    if (state.playing) {
      track.textContent = state.title ?? '正在播放';
    } else if (!state.started) {
      track.textContent = '点按开始收听';
    } else {
      track.textContent = '正在对齐电台…';
    }
    track.title = state.title ?? '';

    // 艺术家只在真的在播、且确实读到了标签时出现。
    const artist = required('radio-artist');
    artist.textContent = state.playing ? state.artist ?? '' : '';
    artist.hidden = artist.textContent === '';
    artist.title = artist.textContent;

    const mute = required('radio-mute');
    const silent = state.muted || state.volume === 0;
    mute.innerHTML = icon(silent ? 'muted' : 'sound');
    mute.title = state.muted ? '取消静音' : '静音';
    mute.setAttribute('aria-label', mute.title);
    mute.classList.toggle('muted', silent);

    const percent = Math.round(state.volume * 100);
    const volume = required<HTMLInputElement>('radio-volume');
    if (document.activeElement !== volume) volume.value = String(percent);
    volume.style.setProperty('--level', `${percent}%`);
    required('radio-percent').textContent = String(percent);
  }

  private startLocal(): void {
    // 开局弹窗里选的棋境；「随机」或没选就是 undefined，由 LocalGameState 自己抽。
    const scene = readSceneChoice('local-scene') ?? undefined;
    const rule = readRuleChoice('local');
    this.leaveRemoteSilently();
    localStorage.removeItem('yijing-active-game');
    localStorage.removeItem('yijing-room-code');
    this.awaitingRemoteGame = false;
    this.setSnapshot(this.localGame.start(scene, rule ?? undefined));
    required<HTMLDialogElement>('game-dialog').close();
    toast(`本地对弈开始 · ${sceneName(this.localGame.currentScene)}`);
  }

  /** 打开 AI 弹窗时恢复上局参数（黑白 / 禁手 / 棋境）。 */
  private restoreAiParams(): void {
    try {
      const raw = localStorage.getItem('yijing.ai-params');
      if (!raw) return;
      const params = JSON.parse(raw) as { color?: string; rule?: string; scene?: string };
      if (params.color === 'white' || params.color === 'black') {
        const input = document.querySelector<HTMLInputElement>(`input[name="ai-color"][value="${params.color}"]`);
        if (input) input.checked = true;
      }
      if (params.rule === 'renju' || params.rule === 'freestyle') {
        const input = document.querySelector<HTMLInputElement>(`input[name="ai-rule"][value="${params.rule}"]`);
        if (input) input.checked = true;
      }
      if (params.scene && params.scene !== 'random') {
        const input = document.querySelector<HTMLInputElement>(`input[name="ai-scene"][value="${params.scene}"]`);
        if (input && !input.disabled) input.checked = true;
      }
    } catch {
      /* 脏数据忽略，走默认值 */
    }
  }

  /** 依快照同步执子权勾选框的显隐与状态。 */
  private renderAiSidePicker(): void {
    const picker = document.getElementById('ai-side-picker');
    if (!picker) return;
    const snapshot = this.snapshot;
    const visible = snapshot?.mode === 'ai' && !snapshot.spectating && snapshot.status === 'playing';
    picker.hidden = !visible;
    if (!visible || !snapshot) return;
    const black = required<HTMLInputElement>('ai-side-black');
    const white = required<HTMLInputElement>('ai-side-white');
    // 用户刚点完勾选框（焦点还在）时不回写，避免打断交互。
    if (document.activeElement !== black) black.checked = snapshot.aiBlack === true;
    if (document.activeElement !== white) white.checked = snapshot.aiWhite === true;
  }

  private handleAiSideChange(): void {
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.mode !== 'ai' || snapshot.status !== 'playing') return;
    const aiBlack = required<HTMLInputElement>('ai-side-black').checked;
    const aiWhite = required<HTMLInputElement>('ai-side-white').checked;
    this.socket.aiConfig(snapshot.id, aiBlack, aiWhite);
    if (aiBlack && aiWhite) toast('观赏模式 · AI 黑白轮番对弈');
    else if (!aiBlack && !aiWhite) toast('编辑模式 · AI 已退出，可自由落子');
  }

  private openGameDialog(mode: 'local' | 'ai' | 'online'): void {
    required('local-options').hidden = mode !== 'local';
    required('ai-options').hidden = mode !== 'ai';
    required('online-options').hidden = mode !== 'online';
    if (mode === 'ai') this.restoreAiParams();
    required('ai-error').textContent = '';
    required('local-error').textContent = '';
    required('online-error').textContent = '';
    required('online-auth-note').textContent = this.user
      ? `将以「${this.user.name}」的身份联机对弈。`
      : '尚未建立会话。大厅与房间号都需要一个身份，游客也可以。';
    if (mode === 'online') {
      this.setLobbyTab('hall');
      this.renderLobby();
    } else {
      this.stopLobbyWatch();
    }
    // 三个弹窗都有棋境选择，都要过一遍解锁状态：商城刚解锁的棋境在这里解锢。
    this.refreshScenePickerLock();
    // 先开窗再订阅：名单推送只会在面板已打开时被渲染，早一步到就白丢了。
    required<HTMLDialogElement>('game-dialog').showModal();
    if (mode === 'online') this.startLobbyWatch();
  }

  private setLobbyTab(tab: 'hall' | 'room'): void {
    this.lobbyTab = tab;
    document.querySelectorAll<HTMLButtonElement>('[data-lobby-tab]').forEach((button) => {
      button.classList.toggle('active', (button.dataset.lobbyTab === 'room') === (tab === 'room'));
    });
    required('lobby-hall').hidden = tab !== 'hall';
    required('lobby-room').hidden = tab !== 'room';
    required('online-error').textContent = '';
  }

  /** 大厅用订阅式推送：打开面板就连上，关掉就断开，中间每 5 秒做一次兜底刷新。 */
  private startLobbyWatch(): void {
    this.refreshLobby();
    if (this.lobbyTimer !== null) window.clearInterval(this.lobbyTimer);
    this.lobbyTimer = window.setInterval(() => this.refreshLobby(), LOBBY_POLL_MS);
  }

  private stopLobbyWatch(): void {
    if (this.lobbyTimer !== null) {
      window.clearInterval(this.lobbyTimer);
      this.lobbyTimer = null;
    }
    this.trySend('lobby.watch', { on: false });
  }

  private refreshLobby(): void {
    if (!this.user) {
      this.renderLobby();
      return;
    }
    // 房间号页签下不需要名单，省掉每 5 秒一次的无效拉取。
    if (this.lobbyTab !== 'hall') return;
    if (!this.trySend('lobby.watch', { on: true })) {
      required('lobby-count-text').textContent = '正在连接大厅…';
    }
  }

  private handleLobby(roster: LobbyRoster): void {
    this.roster = roster;
    if (required<HTMLDialogElement>('game-dialog').open) this.renderLobby();
  }

  private renderLobby(): void {
    const list = required('lobby-list');
    const empty = required('lobby-empty');
    const emptyText = required('lobby-empty-text');
    const enter = required<HTMLButtonElement>('lobby-enter');
    const countText = required('lobby-count-text');
    list.replaceChildren();

    if (!this.user) {
      countText.textContent = '尚未建立会话';
      emptyText.textContent = '进入大厅需要一个身份，游客也可以。';
      enter.hidden = false;
      empty.hidden = false;
      return;
    }
    enter.hidden = true;
    const roster = this.roster;
    if (!roster) {
      countText.textContent = this.connectionStatus === 'connected' ? '正在读取大厅…' : '正在连接大厅…';
      emptyText.textContent = '';
      empty.hidden = true;
      return;
    }

    const { players, counts } = roster;
    const me = players.find((player) => player.id === this.user?.id);
    const others = players.filter((player) => player.id !== this.user?.id);
    // 「可约战」要对看的人有意义，所以不把「自己」算进去。
    const idleOthers = others.filter((player) => player.status === 'idle').length;
    countText.textContent = counts.online <= 1
      ? '此刻大厅只有你一人'
      : idleOthers === 0
        ? `${counts.online} 人在线 · 暂无空闲棋友`
        : `${counts.online} 人在线 · ${idleOthers} 人可约战`;
    if (me) list.append(this.lobbyRow(me, true));
    for (const player of others) list.append(this.lobbyRow(player, false));
    empty.hidden = others.length > 0;
    emptyText.textContent = '此刻大厅只有你一人，切到「房间号」邀请好友吧。';
  }

  private lobbyRow(player: LobbyPlayer, isSelf: boolean): HTMLLIElement {
    const row = document.createElement('li');
    row.className = `lobby-row${isSelf ? ' self' : ''}${player.status === 'idle' ? '' : ' busy'}`;

    const avatar = document.createElement('span');
    avatar.className = `lobby-avatar${player.guest ? ' guest' : ''}`;
    avatar.textContent = player.name.slice(0, 1).toUpperCase();

    const name = document.createElement('span');
    name.className = 'lobby-name';
    const fullName = document.createElement('span');
    fullName.className = 'lobby-fullname';
    fullName.textContent = player.name;
    name.append(fullName);
    if (!isSelf && player.guest) {
      const tag = document.createElement('small');
      tag.textContent = '游客';
      name.append(tag);
    }

    // 自己那一行不放「可约战」：它会被读成「我可以约自己」。第三列统一成状态位，
    // 按钮列才不会因为少一个按钮而错位。
    const state = document.createElement('span');
    state.className = `lobby-state ${isSelf ? 'self' : player.status}`;
    state.textContent = isSelf ? '本人' : STATUS_LABEL[player.status];

    // 头像 / 昵称可点开名片：大厅里就能看别人的战绩（自己那行则是看自己的）。
    const openProfile = (): void => {
      void this.openProfileCard({ id: player.id, name: player.name });
    };
    avatar.classList.add('clickable');
    name.classList.add('clickable');
    avatar.title = '查看名片';
    name.title = '查看名片';
    avatar.addEventListener('click', openProfile);
    name.addEventListener('click', openProfile);

    row.append(avatar, name, state);
    if (isSelf) return row;
    if (player.status === 'idle') {
      const button = document.createElement('button');
      button.className = 'secondary-button lobby-invite';
      button.textContent = '约战';
      button.disabled = this.snapshot !== null;
      button.addEventListener('click', () => this.sendChallenge(player, button));
      row.append(button);
    } else if ((player.status === 'playing' || player.status === 'watching') && player.gameId) {
      // 对弈中的人没有第二张棋盘，但他那盘棋可以给第三个人看；
      // 已经在看棋的人给个入口直接跳到同一盘棋（多个人看同一盘是允许的）。
      const gameId = player.gameId;
      const button = document.createElement('button');
      button.className = 'secondary-button lobby-invite lobby-watch';
      button.textContent = '观战';
      button.disabled = this.snapshot !== null && this.snapshot.spectating !== true;
      button.addEventListener('click', () => void this.watchGame(gameId, button));
      row.append(button);
    }
    return row;
  }

  private async watchGame(gameId: string, button: HTMLButtonElement): Promise<void> {
    required('online-error').textContent = '';
    setBusy(button, true, '进入…');
    try {
      await this.withSession(() => {
        this.awaitingRemoteGame = true;
        this.socket.send('spectate.join', { gameId });
        required<HTMLDialogElement>('game-dialog').close();
      });
    } catch (error) {
      setBusy(button, false);
      required('online-error').textContent = this.errorMessage(error);
    }
  }

  private sendChallenge(player: LobbyPlayer, button: HTMLButtonElement): void {
    required('online-error').textContent = '';
    // 棋境与读秒都是发起方定、接受即沿用的条件。这里只取棋境而不复用
    // `scenePayload`：那个还会带上别处弹窗残留的规则单选，而约战协议目前
    // 不接规则面，多发一个字段只会让服务端读到一份没人选的规则。
    const scene = readSceneChoice('online-scene');
    if (!this.trySend('challenge.create', {
      targetId: player.id,
      ...(scene ? { scene } : {}),
      ...this.timeControlPayload(),
    })) {
      required('online-error').textContent = '与服务器的连接尚未就绪，请稍后重试';
      return;
    }
    setBusy(button, true, '邀请中…');
  }

  private async enterLobby(): Promise<void> {
    if (this.user) return;
    try {
      await this.withSession(() => this.refreshLobby());
      this.renderLobby();
      required('online-auth-note').textContent = `将以「${this.currentName()}」的身份联机对弈。`;
    } catch (error) {
      toast(this.errorMessage(error), 'error');
    }
  }

  private handleChallengeSent(sent: ChallengeSent): void {
    this.outgoing = sent.challengeId;
    this.sentWindow = Math.max(3_000, sent.expiresInMs);
    required('challenge-sent-name').textContent = sent.target.name;
    required<HTMLDialogElement>('game-dialog').close();
    required('challenge-sent').hidden = false;
    this.startSentCountdown();
    toast(`约战已送达「${sent.target.name}」，等待回应`);
  }

  private handleChallengeInvite(invite: ChallengeInvite): void {
    // 正在对局的人没有第二张棋盘，直接回绝比让邀请挂在屏幕上更诚实。
    if (this.snapshot && this.snapshot.status === 'playing') {
      this.trySend('challenge.respond', { challengeId: invite.challengeId, accept: false });
      toast(`「${invite.from.name}」想约你，但你正在对局中`);
      return;
    }
    if (this.incoming) {
      this.trySend('challenge.respond', { challengeId: invite.challengeId, accept: false });
      return;
    }
    this.incoming = invite;
    this.incomingWindow = Math.max(3_000, invite.expiresInMs);
    required('challenge-from-name').textContent = invite.from.name;
    // 对方开的对局条件要提前说清：接受即沿用，等下完一局再告诉人「这局限时
    // 30 秒、在赛博棋境里下」就晚了——那局可能已经因为想太久输掉了。
    required('challenge-condition-scene').textContent = invite.scene
      ? sceneName(coerceSceneId(invite.scene))
      : '随机';
    required('challenge-condition-value').textContent = timeControlLabel(invite.timeControl);
    required<HTMLDialogElement>('challenge-dialog').showModal();
    this.startIncomingCountdown();
    this.sounds.play('join');
  }

  private startIncomingCountdown(): void {
    this.incomingDeadline = Date.now() + this.incomingWindow;
    this.stopIncomingTicker();
    this.tickIncomingCountdown();
    this.incomingTicker = window.setInterval(() => this.tickIncomingCountdown(), 250);
  }

  private tickIncomingCountdown(): void {
    const remaining = Math.max(0, this.incomingDeadline - Date.now());
    const ratio = Math.max(0, Math.min(1, remaining / this.incomingWindow));
    required('challenge-countdown').textContent = `${Math.ceil(remaining / 1000)} 秒内回应`;
    required('challenge-meter-bar').style.transform = `scaleX(${ratio})`;
    // 到点只收起界面：作废由服务端裁定，随后会推来 expired 结果。
    if (remaining <= 0) this.closeChallengeDialog();
  }

  private startSentCountdown(): void {
    this.sentDeadline = Date.now() + this.sentWindow;
    this.stopSentTicker();
    this.tickSentCountdown();
    this.sentTicker = window.setInterval(() => this.tickSentCountdown(), 250);
  }

  private tickSentCountdown(): void {
    const remaining = Math.max(0, this.sentDeadline - Date.now());
    required('challenge-sent-timer').textContent = String(Math.ceil(remaining / 1000));
    if (remaining <= 0) this.closeSentCard();
  }

  private stopIncomingTicker(): void {
    if (this.incomingTicker !== null) {
      window.clearInterval(this.incomingTicker);
      this.incomingTicker = null;
    }
  }

  private stopSentTicker(): void {
    if (this.sentTicker !== null) {
      window.clearInterval(this.sentTicker);
      this.sentTicker = null;
    }
  }

  private respondChallenge(accept: boolean): void {
    const invite = this.incoming;
    this.closeChallengeDialog();
    if (!invite) return;
    if (accept) {
      // 接受后棋局快照可能先于回执到达，先认领再发送，否则快照会被当成无关推送丢弃。
      this.awaitingRemoteGame = true;
      this.challengeJustAccepted = true;
      // 大厅弹窗立刻收起：等快照回来再关会有一瞬间盖着棋盘。
      this.closeLobbyDialog();
      toast('正在开局…');
    }
    if (!this.trySend('challenge.respond', { challengeId: invite.challengeId, accept })) {
      this.awaitingRemoteGame = false;
      this.challengeJustAccepted = false;
      toast('连接已断开，约战没能送达', 'error');
      return;
    }
    // 回执发出去之后才收复盘：发送失败时不该把玩家从棋谱里踢出来。
    if (accept) this.leaveReplayForNewGame();
  }

  private cancelChallenge(): void {
    const challengeId = this.outgoing;
    this.closeSentCard();
    if (challengeId) this.trySend('challenge.cancel', { challengeId });
  }

  private closeChallengeDialog(): void {
    this.incoming = null;
    this.stopIncomingTicker();
    const dialog = required<HTMLDialogElement>('challenge-dialog');
    if (dialog.open) dialog.close();
  }

  /**
   * 收起大厅 / 模式选择弹窗。
   *
   * 在大厅里应邀（或对方接受我的约战）之后，棋局已经开局，但大厅弹窗还开着，
   * 会整个盖在棋盘上——看起来就像「应邀的窗口不消失」。进入新对局时必须收掉它；
   * 关闭本身会触发 `close` 监听，顺带停止大厅订阅。
   */
  private closeLobbyDialog(): void {
    const dialog = required<HTMLDialogElement>('game-dialog');
    if (dialog.open) dialog.close();
  }

  private closeSentCard(): void {
    this.outgoing = null;
    this.stopSentTicker();
    required('challenge-sent').hidden = true;
  }

  private handleChallengeResult(result: ChallengeResult): void {
    if (result.status === 'accepted') {
      this.closeSentCard();
      this.closeChallengeDialog();
      this.closeLobbyDialog();
      if (result.gameId && this.snapshot?.id === result.gameId) return;
      this.awaitingRemoteGame = true;
      this.challengeJustAccepted = true;
      // 我在复盘时对方接受了我的邀战：同样要先收掉复盘，
      // 否则新棋局的快照会被 handleRemoteSnapshot 的 replay 闸门拦掉。
      this.leaveReplayForNewGame();
      return;
    }
    if (result.status === 'declined') {
      this.closeSentCard();
      if (!result.byMe) toast(result.byName ? `「${result.byName}」婉拒了这次约战` : '对方婉拒了这次约战');
      return;
    }
    if (result.status === 'expired') {
      this.closeSentCard();
      this.closeChallengeDialog();
      toast('这场约战已超时作废');
      return;
    }
    this.closeSentCard();
    this.closeChallengeDialog();
    if (!result.byMe && result.reason && result.reason !== '对局已开始') toast(result.reason);
  }

  private trySend(type: string, payload: Record<string, unknown> = {}): boolean {
    try {
      this.socket.send(type, payload);
      return true;
    } catch {
      return false;
    }
  }

  private currentName(): string {
    return this.user?.name ?? '棋友';
  }

  /**
   * 读一处棋境选择 + 一处规则选择，产出要放进建局报文的字段。
   *
   * 选了「随机」时这里返回**空对象**而不是 `{ scene: null }`：服务端对缺字段
   * 的处理是「自己抽签」，而对 null 的处理是「用默认值」。随机眼看莫名其妙
   * 地变成每局都进茶室，就是从这种一字之差里长出来的。
   *
   * @param sceneGroup 棋境单选的 name
   * @param ruleGroup 规则单选的 name（`<group>-rule`），与棋境组名不一定同源
   *        ——联机弹窗里棋境叫 `online-scene`，规则却挂在 `room` 组下。
   */
  private scenePayload(sceneGroup: string, ruleGroup: string): { scene?: string; rule?: string } {
    const scene = readSceneChoice(sceneGroup);
    const rule = readRuleChoice(ruleGroup);
    return { ...(scene ? { scene } : {}), ...(rule ? { rule } : {}) };
  }

  /**
   * 建房 / 约战的读秒选择。
   *
   * 选了「不限时」时返回**空对象**，与棋境的处理同理：缺字段让服务端按自己的
   * 默认值走，而不是把「none」这个常量从客户端再声明一遍——将来服务端改默认值
   * 时，老客户端不该继续把旧默认值钉死。
   */
  private timeControlPayload(): { timeControl?: TimeControl } {
    const choice = readTimeChoice('online');
    return choice ? { timeControl: choice } : {};
  }

  private async startAi(): Promise<void> {
    const selected = document.querySelector<HTMLInputElement>('input[name="ai-color"]:checked');
    const color = selected?.value === 'white' ? 'white' : 'black';
    // 记住本局参数，下次打开 AI 弹窗默认带上（用户要求「默认记忆上局参数」）。
    localStorage.setItem('yijing.ai-params', JSON.stringify({
      color,
      rule: readRuleChoice('ai'),
      scene: readSceneChoice('ai-scene'),
    }));
    const button = required<HTMLButtonElement>('start-ai');
    setBusy(button, true, '正在创建棋局…');
    try {
      await this.withSession(() => {
        this.awaitingRemoteGame = true;
        this.socket.send('ai.create', { color, ...this.scenePayload('ai-scene', 'ai') });
        required<HTMLDialogElement>('game-dialog').close();
        toast(color === 'black' ? '棋局已创建，你执黑先行' : '棋局已创建，你执白后行');
      });
    } catch (error) {
      required('ai-error').textContent = this.errorMessage(error);
    } finally {
      setBusy(button, false);
    }
  }

  private async createRoom(): Promise<void> {
    const button = required<HTMLButtonElement>('create-room');
    setBusy(button, true, '正在创建…');
    try {
      await this.withSession(() => {
        this.awaitingRemoteGame = true;
        this.socket.send('room.create', { ...this.scenePayload('online-scene', 'room'), ...this.timeControlPayload() });
        required<HTMLDialogElement>('game-dialog').close();
      });
    } catch (error) {
      required('online-error').textContent = this.errorMessage(error);
    } finally {
      setBusy(button, false);
    }
  }

  private async joinRoom(event: Event): Promise<void> {
    event.preventDefault();
    const input = required<HTMLInputElement>('room-code-input');
    const code = input.value.trim().toUpperCase();
    if (!code) return;
    const button = this.joinSubmitButton();
    setBusy(button, true, '加入中…');
    try {
      await this.withSession(() => {
        this.awaitingRemoteGame = true;
        this.socket.send('room.join', { code });
        required<HTMLDialogElement>('game-dialog').close();
      });
    } catch (error) {
      required('online-error').textContent = this.errorMessage(error);
    } finally {
      setBusy(button, false);
    }
  }

  private async withSession(action: () => void): Promise<void> {
    if (!this.user) {
      this.user = await this.auth.guest();
      this.sessionReady = false;
      this.renderAccount();
      toast(`已以游客「${this.user?.name ?? '棋友'}」身份进入`);
    }
    if (this.sessionReady && this.connectionStatus === 'connected') {
      action();
      return;
    }
    this.pendingAfterSession = action;
    this.socket.connect();
  }

  private handleSession(user: SessionUser | null, games: GameSnapshot[]): void {
    this.user = user;
    this.sessionReady = true;
    this.renderAccount();
    // 钱包（积分 + 已解锁 + 皮肤）与显示设置都是服务端权威数据，登录即同步。
    if (user) {
      void this.refreshWallet();
      void this.syncPreferencesFromServer();
    }

    const savedGameId = localStorage.getItem('yijing-active-game');
    const savedRoom = localStorage.getItem('yijing-room-code');
    const currentId = this.snapshot?.mode === 'local' ? null : this.snapshot?.id;
    // 复盘期间不自动恢复棋局，否则刚打开棋谱就被拽回自己的棋盘。
    const restored = this.replay ? undefined : games.find((game) => game.id === savedGameId || game.id === currentId)
      ?? (!this.snapshot && savedRoom ? games.find((game) => game.roomCode === savedRoom) : undefined);
    if (restored && (this.snapshot?.mode !== 'local' || this.awaitingRemoteGame)) {
      this.awaitingRemoteGame = false;
      this.setSnapshot(restored);
      toast('已恢复上次的棋局');
    } else if (!this.snapshot && savedRoom && !restored) {
      try {
        this.awaitingRemoteGame = true;
        this.socket.send('room.resume', { code: savedRoom });
      } catch {
        this.awaitingRemoteGame = false;
      }
    }

    const pending = this.pendingAfterSession;
    this.pendingAfterSession = null;
    pending?.();
    // 重连后服务端的连接登记已经清空：棋手要重新报座位，观战者要重新入席，
    // 否则画面还停在掉线前那一手，之后再也不动。
    if (this.snapshot && this.snapshot.mode !== 'local') {
      if (!this.snapshot.spectating) {
        this.trySend('game.focus', { gameId: this.snapshot.id });
      } else if (this.snapshot.status === 'playing') {
        this.trySend('spectate.join', { gameId: this.snapshot.id });
      }
    }
    // 订阅标记也会丢，重新挂一次，否则大厅会停在离线前那一帧。
    if (!required('online-options').hidden) this.refreshLobby();
  }

  private handleRemoteSnapshot(snapshot: GameSnapshot): void {
    // 当前不在任何对局里：只有「主动发起」的建房 / 加入 / 断线恢复才接受推送。
    //
    // 这一条是「退出后回不到模式选择」的根因所在：玩家点退出时把 snapshot 置空，
    // 但服务器那边的对局还活着（AI 可能还在思考、联机对手也可能刚落了子），
    // 它一广播，这里的前两条判断全部落空，快照被原样接收，
    // 玩家就在欢迎页被硬生生拽回棋盘，看起来就是「退不出去」。
    // 复盘时 snapshot 是空的，但这不是「我刚退出」，而是「我在看别人的棋」。
    // 不挡住的话，后台推送会把正在复盘的棋盘换掉。
    if (this.replay) return;
    if (!this.snapshot && !this.awaitingRemoteGame) return;
    if (this.snapshot?.mode === 'local' && !this.awaitingRemoteGame) return;
    if (this.snapshot && this.snapshot.mode !== 'local' && this.snapshot.id !== snapshot.id && !this.awaitingRemoteGame) return;
    this.awaitingRemoteGame = false;
    this.setSnapshot(snapshot);
    this.applySkins();
    // 人机局轮到 AI：着法由本地 Rapfi 引擎计算后提交（观战者没有引擎）。
    if (
      snapshot.mode === 'ai' && snapshot.aiThinking && snapshot.status === 'playing'
      && !snapshot.spectating
    ) {
      void this.runClientAiTurn(snapshot);
    }
  }

  private setSnapshot(snapshot: AnyGameSnapshot): void {
    const previous = this.snapshot;
    this.snapshot = snapshot;
    // 换了一盘新棋（含大厅应邀、观战、房间加入）：大厅 / 模式弹窗必须收掉，
    // 否则它会浮在棋盘上，看起来像「窗口没消失」。
    if (previous?.id !== snapshot.id) this.closeLobbyDialog();
    // 引擎思考面板属于「自己在下的人机局」与「本地对弈的手动 AI 分析」；
    // 观战/联机一律收起，换到另一盘棋时旧分析也已过时，一并清掉。
    const engineEligible = !snapshot.spectating && (snapshot.mode === 'ai' || snapshot.mode === 'local');
    if (!engineEligible || (previous && previous.id !== snapshot.id)) {
      const panel = document.getElementById('engine-panel');
      if (panel) {
        panel.hidden = true;
        panel.innerHTML = '';
      }
      this.engineInfo = {};
    }
    // 记录开局协商状态；本地对弈没有这一步，强置 null。
    this.opening = snapshot.mode === 'local' ? null : (snapshot.opening ?? null);
    // 观战不留恢复点：那不是「我的棋局」，下次打开页面也不该被拽回别人的棋盘。
    if (snapshot.mode !== 'local' && !snapshot.spectating) {
      localStorage.setItem('yijing-active-game', snapshot.id);
      if (snapshot.roomCode) localStorage.setItem('yijing-room-code', snapshot.roomCode);
      else localStorage.removeItem('yijing-room-code');
    }
    if (this.challengeJustAccepted) {
      this.challengeJustAccepted = false;
      if (snapshot.mode === 'online' && snapshot.yourColor) {
        toast('约战成立 · 开局先手由双方决定');
      }
    }
    if (snapshot.spectating) this.closeChallengeDialog();
    // 告诉大厅「我坐上棋盘了」。服务端以此为座位判据，这样被遗弃的棋局
    // 不会让人永远显示成「对弈中」。观战者没坐下，不能占座。
    if (snapshot.mode !== 'local' && !snapshot.spectating) this.trySend('game.focus', { gameId: snapshot.id });

    // 落子音不在这里立刻响，而是交给棋盘：等新棋子砸到盘面、涟漪扩散出来那一刻
    // 才触发（见 BoardManager.playDrop 落地回调）。否则棋子还在半空、涟漪还没出现，
    // 啪的一声就先响了，听感和画面会脱节。只在「同一局、确实多了一手」时才挂回调。
    const onStoneLand = previous?.id === snapshot.id
      && snapshot.moveCount > previous.moveCount
      && snapshot.lastMove
      ? (color: 1 | 2) => this.sounds.play(color === 1 ? 'black' : 'white')
      : undefined;
    if (snapshot.status === 'finished' && previous?.status !== 'finished' && snapshot.winner !== 0) {
      this.sounds.play('victory');
    }
    this.syncPresence(snapshot);
    this.syncClock(snapshot);
    // 棋境跟着快照走。换了一局（或换了个房间）才换景，同一局内重复推送的
    // 快照不会触发重建——否则每落一子都要把整套家具拆了重装。
    const sceneId = coerceSceneId(snapshot.scene);
    this.scene.setScene(sceneId);
    this.scene.setSnapshot(snapshot, onStoneLand);
    // 一局结束发放积分（同一局只结算一次）。
    if (snapshot.status === 'finished' && previous && previous.status === 'playing') {
      this.onGameSettled(snapshot);
    }
    this.render();
    this.showSnapshotUndoRequest();
    this.showSnapshotRestartRequest();
  }

  private makeMove(row: number, col: number): void {
    const snapshot = this.snapshot;
    if (!snapshot || !this.canMove()) return;
    try {
      if (snapshot.mode === 'local') {
        this.setSnapshot(this.localGame.move(row, col));
      } else {
        this.socket.send('game.move', { gameId: snapshot.id, row, col });
        this.scene.setInteractive(false);
      }
    } catch (error) {
      this.sounds.play('error');
      toast(this.errorMessage(error), 'error');
      this.render();
    }
  }

  private canMove(): boolean {
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.status !== 'playing') return false;
    // 开局协商或硬币揭晓期间，棋盘不可落子：先手还没定下来。
    if (this.opening || this.coinActive) return false;
    if (snapshot.mode === 'local') return true;
    if (snapshot.mode === 'ai') {
      // 人机局：落子权跟当前轮次方走（编辑模式下玩家可替任意一方落子）；
      // aiThinking 为真表示当前轮次方由 AI 执子，棋盘锁定。
      return !snapshot.aiThinking;
    }
    return snapshot.yourColor === snapshot.currentPlayer && !snapshot.aiThinking;
  }

  // ------------------------------------------------------------------
  // 开局「决定先后手」：选择提交与揭晓动画
  // ------------------------------------------------------------------
  private sendOpeningChoice(choice: 'self' | 'opponent'): void {
    const snapshot = this.snapshot;
    // 只有协商进行中、且自己还没选过时才能提交。
    if (!snapshot || !this.opening || this.opening.youChose) return;
    try {
      this.socket.send('game.first_move_choice', { gameId: snapshot.id, choice });
      // 乐观更新，服务端回包会二次确认；即便失败，下一步快照也会把状态纠正回来。
      this.opening = { ...this.opening, youChose: choice };
      this.render();
    } catch (error) {
      this.sounds.play('error');
      toast(this.errorMessage(error), 'error');
    }
  }

  private handleOpeningResult(result: OpeningResult): void {
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.mode === 'local' || result.gameId !== snapshot.id) return;
    // 进入揭晓阶段：收起选择面板、锁定落子，交给硬币或「双方一致」提示。
    this.opening = null;
    this.openingResult = result;
    this.coinActive = true;
    this.openingToken += 1;
    const token = this.openingToken;
    this.render();
    void this.playOpeningReveal(token, result);
  }

  private async playOpeningReveal(token: number, result: OpeningResult): Promise<void> {
    const firstName = result.seats[result.firstSeat]?.name ?? '先手';
    if (result.method === 'coin') {
      const wrap = required('coin-canvas-wrap');
      // 懒加载硬币场景：它只在揭晓这一刻被拉起来，用完后由 finishOpening 释放。
      if (!this.coin) this.coin = new CoinScene(wrap, { reducedMotion: this.reducedMotion });
      await this.coin.play({ firstSeat: result.firstSeat, nameA: result.seats.a.name, nameB: result.seats.b.name });
      if (token !== this.openingToken) return;
      required('opening-result').textContent = `硬币落地 · ${firstName} 先手`;
      this.sounds.play('join');
    }
    // agreement 不抛硬币，先手结果由 render() 写进 opening-status。
    // 硬币需要更长的停留：停稳后镜头还要推近，玩家得看清名字。
    const holdMs = this.reducedMotion ? 950 : (result.method === 'coin' ? 2400 : 1700);
    await this.delay(holdMs);
    if (token !== this.openingToken) return;
    await this.finishOpening();
  }

  /**
   * 收场：先让整块开局遮罩淡出、硬币轻微缩小，再释放 WebGL 与隐藏。
   *
   * 直接 `hidden` + `dispose()` 会让画面「啪」地跳回棋盘，所以退场要留一点时间。
   * 减少动态效果时跳过动画，立即收场。
   */
  private async finishOpening(): Promise<void> {
    const overlay = required('opening-overlay');
    const wrap = required('coin-canvas-wrap');
    const animate = !this.reducedMotion && !overlay.hidden;
    if (animate) {
      overlay.classList.add('leaving');
      wrap.classList.add('leaving');
      await this.delay(280);
      overlay.classList.remove('leaving');
      wrap.classList.remove('leaving');
    }

    const coin = this.coin;
    this.coin = null;
    this.coinActive = false;
    this.openingResult = null;
    required('opening-result').textContent = '';
    coin?.dispose();
    this.render();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  private async requestRestart(force = false): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.status === 'waiting') return;
    // 联机 PVP：重开需要对方同意。
    if (snapshot.mode === 'online') {
      // 自己已发起请求 → 再点一次取消（后端 toggle）。
      if (snapshot.restartPending) {
        this.socket.send('game.restart', { gameId: snapshot.id });
        return;
      }
      // 对方已发起请求、正等你回应时，重开按钮是禁用的，这里作为兜底直接返回。
      if (snapshot.restartRequest) return;
      if (!force && snapshot.moveCount > 0 && snapshot.status !== 'finished') {
        const accepted = await confirmAction(
          '请求重开本局？',
          '将向对方发送重开请求，需对方同意后才清空棋盘与落子历史。',
          '发送请求',
        );
        if (!accepted) return;
      }
      try {
        this.socket.send('game.restart', { gameId: snapshot.id });
        required('result-card').hidden = true;
      } catch (error) {
        toast(this.errorMessage(error), 'error');
      }
      return;
    }
    // 本地 / 人机：原逻辑，立即重开。
    if (!force && snapshot.moveCount > 0 && snapshot.status !== 'finished') {
      // 残局局重开不是「清空棋盘」，而是「再练一次同一道题」——文案跟着说，
      // 否则玩家会以为重开之后就回到空盘了。
      const startPly = snapshot.startPly ?? 0;
      const accepted = await confirmAction(
        '重新开始这一局？',
        startPly > 0
          ? `将回到第 ${startPly} 手的残局起点，本局落的子会被清空。`
          : '当前棋盘与落子历史将被清空，此操作需要重新开始。',
        '确认重开',
      );
      if (!accepted) return;
    }
    try {
      if (snapshot.mode === 'local') this.setSnapshot(this.localGame.start(this.localGame.currentScene, this.localGame.currentRule));
      else this.socket.send('game.restart', { gameId: snapshot.id });
      required('result-card').hidden = true;
    } catch (error) {
      toast(this.errorMessage(error), 'error');
    }
  }

  private requestUndo(): void {
    const snapshot = this.snapshot;
    if (!snapshot?.canUndo) {
      this.sounds.play('error');
      toast('现在没有可以撤回的落子', 'error');
      return;
    }
    try {
      if (snapshot.mode === 'local') {
        this.setSnapshot(this.localGame.undo());
        toast('已撤回上一步');
      } else {
        this.socket.send('game.undo', { gameId: snapshot.id });
        toast(snapshot.mode === 'online' ? '悔棋请求已发送，等待对方回应' : '已请求撤销上一轮');
      }
    } catch (error) {
      this.sounds.play('error');
      toast(this.errorMessage(error), 'error');
    }
  }

  private async requestResign(): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.status !== 'playing') return;
    const accepted = await confirmAction('确认认输？', '棋局有胜负，心境无得失。确认后将立即结束本局。', '确认认输');
    if (!accepted) return;
    try {
      if (snapshot.mode === 'local') this.setSnapshot(this.localGame.resign());
      else this.socket.send('game.resign', { gameId: snapshot.id });
    } catch (error) {
      toast(this.errorMessage(error), 'error');
    }
  }

  private async requestExit(): Promise<void> {
    // 复盘不是棋局：没有「要不要放弃」的问题，直接退回原处。
    if (this.replay) {
      this.exitReplay();
      return;
    }
    if (!this.snapshot) {
      this.scene.resetView();
      return;
    }
    // 观战随时可以走：既没有对局要结束，也没有对手在等。
    if (this.snapshot.spectating) {
      this.exitGame();
      return;
    }
    if (this.snapshot.status === 'playing' && this.snapshot.moveCount > 0) {
      const accepted = await confirmAction('离开当前棋局？', this.snapshot.mode === 'online' ? '将退出当前联机房间；你也可以稍后通过房间号重新加入。' : '当前对局将结束，返回模式选择。', '退出对局');
      if (!accepted) return;
    }
    this.exitGame();
  }

  private exitGame(): void {
    if (this.snapshot?.spectating) this.trySend('spectate.leave');
    this.leaveRemoteSilently();
    this.closeChallengeDialog();
    this.closeSentCard();
    this.clearPresence();
    this.clearClock();
    this.clearPhraseBubbles();
    // 在途的 AI 分析请求随对局一起作废；对方弹窗若还开着也一并收掉。
    this.aiAnalysisRequestedGame = null;
    if (this.incomingAiAnalysis) {
      this.incomingAiAnalysis = null;
      required<HTMLDialogElement>('ai-analysis-dialog').close();
    }
    // 进行中的开局揭晓（硬币动画）随对局一起作废，避免回调污染后续界面。
    this.openingToken += 1;
    this.opening = null;
    this.coinActive = false;
    this.openingResult = null;
    required('opening-result').textContent = '';
    if (this.coin) {
      this.coin.dispose();
      this.coin = null;
    }
    this.snapshot = null;
    this.awaitingRemoteGame = false;
    this.challengeJustAccepted = false;
    this.pendingAfterSession = null;
    localStorage.removeItem('yijing-active-game');
    localStorage.removeItem('yijing-room-code');
    this.scene.setSnapshot(null);
    this.trySend('game.focus', { gameId: null });
    required<HTMLDialogElement>('game-dialog').close();
    required<HTMLDialogElement>('undo-dialog').close();
    this.render();
  }

  private leaveRemoteSilently(): void {
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.mode === 'local' || snapshot.spectating) return;
    if (this.connectionStatus !== 'connected') return;
    try {
      this.socket.send('room.leave', { gameId: snapshot.id });
    } catch {
      // 退出本地界面不依赖服务器响应。
    }
  }

  private showSnapshotUndoRequest(): void {
    const request = this.snapshot?.undoRequest;
    if (this.snapshot?.mode === 'online' && request) {
      this.showUndoRequest(this.snapshot.id, request.fromName);
    } else if (!request) {
      this.pendingUndoGameId = null;
      this.dismissedUndoKey = null;
      required<HTMLDialogElement>('undo-dialog').close();
    }
  }

  private showUndoRequest(gameId: string, fromName: string): void {
    if (this.snapshot?.id !== gameId) return;
    const key = `${gameId}:${this.snapshot.moveCount}:${fromName}`;
    if (this.dismissedUndoKey === key) return;
    this.pendingUndoGameId = gameId;
    required('undo-request-message').textContent = `${fromName} 希望撤销上一轮落子，是否同意？`;
    const dialog = required<HTMLDialogElement>('undo-dialog');
    if (!dialog.open) dialog.showModal();
  }

  private respondUndo(accept: boolean): void {
    if (!this.pendingUndoGameId) return;
    const gameId = this.pendingUndoGameId;
    this.dismissedUndoKey = `${gameId}:${this.snapshot?.moveCount ?? 0}:responded`;
    try {
      this.socket.send('game.undo_response', { gameId, accept });
    } catch (error) {
      toast(this.errorMessage(error), 'error');
    }
    this.pendingUndoGameId = null;
    required<HTMLDialogElement>('undo-dialog').close();
  }

  // ------------------------------------------------------------------
  // PVP 重开（需对方同意）
  // ------------------------------------------------------------------

  private showSnapshotRestartRequest(): void {
    const request = this.snapshot?.restartRequest;
    if (this.snapshot?.mode === 'online' && request) {
      this.showRestartRequest(this.snapshot.id, request.fromName);
    } else if (!request) {
      this.pendingRestartGameId = null;
      this.dismissedRestartKey = null;
      required<HTMLDialogElement>('restart-dialog').close();
    }
  }

  private showRestartRequest(gameId: string, fromName: string): void {
    if (this.snapshot?.id !== gameId) return;
    const key = `${gameId}:${fromName}`;
    if (this.dismissedRestartKey === key) return;
    this.pendingRestartGameId = gameId;
    required('restart-request-message').textContent = `${fromName} 想要重开本局，是否同意？`;
    const dialog = required<HTMLDialogElement>('restart-dialog');
    if (!dialog.open) dialog.showModal();
  }

  private respondRestart(accept: boolean): void {
    if (!this.pendingRestartGameId) return;
    const gameId = this.pendingRestartGameId;
    this.pendingRestartGameId = null;
    try {
      this.socket.send('game.restart_response', { gameId, accept });
    } catch (error) {
      toast(this.errorMessage(error), 'error');
    }
    required<HTMLDialogElement>('restart-dialog').close();
  }

  // ------------------------------------------------------------------
  // 断线提示与按铃
  // ------------------------------------------------------------------
  private handlePresence(event: PresenceEvent): void {
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.id !== event.gameId) return;
    // 自己的连接状态这里收不到（断了就收不到消息了），这条只是兜底。
    if (event.userId === this.user?.id) return;
    if (!event.online) {
      this.showPresence(event.color, event.name, event.reconnectInMs);
      return;
    }
    if (this.presence?.color === event.color) {
      this.clearPresence();
      toast(`「${event.name}」已重新连接`);
    }
  }

  /**
   * 用快照里的 presence 校正横幅。
   *
   * 事件负责「刚刚发生了什么」，快照负责「现在是什么状态」：刷新页面、重连、
   * 或者事件丢了的时候，靠这一份把倒计时接回同一条线上。
   */
  private syncPresence(snapshot: AnyGameSnapshot): void {
    if (snapshot.mode !== 'online' || snapshot.status !== 'playing' || !snapshot.presence) {
      this.clearPresence();
      return;
    }
    const presence = snapshot.presence;
    const mine = snapshot.spectating ? null : snapshot.yourColor;
    const offline = offlineOpponent(presence, mine);
    if (!offline) {
      this.clearPresence();
      return;
    }
    const player = offline.color === 1 ? snapshot.players.black : snapshot.players.white;
    this.showPresence(offline.color, player?.name ?? '对手', offline.remainingMs);
  }

  private showPresence(color: PlayerColor, name: string, remainingMs: number): void {
    const deadline = Date.now() + Math.max(0, remainingMs);
    if (this.presence && this.presence.color === color) {
      // 服务端每几秒刷新一次剩余时间，取更早的那个截止点：
      // 倒计时只应该往前走，不能因为一次快照就往回跳。
      this.presence.deadline = Math.min(this.presence.deadline, deadline);
      this.presence.name = name;
    } else {
      this.presence = { color, name, deadline };
      this.startPresenceTicker();
    }
    this.renderPresence();
  }

  private clearPresence(): void {
    this.presence = null;
    if (this.presenceTicker !== null) {
      window.clearInterval(this.presenceTicker);
      this.presenceTicker = null;
    }
    const alert = required('presence-alert');
    if (!alert.hidden) alert.hidden = true;
  }

  private startPresenceTicker(): void {
    if (this.presenceTicker !== null) return;
    this.presenceTicker = window.setInterval(() => this.renderPresence(), 1000);
  }

  private renderPresence(): void {
    const alert = required('presence-alert');
    const state = this.presence;
    if (!state) {
      alert.hidden = true;
      return;
    }
    const remaining = Math.max(0, state.deadline - Date.now());
    const expired = remaining <= 0;
    required('presence-alert-text').textContent = expired
      ? `${state.name} 断线超时，正在结算…`
      : `${state.name} 已断线，超时将判负`;
    const timer = required('presence-alert-timer');
    timer.textContent = formatCountdown(remaining / 1000);
    timer.hidden = expired;
    alert.hidden = false;
  }

  /**
   * 用快照里的 clock 校正倒计时。
   *
   * 与 presence 同一套分工：事件负责「刚刚发生了什么」，快照负责「现在是什么
   * 状态」。服务端只在状态变化时下发快照（落子 / 悔棋 / 重开 / 超时 / 断线 /
   * 重连），两次快照之间的每一秒都靠本地从 `deadlineAt` 算——绝不逐秒广播。
   */
  private syncClock(snapshot: AnyGameSnapshot): void {
    const clock = snapshot.clock;
    if (!clockVisible(snapshot.status, clock)) {
      this.clearClock();
      return;
    }
    this.clock = {
      deadlineAt: clock.deadlineAt,
      // 顺手校一次时：玩家电脑的钟差几分钟很常见，不校正的话屏幕上的秒数会整体偏掉。
      offset: clockOffset(clock.deadlineAt, clock.remainingMs, Date.now()),
      paused: clock.paused === true,
    };
    this.startClockTicker();
    this.renderClock();
  }

  private clearClock(): void {
    this.clock = null;
    if (this.clockTicker !== null) {
      window.clearInterval(this.clockTicker);
      this.clockTicker = null;
    }
    const chip = required('turn-clock');
    if (!chip.hidden) chip.hidden = true;
    chip.classList.remove('low', 'paused');
    chip.setAttribute('aria-live', 'off');
  }

  /**
   * 1 秒一跳就够了。
   *
   * 刻意不挂进 rAF 主循环：倒计时是文字，60fps 重绘 DOM 只费电不增信息；
   * 也刻意不看 rAF 的时间戳——后台标签页里它根本不跑。
   */
  private startClockTicker(): void {
    if (this.clockTicker !== null) return;
    this.clockTicker = window.setInterval(() => this.renderClock(), 1000);
  }

  private renderClock(): void {
    const chip = required('turn-clock');
    const state = this.snapshot ? this.clock : null;
    if (!state) {
      chip.hidden = true;
      // 藏起来也要把数字擦掉：徽标的 textContent 会被拼进无障碍名称，
      // 留着上一次的「00:30」等于对着读屏软件报一个并不存在的表。
      chip.textContent = '';
      return;
    }
    const left = remainingMs(state.deadlineAt, Date.now() - state.offset);
    chip.textContent = clockLabel(left);
    chip.hidden = false;
    const low = isLowTime(left);
    chip.classList.toggle('low', low);
    // 断线停表时把数字压暗：还在走和「暂时不走」必须一眼分得开，
    // 否则对手掉线的人会以为自己的表还在扣。
    chip.classList.toggle('paused', state.paused);
    // 读屏只在最后 10 秒跟进：否则它会把一局棋读成报数。
    chip.setAttribute('aria-live', low ? 'polite' : 'off');
    // 到 0 只显示 00:00，**不本地判负**：两端各自计时，差几十毫秒是常态，
    // 本地抢先宣布「你输了」就会和服务端的裁定打架。判负只认服务端快照。
  }

  private handleRing(event: RingEvent): void {
    if (!this.snapshot || this.snapshot.id !== event.gameId) return;
    this.scene.ringBell();
    this.sounds.play('bell');
    // 同一个 key：连点器把铃按成一片时，提示条只保留最新的一条，
    // 不会向上堆成一堵墙挡住棋盘、妨碍落子。
    toast(`「${event.fromName}」按铃催你落子`, 'info', 'ring');
  }

  /**
   * 桌上那口铜铃被按了。本地立刻响，再把铃声送到对面。
   *
   * 连点友好：本地不做防抖 / 节流——每次有效点击都立刻播放铃动画与音效并发协议。
   * 服务端默认也不限制频率（`RING_COOLDOWN_SECONDS=0`），连点器会逐次送达对面；
   * 若要把冷却调回来，改后端环境变量即可，前端无需改动。
   */
  private ringBell(): void {
    this.sounds.play('bell');
    const snapshot = this.snapshot;
    const live = snapshot?.mode === 'online' && snapshot.status === 'playing' && !snapshot.spectating;
    if (!live) {
      if (snapshot) toast('联机对局里，铃声才会传到对面');
      return;
    }
    if (!this.trySend('game.ring', { gameId: snapshot.id })) toast('连接已断开，铃声没能传出去', 'error');
  }

  // ------------------------------------------------------------------
  // 商城：积分、解锁、装备
  // ------------------------------------------------------------------

  /** 把当前装备的材质应用到棋盘（黑 / 白各一份）。 */
  private applyEquippedMaterials(): void {
    this.applySkins();
  }

  /** 打开商城并渲染当前积分 / 解锁 / 装备状态。 */
  // ------------------------------------------------------------------
  // 设置
  // ------------------------------------------------------------------

  private openSettings(): void {
    this.renderMoveNumberOptions();
    const dialog = required<HTMLDialogElement>('settings-dialog');
    if (!dialog.open) dialog.showModal();
  }

  private setMoveNumberMode(mode: MoveNumberMode): void {
    if (this.settings.moveNumbers === mode) return;
    this.settings = { ...this.settings, moveNumbers: mode };
    this.persistSettings();
    this.applySettings();
  }

  /** 切换「显示对方玩家皮肤」并持久化。 */
  private setShowOpponentSkin(value: boolean): void {
    if (this.settings.showOpponentSkin === value) return;
    this.settings = { ...this.settings, showOpponentSkin: value };
    this.persistSettings();
    this.applySkins();
    this.applySettings();
  }

  /** 切换「棋盘坐标」并持久化。 */
  private setShowBoardCoordinates(value: boolean): void {
    if (this.settings.showBoardCoordinates === value) return;
    this.settings = { ...this.settings, showBoardCoordinates: value };
    this.persistSettings();
    this.applySettings();
  }

  /**
   * 给二选一的分段控件（与手数编号同款 .segmented 风格）刷新高亮态。
   * `dataAttr` 必须是连字符形式的属性名 —— CSS 属性选择器里不能写 dataset 的
   * 驼峰键（`[data-opponentSkin]` 匹配不到 `data-opponent-skin`），故用字面量类型约束。
   */
  private renderBinaryToggle(
    containerId: string,
    dataAttr: 'opponent-skin' | 'board-coords',
    on: boolean,
  ): void {
    required(containerId).querySelectorAll<HTMLButtonElement>(`[data-${dataAttr}]`).forEach((button) => {
      const active = (button.getAttribute(`data-${dataAttr}`) === 'on') === on;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', String(active));
    });
  }

  /** 把设置下发到渲染层，并刷新界面上的选中态。 */
  private applySettings(): void {
    this.scene.setMoveNumbers(this.settings.moveNumbers);
    this.scene.setBoardCoordinates(this.settings.showBoardCoordinates);
    this.renderMoveNumberOptions();
    this.renderBinaryToggle('opponent-skin-options', 'opponent-skin', this.settings.showOpponentSkin);
    this.renderBinaryToggle('board-coords-options', 'board-coords', this.settings.showBoardCoordinates);
  }

  private renderMoveNumberOptions(): void {
    const container = required('move-number-options');
    container.querySelectorAll<HTMLButtonElement>('[data-move-numbers]').forEach((button) => {
      const value = normalizeMoveNumberMode(button.dataset.moveNumbers);
      const active = value === this.settings.moveNumbers;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', String(active));
    });
    const current = MOVE_NUMBER_OPTIONS.find((option) => option.value === this.settings.moveNumbers);
    required('move-number-hint').textContent = current?.hint ?? '';
  }

  // ------------------------------------------------------------------
  // 个人名片
  // ------------------------------------------------------------------

  /**
   * 打开个人名片。
   *
   * 不传 target（或 target 就是自己）→ 看自己：战绩 + 积分；
   * 传别人的 id → 看对方的公开名片：战绩 + 积分（积分是公开分数，与看自己一致）。
   * 大厅玩家名、对局中的双方名字都走这里。
   */
  private async openProfileCard(target?: { id: string; name: string }): Promise<void> {
    const dialog = required<HTMLDialogElement>('profile-card');
    if (!dialog.open) dialog.showModal();
    const isSelf = !target || target.id === this.user?.id;
    required('profile-card-name').textContent = isSelf ? (this.user?.name ?? '游客') : target!.name;
    required('profile-card-sub').textContent = isSelf ? '对局统计 · 数据随每局结束更新' : '对局统计';
    const body = required('profile-card-body');
    body.innerHTML = '<p class="profile-loading">正在读取对局统计…</p>';
    try {
      if (isSelf) {
        // 积分以服务端钱包为准：本地缓存可能因换设备 / 未结算而落后。
        const [stats, wallet] = await Promise.all([
          this.auth.stats(),
          this.auth.wallet().catch(() => null),
        ]);
        if (wallet) {
          applyWallet(this.profile, wallet.points, wallet.unlocked);
          saveProfile(this.profile);
        }
        this.renderProfileStats(stats, wallet?.points ?? this.profile.points);
      } else {
        const profile = await this.auth.statsFor(target!.id);
        required('profile-card-name').textContent = profile.name;
        // 看别人也展示积分（公开分数），布局与看自己完全一致。
        this.renderProfileStats(profile, profile.points);
      }
    } catch (error) {
      body.innerHTML = `<p class="form-error">${escapeHtml(this.errorMessage(error))}</p>`;
    }
  }

  /** 渲染名片的战绩网格；`points` 为 null 时该格隐藏（正常情况下自己与他人都传具体数值）。 */
  private renderProfileStats(stats: ProfileStats, points: number | null): void {
    const rate = stats.winrate === null ? '—' : `${Math.round(stats.winrate * 100)}%`;
    const pointsCell = points === null
      ? ''
      : `<div class="profile-stat points"><strong>${points}</strong><span>积分</span></div>`;
    required('profile-card-body').innerHTML = `
      <div class="profile-card-grid">
        <div class="profile-stat primary"><strong>${stats.totalGames}</strong><span>总场次</span></div>
        <div class="profile-stat primary"><strong>${rate}</strong><span>胜率</span></div>
        ${pointsCell}
        <div class="profile-stat win"><strong>${stats.wins}</strong><span>胜</span></div>
        <div class="profile-stat lose"><strong>${stats.losses}</strong><span>负</span></div>
        <div class="profile-stat draw"><strong>${stats.draws}</strong><span>和棋</span></div>
      </div>`;
  }

  /**
   * 给对局顶部的玩家名挂上「查看名片」链接。
   *
   * `player` 为空、AI（yixin）、或没有 id（等待中的白座）时移除链接——
   * 这些情况没有可查的真实玩家。
   */
  private bindProfileLink(elementId: string, player: { id: string; name: string } | null | undefined): void {
    const element = required(elementId);
    if (!player || !player.id || player.id === 'yixin') {
      element.classList.remove('clickable');
      element.title = '';
      element.onclick = null;
      return;
    }
    element.classList.add('clickable');
    element.title = '查看名片';
    element.onclick = (): void => {
      void this.openProfileCard({ id: player.id, name: player.name });
    };
  }

  private openShop(): void {
    this.renderShop();
    required<HTMLDialogElement>('shop-dialog').showModal();
  }

  /** 重绘商城内容：积分、材质、棋境三类商品。 */
  private renderShop(): void {
    const content = required('shop-content');
    const points = this.profile.points;

    const items = SHOP_ITEMS.map((item) => {
      const unlocked = isUnlocked(this.profile, item.id);
      const tag = this.shopItemTag(item.id);
      const swatch = this.shopSwatch(item.target, item.kind, item.swatch);
      const action = this.shopActionButton(item, unlocked);
      return (
        `<div class="shop-item${tag === 'equipped' ? ' is-equipped' : ''}">` +
        `<span class="shop-swatch" style="${swatch}"></span>` +
        `<div class="shop-meta"><div class="shop-name">${item.name}${tag === 'equipped' ? '<span class="shop-tag">已装备</span>' : ''}</div>` +
        `<div class="shop-desc">${item.description}</div></div>` +
        `<div class="shop-action">${action}</div>` +
        `</div>`
      );
    }).join('');

    content.innerHTML = `
      <div class="shop-head">
        <h2>弈境商城</h2>
        <span class="shop-points">积分 <strong>${points}</strong></span>
      </div>
      <p class="modal-subtitle" style="margin:0 0 4px">每下完一局可得 ${POINTS_PER_GAME} 积分，可解锁特殊棋子；所有棋境免费选择。</p>
      <p class="shop-section-title">棋子材质</p>
      <div class="shop-list">${items}</div>
    `;

    // 行为按钮是动态生成的，单独绑定，避免重复绑定。
    content.querySelectorAll<HTMLButtonElement>('[data-shop-action]').forEach((button) => {
      button.addEventListener('click', () => {
        const action = button.dataset.shopAction;
        const itemId = button.dataset.item;
        if (action && itemId) this.handleShopAction(action, itemId);
      });
    });
  }

  /** 商品当前状态：装备中 / 已解锁 / 锁定（用于标签与按钮文案）。 */
  private shopItemTag(itemId: string): 'equipped' | 'unlocked' | 'locked' {
    const item = SHOP_ITEMS.find((candidate) => candidate.id === itemId);
    if (!item) return 'locked';
    if (!isUnlocked(this.profile, itemId)) return 'locked';
    if (item.kind === 'material') {
      const equippedId = item.side === 'black' ? this.profile.equipped.materialBlack : this.profile.equipped.materialWhite;
      if (equippedId === item.target) return 'equipped';
    }
    return 'unlocked';
  }

  /** 商品缩略色块：材质用其自身颜色（或指定的展示色），棋境用预设的代表色。 */
  private shopSwatch(target: string, kind: 'material' | 'scene', display?: string): string {
    if (display) return `background:${display}`;
    if (kind === 'material') {
      const def = STONE_MATERIALS[target];
      if (def) return `background:${def.color}`;
    }
    const sceneSwatch: Record<string, [string, string, string]> = {
      courtyard: ['#4b6b52', '#a8bfae', '#e6efe6'],
      cyber: ['#0b0e1a', '#7a2ff2', '#2ff2d8'],
      studio: ['#0a0b0d', '#6a635c', '#fff4e6'],
    };
    const palette = sceneSwatch[target];
    if (palette) return `background:linear-gradient(135deg, ${palette[0]}, ${palette[1]}, ${palette[2]})`;
    return 'background:#cdbfa6';
  }

  /** 生成单个商品的按钮：解锁 / 装备 / 取消装备 / 积分不足。 */
  private shopActionButton(item: { id: string; price: number; kind: 'material' | 'scene' }, unlocked: boolean): string {
    if (!unlocked) {
      const affordable = this.profile.points >= item.price;
      const label = `解锁 · ${item.price}`;
      return `<button class="shop-btn primary" data-shop-action="unlock" data-item="${item.id}"${affordable ? '' : ' disabled'}>${label}</button>`;
    }
    if (item.kind === 'scene') {
      return `<button class="shop-btn" data-shop-action="noop" disabled>已解锁</button>`;
    }
    const tag = this.shopItemTag(item.id);
    if (tag === 'equipped') {
      return `<button class="shop-btn equipped" data-shop-action="equip" data-item="${item.id}">取消装备</button>`;
    }
    return `<button class="shop-btn" data-shop-action="equip" data-item="${item.id}">装备</button>`;
  }

  /** 处理商城按钮动作。 */
  private handleShopAction(action: string, itemId: string): void {
    const item = SHOP_ITEMS.find((candidate) => candidate.id === itemId);
    if (!item) return;
    if (action === 'unlock') {
      // 购买走服务端：扣费与解锁记录都在后端，本地档案只是缓存。
      void this.purchaseItem(item);
      return;
    }
    if (action === 'equip') {
      const result = equipMaterial(this.profile, itemId);
      if (!result.ok) {
        toast(result.reason ?? '装备失败', 'error');
        return;
      }
      this.applyEquippedMaterials();
      this.renderShop();
      // 皮肤装备同步到服务端（换设备跟随；校验在服务端做）。
      const equipped = this.profile.equipped;
      void this.auth.equip(equipped.materialBlack, equipped.materialWhite).catch(() => {
        /* 离线静默：本地已生效，下次装备会再同步 */
      });
      return;
    }
  }

  /** 服务端购买：成功后把钱包缓存刷进本地并应用外观。 */
  private async purchaseItem(item: { id: string; name: string }): Promise<void> {
    try {
      const wallet = await this.auth.purchase(item.id);
      applyWallet(this.profile, wallet.points, wallet.unlocked);
      saveProfile(this.profile);
      toast(`已解锁「${item.name}」`);
      this.applyShopSideEffects(item.id);
      this.renderShop();
    } catch (error) {
      toast(this.errorMessage(error) || '解锁失败，请稍后再试', 'error');
    }
  }

  /**
   * 解锁棋境后，建房 / AI 开局面板里的对应棋境卡片需要解除锁定。
   */
  private applyShopSideEffects(itemId: string): void {
    const item = SHOP_ITEMS.find((candidate) => candidate.id === itemId);
    if (item?.kind === 'scene') this.refreshScenePickerLock();
  }

  /**
   * 根据已解锁的棋境，锁定 / 解锁开局面板里的棋境卡片。
   * 庭院与赛博是解锁项；茶室始终免费。「随机」不受影响，仍是默认选中。
   */
  private refreshScenePickerLock(): void {
    this.root.querySelectorAll<HTMLInputElement>('input[name="ai-scene"], input[name="online-scene"], input[name="local-scene"]').forEach((input) => {
      if (input.value !== 'courtyard' && input.value !== 'cyber' && input.value !== 'living') return;
      const label = input.closest<HTMLLabelElement>('label.scene-card');
      if (!label) return;
      const unlocked = isSceneUnlocked(this.profile, input.value);
      input.disabled = !unlocked;
      label.classList.toggle('locked', !unlocked);
      const existing = label.querySelector('.scene-locked-tag');
      if (unlocked) {
        existing?.remove();
      } else if (!existing) {
        const tag = document.createElement('span');
        tag.className = 'scene-locked-tag';
        tag.textContent = '未解锁';
        label.append(tag);
      }
    });
  }

  // ------------------------------------------------------------------
  // 对局结束积分结算（服务端权威）
  // ------------------------------------------------------------------

  /**
   * 一局真正结束：服务端已在终局路径里给参与者 +POINTS_PER_GAME，
   * 这里拉一次钱包刷新本地缓存（顺带给个正反馈 toast）。
   */
  private onGameSettled(snapshot: AnyGameSnapshot): void {
    if (snapshot.mode === 'local' || snapshot.spectating) return;
    void this.refreshWallet().then(() => {
      toast(`本局获得 ${POINTS_PER_GAME} 积分，可在商城解锁棋子材质`);
      if (required<HTMLDialogElement>('shop-dialog').open) this.renderShop();
    });
  }

  /** 从服务端拉钱包，覆盖本地档案缓存；失败静默（下次再同步）。 */
  private async refreshWallet(): Promise<void> {
    try {
      const wallet = await this.auth.wallet();
      applyWallet(this.profile, wallet.points, wallet.unlocked);
      // 皮肤跟账号走：服务端的装备覆盖本地缓存（装了什么在哪个设备都一样）。
      this.profile.equipped = wallet.equipped;
      saveProfile(this.profile);
      this.applySkins();
      if (required<HTMLDialogElement>('shop-dialog').open) this.renderShop();
    } catch {
      /* 未登录 / 网络抖动：本地缓存继续顶用 */
    }
  }

  /** 登录后同步一次服务端持久化的显示设置（服务端权威）。 */
  private async syncPreferencesFromServer(): Promise<void> {
    try {
      const prefs = await this.auth.preferences();
      this.settings = mergeServerSettings(this.settings, prefs);
      saveSettings(this.settings);
      this.applySettings();
      this.applySkins();
    } catch {
      /* 未登录 / 网络抖动：本地设置继续顶用 */
    }
  }

  /** 设置变更后本地立即生效 + 异步上服（永久储存）。 */
  private persistSettings(): void {
    saveSettings(this.settings);
    void this.auth.savePreferences({ ...this.settings }).catch(() => {
      /* 离线时静默：本地已存，下次改动会再试 */
    });
  }

  /**
   * 依快照计算双方棋子的皮肤并下发渲染层。
   *
   * - 本地同屏 / 人机：双方都按【自己】已装备的皮肤渲染
   *   （AI 与本地对手都跟随玩家装备，没有独立皮肤）。
   * - 联机 PVP：「显示对方玩家装备的棋子皮肤」设置在此生效——
   *   开启：对方棋子按其【自己装备】的皮肤渲染（透明即透明、实体即实体）；
   *   关闭：自己与对方的棋子一律显示【自己】已启用的皮肤。
   */
  private applySkins(): void {
    // 返回顺序固定「先黑后白」，与 setStoneMaterials 的签名对齐；
    // 具体解析规则见 resolveStoneSkins（含自己执白时不能对调黑白的约束）。
    const [blackId, whiteId] = resolveStoneSkins(
      this.snapshot,
      this.profile.equipped,
      this.settings.showOpponentSkin,
    );
    this.scene.setStoneMaterials(blackId, whiteId);
  }

  // ------------------------------------------------------------------
  // 快捷短语：收缩菜单 / 发送与接收气泡
  // ------------------------------------------------------------------

  /** 展开 / 收起快捷短语面板，并同步 aria-expanded 状态。 */
  private togglePhrasePanel(): void {
    const panel = required('phrase-panel');
    const willOpen = panel.hidden; // 当前隐藏 → 即将展开
    panel.hidden = !willOpen;
    required('phrase-toggle').setAttribute('aria-expanded', String(willOpen));
  }

  /** 收起快捷短语面板（发送后或点击外部时调用）。 */
  private closePhrasePanel(): void {
    required('phrase-panel').hidden = true;
    required('phrase-toggle').setAttribute('aria-expanded', 'false');
  }

  /**
   * 发送一条快捷短语。
   *
   * 本地立即弹一个「自己的气泡」做反馈（联机 / 本地 / 人机都看得到），
   * 若是进行中的联机对局，再把 `phraseId` 发给服务端——服务端只转发已知
   * `phraseId` 对应的规范文案，从源头杜绝 chat 注入与 XSS。
   */
  private sendPhrase(phraseId: string): void {
    const text = phraseText(phraseId);
    if (!text) return;
    const snapshot = this.snapshot;
    const selfColor: PlayerColor = snapshot?.yourColor ?? 1;
    this.showPhraseBubble({
      gameId: snapshot?.id ?? '',
      senderId: this.user?.id ?? 'me',
      senderName: '你',
      color: selfColor,
      phraseId,
      text,
      timestamp: 0,
    });
    const live = snapshot?.mode === 'online' && snapshot.status === 'playing' && !snapshot.spectating;
    if (!live) return;
    if (!this.trySend('game.phrase', { gameId: snapshot.id, phraseId })) toast('连接已断开，短语没能传出去', 'error');
  }

  /** 收到对方（或观战者）发来的短语，弹出气泡。 */
  private handlePhrase(event: PhraseEvent): void {
    if (!this.snapshot || this.snapshot.id !== event.gameId) return;
    this.showPhraseBubble(event);
  }

  /**
   * 在屏幕上方弹出一条短语气泡。文案一律用 `textContent` 写入，绝不使用 innerHTML，
   * 即便服务端被攻破也只能显示纯文本，无法注入脚本。
   */
  private showPhraseBubble(event: PhraseEvent): void {
    const layer = required('phrase-layer');

    // 同时最多显示两条：第三条进来时先让最早的那条平滑收起。
    // 只统计仍在显示的气泡（已在收起动画里的不再算数），避免连发时误杀新的。
    const visible = Array.from(layer.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement && !child.classList.contains('collapsing'),
    );
    for (const stale of visible.slice(0, Math.max(0, visible.length - 1))) {
      this.dismissPhraseBubble(stale);
    }

    const bubble = document.createElement('div');
    bubble.className = `phrase-bubble ${event.color === 2 ? 'white' : 'black'}`;

    const name = document.createElement('span');
    name.className = 'phrase-bubble-name';
    name.textContent = event.senderName;

    const text = document.createElement('span');
    text.className = 'phrase-bubble-text';
    text.textContent = event.text;

    bubble.append(name, text);
    layer.append(bubble);

    // 强制一次回流，让浏览器立刻算好「插入态」的样式；否则紧接着加 .show 时
    // 过渡/动画可能被跳过，气泡会突兀地直接出现。
    void bubble.offsetHeight;
    bubble.classList.add('show');
    const hideTimer = window.setTimeout(() => this.dismissPhraseBubble(bubble), 2600);
    this.phraseTimers.push(hideTimer);
  }

  /**
   * 收起一条气泡：先把它当前高度固定成像素值，再过渡到 0（连同 padding、边框、
   * 下外边距一起归零），下面那条就会匀速滑上来。如果直接 `remove()`，flex 重排
   * 是瞬间的，看起来就是「突然往上跳一格」。
   */
  private dismissPhraseBubble(bubble: HTMLElement): void {
    if (bubble.classList.contains('collapsing')) return;
    bubble.classList.remove('show');
    const height = bubble.offsetHeight;
    // 先锁成像素高度并强制回流，否则 auto→0 无法插值，动画不会发生。
    bubble.style.height = `${height}px`;
    void bubble.offsetHeight;
    bubble.classList.add('collapsing');
    bubble.style.height = '0px';
    const removeTimer = window.setTimeout(() => bubble.remove(), 320);
    this.phraseTimers.push(removeTimer);
  }

  /** 退出对局时清理所有短语气泡计时器与 DOM，避免计时器泄漏。 */
  private clearPhraseBubbles(): void {
    for (const timer of this.phraseTimers) window.clearTimeout(timer);
    this.phraseTimers.length = 0;
    required('phrase-layer').replaceChildren();
  }

  // ------------------------------------------------------------------
  // 对局内 AI 分析（好友联机：请求 → 对方同意 → 本地引擎给出建议一手）
  // ------------------------------------------------------------------

  /** 把行列换成棋谱坐标（A1 在左下角），提示语里比裸数字好读。 */
  private coordinateLabel(row: number, col: number): string {
    return `${String.fromCharCode(65 + col)}${15 - row}`;
  }

  /** 向对手发起 AI 分析请求；是否放行由对方决定。 */
  private requestAiAnalysis(): void {
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.mode !== 'online' || snapshot.status !== 'playing' || snapshot.spectating) return;
    if (this.aiAnalysisRequestedGame === snapshot.id) return;
    try {
      this.socket.send('game.ai_request', { gameId: snapshot.id });
      this.aiAnalysisRequestedGame = snapshot.id;
      toast('已请求 AI 分析，等待对方同意');
    } catch (error) {
      toast(this.errorMessage(error), 'error');
    }
    this.render();
  }

  /** 收到对手的分析请求：弹窗询问是否同意。 */
  private handleAiAnalysisRequested(event: AiAnalysisRequestEvent): void {
    if (!this.snapshot || this.snapshot.id !== event.gameId || this.snapshot.spectating) return;
    if (this.incomingAiAnalysis) return; // 已有一个待回应的请求，忽略后来的。
    this.incomingAiAnalysis = event;
    required('ai-analysis-from').textContent = event.fromName;
    required<HTMLDialogElement>('ai-analysis-dialog').showModal();
    this.sounds.play('join');
  }

  /** 回应对手的分析请求。 */
  private respondAiAnalysis(accept: boolean): void {
    const event = this.incomingAiAnalysis;
    if (!event) return;
    this.incomingAiAnalysis = null;
    required<HTMLDialogElement>('ai-analysis-dialog').close();
    try {
      this.socket.send('game.ai_respond', { gameId: event.gameId, accept });
    } catch (error) {
      toast(this.errorMessage(error), 'error');
    }
  }

  /** 分析结果：同意则亮出建议落点，婉拒则如时告知。 */
  private handleAiAnalysisResult(event: AiAnalysisResultEvent): void {
    if (!this.snapshot || this.snapshot.id !== event.gameId) return;
    if (this.aiAnalysisRequestedGame === event.gameId) this.aiAnalysisRequestedGame = null;
    if (event.accepted && event.row !== undefined && event.col !== undefined) {
      // 服务端转发来的落点（请求方算完后回传广播）：双方含观战者都亮出绿色推荐环。
      this.scene.showHint(event.row, event.col);
      toast(`AI 分析 · 建议 ${event.byName === this.user?.name ? '你' : event.byName}方落子 ${this.coordinateLabel(event.row, event.col)}`);
      this.sounds.play('bell');
    } else if (event.accepted) {
      // 引擎已迁到客户端：同意后由请求方本地计算建议点，再把落点回传服务端，
      // 由服务端广播给对手与观战者——这样双方棋盘上都会出现同一个绿色推荐环。
      if (event.byName === this.user?.name) {
        void this.computeLocalSuggestion(event.gameId, undefined, false).then((move) => {
          if (move) this.submitAiPoint(event.gameId, move.row, move.col);
        });
      } else {
        toast(`${event.byName} 获得了 AI 分析许可`);
      }
    } else {
      toast(`${event.byName} 的 AI 分析请求被对方婉拒`);
    }
    this.render();
  }

  /** 请求方算出落点后回传给服务端，由服务端转播给对手与观战者。 */
  private submitAiPoint(gameId: string, row: number, col: number): void {
    try {
      this.socket.send('game.ai_result', { gameId, row, col });
    } catch (error) {
      toast(this.errorMessage(error), 'error');
    }
  }

  // ------------------------------------------------------------------
  // 本地 Rapfi 引擎
  // ------------------------------------------------------------------

  /** 拿到共享引擎实例（首次会下载 NNUE 权重，之后秒回）。 */
  private async ensureRapfi(): Promise<RapfiClient> {
    if (this.rapfi?.isReady) return this.rapfi;
    toast('正在加载本地引擎（约 10MB，仅首次）…');
    this.rapfi = await getRapfiClient({
      onInfo: (info) => this.handleEngineInfo(info),
      onError: (message) => toast(`本地引擎：${message}`),
    });
    toast('本地引擎已就绪');
    return this.rapfi;
  }

  /**
   * 人机局的 AI 回合：本地引擎全量重建局面并思考，算完提交 `game.ai_move`。
   * think() 每次都全量 BOARD，与重开/悔棋后的任何棋盘状态天然兼容。
   */
  private async runClientAiTurn(snapshot: GameSnapshot): Promise<void> {
    if (this.aiMoveInFlight || this.replay) return;
    this.aiMoveInFlight = true;
    const gameId = snapshot.id;
    try {
      const client = await this.ensureRapfi();
      // 重开后同一 gameId 棋盘已清空：START 重置一次，代价可忽略。
      if (this.rapfiGameId !== gameId) {
        client.startGame(2000, snapshot.rule);
        this.rapfiGameId = gameId;
        this.engineInfo = {};
      }
      const move = await client.think(snapshot.moves ?? [], 2000);
      // 思考期间对局可能已经结束（用户认输 / 自己上一手五连获胜 / 切局）：
      // 只有「仍是这盘棋、仍在进行中、服务端仍在等 AI」三者同时成立才提交，
      // 否则服务端会以 NOT_AI_TURN 拒绝并弹出无意义的红色报错。
      const current = this.snapshot;
      if (
        current && current.id === gameId && current.mode === 'ai'
        && current.status === 'playing' && current.aiThinking
      ) {
        this.socket.aiMove(gameId, move.row, move.col);
      }
    } catch (error) {
      if (this.snapshot?.id === gameId) {
        toast(this.errorMessage(error) ?? '本地引擎思考失败，请重试');
      }
    } finally {
      this.aiMoveInFlight = false;
    }
  }

  /** 实时思考信息：刷新状态栏面板；主变化首点以提示环跟着搜索走（节流）。 */
  private handleEngineInfo(info: RapfiInfo): void {
    // 人机局（AI 思考 / 手动分析）与本地对弈的手动分析都会推送；观战与联机不接。
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.spectating || (snapshot.mode !== 'ai' && snapshot.mode !== 'local')) return;
    this.engineInfo = { ...this.engineInfo, ...info };
    const panel = document.getElementById('engine-panel');
    if (panel) {
      const parts: string[] = [];
      if (this.engineInfo.depth !== undefined) parts.push(`深度 <strong>${this.engineInfo.depth}</strong>`);
      if (this.engineInfo.winrate !== undefined) {
        parts.push(`胜率 <strong>${Math.round(this.engineInfo.winrate * 100)}%</strong>`);
      }
      if (this.engineInfo.eval !== undefined) parts.push(`评估 <strong>${this.engineInfo.eval}</strong>`);
      const line = this.engineInfo.bestline;
      if (line?.length) {
        parts.push(`主线 ${line.slice(0, 4).map(([r, c]) => this.coordinateLabel(r, c)).join('→')}`);
      }
      panel.innerHTML = parts.join('<i class="status-divider"></i>');
      panel.hidden = parts.length === 0;
    }
    // 搜索每深入一层主变化都会变：节流到 500ms 亮一次环，棋盘上能「看见思考」。
    const best = info.bestline?.[0];
    if (best && performance.now() - this.lastHintAt > 500) {
      this.lastHintAt = performance.now();
      this.scene.showHint(best[0], best[1]);
    }
  }

  /**
   * 对当前局面本地算一个建议点，并亮出绿色推荐环。
   * PVP 分析（对方同意后）与人机「AI 分析」共用：引擎同一时刻只能跑一个 think，
   * 由调用方用 aiEvaluationInFlight / aiMoveInFlight / aiThinking 把关。
   * @param announce 是否自行弹出 toast 与音效（PVP 场景由服务端广播的落点事件统一
   *   播报，避免请求方本地与广播各响一次）。
   * @returns 算出的建议点；引擎失败时返回 null。
   */
  private async computeLocalSuggestion(
    gameId: string,
    moves?: ReadonlyArray<{ row: number; col: number; color: number }>,
    announce = true,
  ): Promise<{ row: number; col: number } | null> {
    const source = moves ?? this.snapshot?.moves;
    if (!source) return null;
    try {
      const client = await this.ensureRapfi();
      if (this.rapfiGameId !== gameId) {
        client.startGame(1500, this.snapshot?.rule);
        this.rapfiGameId = gameId;
      }
      const move = await client.think(source, 1500);
      this.scene.showHint(move.row, move.col);
      if (announce) {
        toast(`AI 分析 · 建议 ${this.coordinateLabel(move.row, move.col)} 落子`);
        this.sounds.play('bell');
      }
      return move;
    } catch {
      if (announce) toast('本地引擎计算失败，请稍后再试');
      return null;
    }
  }

  /**
   * 人机 / 本地对弈的「AI 分析」：手动让本地 Rapfi 引擎分析当前局面，给出下一手推荐。
   * 与复盘的 AI 评估复用同一条 `computeLocalSuggestion` 路径（全量重建局面、
   * 零服务端参与）。引擎同一时刻只能跑一个 think——人机回合进行中由
   * `aiThinking` 把关禁用按钮，这里再补一层在途标记防连点（本地局没有
   * AI 回合，天然无冲突）。
   */
  private async requestAiSelfAnalysis(): Promise<void> {
    if (this.replay) return;
    const snapshot = this.snapshot;
    if (!snapshot || (snapshot.mode !== 'ai' && snapshot.mode !== 'local') || snapshot.status !== 'playing' || snapshot.spectating) return;
    if (this.aiEvaluationInFlight || this.aiMoveInFlight || snapshot.aiThinking) return;
    this.aiEvaluationInFlight = true;
    required<HTMLButtonElement>('ai-evaluate-button').disabled = true;
    try {
      await this.computeLocalSuggestion(snapshot.id, snapshot.moves);
    } finally {
      this.aiEvaluationInFlight = false;
      // 局面可能已变（轮到 AI / 已结束）：按当前快照重新同步按钮态。
      required<HTMLButtonElement>('ai-evaluate-button').disabled =
        !!this.snapshot?.aiThinking;
    }
  }

  // ------------------------------------------------------------------
  // 复盘
  // ------------------------------------------------------------------

  /** 打开「近期对局」列表。 */
  private async openReplayList(): Promise<void> {
    const dialog = required<HTMLDialogElement>('replay-dialog');
    if (!dialog.open) dialog.showModal();
    this.renderReplayTabs();
    await this.loadReplays();
  }

  /** 按当前页签拉一次列表。切页签和首次打开都走这里。 */
  private async loadReplays(): Promise<void> {
    required('replay-error').textContent = '';
    required('replay-empty').hidden = true;
    required('replay-list').innerHTML = '<li class="replay-loading">正在读取棋谱…</li>';
    try {
      const mode = this.replayTab === 'ai' || this.replayTab === 'online' ? this.replayTab : undefined;
      const items = await this.replays.list(20, 0, mode, this.replayTab === 'favorite');
      this.renderReplayList(items);
    } catch (error) {
      required('replay-list').innerHTML = '';
      required('replay-error').textContent =
        error instanceof ReplayError ? error.message : this.errorMessage(error);
    }
  }

  private setReplayTab(tab: 'all' | 'favorite' | 'ai' | 'online'): void {
    if (this.replayTab === tab) return;
    this.replayTab = tab;
    this.renderReplayTabs();
    void this.loadReplays();
  }

  private renderReplayTabs(): void {
    required('replay-tabs').querySelectorAll<HTMLButtonElement>('[data-replay-tab]').forEach((button) => {
      const value = button.dataset.replayTab;
      const active = value === this.replayTab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
  }

  private renderReplayList(items: ReplaySummary[]): void {
    const list = required('replay-list');
    list.innerHTML = '';
    const empty = required('replay-empty');
    empty.hidden = items.length > 0;
    const scope = this.replayTab === 'ai' ? '与 AI 的'
      : this.replayTab === 'online' ? '与好友的'
        : this.replayTab === 'favorite' ? '收藏的'
          : '';
    empty.innerHTML = this.replayTab === 'favorite'
      ? '还没有收藏的棋局。<br>在复盘播放条上点「收藏」，这局就会永久留在列表里。'
      : `还没有可以复盘的${scope}棋局。<br>下完一局之后再来。`;
    for (const item of items) {
      const black = item.players.black?.name ?? '黑方';
      const white = item.players.white?.name ?? '白方';
      const duration = formatDuration(item.createdAt, item.finishedAt);
      // 模式已经不写进 meta 了：页签和左边那枚徽标都在说同一件事，
      // 在这里再重复一遍只会把真正有用的「手数 / 用时 / 棋境」挤走。
      // 时间放最前面：复盘列表按时间倒序，读的时候第一个想确认的就是「这是哪一天的哪盘」。
      const meta = [
        formatDateTimeShort(item.finishedAt ?? item.createdAt),
        `${item.moveCount} 手`,
        duration,
        sceneName(coerceSceneId(item.scene)),
        item.yourColor === 1 ? '你执黑' : item.yourColor === 2 ? '你执白' : '',
      ].filter(Boolean).join(' · ');
      const kind = item.mode === 'ai' ? 'ai' : 'online';
      const kindLabel = summarizeMode(item);
      const won = item.winner !== 0 && item.winner === item.yourColor;
      const flag = item.winner === 0 ? '和棋' : won ? '胜' : '负';

      const row = document.createElement('li');
      row.className = 'replay-item';
      row.innerHTML =
        `<button class="replay-row" type="button" data-replay-id="${escapeHtml(item.id)}">` +
        `<span class="replay-row-main">` +
        `<span class="replay-kind ${kind}" title="${escapeHtml(kindLabel)}">${icon(kind === 'ai' ? 'cpu' : 'users')}</span>` +
        `<i class="stone-avatar black"></i>${escapeHtml(black)}` +
        `<span class="replay-row-vs">对</span><i class="stone-avatar white"></i>${escapeHtml(white)}</span>` +
        `<span class="replay-row-flag${won ? ' win' : ''}">${flag}</span>` +
        `<span class="replay-row-meta">${escapeHtml(meta)}</span>` +
        `</button>` +
        `<button class="replay-fav${item.favorite ? ' on' : ''}" type="button"` +
        ` data-fav-id="${escapeHtml(item.id)}" data-favorite="${item.favorite ? '1' : '0'}"` +
        ` aria-pressed="${item.favorite ? 'true' : 'false'}"` +
        ` title="${item.favorite ? '取消收藏（回到 30 天自动清理）' : '收藏这局棋谱，永久保留'}"` +
        ` aria-label="${item.favorite ? '取消收藏' : '收藏'}">${icon('star')}</button>`;
      list.append(row);
    }
  }

  /** 读取一局棋谱并进入复盘。 */
  private async startReplay(gameId: string): Promise<void> {
    required('replay-error').textContent = '';
    try {
      const record = await this.replays.get(gameId);
      this.enterReplay(record);
    } catch (error) {
      const message = error instanceof ReplayError ? error.message : this.errorMessage(error);
      required('replay-error').textContent = message;
    }
  }

  /** 结算卡上的「复盘本局」：直接用当前这局的 id 去取棋谱。 */
  private async replayCurrentGame(): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.mode === 'local') return;
    await this.startReplay(snapshot.id);
  }

  private enterReplay(record: ReplayRecord): void {
    const dialog = required<HTMLDialogElement>('replay-dialog');
    if (dialog.open) dialog.close();

    this.replayReturn = this.snapshot;
    // 复盘期间把对局快照让开：服务端推送、积分结算、断线恢复都不该在这时候插进来。
    this.snapshot = null;
    this.clearClock();
    this.replay = record;
    this.replayIndex = 0;
    this.replaySuggestion = null;
    this.stopReplayTimer();
    this.render();
    this.renderReplayFrame();
    // 进来时说明一次「怎么出去」：复盘把对局界面的出口全收起来了，
    // 只剩底部播放条左侧那个按钮，第一次进来的人不一定注意得到。
    toast('复盘模式 · 底部进度条可逐手回看，点「返回」或按 Esc 退出');
  }

  /**
   * 摆出第 `replayIndex` 手的局面。
   *
   * 这里**不新增任何渲染路径**，而是构造一张「假快照」交给 `GomokuScene.setSnapshot`：
   * 棋盘差分、最后一手标记、五连高亮、落子动画全部复用同一套代码。
   * 复盘和实战的棋盘因此不可能长得不一样——这比再写一条渲染分支可靠得多。
   */
  private renderReplayFrame(landColor?: 1 | 2): void {
    const record = this.replay;
    if (!record) return;

    const total = record.moves.length;
    const index = clampIndex(this.replayIndex, total);
    this.replayIndex = index;
    const atEnd = total > 0 && index >= total;

    // 落子音交给「棋子落到棋盘、涟漪冒出来」那一刻，和实战同一套时序；
    // 拖进度条一次补多颗子时只响一声。
    let played = false;
    const onStoneLand = landColor
      ? (color: 1 | 2) => {
          if (played) return;
          played = true;
          this.sounds.play(color === 1 ? 'black' : 'white');
        }
      : undefined;

    this.scene.setSnapshot({
      id: `replay:${record.id}`,
      mode: record.mode === 'online' ? 'online' : 'ai',
      status: atEnd ? 'finished' : 'playing',
      scene: coerceSceneId(record.scene),
      board: boardAt(record.moves, index),
      currentPlayer: index % 2 === 0 ? 1 : 2,
      players: {
        black: record.players.black ?? { id: 'black', name: '黑方' },
        white: record.players.white ?? { id: 'white', name: '白方' },
      },
      yourColor: record.yourColor,
      roomCode: null,
      lastMove: lastMoveAt(record.moves, index),
      // 复盘的序列就是棋谱本身：编号因此能和实战一模一样地标出来。
      moves: record.moves.slice(0, index),
      winner: atEnd ? record.winner : 0,
      winReason: atEnd ? record.winReason : null,
      moveCount: index,
      canUndo: false,
      aiThinking: false,
    }, onStoneLand);
    // 翻回有建议的那一手时重亮提示环（环本身 6 秒自动消散，重进局面要补一次）。
    if (this.replaySuggestion?.ply === index) {
      this.scene.showHint(this.replaySuggestion.row, this.replaySuggestion.col);
    }
    this.renderReplayAiResult();
    this.renderReplayControls();
  }

  private renderReplayControls(): void {
    this.renderReplayKeep();
    const record = this.replay;
    if (!record) return;
    const total = record.moves.length;
    const index = this.replayIndex;

    const slider = required<HTMLInputElement>('replay-slider');
    slider.max = String(Math.max(total, 1));
    slider.value = String(index);
    required('replay-progress').textContent = `${index} / ${total}`;

    required<HTMLButtonElement>('replay-first').disabled = index === 0;
    required<HTMLButtonElement>('replay-prev').disabled = index === 0;
    required<HTMLButtonElement>('replay-next').disabled = index >= total;
    required<HTMLButtonElement>('replay-last').disabled = index >= total;
    // 第 0 手是空盘（等同开新局），末尾若是五连/满盘也已下无可下。
    required<HTMLButtonElement>('replay-continue').disabled = !canContinueFrom(record, index);

    const toggle = required<HTMLButtonElement>('replay-toggle');
    toggle.innerHTML = icon(this.replayTimer === null ? 'play' : 'pause');
    toggle.title = this.replayTimer === null ? '播放' : '暂停';
    toggle.disabled = total === 0;

    required('move-count').innerHTML = `${index} <small>/ ${total} 手</small>`;
    required('current-color').textContent =
      index >= total ? '已终局' : index % 2 === 0 ? '黑方' : '白方';
  }

  /** 跳到第 `target` 手（越界会被夹紧）。前进时播一声落子音，和实战听感一致。 */
  private seekReplay(target: number): void {
    const record = this.replay;
    if (!record) return;
    const total = record.moves.length;
    const next = clampIndex(target, total);
    if (next >= total) this.stopReplayTimer();
    if (next === this.replayIndex) {
      this.renderReplayControls();
      return;
    }
    const forward = next > this.replayIndex;
    this.replayIndex = next;
    this.renderReplayFrame(forward ? record.moves[next - 1]?.color : undefined);
  }

  // -----------------------------------------------------------------
  // 复盘 AI 评估：纯手动（点按钮才碰引擎）+ 服务端缓存 + 前端缓存
  // -----------------------------------------------------------------

  /**
   * 列表里的星标：收藏 / 取消收藏。
   * 按钮自己记着当前状态（`data-favorite`），所以同一个处理器兼管两个方向；
   * 从「已收藏」页签里取消后，这一行立刻淡出并从列表移除。
   */
  private async toggleReplayFavorite(gameId: string, button: HTMLButtonElement): Promise<void> {
    if (button.disabled) return;
    const next = button.dataset.favorite !== '1';
    if (!next && !(await this.confirmUnfavorite())) return;
    button.disabled = true;
    try {
      const favorite = await this.auth.favoriteReplay(gameId, next);
      button.dataset.favorite = favorite ? '1' : '0';
      button.classList.toggle('on', favorite);
      button.setAttribute('aria-pressed', String(favorite));
      button.title = favorite ? '取消收藏（回到 30 天自动清理）' : '收藏这局棋谱，永久保留';
      button.setAttribute('aria-label', favorite ? '取消收藏' : '收藏');
      button.disabled = false;
      // 正在复盘的若是同一局，播放条上的按钮一起同步。
      if (this.replay?.id === gameId) {
        this.replay.favorite = favorite;
        this.renderReplayKeep();
      }
      toast(favorite ? '已收藏，这局棋谱永久保留' : '已取消收藏，回到 30 天自动清理');
      if (!favorite && this.replayTab === 'favorite') {
        const item = button.closest('.replay-item');
        if (item) {
          item.classList.add('leaving');
          window.setTimeout(() => {
            item.remove();
            if (!required('replay-list').childElementCount) this.renderReplayList([]);
          }, 200);
        }
      }
    } catch (error) {
      button.disabled = false;
      toast(this.errorMessage(error) || '操作失败，请稍后再试', 'error');
    }
  }

  /** 取消收藏前的确认：它会让棋谱回到 30 天自动清理的范围内，属于不可逆的「放手」。 */
  private confirmUnfavorite(): Promise<boolean> {
    return confirmAction(
      '取消收藏这局棋谱？',
      '取消后它不再永久保留，会回到 30 天自动清理的范围——30 天前的棋局将在下次清理时被删除。期间仍可正常复盘。',
      '取消收藏',
    );
  }

  /** 复盘播放条上的收藏按钮：已收藏时再点一次即取消。 */
  private async toggleCurrentReplayFavorite(): Promise<void> {
    const record = this.replay;
    if (!record) return;
    const button = required<HTMLButtonElement>('replay-keep');
    if (button.disabled) return;
    const next = record.favorite !== true;
    if (!next && !(await this.confirmUnfavorite())) return;
    button.disabled = true;
    try {
      const favorite = await this.auth.favoriteReplay(record.id, next);
      record.favorite = favorite;
      this.renderReplayKeep();
      toast(favorite ? '已收藏，这局棋谱永久保留' : '已取消收藏，回到 30 天自动清理');
    } catch (error) {
      button.disabled = false;
      toast(
        this.errorMessage(error) || (next ? '收藏失败，请稍后再试' : '取消收藏失败，请稍后再试'),
        'error',
      );
    }
  }

  /** 收藏按钮的显隐与文案（收藏 ↔ 已收藏，点一次切换）。 */
  private renderReplayKeep(): void {
    const button = required<HTMLButtonElement>('replay-keep');
    if (!this.replay) {
      button.hidden = true;
      return;
    }
    const favorite = this.replay.favorite === true;
    const label = required('replay-keep-label');
    button.hidden = false;
    button.disabled = false;
    button.classList.toggle('on', favorite);
    button.setAttribute('aria-pressed', String(favorite));
    button.title = favorite
      ? '已收藏：点击取消，棋局回到 30 天自动清理'
      : '收藏这局棋谱，永久保留';
    label.textContent = favorite ? '已收藏' : '收藏';
  }

  private requestReplaySuggestion(): void {
    const record = this.replay;
    if (!record || this.replayAnalyzing) return;
    const total = record.moves.length;
    const ply = clampIndex(this.replayIndex, total);
    if (ply >= total) {
      toast('终局之后没有下一手，拉回到任意中间局面再评估');
      return;
    }

    const key = `${record.id}:${ply}`;
    const cached = this.replaySuggestionCache.get(key);
    if (cached) {
      this.applyReplaySuggestion(ply, cached);
      return;
    }

    // 复盘评估也走本地 Rapfi：秒级返回，无需服务端参与（引擎已前端化）。
    this.replayAnalyzing = true;
    const button = required<HTMLButtonElement>('replay-ai');
    button.disabled = true;
    required('replay-ai-result').textContent = '分析中…';
    const moves = record.moves.slice(0, ply).map(
      (move) => ({ row: move.row, col: move.col, color: move.color }),
    );
    void (async () => {
      const client = await this.ensureRapfi();
      if (this.rapfiGameId !== `replay:${record.id}`) {
        client.startGame(1500);
        this.rapfiGameId = `replay:${record.id}`;
      }
      return client.think(moves, 1500);
    })()
      .then((point) => {
        const suggestion: ReplaySuggestion = { row: point.row, col: point.col, color: ply % 2 === 0 ? 1 : 2, cached: false };
        this.replaySuggestionCache.set(key, suggestion);
        // 等引擎的这几秒里用户可能已经拖走了；只在还停在原局面时才亮环。
        if (this.replay && clampIndex(this.replayIndex, total) === ply) {
          this.applyReplaySuggestion(ply, suggestion);
        }
      })
      .catch((error: unknown) => {
        const message =
          error instanceof ReplayError ? error.message : this.errorMessage(error);
        // 拖走了就不弹错误，避免用户早已不在那个局面却被旧请求吓一跳。
        if (this.replay && clampIndex(this.replayIndex, total) === ply) {
          required('replay-ai-result').textContent = '';
          toast(message ?? 'AI 评估失败，请稍后重试');
        }
      })
      .finally(() => {
        this.replayAnalyzing = false;
        button.disabled = false;
      });
  }

  /** 在当前局面亮出建议环 + 文案。缓存命中与新鲜结果共用这一个出口。 */
  private applyReplaySuggestion(ply: number, suggestion: ReplaySuggestion): void {
    this.replaySuggestion = { ...suggestion, ply };
    this.scene.showHint(suggestion.row, suggestion.col);
    this.renderReplayAiResult();
    toast(`AI 评估 · 建议${suggestion.color === 1 ? '黑' : '白'}方落子 ${this.coordinateLabel(suggestion.row, suggestion.col)}`);
  }

  /** 进度条旁那格文案：只在与当前局面同手数时显示，翻走了就清空。 */
  private renderReplayAiResult(): void {
    const span = required('replay-ai-result');
    const suggestion = this.replaySuggestion;
    if (suggestion && suggestion.ply === this.replayIndex) {
      span.textContent = `建议 ${this.coordinateLabel(suggestion.row, suggestion.col)}`;
    } else {
      span.textContent = '';
    }
  }

  private toggleReplay(): void {
    const record = this.replay;
    if (!record || record.moves.length === 0) return;
    if (this.replayTimer !== null) {
      this.stopReplayTimer();
      this.renderReplayControls();
      return;
    }
    // 已经在终局就从头播：否则按一下播放什么都不会发生。
    if (this.replayIndex >= record.moves.length) this.replayIndex = 0;
    this.replayTimer = window.setInterval(() => this.advanceReplay(), 900);
    this.renderReplayFrame();
  }

  private advanceReplay(): void {
    const record = this.replay;
    if (!record) return;
    if (this.replayIndex >= record.moves.length) {
      this.stopReplayTimer();
      this.renderReplayControls();
      return;
    }
    this.replayIndex += 1;
    this.renderReplayFrame(record.moves[this.replayIndex - 1]?.color);
  }

  private stopReplayTimer(): void {
    if (this.replayTimer === null) return;
    window.clearInterval(this.replayTimer);
    this.replayTimer = null;
  }

  /**
   * 退出复盘。
   *
   * @param options.restore 退出后是否把「进入复盘前的那盘棋」恢复出来。
   *   默认 true（结算卡进来的就回结算卡）。只有「马上要接一盘新棋」时才传 false：
   *   那时恢复旧棋盘毫无意义，只会闪一下再被新快照替换。
   */
  private exitReplay(options: { restore?: boolean } = {}): void {
    this.stopReplayTimer();
    this.replay = null;
    this.replayIndex = 0;
    this.replaySuggestion = null;
    this.replayAnalyzing = false;
    const restore = options.restore === false ? null : this.replayReturn;
    this.replayReturn = null;

    required('replay-bar').hidden = true;
    this.root.classList.remove('is-replaying');
    this.scene.setSnapshot(null);
    this.scene.setInteractive(false);

    if (restore) {
      // 从结算卡进来的：回到那张结算卡，而不是把人丢回首页。
      this.setSnapshot(restore);
      return;
    }
    this.snapshot = null;
    this.render();
  }

  // -----------------------------------------------------------------
  // 复盘「一键续弈」：把当前局面当残局起点，新开一局人机继续下
  // -----------------------------------------------------------------

  /** 打开续弈弹窗。只摆状态，真正建局在 {@link continueWithAi}。 */
  private openContinueDialog(): void {
    const record = this.replay;
    if (!record) return;
    const ply = continuePly(record, this.replayIndex);
    if (!canContinueFrom(record, ply)) {
      toast('这一步已经是终局，没法从中途接手');
      return;
    }
    required('continue-error').textContent = '';
    required('continue-subtitle').textContent =
      ply === record.moves.length
        ? `从终局盘面接手：${ply} 颗子原样保留，接着由你和引擎轮流落子。`
        : `从第 ${ply} 手接手：盘面原样保留，接着由你和引擎轮流落子。`;
    required('continue-black-note').textContent = `你执白 · ${firstMoverNote(ply, 'black')}`;
    required('continue-white-note').textContent = `你执黑 · ${firstMoverNote(ply, 'white')}`;
    required<HTMLDialogElement>('continue-dialog').showModal();
  }

  /**
   * 从复盘的局面开一局人机。
   *
   * 分工：前端只送**坐标序列**和「人执哪一边」。轮到谁、颜色怎么排、这个前缀
   * 合不合法，全部由服务端判——颜色在前端再算一遍，迟早会和它对不上，而且
   * 错得静默（棋盘摆出来的和看到的不一样）。
   */
  private async continueWithAi(aiSide: 'black' | 'white'): Promise<void> {
    const record = this.replay;
    if (!record) return;
    const ply = continuePly(record, this.replayIndex);
    if (!canContinueFrom(record, ply)) return;

    const humanSide = aiSide === 'black' ? 'white' : 'black';
    const dialog = required<HTMLDialogElement>('continue-dialog');
    if (dialog.open) dialog.close();

    try {
      await this.withSession(() => {
        this.leaveReplayForNewGame();
        this.awaitingRemoteGame = true;
        this.socket.send('ai.create', {
          color: humanSide,
          // 棋境与规则跟着棋谱走：换棋境只是换个景，换成无禁手就换了整局棋的性质。
          scene: coerceSceneId(record.scene),
          ...(record.rule ? { rule: record.rule } : {}),
          preset: presetFrom(record, ply),
        });
        toast(`已从第 ${ply} 手接手，你执${humanSide === 'black' ? '黑' : '白'}`);
      });
    } catch (error) {
      required('continue-error').textContent = this.errorMessage(error);
      // 建局没成时把弹窗放回来，别让人对着一个已经关掉的框干等。
      dialog.showModal();
    }
  }

  /**
   * 复盘状态下要接一盘新棋：先把复盘收掉。
   *
   * 必须收，否则 {@link handleRemoteSnapshot} 的第一道闸（`if (this.replay) return`）
   * 会把新棋局的快照当成「后台推送」丢掉——玩家接受约战之后界面毫无变化，
   * 人就被卡在棋谱回放里（用户实测到的 bug）。
   *
   * 传 `restore: false`：复盘若来自结算卡，默认行为是把那盘已结束的旧局摆回去，
   * 紧接着又被新快照替换，屏幕上会闪一下旧棋盘。
   */
  private leaveReplayForNewGame(): void {
    if (!this.replay) return;
    this.exitReplay({ restore: false });
  }

  /** 复盘期间的 HUD：对局界面照常在，但所有按钮都不该动。 */
  private renderReplayHud(): void {
    const record = this.replay;
    if (!record) return;
    this.root.classList.add('is-playing');

    required('welcome-screen').hidden = true;
    required('waiting-card').hidden = true;
    required('result-card').hidden = true;
    required('ai-thinking').hidden = true;
    required('replay-bar').hidden = false;
    required('board-tip').hidden = false;
    required('board-tip').textContent = '复盘 · 拖动进度条回看任意一手';

    required('mode-eyebrow').textContent = `复盘 · ${summarizeMode(record)}`;
    required('context-text').textContent = `复盘 · ${sceneName(coerceSceneId(record.scene))}`;
    required('stage-title').textContent =
      `${record.players.black?.name ?? '黑方'} 对 ${record.players.white?.name ?? '白方'}`;
    required('game-state-badge').textContent = '复盘中';
    required('game-state-badge').classList.remove('playing');
    required('stage-status').textContent = `${record.moveCount} 手 · ${resultLabel(record)}`;

    required('black-player-name').textContent = record.players.black?.name ?? '黑方';
    required('white-player-name').textContent = record.players.white?.name ?? '白方';
    required('black-you-tag').hidden = record.yourColor !== 1;
    required('white-you-tag').hidden = record.yourColor !== 2;
    required('black-player-row').classList.remove('active');
    required('white-player-row').classList.remove('active');
    required('turn-badge').hidden = true;
    this.clearClock();
    required('watch-chip').hidden = true;
    required('room-info').hidden = true;
    required('phrase-zone').hidden = true;

    required('replay-bar-title').textContent = `复盘 · ${record.moveCount} 手`;
    required('replay-bar-time').textContent = formatDateTime(record.finishedAt ?? record.createdAt);
    required('replay-bar-result').textContent = resultLabel(record);

    this.scene.setInteractive(false);
    this.closePhrasePanel();
    this.renderAccount();
    this.renderConnection();
    this.renderSoundButton();
  }

  private handleSocketError(code: string, message: string): void {
    this.awaitingRemoteGame = false;
    this.challengeJustAccepted = false;
    this.closeSentCard();
    // AI 局的 NOT_AI_TURN 一律是竞态产物：对局已结束、客户端引擎晚到的那步棋
    // 被服务端拒收（终局后服务端不再「等待 AI」）。这从来不是玩家操作失误，
    // 弹红字只会吓人——静默丢弃即可。覆盖「终局瞬间广播尚未到达、本地快照仍是
    // playing」的窗口，避免误报「当前不在等待 AI 落子」。
    if (code === 'NOT_AI_TURN' && this.snapshot?.mode === 'ai') {
      return;
    }
    // 时钟判负同理，而且更要安静：玩家这一刻该看到的是「我输了」，
    // 不是一条红字「本回合已超时」。终局快照就在路上，这里只把在途的
    // 等待态收干净（awaitingRemoteGame 上面已清），不弹条、不响错误音。
    if (code === 'CLOCK_EXPIRED') {
      this.render();
      return;
    }
    if (code === 'AUTH_REQUIRED' || code === 'UNAUTHORIZED') {
      this.user = null;
      this.sessionReady = false;
      this.renderAccount();
    }
    this.sounds.play('error');
    toast(message, 'error');
    if (required<HTMLDialogElement>('game-dialog').open) required('online-error').textContent = message;
    if (required<HTMLDialogElement>('game-dialog').open) this.renderLobby();
    this.render();
  }

  private handleConnectionStatus(status: ConnectionStatus): void {
    this.connectionStatus = status;
    if (status !== 'connected') {
      this.sessionReady = false;
      // 断线意味着握手一律作废：服务端在连接消失时会收回约战，界面不该继续等。
      this.closeSentCard();
      this.closeChallengeDialog();
      this.roster = null;
    }
    this.renderConnection();
    this.render();
  }

  private async handleAccount(): Promise<void> {
    if (!this.user) {
      required('auth-error').textContent = '';
      required<HTMLDialogElement>('auth-dialog').showModal();
      return;
    }
    const accepted = await confirmAction(
      `你好，${this.user.name}`,
      this.user.guest ? '当前是游客会话。退出后，未登录的对局身份将无法找回。' : '确认退出当前账号吗？本地对弈不会受到影响。',
      '退出登录',
    );
    if (!accepted) return;
    try {
      await this.auth.logout();
      this.socket.close();
      this.user = null;
      this.sessionReady = false;
      if (this.snapshot?.mode !== 'local' && this.snapshot) this.exitGame();
      this.renderAccount();
      toast('已安全退出');
    } catch (error) {
      toast(this.errorMessage(error), 'error');
    }
  }

  private async submitAuth(event: Event): Promise<void> {
    event.preventDefault();
    const username = required<HTMLInputElement>('auth-username').value.trim();
    const password = required<HTMLInputElement>('auth-password').value;
    const button = required<HTMLButtonElement>('auth-submit');
    setBusy(button, true, this.authTab === 'login' ? '正在登录…' : '正在注册…');
    required('auth-error').textContent = '';
    try {
      this.user = this.authTab === 'login' ? await this.auth.login(username, password) : await this.auth.register(username, password);
      this.sessionReady = false;
      this.socket.connect();
      required<HTMLDialogElement>('auth-dialog').close();
      this.renderAccount();
      toast(this.authTab === 'login' ? '欢迎回来，棋友' : '账号已创建，欢迎来到弈境');
    } catch (error) {
      required('auth-error').textContent = this.errorMessage(error);
    } finally {
      setBusy(button, false);
    }
  }

  private async enterAsGuest(): Promise<void> {
    const button = required<HTMLButtonElement>('guest-button');
    setBusy(button, true, '正在进入…');
    try {
      this.user = await this.auth.guest();
      this.sessionReady = false;
      this.socket.connect();
      required<HTMLDialogElement>('auth-dialog').close();
      this.renderAccount();
      toast('游客身份已就绪，开始你的棋局吧');
    } catch (error) {
      required('auth-error').textContent = this.errorMessage(error);
    } finally {
      setBusy(button, false);
    }
  }

  private setAuthTab(tab: 'login' | 'register'): void {
    this.authTab = tab;
    document.querySelectorAll<HTMLButtonElement>('[data-auth-tab]').forEach((button) => {
      button.classList.toggle('active', button.dataset.authTab === tab);
    });
    required<HTMLInputElement>('auth-password').autocomplete = tab === 'login' ? 'current-password' : 'new-password';
    required('auth-submit').innerHTML = `${tab === 'login' ? '登录并继续' : '注册并继续'} ${icon('arrow')}`;
    required('auth-error').textContent = '';
  }

  private render(): void {
    // 复盘有自己的一整套 HUD：对局的一切状态在这一刻都不成立
    // （没有回合、没有可悔的棋、没有对手在思考），走通用渲染只会画出一堆空值。
    this.root.classList.toggle('is-replaying', this.replay !== null);
    if (this.replay) {
      this.renderReplayHud();
      return;
    }

    const snapshot = this.snapshot;
    const spectating = snapshot?.spectating === true;
    this.renderAiSidePicker();
    // 首页不显示对局 HUD（顶栏对战条、叙事行、底部操作坞），避免和首页文案重复。
    this.root.classList.toggle('is-playing', snapshot !== null);
    this.root.classList.toggle('is-spectating', spectating);
    required('welcome-screen').hidden = snapshot !== null;
    required('waiting-card').hidden = snapshot?.mode !== 'online' || snapshot.status !== 'waiting';
    // 结算卡显隐：对局进行中或尚未开始一律隐藏；局终时若玩家临时收起则保持隐藏。
    // 一旦对局状态离开「已结束」（例如再来一局、退出），收起标记复位，
    // 这样下一局终局时结算卡会重新正常弹出，不会被上一局的状态卡住。
    if (snapshot?.status !== 'finished') this.resultCardDismissed = false;
    required('result-card').hidden = snapshot?.status !== 'finished' || this.resultCardDismissed;
    // 本地对弈只存在于这台设备上，服务端没有它的棋谱，所以不给复盘入口。
    required('result-replay').hidden = snapshot?.mode === 'local';
    required('ai-thinking').hidden = !snapshot?.aiThinking;
    required('board-tip').hidden = snapshot?.status === 'waiting';
    required('board-tip').textContent = snapshot?.mode === 'online' && snapshot.status === 'playing'
      ? '左键落子 · 点桌上的铜铃催促 · 右键旋转'
      : '右键拖动旋转 · 滚轮缩放';
    this.scene.setInteractive(this.canMove());

    const modeNames = { local: '本地对弈', ai: 'AI 对弈', online: '好友联机' } as const;
    // 残局局要标出处：盘上几颗子不是自己下的，不写一句「从第 N 手接手」，
    // 玩家会以为自己刚才漏看了半盘棋。
    const practiceSuffix = (snapshot?.startPly ?? 0) > 0 ? ` · 残局自第 ${snapshot?.startPly} 手` : '';
    required('mode-eyebrow').textContent = snapshot
      ? `${spectating ? '观战' : modeNames[snapshot.mode]} · 十五路无禁手${timeBudgetSuffix(snapshot.timeControl)}${practiceSuffix}`
      : '十五路 · 无禁手';
    required('stage-title').textContent = snapshot ? this.stageTitle(snapshot) : '落子有声，心静无界。';
    required('context-text').textContent = snapshot
      // 棋境名也进上下文行：换景是后台自动发生的（随机 / 跟随房主），
      // 屏幕上不写一句「你在哪儿下棋」，玩家会误以为场景是随机跳的。
      ? `${modeNames[snapshot.mode]}${spectating ? ' · 观战' : ''}${snapshot.roomCode ? ` · 房间 ${snapshot.roomCode}` : ''} · ${sceneName(coerceSceneId(snapshot.scene))}`
      : '一方棋盘，一刻安宁';
    required('game-state-badge').textContent = snapshot ? this.statusLabel(snapshot) : '未开始';
    required('game-state-badge').classList.toggle('playing', snapshot?.status === 'playing');

    const watchers = snapshot?.spectatorCount ?? 0;
    const watchChip = required('watch-chip');
    watchChip.hidden = watchers <= 0;
    required('watch-count').textContent = String(watchers);
    // 观战者名单：对局内的人能直接看到谁在看棋（最多列三个，其余折叠）。
    const names = snapshot && 'spectators' in snapshot ? snapshot.spectators ?? [] : [];
    const watchNames = required('watch-names');
    const shown = names.slice(0, 3).map((item) => item.name);
    watchNames.textContent = shown.length > 0
      ? ` · ${shown.join('、')}${names.length > 3 ? ` 等 ${names.length} 人` : ''}`
      : '';
    watchChip.title = names.map((item) => item.name).join('、');

    const blackName = snapshot?.players.black.name ?? '黑方';
    const whiteName = snapshot?.players.white?.name ?? (snapshot?.mode === 'online' ? '等待棋友' : '白方');
    required('black-player-name').textContent = blackName;
    required('white-player-name').textContent = whiteName;
    // 联机对局里点双方名字可看名片；本地 / 人机没有「别人」可看，不挂链接。
    const onlineMatch = snapshot?.mode === 'online';
    this.bindProfileLink('black-player-name', onlineMatch ? snapshot?.players.black : null);
    this.bindProfileLink('white-player-name', onlineMatch ? snapshot?.players.white : null);
    required('black-you-tag').hidden = snapshot?.yourColor !== 1;
    required('white-you-tag').hidden = snapshot?.yourColor !== 2;
    required('black-player-row').classList.toggle('active', snapshot?.status === 'playing' && snapshot.currentPlayer === 1);
    required('white-player-row').classList.toggle('active', snapshot?.status === 'playing' && snapshot.currentPlayer === 2);

    required('move-count').innerHTML = `${snapshot?.moveCount ?? 0} <small>手</small>`;
    required('current-color').textContent = snapshot?.status === 'finished' ? '已结束' : snapshot ? snapshot.currentPlayer === 1 ? '黑方' : '白方' : '—';
    const turnBadge = required('turn-badge');
    turnBadge.hidden = !snapshot || snapshot.status !== 'playing';
    if (snapshot) {
      const stone = turnBadge.querySelector('.mini-stone');
      stone?.classList.toggle('black', snapshot.currentPlayer === 1);
      stone?.classList.toggle('white', snapshot.currentPlayer === 2);
      const label = snapshot.aiThinking ? '对方正在思考' : `${snapshot.currentPlayer === 1 ? '黑方' : '白方'}回合`;
      required('turn-label').textContent = label;
    }
    // 倒计时就长在回合徽标里：眼睛本来就盯在这一行看「轮到谁」，
    // 剩余时间跟在一起才有人看；另起一行只会多一个要被扫视的元素。
    this.renderClock();

    required('room-info').hidden = !snapshot?.roomCode;
    required('panel-room-code').textContent = snapshot?.roomCode ?? '——';
    required('waiting-room-code').textContent = snapshot?.roomCode ?? '——';
    required('stage-status').textContent = this.stageStatus(snapshot);
    // 快捷短语菜单只在「好友联机对局」出现：本地/人机对弈无意义、观战者不能发言。
    required('phrase-zone').hidden = !(snapshot && snapshot.mode === 'online' && !snapshot.spectating);
    // 切换对局状态时，确保菜单处于收起态，避免残留展开面板。
    this.closePhrasePanel();
    this.refreshScenePickerLock();
    // 重开按钮：联机 PVP 自己已发起请求 → 变「取消重开」且可点；对方已发起请求 → 禁用（改走弹窗）；
    // 其余情况沿用原禁用条件。
    const restartButton = required<HTMLButtonElement>('restart-button');
    const restartLabel = restartButton.querySelector('span');
    if (snapshot?.restartPending) {
      restartButton.disabled = false;
      if (restartLabel) restartLabel.textContent = '取消重开';
    } else {
      if (restartLabel) restartLabel.textContent = '重开';
      restartButton.disabled = !snapshot || snapshot.status === 'waiting' || spectating || !!snapshot.restartRequest;
    }
    required<HTMLButtonElement>('undo-button').disabled = !snapshot?.canUndo || snapshot.aiThinking;
    // 人机 / 本地对弈的「AI 分析」：手动让本地引擎分析当前局面，给下一手推荐。
    // 仅在对局进行中可用；人机局还要避开 AI 正在思考（避免与 AI 落子抢引擎）。
    const aiEvaluateButton = required<HTMLButtonElement>('ai-evaluate-button');
    aiEvaluateButton.hidden = !(snapshot && (snapshot.mode === 'ai' || snapshot.mode === 'local') && snapshot.status === 'playing' && !snapshot.spectating);
    aiEvaluateButton.disabled = !!snapshot?.aiThinking || this.aiEvaluationInFlight;
    // AI 分析按钮：只在好友联机对局中出现；已发出请求后置灰等回应。
    const aiAnalysisButton = required<HTMLButtonElement>('ai-analysis-button');
    const analysisAvailable = snapshot?.mode === 'online'
      && snapshot.status === 'playing'
      && !snapshot.spectating
      && !!snapshot.players.white;
    aiAnalysisButton.hidden = !analysisAvailable;
    aiAnalysisButton.disabled = this.aiAnalysisRequestedGame === snapshot?.id;
    // 认输：本地同屏对弈无意义，移除；人机/联机保留。
    required<HTMLButtonElement>('resign-button').hidden = snapshot?.mode === 'local';
    required<HTMLButtonElement>('resign-button').disabled = !snapshot || snapshot.status !== 'playing' || spectating || (snapshot.mode === 'online' && !snapshot.players.white);
    required<HTMLButtonElement>('exit-button').disabled = !snapshot;
    const exitLabel = required('exit-button').querySelector('span');
    if (exitLabel) exitLabel.textContent = spectating ? '离开' : '退出';
    if (snapshot?.status === 'finished') this.renderResult(snapshot);
    this.renderOpeningOverlay();
    this.renderAccount();
    this.renderSoundButton();
    this.renderConnection();
  }

  /** 开局「决定先后手」面板：协商中显示选择、揭晓时显示硬币或「双方一致」提示，其余时刻收起并复位。 */
  private renderOpeningOverlay(): void {
    const overlay = required('opening-overlay');
    const card = required('opening-card');
    const choices = required('opening-choices');
    const status = required('opening-status');
    const coin = required('opening-coin');
    const selfBtn = required<HTMLButtonElement>('opening-self');
    const oppBtn = required<HTMLButtonElement>('opening-opponent');

    if (this.opening) {
      // 协商进行中：双方各自独立选择谁先手。
      overlay.hidden = false;
      card.hidden = false;
      coin.hidden = true;
      const youChose = this.opening.youChose;
      const opponentChose = this.opening.opponentChose;
      required('opening-title').textContent = youChose ? '已选择，等待对方…' : '你希望谁先手？';
      const sub = required('opening-sub');
      if (youChose && !opponentChose) sub.textContent = '对方还在犹豫，稍候片刻。';
      else if (youChose && opponentChose) sub.textContent = '双方都已表态，正在揭晓…';
      else sub.textContent = '双方各自独立选择，谁先手由你们共同决定。';
      selfBtn.classList.toggle('chosen', youChose === 'self');
      oppBtn.classList.toggle('chosen', youChose === 'opponent');
      selfBtn.disabled = youChose !== null;
      oppBtn.disabled = youChose !== null;
      choices.hidden = false;
      status.hidden = true;
      return;
    }

    if (this.coinActive && this.openingResult) {
      // 揭晓阶段：抛硬币走 3D 动画，一致则直接以文字确认。
      overlay.hidden = false;
      if (this.openingResult.method === 'coin') {
        card.hidden = true;
        coin.hidden = false;
      } else {
        card.hidden = false;
        coin.hidden = true;
        choices.hidden = true;
        status.hidden = false;
        const firstName = this.openingResult.seats[this.openingResult.firstSeat]?.name ?? '先手';
        status.textContent = `双方一致 · ${escapeHtml(firstName)} 先手`;
      }
      return;
    }

    // 既非协商也非揭晓：彻底收起，并把面板复位成干净状态，下次进入是清爽的。
    overlay.hidden = true;
    card.hidden = false;
    choices.hidden = false;
    status.hidden = true;
    selfBtn.classList.remove('chosen');
    oppBtn.classList.remove('chosen');
    selfBtn.disabled = false;
    oppBtn.disabled = false;
  }

  private renderResult(snapshot: AnyGameSnapshot): void {
    const spectating = snapshot.spectating === true;
    const winnerName = snapshot.winner === 1 ? '黑方' : '白方';
    let title = `${winnerName}胜出`;
    if (snapshot.winReason === 'draw') title = '和棋，亦是圆满';
    else if (!spectating && snapshot.yourColor && snapshot.winner === snapshot.yourColor) title = '你赢得了这一局';
    else if (!spectating && snapshot.yourColor) title = '胜败之外，皆有收获';
    required('result-title').textContent = title;

    // 超时判负必须说清「谁的表走完了」：只写「一方超时」，输的人不确定是不是
    // 自己，赢的人也不确定这局到底算不算赢。观战者没有立场，用黑白称呼。
    const loserName = snapshot.winner === 1 ? '白方' : '黑方';
    const timeoutText = spectating || !snapshot.yourColor
      ? `${loserName}思考超时，本局结束`
      : snapshot.yourColor === snapshot.winner
        ? '对方思考超时，本局由你取胜'
        : '你思考超时，本局判负';
    const description = snapshot.winReason === 'draw'
      ? '棋盘已满，感谢这一场势均力敌的对弈'
      : snapshot.winReason === 'offline'
        ? '一方断线超过两分钟，本局自动结束'
        : snapshot.winReason === 'timeout'
          ? timeoutText
          : `${winnerName} · 谢谢你的专注与投入`;
    required('result-description').textContent = description;
    // 残局练习局的 `moveCount` 里含着载入的棋谱：报给人看的应该是「这一局你下了
    // 几手」，把别人下过的一起算进去，会让人以为自己下了几十手。
    const startPly = snapshot.startPly ?? 0;
    required('result-moves').textContent = String(Math.max(0, snapshot.moveCount - startPly));
    if (startPly > 0) {
      required('result-description').textContent = `${description}（本局从第 ${startPly} 手残局接手）`;
    }
    required('result-reason').textContent = snapshot.winReason === 'draw'
      ? '棋盘已满'
      : snapshot.winReason === 'offline'
        ? '断线超时'
        : snapshot.winReason === 'timeout'
          ? '思考超时'
          : snapshot.winReason === 'resign' ? '一方认输' : '五子连珠';
    required('result-emblem').textContent = snapshot.winReason === 'draw'
      ? '和'
      : snapshot.winReason === 'offline'
        ? '断'
        : snapshot.winReason === 'timeout' ? '时' : snapshot.winReason === 'resign' ? '终' : '五';
    // 看棋的人没有「再来一局」：这盘棋不归他。
    required('result-restart').hidden = spectating;
    required('result-home').textContent = spectating ? '离开观战' : '返回模式选择';
  }

  /**
   * 局终后点击棋盘「周围区域」（结算卡之外的空白棋盘）的回调：临时收起 / 恢复结算卡。
   *
   * 设计要点：点击只会落在 canvas 上（结算卡是浮在棋盘上的独立 DOM，点它不会穿透到
   * canvas），所以天然就是「点周围区域」。而拖拽（右键旋转）与缩放（滚轮）都不会产生
   * 这个回调，临时收起期间玩家随意转视角、拉远近，结算卡都不会被重新唤醒；想恢复时
   * 再点一次周围区域即可。收起状态用 `resultCardDismissed` 记录，`render()` 在局终时
   * 会尊重它，离开「已结束」状态则自动复位。
   */
  private toggleResultCard(): void {
    this.resultCardDismissed = !this.resultCardDismissed;
    required('result-card').hidden = this.resultCardDismissed;
  }

  private renderAccount(): void {
    required('account-name').textContent = this.user ? this.user.name : '登录 / 注册';
    required('account-button').title = this.user ? `${this.user.guest ? '游客' : '已登录'} · 点击退出` : '登录或注册';
  }

  private renderSoundButton(): void {
    const button = required('sound-button');
    const muted = this.sounds.isMuted;
    button.innerHTML = icon(muted ? 'muted' : 'sound');
    button.title = muted ? '开启音效' : '静音';
    button.setAttribute('aria-label', button.title);
  }

  private renderConnection(): void {
    const element = required('connection-status');
    element.hidden = !this.user;
    element.className = `connection-status ${this.connectionStatus}`;
    const label = this.connectionStatus === 'connected' ? '已连接' : this.connectionStatus === 'connecting' ? '连接中' : '等待重连';
    const text = element.querySelector('span');
    if (text) text.textContent = label;
  }

  private stageTitle(snapshot: AnyGameSnapshot): string {
    if (snapshot.status === 'waiting') return '房间已备好，静候棋友。';
    if (snapshot.status === 'finished') return '一局落幕，余韵悠长。';
    if (snapshot.aiThinking) return '静心等待，AI 正在思考。';
    if (snapshot.spectating) return '静观棋局，落子有声。';
    if (snapshot.mode === 'ai') {
      const watching = snapshot.aiBlack && snapshot.aiWhite;
      if (watching) return '观赏模式 · AI 黑白轮番对弈。';
      return '轮到你了，专注下一步。';
    }
    if (snapshot.mode !== 'local' && snapshot.yourColor === snapshot.currentPlayer) return '轮到你了，专注下一步。';
    return snapshot.currentPlayer === 1 ? '黑方落子，棋局伊始。' : '白方落子，从容应对。';
  }

  private stageStatus(snapshot: AnyGameSnapshot | null): string {
    if (!snapshot) return '请选择对弈方式';
    if (snapshot.status === 'waiting') return '等待对手加入房间';
    if (snapshot.status === 'finished') return '本局已结束';
    if (snapshot.spectating) return `观战中 · ${snapshot.currentPlayer === 1 ? '黑方' : '白方'}回合`;
    if (snapshot.aiThinking) return 'AI 正在计算下一步';
    if (snapshot.mode === 'local') return `${snapshot.currentPlayer === 1 ? '黑方' : '白方'}回合 · 点击交叉点落子`;
    if (snapshot.mode === 'ai') return `${snapshot.currentPlayer === 1 ? '黑方' : '白方'}回合 · 点击交叉点落子`;
    return snapshot.yourColor === snapshot.currentPlayer ? '轮到你了 · 点击交叉点落子' : '等待对方落子';
  }

  private statusLabel(snapshot: AnyGameSnapshot): string {
    if (snapshot.status === 'waiting') return '等待加入';
    if (snapshot.status === 'finished') return '已结束';
    if (snapshot.spectating) return '观战中';
    return '对弈中';
  }

  private async copyRoomCode(): Promise<void> {
    const code = this.snapshot?.roomCode;
    if (!code) return;
    if (await copyText(code)) {
      this.sounds.play('join');
      toast(`房间号 ${code} 已复制`);
    } else {
      toast(`房间号：${code}`);
    }
  }

  private joinSubmitButton(): HTMLButtonElement {
    const button = required('join-form').querySelector<HTMLButtonElement>('button[type="submit"]');
    if (!button) throw new Error('缺少加入房间按钮');
    return button;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : '操作未能完成，请重试';
  }
}

const root = document.getElementById('app');
if (!root) throw new Error('缺少应用挂载节点');
new YijingApp(root);
