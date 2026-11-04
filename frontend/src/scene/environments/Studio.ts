import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { loadPbrTextureSet } from '../assets';
import type { IntroDescriptor } from './Environment';
import { Environment, TABLE_LEG_HEIGHT, TABLE_THICKNESS, TABLE_TOP_Y } from './Environment';

/**
 * 摄影棚：第五棋境，一张给「静物产品照」用的桌子。
 *
 * 和前四个棋境的目标不同——茶室、庭院、赛博、客厅都在讲故事（坐在哪儿下棋），
 * 这一个不讲故事，只负责把棋盘拍好看：
 *
 * - **无缝弧形背景**：地面到背墙用一条 quarter-circle 的 cove 连起来，整整一圈
 *   （`LatheGeometry` 旋转成形）。相机 360° 转都不会看见墙角或虚空，
 *   这是影棚和「一间黑屋子」的区别。
 * - **柔光箱**：四盏 `RectAreaLight`（主光 / 补光 / 顶光 / 轮廓光）。面光源有面积，
 *   打在高光上的反射是一整条柔和的矩形亮带，而不是点光那种小圆点——
 *   「产品摄影感」主要来自这里。
 * - **真实接触阴影**：`RectAreaLight` 在 three 里没有阴影（见 RectAreaLight.js
 *   的注释），所以另配一盏与主光**同方向**的平行光专门投影子，棋子才会「压」
 *   在棋盘上，而不是浮着。
 *
 * 素材：桌子走 `Environment.buildTable`，桌面用已有的 `darkwood` PBR，
 * 天光沿用 `studio_kominka_01_1k.hdr`；台面相机、明信片与桌后的背景板
 * 都是 Poly Haven 的 CC0 扫描模型（见 `THIRD_PARTY_NOTICES.md`），不再手搓几何。
 * 四盏柔光箱依旧只是光源、留在画外——真实棚拍里灯本来也不一定入镜。
 */

/** 影棚地面高度：和其它环境一样，桌子腿落在这条线上。 */
const FLOOR_Y = TABLE_TOP_Y - TABLE_THICKNESS - TABLE_LEG_HEIGHT;

/** 影棚半径 / 墙高 / 底部圆角半径（世界单位；1 单位 ≈ 3.1cm）。 */
const STUDIO_RADIUS = 150;
const STUDIO_HEIGHT = 170;
const COVE_RADIUS = 18;

/** `RectAreaLightUniformsLib.init()` 只需一次；切来切去不要重复烘 LTC 贴图。 */
let ltcReady = false;

export class StudioEnvironment extends Environment {
  /** 纯黑偏冷的底色：影棚的背景该「退」到最后面，不能和棋盘抢。 */
  override readonly background: THREE.ColorRepresentation = '#0a0b0d';
  /** 已有素材里唯一带 studio 字样的 HDRI：只取一点点环境反射，不靠它照明。 */
  override readonly hdri = '/hdri/studio_kominka_01_1k.hdr';
  override readonly environmentIntensity = 0.15;
  override readonly exposure = 1.14;
  /** 柔光箱在漆面棋子/棋盘上打出的高光，给一丝极淡的溢出。 */
  override readonly bloom = 0.1;
  override readonly bloomThreshold = 1.15;
  /** 影棚是个大圆筒，相机可以退得比茶室远一些看整张台面。 */
  override readonly maxDistance = 64;

  /**
   * 推镜从房间后方压进来：先看见两侧柔光箱与弧形背景，再落到棋盘上——
   * 像摄影棚里把灯调好、把机位推到位的过程。
   *
   * 原先 [52,40,58] + fov 50 只框得住桌面，灯箱与无缝背景全在画外，
   * 「摄影棚」看起来就是一块灰底加一张木桌。改到正后方、放宽到 62°，
   * 起点那一帧才交代得出这是个棚。默认对局机位仍是正俯拍，未改动。
   */
  override readonly intro: IntroDescriptor = {
    position: [0, 34, 116],
    target: [0, 14, 4],
    fov: 62,
    duration: 5200,
  };

  private readonly tableTopMaterial: THREE.MeshStandardMaterial;

