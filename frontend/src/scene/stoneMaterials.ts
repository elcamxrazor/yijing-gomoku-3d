import * as THREE from 'three';

/**
 * 棋子材质配置与工厂。
 *
 * 棋子外观被抽成一份「目录 + 工厂」，对局逻辑（规则层、落子、胜负）完全不感知
 * 材质——它只通过 {@link GomokuScene.setStoneMaterials} 把两份材质 id 交给渲染层。
 * 这样新增一种材质只是往 `STONE_MATERIALS` 里加一条记录，不会改到任何对局代码。
 *
 * 默认黑/白实体棋子（`solid-black` / `solid-white`）始终可用；两种特殊材质
 * （磨砂半透明黑、半透明白）为商城解锁项，未解锁、未装备时绝不会被渲染。
 */

/** 材质作用的棋手方。 */
export type StoneSide = 'black' | 'white';

/** 一种棋子外观的完整定义（也是商城「材质」商品的底层数据）。 */
export interface StoneMaterialDef {
  /** 稳定的材质标识，落库 / 商城引用它。 */
  materialId: string;
  /** 中文名，UI 与回显用。 */
  name: string;
  /** 该材质作用于黑子还是白子。 */
  side: StoneSide;
  /** 基础颜色（十六进制字符串）。 */
  color: string;
  /** 不透明度 0~1；1 为完全不透明。 */
  opacity: number;
  /** 玻璃透射强度 0~1；>0 时启用 `MeshPhysicalMaterial.transmission` 呈现玻璃质感。 */
  transmission: number;
  /** 磨砂程度：越大越像磨砂玻璃，通过 `roughness` 实现。 */
  roughness: number;
  /** 金属度 0~1。 */
  metalness: number;
  /** 清漆层强度 0~1，模拟棋子表面那层釉光。 */
  clearcoat: number;
  /** 清漆层粗糙度 0~1。 */
  clearcoatRoughness: number;
  /** 是否为「磨砂」质感（用于 UI 文案与回显）。 */
  frosted: boolean;
  /**
   * 透射衰减色（仅 `transmission > 0` 时生效）：光在棋子内部走过一段后
   * 被染成这个颜色。缺省沿用翡翠那套浅玉色 `#d8f3e4`；冷色材质（如鸿璐）
   * 应传自己的浅色，否则会被绿调带偏。
   */
  attenuationColor?: string;
  /** 透射衰减距离（世界单位）；越小，厚处越快被衰减色吃掉。缺省 1.4。 */
  attenuationDistance?: number;
  /**
   * 自发光色（缺省纯黑 = 不发光）。
   *
   * 用途是「补色」：透射玻璃会把棋盘暖黄一起透上来，青色叠暖黄会偏绿。
   * 透射只能做减法（吸收），没法凭空加蓝，所以给一点冷色自发光来补蓝，
   * 把最终观感拉回青色，而不是靠把底色改得更暗去硬压。
   */
  emissive?: string;
  /** 自发光强度（0 表示不发光）。 */
  emissiveIntensity?: number;
  /**
   * 环境反射强度（缺省 1.0）。暖色环境反射会把冷色材质往黄里带，
   * 需要保色的材质可以调低它，减少环境暖光的白色反光。
   */
  envMapIntensity?: number;
  /**
   * 透射厚度（缺省 0.5）。衰减是「按厚度」累积的：做薄一点，吸收更少、
   * 折射畸变更小，棋子就更有「清透玻璃」的观感。仅透射材质生效。
   */
  thickness?: number;
  /** 是否默认可用（默认黑/白实体棋子为 true，特殊材质为 false）。 */
  defaultUnlocked: boolean;
  /** 商城价格（积分）；默认解锁项为 0。 */
  price: number;
  /** 一句话说明。 */
  description: string;
}

