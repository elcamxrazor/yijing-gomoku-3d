FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
RUN mkdir -p /app/data
EXPOSE 25562
# 仅后端镜像：AI 引擎（Rapfi WASM）在浏览器端运行，这里无需任何引擎二进制或 Wine。
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "25562"]
