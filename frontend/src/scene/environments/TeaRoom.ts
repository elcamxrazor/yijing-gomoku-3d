import * as THREE from 'three';
import { PALETTE } from '../config';
import { loadModel, loadPbrTextureSet, prepareModel, fitModel } from '../assets';
import type { IntroDescriptor } from './Environment';
import { Environment, TABLE_LEG_HEIGHT, TABLE_THICKNESS, TABLE_TOP_Y } from './Environment';
import { makeScrollTexture, makeShojiTexture } from './textures';

/**
 * 基础茶室：默认棋境。
 *
 * 之前的「客厅」被整个换掉了——沙发、电视、城市天际线搬走，换成茶室的语言：
 * 榻榻米、障子窗、床の間、木梁、行灯、蒲团。「穷酸感」的根子不是缺素材，
 * 而是房间没有文化立场的家具堆砌；一套自洽的茶室语汇，全程序化也能立住。
 *
 * 尺度沿用旧客厅（150 × 120 × 92），相机约束与推镜参数不用动。
 */

const ROOM_HALF_WIDTH = 75;
const ROOM_HALF_DEPTH = 60;
const ROOM_HEIGHT = 92;
const FLOOR_Y = TABLE_TOP_Y - TABLE_THICKNESS - TABLE_LEG_HEIGHT;

const CLAY_WALL = '#e5d9c0';
const DARK_WOOD = '#4a3527';
const MID_WOOD = '#6b4e35';

export class TeaRoomEnvironment extends Environment {
  override readonly background: THREE.ColorRepresentation = PALETTE.background;
  /** 古民家室内 HDRI：暖色木屋的天光，PBR 材质反射层次的主要来源。 */
  override readonly hdri = '/hdri/studio_kominka_01_1k.hdr';
  override readonly environmentIntensity = 0.3;
  /** 障子纸与行灯的自发光给一点点柔光溢出，像胶片里的高光。 */
  override readonly bloom = 0.14;
  override readonly bloomThreshold = 1.05;
  override readonly intro: IntroDescriptor = {
    position: [58, 44, 48],
    target: [-4, 4, -6],
  };

  private readonly tableTopMaterial: THREE.MeshStandardMaterial;
  private readonly lanternLight: THREE.PointLight;
  /** 所有要披杉木皮的木构件材质（梁、柱、墙裙、床の間、行灯框）。 */
  private readonly woodMaterials: THREE.MeshStandardMaterial[] = [];

  constructor(scene: THREE.Scene) {
    super(scene, 'tea');

    this.createLights();
    this.buildTatamiFloor();
    this.buildCeiling();
    this.buildWalls();
    this.buildShojiWindowWall();
    this.buildTokonoma();
    // 建桌即拿到顶面材质，后面的异步贴图会热替换到它身上。
    this.tableTopMaterial = this.buildChabudai();
    void this.applyTableTexture();
    this.zabuton(-21, 4, FLOOR_Y, '#3f4a63', 0.05);
    this.zabuton(21, 4, FLOOR_Y, '#7a4a38', -0.08);
    this.buildAndon();
    this.buildTeaSet();
    // 木构件都建完了，统一披杉木皮（异步热替换，不阻塞构造）。
    void this.applyWoodTexture();
    void this.applyPlant();

    this.lanternLight = new THREE.PointLight('#ffcf94', 0.55, 0, 0);
    this.lanternLight.position.set(-56, FLOOR_Y + 16, 40);
    this.root.add(this.lanternLight);
  }

  // ------------------------------------------------------------------
  // 光照
  // ------------------------------------------------------------------

