variable "SOURCE_REVISION" {
  validation {
    condition = SOURCE_REVISION != ""
    error_message = "SOURCE_REVISION must be an immutable source commit SHA"
  }
}

variable "IMAGE_VERSION" {
  validation {
    condition = IMAGE_VERSION != ""
    error_message = "IMAGE_VERSION must be set"
  }
}

# Pinned worker base images (no repository code inside). Re-bake with the
# `bases` group only when the engine image, node pin, or OS deps change, push
# once, then update these digests and pre-seed every fleet host (see
# docs/images-last-worker-iteration.md). Worker bakes below consume the base
# by digest so the 26.8 GB engine layer never moves again on a code change.
variable "CARLA_WORKER_BASE_IMAGE" {
  default = "ghcr.io/simforgeinc/carla-worker-base:0.10.0-kia-node22.14-v1@sha256:e2e64f5c082fa27ee65450f7900c4ea991a5e832d8c2938d3e5e3061ad06e0f1"
}

variable "BROWSER_WORKER_BASE_IMAGE" {
  default = "ghcr.io/simforgeinc/browser-worker-base:node22.14-chromium-v1@sha256:9b9dd2b0ba97788dbc7e4c8f8085e5cd6a973d2fa9ba46958a2b81b667f13093"
}

variable "CARLA_WORKER_BASE_VERSION" {
  default = "0.10.0-kia-node22.14-v1"
}

variable "BROWSER_WORKER_BASE_VERSION" {
  default = "node22.14-chromium-v1"
}

group "default" {
  targets = ["browser-worker", "carla-worker"]
}

group "bases" {
  targets = ["carla-worker-base", "browser-worker-base"]
}

target "common" {
  context = "."
  contexts = {
    source = "../../.."
  }
  args = {
    SOURCE_REVISION = SOURCE_REVISION
    IMAGE_VERSION = IMAGE_VERSION
  }
  platforms = ["linux/amd64"]
}

target "browser-worker" {
  inherits = ["common"]
  dockerfile = "browser.Dockerfile"
  args = {
    SOURCE_REVISION = SOURCE_REVISION
    IMAGE_VERSION = IMAGE_VERSION
    BROWSER_WORKER_BASE_IMAGE = BROWSER_WORKER_BASE_IMAGE
  }
  tags = ["uniscenarios/browser-render-worker:${IMAGE_VERSION}"]
}

target "carla-worker" {
  inherits = ["common"]
  dockerfile = "carla.Dockerfile"
  args = {
    SOURCE_REVISION = SOURCE_REVISION
    IMAGE_VERSION = IMAGE_VERSION
    CARLA_WORKER_BASE_IMAGE = CARLA_WORKER_BASE_IMAGE
  }
  tags = ["uniscenarios/carla-render-worker:${IMAGE_VERSION}"]
}

target "carla-worker-base" {
  context = "."
  dockerfile = "base.carla.Dockerfile"
  args = {
    BASE_VERSION = CARLA_WORKER_BASE_VERSION
  }
  platforms = ["linux/amd64"]
  tags = ["ghcr.io/simforgeinc/carla-worker-base:${CARLA_WORKER_BASE_VERSION}"]
}

target "browser-worker-base" {
  context = "."
  dockerfile = "base.browser.Dockerfile"
  args = {
    BASE_VERSION = BROWSER_WORKER_BASE_VERSION
  }
  platforms = ["linux/amd64"]
  tags = ["ghcr.io/simforgeinc/browser-worker-base:${BROWSER_WORKER_BASE_VERSION}"]
}
