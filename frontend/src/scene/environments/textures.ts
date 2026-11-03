import * as THREE from 'three';

/**
 * 环境专用贴图：全部 Canvas 程序化生成。
 *
 * 贴图是棋境「穷酸感」的分水岭——纯色盒子一眼就是搭出来的，而榻榻米的
 * 草编纹、枯山水的耙痕、霓虹的辉光这些细节，扫描素材当然更好，但本页
 * 的目标是：不下载任何新素材，也能把三个房间各自的语言做出来。
 *
 * 所有函数用固定随机种子，刷新前后纹理完全一致。
 */

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

function canvasOf(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器无法创建画布');
  return [canvas, context];
}

function finish(canvas: HTMLCanvasElement, repeat?: { x: number; y: number }): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  if (repeat) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(repeat.x, repeat.y);
  }
  return texture;
}

/* ------------------------------------------------------------------ */
/* 障子纸                                                              */
/* ------------------------------------------------------------------ */

/** 障子纸：暖白 + 纤维噪点 + 极淡的上下渐变。配合一点自发光当背光用。 */
export function makeShojiTexture(): THREE.CanvasTexture {
  const [canvas, context] = canvasOf(256, 256);
  const random = seeded(1147);

  const gradient = context.createLinearGradient(0, 0, 0, 256);
  gradient.addColorStop(0, '#fbf4e2');
  gradient.addColorStop(0.5, '#f6efdd');
  gradient.addColorStop(1, '#efe6d0');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 256, 256);

  const image = context.getImageData(0, 0, 256, 256);
  const data = image.data;
  for (let index = 0; index < data.length; index += 4) {
    const delta = (random() - 0.5) * 14;
    data[index] = Math.max(0, Math.min(255, (data[index] ?? 0) + delta));
    data[index + 1] = Math.max(0, Math.min(255, (data[index + 1] ?? 0) + delta));
    data[index + 2] = Math.max(0, Math.min(255, (data[index + 2] ?? 0) + delta * 0.7));
  }
  context.putImageData(image, 0, 0);

  return finish(canvas);
}


/* ------------------------------------------------------------------ */
/* 赛博朋克                                                            */
/* ------------------------------------------------------------------ */

/** 赛博地面：深色底 + 发光网格。同时当 map 与 emissiveMap 用。 */
export function makeCyberFloorTexture(): THREE.CanvasTexture {
  const [canvas, context] = canvasOf(512, 512);

  context.fillStyle = '#0b0d13';
  context.fillRect(0, 0, 512, 512);

  // 网格：青色主线 + 暗一点的细分区。shadowBlur 做出辉光。
  context.strokeStyle = 'rgba(38,222,255,0.85)';
  context.lineWidth = 3;
  context.shadowColor = '#26deff';
  context.shadowBlur = 9;
  context.beginPath();
  context.moveTo(0, 1.5);
  context.lineTo(512, 1.5);
  context.moveTo(1.5, 0);
  context.lineTo(1.5, 512);
  context.stroke();

  context.strokeStyle = 'rgba(38,222,255,0.16)';
  context.lineWidth = 1;
  context.shadowBlur = 3;
  for (let i = 1; i < 4; i += 1) {
    context.beginPath();
    context.moveTo(0, i * 128);
    context.lineTo(512, i * 128);
    context.moveTo(i * 128, 0);
    context.lineTo(i * 128, 512);
    context.stroke();
  }
  context.shadowBlur = 0;
  return finish(canvas, { x: 10, y: 8 });
}

