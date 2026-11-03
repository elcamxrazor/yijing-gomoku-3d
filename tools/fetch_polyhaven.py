"""从 Poly Haven 抓取 CC0 素材，落地到 frontend/public/。

为什么需要这个脚本，而不是直接 curl 下载 `.gltf`：

Poly Haven 发布的是「`.gltf` + 外部 `.bin` + `textures/` 目录」的分体式 glTF。
本项目实测这种格式在浏览器里会**静默卡住**——`.gltf` 请求 200，`.bin` 永不发出，
`GLTFLoader.loadAsync` 既不 resolve 也不 reject（详见 HANDOFF 的踩坑记录）。
所以统一转成**单文件 GLB**：几何 buffer 与全部贴图都内嵌进一个二进制块，
一次请求拿全，同时省掉十几个 HTTP 请求。

用法：
    python tools/fetch_polyhaven.py model Ottoman_01 ottoman_01
    python tools/fetch_polyhaven.py texture bamboo_wall_02 bamboo
    python tools/fetch_polyhaven.py texture raked_dirt raked
"""

from __future__ import annotations

import io
import json
import os
import struct
import sys
import urllib.parse
import urllib.request

MODEL_GLTF = "https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/{id}/{id}_1k.gltf"
MODEL_TEX = "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/{id}/"
# 贴图分辨率：默认 1k；需要更清晰的（近景的棋盘、桌面）用 PH_RES=2k 覆盖。
TEXTURE_RES = os.environ.get("PH_RES", "1k")
TEXTURE_JPG = "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/{res}/{id}/{id}_{kind}_{res}.jpg"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(ROOT, "frontend", "public")

# 贴图通道 → 项目里的文件名后缀（loadPbrTextureSet 的约定）
TEXTURE_CHANNELS = {
    "diff": "diff",
    "nor_gl": "nor",
    "rough": "rough",
    "ao": "ao",
    "disp": "disp",
}

# 超过这个体积就重压一遍，避免单个模型把首屏拖垮
MAX_TEXTURE_BYTES = 400_000
# 贴图长边上限。街景道具在画面里只有几十像素，1K 贴图纯属浪费带宽；
# 需要更清晰的（比如近景的树）用环境变量 PH_TEX_EDGE=1024 覆盖。
MAX_TEXTURE_EDGE = int(os.environ.get("PH_TEX_EDGE", "512"))


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "gomoku-asset-fetch/1.0"})
    with urllib.request.urlopen(request, timeout=180) as response:
        return response.read()


def recompress(data: bytes, quality: int) -> bytes:
    """降采样 + 重压。体积能砍掉一个数量级，肉眼几乎看不出差别。"""
    from PIL import Image  # 延迟导入：只用 resample 时才需要 Pillow

    image = Image.open(io.BytesIO(data))
    if image.mode not in ("RGB", "L"):
        image = image.convert("RGB")
    longest = max(image.size)
    if longest > MAX_TEXTURE_EDGE:
        ratio = MAX_TEXTURE_EDGE / longest
        image = image.resize(
            (max(1, round(image.width * ratio)), max(1, round(image.height * ratio))),
            Image.LANCZOS,
        )
    out = io.BytesIO()
    image.save(out, "JPEG", quality=quality, optimize=True, progressive=True)
    result = out.getvalue()
    # 压完反而更大就保留原图
    return result if len(result) < len(data) else data


