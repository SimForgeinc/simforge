# syntax=docker/dockerfile:1.7
# Thin browser worker: code layers only, on top of the pinned
# browser-worker-base (node + chromium + OS deps — see base.browser.Dockerfile).
# Dependency installs are ordered before source copies and use BuildKit cache
# mounts, so a code-only change rebuilds in seconds and pushes/pulls only thin
# layers on hosts where the base is seeded.
ARG BROWSER_WORKER_BASE_IMAGE
# Manifest-pruning stage: reduce /packages to package.json files only, so the
# pnpm install layer below is keyed on manifests (content-checksummed COPY)
# and stays cached across source-only changes.
FROM node:22.14.0-bookworm-slim AS manifests
WORKDIR /src
COPY --from=source /packages ./packages
RUN find ./packages -mindepth 2 -maxdepth 2 ! -name package.json -exec rm -rf {} +

FROM node:22.14.0-bookworm-slim AS build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
# Dependency manifests first: pnpm install stays cached across code changes.
COPY --from=source /package.json /pnpm-lock.yaml /pnpm-workspace.yaml /tsconfig.base.json ./
COPY --from=manifests /src/packages ./packages
COPY --from=source /services/render-worker/package.json ./services/render-worker/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --ignore-scripts --store-dir /pnpm-store
COPY --from=source /packages ./packages
COPY --from=source /services/render-worker ./services/render-worker
RUN pnpm --filter @uniscenarios/browser-renderer... --filter @uniscenarios/render-worker... build \
 && pnpm deploy --legacy --filter @uniscenarios/render-worker --prod /out/worker \
 && pnpm deploy --legacy --filter @uniscenarios/browser-renderer --prod /out/browser-renderer

FROM ${BROWSER_WORKER_BASE_IMAGE} AS runtime
ARG BROWSER_WORKER_BASE_IMAGE
ARG SOURCE_REVISION
ARG IMAGE_VERSION
RUN test -n "$SOURCE_REVISION" && test -n "$IMAGE_VERSION"
COPY --from=build --chown=renderer:renderer /out/worker /opt/uniscenarios/worker
COPY --from=build --chown=renderer:renderer /out/browser-renderer /opt/uniscenarios/browser-renderer
# Real-GPU rendering by default: ANGLE over EGL with the NVIDIA glvnd vendor.
# Hosts may override, but launch-config drift can no longer silently fall
# renders back to SwiftShader CPU rendering.
ENV NODE_ENV=production \
    PORT=8080 \
    UNISCENARIOS_BROWSER_ENGINE_MODULE=/opt/uniscenarios/browser-renderer/dist/index.js \
    UNISCENARIOS_SCRATCH_DIR=/scratch \
    UNISCENARIOS_CACHE_DIR=/cache \
    UNISCENARIOS_GPU_LOCK=/run/uniscenarios/gpu.lock \
    CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
    UNISCENARIOS_CHROMIUM_EXTRA_ARGS="--use-gl=angle --use-angle=gl-egl" \
    __EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/10_nvidia.json \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,graphics,utility
LABEL org.opencontainers.image.title="UniScenarios browser render worker" \
      org.opencontainers.image.version="$IMAGE_VERSION" \
      org.opencontainers.image.revision="$SOURCE_REVISION" \
      org.opencontainers.image.source="https://github.com/SimForgeinc/UniScenarios" \
      io.uniscenarios.engine="browser" \
      io.uniscenarios.worker-base="$BROWSER_WORKER_BASE_IMAGE" \
      io.uniscenarios.contract="uniscenario.render-worker-control/v2"
USER 10001:10001
WORKDIR /scratch
VOLUME ["/scratch", "/cache", "/run/uniscenarios"]
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT||8080}/health`).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/uniscenarios/worker/dist/main.js"]
CMD ["--config", "/config/worker.json"]
