import * as THREE from 'three';
import { fitModel, loadModel, loadPbrTextureSet, prepareModel } from '../assets';
import type { IntroDescriptor } from './Environment';
import { Environment, TABLE_LEG_HEIGHT, TABLE_THICKNESS, TABLE_TOP_Y } from './Environment';

/**
 * 日式庭院：露天的一局。
 *
 * 三个环境的差别从这里开始：茶室是「四面墙里的一局」，庭院是「屋檐下的一局」。
 * 所以这里没有天花，光来自天顶而非障子窗，相机也不再被围在盒子里——
 * {@link Environment.maxDistance} 放到 72，玩家可以退开看整片枯山水。
 *
 * 组成：缘侧木平台 + 枯山水砂庭（含石组与耙痕）+ 石灯笼 + 松与枫 + 竹垣。
 * 桌面高度照旧顶在 TABLE_TOP_Y，棋盘和铜铃的位置一单位都不用挪。
 */

/** 缘侧木板的顶面，也就是玩家坐的高度基准。 */
const DECK_Y = TABLE_TOP_Y - TABLE_THICKNESS - TABLE_LEG_HEIGHT;
/** 平台比砂庭高出来的这一段，是「坐在廊上」和「站在院子里」的分界线。 */
const DECK_THICKNESS = 2.4;
const SAND_Y = DECK_Y - DECK_THICKNESS;

const DECK_HALF_X = 44;
const DECK_HALF_Z = 38;
/**
 * 竹垣围出的庭院范围。
 *
 * 比缘侧大出一大圈：中间那 60×54 单位的沙地才是枯山水要交代的东西，
 * 墙贴着走廊立的话，院子就只剩一条缝。
 */
const FENCE_HALF_X = DECK_HALF_X + 58;
const FENCE_HALF_Z = DECK_HALF_Z + 54;

const WOOD = '#6a4c33';
const WOOD_DARK = '#422f1f';
const STONE = '#767369';

export class CourtyardEnvironment extends Environment {
  override readonly background: THREE.ColorRepresentation = '#c9d8dd';
  /** 中式园林 HDRI：直接作 360° 天空背景 + 天光来源，程序化的渐变球退役。 */
  override readonly hdri = '/hdri/chinese_garden_1k.hdr';
  override readonly hdriBackground = true;
  override readonly backgroundIntensity = 1.05;
  override readonly environmentIntensity = 0.5;
  override readonly exposure = 1.0;
  override readonly bloom = 0.1;
  override readonly bloomThreshold = 1.2;
  /** 露天庭院，相机可以退得更远看整片枯山水。 */
  override readonly maxDistance = 72;
  /** 很淡的一层远雾：只为把砂庭边缘揉进 HDRI 的地平线，不压能见度。 */
  override readonly fog = new THREE.Fog('#bcc8c0', 220, 460);

  override readonly intro: IntroDescriptor = {
    position: [64, 82, 86],
    target: [0, 0, -14],
    fov: 66,
  };

  constructor(scene: THREE.Scene) {
    super(scene, 'courtyard');

    this.createLights();
    this.buildSandGarden();
    this.deckMaterial = this.buildDeck();
    void this.applyDeckTexture();
    this.buildBambooFence();
    this.buildGardenLantern(-52, -30);
    this.buildGardenLantern(52, 30, 0.92);
    this.buildTsukubai(38, -30);
    this.buildPine(-52, 24);
    this.buildMaple(50, -24);
    this.buildIshiIshidoroRocks();

    // 棋盘所在的矮几 + 两枚蒲团，坐在缘侧边缘对坐。
    this.tableTopMaterial = this.buildTable({
      top: '#5b4128',
      leg: '#3a2a1c',
      roughness: 0.55,
      legStyle: 'splayed',
      legHeight: TABLE_LEG_HEIGHT,
    });
    void this.applyTableTexture();
    this.zabuton(-21, 4, DECK_Y, '#4a5a53', 0.06);
    this.zabuton(21, 4, DECK_Y, '#8d5a3c', -0.1);
  }

  private readonly deckMaterial: THREE.MeshStandardMaterial;
  private readonly tableTopMaterial: THREE.MeshStandardMaterial;

