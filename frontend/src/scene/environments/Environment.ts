import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { BOARD_SURFACE_Y, BOARD_THICKNESS, BOARD_WIDTH, TABLE_SURFACE_Y } from '../config';
import { fitModel, loadModel, prepareModel } from '../assets';
import type { ScenePresetId } from '../../game/scenes';

/**
 * 环境的公共约定。
 *
 * 一个「环境」= 围绕棋盘的一切：地面、墙体或庭院、家具、光照、背景色与雾。
 * 棋盘、棋子、铜铃不属于环境——它们是游戏本体，换环境时留在原地。
 *
 * 每个环境自带：
 * - `intro`：开局推镜的起点机位。客厅该从窗外推进来，庭院该从天上落下来，
 *   赛博房该从霓虹深处亮起来——同一个「坐下来对弈」的叙事，不同的开场白。
 * - `background` / `fog` / `environmentIntensity` / `exposure`：挂到 `scene`
 *   上的全局氛围，由 SceneManager 在 {@link SceneManager.applyEnvironment} 里
 *   统一应用——只有它知道「下一个」环境是什么，也知道旧值该还原成什么。
 */
export interface IntroDescriptor {
  /** 推镜起始机位（世界坐标）。 */
  position: [number, number, number];
  /** 推镜起始目标点。 */
  target: [number, number, number];
  /** 起始视场（度）；不给就用 64 的广角默认。 */
  fov?: number;
  /** 推镜时长（毫秒）；不给就用 SceneManager 的默认 5400。 */
  duration?: number;
}

/** 桌面上表面：所有环境的桌子都把桌面顶在这条线上，棋盘与铜铃才对得齐。 */
export const TABLE_TOP_Y = -BOARD_THICKNESS / 2;

/**
 * 桌面默认边长。
 *
 * 从 36 收到 30 是一次构图修正：**默认取景下桌沿原本整个在画面外**，
 * 那张桌子就退化成「一块无限大的深色平面」，棋盘像浮在上面。
 * 收到 30 之后桌沿刚好进画面边缘，一眼能看出这是「一张桌子」，
 * 院子 / 榻榻米 / 发光地板才交代得出来。
 * 30 单位 ≈ 93cm，仍然是真实矮几的尺寸（棋盘 45cm 摆在上面比例也对）。
 */
export const TABLE_SIZE = 30;
export const TABLE_THICKNESS = 0.55;
/** 桌腿默认高度：决定坐姿棋盘离地多少。 */
export const TABLE_LEG_HEIGHT = 12.4;

/**
 * 已解析的扫描模型原型，**全进程缓存**。
 *
 * 切棋境是常态，同一个 GLB 反复 fetch + GLTFLoader.parse 会白烧主线程；
 * 这里缓存解析后的 Object3D，每次摆放只 `clone(true)`——几何体与材质共享，
 * 多摆几件的显存成本接近零。原型本身不挂进任何 scene，`dispose()` 也不碰它。
 */
const propPrototypes = new Map<string, Promise<THREE.Object3D | null>>();

function propPrototype(id: string): Promise<THREE.Object3D | null> {
  let pending = propPrototypes.get(id);
  if (!pending) {
    pending = loadModel(id).then((model) => {
      if (model) prepareModel(model, 8);
      return model;
    });
    propPrototypes.set(id, pending);
  }
  return pending;
}

