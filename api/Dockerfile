# syntax=docker/dockerfile:1

# ---- build: resolve the locked dependencies into a self-contained virtualenv ----
FROM python:3.12.15-slim-trixie AS build
COPY --from=ghcr.io/astral-sh/uv:0.12.22 /uv /bin/uv

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv

WORKDIR /src

# Dependencies first, so source edits do not invalidate this layer.
COPY pyproject.toml uv.lock .python-version ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

COPY README.md ./
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable

# ---- runtime: same base image, venv only, non-root ----
FROM python:3.12.15-slim-trixie

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:${PATH}" \
    # uvicorn trusts X-Forwarded-For only from these peers (IPs or CIDRs). Compose sets it to
    # the gateway's network so per-client rate limiting sees real client addresses.
    FORWARDED_ALLOW_IPS=127.0.0.1

RUN groupadd --system --gid 10001 picloud \
    && useradd --system --uid 10001 --gid picloud --no-create-home \
       --home-dir /nonexistent --shell /usr/sbin/nologin picloud

COPY --from=build /opt/venv /opt/venv

USER picloud:picloud
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3)"]

# --no-access-log: the app writes its own JSON access log with request ids.
# --timeout-graceful-shutdown: SSE streams never end on their own, so cap the drain on stop.
CMD ["uvicorn", "picloud_api.main:app", "--host", "0.0.0.0", "--port", "8000", \
     "--proxy-headers", "--no-access-log", "--no-server-header", "--timeout-graceful-shutdown", "5"]