  /** 深色胡桃木桌面：庭院的桌子要比缘侧深一档，棋盘才「沉」得下来。 */
  private async applyTableTexture(): Promise<void> {
    const set = await loadPbrTextureSet('darkwood', 2.2, { ao: true, anisotropy: 16 }).catch(() => null);
    if (!set) return;
    this.tableTopMaterial.map = set.map;
    this.tableTopMaterial.normalMap = set.normalMap;
    this.tableTopMaterial.roughnessMap = set.roughnessMap;
    this.tableTopMaterial.aoMap = set.aoMap;
    this.tableTopMaterial.color.set('#9a8d80');
    this.tableTopMaterial.normalScale.set(0.7, 0.7);
    this.tableTopMaterial.needsUpdate = true;
    for (const texture of [set.map, set.normalMap, set.roughnessMap, set.aoMap]) {
      if (texture) this.disposables.push(texture);
    }
  }

  // ------------------------------------------------------------------
  // 光照：露天场面，天光为主
  // ------------------------------------------------------------------

  private createLights(): void {
    // 半球天光从 0.85 压到 0.6：天光把影子的暗部整片托亮，开太大时
    // 棋子斜射影在盘上读不出来（实测教训）。0.6 仍是户外白昼的底色。
    const hemisphere = new THREE.HemisphereLight('#dceaf2', '#8f8a70', 0.6);
    hemisphere.position.set(0, 120, 0);
    this.root.add(hemisphere);

    // 主光：偏南的低角度日光。低仰角才有可读的棋子影子（几何见下）。
    const sun = new THREE.DirectionalLight('#fff6e6', 2.8);
    // 仰角压到 ~20°：棋子厚径比 0.34，影子伸出轮廓的可见宽度只有
    // 顶高 × cot(仰角) − 半径——原 32° 时 ~0.05 单位（纯月牙），
    // 20° 时 ~0.33 单位（直径的 43%），影子才完整可读。
    // 天光已压暗，日光加到 2.8 保证水平棋盘的直射对比。
    sun.position.set(-95, 33, -76);
    sun.target.position.set(0, DECK_Y, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    // 收紧到棋盘与近景家具的范围：±100 时 2048² 贴图摊得太开，
    // 棋子影子只剩几个 texel，糊到看不见。
    sun.shadow.camera.left = -20;
    sun.shadow.camera.right = 20;
    sun.shadow.camera.top = 20;
    sun.shadow.camera.bottom = -20;
    sun.shadow.camera.near = 20;
    sun.shadow.camera.far = 320;
    sun.shadow.bias = -0.0007;
    // normalBias 归零：见 TeaRoom 同款说明（防 peter-panning 漏光亮缝）。
    sun.shadow.normalBias = 0.0;
    sun.shadow.radius = 4; // PCFSoft：边缘更柔，接近半影
    this.root.add(sun, sun.target);

    // 棋盘上方的补光：砂庭反光很强，但棋盘本身要有一点舞台感。
    // 0.5→0.35：这盏也是无影的头顶光，太亮会漂白棋子影子（同茶室教训）。
    const fill = new THREE.SpotLight('#fff3e0', 0.35, 0, 0.95, 0.6);
    fill.position.set(8, 14, 9);
    fill.target.position.set(0, 0, 0);
    fill.decay = 0;
    this.root.add(fill, fill.target);
  }

  // ------------------------------------------------------------------
  // 砂庭
  // ------------------------------------------------------------------

  private buildSandGarden(): void {
    // 纯色兜底，真实砂 PBR 到位后热替换。
    // 细分到 320×320：位移贴图必须有足够顶点才有形。
    // 一块平面加再强的法线，在正上方打下来的光里也只是「明暗微差」；
    // 只有真的把顶点推下去，耙沟才会自己挡住光、投出影子。
    // 10 万个顶点是一次性的，绘制仍然只有 1 个 draw call。
    const geometry = this.track(new THREE.PlaneGeometry(420, 420, 320, 320));
    const material = new THREE.MeshStandardMaterial({
      color: '#cfc9b8',
      roughness: 0.97,
      metalness: 0,
    });
    this.disposables.push(material);
    const sand = new THREE.Mesh(geometry, material);
    sand.rotation.x = -Math.PI / 2;
    sand.position.y = SAND_Y;
    sand.receiveShadow = true;
    this.root.add(sand);
    this.sandMaterial = material;
    void this.applySandTexture();
  }

  private sandMaterial: THREE.MeshStandardMaterial | null = null;

  /**
   * 砂庭的表面：**白沙的反射率 + 耙过地面的起伏**。
   *
   * 这一步试过两个极端，都不行：
   *
   * - 只用海岸砂（`zensand`）：砂粒是对的，但它是一块**平的**砂，
   *   枯山水最重要的那道「梳过的沟」完全没有，只能靠几何画几个半透明圆环顶上。
   * - 只用耙过的地面（`raked_dirt`）：沟是对的，可那是耙过的**泥地**——
   *   带着草屑、土黄、踩出来的坑，铺在院子里像一块没收拾的工地。
   *
   * 所以两张各取一半：`zensand` 出颜色（白沙）、`raked_dirt` 出法线与位移（耙沟）。
   * 砂是各向同性的颗粒，两张贴图叠在一起不会「对不上缝」——
   * 颜色归颜色、光影归光影，合成的结果就是「一块被耙过的白沙」。
   *
   * 尺度按物理尺寸反推：420 单位 ≈ 13 米，一张贴图约 2.6 米，repeat 取 5，
   * 于是耙沟间距落在 15cm 左右，和真实耙砂一致。
   */
  private async applySandTexture(): Promise<void> {
    const [grain, rake] = await Promise.all([
      loadPbrTextureSet('zensand', 5, { ao: true, anisotropy: 8 }).catch(() => null),
      loadPbrTextureSet('raked', 5, { ao: true, displacement: true, anisotropy: 8 }).catch(() => null),
    ]);
    if (!this.sandMaterial) return;

    if (grain) {
      this.sandMaterial.map = grain.map;
      this.sandMaterial.roughnessMap = grain.roughnessMap;
      this.sandMaterial.aoMap = grain.aoMap;
      // 乘 1 附近即可：砂面在正午直射下本来就接近过曝，再往上抬只会把
      // 耙沟的明暗差一起削平（这也是它一直看起来「白得像张纸」的原因之一），
      // 白度交给环境光，贴图只负责颗粒。
      this.sandMaterial.color.setRGB(1.0, 0.99, 0.97);
      for (const texture of [grain.map, grain.roughnessMap, grain.aoMap]) {
        if (texture) this.disposables.push(texture);
      }
    }

    if (rake) {
      this.sandMaterial.normalMap = rake.normalMap;
      this.sandMaterial.normalScale.set(1.6, 1.6);
      // **真位移**：耙沟把顶点推下去，几何自己挡住光。
      // 之前用 bumpMap / normalMap，理论上也有凹凸，但在天顶光下几乎看不出——
      // 光照方向与视线几乎平行时，法线的扰动不会改变着色。
      // 换成 displacementMap 之后沟有了实际的深度，阴影与遮挡都是真的。
      this.sandMaterial.displacementMap = rake.displacementMap ?? rake.aoMap;
      this.sandMaterial.displacementScale = 0.9;
      this.sandMaterial.displacementBias = -0.45;
      for (const texture of [rake.normalMap, rake.displacementMap, rake.aoMap]) {
        if (texture) this.disposables.push(texture);
      }
    }

    this.sandMaterial.roughness = 1;
    this.sandMaterial.needsUpdate = true;
  }

  /**
   * 石组：三处景石，全部用扫描岩石（boulder_01 / rock_07 / stone_01）。
   *
   * 枯山水的石头讲究「丑而怪」——风化洞、水蚀纹、不对称的筋骨。
   * 十二面体怎么转都是几何体，扫描件才有那种被海水盘了几千年的皮壳。
   * 加载是异步的：砂庭先成形，石头随后落定，每处周围照旧梳一圈耙痕。
   */
  private buildIshiIshidoroRocks(): void {
    // 石组刻意贴着缘侧摆（缘侧半宽 44 / 半深 38）。
    //
    // 原来的三处景石在 (-64,-70)、(74,-64)、(-20,82)，离平台有二十多个单位，
    // 相机拉到最远（maxDistance 72）也只能看见一片空砂——「枯山水」只存在于
    // 代码里。挪到平台外沿四五个单位之后，开场推镜和拉远视角都能看到石头与耙痕。
    this.rakeRings(-52, -46, [10, 14.5, 19]);
    this.rakeRings(56, -44, [9, 13, 17]);
    this.rakeRings(-16, 52, [10, 14.5, 19]);

    // 三处景石各用一件不同的扫描石，避免「同一块石头摆三次」的复制感。
    // 注意体积：海岸岩（coast_rocks_01）的几何数据有 19MB、紫薇（jacaranda）的
    // 树叶更是 145MB——这些「1k」只降贴图不降面数，必须挑面数合适的素材。
    void this.placeRock('boulder_01', -52, -46, 15, 0.7);
    void this.placeRock('rock_07', 56, -44, 12, -0.4);
    void this.placeRock('stone_01', -16, 52, 13, 2.4);
  }

  /** 把一块扫描岩石按目标水平跨距放到砂面上。 */
  private async placeRock(id: string, x: number, z: number, footprint: number, rotationY: number): Promise<void> {
    const model = await loadModel(id);
    if (!model) return;
    prepareModel(model, 8);
    fitModel(model, { footprint, rotationY, groundY: SAND_Y - 0.4 });
    model.position.x += x;
    model.position.z += z;
    this.root.add(model);
  }

  /**
   * 耙痕。
   *
   * 原来这里是几何画的同心圆环（先是一层半透明深色环，后来改成一深一浅两条）。
   * 无论怎么调，它都只有颜色、没有形——远看是「印在砂上的几个圈」，
   * 近看更露：环是完美的圆、宽窄一致、不随砂面的起伏变形。
   *
   * 现在整片耙痕由 `raked_dirt` 贴图承担：真实的耙沟有深有浅、有顺有逆、
   * 边缘被风吹散，这是画不出来的。所以这里不再画任何东西，
   * 只保留调用点——「哪些位置是梳过砂的」这个信息仍然是场景自己决定的。
   */
  private rakeRings(_x: number, _z: number, _radii: number[]): void {
    // 保留方法签名与调用点：耙痕的呈现方式换成了贴图，
    // 但「哪些位置是梳过砂的」这个信息仍然由调用方决定，
    // 将来若要在石组周围加强耙痕，从这里接。
  }

  // ------------------------------------------------------------------
  // 缘侧（木平台）
  // ------------------------------------------------------------------

  private buildDeck(): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({ color: WOOD, roughness: 0.72 });
    this.disposables.push(material);
    const slab = this.box(
      [DECK_HALF_X * 2, DECK_THICKNESS, DECK_HALF_Z * 2],
      [0, SAND_Y + DECK_THICKNESS / 2, 0],
      material,
      this.root,
      { cast: false },
    );
    slab.receiveShadow = true;

    // 廊下的阴影线：平台外沿一圈深色收边，让平台「离开地面」而不是浮着。
    const edge = this.material(WOOD_DARK, { roughness: 0.68 });
    for (const side of [-1, 1] as const) {
      this.box([DECK_HALF_X * 2, 0.6, 1.2], [0, SAND_Y + 0.3, side * DECK_HALF_Z], edge, this.root, { cast: false });
      this.box([1.2, 0.6, DECK_HALF_Z * 2], [side * DECK_HALF_X, SAND_Y + 0.3, 0], edge, this.root, { cast: false });
    }
    return material;
  }

