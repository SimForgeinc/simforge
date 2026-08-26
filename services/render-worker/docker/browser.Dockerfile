# syntax=docker/dockerfile:1.7
FROM node:22.14.0-bookworm-slim AS build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
COPY --from=source /package.json /pnpm-lock.yaml /pnpm-workspace.yaml /tsconfig.base.json ./
COPY --from=source /packages ./packages
COPY --from=source /services/render-worker ./services/render-worker
RUN pnpm install --frozen-lockfile --ignore-scripts \
 && pnpm --filter @simforge/render... --filter @simforge/render-worker... build \
 && pnpm deploy --legacy --filter @simforge/render-worker --prod /out/worker \
 && pnpm deploy --legacy --filter @simforge/render --prod /out/browser-renderer

FROM node:22.14.0-bookworm-slim AS runtime
ARG SOURCE_REVISION
ARG IMAGE_VERSION
RUN test -n "$SOURCE_REVISION" && test -n "$IMAGE_VERSION" \
 && apt-get update \
 && apt-get install -y --no-install-recommends chromium tini ca-certificates ffmpeg libegl1 libgles2 \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 renderer \
 && useradd --system --uid 10001 --gid renderer --home-dir /nonexistent --shell /usr/sbin/nologin renderer \
 && mkdir -p /opt/simforge /scratch /cache /run/simforge \
 && chown -R renderer:renderer /scratch /cache /run/simforge
COPY --from=build --chown=renderer:renderer /out/worker /opt/simforge/worker
COPY --from=build --chown=renderer:renderer /out/browser-renderer /opt/simforge/browser-renderer
# Real-GPU rendering by default: ANGLE over EGL with the NVIDIA glvnd vendor.
# Hosts may override, but launch-config drift can no longer silently fall
# renders back to SwiftShader CPU rendering.
ENV NODE_ENV=production \
    PORT=8080 \
    UNISCENARIOS_BROWSER_ENGINE_MODULE=/opt/simforge/browser-renderer/dist/index.js \
    UNISCENARIOS_SCRATCH_DIR=/scratch \
    UNISCENARIOS_CACHE_DIR=/cache \
    UNISCENARIOS_GPU_LOCK=/run/simforge/gpu.lock \
    CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
    UNISCENARIOS_CHROMIUM_EXTRA_ARGS="--use-gl=angle --use-angle=gl-egl" \
    __EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/10_nvidia.json \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,graphics,utility
LABEL org.opencontainers.image.title="SimForge browser render worker" \
      org.opencontainers.image.version="$IMAGE_VERSION" \
      org.opencontainers.image.revision="$SOURCE_REVISION" \
      org.opencontainers.image.source="https://github.com/SimForgeinc/simforge-oss" \
      io.uniscenarios.engine="browser" \
      io.uniscenarios.contract="uniscenario.render-worker-control/v2"
USER 10001:10001
WORKDIR /scratch
VOLUME ["/scratch", "/cache", "/run/simforge"]
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT||8080}/health`).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/simforge/worker/dist/main.js"]
CMD ["--config", "/config/worker.json"]
