# syntax=docker/dockerfile:1.7
# Pinned browser worker base: node runtime + chromium + GPU/video OS deps +
# runtime user and directories. Contains NO repository code — worker code
# ships as thin layers on top (see browser.Dockerfile).
FROM node:22.14.0-bookworm-slim
ARG BASE_VERSION
RUN test -n "$BASE_VERSION" \
 && apt-get update \
 && apt-get install -y --no-install-recommends chromium tini ca-certificates ffmpeg libegl1 libgles2 \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 renderer \
 && useradd --system --uid 10001 --gid renderer --home-dir /nonexistent --shell /usr/sbin/nologin renderer \
 && mkdir -p /opt/uniscenarios /scratch /cache /run/uniscenarios \
 && chown -R renderer:renderer /scratch /cache /run/uniscenarios
LABEL org.opencontainers.image.title="UniScenarios browser worker base" \
      org.opencontainers.image.version="$BASE_VERSION" \
      org.opencontainers.image.source="https://github.com/SimForgeinc/UniScenarios" \
      io.uniscenarios.engine="browser" \
      io.uniscenarios.layer="worker-base"
