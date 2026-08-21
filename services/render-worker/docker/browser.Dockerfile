# syntax=docker/dockerfile:1.7
FROM node:22.14.0-bookworm-slim AS build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
COPY --from=source /package.json /pnpm-lock.yaml /pnpm-workspace.yaml /tsconfig.base.json ./
COPY --from=source /packages ./packages
COPY --from=source /services/render-worker ./services/render-worker
RUN pnpm install --frozen-lockfile --ignore-scripts \
 && pnpm --filter @uniscenarios/browser-renderer... --filter @uniscenarios/render-worker... build \
 && pnpm deploy --legacy --filter @uniscenarios/render-worker --prod /out/worker \
 && pnpm deploy --legacy --filter @uniscenarios/browser-renderer --prod /out/browser-renderer

FROM node:22.14.0-bookworm-slim AS runtime
ARG SOURCE_REVISION
ARG IMAGE_VERSION
RUN test -n "$SOURCE_REVISION" && test -n "$IMAGE_VERSION" \
 && apt-get update \
 && apt-get install -y --no-install-recommends chromium tini ca-certificates xvfb xauth \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 renderer \
 && useradd --system --uid 10001 --gid renderer --home-dir /scratch --shell /usr/sbin/nologin renderer \
 && mkdir -p /opt/uniscenarios /scratch /cache /run/uniscenarios /usr/share/vulkan/icd.d /tmp/.X11-unix \
 && printf '%s\n' '{"file_format_version":"1.0.1","ICD":{"library_path":"libGLX_nvidia.so.0","api_version":"1.3.0"}}' > /usr/share/vulkan/icd.d/nvidia_icd.json \
 && chmod 1777 /tmp/.X11-unix \
 && chown -R renderer:renderer /scratch /cache /run/uniscenarios
COPY --from=build --chown=renderer:renderer /out/worker /opt/uniscenarios/worker
COPY --from=build --chown=renderer:renderer /out/browser-renderer /opt/uniscenarios/browser-renderer
ENV NODE_ENV=production \
    HOME=/scratch \
    PORT=8080 \
    UNISCENARIOS_BROWSER_ENGINE_MODULE=/opt/uniscenarios/browser-renderer/dist/index.js \
    UNISCENARIOS_SCRATCH_DIR=/scratch \
    UNISCENARIOS_CACHE_DIR=/cache \
    UNISCENARIOS_GPU_LOCK=/run/uniscenarios/gpu.lock \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,graphics,utility,display
LABEL org.opencontainers.image.title="UniScenarios browser render worker" \
      org.opencontainers.image.version="$IMAGE_VERSION" \
      org.opencontainers.image.revision="$SOURCE_REVISION" \
      org.opencontainers.image.source="https://github.com/SimForgeinc/UniScenarios" \
      io.uniscenarios.engine="browser" \
      io.uniscenarios.contract="uniscenario.render-worker-control/v2"
USER root
WORKDIR /scratch
VOLUME ["/scratch", "/cache", "/run/uniscenarios"]
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/sbin/runuser", "-u", "renderer", "--", "/usr/bin/xvfb-run", "-a", "node", "/opt/uniscenarios/worker/dist/main.js"]
CMD ["--config", "/config/worker.json"]
