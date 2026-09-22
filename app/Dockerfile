FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends optipng && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt

# Install runtime dependencies first to leverage layer caching.
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r /app/requirements.txt

COPY . /app

EXPOSE 5001

CMD ["uvicorn", "src.main:app", "--proxy-headers", "--forwarded-allow-ips=*", "--host", "0.0.0.0", "--port", "5001", "--no-access-log"]
