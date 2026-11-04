import * as THREE from 'three';
import { fitModel, loadModel, loadPbrTextureSet, prepareModel } from '../assets';
import { TABLE_SURFACE_Y } from '../config';
import type { IntroDescriptor } from './Environment';
import { Environment, TABLE_LEG_HEIGHT, TABLE_SIZE, TABLE_THICKNESS, TABLE_TOP_Y } from './Environment';
import { makeCyberFloorTexture, makeNeonSignTexture, makePetalTexture } from './textures';

/**
 * 赛博夜局：城市深处的一张棋桌。
 *
 * 与前两个环境的差别在于「光的方向」：茶室是侧面进来的日光，庭院是天顶的天光，
 * 这里没有主光——亮度全靠满场自己发光的招牌与地灯，人眼得先适应暗，
 * 才看得清棋盘上的黑子白子。所以场景整体压暗、曝光拉高（`exposure` 1.06），
 * 棋盘上方留一枚专用射灯保证可读性：**可以按照
 * 氛围暗，但棋盘必须亮**。
 *
 * 组成：发光金属地面 + 霓虹招牌 + 两丛通电的灌木 + 飘落花瓣
 * + 一整片真实街景杂物（锈空调、配电箱、垃圾桶、旧轮胎、油桶）
 * + 一张带青色光边的金属棋桌。桌面依旧顶在 TABLE_TOP_Y。
 */

const FLOOR_Y = TABLE_TOP_Y - TABLE_THICKNESS - TABLE_LEG_HEIGHT;

const CYAN = '#26deff';
const MAGENTA = '#ff4fa3';
/** 花瓣的活动范围：整片都在相机看得见的区域内，别浪费粒子。 */
const PETAL_AREA = 74;
const PETAL_TOP = 118;
const PETAL_COUNT = 520;

export class CyberpunkEnvironment extends Environment {
  override readonly background: THREE.ColorRepresentation = '#080a12';
  /** 上海外滩夜景 HDRI：真实的城市天际线作背景 + 霓虹环境光来源。 */
  override readonly hdri = '/hdri/shanghai_bund_1k.hdr';
  override readonly hdriBackground = true;
  override readonly backgroundIntensity = 0.9;
  override readonly environmentIntensity = 0.4;
  override readonly fog = new THREE.Fog('#0b0e1a', 60, 260);
  override readonly maxDistance = 60;
  override readonly exposure = 1.06;
  /** 赛博的灵魂：霓虹溢出的光晕全靠泛光。 */
  override readonly bloom = 0.75;
  override readonly bloomThreshold = 0.72;

  override readonly intro: IntroDescriptor = {
    position: [-78, 36, 72],
    target: [0, 0, -6],
    fov: 68,
  };

  /** 飘落的花瓣（THREE.Points），唯一每帧都会动的东西。 */
  private petals: THREE.Points | null = null;
  private petalSpeeds: Float32Array | null = null;
  private petalPhases: Float32Array | null = null;
  private lastFrameAt = 0;
  /** 会呼吸的霓虹：存下来供 onFrame 调光。 */
  private readonly flickers: Array<{ light: THREE.PointLight; base: number; phase: number }> = [];