  private createLights(): void {
    // 障子纸本身在发光（材质带自发光），半球光只需把暗部托起来。
    const hemisphere = new THREE.HemisphereLight('#fff8ea', '#b9a986', 0.3);
    hemisphere.position.set(0, FLOOR_Y + ROOM_HEIGHT, 0);
    this.root.add(hemisphere);

    // 主投影光：远置平行光（上午日光从障子窗斜入）。平行光的影子
    // 大小方向处处一致——近距射灯会「近灯影小、远灯影大」（实测教训）。
    const sun = new THREE.DirectionalLight('#fff2dd', 2.4);
    // 仰角压到 ~20°、方位斜向左前。棋子厚径比只有 0.34（厚 0.26 / 径 0.76），
    // 影子伸出轮廓的可见宽度 = 顶高 × cot(仰角) − 半径：28° 时仅 ~0.10 单位
    // （满屏约 5px，还是一弯「月牙」），20° 时 ~0.33 单位（直径的 43%），
    // 才读得出「斜移出去的完整影子」。再高（36°）短影大半被棋子自身挡住，
    // 再低（<17°）整间屋的影子都会拖成长夕照。方位斜向左前且不穿棋盘：
    // 桌上茶具的影子落向深色桌面，对比低、不会在盘上形成「莫名阴影」。
    sun.position.set(-72, 39, -110);
    sun.target.position.set(0, FLOOR_Y, 14);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    // ±30：罩住棋盘与近景家具（±20 曾把家具影子硬切出诡异边界）。
    sun.shadow.camera.left = -30;
    sun.shadow.camera.right = 30;
    sun.shadow.camera.top = 30;
    sun.shadow.camera.bottom = -30;
    sun.shadow.camera.near = 20;
    sun.shadow.camera.far = 240;
    sun.shadow.bias = -0.0006;
    // normalBias 归零：棋盘是平面，本不需要它防自阴影；偏大反而把影子从棋子
    // 接触面推开，留出一圈漏光亮缝（peter-panning）——用户看到的「月牙+内部高亮」正是它。
    sun.shadow.normalBias = 0.0;
    sun.shadow.radius = 4;
    this.root.add(sun, sun.target);




    // 棋盘上方的暖射灯：降为无影补光（近距投影会造成影子近小远大）。
    // 强度压到 0.55：它近乎正头顶照棋盘，是无影的「影子漂白剂」——
    // 开太大时太阳的斜射影在盘上几乎读不出来（实测教训）。
    const spotlight = new THREE.SpotLight(PALETTE.lightWarm, 0.55);
    // 稍微偏移（不再正对棋盘中心）：影子斜向一侧，更像真实吊灯。
    spotlight.position.set(5.2, 9, 5.6);
    spotlight.target.position.set(0, 0, 0);
    spotlight.angle = 1.0;
    spotlight.penumbra = 0.45;
    spotlight.decay = 0;
    spotlight.distance = 0;
    spotlight.castShadow = false;
    spotlight.shadow.mapSize.set(2048, 2048);
    spotlight.shadow.camera.near = 1;
    spotlight.shadow.camera.far = 45;
    spotlight.shadow.bias = -0.0004;
    spotlight.shadow.normalBias = 0.012;
    spotlight.shadow.radius = 4;
    this.root.add(spotlight, spotlight.target);
  }

  /**
   * 木构件材质：创建后登记进 woodMaterials，等杉木 PBR 到位统一热替换。
   * 颜色保留作乘色——杉木贴图是浅色原材，深梁柱靠乘色压暗，木纹依旧清晰。
   */
  private woodMaterial(color: string, roughness = 0.6): THREE.MeshStandardMaterial {
    const material = this.material(color, { roughness });
    this.woodMaterials.push(material);
    return material;
  }

  /** 日本杉木（japanese_cedar_planks）：梁、柱、墙裙的木纹来源。 */
  private async applyWoodTexture(): Promise<void> {
    const set = await loadPbrTextureSet('cedar', { x: 3, y: 3 }, { ao: true, anisotropy: 8 }).catch(() => null);
    if (!set) return;
    for (const material of this.woodMaterials) {
      material.map = set.map;
      material.normalMap = set.normalMap;
      material.roughnessMap = set.roughnessMap;
      material.aoMap = set.aoMap;
      material.normalScale.set(0.6, 0.6);
      material.needsUpdate = true;
    }
    for (const texture of [set.map, set.normalMap, set.roughnessMap, set.aoMap]) {
      if (texture) this.disposables.push(texture);
    }
  }

  // ------------------------------------------------------------------
  // 建筑
  // ------------------------------------------------------------------

