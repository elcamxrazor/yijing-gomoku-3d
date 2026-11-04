# AGENTS.md — 部署与操作速查

> 一次只启用一个 AI 会话，做完就提交并推送云端。开工前扫一遍本文件，够用。

## 环境

| 项目 | 值 |
| --- | --- |
| 主仓库 / 部署目录 | `C:\Users\45126\WorkBuddy\2026-10-31-07-00-13` |
| 服务端口 | `25562`（uvicorn `0.0.0.0`，后端同时托管 `frontend/dist`） |
| Git | `C:\Users\45126\.workbuddy\binaries\PortableGit\versions\1.3.0\cmd\git.exe`——**cmd 里没有 git 在 PATH，必须写全路径** |
| Node | `C:\Users\45126\.workbuddy\binaries\node\versions\22.22.2-6\` |
| Python | `C:\Users\45126\.workbuddy\binaries\python\versions\3.13.12\python.exe` |
| 启动脚本 | `C:\Users\45126\start_backend.cmd` |
| 开机自启 | 计划任务 `YijingGomokuBackend`（开机触发 + SYSTEM，不限时） |

服务已由计划任务托管，**机器重启会自动起来**。此时手动再拉会提示「端口 25562 已被占用」然后退出，属正常。

## 上线（改完代码后）

```bat
:: 1. 构建
cd /d C:\Users\45126\WorkBuddy\2026-10-31-07-00-13\frontend
set PATH=C:\Users\45126\.workbuddy\binaries\node\versions\22.22.2-6;%PATH%
npm run build

:: 2. 重启后端（.py 改动必须重启才生效）
netstat -ano | findstr :25562
taskkill /PID <上面查到的PID> /F
schtasks /run /tn YijingGomokuBackend
```

验证：首页 HTTP 200、引用的 `index-*.js` 与 `dist/assets` 里文件名一致、进程启动时间晚于 `.py` 的修改时间。

## 测试

```bat
:: backend/
python -m pytest -q

:: frontend/
npm run typecheck
npm test
```

已知红灯 `test_public_profile_reports_identity_but_not_wallet` 是产品口径冲突（`profile_routes` 源码里明写积分是公开的），不是 bug，不要为了让它变绿去改可见性。

## 提交

- 中文前缀：`feat:` `fix:` `test:` `docs:` `refactor:` `chore:`，一个 commit 做一件事
- **不要提交** `frontend/dist/`、`backend/data/*.db`、`backend/_restart.log`
- 提交后直接 `git push origin main`（origin 已配好凭证，服务器和本机都能推）
- 提交前确认 `git status` 干净，别把半成品和别人未提交的改动一起打进构建

## 坑

- 计划任务默认 `ExecutionTimeLimit=72:00:00`，跑满 72 小时会被强杀；已改成 `PT0S`，重建任务时记得重设
- 数据库加列要用 `Database._ensure_column(...)` 做幂等 `ALTER TABLE`，`db.create_all()` **不会**给已有表加列
- 构建期间 `GET /` 可能刷一段 404，是旧进程日志，新进程起来后就正常
- `npm ci` 在 npm 10.9.7 上会失败，用 `npm install`（会重写 `package-lock.json`，别把无关变动混进提交）
- `timeout /t` 在非交互 SSH 里不工作，等待用 `ping -n 6 127.0.0.1 >nul`
