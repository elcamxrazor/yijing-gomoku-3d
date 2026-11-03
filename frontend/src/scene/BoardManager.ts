import * as THREE from 'three';
import { loadPbrTextureSet } from './assets';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { Move, PlayerColor } from '../game/types';
import { visibleMoveIndices, type MoveNumberMode } from '../game/settings';
import { Easing } from './animation/tween';
import type { TweenManager } from './animation/tween';
import type { SceneManager } from './SceneManager';
import {
  BOARD_SIZE,
  BOARD_SURFACE_Y,
  BOARD_THICKNESS,
  BOARD_WIDTH,
  DROP_DURATION,
  DROP_HEIGHT,
  GRID_SPACING,
  HINT_COLLAPSE_DELAY,
  HINT_COLLAPSE_DURATION,
  PALETTE,
  RIPPLE_DURATION,
  SQUASH_DURATION,
  SQUASH_SCALE_XZ,
  SQUASH_SCALE_Y,
  STONE_BASE_SCALE,
  STONE_FLAT_RATIO,
  STONE_RADIUS,
  STONE_REST_Y,
  positionFor,
} from './config';
import type { BoardPoint } from './config';
import { createStoneGeometry, makeGlowTexture, makeLabelTexture, makeMoveNumberTexture, makeWoodTexture } from './materials';
import {
  createStoneMaterial,
  DEFAULT_BLACK_MATERIAL,
  DEFAULT_WHITE_MATERIAL,
  STONE_MATERIALS,
  getMaterialDef,
} from './stoneMaterials';
import type { StoneMaterialDef } from './stoneMaterials';

/**
 * 取一份棋子材质定义。
 *
 * `STONE_MATERIALS` 是 `Record<string, StoneMaterialDef>`，而项目开了
 * `noUncheckedIndexedAccess`：下标访问一律被判成「可能 undefined」。
 * 默认材质的键一定存在，把取值收口在这个函数里，调用点就不用到处写断言，
 * 也顺手保证「万一真的取不到」时是抛错而不是渲染出一颗没材质的棋子。
 */
function materialDef(id: string): StoneMaterialDef {
  const def = STONE_MATERIALS[id];
  if (!def) throw new Error(`未知的棋子材质：${id}`);
  return def;
}

export interface BoardManagerOptions {
  reducedMotion: boolean;
}

interface StoneEntry {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
  color: PlayerColor;
}

interface Ripple {
  mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  startedAt: number;
}

/** AI 分析建议的提示环：比涟漪停留更久、颜色更醒目。 */
interface Hint {
  mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  startedAt: number;
  /**
   * 计划开始收缩的时刻（帧时钟，可能在未来）。为 null 表示还没安排退场；
   * 到点后从满尺寸平滑缩到 0 再销毁，而不是生硬消失。
   */
  collapsedAt: number | null;
}

/** 格线覆盖范围：比棋盘略窄，留出边框。 */
const GRID_EXTENT = (BOARD_SIZE - 1) * GRID_SPACING / 2;

/** 格线抬离板面的高度，避免与板面共面产生 z-fighting。 */
const LINE_LIFT = 0.006;

/**
 * 棋盘管理：棋盘本体、格线、棋子、预览棋子、标记与所有落子相关动画。
 *
 * 它只做「把状态画出来」，不判断合法性也不判胜负——那些逻辑留在
 * `game/rules.ts`，本类只接收已经算好的棋盘数组。
 */
export class BoardManager {
  private readonly sceneManager: SceneManager;
  private readonly tweens: TweenManager;
  private readonly reducedMotion: boolean;

  private readonly root = new THREE.Group();
  private readonly boardGroup = new THREE.Group();
  /** 棋盘面板材质：先挂程序化木纹，橡木皮贴图到位后热替换。 */
  private boardMaterial!: THREE.MeshStandardMaterial;
  /** 棋盘贴图的引用，销毁时统一释放。 */
  private readonly boardTextures: THREE.Texture[] = [];
  private readonly stones = new Map<string, StoneEntry>();
  private readonly ripples: Ripple[] = [];
  private readonly hints: Hint[] = [];
  /**
   * 退场动画进行中时排队的新推荐点。
   *
   * 落子后旧环要先陪落子动画、再收缩退场；这段时间里引擎思考 / 联机广播
   * 可能已经算出下一手。若直接 dispose 旧环换新环，收缩动画就永远看不到——
   * 所以新点先排在这里，等旧环收完再亮。
   */
  private pendingHint: { row: number; col: number } | null = null;
  private readonly winnerMarkers = new THREE.Group();
  /** 棋子上的手数标签：key 是 `row:col`，值是挂在棋子网格下的薄片与其数字。 */
  private readonly moveLabels = new Map<
    string,
    { mesh: THREE.Mesh; value: number; latest: boolean }
  >();
  /**
   * 手数标签的共享几何：一张 1×1 的平面，靠 mesh.scale 调到实际大小。
   *
   * 这里不再用 `THREE.Sprite`。Sprite 永远正对相机，俯视时读起来舒服，
   * 但视角一拖低，它就会侧躺进棋子内部——下半截被棋子挡住，数字看起来像
   * 被削掉一块（用户实测到的「拖视角时数字与棋子穿模」）。
   * 换成平铺在棋子顶面的薄片之后，标签和棋子共用同一套局部坐标系，
   * 从任何角度看都贴在顶面上，不可能穿进去。
   */
  private readonly labelGeometry = new THREE.PlaneGeometry(1, 1);
  /** 手数贴图缓存。同一个数字+色调只画一次，满盘也就两百来张小图。 */
  private readonly numberTextures = new Map<string, THREE.Texture>();
  private moveNumberMode: MoveNumberMode = 'off';
  /** 当前局面的完整着法序列（服务端 / 本地对局都会给全）。 */
  private history: readonly Move[] = [];

