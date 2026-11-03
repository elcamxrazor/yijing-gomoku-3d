/**
 * 本地显示设置。
 *
 * 这些东西**只影响自己看到的画面**，不参与任何对局判定，所以既不进服务器、
 * 也不进 `GameSnapshot`——存 `localStorage`，换台设备就是另一套偏好。
 *
 * 之所以单独开一个模块而不是塞进 `shop/store.ts`：商城那份档案是「游戏进度」
 * （积分、解锁、装备），丢了会让玩家损失东西；这里是「怎么看棋盘」，
 * 丢了无所谓，两者的容错策略也不该一样。
 */

/** 步数编号的显示范围。 */
export type MoveNumberMode = 'off' | 'last' | 'lastTwo' | 'all';

export interface GameSettings {
  moveNumbers: MoveNumberMode;
  /** 是否按对方玩家装备的皮肤渲染对方的棋子（默认显示）。 */
  showOpponentSkin: boolean;
  /** 是否在棋盘四周显示坐标（A–O 列、1–15 行），方便讲棋与复盘对照。 */
  showBoardCoordinates: boolean;
}

export const MOVE_NUMBER_OPTIONS: ReadonlyArray<{
  value: MoveNumberMode;
  label: string;
  hint: string;
}> = [
  { value: 'off', label: '不显示', hint: '只看黑白，画面最干净。' },
  { value: 'last', label: '最新一步', hint: '只在刚落下的那颗子上标号，方便确认对手下在哪。' },
  { value: 'lastTwo', label: '最新两步', hint: '标出最近两手，看得清「他下这里、我应那里」。' },
  { value: 'all', label: '全部步数', hint: '每颗子都标上手数，适合复盘与讲棋。' },
];

const STORAGE_KEY = 'yijing.settings.v1';

const DEFAULTS: GameSettings = { moveNumbers: 'off', showOpponentSkin: true, showBoardCoordinates: false };

/** 非法值一律退回默认：手改 `localStorage` 不该让界面崩掉。 */
export function normalizeMoveNumberMode(value: unknown): MoveNumberMode {
  return value === 'off' || value === 'last' || value === 'lastTwo' || value === 'all'
    ? value
    : DEFAULTS.moveNumbers;
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // 隐私模式 / 禁用 Cookie 时访问 localStorage 会直接抛错。
    return null;
  }
}

export function loadSettings(storage: Storage | null = safeStorage()): GameSettings {
  if (!storage) return { ...DEFAULTS };
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== 'object') return { ...DEFAULTS };
    const record = data as Record<string, unknown>;
    return {
      moveNumbers: normalizeMoveNumberMode(record.moveNumbers),
      showOpponentSkin: record.showOpponentSkin === undefined ? true : record.showOpponentSkin === true,
      showBoardCoordinates: record.showBoardCoordinates === true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: GameSettings, storage: Storage | null = safeStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({
      moveNumbers: settings.moveNumbers,
      showOpponentSkin: settings.showOpponentSkin,
      showBoardCoordinates: settings.showBoardCoordinates,
    }));
  } catch {
    // 写不进去（配额满 / 隐私模式）也不该影响对局，静默忽略。
  }
}

/**
 * 该给哪几手标号（返回从 0 开始的着法序号）。
 *
 * 抽成纯函数是为了能单测：它是这个功能里唯一会「算错就看不出来」的地方——
 * 少标一手、多标一手，肉眼都不一定发现，但玩家会以为棋谱错了。
 */
export function visibleMoveIndices(mode: MoveNumberMode, total: number): number[] {
  // 先收口成合法的非负整数：`Math.floor(NaN)` 还是 NaN，
  // 后面拿它算 `Array.from({length})` 会得到一堆看起来「正常」的空数组，
  // 出问题时完全看不出是这个入参的锅。
  const count = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  if (mode === 'off' || count === 0) return [];
  if (mode === 'all') return Array.from({ length: count }, (_, index) => index);
  const tail = mode === 'last' ? 1 : 2;
  const start = Math.max(0, count - tail);
  return Array.from({ length: count - start }, (_, offset) => start + offset);
}


/**
 * 用服务端持久化的设置覆盖本地（登录后同步一次；服务端是权威）。
 * 只覆盖认识的键，缺省键保留本地值（老账号无此数据时不重置）。
 */
export function mergeServerSettings(settings: GameSettings, prefs: Record<string, unknown>): GameSettings {
  const next: GameSettings = { ...settings };
  if (prefs.moveNumbers !== undefined) next.moveNumbers = normalizeMoveNumberMode(prefs.moveNumbers);
  if (prefs.showOpponentSkin !== undefined) next.showOpponentSkin = prefs.showOpponentSkin === true;
  if (prefs.showBoardCoordinates !== undefined) next.showBoardCoordinates = prefs.showBoardCoordinates === true;
  return next;
}
