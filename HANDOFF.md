# 弈境（Yijing Gomoku）项目交接文档

> 供接手的同事快速了解项目全貌、已完成的改动、以及**待办事项**。
> 最后更新：2026-11-05（已含第 6 轮「三种棋境」架构、第 7 轮 CC0 真实素材场景优化，以及批次十四～十六：棋境陈设真实模型 + 防穿模、桌面陈设按实拍反馈校准尺寸与姿态、顶部 HUD 精简为两行；多会话并发防护与发布门禁已落地；文档与代码已对齐，可直接交接）

---

## 1. 项目是什么

一个**原创的 3D 禅意风格网页联机五子棋**。核心特征：

- **前端**：Vite 7 + TypeScript 5.9（strict 模式）+ Three.js 0.180，WebGL 3D 渲染
- **后端**：FastAPI + Starlette WebSocket + SQLAlchemy 2.1 + Pydantic Settings
- **AI 引擎**：Yixin（弈心），C++ 程序，浏览器跑不了 → 走后端桥接：
  `浏览器 ⇄ WebSocket ⇄ FastAPI ⇄ 管道(pipe) ⇄ Yixin 子进程`，协议用 `pygomo-lib` 实现 Gomocup
- **功能**：账号注册/登录/登出（Argon2id 密码哈希）、游客单机、人机对战（可选黑白）、
  **在线大厅 + 约战**（在线名单 / 点人约战 / 对方接受即随机分配黑白开局）、
  联机（建房/房间号加入/实时同步/断线重连/认输/悔棋）、15×15 黑先五连判胜、平局、
  最后落子标记。禁手**未实现**但预留了扩展点。

**代码规模**：前端 ~5900 行（24 个 TS/CSS 文件），后端 ~3000 行（28 个 Python 文件）。
另有 README、Dockerfile、docker-compose、Caddy/Nginx 部署配置。

---

## 2. 目录结构（关键文件）

```
项目根 = C:\Users\45126\WorkBuddy\3d-yijing-gomoku

backend/
  app/
    main.py             FastAPI 入口，端口预检，SPA 静态托管
    config.py           Pydantic Settings（所有环境变量）
    models.py           User/AuthSession/Game/GameMove（SQLAlchemy）
    rules.py            BOARD_SIZE=15、五连判胜、RulePolicy 禁手扩展点
    game.py             权威对局服务（落子/悔棋/认输/重开/断线回收/AI 调度）
    lobby.py            在线大厅：座位状态、名单推送、约战握手（内存，不落库）
    spectate.py         观战：只读席位、人数、断线即退（内存，不落库）
    radio.py            网络电台曲库：扫描目录、按 id 索引
    radio_routes.py     /api/radio 曲目清单与音频流（Range）
    scenes.py           棋境预设表（tea/courtyard/cyber/living/studio）、normalize_scene、random_scene
    hub.py              连接池、个性化快照广播、幂等缓存
    websocket.py        WS 协议分发、Origin 校验、心跳
    security.py         Argon2id、token、限流
    auth_routes.py      注册/登录/登出/游客/me
    database.py         SQLite WAL
    engine/
      base.py           EngineAdapter 抽象基类
      pygomo_adapter.py Gomocup 协议适配（真实 Yixin）
      manager.py        引擎会话池（LRU 淘汰、超时杀进程重建）
      protocol.py       坐标转换（后端 (row,col) ↔ 引擎 (x=col,y=row)）
      fake.py           确定性测试适配器
  tests/                141 项 pytest（规则/协议/认证/心跳/引擎/AI/联机/大厅/观战/掉线/电台/棋境/积分隐私）

frontend/
  src/
    main.ts             编排：认证、模式、落子、悔棋、认输、退出、音效
    scene/
      GomokuScene.ts    门面（对外 4 个方法 + setScene 换棋境，main.ts 依赖它的接口）
      SceneManager.ts   渲染器/相机/OrbitControls/主循环/推镜/限帧/applyEnvironment
      BoardManager.ts   棋盘/棋子/落子动画/拾取/悬停预览/获胜高亮
      Bell.ts           桌上那枚铜铃：命中测试、按铃动画、声波
      CoinScene.ts      开局抛硬币的 3D 小场景（见 3.10）：两面刻名、抛起/旋转/落地
      environments/     五种棋境（见 3.7）：
        Environment.ts    抽象基类：造形工具、氛围字段（background/fog/exposure…）、intro
        TeaRoom.ts        基础茶室（榻榻米/障子窗/床之间/行灯）
        Courtyard.ts      日式庭院（缘侧/枯山水/石灯笼/松枫/蹲踞）
        Cyberpunk.ts      赛博夜局（霓虹网格/赛博樱花/飘落花瓣/灯牌闪烁）
        LivingRoom.ts     现代客厅（CG 户型套件裁剪导入，茶几对位）
        Studio.ts         摄影棚（360° 弧形无缝背景 + 柔光箱面光 + 接触阴影）
        textures.ts       程序化纹理（榻榻米/障子纸/砂纹/天空/网格/霓虹/花瓣）
      assets.ts         CC0 素材加载（HDRI/PBR 贴图/GLB 模型）
      materials.ts      程序化木纹/天际线/屏幕贴图/棋子材质
      config.ts         常量、机位、配色、棋子尺寸
      animation/tween.ts 自研补间引擎（未引入 gsap）
    game/               规则、本地状态、类型、断线横幅口径（presence.ts）
    network/GameSocket.ts WS 客户端、重连、心跳
    audio/SoundManager.ts Web Audio 程序化音效
    audio/Radio.ts       网络电台播放器（自动接续、音量/静音持久化）
    ui/                 DOM 骨架、反馈、图标
    utils/              id（兼容非安全上下文的 UUID）、clipboard
  public/               CC0 素材（见第 4 节）

deploy/Caddyfile、deploy/nginx.conf   反代配置（含 WS 升级头）
engines/yixin17/pbrain-Yixin17_64.exe  Yixin 引擎（gitignore 内，需自备）
docker-compose.yml、Dockerfile
README.md、THIRD_PARTY_NOTICES.md
```

---

## 3. 已完成的功能全景（按开发顺序）

### 3.1 核心功能（最初交付）

- **AI 桥接**：每局独立 Yixin 子进程 + `asyncio.Lock` 串行化 + `asyncio.to_thread`
  不阻塞事件循环；超时杀进程重建；`generation` 版本号丢弃过期 AI 结果
- **悔棋/重连/重开**：统一走 `START + BOARD` 棋谱重建，不依赖引擎撤销
- **联机**：服务端权威状态 + 个性化快照广播、6 位房间号、requestId 幂等、
  Origin 校验、ping/pong 心跳、断线 120s 宽限（仅对手在线才判负）
- **认证**：Argon2id、256 位随机 token（DB 只存 SHA-256）、HttpOnly + SameSite=Lax Cookie
- **3D**：程序化木纹、MeshPhysicalMaterial clearcoat 棋子、涟漪/缩放动画、Raycaster 拾取

### 3.2 功能修复

- **非安全上下文崩溃**：`crypto.randomUUID()` 在 `http://公网IP` 下是 `undefined`，
  导致落子请求直接抛异常。新增 `utils/id.ts`（回退 `getRandomValues` 手拼 UUID），
  以及 `utils/clipboard.ts`（回退 `execCommand('copy')`）。
- **AI 会话泄漏**：中途关闭页面的对局一直占引擎进程，累积到上限新对局报"服务繁忙"。
  加了两层：presence 循环每 5s 扫一次释放空闲会话；容量满时 LRU 淘汰最久未用且空闲的会话。
- **退出后回不到模式选择**：`main.ts` 的 `handleRemoteSnapshot` 在 `snapshot === null`（刚退出）
  时无防护，服务器补发的旧快照会把玩家拽回棋盘。加 `if (!this.snapshot && !this.awaitingRemoteGame) return;`。
- **限帧**：渲染循环分两档上限——有运动 60fps、静止 30fps；静止时关 `shadowMap.autoUpdate`。
  （这是为了"不想让显卡风扇转"，144Hz 屏上同一张静止画面原来会被画 144 次/秒）

### 3.3 在线大厅与约战（本轮新增，原先的头号待办）

`backend/app/lobby.py` + `frontend` 的联机弹窗，把「建房/房间号」之外的另一条入口补齐：

- **大厅名单**：`lobby.players` 推给「订阅了大厅」的连接（`lobby.watch {on}`）。
  对局中的玩家不会被别人的进进出出打断，也不会为每次连接变化付一次广播成本。
- **座位状态**：`可约战 / 房间等待中 / 对弈中`，判据是**客户端报告的 `game.focus`**
  （我此刻在看哪盘棋），不是「库里有没有没下完的棋」。理由见 5.11。
- **约战握手**：`challenge.create → challenge.incoming → challenge.respond`，
  30 秒 TTL（`CHALLENGE_TTL_SECONDS`），可撤回；对方掉线立刻作废。
- **开局**：接受后先推 `challenge.result` 再推 `game.snapshot`，客户端靠这个顺序
  决定是否认领快照。建局时随机定的是「初始座次」，**实际先后手由开局协商决定**
  ——双方各自选「希望谁先手」，一致则直接定、不一致抛硬币（详见 3.10）。
- **失败路径**：自己不能约自己；同一目标重复发起是幂等的；手上已有待回应邀请时
  不能再发起（`CHALLENGE_INCOMING`）；对局中的人被约战时客户端直接回绝并提示。

UI 侧：联机弹窗拆成「在线大厅 / 房间号」两个页签；`#challenge-sent` 浮卡显示
「等待某某回应 + 倒计时 + 撤回」；`#challenge-dialog` 是收到邀请的弹窗（进度条倒计时）。
面板打开时每 5 秒重发一次 `lobby.watch {on:true}` 做兜底刷新。

### 3.4 网络电台（本轮新增，后改为全服同步）

`backend/app/radio.py` + `frontend/src/audio/Radio.ts`，一台「发射机」而不是播放器。

- **曲库**：扫描 `RADIO_DIR`（默认仓库根下的 `radio/`；本机在 `backend/.env` 里指到了
  `C:/Users/45126/Desktop/音乐库`），只认音频后缀，按文件名排序，最多 1000 首；
  列表有 8 秒缓存。目录为空时 `/api/radio` 返回 `enabled:false`，前端把入口整个隐藏。
- **曲名**：读 ID3v2 的 `TIT2` / `TPE1`（手写 ~40 行，没有引入 mutagen），读不到才退回
  文件名。**这条是实测逼出来的**：用户的文件是音乐 App 缓存下来的
  `M800000dB5PY0Fmiev.mp3`，只按文件名显示等于没有曲名。
- **时长**：排期的前提。mp3 常量码率按字节数算、VBR 读 Xing 帧数，wav 读 `fmt`/`data`，
  flac 读 `STREAMINFO`，ogg/opus 读末页 granule（Opus 固定 48kHz 并扣 pre-skip）；
  其它按 192kbps 估算。标签与时长都按 mtime+size 缓存。
- **排期**：`_epoch`（这一轮起点）+ 每首的累计偏移 + 总长，`_position_at(now)` 用
  `(now - epoch) % total` 二分定位。曲目变了就重建，并把正在播的那首原位接上。
- **同步**：客户端只要一次 `(哪首, 第几秒)` 当锚点，之后用**本机 `performance.now()`**
  往前走，30 秒对一次表。刻意不比较两台机器的绝对时间（见 5.16）。
- **音量**：滑杆位置取平方作为增益（见 5.17）。
- **起播**：只有点电台按钮（或卡片）那一次手势会起播；页面里其它点击不再触发，
  来下棋的人不该被背景音乐突袭。

### 3.5 观战、断线判负与铜铃（本轮新增）

`backend/app/spectate.py` + `frontend` 的大厅与状态条，三件「坐在棋盘边」的事。

- **观战**：大厅里 `playing` 的行多一个「观战」按钮 → `spectate.join {gameId}`。
  观战者**不占座位**（不写 `game.focus`）、不写库、快照里 `yourColor = null`；
  服务端所有写操作的权限判据仍是 `_participants`，观战身份不参与其中。
  棋局结束时观战者留在原地看结果（结算卡没有「再来一局」）。
- **人数**：快照带 `spectatorCount`，进 / 出观战都会广播一次快照，局内人状态条上
  直接看到「观战 N 人」。观战的登记与退出都在内存里，断线即退。
- **掉线提示**：连接断开时 `player_presence(False)` 给对面推 `game.presence`
  （带 `reconnectInMs`），同时把这一轮快照再广播一次——快照里的 `presence`
  是「现在是什么状态」，事件是「刚刚发生了什么」，两边都要有。
- **两分钟判负**：`_check_disconnects` 用同一个 `_offline_since` 起点，超时把
  `win_reason` 记成 `offline`（不是 `resign`：结算卡要写清原因）。
  **双方都掉线时不计时**，否则两个人都关电脑会判给先掉线的那个。