/** 全部棋子材质目录。新增材质只需在此追加一条。 */
export const STONE_MATERIALS: Record<string, StoneMaterialDef> = {
  'solid-black': {
    materialId: 'solid-black',
    name: '黑玉',
    side: 'black',
    color: '#171a18',
    opacity: 1,
    transmission: 0,
    roughness: 0.22,
    metalness: 0.05,
    clearcoat: 0.65,
    clearcoatRoughness: 0.2,
    frosted: false,
    defaultUnlocked: true,
    price: 0,
    description: '默认实体黑子，表面带一层清漆釉光。',
  },
  'solid-white': {
    materialId: 'solid-white',
    name: '白玉',
    side: 'white',
    color: '#f4f0e7',
    opacity: 1,
    transmission: 0,
    roughness: 0.2,
    metalness: 0,
    clearcoat: 0.7,
    clearcoatRoughness: 0.18,
    frosted: false,
    defaultUnlocked: true,
    price: 0,
    description: '默认实体白子，温润如玉。',
  },
  'frosted-black': {
    materialId: 'frosted-black',
    name: '墨玉',
    side: 'black',
    // 底色不能太黑：透射光会被底色吃光，结果和普通黑子没有区别（实测教训）。
    // 翡翠绿 + 高透射：透过棋子能看到木纹格线的朦胧影子。
    color: '#9ed6b6',
    opacity: 0.9,
    transmission: 0.97,
    roughness: 0.07,
    metalness: 0,
    clearcoat: 0.3,
    clearcoatRoughness: 0.45,
    frosted: true,
    defaultUnlocked: false,
    price: 30,
    description: '墨玉：通透玉质，墨色温润，木纹在棋子下隐约流动。',
  },
  'frosted-cyan': {
    materialId: 'frosted-cyan',
    name: '鸿璐',
    side: 'black',
    // 鸿璐：淡青透明玻璃。目标色 #95EADA（允许更暗）。
    //
    // 设计取舍：
    // - 「透」是第一优先：transmission 拉满、thickness 做薄、自发光压低。
    //   自发光是「发光盖住背景」，它越强越不透——这是最容易被忽略的一项。
    // - 棋盘是暖黄木色，透上来会把青色带绿；透射只能做减法，所以用一层
    //   浅青染色（attenuation + emissive）把观感拉回青。
    // - 浅色比深色更像「带色的玻璃」；深青容易看成一坨实心。
    // - ACES 色调映射下高亮度必然去饱和，所以不追求 #5DFDE4 原值。
    color: '#95eada',
    opacity: 0.9,
    transmission: 1.0,
    // 磨砂程度对齐「凝脂」（translucent-white）的 roughness 0.12。
    roughness: 0.12,
    metalness: 0,
    clearcoat: 0.05,
    clearcoatRoughness: 0.6,
    frosted: false,
    // 折射厚度对齐「凝脂」（translucent-white）的 0.5：ior 两者本就同为 1.5，
    // 真正决定「折射多强 / 玻璃珠感多明显」的是 thickness。鸿璐此前为追求
    // 通透被做薄到 0.12，折射就很平、像一层色膜；对齐到 0.5 后，棋子内部
    // 光线走过的路程与凝脂相同，折射弯折与边缘畸变也就一致了。
    // 注意：thickness 只改折射与内部吸收，颜色 / 透射 / 磨砂 / 衰减色
    // / 自发光 / 环境反射等其余参数保持原样不动。
    thickness: 0.5,
    attenuationColor: '#8ff2ea',
    attenuationDistance: 3.0,
    emissive: '#8ff2ea',
    emissiveIntensity: 0.34,
    envMapIntensity: 0.65,
    defaultUnlocked: false,
    price: 30,
    description: '鸿璐：青碧透亮，透过暖黄棋盘仍呈青色，光在棋子内流转。',
  },
  'translucent-white': {
    materialId: 'translucent-white',
    name: '凝脂',
    side: 'white',
    color: '#f6f2ea',
    opacity: 0.88,
    transmission: 0.85,
    roughness: 0.12,
    metalness: 0,
    clearcoat: 0.5,
    clearcoatRoughness: 0.16,
    frosted: false,
    defaultUnlocked: false,
    price: 30,
    description: '半透明白：清透玻璃棋子，光线在其间流转。',
  },
};

