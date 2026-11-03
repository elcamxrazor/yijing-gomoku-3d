/**
 * Rapfi WASM 引擎的主线程客户端。
 *
 * 分工：Worker（rapfi.worker.js）持有引擎实例并做协议解析；这里负责
 * 能力探测（决定加载哪个变体）、共享内存分配、命令编排与事件再分发。
 * 协议语义对齐 Rapfi 官方 Gomocalc 实现（tools/rapfi/Gomocalc/src/ai/engine.js）：
 * 引擎落子/建议是一行 `row,col`；思考信息以 `INFO DEPTH/EVAL/WINRATE/...`
 * 逐行推送——这是 Rapfi 原生能力（Yixin 没有的东西），因此实时面板才做得了。
 */

/** 引擎思考信息（一次搜索过程中的滚动快照，逐行到达）。 */
export interface RapfiInfo {
  depth?: number;
  seldepth?: number;
  /** 评估分：厘值字符串，杀棋分形如 `m12`（Engine 视角）。 */
  eval?: string;
  /** 胜率 0~1（引擎换算），比裸分更直观，UI 默认用它。 */
  winrate?: number;
  nodes?: number;
  /** 每秒节点数。 */
  speed?: number;
  /** 主变化（预测着法序列），首项即当前最佳点。 */
  bestline?: Array<[number, number]>;
}

export interface RapfiHandlers {
  /** 高频思考信息（每秒多次，UI 端自行节流）。 */
  onInfo?: (info: RapfiInfo) => void;
  /** 搜索结束，引擎给出的落点（AI 落子 / 建议点共用）。 */
  onMove?: (row: number, col: number) => void;
  onMessage?: (text: string) => void;
  /** NNUE 权重下载进度 0~1。 */
  onLoading?: (progress: number) => void;
  onReady?: () => void;
  onError?: (message: string) => void;
}

/** 15×15 无禁手。Rapfi 规则号：0=freestyle。 */
const RULE_FREESTYLE = 0;
// Gomocup 协议：0 = 自由（无禁手），4 = 连珠（黑方禁手）。
const RULE_RENJU = 4;
const BOARD_SIZE = 15;

/** WebAssembly SIMD 探针（标准 128-bit i64x2.extract_lane 样本）。 */
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15,
  253, 98, 11,
]);