- **铜铃**：`frontend/src/scene/Bell.ts` 是桌面上的一枚按铃。点一下按钮下压、
  桌上一圈声波，同时 `game.ring` 由服务端转给对手与观战者。冷却按对局算
  （`RING_COOLDOWN_SECONDS`，默认 2.5s），冷却中的按铃不转发、只回 `accepted:false`。

### 3.6 3D 场景（多轮迭代，这是最近的主要工作）

场景经历了多轮迭代，从"一块桌面"演进到**三种可切换的禅意棋境**（茶室 / 庭院 / 赛博夜局）：

1. **场景重构**：拆成 `SceneManager / BoardManager / Environment` 三层（基类 + 三个子类），
   引入自研补间引擎（没装 gsap），落子有自由落体 + 挤压回弹 + 二次起跳。
2. **全屏棋境版式**：去掉上下"框"，3D 画布 `position: fixed; inset: 0` 铺满，
   HUD 改成悬浮玻璃薄片；相机按视口自动取景（把棋盘 8 角投影到 NDC 迭代调距离）。
3. **现代客厅（已移除）**：早期版本是程序化搭建的客厅（落地窗/沙发/电视柜/实木桌面），
   **第 6 轮被三种棋境整体取代**，`RoomEnvironment.ts` 已删除，旧素材（sofa/planks/curly_teddy/caban）一并弃用。
4. **接真实素材**（转折点）：改用 Poly Haven 的 CC0 素材（HDRI / PBR / 扫描模型）。
5. **打磨真实感（第 7 轮）**：每环境独立 HDRI 环境光照 + 真实 PBR 贴图 + 扫描模型 + 赛博 Bloom 后处理，
   三棋境各自接入真实材质与模型（详见第 4 节与 `docs/SCENE_OPTIMIZATION.md`）。

**当前场景的最终形态（五种棋境，见 3.7）**：
- 棋境 ID 固定为 `tea / courtyard / cyber / living / studio`，进库、进快照；建房/约战可选或随机分配
- 光照：每环境独立 HDRI 环境贴图（`scene.environment`，`PMREMGenerator` 预滤波）
  + 平行光 + 半球光 + 局部聚光；赛博额外开 `UnrealBloom` 后处理
- 棋盘：AI 生成的榧木纹 PBR 贴图（整块细纹板，无拼缝节疤；`board_diff` 派生
  rough/normal/ao），墨色 15 路格线 + 星位，无额外装饰边框（真实棋盘样式）
- 棋子：压扁后重算法线的球体（扁圆围棋子形），clearcoat 釉光
- 相机：近正俯拍（方向 `(0,1,0.02)`，那 0.02 是避开 lookAt 的奇点），
  开局按各环境 `intro` 推镜，可 360° 环绕

### 3.7 五种棋境

一局棋可以在五个预设房间里下：**基础茶室 / 日式庭院 / 赛博夜局 / 现代客厅 / 摄影棚**。
ID 是五个字符串：`tea / courtyard / cyber / living / studio`，前后端各有一份同名表
（`frontend/src/game/scenes.ts` 与 `backend/app/scenes.py`），进数据库、进快照。

- **场景层**：`scene/environments/Environment.ts` 是抽象基类，收敛两件事——
  造形工具（box/cylinder/rounded/zabuton/buildTable，含**桌面上表面高度对齐**，
  棋盘与铜铃在五个场景里都落在同一条线上）与「全局氛围」字段
  （background / fog / environmentIntensity / exposure / maxDistance / intro 推镜起点）。
  各子类只管搭自己的家具；`SceneManager.applyEnvironment` 负责换景时
  清掉旧雾、换曝光、按新环境的 `maxDistance` 收紧相机。
- **切换**：`GomokuScene.setScene(id)` 销毁旧环境、建新的、重画阴影。
  同一棋境的重复快照直接跳过（每落一子都会来一张快照）。
- **选择与随机**：AI 弹窗与建房弹窗各有一组棋境卡片（默认「随机」）。
  建房没指定 → 服务端 `random_scene()`；约战 → 恒随机；本地对弈 → 前端自己抽。
  未知取值一律回退 `tea`（`normalize_scene` / `coerceSceneId`），**不报错**——
  棋境错了最多背景不对，没理由废掉一盘下到一半的棋。
- **协议**：快照新增 `scene` 字段；`room.create` / `ai.create` 的 payload 可带 `scene`。
  上下文行会显示当前棋境名（`好友联机 · 房间 XXXXXX · 赛博夜局`）。
- **迁移**：老库的 `games` 表没有 `scene` 列，`Database.create_all` 后用
  `PRAGMA table_info` 判缺再 `ALTER TABLE ADD COLUMN ... DEFAULT 'tea'`（幂等）。

- **后加的两个棋境**：`living` 整间户型来自 CG 套件裁剪导入，运行时按材质名找茶几对位；
  `studio` 不讲故事，只做「产品照」——地面→圆角→背墙用一条 `LatheGeometry` 剖面
  转成 360° 无缝背景，三盏 `RectAreaLight` 当柔光箱（注意 three 0.180 的面光
  **不支持阴影**），另配一盏与主光同向的平行光专投棋子接触阴影。桌面复用
  `buildTable` + `darkwood` 贴图，不新增模型。背景洗墙用宽角 + 全半影聚光灯，
  面光打在墙上会是一块硬边矩形，反而像地平线。

**踩过的坑（接手必读）**：
- `cylinder()` 等造形工具默认挂 `this.root`（世界系）。庭院的松、枫、石灯笼，
  赛博的樱花树，最初都把树干画在了**世界原点**——一根 30 单位高的黑柱子正好
  从桌子中间穿过去。修法是给 `cylinder()` 加 `parent` 参数并传 `group`。
  新写环境时，凡是局部 `Group` 里的物体，parent 一律要传 group。
- 子类覆盖基类字段要写 `override`，且基类字段要显式标注 `: number`——
  否则 `readonly exposure = 0.94` 被推成字面量类型 `0.94`，子类写 `1.06` 直接报错。

---

### 3.8 对局复盘（本轮新增）

**做了什么**：已结束的 AI / 联机对局可以重新摆一遍。入口两个——首页模式卡下方的
「复盘 · 近期对局」，和结算卡上的「复盘本局」。

**关键设计（改动前先读）**

- **不新增存储**。`games` + `game_moves` 两张表本来就记着完整的对局，复盘只是
  一个只读出口（`app/replay.py`）。加一张「棋谱表」反而会出现两份真相。
- **不新增渲染路径**。`main.ts` 把「第 n 手之后」拼成一张**假快照**交给
  `GomokuScene.setSnapshot`，棋盘差分、落子动画、最后一手、五连高亮全部复用。
  复盘和实战的棋盘因此不可能长得不一样。
- **重建而不是增量**。`game/replay.ts` 的 `boardAt(moves, n)` 每次从头摆 n 手，
  拖动进度条跳几十手也不会出现「退到一半状态对不上」。
- **只有参与者能读**，且别人的棋局返回 **404 而不是 403**——403 等于承认
  「这盘棋存在」。
- **复盘期间 `this.snapshot` 必须置空**，否则对局推送、积分结算、断线恢复会插进来。
  退出时用 `replayReturn` 把原来的快照放回去（从结算卡进来的就回到结算卡）。
- **CSS 上要收干净**：复盘时 `.is-replaying` 隐藏操作坞、短语菜单、状态行、
  叙事标题。状态行和播放条都贴底，不隐藏会直接叠在一起；叙事标题是深色字配
  浅色光晕，压在深色棋盘上只剩一团灰。

**接口**：`GET /api/games/replays`（可带 `mode=ai|online`）、`GET /api/games/replays/{id}`（Cookie 鉴权）。

**「再来一局」会吃掉上一盘（已修）**：`restart` 原本在同一个 `Game` 行上 `moves.clear()`，
赢了一盘立刻重开，上一盘的棋谱就没了——复盘里只剩最后一盘。修法不是「新建一行」，
因为 `room_code` 有唯一约束、客户端手里的 `gameId` 也会失效；而是**先把旧棋复制成
一条独立的已结束记录**（`GameService._archive`，房间号置空），原行继续承载下一盘，
同时把 `created_at` 重置，避免第二盘的「用时」把第一盘也算进去。
历史数据无法追回：修复之前被清掉的棋谱已经不在库里了。

**列表分类**：`mode` 参数在服务端过滤，不在前端筛。前端只取 20 条，本地筛会变成
「取 20 条再删一半」，翻两页就只剩个位数。页签三档（全部 / 与好友 / 与 AI），
每行左侧再放一枚类型徽标（`users` / `cpu`），这样在「全部」页签下也能一眼分清。

**时间必须带时区（踩过的坑）**：`DateTime(timezone=True)` 在 SQLite 上只是「允许」
带时区，实际**不保留**偏移量——写进去是 `…16:51+00:00`，读回来是 `…16:51` 这个
naive 值。直接 `isoformat()` 得到的是没有偏移的字符串，浏览器 `Date.parse` 会按
**本地时间**解释，于是 UTC 16:51 的棋局在 UTC+8 的屏幕上显示成 16:51 而不是 00:51，
整整差一个时区。修法是 `replay.py` 里的 `_iso()`：naive 值补上 `timezone.utc` 再
序列化。新增时间字段时照此处理，别再直接 `isoformat()`。

**退出指引**：复盘把对局界面的出口（退出按钮、操作坞）全收起来了，所以播放条左侧
必须是**实心按钮**（不是文字链），进入时再弹一条 toast 说明「点返回或按 Esc 退出」。
复盘状态下 toast 要抬高（`.is-replaying .toast-region { bottom: 154px }`），
否则会压在播放条的标题行上。

**复盘时接受约战进不去对局（已修）**：`handleRemoteSnapshot` 的第一道闸是
`if (this.replay) return;`——它的本意是「别让后台推送把正在看的棋谱换掉」，
但接受约战后服务端推来的**新棋局快照**也会撞上这道闸，于是弹窗消失、界面毫无变化，
人被卡在回放里。修法是在「接受」的回执发出去之后调用
`leaveReplayForNewGame()`（内部 `exitReplay({ restore: false })`）：

- 必须是**回执发送成功后**才退出复盘，发送失败时不该把人从棋谱里踢出来；
- 用 `restore: false`：复盘若来自结算卡，默认会把那盘已结束的旧局摆回去，
  紧接着又被新快照替换，屏幕上会闪一下旧棋盘；
- `handleChallengeResult` 的 `accepted` 分支同样要调（我在复盘时对方接受了邀战），
  虽然复盘界面下进得了大厅、发不出邀战，但这条路径留着兜底。
- 闸门本身**不能删**：没有它，复盘时任何后台推送都会把棋盘换掉。

**测试**：`backend/tests/test_replay.py` 5 项；`frontend/src/game/replay.test.ts` 12 项。

### 3.9 手数编号与设置界面（本轮新增）

棋子可以标上「这是第几手」，四档：不显示 / 最新一步 / 最新两步 / 全部步数。
入口是顶栏齿轮，偏好存 `localStorage['yijing.settings.v1']`。

**关键设计**

- **编号来源是「序列」，不是棋盘**。`game.snapshot` 因此多了一个 `moves` 字段
  （后端 `_snapshot`、本地 `LocalGameState`、复盘假快照三处都要给）。只看 `board`
  不可能知道第几手，悔棋/重连/刷新之后更无从重建。
- **标签是棋子的子节点**，不是世界坐标里另摆一层：落子有下落与压扁动画，
  跟着棋子一起动才不会「石头还在天上、数字已经落定」。
- **用平贴薄片，不要用 `Sprite`**。标签原本是 `THREE.Sprite`——永远正对相机，
  俯视时最舒服，但视角一拖低就侧躺进棋子内部，数字下半截被棋子挡掉，
  看起来像被削了一块。现在是一张 `PlaneGeometry` 平铺在棋子顶面
  （`rotation.x = -π/2`，抬高 0.01 躲 z-fighting），和棋子共用局部坐标系，
  任何角度看都不会穿进去。代价是低角度下数字会因透视变扁——但那是「刻在棋子上
  的字」本来该有的样子，比被裁掉一半好得多。
- **标签材质要 `toneMapped: false`**。红字按 `#b3251a` 画出来，经过 ACES + 曝光
  会被提亮成粉色，白子上的深字也会发灰。这层字是给人读的，不是受光物体。
- **最新一手标红**（`latest = index === history.length - 1`）：黑子用亮红 `#ff5b47`、
  白子用暗红 `#b3251a`。缓存键 `数字:颜色:latest` 必须带上这一位，
  否则下一手落子之后上一手的红字会一直留着。
- **差量更新**。`renderMoveNumbers()` 先算「这一帧该有哪几个标签」再和现有对比，
  不做推倒重建——「全部步数」在满盘时一次会丢掉两百多个材质实例。
  比较时**数字和 latest 都要比**，不能只比数字。
- **贴图缓存按「数字:颜色」**，黑子浅字、白子深字。一套配色不可能在两种底上都清楚。
- **两位数要逐字排版**。一次 `fillText('12')` 再叠描边会糊成 `132`；
  自己算每个字的宽度并留固定间隙，顺便绕开 `ctx.letterSpacing` 的兼容性。