  private readonly stoneGeometry = createStoneGeometry();
  /**
   * 棋盘坐标标签（A–O 列、1–15 行）：挂在 boardGroup 下，随棋盘一起旋转/取景。
   * 平铺在木框边的薄片上——和手数编号同一套「贴面不穿模」思路，斜视角也不会陷进棋子。
   */
  private readonly coordsGroup = new THREE.Group();
  private readonly coordLabelGeometry = new THREE.PlaneGeometry(0.52, 0.52);
  private readonly coordLabelTextures: THREE.Texture[] = [];
  private showBoardCoords = false;
  /**
   * 棋子阴影走「方向光实时阴影贴图」，不再用贴地暗片。
   *
   * 之前的 blob 接触影是居中椭圆、没有半影、也不随光向偏移，怎么看都「平」，
   * 不像摄影里的落影。现在让棋子 `castShadow = true`，由场景里那盏投影平行光
   * （茶室太阳 / 庭院日光 / 赛博月亮 / 客厅天光）在棋盘上投出**带半影、随光向偏移**
   * 的真实接触影——这才是静物摄影里「物体压在台面上」的落影。
   *
   * 之前之所以改用 blob，是因为旧配置里 `normalBias` 把影子从接触面推开，
   * 漏出一圈亮缝（peter-panning），即用户看到的「月牙 + 内部高亮」。四个棋境的
   * `normalBias` 已归零、并配好负 `bias`，实时阴影现在是干净的整片椭圆，blob 可以退役。
   *
   * 棋盘是接收面（`receiveShadow = true`，见 buildBoard）；棋子自身不接收阴影，
   * 避免透射材质在接触处叠出乌团。
   */
  /** 当前生效的黑 / 白棋子材质，可由 `setStoneMaterials` 热替换。 */
  private stoneMaterials: { black: THREE.MeshPhysicalMaterial; white: THREE.MeshPhysicalMaterial };
  /** 当前装备的材质 id，供预览棋子与渲染层查询。 */
  private stoneMaterialIds: { black: string; white: string } = {
    black: DEFAULT_BLACK_MATERIAL,
    white: DEFAULT_WHITE_MATERIAL,
  };
  private readonly interactionPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -BOARD_SURFACE_Y);

  private readonly ghost: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
  private readonly ghostGlow: THREE.Sprite;
  private readonly hoverRing: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  /**
   * 最新一手提示：核心圆点 + 外圈细环。
   *
   * 单独一个小圆点在「凝脂」这种高透射白子上对比度不够——半透明的底色
   * 会把深色圆点衬得发灰，斜视角下甚至看不出那是个点。补一圈同色细环后，
   * 环与点之间留出空隙，形成「靶心」图案：底色再透也能一眼读出位置。
   */
  private readonly lastMarker = new THREE.Group();
  private readonly lastMarkerDot: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  private readonly lastMarkerRing: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  /** 当前标记的最后一手；null 表示没有可标的手。 */
  private lastMove: { row: number; col: number; color: PlayerColor } | null = null;
  /** 圆点延迟显示的截止时刻（帧时钟）；null 表示不延迟。 */
  private markerRevealAt: number | null = null;
  private readonly glowTexture = makeGlowTexture();

  private hoverColor: PlayerColor = 1;

  constructor(sceneManager: SceneManager, options: BoardManagerOptions) {
    this.sceneManager = sceneManager;
    this.tweens = sceneManager.tweens;
    this.reducedMotion = options.reducedMotion;

    sceneManager.scene.add(this.root);
    this.root.add(this.boardGroup);
    this.boardGroup.add(this.coordsGroup);
    this.root.add(this.winnerMarkers);

    this.stoneMaterials = {
      black: createStoneMaterial(materialDef(DEFAULT_BLACK_MATERIAL)),
      white: createStoneMaterial(materialDef(DEFAULT_WHITE_MATERIAL)),
    };

    this.buildBoard();

    // 预览棋子：半透明，叠一层加色光晕。
    this.ghost = new THREE.Mesh(this.stoneGeometry, this.stoneMaterials.black.clone());
    this.ghost.scale.set(STONE_BASE_SCALE.x, STONE_BASE_SCALE.y, STONE_BASE_SCALE.z);
    this.ghost.material.transparent = true;
    this.ghost.material.opacity = 0.44;
    this.ghost.material.depthWrite = false;
    this.ghost.visible = false;
    this.root.add(this.ghost);

    this.ghostGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTexture,
      color: '#ffe3b0',
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      // 关深度测试：光晕是贴着板面的加色光斑，billboard 下半截会插进棋盘，
      // 相机一低就被板面裁出一条生硬的直线（穿模）。关掉后光斑整片叠在
      // 棋盘上（additive 叠加，视觉上就是「光落在板面上」），任何视角都完整。
      depthTest: false,
      blending: THREE.AdditiveBlending,
    }));
    this.ghostGlow.scale.setScalar(1.95);
    this.ghostGlow.visible = false;
    this.root.add(this.ghostGlow);

    // 落点指示环：半透明棋子在浅色棋盘上对比度很低，加一圈细环明确"将落在这里"
    this.hoverRing = new THREE.Mesh(
      new THREE.RingGeometry(0.4, 0.435, 40),
      new THREE.MeshBasicMaterial({
        color: '#7d6a4e',
        transparent: true,
        opacity: 0.4,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.hoverRing.rotation.x = -Math.PI / 2;
    this.hoverRing.visible = false;
    this.root.add(this.hoverRing);

    // 圆点与外环共用一套材质实例，换色时一起改，销毁时一起释放。
    // transparent 必须开：不透明物体会被排进不透明队列、先于透射材质
    // （凝脂 / 翡翠）渲染，整块被透射面盖住——标记就凭空消失了。
    // 转入透明队列后按 renderOrder 排在最后，永远压在棋子表面之上。
    const markerDotMaterial = new THREE.MeshBasicMaterial({
      color: PALETTE.accent,
      depthTest: false,
      transparent: true,
      depthWrite: false,
    });
    this.lastMarkerDot = new THREE.Mesh(new THREE.CircleGeometry(0.07, 24), markerDotMaterial);
    this.lastMarkerDot.rotation.x = -Math.PI / 2;
    this.lastMarkerRing = new THREE.Mesh(
      new THREE.RingGeometry(0.1, 0.122, 32),
      markerDotMaterial,
    );
    this.lastMarkerRing.rotation.x = -Math.PI / 2;
    this.lastMarkerDot.renderOrder = 5;
    this.lastMarkerRing.renderOrder = 5;
    this.lastMarker.add(this.lastMarkerDot, this.lastMarkerRing);
    this.lastMarker.visible = false;
    this.root.add(this.lastMarker);

    sceneManager.onFrame((now) => this.update(now));
  }

  // ---------------------------------------------------------------------
  // 对外接口
  // ---------------------------------------------------------------------

  /**
   * 把 15×15 的棋盘数组同步成棋子。
   *
   * 采用差量更新而不是清空重建：重连、悔棋时大部分棋子没变，
   * 只补新增、删多余的，才能保留正在播放的落子动画。
   *
   * @param board   服务端或本地规则算出的棋盘（0 空 / 1 黑 / 2 白）
   * @param animate 是否为新落子播放下落动画；首次载入历史棋谱时传 false
   */
  syncBoard(board: number[][], animate: boolean, onLand?: (color: PlayerColor) => void): void {
    const expected = new Set<string>();
    let changed = false;
    for (let row = 0; row < board.length; row += 1) {
      const line = board[row];
      if (!line) continue;
      for (let col = 0; col < line.length; col += 1) {
        const cell = line[col];
        if (cell !== 1 && cell !== 2) continue;
        const key = `${row}:${col}`;
        expected.add(key);
        if (!this.stones.has(key)) {
          this.addStone(row, col, cell, animate, onLand);
          changed = true;
        }
      }
    }
    for (const [key, entry] of this.stones) {
      if (expected.has(key)) continue;
      this.root.remove(entry.mesh);
      this.stones.delete(key);
      changed = true;
    }
    // 棋子是场景里最会投影的东西；画面静止时阴影图不会自己重画（见 SceneManager.tick），
    // 少了这一句，收官重开之后棋盘上会留着一片已经不存在的影子。
    if (changed) this.sceneManager.invalidateShadows();
  }

  /**
   * 热替换黑 / 白棋子材质。
   *
   * 由 `GomokuScene.setStoneMaterials` 转发：商城装备或换回默认时调用。
   * 已落子的棋子会即时改指新材质，因此在对局中途切换也能立刻看到效果。
   * 非法 id 回退到默认材质，绝不渲染出「无材质」的棋子。
   */
  setStoneMaterials(blackId: string, whiteId: string): void {
    const blackDef = getMaterialDef(blackId) ?? materialDef(DEFAULT_BLACK_MATERIAL);
    const whiteDef = getMaterialDef(whiteId) ?? materialDef(DEFAULT_WHITE_MATERIAL);
    this.stoneMaterialIds = { black: blackDef.materialId, white: whiteDef.materialId };
    const blackMaterial = createStoneMaterial(blackDef);
    const whiteMaterial = createStoneMaterial(whiteDef);

    const previousBlack = this.stoneMaterials.black;
    const previousWhite = this.stoneMaterials.white;
    this.stoneMaterials.black = blackMaterial;
    this.stoneMaterials.white = whiteMaterial;

    // 已落子的棋子重新指向新材质。
    for (const entry of this.stones.values()) {
      entry.mesh.material = this.stoneMaterials[entry.color === 1 ? 'black' : 'white'];
    }
    // 旧材质不再被任何棋子引用，释放显存。
    previousBlack.dispose();
    previousWhite.dispose();
    // 换了材质不改变任何几何，但半透明/透射会改变遮挡关系，重画一次阴影更稳。
    this.sceneManager.invalidateShadows();
  }

  /** 当前装备的材质 id，供外部查询（如商城回显）。 */
  get currentMaterialIds(): { black: string; white: string } {
    return { ...this.stoneMaterialIds };
  }

  /** 清空所有棋子、标记与动画。 */
  /**
   * 设置手数编号的显示范围。
   *
   * 只影响「画不画、画几手」，与规则无关，所以放在渲染层而不是对局状态里。
   */
  setMoveNumberMode(mode: MoveNumberMode): void {
    if (this.moveNumberMode === mode) return;
    this.moveNumberMode = mode;
    this.renderMoveNumbers();
    // 编号与圆点表达的是同一个信息（最新一手在哪），两者只留一个：
    // 编号开着的时候，最新一手自带红字，再叠个圆点反而互相打架。
    this.refreshLastMarker();
  }

  /**
   * 开关棋盘四周坐标（A–O 列、1–15 行）。
   * 开启时按需构建一次标签（坐标布局固定，不会随落子变化，故只在开关跳变时重建）；
   * 关闭时整体撤下并释放纹理，避免无谓渲染。
   */
  setBoardCoordinates(enabled: boolean): void {
    if (this.showBoardCoords === enabled) return;
    this.showBoardCoords = enabled;
    this.coordsGroup.clear();
    for (const texture of this.coordLabelTextures) texture.dispose();
    this.coordLabelTextures.length = 0;
    this.coordsGroup.visible = enabled;
    if (enabled) this.buildBoardCoordinates();
  }

  /** 沿木框边缘铺坐标：列字母沿前缘（+Z），行号沿左缘（-X），A1 落在左前角。 */
  private buildBoardCoordinates(): void {
    const edge = BOARD_WIDTH / 2 - 0.5; // 木框中带，刚好在格线之外、边框之内
    const y = BOARD_SURFACE_Y + 0.008;
    // 列：A(0)..O(14) 沿前缘
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const { x } = positionFor(0, col);
      this.addCoordLabel(String.fromCharCode(65 + col), x, edge, y);
    }
    // 行：row 14 → "1"（前缘），row 0 → "15"（后缘），沿左缘 -X
    for (let row = 0; row < BOARD_SIZE; row += 1) {
      const { z } = positionFor(row, 0);
      this.addCoordLabel(String(15 - row), -edge, z, y);
    }
  }

  private addCoordLabel(text: string, x: number, z: number, y: number): void {
    const texture = makeLabelTexture(text);
    this.coordLabelTextures.push(texture);
    const mesh = new THREE.Mesh(
      this.coordLabelGeometry,
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, y, z);
    this.coordsGroup.add(mesh);
  }

  /** 同步着法序列。棋盘每变一次都要给，编号是从序列里查出来的，不是从格子里猜的。 */
  setHistory(moves: readonly Move[]): void {
    this.history = moves;
    this.renderMoveNumbers();
  }

  /**
   * 按当前设置重新铺一遍手数。
   *
   * 标签是**挂在棋子网格下面**的子节点，而不是单独摆在世界坐标里：
   * 落子有下落与压扁动画，标签跟着棋子一起动才不会「石头还在天上、数字已经落定」。
   */
  private renderMoveNumbers(): void {
    // 先算出「这一帧应该有哪几个标签」，再去和现有的做差量：
    // 每落一手都推倒重建的话，「全部步数」在满盘时会一次丢掉两百多个
    // 材质实例，纯属给 GC 添活。
    //
    // 最后一手（`history.length - 1`）单独标出：对局时它是「刚下的那手」，
    // 复盘时它是「当前摆到的那手」——两种场合指的都是同一件事，共用一套红色。
    const lastIndex = this.history.length - 1;
    const wanted = new Map<string, { value: number; color: PlayerColor; latest: boolean }>();
    for (const index of visibleMoveIndices(this.moveNumberMode, this.history.length)) {
      const move = this.history[index];
      // 序列来自网络：脏数据（缺字段 / 越界）不该让整个棋盘抛错，跳过这一手即可。
      if (!move || !Number.isInteger(move.row) || !Number.isInteger(move.col)) continue;
      const entry = this.stones.get(`${move.row}:${move.col}`);
      // 悔棋或重开之后，序列里的第 n 手可能已经不在盘上了，跳过即可。
      if (!entry || entry.color !== move.color) continue;
      wanted.set(`${move.row}:${move.col}`, {
        value: index + 1,
        color: move.color,
        latest: index === lastIndex,
      });
    }

    for (const [key, label] of [...this.moveLabels]) {
      if (wanted.has(key)) continue;
      this.disposeLabel(label);
      this.moveLabels.delete(key);
    }

    for (const [key, spec] of wanted) {
      const existing = this.moveLabels.get(key);
      // 「是不是最新一手」也要比：只比数字的话，下一手落子之后
      // 上一手的红字会一直留在盘上。
      if (existing && existing.value === spec.value && existing.latest === spec.latest) continue;
      if (existing) {
        this.disposeLabel(existing);
        this.moveLabels.delete(key);
      }

      const entry = this.stones.get(key);
      if (!entry) continue;

      const mesh = new THREE.Mesh(
        this.labelGeometry,
        new THREE.MeshBasicMaterial({
          map: this.numberTexture(spec.value, spec.color, spec.latest),
          transparent: true,
          // 关深度写入（它只是一层字，不该挡住后面的东西）、留深度测试
          // （否则对面半场的棋子会把字透到棋盘外面来）。
          depthWrite: false,
          // 带 alpha 的贴图参与排序，相邻棋子叠在一起时才不会互相抹掉。
          alphaTest: 0.02,
          // 不参与色调映射：红字是按「#b3251a」画的，经过 ACES + 曝光之后
          // 会被提亮成粉色，白子上的深字也会发灰。这层字是要被人读的，
          // 不是场景里的受光物体，保持原色才对。
          toneMapped: false,
        }),
      );
      // 边长约等于棋子直径的 75%：贴图本身留了边，真实笔画仍落在棋子内部；
      // 再大就会盖住棋子边缘的高光，远看像一颗贴了标签的圆片。
      mesh.scale.setScalar(STONE_RADIUS * 1.5);
      // 抬高一点点压在顶面之上躲 z-fighting（0.01 在画面上就是零）。
      mesh.position.set(0, STONE_RADIUS * STONE_FLAT_RATIO + 0.01, 0);
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = 3;
      entry.mesh.add(mesh);
      this.moveLabels.set(key, { mesh, value: spec.value, latest: spec.latest });
    }
  }

  private disposeLabel(label: { mesh: THREE.Mesh }): void {
    label.mesh.removeFromParent();
    const material = label.mesh.material;
    if (Array.isArray(material)) for (const item of material) item.dispose();
    else material.dispose();
    // 几何是多个标签共享的，这里只销毁材质——销毁几何会让剩下的标签一起消失。
  }

  private clearMoveNumbers(): void {
    for (const label of this.moveLabels.values()) this.disposeLabel(label);
    this.moveLabels.clear();
  }

  private numberTexture(value: number, color: PlayerColor, latest: boolean): THREE.Texture {
    const key = `${value}:${color}:${latest ? 'latest' : 'plain'}`;
    const cached = this.numberTextures.get(key);
    if (cached) return cached;
    // 黑子配浅字、白子配深字：一套配色不可能在两种底色上都看得清。
    // 最新一手另换红色，所以缓存键里必须带上这一位。
    const texture = makeMoveNumberTexture(value, color === 1 ? 'light' : 'dark', latest);
    this.numberTextures.set(key, texture);
    return texture;
  }

  clear(): void {
    this.tweens.clear();
    this.clearMoveNumbers();
    for (const entry of this.stones.values()) {
      this.root.remove(entry.mesh);
    }
    this.stones.clear();
    for (const ripple of this.ripples) this.disposeRipple(ripple);
    this.ripples.length = 0;
    this.winnerMarkers.clear();
    // 换局清盘时把「最新一手」一并忘掉：延迟计时器若留着，可能在空盘上凭空亮个点。
    this.lastMove = null;
    this.markerRevealAt = null;
    this.lastMarker.visible = false;
    for (const hint of this.hints) this.disposeHint(hint);
    this.hints.length = 0;
    // 换局清盘：排队的推荐点也一并作废，别让旧局的建议在新盘上冒出来。
    this.pendingHint = null;
    this.sceneManager.invalidateShadows();
  }

  /**
   * 设置悬停预览。传 `null` 隐藏；`color` 决定预览棋子的黑白。
   */
  setHover(point: BoardPoint | null, color: PlayerColor): void {
    this.hoverColor = color;
    if (!point) {
      this.ghost.visible = false;
      this.ghostGlow.visible = false;
      this.hoverRing.visible = false;
      return;
    }
    const { x, z } = positionFor(point.row, point.col);
    const material = color === 1 ? this.stoneMaterials.black : this.stoneMaterials.white;
    const def = materialDef(color === 1 ? this.stoneMaterialIds.black : this.stoneMaterialIds.white);
    this.ghost.material.color.copy(material.color);
    // 预览棋子跟随装备材质的透明度：实体子更实，玻璃子更虚。
    this.ghost.material.transparent = true;
    this.ghost.material.opacity = 0.44 * def.opacity;
    this.ghost.position.set(x, STONE_REST_Y, z);
    this.ghost.visible = true;

    this.ghostGlow.material.color.set(color === 1 ? '#d8c39a' : '#fff2d4');
    this.ghostGlow.position.set(x, BOARD_SURFACE_Y + 0.03, z);
    this.ghostGlow.visible = true;

    this.hoverRing.position.set(x, BOARD_SURFACE_Y + 0.012, z);
    this.hoverRing.material.color.set(color === 1 ? '#4a3f2e' : '#9c8a6a');
    this.hoverRing.visible = true;
  }

  /**
   * 标记最后一手（落点上的「靶心」圆点）。
   *
   * @param delayMs 延迟显示的毫秒数。带落子动画的新手要等棋子落定再亮点，
   *   否则子还在半空、点已经贴在落点上，看起来像点在等子；载入历史棋谱
   *   （复盘跳转、重连同步）没有动画，传 0 立即显示。
   */
  setLastMove(move: { row: number; col: number; color: PlayerColor } | null, delayMs = 0): void {
    // 局面一变（落子 / 清盘），排队的旧建议也随即作废，别在新局面上冒出来。
    this.pendingHint = null;
    // 场上推荐点即过时：先陪落子动画走一段再抽缩收场。
    // 只有「同一局里真有一子落下」的快照（delayMs > 0）才延迟；首次载入 / 清盘立即收。
    this.collapseHints(delayMs > 0 ? HINT_COLLAPSE_DELAY : 0);
    this.lastMove = move;
    this.markerRevealAt = move && delayMs > 0 ? performance.now() + delayMs : null;
    this.refreshLastMarker();
  }

  /** 按当前状态（有没有最后一手 / 编号是否开启 / 延迟是否到点）刷新圆点。 */
  private refreshLastMarker(): void {
    const move = this.lastMove;
    if (!move || this.moveNumberMode !== 'off' || this.markerRevealAt !== null) {
      this.lastMarker.visible = false;
      return;
    }
    const { x, z } = positionFor(move.row, move.col);
    this.lastMarker.position.set(x, STONE_REST_Y + 0.185, z);
    // 黑子配浅金、白子配深棕：与手数编号同一套对比策略。
    const color = move.color === 1 ? '#e9c47f' : '#4c3b26';
    this.lastMarkerDot.material.color.set(color);
    this.lastMarkerRing.material.color.set(color);
    this.lastMarker.visible = true;
  }

  /** 高亮获胜的五连。 */
  setWinningLine(points: BoardPoint[]): void {
    this.winnerMarkers.clear();
    if (points.length === 0) return;
    const geometry = new THREE.RingGeometry(0.405, 0.435, 36);
    const material = new THREE.MeshBasicMaterial({
      color: '#b58c4d',
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
    });
    for (const point of points) {
      const ring = new THREE.Mesh(geometry, material);
      const { x, z } = positionFor(point.row, point.col);
      ring.position.set(x, BOARD_SURFACE_Y + 0.02, z);
      ring.rotation.x = -Math.PI / 2;
      this.winnerMarkers.add(ring);
    }
  }

  /**
   * 射线拾取：把一条世界空间射线换算成最近的交叉点。
   * 与棋盘面求交，再按格距四舍五入；偏离交叉点超过半格则视为未命中。
   */
  pick(raycaster: THREE.Raycaster): BoardPoint | null {
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(this.interactionPlane, hit)) return null;
    const offset = (BOARD_SIZE - 1) / 2;
    const col = Math.round(hit.x / GRID_SPACING + offset);
    const row = Math.round(hit.z / GRID_SPACING + offset);
    if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) return null;
    const center = positionFor(row, col);
    if (Math.hypot(hit.x - center.x, hit.z - center.z) > GRID_SPACING * 0.47) return null;
    return { row, col };
  }

  // ---------------------------------------------------------------------
  // 构建
  // ---------------------------------------------------------------------

  private buildBoard(): void {
    const wood = makeWoodTexture(this.sceneManager.renderer);
    this.boardMaterial = new THREE.MeshStandardMaterial({
      map: wood,
      // 占位贴图阶段也别用纯白：真实贴图会异步接上来，
      // 但首帧如果亮到发白，用户会先看到一个「白板」再变回棋盘。
      color: '#a2855a',
      roughness: 0.86,
      metalness: 0,
      // 环境反射压低：板面亮度大头若来自 envMap（IBL 不受阴影影响），
      // 灯光的影子再浓也看不见——影子可见度 = 灯光占总亮度的比例。
      envMapIntensity: 0.3,
    });
    this.boardTextures.push(wood);
    const board = new THREE.Mesh(
      new RoundedBoxGeometry(BOARD_WIDTH, BOARD_THICKNESS, BOARD_WIDTH, 5, 0.12),
      this.boardMaterial,
    );
    board.receiveShadow = true;
    board.castShadow = true;
    this.boardGroup.add(board);

    // 格线用「有真实宽度的薄片」而不是 LineSegments。
    // WebGL 的 lineWidth 恒为 1px：放大后线细得像头发丝，还会因为与板面共面
    // 产生 z-fighting，整条线随机消失。改用几何片后宽度随缩放变化，也不再闪。
    const gridMaterial = new THREE.MeshStandardMaterial({
      color: PALETTE.grid,
      roughness: 0.9,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    this.boardGroup.add(new THREE.Mesh(this.buildLineGeometry(GRID_EXTENT), gridMaterial));

    // 真实五子棋盘只有 15 路格线本身：最外一圈线就是边框，
    // 线外直接是木板留白——不再额外画一圈装饰矩形。

    const starGeometry = new THREE.CircleGeometry(0.078, 24);
    const starMaterial = new THREE.MeshStandardMaterial({ color: PALETTE.star, roughness: 0.9 });
    const starPoints: BoardPoint[] = [
      { row: 3, col: 3 }, { row: 3, col: 11 }, { row: 7, col: 7 },
      { row: 11, col: 3 }, { row: 11, col: 11 },
    ];
    for (const point of starPoints) {
      const star = new THREE.Mesh(starGeometry, starMaterial);
      const { x, z } = positionFor(point.row, point.col);
      star.position.set(x, BOARD_SURFACE_Y + LINE_LIFT, z);
      star.rotation.x = -Math.PI / 2;
      this.boardGroup.add(star);
    }

    void this.applyBoardWood();
  }

  /**
   * 用真实贴图替换程序化棋盘木纹。
   *
   * 棋盘是全场离镜头最近的材质——玩家整局都在盯着它。程序化木纹放大后能看出
   * 重复的条纹和规律的噪点，一眼就知道是算出来的；换成真实的整块榧木板贴图后，
   * 纹理的随机性和细腻度立刻不一样，而且和房间里的木家具是在同一套摄影条件下拍的，
   * 放在一起不会「一个像照片、一个像贴纸」。
   */
  private async applyBoardWood(): Promise<void> {
    // 整幅取样：这套贴图本来就是按「一张贴图 = 一块整板」做的，
    // 不需要再从中裁一块，把全部分辨率都留给棋盘近景。
    const repeat = 1;
    const offset = (1 - repeat) / 2;
    const set = await loadPbrTextureSet('board', repeat, {
      ao: true,
      anisotropy: 16,
    }).catch(() => null);
    if (!set) return;

    for (const texture of [set.map, set.normalMap, set.roughnessMap, set.aoMap]) {
      if (!texture) continue;
      texture.offset.set(offset, offset);
    }

    this.boardMaterial.map = set.map;
    this.boardMaterial.normalMap = set.normalMap;
    this.boardMaterial.roughnessMap = set.roughnessMap;
    this.boardMaterial.aoMap = set.aoMap;
    this.boardMaterial.aoMapIntensity = 0.7;
    // 贴图本身已经按榧木的奶油金色校准过，tint 保持纯白即可——
    // 再乘暖色只会把它推向橙黄。
    //
    // 曾经因为「过曝」把 tint 压到 `#cbb894` / roughness 0.95，结果走向另一个极端：
    // 深色场景里棋盘沉进背景，白子像悬在半空。棋盘是全场唯一必须**始终好读**的
    // 物件，宁可让它比周围家具亮一档——过曝可以用曝光和灯光收敛，
    // 而一块发闷的深色棋盘没有任何补救手段。
    this.boardMaterial.color.set('#a2855a');
    // 棋盘是打磨上蜡的缎面：细部交给粗糙度贴图（纹理线略糙、亮木略滑），
    // 标量只做整体定调，配合贴图均值落在 0.35 左右的丝质微光区间。
    // tint 定为 #a2855a（琥珀暖木，按用户反馈在「太浅 #ffffff」与「太暗 #8a6f45」之间取中）。注意 ACES 色调映射在中高亮度区压缩严重：#c9b48c/#9d8055 档位渲染出来仍接近原浅色，只有这一档才跨过视觉拐点——灰度直觉在这里失效，调色必须截图验证：用户反馈棋盘太浅；此前 #cbb894 的教训是
    // 不能碰 roughness/压得太狠，否则深色场景里棋盘沉进背景——只动颜色不动粗糙度，白子对比依旧靠亮度差。
    this.boardMaterial.roughness = 1.0;
    this.boardMaterial.envMapIntensity = 0.3;
    this.boardMaterial.normalScale.set(0.55, 0.55);
    this.boardMaterial.needsUpdate = true;

    for (const texture of [set.map, set.normalMap, set.roughnessMap, set.aoMap]) {
      if (texture) this.boardTextures.push(texture);
    }
  }

  /**
   * 生成格线几何：把每一条线摊成一块极薄的矩形（两个三角形）。
   *
   * @param extent 线的半长
   * @param halfWidth 线的半宽（世界单位），默认约为格距的 4%——
   *   与真实棋盘的墨线宽度比例相当，再粗就成了「画框」
   * @param offsets 自定义线位置；省略时按 15 路等距生成
   */
  private buildLineGeometry(
    extent: number,
    halfWidth = GRID_SPACING * 0.02,
    offsets?: number[],
  ): THREE.BufferGeometry {
    const positions: number[] = [];
    // 注意是「板面 + 抬升」而不是抬升本身：写绝对值会把格线埋进棋盘里。
    const y = BOARD_SURFACE_Y + LINE_LIFT;
    const push = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): void => {
      positions.push(ax, y, az, bx, y, bz, cx, y, cz);
      positions.push(ax, y, az, cx, y, cz, dx, y, dz);
    };

    const lines = offsets ?? Array.from({ length: BOARD_SIZE }, (_, index) => (index - (BOARD_SIZE - 1) / 2) * GRID_SPACING);
    for (const offset of lines) {
      // 横线（沿 X）
      push(-extent, offset - halfWidth, extent, offset - halfWidth, extent, offset + halfWidth, -extent, offset + halfWidth);
      // 竖线（沿 Z）
      push(offset - halfWidth, -extent, offset - halfWidth, extent, offset + halfWidth, extent, offset + halfWidth, -extent);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    return geometry;
  }

  // ---------------------------------------------------------------------
  // 棋子与动画
  // ---------------------------------------------------------------------

  private addStone(
    row: number,
    col: number,
    color: PlayerColor,
    animate: boolean,
    onLand?: (color: PlayerColor) => void,
  ): void {
    const material = color === 1 ? this.stoneMaterials.black : this.stoneMaterials.white;
    const mesh = new THREE.Mesh(this.stoneGeometry, material);
    const { x, z } = positionFor(row, col);
    // 棋子投射真实阴影：让场景里的投影平行光在棋盘上投出随光向偏移、带半影的
    // 接触影（静物摄影里「棋子压在盘上」的落影），取代之前居中、无半影的 blob 暗片。
    // 棋子自身不接收阴影：透射棋子的折射采样恰好取正下方那块板，叠影会乌成一团。
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.scale.set(STONE_BASE_SCALE.x, STONE_BASE_SCALE.y, STONE_BASE_SCALE.z);
    mesh.position.set(x, STONE_REST_Y, z);

    this.stones.set(`${row}:${col}`, { mesh, color });
    this.root.add(mesh);

    // 不带动画（首次载入 / 复盘跳转 / 重连整盘重建）或用户开了「减弱动效」时，
    // 棋子直接摆上盘，没有落地涟漪；落子音在这里立即响，保证静默动效下仍有反馈。
    if (!animate || this.reducedMotion) {
      onLand?.(color);
      return;
    }
    this.playDrop(mesh, row, col, color, onLand);
  }

  /**
   * 落子动画，共两段：
   *
   * 1. 下落 300ms —— 从棋盘上方 `DROP_HEIGHT` 处自由落体到棋盘面。
   *    曲线用 `Easing.gravity`（位移 ∝ t²），呈现加速下坠的手感。
   * 2. 挤压回弹 100ms —— 落地瞬间把 y 轴压到 0.8、x/z 撑到 1.2，
   *    再在 0.1 秒内弹回原始比例（squash & stretch）。
   *
   * 之所以拆成两段而不是一条曲线：落地是一个「瞬间」事件，
   * 用 `onComplete` 串接语义最直白，也方便中途只取消其中一段。
   */
  private playDrop(
    mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>,
    row: number,
    col: number,
    color: PlayerColor,
    onLand?: (color: PlayerColor) => void,
  ): void {
    const { x, z } = positionFor(row, col);
    const restY = STONE_REST_Y;

    // 起点：棋子在棋盘正上方 DROP_HEIGHT 处。
    mesh.position.set(x, restY + DROP_HEIGHT, z);

    this.tweens.add({
      duration: DROP_DURATION,
      easing: Easing.gravity,
      onUpdate: (progress) => {
        // progress 已经从 0 缓动到 1（t²），直接线性插值即可。
        mesh.position.y = restY + DROP_HEIGHT * (1 - progress);
      },
      onComplete: () => {
        mesh.position.y = restY;
        this.playSquash(mesh);
        this.playBounce(mesh, restY);
        // 落地涟漪：棋子砸到盘面的瞬间才扩散开来。落子音也卡在这一个时刻，
        // 让「听感」和「视觉」同步——涟漪一出现，啪的一声才落下，
        // 而不是在棋子还在半空时就提前响。
        this.spawnRipple(row, col);
        onLand?.(color);
      },
    });
  }

  /**
   * 落地回弹：一个极小的抛物线二次起跳。
   *
   * 和挤压动画同时播放——挤压负责「重量」，回弹负责「材质有弹性」。
   * 幅度只有 0.11 个世界单位（棋子半径的 1/3 不到），过了就变成弹力球。
   */
  private playBounce(
    mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>,
    restY: number,
  ): void {
    this.tweens.add({
      duration: 150,
      easing: Easing.easeOutCubic,
      onUpdate: (progress) => {
        mesh.position.y = restY + Math.sin(progress * Math.PI) * 0.11;
      },
      onComplete: () => {
        mesh.position.y = restY;
      },
    });
  }

  /** 落地挤压：先瞬间压扁，再用 100ms 恢复。 */
  private playSquash(
    mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>,
  ): void {
    const apply = (xz: number, y: number): void => {
      mesh.scale.set(STONE_BASE_SCALE.x * xz, STONE_BASE_SCALE.y * y, STONE_BASE_SCALE.z * xz);
    };

    apply(SQUASH_SCALE_XZ, SQUASH_SCALE_Y);

    this.tweens.add({
      duration: SQUASH_DURATION,
      easing: Easing.easeOutCubic,
      onUpdate: (progress) => {
        apply(
          THREE.MathUtils.lerp(SQUASH_SCALE_XZ, 1, progress),
          THREE.MathUtils.lerp(SQUASH_SCALE_Y, 1, progress),
        );
      },
      onComplete: () => apply(1, 1),
    });
  }

  /** 落地涟漪：一圈向外扩散并淡出的细环。 */
  private spawnRipple(row: number, col: number): void {
    const material = new THREE.MeshBasicMaterial({
      color: '#f5e6c7',
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(new THREE.RingGeometry(0.38, 0.415, 48), material);
    const { x, z } = positionFor(row, col);
    mesh.position.set(x, BOARD_SURFACE_Y + 0.015, z);
    mesh.rotation.x = -Math.PI / 2;
    this.root.add(mesh);
    this.ripples.push({ mesh, startedAt: performance.now() });
  }

  /**
   * 在某个交叉点上亮出一个 AI 建议提示环：醒目的绿色，且一直保持到下一颗
   * 棋子落定后再收起（见 {@link HINT_COLLAPSE_DELAY}）。
   *
   * 与涟漪共用「几何 + 材质逐个释放」的纪律：提示环是一次性的，
   * 不能在满盘提示中堆出一地泄漏。同一时刻只保留一个推荐点。
   *
   * **旧环退场期间不硬切**：落子后旧环正处于「延迟保持 / 收缩」的退场动画中，
   * 此时引擎思考或联机广播送来的新点先排队（{@link pendingHint}），等旧环
   * 收完再亮——否则新环会直接 dispose 旧环，收缩动画永远看不见。
   */
  showHint(row: number, col: number): void {
    if (this.hints.some((hint) => hint.collapsedAt !== null)) {
      this.pendingHint = { row, col };
      return;
    }
    this.pendingHint = null;
    this.spawnHint(row, col);
  }

  /** 真正创建并挂上一个推荐环；调用方负责「同一时刻只有一个」的时序。 */
  private spawnHint(row: number, col: number): void {
    // 同一时刻只保留一个推荐点：先清掉场上残留的旧环。
    for (let index = this.hints.length - 1; index >= 0; index -= 1) {
      const hint = this.hints[index];
      if (hint) this.disposeHint(hint);
    }
    this.hints.length = 0;
    const material = new THREE.MeshBasicMaterial({
      color: PALETTE.hint,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.37, 48), material);
    const { x, z } = positionFor(row, col);
    mesh.position.set(x, BOARD_SURFACE_Y + 0.02, z);
    mesh.rotation.x = -Math.PI / 2;
    this.root.add(mesh);
    this.hints.push({ mesh, startedAt: performance.now(), collapsedAt: null });
    this.sceneManager.invalidateShadows();
  }

  /**
   * 安排收起当前所有推荐点：落子后推荐已过时，环以「抽缩到 0%」的动画退场，
   * 而不是生硬消失。
   *
   * @param delayMs 延迟多久才开始收缩。落子时传 {@link HINT_COLLAPSE_DELAY}，
   *   让绿圈先陪棋子下落一段、等棋子落定后再收；清盘 / 载入传 0 立即收。
   *   已安排过退场的环不重复安排，避免同一次落子被多次快照反复推迟。
   */
  collapseHints(delayMs = 0): void {
    const startAt = performance.now() + Math.max(0, delayMs);
    for (const hint of this.hints) {
      if (hint.collapsedAt === null) hint.collapsedAt = startAt;
    }
  }

  private disposeRipple(ripple: Ripple): void {
    this.root.remove(ripple.mesh);
    ripple.mesh.geometry.dispose();
    ripple.mesh.material.dispose();
  }

  private disposeHint(hint: Hint): void {
    this.root.remove(hint.mesh);
    hint.mesh.geometry.dispose();
    hint.mesh.material.dispose();
  }

  // ---------------------------------------------------------------------
  // 每帧更新
  // ---------------------------------------------------------------------

  private update(now: number): void {
    // 延迟显示的最新一手圆点：到点才亮，棋子落定与圆点出现的顺序由此保证。
    if (this.markerRevealAt !== null && now >= this.markerRevealAt) {
      this.markerRevealAt = null;
      this.refreshLastMarker();
    }

    // 涟漪：放大 + 淡出，结束后立刻释放几何体与材质。
    for (let index = this.ripples.length - 1; index >= 0; index -= 1) {
      const ripple = this.ripples[index];
      if (!ripple) continue;
      const progress = Math.min(1, (now - ripple.startedAt) / RIPPLE_DURATION);
      ripple.mesh.scale.setScalar(1 + progress * 2.1);
      ripple.mesh.material.opacity = (1 - progress) * 0.5;
      if (progress >= 1) {
        this.disposeRipple(ripple);
        this.ripples.splice(index, 1);
      }
    }

    // AI 建议提示环：轻轻呼吸、保持可见；落子后先保持一小段、再平滑收缩淡出。
    for (let index = this.hints.length - 1; index >= 0; index -= 1) {
      const hint = this.hints[index];
      if (!hint) continue;
      // 还没到退场时刻（从未安排，或仍在 HINT_COLLAPSE_DELAY 的延迟窗口内）：
      // 继续呼吸、保持满尺寸——这一段正是「陪着棋子下落」的观感来源。
      if (hint.collapsedAt === null || now < hint.collapsedAt) {
        const pulse = 1 + Math.sin((now - hint.startedAt) / 600) * 0.07;
        hint.mesh.scale.setScalar(pulse);
        hint.mesh.material.opacity = 0.9;
        continue;
      }
      // 退场阶段：从满尺寸线性缩到 0，并同步淡出。
      // 注意必须用「相对起点」的绝对比例，不能拿当前 scale 自乘——
      // 那会变成指数收缩，几帧内就没了，等于没有过渡。
      const shrink = Math.min(1, (now - hint.collapsedAt) / HINT_COLLAPSE_DURATION);
      hint.mesh.scale.setScalar(Math.max(0.001, 1 - shrink));
      hint.mesh.material.opacity = 0.9 * (1 - shrink);
      if (shrink >= 1) {
        this.disposeHint(hint);
        this.hints.splice(index, 1);
      }
    }

    // 旧环退场完成、场上已无环：把退场期间排队的新推荐点补上。
    if (this.hints.length === 0 && this.pendingHint) {
      const next = this.pendingHint;
      this.pendingHint = null;
      this.spawnHint(next.row, next.col);
    }

    // 预览光晕：缓慢呼吸，提示「这里可以落子」。尊重 reduced-motion 时保持恒定。
    if (!this.ghostGlow.visible || this.reducedMotion) return;
    const pulse = 0.5 + Math.sin(now * 0.0032) * 0.5;
    this.ghostGlow.material.opacity = 0.24 + pulse * 0.14;
    this.ghostGlow.scale.setScalar(1.9 + pulse * 0.16);
  }

  /** 当前预览棋子的颜色，供外部查询。 */
  get currentHoverColor(): PlayerColor {
    return this.hoverColor;
  }

  dispose(): void {
    for (const texture of this.boardTextures) texture.dispose();
    for (const texture of this.numberTextures.values()) texture.dispose();
    this.numberTextures.clear();
    this.labelGeometry.dispose();
    this.clear();
    this.root.removeFromParent();
    this.stoneGeometry.dispose();
    this.stoneMaterials.black.dispose();
    this.stoneMaterials.white.dispose();
    this.glowTexture.dispose();
    this.ghost.material.dispose();
    this.ghostGlow.material.dispose();
    this.hoverRing.geometry.dispose();
    this.hoverRing.material.dispose();
    this.lastMarkerDot.geometry.dispose();
    this.lastMarkerRing.geometry.dispose();
    // 圆点与外环共用一份材质，销毁一次即可。
    this.lastMarkerDot.material.dispose();
  }
}
