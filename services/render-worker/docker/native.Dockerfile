# syntax=docker/dockerfile:1.7
FROM node:22.14.0-bookworm-slim AS node-build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
COPY --from=source /package.json /pnpm-lock.yaml /pnpm-workspace.yaml /tsconfig.base.json ./
COPY --from=source /packages ./packages
COPY --from=source /services/render-worker ./services/render-worker
RUN pnpm install --frozen-lockfile --ignore-scripts \
 && pnpm --filter @simforge-oss/render-worker... build \
 && pnpm deploy --legacy --filter @simforge-oss/render-worker --prod /out/worker

FROM rust:1.95.0-bookworm AS rust-build
WORKDIR /src
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends clang libasound2-dev libudev-dev libwayland-dev libx11-dev libxkbcommon-dev pkg-config \
 && rm -rf /var/lib/apt/lists/*
COPY --from=source /renderer ./renderer
RUN cargo build --locked --manifest-path renderer/Cargo.toml --release -p service --bin native-render-service

FROM node:22.14.0-bookworm-slim AS runtime
ARG SOURCE_REVISION
ARG IMAGE_VERSION
RUN test -n "$SOURCE_REVISION" && test -n "$IMAGE_VERSION" \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates ffmpeg libasound2 libudev1 libvulkan1 libx11-6 libxkbcommon0 tini vulkan-tools \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/simforge /scratch /cache /run/simforge \
 && chown -R node:node /scratch /cache /run/simforge
COPY --from=node-build --chown=node:node /out/worker /opt/simforge/worker
COPY --from=rust-build /src/renderer/target/release/native-render-service /usr/local/bin/native-render-service
ENV NODE_ENV=production \
    PORT=8080 \
    SIMFORGE_NATIVE_RENDER_BINARY=/usr/local/bin/native-render-service \
    SIMFORGE_SCRATCH_DIR=/scratch \
    SIMFORGE_CACHE_DIR=/cache \
    SIMFORGE_GPU_LOCK=/run/simforge/gpu.lock \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,graphics,utility
LABEL org.opencontainers.image.title="SimForge native render worker" \
      org.opencontainers.image.version="$IMAGE_VERSION" \
      org.opencontainers.image.revision="$SOURCE_REVISION" \
      org.opencontainers.image.source="https://github.com/SimForgeinc/simforge-oss" \
      io.simforge.engine="native" \
      io.simforge.native.engine-id="bevy-retained" \
      io.simforge.contract="simforge.render-worker-control/v2"
USER node
WORKDIR /scratch
VOLUME ["/scratch", "/cache", "/run/simforge"]
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT||8080}/health`).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/simforge/worker/dist/main.js"]
CMD ["--config", "/config/worker.json"]
