# syntax=docker/dockerfile:1.7
FROM node:22.14.0-bookworm-slim AS node-build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
COPY --from=source /package.json /pnpm-lock.yaml /pnpm-workspace.yaml /tsconfig.base.json ./
COPY --from=source /packages/scenario ./packages/scenario
COPY --from=source /packages/render ./packages/render
COPY --from=source /services/render-worker ./services/render-worker
RUN pnpm install --frozen-lockfile --ignore-scripts \
 && pnpm --filter @simforge-oss/scenario --filter @simforge-oss/render --filter @simforge-oss/render-worker build \
 && pnpm deploy --legacy --filter @simforge-oss/render-worker --prod /out/worker

FROM python:3.12.10-slim-bookworm AS python-build
WORKDIR /src
COPY --from=source /adapters/carla-exec ./adapters/carla-exec
RUN python -m pip wheel --no-cache-dir --wheel-dir /wheels ./adapters/carla-exec

FROM ghcr.io/simforgeinc/carla-rfs-munich-belmont:0.10.0-kia@sha256:baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64 AS runtime
ARG SOURCE_REVISION
ARG IMAGE_VERSION
USER root
RUN test -n "$SOURCE_REVISION" && test -n "$IMAGE_VERSION" \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 python3-pip tini ca-certificates libxml2-utils ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/simforge /scratch /cache /run/simforge \
 && chown -R carla:carla /scratch /cache /run/simforge
COPY --from=node-build /usr/local /usr/local
COPY --from=node-build --chown=carla:carla /out/worker /opt/simforge/worker
COPY --from=python-build /wheels /tmp/wheels
RUN python3 -m pip install --no-cache-dir /home/carla/PythonAPI/carla/dist/carla-*.whl /tmp/wheels/*.whl && rm -rf /tmp/wheels
ENV NODE_ENV=production \
    PORT=8080 \
    UNISCENARIOS_CARLA_BINARY=/usr/local/bin/simforge-oss-carla-api \
    UNISCENARIOS_SCRATCH_DIR=/scratch \
    UNISCENARIOS_CARLA_BLUEPRINT_ID=vehicle.kia.carnival \
    UNISCENARIOS_CARLA_BLUEPRINT_CLASS=/Game/Carla/Blueprints/Vehicles/KiaCarnival2025/BP_KiaCarnival2025.BP_KiaCarnival2025_C \
    UNISCENARIOS_CARLA_IMAGE_MANIFEST_SHA256=baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64 \
    UNISCENARIOS_CACHE_DIR=/cache \
    UNISCENARIOS_GPU_LOCK=/run/simforge/gpu.lock \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,graphics,utility
LABEL org.opencontainers.image.title="SimForge CARLA render worker" \
      org.opencontainers.image.version="$IMAGE_VERSION" \
      org.opencontainers.image.revision="$SOURCE_REVISION" \
      org.opencontainers.image.source="https://github.com/SimForgeinc/simforge-oss" \
      io.uniscenarios.engine="carla" \
      io.uniscenarios.carla.base.index-digest="sha256:f17c639e5f86fd7458fe1d02d3be1d481deeaa714f3cac30e465187d04ec90e5" \
      io.uniscenarios.carla.base.manifest-digest="sha256:baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64" \
      io.uniscenarios.sensor-host.catalog-asset-id="vehicle.kia.carnival" \
      io.uniscenarios.sensor-host.carla-blueprint-id="vehicle.kia.carnival" \
      io.uniscenarios.sensor-host.carla-class-path="/Game/Carla/Blueprints/Vehicles/KiaCarnival2025/BP_KiaCarnival2025.BP_KiaCarnival2025_C" \
      io.uniscenarios.contract="uniscenario.render-worker-control/v2"
USER carla
WORKDIR /scratch
VOLUME ["/scratch", "/cache", "/run/simforge"]
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT||8080}/health`).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/simforge/worker/dist/main.js"]
CMD ["--config", "/config/worker.json"]