- 脏数据防护：序列来自网络，`row/col` 不是整数就跳过该手，不让整块棋盘抛错。

**测试**：`frontend/src/game/settings.test.ts` 13 项；`backend/tests/test_snapshot_history.py` 1 项。

### 3.10 开局「决定先后手」（本轮新增，仅联机对战）

按用户需求实现的开局流程：**每局开始前，两位玩家分别独立选择「希望谁先手」**
（可以选自己，也可以选对方）。若两人选择指向同一位玩家，该玩家先手，直接开局、
不抛硬币；若指向不同玩家（包括都选自己、都选对方），进入**抛硬币环节**，
用 3D 动画随机决定先后手。多局对战每局结束再开新局时，**重新走一遍上述流程**。

**适用范围（刻意收窄）**：只有**联机对战**（约战 / 房间）走这套流程。
AI 对局沿用传统模式（人类执自选颜色、黑先），本地对战同样黑先——
自己跟自己协商先后手毫无意义，AI 也不会讨价还价。

**后端**（`game.py` / `websocket.py` / `models.py` / `database.py`）

- `games` 表新增 `opening` JSON 列（`database.py` 里有轻量迁移：缺列就补）。
  内容：`{a_id, b_id, choices:{用户id: 'self'|'opponent'|null}, resolved, first_seat, method, opened_at}`。
  **注意 `choices` 的键是用户 id，不是字母 a/b**——座位字母只是「初始座次」，
  揭晓后黑白座位会互换（`_resolve_opening_in_session`），让先手者执黑（五子棋惯例）。
- 触发点：`_accept_challenge`（约战成立）、`join_room`（房里坐进第二个人）、
  `restart`（联机再来一局）。**`create_ai` 不触发**；AI 局若 AI 执黑，
  直接 `_start_ai_if_black` 开局落子。
- 落子闸门：`move()` 里 `opening` 未清除时抛 `OPENING_PENDING`。揭晓即 `game.opening = None`，
  闸门随之打开，快照里也不再带 `opening` 字段。
- WS 协议：客户端发 `game.first_move_choice {gameId, choice: 'self'|'opponent'}`
  → 服务端回 `game.first_move_choice_ack {accepted:true}`；双方都表态后服务端经
  `hub.send_to_game` 向双方与观战者推 `game.opening_result
  {gameId, firstSeat:'a'|'b', method:'agreement'|'coin', seats:{a:{id,name}, b:{id,name}}}`。
  **分发字段是 `choice`**（`websocket.py`），别改回 `preference`——前端和测试都发 `choice`。
- 裁定规则（`_resolve_opening_in_session`）：把每人的 choice 换算成「他希望谁先手」
  的座位 id；两个希望一致 → `agreement` 直接定；不一致 → `secrets.choice` 抛硬币（`coin`）。
- **120 秒超时兜底**（`OPENING_TIMEOUT_SECONDS` + 心跳循环里的
  `_resolve_stale_openings`）：一方迟迟不选就给缺失方随机补一个再揭晓，
  避免整局卡死在「先后手未定」。快照在未决阶段带
  `opening: {phase:'choosing', seats, youSeat, youChose, opponentChose}`，
  对方选没选、选了什么（但不知道选的指向）都看得到。

**前端**（`main.ts` / `ui/shell.ts` / `scene/CoinScene.ts` / `network/GameSocket.ts`）

- 快照带未决 `opening` 时弹出玻璃拟态遮罩（`renderOpeningOverlay`）：标题 +
  两个选择按钮「我执先手 / 对方执先手」，自己选完按钮置灰并显示「已选择，
  等待对方」，对方已选则同步显示。
- 收到 `game.opening_result` 后：`method === 'agreement'` 不抛硬币，
  显示「双方一致 · XX 先手」片刻直接开局；`method === 'coin'` 懒创建
  `CoinScene` 播放 3D 硬币再揭晓。
- **CoinScene** 是独立 Three.js 小场景：硬币两面各刻一位玩家名字（CanvasTexture），
  有向上抛起、空中旋转、落地弹跳停稳的动画，带光照与阴影；`play(result)` 返回
  Promise，硬币落定、结果清晰可辨时 resolve。落地后界面明确提示「硬币落地 · XX 先手」。
  桌面与移动端都适配（画布 `min(280px, 70vw)`，窄屏堆叠布局）；
  `prefers-reduced-motion` 时直接落定不旋转。
- **令牌防串局**（`openingToken`）：退出对局或重开会自增令牌，进行中的揭晓动画
  await 之后发现令牌变了就静默丢弃回调——否则上一局的硬币结果会污染新局。

**踩过的坑**

- `submit_first_move_choice` 最初把「座位」算成字母 `'a'/'b'` 去写 `choices`，
  而字典的键是用户 id——两个人的选择永远凑不齐，整局卡死。**座位键一律用
  `black_player_id` / `white_player_id`（即用户 id）**。
- 测试里 `receive_request(ws, id)` 会**跳过并消费**一切不匹配的消息，而
  `opening_result` 可能先于 ack 到达——所以测试必须**先收双方的 opening_result
  再收 ack**，顺序反了就永久阻塞（`test_online_game.py` 两个测试都栽过）。
  公共握手助手 `agree_first_player` 在 `test_spectate.py`，`test_replay_restart.py`
  复用它；同一局握手多次必须换 requestId（服务端按 (用户, requestId) 幂等缓存）。

**测试**：`backend/tests/test_online_game.py` 3 项（含「一致直接开局」「不一致抛硬币
后先手者落子」两条链路）；`test_spectate.py` / `test_replay_restart.py` 的联机用例
均已接入开局握手。

### 3.11 现代客厅棋境（第四棋境，本轮新增）

用户提供了一套「CG美术之家」家庭室内 glTF 套件（232 材质 / 186 万面 / 77MB，Z-up，
1 mesh + 232 primitives，无家具级层级），用户选**方案 B：裁剪小物件后整间进**。

- **导入管线** `tools/import_cg_gltf.py`：按材质名裁剪（DROP 窗帘/毛巾/床品/厨卫，
  KEEP 地板/天花/墙/插座骨架，Y 区间过滤别房间，小物件面数黑洞判据）→ 186 万面裁到
  **27.7 万面**；贴图压 1K/85 内嵌；Z-up 在 GLB 节点上转 -90°X；玻璃材质手动 BLEND
  （原文件全是 OPAQUE，不处理就是一块不透明白板）。产物 `living_room_1k.glb` 17.9MB。
- **几何切片（关键）**：原文件把所有顶点塞在几个几十 MB 的巨大 bufferView 里，
  按 view 整段拷贝会把被裁掉的百万面也带上。必须按 accessor 的 byteOffset/byteLength
  精确切片，再按 (view, 起止) 去重。
- **对位**：`LivingRoomEnvironment` 运行时按材质名找到 `…Coffee_Table` 图元量真实包围盒，
  把它的**顶面中心**对齐到 `(0, TABLE_TOP_Y, 0)`——与其它环境同一条「桌面在 TABLE_TOP_Y」
  约定；比例按棋盘 14.6 单位 = 真实 45cm 反推（1 米 ≈ 32.4 单位）。找不到茶几就走实测常量兜底。
- **光照**：真实户型无 GI，半球光 0.9 + 日光平行光 1.5 + 三盏天花暖点光 + 棋盘聚光
  （唯一投影光）；房间 27.7 万面全部 `castShadow=false / receiveShadow=true`。
  相机 `maxDistance` 放到 110（客厅开间大，茶室的 56 会把人锁死在棋盘正上方）。
- **注册**：`scene: 'living'` 进前后端两份 ID 表、棋境卡片色带、商城 `scene-living`
  （50 分）、`refreshScenePickerLock` 解锁门、`GomokuScene.createEnvironment`。
  测试：前端 `scenes.test.ts` 改为四 ID 断言；后端从 `SCENE_IDS` 推导自动覆盖。
- **验证**（`frontend/uitest/living.cjs`，系统 Edge 跑 Playwright）：解锁 → AI 弹窗选
  「现代客厅」→ 开局；推镜中段能看到木地板/白墙/电视/门洞与整条动线，落镜后棋盘居中
  压在茶几上；点击落子 + Yixin 回应正常（已落子 2 手），0 console error。

**本轮踩的三个坑（重要）**

23. **Vite 会把 `public/` 复制进 `dist/`，生产单端口服务喂的是 dist**。重新生成
    `public/models/...` 里的素材后**必须重新 build**，否则浏览器拿到的还是旧文件——
    本次 GLB 重生成后依然报同一解析错误，排查半天发现磁盘上是新的、服务的是旧拷贝。
    校验方法：对比 `dist/` 与 `public/` 的文件字节数。
24. **three 的 GLTFLoader 对 interleaved bufferView 按 `count * byteStride` 取字节**
    （`new TypedArray(bufferView, ibSlice*stride, count*stride/elementBytes)`）。切片时若只给
    `stride*(count-1)+size` 字节会 `RangeError: Invalid typed array length`——
    最后一个 accessor 的数据可能顶着 buffer 结尾、没有步长尾巴，切完要**补零到 count*stride**。
25. **Playwright 驱动**：本机没有 playwright 浏览器缓存，`npm i -D --no-save playwright`
    后用 `chromium.launch({ channel: 'msedge' })` 直接驱动系统 Edge，无需下载浏览器。

### 3.12 体验打磨批次三（本轮新增）

用户集中反馈的 13 项改进，全部落地：

- **快捷短语并入操作坞**：原来短语按钮独自悬浮在操作坞上方一行，多出一层孤立胶囊；
  现在是操作坞第一个键位（与重开/悔棋/认输/退出同一枚胶囊），面板从它头顶弹出。
- **编号与圆点互斥**：手数编号开启（非 off）时最新一手的提示圆点隐藏——两者表达同一
  信息，叠在一起互相打架。落点在 `BoardManager.refreshLastMarker` 统一裁决。
- **圆点延迟显示**：带落子动画的新手要等棋子落定（`LANDING_DURATION` =
  下落 300 + 挤压 100 + 回弹 150ms）才亮圆点，历史载入/复盘跳转立即显示。
  `setLastMove(move, delayMs)`，用 `performance.now()` 时钟在 `update()` 里兑现。
- **圆点改「靶心」**：核心圆点 + 同色外环（黑子上浅金、白子上深棕），半透明白子上
  也一眼可辨。
- **本地对弈可选棋境**：`[data-mode="local"]` 改为打开 `#local-options` 弹窗
  （复用 `scenePickerHtml('local-scene')`）；「再来一局」沿用 `localGame.currentScene`
  不再重抽。
- **棋盘贴图分辨率（已回退）**：`fetch_polyhaven.py` 加了 `PH_RES` 环境变量，曾把
  `brown_planks_08` 重下为 2K（`PH_TEX_EDGE=2048`，diff 941K）；用户查看后要求
  恢复上一版，已用 `PH_TEX_EDGE=1024` 重新抓回（1024×1024，diff 234K，
  比最早 189K 略大是 Poly Haven 源文件重编码所致，视觉同级）。脚本能力保留。
- **观战者 ID 可见**：快照新增 `spectators: [{id, name}]`（`_spectator_dicts`），
  状态行的观战胶囊直接列名字（最多 3 个 + 「等 N 人」，title 给全名单）。
- **人机局可观战**：`spectate.join` 放行 `mode in ("online", "ai")`。AI 的落子走
  同一条 `broadcast_game`，观战者自动收到，无需额外代码。
- **大厅显示「观战中」**：`lobby.players()` 对不在座位、但 `spectate.watching()` 命中的
  人标 `status: "watching"`（带 gameId，可直接跳去同看）。前端 `STATUS_LABEL` 加映射。
- **对局内 AI 分析**（新协议）：`game.ai_request` → 对手弹窗 → `game.ai_respond` →
  同意则 `EngineManager.analyze(history, color)`（独立 `__analysis__` 会话，每次全量
  START+BOARD，避免增量 `turn` 被交替执子方搅乱）→ `game.ai_analysis_result` 广播给
  双方与观战者。前端在棋盘上亮 6 秒提示环（`BoardManager.showHint`）。请求 60s TTL，
  同盘同时只允许一个在途请求；回应校验顺序是「参与者 → 请求存在 → 未超时」。
- **磨砂墨玉折射修复**：透射材质绝不能再叠 `transparent+opacity`（会被普通透明混合
  压淡，折射糊没）。`createStoneMaterial`：`transmission > 0` 时强制
  `transparent=false, opacity=1, thickness=0.76, ior=1.5`。
- **复盘落子音效**：`seekReplay` / `advanceReplay` 前进时按刚落那子的颜色播
  `sounds.play('black'/'white')`，与实战听感一致；后退/跳转不响。
- **结算卡按钮间距**：`#result-card` 的主/次按钮与文字链拉开 2/12/10px 呼吸感。

26. **测试里消费推送的顺序陷阱**：服务端在 dispatch **期间**就发出事件
    （如 `game.ai_analysis_result`），带 `requestId` 的 ack 在 dispatch 返回后才发——
    先收 ack 的 `receive_request` 会把先到的结果事件顺手消费掉。必须先收事件再收 ack。

