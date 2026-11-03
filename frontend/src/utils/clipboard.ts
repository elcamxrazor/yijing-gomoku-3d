/**
 * 复制文本到剪贴板。
 *
 * `navigator.clipboard` 也只存在于安全上下文（HTTPS / localhost），所以通过
 * `http://公网IP:25562` 访问时它是 `undefined`。这里在异步 API 不可用时退回到
 * 隐藏 textarea + `document.execCommand('copy')`，让房间号复制在明文 HTTP 下也能用。
 *
 * @returns 是否真正写入剪贴板；`false` 时调用方应把内容直接展示给用户。
 */
export async function copyText(text: string): Promise<boolean> {
  const clipboard = navigator.clipboard;
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // 权限被拒绝时继续尝试兼容方案。
    }
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  document.body.appendChild(area);
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(area);
  }
}
