import { afterEach, describe, expect, it } from 'vitest';
import { createRequestId } from './id';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const original = {
  crypto: globalThis.crypto,
  randomUUID: globalThis.crypto?.randomUUID,
  getRandomValues: globalThis.crypto?.getRandomValues,
};

function strip(api: 'randomUUID' | 'getRandomValues'): void {
  Object.defineProperty(globalThis.crypto, api, {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  if (original.randomUUID) {
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      value: original.randomUUID,
      configurable: true,
      writable: true,
    });
  }
  if (original.getRandomValues) {
    Object.defineProperty(globalThis.crypto, 'getRandomValues', {
      value: original.getRandomValues,
      configurable: true,
      writable: true,
    });
  }
});

describe('createRequestId', () => {
  it('返回合法的 v4 标识', () => {
    expect(createRequestId()).toMatch(UUID_V4);
  });

  it('每次调用都不相同', () => {
    const ids = new Set(Array.from({ length: 200 }, () => createRequestId()));
    expect(ids.size).toBe(200);
  });

  // 通过 http://公网IP 访问时 crypto.randomUUID 不存在，这是用户实际遇到的崩溃场景。
  it('randomUUID 缺失时仍能生成 v4 标识', () => {
    strip('randomUUID');
    expect(createRequestId()).toMatch(UUID_V4);
  });

  it('crypto 完全不可用时退回 Math.random', () => {
    strip('randomUUID');
    strip('getRandomValues');
    expect(createRequestId()).toMatch(UUID_V4);
  });
});