  private async applyDeckTexture(): Promise<void> {
    // 日本杉木板：缘侧的木板就该是这种晒得发白的软木，不是深色的室内地板。
    const set = await loadPbrTextureSet('cedar', { x: 10, y: 9 }, { ao: true, anisotropy: 16 }).catch(() => null);
    if (!set) return;
    this.deckMaterial.map = set.map;
    this.deckMaterial.normalMap = set.normalMap;
    this.deckMaterial.roughnessMap = set.roughnessMap;
    this.deckMaterial.aoMap = set.aoMap;
    this.deckMaterial.aoMapIntensity = 0.9;
    // 杉木原图是蜜橙色的，缘侧的木板该是雨淋日晒后的灰褐色——用灰调压掉橙。
    this.deckMaterial.color.set('#8d867c');
    this.deckMaterial.roughness = 1;
    this.deckMaterial.needsUpdate = true;
    for (const texture of [set.map, set.normalMap, set.roughnessMap, set.aoMap]) {
      if (texture) this.disposables.push(texture);
    }
  }

  /**
   * 竹垣：庭院外围的一圈竹编墙。
   *
   * 这一处动了两件事。
   *
   * **位置**：原来这圈墙紧贴着缘侧（离平台只有 2.2 单位），等于在廊前立了一道
   * 帘子——枯山水砂庭、景石、耙痕全被挡在后面，相机拉到最远也只能看见一排竹竿。
   * 挪到庭院外围之后，「坐在廊上看院子」这件事才第一次成立。
   *
   * **材质**：原来是一根根半径 0.5 单位的 InstancedMesh 圆柱（约 3cm 粗，
   * 远看像一排铁丝）。现在主体交给 Poly Haven 的真实竹编贴图
   * （`bamboo_wall_02`，照片级的竹片编织与绑绳），圆柱只保留立柱与压条做结构。
   */
  private buildBambooFence(): void {
    const height = 40;
    const centerY = SAND_Y + height / 2;
    const lengthX = FENCE_HALF_X * 2;
    const lengthZ = FENCE_HALF_Z * 2;

    // 竹编面板：四面薄墙。贴图还没到之前先用竹黄兜底。
    const panelMaterial = this.material('#a08d5f', { roughness: 0.9 });
    this.fenceMaterial = panelMaterial;

    for (const side of [-1, 1] as const) {
      const northSouth = this.box(
        [lengthX, height, 1],
        [0, centerY, side * FENCE_HALF_Z],
        panelMaterial,
        this.root,
        { cast: false },
      );
      northSouth.receiveShadow = true;

      const eastWest = this.box(
        [1, height, lengthZ],
        [side * FENCE_HALF_X, centerY, 0],
        panelMaterial,
        this.root,
        { cast: false },
      );
      eastWest.receiveShadow = true;
    }

    // 立柱：每隔 12 单位一根粗竹竿，把长墙分成一段一段。
    // 这是竹垣在尺度上唯一可信的「结构」——一根通到底的墙会像一块贴了图的板。
    const postMaterial = this.material('#b8a273', { roughness: 0.88 });
    const spacing = 6;
    const postsX = Math.floor(lengthX / spacing);
    const postsZ = Math.floor(lengthZ / spacing);
    for (let index = 0; index <= postsX; index += 1) {
      const x = -FENCE_HALF_X + (lengthX / postsX) * index;
      for (const side of [-1, 1] as const) {
        this.cylinder(1.15, 1.3, height + 6, [x, SAND_Y + (height + 6) / 2, side * FENCE_HALF_Z], postMaterial, 7);
      }
    }
    for (let index = 0; index <= postsZ; index += 1) {
      const z = -FENCE_HALF_Z + (lengthZ / postsZ) * index;
      for (const side of [-1, 1] as const) {
        this.cylinder(1.15, 1.3, height + 6, [side * FENCE_HALF_X, SAND_Y + (height + 6) / 2, z], postMaterial, 7);
      }
    }

    // 横向压条：两道竹竿压在面板外侧，是竹垣最容易辨认的特征。
    // 顶上再加一根帽子（压顶竹），墙才有一条收得住的边——
    // 没有它的话，再好的贴图也会在墙顶露出一条齐刷刷的「切边」。
    const railMaterial = this.material('#6d5c36', { roughness: 0.9 });
    for (const ratio of [0.24, 0.7, 1]) {
      const y = SAND_Y + height * ratio;
      // 顶帽粗一档，压得住墙面
      const radius = ratio === 1 ? 2.1 : 1.5;
      for (const side of [-1, 1] as const) {
        const railX = this.cylinder(radius, radius, lengthX, [0, y, side * (FENCE_HALF_Z + 1.2)], railMaterial, 8);
        railX.rotation.z = Math.PI / 2;
        const railZ = this.cylinder(radius, radius, lengthZ, [side * (FENCE_HALF_X + 1.2), y, 0], railMaterial, 8);
        railZ.rotation.x = Math.PI / 2;
      }
    }

    void this.applyFenceTexture(Math.max(lengthX, lengthZ));
  }

