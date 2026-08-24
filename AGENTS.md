# AGENTS.md — driving SimForge from an agent

SimForge is a deterministic scenario-generation pipeline: author a portable
**template** (logical anchor + choreography, no road IDs, no coordinates), match
it to concrete **sites** on real maps, sample **instances**, simulate, filter,
and verify. The `simforge` CLI is the stable surface for every step.

## Setup

```sh
pnpm install
node packages/cli/bin/simforge.js --help        # the command surface, as JSON
```

- **dev-assets are required** for anything map-bound: `dev-assets/<mapId>/`
  (yale-street, belmont-research-center, el-camino-road,
  easterbrook-discovery-school, richmond-field-station). They are git-ignored;
  override the location with `SCEN_DEV_ASSETS=<dir>`.
- Build a package in isolation: `pnpm --filter @simforge/cli build`.
- Run one test file: `cd packages/cli && npx vitest run src/__tests__/cli-smoke.test.ts`.

## CLI contract

- **stdout is the result** — one JSON document (pretty-printed only with
  `--pretty`). stderr carries progress-free structured errors:
  `{code, path?, reason, detail?}`.
- **Exit codes:** `0` ok · `1` the command could not run (bad flags, missing
  file, unknown map) · `2` it ran and found something wrong with the input
  (schema issues, unresolved map, rejected trace). Key repair loops off `2`.
- `--help` on any command prints the same JSON surface; unknown flags are
  errors, never warnings.

## The authoring loop

```sh
U=node packages/cli/bin/simforge.js

$U schemas --content > /tmp/template.schema.json    # the emission contract

$U template new --out s.template.json               # deterministic v2 skeleton
$U template validate s.template.json                # tier-1; exit 2 = repair
$U template validate s.template.json --map yale-street   # + map-backed checks

$U sites match s.template.json --all-maps           # ranked concrete sites
$U instantiate s.template.json --map yale-street --site <siteId> \
    --seed fixed-seed-1 --out i.instance.json
$U simulate i.instance.json --trace i.trace.json.gz
$U evaluate i.trace.json.gz                         # reject filters
$U evidence verify i.instance.json i.trace.json.gz  # same-input-hash proof
$U export i.instance.json --format xosc-1.4 --out i.xosc
```

`simforge batch s.template.json --all-maps --draws 5 --out out/` runs the
whole matrix (instantiate → simulate → evaluate) with per-cell seeds and a
resumable ledger. `catalog create/verify/batch` manage the 100-slot per-map
scenario catalog.

Query the world instead of guessing coordinates — the model never sees raw
road IDs:

```sh
$U maps list
$U locations find --map yale-street --type junction --facts control=signalized
$U locations resolve "signalized junction near a school" --map yale-street
```

## Import / export (OpenSCENARIO)

```sh
$U import scene.xosc --map yale-street --out imported.template.json
$U render hash render-intent.json
$U render run render-intent.json --engine browser --inputs inputs.json --out clip/
```

`import` reports mapped/unmapped features and what was lossy (storyboard
semantics stay in the source; actors land as map-pinned `scene_absolute`
roles); findings → exit 2. `export` formats: `xosc-1.4`, `xosc-1.3-esmini`,
`osc-2.2`.

## Determinism rules

- The engine is fixed-step **20 ms**, pure TypeScript; headless CLI and editor
  preview run the same engine byte-for-byte.
- Same template × site × seed ⇒ byte-identical artifacts. Never use wall-clock
  seeds; pass `--seed` (or `--draws` for the seeded matrix).
- `template new` is a deterministic generator (fixed timestamps); stamp real
  times on first save.
- Traces are gzipped and hash-pinned; `evidence verify` proves an instance and
  trace share one input hash before anyone reads metrics off the trace.

## Docs

- `docs/agent-authoring-architecture.md` — the layer stack and build contract.
- `docs/simcloud-convergence.md` — canonical ownership and the local-to-product
  flow.
- `packages/cli/README.md` — full command reference.
