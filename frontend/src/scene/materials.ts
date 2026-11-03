import * as THREE from 'three';
import { PALETTE, STONE_FLAT_RATIO, STONE_RADIUS } from './config';

/**
 * 场景层仍保留的少量程序化纹理工厂。
 *
 * 棋盘木纹占位与棋子光晕在此用 Canvas 程序化生成；其余材质（榻榻米、木构件、
 * 红木桌面、白砂、钢板）与模型均来自 Poly Haven 的 CC0 素材，
 * 由 `assets.ts` 加载（见 `THIRD_PARTY_NOTICES.md`）。棋盘面的榧木 PBR 贴图
 * 是 AI 生成的（diff 上做了亮度均衡，rough/normal/ao 由 diff 派生），
 * 同样从 `assets.ts` 走 `loadPbrTextureSet('board', …)` 加载。
 * 程序化纹理只在真实素材
 * 加载到位前作兜底；棋境专用的辅助贴图（障子纸、赛博地面、霓虹、花瓣、挂轴）
 * 见 `environments/textures.ts`。
 */

/** 程序化木纹（兜底）：底色渐变 + 通栏色带 + 随机纹理线 + 年轮 + 暗角。
 * 仅在真实榧木贴图加载到位前作棋盘面占位，到位后被热替换。
 * 配色与新贴图同一基调：浅金奶油色的细纹整板。 */
export function makeWoodTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器无法创建木纹画布');

  const gradient = context.createLinearGradient(0, 0, 1024, 240);
  gradient.addColorStop(0, '#e3cb96');
  gradient.addColorStop(0.45, '#ecd9ab');
  gradient.addColorStop(1, '#e0c68e');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 1024, 1024);

  // 通栏色带：让木面读起来是一整块板，而不是平涂。
  for (let band = 0; band < 26; band += 1) {
    const top = (band / 26) * 1024;
    context.fillStyle = `rgba(${band % 2 === 0 ? '255,250,228' : '156,116,62'},${0.012 + (band % 3) * 0.006})`;
    context.fillRect(0, top, 1024, 1024 / 26 + 1);
  }

  // 固定种子的伪随机，保证每次刷新纹理一致。
  let seed = 48371;
  const random = (): number => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  for (let index = 0; index < 340; index += 1) {
    const y = random() * 1024;
    const amplitude = 2 + random() * 12;
    context.beginPath();
    context.moveTo(-20, y);
    for (let x = -20; x <= 1044; x += 48) {
      context.lineTo(x, y + Math.sin(x * 0.012 + index) * amplitude + (random() - 0.5) * 4);
    }
    context.strokeStyle = `rgba(${random() > 0.32 ? '148,105,52' : '255,250,230'},${0.05 + random() * 0.11})`;
    context.lineWidth = 0.7 + random() * 2.2;
    context.stroke();
  }

  for (let index = 0; index < 9; index += 1) {
    const x = random() * 1024;
    const y = random() * 1024;
    context.save();
    context.translate(x, y);
    context.scale(2.8 + random() * 2, 0.65 + random() * 0.35);
    for (let ring = 5; ring > 0; ring -= 1) {
      context.beginPath();
      context.ellipse(0, 0, ring * 5, ring * 5, 0, 0, Math.PI * 2);
      context.strokeStyle = `rgba(150,110,58,${0.018 + (5 - ring) * 0.008})`;
      context.lineWidth = 1;
      context.stroke();
    }
    context.restore();
  }

  // 边缘轻微压暗，增加厚度感。
  const vignette = context.createRadialGradient(512, 512, 260, 512, 512, 760);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(120,88,40,0.12)');
  context.fillStyle = vignette;
  context.fillRect(0, 0, 1024, 1024);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return texture;
}

/**
 * 预览棋子的光晕贴图：中心不透明、向外衰减到全透明的径向渐变。
 * 用加色混合叠在棋子下方，形成一圈柔和的外发光。
 */
