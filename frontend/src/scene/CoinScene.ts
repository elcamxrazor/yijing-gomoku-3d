import * as THREE from 'three';

export interface CoinPlayResult {
  /** 先手所在的座位：'a' 或 'b'（与 `OpeningResult.firstSeat` 一致）。 */
  firstSeat: 'a' | 'b';
  /** 两名座位玩家的名字，键 a / b 与 `firstSeat` 对应。 */
  nameA: string;
  nameB: string;
}

/**
 * 一枚会抛、会转、会落定并清晰显示先手玩家的 3D 硬币。
 *
 * 独立于主对局场景（`GomokuScene`）：它只在「开局决定先后手」的瞬间被拉起来，
 * 用一块覆盖全屏的玻璃层把棋盘暂时遮住，落下后朝上的那一面写的名字即为先手者。
 *
 * - 两面分别用 Canvas 纹理绘制两位玩家的名字（黑座 = a 面，白座 = b 面）；
 * - 自带环境光 + 平行光（投影）+ 半球补光，地面用 `ShadowMaterial` 只承接阴影，
 *   让页面背景透出来，融入整体玻璃质感；
 * - 动画分「上抛 + 空中旋转 + 落地停稳」三段，落地后最终指定一面朝上，结果清晰可辨；
 * - 监听容器尺寸，桌面 / 竖屏手机都重新取景；减少动态效果时直接落定。
 */
export class CoinScene {
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly coin: THREE.Mesh;
  private readonly faceA: THREE.MeshStandardMaterial;
  private readonly faceB: THREE.MeshStandardMaterial;
  private readonly ground: THREE.Mesh;
  private rafId = 0;
  private running = false;
  private startTime = 0;
  private lastTimestamp = 0;
  private readonly tossDuration = 1.05;
  private readonly settleDuration = 1.25;
  private readonly coinRadius = 1;
  private readonly coinHeight = 0.22;
  private readonly tossHeight = 3.0;
  private spinX = 0;
  private spinY = 0;
  private readonly spinSpeedX = 16;
  private readonly spinSpeedY = 11;
  private landRotX = 0;
  private landRotY = 0;
  private targetRotX = 0;
  private targetRotY = 0;
  private resolvePlay: (() => void) | null = null;
  private reducedMotion = false;
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;

  constructor(private readonly container: HTMLElement, options?: { reducedMotion?: boolean }) {
    this.reducedMotion = options?.reducedMotion ?? false;
    // 视野必须盖住整段抛物线（峰顶 y≈3.1），否则硬币抛到最高处会被裁切。
    this.camera = new THREE.PerspectiveCamera(46, 1, 0.1, 100);
    this.camera.position.set(0, 2.4, 6.2);
    this.camera.lookAt(0, 1.15, 0);

    // 硬币本体：圆柱，材质顺序为 [侧壁, 顶面(+Y), 底面(-Y)]。
    this.faceA = new THREE.MeshStandardMaterial({ metalness: 0.35, roughness: 0.45 });
    this.faceB = new THREE.MeshStandardMaterial({ metalness: 0.35, roughness: 0.45 });
    const rim = new THREE.MeshStandardMaterial({ color: 0xc9a24b, metalness: 0.9, roughness: 0.28 });
    const geometry = new THREE.CylinderGeometry(this.coinRadius, this.coinRadius, this.coinHeight, 72, 1);
    this.coin = new THREE.Mesh(geometry, [rim, this.faceA, this.faceB]);
    this.coin.castShadow = true;
    this.coin.position.y = this.coinHeight / 2;
    this.scene.add(this.coin);

    // 地面：只承接阴影，自身透明，让页面背景透出。
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.ShadowMaterial({ opacity: 0.32 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    // 光照：环境光打底 + 半球补光 + 一盏带阴影的平行光。
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3026, 0.45));
    const key = new THREE.DirectionalLight(0xfff2d6, 1.15);
    key.position.set(3.5, 8, 4.5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 24;
    key.shadow.camera.left = -5;
    key.shadow.camera.right = 5;
    key.shadow.camera.top = 5;
    key.shadow.camera.bottom = -5;
    key.shadow.bias = -0.0005;
    this.scene.add(key);

    // 渲染器：背景透明，叠加在页面玻璃层之上。
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.container.appendChild(this.renderer.domElement);
      this.renderer.domElement.style.display = 'block';
      this.renderer.domElement.style.width = '100%';
      this.renderer.domElement.style.height = '100%';
    } catch {
      // WebGL 不可用：play() 会直接以结果文案收场，不抛错。
      this.renderer = null;
    }
    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
  }

  /** 用两位玩家的名字重绘硬币两面（a 面 = 黑座，b 面 = 白座）。 */
  private buildFaces(nameA: string, nameB: string): void {
    this.faceA.map = this.makeFaceTexture(nameA, '#1c2024', '#f4f0e7');
    this.faceB.map = this.makeFaceTexture(nameB, '#f4f0e7', '#222831');
    this.faceA.needsUpdate = true;
    this.faceB.needsUpdate = true;
  }