def build_glb(asset_id: str, out_name: str) -> None:
    """下载分体 glTF，合并成一个内嵌贴图的 GLB。"""
    gltf_url = MODEL_GLTF.format(id=asset_id)
    base_url = gltf_url.rsplit("/", 1)[0] + "/"
    document = json.loads(fetch(gltf_url).decode("utf-8"))

    # ---- 1) 合并全部 buffer 到一个二进制块 ----
    merged = bytearray()
    buffer_offsets: list[int] = []
    for buffer in document["buffers"]:
        uri = buffer.get("uri")
        data = fetch(base_url + urllib.parse.quote(urllib.parse.unquote(uri))) if uri else b""
        merged.extend(b"\x00" * ((-len(merged)) % 4))
        buffer_offsets.append(len(merged))
        merged.extend(data)

    for view in document.get("bufferViews", []):
        index = view.get("buffer", 0)
        view["byteOffset"] = view.get("byteOffset", 0) + buffer_offsets[index]
        view["buffer"] = 0
    document["buffers"] = [{"byteLength": len(merged)}]

    binary = bytearray(merged)

    def append_chunk(data: bytes) -> tuple[int, int]:
        binary.extend(b"\x00" * ((-len(binary)) % 4))
        offset = len(binary)
        binary.extend(data)
        return offset, len(data)

    # ---- 2) 贴图内嵌 ----
    texture_base = MODEL_TEX.format(id=asset_id)
    texture_count = 0
    for image in document.get("images", []):
        uri = image.get("uri")
        if not uri:
            continue
        filename = os.path.basename(urllib.parse.unquote(uri))
        data = fetch(texture_base + urllib.parse.quote(filename))
        # 模型自带的贴图一律降采样重压：1K 的皮革/金属贴图对几十像素的道具毫无意义
        data = recompress(data, 84)
        offset, length = append_chunk(data)
        index = len(document["bufferViews"])
        document["bufferViews"].append(
            {"buffer": 0, "byteOffset": offset, "byteLength": length}
        )
        image.pop("uri", None)
        image["bufferView"] = index
        image["mimeType"] = "image/jpeg"
        texture_count += 1

    document["buffers"][0]["byteLength"] = len(binary)

    # ---- 3) 组装 GLB ----
    payload = json.dumps(document, separators=(",", ":")).encode("utf-8")
    payload += b" " * ((-len(payload)) % 4)
    binary.extend(b"\x00" * ((-len(binary)) % 4))

    total = 12 + 8 + len(payload) + 8 + len(binary)
    glb = bytearray(b"glTF")
    glb += struct.pack("<II", 2, total)
    glb += struct.pack("<I", len(payload)) + b"JSON"
    glb += payload
    glb += struct.pack("<I", len(binary)) + b"BIN\x00"
    glb += binary

    target_dir = os.path.join(PUBLIC, "models", out_name)
    os.makedirs(target_dir, exist_ok=True)
    target = os.path.join(target_dir, f"{out_name}_1k.glb")
    with open(target, "wb") as handle:
        handle.write(glb)

    meshes = len(document.get("meshes", []))
    print(
        f"{asset_id:32s} -> {out_name}/{out_name}_1k.glb  "
        f"{len(glb) / 1024:7.0f}K  meshes={meshes} textures={texture_count}"
    )


def build_texture(asset_id: str, out_prefix: str) -> None:
    """下载一套 PBR 贴图，按项目的 `{prefix}_{kind}.jpg` 约定命名。"""
    target_dir = os.path.join(PUBLIC, "textures")
    os.makedirs(target_dir, exist_ok=True)
    print(f"--- {asset_id} -> {out_prefix}_* ---")
    for source_kind, suffix in TEXTURE_CHANNELS.items():
        url = TEXTURE_JPG.format(id=asset_id, kind=source_kind, res=TEXTURE_RES)
        try:
            data = fetch(url)
        except Exception as error:  # 缺通道是正常的（有些素材没有 disp）
            print(f"  {suffix:6s} SKIP ({error})")
            continue
        if len(data) > 200_000:
            data = recompress(data, 92 if source_kind in ("nor_gl", "rough", "disp") else 86)
        path = os.path.join(target_dir, f"{out_prefix}_{suffix}.jpg")
        with open(path, "wb") as handle:
            handle.write(data)
        print(f"  {suffix:6s} {len(data) / 1024:6.0f}K  {os.path.basename(path)}")


def main(argv: list[str]) -> int:
    if len(argv) < 4:
        print(__doc__)
        return 1
    kind = argv[1]
    pairs = list(zip(argv[2::2], argv[3::2]))
    for asset_id, out_name in pairs:
        if kind == "model":
            build_glb(asset_id, out_name)
        elif kind == "texture":
            build_texture(asset_id, out_name)
        else:
            print(f"未知类型 {kind}")
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
