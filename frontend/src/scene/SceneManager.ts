import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { Environment, IntroDescriptor } from './environments/Environment';
import { loadHdri } from './assets';
import { Easing, TweenManager } from './animation/tween';
import { beginIntro, endIntro } from '../ui/introGate';
import {
  BOARD_SURFACE_Y,
  BOARD_WIDTH,
  CAMERA_FOV,
  CAMERA_FOV_PORTRAIT,
  CAMERA_POSITION,
  FRAMING_MARGIN,
  PALETTE,
  VIEW_INSETS,
} from './config';

export interface SceneManagerOptions {
  /** 系统是否要求「减少动态效果」。开启后关掉阻尼与补间动画。 */
  reducedMotion: boolean;
}

/**
 * 场景管理：负责渲染器、相机、轨道控制器与主渲染循环。
 *
 * 它不关心棋盘和房间长什么样——那些由 `BoardManager` 与 `Environment`
 * 往 `this.scene` 里挂对象。三者只通过本类暴露的 `scene` / `camera` / `tweens`
 * 通信，避免互相引用形成环。
 *
 * 棋床（环境）是可以换的：三个预设各说出自己的背景色、雾、曝光、推镜起点与
 * 「相机最远能退到哪」。这些由 {@link SceneManager.applyEnvironment} 一次性接过来，
 * 场景本身只为「下一个环境」服务，不替任何一个环境记住状态。
 */
export class SceneManager {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;
  /** 全局补间队列，落子动画与涟漪都挂在这里。 */
  readonly tweens = new TweenManager();

  private readonly container: HTMLElement;
  private readonly reducedMotion: boolean;
  private readonly resizeObserver: ResizeObserver;
  private readonly frameCallbacks: Array<(now: number) => void> = [];
  private animationFrame = 0;
  private disposed = false;
  /** 用户是否手动调整过视角；调整过之后窗口变化就不再强行复位取景方向。 */
  private userAdjusted = false;
  /** 推镜进行中：此时不要因为 resize 打断相机动线。 */
  private introPlaying = false;
  /** 复位视角动画进行中：同样不要被 resize 打断。 */
  private resetPlaying = false;
  /** PMREM 烘焙出的环境贴图，销毁时单独释放（它不在 scene 的节点树里）。 */
  private environmentTexture: THREE.Texture | null = null;
  /**
   * 每个环境各用一张 HDRI（茶室=古民家室内、庭院=中式园林、赛博=外滩夜景）。
   * 按 URL 缓存：环境在生命周期里会被反复换进换出，同一张图只加载烘焙一次。
   */
  private readonly hdriCache = new Map<string, { environment: THREE.Texture; background: THREE.Texture }>();
  /** 正在加载中的 HDRI（避免切环境时重复发请求）。 */
  private readonly hdriPending = new Map<string, Promise<void>>();
  /** 当前作为背景显示的 HDRI 原图路径；纯色背景时为 null。 */
  private backgroundHdriUrl: string | null = null;
  /** 后处理链：渲染 → 泛光 → 输出（色调映射 + sRGB 都在 OutputPass 里收尾）。 */
  private readonly composer: EffectComposer;
  private readonly bloomPass: UnrealBloomPass;
  /** 当前环境提出的诉求：背景、雾、曝光、推镜起点、相机最远距离。 */
  private background = new THREE.Color(PALETTE.background);
  private fog: THREE.Fog | null = null;
  private environmentIntensity = 0.46;
  private exposure = 0.94;
  private intro: IntroDescriptor | null = null;
  private maxDistance = 56;
  /**
   * 当前挂在本管理器上的环境实例。
   *
   * 存它不是为了改它的几何——几何由环境自己 `scene.add` 进去——而是为了让主循环
   * 能把每帧回调转给它：樱花花瓣飘落、霓虹呼吸这类动效放在环境内部最自然，
   * 但「画还是不画」得由 SceneManager 说了算（见 {@link tick} 的限帧逻辑）。
   */
  private environment: Environment | null = null;