  private fenceMaterial: THREE.MeshStandardMaterial | null = null;

  /**
   * 真实的竹编贴图（bamboo_wall_02）。
   *
   * repeat 按**物理尺寸**反推：一张贴图约 2 米见方的竹编，墙长 length 米就该重复
   * length / 2 次。凭感觉给一个 8 或 10 会把竹片压成一片糊，绑绳的细节全丢。
   */
  private async applyFenceTexture(length: number): Promise<void> {
    // 1 单位 ≈ 3.1cm（桌子 30 单位 = 93cm），所以 length 单位 ≈ length * 0.031 米
    const meters = length * 0.031;
    const repeat = { x: meters / 2, y: 0.64 };
    const set = await loadPbrTextureSet('bamboo', repeat, {
      ao: true,
      displacement: true,
      anisotropy: 8,
    }).catch(() => null);
    if (!set || !this.fenceMaterial) return;

    this.fenceMaterial.map = set.map;
    this.fenceMaterial.normalMap = set.normalMap;
    this.fenceMaterial.roughnessMap = set.roughnessMap;
    this.fenceMaterial.aoMap = set.aoMap;
    this.fenceMaterial.color.set('#efe0ba');
    this.fenceMaterial.roughness = 1;
    this.fenceMaterial.normalScale.set(1.4, 1.4);
    // 竹编的凹凸来自位移图：竹片之间的缝是真缝，不是画上去的一条暗线
    this.fenceMaterial.bumpMap = set.displacementMap ?? set.aoMap;
    this.fenceMaterial.bumpScale = 0.2;
    this.fenceMaterial.needsUpdate = true;

    for (const texture of [set.map, set.normalMap, set.roughnessMap, set.aoMap, set.displacementMap]) {
      if (texture) this.disposables.push(texture);
    }
  }