27. **`asyncio.Lock` 不能跨事件循环摸**：`app.state` 上的服务持有 `asyncio.Lock`，
    它在首次 await 时绑定 TestClient 的事件循环；测试若另起 `asyncio.run()` 去
    占用/检查这把锁，下次 HTTP 请求就会 `RuntimeError: attached to a different loop`。
    单飞/锁语义的单元验证要用**独立的服务实例**（自带锁），不碰 app.state 上的那个。

### 3.13 复盘 AI 推荐点（批次四，2026-11-02）

**背景**：用户想要 depth/score/pv 思考可视化，实测确认 Yixin 公开版（2017/2018）
不输出 INFO（见 8.1 #3）。用户决策走「路线二」：降级为**推荐点**形态，
人机对局思考面板与 PVP 数字增强**搁置**（等商业版），复盘 AI 评估先行。

- **协议**：`POST /api/games/replays/{gameId}/analyze`，body `{ply}`（0=空盘），
  返回 `{row, col, color, cached}`。`ReplayAiAdvisor`（replay.py）：手动触发、
  单飞（忙时 409 `ENGINE_BUSY`）、`(gameId, ply)` 内存 LRU 500 条缓存、
  终局局面 400。权限与复盘读取一致（仅参与者，路人 404）。
  路由在 `replay_routes.py`；`main.py` 挂 `app.state.replay_ai`。
- **前端**：ReplayClient.analyze（POST）；复盘播放条新增「AI评估」按钮
  （`#replay-ai`，cpu 图标带文字）+ `#replay-ai-result` 文案位（金色）；
  main.ts：`replaySuggestion`（带 ply 标记，只在与当前手数同格时显示）+
  `replaySuggestionCache`（`gameId:ply`，翻回去零延迟重亮）+ `replayAnalyzing`
  防重入；点按钮 → `scene.showHint`（复用 PVP 分析的 6s 呼吸提示环）+ toast；
  翻走后建议文案自动消失、翻回同手数重亮环。enterReplay/exitReplay 重置状态。
- **验证**：后端 80 passed（+3：建议正确性/权限与越界/单飞与缓存）；tsc/vitest/
  build 通过；**真实 Yixin 端到端**（WS 下完一局认输 → 逐手 analyze，四个局面
  推荐点合理、缓存标志正确）；Playwright 截图（uitest/replay_ai.cjs +
  replay_ai_setup.json 预置会话）：按钮/文案/提示环/翻回重亮全部符合预期，
  0 console error。
- **未做**（等 Yixin 商业版，用户去 aiexp.info 谈）：人机对局思考面板、
  PVP 分析的 depth/score/pv 数字。届时往现成链路里填字段即可。


### 3.14 引擎切换：Yixin → 前端 Rapfi WASM（批次五，2026-11-02）

用户拍板：彻底抛弃 Yixin，引擎整体迁到浏览器。触发因素是 Yixin 公开版
不输出 INFO（见 8.1 #3），而 Rapfi 原生输出 `INFO DEPTH/EVAL/WINRATE/BESTLINE`。

- **构建**：`tools/build_rapfi_wasm.sh`（emsdk 6.0.13 + pip cmake + ninja.exe 在
  `~/.workbuddy/bin/tools`）。两个变体 multi-simd128 / single-simd128 + 共享
  `rapfi.data`（mix9svq freestyle 权重 10MB）。权重包在 `tools/rapfi-freestyle/`：
  从官方 Networks 裁剪 + **必须删掉示例 config 的 `[model] binary_file` 行**
  （指向不存在的经典模型会让整个配置加载失败退回内置评估——实测踩过）+
  `coord_conversion_mode` 保持 Gomocalc 默认 `X_flipY`。源码在 `tools/rapfi/`（含子模块）。
- **坐标**：Gomocup 惯例 `(x=col, y=row)`，与后端当年对 Yixin 的映射完全一致；
  实测对手竖四必堵点验证过帧对齐。
- **前端**（`src/engine/rapfiClient.ts` + `rapfi.worker.js`）：
  - 多线程变体**主线程实例化**（官方 Gomocalc 模式，pthread 重活引擎自己管）；
    单线程变体走 Worker。多线程构建放进自定义 Worker 会与 pthread 消息机制
    互相污染导致引擎失联（实测踩过）。
  - 能力探测：SIMD 探针 + `crossOriginIsolated`；`SHOW_DETAIL 3` 开启 INFO 流。
  - `think()` 每次全量 BOARD 重建（无状态分析）；AI 落子、PVP 本地分析、
    复盘「AI评估」三条链路共用。
- **后端**：`engine/` 包整体删除，`game.py` 去掉引擎依赖；新增 `game.ai_move`
  消息（`submit_ai_move`：校验 mode/参与者/ai_thinking/合法性，伪造不了非法棋）；
  人机局 AI 回合只置 `ai_thinking=True` 等客户端提交；PVP 分析同意后不再由
  服务端算点（row/col 缺省 = 请求方本地计算约定）；`recover_ai_games` 恢复时
  也只置位。复盘 `POST .../analyze` 端点与 `ReplayAiAdvisor` 删除（前端本地化）。
- **HTTP 头**：`main.py` 加 COOP/COEP 中间件（多线程 WASM 必需；素材全自托管无副作用）。
- **测试**：后端 67 passed（删 engine/idle/protocol/replay_analyze 四个过时文件，
  其余改为 `game.ai_move` 冒充客户端提交——注意 **ai_move 的 ack 即终态快照**，
  先 receive_request 再 receive_until 会永久挂起，又一个顺序陷阱）；
  前端 85 passed；Playwright 真实浏览器 E2E（uitest/rapfi_e2e.cjs）：
  人机局实下一回合，面板显示「深度 13 / 胜率 17% / 评估 -314 / 主线 E11→E9→G11→H11」，
  0 console error。
- **清理**：`engines/` 目录与 yixin17 二进制删除，backend/.env 与 config 去掉全部
  YIXIN_*；THIRD_PARTY_NOTICES 增加 Rapfi GPL-3.0 条目（分发须附源码指引）。

### 3.15 批次六：积分 / 名片 / 磨砂墨玉 / 先后手轮换（2026-11-02）

- **17 积分**：商城是前端本地档案（`yijing.profile.v1`），`INITIAL_POINTS` 500→10000，
  档案版本 v2→v3，迁移规则「所有旧档案积分一次性调整为 10000，此后正常累加」。
  棋境全部免积分解锁：`isSceneUnlocked` 恒 true（给未来条件解锁留同一入口），
  `SHOP_ITEMS` 移除 scene 类商品（商城只卖棋子材质）。
- **18 个人名片**：`GET /api/users/me/stats`（`profile_routes.py`）——扁平字段
  `totalGames/wins/losses/draws/winrate`（winrate 0~1，无对局为 null），后续新维度
  直接追加键即拓展。前端名片弹窗（HUD 的 user 图标 + 大厅 headline「我的名片」双入口），
  `AuthClient.stats()` 拉取。测试注意：内存库的连接随 TestClient 退出被 dispose，
  嵌套 TestClient 场景下的断言必须在所有客户端仍存活时发起。
- **19 磨砂墨玉**：原底色 #1d211f 太黑，透射光被吃光 → 与普通黑子无异。改为
  墨绿玉色 #3d4f47 + transmission 0.78 + roughness 0.38（磨砂），特写确认呈
  玉质感、与纯黑棋子明显区分。
- **20 先后手轮换**：联机「再来一局」不再重新协商——restart 时黑白座位直接对调
  （第一局仍走协商）。`test_restart_in_a_room_keeps_both_games` /
  `test_online_room_sync_...` 按轮换语义更新（原白座执黑先手）。

### 3.16 批次七：抛硬币观感 / 透射棋子标记 / 翡翠 / 棋盘提亮（2026-10-02 追加）

- **21 抛硬币**：名字字号 132/92 → 88/64（132px 铺满盘面像贴海报）；容器
  280px→340px（窄屏 260px）；相机 fov 38→46、lookAt 上移至 y=1.15、距离 6.2——
  原视野盖不住抛物线峰顶（y≈3.1），硬币抛到最高处被裁切。
- **22 凝脂标记修复**：最新一手圆点是**不透明** MeshBasicMaterial，排在不透明
  队列先渲染，被透射材质（凝脂/翡翠）的表面整体盖住——圆点凭空消失；手数编号
  是透明材质不受影响。修复：markerDotMaterial 加 `transparent + depthWrite:false`
  转入透明队列（renderOrder 5 已有）。**给透射棋子挂任何子标记都要走透明队列**。
- **翡翠**：磨砂墨玉更名「翡翠」，color #3d4f47→#2f6b50（翠绿）、transmission
  0.78→0.88、roughness 0.38→0.3。
- **24 棋盘提亮**：#8a6f45 → #a2855a（用户先嫌浅后嫌暗，取中间；ACES 压缩下
  只能靠截图验证，见 3.13 的教训）。
- 验证：Playwright 双浏览器联机流程抓硬币空中/落定帧（uitest/coin_check.cjs，
  注意双方选择一致时直接揭晓、没有硬币动画——要制造冲突才抛）；凝脂三模式
  （all/last/off）特写截图确认编号与圆点全部正常。

### 3.16 批次七：抛硬币观感 / 透射棋子标记 / 翡翠 / 棋盘提亮（2026-10-02 追加）

- **21 抛硬币**：名字字号 132/92 → 88/64（132px 铺满盘面像贴海报）；容器
  280px→340px（窄屏 260px）；相机 fov 38→46、lookAt 上移至 y=1.15、距离 6.2——
  原视野盖不住抛物线峰顶（y≈3.1），硬币抛到最高处被裁切。
- **22 凝脂标记修复**：最新一手圆点是**不透明** MeshBasicMaterial，排在不透明
  队列先渲染，被透射材质（凝脂/翡翠）的表面整体盖住——圆点凭空消失；手数编号
  是透明材质不受影响。修复：markerDotMaterial 加 `transparent + depthWrite:false`
  转入透明队列（renderOrder 5 已有）。**给透射棋子挂任何子标记都要走透明队列**。
- **翡翠**：磨砂墨玉更名「翡翠」，color #3d4f47→#2f6b50（翠绿）、transmission
  0.78→0.88、roughness 0.38→0.3。
- **24 棋盘提亮**：#8a6f45 → #a2855a（用户先嫌浅后嫌暗，取中间；ACES 压缩下
  只能靠截图验证，见 3.13 的教训）。
- 验证：Playwright 双浏览器联机流程抓硬币空中/落定帧（uitest/coin_check.cjs，
  注意双方选择一致时直接揭晓、没有硬币动画——要制造冲突才抛）；凝脂三模式
  （all/last/off）特写截图确认编号与圆点全部正常。

### 3.17 批次八：推荐点收缩 / 光晕穿模 / 翡翠透光（2026-11-02 追加二）

- **25 推荐点抽缩**：`setLastMove` 一触发就 `collapseHints()`——落子/清盘瞬间
  场上推荐环进入 240ms「缩到 0% + 同步淡出」阶段后销毁，不再等 6 秒或生硬消失。
- **27 光晕穿模**：ghostGlow（落点预览光斑）是 billboard Sprite，下半截插进棋盘，
  低视角被板面裁出直线。修复：SpriteMaterial `depthTest: false`（additive 叠加，
  光斑整片落在板面上，任何视角完整）。
- **30 翡翠透光**：三层组合拳——① 透射材质棋子 **castShadow=false**（棋子影子落在
  自己正下方，透射采样到的正是被影子压暗的板面，内部发乌的主因）；② color
  #57a87e 提亮 + transmission 0.97；③ thickness 0.76→0.5（折射光程更短，木纹更可辨）。
- 验证：hint_collapse.cjs（落子后棋盘无残留推荐环）、jade_check.cjs 特写（翡翠
  通透感与凝脂同风格）、grease_check.cjs（圆点/编号回归正常）。

### 3.17 批次八：推荐点收缩 / 光晕穿模 / 翡翠透光（2026-11-02 追加二）

- **25 推荐点抽缩**：`setLastMove` 一触发就 `collapseHints()`——落子/清盘瞬间
  场上推荐环进入 240ms「缩到 0% + 同步淡出」阶段后销毁，不再等 6 秒或生硬消失。
- **27 光晕穿模**：ghostGlow（落点预览光斑）是 billboard Sprite，下半截插进棋盘，
  低视角被板面裁出直线。修复：SpriteMaterial `depthTest: false`（additive 叠加，
  光斑整片落在板面上，任何视角完整）。
- **30 翡翠透光**：三层组合拳——① 透射材质棋子 **castShadow=false**（棋子影子落在
  自己正下方，透射采样到的正是被影子压暗的板面，内部发乌的主因）；② color
  #57a87e 提亮 + transmission 0.97；③ thickness 0.76→0.5（折射光程更短，木纹更可辨）。
- 验证：hint_collapse.cjs（落子后棋盘无残留推荐环）、jade_check.cjs 特写（翡翠
  通透感与凝脂同风格）、grease_check.cjs（圆点/编号回归正常）。

