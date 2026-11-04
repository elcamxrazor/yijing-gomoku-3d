# AGENTS.md — 多会话协作约定

> **开工前请先读完本文件再动手。**
> 这个仓库有多个 AI 会话先后甚至并发修改。「硬规则」不是形式主义——每一条背后都有真实踩过的坑：
> 有会话的未提交工作被工作区操作打断，有半成品代码在准备上线的边缘被拦下。

---

## 1. 环境事实（照抄，不要猜）

**生产服务器（Windows）**

| 项目 | 值 |
| --- | --- |
| 主机 / Tailscale | `100.68.42.112`，SSH 用户 `45126` |
| 仓库与部署目录 | `C:\Users\45126\WorkBuddy\2026-10-31-07-00-13` |
| 服务端口 | `25562`（uvicorn `0.0.0.0`，后端同时托管 `frontend/dist`） |
| Python | `C:\Users\45126\.workbuddy\binaries\python\versions\3.13.12\python.exe` |
| Node | `C:\Users\45126\.workbuddy\binaries\node\versions\22.22.2-6\` |
| Git | `C:\Users\45126\.workbuddy\binaries\PortableGit\versions\1.3.0\cmd\git.exe` |
| 后端启动脚本 | `C:\Users\45126\start_backend.cmd` |
| 开机自启任务 | `YijingGomokuBackend`（开机触发 + SYSTEM 身份，`ExecutionTimeLimit=PT0S`） |

- **`cmd` 里没有 git 在 PATH**，必须写全路径。也不要靠猜目录结构（`PortableGit\versions\current\current` 这种嵌套是陷阱，用 `dir /s /b` 找）。
- 服务已由计划任务托管：**机器重启后会自动起来**。手动再拉一次会提示「端口 25562 已被占用」然后退出，这是正常现象，不是故障。
- 手动重启：`schtasks /run /tn YijingGomokuBackend`

**网络限制**

- 服务器**访问不了 github.com**，且 `origin` 是不带 token 的裸地址 → **服务器永远无法 push**。不要在这上面浪费时间。
- 本机推送 GitHub 必须走代理 `http://127.0.0.1:7897`；系统默认的 `http://127.0.0.1:13797` 对 GitHub 报 `CONNECT tunnel failed 502`，直连则超时。
- 本机连服务器：`ssh -F .ssh/config yijing`（用工作区的 `rrun.sh` / `rscp.sh` 包装，它们会固定 MSYS 不转换路径）。Tailscale 的 `100.68.42.112:25562` **本地直连不通**，要访问站点得开 SSH 隧道 `-L 25562:127.0.0.1:25562`；且 `-L` 不能用 `rrun.sh` 加（`yijing` 之后的参数会被当成远程命令）。

**数据**

- SQLite：`backend/data/gomoku.db`，**不进版本库**。
- 加列靠 `Database._ensure_column("表", "列", "定义")` 做幂等 `ALTER TABLE`。`db.create_all()` **不会**给已有表加列。
- 后端 `.py` 改动**必须重启**才生效（不是热加载）。

---

## 2. 角色分工与交接

两个会话**都可以改代码**，但**同一时刻只能有一个在改**。换班由用户口头指定，不靠会话之间自行协商。

| 角色 | 可以做什么 | 不可以做什么 |
| --- | --- | --- |
| **当班会话**（用户指定） | 改 `frontend/` `backend/` 源码、提交、构建、重启、验证、推 GitHub | 在对方未交班时抢改 |
| **待命会话** | 只读 `status/log/diff/show`、跑测试、查日志、代码审查、运维（计划任务 / 进程 / 数据清理）、搬运 bundle | 改源码、`stash`、`checkout`、`clean`、`build`、重启 |

- **默认当班方是本地会话。** 服务器侧 AI 有额度限制，不宜承担主力开发；它适合接手「已经在手上、正在写的那一段」，写完就交回。
- 不要靠猜对方在不在改。**进入当班只认 `git status`**：不干净说明上一位还没交班，停手、问人。

### 交接协议

交班时必须满足三条，缺一条就会出事：

1. **工作区干净** —— 上一位的改动要么已 commit，要么明确说明丢弃。**不许带着未提交改动交班。**
2. **两边 HEAD 一致** —— 本地 clone 与服务器仓库指向同一个 commit（同步见第 7 节）。
3. **线上状态已知** —— 当前线上产物哈希是什么、有没有已提交但未部署的代码。