  // ------------------------------------------------------------------
  // 石作：灯笼与蹲踞
  // ------------------------------------------------------------------

  /**
   * 庭院灯：一座矮石座 + **真实的木框灯身**（Poly Haven `wooden_lantern_01`）。
   *
   * 原来这里是六段基本体堆出来的「春日灯笼」：基座、竿、中台、火袋、笠、宝珠，
   * 比例是查着定式摆的，但方块、圆锥、球体三种几何体拼在一起，无论怎么调比例
   * 都还是「积木」。灯罩还得自己拿自发光的方块假装纸面。
   *
   * 现在只有**石座是基本体**——真实灯笼本来也要垫石头；灯身整段交给扫描件，
   * 木框的榫、玻璃的厚度、铁皮顶的锈迹都是摄影级的。灯芯仍然是我们自己点：
   * 一盏暖色点光源 + 玻璃材质的自发光，两样合起来才像「里面有火」。
   */
  private buildGardenLantern(x: number, z: number, scale = 1): void {
    const stone = this.material(STONE, { roughness: 0.98 });
    const baseTop = SAND_Y + 5.4 * scale;
    // 两块叠石：下宽上窄，压住灯身的视觉重心。
    // 段数给到 7（奇数）并各自转一个角度，截面才不是正多边形，
    // 光影在棱上断得乱一点，才像凿出来的石头而不是车出来的水泥墩。
    const lower = this.cylinder(5.6 * scale, 6.6 * scale, 3.2 * scale, [x, SAND_Y + 1.6 * scale, z], stone, 7);
    lower.rotation.y = 0.4;
    const upper = this.cylinder(4.2 * scale, 5.0 * scale, 2.2 * scale, [x, SAND_Y + 4.3 * scale, z], stone, 7);
    upper.rotation.y = -0.7;

    void this.placeLanternBody(x, z, baseTop, scale);
  }