  constructor(scene: THREE.Scene) {
    super(scene, 'cyber');

    this.createLights();
    this.buildFloor();
    // 远景城市交给外滩夜景 HDRI 背景——程序化的楼体盒子在照片级天际线面前
    // 只会露怯；霓虹招牌保留，但改为立地灯杆支撑（见 buildNeonSigns）。
    this.buildNeonSigns();
    this.buildCyberFoliage(-58, -34);
    this.buildCyberFoliage(62, 40, 0.86);
    this.buildStreetProps();
    this.buildPetals();

    this.buildTable({
      top: '#1c2432',
      leg: '#0f1319',
      roughness: 0.42,
      metalness: 0.45,
      emissive: CYAN,
      emissiveIntensity: 0.1,
      legStyle: 'panel',
      legHeight: TABLE_LEG_HEIGHT,
    });
    // 桌沿光带做**两层**：
    //
    // 1. 桌面上的一圈发光细框——俯拍时唯一看得见的一层。这张桌子是深色的，
    //    在对局视角里如果没有这圈框，整张桌子就是一块和背景糊在一起的黑板。
    // 2. 桌面下方外沿的侧光——拉远或转到侧面时才看得到，负责把桌子的厚度交代出来。
    //
    // 两层都必须是**四条直边**。之前用 `TorusGeometry` 套方形桌，圆环只在四条边的
    // 中点附近露头，俯拍正好看到左右两段对称弧线，像一对括号/爪子。
    const trim = new THREE.MeshStandardMaterial({
      color: CYAN,
      emissive: new THREE.Color(CYAN),
      emissiveIntensity: 0.85,
      roughness: 0.5,
    });
    this.disposables.push(trim);

    const frameInset = TABLE_SIZE / 2 - 1.6;
    const frameBar = 0.2;
    for (const axis of ['x', 'z'] as const) {
      for (const side of [-1, 1] as const) {
        // 桌面上的发光框
        const size: [number, number, number] =
          axis === 'x'
            ? [frameBar, 0.06, TABLE_SIZE - 3.2]
            : [TABLE_SIZE - 3.2, 0.06, frameBar];
        const position: [number, number, number] =
          axis === 'x' ? [side * frameInset, TABLE_SURFACE_Y + 0.02, 0] : [0, TABLE_SURFACE_Y + 0.02, side * frameInset];
        this.box(size, position, trim, this.root, { cast: false });
      }
    }

    // 桌沿下方的侧光：贴着外沿，比桌面低一个桌板厚度
    const edgeY = TABLE_TOP_Y - TABLE_THICKNESS - 0.3;
    const edgeInset = TABLE_SIZE / 2 - 0.15;
    for (const axis of ['x', 'z'] as const) {
      for (const side of [-1, 1] as const) {
        const size: [number, number, number] =
          axis === 'x' ? [0.4, 0.4, TABLE_SIZE - 0.6] : [TABLE_SIZE - 0.6, 0.4, 0.4];
        const position: [number, number, number] =
          axis === 'x' ? [side * edgeInset, edgeY, 0] : [0, edgeY, side * edgeInset];
        this.box(size, position, trim, this.root, { cast: false });
      }
    }

    this.zabuton(-21, 4, FLOOR_Y, '#1d2b3a', 0.05);
    this.zabuton(21, 4, FLOOR_Y, '#33203a', -0.09);
    // 桌面右后角放一台真实扫描的复古游戏主机：赛博夜局的「电子设备」
    // 用实物而不是几块发光矩形来表达。
    this.placeTableProp({
      id: 'gaming_console',
      x: 10.6,
      z: -6.0,
      footprint: 5.0,
      rotationY: -0.35,
    });
  }

  /**
   * 街景杂物：让「城市深处的一张棋桌」真的坐落在**一条街上**。
   *
   * 之前这个场景里除了桌子、两株电子樱和几块悬空的霓虹牌，什么都没有——
   * 地面是一整片发光的网格，一直铺到天际线，看起来像在一个空旷的虚拟房间里，
   * 而不是一条巷子。补的全是 Poly Haven 的扫描件：空调外机、配电箱、垃圾桶、
   * 旧轮胎、油桶。这些东西身上有锈、有油污、有被贴过小广告的痕迹，
   * 程序化的盒子再怎么写都长不出这些。
   *
   * 摆放遵循一条：**全部在半径 24 单位以外**。默认取景下桌子占满画面，
   * 杂物只该在镜头拉远或转动时进入边缘，绝不和棋盘抢注意力。
   */
  private buildStreetProps(): void {
    // 空调外机：赛博街景的第一符号。堆两台，再往远处散两台。
    // 只用「锈穿的那台」：干净那台在赛博街头太违和，而锈迹正是街上最该有的东西。
    const RUSTED = /rusted/i;
    this.placeProp('exterior_aircon_unit', -38, -25, { footprint: 26, height: 18, rotationY: 0.36, only: RUSTED });
    this.placeProp('exterior_aircon_unit', -38, -25, {
      footprint: 26,
      height: 18,
      rotationY: 0.36,
      groundY: FLOOR_Y + 18,
      only: RUSTED,
    });
    this.placeProp('exterior_aircon_unit', 34, -32, { footprint: 24, height: 17, rotationY: Math.PI + 0.18, only: RUSTED });
    this.placeProp('exterior_aircon_unit', -27, 40, { footprint: 24, height: 17, rotationY: -0.62, only: RUSTED });

    // 配电箱：街道另一侧，负责把「有电」这件事交代出来
    this.placeProp('utility_box_01', 45, 8, { footprint: 20, height: 26, rotationY: -0.22 });
    this.placeProp('utility_box_01', -47, 17, { footprint: 20, height: 26, rotationY: 0.5 });

    // 垃圾桶、轮胎、油桶：零散地沿街边摆，填掉大片空地
    this.placeProp('metal_trash_can', 25, -22, { footprint: 15, rotationY: 0.4 });
    this.placeProp('metal_trash_can', -31, -18, { footprint: 15, rotationY: -0.9 });
    this.placeProp('old_tyre', 39, 24, { footprint: 18, rotationY: 0.2 });
    this.placeProp('old_tyre', -36, 28, { footprint: 18, rotationY: 1.1 });
    this.placeProp('old_tyre', 21, 33, { footprint: 18, rotationY: 2.3 });
    this.placeProp('barrel_02', 17, 36, { footprint: 15, rotationY: 0.6 });
    this.placeProp('barrel_02', -15, -36, { footprint: 15, rotationY: -0.3 });

    // 施工护栏：一段一段沿着看不见的「街沿」摆。
    // 这是整个场景里最能把「空地」变成「街」的一件东西——
    // 一排护栏在地上画出一条线，人的眼睛会自己把线后面的区域读成车道。
    for (let index = 0; index < 4; index += 1) {
      this.placeProp('concrete_road_barrier', -30 + index * 20, 46, {
        footprint: 22,
        rotationY: 0,
      });
    }

    // 施工护栏：一段一段沿着看不见的「街沿」摆。
    // 这是整个场景里最能把「空地」变成「街」的一件东西——
    // 一排护栏在地上画出一条线，人的眼睛会自己把线后面的区域读成车道。
    for (let index = 0; index < 4; index += 1) {
      this.placeProp('concrete_road_barrier', -30 + index * 20, 46, {
        footprint: 22,
        rotationY: 0,
      });
    }
  }

