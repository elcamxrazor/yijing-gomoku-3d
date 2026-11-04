# Third-party notices

This project is an original implementation. No artwork, UI assets, audio files
or source code were copied from another game.

## Runtime dependencies

| Component | Licence | Use |
| --- | --- | --- |
| Three.js | MIT | 3D rendering |
| Vite | MIT | frontend build/dev server |
| TypeScript | Apache-2.0 | frontend language/tooling |
| FastAPI | MIT | HTTP and WebSocket API |
| Uvicorn | BSD-3-Clause | ASGI server |
| SQLAlchemy | MIT | persistence |
| Argon2-cffi | MIT | password hashing |
| PyGomo (`pygomo-lib`) | MIT | Gomocup 协议参考（已随引擎迁移退役，见下） |
| Rapfi（WASM 构建） | **GPL-3.0** | 前端五子棋引擎（AI 落子 / 实时分析 / 复盘评估） |
| Vitest | MIT | frontend tests |
| pytest | MIT | backend tests |

## Rapfi engine（当前引擎）

前端引擎为 [Rapfi](https://github.com/dhbloo/rapfi)（Gomocup 顶尖引擎）的
**Emscripten WASM 构建**（multi-simd128 / single-simd128 两变体 + mix9svq 无禁手权重）。
Rapfi 以 **GNU GPL v3** 授权：本项目保留其版权与许可声明。构建产物位于
`frontend/public/engine/`；**本仓库不包含 Rapfi 源码树**（体积大且含上游子模块），
对应源码由官方仓库 <https://github.com/dhbloo/rapfi> 提供。重新构建时，
按 `tools/build_rapfi_wasm.sh` 的说明把上游源码放入 `tools/rapfi/` 后再运行。
依 GPL，任何人取得本应用的 WASM 构建产物时，均可从上述官方仓库获取对应源码。

## Yixin engine（已退役）

2026-11-02 起本项目不再使用 Yixin 引擎。历史决策记录：公开下载版
（demo）不输出 INFO 搜索信息（depth/eval/pv，实测 2017/2018 均如此，
仅商业版有），无法支撑思考可视化，用户拍板整体切换到前端 Rapfi。

## Design references

引擎集成参考了 Rapfi 官方 Web 应用 [gomoku-calculator](https://github.com/dhbloo/gomoku-calculator)
的 Worker/主线程实例化模式与 Gomocup 协议语义（x=col, y=row、INFO 行、YXSTOP）。

## 3D 素材（CC0 / 公有领域）

以下素材下载自 **[Poly Haven](https://polyhaven.com)**，均为 **CC0 1.0 Universal** 授权：
可商用、可修改、可再分发，无需署名。文件已随项目存放在 `frontend/public/` 下，
**运行时不访问外网**，离线也能完整渲染。

| 素材 | 用途 | 文件 |
| --- | --- | --- |
| [Lebombo](https://polyhaven.com/a/lebombo) | 默认室内 HDRI（兜底环境光） | `public/hdri/lebombo_1k.hdr` |
| [Studio Kominka 01](https://polyhaven.com/a/studio_kominka_01) | 茶室环境光（古民家 HDRI） | `public/hdri/studio_kominka_01_1k.hdr` |
| [Chinese Garden](https://polyhaven.com/a/chinese_garden) | 庭院天光 + 360° 天空背景 | `public/hdri/chinese_garden_1k.hdr` |
| [Shanghai Bund](https://polyhaven.com/a/shanghai_bund) | 赛博夜局环境光 + 城市天际线背景 | `public/hdri/shanghai_bund_1k.hdr` |
| [Tatami Mat](https://polyhaven.com/a/tatami_mat) | 茶室榻榻米地面 | `public/textures/tatami_*.jpg` |
| [Japanese Cedar Planks](https://polyhaven.com/a/japanese_cedar_planks) | 茶室木构件与庭院缘侧 | `public/textures/cedar_*.jpg` |
| [Rosewood Veneer 1](https://polyhaven.com/a/rosewood_veneer1) | 茶室桌面 | `public/textures/rosewood_*.jpg` |
| [Dark Wood](https://polyhaven.com/a/dark_wood) | 庭院桌面 | `public/textures/darkwood_*.jpg` |
| [Coast Sand 01](https://polyhaven.com/a/coast_sand_01) | 枯山水砂庭 | `public/textures/zensand_*.jpg` |
| [Metal Plate](https://polyhaven.com/a/metal_plate) | 赛博地面 | `public/textures/metalplate_*.jpg` |
| AI 生成（非第三方素材） | 棋盘木面（榧木纹，`board_diff` 生成图做亮度均衡，`board_nor/rough/ao` 由其派生） | `public/textures/board_*.jpg` |
| [Tea Set 01](https://polyhaven.com/a/tea_set_01) | 茶室桌上茶具（扫描模型） | `public/models/tea_set_01/` |
| [Coast Rocks 01](https://polyhaven.com/a/coast_rocks_01) | 庭院石组（扫描模型） | `public/models/coast_rocks_01/` |
| [Boulder 01](https://polyhaven.com/a/boulder_01) | 庭院石组（扫描模型） | `public/models/boulder_01/` |
| [Jacaranda Tree](https://polyhaven.com/a/jacaranda_tree) | 庭松（调绿）/ 红枫（调红）/ 赛博樱（调粉发光）共用骨架 | `public/models/jacaranda_tree/` |
| [Potted Plant 02](https://polyhaven.com/a/potted_plant_02) | 茶室盆栽 | `public/models/potted_plant_02/` |
| [Book Encyclopedia Set 01](https://polyhaven.com/a/book_encyclopedia_set_01) | 客厅茶几书刊 | `public/models/book_set/` |
| [Postcard Set 01](https://polyhaven.com/a/postcard_set_01) | 影棚台面明信片 | `public/models/postcard_set/` |
| [Camera 01](https://polyhaven.com/a/camera_01) | 影棚台面相机 | `public/models/camera_01/` |
| [Gaming Console](https://polyhaven.com/a/gaming_console) | 赛博桌面游戏主机 | `public/models/gaming_console/` |
| [Projector Screen](https://polyhaven.com/a/projector_screen) | 影棚背景板 / 反光板（运行时换成纯色材质） | `public/models/projector_screen/` |

其余视觉资产（障子纸、霓虹招牌、花瓣、挂轴、图标、纯色兜底材质）
全部由 Canvas 2D 在运行时程序化生成，或直接使用基础几何体，不依赖任何外部文件。

素材总体积约 **61 MB**（HDRI 6.1 MB + 贴图 17 MB + 模型 38 MB；另有 13 MB 的本地 AI 引擎 wasm/data 不计入素材）。
其中扫描树木/岩石模型原始体积高达 214 MB ~ 958 MB（几百万面的摄影测量网格），
经 [gltf-transform](https://gltf-transform.dev) 做 meshopt 简化 + 纹理缩到 512 + 量化压缩后
降到 0.3 ~ 12 MB 不等；法线/粗糙度贴图用 JPEG quality 90 避免色带。
全部为静态文件，可被浏览器与 CDN 正常缓存。
