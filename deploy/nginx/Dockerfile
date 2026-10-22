# syntax=docker/dockerfile:1
#
# PiCloud gateway: builds the web/ SPA and serves it with nginx.
# Build context is the repository root:
#   docker build -f deploy/nginx/Dockerfile -t picloud-gateway .
# Dockerfile.dockerignore (next to this file) limits the context to web/ and deploy/nginx/.

ARG NODE_IMAGE=node:22.23.3-alpine
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.30.5-alpine

# --- Stage 1: build the SPA -------------------------------------------------
# The output is static files, so this stage always runs on the build host's
# native platform; multi-arch builds do not need to emulate Node.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS web
ENV PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
RUN corepack enable
WORKDIR /src/web
# Optional pnpm files are matched with a glob so the COPY works without them.
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yam[l] web/.npmr[c] ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

# --- Stage 2: nginx, non-root (UID 101) -------------------------------------
FROM ${NGINX_IMAGE}

LABEL org.opencontainers.image.title="picloud-gateway" \
      org.opencontainers.image.description="PiCloud nginx gateway: SPA, TLS, basic auth, api and Grafana reverse proxy" \
      org.opencontainers.image.source="https://github.com/Reec1e33/proj2-raspPI-ai-server"

# The entrypoint renders /etc/nginx/templates/*.template into /etc/nginx/conf.d/.
# Only these variables are substituted; nginx's own $variables stay intact.
ENV NGINX_ENVSUBST_FILTER="^(SERVER_NAME|PUBLIC_HTTPS_PORT)" \
    SERVER_NAME=localhost \
    PUBLIC_HTTPS_PORT=443

RUN rm -f /etc/nginx/conf.d/default.conf
COPY deploy/nginx/nginx.conf /etc/nginx/nginx.conf
COPY deploy/nginx/snippets/ /etc/nginx/snippets/
COPY deploy/nginx/templates/ /etc/nginx/templates/
COPY --from=web /src/web/dist/ /usr/share/nginx/html/

EXPOSE 8080 8443
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD wget -qO /dev/null http://127.0.0.1:8081/healthz || exit 1
