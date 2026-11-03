import * as THREE from 'three';
import { Easing } from './animation/tween';
import type { TweenManager } from './animation/tween';
import { TABLE_SURFACE_Y } from './config';

/**
 * 桌上那枚铜铃（桌面按铃）。
 *
 * 它是「敲一下」这个动作在三维世界里的落点：棋盘上没有催促按钮，只有这枚铃。
 * 按铃不改变任何棋局状态，所以它只负责两件事——**看起来像被按了一下**，
 * 以及告诉外面「有人按了铃」。
 *
 * 为什么是「按铃」而不是挂在架子上的手摇铃：默认机位近乎正俯拍，手摇铃的提手
 * 在整个画面里只是一条线，看上去像一颗金蛋。桌面按铃在正上方看是「圆顶 + 按钮
 * + 圆底盘」，轮廓自带说明，而且和「按铃催促」这个动作对得上。
 *
 * 摆位是算过的：棋盘半宽 7.3，桌沿 18，但默认取景只比棋盘大一圈，所以铃必须
 * 贴住棋盘左前角、又不能和棋盘打架；再靠外，竖屏手机上就被切掉了。
 */

/** 铃在桌面上的位置：棋盘左前方，伸手可及。 */
const POSITION = { x: -8.15, z: 6.05 } as const;

/** 窄屏上棋盘几乎占满宽度，铃要缩小并往里收，否则会被屏幕边缘切掉半边。 */
const COMPACT_POSITION_X = -7.95;

/** 整体放大一点：直径约 5.6cm，比真按铃略大，为的是在俯拍里点得到。 */
const SCALE = 1.32;
const COMPACT_SCALE = 0.82;

/** 按钮静止时的高度（铃体局部坐标）。 */
const BUTTON_Y = 0.44;

/** 一次响铃的时长。 */
const RING_DURATION = 700;

interface Wave {
  mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  startedAt: number;
}

export class Bell {
  readonly group = new THREE.Group();
  private readonly tweens: TweenManager;
  private readonly bodyMaterial: THREE.MeshPhysicalMaterial;
  private readonly buttonMaterial: THREE.MeshPhysicalMaterial;
  private readonly hoverRing: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private readonly waves: Wave[] = [];
  /** 被按下去的那颗按钮。按下 / 弹回是这枚铃唯一的动作。 */
  private readonly button = new THREE.Group();
  private readonly hitCenter = new THREE.Vector3();
  private ringToken = 0;
  private ringUntil = 0;
  private hovered = false;

