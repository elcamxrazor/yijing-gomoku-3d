import * as THREE from 'three';
import { GomokuRuleEngine } from '../game/rules';
import type { AnyGameSnapshot, PlayerColor } from '../game/types';
import type { MoveNumberMode } from '../game/settings';
import type { ScenePresetId } from '../game/scenes';
import { DEFAULT_SCENE_ID } from '../game/scenes';
import { Bell } from './Bell';
import { LANDING_DURATION, type BoardPoint } from './config';
import { BoardManager } from './BoardManager';
import type { Environment } from './environments/Environment';
import { CyberpunkEnvironment } from './environments/Cyberpunk';
import { CourtyardEnvironment } from './environments/Courtyard';
import { LivingRoomEnvironment } from './environments/LivingRoom';
import { StudioEnvironment } from './environments/Studio';
import { TeaRoomEnvironment } from './environments/TeaRoom';
import { SceneManager } from './SceneManager';

export interface SceneOptions {
  /** 玩家在空交叉点上落子时回调，参数是行列（0 基）。 */
  onMove: (row: number, col: number) => void;
  /** 玩家按了桌上的铜铃。 */
  onRing: () => void;
  /**
   * 局终后玩家点击棋盘空白区域（结算卡之外的「周围区域」）时回调，
   * 用来临时收起 / 恢复结算卡，方便观察棋盘。拖拽与缩放不触发。
   */
  onBackgroundClick: () => void;
  /** 系统「减少动态效果」偏好：为真时跳过下落与回弹动画。 */
  reducedMotion: boolean;
}

/** 判定「点击」而非「拖拽」的位移阈值（像素）。 */
const CLICK_SLOP = 7;

/**
 * 三维棋盘场景的对外门面。
 *
 * 内部由三个各司其职的模块拼装：
 * - {@link SceneManager} 渲染器 / 相机 / 控制器 / 主循环
 * - {@link Environment}  桌子 / 地面 / 摆设 / 光照（茶室、庭院、赛博三选一）
 * - {@link BoardManager} 棋盘 / 棋子 / 预览 / 落子动画
 *
 * 本类只负责「把三者接起来 + 处理指针事件 + 把快照翻译成渲染指令」，
 * 因此对 `main.ts` 暴露的 API 和重构前完全一致，游戏逻辑一行都不用改。
 *
 * 环境是可以整体换掉的：{@link GomokuScene.setScene} 会销毁旧的、建新的，
 * 再把它的背景 / 雾 / 曝光 / 推镜起点交给 SceneManager 统一接管。
 */
export class GomokuScene {
  private readonly sceneManager: SceneManager;
  private environment: Environment;
  private readonly board: BoardManager;
  private readonly bell: Bell;
  /** 当前生效的棋境，用来跳过「换个快照但场景没变」时的无谓重建。 */
  private sceneId: ScenePresetId = DEFAULT_SCENE_ID;

  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly rules = new GomokuRuleEngine();

  private snapshot: AnyGameSnapshot | null = null;
  private interactive = false;
  private pointerStart: { x: number; y: number; id: number } | null = null;
  /** 中键按下起点；松手时若没拖动则复位视角。 */
  private middleStart: { x: number; y: number; id: number } | null = null;

  constructor(container: HTMLElement, private readonly options: SceneOptions) {
    this.sceneManager = new SceneManager(container, { reducedMotion: options.reducedMotion });
    this.environment = GomokuScene.createEnvironment(DEFAULT_SCENE_ID, this.sceneManager.scene);
    this.sceneManager.applyEnvironment(this.environment);
    this.board = new BoardManager(this.sceneManager, { reducedMotion: options.reducedMotion });
    this.bell = new Bell(this.sceneManager.tweens, this.sceneManager.scene);
    this.sceneManager.onFrame((now) => this.bell.update(now));
    this.bindEvents();
  }

  /** 棋境 ID → 具体环境实例。新增预设时只需在这里加一个分支。 */
  private static createEnvironment(id: ScenePresetId, scene: THREE.Scene): Environment {
    if (id === 'courtyard') return new CourtyardEnvironment(scene);
    if (id === 'cyber') return new CyberpunkEnvironment(scene);
    if (id === 'living') return new LivingRoomEnvironment(scene);
    if (id === 'studio') return new StudioEnvironment(scene);
    return new TeaRoomEnvironment(scene);
  }

