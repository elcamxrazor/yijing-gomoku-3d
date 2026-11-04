import * as THREE from 'three';
import { loadModel, prepareModel } from '../assets';
import { BOARD_WIDTH } from '../config';
import type { IntroDescriptor } from './Environment';
import { Environment, TABLE_TOP_Y } from './Environment';

/**
 * 现代客厅：第四棋境，整间导入的写实户型。
 *
 * 模型来自用户提供的「CG美术之家」家庭室内套件（**商用授权需用户自行确认**，
 * 它不在 CC0 清单里），由 `tools/import_cg_gltf.py` 裁剪合成：
 * 186 万面裁到 27.7 万面（丢掉窗帘/毛巾/卧室/厨卫与小物件面数黑洞），
 * 贴图压到 1K 内嵌，Z-up 已在 GLB 节点上转成 Y-up。
 *
 * ## 对位：棋盘必须落在茶几上
 *
 * 这套模型没有家具级层级（1 个 mesh / 232 个 primitive），茶几是材质名为
 * `…Coffee_Table` 的图元。加载后按材质名找到它，量出真实包围盒，然后：
 *
 * - **比例**：棋盘 14.6 单位对应真实五子棋盘 45cm → 1 米 ≈ 32.4 单位；
 * - **平移**：茶几顶面中心对齐到世界原点上方 `TABLE_TOP_Y`——和其它环境
 *   「桌面顶在 TABLE_TOP_Y 这条线上」是同一条约定，棋盘、铜铃才不用挪；
 * - 找不到茶几（模型没到位 / 裁剪规则改了名字）就退回一组实测常量，
 *   保证房间永远能成形。
 *
 * 房间整体 27.7 万面但完全静止：`castShadow` 全关（投影只留给棋盘聚光灯下的
 * 棋子），`receiveShadow` 全开，阴影图只在画面运动时重绘（见 SceneManager 限帧）。
 */

/** 棋盘真实宽度：标准五子棋盘约 45cm。 */
const REAL_BOARD_METERS = 0.45;
/** 1 米 = 多少世界单位，由棋盘尺寸反推，保证棋子与家具的比例是真实的。 */
const UNITS_PER_METER = BOARD_WIDTH / REAL_BOARD_METERS;

/** 茶几顶面高度（米，Z-up 原始坐标实测）。 */
const COFFEE_TABLE_TOP_Z = 0.44;
/** 茶几顶面中心（米，Z-up 原始坐标实测）。 */
const COFFEE_TABLE_CENTER = { x: 1.055, y: 2.58 };

export class LivingRoomEnvironment extends Environment {
  override readonly background: THREE.ColorRepresentation = '#c9ccd1';
  /** 默认室内 HDRI（Lebombo 公寓）：同是封闭室内，天光气质一致，不用换。 */
  override readonly environmentIntensity = 0.85;
  override readonly exposure = 1.15;
  /** 房间自发光（灯带/灯罩）给一丝柔光溢出。 */
  override readonly bloom = 0.1;
  override readonly bloomThreshold = 1.05;
  /**
   * 相机最远距离：客厅开间约 13m（420 单位），56 的茶室上限会把玩家锁死在
   * 棋盘正上方，沙发电视根本看不到。110（≈3.4m）能退到沙发上空回望棋盘，
   * 又不至于穿进对面墙体。
   */
  override readonly maxDistance = 110;
  /**
   * 推镜从沙发上空起步，沿着「沙发 → 茶几」的动线推进。
   *
   * 沙发主体实测在 z≈178~209（棋盘 +z 方向约 6 米），原先机位 [24,66,232]
   * 俯角只有 17°，沙发被压在画面下缘之外，整段开场只看到白墙、挂画与茶几，
   * 白费了 17.9MB 的户型。这里把机位抬高、拉远并把注视点挪到沙发与茶几
   * 之间（z≈96），俯角约 26°，沙发、单椅、茶几同框，推近时再依次退出画面。
   * 默认对局机位仍是正俯拍，一个单位都没动。
   */
  override readonly intro: IntroDescriptor = {
    position: [12, 88, 258],
    target: [0, 10, 96],
    fov: 68,
    duration: 5600,
  };

  constructor(scene: THREE.Scene) {
    super(scene, 'living');

    this.createLights();
    this.buildFallbackShell();
    // 客厅用的是 GLB 里那张 x±25.8 / z±11.4 的长茶几，台面 y=-0.31，
    // 和通用 30×30 桌子不同；显式传边界，书刊才不会探出桌沿或压到棋盘。
    this.placeTableProp({
      id: 'book_set',
      x: 11.2,
      z: -6.0,
      footprint: 5.8,
      rotationY: 0.25,
      groundY: -0.31,
      tableHalf: [25.79, 11.44],
    });
    void this.buildRoom();
  }

  // ------------------------------------------------------------------
  // 光照
  // ------------------------------------------------------------------