  private buildTatamiFloor(): void {
    // 先用纯色兜底，真实榻榻米 PBR 到位后热替换（见 applyTatamiTexture）。
    const geometry = new THREE.PlaneGeometry(ROOM_HALF_WIDTH * 2, ROOM_HALF_DEPTH * 2);
    const material = new THREE.MeshStandardMaterial({
      color: '#b3a06b',
      roughness: 0.92,
      metalness: 0,
    });
    this.disposables.push(geometry, material);
    const floor = new THREE.Mesh(geometry, material);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = FLOOR_Y;
    floor.receiveShadow = true;
    this.root.add(floor);
    this.tatamiMaterial = material;
    void this.applyTatamiTexture();
  }

  private tatamiMaterial: THREE.MeshStandardMaterial | null = null;

  /**
   * 真实榻榻米贴图（Poly Haven tatami_mat）：一张标准席 90×180cm ≈ 29×58 单位。
   * 重复次数按房间尺寸反推，边缘的半张被墙体压住——真实和室也是这么裁边的。
   * 程序画不出来的灯芯草编织光泽与色差，全在这几张图里。
   */
  private async applyTatamiTexture(): Promise<void> {
    const set = await loadPbrTextureSet(
      'tatami',
      { x: (ROOM_HALF_WIDTH * 2) / 29, y: (ROOM_HALF_DEPTH * 2) / 58 },
      { ao: true, anisotropy: 16 },
    ).catch(() => null);
    if (!set || !this.tatamiMaterial) return;
    this.tatamiMaterial.map = set.map;
    this.tatamiMaterial.normalMap = set.normalMap;
    this.tatamiMaterial.roughnessMap = set.roughnessMap;
    this.tatamiMaterial.aoMap = set.aoMap;
    this.tatamiMaterial.color.set('#ffffff');
    this.tatamiMaterial.normalScale.set(0.7, 0.7);
    this.tatamiMaterial.needsUpdate = true;
    for (const texture of [set.map, set.normalMap, set.roughnessMap, set.aoMap]) {
      if (texture) this.disposables.push(texture);
    }
  }

  private buildCeiling(): void {
    const geometry = new THREE.PlaneGeometry(ROOM_HALF_WIDTH * 2, ROOM_HALF_DEPTH * 2);
    const material = new THREE.MeshStandardMaterial({ color: '#efe7d4', roughness: 0.96 });
    this.disposables.push(geometry, material);
    const ceiling = new THREE.Mesh(geometry, material);
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.y = FLOOR_Y + ROOM_HEIGHT;
    ceiling.receiveShadow = true;
    this.root.add(ceiling);

    // 露明木梁：横向五根 + 纵向两根。抬头不再是一块平板，
    // 这是「和室」和「石膏盒子」之间最大的差别。
    const beam = this.woodMaterial(DARK_WOOD, 0.6);
    for (let index = -2; index <= 2; index += 1) {
      this.box(
        [ROOM_HALF_WIDTH * 2 + 4, 6.5, 5],
        [0, FLOOR_Y + ROOM_HEIGHT - 3.4, index * 24],
        beam,
        this.root,
        { cast: false },
      );
    }
    for (const side of [-1, 1] as const) {
      this.box(
        [5, 6.5, ROOM_HALF_DEPTH * 2],
        [side * (ROOM_HALF_WIDTH - 12), FLOOR_Y + ROOM_HEIGHT - 3.4, 0],
        beam,
        this.root,
        { cast: false },
      );
    }
  }