  constructor(container: HTMLElement, options: SceneManagerOptions) {
    this.container = container;
    this.reducedMotion = options.reducedMotion;

    // ---- 渲染器 -------------------------------------------------------
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    // 移动端 / 高分屏上限压到 2，否则 4K 屏会让片元着色开销翻几倍直接掉帧。
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    // PCFSoftShadowMap：阴影边缘做多点采样，避免硬邦邦的锯齿。
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.94;
    this.renderer.domElement.setAttribute('aria-label', '三维五子棋棋盘，点击交叉点落子');
    this.renderer.domElement.setAttribute('role', 'img');
    container.append(this.renderer.domElement);

    // ---- 背景 ---------------------------------------------------------
    // 低饱和暖灰兜底：任何环境上膛之前（或环境没给雾的空档）看到的是它而不是纯黑。
    // 真正的背景色由 { Environment.background} 在 applyEnvironment 里顶掉。
    this.scene.background = this.background;

    // 曝光先给默认值，环境接手后按自己的昼夜改。
    this.renderer.toneMappingExposure = this.exposure;

    // ---- 环境光照（HDRI）----------------------------------------------
    // 不再在构造时固定加载某一张：三个棋境各用各的天光（古民家室内 / 中式园林 /
    // 外滩夜景），统一由 applyEnvironment → useHdri 按环境加载并缓存。
    // 第一张图到位前靠纯灯光照明，不会阻塞首帧。

    // ---- 相机 ---------------------------------------------------------
    // 第三人称斜视角：比纯俯视更能体现棋子的立体感与投影。
    // 远平面给到 2400：庭院的 360° 实景天空与赛博的城市天际线都在「无穷远」，
    // 旧的 200 会把它们整体裁掉，转个头背景就黑了。
    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 2400);
    this.camera.position.set(CAMERA_POSITION.x, CAMERA_POSITION.y, CAMERA_POSITION.z);
    this.camera.lookAt(0, 0, 0);

