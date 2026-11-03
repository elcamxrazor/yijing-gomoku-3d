"""把「CG美术之家」那类 glTF 套件（.gltf + buffer.bin + 散装 jpg）裁成一个能进游戏的 GLB。

为什么要这个脚本，而不是直接用 `tools/fetch_polyhaven.py`：

* 这类套件是**整套户型**（客厅 + 卧室 + 厨房 + 卫生间），一次导进来 186 万三角面、
  46MB 几何、30MB 贴图。面数几乎全花在窗帘、毛巾、门把手上——一条 5cm 的毛巾
  18 万面，比整个客厅的家具加起来还多。不裁就没法进游戏。
* 它是 **Z-up**（地板 z=0、天花 z=3.29），直接加载到 three（Y-up）是躺着的。
* 所有贴图是外部 jpg，需要压到 1K 再内嵌，否则单模型比全站素材还大。

产物：`frontend/public/models/<name>/<name>_1k.glb`（单文件，几何 + 贴图全内嵌）。

用法：
    python tools/import_cg_gltf.py "C:/path/to/套件目录" living_room
"""

from __future__ import annotations

import io
import json
import math
import os
import re
import struct
import sys

from PIL import Image

# 贴图长边上限与质量：22 张 2K jpg 压成 1K/85 之后约 3~4MB
MAX_TEXTURE_EDGE = 1024
JPEG_QUALITY = 85

# 只做客厅：这些名字一律丢掉（被子、毛巾、水槽、马桶、橱柜……）
DROP_NAME = re.compile(
    r"curtain|towel|bed|quilt|sheet|pillow|sink|toilet|bath|kitchen|dining|basin|wash|floor_lamp",
    re.I,
)
# 房子的「骨架」：地板、天花、墙、踢脚线、插座，无论落在哪个房间都留着
KEEP_NAME = re.compile(
    r"^(floor|ceiling|wall|coving|running_032board|sockets|screw)", re.I
)
# 客厅在原始坐标里的 Y 区间（Z-up 的 Y 是「进深」）。卧室在 Y>3.4，厨卫在 Y<-5。
KEEP_Y_RANGE = (-5.0, 3.4)
# 面数黑洞的判据：单个小物件（最长边 < 1.2m）却超过 4 万面
SMALL_OBJECT_EDGE = 1.2
SMALL_OBJECT_TRIS = 40_000


