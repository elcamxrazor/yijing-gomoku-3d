import type { SessionUser } from '../game/types';

interface UserResponse {
  user: SessionUser | null;
}

/** 个人名片的对局统计（拓展接口：后续新维度直接追加字段）。 */
export interface ProfileStats {
  totalGames: number;
  wins: number;
  losses: number;
  draws: number;
  /** 0~1；没有对局时为 null。 */
  winrate: number | null;
}

/** 查看他人名片时的公开资料：身份 + 战绩 + 积分（积分是公开分数，不含钱包细节）。 */
export interface PublicProfile extends ProfileStats {
  id: string;
  name: string;
  guest: boolean;
  points: number;
}

/** 积分钱包（服务端权威）。 */
export interface Wallet {
  points: number;
  unlocked: string[];
  pointsPerGame: number;
  /** 装备的棋子皮肤（服务端持久化，换设备跟随）。 */
  equipped: { materialBlack: string; materialWhite: string };
}

export class AuthError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'AuthError';
  }
}

export class AuthClient {
  private readonly baseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

  me(): Promise<SessionUser | null> {
    return this.request('/api/auth/me');
  }

  login(username: string, password: string): Promise<SessionUser | null> {
    return this.request('/api/auth/login', { username, password });
  }

  register(username: string, password: string): Promise<SessionUser | null> {
    return this.request('/api/auth/register', { username, password });
  }

  guest(): Promise<SessionUser | null> {
    return this.request('/api/auth/guest');
  }

  async logout(): Promise<void> {
    await this.request('/api/auth/logout');
  }

  /** 自己的对局统计（GET /api/users/me/stats）。 */
  async stats(): Promise<ProfileStats> {
    const raw: unknown = await this.requestRaw('/api/users/me/stats');
    if (!raw || typeof raw !== 'object') throw new AuthError('对局统计数据不完整', 500);
    return this.parseStats(raw as Record<string, unknown>);
  }

  /** 查看任意玩家的公开战绩（GET /api/users/{id}/stats；不含钱包）。 */
  async statsFor(userId: string): Promise<PublicProfile> {
    const raw: unknown = await this.requestRaw(`/api/users/${encodeURIComponent(userId)}/stats`);
    if (!raw || typeof raw !== 'object') throw new AuthError('玩家资料不完整', 500);
    const data = raw as Record<string, unknown>;
    return {
      ...this.parseStats(data),
      id: typeof data.id === 'string' ? data.id : userId,
      name: typeof data.name === 'string' ? data.name : '玩家',
      guest: data.guest === true,
      points: typeof data.points === 'number' ? data.points : 0,
    };
  }

  /** 把统计响应解析成扁平结构；缺字段一律回落 0 / null，不阻塞名片渲染。 */
  private parseStats(data: Record<string, unknown>): ProfileStats {
    const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
    return {
      totalGames: num(data.totalGames),
      wins: num(data.wins),
      losses: num(data.losses),
      draws: num(data.draws),
      winrate: typeof data.winrate === 'number' ? data.winrate : null,
    };
  }

  /** 积分钱包：余额 + 已解锁商品（GET /api/users/me/wallet）。 */
  async wallet(): Promise<Wallet> {
    const raw: unknown = await this.requestRaw('/api/users/me/wallet');
    if (!raw || typeof raw !== 'object') throw new AuthError('钱包数据不完整', 500);
    const data = raw as Record<string, unknown>;
    const equippedRaw = (data.equipped ?? {}) as Record<string, unknown>;
    return {
      points: typeof data.points === 'number' ? data.points : 0,
      unlocked: Array.isArray(data.unlocked) ? (data.unlocked as string[]) : [],
      pointsPerGame: typeof data.pointsPerGame === 'number' ? data.pointsPerGame : 10,
      equipped: {
        materialBlack: typeof equippedRaw.materialBlack === 'string' ? equippedRaw.materialBlack : 'solid-black',
        materialWhite: typeof equippedRaw.materialWhite === 'string' ? equippedRaw.materialWhite : 'solid-white',
      },
    };
  }

