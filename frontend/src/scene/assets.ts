import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

/**
 * 外部素材加载（HDRI、PBR 贴图与 glTF 模型）。
 *
 * ## 素材来源
 *
 * 全部来自 **Poly Haven（https://polyhaven.com）**，均为 **CC0（公有领域）** 授权，
 * 可商用、可修改、无需署名。文件已下载到 `public/` 下随项目分发，
 * 运行时不依赖任何外网请求，离线也能跑。
 *
 * | 用途 | 素材 | 路径 |
 * | --- | --- | --- |
 * | 默认环境光 | Lebombo（室内 HDRI） | `public/hdri/lebombo_1k.hdr` |
 * | 茶室天光 | Studio Kominka（古民家 HDRI） | `public/hdri/studio_kominka_01_1k.hdr` |
 * | 庭院天空 | Chinese Garden（园林 HDRI，兼作 360° 背景） | `public/hdri/chinese_garden_1k.hdr` |
 * | 赛博天际线 | Shanghai Bund（外滩夜景 HDRI，兼作背景） | `public/hdri/shanghai_bund_1k.hdr` |
 * | 茶室地面 | Tatami Mat（榻榻米） | `public/textures/tatami_*.jpg` |
 * | 木构件 | Japanese Cedar Planks（杉木） | `public/textures/cedar_*.jpg` |
 * | 茶桌/庭院桌 | Rosewood / Dark Wood | `public/textures/rosewood_*.jpg`、`darkwood_*.jpg` |
 * | 枯山水砂庭 | Coast Sand（浅色海岸砂） | `public/textures/zensand_*.jpg` |
 * | 赛博地面 | Metal Plate（钢板） | `public/textures/metalplate_*.jpg` |
 * | 棋盘 | 榧木纹（AI 生成，非 Poly Haven） | `public/textures/board_*.jpg` |
 * | 茶具 | Tea Set 01（扫描模型） | `public/models/tea_set_01/` |
 * | 岩石 | Coast Rocks / Boulder（扫描模型） | `public/models/coast_rocks_01/`、`boulder_01/` |
 * | 庭木 / 赛博植物（松/枫/樱共用骨架） | Shrub 02（扫描灌木，4 个变体） | `public/models/shrub_02/` |
 * | 绿植 | Potted Plant 02 | `public/models/potted_plant_02/` |
 * | 棋境桌面陈设 | Book Set / Postcard Set / Camera 01 / Gaming Console / Projector Screen | `public/models/book_set/`、`postcard_set/`、`camera_01/`、`gaming_console/`、`projector_screen/` |
 *
 * 模型统一经 gltf-transform 做 meshopt 简化 + 压缩（树木从 214 MB 压到 12 MB），
 * 因此 GLTFLoader 挂了 MeshoptDecoder 才能解析。
 *
 * ## 为什么加载是「异步但非阻塞」
 *
 * 场景需要同步构建出来（相机、控制器、拾取都依赖它），所以这里不阻塞构造过程：
 * 先用纯色材质把房间搭好，贴图与模型到位后再热替换。用户永远看到的是
 * 一个已经成形的房间，而不是白屏等下载。
 */

const textureLoader = new THREE.TextureLoader();
const gltfLoader = new GLTFLoader();
// 优化过的模型（树木、岩石、茶具）都过了 gltf-transform 的 meshopt 压缩，
// 不解码 GLTFLoader 会在 parse 阶段直接抛「Missing decoder」。
gltfLoader.setMeshoptDecoder(MeshoptDecoder);
const rgbeLoader = new RGBELoader();

export interface PbrTextureSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  /** 环境光遮蔽：让板缝、织纹凹陷处自然变暗，这是「假木头」和「真木头」的主要差别。 */
  aoMap: THREE.Texture | null;
  /** 位移图（这里当凹凸用）：板缝是有深度的沟槽，不是画在平面上的一道线。 */
  displacementMap: THREE.Texture | null;
}

