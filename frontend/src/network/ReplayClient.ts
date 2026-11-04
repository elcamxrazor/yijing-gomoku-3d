import type { ReplayRecord, ReplaySummary } from '../game/replay';

interface ReplayListResponse {
  replays: ReplaySummary[];
  limit: number;
  offset: number;
}

/** 复盘 AI 评估的结果：本地引擎建议的下一手（`ply` 手之后的行动方）。 */
export interface ReplaySuggestion {
  row: number;
  col: number;
  color: number;
  cached: boolean;
}

export class ReplayError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ReplayError';
  }
}

/**
 * 复盘的 HTTP 客户端。
 *
 * 复用同一张会话 Cookie（`credentials: 'include'`），所以登录 / 游客身份直接生效，
 * 不需要再往请求里塞 token。复盘是一次性的读操作，没有订阅需求，
 * 因此没有走 WebSocket——`dispatch` 那张表已经够长了。
 */
export class ReplayClient {
  private readonly baseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

  /**
   * @param mode `ai` 只取与 AI 的对局，`online` 只取与好友的；不传就是全部。
   *   过滤放在服务端做，客户端只按 20 条一页取——本地过滤会变成
   *   「取 20 条再筛掉一半」，翻两页就只剩个位数。
   */
  async list(
    limit = 20,
    offset = 0,
    mode?: 'ai' | 'online',
    favoriteOnly = false,
  ): Promise<ReplaySummary[]> {
    const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (mode) query.set('mode', mode);
    if (favoriteOnly) query.set('favorite', 'true');
    const data = await this.request(`/api/games/replays?${query.toString()}`);
    if (!data || typeof data !== 'object' || !('replays' in data)) return [];
    const replays = (data as ReplayListResponse).replays;
    return Array.isArray(replays) ? replays : [];
  }

  get(gameId: string): Promise<ReplayRecord> {
    return this.request(`/api/games/replays/${encodeURIComponent(gameId)}`) as Promise<ReplayRecord>;
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { credentials: 'include', ...init });
    } catch {
      throw new ReplayError('暂时无法连接服务器，请检查网络后重试', 0);
    }

    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        this.errorMessage(data) ??
        (response.status === 401 ? '请先登录或创建游客会话' : '棋谱读取失败，请重试');
      throw new ReplayError(message, response.status);
    }
    if (!data || typeof data !== 'object') {
      throw new ReplayError('棋谱数据不完整', response.status);
    }
    return data;
  }

  private errorMessage(data: unknown): string | null {
    if (!data || typeof data !== 'object') return null;
    if ('detail' in data && typeof data.detail === 'string') return data.detail;
    if ('message' in data && typeof data.message === 'string') return data.message;
    return null;
  }
}
