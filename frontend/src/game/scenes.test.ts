import { describe, expect, it } from 'vitest';
import { LocalGameState } from '../game/state';
import {
  DEFAULT_SCENE_ID, SCENE_PRESETS, coerceSceneId, isScenePresetId, randomSceneId, sceneName,
} from '../game/scenes';

describe('scenes', () => {
  it('五个棋境各有一个稳定 ID', () => {
    expect(SCENE_PRESETS.map((preset) => preset.id)).toEqual([
      'tea', 'courtyard', 'cyber', 'living', 'studio',
    ]);
    // ID 会进数据库，改名等于让已有对局失忆——这条断言是为了挡住手滑重命名。
    for (const preset of SCENE_PRESETS) {
      expect(preset.name.length).toBeGreaterThan(0);
      expect(preset.tagline.length).toBeGreaterThan(0);
    }
  });

  it('未知取值一律回退到默认棋境', () => {
    expect(coerceSceneId(undefined)).toBe(DEFAULT_SCENE_ID);
    expect(coerceSceneId(null)).toBe(DEFAULT_SCENE_ID);
    expect(coerceSceneId('atlantis')).toBe(DEFAULT_SCENE_ID);
    expect(coerceSceneId(7)).toBe(DEFAULT_SCENE_ID);
    expect(coerceSceneId(['tea'])).toBe(DEFAULT_SCENE_ID);
  });

  it('已知 ID 原样通过', () => {
    for (const preset of SCENE_PRESETS) {
      expect(isScenePresetId(preset.id)).toBe(true);
      expect(coerceSceneId(preset.id)).toBe(preset.id);
    }
    expect(isScenePresetId('random')).toBe(false);
  });

  it('随机只抽真实预设，且能抽到全部棋境', () => {
    // 200 次抽不到某一个的概率可以忽略；这条用例实际是在防
    // 「随机里少写一种」这类复制粘贴事故。
    const drawn = new Set<string>();
    for (let index = 0; index < 200; index += 1) drawn.add(randomSceneId());
    expect(drawn).toEqual(new Set(SCENE_PRESETS.map((preset) => preset.id)));
  });

  it('sceneName 总有可读回显', () => {
    for (const preset of SCENE_PRESETS) expect(sceneName(preset.id)).toBe(preset.name);
  });
});

describe('本地对弈的棋境', () => {
  it('开局自带一个合法棋境', () => {
    const local = new LocalGameState();
    const snapshot = local.start();
    expect(isScenePresetId(snapshot.scene)).toBe(true);
  });

  it('落子与悔棋都不会改棋境', () => {
    const local = new LocalGameState();
    const first = local.start();
    local.move(7, 7);
    local.move(7, 8);
    local.undo();
    const later = local.move(8, 8);
    // 同一局中途换景会让人怀疑自己断线重连了一回。
    expect(later.scene).toBe(first.scene);
    expect(later.moveCount).toBe(2);
  });

  it('start 可以指定棋境', () => {
    const local = new LocalGameState();
    expect(local.start('cyber').scene).toBe('cyber');
    // 重开一局不指定则重新抽签（这里只断言「仍然是合法棋境」，
    // 至于是不是另一个属于概率，不该进断言）。
    expect(isScenePresetId(local.start().scene)).toBe(true);
  });
});