交班时在对话里报一行：

```
交班：HEAD=<sha> 工作区干净 线上=<产物哈希|未构建> 未部署=<有/无> 备注=<一句话>
```

接手方先 `git status` + `git log -1` 核对这两项，再开工。

---

## 3. 硬规则

**H1 · 不动别人未提交的工作。**
禁止 `git stash`、`git checkout --`、`git reset --hard`、`git clean`、批量覆盖文件。
如果某个操作因为工作区有未提交改动而受阻（例如 `git pull` abort），**停下来问**，
不要自作主张把别人的改动收进 stash。工作区突然变干净，对方视角就是「正在写的东西凭空消失了」。

**H2 · 构建前必须 `git status` 干净。**
`vite build` 会把工作区里**所有**未提交改动一起打进产物。半成品上线比没上线更糟。
有未提交改动时，先让改动方提交，或明确确认「这批就是要上线」。

**H3 · 不要 rebase / amend 已提交（尤其已同步的）历史。**
跨机搬运依赖增量 bundle（`<已知公共点>..main`），历史一改写基线立刻错位。
要撤销已提交的改动，新开一个 commit 反过来做。

**H4 · `dist/` 与 `data/` 不进版本库。**
`frontend/dist/`、`backend/data/*.db`、`backend/_restart.log` 都是运行时产物。
提交前看一眼 `git status`，别 `git add -A` 一把梭。

**H5 · 提交 = 这段工作结束。**
commit 之后工作区应当干净，语义上表示「可以给别人用/可以构建了」。
不要留半截提交再去改别的文件，那样别人无法判断当前状态。

**H6 · 上线是两件事，别只做一半。**
`git commit` 只入库，**不改变线上**。线上生效 = `vite build` + 重启后端。
做完要验证（见第 6 节），并在对话里明确说「已构建并重启」。

---

## 4. 提交约定

- commit message 用中文，前缀沿用现有风格：`feat:` / `fix:` / `test:` / `docs:` / `refactor:` / `chore:`。
- 一个 commit 做一件事，不要混合「功能 + 顺手改格式」。
- 提交前跑一遍该跑的门禁（见第 5 节）。
- **提交后要在对话里通知**，并说明「已推 GitHub / 未推」。没被推到远端的 commit 只存在于一块硬盘上。

---

## 5. 提交前门禁

**本地 clone 有完整依赖**（`node_modules` 已装，node v22.22.2，与服务器一致），
类型检查与单测都在本地跑，快：

```bash
# 后端（backend/ 下）
python -m pytest -q

# 前端（frontend/ 下）
npm run typecheck     # tsc -b
npm test              # vitest run
```

`vite build` **只在服务器执行**（产物只有服务器用，且 `dist/` 含大量模型资源，没必要来回传）。

- 已知红灯：`test_profile.py::test_public_profile_reports_identity_but_not_wallet`。
  原因是**产品口径冲突**（`profile_routes` 的 docstring 明写「积分是公开分数」，测试却断言不得公开），
  不是实现 bug。在口径定下来之前，不要为了让测试变绿而擅自改 `profile_routes` 的可见性。
- `npm ci` 在 npm 10.9.7 上会失败，用 `npm install`；注意它可能重写 `package-lock.json`，
  **不要把无关的 lock 变动混进提交**。

---

## 6. 从改码到上线

**本地改码、服务器构建运行**，服务器不承担编辑工作。完整链路：

**① 本地**（`gomoku-work/`，本机 clone）

```bash
git status                 # 必须干净，确认已接手
# ...改代码...
npm run typecheck && npm test      # frontend/
python -m pytest -q                # backend/
git add <文件> && git commit -m "feat: ..."
```

**② 同步到服务器**（服务器拉不了 GitHub，只能靠上传 bundle）

```bash
# 本地：基线用「服务器当前 HEAD」，中间提交会一并带入
git bundle create ../up.bundle <服务器当前HEAD>..main
rscp.sh ../up.bundle yijing:C:/Users/45126/up.bundle
```

```bat
:: 服务器（git 需全路径）
cd /d C:\Users\45126\WorkBuddy\2026-10-31-07-00-13
git fetch C:\Users\45126\up.bundle main
git merge --ff-only FETCH_HEAD
```