  /** 保存皮肤装备（POST /api/shop/equip；服务端校验已解锁）。 */
  async equip(materialBlack: string, materialWhite: string): Promise<{ materialBlack: string; materialWhite: string }> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/shop/equip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ material_black: materialBlack, material_white: materialWhite }),
      });
    } catch {
      throw new AuthError('暂时无法连接服务器，请检查网络后重试', 0);
    }
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new AuthError(this.errorMessage(data) ?? '皮肤保存失败，请稍后再试', response.status);
    }
    const equipped = ((data as Record<string, unknown>)?.equipped ?? {}) as Record<string, unknown>;
    return {
      materialBlack: typeof equipped.materialBlack === 'string' ? equipped.materialBlack : materialBlack,
      materialWhite: typeof equipped.materialWhite === 'string' ? equipped.materialWhite : materialWhite,
    };
  }

  /** 拉取服务端持久化的显示设置。 */
  async preferences(): Promise<Record<string, unknown>> {
    const raw: unknown = await this.requestRaw('/api/users/me/preferences');
    const prefs = (raw as Record<string, unknown>)?.preferences;
    return prefs && typeof prefs === 'object' ? (prefs as Record<string, unknown>) : {};
  }

  /** 持久化显示设置到服务端（fire-and-forget 场景也可 await）。 */
  async savePreferences(prefs: Record<string, unknown>): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/users/me/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ preferences: prefs }),
      });
    } catch {
      throw new AuthError('暂时无法连接服务器，请检查网络后重试', 0);
    }
    if (!response.ok) {
      const data: unknown = await response.json().catch(() => null);
      throw new AuthError(this.errorMessage(data) ?? '设置保存失败', response.status);
    }
  }

  /**
   * 收藏 / 取消收藏棋谱。
   * 收藏（POST）后永久保留；取消（DELETE）后回到 30 天滚动清理的范围内。
   * 两个方向都幂等，返回服务端确认后的最终状态。
   */
  async favoriteReplay(gameId: string, favorite: boolean): Promise<boolean> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/games/replays/${encodeURIComponent(gameId)}/keep`, {
        method: favorite ? 'POST' : 'DELETE',
        credentials: 'include',
      });
    } catch {
      throw new AuthError('暂时无法连接服务器，请检查网络后重试', 0);
    }
    if (!response.ok) {
      const data: unknown = await response.json().catch(() => null);
      throw new AuthError(
        this.errorMessage(data) ?? (favorite ? '收藏失败，请稍后再试' : '取消收藏失败，请稍后再试'),
        response.status,
      );
    }
    const data: unknown = await response.json().catch(() => null);
    return data && typeof data === 'object' && 'favorite' in data
      ? Boolean((data as { favorite: unknown }).favorite)
      : favorite;
  }

  /** 购买商城商品（POST /api/shop/purchase）；扣费与解锁都在服务端。 */
  async purchase(itemId: string): Promise<Wallet> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/shop/purchase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ item_id: itemId }),
      });
    } catch {
      throw new AuthError('暂时无法连接服务器，请检查网络后重试', 0);
    }
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = this.errorMessage(data)
        ?? (response.status === 409 ? '积分不足' : '购买未能完成，请稍后再试');
      throw new AuthError(message, response.status);
    }
    const wallet = (data ?? {}) as Record<string, unknown>;
    const equippedRaw = (wallet.equipped ?? {}) as Record<string, unknown>;
    return {
      points: typeof wallet.points === 'number' ? wallet.points : 0,
      unlocked: Array.isArray(wallet.unlocked) ? (wallet.unlocked as string[]) : [],
      pointsPerGame: typeof wallet.pointsPerGame === 'number' ? wallet.pointsPerGame : 10,
      equipped: {
        materialBlack: typeof equippedRaw.materialBlack === 'string' ? equippedRaw.materialBlack : 'solid-black',
        materialWhite: typeof equippedRaw.materialWhite === 'string' ? equippedRaw.materialWhite : 'solid-white',
      },
    };
  }

  private async requestRaw(path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { credentials: 'include' });
    } catch {
      throw new AuthError('暂时无法连接服务器，请检查网络后重试', 0);
    }
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = this.errorMessage(data) ?? (response.status === 401 ? '登录状态已失效' : '请求未能完成，请重试');
      throw new AuthError(message, response.status);
    }
    return data;
  }

  private async request(path: string, body?: { username: string; password: string }): Promise<SessionUser | null> {
    let response: Response;
    try {
      const options: RequestInit = {
        method: body || path.endsWith('/guest') || path.endsWith('/logout') ? 'POST' : 'GET',
        credentials: 'include',
      };
      if (body) {
        options.headers = { 'Content-Type': 'application/json' };
        options.body = JSON.stringify(body);
      }
      response = await fetch(`${this.baseUrl}${path}`, options);
    } catch {
      throw new AuthError('暂时无法连接服务器，请检查网络后重试', 0);
    }

    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = this.errorMessage(data) ?? (response.status === 401 ? '登录状态已失效' : '请求未能完成，请重试');
      throw new AuthError(message, response.status);
    }
    if (!data || typeof data !== 'object' || !('user' in data)) return null;
    const user = (data as UserResponse).user;
    return user && typeof user.id === 'string' && typeof user.name === 'string' ? user : null;
  }

  private errorMessage(data: unknown): string | null {
    if (!data || typeof data !== 'object') return null;
    if ('detail' in data && typeof data.detail === 'string') return data.detail;
    if ('message' in data && typeof data.message === 'string') return data.message;
    if ('error' in data && data.error && typeof data.error === 'object' && 'message' in data.error && typeof data.error.message === 'string') {
      return data.error.message;
    }
    return null;
  }
}