/** 一件桌面陈设的摆位参数。 */
export interface PropOptions {
  /** 模型 id，对应 `public/models/<id>/<id>_1k.glb`。 */
  id: string;
  /** 目标位置（世界坐标，棋盘中心是原点）。 */
  x: number;
  z: number;
  /** 目标最长水平边；放不下时会自动按档缩小。 */
  footprint: number;
  /** 目标高度；给了就优先按高度缩放（落地灯具用，否则会矮得看不见）。 */
  height?: number;
  rotationY?: number;
  /**
   * 绕 X 轴的额外旋转（弧度），在 `fitModel` 之前施加。
   *
   * 有些扫描模型的原始姿态是**竖着立起来的**：`postcard_set` 是一整面
   * 4×5 的明信片墙，平面在 XY 上、z 厚度为零，正俯拍时只看得见一条细线。
   * 传 `-Math.PI / 2` 让它绕 X 躺到桌面上，正面朝上，才读得出是一叠照片。
   * 顺序很重要：先转再量包围盒，缩放与贴地才会按「平躺后」的尺寸算。
   */
  rotationX?: number;
  /** 台面高度，默认 `TABLE_SURFACE_Y`。客厅 GLB 茶几要传 -0.31。 */
  groundY?: number;
  /** 在 groundY 之上再抬一点点：零厚度的平面模型直接贴桌面会 z-fighting。 */
  lift?: number;
  /** 本场景桌面的可用半宽 / 半深，默认按 `TABLE_SIZE` 算。 */
  tableHalf?: [number, number];
  /** 允许的最大高度，避免高物件穿出取景或盖住棋盘。 */
  maxHeight?: number;
  /** 用纯色材质替换模型自带贴图（把斑驳幕布变成干净的影棚背景板）。 */
  flatColor?: string;
}

export interface TableOptions {
  /** 桌面颜色。 */
  top: string;
  /** 桌腿颜色；不给了用比桌面再深一档的同色。 */
  leg?: string;
  roughness?: number;
  metalness?: number;
  /** 桌面自发光色（霓虹镶边用）。 */
  emissive?: string;
  emissiveIntensity?: number;
  size?: number;
  thickness?: number;
  legHeight?: number;
  /** `splayed` 四条外撇圆腿（茶桌），`panel` 四面裙板（霓虹台）。 */
  legStyle?: 'splayed' | 'panel';
}

export abstract class Environment {
  protected readonly root = new THREE.Group();
  protected readonly disposables: Array<THREE.BufferGeometry | THREE.Material | THREE.Texture> = [];

  /** 切棋境后迟到返回的异步资源一律丢弃，别往已销毁的 root 上挂。 */
  protected disposed = false;
  /** 本环境已经摆下的陈设包围盒，供后续摆放做互斥检查。 */
  private readonly placedProps: THREE.Box3[] = [];
  /** 同一环境的摆放串行执行，否则并发的 AABB 检查会互相看不见对方。 */
  private propQueue: Promise<void> = Promise.resolve();

  /** 挂到 scene.background 的全局底色。 */
  abstract readonly background: THREE.ColorRepresentation;
  /** 开局推镜的起点。 */
  abstract readonly intro: IntroDescriptor;

  /** 环境专属的雾；没有就为 null。 */
  readonly fog: THREE.Fog | null = null;
  // 下面几个必须显式标注为 `number`：不写类型标注时 TS 会把 `= 0.46` 推成
  // 字面量类型 `0.46`，子类写 `= 0.3` 就会被判成「改不了基类的类型」。
  /** HDRI 环境贴图的强度（SceneManager 在贴图到位时应用）。 */
  readonly environmentIntensity: number = 0.46;
  /** 色调映射曝光：夜里要比白天亮一点才看得清。 */
  readonly exposure: number = 0.94;
  /**
   * 本环境使用的 HDRI 路径；null 表示沿用 SceneManager 的默认室内 HDRI。
   * 换环境时 SceneManager 按它切换 `scene.environment` 的光照来源。
   */
  readonly hdri: string | null = null;
  /**
   * 是否把 HDRI 原图直接挂成 `scene.background`（360° 实景天空/夜景）。
   * true 时 `background` 颜色只作贴图到位前的兜底。
   */
  readonly hdriBackground: boolean = false;
  /** HDRI 作背景时的亮度系数。 */
  readonly backgroundIntensity: number = 1;
  /**
   * 泛光（Bloom）强度：0 = 关闭。
   * 赛博的霓虹靠它「溢」出来；茶室/庭院给很小的一点柔光，过曝的高光才像照片。
   */
  readonly bloom: number = 0;
  /** 泛光阈值：只有亮度超过它的像素才发光。夜景低、日景高。 */
  readonly bloomThreshold: number = 1;
  /**
   * 相机允许的最远距离。
   *
   * 这是「封闭感」的开关：茶室必须在 56 以内，否则 OrbitControls 一拉远
   * 就穿墙看到了外面的世界。庭院是露天的，可以放到 72 让相机退开看全景。
   */
  readonly maxDistance: number = 56;

