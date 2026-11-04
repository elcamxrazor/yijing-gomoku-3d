@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d C:\Users\45126\WorkBuddy\2026-10-31-07-00-13 || exit /b 1

echo ===1/5 前置门禁===
git fetch origin main
if errorlevel 1 echo NOTE: fetch 失败，按本地 origin/main 判断
for /f %%i in ('git rev-parse HEAD') do set HEAD_SHA=%%i
for /f %%i in ('git rev-parse origin/main') do set REMOTE_SHA=%%i
if not "!HEAD_SHA!"=="!REMOTE_SHA!" (
  echo BLOCKED: HEAD 与 origin/main 不一致，先执行 git pull --ff-only origin main
  exit /b 1
)
set DIRTY=
for /f "delims=" %%i in ('git status --porcelain ^| findstr /v /c:"_restart.log"') do set DIRTY=1
if defined DIRTY (
  echo BLOCKED: 工作区有未提交改动，可能是另一个会话的在制品；先确认归属再发布。
  exit /b 1
)
echo OK: !HEAD_SHA! 工作区干净

if exist CLAIM.json (
  echo NOTE: 存在 CLAIM.json 租约，请确认持锁会话已收工。
)

echo ===2/5 构建===
set PATH=C:\Users\45126\.workbuddy\binaries\node\versions\22.22.2-6;%PATH%
cd /d C:\Users\45126\WorkBuddy\2026-10-31-07-00-13\frontend
call npm run build
if errorlevel 1 (
  echo BLOCKED: 构建失败，未改动线上进程。
  exit /b 1
)
cd /d C:\Users\45126\WorkBuddy\2026-10-31-07-00-13

echo ===3/5 写入 BUILD_INFO===
> "frontend\dist\BUILD_INFO.json" echo {"commit":"!HEAD_SHA!","builtAt":"%DATE% %TIME%","publisher":"server","source":"tools/deploy.cmd"}

echo ===4/5 重启后端===
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :25562 ^| findstr LISTENING') do taskkill /PID %%p /F >nul 2>&1
schtasks /run /tn YijingGomokuBackend
if errorlevel 1 (
  echo BLOCKED: 计划任务启动失败，请手工检查 YijingGomokuBackend。
  exit /b 1
)

echo ===5/5 完成===
echo 校验： curl http://127.0.0.1:25562/BUILD_INFO.json
echo 期望 commit = !HEAD_SHA!
endlocal