  private buildWalls(): void {
    const clay = this.material(CLAY_WALL, { roughness: 0.95 });
    const wood = this.woodMaterial(DARK_WOOD, 0.66);

    for (const side of [-1, 1] as const) {
      this.box([2, ROOM_HEIGHT, ROOM_HALF_DEPTH * 2], [side * ROOM_HALF_WIDTH, FLOOR_Y + ROOM_HEIGHT / 2, 0], clay, this.root, { cast: false });
    }
    this.box([ROOM_HALF_WIDTH * 2, ROOM_HEIGHT, 2], [0, FLOOR_Y + ROOM_HEIGHT / 2, ROOM_HALF_DEPTH], clay, this.root, { cast: false });

    // 下段木墙板：三面墙脚一段深色木裙墙，和室的标准做法。
    for (const side of [-1, 1] as const) {
      this.box([1.2, 15, ROOM_HALF_DEPTH * 2], [side * (ROOM_HALF_WIDTH - 0.8), FLOOR_Y + 7.5, 0], wood, this.root, { cast: false });
    }
    this.box([ROOM_HALF_WIDTH * 2, 15, 1.2], [0, FLOOR_Y + 7.5, ROOM_HALF_DEPTH - 0.8], wood, this.root, { cast: false });

    // 四角与墙中的木柱：房间立刻有了「结构」。
    const post = this.woodMaterial(MID_WOOD, 0.6);
    const postX = [-ROOM_HALF_WIDTH + 2.4, -22, 22, ROOM_HALF_WIDTH - 2.4];
    for (const x of postX) {
      this.box([3.6, ROOM_HEIGHT, 3.6], [x, FLOOR_Y + ROOM_HEIGHT / 2, ROOM_HALF_DEPTH - 2.6], post, this.root, { cast: false });
    }
    for (const z of [-ROOM_HALF_DEPTH + 2.6, ROOM_HALF_DEPTH - 2.6]) {
      for (const x of [-ROOM_HALF_WIDTH + 2.4, ROOM_HALF_WIDTH - 2.4]) {
        this.box([3.6, ROOM_HEIGHT, 3.6], [x, FLOOR_Y + ROOM_HEIGHT / 2, z], post, this.root, { cast: false });
      }
    }
  }