/** 霓虹招牌：黑底上几块发光的伪日文 glyph + 一道分隔线。 */
export function makeNeonSignTexture(): THREE.CanvasTexture {
  const [canvas, context] = canvasOf(512, 256);
  const random = seeded(778899);

  context.fillStyle = '#07080d';
  context.fillRect(0, 0, 512, 256);

  const drawGlyph = (x: number, y: number, size: number, color: string): void => {
    context.strokeStyle = color;
    context.lineWidth = size * 0.13;
    context.lineCap = 'square';
    context.shadowColor = color;
    context.shadowBlur = 18;
    // 伪假名：三四笔横竖撇的随机组合。不必是字，只要「像招牌上的字」。
    const strokes = 3 + Math.floor(random() * 2);
    for (let s = 0; s < strokes; s += 1) {
      const ax = x + random() * size * 0.7;
      const ay = y + random() * size * 0.7;
      const horizontal = random() > 0.5;
      const length = size * (0.3 + random() * 0.45);
      context.beginPath();
      if (horizontal) {
        context.moveTo(ax, ay);
        context.lineTo(ax + length, ay + (random() - 0.5) * size * 0.15);
      } else {
        context.moveTo(ax, ay);
        context.lineTo(ax + (random() - 0.5) * size * 0.12, ay + length);
      }
      context.stroke();
    }
    context.shadowBlur = 0;
  };

  drawGlyph(48, 48, 70, '#ff4fa3');
  drawGlyph(150, 40, 86, '#ff4fa3');
  drawGlyph(266, 48, 70, '#26deff');
  drawGlyph(368, 60, 54, '#26deff');

  // 底部一条通栏霓虹管。
  context.strokeStyle = '#26deff';
  context.lineWidth = 6;
  context.shadowColor = '#26deff';
  context.shadowBlur = 22;
  context.beginPath();
  context.moveTo(36, 196);
  context.lineTo(476, 196);
  context.stroke();
  context.shadowBlur = 0;

  return finish(canvas);
}

/** 花瓣精灵贴图：一枚带柔边的粉色花瓣，供 Points 粒子用。 */
export function makePetalTexture(): THREE.CanvasTexture {
  const [canvas, context] = canvasOf(64, 64);

  const gradient = context.createRadialGradient(32, 34, 2, 32, 34, 26);
  gradient.addColorStop(0, 'rgba(255,214,235,0.98)');
  gradient.addColorStop(0.55, 'rgba(255,132,196,0.85)');
  gradient.addColorStop(1, 'rgba(255,132,196,0)');
  context.fillStyle = gradient;
  context.beginPath();
  context.ellipse(32, 34, 17, 24, 0.35, 0, Math.PI * 2);
  context.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/* ------------------------------------------------------------------ */
/* 茶室                                                                */
/* ------------------------------------------------------------------ */

/** 床の間挂轴：宣纸底 + 几笔墨 + 一方红印。 */
export function makeScrollTexture(): THREE.CanvasTexture {
  const [canvas, context] = canvasOf(256, 512);
  const random = seeded(9510);

  context.fillStyle = '#ece4d0';
  context.fillRect(0, 0, 256, 512);

  // 纸纹
  const image = context.getImageData(0, 0, 256, 512);
  const data = image.data;
  for (let index = 0; index < data.length; index += 4) {
    const delta = (random() - 0.5) * 10;
    data[index] = Math.max(0, Math.min(255, (data[index] ?? 0) + delta));
    data[index + 1] = Math.max(0, Math.min(255, (data[index + 1] ?? 0) + delta));
    data[index + 2] = Math.max(0, Math.min(255, (data[index + 2] ?? 0) + delta * 0.5));
  }
  context.putImageData(image, 0, 0);

  // 墨字：几笔竖向笔触，笔肚重、笔锋轻。
  context.strokeStyle = '#1d1a16';
  for (let column = 0; column < 3; column += 1) {
    const x = 70 + column * 58;
    const strokes = 2 + Math.floor(random() * 2);
    for (let s = 0; s < strokes; s += 1) {
      const top = 60 + s * 46 + column * 22;
      const height = 40 + random() * 70;
      context.lineWidth = 7 + random() * 5;
      context.beginPath();
      context.moveTo(x + (random() - 0.5) * 14, top);
      context.quadraticCurveTo(
        x + (random() - 0.5) * 26,
        top + height / 2,
        x + (random() - 0.5) * 12,
        top + height,
      );
      context.stroke();
    }
  }

  // 红印
  context.fillStyle = '#a33327';
  context.fillRect(186, 420, 30, 30);
  context.fillStyle = 'rgba(236,228,208,0.85)';
  context.fillRect(192, 426, 5, 18);
  context.fillRect(205, 426, 5, 18);

  return finish(canvas);
}