async function loadTexture(
  url: string,
  srgb: boolean,
  repeat: number,
  aniso = 8,
): Promise<THREE.Texture> {
  const texture = await textureLoader.loadAsync(url);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.anisotropy = aniso;
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * 加载一套 PBR 贴图：颜色 + 法线 + 粗糙度 + （可选）AO。
 *
 * 粗糙度与 AO 都是线性数据，绝对不能标成 sRGB，否则表面会整体偏亮。
 * 选项里的 `repeat` 可以分开给横向/纵向，木地板沿板长方向通常要拉得更长。
 */
export async function loadPbrTextureSet(
  prefix: string,
  repeat: number | { x: number; y: number },
  options: { ao?: boolean; displacement?: boolean; anisotropy?: number } = {},
): Promise<PbrTextureSet> {
  const aniso = options.anisotropy ?? 8;
  const rx = typeof repeat === 'number' ? repeat : repeat.x;
  const ry = typeof repeat === 'number' ? repeat : repeat.y;

  const applyRepeat = (texture: THREE.Texture): THREE.Texture => {
    texture.repeat.set(rx, ry);
    return texture;
  };

  const [map, normalMap, roughnessMap, aoMap, displacementMap] = await Promise.all([
    loadTexture(`/textures/${prefix}_diff.jpg`, true, 1, aniso).then(applyRepeat),
    loadTexture(`/textures/${prefix}_nor.jpg`, false, 1, aniso).then(applyRepeat),
    loadTexture(`/textures/${prefix}_rough.jpg`, false, 1, aniso).then(applyRepeat),
    options.ao
      ? loadTexture(`/textures/${prefix}_ao.jpg`, false, 1, aniso).then(applyRepeat)
      : Promise.resolve(null),
    options.displacement
      ? loadTexture(`/textures/${prefix}_disp.jpg`, false, 1, aniso).then(applyRepeat)
      : Promise.resolve(null),
  ]);

  return { map, normalMap, roughnessMap, aoMap, displacementMap };
}

/**
 * 加载 HDRI，同时产出两种形态。
 *
 * 一张 HDR 在两个地方打工：
 * - `environment`：经 PMREM 预滤波后挂到 `scene.environment`，给所有 PBR 材质
 *   提供真实的环境反射与一层柔和的全局照明（这是「像照片」的关键）。
 * - `background`：原始的等距柱状投影图，直接挂 `scene.background` 就是一张
 *   360° 的天空/夜景——庭院的天空、赛博的城市天际线都靠它，比程序化画的
 *   渐变球和楼体盒子真实一个量级。
 *
 * 两种形态共用一次网络加载，调用方按需各取所需。
 */
export interface HdriResult {
  /** PMREM 烘焙出的环境贴图（光照与反射用）。 */
  environment: THREE.Texture;
  /** 等距柱状投影原图（作 scene.background 用）。 */
  background: THREE.Texture;
}

export async function loadHdri(
  renderer: THREE.WebGLRenderer,
  url: string,
): Promise<HdriResult | null> {
  let hdr: THREE.DataTexture | null = null;
  try {
    hdr = await rgbeLoader.loadAsync(url);
  } catch (error) {
    console.warn('[assets] HDRI 加载失败', url, error);
    return null;
  }

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const target = pmrem.fromEquirectangular(hdr);
  pmrem.dispose();

  // 背景用原图：three 允许把等距柱状投影图直接设成 scene.background。
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  return { environment: target.texture, background: hdr };
}

/**
 * 加载 HDRI 环境贴图并烘焙成 PMREM（旧接口，仅取光照用途）。
 *
 * 必须经过 `PMREMGenerator` 预滤波，否则直接塞等距柱状投影图进去，
 * 粗糙度不同的表面会得到错误的反射模糊程度。
 */
export async function loadEnvironment(
  renderer: THREE.WebGLRenderer,
  url = '/hdri/lebombo_1k.hdr',
): Promise<THREE.Texture | null> {
  const result = await loadHdri(renderer, url);
  if (!result) return null;
  // 调用方只要光照贴图，背景原图没有去处，立刻释放省显存。
  result.background.dispose();
  return result.environment;
}

/**
 * 加载 glTF 模型（**单文件 GLB**，手动 fetch + parse）。
 *
 * 这里没有用 `gltfLoader.loadAsync(url)`，而是自己 fetch 出 ArrayBuffer 再交给
 * `parseAsync(buffer, path)`。两个原因：
 *
 * 1. **可诊断**。`loadAsync` 走 `FileLoader`，一旦内部静默卡住就既没有 resolve
 *    也没有 reject，调用方完全看不到发生了什么；手动 fetch 至少能拿到 HTTP 状态、
 *    能包 try/catch，出错时有明确的异常对象。
 * 2. **base path 可控**。模型里的贴图引用是相对路径（`textures/xxx.jpg`），
 *    由第二个参数显式给出基准目录，不依赖 loader 从 URL 里反推。
 *
 * 模型用 GLB 而不是「`.gltf` + 外部 `.bin`」：分体式需要二次请求 `.bin`，
 * 而这一步在本项目实测会静默失败（`.gltf` 200、`.bin` 永不发出）。
 * buffer 内嵌后一次请求拿全几何数据。
 */
export async function loadModel(id: string): Promise<THREE.Object3D | null> {
  const base = `/models/${id}/`;
  try {
    const response = await fetch(`${base}${id}_1k.glb`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const gltf = await gltfLoader.parseAsync(buffer, base);
    return gltf.scene;
  } catch (error) {
    console.warn(`[assets] 模型 ${id} 加载失败`, error);
    return null;
  }
}

/** 兼容旧调用：绿植模型。 */
export function loadPlantModel(id: string): Promise<THREE.Object3D | null> {
  return loadModel(id);
}

/** 给模型内所有网格打开投影/接影，并统一各向异性过滤。 */
export function prepareModel(root: THREE.Object3D, anisotropy = 8): void {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    node.castShadow = true;
    node.receiveShadow = true;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      material.side = THREE.DoubleSide;
      for (const key of ['map', 'normalMap', 'roughnessMap', 'aoMap', 'alphaMap'] as const) {
        const texture = material[key];
        if (texture) texture.anisotropy = anisotropy;
      }
    }
  });
}