### 3.18 批次九：积分后端化 / 禁手 / 误报修复 / 阴影与焦散（2026-11-02 追加三）

- **积分迁移后端**（用户拍板）：`users.points/unlocked` 两列（老库 `_ensure_column` 补列，
  存量 10000）；终局结算 `_settle()` 挂在**全部 7 个 playing→finished 翻转点**
  （五连×2 / 和棋×2 / 认输 / 离开 / 断线判负），AI 座位不发、归档复制不重复结算。
  端点：`GET /api/users/me/wallet` + `POST /api/shop/purchase`（**独立 shop_router**，
  挂在 /api/users 前缀下会 405——实测踩过）；服务端目录是扣费唯一权威。
  前端 store.ts 变 v4：points/unlocked 只是服务端钱包的**缓存**（`applyWallet`），
  装备偏好仍本地；`settledGames` 本地去重退役。
- **禁手规则**：后端 `RenjuRules`（三三/四四/长连，黑恰五胜、白长连也胜）；
  判定用「填空点成五=四、填空点出 `.BBBB.`=活三」的实用简化，同线双四不计数
  （棋谱级特例）。`games.rule` 列 + `board_from_moves(history, variant)` 贯穿；
  快照带 `rule`。前端 `RenjuRuleEngine` 同构实现（两端裁决一致），本地/人机/
  建房三个开局弹窗各一组**独立 name 的**规则胶囊（共用 name 会跨弹窗互斥——踩过）；
  Rapfi `INFO RULE 4`（renju）。约战暂固定无禁手。
- **33 误报（NOT_AI_TURN 红字"当前不在等待 AI 落子"）**：AI 局终局竞态下，前端引擎晚到
  的那步 `game.ai_move` 被服务端以 `NOT_AI_TURN` 拒收并弹红字。分两层：
  ① 早期缓解：前端提交前校验 `status==='playing' && aiThinking`，且 `handleSocketError`
     对终局态的 `NOT_AI_TURN` 静默丢弃；
  ② **本轮根因修复（真正源头在后端）**：`submit_ai_move` 的 AI **获胜 / 和棋**两个终局
     分支都没把 `game.ai_thinking` 翻回 `False`，于是终局快照仍带着 `aiThinking=True`
     广播出去，前端据此以为"还要替 AI 落子"才去提交。已在 `backend/app/game.py` 给两个
     终局分支补 `game.ai_thinking = False`，并补上**和棋分支漏掉的 `_settle`**（平局此前
     不计分，属遗留 bug）；前端 `handleSocketError` 覆盖到"ai 模式 + 任意 NOT_AI_TURN"
     一律静默。回归测试：`test_ai_winning_move_ends_game_and_clears_ai_thinking`。
- **36 结算卡可点棋盘空白临时收起（任务 40）**：局终（`status==='finished'`）时点击棋盘
  空白处（非铜铃、非结算卡自身 DOM——结算卡是浮在棋盘上的独立层，点它不穿透）会临时隐藏
  结算卡，再点一次恢复，方便玩家终局后旋转 / 缩放观察棋盘。实现：`GomokuScene` 新增
  `onBackgroundClick` 回调，仅在局终且点击棋盘空白（bell.hit 先判、board.pick 落空）时触发；
  `main.ts` 用 `resultCardDismissed` 标志切换 `#result-card` 显隐，`render()` 表达式为
  `status==='finished' && !resultCardDismissed`。**关键**：右键拖拽旋转 / 滚轮缩放不触发该
  回调（事件只落在 canvas 落点判定上），所以收起期间随便转视角、拉远近都不会被重新唤醒；
  离开 finished 状态（新开一局）`resultCardDismissed` 自动复位，下一局终局照常弹出。
- **37 复位视角补间动画（任务 41）**：`SceneManager.resetView()` 从瞬切改为用项目自带
  `TweenManager` 把相机**位置 / controls.target / fov** 一起补间到默认第三人称斜视角
  （650ms `easeInOutCubic`）；动画期间锁 `controls.enabled = false` 避免与阻尼 / 用户拖拽
  抢相机，结束再交还并 `applyFraming` 吸附精确取景。新增 `resetPlaying` 标志，`resize()` 在
  `introPlaying || resetPlaying` 期间不强行打断动线。**刻意不尊重 reducedMotion**——复位是
  玩家主动触发的视图导航，短促缓动有助于空间定位，不属于「减少动态效果」要压制的非必要炫动
  （棋子下落 / 涟漪等装饰动画仍尊重该偏好）。`GomokuScene` 对外接口仍是 `resetView()`。
- **38 设置弹窗两个开关统一为 `.segmented` 分段控件**：「对方棋子皮肤」「棋盘坐标」原先是原生
  checkbox（`accent-color` 上色），与「棋子上的手数编号」的 `.segmented` 风格不一致。
  `shell.ts` 改为 `<div class="segmented">` + 两个 `显示/隐藏` 按钮（`data-opponent-skin` /
  `data-board-coords`），`main.ts` 点击容器委托 + `renderBinaryToggle()` 刷 active 态，
  `main.css` 补 `.settings-modal .segmented { margin-bottom: 0 }` 对齐行距。
- **39 分段控件点击后高亮不刷新（38 的回归 bug，已修，实测）**：`renderBinaryToggle` 用
  `[data-${dataAttr}]` 拼 CSS 选择器，**必须传连字符属性名**——`[data-opponentSkin]` 匹配不到
  `data-opponent-skin`（dataset 的驼峰键只用于 JS 读值，不能进属性选择器）。首次修复只改了
  `applySettings()` 的两处调用，却漏了 `setShowOpponentSkin` / `setShowBoardCoordinates`
  里的两处仍传驼峰，导致「初始高亮正常、点击后不变」。最终修法：两个 setter 与
  `setMoveNumberMode` 一样统一调 `applySettings()`（消灭重复调用点），并给 `renderBinaryToggle`
  的 `dataAttr` 加字面量联合类型 `'opponent-skin' | 'board-coords'` 编译期防呆。
  验证：`frontend/uitest/settings_toggle_check.cjs`（Playwright/msedge 实测点击双向切换 +
  localStorage 持久化全通过）。**部署注意**：后端 `SPAStaticFiles` 对 `index.html` 只有
  `etag`/`last-modified`、无 `Cache-Control`，浏览器会启发式缓存旧 index.html 而继续跑旧 JS；
  每次改前端务必让用户硬刷新（Ctrl+Shift+R），必要时给 HTML 响应加 `Cache-Control: no-cache`
  根治（需重启后端）。
- **40 本地对弈加入「AI 分析」**：复用人机模式的手动分析链路（`requestAiSelfAnalysis` →
  `computeLocalSuggestion` → 共享 Rapfi 引擎 `think()` 全量重建局面），把守卫与按钮显隐从
  `mode === 'ai'` 放宽为 `ai || local`。要点：
  - 本地快照 id 形如 `local-${sequence}`（每局唯一），正好当 `rapfiGameId` 去重键——重开 /
    换规则会换 id，`startGame` 自动重发（规则号随 `snapshot.rule` 下发）；
  - `think()` 每次全量 BOARD，悔棋 / 撤销后照常正确；本地局 `aiThinking` 恒 false，无抢引擎问题；
  - `handleEngineInfo` 与 `setSnapshot` 的面板收起逻辑同步放宽：本地局也显示实时思考面板，
    但换到另一盘棋（id 变化）时清掉旧分析；复盘态（`this.replay`）下分析按钮不响应；
  - 注意：空棋盘上引擎秒出解、不吐 INFO 流，面板无内容属正常，建议点照常弹 toast。
  验证：`frontend/uitest/local_ai_analysis_check.cjs`（真实落两子 → 点 AI 分析 → 断言
  建议落子 toast + 实时面板「深度/胜率/评估/主线」，PASS、零页面错误）。
- **34 阴影 / 35 焦散**：透射棋子（不能投影）贴地补 `makeTransmissiveDecor`——
  假影椭圆 + 程序化焦散亮环（`makeCausticTexture`：主亮环+放射光丝，additive）。
  **装饰圆片 depthTest 必须为 true**：关掉会画在透射棋子上面把整颗盖暗（踩过；
  透射队列渲染先于透明队列，depthTest:false 的透明物会覆盖透射物）。
  翡翠透感三件套最终参数：color #9ed6b6（本色要浅——透射=本色×板色）+
  attenuationColor #d8f3e4/dist 1.4 + roughness 0.07（折射扭曲的木纹是透感关键线索）。
  **斜射化（用户反馈"像顶光"）**：假影从居中正圆改为斜向偏移椭圆——圆片包 Group
  转 shadowTilt 方位角 + 局部 y 拉伸 1.4，偏移经 `SHADOW_OFFSETS` WeakMap 在
  addStone 落点平移时叠加；焦散环反向（迎光侧）。
  **后续微调（同日）**：焦散整体下线（makeCausticTexture 与 decor 里的焦散 mesh
  删除）；全体棋子关闭真实投影（"短影"），统一只留斜射假影；长影偏移减半
  （0.12→0.06）、拉伸 1.4→1.2、透明度 0.32→0.2。**clear() 修复**：重开清盘
  只移除了棋子网格没移除 decor——假影残留盘上；补上 decor 下架循环。
  **整体退役（同日终）**：手绘假影体系（时机提前/形状假）整体删除，回到
  **真实阴影贴图**。生效关键（三轮探针排查的结论）：**板面亮度主体是 HDRI
  IBL（environmentIntensity 0.55），而 IBL 不产生阴影**——多光源+IBL 平分照明时
  任何单光源影子只占约 30%，视觉上消失。正解是让**单一投影光源主导棋盘照明**：
  茶室改为聚光灯独占（spot 4.2 castShadow=true 位置 (5.2,9,5.6) 斜偏，sun 0.25
  castShadow=false，hemi 0.12），影子立即清晰。TeaRoom/Courtyard 的 shadow camera
  收紧 ±40→±20（±100 时代棋子影子只有几个 texel）。棋子自身 receiveShadow=false
  防透射内部发乌。**调试方法论**：runtime 探针（window.__sceneDebug dump 灯光
  intensity/castShadow）+ 红 board 探针（color=ff0000 判定可见 mesh 归属）+
  独立测试立方体（判定管线 vs 细节），三层排查法值得复用。
  **全棋境统一（用户反馈"射灯太近影子近大远小/茶室太暗/莫名阴影"）**：四棋境
  统一为「远置 DirectionalLight 唯一投影主光」——平行光影子大小方向处处一致，
  根治射灯近距投影的近大远小；近距射灯全部 castShadow=false 降为无影补光
  （茶室 0.9/客厅 0.8/赛博 0.9）。茶室提亮（IBL 0.3 + hemi 0.3 + sun 1.5）；
  客厅 daylight 补 shadow camera（此前无配置）；赛博新增远置"月光"平行光。
  shadow camera ±30（±20 会把家具影子硬切出诡异边界）。E2E 大坑：本地局场景
  随机——调哪个棋境必须 evaluate 强制选中对应单选。
- **测试**：后端 84 passed（+test_renju 9、test_wallet 3）；前端 83；E2E：
  规则选择器默认无禁手、renju 开局正常、jade 特写透光+假影+焦散、0 console error。

### 3.19 批次十：AI 局参数记忆 + 执子权切换（观赏/编辑模式）

- **参数记忆**：AI 弹窗打开时恢复上局黑白/禁手/棋境（`yijing.ai-params`，startAi 时写入）。
- **执子权模型**：`games.ai_black/ai_white` 两列（对局中可改）。新语义：
  - 落子权跟**当前轮次方**走，不跟座位走。该方 ai 标志为真 → `ai_thinking=True`，
    客户端引擎算完 `game.ai_move` 提交；为假 → 玩家经 `game.move` 落子（mode=ai 时
    **不看座位色**——编辑模式下玩家替任意一方落子）。
  - 新消息 `game.ai_config {aiBlack, aiWhite}` → `GameService.ai_config`：改标志、
    按当前轮次方重置 ai_thinking、广播。双真=观赏（AI 自弈循环），双假=编辑。
  - **奇偶坑（实测踩过）**：下一手颜色 = `BLACK if (len(history)+1) % 2 == 0`——
    第一版写成 `== 1` 全反了，表现为 AI 永远不被触发。断言调试靠 spy _ai_flag
    发现只收到 BLACK 调用。
  - undo：混合模式撤 2 手（人+AI），观赏/编辑撤 1 手；快照 `canUndo` 同步放宽。
  - recover/restart：按标志重置 ai_thinking（老 AI 局升级后标志默认 False，
    会变成编辑模式——可接受的一次性边缘）。
- **前端**：HUD 两个勾选框（ai-side-picker，render 循环依快照同步）；canMove 对
  mode=ai 放宽为 `!aiThinking`；状态栏文案区分观赏/编辑；AI 弹窗记忆参数。
- **测试**：后端 87 passed（+test_ai_config 3）；前端 83；E2E（ai_modes.cjs）：
  初始勾选 white=true、观赏模式 14 秒自弈至 10 手、编辑模式自由落第 12 手，0 error。

