/**
 * 3D 场景的共享常量与配色。
 *
 * 这里的坐标系约定：
 * - 棋盘平铺在 XZ 平面，y 轴向上，棋盘中心位于世界原点。
 * - `row` 沿 +Z 增大，`col` 沿 +X 增大，两者都以 0 为起点、14 为终点。
 * - 渲染层只负责把「行列」换算成世界坐标，任何胜负判断都由 `game/rules.ts` 负责，
 *   两边互不依赖，避免改视觉时误伤规则。
 */

/** 棋盘边长（路数）。 */
export const BOARD_SIZE = 15;

/** 相邻两条格线的世界距离。 */
export const GRID_SPACING = 0.9;

/** 棋盘外框边长与厚度；棋子、格线、涟漪都贴合在 BOARD_SURFACE_Y 上。 */
export const BOARD_WIDTH = 14.6;
export const BOARD_THICKNESS = 0.62;

/** 棋盘上表面的 y 值（棋盘本体中心在 y=0）。 */
export const BOARD_SURFACE_Y = BOARD_THICKNESS / 2;

/**
 * 茶几面的高度。棋盘底面是 -BOARD_THICKNESS/2，桌面又薄薄高出 0.012，
 * 于是棋盘看起来是「放在桌上」而不是从桌面里长出来。
 * 铜铃这类桌面摆件都以它为落脚点。
 */
export const TABLE_SURFACE_Y = -BOARD_THICKNESS / 2 + 0.012;

/** 棋子半径，以及围棋棋子的「扁平比」——y 轴按 0.48 压扁后才是扁圆形。 */
export const STONE_RADIUS = 0.38;
export const STONE_FLAT_RATIO = 0.34;

/** 棋子静止时的 y：压在棋盘面上，略微嵌进去一点，避免看起来悬空。 */
/**
 * 棋子静止时的中心高度：板面 + 棋子的半厚。
 * 直接用几何参数推，改棋子厚度时不用再手算这个数。
 */
export const STONE_REST_Y = BOARD_SURFACE_Y + STONE_RADIUS * STONE_FLAT_RATIO;

/** 棋子的基准缩放：x/z 为 1，y 轴压扁。 */
/**
 * 棋子基准缩放。
 *
 * 几何体本身已经按 `STONE_FLAT_RATIO` 做出了扁圆厚度（旋转体），
 * 这里不能再乘一遍，否则会被压成薄片。
 */
export const STONE_BASE_SCALE = { x: 1, y: 1, z: 1 } as const;

/** 落子动画参数（单位：毫秒 / 世界单位）。 */
export const DROP_HEIGHT = 5;
export const DROP_DURATION = 300;
export const SQUASH_DURATION = 100;
export const SQUASH_SCALE_XZ = 1.2;
export const SQUASH_SCALE_Y = 0.8;

/** 涟漪动画时长。 */
export const RIPPLE_DURATION = 650;

/**
 * AI 建议绿圈在「落子后」延迟多久才开始收缩。
 *
 * 之所以要延迟：`setLastMove` 是在新棋子开始下落的同时就被调用的，
 * 若立刻收缩，棋子还在半空、绿圈就已经缩没了。这里让它先陪下落动画
 * 走一段，等棋子基本落定再平滑退场；随后 {@link HINT_COLLAPSE_DURATION}
 * 毫秒收完，正好赶在「最新一手」靶心（{@link LANDING_DURATION}）亮起前结束。
 */
export const HINT_COLLAPSE_DELAY = 250;

/** 绿圈退场收缩时长：从满尺寸平滑缩到 0 并淡出。 */
export const HINT_COLLAPSE_DURATION = 240;

/**
 * 一次完整落子动画的总时长：下落 + 挤压 + 二次回弹。
 *
 * 「最新一手」的提示圆点要等这段时间过了才出现——棋子还在天上飞时
 * 圆点先亮出来，看起来就像「点在等子」；等它落定了再亮才是「点在指子」。
 * 150 是 playBounce 的动画时长（见 BoardManager），这里一并收口成常量，
 * 改落子动画时只需要调一处。
 */
export const LANDING_DURATION = DROP_DURATION + SQUASH_DURATION + 150;

/**
 * 相机机位：**近乎正俯拍**。
 *
 * 方向向量几乎垂直向下（只留 0.02 的 z 分量）。这一点点倾斜不是为了造型，
 * 而是必需的：`lookAt` 与 OrbitControls 在视线与 up 向量完全平行时会退化，
 * 极角 0 会得到 NaN 或奇异值。0.02 rad ≈ 1.15°，肉眼分辨不出，
 * 但数学上完全避开了奇点。
 */
export const CAMERA_POSITION = { x: 0, y: 1, z: 0.02 } as const;
export const CAMERA_FOV = 46;
export const CAMERA_FOV_PORTRAIT = 58;

/**
 * HUD 占用的视口边距（像素）。
 *
 * 取景时会把棋盘塞进「视口减去这些边距」的安全区里：上边是顶栏与叙事行，
 * 下边是状态胶囊与操作坞。数值按桌面版式实测得出（1280×800 下叙事行底边 106px、
 * 状态胶囊顶边 687px），改版式时要跟着重新测量。
 */
export const VIEW_INSETS = { top: 112, bottom: 120, side: 24 } as const;

/** 取景时在棋盘外再留一点桌沿，避免棋盘边缘贴死屏幕。 */
export const FRAMING_MARGIN = 1.045;

/** 低饱和暖灰配色，替代原先的纯黑/纯浅色背景。 */
export const PALETTE = {
  background: '#d6d0c4',
  floor: '#b7b0a1',
  wall: '#cac4b7',
  /* 桌面比棋盘深一档：大面积浅木会压过棋盘，深胡桃木更能衬托出棋盘的浅色 */
  table: '#674a31',
  tableLeg: '#523a25',
  /* 格线与星位用近黑的墨色：真实棋盘的线是画上去的墨线，不是描了一道浅棕。 */
  grid: '#241e17',
  star: '#241e17',
  accent: '#c69c5d',
  /** AI 建议推荐环：醒目的绿色，区别于落子涟漪与最后一手的靶心。 */
  hint: '#37b24d',
  stoneBlack: '#171a18',
  stoneWhite: '#f4f0e7',
  lightWarm: '#fff3dd',
  ambient: '#fff6e8',
} as const;

/** 棋盘上的一个交叉点。 */
export interface BoardPoint {
  row: number;
  col: number;
}

/**
 * 把行列换算成世界坐标（只取水平分量，y 由调用方按用途决定）。
 */
export function positionFor(row: number, col: number): { x: number; z: number } {
  const offset = (BOARD_SIZE - 1) / 2;
  return {
    x: (col - offset) * GRID_SPACING,
    z: (row - offset) * GRID_SPACING,
  };
}
