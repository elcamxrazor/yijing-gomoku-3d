# AGENTS.md — 协作与部署速查

> 一次只启用一个 AI 会话。**本地会话只推源码，构建 / 重启只由服务器执行。**
> 开工前扫一遍本文件。下面的门禁都是仓库内版本化的脚本（`tools/hooks/`），不是口头约定。

## 并发规则（先读这段）

| 事项 | 规则 |
| --- | --- |
| 独立工作树 | 每个会话用自己的目录或 `git worktree`，不共用工作区 |
| 取锁 | 长任务开工 `tools/claim.sh start <名字> <任务>`，然后 `export AI_SESSION=<名字>`；收工 `tools/claim.sh release` |
| 锁过期 | 默认 45 分钟自动过期；确认对方失联用 `tools/claim.sh takeover <名字> <任务>` |
| 提交 | 显式 `git add <具体路径>`，**禁止 `git add -A`**；一个 commit 一件事，做完立刻推 |
| 冲突 | 推送被拦 → `git fetch && git rebase origin/main` → 重跑三件套测试 → 再推；**禁止 `--force` / `--no-verify`** |
| 发布 | 只有服务器能 build / 重启；本地永远不碰 `frontend/dist`、不部署 |
| 门禁 | 两边都执行过 `git config core.hooksPath tools/hooks`（或 `sh tools/install-hooks.sh`），钩子随 pull 同步 |

被 `BLOCKED` 拦住时按提示处理，不要绕过——那通常意味着另一个会话正在写。
`pre-commit` 拦派生物与误提交，`pre-push` 拦他人租约与非快进推送（等价于禁 force）。

## 环境

| 项目 | 值 |
| --- | --- |
| 主仓库 / 部署目录 | `C:\Users\45126\WorkBuddy\3d-yijing-gomoku` |
| 服务端口 | `25562`（uvicorn `0.0.0.0`，后端同时托管 `frontend/dist`） |
| Git | 已加进系统 PATH，直接 `git xxx` 即可（2.55.0）。若报「不是内部或外部命令」，退回全路径 `C:\Users\45126\.workbuddy\binaries\PortableGit\versions\1.3.0\cmd\git.exe` |
| Node | `C:\Users\45126\.workbuddy\binaries\node\versions\22.22.2-6\` |
| Python | `C:\Users\45126\.workbuddy\binaries\python\versions\3.13.12\python.exe` |
| 启动脚本 | `C:\Users\45126\start_backend.cmd` |
| 开机自启 | 计划任务 `YijingGomokuBackend`（开机触发 + SYSTEM，不限时） |

服务已由计划任务托管，**机器重启会自动起来**。此时手动再拉会提示「端口 25562 已被占用」然后退出，属正常。

## 上线（仅服务器执行，单一发布入口）

```bat
cd /d C:\Users\45126\WorkBuddy\3d-yijing-gomoku
tools\deploy.cmd
```

脚本依次做：`HEAD == origin/main` 且工作区干净 → **租约硬门禁** → `npm run build` → 写
`frontend/dist/BUILD_INFO.json`（commit / 时间 / 发布者）→ 重启计划任务。
**任何前置检查失败就直接退出，不会把半成品打上线**。本地会话不要运行它，也不要自己 build。

**租约硬门禁（2026-11-05 起）**：`tools/deploy.cmd` 会在构建前调用
`tools/publish_gate.py`（判定逻辑与 `pre-push` 钩子一致）：

- 无 `CLAIM.json`、或租约已过期 → 放行（短任务可直接发布）
- 有未过期租约且 `AI_SESSION` 等于 owner → 放行（持锁者本人）
- 有未过期租约但没设 `AI_SESSION` / 不匹配 → **BLOCKED，退出码 1，不构建不重启**
- `CLAIM.json` 损坏或 python 不可用 → 同样 BLOCKED，绝不静默放行

长任务发布前先 `tools/claim.sh start <名字> <任务>` 并 `set AI_SESSION=<名字>`，
发完 `tools/claim.sh release`。服务器 `python` 不在 PATH，脚本已用全路径
`C:\Users\45126\.workbuddy\binaries\python\versions\3.13.12\python.exe` 调用，失效时回退 `python`。

验证：`curl http://127.0.0.1:25562/BUILD_INFO.json` 里的 `commit` 等于 `git rev-parse HEAD`；
首页 200；首页引用的 `index-*.js` 与 `dist/assets` 文件名一致。