  private createLights(): void {
    // 真实户型没有全局光照（GI），暗部全靠人工光托：
    // 半球光打底 + 日光定向光 + 三盏天花暖点光 + 棋盘聚光。
    const hemisphere = new THREE.HemisphereLight('#ffffff', '#8f8574', 0.55);
    hemisphere.position.set(0, 60, 0);
    this.root.add(hemisphere);

    // 主光：棋盘正上方的吊灯（模型里有 MainLamp 图元，这里给它补一盏真光源）。
    // 棋子的接触阴影全靠它，它是这个环境里唯一开投影的光。
    // 落地灯降为无影补光（近距投影会让棋子影子近小远大）。
    const lamp = new THREE.SpotLight('#fff1d8', 0.5);
    lamp.position.set(6, 30, 5);
    lamp.target.position.set(0, 0, 0);
    lamp.angle = 1.0;
    lamp.penumbra = 0.5;
    lamp.decay = 0;
    lamp.distance = 0;
    lamp.castShadow = false;
    lamp.shadow.mapSize.set(2048, 2048);
    lamp.shadow.camera.near = 4;
    lamp.shadow.camera.far = 70;
    lamp.shadow.bias = -0.0004;
    lamp.shadow.normalBias = 0.012;
    lamp.shadow.radius = 3;
    this.root.add(lamp, lamp.target);

    // 白天的落地窗光：主投影光（远置平行光，影子大小处处一致）。
    const daylight = new THREE.DirectionalLight('#eef4ff', 2.2);
    // 仰角压到 ~20°：棋子厚径比 0.34，影子伸出轮廓的可见宽度只有
    // 顶高 × cot(仰角) − 半径——25° 时仅 ~0.16 单位（偏细的月牙），
    // 20° 时 ~0.33 单位（直径的 43%），才像日光斜入的完整影子。
    // 客厅有三盏无影天花灯做底光，日光必须够强，影子才不被漂白。
    daylight.position.set(-55, 65, 170);
    daylight.target.position.set(0, 0, 0);
    daylight.castShadow = true;
    daylight.shadow.mapSize.set(2048, 2048);
    daylight.shadow.camera.left = -30;
    daylight.shadow.camera.right = 30;
    daylight.shadow.camera.top = 30;
    daylight.shadow.camera.bottom = -30;
    daylight.shadow.camera.near = 10;
    daylight.shadow.camera.far = 320;
    daylight.shadow.bias = -0.0006;
    // normalBias 归零：见 TeaRoom 同款说明（防 peter-panning 漏光亮缝）。
    daylight.shadow.normalBias = 0.0;
    daylight.shadow.radius = 4;
    this.root.add(daylight, daylight.target);

    // 客厅自己的天花灯：模型里的灯具只有壳没有光，补三盏暖点光把房间点亮。
    // 位置照着保留区（客厅动线：沙发—茶几—电视墙）大致铺开。
    for (const [x, z, intensity] of [
      [0, 60, 0.55],
      [-90, 20, 0.45],
      [60, 130, 0.45],
    ] as Array<[number, number, number]>) {
      const ceiling = new THREE.PointLight('#ffe8c4', intensity, 0, 0);
      ceiling.position.set(x, 55, z);
      this.root.add(ceiling);
    }
  }

  /**
   * 兜底壳：模型没到位时至少有一块地板和一圈矮墙，棋盘不悬在虚空里。
   * 模型加载成功后整组隐藏。
   */
  private buildFallbackShell(): void {
    const floorY = TABLE_TOP_Y - COFFEE_TABLE_TOP_Z * UNITS_PER_METER;
    const shell = new THREE.Group();
    const shellMaterial = this.material('#b9b2a4', { roughness: 0.9 });
    const floor = new THREE.Mesh(new THREE.BoxGeometry(500, 1, 500), shellMaterial);
    floor.position.y = floorY - 0.5;
    floor.receiveShadow = true;
    this.track(floor.geometry);
    shell.add(floor);
    this.root.add(shell);
    this.fallbackShell = shell;
  }

  private fallbackShell: THREE.Group | null = null;

  // ------------------------------------------------------------------
  // 真房间
  // ------------------------------------------------------------------

  private async buildRoom(): Promise<void> {
    const model = await loadModel('living_room');
    if (!model) return; // 兜底壳已经在场，房间不至于空掉

    prepareModel(model, 8);
    // 几何与材质归环境所有，销毁时统一释放（SceneManager.dispose 也会兜一遍）。
    model.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      // 房间完全静止：投影只留给棋盘聚光灯下的棋子，27.7 万面进阴影图不值得。
      node.castShadow = false;
      node.receiveShadow = true;
      this.disposables.push(node.geometry);
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      this.disposables.push(...materials);
    });

    // ---- 比例 ---------------------------------------------------------
    model.scale.setScalar(UNITS_PER_METER);
    model.updateMatrixWorld(true);

    // ---- 对位 ---------------------------------------------------------
    const tableBox = this.measureCoffeeTable(model);
    const target = new THREE.Vector3(0, TABLE_TOP_Y, 0);
    if (tableBox) {
      const center = tableBox.getCenter(new THREE.Vector3());
      // 顶面中心 → 世界原点上方；y 用「顶面」而不是包围盒中心。
      model.position.x += target.x - center.x;
      model.position.z += target.z - center.z;
      model.position.y += target.y - tableBox.max.y;
    } else {
      // 实测常量兜底：旋转 (x,y,z)→(x,z,-y) 后茶几中心在 (1.06, ·, -2.58)。
      model.position.x -= COFFEE_TABLE_CENTER.x * UNITS_PER_METER;
      model.position.z += COFFEE_TABLE_CENTER.y * UNITS_PER_METER;
      model.position.y += TABLE_TOP_Y - COFFEE_TABLE_TOP_Z * UNITS_PER_METER;
    }

    this.root.add(model);
    if (this.fallbackShell) this.fallbackShell.visible = false;
  }

  /**
   * 按材质名找茶几图元并量出**世界坐标**包围盒。
   *
   * 注意必须在 `scale` 与 `updateMatrixWorld` 之后调用，量到的才是最终尺寸。
   * 找不到（导入脚本改名 / 模型没这间房）返回 null，由调用方走常量兜底。
   */
  private measureCoffeeTable(model: THREE.Object3D): THREE.Box3 | null {
    let box: THREE.Box3 | null = null;
    model.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      const hit = materials.some((material) => /coffee_table/i.test(material.name));
      if (!hit) return;
      const candidate = new THREE.Box3().setFromObject(node);
      box = box ? box.union(candidate) : candidate;
    });
    return box;
  }
}
