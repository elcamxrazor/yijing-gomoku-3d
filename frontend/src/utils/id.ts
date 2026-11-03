/**
 * 生成 RFC 4122 v4 标识。
 *
 * `crypto.randomUUID()` 只在「安全上下文」可用（HTTPS、localhost、127.0.0.1）。
 * 通过 `http://内网IP:25562` 或 `http://公网IP:25562` 打开页面时它并不存在，
 * 直接调用会抛出 “crypto.randomUUID is not a function”，于是任何一次落子都会失败。
 *
 * `crypto.getRandomValues()` 没有这个限制，因此这里用它手工拼装 v4 UUID，
 * 只有在极老的浏览器上才退化到 `Math.random`。
 */
export function createRequestId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // version 4
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10xx

  let hex = '';
  for (let index = 0; index < bytes.length; index += 1) {
    hex += (bytes[index] ?? 0).toString(16).padStart(2, '0');
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
