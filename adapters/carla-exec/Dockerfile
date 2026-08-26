FROM ghcr.io/simforgeinc/carla-rfs-munich-belmont@sha256:baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64

USER root
WORKDIR /opt/simforge-oss-carla-exec
COPY . /opt/simforge-oss-carla-exec
RUN python3 -m pip install --no-cache-dir --no-deps /opt/simforge-oss-carla-exec

ENV SIMFORGE_MANAGED_EXECUTION=1 \
    UNISCENARIOS_CARLA_BLUEPRINT_ID=vehicle.kia.carnival \
    UNISCENARIOS_CARLA_BLUEPRINT_CLASS=/Game/Carla/Blueprints/Vehicles/KiaCarnival2025/BP_KiaCarnival2025.BP_KiaCarnival2025_C \
    UNISCENARIOS_CARLA_IMAGE_MANIFEST_SHA256=baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64

USER carla
ENTRYPOINT ["simforge-oss-carla-api"]