### 3.20 批次十一：皮肤与设置上服 + 棋谱保留策略

- **皮肤同步**：`users.equipped`（JSON）+ `POST /api/shop/equip`（服务端校验
  **商品 id ↔ 材质 id 映射**——解锁表存 mat-*，请求带 frosted-black 这类 target，
  直接比对必 403，实测踩过）。快照 `players.{black,white}.skin` 透传各座玩家
  为自己颜色装备的材质。前端 `applySkins()`：自己色用自己装备、对方色用对方
  skin（设置可关，关了显示默认实体棋子）；wallet 同步覆盖本地装备缓存。
- **设置上服**：`users.preferences`（JSON≤4KB）+ GET/PUT `/api/users/me/preferences`。
  前端 settings 加 `showOpponentSkin`（默认 true）；登录时 `mergeServerSettings`
  以服务端为准同步一次，任何变更 `persistSettings()` 本地立即生效 + 异步上服。
- **棋谱保留**：`games.keep_forever` 列 + `POST /api/games/replays/{id}/keep`
  （参与者、幂等）；`GameService.start_retention_monitor` 每 6 小时清理
  `finished && !keep_forever && updated_at < now-30d`（moves 级联删除）。
  复盘播放条新增「永久储存」按钮（已存则置灰「已永久保存」）。
- **测试**：后端 90 passed（+test_profile_sync 3）；前端 83；E2E：设置开关
  默认开、prefs PUT 无报错、复盘按钮渲染，0 console error。

### 3.21 批次十二：任务 44/45 弹窗布局修复与中键复位视角（2026-11-04）

- **44 开局弹窗「规则」标签与规则胶囊重叠（布局 bug，已修，实测）**：本地 / 人机 / 建房
  三个开局弹窗里，`.form-label-row`（「棋境」「规则」等小号大写标签，`main.css` 里
  `margin: 18px 0 8px`）紧跟 `rulePickerHtml()` 生成的 `.rule-picker`（`.rule-pill` 胶囊行）。
  此前标签与胶囊行之间负间距，导致「规则」字样压在规则胶囊上方重叠。修法：把
  `.rule-picker { margin: 0 0 6px }` 与 `.form-label-row` 的下 margin 配合固定，使「规则」
  标签 bottom 与 `.rule-picker` top 之间恒为正 gap（实测本地弹窗 gap=8px、AI 弹窗同理，
  无重叠）。`shell.ts` 维持 `<p class="form-label-row">规则</p>${rulePickerHtml('local'|'ai'|'room')}`
  结构不变。验证：`frontend/uitest/verify_44_45.cjs`（Playwright/msedge）几何测量
  `.form-label-row` 与相邻 `.rule-picker` 的 `getBoundingClientRect()` 间距 ≥ 0 判 PASS。

- **45 鼠标中键点击棋盘复位视角（新交互，已修 + 顺带修一个真实潜在 bug，实测）**：
  `GomokuScene` 监听 pointerdown/up 的 `button===1`（中键），按下记 `middleStart`
  （含 pointerId），抬起时若位移 ≤ `CLICK_SLOP(7px)` 判为"点击"而非"拖拽"，调
  `sceneManager.resetView()` 走任务 41 的 650ms 缓动复位（与「复位视角」按钮同一路径）；
  拖拽（超阈值）不触发，避免与浏览器中键自动滚动冲突误复位。
  **顺带修复的真实潜在 bug**：`resetView()` 的复位补间 `onComplete` 在开局推镜
  （`playIntro` 5400ms）叠加时偶发不触发，导致 `resetPlaying` 永久卡 `true`，进而
  `resize()`（line 464，`introPlaying || resetPlaying` 期间拦截）被永久阻塞取景重算
  （实测从 t≈4s 一直卡到 t≈16s+）。兜底：在 `tick()` 的 `this.tweens.update(now)`
  之后加——「`!introPlaying && resetPlaying && tweens.size===0` 时把 `resetPlaying`
  收回 false」，确认无相机动画进行中才解锁 `resize()`。
  **调试方法论升级**：WebGL 画面字节级 diff 不可靠（环境粒子 / 霓虹呼吸动画相位不同会让
  静态相机位姿产生数万字节像素差异，但相机数值本身是确定性的）。改在 `SceneManager`
  构造函数尾用 `?debugcam=1` gated 挂载 `window.__camPose()`（返回
  pos/tgt/fov/rp/ip/tw），正常访问零副作用；`verify_44_45.cjs` 用 `waitSettled()`
  轮询（rp===false && ip===false && tw===0）做确定性位姿断言：默认 `[0,25.612,0.512]`、
  右键拖拽后方位角明显改变（poseDist>0.1）、中键点击后方位角回到 0 与默认一致
  （poseClose<0.5），VERDICT=PASS、零页面错误。
  **部署注意**：后端 `SPAStaticFiles` 对 index.html 只有 etag/last-modified、无
  `Cache-Control`，改前端务必让用户硬刷新（Ctrl+Shift+R）。

### 3.22 批次十三：他人名片显示积分 + 布局与自己对齐（2026-11-04）

- **现象**：联机大厅点别人昵称看名片，内容排列和自己名片不同、且不显示积分。
- **根因**：`openProfileCard(target)` 的「他人」分支调 `renderProfileStats(profile, null)`，
  把 `points` 传 `null` → 渲染时**省略整个「积分」格**，于是他人是 5 格、自己是 6 格
  （3 列网格下 5 格末行缺一格，视觉错位），且积分数为 0。原设计注释写「不暴露钱包」，
  但积分是公开分数，用户明确要求展示。
- **改动**：
  - 后端 `backend/app/profile_routes.py` 的 `GET /api/users/{id}/stats` 原来只回
    `id/name/guest + 战绩`，现在追加 `points: target.points or 0`（**只加积分这一公开分数，
    钱包的私人部分——已解锁商品 / 装备皮肤——仍不回**）。
  - 前端 `src/auth/AuthClient.ts`：`PublicProfile` 接口加 `points: number`；`statsFor()`
    解析并回落 0。
  - 前端 `src/main.ts`：`openProfileCard` 的他人分支改传 `profile.points`（与看自己同一套
    `renderProfileStats`，网格顺序、配色完全一致）。同步清掉「不显示积分（看他人的名片）」
    等旧注释；`profile_routes.py` 的端点 docstring 也改为「回身份、战绩与积分，不回钱包私人部分」。
  - README 同步更正：功能列表「个人名片」、API 表 `/api/users/{id}/stats` 描述。
- **部署**：纯前端改动走 `dist` 读盘；但**后端也改了**，必须重启后端（`:25562` 是单一端口
  python 服务，读 `backend/.env`、伺服 `frontend/dist`）。本机该服务由环境自动托管，杀掉会
  自启，自启进程会加载最新 `.py`，因此改完后端代码 + `npm run build` 后重启即生效。
- **验证**：`frontend/uitest/public_profile_check.cjs`（两游客进大厅，A 点 B 昵称 → 断言
  卡片 `open`、含「积分」格且数值为 10000、`.profile-stat` 恰 6 格）实测 `VERDICT: PASS`。

### 3.23 批次十四：棋境陈设改用真实模型 + 防穿模（2026-11-04）

**用户约束**：场景里优先复用现有模型或上网找 CC0 素材，**不要自己建模**（程序化
几何既不好看又费算力），且布置**不能穿模**。默认相机倾角一个字未动（落子精度优先）。

- **撤销**：上一版 P0 里用基础几何手搓的 `buildSignature` 五套道具（茶盏 / 耙纹石组 /
  发光铭牌 / 杯垫杂志 / 扇形色卡）、桌沿 `buildEdge`、坐垫配件、铜铃托盘，以及影棚
  `buildSoftboxes` 的两块发光面。`Environment.ts` 直接从备份还原后只追加新能力。
- **基类新增 `placeTableProp()`**（`Environment.ts`）：
  - 模块级 `propPrototypes` 缓存已解析 GLB，摆放只 `clone(true)` 共享几何/材质，
    切棋境不再重复 fetch + GLTFLoader.parse；
  - `disposed` 标志 + 异步守卫，切场景后迟到资源直接丢弃（顺手补上旧泄漏路径）；
  - `propQueue` 串行化同环境摆放，否则并发 AABB 检查会互相看不见对方；
  - **AABB 防穿模**：棋盘柱体、铜铃占位、桌沿边界、已摆陈设四项互斥，放不下就
    按 `1 → .86 → .72 → .6 → .48` 缩档 + 三个让位点重试，仍不行就跳过并告警；
  - `height` 按高度缩放（落地器材用）、`flatColor` 纯色替换贴图（斑驳幕布变背景板）、
    `groundY` / `tableHalf` 适配不同台面（客厅 GLB 茶几是 x±25.8 / z±11.4、y=-0.31）。
  - `?debugprops=1` 只读读数钩子：把每件陈设的世界 AABB 暴露给回归脚本做数值断言。
- **五景陈设**（全部真实扫描模型，零自建几何）：茶室 `tea_set_01`（原手工摆放左缘
  探到 x=6、正压棋盘右缘，改由校验自动缩到 0.86）；庭院 `rock_09` + `stone_01`；
  赛博 `gaming_console`；客厅 `book_set`；影棚 `camera_01` + `postcard_set` +
  桌后 `projector_screen`（纯色当背景板）。四盏 `RectAreaLight` 仍只作光源留在画外。
- **新下载 CC0**：`book_set` / `postcard_set` / `camera_01` / `gaming_console` /
  `projector_screen`（`tools/fetch_polyhaven.py`，贴图压到 512px，合计约 6 MB）。
  `decorative_book_set_01` 无 glTF 格式，改用 `book_encyclopedia_set_01`；
  `portable_searchlight` / `security_light` / `desk_lamp_arm_01` 实拍后语义不符，已删除。
- **可见区实测**：默认正俯视画面约 x±17 / z±10.6，z 方向像素密度比 x 高 1.27 倍；
  道具中心放 **z≈-6** 才连边缘一起留在画面内，`z<-8` 会被上缘裁掉——
  「没穿模」不等于「看得见」，摆位得同时满足两者。
- **验证**：`tsc -b` / `vite build` / 114 前端单测全绿；`uitest/out/_verify_props.cjs`
  真实浏览器五棋境连跑：8 件陈设全部摆下，AABB 断言「不压棋盘 / 不碰铜铃 /
  不探桌沿 / 彼此不重叠」零违规，落子正常（各 1 手），零 pageerror / 零跳过告警 →
  **VERDICT: PASS**。P1 三项（开场 HUD 让位、叙事行对比度、客厅/影棚机位）保留。

### 3.24 批次十五：桌面陈设按实拍反馈校准尺寸与姿态（2026-11-05）

**用户反馈**：茶具与胶片相机「只比棋子大一点点」，书「过于小、还歪着」，影棚照片「竖着摆」，
庭院小石头该去左下角并加旋转；**庭院大石头与赛博电子设备保持不动**。默认相机倾角仍未改。

- **硬约束复盘**：棋盘禁区右缘 7.75 到桌沿 14.5 只有 6.75 净宽；顶栏与底部状态坞
  又把上下两段 z 吃掉了。所以**只调大 `footprint` 会被 AABB 缩档悄悄缩回去**，
  放大件必须同时改「朝向 + 摆位」，让长边沿 z 走桌面纵深。
- **基类**：`PropOptions` 新增 `rotationX`（先转姿态再 `fitModel`，把立式扫描件放平）
  与 `lift`（零厚度平面抬离桌面，防 z-fighting）。
- **茶室** `tea_set_01`：5.6 → **9.5**（≈1.7 倍），转 90° 沿右侧桌边排成一列茶席，
  单只茶杯约 1.5 单位 ≈ 棋子 0.76 的两倍。§3.23 里「自动缩到 0.86」已不再适用。
- **庭院**：`rock_09` 原位原尺寸不动；`stone_01` 从右侧移到 **(-12.2, 7.0)**（屏幕
  左下角、铜铃左侧的空位），朝向改 1.2 rad，与右上大石形成对角呼应。
- **赛博** `gaming_console`：**一行未改**，保持原有的 factor=0.86 与外观。
- **影棚**：台面 26 → **30**（与其余棋境统一，只为给放大的器材留净空，机位/倾角未动）；
  `camera_01` 3.8 → **8.0**（≈2.1 倍）并摆正；`postcard_set` 是一整面竖直的 4×5
  明信片墙（z 厚度 0），俯拍只是一条细线，改 `rotationX: -π/2` **平放**、抬 0.04、
  放大到 4.6，现在能看清是一叠照片。
- **客厅** `book_set`：5.8 → **9.0**（≈1.55 倍），去掉 0.25 rad 斜角。长边转 90° 沿 z
  摆在棋盘右侧中段（x≈9.7~12.3），与桌沿平行且完整在画面内——横排 9.0 会被右缘裁掉。
  立着的书高 3.88，`maxHeight` 显式放到 5.2，免得被默认 4.2 缩回去。
