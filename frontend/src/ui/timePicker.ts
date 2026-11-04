/**
 * 读秒选择器：建房 / 约战弹窗里那排胶囊单选。
 *
 * 默认「不限时」——读秒是新玩家主动选的，不该在没人要求的时候改变现有体验。
 * 也刻意不做「五档」：玩家分不出 45 秒和 60 秒的差别，多出来的只是决策成本。
 */

import { PER_MOVE_OPTIONS } from '../game/clock';
import type { TimeControl } from '../game/types';

export function timePickerHtml(group: string): string {
  const pill = (value: string, label: string, checked: boolean) =>
    `<label class="rule-pill"><input type="radio" name="${group}-time" value="${value}"${checked ? ' checked' : ''}><span>${label}</span></label>`;
  return (
    `<div class="rule-picker time-picker" role="radiogroup" aria-label="读秒">` +
    pill('none', '不限时', true) +
    PER_MOVE_OPTIONS.map((ms) => pill(String(ms), `${ms / 1000} 秒`, false)).join('') +
    `</div>`
  );
}

/**
 * 读出当前选中的读秒档位。
 *
 * @returns 选了具体秒数返回 `{mode:'perMove', perMoveMs}`；选了「不限时」或
 *          压根没选中返回 `null`（调用方据此**不写这个字段**，让服务端走默认）。
 */
export function readTimeChoice(group: string): TimeControl | null {
  const checked = document.querySelector<HTMLInputElement>(
    `input[name="${group}-time"]:checked`,
  );
  if (!checked) return null;
  const ms = Number(checked.value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return { mode: 'perMove', perMoveMs: ms };
}
