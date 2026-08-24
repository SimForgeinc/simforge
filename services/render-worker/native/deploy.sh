#!/usr/bin/env bash
# Fleet deploy driver for host-native workers (runs on the operator
# workstation, inside a UniScenarios checkout).
#
#   deploy.sh <rev> <host> [host ...]
#
# For every host IN PARALLEL: push <rev> to the host's bare repo over ssh,
# then run sync-host.sh there (checkout + dep sync + build + config stamp +
# systemctl restart). Prints per-host and total wall time.
#
# Approval comes FIRST: workers refuse to register until the row carries the
# new revision + lockfile hash. Print the statement with --print-approval-sql.
set -euo pipefail

if [ "${1:-}" = "--print-approval-sql" ]; then
  rev="${2:?usage: deploy.sh --print-approval-sql <rev>}"
  rev="$(git rev-parse --verify "$rev^{commit}")"
  digest="sha256:$(git show "$rev:pnpm-lock.yaml" | sha256sum | cut -d' ' -f1)"
  cat <<SQL
-- host-native approval: bind rows to revision + dependency-lockfile hash.
-- current columns move WITH the approval: the approved_identity_ck constraint
-- requires approved_* = current_* while a row is active, and the next
-- registration overwrites current_* with what the worker actually runs.
UPDATE uniscenario.worker_nodes
   SET worker_version          = '$rev',
       image_digest            = '$digest',
       approved_worker_version = '$rev',
       approved_image_digest   = '$digest',
       approved_at             = NOW()
 WHERE id IN ('<native worker row ids>');
SQL
  exit 0
fi

rev="${1:?usage: deploy.sh <rev> <host> [host ...]}"
shift
[ "$#" -ge 1 ] || { echo "usage: deploy.sh <rev> <host> [host ...]" >&2; exit 64; }

rev="$(git rev-parse --verify "$rev^{commit}")"
NATIVE=/opt/simforge/uniscenarios-native
start=$(date +%s)

pids=()
for host in "$@"; do
  (
    h0=$(date +%s)
    git push --quiet --force "ssh://$host$NATIVE/repo.git" "$rev:refs/heads/deploy"
    # Run the sync script AT the deployed revision from a stable temp path —
    # never execute a script that the checkout is about to replace under it.
    git show "$rev:services/render-worker/native/sync-host.sh" \
      | ssh -o BatchMode=yes "$host" "cat > /tmp/uniscenarios-sync-host.sh && bash /tmp/uniscenarios-sync-host.sh '$rev'"
    echo "[$host] done in $(( $(date +%s) - h0 ))s"
  ) &
  pids+=($!)
done

fail=0
for pid in "${pids[@]}"; do wait "$pid" || fail=1; done
echo "fleet deploy of $rev: $(( $(date +%s) - start ))s total"
exit $fail
