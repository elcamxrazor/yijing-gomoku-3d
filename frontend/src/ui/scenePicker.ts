/**
 * 棋境选择器：建房 / AI 开局弹窗里那排小卡片。
 *
 * 交互上刻意做成一个「可选项」而不是必填项：第一位是「随机」，并且默认选中。
 * 手选棋境应该是一次主动决定——老想着背景该配什么的人并不多，
 * 多数人只想快点开盘；而把随机藏起来（比如只提供三个具体场景）就等于
 * 逼每个人每次都做选择。
 *
 * 返回值用 `null` 表达「客户端没有偏好」，而不是「用默认棋境」。
 * 这两者的差别会在服务端体现：null 让服务端自己抽签并存库，
 * 客户端换成默认棋境则会把「随机」这回事悄悄埋掉。
 */

import { SCENE_PRESETS, coerceSceneId, isScenePresetId, type ScenePresetId } from '../game/scenes';

/** 每种棋境在卡片上的缩略色带：取该场景最有代表性的三种颜色。 */
const SWATCH: Record<string, [string, string, string]> = {
  random: ['#6b7280', '#9ca3af', '#e5e7eb'],
  tea: ['#3d2b1f', '#8a6a45', '#e8d9b8'],
  courtyard: ['#4b6b52', '#a8bfae', '#e6efe6'],
  cyber: ['#0b0e1a', '#7a2ff2', '#2ff2d8'],
  living: ['#8d99a6', '#c9b294', '#e8e4dc'],
  studio: ['#0a0b0d', '#6a635c', '#fff4e6'],
};

function card(value: string, name: string, tagline: string, checked: boolean): string {
  const [a, b, c] = SWATCH[value] ?? SWATCH.random ?? ['#666', '#888', '#aaa'];
  return (
    `<label class="scene-card">` +
    `<input type="radio" name="%GROUP%" value="${value}"${checked ? ' checked' : ''}>` +
    `<span class="scene-swatch" style="--scene-a:${a};--scene-b:${b};--scene-c:${c}"></span>` +
    `<strong>${name}</strong><small>${tagline}</small>` +
    `</label>`
  );
}

/**
 * 生成一组棋境单选卡片。
 *
 * @param group radio 的 name，同一弹窗里要保证唯一（AI 弹窗与建房弹窗各一组）。
 */
export function scenePickerHtml(group: string): string {
  const cards = [
    card('random', '随机', '开局时抽签', true),
    ...SCENE_PRESETS.map((preset) => card(preset.id, preset.name, preset.tagline, false)),
  ];
  return (
    `<div class="scene-picker" role="radiogroup" aria-label="棋境">` +
    cards.join('') +
    `</div>`
  ).replaceAll('%GROUP%', group);
}

/**
 * 读出当前选中的棋境。
 *
 * @returns 具体预设 ID；选了「随机」或压根没选中就返回 null。
 */
export function readSceneChoice(group: string): ScenePresetId | null {
  const checked = document.querySelector<HTMLInputElement>(`input[name="${group}"]:checked`);
  if (!checked || !isScenePresetId(checked.value)) return null;
  return coerceSceneId(checked.value);
}

/**
 * 规则选择器：无禁手（默认）/ 有禁手（连珠）。
 *
 * 一行两个胶囊单选，跟棋境选择器同一交互语言；默认无禁手——
 * 多数休闲玩家不需要知道什么是三三禁手。
 */
export function rulePickerHtml(group: string): string {
  const pill = (value: string, label: string, checked: boolean) =>
    `<label class="rule-pill"><input type="radio" name="${group}-rule" value="${value}"${checked ? ' checked' : ''}><span>${label}</span></label>`;
  return (
    `<div class="rule-picker" role="radiogroup" aria-label="规则">` +
    pill('freestyle', '无禁手', true) +
    pill('renju', '有禁手（连珠）', false) +
    `</div>`
  );
}

/** 读出当前选中的规则（各组 name 独立，取任意已选中的）；没有则 null 走默认。 */
export function readRuleChoice(): 'freestyle' | 'renju' | null {
  const checked = document.querySelector<HTMLInputElement>('input[name$="-rule"]:checked');
  if (!checked) return null;
  return checked.value === 'renju' ? 'renju' : 'freestyle';
}
