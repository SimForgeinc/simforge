#!/usr/bin/env bash
# Host-side sync for host-native workers: checkout REV, sync deps, build,
# stamp configs with revision + lockfile-hash provenance, restart units.
# Invoked by deploy.sh over ssh; idempotent.
#
#   sync-host.sh <rev> [unit ...]      units default to every enabled
#                                      uniscenarios-native-worker@ instance
set -euo pipefail

REV="${1:?usage: sync-host.sh <rev> [unit ...]}"
shift || true

NATIVE=/opt/simforge/uniscenarios-native
export PATH="$NATIVE/node/bin:$NATIVE/uv:$PATH"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# --- checkout ----------------------------------------------------------------
git --git-dir="$NATIVE/repo.git" --work-tree="$NATIVE/src" checkout --detach -f "$REV"
git --git-dir="$NATIVE/repo.git" update-ref refs/heads/deployed "$REV"

cd "$NATIVE/src"
CODE_DIGEST="sha256:$(sha256sum pnpm-lock.yaml | cut -d' ' -f1)"
REV8="${REV:0:8}"

# --- role detection from config templates -------------------------------------
need_browser=0
need_carla=0
for template in "$NATIVE"/config-templates/*.json; do
  [ -e "$template" ] || continue
  if grep -q '"id": *"browser"' "$template"; then need_browser=1; else need_carla=1; fi
done

# --- deps + build (deps-before-code is free here: pnpm store is host-warm) ----
pnpm install --frozen-lockfile --ignore-scripts >/dev/null
if [ "$need_browser" = 1 ]; then
  pnpm --filter @uniscenarios/browser-renderer... --filter @uniscenarios/render-worker... build >/dev/null
else
  pnpm --filter @uniscenarios/scenario-model --filter @uniscenarios/render-runtime --filter @uniscenarios/render-worker build >/dev/null
fi

build_dir="$NATIVE/builds/$REV"
rm -rf "$build_dir" && mkdir -p "$build_dir"
pnpm deploy --legacy --filter @uniscenarios/render-worker --prod "$build_dir/worker" >/dev/null
if [ "$need_browser" = 1 ]; then
  pnpm deploy --legacy --filter @uniscenarios/browser-renderer --prod "$build_dir/browser-renderer" >/dev/null
fi
ln -sfn "$build_dir" "$NATIVE/current"
ls -dt "$NATIVE"/builds/* | tail -n +4 | xargs -r rm -rf

# --- python bridge (carla lanes) ----------------------------------------------
if [ "$need_carla" = 1 ]; then
  uv pip install --python "$NATIVE/venv/bin/python" --no-deps --force-reinstall ./adapters/carla-bridge >/dev/null
fi

# --- stamp configs from templates ---------------------------------------------
for template in "$NATIVE"/config-templates/*.json; do
  [ -e "$template" ] || continue
  sed -e "s/__REV__/$REV/g" -e "s/__REV8__/$REV8/g" -e "s/__CODE_DIGEST__/$CODE_DIGEST/g" \
    "$template" > "$NATIVE/config/$(basename "$template")"
done

# --- restart ------------------------------------------------------------------
SYSTEMCTL=(systemctl)
[ "$(id -u)" = 0 ] || SYSTEMCTL=(sudo -n systemctl)
units=("$@")
if [ "${#units[@]}" = 0 ]; then
  mapfile -t units < <("${SYSTEMCTL[@]}" list-unit-files 'uniscenarios-native-worker@*' --state=enabled --no-legend 2>/dev/null | awk '{print $1}')
fi
for unit in "${units[@]}"; do
  "${SYSTEMCTL[@]}" restart "$unit"
done

echo "synced $(hostname): rev=$REV codeDigest=$CODE_DIGEST units=${units[*]:-none}"