  constructor(scene: THREE.Scene) {
    super(scene, 'studio');

    if (!ltcReady) {
      // WebGLRenderer 下 RectAreaLight 依赖这张 LTC 查找表，不初始化会整片发黑。
      RectAreaLightUniformsLib.init();
      ltcReady = true;
    }

    this.createLights();
    this.buildCyclorama();

    // 桌后立一块真实扫描的投影幕布，当影棚的背景板 / 反光板。
    // 四盏 RectAreaLight 仍只是光源（真实影棚里灯也常在画外），但至少开场
    // 推镜能看见一件明确的棚拍器材，而不是一整片空灰。
    // 放在 z=-36、桌后半宽之外，AABB 校验会保证不与桌子 / 棋盘穿模。
    const studioHalf: [number, number] = [STUDIO_RADIUS - COVE_RADIUS, STUDIO_RADIUS - COVE_RADIUS];
    this.placeTableProp({
      id: 'projector_screen',
      x: 0, z: -36, footprint: 16, height: 20, rotationY: 0,
      groundY: FLOOR_Y, tableHalf: studioHalf, maxHeight: 24,
      flatColor: '#d6d8d6',
    });

    // 桌子照旧顶在 TABLE_TOP_Y：棋盘、铜铃一单位都不用挪。
    // 桌面用暗胡桃木，把浅色榧木棋盘衬出来（真实棋具产品照也常这么做）。
    this.tableTopMaterial = this.buildTable({
      top: '#2a2b2e',
      leg: '#17181b',
      roughness: 0.6,
      metalness: 0.04,
      // 台面从 26 放到 30，和其余四个棋境一致。原先 26 见方时，棋盘禁区
      // 右缘 7.75 到桌沿 12.5 只有 4.75 单位净宽，相机想放大一倍多根本摆不下，
      // 会被 AABB 自动缩回去。放大台面只是给器材留出净空，**默认相机机位
      // 与倾角一个单位都没动**。
      size: 30,
      legStyle: 'panel',
      legHeight: TABLE_LEG_HEIGHT,
    });
    void this.applyTableTexture();

    const tableHalf: [number, number] = [15, 15];
    // 胶片相机：footprint 3.8 → 8.0（约 2.1 倍）。原先只比棋子大一点点，
    // 放大后端正摆在右后角，俯拍才读得出机身、镜头与背带。
    // 朝向归零不是随便改的：相机长边在 z，斜一点就会把 x 跨度撑过桌面净宽。
    this.placeTableProp({
      id: 'camera_01', x: 11.1, z: -4.0, footprint: 8.0, rotationY: 0,
      tableHalf,
    });
    // 明信片模型是一整面**竖直立着**的 4×5 照片墙（z 厚度为零），俯拍只看得见
    // 一条细线。绕 X 轴 -90° 让它平躺在台面上、正面朝上，并抬高 0.04 避免与
    // 桌面共面闪烁；顺带放大到 4.6，平放后才看得清是一叠照片。
    this.placeTableProp({
      id: 'postcard_set', x: 10.6, z: 5.6, footprint: 4.6,
      rotationX: -Math.PI / 2, lift: 0.04,
      tableHalf,
    });
  }

  // ------------------------------------------------------------------
  // 光照：四盏柔光箱 + 洗墙聚光 + 投影平行光
  // ------------------------------------------------------------------

  private createLights(): void {
    // 底光压到极低：影棚的暗部靠柔光箱的边缘光托，不靠一盏天光照亮全屋。
    const hemisphere = new THREE.HemisphereLight('#dfe7f2', '#0b0c0e', 0.2);
    hemisphere.position.set(0, 90, 0);
    this.root.add(hemisphere);

    // 主柔光箱（key）：左前上方最大的一块，接近中性的暖白。
    // 仰角约 24°——和投影平行光一致；棋子厚径比 0.34，仰角再高影子就被
    // 自身挡住了（见 TeaRoom 的几何推导），24° 才能投出读得出来的接触影。
    const key = new THREE.RectAreaLight('#fffcf6', 3.4, 50, 36);
    key.position.set(-64, 34, 40);
    key.lookAt(0, 2, 0);
    this.root.add(key);

    // 补光（fill）：右前方，冷一档、弱一档，只抬暗部，不参与造型。
    const fill = new THREE.RectAreaLight('#e8f0ff', 2, 44, 32);
    fill.position.set(62, 42, 46);
    fill.lookAt(0, 2, 0);
    this.root.add(fill);

    // 顶光（top）：正上方的大面积柔光。24° 的低角度主光在桌面上是掠射，
    // 照度被 sin(仰角) 砍掉大半，桌面会黑成一块板；顶光垂直打下来，
    // 台面与地面才有一片亮起来的光池，桌子也才「站」在地上。
    const top = new THREE.RectAreaLight('#f6f8ff', 2.3, 74, 74);
    top.position.set(0, 56, 4);
    top.lookAt(0, 0, 0);
    this.root.add(top);

    // 轮廓光（rim）：从棋盘后方打过来，勾出棋子边缘与桌沿，画面才有纵深。
    const rim = new THREE.RectAreaLight('#ffffff', 2.3, 36, 24);
    rim.position.set(0, 42, -70);
    rim.lookAt(0, 2, 0);
    this.root.add(rim);

    // 背景洗墙光：单独一盏打向弧形背墙。背景在 150 单位外，主光/补光到那里
    // 已经衰减殆尽，不单独给光的话背景就是纯黑的一团——那是「黑屋子」，不是影棚。
    //
    // 这里**不用 RectAreaLight**：面光投在墙上是一块边缘清晰的矩形光斑，
    // 远看就是一条斜着的地平线。改用宽角 + 全半影（penumbra=1）的聚光灯，
    // 光斑才有真正连续的圆形衰减，墙脚也能平滑地暗下去。
    const backdrop = new THREE.SpotLight('#eef3ff', 4.5, 0, 0.95, 1, 0);
    backdrop.position.set(0, 34, -74);
    backdrop.target.position.set(0, 8, -150);
    backdrop.decay = 0;
    backdrop.distance = 0;
    backdrop.castShadow = false;
    this.root.add(backdrop, backdrop.target);

    // 投影光：RectAreaLight 在 three 里没有阴影支持，接触阴影只能交给平行光。
    // 位置与主柔光箱同向（方向比 64:34:40 ≈ 118:62:74），影子方向才和主光一致，
    // 不会出现「光从左上来、影子往右下跑」的错位。
    const shadowLight = new THREE.DirectionalLight('#fff2df', 1.2);
    shadowLight.position.set(-118, 62, 74);
    shadowLight.target.position.set(0, 0, 0);
    shadowLight.castShadow = true;
    shadowLight.shadow.mapSize.set(2048, 2048);
    // ±34 罩住棋盘与桌沿：再大 2048² 摊薄，棋子影子会糊成一片。
    shadowLight.shadow.camera.left = -34;
    shadowLight.shadow.camera.right = 34;
    shadowLight.shadow.camera.top = 34;
    shadowLight.shadow.camera.bottom = -34;
    shadowLight.shadow.camera.near = 20;
    shadowLight.shadow.camera.far = 320;
    shadowLight.shadow.bias = -0.0006;
    // normalBias 归零：见 TeaRoom 的说明（防 peter-panning 漏光亮缝）。
    shadowLight.shadow.normalBias = 0;
    shadowLight.shadow.radius = 4;
    this.root.add(shadowLight, shadowLight.target);
  }

