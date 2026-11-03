/**
 * 快捷短语目录（前后端共用同一份文案）。
 *
 * 这是 `game.phrase` 协议的「合法词表」：服务端只转发已知 `phraseId` 对应的
 * 规范文案，根本不接受客户端任意文本，从源头杜绝 chat 注入与 XSS 载荷。
 * 前端 `PHRASES` 用于渲染按钮与气泡文案。
 */
export interface PhraseDef {
  id: string;
  text: string;
}

export const PHRASES: PhraseDef[] = [
  { id: 'lead', text: '局势对我很有利！' },
  { id: 'persist', text: '坚持下去，胜利就是我的了。' },
  { id: 'hurry', text: '如果再不尽快采取行动，你就要失败了！' },
  { id: 'cai', text: '菜' },
  { id: 'rou', text: '肉' },
  { id: 'jue', text: '撅' },
  { id: 'shale', text: '傻了吧' },
];

/** `phraseId` → 文案。 */
export const PHRASE_MAP: Record<string, string> = Object.fromEntries(
  PHRASES.map((phrase) => [phrase.id, phrase.text]),
);

/** 取已知短语的规范文案；未知返回 null。 */
export function phraseText(id: string): string | null {
  return PHRASE_MAP[id] ?? null;
}