export function makeGlowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器无法创建光晕画布');

  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,0.95)');
  gradient.addColorStop(0.32, 'rgba(255,255,255,0.42)');
  gradient.addColorStop(0.68, 'rgba(255,255,255,0.12)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * 黑白棋子的物理材质。
 *
 * 用了 clearcoat 来模拟棋子表面那层釉光——这是让 3D 棋子看起来像真石头
 * 而非塑料球的关键：底层漫反射偏哑光，清漆层单独反射高光。
 */
/**
 * 棋子上的手数贴图。
 *
 * 三个细节决定了它能不能看清：
 *
 * 1. **字号随位数收缩**。「全部步数」在一盘满盘棋里会出现三位数，
 *    三位数和一位数共用一个字号时，`225` 会顶出棋子边缘——所以按位数
 *    取 64 / 48 / 38 三档。两位数那一档一开始给到 54，`10` 的两个字
 *    几乎粘在一起，看起来像 `1ı0`。
 * 2. **深浅两套配色**。同一个颜色不可能在纯黑和纯白两种底上都清楚，
 *    黑子用浅字、白子用深字，各自再补一圈极淡的对比描边压住边缘锯齿。
 * 3. **最新一手用红色**。同一个数字在一盘棋里只会出现一次，但「哪一手是
 *    刚下的」是复盘与对局里最常被追问的信息——把最后一手染红，比在界面上
 *    另外加一行「上一手：H8」直接得多。红色也要分深浅两档：黑子上用亮红，
 *    白子上用暗红，否则其中一种底上会糊掉。
 */
export function makeMoveNumberTexture(
  value: number,
  tone: 'light' | 'dark',
  latest = false,
): THREE.CanvasTexture {
  const size = 96;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器无法创建手数画布');

  const text = String(value);
  const digits = text.length;
  const fontSize = digits >= 3 ? 38 : digits === 2 ? 46 : 64;
  context.font = `600 ${fontSize}px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';

  // 逐字排版，而不是 `fillText` 一次画完。
  //
  // 一次画完时，两个数字之间的默认字距太窄，再叠上 3.5px 的描边，
  // `12` 会糊成 `132`。自己算每个字的宽度并留出固定间隙，
  // 既不受 `ctx.letterSpacing`（新 API，老浏览器没有）影响，也保证一定分得开。
  const glyphs = [...text];
  const widths = glyphs.map((glyph) => context.measureText(glyph).width);
  const gap = digits > 1 ? fontSize * 0.1 : 0;
  const total = widths.reduce((sum, width) => sum + width, 0) + gap * (digits - 1);
  const baseline = size / 2 + 1;

  // 描边先画：给字一圈极淡的反色底，白色棋子上的深字就不至于糊成一团。
  // 线宽跟着字号走——固定 3.5px 在两个字挨得近时会直接把它们连起来。
  context.lineWidth = Math.max(2, fontSize * 0.055);
  context.strokeStyle = tone === 'light' ? 'rgba(20, 24, 20, 0.45)' : 'rgba(252, 250, 244, 0.55)';
  // 最新一手：黑子配亮红（压在深底上够亮且不刺眼），白子配暗红（压在浅底上
  // 才立得住）。这两个值是按「不参与色调映射、原样输出」调的——早先给到
  // #c02b1d，经过 ACES + 曝光后会被提亮成粉色，白子上几乎糊掉。
  context.fillStyle = latest
    ? tone === 'light' ? '#ff5b47' : '#b3251a'
    : tone === 'light' ? '#f6f2e8' : '#1b201a';

  let cursor = (size - total) / 2;
  glyphs.forEach((glyph, index) => {
    const center = cursor + (widths[index] ?? 0) / 2;
    context.strokeText(glyph, center, baseline);
    context.fillText(glyph, center, baseline);
    cursor += (widths[index] ?? 0) + gap;
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/**
 * 棋盘坐标标签纹理（A–O / 1–15）。
 *
 * 透明背景 + 深墨色字：贴在棋盘木框边的薄片上，俯视时与格线同一套墨色，
 * 斜看也不会像独立小牌那样突兀。size 取 64，单字符/双字符都够清晰，
 * 30 张贴图（15 列 + 15 行）体量极小。
 */
export function makeLabelTexture(text: string, color = '#262019'): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建坐标标签画布');
  context.clearRect(0, 0, size, size);
  context.font = '600 44px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = color;
  context.fillText(text, size / 2, size / 2 + 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

export function createStoneMaterials(): {
  black: THREE.MeshPhysicalMaterial;
  white: THREE.MeshPhysicalMaterial;
} {
  return {
    black: new THREE.MeshPhysicalMaterial({
      color: PALETTE.stoneBlack,
      roughness: 0.22,
      metalness: 0.05,
      clearcoat: 0.65,
      clearcoatRoughness: 0.2,
    }),
    white: new THREE.MeshPhysicalMaterial({
      color: PALETTE.stoneWhite,
      roughness: 0.2,
      metalness: 0,
      clearcoat: 0.7,
      clearcoatRoughness: 0.18,
    }),
  };
}

/**
 * 棋子几何：**压扁后重算法线的球体**。
 *
 * 围棋子的正确形状是「扁圆的旋转椭球」，而不是正球。这里不用 `SphereGeometry`
 * 再靠 `scale.y` 压扁——scale 只改变换矩阵，不改顶点法线，法线仍是正球的方向，
 * 光照下棋子会显得「中凸外鼓」，而且球体两极 UV 收敛会在顶心留一个小暗点。
 *
 * 做法：先生成一个正球，然后**直接把顶点坐标的 y 分量压到 `STONE_FLAT_RATIO`，
 * 再 `computeVertexNormals()` 重算**。这样法线和几何严格一致，顶心也是光滑的，
 * 不会再出现「十字刻痕」或暗点。
 */
export function createStoneGeometry(): THREE.SphereGeometry {
  const geometry = new THREE.SphereGeometry(STONE_RADIUS, 56, 40);
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let index = 0; index < position.count; index += 1) {
    position.setY(index, (position.getY(index) as number) * STONE_FLAT_RATIO);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/** 棋子的基准缩放值（外部动画在此基础上做挤压变形）。 */
export const STONE_BASE = new THREE.Vector3(1, 1, 1);

/**
 * 焦散亮环纹理：模拟透明棋子（透镜）把光聚到板面上的亮环 + 放射光丝。
 *
 * 纯程序化：外圈一条主亮环（高斯径向衰减）+ 若干随机角度的短光丝
 * （模拟折射面的不平整），中心留空（那里是棋子本体）。additive 叠加下
 * 只会增亮，不会遮住底下的木纹。
 */
export function makeCausticTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建焦散纹理画布');
  const center = size / 2;
  const ringRadius = size * 0.3;

  ctx.clearRect(0, 0, size, size);
  // 主亮环：多笔半透明圆弧叠加出柔和的高斯边。
  ctx.lineCap = 'round';
  for (let pass = 0; pass < 14; pass += 1) {
    const t = pass / 13;
    const radius = ringRadius * (0.92 + t * 0.16);
    const alpha = 0.16 * Math.exp(-Math.pow((t - 0.5) / 0.24, 2));
    ctx.strokeStyle = `rgba(255, 244, 214, ${alpha})`;
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(center, center, radius, 0, Math.PI * 2);
    ctx.stroke();
  }
  // 放射光丝：随机角度、长短不一，从亮环向内外发散。
  let seed = 20261102;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  for (let i = 0; i < 46; i += 1) {
    const angle = random() * Math.PI * 2;
    const inner = ringRadius * (0.62 + random() * 0.25);
    const outer = ringRadius * (1.08 + random() * 0.42);
    const alpha = 0.05 + random() * 0.12;
    ctx.strokeStyle = `rgba(255, 250, 224, ${alpha})`;
    ctx.lineWidth = 1 + random() * 2.2;
    ctx.beginPath();
    ctx.moveTo(center + Math.cos(angle) * inner, center + Math.sin(angle) * inner);
    ctx.lineTo(center + Math.cos(angle) * outer, center + Math.sin(angle) * outer);
    ctx.stroke();
  }
  // 内缘亮弧（透镜近轴聚光更亮的一小段）。
  ctx.strokeStyle = 'rgba(255, 248, 220, 0.2)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(center, center, ringRadius * 0.8, Math.PI * 0.15, Math.PI * 0.85);
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}
