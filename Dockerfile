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
# Yixin is not bundled. It is licensed for non-commercial use only; mount it at
# runtime and set YIXIN_ENGINE_PATH. A Linux container needs a Wine-based image
# to execute the Windows engine, or run the backend natively on Windows.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "25562"]
