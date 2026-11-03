# 场景真实化（第七轮优化）

> 适用版本：三种棋境架构落地后。本文记录「在不改动规则层的前提下，把三个 3D 场景
> 从程序化几何体升级为真实素材驱动」的设计取舍、资产清单与验证结论。

## 1. 目标与边界

- **只动场景，不动规则。** 所有胜负、合法性校验仍在 `game/rules.ts` 与服务端
  `app/rules.py`；场景层只负责把已算好的棋盘画出来。
- **真实感优先，体积可控。** 素材全部来自 [Poly Haven](https://polyhaven.com)，
  **CC0 1.0（公有领域）**：可商用、可修改、可再分发、无需署名。
- **离线可用。** 所有素材下载到 `frontend/public/` 随项目分发，运行时不访问外网。

## 2. 素材策略：三类 CC0 资产

| 类别 | 作用 | 在 three.js 中的去向 |
| --- | --- | --- |
| **HDRI 环境贴图** | 真实环境反射 + 一层柔和全局照明，兼作 360° 背景 | `PMREMGenerator` 预滤波 → `scene.environment`；原图 → `scene.background` |
| **PBR 材质贴图** | 榻榻米 / 木构件 / 桌面 / 白砂 / 钢板 / 棋盘的漫反、法线、粗糙、AO | `MeshStandardMaterial` 各通道 |
| **扫描模型（GLB）** | 茶具、盆栽、树木、岩石、石灯 | `GLTFLoader`（挂 `MeshoptDecoder`） |

每个棋境用**各自匹配**的 HDRI（茶室古民家 / 庭院园林 / 赛博外滩），默认 `lebombo_1k.hdr`
作兜底环境光。`UnrealBloom` 后处理**仅赛博棋境**开启。

## 3. 资产清单（约 42 MB）

| 素材（Poly Haven） | 用途 | 文件 |
| --- | --- | --- |
| Lebombo | 默认室内 HDRI（兜底） | `public/hdri/lebombo_1k.hdr` |
| Studio Kominka 01 | 茶室环境光（古民家） | `public/hdri/studio_kominka_01_1k.hdr` |
| Chinese Garden | 庭院天光 + 360° 天空背景 | `public/hdri/chinese_garden_1k.hdr` |
| Shanghai Bund | 赛博环境光 + 城市天际线背景 | `public/hdri/shanghai_bund_1k.hdr` |
| Tatami Mat | 茶室榻榻米地面（带绿席边） | `public/textures/tatami_*.jpg` |
| Japanese Cedar Planks | 茶室木构件、庭院缘侧 | `public/textures/cedar_*.jpg` |
| Rosewood Veneer 1 | 茶室桌面 | `public/textures/rosewood_*.jpg` |
| Dark Wood | 庭院桌面 | `public/textures/darkwood_*.jpg` |
| Coast Sand 01 | 枯山水砂庭 | `public/textures/zensand_*.jpg` |
| Metal Plate | 赛博地面 | `public/textures/metalplate_*.jpg` |
| AI 生成榧木纹（非 Poly Haven） | 棋盘木面 | `public/textures/board_*.jpg` |
| Tea Set 01 | 茶室桌上茶具（扫描） | `public/models/tea_set_01/` |
| Coast Rocks 01 / Boulder 01 | 庭院石组（扫描） | `public/models/coast_rocks_01/`、`boulder_01/` |
| Jacaranda Tree | 庭松 / 红枫 / 赛博樱共用骨架 | `public/models/jacaranda_tree/` |
| Potted Plant 02 | 茶室盆栽 | `public/models/potted_plant_02/` |

体积构成：HDRI 6.1 MB + 贴图 18 MB + 模型 18 MB。扫描树木/岩石原始体积 214 MB ~ 958 MB
（摄影测量高模），经 [gltf-transform](https://gltf-transform.dev) 做 **meshopt 简化 +
纹理缩到 512 + 量化压缩** 后降到 0.3 ~ 12 MB；法线/粗糙度贴图用 JPEG quality 90 避免色带。

## 4. 各棋境改造要点

### 基础茶室（tea，默认）
- 榻榻米换成 `tatami` 全套 PBR（diff / nor / rough / ao 四通道），保留绿席边。
- 梁、柱、障子框用 `cedar` 杉木 PBR；桌面用 `rosewood` 红木（调暗调褐，避免大理石感）。
- 环境光来自古民家 HDRI `studio_kominka_01`。
- 桌上摆**真实扫描茶具** `tea_set_01`，取代原来的几何体堆砌。
- 盆栽换成真实扫描模型 `potted_plant_02`。

### 日式庭院（courtyard）
- `chinese_garden` HDRI 直接作 360° 天空背景 + 天光来源，**程序化的渐变球退役**。
- 枯山水砂庭换成 `zensand` 白砂 PBR（乘亮一档即白川砂），取代旧 `sand_*`。
- 缘侧木平台改用 `cedar`（去橙调灰褐）。
- 石组换成真实扫描岩石 `coast_rocks_01` / `boulder_01`。
- 庭松与红枫共用 `jacaranda_tree` 骨架，分别把叶片调成松绿 / 枫红
  （原本想用松树模型，但 `pine_tree_01` 加载后落在世界原点穿桌，已删除改用骨架调色）。

### 赛博夜局（cyber）
- `shanghai_bund` 外滩夜景 HDRI 作背景，照片级天际线取代程序化楼体盒子。
- 金属网格地面换成 `metalplate` 真实 PBR。
- 樱花树用 `jacaranda_tree` 骨架 + 粉色自发光（点光减弱，避免光晕过曝）。
- 霓虹招牌改为立地灯杆 + 闪烁；保留 `UnrealBloom` 后处理。

## 5. 工程改动

| 文件 | 改动 |
| --- | --- |
| `scene/SceneManager.ts` | 增大相机 `far`（避免裁掉天空球 / 城市天际线）；接入 `EffectComposer` + `UnrealBloom` + `OutputPass` 后处理链（Bloom 仅赛博开启）；`applyEnvironment` 支持每环境 HDRI / 背景 / Bloom；resize / tick / dispose 走后处理 |
| `scene/assets.ts` | 挂 `MeshoptDecoder` 解析压缩 GLB；新增 `loadHdri(url)`（每环境独立加载 + 缓存）；`loadModel` / `loadPbrTextureSet` 加载真实素材；`loadEnvironment` 保留兜底 |
| `scene/environments/Environment.ts` | 基类加 `hdri` / `hdriBackground` / `backgroundIntensity` / `bloom` / `bloomThreshold`；`cylinder()` 加 `parent` 参数（修世界原点黑柱）；`zabuton()` 系带改细改柔 |
| `scene/environments/TeaRoom.ts` | 古民家 HDRI；真实榻榻米 PBR；杉木梁柱；红木桌面；真实茶具；盆栽换真实模型 |
| `scene/environments/Courtyard.ts` | 园林 HDRI 作天空；枯山水换 `zensand`；缘侧换杉木；石组换真实岩石；松/枫用蓝花楹骨架调色；删除程序化天空球与砂庭函数 |
| `scene/environments/Cyberpunk.ts` | 外滩夜景 HDRI 背景；金属网格地面真实 PBR；樱花换蓝花楹骨架 + 粉色自发光；霓虹立地灯杆 + 闪烁；保留 Bloom |

### 清理（与本轮同步）
- 删除弃用的 `public/textures/sand_*.jpg`（被 `zensand_*` 取代）。
- 从 `scene/materials.ts` 移除未调用的旧客厅程序化函数
  `makePlankTexture` / `makeFabricTexture` / `makeSkylineTexture` / `makeSkyTexture` /
  `makeLeafTexture` / `makeScreenTexture` 及其私有辅助 `clampByte` / `mixShade`。
  保留仍在用的 `makeWoodTexture`（棋盘木纹占位，真实贴图到位后热替换）、
  `makeGlowTexture`（棋子光晕）、`createStoneMaterials` / `createStoneGeometry`。

## 6. 体积与性能

- 全部素材约 **42 MB**（原摄影测量模型 214 MB ~ 958 MB），静态文件可被浏览器与 CDN 缓存。
- 模型经 meshopt + 512 纹理 + 量化压缩；`GLTFLoader` 必须挂 `MeshoptDecoder` 才能解析。
- 异步加载后热替换：房间先以纯色建好，贴图 / 模型到位再挂上，不白屏。
- 素材顺序：模型先发、贴图后发，避免十几张大贴图占满 6 条并发连接把模型排到后面。

## 7. 验证结论

- `vite build` 通过；前端 **49 项 vitest** 通过；后端 **62 项 pytest** 通过。
- Playwright 三场景截图人工核验达标（茶室真实榻榻米 + 茶具、庭院真实岩石松树 + 天空、
  赛博外滩天际线 + Bloom）。
- 双人同房间同棋境 `SAME-SCENE OK`（同局所有人必在同一棋境，由 `games.scene` 广播）。

## 8. 已知取舍

- 松树模型因原点问题退役，庭松 / 红枫改用蓝花楹骨架调色，并非真实松/枫模型。
- 赛博樱花点光被刻意减弱，辉光主要交给自发光 + Bloom，避免过曝。
- 茶室红木桌面调暗调褐，规避初版偏亮的大理石感。
- 程序化兜底纹理（棋盘木纹占位、棋子光晕）与棋境辅助贴图（障子纸、赛博地面、
  霓虹、花瓣、挂轴）仍由 Canvas 运行时生成，不依赖外部文件。