    // ---- 轨道控制器 ---------------------------------------------------
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 0);
    this.controls.enablePan = false;
    this.controls.enableDamping = !options.reducedMotion;
    this.controls.dampingFactor = 0.075;
    this.controls.rotateSpeed = 0.5;
    this.controls.zoomSpeed = 0.6;
    this.controls.minDistance = 16.5;
    this.controls.maxDistance = 31;
    // 极角限制：下限保留 0.02rad 而不是 0——视线与 up 完全平行时 lookAt 会退化；
    // 上限 1.05rad(≈60°) 保证相机永远不会沉到棋盘平面以下。
    this.controls.minPolarAngle = 0.02;
    this.controls.maxPolarAngle = 1.05;
    // 方位角完全放开：房间四面墙、天花都做齐了，玩家可以 360° 环绕观察棋局。
    this.controls.minAzimuthAngle = -Infinity;
    this.controls.maxAzimuthAngle = Infinity;

    // 鼠标：左键留给「点击落子」，不能同时被控制器拿去旋转；
    // 右键拖动旋转视角，中键滚轮缩放。
    this.controls.mouseButtons = {
      LEFT: null,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.ROTATE,
    };
    // 触摸：单指留给落子，双指捏合缩放 + 旋转。
    this.controls.touches = {
      ONE: null,
      TWO: THREE.TOUCH.DOLLY_ROTATE,
    };

    // OrbitControls 在用户开始拖拽/缩放时派发 start，用来标记「视角已被手动调整」。
    this.controls.addEventListener('start', this.onControlStart);

    // ---- 后处理：泛光 -------------------------------------------------
    // 链：RenderPass（线性 HDR）→ UnrealBloomPass（高光溢出）→ OutputPass
    // （统一做 ACES 色调映射 + sRGB 输出）。霓虹「溢出来」的光晕、日光下白砂的
    // 柔光都靠中间那站；没有它，自发光材质再亮也只是一块平色。
    //
    // 渲染目标自带 4x MSAA：composer 离屏渲染不吃画布的 antialias，不补这一手
    // 棋盘边线会全是锯齿。
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const renderTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: 4,
    });
    this.composer = new EffectComposer(this.renderer, renderTarget);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0, 0.55, 1);
    // 默认关闭——只有声明了 bloom 的环境才打开，避免白天场景过曝。
    this.bloomPass.enabled = false;
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();
    this.start();
    // 仅供自动化测试读取相机位姿（?debugcam=1 时暴露），正常访问不挂载任何东西。
    if (new URLSearchParams(location.search).has('debugcam')) {
      (window as unknown as Record<string, unknown>).__camPose = () => ({
        pos: this.camera.position.toArray(),
        tgt: this.controls.target.toArray(),
        fov: this.camera.fov,
        rp: this.resetPlaying,
        ip: this.introPlaying,
        tw: this.tweens.size,
      });
    }
  }

  /** 注册每帧回调（在渲染之前执行），返回取消订阅函数。 */
  onFrame(callback: (now: number) => void): () => void {
    this.frameCallbacks.push(callback);
    return () => {
      const index = this.frameCallbacks.indexOf(callback);
      if (index >= 0) this.frameCallbacks.splice(index, 1);
    };
  }

  /**
   * 接手一个环境的全局设定：背景、雾、环境光强度、曝光、推镜起点、相机上限。
   *
   * 这一步必须走本类而不是让环境直接改 `scene`：三个环境在整个生命周期里
   * 会被反复换进换出（建房时选、开局随机到、加入别人的房间时跟随），
   * 「旧环境留下的雾」必须由唯一知道前后是谁的一方清掉。
   *
   * 同时记得通报一次阴影——换环境等于增删了一大批投影体，而静止时
   * `shadowMap.autoUpdate` 是关着的，不点这一下会留下上一套家具的影子。
   */
  applyEnvironment(environment: Environment): void {
    this.environment = environment;
    this.background = new THREE.Color(environment.background);
    this.fog = environment.fog;
    this.scene.fog = this.fog;
    this.environmentIntensity = environment.environmentIntensity;
    if (this.environmentTexture) this.scene.environmentIntensity = this.environmentIntensity;
    this.exposure = environment.exposure;
    this.renderer.toneMappingExposure = this.exposure;
    this.intro = environment.intro;
    this.maxDistance = environment.maxDistance;

    // 泛光按环境开关：赛博的霓虹靠它发光，日景只留一丝柔光。
    this.bloomPass.strength = environment.bloom;
    this.bloomPass.threshold = environment.bloomThreshold;
    this.bloomPass.enabled = environment.bloom > 0;

    // HDRI 背景：贴图到位前先用纯色兜底，到位后换成 360° 实景。
    // 若环境不用 HDRI 作背景，立刻还原成色（否则上一个环境的天空会残留）。
    this.backgroundHdriUrl = environment.hdriBackground ? environment.hdri : null;
    this.scene.background = this.background;
    this.scene.backgroundIntensity = 1;

    // 切换光照来源的 HDRI（不同环境用不同的天光）。
    const hdriUrl = environment.hdri ?? SceneManager.DEFAULT_HDRI;
    void this.useHdri(hdriUrl, environment);

    this.invalidateShadows();
    this.resetView();
  }

  /** 没声明专属 HDRI 的环境共用的默认室内 HDRI。 */
  private static readonly DEFAULT_HDRI = '/hdri/lebombo_1k.hdr';

  /**
   * 让指定 HDRI 成为当前环境光（按需加载 + 缓存）。
   *
   * 三个环境在生命周期里反复切换，所以加载结果按 URL 缓存下来；
   * 「当前该显示哪张」以本方法最后一次被调用的参数为准——旧请求晚回来
   * 也不能把刚换好的环境又顶回去（慢网络下快速切环境的竞态）。
   */
  private async useHdri(url: string, environment: Environment): Promise<void> {
    const apply = (entry: { environment: THREE.Texture; background: THREE.Texture }): void => {
      // 环境已经又换了一轮，这次的加载结果不再适用。
      if (this.disposed || this.environment !== environment) return;
      this.scene.environment = entry.environment;
      this.environmentTexture = entry.environment;
      this.scene.environmentIntensity = this.environmentIntensity;
      if (this.backgroundHdriUrl === url) {
        this.scene.background = entry.background;
        this.scene.backgroundIntensity = environment.backgroundIntensity;
      }
      this.invalidateShadows();
    };

    const cached = this.hdriCache.get(url);
    if (cached) {
      apply(cached);
      return;
    }

    let pending = this.hdriPending.get(url);
    if (!pending) {
      pending = loadHdri(this.renderer, url).then((result) => {
        this.hdriPending.delete(url);
        if (!result) return;
        if (this.disposed) {
          result.environment.dispose();
          result.background.dispose();
          return;
        }
        this.hdriCache.set(url, result);
      });
      this.hdriPending.set(url, pending);
    }
    await pending;
    const entry = this.hdriCache.get(url);
    if (entry) apply(entry);
  }

  /** 当前生效的推镜描述符；没有环境条件时用茶室的保守远景。 */
  private introDescriptor(): IntroDescriptor {
    return (
      this.intro ?? {
        position: [58, 44, 48],
        target: [-4, 4, -6],
      }
    );
  }

  /**
   * 请阴影贴图重画一次。
   *
   * 画面静止时 `shadowMap.autoUpdate` 是关掉的（见 `tick`），这是省 GPU 的关键。
   * 但由此带来一个副作用：此时删掉一颗棋子，它在棋盘上的影子**不会**跟着消失，
   * 因为那张阴影图还停在上一帧。凡是增删了会投影的物体（棋子、家具），
   * 都必须在这里点一下，否则就会出现「终局后棋子没了，影子还印在桌上」。
   */
  invalidateShadows(): void {
    this.renderer.shadowMap.needsUpdate = true;
  }

  /**
   * 把相机复位到初始的第三人称斜视角，并按当前视口重新取景。
   *
   * 不是「啪」地瞬切——用现成的 `TweenManager` 把相机从当前机位、目标点、视场
   * 一起补间到默认斜视角，约 0.65 秒缓入缓出。玩家点复位按钮时能感到相机「滑」
   * 回原位，而不是硬跳。减动效偏好下退回瞬切。
   */
  resetView(): void {
    this.userAdjusted = false;
    this.introPlaying = false;
    this.controls.target.set(0, 0, 0);

    const endDirection = this.defaultDirection();
    const endTarget = this.controls.target.clone();
    const endDistance = this.fitDistance(endDirection);
    const endPosition = endTarget.clone().addScaledVector(endDirection, endDistance);
    const endFov = this.targetFov();

    // 动画期间锁住控制器，避免和阻尼/用户的拖拽抢相机；结束再交还。
    // 复位视角动画刻意不尊重 reducedMotion——这是玩家主动触发的视图导航，
    // 短促的缓动有助于空间定位，不属于「减少动态效果」要压制的非必要炫动。
    this.resetPlaying = true;
    this.controls.enabled = false;
    const startPosition = this.camera.position.clone();
    const startTarget = this.controls.target.clone();
    const startFov = this.camera.fov;
    this.tweens.add({
      duration: 650,
      easing: Easing.easeInOutCubic,
      onUpdate: (progress) => {
        this.camera.position.lerpVectors(startPosition, endPosition, progress);
        this.controls.target.lerpVectors(startTarget, endTarget, progress);
        this.camera.fov = startFov + (endFov - startFov) * progress;
        this.camera.updateProjectionMatrix();
        this.camera.lookAt(this.controls.target);
      },
      onComplete: () => {
        this.resetPlaying = false;
        this.controls.enabled = true;
        this.userAdjusted = false;
        // 收尾吸附到精确取景（重算缩放范围 + 纵向补偿）。
        this.applyFraming(endDirection);
      },
    });
  }

  /**
   * 开局推镜：从环境给出的远景机位推进到棋盘取景，结束后交还 OrbitControls。
   *
   * 用的是项目自带的 `TweenManager` 而不是 gsap：整个工程只有这一处相机动画，
   * 为此多引一个运行时依赖不划算；现有引擎已经支持缓动函数与串接，够用。
   *
   * 起点定在房间的一个前侧角落，目标点从房间中部（能看见障子窗、床の間）
   * 逐步收到棋盘中心，庭院则从屋檐上俯下来，赛博房从霓虹深处亮起来——
   * 形成「先看身处何处，再坐下来对弈」的叙事。
   */
  playIntro(): void {
    this.introPlaying = true;
    this.controls.enabled = false;

    const endDirection = this.defaultDirection();
    const endDistance = this.fitDistance(endDirection);
    const endPosition = this.controls.target.clone().addScaledVector(endDirection, endDistance);
    const endTarget = this.controls.target.clone();

    // 起始机位由环境给出（默认那个是茶室的房间对角线），有一点很重要：
    // 房间 150 单位宽，而相机受 maxDistance 限制最远只能退到 56 单位，
    // 46° 的视场在 90 单位距离上只装得下 76 单位宽的景物——永远框不进
    // 整面障子窗。所以远景帧默认改用 64° 广角，推进过程中再收窄回 46°：
    // 广角负责「把房间装进来」，变焦负责「推进感」。
    // 这是电影里标准的推轨 + 变焦，比单纯平移镜头更有「走进去」的体感。
    const descriptor = this.introDescriptor();
    const startPosition = new THREE.Vector3(...descriptor.position);
    const startTarget = new THREE.Vector3(...descriptor.target);
    const startFov = descriptor.fov ?? 64;
    const duration = descriptor.duration ?? 5400;

    if (this.reducedMotion) {
      this.applyFraming(endDirection);
      this.introPlaying = false;
      this.controls.enabled = true;
      return;
    }

    // 这 5.4 秒把 HUD 与开场 toast 全部让位，环境镜头才干净（见 ui/introGate.ts）。
    beginIntro(duration);

    // 直接切到远景再推进。切的那一帧正好被首页遮罩的淡出盖住，
    // 比「先拉远再推进」少一次多余的运动，动线更干净。
    this.camera.position.copy(startPosition);
    this.controls.target.copy(startTarget);
    this.camera.fov = startFov;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(startTarget);

    this.tweens.add({
      // 5.4 秒：从远景缓缓推到棋盘正上方。要的是「坐定、静下来」的节奏，
      // 太快就变成过场动画，反而打断进入对局的心境。
      duration,
      easing: Easing.easeInOutCubic,
      onUpdate: (progress) => {
        this.camera.position.lerpVectors(startPosition, endPosition, progress);
        this.controls.target.lerpVectors(startTarget, endTarget, progress);
        this.camera.fov = startFov + (this.targetFov() - startFov) * progress;
        this.camera.updateProjectionMatrix();
        this.camera.lookAt(this.controls.target);
      },
      onComplete: () => {
        this.introPlaying = false;
        this.userAdjusted = false;
        this.controls.enabled = true;
        this.applyFraming(endDirection);
        endIntro();
      },
    });
  }

  private readonly onControlStart = (): void => {
    this.userAdjusted = true;
  };

  /** 当前宽高比下的默认机位方向：正俯拍。 */
  private defaultDirection(): THREE.Vector3 {
    return new THREE.Vector3(CAMERA_POSITION.x, CAMERA_POSITION.y, CAMERA_POSITION.z).normalize();
  }

  /** 当前宽高比对应的目标视场：竖屏放宽，避免棋盘被横向裁掉。 */
  private targetFov(): number {
    return this.camera.aspect < 1 ? CAMERA_FOV_PORTRAIT : CAMERA_FOV;
  }

  /**
   * 根据容器尺寸同步画布与相机。
   *
   * 不只改画布大小，还会重新计算取景距离——窗口一变，棋盘的合适距离就变了。
   * 当前视角方向会被保留，只有距离被重算，所以旋转过的视角不会被强行拉回。
   */
  resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(width, height, false);
    // 后处理链也要跟着变：渲染目标不 resize，画面会拉伸或糊掉。
    this.composer.setSize(width, height);

    const aspect = width / height;
    this.camera.aspect = aspect;
    this.camera.fov = aspect < 1 ? CAMERA_FOV_PORTRAIT : CAMERA_FOV;
    this.camera.updateProjectionMatrix();

    // 推镜 / 复位动画进行中不要插手续算，否则相机会被拉回终点。
    if (this.introPlaying || this.resetPlaying) return;

    // 用户没动过视角时，横竖屏切换应该换成该比例下的最佳机位；
    // 动过就保留他的角度，只重算距离。
    const direction = this.userAdjusted
      ? this.camera.position.clone().sub(this.controls.target).normalize()
      : this.defaultDirection();
    this.applyFraming(direction);
  }

  /** 沿给定方向摆好相机，并把缩放范围锁在取景距离附近。 */
  private applyFraming(direction: THREE.Vector3): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);

    // 每次取景都从无偏移状态开始，避免多次调用叠加。
    this.camera.clearViewOffset();

    const distance = this.fitDistance(direction);
    this.camera.position.copy(this.controls.target).addScaledVector(direction, distance);
    this.camera.lookAt(this.controls.target);
    this.camera.updateMatrixWorld(true);

    // 透视下棋盘近端被放大、远端被压缩，投影包围盒并不是以视口中心对称的。
    // 只按距离缩放会留下「上边空一大块、下边贴边」的观感，所以再补一次纵向平移。
    const shift = this.verticalShift();
    if (Math.abs(shift) > 0.5) {
      this.camera.setViewOffset(width, height, 0, -shift, width, height);
    }

    this.controls.minDistance = distance * 0.55;
    // 上限由环境说了算：茶室是封闭房间，相机一旦穿墙就看到外面的世界，
    // 56 能保证任何方位角下都在室内；庭院露天，可以放到 72 让相机退开看全景。
    this.controls.maxDistance = Math.max(distance * 1.8, this.maxDistance);
    this.controls.update();
  }

  /** 棋盘八个角点，取景与垂直补偿都以它为准。 */
  private framingCorners(): THREE.Vector3[] {
    const half = (BOARD_WIDTH / 2) * FRAMING_MARGIN;
    const corners: THREE.Vector3[] = [];
    for (const x of [-half, half]) {
      for (const z of [-half, half]) {
        corners.push(new THREE.Vector3(x, BOARD_SURFACE_Y, z));
        corners.push(new THREE.Vector3(x, 0, z));
      }
    }
    return corners;
  }

  /**
   * 棋盘投影包围盒的中心相对安全区中心还要往下挪多少像素（正值往下）。
   */
  private verticalShift(): number {
    const height = Math.max(1, this.container.clientHeight);
    this.camera.updateMatrixWorld(true);

    let minY = Infinity;
    let maxY = -Infinity;
    for (const corner of this.framingCorners()) {
      const projected = corner.clone().project(this.camera);
      const pixelY = ((1 - projected.y) / 2) * height;
      minY = Math.min(minY, pixelY);
      maxY = Math.max(maxY, pixelY);
    }

    const currentCenter = (minY + maxY) / 2;
    const safeCenter = (VIEW_INSETS.top + (height - VIEW_INSETS.bottom)) / 2;
    return safeCenter - currentCenter;
  }

  /**
   * 计算「刚好把棋盘塞进安全区」的相机距离。
   *
   * 做法是迭代测量：先把相机放到一个估计距离上，把棋盘八个角投影到 NDC，
   * 看横竖哪个方向超出得更厉害，就把距离按比例放大，重复几次即收敛。
   * 直接解析求解会受透视影响（近端比远端放大得多），迭代法更稳。
   */
  private fitDistance(direction: THREE.Vector3): number {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);

    // 安全区占 NDC 的比例（NDC 范围是 -1..1，所以要乘 2）
    const budgetX = Math.max(0.3, 1 - (VIEW_INSETS.side * 2) / width);
    const budgetY = Math.max(0.3, 1 - (VIEW_INSETS.top + VIEW_INSETS.bottom) / height);

    const corners = this.framingCorners();
    const camera = this.camera;
    let distance = 22;
    for (let iteration = 0; iteration < 4; iteration += 1) {
      camera.position.copy(this.controls.target).addScaledVector(direction, distance);
      camera.lookAt(this.controls.target);
      camera.updateMatrixWorld(true);

      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const corner of corners) {
        const projected = corner.clone().project(camera);
        minX = Math.min(minX, projected.x);
        maxX = Math.max(maxX, projected.x);
        minY = Math.min(minY, projected.y);
        maxY = Math.max(maxY, projected.y);
      }

      // 用包围盒的「半宽/半高」，而不是 max(|x|,|y|)。
      // 棋盘近端被透视放大后包围盒是偏心的，直接取绝对值会算出偏大的距离，
      // 结果就是棋盘缩得比安全区小一圈、四周留白。
      const halfX = (maxX - minX) / 2;
      const halfY = (maxY - minY) / 2;
      distance *= Math.max(halfX / budgetX, halfY / budgetY);
    }
    return distance;
  }

  start(): void {
    if (this.animationFrame !== 0 || this.disposed) return;
    this.animationFrame = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (this.animationFrame !== 0) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
  }

  dispose(): void {
    this.disposed = true;
    endIntro(); // 推镜被销毁打断时别把 HUD 永久藏起来
    this.stop();
    this.resizeObserver.disconnect();
    this.controls.removeEventListener('start', this.onControlStart);
    this.controls.dispose();
    this.tweens.clear();
    this.frameCallbacks.length = 0;

    // 统一在这里释放几何体与材质，子模块不必各自遍历一遍。
    this.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.Sprite)) return;
      const disposable = object as THREE.Mesh | THREE.Sprite;
      disposable.geometry?.dispose();
      const materials = Array.isArray(disposable.material)
        ? disposable.material
        : [disposable.material];
      materials.forEach((material) => {
        if (!material) return;
        const map = (material as THREE.MeshStandardMaterial).map;
        map?.dispose();
        material.dispose();
      });
    });
    this.scene.clear();

    this.environmentTexture?.dispose();
    this.environmentTexture = null;
    this.scene.environment = null;
    // 缓存的各环境 HDRI 与后处理链一并释放。
    for (const entry of this.hdriCache.values()) {
      entry.environment.dispose();
      entry.background.dispose();
    }
    this.hdriCache.clear();
    this.composer.dispose();

    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  /**
   * 主循环：补间 → 业务回调 → 控制器阻尼 → 渲染。
   *
   * ## 为什么要限帧
   *
   * `requestAnimationFrame` 的节奏由显示器决定：144Hz 屏上这个循环会实打实跑 144 次/秒。
   * 画面内容完全一样（相机没动、棋子没动），多出来的每一帧都是白烧的 GPU，
   * 直接表现就是显卡风扇转起来。iOS / Android 上还会明显耗电发热。
   *
   * 这里分两档，都是「上限」而不是固定值：
   * - **有运动**（相机在动、或者还有补间在播）→ 60fps
   * - **静止**（相机 0.9 秒没动、补间队列为空）→ 30fps
   *
   * 静止画面肉眼分不出 30 和 60，但 GPU 占用直接砍半。
   * 同时把 `shadowMap.autoUpdate` 一起关掉——两张 2048² 的阴影图每帧重画是这个场景
   * 最贵的一笔开销，而静止时阴影内容根本不会变。
   */
  private readonly maxFps = 60;
  private readonly idleFps = 30;
  /** 上一帧实际绘制的时刻，用来算「到点没有」。 */
  private lastFrameAt = 0;
  /** 最近一次检测到「画面在动」的时刻。 */
  private lastMotionAt = 0;
  /** 相机状态指纹，用来判断这一帧和上一帧有没有区别。 */
  private motionSignature = '';
  /** 当前阴影是否处于每帧更新状态，避免反复写 `autoUpdate`。 */
  private shadowsLive = true;

  /**
   * 判断画面是否还在动。
   *
   * 有两类「动」：一是相机位姿在变（用户拖拽、补间推镜、阻尼惯性），
   * 二是有补间正在播（落子下坠、挤压回弹、涟漪扩散）。
   * 后者不一定改变相机，所以必须单独判一次，否则棋子下落时阴影会僵在原地。
   */
  private hasMotion(now: number): boolean {
    if (this.tweens.size > 0) {
      this.lastMotionAt = now;
      return true;
    }
    const camera = this.camera;
    const signature =
      `${camera.position.x.toFixed(3)},${camera.position.y.toFixed(3)},${camera.position.z.toFixed(3)},` +
      `${camera.quaternion.x.toFixed(4)},${camera.quaternion.y.toFixed(4)},` +
      `${camera.quaternion.z.toFixed(4)},${camera.quaternion.w.toFixed(4)},` +
      `${camera.fov.toFixed(2)}`;
    if (signature !== this.motionSignature) {
      this.motionSignature = signature;
      this.lastMotionAt = now;
      return true;
    }
    // 留 0.9 秒缓冲：阻尼停下来的最后几帧位移已经小到指纹不变，
    // 立刻降帧会让收尾显得顿一下。
    return now - this.lastMotionAt < 900;
  }

  private readonly tick = (): void => {
    if (this.disposed) return;
    this.animationFrame = requestAnimationFrame(this.tick);
    const now = performance.now();

    const busy = this.hasMotion(now);
    const interval = 1000 / (busy ? this.maxFps : this.idleFps);
    // 减 1.2ms 是给浮点误差留余量：60Hz 屏的 rAF 间隔正好 16.67ms，
    // 严格比较会因为差 0.01ms 就被判成「还没到点」，结果每两帧才画一次，
    // 直接掉到 30fps——限帧限成了掉帧。
    if (now - this.lastFrameAt < interval - 1.2) return;
    this.lastFrameAt = now;

    // 阴影只在「画面对不上」的时候重画：从静止切回运动的那一帧强制刷一次，
    // 之后交给 autoUpdate 逐帧跟进。
    if (busy !== this.shadowsLive) {
      this.shadowsLive = busy;
      this.renderer.shadowMap.autoUpdate = busy;
      if (busy) this.renderer.shadowMap.needsUpdate = true;
    }

    this.tweens.update(now);
    // 兜底：复位动画若因故没走完 onComplete（例如补间被清理），在确认没有相机
    // 动画进行时收回 resetPlaying，避免它永久卡住 resize() 的取景重算。
    if (!this.introPlaying && this.resetPlaying && this.tweens.size === 0) {
      this.resetPlaying = false;
    }
    // 环境自带的时间动画（樱花飘落、霓虹呼吸）：放在这里而不是环境内部自己
    // 开 rAF，是为了让它跟着 SceneManager 的限帧一起走，静止时降到 30fps。
    this.environment?.onFrame(now);
    for (const callback of this.frameCallbacks) callback(now);

    this.controls.update();
    // 走 EffectComposer：RenderPass 内部还是调 renderer.render，
    // 之后经泛光与 OutputPass（ACES 色调映射 + sRGB）合成到画布。
    this.composer.render();
  };
}
