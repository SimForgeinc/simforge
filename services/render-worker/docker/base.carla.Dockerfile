# syntax=docker/dockerfile:1.7
# Pinned CARLA worker base: UE5 engine + cooked maps + runtime OS deps +
# node runtime + CARLA PythonAPI wheel. Contains NO repository code — it
# changes only when the engine image, node pin, or OS deps change, so it is
# baked rarely, pushed once, and pre-seeded on every fleet host. Worker code
# ships as thin layers on top (see carla.Dockerfile).
ARG CARLA_ENGINE_IMAGE=ghcr.io/simforgeinc/carla-rfs-munich-belmont:0.10.0-kia@sha256:baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64
FROM node:22.14.0-bookworm-slim AS node-runtime
FROM ${CARLA_ENGINE_IMAGE}
ARG BASE_VERSION
USER root
RUN test -n "$BASE_VERSION" \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 python3-pip tini ca-certificates libxml2-utils ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/uniscenarios /scratch /cache /run/uniscenarios \
 && chown -R carla:carla /scratch /cache /run/uniscenarios
COPY --from=node-runtime /usr/local /usr/local
RUN python3 -m pip install --no-cache-dir /home/carla/PythonAPI/carla/dist/carla-*.whl \
 && node --version && python3 -c 'import carla; print(carla.__file__)'
LABEL org.opencontainers.image.title="UniScenarios CARLA worker base" \
      org.opencontainers.image.version="$BASE_VERSION" \
      org.opencontainers.image.source="https://github.com/SimForgeinc/UniScenarios" \
      io.uniscenarios.engine="carla" \
      io.uniscenarios.layer="worker-base" \
      io.uniscenarios.carla.base.index-digest="sha256:f17c639e5f86fd7458fe1d02d3be1d481deeaa714f3cac30e465187d04ec90e5" \
      io.uniscenarios.carla.base.manifest-digest="sha256:baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64"
USER carla