  /**
   * 切换棋境。
   *
   * 两件事必须同时做对：一是旧环境的几何、材质、贴图要干净地释放（切来切去
   * 是常态，泄漏一次量不大，切十次就够结成堆），二是背景 / 雾 / 曝光这类
   * 「全局状态」必须交给 SceneManager 回滚——不然从赛博的浓雾切回茶室，
   * 房间里会一直飘着夜里的雾。
   *
   * @returns 是否真的换了；同一个棋境不会重建。
   */
  setScene(id: ScenePresetId): boolean {
    // 每落一子都会来一张快照，同一棋境必须直接跳过——否则整盘家具跟着重拆重裱。
    if (id === this.sceneId) return false;
    this.environment.dispose();
    this.sceneId = id;
    this.environment = GomokuScene.createEnvironment(id, this.sceneManager.scene);
    this.sceneManager.applyEnvironment(this.environment);
    // 铃铛和棋盘不在环境的节点树下，不会被带了去；但换环境等于加减了一大批
    // 投影体，静止时阴影贴图是不更新的，必须点这一下让桌面重画影子。
    this.sceneManager.invalidateShadows();
    return true;
  }

  /** 当前棋境，建房界面回显用。 */
  currentScene(): ScenePresetId {
    return this.sceneId;
  }

  // ---------------------------------------------------------------------
  // 对外接口（与重构前保持一致）
  // ---------------------------------------------------------------------

  /** 同步对局状态：棋子差量更新、最后落子标记、获胜连线高亮。 */
  setSnapshot(snapshot: AnyGameSnapshot | null, onLand?: (color: PlayerColor) => void): void {
    const previous = this.snapshot;
    this.snapshot = snapshot;

    if (!snapshot) {
      this.board.clear();
      this.board.setHistory([]);
      this.board.setLastMove(null);
      this.board.setHover(null, 1);
      return;
    }

    // 换了一局就整盘重建；同一局则只补新增的棋子，保住正在播放的动画。
    const sameGame = previous !== null && previous.id === snapshot.id;
    if (!sameGame) this.board.clear();

    // 从「无对局」进入「有对局」时播一次推镜：远景展示客厅，再落到棋盘上。
    if (previous === null) this.sceneManager.playIntro();
    this.board.syncBoard(snapshot.board, sameGame, onLand);

    // 手数编号：序列由快照带下来，棋盘只负责画。
    // 必须在 syncBoard 之后——它是按「盘上有没有这颗子」来挑标签的。
    this.board.setHistory(snapshot.moves ?? []);
    // 同一局里新到的手带落子动画：圆点等棋子落定（下落+挤压+回弹）再亮；
    // 首次载入 / 复盘跳转是直接摆盘，没有动画，立即显示。
    this.board.setLastMove(snapshot.lastMove ?? null, sameGame ? LANDING_DURATION : 0);
    this.board.setWinningLine(this.winningLine(snapshot));
    this.board.setHover(null, snapshot.currentPlayer);
  }

  /** 设置棋子上的手数编号范围（纯显示设置，不影响对局）。 */
  setMoveNumbers(mode: MoveNumberMode): void {
    this.board.setMoveNumberMode(mode);
  }

  setBoardCoordinates(enabled: boolean): void {
    this.board.setBoardCoordinates(enabled);
  }

  /** 是否接受落子输入（同时切换鼠标指针样式）。 */
  setInteractive(interactive: boolean): void {
    this.interactive = interactive;
    if (!interactive) this.board.setHover(null, this.hoverColor());
    this.sceneManager.renderer.domElement.style.cursor = interactive ? 'crosshair' : 'default';
  }

  /** 相机复位到初始第三人称斜视角。 */
  resetView(): void {
    this.sceneManager.resetView();
  }

  /** 让桌上的铜铃自己响一下（对手按铃时用）。 */
  ringBell(): void {
    this.bell.ring();
  }

  /** 在棋盘上亮出 AI 分析的建议落点（数秒后自动消散）。 */
  showHint(row: number, col: number): void {
    this.board.showHint(row, col);
  }

  /**
   * 热替换棋子材质（黑 / 白各一份 id）。
   *
   * 材质是渲染层的装饰配置，对局逻辑不感知——这里只把两份 id 交下去，
   * 由 `BoardManager` 负责重建材质并改指现有棋子。
   */
  setStoneMaterials(blackId: string, whiteId: string): void {
    this.board.setStoneMaterials(blackId, whiteId);
  }

  dispose(): void {
    const element = this.sceneManager.renderer.domElement;
    element.removeEventListener('pointermove', this.onPointerMove);
    element.removeEventListener('pointerdown', this.onPointerDown);
    element.removeEventListener('pointerup', this.onPointerUp);
    element.removeEventListener('pointerleave', this.onPointerLeave);

    this.bell.dispose();
    this.board.dispose();
    this.environment.dispose();
    this.sceneManager.dispose();
  }

