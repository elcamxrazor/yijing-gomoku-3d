/**
 * 用户积分与商城（服务端权威 + 本地缓存）。
 *
 * 积分与已解锁商品的唯一权威在后端（users.points / users.unlocked）：
 * 每局终局由服务端发放积分，购买经 `POST /api/shop/purchase` 扣费，
 * 本地档案只是登录后同步下来的缓存——刷新后保留、换设备跟随账号。
 * 纯客户端偏好（装备哪套材质）仍存本地。
 *
 * 关键约束：
 * - 每下完一局给固定积分，数值集中配置（`POINTS_PER_GAME`，与服务端一致）。
 * - 结算 / 扣费全部服务端做，本地不再写钱包。
 */

import { DEFAULT_BLACK_MATERIAL, DEFAULT_WHITE_MATERIAL } from '../scene/stoneMaterials';

/** 带项目命名空间的存储键，避免与其它应用冲突。 */
const STORAGE_KEY = 'yijing.profile.v1';

/** 每局结束发放的积分（集中配置，便于调整）。 */
export const POINTS_PER_GAME = 10;

/** 新用户初始积分；历史档案在版本迁移时统一调整为该值。 */
export const INITIAL_POINTS = 10000;

/** 用户档案版本；旧版本数据会被迁移 / 丢弃到默认值。 */
const PROFILE_VERSION = 3;

/** 已结算局记录上限，防止 localStorage 无限增长。 */
const MAX_SETTLED = 120;

/** 商城商品类型。 */
export type ShopKind = 'material' | 'scene';

/** 一件商城商品的定义（静态配置，不进库）。 */
export interface ShopItem {
  /** 商品 id（落库记录解锁状态用）。 */
  id: string;
  /** 商品类型：材质 or 棋境。 */
  kind: ShopKind;
  /** 商品名。 */
  name: string;
  /** 价格（积分）。 */
  price: number;
  /** 材质类：对应的材质 id；棋境类：对应的棋境 id。 */
  target: string;
  /** 材质类：作用方（黑 / 白）；棋境类为 null。 */
  side: 'black' | 'white' | null;
  /** 一句话说明。 */
  description: string;
  /**
   * 商城色块展示色（可选）。缺省用材质自身的 `color`。
   *
   * 材质为了抵消场景暖光/透射偏色，真实底色可能不是展示想要的色值；
   * 这里允许单独指定一个「展示用」的标准色（如鸿璐固定 #5DFDE4）。
   */
  swatch?: string;
}

/** 用户档案：钱包缓存（服务端同步）+ 本地装备偏好。 */
export interface UserProfile {
  version: number;
  /** 服务端权威余额的本地缓存；未登录 / 未同步时保持初始值。 */
  points: number;
  /** 服务端已解锁列表的本地缓存。 */
  unlocked: string[];
  /** 当前装备的材质（黑 / 白各一份 id；默认实体棋子）。纯本地偏好。 */
  equipped: { materialBlack: string; materialWhite: string };
  /** 已废弃（结算已服务端化），仅为旧 localStorage 兼容保留字段。 */
  settledGames: string[];
}

/** 商城商品配置表（顺序即展示顺序）。棋境已全部免费，商城只卖棋子材质。 */
export const SHOP_ITEMS: ShopItem[] = [
  {
    id: 'mat-frosted-black',
    kind: 'material',
    name: '墨玉',
    price: 30,
    target: 'frosted-black',
    side: 'black',
    description: '磨砂半透明黑子，朦胧玻璃质感，边缘透出木色光晕。',
  },
  {
    id: 'mat-frosted-cyan',
    kind: 'material',
    name: '鸿璐',
    price: 30,
    target: 'frosted-cyan',
    side: 'black',
    description: '青色透明黑子，清透如玻璃，青碧在棋子内流转。',
    // 展示色固定为标准青，不受材质为抵消暖光而做的底色补偿影响。
    swatch: '#5DFDE4',
  },
  {
    id: 'mat-translucent-white',
    kind: 'material',
    name: '凝脂',
    price: 30,
    target: 'translucent-white',
    side: 'white',
    description: '半透明白子，清透玻璃棋子，光线在其间流转。',
  },
];

// 可注入的存储：默认 localStorage，不可用时（隐私模式 / SSR）回退到内存，保证异常兜底。
let storage: { getItem(key: string): string | null; setItem(key: string, value: string): void } = (() => {
  try {
    if (typeof localStorage !== 'undefined') {
      const probe = '__yijing_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return localStorage;
    }
  } catch {
    // 隐私模式或不可用时回退内存，不抛错。
  }
  const memory = new Map<string, string>();
  return {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => {
      memory.set(key, value);
    },
  };
})();

