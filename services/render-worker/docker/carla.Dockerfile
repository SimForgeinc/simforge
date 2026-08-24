# syntax=docker/dockerfile:1.7
# Thin CARLA worker: code layers only, on top of the pinned carla-worker-base
# (engine + OS deps + node + CARLA PythonAPI — see base.carla.Dockerfile).
# Dependency installs are ordered before source copies and use BuildKit cache
# mounts, so a code-only change rebuilds in seconds and pushes/pulls only thin
# layers on hosts where the base is seeded.
ARG CARLA_WORKER_BASE_IMAGE
FROM node:22.14.0-bookworm-slim AS node-build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
# Dependency manifests first: pnpm install stays cached across code changes.
COPY --from=source /package.json /pnpm-lock.yaml /pnpm-workspace.yaml /tsconfig.base.json ./
COPY --from=source /packages/scenario-model/package.json ./packages/scenario-model/package.json
COPY --from=source /packages/render-runtime/package.json ./packages/render-runtime/package.json
COPY --from=source /services/render-worker/package.json ./services/render-worker/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --ignore-scripts --store-dir /pnpm-store
COPY --from=source /packages/scenario-model ./packages/scenario-model
COPY --from=source /packages/render-runtime ./packages/render-runtime
COPY --from=source /services/render-worker ./services/render-worker
RUN pnpm --filter @uniscenarios/scenario-model --filter @uniscenarios/render-runtime --filter @uniscenarios/render-worker build \
 && pnpm deploy --legacy --filter @uniscenarios/render-worker --prod /out/worker

FROM python:3.12.10-slim-bookworm AS python-build
WORKDIR /src
COPY --from=source /adapters/carla-bridge ./adapters/carla-bridge
RUN --mount=type=cache,id=pip-cache,target=/root/.cache/pip \
    python -m pip wheel --wheel-dir /wheels ./adapters/carla-bridge

FROM ${CARLA_WORKER_BASE_IMAGE} AS runtime
ARG CARLA_WORKER_BASE_IMAGE
ARG SOURCE_REVISION
ARG IMAGE_VERSION
USER root
RUN test -n "$SOURCE_REVISION" && test -n "$IMAGE_VERSION"
COPY --from=node-build --chown=carla:carla /out/worker /opt/uniscenarios/worker
COPY --from=python-build /wheels /tmp/wheels
RUN python3 -m pip install --no-cache-dir /tmp/wheels/*.whl && rm -rf /tmp/wheels
ENV NODE_ENV=production \
    PORT=8080 \
    UNISCENARIOS_CARLA_BINARY=/usr/local/bin/uniscenarios-carla \
    UNISCENARIOS_SCRATCH_DIR=/scratch \
    UNISCENARIOS_CARLA_BLUEPRINT_ID=vehicle.kia.carnival \
    UNISCENARIOS_CARLA_BLUEPRINT_CLASS=/Game/Carla/Blueprints/Vehicles/KiaCarnival2025/BP_KiaCarnival2025.BP_KiaCarnival2025_C \
    UNISCENARIOS_CARLA_IMAGE_MANIFEST_SHA256=baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64 \
    UNISCENARIOS_CACHE_DIR=/cache \
    UNISCENARIOS_GPU_LOCK=/run/uniscenarios/gpu.lock \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,graphics,utility
LABEL org.opencontainers.image.title="UniScenarios CARLA render worker" \
      org.opencontainers.image.version="$IMAGE_VERSION" \
      org.opencontainers.image.revision="$SOURCE_REVISION" \
      org.opencontainers.image.source="https://github.com/SimForgeinc/UniScenarios" \
      io.uniscenarios.engine="carla" \
      io.uniscenarios.worker-base="$CARLA_WORKER_BASE_IMAGE" \
      io.uniscenarios.carla.base.index-digest="sha256:f17c639e5f86fd7458fe1d02d3be1d481deeaa714f3cac30e465187d04ec90e5" \
      io.uniscenarios.carla.base.manifest-digest="sha256:baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64" \
      io.uniscenarios.sensor-host.catalog-asset-id="vehicle.kia.carnival" \
      io.uniscenarios.sensor-host.carla-blueprint-id="vehicle.kia.carnival" \
      io.uniscenarios.sensor-host.carla-class-path="/Game/Carla/Blueprints/Vehicles/KiaCarnival2025/BP_KiaCarnival2025.BP_KiaCarnival2025_C" \
      io.uniscenarios.contract="uniscenario.render-worker-control/v2"
USER carla
WORKDIR /scratch
VOLUME ["/scratch", "/cache", "/run/uniscenarios"]
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT||8080}/health`).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/uniscenarios/worker/dist/main.js"]
CMD ["--config", "/config/worker.json"]