- **验证**：`tsc -b` / `vite build` / 前端单测全绿；`uitest/out/_verify_sizes.cjs`
  真实浏览器五棋境连跑，除「必须 factor=1」外还断言放大跨度、小石头位置、
  照片 y 厚度 < 0.35、书的长边方向与右端不越界；8 件陈设零穿模、零跳过告警、
  零 pageerror、落子各 1 手 → **VERDICT: PASS**。

### 3.25 批次十六：顶部 HUD 精简为两行（2026-11-05）

**用户反馈**：「顶部 ui 太杂乱了，能不能优化布局排版并去掉无用元素」。实拍基线（1280×820，
人机局玩家回合）显示顶部 116px 内叠了三行、三枚带底浮片：顶栏白色对战条、
灰色小字「AI 对弈 · 十五路无禁手」、深色标题胶囊 + 白色回合徽标。同一事实被重复表达：
「AI 对弈」出现 2 次，「轮到谁」出现在叙事标题 / 回合徽标 / 底部状态行 / 当前颜色 / 名字高亮
共 5 处；AI 思考时「思考」更是在右上角浮动条、标题、徽标、底部状态行说了 4 遍。

- **合并浮片**：玻璃底从 `#stage-title` 移到 `.narration-line`，标题与 `#turn-badge`
  共用一枚胶囊，中间只留一道竖线；标题去掉背景/边框/圆角，徽标去掉白底与阴影、
  改浅色字并 `align-self: stretch` 让分隔线贯穿。`html[data-scene]` 的棋境底色适配
  同步改挂 `.narration-line`，`.mini-stone.black` 加浅描边、读秒改浅色以压在深底上。
- **删恒定信息**：`#mode-eyebrow` 默认 `hidden`，只在**限时 / 残局 / 观战**时显示精简后缀
  （`每步 30 秒 · 残局自第 12 手`）；`renderReplayHud` 里显式置回 hidden。
  模式与棋境本来就在顶栏 `#context-text`，规则首页已写，无需每局重复一遍。
- **删重复浮条**：右上角 `#ai-thinking`「对方正在思考」整块移除（DOM + `main.ts` 两处
  `required` + CSS/keyframes）。AI 思考态由叙事胶囊统一表达：标题改「静观其变，稍候一手。」，
  徽标仍是「对方正在思考」——**后者是 `continue_check.cjs` 的硬断言，不能改**。
- **删无用装饰**：`.match-vs` 的「对 弈」两字换成 1px 竖分隔线；`#connection-status`
  只在「连接中 / 等待重连」时显示（正常态不播报，人机/本地局由本地引擎算、socket 灯无关，
  断线另有 `presence-alert`）。顺手修 `stageTitle()`：原先人机局不看 `yourColor` 一律写
  「轮到你了」，AI 执先手时会说错。
- **对齐与断点**：桌面 `.match` 与 `.narration-line` 都在正中（实测中心 640 / 640.5）。
  **900px 以下直接收起 `.match`**：这一档放不下居中的双方胶囊（会撞右侧 7 个操作按钮），
  原来 `position: static; margin-inline:auto` 把它推到品牌旁边、和叙事胶囊错开更乱。
  680px 以下原本就已经隐藏，等于把断点上移并删掉 460px 的死规则。
- **刻意保留**：`#turn-badge` / `#turn-label` / `#turn-clock`（读秒与 E2E 锚点都在这里）、
  `.match` 的双方名字（联机点名字看名片）、`#stage-title` / `#mode-eyebrow`（复盘覆写用到）、
  `#current-color`（`rapfi_e2e.cjs` 读取）。所有 `[hidden]` / `is-playing` /
  `intro-running` / `is-replaying` 开关原样复用，开场推镜淡出不受影响。
- **验证**：`tsc -b` / `vite build` / 114 项前端单测全绿；`uitest/out/_hud_after.cjs`
  在 1280 / 900 / 680 / 390 四个视口连跑，断言浮片数（桌面 2、窄屏 1）、胶囊不溢出、
  不与顶栏重叠、冗余元素已消失、落子与 AI 思考态文案不重复、零 pageerror →
  **VERDICT: PASS**；`_hud_eyebrow.cjs` 验证副标题条件显示不与胶囊重叠 → PASS；
  `continue_check` / `mobile_phrase`（气泡与 HUD 无几何重叠）/ `ingame_profile_check`
  三个依赖顶部 HUD 的 E2E 全绿。改前源码备份在 `.workbuddy/backups/20261105-0040/`。
- **顺带**：`.gitignore` 忽略 `frontend/uitest/uitest/`（从该目录内跑脚本时，
  相对路径 `uitest/out/...` 会多嵌一层测试截图）。
- **推送**：本轮 `git push` 两条通道都失败（直连 `github.com:443` 超时；环境代理对
  `github.com` 的 CONNECT 返回 502，但 `api.github.com` 通）。改用新增的
  `tools/push_via_api.py` 走 Git Data API 同步，6 个 blob、tree、commit 的 SHA
  与本地**逐层完全一致**，远端 `main` = 本地 `7416982`。详见 `AGENTS.md`「提交」节。

## 4. 素材来源与授权