## 测试

```bat
:: backend/
python -m pytest -q

:: frontend/
npm run typecheck
npm test
```

已知红灯 `test_public_profile_reports_identity_but_not_wallet` 是产品口径冲突
（`profile_routes` 源码里明写积分是公开的），不是 bug，不要为了让它变绿去改可见性。

## 提交

- 中文前缀：`feat:` `fix:` `test:` `docs:` `refactor:` `chore:`，一个 commit 做一件事
- **不要提交** `frontend/dist/`、`backend/data/*.db`、`backend/_restart.log`（pre-commit 会拦）
- 提交后直接 `git push origin main`（origin 已配好凭证，服务器和本机都能推）
- **推失败先换通道，别急着怀疑凭证**：直连不通就加 `https_proxy=http://127.0.0.1:7897`，代理不通就去掉代理；两边都试过还报 `Authentication failed` 才是真凭证问题
- **两条通道都不通时走 API 兜底**（2026-11-05 实测：直连 `github.com:443` 超时，环境代理对 `github.com` 的 CONNECT 返回 502，但 `api.github.com` 可用）：`python tools/push_via_api.py` 会用 Git Data API 把本地 HEAD 这一笔提交原样同步到远端 `main`，blob / tree / commit 三层逐一比对 SHA，成功后自动更新本地 `origin/main`。**前提**：远端 `main` 正好是 HEAD 的父节点、只有一笔未推送提交；分叉或多笔先手工处理
- 提交前确认 `git status` 干净，别把半成品和别人未提交的改动一起打进构建

## 坑

- `core.hooksPath` 是**本机** git 配置，新 clone / 新 worktree 要重新 `git config core.hooksPath tools/hooks`
- 走 7897 代理时 schannel 常报 `failed to receive handshake`；改用 `git -c http.sslBackend=openssl -c http.proxy=http://127.0.0.1:7897 push origin main` 即可（2026-11-05 实测）；偶发 `unexpected eof while reading` 属链路抖动，重试一两次即可
- 服务器 `python` **不在 PATH**：用 `C:\Users\45126\.workbuddy\binaries\python\versions\3.13.12\python.exe`；跑 `tools/push_via_api.py` 前先 `set PYTHONIOENCODING=utf-8`，否则中文门禁提示在 SSH 里是乱码
- `tools/push_via_api.py` 走 HTTPS API、**不经过 git 钩子**，但已内置等效门禁（租约 / 派生物 / 远端必须等于 HEAD^）；`python tools/push_via_api.py --check` 可只跑门禁不联网。**优先普通 `git push`**，API 兜底只在两条网络通道都断时用，用后重跑三件套
- `CLAIM.json` 是租约锁文件，必须提交；别手工删，用 `tools/claim.sh release`
- `package-lock.json` 被单独改动会被 pre-commit 拒绝（多半是 `npm install` 重写的），用 `git restore frontend/package-lock.json`
- `backend/_restart.log` 被追踪且每次重启都变脏：部署门禁已排除它，但仍禁止提交
- 计划任务默认 `ExecutionTimeLimit=72:00:00`，跑满 72 小时会被强杀；已改成 `PT0S`，重建任务时记得重设
- 数据库加列要用 `Database._ensure_column(...)` 做幂等 `ALTER TABLE`，`db.create_all()` **不会**给已有表加列
- 构建期间 `GET /` 可能刷一段 404，是旧进程日志，新进程起来后就正常
- `npm ci` 在 npm 10.9.7 上会失败，用 `npm install`
- `timeout /t` 在非交互 SSH 里不工作，等待用 `ping -n 6 127.0.0.1 >nul`
- 服务器推 GitHub 会多打一条 `Unable to persist credentials with the 'wincredman' credential store`，**只是警告，推送已成功**
- 系统 PATH 的改动前备份在 `C:\Users\45126\machine_path_backup.txt`，要回滚就把它写回 `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment` 的 `Path`
