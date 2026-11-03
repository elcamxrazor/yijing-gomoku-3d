# syntax=docker/dockerfile:1

# --- frontend build ---------------------------------------------------------
FROM node:22-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- application ------------------------------------------------------------
FROM python:3.11-slim AS app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=25562
WORKDIR /app
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/app ./app
COPY --from=web /web/dist ./frontend/dist
RUN mkdir -p /app/data
EXPOSE 25562
# AI 引擎（Rapfi WASM）在浏览器端运行，镜像里不需要任何引擎二进制或 Wine。
# 前端构建产物（含 public/engine/*）已由上面的 web 阶段复制进 ./frontend/dist。
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "25562"]