  // ------------------------------------------------------------------
  // 无缝弧形背景（地面 → 圆角 → 背墙，360°）
  // ------------------------------------------------------------------

  /**
   * 一条从中心铺出去、在边缘卷起来变成墙的剖面线，绕 Y 轴旋转一圈。
   *
   * 剖面点（半径, 高度）：
   * - `(0, 0)` → `(R-C, 0)`：地面；
   * - 四分之一圆弧 `(R-C, 0)` → `(R, C)`：cove，墙脚那道弯；
   * - `(R, C)` → `(R, H)`：背墙。
   *
   * 用内置的 `LatheGeometry` 而不是自己拼平面：一条剖面线就是一个连续的曲面，
   * 墙脚不会有接缝，绘制仍然只有一个 draw call。
   */
  private buildCyclorama(): void {
    const profile: THREE.Vector2[] = [];
    // 半径给 0.001 而不是 0：Lathe 在轴上会退化出 NaN 法线。
    profile.push(new THREE.Vector2(0.001, 0));
    profile.push(new THREE.Vector2(STUDIO_RADIUS - COVE_RADIUS, 0));

    const arcSteps = 14;
    for (let index = 1; index <= arcSteps; index += 1) {
      const angle = (index / arcSteps) * (Math.PI / 2);
      profile.push(
        new THREE.Vector2(
          STUDIO_RADIUS - COVE_RADIUS + Math.sin(angle) * COVE_RADIUS,
          COVE_RADIUS - Math.cos(angle) * COVE_RADIUS,
        ),
      );
    }
    profile.push(new THREE.Vector2(STUDIO_RADIUS, STUDIO_HEIGHT));

    const geometry = this.track(new THREE.LatheGeometry(profile, 96));
    const material = new THREE.MeshStandardMaterial({
      // 近黑的哑光灰：地面和墙各自被柔光箱照出一点层次，但整体退到棋盘后面。
      color: '#2b2f35',
      roughness: 0.95,
      metalness: 0,
      // 剖面是从内往外长的，法线朝向内侧；两面都画最稳，反正只看得到一面。
      side: THREE.DoubleSide,
    });
    this.disposables.push(material);

    const cyclorama = new THREE.Mesh(geometry, material);
    cyclorama.position.y = FLOOR_Y;
    // 背景只接影子，不投影子：它是一整块巨大的曲面，进阴影图没有意义。
    cyclorama.castShadow = false;
    cyclorama.receiveShadow = true;
    this.root.add(cyclorama);
  }

  // ------------------------------------------------------------------
  // 桌面
  // ------------------------------------------------------------------

  /** 暗胡桃木：复用庭院那张桌子的贴图，只把色相压冷、压灰一点。 */
  private async applyTableTexture(): Promise<void> {
    const set = await loadPbrTextureSet('darkwood', 1.4, { ao: true, anisotropy: 16 }).catch(() => null);
    if (!set) return;

    this.tableTopMaterial.map = set.map;
    this.tableTopMaterial.normalMap = set.normalMap;
    this.tableTopMaterial.roughnessMap = set.roughnessMap;
    this.tableTopMaterial.aoMap = set.aoMap;
    // 原图是暖棕的；影棚要中性，乘一层冷灰把暖度收掉，木纹还在。
    // 别压太狠：桌面是「台面」，不是背景，得能被柔光箱读出材质。
    this.tableTopMaterial.color.set('#83888d');
    this.tableTopMaterial.roughness = 0.85;
    this.tableTopMaterial.normalScale.set(0.5, 0.5);
    this.tableTopMaterial.needsUpdate = true;

    for (const texture of [set.map, set.normalMap, set.roughnessMap, set.aoMap]) {
      if (texture) this.disposables.push(texture);
    }
  }
}