def drop_reason(name: str, mid_y: float, longest: float, tris: int) -> str | None:
    """返回丢弃原因；None 表示保留。顺序即优先级，先判的先赢。"""
    if DROP_NAME.search(name):
        return "名称"
    if KEEP_NAME.search(name):
        return None
    if not (KEEP_Y_RANGE[0] <= mid_y <= KEEP_Y_RANGE[1]):
        return "别的房间"
    if tris > SMALL_OBJECT_TRIS and longest < SMALL_OBJECT_EDGE:
        return "面数黑洞"
    return None


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    src, name = sys.argv[1], sys.argv[2]
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(root, "frontend", "public", "models", name)
    os.makedirs(out_dir, exist_ok=True)

    gltf_file = next(f for f in os.listdir(src) if f.lower().endswith(".gltf"))
    doc = json.load(open(os.path.join(src, gltf_file), encoding="utf-8"))
    bin_blob = open(os.path.join(src, doc["buffers"][0]["uri"]), "rb").read()

    accessors = doc["accessors"]
    materials = doc["materials"]

    # ---- 1. 挑出要保留的图元 ----------------------------------------
    kept_prims = []
    kept_tris = dropped_tris = 0
    for prim in doc["meshes"][0]["primitives"]:
        pos = accessors[prim["attributes"]["POSITION"]]
        tris = (
            accessors[prim["indices"]]["count"] // 3
            if "indices" in prim
            else pos["count"] // 3
        )
        mat_name = materials[prim["material"]].get("name", "")
        size = [pos["max"][i] - pos["min"][i] for i in range(3)]
        mid_y = (pos["max"][1] + pos["min"][1]) / 2
        if drop_reason(mat_name, mid_y, max(size), tris):
            dropped_tris += tris
            continue
        kept_prims.append(prim)
        kept_tris += tris
    print(f"保留 {len(kept_prims)} 个图元 / {kept_tris:,} 面；丢弃 {dropped_tris:,} 面")

    # ---- 2. 重排 accessor / bufferView ------------------------------
    #
    # 这里**不能**按 bufferView 整段拷贝。原文件把所有顶点数据塞在几个几十 MB 的
    # bufferView 里，accessor 靠 byteOffset 在里面定位；整段搬过来会把被裁掉的
    # 一百多万面也一起带上（实测：只留 27 万面，GLB 仍然 21MB）。
    # 正确做法是按 accessor 的真实字节范围切片，再按 (bufferView, 起止) 去重。
    used_accessors = sorted(
        {idx for p in kept_prims for idx in p["attributes"].values()}
        | {p["indices"] for p in kept_prims if "indices" in p}
    )
    index_accessors = {p["indices"] for p in kept_prims if "indices" in p}

    def element_size(acc: dict) -> int:
        component = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
        width = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}
        return component[acc["componentType"]] * width[acc["type"]]

    new_blob = bytearray()
    new_views: list[dict] = []
    slice_map: dict[tuple[int, int, int], int] = {}

    def slice_view(old_view: int, start: int, end: int, target: int | None, stride: int | None, min_bytes: int) -> int:
        key = (old_view, start, end)
        if key in slice_map:
            return slice_map[key]
        while len(new_blob) % 4:
            new_blob.append(0)
        view = {"buffer": 0, "byteOffset": len(new_blob), "byteLength": max(end - start, min_bytes)}
        if target is not None:
            view["target"] = target
        if stride is not None:
            view["byteStride"] = stride
        payload = bin_blob[start:end]
        # 原文件里最后一个 accessor 的数据可能顶着 buffer 结尾，没有步长尾巴；
        # three 的 GLTFLoader 要求 view 容得下 count*stride 字节，不足的部分补零。
        if len(payload) < min_bytes:
            payload += b"\x00" * (min_bytes - len(payload))
        new_blob.extend(payload)
        new_views.append(view)
        slice_map[key] = len(new_views) - 1
        return slice_map[key]

    def append_blob(payload: bytes) -> int:
        while len(new_blob) % 4:
            new_blob.append(0)
        new_views.append({"buffer": 0, "byteOffset": len(new_blob), "byteLength": len(payload)})
        new_blob.extend(payload)
        return len(new_views) - 1

    acc_map = {old: new for new, old in enumerate(used_accessors)}
    new_accessors = []
    for old in used_accessors:
        acc = dict(accessors[old])
        if acc.get("sparse"):
            raise SystemExit("遇到 sparse accessor，这个脚本没处理")
        old_view = acc.get("bufferView")
        if old_view is not None:
            view = doc["bufferViews"][old_view]
            size = element_size(acc)
            stride = view.get("byteStride") or size
            offset = acc.get("byteOffset", 0)
            begin = view.get("byteOffset", 0) + offset
            finish = begin + stride * (acc["count"] - 1) + size
            target = 34963 if old in index_accessors else 34962
            # three 的 GLTFLoader 读 interleaved view 时按 count*stride 取字节，
            # 切片必须留足整个步长网格（结尾数据不足就补零）。
            min_bytes = stride * acc["count"] if stride > size else size * acc["count"]
            acc["bufferView"] = slice_view(old_view, begin, finish, target, view.get("byteStride"), min_bytes)
            acc["byteOffset"] = 0
        new_accessors.append(acc)

    # ---- 3. 材质 / 贴图 ---------------------------------------------
    used_materials = sorted({p["material"] for p in kept_prims})
    mat_map = {old: new for new, old in enumerate(used_materials)}

    used_textures: set[int] = set()
    for old in used_materials:
        mat = materials[old]
        pbr = mat.get("pbrMetallicRoughness", {})
        for key in ("baseColorTexture", "metallicRoughnessTexture"):
            if key in pbr:
                used_textures.add(pbr[key]["index"])
        for key in ("normalTexture", "occlusionTexture", "emissiveTexture"):
            if key in mat:
                used_textures.add(mat[key]["index"])
    used_textures = sorted(used_textures)

    images = doc.get("images", [])
    textures = doc.get("textures", [])
    samplers = doc.get("samplers", [])

    # 先压图片，按老 image 索引缓存
    image_bytes: dict[int, bytes] = {}
    for tex_index in used_textures:
        image_index = textures[tex_index]["source"]
        if image_index in image_bytes:
            continue
        image = images[image_index]
        raw = open(os.path.join(src, image["uri"]), "rb").read()
        bitmap = Image.open(io.BytesIO(raw))
        if bitmap.mode not in ("RGB", "L"):
            bitmap = bitmap.convert("RGB")
        if max(bitmap.size) > MAX_TEXTURE_EDGE:
            scale = MAX_TEXTURE_EDGE / max(bitmap.size)
            bitmap = bitmap.resize(
                (max(1, round(bitmap.width * scale)), max(1, round(bitmap.height * scale))),
                Image.LANCZOS,
            )
        out = io.BytesIO()
        bitmap.save(out, "JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)
        image_bytes[image_index] = out.getvalue()

    used_images = sorted({textures[t]["source"] for t in used_textures})
    image_map = {old: new for new, old in enumerate(used_images)}
    new_images = []
    for old in used_images:
        payload = image_bytes[old]
        view_index = append_blob(payload)
        new_images.append({"bufferView": view_index, "mimeType": "image/jpeg"})

    used_samplers = sorted({textures[t]["sampler"] for t in used_textures if "sampler" in textures[t]})
    sampler_map = {old: new for new, old in enumerate(used_samplers)}

    tex_map = {old: new for new, old in enumerate(used_textures)}
    new_textures = []
    for old in used_textures:
        tex = {"source": image_map[textures[old]["source"]]}
        if "sampler" in textures[old]:
            tex["sampler"] = sampler_map[textures[old]["sampler"]]
        new_textures.append(tex)

    new_materials = []
    for old in used_materials:
        mat = json.loads(json.dumps(materials[old]))  # 深拷贝
        pbr = mat.get("pbrMetallicRoughness", {})
        for key in ("baseColorTexture", "metallicRoughnessTexture"):
            if key in pbr:
                pbr[key]["index"] = tex_map[pbr[key]["index"]]
        for key in ("normalTexture", "occlusionTexture", "emissiveTexture"):
            if key in mat:
                mat[key]["index"] = tex_map[mat[key]["index"]]
        # 玻璃原本是 OPAQUE，导入后在灯光下会变成一块不透明的白板
        if re.search(r"^glass$|^glass_", mat.get("name", ""), re.I):
            mat["alphaMode"] = "BLEND"
            pbr.setdefault("baseColorFactor", [1, 1, 1, 1])
            pbr["baseColorFactor"] = [*pbr["baseColorFactor"][:3], 0.32]
        new_materials.append(mat)

    # ---- 4. 重写 mesh / node ----------------------------------------
    new_prims = []
    for prim in kept_prims:
        prim = json.loads(json.dumps(prim))
        prim["attributes"] = {k: acc_map[v] for k, v in prim["attributes"].items()}
        if "indices" in prim:
            prim["indices"] = acc_map[prim["indices"]]
        prim["material"] = mat_map[prim["material"]]
        new_prims.append(prim)

    nodes = json.loads(json.dumps(doc["nodes"]))
    for node in nodes:
        if "mesh" in node:
            # Z-up → Y-up：绕 X 轴 -90°，地板落到 y=0。
            node["rotation"] = [-0.7071067811865476, 0.0, 0.0, 0.7071067811865476]

    out_doc = {
        "asset": {
            "version": "2.0",
            "generator": "yijing import_cg_gltf.py",
        },
        "scene": 0,
        "scenes": doc["scenes"],
        "nodes": nodes,
        "meshes": [{"primitives": new_prims}],
        "materials": new_materials,
        "textures": new_textures,
        "images": new_images,
        "accessors": new_accessors,
        "bufferViews": new_views,
        "buffers": [{"byteLength": 0}],  # 稍后回填
    }
    if used_samplers:
        out_doc["samplers"] = [samplers[old] for old in used_samplers]

    # ---- 5. 打包 GLB ------------------------------------------------
    json_bytes = json.dumps(out_doc, separators=(",", ":")).encode("utf-8")
    json_bytes += b" " * ((4 - len(json_bytes) % 4) % 4)
    while len(new_blob) % 4:
        new_blob.append(0)

    out_path = os.path.join(out_dir, f"{name}_1k.glb")
    total = 12 + 8 + len(json_bytes) + 8 + len(new_blob)
    with open(out_path, "wb") as handle:
        handle.write(b"glTF")
        handle.write(struct.pack("<II", 2, total))
        handle.write(struct.pack("<I", len(json_bytes)) + b"JSON")
        handle.write(json_bytes)
        handle.write(struct.pack("<I", len(new_blob)) + b"BIN\x00")
        handle.write(new_blob)

    print(f"写出 {out_path}")
    print(f"  GLB {total/1e6:.2f} MB（几何 {len(new_blob)/1e6:.2f} MB，贴在几何之后）")
    print(f"  材质 {len(new_materials)}，贴图 {len(new_images)} 张")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