/**
 * 把模型按目标尺寸装箱：缩放到指定长边、底面贴地、可指定朝向。
 *
 * glTF 模型的原始单位五花八门（米、毫米、厘米都有），所以这里一律用
 * 包围盒反推缩放比，而不是假设某个固定比例。
 */
export function fitModel(
  model: THREE.Object3D,
  options: {
    /** 目标「最长水平边」的长度（世界单位）。 */
    footprint: number;
    /** 目标高度；给了就优先保证高度，否则只按 footprint 缩放。 */
    height?: number;
    /** 绕 Y 轴旋转（弧度）。 */
    rotationY?: number;
    /** 落地高度，默认 0。 */
    groundY?: number;
  },
): void {
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  box.getSize(size);

  const horizontal = Math.max(size.x, size.z) || 1;
  const scale = options.height
    ? options.height / (size.y || 1)
    : options.footprint / horizontal;

  model.scale.setScalar(scale);
  model.rotation.y = options.rotationY ?? 0;

  // 重新计算一次（缩放后）的包围盒，把模型底面精确放到地面上。
  model.updateMatrixWorld(true);
  const scaled = new THREE.Box3().setFromObject(model);
  model.position.y += (options.groundY ?? 0) - scaled.min.y;

  // 水平居中：glTF 的局部原点不一定在几何中心。
  const center = new THREE.Vector3();
  scaled.getCenter(center);
  model.position.x -= center.x;
  model.position.z -= center.z;
}