  /** 同一个模型只下载解析一次，其余都是 clone。 */
  private readonly propPrototypes = new Map<string, Promise<THREE.Object3D | null>>();

  private async placeProp(
    id: string,
    x: number,
    z: number,
    options: {
      footprint: number;
      height?: number;
      rotationY?: number;
      groundY?: number;
      /**
       * 只保留名字匹配的顶层节点。
       *
       * Poly Haven 的不少素材是「一件东西的不同版本并排放」——
       * `exterior_aircon_unit` 里其实躺着**两台**外机（一台干净、一台锈穿），
       * 整个塞进场景会得到两台缩小的空调，还把包围盒撑得离谱。
       */
      only?: RegExp;
    },
  ): Promise<void> {
    let prototype = this.propPrototypes.get(id);
    if (!prototype) {
      prototype = (async () => {
        const model = await loadModel(id);
        if (!model) return null;
        prepareModel(model, 8);
        // 几何与原始材质归环境所有：克隆体共用它们，所以在原型上登记释放
        model.traverse((node) => {
          if (!(node instanceof THREE.Mesh)) return;
          this.disposables.push(node.geometry);
          const materials = Array.isArray(node.material) ? node.material : [node.material];
          this.disposables.push(...materials);
        });
        return model;
      })();
      this.propPrototypes.set(id, prototype);
    }

    const source = await prototype;
    if (!source) return;

    const prop = source.clone(true);

    if (options.only) {
      const keep = options.only;
      for (const child of [...prop.children]) {
        if (!keep.test(child.name)) child.removeFromParent();
      }
    }

    prop.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      // 街景杂物不进阴影贴图：棋盘射灯的阴影相机只覆盖桌边那一小片，
      // 这些道具投的影根本不在范围内，白白多一遍 draw。
      node.castShadow = false;
      node.receiveShadow = true;
    });

    // 逐项赋值而不是直接传对象字面量：项目开了 exactOptionalPropertyTypes，
    // `height: undefined` 与「不给 height」在类型上是两回事。
    const target: Parameters<typeof fitModel>[1] = {
      footprint: options.footprint,
      groundY: options.groundY ?? FLOOR_Y,
    };
    if (options.height !== undefined) target.height = options.height;
    if (options.rotationY !== undefined) target.rotationY = options.rotationY;
    fitModel(prop, target);
    prop.position.x += x;
    prop.position.z += z;
    this.root.add(prop);
  }

  /** 花瓣每帧下落 + 打旋，落到地面就回到顶上继续飘。 */
  override onFrame(now: number): void {
    const points = this.petals;
    const speeds = this.petalSpeeds;
    const phases = this.petalPhases;
    if (!points || !speeds || !phases) return;

    // 首帧没有上一帧可用；钳住 dt 是为了切标签页回来时不要「瞬移」一大段。
    const dt = this.lastFrameAt === 0 ? 0.016 : Math.min((now - this.lastFrameAt) / 1000, 0.05);
    this.lastFrameAt = now;

    const attribute = points.geometry.getAttribute('position') as THREE.BufferAttribute;
    const array = attribute.array as Float32Array;
    const bottom = FLOOR_Y + 0.4;
    for (let index = 0; index < speeds.length; index += 1) {
      const base = index * 3;
      // 局部变量 + `?? 0`：项目开了 `noUncheckedIndexedAccess`，下标访问一律判
      // 「可能 undefined」。对 Float32Array 来说这个担忧不成立（下标越界返回
      // undefined，但这里的下标都由 length 约束着），用默认值兜住即为真值。
      const x = array[base] ?? 0;
      const y = array[base + 1] ?? 0;
      const z = array[base + 2] ?? 0;
      const phase = phases[index] ?? 0;
      array[base] = x + Math.sin(now * 0.0011 + phase) * dt * 2.4;
      // 落到视线以下就回到顶部重新飘：与其判断旧 y，不如直接比较刚写进去的值。
      const nextY = y - (speeds[index] ?? 0) * dt;
      array[base + 2] = z + Math.cos(now * 0.0009 + phase) * dt * 1.6;
      if (nextY < bottom) {
        array[base] = (Math.random() - 0.5) * PETAL_AREA * 2;
        array[base + 1] = bottom + PETAL_TOP * (0.6 + Math.random() * 0.4);
        array[base + 2] = (Math.random() - 0.5) * PETAL_AREA * 2;
      } else {
        array[base + 1] = nextY;
      }
    }
    attribute.needsUpdate = true;

    // 霓虹呼吸：几条不同相位的正弦叠加，比固定亮度更像「电流不稳的招牌」。
    for (const flicker of this.flickers) {
      const wobble = 0.82 + Math.sin(now * 0.0021 + flicker.phase) * 0.12 + Math.sin(now * 0.0079) * 0.06;
      flicker.light.intensity = flicker.base * wobble;
    }
  }

  // ------------------------------------------------------------------
  // 光照：没有主光，全靠人造光源
  // ------------------------------------------------------------------

  private createLights(): void {
    // 夜里的环境光压得很低：高了一切都发灰，赛博感全丢。
    const hemisphere = new THREE.HemisphereLight('#3a4d78', '#120c1a', 0.4);
    hemisphere.position.set(0, 80, 0);
    this.root.add(hemisphere);

    // 棋盘射灯：这一盏是功能性的。没有它，黑子在黑夜里根本读不出来。
    // 主 key 降为无影补光；投影改由远置平行光负责（影子大小一致）。
    const key = new THREE.SpotLight('#eaf4ff', 0.9, 0, 0.86, 0.5);
    key.position.set(7.5, 15, 8.5);
    key.target.position.set(0, 0, 0);
    key.decay = 0;
    key.castShadow = false;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 2;
    key.shadow.camera.far = 60;
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 3;
    this.root.add(key, key.target);

    // 夜空主投影光：远置平行光，冷色调，影子大小方向处处一致。
    const moon = new THREE.DirectionalLight('#bcd4ff', 1.4);
    // 仰角压到 ~20°：棋子厚径比 0.34，影子伸出轮廓的可见宽度只有
    // 顶高 × cot(仰角) − 半径——28° 时仅 ~0.10 单位（细月牙），
    // 20° 时 ~0.33 单位（直径的 43%），夜色下才读得出完整偏移影。
    moon.position.set(-58, 31, 62);
    moon.target.position.set(0, 0, 0);
    moon.castShadow = true;
    moon.shadow.mapSize.set(2048, 2048);
    moon.shadow.camera.left = -30;
    moon.shadow.camera.right = 30;
    moon.shadow.camera.top = 30;
    moon.shadow.camera.bottom = -30;
    moon.shadow.camera.near = 5;
    moon.shadow.camera.far = 200;
    moon.shadow.bias = -0.0005;
    // normalBias 归零：见 TeaRoom 同款说明（防 peter-panning 漏光亮缝）。
    moon.shadow.normalBias = 0.0;
    moon.shadow.radius = 4;
    this.root.add(moon, moon.target);

    // 两侧补光：一青一紫，协定整场的主色。
    const cyanFill = new THREE.PointLight(CYAN, 1.1, 0, 0);
    cyanFill.position.set(-34, 26, -30);
    const magentaFill = new THREE.PointLight(MAGENTA, 0.95, 0, 0);
    magentaFill.position.set(38, 22, 34);
    this.root.add(cyanFill, magentaFill);
    this.registerFlicker(cyanFill, 1.1, 0);
    this.registerFlicker(magentaFill, 0.95, 2.1);
  }

  private registerFlicker(light: THREE.PointLight, base: number, phase: number): void {
    this.flickers.push({ light, base, phase });
  }

  // ------------------------------------------------------------------
  // 地面与城市
  // ------------------------------------------------------------------

  /** 地面：金属板 PBR 打底 + 一层透明的发光网格罩面。 */
  private buildFloor(): void {
    // 先铺深色金属底（真实钢板贴图），网格光带单独浮在上面一层。
    const geometry = this.track(new THREE.PlaneGeometry(340, 340));
    const material = new THREE.MeshStandardMaterial({
      color: '#1a2029',
      roughness: 0.45,
      metalness: 0.75,
    });
    this.disposables.push(material);
    const floor = new THREE.Mesh(geometry, material);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = FLOOR_Y;
    floor.receiveShadow = true;
    this.root.add(floor);
    this.floorMaterial = material;
    void this.applyFloorTexture();

    // 发光网格罩面：transparent + 加法混合，只留光带，不挡钢板质感。
    const grid = makeCyberFloorTexture();
    grid.repeat.set(14, 12);
    this.disposables.push(grid);
    const overlayMaterial = new THREE.MeshStandardMaterial({
      map: grid,
      emissive: new THREE.Color('#ffffff'),
      emissiveMap: grid,
      emissiveIntensity: 1.0,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      roughness: 0.4,
      metalness: 0.4,
    });
    this.disposables.push(overlayMaterial);
    const overlay = new THREE.Mesh(this.track(new THREE.PlaneGeometry(340, 340)), overlayMaterial);
    overlay.rotation.x = -Math.PI / 2;
    overlay.position.y = FLOOR_Y + 0.06;
    overlay.receiveShadow = false;
    this.root.add(overlay);
  }

  private floorMaterial: THREE.MeshStandardMaterial | null = null;

  /** 钢板贴图：拉丝与铆钉的细节让地面像一块真的金属平台。 */
  private async applyFloorTexture(): Promise<void> {
    const set = await loadPbrTextureSet('metalplate', { x: 18, y: 18 }, { ao: true, anisotropy: 8 }).catch(() => null);
    if (!set || !this.floorMaterial) return;
    this.floorMaterial.map = set.map;
    this.floorMaterial.normalMap = set.normalMap;
    this.floorMaterial.roughnessMap = set.roughnessMap;
    this.floorMaterial.aoMap = set.aoMap;
    this.floorMaterial.color.set('#7e8894');
    this.floorMaterial.needsUpdate = true;
    for (const texture of [set.map, set.normalMap, set.roughnessMap, set.aoMap]) {
      if (texture) this.disposables.push(texture);
    }
  }

  /**
   * 霓虹招牌：一块自发光贴图的平面 + 一盏同色点光源。
   *
   * 贴图负责「看」，点光源负责「照」——只有贴图的话，它周围一切仍是黑的，
   * 看起来像贴纸上写着发光；加上真实光照，光才会真的落到桌面和地砖上。
   */
  private buildNeonSigns(): void {
    const texture = makeNeonSignTexture();
    this.disposables.push(texture);

    const signs: Array<{ position: [number, number, number]; rotationY: number; color: string; base: number }> = [
      { position: [-76, 44, -46], rotationY: 0.62, color: MAGENTA, base: 1.6 },
      { position: [80, 38, -34], rotationY: -0.78, color: CYAN, base: 1.5 },
      { position: [-58, 30, 72], rotationY: Math.PI - 0.5, color: CYAN, base: 1.2 },
      { position: [66, 52, 60], rotationY: -Math.PI + 0.7, color: MAGENTA, base: 1.3 },
    ];

    signs.forEach((sign, index) => {
      const material = new THREE.MeshStandardMaterial({
        map: texture,
        emissive: new THREE.Color(sign.color),
        emissiveMap: texture,
        emissiveIntensity: 1.9,
        roughness: 0.6,
        side: THREE.DoubleSide,
      });
      this.disposables.push(material);
      const panel = this.mesh(new THREE.PlaneGeometry(34, 17), material, this.root, { cast: false });
      panel.position.set(...sign.position);
      panel.rotation.y = sign.rotationY;

      const light = new THREE.PointLight(sign.color, sign.base, 0, 0);
      light.position.set(...sign.position);
      this.root.add(light);
      this.registerFlicker(light, sign.base, index * 1.7);

      // 立地灯杆：城市远景交给 HDRI 后，招牌不再「挂在楼上」，
      // 改成一根从地面顶起来的钢桅杆，夜里只看得见牌子悬在半空。
      const mast = this.material('#101318', { roughness: 0.7, metalness: 0.6 });
      const mastTop = sign.position[1] - 8.5;
      this.cylinder(
        0.5, 0.7, mastTop - FLOOR_Y,
        [sign.position[0], (mastTop + FLOOR_Y) / 2, sign.position[2]],
        mast, 8,
      );
    });
  }

  // ------------------------------------------------------------------
  // 电子樱
  // ------------------------------------------------------------------

  /**
   * 一丛「通电的植物」：街角被霓虹养大的灌木。
   *
   * 这里原本是紫薇（`jacaranda_tree`）扫描件——毕竟「电子樱」听起来就该是棵树。
   * 但那件素材的树叶图元有 **264 万个顶点、145MB**（"1k" 只降贴图，不降面数），
   * 整棵树落地 208MB，比全站其他素材加起来还大一个量级，只能换掉。
   *
   * 现在用 `shrub_02`：五米宽的真实灌木扫描件，5 万个三角形，
   * 把颜色压暗、给叶片一层品红自发光——夜里它就是一丛自己会亮的植物。
   * 在赛博街头，**发光的灌木**其实比一棵写实的樱树更贴题。
   */
  private buildCyberFoliage(x: number, z: number, scale = 1): void {
    void (async () => {
      const model = await loadModel('shrub_02');
      if (!model) return;
      prepareModel(model, 8);

      // 这个素材是四个变体并排摆的，只留一株，否则会在场景里得到四丛花。
      for (const child of [...model.children]) {
        if (!/shrub_02_a$/i.test(child.name)) child.removeFromParent();
      }

      model.traverse((node) => {
        if (!(node instanceof THREE.Mesh)) return;
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        for (const material of materials) {
          if (!(material instanceof THREE.MeshStandardMaterial)) continue;
          // 叶子：压成暗紫，覆一层品红自发光，夜里只看得见轮廓与微光
          material.color.set('#4a2b44');
          material.emissive.set('#ff4fa3');
          material.emissiveIntensity = 0.5;
          material.roughness = 0.92;
          material.metalness = 0;
        }
      });

      fitModel(model, {
        footprint: 26 * scale,
        height: 15 * scale,
        rotationY: x * 0.13,
        groundY: FLOOR_Y,
      });
      model.position.x += x;
      model.position.z += z;
      this.root.add(model);

      const glow = new THREE.PointLight('#ff6fb5', 0.45, 0, 0);
      glow.position.set(x, FLOOR_Y + 10 * scale, z);
      this.root.add(glow);
    })();
  }

  /** 花瓣雪：一颗 Points 承载全部粒子，CPU 只更新位置数组。 */
  private buildPetals(): void {
    const positions = new Float32Array(PETAL_COUNT * 3);
    this.petalSpeeds = new Float32Array(PETAL_COUNT);
    this.petalPhases = new Float32Array(PETAL_COUNT);
    for (let index = 0; index < PETAL_COUNT; index += 1) {
      const base = index * 3;
      positions[base] = (Math.random() - 0.5) * PETAL_AREA * 2;
      positions[base + 1] = FLOOR_Y + Math.random() * PETAL_TOP;
      positions[base + 2] = (Math.random() - 0.5) * PETAL_AREA * 2;
      this.petalSpeeds[index] = 2.4 + Math.random() * 3.4;
      this.petalPhases[index] = Math.random() * Math.PI * 2;
    }

    const geometry = this.track(new THREE.BufferGeometry());
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const texture = makePetalTexture();
    this.disposables.push(texture);
    const material = new THREE.PointsMaterial({
      map: texture,
      color: '#ffb8d8',
      size: 1.45,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
    });
    this.disposables.push(material);

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    this.root.add(points);
    this.petals = points;
  }
}
