#!/usr/bin/env bash
# One-time per-host bootstrap for host-native UniScenarios render workers.
# Pins the node and uv toolchains, provisions the python venv (matching the
# CARLA PythonAPI wheel's cp tag), seeds the pinned CARLA engine container
# image (the ONLY container in the host-native model), installs the systemd
# unit, and prepares the deploy layout. Run as root (rtx3080 hosts) or with
# sudo (simforge1).
#
#   bootstrap-host.sh carla|browser|both [run-user]
#
# Idempotent: safe to re-run.
set -euo pipefail

role="${1:?usage: bootstrap-host.sh carla|browser|both [run-user]}"
run_user="${2:-$(id -un "${SUDO_UID:-$(id -u)}")}"

NATIVE=/opt/simforge/uniscenarios-native
NODE_VERSION=v22.14.0
UV_VERSION=0.9.28
PYTHON_PIN=3.10
# Pinned CARLA engine image — never repackaged; workers talk RPC to a server
# container running this image.
ENGINE_IMAGE="ghcr.io/simforgeinc/carla-rfs-munich-belmont:0.10.0-kia@sha256:baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64"
# Chromium build matching packages/browser-renderer's playwright-core pin.
PLAYWRIGHT_VERSION=1.62.1

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$NATIVE"/{config,env,state/scratch,state/cache,state/run,src}
[ -d "$NATIVE/repo.git" ] || git init --bare --initial-branch=deploy "$NATIVE/repo.git"

# --- pinned node ------------------------------------------------------------
if [ ! -x "$NATIVE/node/bin/node" ] || [ "$("$NATIVE/node/bin/node" --version)" != "$NODE_VERSION" ]; then
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz" -o /tmp/node-native.tar.xz
  rm -rf "$NATIVE/node" && mkdir -p "$NATIVE/node"
  tar -xJf /tmp/node-native.tar.xz -C "$NATIVE/node" --strip-components=1 && rm /tmp/node-native.tar.xz
fi
"$NATIVE/node/bin/corepack" enable --install-directory "$NATIVE/node/bin" 2>/dev/null || true
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$NATIVE/node/bin/corepack" prepare pnpm@11.18.0 --activate

# --- pinned uv --------------------------------------------------------------
if [ ! -x "$NATIVE/uv/uv" ]; then
  mkdir -p "$NATIVE/uv"
  curl -fsSL "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-x86_64-unknown-linux-gnu.tar.gz" \
    | tar -xzf - -C "$NATIVE/uv" --strip-components=1
fi

# --- ffmpeg + xml tooling (host packages) -----------------------------------
command -v ffmpeg >/dev/null && command -v xmllint >/dev/null \
  || { apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ffmpeg libxml2-utils; }

if [ "$role" = "carla" ] || [ "$role" = "both" ]; then
  # --- engine container seed + CARLA PythonAPI wheel ------------------------
  docker image inspect "$ENGINE_IMAGE" >/dev/null 2>&1 || docker pull "$ENGINE_IMAGE"
  if [ ! -e "$NATIVE"/carla-wheel/carla-*.whl ]; then
    mkdir -p "$NATIVE/carla-wheel"
    cid="$(docker create "$ENGINE_IMAGE")"
    docker cp "$cid:/home/carla/PythonAPI/carla/dist/." "$NATIVE/carla-wheel/"
    docker rm "$cid" >/dev/null
  fi
  # --- python venv matching the wheel's cp tag -------------------------------
  if [ ! -x "$NATIVE/venv/bin/python" ]; then
    "$NATIVE/uv/uv" venv --python "$PYTHON_PIN" "$NATIVE/venv"
  fi
  "$NATIVE/uv/uv" pip install --python "$NATIVE/venv/bin/python" "$NATIVE"/carla-wheel/carla-*.whl
fi

if [ "$role" = "browser" ] || [ "$role" = "both" ]; then
  # --- chromium (playwright build; matches playwright-core pin) -------------
  export PLAYWRIGHT_BROWSERS_PATH="$NATIVE/browsers"
  "$NATIVE/node/bin/node" "$NATIVE/node/bin/npx" -y "playwright@$PLAYWRIGHT_VERSION" install chromium
  chromium_bin="$(find "$NATIVE/browsers" -maxdepth 3 -type f -name chrome -path '*chromium*' | sort | tail -1)"
  [ -n "$chromium_bin" ] || { echo "chromium install failed" >&2; exit 1; }
  echo "$chromium_bin" > "$NATIVE/chromium-path"
fi

# --- systemd unit ------------------------------------------------------------
sed "s/__RUN_USER__/$run_user/" "$script_dir/uniscenarios-native-worker@.service" \
  > /etc/systemd/system/uniscenarios-native-worker@.service
systemctl daemon-reload

# --- control adapter ----------------------------------------------------------
cp "$script_dir/simcloud-control-adapter.mjs" "$NATIVE/config/simcloud-control-adapter.mjs"

chown -R "$run_user" "$NATIVE"
echo "bootstrap complete: $NATIVE (role=$role, user=$run_user)"
