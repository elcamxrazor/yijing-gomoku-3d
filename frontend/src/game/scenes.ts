/**
 * 棋境预设：一局棋在哪个房间里下。
 *
 * ID 是前后端之间的协议值（会进数据库、进快照），一旦发布就不再改动；
 * 名称与文案只属于界面，随便调。
 *
 * 「随机」不是预设之一，而是「不指定」——后端建房/约战时会抽一个；
 * 本地对弈由前端自己抽。这样快照里的 `scene` 永远是一个确定的预设，
 * 不存在「随机」这个需要二次解释的状态。
 */
export const SCENE_PRESETS = [
  {
    id: 'tea',
    name: '基础茶室',
    tagline: '木格窗影 · 一盏清茶',
  },
  {
    id: 'courtyard',
    name: '日式庭院',
    tagline: '枯山水 · 蒲团对坐',
  },
  {
    id: 'cyber',
    name: '赛博夜局',
    tagline: '霓虹 · 电子樱花',
  },
  {
    id: 'living',
    name: '现代客厅',
    tagline: '沙发对坐 · 茶几博弈',
  },
  {
    id: 'studio',
    name: '摄影棚',
    tagline: '柔光箱 · 静物棚拍',
  },
] as const;

export type ScenePresetId = (typeof SCENE_PRESETS)[number]['id'];

const PRESET_IDS = new Set<string>(SCENE_PRESETS.map((preset) => preset.id));

/** 未知值（旧快照、恶意报文）一律回退到茶室——它是最保守的默认。 */
export const DEFAULT_SCENE_ID: ScenePresetId = 'tea';

/** 值是不是一个合法的预设 ID。 */
export function isScenePresetId(value: unknown): value is ScenePresetId {
  return typeof value === 'string' && PRESET_IDS.has(value);
}

/** 把任意输入收敛成合法预设：不认识的就用默认。 */
export function coerceSceneId(value: unknown): ScenePresetId {
  return isScenePresetId(value) ? value : DEFAULT_SCENE_ID;
}

/** 预设名；给状态行、弹窗文案用。 */
export function sceneName(id: ScenePresetId): string {
  return SCENE_PRESETS.find((preset) => preset.id === id)?.name ?? '基础茶室';
}

/** 均匀抽一个预设。 */
export function randomSceneId(): ScenePresetId {
  const index = Math.floor(Math.random() * SCENE_PRESETS.length);
  return SCENE_PRESETS[index]?.id ?? DEFAULT_SCENE_ID;
}