  /**
   * 障子窗墙：茶室的主光源。
   *
   * 三扇障子 + 上方的横窗。纸面带自发光——上午的阳光把纸照亮，
   * 室内的一切明暗关系都从这面墙出发。
   */
  private buildShojiWindowWall(): void {
    const wallZ = -ROOM_HALF_DEPTH;
    const structure = this.material(CLAY_WALL, { roughness: 0.95 });
    const frame = this.woodMaterial(DARK_WOOD, 0.55);

    this.box([10, ROOM_HEIGHT, 2], [-ROOM_HALF_WIDTH + 5, FLOOR_Y + ROOM_HEIGHT / 2, wallZ], structure, this.root, { cast: false });
    this.box([10, ROOM_HEIGHT, 2], [ROOM_HALF_WIDTH - 5, FLOOR_Y + ROOM_HEIGHT / 2, wallZ], structure, this.root, { cast: false });
    this.box([ROOM_HALF_WIDTH * 2, 10, 2], [0, FLOOR_Y + ROOM_HEIGHT - 5, wallZ], structure, this.root, { cast: false });
    this.box([ROOM_HALF_WIDTH * 2, 4, 2], [0, FLOOR_Y + 2, wallZ], structure, this.root, { cast: false });

    const paperTexture = makeShojiTexture();
    paperTexture.repeat.set(2, 2);
    const paper = new THREE.MeshStandardMaterial({
      map: paperTexture,
      emissive: new THREE.Color('#ffedc9'),
      emissiveMap: paperTexture,
      emissiveIntensity: 0.62,
      roughness: 0.9,
    });
    this.disposables.push(paper, paperTexture);

    const span = ROOM_HALF_WIDTH * 2 - 24;
    const panelWidth = span / 3;
    const glassBottom = FLOOR_Y + 6;
    const glassTop = FLOOR_Y + ROOM_HEIGHT - 12;

    for (let panel = 0; panel < 3; panel += 1) {
      const x = -span / 2 + panelWidth * (panel + 0.5);
      // 纸面
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(panelWidth - 2.6, glassTop - glassBottom), paper);
      this.disposables.push(plane.geometry);
      plane.position.set(x, (glassBottom + glassTop) / 2, wallZ + 1.4);
      this.root.add(plane);
      // 框
      this.box([panelWidth, 3, 3], [x, glassBottom - 1.2, wallZ + 0.4], frame, this.root, { cast: false });
      this.box([panelWidth, 3, 3], [x, glassTop + 1.2, wallZ + 0.4], frame, this.root, { cast: false });
      this.box([3, glassTop - glassBottom, 3], [x - panelWidth / 2 + 1.2, (glassBottom + glassTop) / 2, wallZ + 0.4], frame, this.root, { cast: false });
      this.box([3, glassTop - glassBottom, 3], [x + panelWidth / 2 - 1.2, (glassBottom + glassTop) / 2, wallZ + 0.4], frame, this.root, { cast: false });
      // 格子棂：竖五横三。
      for (let bar = 1; bar <= 4; bar += 1) {
        const bx = x - panelWidth / 2 + (panelWidth / 5) * bar;
        this.box([1.1, glassTop - glassBottom, 1.6], [bx, (glassBottom + glassTop) / 2, wallZ + 1.0], frame, this.root, { cast: false });
      }
      for (let bar = 1; bar <= 2; bar += 1) {
        const by = glassBottom + ((glassTop - glassBottom) / 3) * bar;
        this.box([panelWidth - 2.6, 1.1, 1.6], [x, by, wallZ + 1.0], frame, this.root, { cast: false });
      }
    }
  }

  /**
   * 床の間：和室的身份牌。
   *
   * 一段抬高的小平台 + 挂轴 + 侧上方的错层搁板（違い棚）+ 一枝插花。
   * 位置在 +z 前墙——推镜从房间后角进来时正好从画面深处看到它。
   */
  private buildTokonoma(): void {
    const wallZ = ROOM_HALF_DEPTH - 2;
    const alcoveX = 26;

    const platform = this.woodMaterial(MID_WOOD, 0.5);
    this.box([34, 2.4, 12], [alcoveX, FLOOR_Y + 1.2, wallZ - 6], platform, this.root);

    // 挂轴
    const scrollTexture = makeScrollTexture();
    const scrollMaterial = new THREE.MeshStandardMaterial({
      map: scrollTexture,
      roughness: 0.94,
      emissive: new THREE.Color('#8a7f68'),
      emissiveMap: scrollTexture,
      emissiveIntensity: 0.14,
    });
    this.disposables.push(scrollMaterial, scrollTexture);
    const scroll = new THREE.Mesh(new THREE.PlaneGeometry(13, 40), scrollMaterial);
    this.disposables.push(scroll.geometry);
    scroll.position.set(alcoveX - 4, FLOOR_Y + 34, wallZ - 1.2);
    this.root.add(scroll);
    // 轴的上下木杆
    const rod = this.woodMaterial(DARK_WOOD, 0.5);
    this.box([15, 1.6, 1.6], [alcoveX - 4, FLOOR_Y + 54.5, wallZ - 1.0], rod, this.root, { cast: false });
    this.box([15, 1.6, 1.6], [alcoveX - 4, FLOOR_Y + 14, wallZ - 1.0], rod, this.root, { cast: false });

    // 違い棚：两块错层小板，放一只茶碗一只花瓶。
    const shelf = this.woodMaterial(MID_WOOD, 0.55);
    this.box([14, 1.2, 8], [alcoveX + 12, FLOOR_Y + 30, wallZ - 4.5], shelf, this.root);
    this.box([14, 1.2, 8], [alcoveX + 4, FLOOR_Y + 18, wallZ - 5.5], shelf, this.root);

    const ceramic = this.material('#2f2b28', { roughness: 0.35 });
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.5, 1.6, 20), ceramic);
    this.disposables.push(bowl.geometry);
    bowl.position.set(alcoveX + 13, FLOOR_Y + 31.6, wallZ - 4.5);
    bowl.castShadow = true;
    this.root.add(bowl);

    const glaze = this.material('#77604c', { roughness: 0.4 });
    const vase = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.6, 5.5, 18), glaze);
    this.disposables.push(vase.geometry);
    vase.position.set(alcoveX + 5, FLOOR_Y + 21.2, wallZ - 5.5);
    vase.castShadow = true;
    this.root.add(vase);
    // 一枝枯枝从瓶里斜出来
    const branch = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.32, 13, 8), this.material('#3d3125', { roughness: 0.9 }));
    this.disposables.push(branch.geometry);
    branch.position.set(alcoveX + 8, FLOOR_Y + 27, wallZ - 5.5);
    branch.rotation.z = -0.55;
    branch.castShadow = true;
    this.root.add(branch);
  }

  // ------------------------------------------------------------------
  // 家具
  // ------------------------------------------------------------------

  /** 卓袱台：低矮的黑胡桃茶桌，棋盘摆在它上面。 */
  private buildChabudai(): THREE.MeshStandardMaterial {
    // 顶面高度与 SIZE 都由基类统一保证（见 Environment.buildTable），
    // 这里只说「这是一张深胡桃色的矮圆腿茶桌」。
    return this.buildTable({
      top: '#4f382a',
      leg: '#3b2a1d',
      roughness: 0.5,
      legStyle: 'splayed',
      legHeight: TABLE_LEG_HEIGHT,
    });
  }

  private async applyTableTexture(): Promise<void> {
    // 红木贴面（rosewood_veneer1）：深红棕的手刮木纹，茶桌要压得住浅色棋盘。
    //
    // 重复次数调到 1.6：原来给 3.2，30 单位的桌子上一张贴图只摊 9 个单位，
    // 木纹的「山形」被复制得整整齐齐，远看像一层墙纸花纹而不是木头。
    // 真实木皮桌面本来就是一两片拼出来的，大花纹才对。
    const set = await loadPbrTextureSet('rosewood', 1.6, { ao: true, anisotropy: 16 }).catch(() => null);
    if (!set) return;
    this.tableTopMaterial.map = set.map;
    this.tableTopMaterial.normalMap = set.normalMap;
    this.tableTopMaterial.roughnessMap = set.roughnessMap;
    this.tableTopMaterial.aoMap = set.aoMap;
    this.tableTopMaterial.aoMapIntensity = 1;
    this.tableTopMaterial.color.set('#8a7466');
    this.tableTopMaterial.roughness = 1;
    this.tableTopMaterial.normalScale.set(0.6, 0.6);
    this.tableTopMaterial.needsUpdate = true;
    for (const texture of [set.map, set.normalMap, set.roughnessMap, set.aoMap]) {
      if (texture) this.disposables.push(texture);
    }
  }

  /** 行灯：纸罩落地灯，角落里一豆暖光。 */
  private buildAndon(): void {
    const frame = this.woodMaterial(DARK_WOOD, 0.6);
    const x = -56;
    const z = 40;
    const baseY = FLOOR_Y;

    this.box([10, 1.2, 10], [x, baseY + 0.6, z], frame, this.root);
    this.box([10, 1.2, 10], [x, baseY + 22, z], frame, this.root);
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as Array<[number, number]>) {
      this.box([1, 21, 1], [x + sx * 4.2, baseY + 11, z + sz * 4.2], frame, this.root);
    }

    const paper = new THREE.MeshStandardMaterial({
      color: '#ffe6bb',
      emissive: new THREE.Color('#ffca7a'),
      emissiveIntensity: 1.1,
      roughness: 0.9,
    });
    this.disposables.push(paper);
    const shade = new THREE.Mesh(new THREE.BoxGeometry(7.6, 18, 7.6), paper);
    this.disposables.push(shade.geometry);
    shade.position.set(x, baseY + 11.4, z);
    this.root.add(shade);
  }

  /**
   * 一套真实茶具（Poly Haven tea_set_01：急须、茶杯、托盘全带的扫描模型）。
   * 空桌是「还没开始」，有茶才是「在对弈」——程序化捏的壶毕竟是几何体堆砌，
   * 扫描件的陶土釉色与手工形变是茶具该有的样子。
   */
  private buildTeaSet(): void {
    void this.applyTeaSetModel();
  }

  private async applyTeaSetModel(): Promise<void> {
    const model = await loadModel('tea_set_01');
    if (!model) return;
    prepareModel(model, 8);
    // 整套器物按 ~9 单位的最大水平边缩到桌面一角，底面贴桌面。
    fitModel(model, { footprint: 9, rotationY: -0.5, groundY: this.tableSurfaceY });
    // 桌子从 36 收到 30（半宽 15）之后，茶具原先的 (13, -12.5) 会让边缘探出桌沿，
    // 顺手往内挪一档，仍然摆在棋盘右后方的空位上。
    model.position.x += 10.5;
    model.position.z += -10;
    this.root.add(model);
  }

  private async applyPlant(): Promise<void> {
    const model = await loadModel('potted_plant_02');
    if (!model) return;
    prepareModel(model, 8);
    const box = new THREE.Box3().setFromObject(model);
    const height = Math.max(0.001, box.max.y - box.min.y);
    const scale = 26 / height;
    model.scale.setScalar(scale);
    model.position.set(-58, FLOOR_Y - box.min.y * scale, -44);
    model.rotation.y = 0.6;
    this.root.add(model);
  }
}