**全部来自 [Poly Haven](https://polyhaven.com)，CC0 授权（可商用、可修改、无需署名）**。
已下载到 `frontend/public/` 随项目分发，运行时不访问外网。详细清单见 `THIRD_PARTY_NOTICES.md`。

> 完整授权清单与逐项用途见 **`THIRD_PARTY_NOTICES.md`**；三种棋境的改造要点、体积与性能见
> **`docs/SCENE_OPTIMIZATION.md`**。

| 用途 | 素材 | 路径 |
|---|---|---|
| 环境光照（兜底） | Lebombo（室内 HDRI） | `public/hdri/lebombo_1k.hdr` |
| 茶室环境光 | Studio Kominka 01 | `public/hdri/studio_kominka_01_1k.hdr` |
| 庭院天光 + 360° 天空 | Chinese Garden | `public/hdri/chinese_garden_1k.hdr` |
| 赛博环境光 + 城市天际线 | Shanghai Bund | `public/hdri/shanghai_bund_1k.hdr` |
| 茶室榻榻米 | Tatami Mat | `public/textures/tatami_*.jpg` |
| 木构件 / 缘侧 | Japanese Cedar Planks | `public/textures/cedar_*.jpg` |
| 茶室桌面 | Rosewood Veneer 1 | `public/textures/rosewood_*.jpg` |
| 庭院桌面 | Dark Wood | `public/textures/darkwood_*.jpg` |
| 枯山水砂庭 | Coast Sand 01 | `public/textures/zensand_*.jpg` |
| 赛博地面 | Metal Plate | `public/textures/metalplate_*.jpg` |
| 棋盘木面 | AI 生成榧木纹（非 Poly Haven） | `public/textures/board_*.jpg` |
| 茶具（扫描） | Tea Set 01 | `public/models/tea_set_01/` |
| 石组（扫描） | Coast Rocks 01 / Boulder 01 | `public/models/coast_rocks_01/`、`public/models/boulder_01/` |
| 庭松/红枫/赛博樱骨架 | Jacaranda Tree | `public/models/jacaranda_tree/` |
| 盆栽（扫描） | Potted Plant 02 | `public/models/potted_plant_02/` |
| 棋境桌面陈设（扫描） | Book Set / Postcard Set / Camera 01 / Gaming Console / Projector Screen | `public/models/{book_set,postcard_set,camera_01,gaming_console,projector_screen}/` |
| 石灯笼（扫描） | Wooden Lantern 01 | `public/models/wooden_lantern_01/` |
| 现代客厅（用户提供） | 「CG美术之家」家庭室内套件（**非 CC0，商用授权待用户自行确认**） | `public/models/living_room/` |

素材总体积约 **60MB**（HDRI 6.1MB + 贴图 18MB + 模型 36MB；客厅 GLB 17.9MB 来自
用户提供的源素材，由 `tools/import_cg_gltf.py` 裁剪合成）。全部随仓库分发，**运行时不访问外网**。

**Yixin 引擎授权（重要）**：公开下载版**仅限非商业用途免费**，商用需作者书面许可。
见 `engines/README.md`。引擎文件在 `.gitignore` 里，需自行下载放入 `engines/`。

---

## 5. 关键技术决策与踩过的坑（重要，接手务必先读）

这些是反复调试才搞定的，接手后**不要轻易改回**：

1. **棋盘外框必须传 ± 两个偏移**：`buildLineGeometry(extent, halfWidth, offsets)` 会为每个
   offset 生成一横一竖。只传 `[+borderExtent]` 就只画右边和下边（"两边有线两边没线"的 bug）。
2. **模型文件用 GLB，不用「glTF + 外部 .bin」**：分体式在本环境会**静默卡死**——`.gltf`
   返回 200，`.bin` 永不发出，`loadAsync` 既不 resolve 也不 reject，一点报错抓不到。
   必须手动 `fetch` + `parseAsync(buffer, basePath)` 才能拿到明确异常。
3. **BoxGeometry 顶面 UV 是 u→世界 z、v→世界 x**，和 PlaneGeometry 差 90°。给 Box 顶面
   贴木纹会变竖向。解法：在 Box 之上单独铺一层 PlaneGeometry 做顶面。
4. **板宽必须按"一张贴图里有几条板"反推**，不能凭感觉调 repeat。Brown Planks 08 一张图
   约 7 条板，桌面 repeat 1.4 得单条 11cm；我一度给到 3.4，板宽只剩 4.7cm 像细条纹。
5. **棋子用"压扁后重算法线"的球体，不用 scale 压扁**：scale 不改法线，光照会中凸外鼓；
   球体两极 UV 收敛会留暗点/十字刻痕。当前实现是生成 SphereGeometry 后直接改顶点 y 再
   `computeVertexNormals()`。
6. **`crypto.randomUUID` / `navigator.clipboard` 只在安全上下文存在**（HTTPS/localhost）。
   公网 HTTP 下是 undefined，必须做回退。
7. **限帧判据要留 1.2ms 余量**：60Hz 屏 rAF 间隔 16.67ms，严格比较会因浮点误差每两帧才画一次。
8. **Poly Haven 文件名大小写不统一**（如 `Sofa_01_1k.gltf`），且 glTF 的 buffer uri 大小写敏感，
   mv 成小写后要同步改 gltf 里的引用。
9. **场景雾（fog）别乱加**：客厅 150 单位宽，旧的 fog 参数（34~72）会把整个房间糊成米色。
10. **HUD 元素的 opacity 过渡**在软件渲染（swiftshader/无 GPU）下会永久卡在 0，这几个元素
    不要加 `transition: opacity`。
11. **大厅座位不能用「库里有没有没下完的棋」来判定**。关标签页、休眠、杀进程之后那盘棋会
    一直停在 `playing`（`_check_disconnects` 只在**对手仍在线**时判负，双方都走了就没人收尸），
    这个人于是永远挂「对弈中」：既不能被约战，也没有任何入口回到那盘棋。改成客户端报告
    `game.focus {gameId}`——「有没有入口」和「是不是在局中」用同一个信号。
12. **约战必须「先回执、再推快照」**。客户端只有在知道「约战成立」之后才会认领随后到达的
    `game.snapshot`（`handleRemoteSnapshot` 有三道守卫，否则会被当成无关推送丢掉）。
    接受方则是**点下接受时就把 `awaitingRemoteGame` 置真**，因为它的快照先于自己的回执到达。
13. **Playwright 多页测试的两个坑**：① `waitForFunction` 默认 `polling:'raf'`，后台页面的
    rAF 会被节流到停摆，必须显式 `polling: 250`；② 服务端推送是按连接写的，用
    `page.waitForFunction` 等列表时一定要等「某人出现」（按名字），不要等「行数 ≥ N」，
    否则会被遗留的在线连接（僵尸进程会自己重连）喂出错误结论。
14. **浏览器不允许无手势自动播放**。电台不能「加载完就播」，必须等一次真实的
    点击/按键（`pointerdown` / `keydown`）再把 `audio.play()` 接上。所以播放器是
    「待命 → 被接上 → 自己调度」的模型，不是 load 即 play；`play()` 被拒绝时
    不要清掉监听，留着等下一次手势。
15. **`loadedmetadata` 到达之前，改 `currentTime` 会被浏览器忽略**。电台加入时先按旧锚点
    起播、紧接着对表修正，两次 seek 之间元数据往往还没到；如果只记住第一次的待定值，
    `loadedmetadata` 会把正确的新位置**覆盖回旧值**，表现是「怎么都对不齐」。修法：
    `readyState < HAVE_METADATA` 时直接覆盖 `pendingSeekMs`，让最后一次意图胜出。
16. **别用「服务器时间 − 本机时间」做同步**。页面主线程被卡住时（3D 初始化、切后台、
    休眠唤醒），`Date.now()` 会比响应里的时间戳晚几十秒，偏移量直接歪掉。实测在
    软渲染环境里歪了 52 秒，所有人都错位。改成「服务器给出 (曲目, 位置) 锚点 +
    本机单调时钟往前走」，跨机器只对齐一个点。
17. **`<audio>.volume` 是线性振幅，不是听感音量**。0.05 已经是 -26dB、听着相当响，
    所以滑杆可用的区间全挤在最左边（用户反馈 5% 才合适）。增益取平方后
    50% ≈ -12dB、25% ≈ -24dB，低位才有细调的余地。

18. **画面静止时阴影贴图是关掉的，删掉棋子不会自己抹掉影子。** `SceneManager.tick`
    为了省 GPU，静止时把 `shadowMap.autoUpdate` 置 false；此时去掉一颗棋子，阴影图
    还停在上一帧，棋盘上会留下一片「已经不存在的影子」（终局重开后最明显）。
    凡是增删可投影物体的地方都要调 `sceneManager.invalidateShadows()`
    （`BoardManager.syncBoard` / `clear` 已经做了）。实测：重开后画面与空盘**逐像素相同**。
19. **`LatheGeometry` 的面朝向由顶点顺序决定**。轮廓点从顶写到底，得到的是一圈朝里的面，
    渲染时被背面剔除——俯拍看到的只有一个黑底盘。必须**从下往上**写。
20. **WebSocket 的 `finally` 里不要 await「碰别人连接」的操作**。socket 关掉之后
    Starlette 会取消这个任务，任何带 checkpoint 的 await（比如往对手的连接写一帧）
    都可能被就地掐断，表现是「对面明明掉线了，我这边什么都没收到」。要把这类通知
    交给 `asyncio.create_task(...)`，别挂在即将消失的协程上。
21. **断线横幅要按「对面」取颜色，别把条件写反**。第一版写成
    `mine !== 1 && presence.white`（本意是「我不是白方才看白方」，写成了「我不是黑方」），
    黑方自己掉线时界面会去关心白方，而真正掉线的白方被忽略，横幅永远不出现。
    这条逻辑现在抽成了 `game/presence.ts` 的纯函数并带了单测。
22. **软渲染下 `dialog::backdrop { backdrop-filter: blur() }` 会把整个截图糊掉**，包含弹窗本身。
    截图前注入 `.modal::backdrop{backdrop-filter:none}` 才能看清排版；这不是真实浏览器的表现。

---

## 6. 测试与构建（当前状态全绿）

| 项 | 命令 | 结果 |
|---|---|---|
| 后端测试 | `cd backend && python -m pytest` | **74 passed** |
| 前端测试 | `cd frontend && npx vitest run` | **85 passed** |
| 类型检查 | `cd frontend && npx tsc -b` | 通过 |
| 生产构建 | `cd frontend && npx vite build` | 通过，three chunk ~544KB |

真实引擎验证过：Yixin 2017 通过 PyGomo 成功 `START/BEGIN/TURN/BOARD`，每步约 0.7s。
大厅/约战另用 Playwright 双窗口跑通过一遍完整链路（A 点约战 → B 弹窗 → 接受 → 双方进局，
随机黑白，`#challenge-sent` 自动收起）。

本轮（观战/断线/铜铃）除了 pytest，还跑了两类端到端验证：

- `C:/Users/45126/AppData/Local/Temp/uitest/wire_check.py`：直接用 `websockets` 连三条
  连接，验证观战快照、落子广播、按铃转发、断线 presence 与快照里的 `presence` 字段——
  不经过浏览器，排障时先跑它。
- Playwright：观战进出（0 → 1 → 2 → 0 人）、观战者结算卡（无「再来一局」）、
  断线横幅与倒计时、重连后横幅收起、按铃后对手收到提示、重开前后棋盘**逐像素比对**
  （验证阴影修复）、以及「只有点电台按钮才起播」。

本轮（三种棋境）的端到端验证（脚本在 `C:/Users/45126/AppData/Local/Temp/uitest/`）：

- `scenes.cjs`：三个棋境各走一遍真实路径（建房弹窗选卡 → 创建房间 → 等待页），
  断言 `#context-text` 显示对应棋境名并截图（`scene-tea/courtyard/cyber.png`）；
  另验证「随机」会落到一个合法棋境。素材请求全程拦截加速。
- `scenes-duo.cjs`：双浏览器同房间——Alice 建房选「赛博夜局」，Bob 凭房间号加入，
  两边 `#context-text` 都必须显示「赛博夜局」（`SAME-SCENE OK`）。

---

## 7. 运行方式

```bash
# 后端（生产单端口 25562，托管已构建的前端）
cd backend && python -m app.main
# 会读 backend/.env（已配置 YIXIN_ENGINE_PATH 指向 engines/yixin17/）

# 前端开发（Vite dev server，端口 25562，代理 /api 和 /ws 到 8000）
cd frontend && npm run dev

# 构建前端（产物到 frontend/dist，由后端托管）
cd frontend && npm run build
```

`backend/.env` 已存在，`YIXIN_ENGINE_PATH` 已指向项目内的 `engines/yixin17/pbrain-Yixin17_64.exe`，
`PORT=25562`。**直接 `python -m app.main` 就能起**。

25562 端口由本项目独占；`netstat -ano | findstr :25562` 可查当前 PID。
注意 25563 是 WorkBuddy 运行时占用的，别动。

---

## 8. 待办事项（接手后的工作清单）

### 8.1 明确未完成的功能（用户之前提过，尚未做）

1. ~~**在线大厅 + 约战**~~（2026-11-01 完成，见 3.3）

2. **动态棋盘尺寸**（13/15/17/19 路）
   当时判断有暗礁：`BOARD_SIZE` 硬编码在 `rules.py`、`models.py`、前端 `types.ts` 三处，还要落库、
   改快照协议、重建引擎会话。且 Yixin 对非 15 路支持有限。建议：尺寸只在本地对弈和好友联机开放，
   人机对战锁死 15 路。

3. **引擎思考面板**（实时显示 depth/胜率/PV）
   实测 Yixin 2017 的 `all_info` 三条全是 `depth 0 / eval 0 / pv []`，引擎不输出搜索细节。
   面板做出来只会显示假数据。需要换成会输出 INFO 的引擎版本（Yixin 商业版或 Rapfi/AlphaGomoku）。
   **2026-11-02 补充**：本轮再次实测 Yixin 2018 (0.7.13，gomocup.org 官方下载) 同样 0 条 INFO
   （复杂中盘 5s + 空盘 12s 都试了）——Yixin 全系列公开版都不输出 INFO，只有商业版/内部版有。
   用户决策：**不做双引擎、不逆向**，走「推荐点」降级形态（见 3.13）；想要数字指标
   只能联系作者（aiexp.info）谈商业版授权。

4. **禁手规则**
   已预留扩展点（`RulePolicy` Protocol / `RuleEngine` 接口），但未实现。

### 8.2 大厅后续可做的（做完 3.3 / 3.5 之后自然延伸出来）

- ~~**观战**~~（2026-11-01 完成，见 3.5）
- **约战附带条件**：现在只能约「默认规则」。要做限时/让子，把条件塞进 `Challenge` 即可，
  握手本身不用改。
- **大厅里的历史与战绩**：`games` 表已经有全部数据（含胜负），只是没做查询接口。
- **好友/最近对手**：需要给 `users` 加关系表，属于新子系统。

### 8.3 场景层面可继续打磨的点（做完 3.7 之后）

- ~~**三种棋境**~~（2026-11-01 完成，见 3.7；旧「客厅」环境已整体移除）
- **各棋境的细节密度**：茶室最丰满（榻榻米/障子/床之间/行灯/茶具）；庭院与赛博的
  远景摆设还可以再加（庭院可加竹林与飞石小径，赛博可加广告飞艇与楼群窗光）。
- **贴图命中率**：三个环境都主要靠程序化纹理（`textures.ts`）+ 纯色 PBR，
  只有茶桌/棋盘复用了 Poly Haven 木皮。要更「照片级」就得给各环境接真实贴图，
  注意素材体积（现在全站约 10MB）。
- **棋境卡没有缩略图**：建房弹窗里是三色渐变色带。可改为实时渲染小图或静态截图，
  静态截图要注意随版本更新。
- **切换棋境没有过渡**：`setScene` 是硬切。可以加一次 300ms 的黑场或曝光渐变，
  但要先想清楚「谁在什么时候触发」——随机分配时黑场会打断进局节奏。

### 8.4 工程/运维层面

- **多标签页会同时出声**：电台没有做跨标签页协调（`BroadcastChannel` / `localStorage`
  互斥）。做的话要注意「被抢占的标签页没有播放入口，会永久静音」这个问题——
  要么给它留一个恢复途径，要么干脆不做。目前按「多标签同时播」处理，和多数音乐站一致。
- **Docker 未实机验证**：本机没有 docker 命令，`docker-compose.yml` 和 `Dockerfile` 写好了但没跑过。
- **本机环境的坑**：Playwright 截图测试里，单次 fetch 要 50+ 秒（swiftshader 软渲染 + 网络拦截），
  导致"素材加载慢"的假象。**真实浏览器不会这样**，10MB 素材正常一两秒。别被测试环境误导。
- **25563 端口**：`0.0.0.0:25563` 是 WorkBuddy node 运行时占用，**不是本项目，别去动它**。

---

## 9. 给接手同事的实操提示

1. **先读 `README.md`**，它是完整的中文文档（功能/架构/环境变量/Yixin 配置/部署/FAQ/版权）。
2. **改场景**：主要在 `frontend/src/scene/`。对外接口集中在 `GomokuScene.ts` 的 4 个方法
   （`setSnapshot` / `setInteractive` / `resetView` / `dispose`），`main.ts` 依赖它。
   **规则层 `game/rules.ts` 和 `backend/app/rules.py` 不要动**，胜负判定已经验证过。
3. **改素材**：新素材放 `frontend/public/`，加载逻辑在 `scene/assets.ts`。
   记住用 GLB（别用分体 glTF），用 `loadPbrTextureSet` 统一加载 PBR 套图。
4. **调相机/取景**：`scene/config.ts` 的 `VIEW_INSETS`（HUD 边距）、`CAMERA_POSITION`、`CAMERA_FOV`。
   取景算法在 `SceneManager.ts` 的 `fitDistance`（把棋盘 8 角投到 NDC 迭代调距离）。
5. **验证场景**：截图脚本在 `C:/Users/45126/AppData/Local/Temp/uitest/*.cjs`（Playwright + Edge headless）。
   注意软渲染下帧率/加载都很慢，截图要等足够久；素材可以用 `context.route` 拦掉提速。
6. **改大厅/约战/观战**：服务端全在 `backend/app/lobby.py`（名单、座位、握手、TTL）
   与 `backend/app/spectate.py`（只读席位、人数、断线收回），
   协议分发在 `websocket.py`（`lobby.watch` / `game.focus` 在连接循环里直接处理，
   约战三条走 `dispatch`）。前端在 `main.ts` 的「大厅与约战」区块 + `ui/shell.ts` 的
   `#online-options` / `#challenge-dialog` / `#challenge-sent`。
   **别把座位判据改回「查库」**，理由见 5.11。
7. **加音乐**：把文件丢进仓库根的 `radio/`，或把 `RADIO_DIR` 指向已有音乐目录后重启。
   曲库在 `backend/app/radio.py`，播放器在 `frontend/src/audio/Radio.ts`。
   入口按钮与音量卡片在 `main.ts` 的 `setupRadio` / `renderRadio`。
8. **改铜铃/断线**：铜铃在 `frontend/src/scene/Bell.ts`（摆位、命中半径、按铃动画），
   接线在 `GomokuScene` 的 `onPointerUp` 与 `main.ts` 的 `ringBell` / `handleRing`；
   断线横幅的数据来自 `game/presence.ts` 的 `offlineOpponent`（纯函数，有单测），
   渲染在 `main.ts` 的 `syncPresence` / `renderPresence`。
9. **测试**：改完跑 `pytest` + `vitest run` + `tsc -b`，三样都要绿。
   端到端先跑 `wire_check.py`（最快、不依赖浏览器），再跑 Playwright 脚本。

---

## 10. 一句话总结

这是一个**功能完整、已通过 157 项测试（后端 72 + 前端 85）、真实 Yixin 引擎验证过的联机五子棋**。核心对局逻辑
（规则/联机/AI 桥接/认证）已经稳定，3D 场景也已是 CC0 真实素材 + PBR + HDRI。
社交层（**在线大厅与约战** 3.3、**观战 / 断线判负 / 桌上铜铃** 3.5）与场景层
（**三种棋境：茶室 / 庭院 / 赛博** 3.7）都已就绪。
接手后的主要方向是：**动态棋盘尺寸**、**战绩查询**，以及各棋境细节的继续打磨。

---

## 11. 给接手同事的一句话

代码与文档（`README.md` / `THIRD_PARTY_NOTICES.md` / 本文件 / `docs/SCENE_OPTIMIZATION.md`）已对齐到最新——三棋境 + CC0 真实素材，clone 后先跑 `pytest` + `npx vitest run` + `npx tsc -b` 做环境自检；动手前务必读一遍第 5 节「踩过的坑」和 `docs/SCENE_OPTIMIZATION.md`，每一条都是调试出来的。祝顺利。