/** 仅测试用：替换底层存储实现。 */
export function setStorageForTesting(next: { getItem(key: string): string | null; setItem(key: string, value: string): void }): void {
  storage = next;
}

/** 构建一份干净的默认档案。 */
function defaultProfile(): UserProfile {
  return {
    version: PROFILE_VERSION,
    points: INITIAL_POINTS,
    unlocked: [],
    equipped: { materialBlack: DEFAULT_BLACK_MATERIAL, materialWhite: DEFAULT_WHITE_MATERIAL },
    settledGames: [],
  };
}

/**
 * 读取用户档案：处理首次初始化、数据缺失、版本不兼容与解析异常，任何情况下都回退默认。
 */
export function loadProfile(): UserProfile {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return defaultProfile();
    const data = JSON.parse(raw) as Partial<UserProfile>;
    if (!data || typeof data !== 'object') return defaultProfile();

    const base = defaultProfile();
    let points = typeof data.points === 'number' && data.points >= 0 ? Math.floor(data.points) : 0;
    const unlocked = Array.isArray(data.unlocked)
      ? data.unlocked.filter((value): value is string => typeof value === 'string')
      : [];
    const equipped = {
      materialBlack: typeof data.equipped?.materialBlack === 'string' ? data.equipped.materialBlack : base.equipped.materialBlack,
      materialWhite: typeof data.equipped?.materialWhite === 'string' ? data.equipped.materialWhite : base.equipped.materialWhite,
    };
    const settledGames = Array.isArray(data.settledGames)
      ? data.settledGames.filter((value): value is string => typeof value === 'string').slice(-MAX_SETTLED)
      : [];
    // 迁移（v3）：所有用户积分一次性调整为 10000，后续正常累加。
    const storedVersion = typeof data.version === 'number' ? data.version : 0;
    if (storedVersion < 3) {
      points = INITIAL_POINTS;
    }
    // 版本不兼容时直接采用现有字段并写回新版本号（迁移）。
    return { version: PROFILE_VERSION, points, unlocked, equipped, settledGames };
  } catch {
    // 解析失败（脏数据 / 截断）一律回退默认，不阻塞游戏。
    return defaultProfile();
  }
}

/** 持久化用户档案；写入失败（配额 / 隐私模式）静默兜底。 */
export function saveProfile(profile: UserProfile): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // 写不进也不影响当前会话的运行。
  }
}

/**
 * 用服务端钱包覆盖本地缓存（只动 points / unlocked，装备偏好不碰）。
 */
export function applyWallet(profile: UserProfile, points: number, unlocked: string[]): void {
  profile.points = typeof points === 'number' && points >= 0 ? Math.floor(points) : profile.points;
  profile.unlocked = Array.isArray(unlocked) ? unlocked.filter((v): v is string => typeof v === 'string') : profile.unlocked;
}

/** 当前积分（便于 UI 显示）。 */
export function getPoints(profile: UserProfile): number {
  return profile.points;
}

/** 某商品是否已解锁（依据服务端同步下来的缓存）。 */
export function isUnlocked(profile: UserProfile, itemId: string): boolean {
  return profile.unlocked.includes(itemId);
}

/**
 * 装备材质：仅对已解锁的材质生效。
 * 再次点击已装备的材质会「取消装备」回退到默认实体棋子。
 */
export function equipMaterial(profile: UserProfile, itemId: string): { ok: boolean; reason?: string } {
  const item = SHOP_ITEMS.find((candidate) => candidate.id === itemId);
  if (!item || item.kind !== 'material') return { ok: false, reason: '商品不存在' };
  if (!isUnlocked(profile, itemId)) return { ok: false, reason: '尚未解锁' };
  if (item.side === 'black') {
    profile.equipped.materialBlack = profile.equipped.materialBlack === item.target ? DEFAULT_BLACK_MATERIAL : item.target;
  } else if (item.side === 'white') {
    profile.equipped.materialWhite = profile.equipped.materialWhite === item.target ? DEFAULT_WHITE_MATERIAL : item.target;
  }
  saveProfile(profile);
  return { ok: true };
}

/**
 * 某棋境是否已解锁。棋境不再需要积分解锁（当前与后续所有场景永久免费），
 * 保留函数形式是为了给将来可能的「条件解锁」留同一入口。
 */
export function isSceneUnlocked(_profile: UserProfile, _sceneId: string): boolean {
  return true;
}