  constructor(tweens: TweenManager, scene: THREE.Scene) {
    this.tweens = tweens;
    this.group.position.set(POSITION.x, TABLE_SURFACE_Y, POSITION.z);
    scene.add(this.group);
    this.applyLayout();
    window.addEventListener('resize', this.onResize);

    this.bodyMaterial = new THREE.MeshPhysicalMaterial({
      // 金属度压到 0.78 而不是 .95：没有了环境贴图时，过高的金属度会让
      // 漫反射完全消失，铜铃变成一块黑疙瘩。0.78 在有无 HDRI 的情况下都读作黄铜。
      color: '#d9b063',
      metalness: 0.78,
      roughness: 0.26,
      clearcoat: 0.4,
      clearcoatRoughness: 0.28,
    });
    this.buttonMaterial = new THREE.MeshPhysicalMaterial({
      color: '#c39a52',
      metalness: 0.7,
      roughness: 0.34,
    });

    // 罩子：一条从裙边升到顶心的轮廓线绕 Y 轴旋转。
    // 点的顺序**必须是从下往上**：LatheGeometry 的面朝向由顶点顺序决定，
    // 反过来写会得到一圈朝里的面，渲染时被背面剔除，俯拍看到的就只剩底盘。
    // 高度只有宽度的一半——按铃是浅碟形，做成半球就变成金蛋了。
    const profile: Array<[number, number]> = [
      [0.66, 0.045],
      [0.67, 0.085],
      [0.62, 0.18],
      [0.54, 0.26],
      [0.44, 0.325],
      [0.32, 0.375],
      [0.18, 0.405],
      [0.00, 0.415],
    ];
    const dome = new THREE.Mesh(
      new THREE.LatheGeometry(profile.map(([radius, y]) => new THREE.Vector2(radius, y)), 56),
      this.bodyMaterial,
    );
    dome.castShadow = true;
    dome.receiveShadow = true;
    this.group.add(dome);

    // 裙边：一圈略粗的边，让罩子有厚度。没有它，罩子边缘在俯拍里会「融化」进桌面。
    const skirt = new THREE.Mesh(
      new THREE.TorusGeometry(0.655, 0.035, 10, 56),
      this.bodyMaterial,
    );
    skirt.rotation.x = Math.PI / 2;
    skirt.position.y = 0.055;
    skirt.castShadow = true;
    this.group.add(skirt);

    // 按钮：按下去的就是它。分三层——深色垫圈把它从罩子上摘出来、
    // 短柱、圆顶帽；正上方看是一个明确的「可以按的圆」。
    const collar = new THREE.Mesh(
      new THREE.TorusGeometry(0.185, 0.022, 10, 40),
      new THREE.MeshStandardMaterial({ color: '#6b5327', metalness: 0.6, roughness: 0.5 }),
    );
    collar.rotation.x = Math.PI / 2;
    collar.position.y = 0.005;
    this.button.add(collar);
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.17, 0.19, 0.1, 32),
      this.buttonMaterial,
    );
    stem.position.y = 0.055;
    stem.castShadow = true;
    this.button.add(stem);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.17, 28, 18, 0, Math.PI * 2, 0, Math.PI / 2), this.buttonMaterial);
    cap.position.y = 0.105;
    cap.castShadow = true;
    this.button.add(cap);
    this.button.position.y = BUTTON_Y;
    this.group.add(this.button);

    // 底盘：深色木质/黄铜垫圈，压住罩子与桌面的交界。
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.74, 0.76, 0.045, 48),
      new THREE.MeshStandardMaterial({ color: '#5b4527', metalness: 0.35, roughness: 0.55 }),
    );
    base.position.y = 0.022;
    base.receiveShadow = true;
    base.castShadow = true;
    this.group.add(base);

    // 悬停时亮起的一圈光：这只是「可点」的提示，不参与光照。
    this.hoverRing = new THREE.Mesh(
      new THREE.RingGeometry(0.82, 0.88, 48),
      new THREE.MeshBasicMaterial({
        color: '#e6c47b',
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.hoverRing.rotation.x = -Math.PI / 2;
    this.hoverRing.position.y = 0.008;
    this.group.add(this.hoverRing);
  }

  /**
   * 按视口宽度摆铃。
   *
   * 竖屏手机为了把 15 路棋盘塞进宽度，两侧只剩 20 多个像素——铃按桌面尺寸摆
   * 就会被屏幕边缘切掉半边。这里在小屏上把铃缩小并往内收一点，仍然落在桌面上。
   */
  private applyLayout(): void {
    const compact = window.innerWidth < 720;
    const scale = compact ? COMPACT_SCALE : SCALE;
    this.group.scale.setScalar(scale);
    this.group.position.x = compact ? COMPACT_POSITION_X : POSITION.x;
    this.hitCenter.set(this.group.position.x, TABLE_SURFACE_Y + 0.42 * scale, POSITION.z);
  }

  private readonly onResize = (): void => this.applyLayout();

  /** 光标是否停在铃上：命中半径比几何体略大，手指点得中。 */
  hit(raycaster: THREE.Raycaster): boolean {
    return raycaster.ray.distanceToPoint(this.hitCenter) < 0.95 * SCALE;
  }

  setHover(hovered: boolean): void {
    if (this.hovered === hovered) return;
    this.hovered = hovered;
    this.hoverRing.material.opacity = hovered ? 0.42 : 0;
    this.bodyMaterial.emissive.set(hovered ? '#3a2a10' : '#000000');
    this.bodyMaterial.emissiveIntensity = hovered ? 0.55 : 0;
    this.buttonMaterial.emissive.set(hovered ? '#2c1e0a' : '#000000');
    this.buttonMaterial.emissiveIntensity = hovered ? 0.5 : 0;
  }

  /** 按一下：按钮压下去弹回来，整枚铃余震一下，桌上荡开一圈声波。 */
  ring(): void {
    this.ringUntil = performance.now() + RING_DURATION + 60;
    const token = ++this.ringToken;
    this.tweens.add({
      duration: RING_DURATION,
      easing: Easing.easeOutCubic,
      onUpdate: (progress) => {
        if (token !== this.ringToken) return;
        // 按下快、回弹慢：前半段走完一个正弦。
        const press = Math.sin(Math.min(1, progress * 2.4) * Math.PI) * 0.085;
        this.button.position.y = BUTTON_Y - press;
        // 罩子的余震很小——按铃是「嗒」的一下，不是弹簧。
        this.group.position.y = TABLE_SURFACE_Y + Math.exp(-9 * progress) * Math.sin(progress * 34) * 0.012;
      },
      onComplete: () => {
        if (token !== this.ringToken) return;
        this.button.position.y = BUTTON_Y;
        this.group.position.y = TABLE_SURFACE_Y;
      },
    });
    this.spawnWave();
  }

  /** 每帧：声波扩散 + 兜底复位（补间队列被清空时按钮不该一直按着）。 */
  update(now: number): void {
    if (this.ringToken && now > this.ringUntil) {
      if (this.button.position.y !== BUTTON_Y) this.button.position.y = BUTTON_Y;
      if (this.group.position.y !== TABLE_SURFACE_Y) this.group.position.y = TABLE_SURFACE_Y;
    }

    for (let index = this.waves.length - 1; index >= 0; index -= 1) {
      const wave = this.waves[index];
      if (!wave) continue;
      const progress = Math.min(1, (now - wave.startedAt) / 720);
      wave.mesh.scale.setScalar(1 + progress * 2.4);
      wave.mesh.material.opacity = (1 - progress) * 0.5;
      if (progress >= 1) {
        this.group.remove(wave.mesh);
        wave.mesh.geometry.dispose();
        wave.mesh.material.dispose();
        this.waves.splice(index, 1);
      }
    }
  }

  private spawnWave(): void {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.82, 0.89, 64),
      new THREE.MeshBasicMaterial({
        color: '#f0d49a',
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.01;
    this.group.add(mesh);
    this.waves.push({ mesh, startedAt: performance.now() });
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.group.removeFromParent();
    for (const wave of this.waves) {
      wave.mesh.geometry.dispose();
      wave.mesh.material.dispose();
    }
    this.waves.length = 0;
    this.bodyMaterial.dispose();
    this.buttonMaterial.dispose();
    this.hoverRing.geometry.dispose();
    this.hoverRing.material.dispose();
  }
}
