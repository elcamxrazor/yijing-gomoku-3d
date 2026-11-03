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
 * 运镜（真实感路线：硬币始终平躺在桌上，靠镜头俯视来读名字）：
 * 1. **抛起段**：镜头拉远、略向上看，保证硬币飞到最高点也不出框；
 * 2. **落地段**：第一次触地挤压 → 两三次逐次变小的弹跳 → 以边缘为支点的晃动衰减；
 * 3. **揭示段**：硬币停稳后镜头推近并俯到约 36°，朝上一面的名字清晰可读。
 *
 * - 两面分别用 Canvas 纹理绘制两位玩家的名字（黑座 = a 面，白座 = b 面）；
 * - 自带环境光 + 平行光（投影）+ 半球补光，地面用 `ShadowMaterial` 只承接阴影；
 * - 监听容器尺寸，桌面 / 竖屏手机都重新取景；减少动态效果时直接落定到揭示机位。
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

  /** 抛起段：从静止到最高点再落回地面。 */
  private readonly tossDuration = 1.05;
  /** 落地段：触地挤压 + 弹跳 + 晃动，硬币在此期间停在桌面附近。 */
  private readonly landDuration = 0.55;
  /** 揭示段：硬币停稳后镜头推近并俯视。 */
  private readonly dollyDuration = 0.55;

  private readonly coinRadius = 1;
  private readonly coinHeight = 0.22;
  private readonly tossHeight = 3.0;
  private spinX = 0;
  private spinY = 0;
  private readonly spinSpeedX = 16;
  private readonly spinSpeedY = 11;
  /** 下落末段收束到的落点朝向（与最终朝向只差整圈）。 */
  private landRotX = 0;
  private landRotY = 0;
  private landingCaptured = false;
  private blendFromRotX = 0;
  private blendFromRotY = 0;
  private targetRotX = 0;
  private resolvePlay: (() => void) | null = null;
  private reducedMotion = false;
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;

  // 两个机位：抛起时看全抛物线，落定后俯视看名字。
  private readonly tossPos = new THREE.Vector3(0, 2.6, 7.6);
  private readonly tossLook = new THREE.Vector3(0, 2.05, 0);
  private readonly revealPos = new THREE.Vector3(0, 2.3, 3.0);
  private readonly revealLook = new THREE.Vector3(0, 0.11, 0);
  private readonly camPos = new THREE.Vector3();
  private readonly camLook = new THREE.Vector3();

  constructor(private readonly container: HTMLElement, options?: { reducedMotion?: boolean }) {
    this.reducedMotion = options?.reducedMotion ?? false;
    this.camera = new THREE.PerspectiveCamera(46, 1, 0.1, 100);
    this.camera.position.copy(this.revealPos);
    this.camera.lookAt(this.revealLook);

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
    // 顶盖 UV 是「U←Z、V←X」，底盖 V 反向；不补偿的话名字会整体转 90°。
    this.faceA.map = this.makeFaceTexture(nameA, '#1c2024', '#f4f0e7', -1);
    this.faceB.map = this.makeFaceTexture(nameB, '#f4f0e7', '#222831', 1);
    this.faceA.needsUpdate = true;
    this.faceB.needsUpdate = true;
  }

  /**
   * 画一面硬币。
   *
   * @param quarterTurn 文字的 90° 补偿方向：顶盖 -1、底盖 +1。
   *   `CylinderGeometry` 的端面 UV 把纹理 U 映射到世界 Z、V 映射到世界 X，
   *   所以直接画横排文字会变成竖排；按面转 90° 才能让名字横向可读。
   */
  private makeFaceTexture(
    name: string,
    background: string,
    foreground: string,
    quarterTurn: -1 | 1,
  ): THREE.CanvasTexture {
    // 1024 而不是 512：揭示段硬币会占到约 300px 宽，2x 屏下 512 会发虚。
    const size = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    // 圆形盘面。
    ctx.fillStyle = background;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 12, 0, Math.PI * 2);
    ctx.fill();
    // 内圈装饰环。
    ctx.strokeStyle = foreground;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 20;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 80, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // 名字：过长先折两行，再按实际宽度缩字号，避免长名字冲出圆盘。
    const family = '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
    const lines = this.wrapName(name, 10);
    let fontSize = lines.length > 1 ? 150 : 200;
    ctx.font = `600 ${fontSize}px ${family}`;
    const widest = Math.max(...lines.map((line) => ctx.measureText(line).width), 1);
    const maxWidth = size * 0.62;
    if (widest > maxWidth) {
      fontSize = Math.max(48, Math.floor((fontSize * maxWidth) / widest));
    }
    const lineHeight = fontSize * 1.08;

    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.rotate(quarterTurn * Math.PI / 2);
    ctx.fillStyle = foreground;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${fontSize}px ${family}`;
    const startY = -((lines.length - 1) * lineHeight) / 2;
    lines.forEach((line, index) => ctx.fillText(line, 0, startY + index * lineHeight));
    ctx.restore();

    const texture = new THREE.CanvasTexture(canvas);
    texture.anisotropy = 8;
    texture.needsUpdate = true;
    return texture;
  }

  private wrapName(name: string, max: number): string[] {
    if (name.length <= max) return [name];
    const mid = Math.ceil(name.length / 2);
    return [name.slice(0, mid), name.slice(mid)];
  }

  /** 抛硬币并落定。返回的 Promise 在硬币停稳、镜头推到揭示机位后 resolve。 */
  play(result: CoinPlayResult): Promise<void> {
    this.buildFaces(result.nameA, result.nameB);
    // 最终朝向：a 面朝上 = 旋转 0；b 面朝上 = 绕 X 翻 180°。
    this.targetRotX = result.firstSeat === 'a' ? 0 : Math.PI;
    this.spinX = 0;
    this.spinY = 0;
    this.landRotX = 0;
    this.landRotY = 0;
    this.landingCaptured = false;
    this.coin.position.set(0, this.coinHeight / 2, 0);
    this.coin.rotation.set(0, 0, 0);
    this.coin.scale.set(1, 1, 1);

    if (this.reducedMotion || !this.renderer) {
      this.coin.rotation.set(this.targetRotX, 0, 0);
      this.applyCamera(this.revealPos, this.revealLook);
      this.renderOnce();
      return new Promise((resolve) => {
        this.resolvePlay = resolve;
        window.setTimeout(() => {
          this.resolvePlay = null;
          resolve();
        }, this.reducedMotion ? 700 : 0);
      });
    }

    this.startTime = performance.now();
    this.lastTimestamp = this.startTime;
    this.running = true;
    this.applyCamera(this.tossPos, this.tossLook);
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
      this.updateToss(elapsed / this.tossDuration, dt);
    } else if (elapsed < this.tossDuration + this.landDuration) {
      this.applyLandingPose((elapsed - this.tossDuration) / this.landDuration);
    } else if (elapsed < this.tossDuration + this.landDuration + this.dollyDuration) {
      this.applyLandingPose(1);
      const d = (elapsed - this.tossDuration - this.landDuration) / this.dollyDuration;
      const e = d * d * (3 - 2 * d); // smoothstep：起止都柔，适合推镜
      this.camPos.lerpVectors(this.tossPos, this.revealPos, e);
      this.camLook.lerpVectors(this.tossLook, this.revealLook, e);
      this.camera.position.copy(this.camPos);
      this.camera.lookAt(this.camLook);
    } else {
      this.applyLandingPose(1);
      this.camPos.copy(this.revealPos);
      this.camLook.copy(this.revealLook);
      this.camera.position.copy(this.camPos);
      this.camera.lookAt(this.camLook);
      this.running = false;
      this.resolvePlay?.();
      this.resolvePlay = null;
    }
    this.renderer!.render(this.scene, this.camera);
    if (this.running) this.rafId = requestAnimationFrame(this.loop);
  };

  /** 抛起段：抛物线 + 高速自旋；最后 18% 把朝向收束到落点姿态，避免落地后还在转。 */
  private updateToss(p: number, dt: number): void {
    const y = this.coinHeight / 2 + this.tossHeight * (1 - (2 * p - 1) ** 2);

    if (p < 0.82) {
      this.spinX += this.spinSpeedX * dt;
      this.spinY += this.spinSpeedY * dt;
      this.coin.rotation.set(this.spinX, this.spinY, 0);
    } else {
      if (!this.landingCaptured) {
        this.landingCaptured = true;
        this.blendFromRotX = this.spinX;
        this.blendFromRotY = this.spinY;
        // 收束到与最终朝向只差整圈的最近角度，视觉上不会「倒转半圈」。
        this.landRotX = this.targetRotX
          + Math.round((this.spinX - this.targetRotX) / (Math.PI * 2)) * Math.PI * 2;
        this.landRotY = Math.round(this.spinY / (Math.PI * 2)) * Math.PI * 2;
      }
      const k = (p - 0.82) / 0.18;
      const e = k * k * (3 - 2 * k);
      this.coin.rotation.set(
        this.blendFromRotX + (this.landRotX - this.blendFromRotX) * e,
        this.blendFromRotY + (this.landRotY - this.blendFromRotY) * e,
        0,
      );
    }
    this.coin.position.y = y;
    this.coin.scale.set(1, 1, 1);
  }

  /**
   * 落地段姿态（u: 0→1）：
   * - 三次触地：首次最高，随后两次逐次变小；
   * - 每次触地叠一个很短的挤压脉冲（厚度压扁）；
   * - 叠加绕 X 的衰减晃动，模拟硬币以边缘为支点晃几下停住。
   */
  private applyLandingPose(u: number): void {
    // 弹跳高度：0 → 0.24 → 0.09 → 0.03 → 0
    let bounce = 0;
    if (u < 0.3) {
      const v = u / 0.3;
      bounce = 0.24 * 4 * v * (1 - v);
    } else if (u < 0.5) {
      const v = (u - 0.3) / 0.2;
      bounce = 0.09 * 4 * v * (1 - v);
    } else if (u < 0.64) {
      const v = (u - 0.5) / 0.14;
      bounce = 0.03 * 4 * v * (1 - v);
    }

    // 每次触地的挤压脉冲（高斯，越往后越轻）。
    const pulse = (center: number, amount: number, width: number): number =>
      amount * Math.exp(-(((u - center) / width) ** 2));
    const squash = Math.max(
      0.78,
      1
        - pulse(0, 0.18, 0.05)
        - pulse(0.3, 0.11, 0.045)
        - pulse(0.5, 0.06, 0.04)
        - pulse(0.64, 0.03, 0.035),
    );

    // 晃动：指数衰减 + 3 次左右的摆动，落地后很快收住。
    const decay = Math.exp(-5.5 * u);
    const wobbleX = 0.085 * decay * Math.sin(u * Math.PI * 2 * 3.2);
    const wobbleZ = 0.04 * decay * Math.sin(u * Math.PI * 2 * 2.4 + 1.1);

    this.coin.rotation.set(this.landRotX + wobbleX, this.landRotY, wobbleZ);
    this.coin.position.y = (this.coinHeight / 2) * squash + bounce;
    this.coin.scale.set(1, squash, 1);
  }

  private applyCamera(position: THREE.Vector3, look: THREE.Vector3): void {
    this.camPos.copy(position);
    this.camLook.copy(look);
    this.camera.position.copy(position);
    this.camera.lookAt(look);
  }

  private renderOnce(): void {
    if (this.renderer) this.renderer.render(this.scene, this.camera);
  }

  /** 容器尺寸变化时重新取景，桌面 / 手机竖屏都保证硬币居中、不溢出。 */
  resize(): void {
    if (!this.renderer) return;
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;
    this.camera.aspect = width / height;
    this.layout();
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    // 没在播放时停在揭示机位（也是减少动态效果时直接展示的姿态）。
    if (!this.running) this.applyCamera(this.revealPos, this.revealLook);
    this.renderOnce();
  }

  /** 按容器宽高比算出两个机位。容器正常是正方形，非方形时按窄边拉远兜底。 */
  private layout(): void {
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;
    const aspect = width / height;
    const k = aspect < 0.9 ? Math.min(1.3, 0.9 / Math.max(aspect, 0.6)) : 1;
    this.tossPos.set(0, 2.6, 7.6 * k);
    this.tossLook.set(0, 2.05, 0);
    this.revealPos.set(0, 2.3 * k, 3.0 * k);
    this.revealLook.set(0, 0.11, 0);
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