`merge --ff-only` 失败 = 两边历史分叉了，**停下来查**，不要 merge 也不要 reset。

**③ 服务器构建**

```bat
cd /d C:\Users\45126\WorkBuddy\2026-10-31-07-00-13\frontend
set PATH=C:\Users\45126\.workbuddy\binaries\node\versions\22.22.2-6;%PATH%
npm run build
```

记下新产物哈希（`dist/assets/index-*.js` 的文件名）。

**④ 重启后端**（`.py` 改动必须重启才生效）

```bat
netstat -ano | findstr :25562        :: 拿到 PID
taskkill /PID <pid> /F
schtasks /run /tn YijingGomokuBackend
```

**⑤ 验证**

- 首页 HTTP 200，引用的 `index-*.js` / `index-*.css` 也 200
- 产物哈希与第 ③ 步一致（不一致说明有缓存或没换 dist）
- 进程启动时间晚于 `.py` 的 mtime（否则没加载新代码）
- 注意：构建期间 `GET /` 可能刷出一段 404，那是旧进程留下的日志，新进程起来后正常

**⑥ 推 GitHub**（本地直连）

```bash
https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 \
  env -u HTTPS_PROXY -u HTTP_PROXY git push origin main
```

浏览器端验收可本地跑 `frontend/uitest/*.cjs`（Playwright + Edge，连线上），
需要 `NODE_PATH=C:/Users/45126/_pwtest/node_modules`（**必须 Windows 风格路径**），
连线上要先开 SSH 隧道 `-L 25562:127.0.0.1:25562`。

---

## 7. GitHub 同步

远端只有一个权威分支 `main`，但提交来源有两个，走两条路。

**A · 本地当班（主路径）** —— 本地直接推，命令见第 6 节 ⑥。服务器那边不需要做任何远端操作。

**B · 服务器侧当班** —— 服务器推不了 GitHub，必须由本地搬运：

```bash
# 服务器（git 全路径）
git bundle create C:\Users\45126\wb.bundle <双方公共提交>..main

# 本机
rscp.sh yijing:C:/Users/45126/wb.bundle ./rt.bundle
cd gomoku-work
git fetch ./rt.bundle main:refs/remotes/srv/main
git log --oneline --stat HEAD..srv/main      # 先看清里面是什么
git push origin srv/main:main
git merge --ff-only srv/main
```

- 搬运前先看 `--stat`，确认没有误带 `dist/` 或 `data/`。
- 推 GitHub 一律带代理，否则报 `502` / 超时（见第 1 节）。

**GitHub 是唯一异地备份。** 服务器那块硬盘是唯一的可运行副本，别让它落后远端太多——
服务器侧连续提交几次而没人搬运，等于把工作压在单盘上。

---

## 8. 已知陷阱速查

| 现象 | 真实原因 |
| --- | --- |
| 重启后手动启动报「端口 25562 被占用」 | 计划任务已经拉起服务了，不是冲突故障 |
| 计划任务跑满 72 小时服务被掐死 | `schtasks` 命令行建的任务默认 `ExecutionTimeLimit=72:00:00`，必须显式设 `PT0S` |
| `cmd` 里 `git` 不是内部或外部命令 | git 不在 PATH，用全路径 |
| `rrun.sh "cd /d C:\..."` 报「参数格式不正确」 | 引号/空格在 ssh 层层转义里丢了，改用 `.cmd` 脚本上传再执行 |
| `timeout /t 5` 在非交互 ssh 里失败 | 用 `ping -n 6 127.0.0.1 >nul` 等待 |
| 构建后一段时间 `GET /` 全是 404 | 旧进程在建 `dist` 期间留下的日志，新进程起来后正常 |
| `wmic process call create` 返回 -1 无输出 | 已失效，改用 `powershell Start-Process` |
| 页面计数与预期差一截 | 残局局从 `start_ply` 起算，`Math.max(0, 手数 - startPly)` |

---

## 9. 改动记录

- 2026-11-05 建立本文件。背景：多会话并发改同一批前端文件，发生一次未提交工作被工作区操作打断的事故。
- 2026-11-05 修订分工：两个会话**都可以**改代码，同一时刻只一个当班，换班由用户指定。
  默认当班方为本地会话（服务器侧 AI 额度受限）；补充交接协议与「本地改码 → 服务器构建」链路。