function supportsSimd(): boolean {
  try {
    return WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
}

function supportsThreads(): boolean {
  return (
    typeof SharedArrayBuffer !== 'undefined' &&
    typeof self.crossOriginIsolated === 'boolean' &&
    self.crossOriginIsolated
  );
}

/** 为多线程构建找一个能分配成功的共享内存上限（Gomocalc 同款渐进探测）。 */
function allocateSharedMemory(): WebAssembly.Memory {
  const pagesPerMB = 1024 * 1024 / 65536;
  for (let maximumMB = 2048; maximumMB >= 512; maximumMB /= 2) {
    try {
      const memory = new WebAssembly.Memory({
        initial: 64 * pagesPerMB,
        maximum: maximumMB * pagesPerMB,
        shared: true,
      });
      memory.grow(1);
      return memory;
    } catch {
      /* 上限太大就降一档 */
    }
  }
  return new WebAssembly.Memory({ initial: 64 * pagesPerMB, shared: true });
}

/** Emscripten 模块（MODULARIZE + preamble.js）暴露的最小接口。 */
interface RapfiModule {
  sendCommand: (command: string) => void;
  terminate?: () => void;
}

type RapfiFactory = (options: {
  locateFile: (file: string) => string;
  onReceiveStdout: (line: string) => void;
  onReceiveStderr: (line: string) => void;
  onExit?: (code: number) => void;
  setStatus?: (text: string) => void;
  wasmMemory?: WebAssembly.Memory | undefined;
}) => Promise<RapfiModule>;

/** 一个待 resolve 的搜索请求：BOARD 发出去之后等下一个落点。 */
interface PendingSearch {
  resolve: (move: { row: number; col: number }) => void;
  reject: (error: Error) => void;
}

export class RapfiClient {
  private worker: Worker | null = null;
  /** 多线程变体直接实例化在主线程（官方 Gomocalc 模式）：重活在引擎自己的
   * pthread 里，主线程只做命令泵送；放进自定义 Worker 反而会与 pthread
   * 的消息机制互相污染（实测引擎因此失联）。单线程变体仍走 Worker。 */
  private mainModule: RapfiModule | null = null;
  private useThreads = false;
  private handlers: RapfiHandlers = {};
  private pending: PendingSearch | null = null;
  private ready = false;
  private loadedVariant = '';
  private sharedMemory: WebAssembly.Memory | null = null;

  /** 当前变体名，仅诊断用（如 `multi-simd128`）。 */
  get variant(): string {
    return this.loadedVariant;
  }

  get isReady(): boolean {
    return this.ready;
  }

  /**
   * 加载引擎（按浏览器能力挑变体）并等它就绪。
   * NNUE 权重约 10MB，`onLoading` 会持续报告进度。
   */
  async load(handlers: RapfiHandlers = {}): Promise<void> {
    this.handlers = handlers;
    this.ready = false;

    this.useThreads = supportsThreads();
    const simd = supportsSimd();
    if (this.useThreads && !simd) this.useThreads = false;
    const variant = this.useThreads ? 'multi-simd128' : simd ? 'single-simd128' : 'single';
    this.loadedVariant = variant;

    if (this.useThreads) {
      // 多线程：主线程直载脚本，引擎内部自己开 pthread（需要全站 COOP/COEP 头）。
      // 共享内存在这里分配，容量渐进探测（Gomocalc 同款）。
      this.sharedMemory = allocateSharedMemory();
      return this.loadMainModule(variant);
    }
    return new Promise<void>((resolve, reject) => {
      const worker = new Worker(new URL('./rapfi.worker.js', import.meta.url));
      this.worker = worker;
      const onceReady = () => {
        this.ready = true;
        resolve();
      };

      worker.onmessage = (event: MessageEvent) => {
        const msg = event.data as {
          type: string;
          line?: string;
          text?: string;
          code?: number;
          message?: string;
        };
        switch (msg.type) {
          case 'ready':
            onceReady();
            this.handlers.onReady?.();
            break;
          case 'stdout':
            this.handleEngineLine(msg.line ?? '');
            break;
          case 'stderr':
            console.warn('[rapfi stderr]', msg.line);
            break;
          case 'status':
            this.handleStatus(msg.text ?? '');
            break;
          case 'exit':
            this.ready = false;
            this.failPending(new Error('引擎进程已退出'));
            break;
          case 'fatal':
            this.handlers.onError?.(msg.message ?? '引擎加载失败');
            reject(new Error(msg.message ?? 'engine load failed'));
            break;
        }
      };
      worker.onerror = (event) => {
        const message = event.message || '引擎加载失败';
        this.handlers.onError?.(message);
        this.failPending(new Error(message));
        reject(new Error(message));
      };

      worker.postMessage({
        type: 'load',
        url: `/engine/rapfi-${variant}.js`,
        sharedMemory: this.sharedMemory,
      });
    });
  }

  /** 多线程变体：主线程注入 <script> 并实例化模块。 */
  private async loadMainModule(variant: string): Promise<void> {
    const url = `/engine/rapfi-${variant}.js`;
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('引擎脚本加载失败'));
      document.head.append(script);
    });
    const factory = (window as unknown as { Rapfi?: RapfiFactory }).Rapfi;
    if (!factory) throw new Error('引擎脚本未注册全局 Rapfi');
    this.mainModule = await factory({
      // 权重数据统一共享一份 rapfi.data（与 Worker 路径同款归一）
      locateFile: (file: string) =>
        `/engine/${/^rapfi.*\.data$/.test(file) ? 'rapfi.data' : file}`,
      onReceiveStdout: (line: string) => this.handleEngineLine(line),
      onReceiveStderr: (line: string) => console.warn('[rapfi stderr]', line),
      onExit: () => {
        this.ready = false;
        this.failPending(new Error('引擎进程已退出'));
      },
      setStatus: (text: string) => this.handleStatus(text),
      wasmMemory: this.sharedMemory ?? undefined,
    });
    this.ready = true;
    this.handlers.onReady?.();
  }

  /** 发送任意 Gomocup 协议命令（诊断/高级用法）。 */
  send(command: string): void {
    if (this.useThreads) {
      if (!this.mainModule || !this.ready) throw new Error('引擎尚未就绪');
      this.mainModule.sendCommand(command);
      return;
    }
    if (!this.worker || !this.ready) throw new Error('引擎尚未就绪');
    this.worker.postMessage({ type: 'command', data: command });
  }

  /**
   * 开始新一盘：重置引擎并下发规则与时间配置。
   * 每盘开头调用一次；引擎内部状态由 START 重置。
   */
  startGame(timeBudgetMs = 2000, rule?: 'freestyle' | 'renju'): void {
    this.send(`INFO RULE ${rule === 'renju' ? RULE_RENJU : RULE_FREESTYLE}`);
    // SHOW_DETAIL 3：开启 DEPTH/EVAL/WINRATE/BESTLINE 逐层 INFO 流（默认不输出，
    // 这正是思考面板的数据源；实测缺失时只有最终落子）。
    this.send('INFO SHOW_DETAIL 3');
    this.send(`INFO TIMEOUT_TURN ${timeBudgetMs}`);
    this.send(`INFO TIMEOUT_MATCH ${Math.max(timeBudgetMs * 30, 60000)}`);
    this.send('START 15');
  }

  /**
   * 灌入整局着法并让引擎思考（AI 落子与复盘建议共用这条路径）。
   * 全量重建是无状态分析的前提：同一引擎会话会被不同执子方交替使用，
   * 增量 TURN 会被搅乱——这与后端引擎池当年的结论一致。
   */
  think(
    moves: ReadonlyArray<{ row: number; col: number; color: number }>,
    timeBudgetMs = 2000,
  ): Promise<{ row: number; col: number }> {
    if (!this.ready) return Promise.reject(new Error('引擎尚未就绪'));
    if (this.pending) return Promise.reject(new Error('引擎正在思考中'));

    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      let side = 1; // 黑先；Gomocup 坐标惯例 (x=col, y=row)，与后端 Yixin 适配一致
      let command = 'BOARD';
      for (const move of moves) {
        command += ` ${move.col},${move.row},${side}`;
        side = 3 - side;
      }
      command += ' DONE';
      this.send(`INFO TIME_LEFT ${Math.max(timeBudgetMs * 30, 60000)}`);
      this.send(command);
    });
  }

  /** 中断当前思考。多线程版用 YXSTOP 软停；单线程版只能杀 Worker 重来。 */
  stopThinking(): void {
    this.failPending(new Error('思考已中断'));
    if (this.useThreads) {
      if (this.mainModule) this.mainModule.sendCommand('YXSTOP');
      return;
    }
    if (!this.worker) return;
    this.worker.terminate();
    this.worker = null;
    this.ready = false;
    // 重新加载：回调沿用当前 handlers，但调用方需重新 await load()
    void this.load(this.handlers).catch(() => {});
  }

  dispose(): void {
    this.failPending(new Error('引擎已销毁'));
    if (this.useThreads) {
      try {
        this.mainModule?.terminate?.();
      } catch {
        /* 已退出则忽略 */
      }
      this.mainModule = null;
    }
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
  }

  // ------------------------------------------------------------------
  // 协议解析（对齐 Gomocalc engine.js 的 INFO 语义）
  // ------------------------------------------------------------------

  private handleStatus(text: string): void {
    // Emscripten 预加载权重时 Status 形如 "Downloading data... (12345/9999999)"
    const match = text.match(/\((\d+)\/(\d+)\)/);
    if (match) {
      const loaded = parseInt(match[1] ?? '0', 10);
      const total = parseInt(match[2] ?? '0', 10);
      if (total > 0) this.handlers.onLoading?.(loaded / total);
      return;
    }
    if (text === 'Running...' || text === '') this.handlers.onLoading?.(1);
  }

  private handleEngineLine(line: string): void {
    if (!line) return;
    const spaceIndex = line.indexOf(' ');

    if (spaceIndex === -1) {
      if (line === 'OK' || line === '?') return;
      if (line === 'SWAP') {
        this.handlers.onMessage?.('SWAP');
        return;
      }
      // 落子行：`x,y`（Gomocup 惯例 x=col, y=row；实测 Rapfi 输出与此一致）
      const coord = line.split(',');
      if (coord.length === 2) {
        const col = Number(coord[0]);
        const row = Number(coord[1]);
        if (Number.isFinite(row) && Number.isFinite(col)) {
          const pending = this.pending;
          this.pending = null;
          pending?.resolve({ row, col });
          this.handlers.onMove?.(row, col);
        }
      }
      return;
    }

    const head = line.substring(0, spaceIndex);
    const tail = line.substring(spaceIndex + 1);

    if (head === 'MESSAGE') {
      this.handlers.onMessage?.(tail);
      return;
    }
    if (head === 'ERROR') {
      this.handlers.onError?.(tail);
      return;
    }
    if (head !== 'INFO') return;

    // INFO 行：逐字段解析。DEPTH/EVAL/WINRATE/BESTLINE 是面板要的核心。
    const i = tail.indexOf(' ');
    if (i === -1) return;
    const key = tail.substring(0, i);
    const value = tail.substring(i + 1);
    const info: RapfiInfo = {};
    switch (key) {
      case 'DEPTH':
        info.depth = Number(value);
        break;
      case 'SELDEPTH':
        info.seldepth = Number(value);
        break;
      case 'EVAL':
        info.eval = value;
        break;
      case 'WINRATE':
        info.winrate = parseFloat(value);
        break;
      case 'NODES':
        info.nodes = Number(value);
        break;
      case 'SPEED':
        info.speed = Number(value);
        break;
      case 'BESTLINE':
        // 主变化每对坐标同样是 (x=col, y=row)，转成 (row, col) 再外发
        info.bestline = (value.match(/\d+,\d+/g) ?? []).map((pair) => {
          const [x, y] = pair.split(',').map(Number);
          return [y, x] as [number, number];
        });
        break;
      default:
        return; // PV/NUMPV/REALTIME 等暂不外发，面板用不上
    }
    this.handlers.onInfo?.(info);
  }

  private failPending(error: Error): void {
    const pending = this.pending;
    this.pending = null;
    pending?.reject(error);
  }
}

/** 单例：全站共享一个引擎实例（Worker + NNUE 只下载一次）。 */
let sharedClient: RapfiClient | null = null;
let loadingPromise: Promise<RapfiClient> | null = null;

/**
 * 取共享引擎实例（首次调用会触发 ~10MB 权重下载，之后秒回）。
 * `onLoading` 只在本次调用是「发起加载的那次」时有效。
 */
export function getRapfiClient(
  handlers: RapfiHandlers = {},
): Promise<RapfiClient> {
  if (sharedClient?.isReady) return Promise.resolve(sharedClient);
  if (!loadingPromise) {
    sharedClient = new RapfiClient();
    loadingPromise = sharedClient
      .load(handlers)
      .then(() => sharedClient!)
      .catch((error) => {
        sharedClient = null;
        loadingPromise = null;
        throw error;
      });
  }
  return loadingPromise;
}

export const RAPFI_BOARD_SIZE = BOARD_SIZE;