  private async placeLanternBody(x: number, z: number, baseTop: number, scale: number): Promise<void> {
    const model = await loadModel('wooden_lantern_01');
    if (!model) return;
    prepareModel(model, 8);

    // 灯身高度按石座的尺度走：座越高、灯越大，两座灯才能保持同一套比例。
    const bodyHeight = 21 * scale;
    model.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) {
        if (!(material instanceof THREE.MeshStandardMaterial)) continue;
        if (/glass/i.test(material.name)) {
          // 玻璃片是「灯芯」：给一点暖色自发光，夜里才像点着
          material.color.set('#ffe6bb');
          material.emissive = new THREE.Color('#ffbf72');
          material.emissiveIntensity = 1.1;
          material.roughness = 0.18;
          material.transparent = true;
          material.opacity = 0.86;
        } else {
          // 木框与铁顶：压暗一档，让它沉在庭院里而不是跳出来
          material.color.multiplyScalar(0.82);
          material.roughness = Math.max(material.roughness, 0.72);
        }
      }
    });

    fitModel(model, {
      footprint: 10 * scale,
      height: bodyHeight,
      rotationY: x * 0.03 + z * 0.02,
      groundY: baseTop,
    });
    model.position.x += x;
    model.position.z += z;
    this.root.add(model);

    const light = new THREE.PointLight('#ffc27a', 1.15 * scale, 46, 1.6);
    light.position.set(x, baseTop + bodyHeight * 0.55, z);
    this.root.add(light);
  }

  /** 蹲踞：一口石钵、一汪水、一根竹笕。茶室外才会有的洗手钵。 */
  private buildTsukubai(x: number, z: number): void {
    const stone = this.material('#7d7b72', { roughness: 0.95 });
    const group = new THREE.Group();
    group.position.set(x, SAND_Y, z);
    this.root.add(group);

    const basin = this.mesh(new THREE.CylinderGeometry(3.2, 3.6, 4.2, 16), stone, group);
    basin.position.y = 2.1;
    const water = new THREE.MeshStandardMaterial({
      color: '#2f4a4a',
      roughness: 0.12,
      metalness: 0.4,
    });
    this.disposables.push(water);
    const surface = this.mesh(new THREE.CircleGeometry(2.8, 20), water, group, { cast: false });
    surface.rotation.x = -Math.PI / 2;
    surface.position.y = 4.05;

    // 竹笕：斜着伸到钵口上方的细竹管。
    const bamboo = this.material('#8f7d4e', { roughness: 0.9 });
    const spout = this.cylinder(0.42, 0.42, 11, [4.6, 8.4, -1.2], bamboo, 8, group);
    spout.rotation.z = -0.5;
    this.cylinder(0.5, 0.5, 9, [-6.4, 4.5, -1.2], bamboo, 8, group);
  }

  // ------------------------------------------------------------------
  // 树
  // ------------------------------------------------------------------

  /**
   * 庭木：一丛被修剪过的灌木（`shrub_02` 的某个变体），靠比例和颜色分成松与枫。
   *
   * 原来这里是蓝花楹（`jacaranda_tree`）扫描件配色演出来的——骨架是棵树。
   * 但那件素材只有「1k 贴图」被降过，**面数没有**：树叶图元 264 万顶点、145MB，
   * 整棵树落地 208MB，是全站其他素材总和的好几倍，代价过高，只能换掉。
   *
   * 换成灌木并不是妥协：日式庭院里的「庭木」本来就是被反复修剪成团块的，
   * 一丛五米宽、边缘圆润的灌木，比一棵枝叶稀疏的写实树更像修剪过的松或枫。
   * 用不同的变体 + 不同的比例，两株才有各自的样子，不至于「同一丛摆两次」。
   */
  private buildPrunedTree(
    x: number,
    z: number,
    variant: string,
    canopy: string,
    emissive: string,
    emissiveIntensity: number,
    footprint: number,
    height: number,
    rotationY: number,
  ): void {
    void (async () => {
      const model = await loadModel('shrub_02');
      if (!model) return;
      prepareModel(model, 8);

      // 这个素材是四个变体并排摆的，只留指定的那一丛
      for (const child of [...model.children]) {
        if (child.name !== variant) child.removeFromParent();
      }

      model.traverse((node) => {
        if (!(node instanceof THREE.Mesh)) return;
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        for (const material of materials) {
          if (!(material instanceof THREE.MeshStandardMaterial)) continue;
          material.color.set(canopy);
          material.emissive.set(emissive);
          material.emissiveIntensity = emissiveIntensity;
          material.roughness = 0.92;
          material.metalness = 0;
        }
      });

      fitModel(model, { footprint, height, rotationY, groundY: SAND_Y });
      model.position.x += x;
      model.position.z += z;
      this.root.add(model);
    })();
  }

  /** 松：窄而高的团块 + 深绿，从廊上看过去压住院子的左后角。 */
  private buildPine(x: number, z: number): void {
    this.buildPrunedTree(x, z, 'shrub_02_b', '#2e4a2a', '#0a1408', 0.3, 30, 34, 0.9);
  }

  /** 枫：宽而低的团块 + 深秋的红，给砂庭留一笔暖色对比。 */
  private buildMaple(x: number, z: number): void {
    this.buildPrunedTree(x, z, 'shrub_02_c', '#c4441a', '#4a1206', 0.45, 28, 24, 2.2);
  }
}