  protected constructor(protected readonly scene: THREE.Scene, readonly id: ScenePresetId) {
    scene.add(this.root);
  }

  /** 有动画的环境（赛博樱花飘落、霓虹呼吸）实现它；静止环境不用管。 */
  onFrame(_now: number): void {}

  dispose(): void {
    this.disposed = true;
    this.root.removeFromParent();
    this.disposables.forEach((item) => item.dispose());
    this.disposables.length = 0;
    this.placedProps.length = 0;
  }

  // ------------------------------------------------------------------
  // 建造工具（从旧 RoomEnvironment 收编，三个环境共用）
  // ------------------------------------------------------------------

  /** 创建标准材质并登记，销毁时统一释放。 */
  protected material(
    color: string,
    options: { roughness?: number; metalness?: number } = {},
  ): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({
      color,
      roughness: options.roughness ?? 0.8,
      metalness: options.metalness ?? 0,
    });
    this.disposables.push(material);
    return material;
  }

  /** 登记一个外部创建的几何体，保证销毁时不漏。 */
  protected track<T extends THREE.BufferGeometry>(geometry: T): T {
    this.disposables.push(geometry);
    return geometry;
  }

  /** 把已有几何体包成 mesh 并挂到父节点。 */
  protected mesh(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    parent: THREE.Object3D = this.root,
    options: { cast?: boolean; receive?: boolean } = {},
  ): THREE.Mesh {
    this.track(geometry);
    const object = new THREE.Mesh(geometry, material);
    object.castShadow = options.cast ?? true;
    object.receiveShadow = options.receive ?? true;
    parent.add(object);
    return object;
  }

  /** 建一个盒子并挂到父节点。 */
  protected box(
    size: [number, number, number],
    position: [number, number, number],
    material: THREE.Material,
    parent: THREE.Object3D = this.root,
    options: { cast?: boolean } = {},
  ): THREE.Mesh {
    const geometry = new THREE.BoxGeometry(...size);
    this.disposables.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...position);
    mesh.castShadow = options.cast ?? true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  /** 圆角盒：坐垫、软包这类「软」的形体用它。 */
  protected rounded(
    size: [number, number, number],
    position: [number, number, number],
    radius: number,
    material: THREE.Material,
    parent: THREE.Object3D,
  ): THREE.Mesh {
    const geometry = new RoundedBoxGeometry(size[0], size[1], size[2], 4, radius);
    this.disposables.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  /** 圆柱：桌腿、石灯笼柱身、树干都用它。 */
  protected cylinder(
    radiusTop: number,
    radiusBottom: number,
    height: number,
    position: [number, number, number],
    material: THREE.Material,
    segments = 16,
    parent: THREE.Object3D = this.root,
  ): THREE.Mesh {
    const geometry = new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments);
    this.disposables.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  /**
   * 蒲团（zabuton）：**真实扫描坐垫模型**，按场景染色。
   *
   * 早先这里是「压扁圆角盒 + 一层鼓起 + 一条系带」三个基本体拼出来的。
   * 在远景里还能糊弄，但这个坐垫离镜头不到一米，圆角盒的直角边缘、
   * 完全对称的鼓起、贴若平板的系带，一眼就露。改用 Poly Haven 的
   * Ottoman_01 之后，坐垫的软塌、缝线、被坐出来的凹陷全部来自扫描几何本身，
   * 不需要也不应该再靠调圆角半径去凑。
   *
   * 材质按场景染色：原模型是深棕皮革，直接乘颜色会越乘越脏，所以丢掉它的
   * 漫反射，只保留法线（皮革/织物的细微起伏）并把粗糙度拉满——
   * 在这个尺度下读起来就是哑光布面。
   *
   * `baseY` 是**坐垫要落的那个面的高度**，不是世界原点：茶室放在榻榻米上、
   * 庭院放在缘侧木板上、赛博房放在发光地板上，三个环境的地面并不在同一高度。
   */
  protected zabuton(x: number, z: number, baseY: number, color: string, rotationY = 0): void {
    // 兜底：模型没到位（或加载失败）时先摆一块扁坐垫，保证房间不缺家具
    const fallbackMaterial = this.material(color, { roughness: 0.98 });
    const fallback = this.rounded(
      [15.4, 2.6, 15.4],
      [x, baseY + 1.3, z],
      1.2,
      fallbackMaterial,
      this.root,
    );
    fallback.rotation.y = rotationY;

    void this.placeCushion(fallback, x, z, baseY, color, rotationY);
  }

  /** 坐垫扫描件的原型。一个环境只下载解析一次，两枚坐垫各克隆一份。 */
  private cushionPrototype: Promise<THREE.Object3D | null> | null = null;

  private async placeCushion(
    fallback: THREE.Mesh,
    x: number,
    z: number,
    baseY: number,
    color: string,
    rotationY: number,
  ): Promise<void> {
    const prototype = await (this.cushionPrototype ??= this.loadCushion());
    if (!prototype) return;

    const cushion = prototype.clone(true);
    cushion.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      const source = Array.isArray(node.material) ? node.material[0] : node.material;
      const textured = source instanceof THREE.MeshStandardMaterial ? source : null;

      const material = new THREE.MeshStandardMaterial({
        color,
        // 满粗糙度 + 无金属度：布面不该有镜面高光，只有一片柔和的明暗
        roughness: 0.97,
        metalness: 0,
        normalMap: textured?.normalMap ?? null,
        normalScale: new THREE.Vector2(0.65, 0.65),
      });
      this.disposables.push(material);
      node.material = material;
      node.castShadow = true;
      node.receiveShadow = true;
    });

    // footprint 17 单位 ≈ 53cm：真实座垫的宽度，也让两枚垫子和 30 单位的桌子
    // 排在一起时不至于挤成一团。
    fitModel(cushion, { footprint: 17, rotationY, groundY: baseY });
    cushion.position.x += x;
    cushion.position.z += z;
    this.root.add(cushion);

    // 模型到了，占位坐垫撤掉（几何/材质仍在 disposables 里，销毁时统一释放）
    fallback.visible = false;
  }

  private async loadCushion(): Promise<THREE.Object3D | null> {
    const model = await loadModel('ottoman_01');
    if (!model) return null;
    prepareModel(model, 8);
    // 几何与原始材质归环境所有：克隆体共用它们，所以在原型上登记释放。
    model.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      this.disposables.push(node.geometry);
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      this.disposables.push(...materials);
    });
    return model;
  }

  /**
   * 桌子：桌面 + 桌腿 + 顶面贴图层。
   *
   * 三个环境的桌子长得完全不同，但**顶面永远在 TABLE_TOP_Y 这条线上**——
   * 棋盘压在这条线上、铜铃也摆在这条线上，环境怎么换，这两样都不用挪。
   *
   * 顶面单独用一块 Plane 铺层，是为了热替换贴图时 UV 方向可控
   * （贴图到位后会乘色并接管这层，见各环境的 `applyXxxTexture`）。
   *
   * @returns 顶面那层的材质，供异步贴图贴上去。
   */
  protected buildTable(options: TableOptions): THREE.MeshStandardMaterial {
    const size = options.size ?? TABLE_SIZE;
    const thickness = options.thickness ?? TABLE_THICKNESS;
    const legHeight = options.legHeight ?? TABLE_LEG_HEIGHT;
    const inset = size / 2 - 4;
    const legColor = options.leg ?? '#3b2a1d';

    const topMaterial = new THREE.MeshStandardMaterial({
      color: options.top,
      roughness: options.roughness ?? 0.5,
      metalness: options.metalness ?? 0,
      emissive: options.emissive ? new THREE.Color(options.emissive) : new THREE.Color('#000000'),
      emissiveIntensity: options.emissiveIntensity ?? 0,
    });
    this.disposables.push(topMaterial);
    const top = this.mesh(new THREE.BoxGeometry(size, thickness, size), topMaterial, this.root, {
      cast: true,
    });
    top.position.y = TABLE_TOP_Y - thickness / 2;

    const surfaceMaterial = new THREE.MeshStandardMaterial({
      color: options.top,
      roughness: options.roughness ?? 0.5,
      metalness: options.metalness ?? 0,
    });
    this.disposables.push(surfaceMaterial);
    const surface = this.mesh(
      new THREE.PlaneGeometry(size, size),
      surfaceMaterial,
      this.root,
      { cast: false },
    );
    surface.rotation.x = -Math.PI / 2;
    surface.position.y = TABLE_SURFACE_Y;

    const legY = TABLE_TOP_Y - thickness - legHeight / 2;
    const legMaterial = this.material(legColor, {
      roughness: 0.62,
      metalness: options.metalness ?? 0,
    });

    if (options.legStyle === 'panel') {
      // 四面裙板：四条薄立板贴在桌面四边内侧，是「科技感台座」的惯例。
      for (const axis of ['x', 'z'] as const) {
        for (const side of [-1, 1] as const) {
          const panel: [number, number, number] =
            axis === 'x' ? [0.9, legHeight, size - 3] : [size - 3, legHeight, 0.9];
          const position: [number, number, number] =
            axis === 'x' ? [side * inset, legY, 0] : [0, legY, side * inset];
          const slab = this.box(panel, position, legMaterial, this.root, { cast: false });
          slab.receiveShadow = true;
        }
      }
    } else {
      // 四条外撇圆腿：低桌的稳定感来自腿往外的斜度。
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as Array<[number, number]>) {
        const leg = this.cylinder(0.6, 0.78, legHeight, [sx * inset, legY, sz * inset], legMaterial, 14);
        leg.rotation.z = -sx * 0.07;
        leg.rotation.x = sz * 0.07;
      }
    }

    return surfaceMaterial;
  }

  /** 桌面沿（每张桌子都贴着 TABLE_TOP_Y 这条线放顶面）。 */
  protected get tableSurfaceY(): number {
    return TABLE_SURFACE_Y;
  }

  // ------------------------------------------------------------------
  // 桌面陈设：只用真实扫描模型，自带防穿模
  // ------------------------------------------------------------------

  /** 棋盘 + 棋子所在柱体，陈设一律不得侵入。 */
  private static readonly BOARD_KEEPOUT = new THREE.Box3(
    new THREE.Vector3(-BOARD_WIDTH / 2 - 0.45, TABLE_TOP_Y - 0.1, -BOARD_WIDTH / 2 - 0.45),
    new THREE.Vector3(BOARD_WIDTH / 2 + 0.45, BOARD_SURFACE_Y + 0.9, BOARD_WIDTH / 2 + 0.45),
  );

  /** 铜铃（含悬停光环）占位，与 scene/Bell.ts 的 POSITION 对齐。 */
  private static readonly BELL_KEEPOUT = new THREE.Box3(
    new THREE.Vector3(-8.15 - 2.4, TABLE_TOP_Y - 0.1, 6.05 - 2.4),
    new THREE.Vector3(-8.15 + 2.4, TABLE_TOP_Y + 3.2, 6.05 + 2.4),
  );

  /**
   * 在桌面摆一件**真实扫描模型**。
   *
   * 所有摆位都过 AABB 校验：不能压棋盘 / 铜铃 / 其它陈设，不能探出桌沿，
   * 也不能高过取景。放不下就按档缩小、往右后角让位；实在放不下宁可不摆并
   * 告警，也绝不留下半截穿模的物件。GLB 解析结果全进程缓存，切棋境不重解。
   *
   * **可见区实测**（1280×800 默认正俯视）：画面约 x±17 / z±10.6，且 z 方向
   * 的像素密度比 x 高约 1.27 倍。道具中心要放 z≈-6 才连边缘一起留在画面内；
   * z<-8 时上缘会被裁掉——「没穿模」不等于「看得见」，摆位得同时满足两者。
   */
  protected placeTableProp(options: PropOptions): void {
    this.propQueue = this.propQueue
      .then(() => this.applyTableProp(options))
      .catch((error) => console.warn(`[environment] 陈设 ${options.id} 摆放失败`, error));
  }

  private async applyTableProp(options: PropOptions): Promise<void> {
    const prototype = await propPrototype(options.id);
    // 切棋境是常态：模型晚回来时这个环境可能已经销毁，直接丢弃。
    if (!prototype || this.disposed) return;

    const half = options.tableHalf ?? [TABLE_SIZE / 2, TABLE_SIZE / 2];
    const groundY = (options.groundY ?? TABLE_SURFACE_Y) + (options.lift ?? 0);
    const maxHeight = options.maxHeight ?? 4.2;
    const rotationY = options.rotationY ?? 0;

    // 纯色替身材质只建一次，多档缩放共用；由 disposables 随环境一起释放。
    const plain = options.flatColor
      ? new THREE.MeshStandardMaterial({
          color: options.flatColor,
          roughness: 0.92,
          side: THREE.DoubleSide,
        })
      : null;
    if (plain) this.disposables.push(plain);

    // 先按指定点摆；放不下再往右后角让一点，仍留在默认取景内。
    const spots: Array<[number, number]> = [
      [options.x, options.z],
      [options.x + 1.3, options.z - 0.5],
      [options.x + 0.4, options.z - 2.0],
    ];

    for (const [x, z] of spots) {
      for (const factor of [1, 0.86, 0.72, 0.6, 0.48]) {
        const candidate = prototype.clone(true);
        // 先摆正姿态再交给 fitModel：它会用旋转后的包围盒反推缩放与落地高度。
        candidate.rotation.x = options.rotationX ?? 0;
        if (plain) {
          candidate.traverse((node) => {
            if (node instanceof THREE.Mesh) node.material = plain;
          });
        }
        fitModel(candidate, {
          footprint: options.footprint * factor,
          ...(options.height ? { height: options.height * factor } : {}),
          rotationY,
          groundY,
        });
        candidate.position.x += x;
        candidate.position.z += z;
        candidate.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(candidate);
        if (box.max.y - groundY > maxHeight) continue;
        if (!this.propFits(box, half, groundY)) continue;

        this.root.add(candidate);
        // 留 0.3 的呼吸缝，避免两件陈设贴在一起视觉上像穿模。
        this.placedProps.push(box.clone().expandByScalar(0.3));
        // 只读调试读数：正常访问不挂载，供回归脚本用数值断言「不穿模」。
        if (new URLSearchParams(location.search).has('debugprops')) {
          const host = window as unknown as Record<string, unknown>;
          const list = (host.__propBoxes ??= []) as Array<Record<string, unknown>>;
          list.push({
            id: options.id,
            env: this.id,
            factor,
            min: box.min.toArray(),
            max: box.max.toArray(),
          });
        }
        return;
      }
    }
    console.warn(
      `[environment] 陈设 ${options.id} 在 (${options.x}, ${options.z}) 放不下，已跳过以避免穿模`,
    );
  }

  /** AABB 互斥：桌沿、棋盘、铜铃、已摆下的其它陈设。 */
  private propFits(box: THREE.Box3, half: [number, number], groundY: number): boolean {
    const [halfX, halfZ] = half;
    if (box.min.y < groundY - 0.25) return false;
    if (box.min.x < -halfX + 0.5 || box.max.x > halfX - 0.5) return false;
    if (box.min.z < -halfZ + 0.5 || box.max.z > halfZ - 0.5) return false;
    if (box.intersectsBox(Environment.BOARD_KEEPOUT)) return false;
    if (box.intersectsBox(Environment.BELL_KEEPOUT)) return false;
    return !this.placedProps.some((placed) => box.intersectsBox(placed));
  }
}