/** 默认黑 / 白材质（始终可用，无需解锁）。 */
export const DEFAULT_BLACK_MATERIAL = 'solid-black';
export const DEFAULT_WHITE_MATERIAL = 'solid-white';

/** 取出某一侧的全部材质定义（商城「材质」分类用）。 */
export function listMaterialsForSide(side: StoneSide): StoneMaterialDef[] {
  return Object.values(STONE_MATERIALS).filter((def) => def.side === side);
}

/** 按 id 取材质定义；未知 id 返回 null。 */
export function getMaterialDef(materialId: string): StoneMaterialDef | null {
  return STONE_MATERIALS[materialId] ?? null;
}

/**
 * 由定义创建一个可用于棋子的 Three.js 物理材质。
 *
 * 玻璃 / 磨砂质感靠 `transmission`（透射）实现：透射让棋子折射背后的环境，
 * 配合场景里已经挂好的 HDRI 环境贴图，会呈现出真正的玻璃感而非一层灰。
 * 磨砂则通过抬高 `roughness` 把透射打散成朦胧质感。
 *
 * 关键点：**透射材质绝不能再叠 `transparent + opacity`。** three 对带
 * `transparent: true` 的表面走普通透明混合管线，透射采样到的背景图会被
 * `opacity` 又压淡一层，结果就是「看得见透光、看不出折射」——墨玉
 * 曾经就因为叠了 0.9 的 opacity，折射直接糊没。透射开启时必须保持
 * `transparent: false`、`opacity: 1`，让折射完全由 transmission 负责。
 */
export function createStoneMaterial(def: StoneMaterialDef): THREE.MeshPhysicalMaterial {
  // 透射材质走 three 的 transmission 管线（transparent=false 才能拿到折射）。
  const transmissive = def.transmission > 0;
  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(def.color),
    roughness: def.roughness,
    metalness: def.metalness,
    clearcoat: def.clearcoat,
    clearcoatRoughness: def.clearcoatRoughness,
    // 自发光默认纯黑（不发光）。给鸿璐一类「透射后被暖黄拉绿」的材质留了
    // 冷色自发光的口子，用来补蓝、把观感拉回青色。
    emissive: new THREE.Color(def.emissive ?? '#000000'),
    emissiveIntensity: def.emissiveIntensity ?? 0,
    transparent: !transmissive && def.opacity < 1,
    opacity: transmissive ? 1 : def.opacity,
    transmission: def.transmission,
    // thickness 决定折射光在棋子内部走的路程：棋子半径 0.38，给足一整个
    // 直径的厚度，透出的木纹格线才有肉眼可见的弯折。想更清透可以调薄。
    thickness: transmissive ? (def.thickness ?? 0.5) : 0,
    ior: transmissive ? 1.5 : 1.45,
    // 透射衰减：光在内部越走越被「漂白」成浅色（而不是被深底色吃掉）。
    // 这是凝脂/墨玉/鸿璐看起来「透」的关键——衰减色浅，厚处也偏透。
    // 允许材质自定义：冷色材质用同色系浅色，避免被默认的浅玉绿带偏。
    ...(transmissive
      ? {
        attenuationColor: def.attenuationColor ?? '#d8f3e4',
        attenuationDistance: def.attenuationDistance ?? 1.4,
      }
      : {}),
  });
  // 实体子用 0.55 的环境反射强度即可；透射材质要让折射里的环境更明显，
  // 默认提到 1.0，让玻璃感在三种棋境里都成立。暖色环境会把冷色材质往黄里
  // 带，需要保色的材质（如鸿璐）可在定义里调低。
  material.envMapIntensity = def.envMapIntensity ?? 1.0;
  return material;
}