  // ---------------------------------------------------------------------
  // 指针交互
  // ---------------------------------------------------------------------

  private bindEvents(): void {
    const element = this.sceneManager.renderer.domElement;
    element.addEventListener('pointermove', this.onPointerMove);
    element.addEventListener('pointerdown', this.onPointerDown);
    element.addEventListener('pointerup', this.onPointerUp);
    element.addEventListener('pointerleave', this.onPointerLeave);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    // 只跟踪左键：右键被 OrbitControls 用于旋转，不参与落子。
    if (event.button === 0) {
      this.pointerStart = { x: event.clientX, y: event.clientY, id: event.pointerId };
    } else if (event.button === 1) {
      // 中键：记下起点，松手时若没拖动就复位视角（拖动留给 OrbitControls 做缩放）。
      this.middleStart = { x: event.clientX, y: event.clientY, id: event.pointerId };
      event.preventDefault(); // 抑制中键自动滚动圈
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    // 中键点击（非拖动）复位视角；右键松手不在这里处理。
    if (event.button === 1) {
      const start = this.middleStart;
      this.middleStart = null;
      if (start && start.id === event.pointerId && Math.hypot(event.clientX - start.x, event.clientY - start.y) <= CLICK_SLOP) {
        this.sceneManager.resetView();
      }
      return;
    }
    const start = this.pointerStart;
    this.pointerStart = null;
    if (!start || start.id !== event.pointerId) return;
    // 位移超过阈值说明是拖拽（旋转视角或滑动手势），不当作点击。
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_SLOP) return;

    this.aim(event);
    // 铜铃先判：它摆在棋盘外，但相机转到低角度时可能压在棋盘上，
    // 这种时候点它更可能是「想敲铃」而不是「想在那个交叉点落子」。
    if (this.bell.hit(this.raycaster)) {
      this.bell.ring();
      this.options.onRing();
      return;
    }
    // 局终：结算卡浮在棋盘上，点击卡之外的「周围区域」用来临时收起 / 恢复结算卡，
    // 让玩家能静心观察终局棋盘。拖拽（右键旋转）与缩放（滚轮）不会产生这个回调，
    // 因此临时收起期间随便转视角、拉远近都不会把结算卡重新唤醒。
    if (this.snapshot?.status === 'finished') {
      this.options.onBackgroundClick();
      return;
    }
    const point = this.board.pick(this.raycaster);
    if (!point || !this.interactive) return;
    if (this.snapshot?.board[point.row]?.[point.col] !== 0) return;
    this.options.onMove(point.row, point.col);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    this.aim(event);
    const overBell = this.bell.hit(this.raycaster);
    this.bell.setHover(overBell);
    const element = this.sceneManager.renderer.domElement;
    if (overBell) {
      element.style.cursor = 'pointer';
      this.board.setHover(null, this.hoverColor());
      return;
    }
    element.style.cursor = this.interactive ? 'crosshair' : 'default';
    // 触摸设备没有 hover 语义，只在真正的指针设备上显示预览。
    if (!this.interactive || event.pointerType === 'touch' || this.pointerStart) {
      this.board.setHover(null, this.hoverColor());
      return;
    }
    const point = this.board.pick(this.raycaster);
    if (!point || this.snapshot?.board[point.row]?.[point.col] !== 0) {
      this.board.setHover(null, this.hoverColor());
      return;
    }
    this.board.setHover(point, this.hoverColor());
  };

  private readonly onPointerLeave = (): void => {
    this.bell.setHover(false);
    this.board.setHover(null, this.hoverColor());
    this.pointerStart = null;
  };

  /** 把屏幕坐标换算成一条世界空间射线。 */
  private aim(event: PointerEvent): void {
    const bounds = this.sceneManager.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.sceneManager.camera);
  }

  // ---------------------------------------------------------------------
  // 辅助
  // ---------------------------------------------------------------------

  /** 当前该谁下（用于预览棋子颜色）。 */
  private hoverColor(): PlayerColor {
    return this.snapshot?.currentPlayer ?? 1;
  }

  /**
   * 结算获胜连线。胜负本身由规则层判定，这里只把结果翻译成要画高亮的坐标。
   */
  private winningLine(snapshot: AnyGameSnapshot): BoardPoint[] {
    if (snapshot.winner === 0 || snapshot.winReason !== 'five' || !snapshot.lastMove) return [];
    const { row, col, color } = snapshot.lastMove;
    return this.rules.findWinningLine(snapshot.board, row, col, color);
  }
}
