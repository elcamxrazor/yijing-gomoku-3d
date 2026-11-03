import type { PlayerColor } from './types';
import type { AnyGameSnapshot } from './types';
import { DEFAULT_BLACK_MATERIAL, DEFAULT_WHITE_MATERIAL } from '../scene/stoneMaterials';

/** 玩家已装备的两色皮肤材质 id。 */
export interface EquippedSkins {
  materialBlack: string;
  materialWhite: string;
}

/** 渲染层 `setStoneMaterials` 需要的两个材质 id，顺序固定为「先黑后白」。 */
export type StoneSkins = [black: string, white: string];

/**
 * 计算本局黑 / 白两侧该用哪套棋子材质。
 *
 * 返回顺序**永远是 [黑, 白]**——渲染层就是按这个顺序取用的。历史上这里踩过坑：
 * 联机分支曾按「自己 / 对方」的位置把两个 id 直接传下去，自己执白时黑白材质
 * 会对调，导致黑子显示白皮肤、白子显示黑皮肤。所以这里按颜色逐个解析，而不是
 * 按「自己 / 对方」。
 *
 * - 本地同屏 / 人机：双方都跟随玩家自己装备的皮肤。
 * - 联机 PVP：自己执哪色就用该色的皮肤；对方是否显示其专属皮肤由设置决定，
 *   关闭时对方也用「自己」同色皮肤。
 */
export function resolveStoneSkins(
  snapshot: AnyGameSnapshot | null,
  equipped: EquippedSkins,
  showOpponentSkin: boolean,
): StoneSkins {
  const mine = (color: PlayerColor): string =>
    color === 1 ? equipped.materialBlack : equipped.materialWhite;

  if (!snapshot || snapshot.mode !== 'online') return [mine(1), mine(2)];

  const ownColor = snapshot.yourColor ?? 1;
  const oppColor: PlayerColor = ownColor === 1 ? 2 : 1;
  const opponent = snapshot.players[oppColor === 1 ? 'black' : 'white'];

  const skinFor = (color: PlayerColor): string => {
    if (color === ownColor) return mine(color);
    if (showOpponentSkin) {
      return opponent?.skin ?? (color === 1 ? DEFAULT_BLACK_MATERIAL : DEFAULT_WHITE_MATERIAL);
    }
    return mine(color);
  };

  return [skinFor(1), skinFor(2)];
}