  private makeFaceTexture(name: string, background: string, foreground: string): THREE.CanvasTexture {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    // 圆形盘面。
    ctx.fillStyle = background;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 6, 0, Math.PI * 2);
    ctx.fill();
    // 内圈装饰环。
    ctx.strokeStyle = foreground;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 40, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    // 名字：过长则两行居中。
    ctx.fillStyle = foreground;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const max = 10;
    const lines = this.wrapName(name, max);
    // 字号收一档：132px 时名字几乎铺满盘面，观感像贴了张海报。
    const fontSize = lines.length > 1 ? 64 : 88;
    ctx.font = `600 ${fontSize}px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`;
    const lineHeight = fontSize * 1.08;
    const startY = size / 2 - ((lines.length - 1) * lineHeight) / 2;
    lines.forEach((line, index) => ctx.fillText(line, size / 2, startY + index * lineHeight));
    const texture = new THREE.CanvasTexture(canvas);
    texture.anisotropy = 4;
    texture.needsUpdate = true;
    return texture;
  }

  private wrapName(name: string, max: number): string[] {
    if (name.length <= max) return [name];
    const mid = Math.ceil(name.length / 2);
    return [name.slice(0, mid), name.slice(mid)];
  }

  /** 抛硬币并落定。返回的 Promise 在硬币停稳后 resolve（结果文案由调用方展示）。 */
  play(result: CoinPlayResult): Promise<void> {
    this.buildFaces(result.nameA, result.nameB);
    // 最终朝向：a 面朝上 = 旋转 0；b 面朝上 = 绕 X 翻 180°。
    this.targetRotX = result.firstSeat === 'a' ? 0 : Math.PI;
    this.targetRotY = 0;
    this.spinX = 0;
    this.spinY = 0;
    this.coin.position.y = this.coinHeight / 2;

    if (this.reducedMotion || !this.renderer) {
      this.coin.rotation.set(this.targetRotX, 0, 0);
      this.renderOnce();
      return new Promise((resolve) => {
        this.resolvePlay = resolve;
        window.setTimeout(() => {
          this.resolvePlay = null;
          resolve();
        }, this.reducedMotion ? 700 : 0);
      });
    }

    this.landRotX = 0;
    this.landRotY = 0;
    this.startTime = performance.now();
    this.lastTimestamp = this.startTime;
    this.running = true;
    this.loop(this.startTime);
    return new Promise((resolve) => {
      this.resolvePlay = resolve;
    });
  }

  private readonly loop = (timestamp: number): void => {
    if (!this.running || this.disposed) return;
    const dt = Math.min((timestamp - this.lastTimestamp) / 1000, 0.05);
    this.lastTimestamp = timestamp;
    const elapsed = (timestamp - this.startTime) / 1000;

    if (elapsed < this.tossDuration) {
      const p = elapsed / this.tossDuration;
      // 上抛抛物线：两端在地面、中间到峰顶。
      const y = this.coinHeight / 2 + this.tossHeight * (1 - (2 * p - 1) ** 2);
      this.spinX += this.spinSpeedX * dt;
      this.spinY += this.spinSpeedY * dt;
      this.coin.position.y = y;
      this.coin.rotation.set(this.spinX, this.spinY, 0);
    } else {
      const s = Math.min((elapsed - this.tossDuration) / this.settleDuration, 1);
      const e = 1 - (1 - s) ** 3; // easeOutCubic
      if (s === 0) {
        this.landRotX = this.spinX;
        this.landRotY = this.spinY;
      }
      // 落定：旋转过渡到最终朝向，绕 Y 收到最近的整圈，叠加衰减抖动与落地挤压。
      const deltaX = ((this.targetRotX - this.landRotX) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
      const adjX = deltaX > Math.PI ? deltaX - Math.PI * 2 : deltaX;
      const deltaY = ((this.targetRotY - this.landRotY) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
      const adjY = deltaY > Math.PI ? deltaY - Math.PI * 2 : deltaY;
      this.coin.rotation.x = this.landRotX + adjX * e;
      this.coin.rotation.y = this.landRotY + adjY * e;
      this.coin.rotation.z = Math.sin(s * Math.PI * 6) * 0.12 * (1 - s);
      const squash = s < 0.3 ? 1 - 0.18 * Math.sin((s / 0.3) * Math.PI) : 1;
      this.coin.position.y = (this.coinHeight / 2) * squash;
      this.coin.scale.y = squash;
      if (s >= 1) {
        this.running = false;
        this.resolvePlay?.();
        this.resolvePlay = null;
      }
    }
    this.renderer!.render(this.scene, this.camera);
    if (this.running) this.rafId = requestAnimationFrame(this.loop);
  };

  private renderOnce(): void {
    if (this.renderer) this.renderer.render(this.scene, this.camera);
  }

  /** 容器尺寸变化时重新取景，桌面 / 手机竖屏都保证硬币居中、不溢出。 */
  resize(): void {
    if (!this.renderer) return;
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;
    const aspect = width / height;
    this.camera.aspect = aspect;
    // 竖屏（手机）把相机拉远一点，硬币才不会被上下裁掉。
    const distance = aspect < 1 ? 6.2 / Math.max(aspect, 0.55) : 6.2;
    this.camera.position.set(0, 2.4, distance);
    this.camera.lookAt(0, 1.15, 0);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.renderOnce();
  }

  /** 释放 WebGL 资源与监听，离开开局流程时调用，避免泄漏。 */
  dispose(): void {
    this.disposed = true;
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        const material = object.material;
        if (Array.isArray(material)) material.forEach((item) => item.dispose());
        else material.dispose();
      }
    });
    this.faceA.map?.dispose();
    this.faceB.map?.dispose();
    this.renderer?.dispose();
    if (this.renderer?.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
    this.renderer = null;
  }
}
